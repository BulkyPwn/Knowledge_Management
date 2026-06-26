/**
 * HiDesk 平台操作 —— 连接测试/配置拉取/领域切换/自动启动
 */

let hiDeskAutoStarting = false; // 防止并发调用 doHiDeskAutoStart

export default function useHiDesk({
  hiDeskServer,
  hiDeskConfigured, setHiDeskConfigured,
  hiDeskTesting, setHiDeskTesting,
  hiDeskTestResult, setHiDeskTestResult,
  hiDeskFetchingConfig, setHiDeskFetchingConfig,
  hiDeskRefreshing, setHiDeskRefreshing,
  hiDeskDomains, setHiDeskDomains,
  hiDeskDatasets, setHiDeskDatasets,
  hiDeskViews, setHiDeskViews,
  hiDeskSelectedDomain, setHiDeskSelectedDomain,
  hiDeskSelectedView, setHiDeskSelectedView,
  hiDeskSelectedKbSn, setHiDeskSelectedKbSn,
  hiDeskChatMode, setHiDeskChatMode,
  hiDeskRawConfig, setHiDeskRawConfig,
  readMemoryFile, writeMemoryFile, getFsRef, runTask,
}) {
  const isServiceNotStartedError = (e) => {
    if (e instanceof TypeError) return true;
    const msg = e?.message || '';
    return /failed to fetch|networkerror|econnrefused|fetch failed/i.test(msg);
  };
  const getHiDeskBaseUrl = () => {
    return `http://${hiDeskServer.ip}:${hiDeskServer.port}`;
  };

  const doHiDeskAutoStart = async () => {
    if (hiDeskAutoStarting) {
      console.warn('[HiDesk] Auto-start already in progress, skipping duplicate call');
      return null;
    }
    const memory = readMemoryFile();
    const remoteCfg = memory.hiDeskRemoteConfig || { ip: '7.212.122.246', remotePath: '/home/Knowledge_Management/HiDesk_Knowledge_API.exe' };
    if (!remoteCfg.ip || !remoteCfg.remotePath) {
      console.warn('[HiDesk] Remote config missing, cannot auto-start');
      return null;
    }
    hiDeskAutoStarting = true;
    console.log('[HiDesk] Attempting auto-start from remote...');
    const { ipcRenderer } = window.require('electron');
    return new Promise((resolve) => {
      runTask('启动 HiDesk 服务', async (updateMsg) => {
        updateMsg('【1/3】正在从远端服务器下载 HiDesk 服务...');
        const result = await ipcRenderer.invoke('setup-hidesk-service', {
          remoteHost: remoteCfg.ip,
          remotePath: remoteCfg.remotePath,
        });
        if (!result.success) {
          return { success: false, message: result.message || 'HiDesk 服务启动失败' };
        }
        if (result.wasRunning) {
          return { success: true, message: 'HiDesk 服务已在运行中' };
        }
        updateMsg('【2/3】HiDesk 服务已下载，正在启动...');
        updateMsg('【3/3】HiDesk 服务启动成功！');
        return { success: true, message: 'HiDesk 服务已就绪' };
      }, 120000).then(async (ok) => {
        hiDeskAutoStarting = false;
        if (ok) {
          setHiDeskConfigured(true);
          setHiDeskTestResult({ success: true, message: 'HiDesk 服务已就绪' });
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  };

  const testHiDeskConnection = async (opts = {}) => {
    const { autoStartOnFailure = true } = opts;
    console.log('[HiDesk] Testing server connection...');
    setHiDeskTesting(true);
    setHiDeskTestResult(null);
    try {
      const url = `${getHiDeskBaseUrl()}/api/health`;
      console.log(`[HiDesk] Request: GET ${url}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      console.log(`[HiDesk] Health check response: ${JSON.stringify(data)}`);
      if (data.status === 'ok') {
        const result = { success: true, message: '连接成功' };
        setHiDeskTestResult(result);
        setHiDeskConfigured(true);
        console.log('[HiDesk] Server connection successful');
        setHiDeskTesting(false);
        return result;
      } else {
        const result = { success: false, message: '服务响应异常: ' + JSON.stringify(data) };
        setHiDeskTestResult(result);
        console.warn('[HiDesk] Server responded abnormally:', data);
        setHiDeskTesting(false);
        return result;
      }
    } catch (e) {
      const serviceDown = isServiceNotStartedError(e);
      const result = {
        success: false,
        message: serviceDown ? 'HiDesk服务暂未启动' : ('连接失败: ' + (e.message || '未知错误')),
      };
      setHiDeskTestResult(result);
      console.error('[HiDesk] Connection failed:', e.message);
      setHiDeskTesting(false);
      if (autoStartOnFailure) {
        setHiDeskTestResult({ success: false, message: 'HiDesk服务暂未启动，正在尝试启动...' });
        await doHiDeskAutoStart();
      }
      return result;
    }
  };

  const saveHiDeskDebugData = (data) => {
    try {
      const fs = getFsRef();
      const pathMod = window.require('path');
      const osMod = window.require('os');
      const debugDir = pathMod.join(osMod.homedir(), '.SSSC_AI', 'hidesk_debug');
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      const debugFile = pathMod.join(debugDir, 'hidesk.json');
      fs.writeFileSync(debugFile, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[HiDesk] Debug data saved: ${debugFile}`);
      return debugFile;
    } catch (e) {
      console.warn('[HiDesk] Failed to save debug data:', e.message);
      return null;
    }
  };

  const fetchHiDeskConfig = async () => {
    console.log('[HiDesk] Fetching HiDesk config...');
    setHiDeskFetchingConfig(true);
    try {
      const base = getHiDeskBaseUrl();
      console.log(`[HiDesk] Base URL: ${base}`);

      const rawUrl = `${base}/api/config/hidesk/raw`;
      console.log(`[HiDesk] Request: GET ${rawUrl}`);
      const rawRes = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
      console.log(`[HiDesk] raw response status: ${rawRes.status} ${rawRes.statusText}`);

      let domainList = [];
      let domainDataMap = {};

      if (rawRes.ok) {
        const rawText = await rawRes.text();
        console.log(`[HiDesk] raw response raw content (first 500 chars): ${rawText.substring(0, 500)}`);

        let rawData;
        try {
          rawData = JSON.parse(rawText);
        } catch (e) {
          console.warn('[HiDesk] raw JSON parse failed:', e.message);
        }

        if (rawData) {
          setHiDeskRawConfig(rawData);
          saveHiDeskDebugData({ type: 'raw_config', url: rawUrl, response: rawData });

          const domainsObj = (rawData?.data || rawData)?.platforms?.hidesk?.domains;
          console.log(`[HiDesk] domainsObj type: ${typeof domainsObj}, keys: ${domainsObj ? JSON.stringify(Object.keys(domainsObj)) : 'null/undefined'}`);

          if (domainsObj && typeof domainsObj === 'object' && !Array.isArray(domainsObj)) {
            const domainNames = Object.keys(domainsObj);
            console.log(`[HiDesk] Found ${domainNames.length} domains: ${JSON.stringify(domainNames)}`);

            domainList = domainNames.map(name => ({ value: name, label: name }));
            setHiDeskDomains(domainList);

            domainDataMap = {};
            for (const [name, data] of Object.entries(domainsObj)) {
              domainDataMap[name] = {
                datasets: Array.isArray(data?.datasets) ? data.datasets : [],
                views: Array.isArray(data?.views) ? data.views : [],
              };
              console.log(`[HiDesk] Domain "${name}": datasets=${domainDataMap[name].datasets.length}, views=${domainDataMap[name].views.length}`);
            }

            if (domainList.length > 0) {
              const first = domainList[0].value;
              setHiDeskSelectedDomain(first);
              setHiDeskSelectedView('');
              setHiDeskSelectedKbSn('');
              setHiDeskDatasets(domainDataMap[first]?.datasets || []);
              setHiDeskViews(domainDataMap[first]?.views || []);
              console.log(`[HiDesk] Default selected domain "${first}", datasets=${domainDataMap[first]?.datasets?.length}, views=${domainDataMap[first]?.views?.length}`);
            }
          } else {
            console.warn('[HiDesk] domains not at expected path data.platforms.hidesk.domains, outputting full structure...');
            const keys = rawData ? Object.keys(rawData) : [];
            console.log(`[HiDesk] rawData top-level keys: ${JSON.stringify(keys)}`);
            for (const key of keys) {
              const val = rawData[key];
              console.log(`[HiDesk] key="${key}" type=${typeof val} isArray=${Array.isArray(val)}, first 200 chars: ${JSON.stringify(val).substring(0, 200)}`);
            }
          }
        }
      } else {
        console.warn(`[HiDesk] raw request failed: ${rawRes.status}`);
        const errText = await rawRes.text();
        console.warn(`[HiDesk] raw error response: ${errText.substring(0, 500)}`);
      }

      const summary = `领域:${domainList.length} 数据集:${domainDataMap[hiDeskSelectedDomain || domainList[0]?.value]?.datasets?.length || 0} 视图:${domainDataMap[hiDeskSelectedDomain || domainList[0]?.value]?.views?.length || 0}`;
      console.log(`[HiDesk] Config fetch complete - ${summary}`);

      setHiDeskConfigured(true);
      setHiDeskTestResult({ success: true, message: `配置拉取成功 (${domainList.length}个领域)` });
    } catch (e) {
      console.error('[HiDesk] Config fetch exception:', e);
      const serviceDown = isServiceNotStartedError(e);
      setHiDeskTestResult({
        success: false,
        message: serviceDown ? 'HiDesk服务暂未启动' : ('拉取配置失败: ' + (e.message || '未知错误')),
      });
    } finally {
      setHiDeskFetchingConfig(false);
    }
  };

  const handleHiDeskDomainChange = async (domain) => {
    console.log(`[HiDesk] Switching domain: "${hiDeskSelectedDomain}" -> "${domain}"`);
    setHiDeskSelectedDomain(domain);
    setHiDeskSelectedView('');
    setHiDeskSelectedKbSn('');
    if (domain && hiDeskRawConfig) {
      const root = hiDeskRawConfig?.data || hiDeskRawConfig;
      const domainsObj = root?.platforms?.hidesk?.domains;
      const domainData = domainsObj?.[domain];
      if (domainData) {
        setHiDeskDatasets(Array.isArray(domainData.datasets) ? domainData.datasets : []);
        setHiDeskViews(Array.isArray(domainData.views) ? domainData.views : []);
        console.log(`[HiDesk] Domain "${domain}": datasets=${domainData.datasets?.length || 0}, views=${domainData.views?.length || 0}`);
      } else {
        setHiDeskDatasets([]);
        setHiDeskViews([]);
        console.log(`[HiDesk] Domain "${domain}" data not found`);
      }
    } else {
      setHiDeskDatasets([]);
      setHiDeskViews([]);
      console.log('[HiDesk] Cleared dataset/view list');
    }
  };

  const handleHiDeskViewChange = (viewKey) => {
    setHiDeskSelectedView(viewKey);
    if (!viewKey) {
      setHiDeskSelectedKbSn('');
      return;
    }
    const viewObj = hiDeskViews.find(v => (v.key || v.name || v.id) === viewKey);
    if (viewObj && viewObj.kb_sn) {
      setHiDeskSelectedKbSn(viewObj.kb_sn);
      console.log(`[HiDesk] Selected view "${viewKey}" -> kb_sn="${viewObj.kb_sn}"`);
    } else {
      console.warn(`[HiDesk] View "${viewKey}" has no kb_sn field, views:`, hiDeskViews);
      setHiDeskSelectedKbSn('');
    }
  };

  const handleHiDeskChatModeChange = (mode) => {
    setHiDeskChatMode(mode);
    writeMemoryFile({ hiDeskChatMode: mode });
  };

  const refreshHiDeskConnection = async () => {
    console.log('[HiDesk] Refreshing connection (test + fetch config)...');
    setHiDeskRefreshing(true);
    setHiDeskTestResult(null);

    const connResult = await testHiDeskConnection({ autoStartOnFailure: true });

    if (!connResult?.success) {
      setHiDeskRefreshing(false);
      return;
    }

    await fetchHiDeskConfig();
    setHiDeskRefreshing(false);
  };

  const handleHiDeskAutoStart = async () => {
    const memory = readMemoryFile();
    const remoteCfg = memory.hiDeskRemoteConfig || { ip: '7.212.122.246', remotePath: '/home/Knowledge_Management/HiDesk_Knowledge_API.exe' };
    if (!remoteCfg.ip || !remoteCfg.remotePath) {
      console.warn('[HiDesk] Remote config missing, skip auto-start');
      testHiDeskConnection({ autoStartOnFailure: false }).then(result => {
        if (result?.success !== false) fetchHiDeskConfig();
      });
      return;
    }

    const healthy = await testHiDeskConnection({ autoStartOnFailure: false });
    if (healthy?.success) {
      console.log('[HiDesk] Service is healthy, fetching config...');
      fetchHiDeskConfig();
      return;
    }

    console.log('[HiDesk] Service not healthy, attempting auto-start from remote...');
    await doHiDeskAutoStart();
  };

  return {
    getHiDeskBaseUrl,
    doHiDeskAutoStart,
    testHiDeskConnection,
    saveHiDeskDebugData,
    fetchHiDeskConfig,
    refreshHiDeskConnection,
    handleHiDeskDomainChange,
    handleHiDeskViewChange,
    handleHiDeskChatModeChange,
    handleHiDeskAutoStart,
  };
}
