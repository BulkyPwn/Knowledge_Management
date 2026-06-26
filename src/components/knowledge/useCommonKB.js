import { useState } from 'react';

/**
 * 公共知识库同步相关逻辑
 * @param {object}   deps.readMemoryFile      - 读取本地持久化配置
 * @param {function} deps.writeMemoryFile      - 写入本地持久化配置
 * @param {function} deps.registerCommonKbSubdirs - 注册公共知识库子文件夹
 * @param {function} deps.fetchKnowledgeBaseList  - 刷新知识库列表
 */
export function useCommonKB({ readMemoryFile, writeMemoryFile, registerCommonKbSubdirs, fetchKnowledgeBaseList }) {
  const [commonKbConfig, setCommonKbConfig] = useState({
    host: '7.212.122.246',
    port: 22,
    username: 'root',
    password: 'Huawei12#$',
    remotePath: '/home/Knowledge_Management/common',
    localPath: 'D:\\Knowledge_Management\\common',
  });
  const [commonKbCheckingLocal, setCommonKbCheckingLocal] = useState(false);
  const [commonKbCheckingServer, setCommonKbCheckingServer] = useState(false);
  const [commonKbSyncing, setCommonKbSyncing] = useState(false);
  const [commonKbStatus, setCommonKbStatus] = useState(null);
  const [commonKbLocalExists, setCommonKbLocalExists] = useState(null);
  const [commonKbServerReachable, setCommonKbServerReachable] = useState(null);
  const [showCommonKbConfig, setShowCommonKbConfig] = useState(false);

  const isCommonKb = (kb) => {
    const publicPath = commonKbConfig.localPath
      ? commonKbConfig.localPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      : '';
    if (!publicPath) return false;
    const kbPath = (kb.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return kbPath.startsWith(publicPath) && kbPath !== publicPath;
  };

  // 加载公共知识库配置（从 memory file 和服务端）
  const loadCommonKbConfig = async () => {
    const data = readMemoryFile();
    if (data.commonKbConfig) {
      setCommonKbConfig(prev => ({ ...prev, ...data.commonKbConfig }));
    }
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/config');
      const result = await resp.json();
      if (result.success && result.data) {
        const d = result.data;
        setCommonKbConfig(prev => ({
          ...prev,
          host: d.host || prev.host,
          port: d.port || prev.port,
          username: d.username || prev.username,
          remotePath: d.remote_path || prev.remotePath,
          localPath: d.local_path || prev.localPath,
        }));
      }
    } catch (e) {
      console.error('Failed to load common KB config:', e);
    }
  };

  // 保存公共知识库配置
  const saveCommonKbConfig = async () => {
    writeMemoryFile({ commonKbConfig });
    try {
      await fetch('http://127.0.0.1:5002/api/v1/common-kb/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: commonKbConfig.host,
          port: commonKbConfig.port,
          username: commonKbConfig.username,
          password: commonKbConfig.password,
          remote_path: commonKbConfig.remotePath,
          local_path: commonKbConfig.localPath,
        }),
      });
    } catch (e) {
      console.error('Failed to save common KB config to server:', e);
    }
  };

  // 检测本地公共知识库
  const checkCommonKbLocal = async () => {
    setCommonKbCheckingLocal(true);
    setCommonKbStatus(null);
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/check-local');
      const result = await resp.json();
      if (result.success && result.data) {
        setCommonKbLocalExists(result.data.exists);
        if (result.data.exists) {
          const subdirCount = result.data.total_items || 0;
          // 优先使用 API 返回的路径
          const localPath = result.data.path || commonKbConfig.localPath;
          setCommonKbStatus({ type: 'success', message: `公共知识库已存在 (${subdirCount} 个子项目)` });
          if (localPath) {
            try {
              await registerCommonKbSubdirs(localPath);
              await fetchKnowledgeBaseList();
              // 重新获取项目列表并统计各公共知识库的源文件总数
              const updatedResp = await fetch('http://127.0.0.1:5002/api/v1/projects');
              const updatedData = await updatedResp.json();
              const projects = (updatedData.data && updatedData.data.projects) ? updatedData.data.projects : [];
              const pp = localPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
              const publicProjects = projects.filter(kb => {
                const kp = (kb.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                return pp && kp.startsWith(pp) && kp !== pp;
              });
              let totalSourceFiles = 0;
              for (const kb of publicProjects) {
                if (kb.path) {
                  try {
                    const srcRes = await fetch(`http://127.0.0.1:5002/api/v1/projects/sources?project_path=${encodeURIComponent(kb.path)}&recursive=true`);
                    if (srcRes.ok) {
                      const srcData = await srcRes.json();
                      if (srcData.success && srcData.data?.sources) {
                        totalSourceFiles += srcData.data.sources.filter(s => !s.is_dir).length;
                      }
                    }
                  } catch { /* skip failed KB */ }
                }
              }
              setCommonKbStatus({ type: 'success', message: `公共知识库已存在: ${subdirCount} 个子项目, ${totalSourceFiles} 个源文件` });
            } catch (e) {
              console.error('Failed to register common KB:', e);
            }
          }
        } else {
          setCommonKbStatus({ type: 'info', message: '本地公共知识库不存在' });
        }
      } else {
        setCommonKbStatus({ type: 'error', message: result.message || '检测失败' });
      }
    } catch (e) {
      setCommonKbStatus({ type: 'error', message: `检测失败: ${e.message}` });
    } finally {
      setCommonKbCheckingLocal(false);
    }
  };

  // 检测服务器可达性
  const checkCommonKbServer = async () => {
    if (!commonKbConfig.host) {
      setCommonKbStatus({ type: 'error', message: '请先配置服务器 IP' });
      return;
    }
    setCommonKbCheckingServer(true);
    setCommonKbStatus(null);
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/check-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: commonKbConfig.host,
          port: commonKbConfig.port,
          username: commonKbConfig.username,
          password: commonKbConfig.password,
        }),
      });
      const result = await resp.json();
      if (result.success && result.data) {
        const d = result.data;
        setCommonKbServerReachable(d.server_reachable && d.ssh_authenticated);
        if (d.server_reachable && d.ssh_authenticated) {
          setCommonKbStatus({ type: 'success', message: '服务器可达，SSH 认证通过' });
        } else if (d.server_reachable) {
          setCommonKbStatus({ type: 'error', message: d.error || 'SSH 认证失败' });
          setCommonKbServerReachable(false);
        } else {
          setCommonKbStatus({ type: 'error', message: d.error || '服务器不可达' });
          setCommonKbServerReachable(false);
        }
      } else {
        setCommonKbStatus({ type: 'error', message: result.message || '检测失败' });
      }
    } catch (e) {
      setCommonKbStatus({ type: 'error', message: `检测失败: ${e.message}` });
    } finally {
      setCommonKbCheckingServer(false);
    }
  };

  // 同步公共知识库（完整流程：检测本地 → 检测服务器 → 下载）
  const syncCommonKb = async () => {
    if (!commonKbConfig.host) {
      setCommonKbStatus({ type: 'error', message: '请先配置服务器 IP' });
      return;
    }
    setCommonKbSyncing(true);
    if (commonKbLocalExists === false && commonKbConfig.host) {
      setCommonKbStatus({ type: 'info', message: '正在使用 SFTP 下载公共知识库...' });
    } else {
      setCommonKbStatus({ type: 'info', message: '正在检查并同步公共知识库...' });
    }
    try {
      const resp = await fetch('http://127.0.0.1:5002/api/v1/common-kb/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: commonKbConfig.host,
          port: commonKbConfig.port,
          username: commonKbConfig.username,
          password: commonKbConfig.password,
          remote_path: commonKbConfig.remotePath,
          local_path: commonKbConfig.localPath,
        }),
      });
      const result = await resp.json();

      if (!result.success) {
        setCommonKbSyncing(false);
        setCommonKbStatus({ type: 'error', message: result.data?.message || result.message || '同步启动失败' });
        return;
      }

      const taskId = result.data?.task_id;
      if (!taskId) {
        setCommonKbSyncing(false);
        setCommonKbStatus({ type: 'error', message: '未获取到任务 ID' });
        return;
      }

      // 轮询进度
      const pollProgress = async () => {
        try {
          const progResp = await fetch(`http://127.0.0.1:5002/api/v1/common-kb/sync-progress?task_id=${encodeURIComponent(taskId)}`);
          const progResult = await progResp.json();
          const prog = progResult.data || {};

          if (prog.status === 'downloading') {
            const downloaded = prog.downloaded_files || 0;
            const total = prog.total_files || 0;
            const progressMsg = total > 0
              ? `正在使用 SFTP 下载公共知识库... (${downloaded}/${total})`
              : prog.message || '正在下载中...';
            setCommonKbStatus({ type: 'info', message: progressMsg });
            return true;
          } else if (prog.status === 'running') {
            setCommonKbStatus({ type: 'info', message: prog.message || '准备中...' });
            return true;
          } else if (prog.status === 'done') {
            setCommonKbSyncing(false);
            setCommonKbLocalExists(true);
            setCommonKbStatus({ type: 'success', message: prog.message || '同步完成' });
            const localPath = commonKbConfig.localPath;
            if (localPath) {
              registerCommonKbSubdirs(localPath).catch(e => console.error('Failed to register common KB after sync:', e));
            }
            return false;
          } else if (prog.status === 'error') {
            setCommonKbSyncing(false);
            setCommonKbStatus({ type: 'error', message: prog.message || '同步失败' });
            return false;
          } else {
            // not_found 或其他未知状态
            setCommonKbStatus({ type: 'info', message: '准备同步...' });
            return true;
          }
        } catch (e) {
          return true;
        }
      };

      const intervalId = setInterval(async () => {
        const shouldContinue = await pollProgress();
        if (!shouldContinue) {
          clearInterval(intervalId);
        }
      }, 500);
    } catch (e) {
      setCommonKbSyncing(false);
      setCommonKbStatus({ type: 'error', message: `同步失败: ${e.message}` });
    }
  };

  return {
    commonKbConfig, setCommonKbConfig,
    commonKbCheckingLocal, commonKbCheckingServer, commonKbSyncing,
    commonKbStatus, setCommonKbStatus,
    commonKbLocalExists, setCommonKbLocalExists,
    commonKbServerReachable, setCommonKbServerReachable,
    showCommonKbConfig, setShowCommonKbConfig,
    isCommonKb,
    loadCommonKbConfig, saveCommonKbConfig,
    checkCommonKbLocal, checkCommonKbServer, syncCommonKb,
  };
}
