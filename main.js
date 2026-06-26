// 在企业网络环境中，代理可能使用自签名证书进行 SSL 检查，
// 需要禁用 TLS 证书验证以允许 HTTPS 请求通过代理。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');

// 打包模式下将控制台日志持久化到 run.log
function setupPackagedLogging() {
  if (!app.isPackaged) return;
  const fs = require('fs');
  const logPath = path.join(process.resourcesPath, '..', 'run.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  function writeLog(level, args) {
    const timestamp = new Date().toISOString();
    const msg = args.map(a => {
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
    logStream.write(`[${timestamp}] [${level}] ${msg}\n`);
  }

  console.log = function(...args) {
    try { writeLog('INFO', args); } catch {}
    origLog.apply(console, args);
  };
  console.warn = function(...args) {
    try { writeLog('WARN', args); } catch {}
    origWarn.apply(console, args);
  };
  console.error = function(...args) {
    try { writeLog('ERROR', args); } catch {}
    origError.apply(console, args);
  };
}

// 异步执行命令（不阻塞主进程）
function execAsync(cmd, options = {}) {
  const { exec } = require('child_process');
  return new Promise((resolve, reject) => {
    exec(cmd, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ========== 通用工具函数（替代 PowerShell 依赖） ==========

// 获取用户配置目录
function getUserConfigDir() {
  return path.join(require('os').homedir(), '.SSSC_AI');
}

// 获取默认配置文件在应用资源中的路径（dev / packaged 通用）
function getDefaultConfigPath(filename) {
  return path.join(__dirname, 'src', 'config', filename);
}

// 确保用户配置目录中存在配置文件（首次运行时从默认配置复制）
function ensureUserConfig() {
  const fs = require('fs');
  const userDir = getUserConfigDir();
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  const configFiles = ['models.json', 'knowledge_management.json'];
  for (const filename of configFiles) {
    const userPath = path.join(userDir, filename);
    if (!fs.existsSync(userPath)) {
      const defaultPath = getDefaultConfigPath(filename);
      if (fs.existsSync(defaultPath)) {
        try {
          fs.copyFileSync(defaultPath, userPath);
          console.log(`[config] Copied default ${filename} to ${userPath}`);
        } catch (err) {
          console.error(`[config] Failed to copy ${filename}:`, err.message);
        }
      } else {
        console.warn(`[config] Default ${filename} not found at ${defaultPath}`);
      }
    }
  }
}

// 读取是否启用本地知识管理（从 memory file）
function isLocalKnowledgeEnabled() {
  try {
    const memoryFile = path.join(require('os').homedir(), '.SSSC_AI', 'knowledge_management.json');
    if (require('fs').existsSync(memoryFile)) {
      const data = JSON.parse(require('fs').readFileSync(memoryFile, 'utf-8'));
      if (data && data.platforms && data.platforms.local === true) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

/** 读取预处理服务是否启用 */
function isPreprocessorEnabled() {
  try {
    const memoryFile = path.join(require('os').homedir(), '.SSSC_AI', 'knowledge_management.json');
    if (require('fs').existsSync(memoryFile)) {
      const data = JSON.parse(require('fs').readFileSync(memoryFile, 'utf-8'));
      const preprocessor = data && data.preprocessor;
      if (preprocessor && preprocessor.enabled === true) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

// 读取用户配置的代理地址（从 memory file）
function getUserProxyConfig() {
  try {
    const memoryFile = path.join(require('os').homedir(), '.SSSC_AI', 'knowledge_management.json');
    if (require('fs').existsSync(memoryFile)) {
      const data = JSON.parse(require('fs').readFileSync(memoryFile, 'utf-8'));
      if (data && data.proxyEnabled && data.proxyUrl && data.proxyUrl.trim()) {
        console.log('[download] Using user-configured proxy:', data.proxyUrl);
        return data.proxyUrl.trim();
      }
    }
  } catch (_) {}
  return null;
}

// 使用系统命令下载，速度与浏览器一致
// options: { timeoutMs, maxRetries, proxyUrl }
async function downloadFile(url, destPath, options = {}) {
  const { timeoutMs = 600000, maxRetries = 3 } = options;

  // 优先级：用户配置 > 系统环境变量
  const proxyUrl = options.proxyUrl || getUserProxyConfig();
  const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

  // 方案 1：bitsadmin.exe（Windows 内置 BITS，最稳定，但不支持代理）
  if (!effectiveProxy) {
    try {
      await downloadFileBits(url, destPath, timeoutMs, maxRetries);
      return;
    } catch (bitsErr) {
      if (bitsErr.code === 'ENOENT' || /not found/i.test(bitsErr.message)) {
        console.log('[download] bitsadmin.exe not found, try curl...');
      } else {
        console.warn('[download] bitsadmin failed:', bitsErr.message);
      }
    }
  }

  // 方案 2：curl.exe（HTTP/2 优先，自动降级 + 断点续传，支持代理）
  try {
    await downloadFileCurl(url, destPath, timeoutMs, maxRetries, effectiveProxy);
    return;
  } catch (curlErr) {
    if (curlErr.code === 'ENOENT' || /not found/i.test(curlErr.message)) {
      console.log('[download] curl.exe not found, fallback to Node.js...');
    } else {
      console.warn('[download] curl failed:', curlErr.message);
    }
  }

  // 方案 3：Node.js 原生 HTTP(S)
  console.log('[download] fallback to Node.js HTTP');
  await downloadFileNodeJs(url, destPath, timeoutMs, maxRetries, effectiveProxy);
}

// ---------- 方案 2：curl.exe ----------
async function downloadFileCurl(url, destPath, timeoutMs, maxRetries, proxyUrl) {
  const fs = require('fs');

  // proxyUrl 非空时强制使用代理，否则检测系统环境变量
  let proxyFlag;
  if (proxyUrl) {
    proxyFlag = ['--proxy', proxyUrl];
    console.log('[download-curl] using proxy:', proxyUrl);
  } else {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const proxyEnv = isHttps
      ? (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
      : (process.env.HTTP_PROXY || process.env.http_proxy);
    const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim());
    function isBypassed(host) {
      return noProxy.some(p => p === '*' || (p.startsWith('.') ? host.endsWith(p) || host === p.slice(1) : host === p));
    }
    proxyFlag = (proxyEnv && !isBypassed(new URL(url).hostname)) ? ['--proxy', proxyEnv] : ['--noproxy', '*'];
  }

  // 单次尝试超时 3 分钟，足够检测停滞；通过重试次数控制总时间预算
  const PER_ATTEMPT_TIMEOUT = 180; // 秒
  const effectiveRetries = Math.max(maxRetries, Math.ceil(timeoutMs / 1000 / PER_ATTEMPT_TIMEOUT) - 1);

  let lastError;
  for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`[download-curl] Retry ${attempt}/${effectiveRetries}, waiting ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      // 不删除已下载的部分文件，curl -C - 会自动断点续传
    }

    // 如果有已下载的部分文件，使用 -C - 断点续传；否则从头下载
    const hasPartial = fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
    if (hasPartial) {
      console.log(`[download-curl] Resuming download, already downloaded ${fs.statSync(destPath).size} bytes`);
    }

    try {
      const { spawn } = require('child_process');

      let ok = false;
      // HTTP/2 优先，不支持则回退 HTTP/1.1
      for (const extraArgs of [['--http2'], []]) {
        const curlArgs = ['-f', '-L', '-s', '-S',
          '--connect-timeout', '15',
          '--max-time', String(PER_ATTEMPT_TIMEOUT),
          '-A', 'OneStopDesktopTool/1.0',
          '-o', destPath,
          ...proxyFlag,
          ...(hasPartial ? ['-C', '-'] : []),
          ...extraArgs,
          url,
        ];
        try {
          await new Promise((resolve, reject) => {
            const child = spawn('curl.exe', curlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('close', (code) => {
              if (code === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) resolve();
              else reject(new Error(stderr.trim() || `curl exit ${code}`));
            });
            child.on('error', (err) => reject(err));
            setTimeout(() => { child.kill(); reject(new Error('下载超时')); }, PER_ATTEMPT_TIMEOUT * 1000 + 30000);
          });
          ok = true;
          break;
        } catch (e) {
          if (/http2.*not support|does not support.*http2/i.test(e.message)) { console.log('[download-curl] HTTP/2 not supported, retry HTTP/1.1'); continue; }
          throw e;
        }
      }
      if (ok) return;
    } catch (err) {
      lastError = err;
      if (err.code === 'ENOENT' || /not found|ENOENT/i.test(err.message)) throw err;
      if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|timeout|timed out|reset|refused|curl.*(6|7|28|35|52|55|56)/i.test(err.message) && attempt < maxRetries) {
        console.warn(`[download-curl] Error (attempt ${attempt + 1}): ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('curl 下载失败');
}

// ---------- 方案 1：bitsadmin.exe（Windows BITS）----------
async function downloadFileBits(url, destPath, timeoutMs, maxRetries) {
  const fs = require('fs');
  const { spawn } = require('child_process');
  const jobName = `OneStopDL_${Date.now()}`;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`[download-bits] Retry ${attempt}/${maxRetries}, waiting ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      // BITS 自带断点续传，不删除已下载的部分
      try {
        await new Promise((resolve) => {
          const c = spawn('bitsadmin.exe', ['/cancel', jobName], { stdio: 'ignore' });
          c.on('close', resolve);
        });
      } catch {}
    }

    try {
      // BITS /transfer 会自动处理重定向和 HTTPS
      await new Promise((resolve, reject) => {
        const child = spawn('bitsadmin.exe', [
          '/transfer', jobName,
          '/download', '/priority', 'FOREGROUND',
          url, destPath,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stdout += d.toString(); }); // bitsadmin prints to stderr

        const timer = setTimeout(() => { child.kill(); reject(new Error('BITS 下载超时')); }, timeoutMs + 30000);

        child.on('close', (code) => {
          clearTimeout(timer);
          const output = stdout + stderr;
          if (code === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
            resolve();
          } else if (/ERROR_FILE_NOT_FOUND|Access is denied|HRESULT: 0x/i.test(output)) {
            reject(new Error(output.trim().split('\n').pop() || 'BITS download failed'));
          } else if (code !== 0) {
            reject(new Error(`BITS exit ${code}: ${output.slice(-200).trim()}`));
          } else {
            reject(new Error('BITS 下载的文件大小为 0'));
          }
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return;
    } catch (err) {
      lastError = err;
      if (err.code === 'ENOENT' || /not found/i.test(err.message)) throw err;
      if (attempt < maxRetries) {
        console.warn(`[download-bits] Error (attempt ${attempt + 1}): ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('BITS 下载失败');
}

// ---------- 方案 3：Node.js 原生 HTTP(S) ----------
async function downloadFileNodeJs(url, destPath, timeoutMs = 180000, maxRetries = 0, proxyUrl) {
  const fs = require('fs');
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`[download-node] Retry ${attempt}/${maxRetries}, waiting ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      try { fs.unlinkSync(destPath); } catch {}
    }
    try {
      await downloadFileNodeJsOnce(url, destPath, timeoutMs, proxyUrl);
      return;
    } catch (err) {
      lastError = err;
      if (err.message && /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EPIPE|socket hang up|read ECONNRESET)/.test(err.message)) {
        console.warn(`[download-node] Network error (attempt ${attempt + 1}): ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('下载失败：已达最大重试次数');
}

function downloadFileNodeJsOnce(url, destPath, timeoutMs = 180000, proxyUrl) {
  const fs = require('fs');
  const urlObj = new URL(url);
  const isHttps = urlObj.protocol === 'https:';

  // 优先级：传入 proxyUrl > 系统环境变量
  const proxyEnv = proxyUrl || (
    isHttps
      ? (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
      : (process.env.HTTP_PROXY || process.env.http_proxy)
  );
  const noProxy = proxyUrl ? '' : (process.env.NO_PROXY || process.env.no_proxy || '');
  const noProxyList = noProxy.split(',').map(s => s.trim());

  function isBypassed(host) {
    if (proxyUrl) return false; // 用户显式指定代理时不绕过
    return noProxyList.some(pattern => {
      if (pattern === '*') return true;
      if (pattern.startsWith('.')) return host.endsWith(pattern) || host === pattern.slice(1);
      return host === pattern;
    });
  }

  return new Promise((resolve, reject) => {
    const requestOptions = {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'OneStopDesktopTool/1.0',
      },
      rejectUnauthorized: false,
    };

    // 如果配置了代理且未绕过，通过代理连接
    if (proxyEnv && !isBypassed(urlObj.hostname)) {
      try {
        const proxyUrl = new URL(proxyEnv);
        const proxyOpts = {
          host: proxyUrl.hostname,
          port: proxyUrl.port || (isHttps ? 443 : 80),
          method: 'CONNECT',
          path: `${urlObj.hostname}:${urlObj.port || (isHttps ? 443 : 80)}`,
          timeout: timeoutMs,
        };
        // 代理认证
        if (proxyUrl.username) {
          proxyOpts.headers = {
            'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxyUrl.username}:${proxyUrl.password || ''}`).toString('base64'),
          };
        }
        const httpMod = require('http');
        const tunnelReq = httpMod.request(proxyOpts);
        // 代理返回非 2xx（如 401/407 认证失败）时，connect 事件不会触发，
        // 而是触发 response 事件。需要捕获并回退到直连。
        tunnelReq.on('response', (proxyRes) => {
          console.warn(`[download] Proxy returned HTTP ${proxyRes.statusCode}, falling back to direct connection`);
          proxyRes.resume(); // 消费响应体防止内存泄漏
          tunnelReq.destroy();
          directDownload();
        });
        tunnelReq.on('connect', (_, socket) => {
          const transport = isHttps ? require('https') : require('http');
          const req = transport.get({
            host: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            socket: socket,
            agent: false,
            ...requestOptions,
          }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              req.destroy();
              return resolve(downloadFileNodeJsOnce(res.headers.location, destPath, timeoutMs));
            }
            if (res.statusCode !== 200) {
              req.destroy();
              return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => { file.close(() => resolve()); });
            file.on('error', (e) => { try { fs.unlinkSync(destPath); } catch {} reject(e); });
            res.on('error', (e) => { try { fs.unlinkSync(destPath); } catch {} reject(e); });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
        });
        tunnelReq.on('error', (err) => {
          console.warn('[download] Proxy connection failed, falling back to direct:', err.message);
          directDownload();
        });
        tunnelReq.on('timeout', () => { tunnelReq.destroy(); reject(new Error('代理连接超时')); });
        tunnelReq.end();
        return;
      } catch (proxyErr) {
        console.warn('[download] Failed to parse proxy config, falling back to direct:', proxyErr.message);
      }
    }

    // 直连下载
    directDownload();

    function directDownload() {
      const transport = isHttps ? require('https') : require('http');
      const req = transport.get(url, requestOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          req.destroy();
          return resolve(downloadFileNodeJsOnce(res.headers.location, destPath, timeoutMs));
        }
        if (res.statusCode !== 200) {
          req.destroy();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => { file.close(() => resolve()); });
        file.on('error', (e) => { try { fs.unlinkSync(destPath); } catch {} reject(e); });
        res.on('error', (e) => { try { fs.unlinkSync(destPath); } catch {} reject(e); });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    }
  });
}

// 解压 zip 文件（兼容所有 Windows 版本），替代 Expand-Archive
async function extractZip(zipPath, destDir) {
  const fs = require('fs');
  fs.mkdirSync(destDir, { recursive: true });

  // 先移除 Mark-of-the-Web，避免下载的 zip 被 Windows 安全策略阻止解压
  try {
    await new Promise((resolve) => {
      const child = spawn('powershell', ['-NoProfile', '-Command',
        `Unblock-File -Path '${zipPath.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`
      ], { stdio: 'ignore', timeout: 10000 });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
  } catch { /* 非关键步骤，忽略 */ }

  // 方案1：PowerShell Expand-Archive（Win10+/PS5.0+）
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive exit ${code}`)));
      child.on('error', reject);
    });
    return true;
  } catch { /* 回退 */ }

  // 方案2：.NET ZipFile（.NET 4.5+，Win7 SP1+）
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('powershell', ['-NoProfile', '-Command',
        `[System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem'); [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${destDir.replace(/'/g, "''")}')`
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ZipFile exit ${code}`)));
      child.on('error', reject);
    });
    return true;
  } catch { /* 回退 */ }

  // 方案3：tar 命令（Windows 10 build 17063+ 内置，不受 Mark-of-the-Web 影响）
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xf', zipPath, '-C', destDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
      child.on('error', reject);
    });
    return true;
  } catch { /* 回退 */ }

  // 方案4：COM Shell.Application（所有 Windows，XP 起均支持）
  const vbsPath = path.join(require('os').tmpdir(), '_extract_' + Date.now() + '.vbs');
  const vbsContent = `
Set sa = CreateObject("Shell.Application")
Set fso = CreateObject("Scripting.FileSystemObject")
' 确保目标目录存在
If Not fso.FolderExists("${destDir.replace(/\\/g, '\\\\')}") Then
  fso.CreateFolder("${destDir.replace(/\\/g, '\\\\')}")
End If
Set src = sa.NameSpace("${zipPath.replace(/\\/g, '\\\\')}")
Set dest = sa.NameSpace("${destDir.replace(/\\/g, '\\\\')}")
If IsNull(dest) Or IsNull(src) Then
  WScript.Echo "FAIL:CanNotOpen"
  WScript.Quit 1
End If
srcItemsCount = src.Items().Count
dest.CopyHere src.Items(), 16
' 等待复制完成（最多120秒，每2秒检查一次）
WScript.Sleep 2000
For i = 1 To 60
  ' 检查目的地文件数是否达到源文件数
  On Error Resume Next
  destCount = dest.Items().Count
  On Error GoTo 0
  If destCount >= srcItemsCount Then Exit For
  WScript.Sleep 2000
Next
WScript.Echo "OK"
`;
  fs.writeFileSync(vbsPath, vbsContent);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('cscript', ['//NoLogo', vbsPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180000,
      });
      let output = '';
      child.stdout.on('data', (d) => { output += d.toString(); });
      child.on('close', (code) => {
        if (output.includes('OK')) return resolve();
        reject(new Error('COM extraction failed'));
      });
      child.on('error', reject);
    });
    return true;
  } finally {
    try { fs.unlinkSync(vbsPath); } catch {}
  }
}

// 检查系统 PATH 中是否存在某命令，返回完整路径或 null（替代 Get-Command）
function checkCommandOnPath(cmd) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`where "${cmd}" 2>nul`, { timeout: 5000, encoding: 'utf-8' }, (err, out) => {
      if (err || !out) return resolve(null);
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      resolve(lines.length > 0 ? lines[0] : null);
    });
  });
}

// 检查进程是否在运行（使用 tasklist，替代 Get-Process）
function checkProcessRunning(name) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`tasklist /FI "IMAGENAME eq ${name}" 2>nul | find /I "${name}" >nul`, {
      timeout: 5000,
    }, (err) => {
      resolve(!err);
    });
  });
}

// 从注册表 Uninstall 键查找应用安装路径（使用 reg query，替代 Get-ItemProperty）
async function findInstalledAppPath(appDisplayName) {
  const { exec } = require('child_process');
  const regKeys = [
    ['HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/reg:64'],
    ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/reg:32'],
    ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', null],
  ];
  const execReg = (cmd) => new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10000, encoding: 'utf-8' }, (err, out) => {
      if (err) return reject(err);
      resolve(out);
    });
  });
  for (const [key, regOpt] of regKeys) {
    try {
      const optStr = regOpt ? ` ${regOpt}` : '';
      const subKeys = await execReg(`reg query "${key}"${optStr} 2>nul`);
      const lines = subKeys.split(/\r?\n/).filter(l => l.trim());
      for (const line of lines) {
        const subKey = line.trim();
        try {
          const info = await execReg(`reg query "${subKey}"${optStr} /v DisplayName 2>nul`);
          if (info.toLowerCase().includes(appDisplayName.toLowerCase())) {
            // 找到匹配，查询 InstallLocation
            try {
              const loc = await execReg(`reg query "${subKey}"${optStr} /v InstallLocation 2>nul`);
              const match = loc.match(/InstallLocation\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
              if (match) return match[1].trim();
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }
  return null;
}

let mainWindow;
let mcpProcess = null;
let mcpMode = null;
let mcpDebugInfo = { restartCount: 0, lastError: null };
let mcpHealthCheckInterval = null;

// ---- MCP Logging Helper ----
function logMcp(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [mcp-server] [${level.toUpperCase()}]`;
  switch (level) {
    case 'error':
      console.error(prefix, message);
      break;
    case 'warn':
      console.warn(prefix, message);
      break;
    case 'debug':
      console.debug(prefix, message);
      break;
    default:
      console.log(prefix, message);
  }
}
let wikiProcess = null;
let sftpProcess = null;
let hideskProcess = null;
let preprocessorProcess = null;
let llmWikiProcess = null;

// 当前应用生命周期内 spawn 过的所有子进程 PID（用于退出时精确清理）
// 始终包含主进程自身 PID，使进程树有根节点
const spawnedPids = new Set([process.pid]);
const _installerPids = new Set();

// 待执行的自动启动任务（当 KMA 未就绪时暂存）
let pendingAutoTasks = [];

// ============================================================
//  W3 用户名密码校验（Cookie 方式，与 HaiwenClient 一致）
// ============================================================
// 参考 haiwen_client.py 的 login 方法：
//   POST https://login.huawei.com/login1/rest/hwidcenter/login
//   Body: { lang, loginAccount, password, uid }
//   成功返回 200 + Set-Cookie → 说明用户名密码正确

const W3_LOGIN_URL = 'https://login.huawei.com/login1/rest/hwidcenter/login';

function _extractCookieString(setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return '';
  const parts = [];
  for (const h of setCookieHeaders) {
    const p = (h || '').split(';')[0].trim();
    if (p) parts.push(p);
  }
  return parts.join('; ');
}

async function verifyW3Credentials(uid, password) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      lang: 'zh_CN',
      loginAccount: uid,
      password: password,
      uid: uid,
    });

    const u = new URL(W3_LOGIN_URL);
    const options = {
      method: 'POST',
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const setCookieHeaders = res.headers['set-cookie'] || [];
          const cookieStr = _extractCookieString(setCookieHeaders);
          if (cookieStr) {
            console.log('[w3-verify] login success, got cookies for', uid);
            resolve({ success: true, cookies: cookieStr });
            return;
          }
          // 200 但无 Cookie → 可能是 JSON 错误响应
          try {
            const data = JSON.parse(chunks);
            resolve({ success: false, error: data.error || data.message || '账号或密码错误' });
          } catch {
            resolve({ success: false, error: '账号或密码错误' });
          }
          return;
        }

        // 非 200 统一视为认证失败，尝试从响应中提取详细错误信息
        let errMsg = '账号或密码错误';
        try {
          const data = JSON.parse(chunks);
          if (data.error) errMsg = data.error;
          else if (data.message) errMsg = data.message;
        } catch {}
        console.log('[w3-verify] login failed:', res.statusCode, errMsg);
        resolve({ success: false, error: errMsg });
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: `网络请求异常: ${err.message}` });
    });
    req.setTimeout(15000, () => {
      req.destroy(new Error('W3 login timeout'));
    });
    req.write(body);
    req.end();
  });
}

function createWindow() {
  console.log('Creating window...');
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    title: 'AI一站式桌面',
    backgroundColor: '#111827',
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'build', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    console.log('Window ready to show');
    mainWindow.show();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Page loaded successfully');
  });

  ipcMain.on('theme-changed', (event, newTheme) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bgColors = {
      dark: '#111827',
      light: '#ffffff',
      gray: '#374151',
    };
    mainWindow.setBackgroundColor(bgColors[newTheme] || bgColors.dark);
  });

  ipcMain.handle('window-minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); });
  ipcMain.handle('window-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
    mainWindow.maximize(); return true;
  });
  ipcMain.handle('window-close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });
  ipcMain.handle('window-is-maximized', () => { return mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized(); });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`Page load failed: ${errorCode} - ${errorDescription}`);
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`Console: ${message}`);
  });

  // 如需调试，取消下行注释或在窗口中按 Ctrl+Shift+I 打开 DevTools
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () {
    console.log('Window closed');
    killLlmWikiProcesses();
    if (sftpProcess && !sftpProcess.killed) {
      sftpProcess.kill();
      sftpProcess = null;
    }
    mainWindow = null;
  });

  Menu.setApplicationMenu(null);
  
  console.log('Window created');
}

app.on('ready', async () => {
  setupPackagedLogging();
  console.log('App ready');
  ensureUserConfig();
  createWindow();

  // 异步执行清理和启动，不阻塞窗口显示
  (async () => {
    await killLlmWikiProcesses();
    await killPortProcesses(5002);
    await killPortProcesses(5003);

    // 启动 SFTP 服务（独立于 KMA Server）
    (async () => {
      try {
        console.log('[auto-start] Starting SFTP service...');
        const sftpResult = await startSftpService();
        if (sftpResult.success) {
          console.log('[auto-start] SFTP service ready on port 5003');
        } else {
          console.log('[auto-start] SFTP service start failed:', sftpResult.message);
        }
      } catch (e) {
        console.error('[auto-start] SFTP service error:', e.message);
      }
    })();

    try {
      // 检查用户是否启用了本地知识管理
      if (!isLocalKnowledgeEnabled()) {
        console.log('[auto-start] Local knowledge management not enabled, skipping KMA / KMA Server / MCP auto-start');
      } else {
        // 并行启动 KMA 和 KMA Server
        console.log('[auto-start] Starting KMA and KMA Server in parallel...');
        sendAutoStartTaskStatus('kma', { status: 'running', message: '正在启动 KMA...' });
        sendAutoStartTaskStatus('wiki-server', { status: 'running', message: '正在启动 KMA Server...' });

        const kmaPromise = startLlmWikiHeadless().then(async (result) => {
          if (result.success) {
            console.log('[auto-start] KMA process spawned, waiting for port 19828...');
            const ready = await waitForPort('127.0.0.1', 19828, 30000, 500);
            if (ready) {
              sendAutoStartTaskStatus('kma', { status: 'completed', message: 'KMA 已就绪 (端口 19828)' });
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('kma-status-changed', { running: true });
              }
              return { component: 'kma', success: true };
            }
            sendAutoStartTaskStatus('kma', { status: 'failed', message: 'KMA 启动超时' });
            return { component: 'kma', success: false };
          }
          if (result.message === '未找到 llm-wiki.exe') {
            sendAutoStartTaskStatus('kma', { status: 'completed', message: 'KMA 未安装，跳过' });
          } else {
            sendAutoStartTaskStatus('kma', { status: 'failed', message: result.message || 'KMA 启动失败' });
          }
          return { component: 'kma', success: false };
        }).catch((err) => {
          console.error('[auto-start] KMA start error:', err.message);
          sendAutoStartTaskStatus('kma', { status: 'failed', message: 'KMA 启动异常: ' + err.message });
          return { component: 'kma', success: false };
        });

        const wikiPromise = startWikiServer().then((result) => {
          if (result.success) {
            sendAutoStartTaskStatus('wiki-server', { status: 'completed', message: 'KMA Server 已就绪' });
            return { component: 'wiki-server', success: true };
          }
          sendAutoStartTaskStatus('wiki-server', { status: 'failed', message: 'KMA Server 启动失败' });
          return { component: 'wiki-server', success: false };
        });

        const [kmaResult, wikiResult] = await Promise.all([kmaPromise, wikiPromise]);
        logMcp('info', `Auto-start: KMA=${kmaResult.success}, Wiki=${wikiResult.success}`);

        // KMA Server 就绪后启动 MCP
        if (wikiResult.success) {
          logMcp('info', 'KMA Server ready, starting MCP in auto-start sequence...');
          sendAutoStartTaskStatus('mcp-server', { status: 'running', message: '正在启动 KMA MCP...' });
          const mcpResult = await doStartMcpServer('http');
          if (mcpResult.success) {
            logMcp('info', 'MCP server started on port 9011 (auto-start)');
            sendAutoStartTaskStatus('mcp-server', { status: 'completed', message: 'KMA MCP 已就绪 (端口 9011)' });
          } else {
            logMcp('error', `MCP auto-start failed: ${mcpResult.message}`);
            sendAutoStartTaskStatus('mcp-server', { status: 'failed', message: 'KMA MCP 启动失败: ' + mcpResult.message });
          }
        } else {
          pendingAutoTasks = ['wiki-server', 'mcp-server'];
          console.log('[auto-start] Wiki Server / MCP added to pending startup queue');
        }

        // KMA 启动后尝试自动启动预处理服务
        if (kmaResult && kmaResult.success) {
          try {
            if (isPreprocessorEnabled()) {
              console.log('[auto-start] Preprocessor enabled, starting...');
              sendAutoStartTaskStatus('preprocessor', { status: 'running', message: '正在启动预处理服务...' });
              const preprocessorResult = await doStartPreprocessorService(5900, {});
              if (preprocessorResult.success) {
                console.log('[auto-start] Preprocessor service ready on port 5900');
                sendAutoStartTaskStatus('preprocessor', { status: 'completed', message: '预处理服务已就绪 (端口 5900)' });
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('preprocessor-status-changed', { running: true, port: 5900 });
                }
              } else {
                console.log('[auto-start] Preprocessor start failed:', preprocessorResult.message);
                sendAutoStartTaskStatus('preprocessor', { status: 'failed', message: '预处理服务启动失败: ' + preprocessorResult.message });
              }
            } else {
              console.log('[auto-start] Preprocessor not enabled, skipping');
            }
          } catch (e) {
            console.error('[auto-start] Preprocessor start error:', e.message);
          }
        }
      }
    } catch (e) {
      console.error('[auto-start] Error:', e.message);
    }

    // 启动 LLM Wiki Review 轮询（在 KMA 启动后）
    startLlmWikiReviewPolling();

    // 启动依赖工具更新后台检测
    startDependencyToolUpdateCheck();
  })();

});

app.on('window-all-closed', function () {
  console.log('All windows closed');
  stopLlmWikiReviewPolling();
  stopDependencyToolUpdateCheck();
  killAllSpawnedProcesses();
  if (process.platform !== 'darwin') app.quit();
});

// 兜底：确保退出时所有子进程被清理（即使 window-all-closed 未触发）
app.on('before-quit', () => {
  killAllSpawnedProcesses();
});

app.on('will-quit', () => {
  // 最终兜底：同步清理所有已知子进程（排除主进程自身和安装程序进程）
  if (process.platform === 'win32') {
    // 1. PID 级别清理（跳过安装程序进程及其子进程树）
    const pids = Array.from(spawnedPids).filter(pid => pid !== process.pid && !_installerPids.has(pid));
    for (const pid of pids) {
      try {
        require('child_process').execSync(`taskkill /F /T /PID ${pid} 2>nul`, { timeout: 5000, stdio: 'ignore' });
      } catch {}
    }
    spawnedPids.clear();

    // 2. 镜像名级别兜底：防止 detached 进程脱离进程树后残留（不杀 msiexec.exe）
    const fallbackImages = [
      'llm-wiki.exe',
      'HiDesk_Knowledge_API.exe',
      'cloudmodeling-processor.exe',
    ];
    for (const img of fallbackImages) {
      try {
        require('child_process').execSync(`taskkill /F /IM ${img} 2>nul`, { timeout: 5000, stdio: 'ignore' });
      } catch {}
    }

    // 3. 端口级别兜底：Python 子进程无法用镜像名区分，用端口清理
    const rescuePorts = [5002, 5003, 9010, 9011, 5858, 5900];
    for (const port of rescuePorts) {
      killProcessOnPortSync(port);
    }
  }
});

app.on('activate', function () {
  console.log('App activated');
  if (mainWindow === null) createWindow();
});

ipcMain.handle('get-app-path', () => {
  return app.getAppPath();
});

// ---- W3 用户名密码校验 ----
ipcMain.handle('verify-w3-credentials', async (event, { uid, password }) => {
  return await verifyW3Credentials(uid, password);
});

// 代理配置读写（与 Settings UI 交互）
ipcMain.handle('get-proxy-config', () => {
  try {
    const fs = require('fs');
    const memoryFile = path.join(require('os').homedir(), '.SSSC_AI', 'knowledge_management.json');
    if (fs.existsSync(memoryFile)) {
      const data = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
      return {
        proxyEnabled: !!data.proxyEnabled,
        proxyUrl: data.proxyUrl || '',
      };
    }
  } catch (_) {}
  return { proxyEnabled: false, proxyUrl: '' };
});

ipcMain.handle('set-proxy-config', async (event, { proxyEnabled, proxyUrl }) => {
  try {
    const fs = require('fs');
    const memoryFile = path.join(require('os').homedir(), '.SSSC_AI', 'knowledge_management.json');
    const dir = path.dirname(memoryFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let data = {};
    if (fs.existsSync(memoryFile)) {
      try { data = JSON.parse(fs.readFileSync(memoryFile, 'utf-8')); } catch (_) {}
    }
    Object.assign(data, { proxyEnabled, proxyUrl });
    fs.writeFileSync(memoryFile, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[proxy] config saved:', { proxyEnabled, proxyUrl });
    return { success: true };
  } catch (err) {
    console.error('[proxy] save failed:', err.message);
    return { success: false };
  }
});

ipcMain.handle('open-file-dialog', async (event, options) => {
  const properties = Array.isArray(options) ? options : (options?.properties || ['openFile', 'openDirectory']);
  const defaultPath = (options && !Array.isArray(options) && options.defaultPath) || undefined;
  const filters = (options && !Array.isArray(options) && options.filters) || undefined;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties,
    ...(defaultPath ? { defaultPath } : {}),
    ...(filters ? { filters } : {}),
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    if (properties.includes('multiSelections')) {
      return result.filePaths;
    }
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('save-chat-history', async (event, options) => {
  const { title, defaultPath, filters, content } = options || {};
  const win = BrowserWindow.fromWebContents(event.sender);
  
  const result = await dialog.showSaveDialog(win, {
    title: title || '保存文件',
    defaultPath: defaultPath,
    filters: filters || [{ name: '所有文件', extensions: ['*'] }],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  try {
    const fs = require('fs');
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { canceled: false, filePath: result.filePath };
  } catch (err) {
    return { canceled: false, filePath: result.filePath, error: err.message };
  }
});

ipcMain.handle('open-file-path', async (event, filePath) => {
  const result = await shell.openPath(filePath);
  if (result) {
    return { success: false, error: result };
  }
  return { success: true };
});

ipcMain.handle('open-user-guide', async () => {
  const frontPageUrl = 'https://onestop.anytest.huawei.com/aiAssistCenter/frontPage';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(frontPageUrl, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      await shell.openExternal(frontPageUrl);
      return { success: true };
    }
  } catch {
    // URL 不可联通，回退为打开本地用户指南
  }

  const guidePath = app.isPackaged
    ? path.join(process.resourcesPath, 'User-Guide.md')
    : path.join(__dirname, 'User-Guide.md');
  await shell.openPath(guidePath);
  return { success: true };
});

function getBackendBasePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'knowledge_management');
  }
  return path.join(__dirname, 'src', 'backend', 'knowledge_management');
}

function getMcpServerPath() {
  return path.join(getBackendBasePath(), 'llm_wiki_mcp_server', 'mcp_server.py');
}

function getWikiServerPath() {
  return path.join(getBackendBasePath(), 'llm_wiki_server', 'app.py');
}

function getSftpServicePath() {
  return path.join(getBackendBasePath(), 'llm_wiki_server', 'sftp_service.py');
}

// ========== SCP 加速下载模块 ==========

// 加载 SFTP 加速服务器配置（从 sftp_accelerator_config.json, name 为 key 的字典）
function loadServerConfig() {
  const fs = require('fs');
  const configPath = path.join(getBackendBasePath(), 'llm_wiki_server', 'config', 'sftp_accelerator_config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config && typeof config === 'object' && !Array.isArray(config)) {
        // 字典格式 { name: { host, port, ... } } → 转为数组
        return Object.entries(config).map(([name, server]) => ({ name, ...server }));
      }
    }
  } catch (e) {
    console.error('[scp] Failed to load server config:', e.message);
  }
  return [];
}

// 尝试从服务器通过 SFTP 拷贝单个文件，用于加速下载
// SFTP 操作总超时（毫秒），包含 require ssh2、连接、传输全流程
const SCP_TOTAL_TIMEOUT = 8000;

// 服务器可达性缓存：每个服务器独立缓存，避免重复等待超时
const _scpReachabilityCache = new Map(); // key = "host:port" -> true/false

async function checkScpReachability(host, port) {
  const cacheKey = `${host}:${port}`;
  if (_scpReachabilityCache.has(cacheKey)) {
    return _scpReachabilityCache.get(cacheKey);
  }

  console.log(`[scp] Quick reachability probe to ${host}:${port}...`);
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        const net = require('net');
        const sock = new net.Socket();
        sock.setTimeout(2000);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); reject(new Error('TCP timeout')); });
        sock.on('error', (e) => { sock.destroy(); reject(e); });
        sock.connect(port, host);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Probe timeout')), 2500)),
    ]);
    console.log(`[scp] Server ${host}:${port} reachable via TCP`);
    _scpReachabilityCache.set(cacheKey, true);
  } catch (e) {
    console.log(`[scp] Server ${host}:${port} unreachable (${e.message})`);
    _scpReachabilityCache.set(cacheKey, false);
  }
  return _scpReachabilityCache.get(cacheKey);
}

// 返回 { success: true, localPath } 或 { success: false, message }
// basePath: 服务器端目录，若不传则使用 server.remote_path（知识库数据），
//           传了则直接拼接（用于二进制文件下载，如 /home/Knowledge_Management）
// 遍历所有配置的 SFTP 服务器，依次尝试，任意一台成功即返回
async function tryScpFile(remoteFileName, localDestPath, basePath) {
  const servers = loadServerConfig();
  if (!servers || servers.length === 0) {
    console.log('[scp] No server configured, skip SCP acceleration');
    return { success: false, message: '未配置 SFTP 服务器' };
  }

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    const host = server.host;
    const port = server.port || 22;
    const serverLabel = server.name ? `${server.name} (${host}:${port})` : `${host}:${port}`;

    // 快速可达性预检（首次探测，后续走缓存）
    const reachable = await checkScpReachability(host, port);
    if (!reachable) {
      console.log(`[scp] Server ${serverLabel} unreachable, trying next...`);
      continue;
    }

    const username = server.username || 'root';
    const password = server.password || '';
    const remoteBasePath = basePath !== undefined ? basePath : (server.remote_path || '/home/Knowledge_Management');
    const remoteFilePath = `${remoteBasePath}/${remoteFileName}`;

    console.log(`[scp] [${i + 1}/${servers.length}] Trying SFTP from ${serverLabel}: ${remoteFilePath} -> ${localDestPath}`);

    const result = await trySingleScp(host, port, username, password, remoteFilePath, localDestPath, remoteFileName);
    if (result.success) {
      return result;
    }
    console.log(`[scp] Server ${serverLabel} failed: ${result.message}, trying next...`);
  }

  return { success: false, message: `所有 ${servers.length} 台 SFTP 服务器均失败` };
}

// 单台服务器的 SFTP 传输逻辑（通过 Python 后端 API）
async function trySingleScp(host, port, username, password, remoteFilePath, localDestPath, remoteFileName) {
  try {
    // 确保 5003 端口就绪再调 API
    const wikiReady = await waitForPort('127.0.0.1', 5003, 3000, 200);
    if (!wikiReady) {
      return { success: false, message: 'SFTP 服务 (5003) 未就绪' };
    }

    const http = require('http');

    const resp = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        host, port, username, password,
        remote_file_path: remoteFilePath,
        local_file_path: localDestPath,
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: 5003,
        path: '/api/v1/sftp/download-file',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: SCP_TOTAL_TIMEOUT,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { resolve({ success: false, error: body }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(postData);
      req.end();
    });

    if (resp.success) {
      const fs = require('fs');
      if (fs.existsSync(localDestPath) && fs.statSync(localDestPath).size > 0) {
        const size = resp.file_size || fs.statSync(localDestPath).size;
        console.log(`[scp] SFTP success via Python: ${remoteFileName} (${size} bytes)`);
        return { success: true, localPath: localDestPath };
      }
      return { success: false, message: '文件大小为 0' };
    }
    return { success: false, message: resp.error || 'SFTP 失败' };
  } catch (err) {
    console.error(`[scp] SFTP request error: ${err.message}`);
    return { success: false, message: `SFTP 失败: ${err.message}` };
  }
}

function getPythonPath() {
  if (app.isPackaged) {
    // 打包环境下优先使用捆绑的 Python 解释器
    const bundledPython = getBundledPythonExe();
    if (bundledPython) {
      return bundledPython;
    }
  } else {
    // 开发环境下优先使用项目虚拟环境
    const fs = require('fs');
    const venvPython = process.platform === 'win32'
      ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '.venv', 'bin', 'python3');
    if (fs.existsSync(venvPython)) {
      return venvPython;
    }
  }
  if (process.platform === 'win32') {
    return 'python';
  }
  return 'python3';
}

function getBundledPythonExe() {
  const runtimePath = path.join(process.resourcesPath, 'vendor', 'python-runtime');
  const fs = require('fs');
  const exeName = process.platform === 'win32' ? 'python.exe' : 'python3';
  const exePath = path.join(runtimePath, exeName);
  if (fs.existsSync(exePath)) {
    return exePath;
  }
  return null;
}

function getBundledPkgsPath() {
  const pkgsPath = path.join(process.resourcesPath, 'vendor', 'python');
  const fs = require('fs');
  if (fs.existsSync(pkgsPath)) {
    return pkgsPath;
  }
  return null;
}

async function checkPythonAvailable(pythonExe) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`"${pythonExe}" --version`, { timeout: 5000 }, (err) => {
      if (err) {
        const hint = app.isPackaged
          ? '当前设备未安装 Python 且打包未捆绑 Python 解释器，请确保打包时已包含 vendor/python-runtime 目录'
          : '当前设备未安装 Python，请先安装 Python 3 并确保 python 命令可用';
        resolve({ ok: false, message: `Python 不可用: ${err.message}。${hint}` });
        return;
      }
      resolve({ ok: true });
    });
  });
}

function buildPythonEnv(extra = {}) {
  const baseEnv = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }, extra);
  if (!app.isPackaged) {
    return baseEnv;
  }

  const vendorPkgsPath = getBundledPkgsPath();
  const vendorRuntimePath = path.join(process.resourcesPath, 'vendor', 'python-runtime');
  const fs = require('fs');

  const env = Object.assign({}, baseEnv);

  // 捆绑了完整 Python 运行时，设置 PYTHONHOME
  if (fs.existsSync(path.join(vendorRuntimePath, 'python.exe'))) {
    env.PYTHONHOME = vendorRuntimePath;

    // 添加捆绑的第三方包到 PYTHONPATH
    if (vendorPkgsPath) {
      const existingPath = process.env.PYTHONPATH || '';
      env.PYTHONPATH = existingPath
        ? vendorPkgsPath + path.delimiter + existingPath
        : vendorPkgsPath;
    }
    return env;
  }

  // 只有 vendor/python 包目录（无完整运行时），只设 PYTHONPATH
  if (vendorPkgsPath) {
    const existingPath = process.env.PYTHONPATH || '';
    env.PYTHONPATH = existingPath
      ? vendorPkgsPath + path.delimiter + existingPath
      : vendorPkgsPath;
  }
  return env;
}

function getOrCreateSharedToken() {
  const fs = require('fs');
  const crypto = require('crypto');
  const dataDir = path.join(getBackendBasePath(), 'llm_wiki_server', 'config');
  const tokenFile = path.join(dataDir, 'backend_token.json');
  try {
    if (fs.existsSync(tokenFile)) {
      const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'));
      if (saved.token) {
        return saved.token;
      }
    }
  } catch (e) {
    console.warn('[token] Failed to read existing token:', e.message);
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ token }, null, 2), 'utf-8');
    console.log('[token] Generated new shared token');
  } catch (e) {
    console.warn('[token] Failed to save token:', e.message);
  }
  return token;
}

function checkPort(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));

    socket.connect(port, host);
  });
}

function checkWikiHealth(host = '127.0.0.1', port = 5002, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: host,
      port: port,
      path: '/api/v1/server/health',
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      // 收到响应头即判定服务健康，不等待 body（body 可能因 server_health
      // 调用 llm-wiki 后端 client.health() 而较大或较慢，导致短超时下被误判为失败）
      if (res.statusCode === 200) {
        resolve(true);
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.ok === true || res.statusCode === 200);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function waitForWikiHealth(timeoutMs, intervalMs = 500) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const tryCheck = () => {
      checkWikiHealth().then((ok) => {
        if (ok) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tryCheck, intervalMs);
      });
    };

    tryCheck();
  });
}

function waitForPort(host, port, timeoutMs, intervalMs = 500) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const tryConnect = () => {
      checkPort(host, port, intervalMs).then((ok) => {
        if (ok) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tryConnect, intervalMs);
      });
    };

    tryConnect();
  });
}

function killPortProcesses(port) {
  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(`lsof -ti:${port}`, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(false);
        const pids = stdout.trim().split('\n').map(Number).filter(p => p);
        if (pids.length === 0) return resolve(false);
        let killed = 0;
        pids.forEach(p => {
          try { process.kill(p, 'SIGKILL'); killed++; } catch (_) {}
        });
        resolve(killed > 0);
      });
    });
  }

  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`netstat -ano | findstr :${port}`, { timeout: 5000, encoding: 'utf-8' }, (err, out) => {
      if (err || !out) return resolve(false);
      const seen = new Set();
      const lines = out.trim().split(/\r?\n/);
      const killPromises = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0' && !seen.has(pid) && !_installerPids.has(Number(pid))) {
          seen.add(pid);
          killPromises.push(new Promise((kResolve) => {
            exec(`taskkill /F /PID ${pid}`, { timeout: 5000 }, () => {
              console.log(`[cleanup] Killed PID ${pid} on port ${port}`);
              kResolve();
            });
          }));
        }
      }
      Promise.all(killPromises).then(() => resolve(true));
    });
  });
}

function startWikiServer() {
  return new Promise(async (resolve) => {
    if (wikiProcess && !wikiProcess.killed) {
      return resolve({ success: true, alreadyRunning: true, pid: wikiProcess.pid });
    }

    const portInUse = await checkWikiHealth();
    if (portInUse) {
      if (wikiProcess === null) {
        console.log('[wiki-server] Port 5002 occupied by zombie, cleaning up...');
        await killPortProcesses(5002);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log('[wiki-server] KMA Server already healthy, skipping spawn');
        return resolve({ success: true, alreadyRunning: true, external: true });
      }
    }

    const scriptPath = getWikiServerPath();
    const python = getPythonPath();

    // 在打包环境下检查 Python 是否可用
    if (app.isPackaged) {
      const pythonAvailable = await checkPythonAvailable(python);
      if (!pythonAvailable.ok) {
        return resolve({ success: false, message: pythonAvailable.message });
      }
    }

    const scriptDir = path.dirname(scriptPath);

    const sharedToken = getOrCreateSharedToken();

    // 性能日志目录：与 run.log 同目录
    let logDir;
    if (app.isPackaged) {
      logDir = path.join(process.resourcesPath, '..');
    } else {
      logDir = path.join(scriptDir, 'logs');
    }

    const env = buildPythonEnv({
      LLM_WIKI_SERVER_PORT: '5002',
      LLM_WIKI_API_TOKEN: sharedToken,
      LLM_WIKI_LOG_DIR: logDir,
    });

    let resolved = false;

    wikiProcess = spawn(python, [scriptPath], {
      env,
      cwd: scriptDir,
      stdio: 'pipe',
    });
    spawnedPids.add(wikiProcess.pid);

    wikiProcess.on('error', (err) => {
      console.error('Wiki server process error:', err.message);
      if (!resolved) {
        resolved = true;
        wikiProcess = null;
        resolve({ success: false, message: 'KMA Server 进程启动失败: ' + err.message });
      }
    });

    wikiProcess.on('close', (code) => {
      console.log('Wiki server process exited with code:', code);
      if (!resolved && code !== 0) {
        resolved = true;
        wikiProcess = null;
        resolve({ success: false, message: 'KMA Server 进程异常退出，退出码: ' + code });
      }
      wikiProcess = null;
    });

    wikiProcess.stdout.on('data', (data) => {
      console.log('[wiki-server]', data.toString('utf-8').trim());
    });

    wikiProcess.stderr.on('data', (data) => {
      console.log('[wiki-server]', data.toString('utf-8').trim());
    });

    waitForWikiHealth(30000, 500).then((ok) => {
      if (resolved) return;
      resolved = true;
      if (ok) {
        resolve({ success: true, pid: wikiProcess ? wikiProcess.pid : null });
      } else {
        resolve({ success: false, message: 'KMA Server 启动超时' });
      }
    });
  });
}

function startSftpService() {
  return new Promise(async (resolve) => {
    if (sftpProcess && !sftpProcess.killed) {
      return resolve({ success: true, alreadyRunning: true, pid: sftpProcess.pid });
    }

    const scriptPath = getSftpServicePath();
    const python = getPythonPath();
    const scriptDir = path.dirname(scriptPath);

    const env = buildPythonEnv({
      SFTP_SERVICE_PORT: '5003',
    });

    let resolved = false;

    sftpProcess = spawn(python, [scriptPath], {
      env,
      cwd: scriptDir,
      stdio: 'pipe',
    });
    spawnedPids.add(sftpProcess.pid);

    sftpProcess.on('error', (err) => {
      console.error('[sftp-service] Process error:', err.message);
      if (!resolved) {
        resolved = true;
        sftpProcess = null;
        resolve({ success: false, message: 'SFTP 服务进程启动失败: ' + err.message });
      }
    });

    sftpProcess.on('close', (code) => {
      console.log('[sftp-service] Process exited with code:', code);
      sftpProcess = null;
    });

    sftpProcess.stdout.on('data', (data) => {
      console.log('[sftp-service]', data.toString('utf-8').trim());
    });

    sftpProcess.stderr.on('data', (data) => {
      console.log('[sftp-service]', data.toString('utf-8').trim());
    });

    waitForPort('127.0.0.1', 5003, 15000, 300).then((ok) => {
      if (resolved) return;
      resolved = true;
      if (ok) {
        resolve({ success: true, pid: sftpProcess ? sftpProcess.pid : null });
      } else {
        resolve({ success: false, message: 'SFTP 服务启动超时' });
      }
    });
  });
}

function doStartMcpServer(mode) {
  const MAX_RETRIES = 15;

  return new Promise(async (resolve) => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (mcpProcess && !mcpProcess.killed) {
          logMcp('warn', `Already running (PID: ${mcpProcess.pid}), skipping start`);
          return resolve({ success: false, message: 'MCP服务已在运行中' });
        }

        const wikiHealthy = await waitForWikiHealth(10000, 500);
        if (!wikiHealthy) {
          if (attempt < MAX_RETRIES) {
            const delayMs = 1000 * Math.pow(2, Math.floor((attempt - 1) / 3));
            logMcp('warn', `KMA not ready, retrying in ${delayMs / 1000}s (${attempt}/${MAX_RETRIES})`);
            sendAutoStartTaskStatus('mcp-server', { status: 'running', message: `KMA 未就绪，${delayMs / 1000}s 后第 ${attempt + 1} 次重试...` });
            await new Promise(r => setTimeout(r, delayMs));
            continue;
          }
          logMcp('error', 'KMA not ready after max retries');
          mcpDebugInfo.lastError = { time: Date.now(), message: 'KMA Server not ready' };
          return resolve({ success: false, message: '请先启动 KMA Server' });
        }

        const scriptPath = getMcpServerPath();
        const python = getPythonPath();
        const scriptDir = path.dirname(scriptPath);
        const args = [scriptPath];

        let targetHost = '127.0.0.1';
        let targetPort = 9010;

        if (mode === 'http') {
          args.push('--transport', 'streamable-http');
          args.push('--host', targetHost);
          args.push('--port', '9011');
          targetPort = 9011;
        }

        const env = buildPythonEnv({
          LLM_WIKI_SERVER_URL: 'http://127.0.0.1:5002',
        });

        logMcp('info', `Spawning: ${python} ${args.join(' ')} (attempt ${attempt}/${MAX_RETRIES})`);
        logMcp('debug', `CWD: ${scriptDir}, port: ${targetPort}`);

        mcpProcess = spawn(python, args, {
          env,
          cwd: scriptDir,
          stdio: 'pipe',
          windowsHide: true,
        });
        spawnedPids.add(mcpProcess.pid);
        mcpMode = mode;

        // Update debug state
        mcpDebugInfo = {
          pid: mcpProcess.pid,
          mode: mode,
          port: targetPort,
          startTime: Date.now(),
          startArgs: { python, args, cwd: scriptDir },
          restartCount: mcpDebugInfo.restartCount || 0,
          lastError: null,
          lastHealthCheck: null,
          healthStatus: 'starting',
          stdoutLines: [],
          stderrLines: [],
        };

        let healthCheckFailed = false;

        if (mode !== 'stdio') {
          mcpProcess.stdout.on('data', (data) => {
            const msg = data.toString('utf-8').trim();
            if (msg) {
              logMcp('stdout', msg);
              // Keep last 100 lines for debug
              if (mcpDebugInfo.stdoutLines) {
                mcpDebugInfo.stdoutLines.push(`[${new Date().toISOString()}] ${msg}`);
                if (mcpDebugInfo.stdoutLines.length > 100) mcpDebugInfo.stdoutLines.shift();
              }
            }
          });

          mcpProcess.stderr.on('data', (data) => {
            const msg = data.toString('utf-8').trim();
            if (msg) {
              logMcp('stderr', msg);
              if (mcpDebugInfo.stderrLines) {
                mcpDebugInfo.stderrLines.push(`[${new Date().toISOString()}] ${msg}`);
                if (mcpDebugInfo.stderrLines.length > 100) mcpDebugInfo.stderrLines.shift();
              }
            }
          });
        }

        mcpProcess.on('error', (err) => {
          logMcp('error', `Process error: ${err.message}`);
          mcpDebugInfo.lastError = { time: Date.now(), message: `Process error: ${err.message}` };
          mcpDebugInfo.healthStatus = 'error';
          mcpProcess = null;
          mcpMode = null;
          if (mainWindow) {
            mainWindow.webContents.send('mcp-status-changed', { running: false, mode: null });
          }
        });

        mcpProcess.on('close', (code, signal) => {
          logMcp('info', `Process exited with code: ${code}, signal: ${signal} (healthCheckFailed: ${healthCheckFailed})`);
          if (healthCheckFailed) return;
          const wasRunning = mcpProcess !== null;
          mcpProcess = null;
          mcpMode = null;
          if (mcpDebugInfo) {
            mcpDebugInfo.healthStatus = 'stopped';
            mcpDebugInfo.lastExit = { time: Date.now(), code, signal };
          }
          if (mainWindow) {
            mainWindow.webContents.send('mcp-status-changed', { running: false, mode: null });
          }

          // Auto-restart on unexpected crash (non-zero exit code)
          if (wasRunning && code !== 0 && code !== null && mcpDebugInfo && mcpDebugInfo.restartCount < 3) {
            const modeToRestart = mcpDebugInfo.mode || 'http';
            mcpDebugInfo.restartCount = (mcpDebugInfo.restartCount || 0) + 1;
            const delayMs = 2000 * mcpDebugInfo.restartCount;
            logMcp('warn', `Auto-restarting MCP in ${delayMs / 1000}s (restart ${mcpDebugInfo.restartCount}/3, exit code: ${code})`);
            setTimeout(() => {
              doStartMcpServer(modeToRestart).then(result => {
                logMcp('info', `Auto-restart result: ${result.success ? 'success' : 'failed - ' + result.message}`);
              });
            }, delayMs);
          }
        });

        if (mainWindow) {
          mainWindow.webContents.send('mcp-status-changed', { running: true, mode: mcpMode });
        }

        // Start periodic health check (every 30s)
        mcpHealthCheckInterval = setInterval(() => {
          if (!mcpProcess || mcpProcess.killed) {
            clearInterval(mcpHealthCheckInterval);
            mcpHealthCheckInterval = null;
            return;
          }
          if (mode === 'http') {
            waitForPort(targetHost, targetPort, 5000, 1000).then(healthy => {
              if (mcpDebugInfo) {
                mcpDebugInfo.lastHealthCheck = Date.now();
                mcpDebugInfo.healthStatus = healthy ? 'healthy' : 'unhealthy';
              }
              if (!healthy && mcpProcess && !mcpProcess.killed) {
                logMcp('warn', 'Periodic health check failed — MCP port unreachable');
              }
            });
          }
        }, 30000);

        if (mode === 'http') {
          const healthy = await waitForPort(targetHost, targetPort, 15000, 500);
          if (mcpDebugInfo) {
            mcpDebugInfo.lastHealthCheck = Date.now();
            mcpDebugInfo.healthStatus = healthy ? 'healthy' : 'timeout';
          }
          if (!healthy) {
            logMcp('error', `Health check failed after startup (port ${targetPort})`);
            if (!mcpProcess || mcpProcess.killed) {
              return resolve({ success: false, cancelled: true });
            }
            healthCheckFailed = true;
            if (mcpProcess && !mcpProcess.killed) {
              mcpProcess.kill();
            }
            mcpProcess = null;
            mcpMode = null;
            clearInterval(mcpHealthCheckInterval);
            mcpHealthCheckInterval = null;
            if (mainWindow) {
              mainWindow.webContents.send('mcp-status-changed', { running: false, mode: null });
            }

            if (attempt < MAX_RETRIES) {
              const delayMs = 1000 * Math.pow(2, Math.floor((attempt - 1) / 3));
              logMcp('warn', `Startup timeout, retrying in ${delayMs / 1000}s (${attempt}/${MAX_RETRIES})`);
              sendAutoStartTaskStatus('mcp-server', { status: 'running', message: `启动超时，${delayMs / 1000}s 后第 ${attempt + 1} 次重试...` });
              await new Promise(r => setTimeout(r, delayMs));
              continue;
            }
            logMcp('error', 'Startup failed after max retries');
            return resolve({ success: false, message: 'MCP HTTP 服务启动超时，已达最大重试次数，请检查 Python 依赖 (pip install mcp requests)' });
          }
          logMcp('info', `MCP server started successfully on port ${targetPort}`);
        }

        resolve({ success: true, mode, pid: mcpProcess ? mcpProcess.pid : null });
        return;
      } catch (err) {
        logMcp('error', `Startup exception (attempt ${attempt}/${MAX_RETRIES}): ${err.message}\n${err.stack}`);
        mcpDebugInfo.lastError = { time: Date.now(), message: err.message, stack: err.stack };
        mcpDebugInfo.healthStatus = 'error';
        // 清理已启动的进程
        if (mcpProcess && !mcpProcess.killed) {
          mcpProcess.kill();
        }
        mcpProcess = null;
        mcpMode = null;
        clearInterval(mcpHealthCheckInterval);
        mcpHealthCheckInterval = null;

        if (attempt < MAX_RETRIES) {
          const delayMs = 1000 * Math.pow(2, Math.floor((attempt - 1) / 3));
          logMcp('warn', `Retrying in ${delayMs / 1000}s (${attempt}/${MAX_RETRIES})`);
          sendAutoStartTaskStatus('mcp-server', { status: 'running', message: `启动异常，${delayMs / 1000}s 后第 ${attempt + 1} 次重试...` });
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        resolve({ success: false, message: 'MCP 服务启动失败: ' + (err.message || '未知错误') });
        return;
      }
    }
  });
}

ipcMain.handle('start-mcp-server', async (event, mode) => {
  return doStartMcpServer(mode);
});

ipcMain.handle('stop-mcp-server', async () => {
  try {
    const pid = mcpProcess && !mcpProcess.killed ? mcpProcess.pid : null;
    mcpProcess = null;
    mcpMode = null;
    clearInterval(mcpHealthCheckInterval);
    mcpHealthCheckInterval = null;
    if (mcpDebugInfo) {
      mcpDebugInfo.healthStatus = 'stopped';
    }
    logMcp('info', `Stopping MCP server (PID: ${pid})`);

    if (pid) {
      if (process.platform === 'win32') {
        try {
          require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        } catch (_) {}
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      }
    }

    setTimeout(() => {
      if (mainWindow) {
        mainWindow.webContents.send('mcp-status-changed', { running: false, mode: null });
      }
    }, 500);

    return { success: true, message: 'MCP服务已停止' };
  } catch (err) {
    logMcp('error', `Failed to stop MCP server: ${err.message}`);
    return { success: false, message: err.message };
  }
});

// MCP debug info handler — allows frontend to query internal MCP state
ipcMain.handle('get-mcp-debug-info', async () => {
  const info = { ...mcpDebugInfo };
  info.currentTime = Date.now();
  info.uptimeMs = info.startTime ? (Date.now() - info.startTime) : null;
  info.isRunning = !!(mcpProcess && !mcpProcess.killed);
  info.currentPid = mcpProcess ? mcpProcess.pid : null;
  // Truncate log buffers for safe IPC transfer
  info.stdoutLines = (info.stdoutLines || []).slice(-50);
  info.stderrLines = (info.stderrLines || []).slice(-50);
  return info;
});

// 自动启动任务的持久化状态（解决渲染进程挂载前事件丢失的竞态问题）
let autoStartTaskStates = {};

// 向渲染进程发送自动启动任务状态更新
function sendAutoStartTaskStatus(taskKey, status) {
  autoStartTaskStates[taskKey] = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auto-start-task-status', { taskKey, ...status });
  }
}

ipcMain.handle('get-auto-start-status', async () => {
  return { tasks: { ...autoStartTaskStates } };
});

// 执行所有待启动任务（KMA → Wiki Server → MCP）
async function runPendingAutoTasks() {
  const tasks = [...pendingAutoTasks];
  pendingAutoTasks = [];
  
  // 先尝试启动 KMA（如果未运行）
  let kmaReady = false;
  try {
    const kmaBinaryCheck = await resolveLlmWikiExePath();
    if (kmaBinaryCheck) {
      const llmWikiAlive = await checkProcessRunning('llm-wiki.exe');
      if (!llmWikiAlive) {
        console.log('[auto-start] KMA not running, starting...');
        sendAutoStartTaskStatus('kma', { status: 'running', message: '正在启动 KMA...' });
        const kmaResult = await startLlmWikiHeadless();
        if (kmaResult.success) {
          const ready = await waitForPort('127.0.0.1', 19828, 30000, 500);
          if (ready) {
            sendAutoStartTaskStatus('kma', { status: 'completed', message: 'KMA 已就绪 (端口 19828)' });
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('kma-status-changed', { running: true });
            }
            kmaReady = true;
          } else {
            sendAutoStartTaskStatus('kma', { status: 'failed', message: 'KMA 启动超时' });
          }
        }
      } else {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('kma-status-changed', { running: true });
        }
        kmaReady = true;
      }
    }
  } catch (e) {
    console.log('[auto-start] KMA check/start error:', e.message);
  }

  for (const task of tasks) {
    if (task === 'wiki-server') {
      console.log('[auto-start] Executing pending task: KMA Server');
      sendAutoStartTaskStatus('wiki-server', { status: 'running', message: '正在启动 KMA Server...' });
      const wikiResult = await startWikiServer();
      if (wikiResult.success) {
        console.log('[auto-start] Wiki server started');
        sendAutoStartTaskStatus('wiki-server', { status: 'completed', message: 'KMA Server 已就绪' });
        if (mainWindow) {
          mainWindow.webContents.send('wiki-status-changed', { running: true, pid: wikiResult.pid });
        }
      } else {
        console.log('[auto-start] Wiki server start failed:', wikiResult.message);
        sendAutoStartTaskStatus('wiki-server', { status: 'failed', message: 'KMA Server 启动失败' });
        // 重新加入待办
        pendingAutoTasks.push('wiki-server', 'mcp-server');
        return;
      }
    }
    if (task === 'mcp-server') {
      console.log('[auto-start] Executing pending task: MCP Server');
      sendAutoStartTaskStatus('mcp-server', { status: 'running', message: '正在启动 KMA MCP...' });
      const mcpResult = await doStartMcpServer('http');
      if (mcpResult.success) {
        logMcp('info', 'MCP server started on port 9011 (auto-start)');
        sendAutoStartTaskStatus('mcp-server', { status: 'completed', message: 'KMA MCP 已就绪 (端口 9011)' });
        if (mainWindow) {
          mainWindow.webContents.send('mcp-status-changed', { running: true, mode: 'http' });
        }
      } else {
        logMcp('error', `MCP auto-start failed: ${mcpResult.message}`);
        sendAutoStartTaskStatus('mcp-server', { status: 'failed', message: 'KMA MCP 启动失败' });
      }
    }
  }
}

ipcMain.handle('get-pending-auto-tasks', async () => {
  return { tasks: [...pendingAutoTasks] };
});

ipcMain.handle('run-pending-auto-tasks', async () => {
  try {
    await runPendingAutoTasks();
    return { success: true, tasks: pendingAutoTasks };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('get-mcp-status', async () => {
  const running = mcpProcess !== null && !mcpProcess.killed;
  return {
    running,
    mode: running ? mcpMode : null,
    pid: running ? mcpProcess.pid : null,
  };
});

ipcMain.handle('start-wiki-server', async () => {
  try {
    const result = await startWikiServer();
    if (result.success) {
      setTimeout(() => {
        if (mainWindow) {
          mainWindow.webContents.send('wiki-status-changed', { running: true, pid: result.pid });
        }
      }, 1000);
    }
    return result;
  } catch (err) {
    console.error('Failed to start wiki server:', err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('stop-wiki-server', async () => {
  try {
    const myPid = wikiProcess && !wikiProcess.killed ? wikiProcess.pid : null;

    wikiProcess = null;

    if (myPid) {
      if (process.platform === 'win32') {
        try {
          require('child_process').execSync(`taskkill /PID ${myPid} /T /F`, { stdio: 'ignore' });
        } catch (_) {}
      } else {
        try { process.kill(myPid, 'SIGTERM'); } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
        try { process.kill(myPid, 'SIGKILL'); } catch (_) {}
      }
    }

    await killPortProcesses(5002);

    return new Promise((resolve) => {
      const check = async () => {
        try {
          const alive = await checkWikiHealth('127.0.0.1', 5002, 1000);
          if (!alive) {
            if (mainWindow) {
              mainWindow.webContents.send('wiki-status-changed', { running: false });
            }
            resolve({ success: true, message: 'Wiki 服务已停止' });
          } else {
            await killPortProcesses(5002);
            setTimeout(check, 300);
          }
        } catch {}
      };
      setTimeout(check, 500);
    });
  } catch (err) {
    console.error('Failed to stop wiki server:', err);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('get-wiki-status', async () => {
  const running = wikiProcess !== null && !wikiProcess.killed;
  if (running) {
    return { running: true, pid: wikiProcess.pid, source: 'spawned' };
  }
  const portHealthy = await checkWikiHealth();
  if (portHealthy) {
    return { running: true, pid: null, source: 'external' };
  }
  return { running: false, pid: null };
});

function killLlmWikiProcesses() {
  if (llmWikiProcess && !llmWikiProcess.killed) {
    // 先尝试用 taskkill /T 杀死整个进程树（Windows 上 .kill() 只杀直接子进程，子进程的子进程会残留）
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /F /T /PID ${llmWikiProcess.pid} 2>nul`, { timeout: 5000, stdio: 'ignore' });
      } catch {}
    }
    try { llmWikiProcess.kill(); } catch {}
    llmWikiProcess = null;
  }
  // 兜底：按镜像名杀，防止 detached 进程脱离进程树后残留
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync('taskkill /F /IM llm-wiki.exe 2>nul', { timeout: 5000, stdio: 'ignore' });
    } catch {}
  }
}

function killHiDeskProcesses() {
  if (hideskProcess && !hideskProcess.killed) {
    try {
      // 杀掉整个进程树
      require('child_process').execSync(`taskkill /F /T /PID ${hideskProcess.pid} 2>nul`, { timeout: 10000, stdio: 'ignore' });
    } catch {}
    try { hideskProcess.kill(); } catch {}
    hideskProcess = null;
  }
  // 兜底按镜像名清理残留
  try {
    require('child_process').execSync('taskkill /F /IM HiDesk_Knowledge_API.exe 2>nul', { timeout: 5000, stdio: 'ignore' });
  } catch {}
}

function killPreprocessorProcesses() {
  if (preprocessorProcess && !preprocessorProcess.killed) {
    try {
      // 杀掉整个进程树
      require('child_process').execSync(`taskkill /F /T /PID ${preprocessorProcess.pid} 2>nul`, { timeout: 10000, stdio: 'ignore' });
    } catch {}
    try { preprocessorProcess.kill(); } catch {}
    preprocessorProcess = null;
  }
  // 兜底按镜像名清理残留
  try {
    require('child_process').execSync('taskkill /F /IM cloudmodeling-processor.exe 2>nul', { timeout: 5000, stdio: 'ignore' });
  } catch {}
}

function killWikiServerProcesses() {
  if (wikiProcess && !wikiProcess.killed) {
    try {
      require('child_process').execSync(`taskkill /F /T /PID ${wikiProcess.pid} 2>nul`, { timeout: 10000, stdio: 'ignore' });
    } catch {}
    try { wikiProcess.kill(); } catch {}
    wikiProcess = null;
  }
  // Python 进程无法用镜像名区分，用端口级兜底
  killProcessOnPortSync(5002);
}

function killSftpProcesses() {
  if (sftpProcess && !sftpProcess.killed) {
    try {
      require('child_process').execSync(`taskkill /F /T /PID ${sftpProcess.pid} 2>nul`, { timeout: 10000, stdio: 'ignore' });
    } catch {}
    try { sftpProcess.kill(); } catch {}
    sftpProcess = null;
  }
  killProcessOnPortSync(5003);
}

function killMcpProcesses() {
  if (mcpProcess && !mcpProcess.killed) {
    try {
      require('child_process').execSync(`taskkill /F /T /PID ${mcpProcess.pid} 2>nul`, { timeout: 10000, stdio: 'ignore' });
    } catch {}
    try { mcpProcess.kill(); } catch {}
    mcpProcess = null;
  }
  killProcessOnPortSync(9011);
  killProcessOnPortSync(9010);
}

/**
 * 同步杀端口上所有进程（用于退出时兜底清理）
 */
function killProcessOnPortSync(port) {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    const out = execSync(`netstat -ano | findstr :${port}`, { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' });
    if (!out) return;
    const seen = new Set();
    for (const line of out.trim().split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0' && !seen.has(pid) && pid !== String(process.pid) && !_installerPids.has(Number(pid))) {
        seen.add(pid);
        try {
          execSync(`taskkill /F /T /PID ${pid} 2>nul`, { timeout: 5000, stdio: 'ignore' });
        } catch {}
      }
    }
  } catch {}
}

/**
 * 检查 PID 是否还活着（同步，通过 tasklist 查询）
 */
function isPidAliveSync(pid) {
  try {
    require('child_process').execSync(`tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul`, { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 通过 PID 精确清理当前应用 spawn 过的所有子进程（不再使用 /IM 通杀，避免误杀外部同名进程）
 */
function killAllSpawnedProcesses() {
  // 先通过专用清理函数处理各进程
  killLlmWikiProcesses();
  killHiDeskProcesses();
  killPreprocessorProcesses();
  killWikiServerProcesses();
  killSftpProcesses();
  killMcpProcesses();

  if (process.platform !== 'win32') return;
  // PID 级别兜底（包括已脱离进程树的 detached 子进程，跳过安装程序进程）
  if (spawnedPids.size > 0) {
    const pids = Array.from(spawnedPids).filter(pid => pid !== process.pid && !_installerPids.has(pid));
    for (const pid of pids) {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /F /T /PID ${pid} 2>nul`, { timeout: 10000, stdio: 'ignore' });
      } catch {}
    }
    console.log('[cleanup] Killed spawned PIDs:', pids.join(' '));
  }
  // 兜底：按镜像名清理 detached 进程脱离进程树后残留
  const fallbackImages = ['llm-wiki.exe', 'HiDesk_Knowledge_API.exe', 'cloudmodeling-processor.exe'];
  for (const img of fallbackImages) {
    try {
      const { execSync } = require('child_process');
      execSync(`taskkill /F /IM ${img} 2>nul`, { timeout: 5000, stdio: 'ignore' });
    } catch {}
  }
  // 注意：不在此处清空 spawnedPids，保留给 will-quit 做最终 PID 级别兜底
}

ipcMain.handle('check-llm-wiki-process', async () => {
  try {
    const running = await checkProcessRunning('llm-wiki.exe');
    return { running };
  } catch {
    return { running: false };
  }
});

async function findLlmWikiFromRegistry() {
  try {
    const installPath = await findInstalledAppPath('LLM Wiki');
    console.log('[llm-wiki] Registry installPath for "LLM Wiki":', installPath || '(not found)');
    if (installPath) {
      const exePath = path.join(installPath, 'llm-wiki.exe');
      if (require('fs').existsSync(exePath)) {
        return exePath;
      }
      console.log('[llm-wiki] Registry path found but exe missing:', exePath);
    }
    return null;
  } catch {
    return null;
  }
}

ipcMain.handle('check-llm-wiki-binary', async () => {
  const regPath = await findLlmWikiFromRegistry();
  if (regPath) return { exists: true, path: regPath };

  const cmdPath = await checkCommandOnPath('llm-wiki.exe') || await checkCommandOnPath('llm-wiki');
  if (cmdPath) return { exists: true, path: cmdPath };

  return { exists: false };
});

ipcMain.handle('get-llm-wiki-status', async () => {
  try {
    const running = await checkProcessRunning('llm-wiki.exe');
    return { running };
  } catch {
    return { running: false };
  }
});

ipcMain.handle('stop-llm-wiki', async () => {
  try {
    killLlmWikiProcesses();
    await new Promise(r => setTimeout(r, 500));
    // 双重确认已经杀掉
    killLlmWikiProcesses();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kma-status-changed', { running: false });
    }
    return { success: true };
  } catch (err) {
    console.error('[llm-wiki] Stop error:', err.message);
    return { success: false, message: err.message };
  }
});

/**
 * 解析 llm-wiki.exe 的路径（不启动进程）
 * 优先级：注册表 > PATH > 解压目录
 * @returns {string|null}
 */
async function resolveLlmWikiExePath() {
  const regPath = await findLlmWikiFromRegistry();
  if (regPath) return regPath;

  try {
    const cmdPath = await checkLlmWikiCommand();
    if (cmdPath && typeof cmdPath === 'string' && cmdPath !== 'llm-wiki.exe') return cmdPath;
  } catch {}

  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || '';
  const searchDirs = [
    path.join(localAppData, 'Programs', 'LLM_Wiki'),
    path.join(localAppData, 'Programs', 'LLM Wiki'),
    path.join(localAppData, 'LLM_Wiki'),
    path.join(localAppData, 'LLM Wiki'),
    path.join(process.env.APPDATA || '', 'LLM_Wiki'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLM_Wiki'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLM Wiki'),
  ];
  for (const dir of searchDirs) {
    const fs = require('fs');
    if (fs.existsSync(dir)) {
      try {
        const exe = findExeRecursive(dir, 'llm-wiki.exe');
        if (exe) { console.log('[llm-wiki] Found in search dir:', exe); return exe; }
      } catch {}
    }
  }
  return null;
}

/**
 * 启动 KMA (llm-wiki.exe) headless 进程
 * @returns {Promise<{success: boolean, pid?: number, message?: string}>}
 */
async function startLlmWikiHeadless() {
  const exePath = await resolveLlmWikiExePath();
  if (!exePath) {
    console.log('[llm-wiki] Binary not found, skipping KMA auto-start');
    return { success: false, message: '未找到 llm-wiki.exe' };
  }
  console.log('[llm-wiki] Resolved exePath:', exePath);
  const { spawn } = require('child_process');
  const sharedToken = getOrCreateSharedToken();
  const env = { ...process.env, LLM_WIKI_HEADLESS: '1', LLM_WIKI_API_TOKEN: sharedToken };
  llmWikiProcess = spawn(exePath, [], {
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  llmWikiProcess.unref();
  spawnedPids.add(llmWikiProcess.pid);
  console.log('[llm-wiki] Started headless, PID:', llmWikiProcess.pid);
  return { success: true, pid: llmWikiProcess.pid };
}

ipcMain.handle('start-llm-wiki-headless', async () => {
  // 先杀掉已有的残留进程，防止重复启动导致旧进程泄漏
  killLlmWikiProcesses();
  try {
    const result = await startLlmWikiHeadless();
    if (result.success) {
      // 等待端口就绪后通知 renderer
      waitForPort('127.0.0.1', 19828, 30000, 500).then(ready => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('kma-status-changed', { running: ready });
        }
      });
    }
    return result;
  } catch (err) {
    console.error('[llm-wiki] Failed to start:', err.message);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('wait-llm-wiki-ready', async (event, timeoutMs = 30000) => {
  return waitForPort('127.0.0.1', 19828, timeoutMs, 500);
});

// SFTP 加速尝试（仅 SCP，不 fallback），renderer 侧分离调用后可更新 UI 消息
ipcMain.handle('scp-llm-wiki-msi', async () => {
  const os = require('os');
  const destPath = path.join(os.tmpdir(), 'LLM_Wiki_x64_en-US.msi');
  const result = await tryScpFile('LLM_Wiki_x64_en-US.msi', destPath, '/home/Knowledge_Management');
  // 归一化字段名，统一使用 path（tryScpFile 返回 localPath）
  if (result.success) {
    const filePath = result.localPath || destPath;
    // 记录下载的 MSI 哈希到本地清单
    const msiHash = computeFileSha256(filePath);
    if (msiHash) {
      updateLocalToolRecord('llm-wiki', { version: 'unknown', installerSha256: msiHash });
    }
    return { success: true, path: filePath };
  }
  return result;
});

// 从 GitHub 下载 KMA 安装包（纯 HTTP 下载）
ipcMain.handle('download-llm-wiki-msi', async () => {
  const url = 'https://raw.githubusercontent.com/BulkyPwn/llm_wiki/target/bundle/msi/LLM_Wiki_x64_en-US.msi';
  const os = require('os');
  const destPath = path.join(os.tmpdir(), 'LLM_Wiki_x64_en-US.msi');

  try {
    await downloadFile(url, destPath, 3600000);
    // 记录下载的 MSI 哈希到本地清单
    const msiHash = computeFileSha256(destPath);
    if (msiHash) {
      updateLocalToolRecord('llm-wiki', { version: 'unknown', installerSha256: msiHash });
    }
    return { success: true, path: destPath };
  } catch (err) {
    console.error('[llm-wiki] Download failed:', err.message);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('install-llm-wiki-msi', async (event, msiPath) => {
  try {
    // 方案 1：静默安装到当前用户目录（%LOCALAPPDATA%），无需 UAC
    console.log('[llm-wiki] Trying msiexec /i (per-user, no UAC)...');
    let result = await runMsiexec(['/i', msiPath, '/quiet', '/norestart', 'ALLUSERS=2', 'MSIINSTALLPERUSER=1']);

    if (result.error) {
      return { success: false, message: result.error };
    }
    if (result.exitCode === 0 || result.exitCode === 3010) {
      return { success: true };
    }

    // 方案 2：用户级安装失败（MSI 可能不支持），降级到提权安装
    console.log('[llm-wiki] Per-user install failed (exit code:', result.exitCode, '), trying elevated...');
    const elevatedResult = await runMsiexecElevated(msiPath);

    if (elevatedResult.error) {
      return { success: false, message: elevatedResult.error };
    }
    if (elevatedResult.exitCode === 0 || elevatedResult.exitCode === 3010) {
      console.log('[llm-wiki] Elevated install succeeded');
      return { success: true };
    }

    return { success: false, message: `MSI 安装返回退出码: ${elevatedResult.exitCode}` };
  } catch (err) {
    console.error('[llm-wiki] MSI install error:', err.message);
    return { success: false, message: err.message };
  }
});

async function runMsiexec(args) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const child = spawn('msiexec.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });
    child.on('close', (code) => { resolve({ exitCode: code }); });
    child.on('error', (e) => { resolve({ exitCode: -1, error: e.message }); });
  });
}

// 提权运行 msiexec /i，通过 PowerShell Start-Process -Verb RunAs（触发 UAC）
async function runMsiexecElevated(msiPath) {
  if (!msiPath || typeof msiPath !== 'string') {
    console.error('[llm-wiki] runMsiexecElevated: invalid msiPath:', msiPath);
    return { exitCode: -1, error: 'MSI path is invalid' };
  }
  const { spawn } = require('child_process');
  // Start-Process -Verb RunAs 弹出 UAC 弹窗，用户同意后以管理员运行 msiexec
  const msiQuoted = msiPath.replace(/"/g, '\\"');
  const psCmd = `$p = Start-Process -FilePath msiexec.exe -ArgumentList '/i',\`"${msiQuoted}\`",'/quiet','/norestart' -Verb RunAs -PassThru -Wait -WindowStyle Hidden; exit $p.ExitCode`;

  console.log('[llm-wiki] Elevated install command:', psCmd);

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600000, // UAC 弹窗等待时间
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      // code === 5 表示 UAC 被拒绝，code === -1 表示被 kill（超时）
      if (stderr.trim()) console.log('[llm-wiki] Elevated stderr:', stderr.trim());
      resolve({ exitCode: code == null ? -1 : code });
    });
    child.on('error', (e) => { resolve({ exitCode: -1, error: e.message }); });
  });
}

ipcMain.handle('cleanup-llm-wiki-msi', async (event, msiPath) => {
  try {
    const fs = require('fs');
    if (fs.existsSync(msiPath)) {
      fs.unlinkSync(msiPath);
      console.log('[llm-wiki] Cleaned up MSI:', msiPath);
    }
    return { success: true };
  } catch (err) {
    console.error('[llm-wiki] Failed to cleanup MSI:', err.message);
    return { success: false };
  }
});

ipcMain.handle('wait-llm-wiki-installed', async (event, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const regPath = await findLlmWikiFromRegistry();
    if (regPath) return { installed: true, path: regPath };

    try {
      const cmdPath = await checkLlmWikiCommand();
      if (cmdPath && typeof cmdPath === 'string') return { installed: true, path: cmdPath };
    } catch {}

    // 尝试安装/解压目录（覆盖 per-user MSI 安装、/a、lessmsi 等多种情况）
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || '';
    const searchDirs = [
      path.join(localAppData, 'Programs', 'LLM_Wiki'),
      path.join(localAppData, 'Programs', 'LLM Wiki'),
      path.join(localAppData, 'LLM_Wiki'),
      path.join(localAppData, 'LLM Wiki'),
      path.join(process.env.APPDATA || '', 'LLM_Wiki'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLM_Wiki'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLM Wiki'),
    ];
    for (const dir of searchDirs) {
      const fs = require('fs');
      if (fs.existsSync(dir)) {
        try {
          const exe = findExeRecursive(dir, 'llm-wiki.exe');
          if (exe) return { installed: true, path: exe };
        } catch {}
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }
  return { installed: false };
});

function findExeRecursive(dir, exeName) {
  const fs = require('fs');
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = findExeRecursive(full, exeName);
        if (found) return found;
      } else if (e.isFile() && e.name.toLowerCase() === exeName.toLowerCase()) {
        return full;
      }
    }
  } catch {}
  return null;
}

async function checkLlmWikiCommand() {
  try {
    const p = await checkCommandOnPath('llm-wiki.exe') || await checkCommandOnPath('llm-wiki');
    return typeof p === 'string' ? p : false;
  } catch {}
  return false;
}

async function findChrysExe() {
  try {
    const cmdPath = await checkCommandOnPath('chrys.exe') || await checkCommandOnPath('chrys');
    if (cmdPath) return cmdPath;
  } catch {}
  const fs = require('fs');
  const searchPaths = [
    path.join(process.cwd(), 'chrys.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'chrys', 'bin', 'chrys.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'chrys', 'chrys.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'chrys', 'bin', 'chrys.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'chrys', 'chrys.exe'),
    path.join(process.env.APPDATA || '', 'chrys', 'bin', 'chrys.exe'),
    path.join(process.env.APPDATA || '', 'chrys', 'chrys.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'chrys.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'chrys'),
    path.join(process.env.APPDATA || '', 'npm', 'chrys.exe'),
    path.join(process.env.USERPROFILE || '', '.chrys', 'chrys.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'chrys', 'bin', 'chrys.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'chrys', 'chrys.exe'),
  ];
  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

ipcMain.handle('check-chrys-exists', async () => {
  const exePath = await findChrysExe();
  return { exists: !!exePath, path: exePath };
});

ipcMain.handle('download-chrys', async () => {
  const url = 'https://raw.githubusercontent.com/BulkyPwn/dist/main/chrys.exe';
  const os = require('os');
  const destPath = path.join(os.tmpdir(), 'chrys.exe');

  // 先尝试从服务器 SCP 拷贝加速
  const scpResult = await tryScpFile('chrys.exe', destPath, '/home/Knowledge_Management');
  let scpFailed = false;
  if (scpResult.success) {
    console.log('[chrys] Got chrys.exe via SCP from server');
    const fs = require('fs');
    const scpPath = scpResult.localPath || destPath;
    if (fs.statSync(scpPath).size < 1024) {
      console.warn('[chrys] SCP file too small, retry via GitHub');
      scpFailed = true;
    } else {
      // 记录下载的 chrys.exe 哈希到本地清单
      const chrysHash = computeFileSha256(scpPath);
      if (chrysHash) {
        updateLocalToolRecord('chrys', { version: 'unknown', installerSha256: chrysHash });
      }
      return { success: true, path: scpPath, scpUsed: true };
    }
  } else {
    scpFailed = !!scpResult.message && scpResult.message !== '未配置服务器 IP';
  }

  // SCP 失败，回退到 GitHub 下载
  try {
    await downloadFile(url, destPath, 300000);
    const fs = require('fs');
    if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1024) {
      return { success: false, message: 'chrys.exe 下载文件异常，大小不足', scpFailed };
    }
    // 记录下载的 chrys.exe 哈希到本地清单
    const chrysHash = computeFileSha256(destPath);
    if (chrysHash) {
      updateLocalToolRecord('chrys', { version: 'unknown', installerSha256: chrysHash });
    }
    // 留在临时目录，install 步骤会自行复制到 %LOCALAPPDATA%\chrys\bin\
    return { success: true, path: destPath, scpFailed };
  } catch (err) {
    console.error('[chrys] Download failed:', err.message);
    return { success: false, message: err.message, scpFailed };
  }
});

ipcMain.handle('install-chrys', async (event, exePath) => {
  try {
    const targetPath = exePath || await findChrysExe();
    if (!targetPath) return { success: false, message: 'chrys.exe not found' };
    const installDir = path.dirname(targetPath);

    const result = await new Promise((resolve) => {
      const child = spawn(`"${targetPath}"`, ['install'], {
        cwd: installDir,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        console.log('[chrys] Install exit code:', code);
        console.log('[chrys] Install stdout:', stdout.slice(-500));
        if (stderr) console.log('[chrys] Install stderr:', stderr.slice(-500));
        // chrys 非零退出也可能表示成功（自解压类程序），所以只要不是信号终止就尝试继续
        resolve({ code, stdout, stderr });
      });

      child.on('error', (err) => {
        console.error('[chrys] Install spawn error:', err.message);
        resolve({ code: -1, stdout, stderr, error: err.message });
      });
    });

    if (result.error) {
      return { success: false, message: result.error };
    }

    // chrys install 成功后应该能被 findChrysExe 找到
    // 等 2 秒让注册表/PATH 刷新
    await new Promise(r => setTimeout(r, 2000));
    const installed = await findChrysExe();
    if (installed) {
      console.log('[chrys] Install verified, found at:', installed);
      return { success: true, path: installed };
    }

    // 如果 install 了但在当前路径找不到，检查目标路径是否还在
    const fs = require('fs');
    if (fs.existsSync(targetPath)) {
      console.log('[chrys] Install done, binary still at:', targetPath);
      return { success: true, path: targetPath };
    }

    console.error('[chrys] Install could not be verified');
    return { success: false, message: 'chrys 安装后无法定位' };
  } catch (err) {
    console.error('[chrys] Install failed:', err.message);
    return { success: false, message: err.message };
  }
});


ipcMain.handle('check-code-llm-wiki-agent', async () => {
  const agentPath = path.join(process.env.APPDATA || '', 'chrys', 'agents', 'Code-with-LLM-wiki.yaml');
  const fs = require('fs');
  return { exists: fs.existsSync(agentPath), path: agentPath };
});

ipcMain.handle('download-code-llm-wiki-agent', async () => {
  const url = 'https://raw.githubusercontent.com/BulkyPwn/dist/main/Code-with-LLM-wiki.yaml';
  const agentDir = path.join(process.env.APPDATA || '', 'chrys', 'agents');
  const agentPath = path.join(agentDir, 'Code-with-LLM-wiki.yaml');

  try {
    const fs = require('fs');
    fs.mkdirSync(agentDir, { recursive: true });

    // 先尝试从服务器 SCP 拷贝加速
    const scpResult = await tryScpFile('Code-with-LLM-wiki.yaml', agentPath, '/home/Knowledge_Management');
    if (scpResult.success) {
      console.log('[chrys] Got Code-with-LLM-wiki.yaml via SCP from server');
      return { success: true, path: scpResult.localPath, scpUsed: true };
    }

    const scpFailed = !!scpResult.message && scpResult.message !== '未配置服务器 IP';

    // SCP 失败，回退到 GitHub 下载
    await downloadFile(url, agentPath, 300000);
    return { success: true, path: agentPath, scpFailed };
  } catch (err) {
    console.error('[chrys] Code-with-LLM-wiki.yaml download failed:', err.message);
    return { success: false, message: err.message };
  }
});

/**
 * 扫描 chrys agents 目录，返回可用 agent 列表
 * 固定包含 "Code"、"QA"，以及 agents 目录下所有 .yaml 文件对应的 agent 名
 */
ipcMain.handle('list-chrys-agents', async () => {
  const fs = require('fs');
  const agentDir = path.join(process.env.APPDATA || '', 'chrys', 'agents');
  const agents = ['Code', 'QA'];
  try {
    if (fs.existsSync(agentDir)) {
      const files = fs.readdirSync(agentDir);
      for (const file of files) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
          const name = file.replace(/\.(yaml|yml)$/, '');
          if (!agents.includes(name)) {
            agents.push(name);
          }
        }
      }
    }
  } catch (err) {
    console.error('[chrys] Failed to scan agents directory:', err.message);
  }
  return { success: true, agents };
});

// 用于跟踪运行中的 chrys 进程
const chrysSessions = {};

/**
 * 准备 chrys 运行环境：写入模型配置到 .env，确保 OTEL 开启
 */
function prepareChrysEnv(modelId) {
  const fs = require('fs');
  const chrysDir = path.join(process.env.APPDATA || '', 'chrys');
  if (!fs.existsSync(chrysDir)) {
    fs.mkdirSync(chrysDir, { recursive: true });
  }
  const envPath = path.join(chrysDir, '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
  }
  const lines = envContent.split('\n');

  // 写入模型配置
  if (modelId) {
    const chrysModelId = generateChrysId(modelId);
    const chrysEnvLine = `CHRYS_MODEL_PROFILE=${chrysModelId}`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('CHRYS_MODEL_PROFILE=')) {
        lines[i] = chrysEnvLine;
        found = true;
        break;
      }
    }
    if (!found) lines.push(chrysEnvLine);
    console.log(`[chrys] Set CHRYS_MODEL_PROFILE=${chrysModelId} (from ${modelId})`);
  }

  // 确保 OTEL 变量写入 .env
  const otelVars = [
    { key: 'CHRYS_OTEL', value: '1' },
    { key: 'CHRYS_OTEL_SENSITIVE_DATA', value: '1' },
  ];
  for (const { key, value } of otelVars) {
    if (!lines.some(l => l.trimStart().startsWith(key + '='))) {
      lines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(envPath, lines.filter(l => l.trim()).join('\n') + '\n', 'utf-8');
}

/**
 * spawn chrys 子进程并监听 stdout/stderr
 * @returns {{ child, stdout, stderr }}
 */
function spawnChrys(exePath, args, cwd) {
  const env = { ...process.env, CHRYS_OTEL: '1', CHRYS_OTEL_SENSITIVE_DATA: '1' };
  const child = spawn(exePath, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  spawnedPids.add(child.pid);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

/**
 * 从 chrys --json 输出的 stdout 中解析 session_id
 * stdout 可能包含多行，找第一个合法 JSON 行
 */
function parseJsonLine(stdout) {
  const lines = stdout.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.session_id) return obj;
    } catch {}
  }
  return null;
}

ipcMain.handle('start-chrys-ppt', async (event, userInput, modelId, options) => {
  try {
    const exePath = await findChrysExe();
    if (!exePath) return { success: false, message: 'chrys.exe not found' };

    const { outputDir, promptTemplate, agent } = options || {};

    prepareChrysEnv(modelId);

    // 工作目录：优先使用用户设置的 outputDir，否则使用进程当前目录
    const cwd = outputDir || process.cwd();

    const template = promptTemplate || '在当前目录下的ppt文件夹下生成一份ppt，无需确认方案直接生成；你可以使用llm-wiki MCP尝试获取需要的知识；ppt生成要求如下：';
    const prompt = `${template}${userInput}`;
    const agentName = agent || 'Code-with-LLM-wiki';
    const args = ['run', '-a', agentName, '--json', prompt];

    console.log(`[chrys] Starting (cwd=${cwd}): ${exePath} ${args.slice(0, -1).join(' ')} "...prompt..."`);

    // Spawn 前快照已有 session 目录
    const sessionsDir = path.join(process.env.APPDATA || '', 'chrys', 'sessions');
    const preExistingDirs = snapshotSessionDirs(sessionsDir);

    const { child, getStdout, getStderr } = spawnChrys(exePath, args, cwd);

    // 通过文件系统发现新 session（不等待进程结束，立即返回）
    let sessionId;
    try {
      sessionId = await discoverNewSessionDir(sessionsDir, child, preExistingDirs);
    } catch (e) {
      console.error(`[chrys] Failed to discover session:`, e.message);
      child.kill();
      return { success: false, message: `无法发现 Chrys session: ${e.message}` };
    }

    console.log(`[chrys] Discovered session: ${sessionId}`);

    chrysSessions[sessionId] = { process: child, getStdout, getStderr, startTime: Date.now() };

    child.on('close', (code) => {
      const stdout = getStdout();
      const stderr = getStderr();
      console.log(`[chrys] start-chrys-ppt exited with code ${code}`);
      if (stderr) console.log(`[chrys] stderr:\n${stderr}`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrys-task-complete', {
          sessionId,
          success: code === 0,
          message: code === 0 ? 'PPT 生成完成' : `Chrys 退出码: ${code}`,
          stdout: stdout.slice(-5000),
          stderr: stderr.slice(-5000),
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[chrys] start-chrys-ppt ${sessionId} spawn error:`, err.message);
      delete chrysSessions[sessionId];
    });

    return { success: true, sessionId, pid: child.pid, sessionDir: path.join(sessionsDir, sessionId) };
  } catch (err) {
    console.error('[chrys] Failed to start chrys:', err.message);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('continue-chrys-session', async (event, userInput, sessionId, modelId, options) => {
  try {
    const exePath = await findChrysExe();
    if (!exePath) return { success: false, message: 'chrys.exe not found' };

    // 同步当前选中的模型到 Chrys 后端
    if (modelId) {
      prepareChrysEnv(modelId);
    }

    const prompt = `对之前生成的PPT做以下调整：${userInput}`;
    const agentName = (options && options.agent) || 'Code-with-LLM-wiki';
    const args = ['run', '-a', agentName, '--session', sessionId, '--json', prompt];

    console.log(`[chrys] Continuing session ${sessionId}: ...prompt...`);

    const { child, getStdout, getStderr } = spawnChrys(exePath, args, process.cwd());

    chrysSessions[sessionId] = { ...(chrysSessions[sessionId] || {}), process: child, getStdout, getStderr, startTime: Date.now() };

    child.on('close', (code) => {
      const stdout = getStdout();
      const stderr = getStderr();
      console.log(`[chrys] continue ${sessionId} exited with code ${code}`);
      if (stderr) console.log(`[chrys] stderr:\n${stderr}`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrys-task-complete', {
          sessionId,
          success: code === 0,
          message: code === 0 ? '调整完成' : `Chrys 退出码: ${code}`,
          stdout: stdout.slice(-5000),
          stderr: stderr.slice(-5000),
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[chrys] continue ${sessionId} spawn error:`, err.message);
    });

    return { success: true, sessionId };
  } catch (err) {
    console.error('[chrys] Failed to continue chrys:', err.message);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('start-chrys-code', async (event, userInput, modelId, options) => {
  try {
    const exePath = await findChrysExe();
    if (!exePath) return { success: false, message: 'chrys.exe not found' };

    const { outputDir, promptTemplate, agent } = options || {};

    prepareChrysEnv(modelId);

    const cwd = outputDir || process.cwd();

    const template = promptTemplate || '在当前目录下的code文件夹下生成代码，无需确认方案直接生成；你可以使用llm-wiki MCP尝试获取需要的知识；代码生成要求如下：';
    const prompt = `${template}${userInput}`;
    const agentName = agent || 'Code-with-LLM-wiki';
    const args = ['run', '-a', agentName, '--json', prompt];

    console.log(`[chrys] Starting code (cwd=${cwd}): ${exePath} ${args.slice(0, -1).join(' ')} "...prompt..."`);

    const sessionsDir = path.join(process.env.APPDATA || '', 'chrys', 'sessions');
    const preExistingDirs = snapshotSessionDirs(sessionsDir);

    const { child, getStdout, getStderr } = spawnChrys(exePath, args, cwd);

    let sessionId;
    try {
      sessionId = await discoverNewSessionDir(sessionsDir, child, preExistingDirs);
    } catch (e) {
      console.error(`[chrys] Failed to discover code session:`, e.message);
      child.kill();
      return { success: false, message: `无法发现 Chrys session: ${e.message}` };
    }

    console.log(`[chrys] Discovered code session: ${sessionId}`);

    chrysSessions[sessionId] = { process: child, getStdout, getStderr, startTime: Date.now() };

    child.on('close', (code) => {
      const stdout = getStdout();
      const stderr = getStderr();
      console.log(`[chrys] start-chrys-code exited with code ${code}`);
      if (stderr) console.log(`[chrys] stderr:\n${stderr}`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrys-task-complete', {
          sessionId,
          success: code === 0,
          message: code === 0 ? '代码生成完成' : `Chrys 退出码: ${code}`,
          stdout: stdout.slice(-5000),
          stderr: stderr.slice(-5000),
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[chrys] start-chrys-code ${sessionId} spawn error:`, err.message);
      delete chrysSessions[sessionId];
    });

    return { success: true, sessionId, pid: child.pid, sessionDir: path.join(sessionsDir, sessionId) };
  } catch (err) {
    console.error('[chrys] Failed to start chrys code:', err.message);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('continue-chrys-code-session', async (event, userInput, sessionId, modelId, options) => {
  try {
    const exePath = await findChrysExe();
    if (!exePath) return { success: false, message: 'chrys.exe not found' };

    // 同步当前选中的模型到 Chrys 后端
    if (modelId) {
      prepareChrysEnv(modelId);
    }

    const prompt = `对之前生成的代码做以下调整：${userInput}`;
    const agentName = (options && options.agent) || 'Code-with-LLM-wiki';
    const args = ['run', '-a', agentName, '--session', sessionId, '--json', prompt];

    console.log(`[chrys] Continuing code session ${sessionId}: ...prompt...`);

    const { child, getStdout, getStderr } = spawnChrys(exePath, args, process.cwd());

    chrysSessions[sessionId] = { ...(chrysSessions[sessionId] || {}), process: child, getStdout, getStderr, startTime: Date.now() };

    child.on('close', (code) => {
      const stdout = getStdout();
      const stderr = getStderr();
      console.log(`[chrys] continue code ${sessionId} exited with code ${code}`);
      if (stderr) console.log(`[chrys] stderr:\n${stderr}`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrys-task-complete', {
          sessionId,
          success: code === 0,
          message: code === 0 ? '代码调整完成' : `Chrys 退出码: ${code}`,
          stdout: stdout.slice(-5000),
          stderr: stderr.slice(-5000),
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[chrys] continue code ${sessionId} spawn error:`, err.message);
    });

    return { success: true, sessionId };
  } catch (err) {
    console.error('[chrys] Failed to continue chrys code:', err.message);
    return { success: false, message: err.message };
  }
});

/**
 * 快照当前 sessions 目录下的子目录集合
 */
function snapshotSessionDirs(sessionsDir) {
  const fs = require('fs');
  const set = new Set();
  try {
    if (fs.existsSync(sessionsDir)) {
      fs.readdirSync(sessionsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .forEach(d => set.add(d.name));
    }
  } catch (_) {}
  return set;
}

/**
 * 轮询找到 chrys 新创建的 session 目录
 * chrys session 目录名本身即 session ID，不依赖额外文件
 * 最多等 60 秒
 */
function discoverNewSessionDir(sessionsDir, childProcess, preExistingDirs) {
  const fs = require('fs');
  const startTime = Date.now();
  const maxWait = 60000;

  return new Promise((resolve, reject) => {
    const tryDiscover = () => {
      // 子进程提前退出（配置错误等）
      if (childProcess.exitCode != null) {
        reject(new Error(`Chrys 进程提前退出 (exit ${childProcess.exitCode})`));
        return;
      }

      try {
        if (!fs.existsSync(sessionsDir)) return;
        const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });

        for (const d of entries) {
          if (!d.isDirectory()) continue;
          if (preExistingDirs.has(d.name)) continue;

          const fullPath = path.join(sessionsDir, d.name);
          const stat = fs.statSync(fullPath);
          // 创建时间必须在 spawn 之后（2s 容差）
          if (stat.mtimeMs >= startTime - 2000) {
            console.log(`[chrys] Session dir discovered: ${d.name} (mtime=${new Date(stat.mtime).toISOString()})`);
            resolve(d.name);
            return;
          }
        }
      } catch (_) {}

      if (Date.now() - startTime > maxWait) {
        reject(new Error('等待 session 目录创建超时'));
        return;
      }

      setTimeout(tryDiscover, 500);
    };

    // 首次延迟 1s，给 chrys 创建目录的时间
    setTimeout(tryDiscover, 1000);
  });
}

function formatNsStr(ns) {
  if (!ns && ns !== 0) return '-';
  const ms = ns / 1e6;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

/**
 * 读取 chrys session 的 OTEL 日志
 * @param {string} sessionId
 * @returns {object} { traces, logs, sessionSummary }
 */
ipcMain.handle('read-chrys-session-logs', async (event, sessionId) => {
  try {
    const fs = require('fs');
    const sessionDir = path.join(process.env.APPDATA || '', 'chrys', 'sessions', sessionId);

    const result = { traces: [], logs: [], sessionSummary: null, found: false, running: false };

    // 检查 session 目录是否存在
    if (!fs.existsSync(sessionDir)) {
      return { ...result, missing: true };
    }
    result.found = true;

    // 检查 chrys 进程是否仍在运行（session 是否有 lock 文件或正在更新）
    const isRunning = chrysSessions[sessionId] && chrysSessions[sessionId].process
      && chrysSessions[sessionId].process.exitCode == null;
    result.running = isRunning;

    // 读取 session.json
    const sessionJsonPath = path.join(sessionDir, 'session.json');
    if (fs.existsSync(sessionJsonPath)) {
      try {
        result.sessionSummary = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf-8'));
      } catch (e) {
        console.warn(`[chrys] Failed to parse session.json for ${sessionId}:`, e.message);
      }
    }

    // 读取 traces.jsonl
    const tracesPath = path.join(sessionDir, 'otel', 'traces.jsonl');
    if (fs.existsSync(tracesPath)) {
      try {
        const content = fs.readFileSync(tracesPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        result.traces = lines.map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
      } catch (e) {
        console.warn(`[chrys] Failed to read traces.jsonl for ${sessionId}:`, e.message);
      }
    }

    // 读取 logs.jsonl
    const logsPath = path.join(sessionDir, 'otel', 'logs.jsonl');
    if (fs.existsSync(logsPath)) {
      try {
        const content = fs.readFileSync(logsPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        result.logs = lines.map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
      } catch (e) {
        console.warn(`[chrys] Failed to read logs.jsonl for ${sessionId}:`, e.message);
      }
    }

    // 兜底：logs.jsonl 为空时，从 traces 的 events 中构建日志条目
    if (result.logs.length === 0 && result.traces.length > 0) {
      const syntheticLogs = [];
      for (const trace of result.traces) {
        if (trace.events && Array.isArray(trace.events)) {
          for (const evt of trace.events) {
            syntheticLogs.push({
              timestamp: evt.timestamp_ns ? new Date(evt.timestamp_ns / 1e6).toISOString() : trace.timestamp,
              severity_text: 'INFO',
              severity_number: 9,
              body: evt.attributes?.message?.content || evt.name || '',
              trace_id: trace.trace_id,
              span_id: trace.span_id,
              attributes: { event: { name: evt.name || 'trace_event' } },
            });
          }
        }
        // 把 span 自身的 start/finish 也作为日志事件
        const model = trace.attributes?.['gen_ai.request.model'];
        if (trace.start_time_ns) {
          syntheticLogs.push({
            timestamp: new Date(trace.start_time_ns / 1e6).toISOString(),
            severity_text: 'INFO',
            severity_number: 9,
            body: `[start] ${trace.name}${model ? ` (${model})` : ''}`,
            trace_id: trace.trace_id,
            span_id: trace.span_id,
            attributes: { event: { name: 'span.start' } },
          });
        }
        if (trace.end_time_ns) {
          const statusCode = trace.status?.code;
          const isError = statusCode && statusCode !== 'OK' && statusCode !== 'UNSET';
          syntheticLogs.push({
            timestamp: new Date(trace.end_time_ns / 1e6).toISOString(),
            severity_text: isError ? 'ERROR' : 'INFO',
            severity_number: isError ? 17 : 9,
            body: `[end] ${trace.name} (${formatNsStr(trace.duration_ns)})${statusCode && statusCode !== 'UNSET' ? ' ' + statusCode : ''}`,
            trace_id: trace.trace_id,
            span_id: trace.span_id,
            attributes: { event: { name: 'span.end' } },
          });
        }
      }
      // 按时间排序
      syntheticLogs.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      result.logs = syntheticLogs;
      if (syntheticLogs.length > 0) {
        console.log(`[chrys] Built ${syntheticLogs.length} synthetic log entries from trace events (logs.jsonl empty)`);
      }
    }

    // 附加 chrys 进程的 stdout / stderr 作为兜底
    const session = chrysSessions[sessionId];
    if (session) {
      result.stdout = (session.stdout || session.getStdout?.() || '').slice(-5000);
      result.stderr = (session.stderr || session.getStderr?.() || '').slice(-5000);
    }

    return result;
  } catch (err) {
    console.error('[chrys] Failed to read session logs:', err.message);
    return { traces: [], logs: [], sessionSummary: null, found: false, running: false };
  }
});

// 取消正在运行的 chrys session
ipcMain.handle('cancel-chrys-session', async (event, sessionId) => {
  const session = chrysSessions[sessionId];
  if (session && session.process) {
    session.process.kill();
    delete chrysSessions[sessionId];
    console.log(`[chrys] Session ${sessionId} cancelled`);
    return { success: true };
  }
  return { success: false, message: 'Session not found' };
});

// ========== Chrys 模型配置同步 ==========

/**
 * 从 model.id 生成 12 位 hex chrysId（确定性）
 */
function generateChrysId(modelId) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(modelId).digest('hex').substring(0, 12);
}

/**
 * 获取 Chrys 模型目录路径
 */
function getChrysModelsDir() {
  return path.join(process.env.APPDATA || '', 'chrys', 'models');
}

/**
 * 简单 YAML 解析：仅支持扁平键值对（与 Chrys ModelProfile 格式兼容）
 */
function parseSimpleYaml(content) {
  const obj = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.substring(0, colonIdx).trim();
    let value = trimmed.substring(colonIdx + 1).trim();
    // 去除引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 布尔转换
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    // 数字转换
    else if (/^-?\d+\.?\d*$/.test(value)) value = Number(value);
    // 空字符串特殊处理
    if (value === "''" || value === '""' || value === '') value = '';
    obj[key] = value;
  }
  return obj;
}

/**
 * 简单 YAML 序列化：扁平对象转 YAML 字符串
 */
function dumpSimpleYaml(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === 'string' && value !== '') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ''`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * 读取已存在的 Chrys 模型配置（按 name 索引）
 */
function readExistingChrysModels() {
  const fs = require('fs');
  const modelsDir = getChrysModelsDir();
  const existing = {}; // name → { chrysId, yamlPath, provider, model_id }
  try {
    if (!fs.existsSync(modelsDir)) return existing;
    const files = fs.readdirSync(modelsDir);
    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const filePath = path.join(modelsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const profile = parseSimpleYaml(content);
        if (profile && profile.name) {
          existing[profile.name] = { chrysId: profile.id, yamlPath: filePath, provider: profile.provider, model_id: profile.model_id };
        }
      } catch (e) {
        console.error(`[chrys] Failed to parse model YAML ${file}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[chrys] Failed to read models dir:', e.message);
  }
  return existing;
}

/**
 * 将 models.json 中的模型转换为 Chrys YAML 配置文件
 * @returns {object} { success, message, matched: string[], created: string[], skipped: string[], failed: string[] }
 */
ipcMain.handle('sync-chrys-models', async () => {
  const fs = require('fs');
  const result = { matched: [], created: [], skipped: [], failed: [] };

  try {
    // 1. 读取 models.json（优先用户配置，回退到默认配置）
    const modelsJsonPath = path.join(getUserConfigDir(), 'models.json');
    if (!fs.existsSync(modelsJsonPath)) {
      return { success: false, message: 'models.json not found', ...result };
    }
    const modelsConfig = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
    const models = modelsConfig.MODELS || [];

    if (models.length === 0) {
      return { success: true, message: 'No models to sync', ...result };
    }

    // 2. 读取已存在的 Chrys 模型
    const existing = readExistingChrysModels();

    // 3. 确保模型目录存在
    const modelsDir = getChrysModelsDir();
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    // 4. 处理每个模型
    for (const model of models) {
      const modelName = model.name;
      const existingModel = existing[modelName];

      if (existingModel) {
        // 已存在同名模型，检查 provider 和 model_id 是否匹配
        const providerMatch = !existingModel.provider || existingModel.provider === (model.provider || 'openai');
        const modelIdMatch = !existingModel.model_id || existingModel.model_id === (model.model || model.id || '');
        if (providerMatch && modelIdMatch) {
          result.matched.push(modelName);
          console.log(`[chrys] Model already configured: ${modelName}`);
          continue;
        }
        // provider/model_id 不匹配但同名，跳过以避免冲突
        console.log(`[chrys] Model name conflict: ${modelName}, provider or model_id mismatch, skipping`);
        result.skipped.push(modelName);
        continue;
      }

      // 5. 生成新配置
      try {
        const chrysId = generateChrysId(model.id);
        const yamlPath = path.join(modelsDir, `${chrysId}.yaml`);

        const profile = {
          id: chrysId,
          name: modelName,
          provider: model.provider || 'openai',
          api_style: model.api_style || 'chat_completions',
          model_id: model.model || model.id || '',
          max_context_tokens: model.max_context_tokens || 100000,
          base_url: model.url || '',
          api_key: model.apiKey || '',
          http_connect_timeout: model.http_connect_timeout || 10.0,
          http_read_timeout: model.http_read_timeout || 300.0,
          http_max_retries: model.http_max_retries || 2,
          verify_ssl: model.verify_ssl !== undefined ? model.verify_ssl : true,
          bypass_proxy: model.bypass_proxy !== undefined ? model.bypass_proxy : false,
          stream: model.stream !== undefined ? model.stream : false,
          vision: model.vision !== undefined ? model.vision : false,
        };

        const yamlContent = dumpSimpleYaml(profile);
        fs.writeFileSync(yamlPath, yamlContent, 'utf-8');
        result.created.push(modelName);
        console.log(`[chrys] Created model config: ${yamlPath} (${modelName})`);
      } catch (e) {
        console.error(`[chrys] Failed to create model config for ${modelName}:`, e.message);
        result.failed.push(`${modelName} (写入失败: ${e.message})`);
      }
    }

    const parts = [];
    parts.push(`已匹配 ${result.matched.length} 个`);
    parts.push(`新创建 ${result.created.length} 个`);
    if (result.skipped.length > 0) {
      parts.push(`跳过 ${result.skipped.length} 个（已存在同名模型）`);
    }
    if (result.failed.length > 0) {
      parts.push(`失败 ${result.failed.length} 个`);
    }

    return {
      success: true,
      message: parts.join('，'),
      ...result,
    };
  } catch (err) {
    console.error('[chrys] sync-chrys-models error:', err.message);
    return { success: false, message: err.message, ...result };
  }
});

// IPC: 设置当前选中的 chrys 模型（更新 .env 中的 CHRYS_MODEL_PROFILE）
ipcMain.handle('set-chrys-active-model', async (event, modelId) => {
  try {
    prepareChrysEnv(modelId);
    console.log(`[chrys] Active model set to: ${modelId}`);
    return { success: true };
  } catch (err) {
    console.error('[chrys] set-chrys-active-model error:', err.message);
    return { success: false, message: err.message };
  }
});

// IPC: 获取模型配置（从用户配置目录读取）
ipcMain.handle('get-models-config', () => {
  try {
    const fs = require('fs');
    const userPath = path.join(getUserConfigDir(), 'models.json');
    if (fs.existsSync(userPath)) {
      return JSON.parse(fs.readFileSync(userPath, 'utf-8'));
    }
  } catch (err) {
    console.error('[config] Failed to read models config:', err.message);
  }
  // 回退到默认配置
  const defaultPath = getDefaultConfigPath('models.json');
  try {
    const fs = require('fs');
    if (fs.existsSync(defaultPath)) {
      return JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
    }
  } catch {}
  return { MODELS: [], DEFAULT_MODEL_ID: '' };
});

// IPC: 保存模型配置（写入用户配置目录）
ipcMain.handle('save-models-config', (event, config) => {
  try {
    const fs = require('fs');
    const userDir = getUserConfigDir();
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    const userPath = path.join(userDir, 'models.json');
    fs.writeFileSync(userPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[config] Models config saved to', userPath);
    return { success: true };
  } catch (err) {
    console.error('[config] Failed to save models config:', err.message);
    return { success: false, message: err.message };
  }
});

// ==================== LLM Wiki Review 轮询 ====================

const LLM_WIKI_BASE_URL = 'http://127.0.0.1:19828';
const REVIEW_POLL_INTERVAL_MS = 30000;

let llmWikiReviewTimer = null;
let lastPendingCount = 0;
let currentNotification = null;

/**
 * 简单的 HTTP GET，返回 { status, data }
 */
function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM Wiki request timeout')); });
    req.end();
  });
}

/**
 * 定时轮询 LLM Wiki 的 review 状态
 */
async function pollLlmWikiReviews() {
  try {
    // 1. 确认 llm-wiki 进程在运行
    let healthOk = false;
    try {
      const health = await httpGetJson(`${LLM_WIKI_BASE_URL}/api/v1/health`, 3000);
      healthOk = !!(health.data && health.data.ok);
    } catch {
      // 服务未运行，静默返回
    }
    if (!healthOk) return;

    // 2. 获取当前项目路径
    const token = getOrCreateSharedToken();
    let projects = [];
    try {
      const projectsResp = await httpGetJson(
        `${LLM_WIKI_BASE_URL}/api/v1/projects?token=${encodeURIComponent(token)}`,
        5000,
      );
      if (projectsResp.data && projectsResp.data.ok) {
        projects = projectsResp.data.projects || [];
      }
    } catch {
      return;
    }

    // 3. 遍历项目直接读文件 {projectPath}/.llm-wiki/review.json
    let totalPending = 0;
    const pendingProjects = []; // { name, path, count }
    for (const project of projects) {
      if (!project.path) continue;
      const reviewPath = path.join(project.path, '.llm-wiki', 'review.json');
      try {
        if (require('fs').existsSync(reviewPath)) {
          const raw = require('fs').readFileSync(reviewPath, 'utf-8');
          const items = JSON.parse(raw);
          if (Array.isArray(items)) {
            const pendingCount = items.filter(item => !item.resolved).length;
            if (pendingCount > 0) {
              totalPending += pendingCount;
              pendingProjects.push({
                name: project.name || path.basename(project.path),
                path: project.path,
                count: pendingCount,
              });
            }
          }
        }
      } catch {
        // 文件不存在或解析失败，跳过此项目
      }
    }

    // 4. pending > 0 → 弹通知（pending 计数变化时通知）
    if (totalPending > 0 && totalPending !== lastPendingCount) {
      console.log(`[llm-wiki-review] ${totalPending} pending review(s), showing notification`);

      // 构建通知正文，包含项目名称
      let body;
      if (pendingProjects.length === 1) {
        body = `${pendingProjects[0].name}: ${pendingProjects[0].count} 个待审阅项`;
      } else {
        const names = pendingProjects.map(p => p.name).join('、');
        body = `${names} 共 ${totalPending} 个待审阅项`;
      }

      // 关闭旧通知（如果还有的话）
      if (currentNotification) {
        try { currentNotification.close(); } catch {}
        currentNotification = null;
      }
      const notification = new Notification({
        title: 'LLM Wiki',
        body,
        silent: false,
      });

      // 5. 用户点击通知 → 呼出 LLM Wiki 窗口（传递项目路径）
      const firstPendingProjectPath = pendingProjects[0].path;
      notification.on('click', () => {
        console.log('[llm-wiki-review] Notification clicked, showing LLM Wiki window');
        const postData = JSON.stringify({ token, project_path: firstPendingProjectPath });
        const req = http.request(
          `${LLM_WIKI_BASE_URL}/api/v1/window/show`,
          {
            method: 'POST',
            timeout: 5000,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
          },
        );
        req.on('error', (err) => {
          console.error('[llm-wiki-review] Window show request failed:', err.message);
        });
        req.write(postData);
        req.end();
      });

      notification.show();
      currentNotification = notification;
    }

    if (totalPending === 0 && lastPendingCount > 0) {
      console.log('[llm-wiki-review] All reviews resolved');
      // 关闭通知，避免用户看到过时的冲突提示
      if (currentNotification) {
        try { currentNotification.close(); } catch {}
        currentNotification = null;
      }
    }

    lastPendingCount = totalPending;
  } catch (err) {
    console.error('[llm-wiki-review] Polling error:', err.message);
  }
}

function startLlmWikiReviewPolling() {
  if (llmWikiReviewTimer) return;
  console.log('[llm-wiki-review] Starting review polling (interval:', REVIEW_POLL_INTERVAL_MS, 'ms)');
  // 首次延迟 15 秒，给 KMA 启动留时间
  setTimeout(() => {
    pollLlmWikiReviews();
    llmWikiReviewTimer = setInterval(pollLlmWikiReviews, REVIEW_POLL_INTERVAL_MS);
  }, 15000);
}

function stopLlmWikiReviewPolling() {
  if (llmWikiReviewTimer) {
    clearInterval(llmWikiReviewTimer);
    llmWikiReviewTimer = null;
    lastPendingCount = 0;
    if (currentNotification) {
      try { currentNotification.close(); } catch {}
      currentNotification = null;
    }
    console.log('[llm-wiki-review] Polling stopped');
  }
}

ipcMain.handle('start-llm-wiki-review-polling', () => {
  startLlmWikiReviewPolling();
  return { success: true };
});

ipcMain.handle('stop-llm-wiki-review-polling', () => {
  stopLlmWikiReviewPolling();
  return { success: true };
});

ipcMain.handle('get-llm-wiki-review-count', () => {
  return { count: lastPendingCount };
});

// ==================== 应用自动更新 ====================

const UPDATE_SERVER_URL = 'http://ai-sssc.his-y.huawei.com:5021'; // TODO: 填入更新服务器地址，例如 http://192.168.1.100:5000
const UPDATE_VERSION_FILE = 'version_desktop_tool.json'; // 本项目专属版本文件，与服务器上其他项目的 version.json 隔离

ipcMain.handle('get-app-version', () => {
  try {
    const fs = require('fs');
    const pkgPath = path.join(__dirname, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return { version: pkg.version || '1.0.0', name: pkg.name || 'ai-desktop-app' };
  } catch {
    return { version: '1.0.0', name: 'ai-desktop-app' };
  }
});

ipcMain.handle('check-for-update', async () => {
  if (!UPDATE_SERVER_URL) {
    return { hasUpdate: false, message: '未配置更新服务器地址' };
  }

  try {
    const currentPkg = await new Promise((resolve) => {
      const fs = require('fs');
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
        resolve(pkg);
      } catch {
        resolve({ version: '1.0.0', name: 'ai-desktop-app' });
      }
    });

    const versionUrl = `${UPDATE_SERVER_URL}/download/${UPDATE_VERSION_FILE}`;
    const resp = await httpGetJson(versionUrl, 10000);

    if (!resp.data || resp.status !== 200) {
      return { hasUpdate: false, message: '无法获取版本信息' };
    }

    const serverData = resp.data;
    const latestVersion = serverData.version || serverData.latest_version || '';
    const currentVersion = currentPkg.version || '1.0.0';

    if (!latestVersion) {
      return { hasUpdate: false, message: '服务器未返回版本号' };
    }

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion,
        releaseNotes: serverData.release_notes || serverData.changelog || '',
        updateTime: serverData.update_time || serverData.updateTime || '',
      };
    }

    return {
      hasUpdate: true,
      currentVersion,
      latestVersion,
      downloadUrl: serverData.download_url || `${UPDATE_SERVER_URL}/download/${serverData.filename || ''}`,
      releaseNotes: serverData.release_notes || serverData.changelog || '',
      filename: serverData.filename || '',
      sha256: serverData.sha256 || '',
      updateTime: serverData.update_time || serverData.updateTime || '',
    };
  } catch (err) {
    console.error('[update] Check failed:', err.message);
    return { hasUpdate: false, message: `检查更新失败: ${err.message}` };
  }
});

function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);
  const len = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < len; i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

ipcMain.handle('download-update', async (event, downloadUrl, expectedSha256) => {
  if (!downloadUrl) {
    return { success: false, message: '未提供下载地址' };
  }

  try {
    const os = require('os');
    const fs = require('fs');
    const crypto = require('crypto');
    const filename = downloadUrl.split('/').pop() || 'update-setup.exe';
    const destPath = path.join(os.tmpdir(), filename);

    if (fs.existsSync(destPath)) {
      try { fs.unlinkSync(destPath); } catch {}
    }

    await downloadFile(downloadUrl, destPath, 3600000);

    if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1024) {
      return { success: false, message: '下载的文件异常，大小不足' };
    }

    if (expectedSha256) {
      const hash = crypto.createHash('sha256');
      const fileBuf = fs.readFileSync(destPath);
      hash.update(fileBuf);
      const actualSha256 = hash.digest('hex').toLowerCase();
      if (actualSha256 !== expectedSha256.toLowerCase()) {
        try { fs.unlinkSync(destPath); } catch {}
        console.error(`[update] SHA256 mismatch: expected=${expectedSha256} actual=${actualSha256}`);
        return { success: false, message: `文件校验失败：SHA256 不匹配` };
      }
      console.log('[update] SHA256 verified OK');
    }

    return { success: true, path: destPath };
  } catch (err) {
    console.error('[update] Download failed:', err.message);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('install-update', async (event, installerPath) => {
  if (!installerPath) {
    return { success: false, message: '未提供安装包路径' };
  }

  try {
    const fs = require('fs');
    if (!fs.existsSync(installerPath)) {
      return { success: false, message: '安装包文件不存在' };
    }

    const ext = path.extname(installerPath).toLowerCase();

    if (ext === '.exe') {
      // VBS 先 sleep 等待旧进程退出，再启动 exe 安装程序
      const vbs = [
        `WScript.Sleep 3000`,
        `Set ws = CreateObject("WScript.Shell")`,
        `ws.Run """${installerPath}""", 1, False`,
      ].join('\r\n');
      const vbsPath = path.join(require('os').tmpdir(), `update_launch_${Date.now()}.vbs`);
      fs.writeFileSync(vbsPath, vbs, 'utf-8');

      // 使用 shell.openPath 启动 VBS，避免 app.quit() 误杀 wscript
      shell.openPath(vbsPath);

      // 立即退出，VBS 内部有 Sleep 等待进程退出后再启动安装程序
      app.quit();

      return { success: true, installing: true };
    }

    // 获取当前安装目录，强制新版本安装到同一路径
    const currentInstallDir = path.dirname(process.resourcesPath);
    if (ext === '.msi') {
      // 旧进程必须先退出，否则 MSI 无法覆盖正在使用的文件
      // VBS 先 sleep 等待进程退出，再启动 msiexec，安装完成后自动启动新版本
      const msiLogPath = path.join(require('os').tmpdir(), 'ai_assistant_update.log');
      const exePath = path.join(currentInstallDir, 'AI_Assistant_Omni.exe');
      const vbs = [
        `WScript.Sleep 3000`,
        `Set ws = CreateObject("WScript.Shell")`,
        `ws.Run "msiexec /i ""${installerPath}"" INSTALLDIR=""${currentInstallDir}"" /qb! /norestart /l*v ""${msiLogPath}""", 1, True`,
        `ws.Run """${exePath}""", 1, False`,
      ].join('\r\n');
      const vbsPath = path.join(require('os').tmpdir(), `update_launch_${Date.now()}.vbs`);
      fs.writeFileSync(vbsPath, vbs, 'utf-8');

      // 使用 shell.openPath 启动 VBS，而非 spawn，
      // 避免 app.quit() 时 Electron 的 Job Object 误杀 wscript 进程
      shell.openPath(vbsPath);

      // 立即退出，VBS 内部有 Sleep 等待进程退出后再启动 MSI
      // 注意：不能在此处 unlink vbsPath，因为 wscript 可能尚未读取完成
      app.quit();

      return { success: true, installing: true };
    }

    await shell.openPath(installerPath);
    return { success: true };
  } catch (err) {
    console.error('[update] Install failed:', err.message);
    return { success: false, message: err.message };
  }
});

// ==================== 依赖工具更新检测 ====================

const DEPENDENCY_VERSION_FILE = 'dependency_versions.json';
const DEPENDENCY_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 每 2 小时检查一次
const TOOL_VERSION_MANIFEST_FILE = 'tool_versions.json';

let dependencyToolUpdateCheckTimer = null;
let dependencyToolUpdateStatus = {}; // { 'llm-wiki': { hasUpdate, local, remote }, 'chrys': { ... } }

/**
 * 计算文件的 SHA256 哈希值
 */
function computeFileSha256(filePath) {
  try {
    const fs = require('fs');
    const crypto = require('crypto');
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex').toLowerCase();
  } catch (err) {
    console.error(`[tool-update] computeFileSha256 failed for ${filePath}:`, err.message);
    return null;
  }
}

/**
 * 获取工具版本本地清单文件路径
 */
function getToolVersionManifestPath() {
  const homeDir = require('os').homedir();
  return path.join(homeDir, '.SSSC_AI', TOOL_VERSION_MANIFEST_FILE);
}

/**
 * 读取本地工具版本清单
 * @returns {Object} { 'llm-wiki': { version, installerSha256, installedAt }, 'chrys': { ... } }
 */
function getLocalToolManifest() {
  try {
    const fs = require('fs');
    const manifestPath = getToolVersionManifestPath();
    if (!fs.existsSync(manifestPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.error('[tool-update] Failed to read local tool manifest:', err.message);
    return {};
  }
}

/**
 * 保存本地工具版本清单
 */
function saveLocalToolManifest(manifest) {
  try {
    const fs = require('fs');
    const manifestPath = getToolVersionManifestPath();
    const dir = path.dirname(manifestPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log('[tool-update] Local tool manifest saved');
  } catch (err) {
    console.error('[tool-update] Failed to save local tool manifest:', err.message);
  }
}

/**
 * 更新本地清单中某个工具的信息（下载完成后调用）
 * @param {string} toolId - 工具标识（如 'llm-wiki', 'chrys'）
 * @param {Object} info - { version, installerSha256 }
 */
function updateLocalToolRecord(toolId, info) {
  const manifest = getLocalToolManifest();
  manifest[toolId] = {
    ...(manifest[toolId] || {}),
    version: info.version || 'unknown',
    installerSha256: info.installerSha256 || '',
    installedAt: Date.now(),
  };
  saveLocalToolManifest(manifest);
}

/**
 * 获取远程依赖工具版本清单（通过 SFTP 从服务器下载）
 */
async function fetchRemoteDependencyVersions() {
  try {
    const os = require('os');
    const destPath = path.join(os.tmpdir(), 'dependency_versions_fetched.json');

    console.log('[tool-update] Fetching remote dependency versions via SFTP...');
    const result = await tryScpFile(DEPENDENCY_VERSION_FILE, destPath, '/home/Knowledge_Management');

    if (!result.success) {
      console.warn('[tool-update] SFTP fetch failed:', result.message);
      return null;
    }

    const fs = require('fs');
    const fetchedPath = result.localPath || destPath;
    if (!fs.existsSync(fetchedPath) || fs.statSync(fetchedPath).size === 0) {
      console.warn('[tool-update] Fetched dependency_versions.json is empty');
      return null;
    }

    const data = JSON.parse(fs.readFileSync(fetchedPath, 'utf-8'));
    console.log('[tool-update] Remote dependency versions:', JSON.stringify(data).slice(0, 200));
    return data;
  } catch (err) {
    console.error('[tool-update] Failed to fetch remote dependency versions:', err.message);
    return null;
  }
}

/**
 * 查找本地已安装工具的 exe 文件路径
 */
function findInstalledToolExe(toolId) {
  try {
    const fs = require('fs');
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || '';

    switch (toolId) {
      case 'chrys': {
        const searchPaths = [
          path.join(process.cwd(), 'chrys.exe'),
          path.join(localAppData, 'chrys', 'bin', 'chrys.exe'),
          path.join(localAppData, 'chrys', 'chrys.exe'),
          path.join(localAppData, 'Programs', 'chrys', 'bin', 'chrys.exe'),
          path.join(localAppData, 'Programs', 'chrys', 'chrys.exe'),
          path.join(process.env.APPDATA || '', 'chrys', 'bin', 'chrys.exe'),
          path.join(process.env.APPDATA || '', 'npm', 'chrys.exe'),
          path.join(process.env.APPDATA || '', 'npm', 'chrys.cmd'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'chrys', 'bin', 'chrys.exe'),
        ];
        for (const p of searchPaths) {
          if (fs.existsSync(p)) return p;
        }
        return null;
      }
      case 'llm-wiki': {
        const searchDirs = [
          path.join(localAppData, 'Programs', 'LLM_Wiki'),
          path.join(localAppData, 'Programs', 'LLM Wiki'),
          path.join(localAppData, 'LLM_Wiki'),
          path.join(localAppData, 'LLM Wiki'),
          path.join(process.env.APPDATA || '', 'LLM_Wiki'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLM_Wiki'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLM Wiki'),
        ];
        for (const dir of searchDirs) {
          if (fs.existsSync(dir)) {
            const exePath = path.join(dir, 'llm-wiki.exe');
            if (fs.existsSync(exePath)) return exePath;
            try {
              const found = findExeRecursive(dir, 'llm-wiki.exe');
              if (found) return found;
            } catch {}
          }
        }
        return null;
      }
      default:
        return null;
    }
  } catch (err) {
    console.error(`[tool-update] findInstalledToolExe failed for ${toolId}:`, err.message);
    return null;
  }
}

/**
 * 核心：检查依赖工具更新
 * 通过对比本地清单中的 installerSha256 与远程清单中的 installer_sha256 来判断是否有更新
 */
async function checkDependencyToolUpdates() {
  console.log('[tool-update] Checking for dependency tool updates...');
  const remoteVersions = await fetchRemoteDependencyVersions();
  if (!remoteVersions || !remoteVersions.tools) {
    console.log('[tool-update] No remote dependency version info available');
    return null;
  }

  const localManifest = getLocalToolManifest();
  const updates = []; // 有更新的工具列表

  for (const [toolId, remoteInfo] of Object.entries(remoteVersions.tools)) {
    const localInfo = localManifest[toolId];
    const remoteHash = (remoteInfo.installer_sha256 || remoteInfo.sha256 || '').toLowerCase();

    let hasUpdate = false;
    let reason = '';

    if (!localInfo) {
      // 本地无记录：尝试通过已安装的 exe 哈希判断
      const installedExe = findInstalledToolExe(toolId);
      if (installedExe) {
        const localExeHash = computeFileSha256(installedExe);
        const remoteExeHash = (remoteInfo.installed_exe_sha256 || '').toLowerCase();
        if (localExeHash && remoteExeHash && localExeHash !== remoteExeHash) {
          hasUpdate = true;
          reason = '已安装版本与远程版本不一致';
        } else if (!remoteExeHash) {
          console.log(`[tool-update] ${toolId}: local installed but no remote exe hash for comparison`);
        }
      } else {
        console.log(`[tool-update] ${toolId}: not installed locally, skipping`);
      }
    } else if (localInfo.installerSha256 && remoteHash && localInfo.installerSha256 !== remoteHash) {
      hasUpdate = true;
      reason = '安装包哈希不一致，有新版本';
    }

    const status = {
      toolId,
      name: remoteInfo.name || toolId,
      hasUpdate,
      reason,
      localVersion: localInfo ? localInfo.version : (findInstalledToolExe(toolId) ? 'installed' : 'not installed'),
      remoteVersion: remoteInfo.version || 'unknown',
      downloadUrl: remoteInfo.download_url || '',
      remoteSha256: remoteHash,
      localSha256: localInfo ? localInfo.installerSha256 : null,
    };

    dependencyToolUpdateStatus[toolId] = status;

    if (hasUpdate) {
      updates.push(status);
      console.log(`[tool-update] UPDATE available for ${toolId}: ${reason} (local=${status.localSha256}, remote=${status.remoteSha256})`);
    } else {
      console.log(`[tool-update] ${toolId}: up to date`);
    }
  }

  // 向前端推送状态
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dependency-tool-update-status', {
      updates,
      allStatus: { ...dependencyToolUpdateStatus },
      checkedAt: Date.now(),
    });
  }

  return updates;
}

/**
 * 启动后台依赖工具更新检测任务（在 app ready 后调用）
 */
function startDependencyToolUpdateCheck() {
  if (dependencyToolUpdateCheckTimer) return;
  console.log('[tool-update] Starting dependency tool update check (interval:',
    DEPENDENCY_CHECK_INTERVAL_MS, 'ms)');

  const runCheck = async () => {
    try {
      const updates = await checkDependencyToolUpdates();
      if (updates && updates.length > 0) {
        const toolNames = updates.map(u => u.name).join('、');
        const notification = new Notification({
          title: '依赖工具更新可用',
          body: `${toolNames} 有新版本，建议更新`,
          silent: false,
        });
        notification.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.webContents.send('dependency-tool-update-show-dialog', { updates });
          }
        });
        notification.show();
        console.log(`[tool-update] Notification shown for: ${toolNames}`);
      }
    } catch (err) {
      console.error('[tool-update] Background check error:', err.message);
    }
  };

  // 首次延迟 30 秒，等工具启动完成
  setTimeout(() => {
    runCheck();
    dependencyToolUpdateCheckTimer = setInterval(runCheck, DEPENDENCY_CHECK_INTERVAL_MS);
  }, 30000);
}

function stopDependencyToolUpdateCheck() {
  if (dependencyToolUpdateCheckTimer) {
    clearInterval(dependencyToolUpdateCheckTimer);
    dependencyToolUpdateCheckTimer = null;
    dependencyToolUpdateStatus = {};
    console.log('[tool-update] Dependency tool update check stopped');
  }
}

// ==================== 依赖工具版本 SFTP 拉取与对比 IPC ====================

/**
 * 获取本地缓存的服务器依赖版本数据（从用户主目录读取）
 */
function getLocalDependencyVersionsCache() {
  try {
    const fs = require('fs');
    const homeDir = require('os').homedir();
    const localPath = path.join(homeDir, '.SSSC_AI', 'dependency_versions_cache.json');
    if (!fs.existsSync(localPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
  } catch (err) {
    console.error('[tool-version] Failed to read local dependency versions cache:', err.message);
    return null;
  }
}

/**
 * 保存依赖版本数据到本地缓存
 */
function saveLocalDependencyVersionsCache(data) {
  try {
    const fs = require('fs');
    const homeDir = require('os').homedir();
    const dir = path.join(homeDir, '.SSSC_AI');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const localPath = path.join(dir, 'dependency_versions_cache.json');
    fs.writeFileSync(localPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[tool-version] Dependency versions cache saved locally');
    return localPath;
  } catch (err) {
    console.error('[tool-version] Failed to save dependency versions cache:', err.message);
    return null;
  }
}

// 获取本地缓存的依赖版本信息
ipcMain.handle('get-local-dependency-versions', async () => {
  const data = getLocalDependencyVersionsCache();
  if (!data) {
    return { success: false, message: '本地没有缓存的依赖版本信息，请在设置面板检查版本更新' };
  }
  return { success: true, data };
});

// 对比本地工具版本与服务器版本（通过 SFTP 获取 dependency_versions.json）
ipcMain.handle('compare-tools-version-with-server', async () => {
  console.log('[tool-version] Comparing local tool versions with server...');
  try {
    const os = require('os');
    const destPath = path.join(os.tmpdir(), 'dependency_versions_compare.json');

    // 通过 SFTP 获取服务器上的 dependency_versions.json
    const result = await tryScpFile(DEPENDENCY_VERSION_FILE, destPath, '/home/Knowledge_Management');

    if (!result.success) {
      // SFTP 失败时，使用本地缓存的版本信息
      const localCache = getLocalDependencyVersionsCache();
      if (!localCache || !localCache.tools) {
        return { success: false, message: '无法获取服务器版本信息，请先确保 SFTP 服务器可达' };
      }
      return compareToolVersions(localCache);
    }

    const fs = require('fs');
    const fetchedPath = result.localPath || destPath;

    if (!fs.existsSync(fetchedPath) || fs.statSync(fetchedPath).size === 0) {
      const localCache = getLocalDependencyVersionsCache();
      if (!localCache || !localCache.tools) {
        return { success: false, message: '服务器上的 dependency_versions.json 无效且本地无缓存' };
      }
      return compareToolVersions(localCache);
    }

    const serverData = JSON.parse(fs.readFileSync(fetchedPath, 'utf-8'));
    // 更新本地缓存
    saveLocalDependencyVersionsCache(serverData);

    return compareToolVersions(serverData);
  } catch (err) {
    console.error('[tool-version] Failed to compare tool versions:', err.message);
    return { success: false, message: `对比失败: ${err.message}` };
  }
});

/**
 * 对比服务器 dependency_versions.json 与本地已安装的工具版本
 * @param {Object} serverData - 服务器上的 dependency_versions.json 数据
 * @returns {Object} { success, data: { tools: [...], checkedAt } }
 */
function compareToolVersions(serverData) {
  const localManifest = getLocalToolManifest();
  const tools = [];

  if (!serverData.tools || typeof serverData.tools !== 'object') {
    return { success: false, message: '服务器版本数据格式错误' };
  }

  for (const [toolId, remoteInfo] of Object.entries(serverData.tools)) {
    const localInfo = localManifest[toolId];
    const remoteHash = (remoteInfo.installer_sha256 || '').toLowerCase();
    const remoteVersion = remoteInfo.version || 'unknown';

    let status = 'unknown';
    let detail = '';

    if (!localInfo || !localInfo.installerSha256) {
      const installedExe = findInstalledToolExe(toolId);
      if (installedExe) {
        const localExeHash = computeFileSha256(installedExe);
        const remoteExeHash = (remoteInfo.installed_exe_sha256 || '').toLowerCase();
        if (localExeHash && remoteExeHash && localExeHash !== remoteExeHash) {
          status = 'update_available';
          detail = '已安装的 exe 版本与服务器不一致';
        } else {
          status = 'installed_no_record';
          detail = '已安装但本地无下载记录';
        }
      } else {
        status = 'not_installed';
        detail = '未安装';
      }
    } else if (remoteHash && localInfo.installerSha256.toLowerCase() !== remoteHash) {
      status = 'update_available';
      detail = `安装包哈希不一致（本地: ${localInfo.installerSha256.slice(0, 16)}..., 远程: ${remoteHash.slice(0, 16)}...）`;
    } else {
      status = 'up_to_date';
      detail = '已是最新版本';
    }

    tools.push({
      toolId,
      name: remoteInfo.name || toolId,
      status,
      detail,
      localVersion: localInfo ? localInfo.version : 'unknown',
      remoteVersion,
      serverSha256: remoteHash,
      localSha256: localInfo ? localInfo.installerSha256 : null,
      installerFile: remoteInfo.installer_file || '',
      downloadUrl: remoteInfo.download_url || '',
    });
  }

  for (const [toolId, localInfo] of Object.entries(localManifest)) {
    if (!serverData.tools[toolId]) {
      tools.push({
        toolId,
        name: toolId,
        status: 'server_no_info',
        detail: '服务器上无此工具的版本信息',
        localVersion: localInfo.version || 'unknown',
        remoteVersion: 'unknown',
        serverSha256: '',
        localSha256: localInfo.installerSha256 || '',
        installerFile: '',
        downloadUrl: '',
      });
    }
  }

  return {
    success: true,
    data: {
      tools,
      updateTime: serverData.update_time || null,
      checkedAt: Date.now(),
    },
  };
}

// ==================== HiDesk 服务自动部署 IPC ====================

/**
 * 设置 HiDesk 服务：从远端 SFTP 下载 exe 并启动
 */
ipcMain.handle('setup-hidesk-service', async (event, { remoteHost, remotePath }) => {
  console.log('[hidesk] setup-hidesk-service called:', { remoteHost, remotePath });

  // 1. 先检查本机 5858 是否已就绪
  const alreadyHealthy = await checkWikiHealth('127.0.0.1', 5858, 3000);
  if (alreadyHealthy) {
    console.log('[hidesk] Port 5858 already healthy, skip');
    return { success: true, wasRunning: true };
  }

  // 2. 检查并清理残留的 HiDesk_Knowledge_API.exe 进程
  killHiDeskProcesses();
  await new Promise(r => setTimeout(r, 2000));

  // 3. 确保 SFTP 服务就绪（用于 SCP 下载）
  if (!sftpProcess || sftpProcess.killed) {
    console.log('[hidesk] SFTP service not running, starting...');
    const sftpResult = await startSftpService();
    if (!sftpResult.success) {
      return { success: false, message: 'SFTP 服务启动失败，无法下载 HiDesk 服务' };
    }
  }

  // 4. 获取本地存储路径，若已存在则直接启动
  const os = require('os');
  const destPath = path.join(os.tmpdir(), 'HiDesk_Knowledge_API.exe');
  const fs = require('fs');

  // 永远优先从远端拉取最新 exe，失败时才回退到本地缓存
  const remoteFileName = path.basename(remotePath);
  const remoteDir = path.dirname(remotePath);
  console.log(`[hidesk] Downloading latest via SCP: ${remoteHost}:${remotePath} -> ${destPath}`);
  const scpResult = await tryScpFileFromHost(remoteHost, remoteFileName, destPath, remoteDir);

  if (!scpResult.success) {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) {
      console.log('[hidesk] Remote download failed, using local cached exe:', destPath);
    } else {
      return { success: false, message: 'HiDesk 服务下载失败: ' + (scpResult.message || '未知错误') };
    }
  } else {
    console.log('[hidesk] Latest exe downloaded, launching...');
  }

  // 5. 启动 exe（detached 模式，不阻塞主进程）
  try {
    const { spawn } = require('child_process');
    hideskProcess = spawn(destPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    hideskProcess.unref();
    spawnedPids.add(hideskProcess.pid);
    console.log('[hidesk] Process spawned, PID:', hideskProcess.pid);

    // 6. 等待 5858 就绪（最多 30 秒）
    const healthy = await waitForPort('127.0.0.1', 5858, 30000, 1000);
    if (healthy) {
      console.log('[hidesk] Service is healthy on port 5858');
      return { success: true, wasRunning: false, pid: hideskProcess.pid };
    } else {
      return { success: false, message: 'HiDesk 服务启动超时，请稍后重试或手动启动' };
    }
  } catch (err) {
    console.error('[hidesk] Failed to launch:', err.message);
    return { success: false, message: 'HiDesk 服务启动失败: ' + err.message };
  }
});

/**
 * 从指定主机通过 SFTP 下载文件（复用现有 SFTP 服务）
 */
async function tryScpFileFromHost(host, remoteFileName, localDestPath, remoteDir) {
  // 复用现有的 SFTP 服务基础设施
  const servers = loadServerConfig();
  const targetServer = servers.find(s => s.host === host) || {
    name: 'hidesk-remote',
    host,
    port: 22,
    username: 'root',
    password: '',
  };

  // 尝试匹配的服务器
  if (servers.some(s => s.host === host)) {
    return await tryScpFile(remoteFileName, localDestPath, remoteDir);
  }

  // 没有匹配的已配置服务器，直接走单次 SFTP
  const port = targetServer.port || 22;
  const username = targetServer.username || 'root';
  const password = targetServer.password || '';
  const remoteFilePath = `${remoteDir}/${remoteFileName}`;

  console.log(`[hidesk] SFTP: ${username}@${host}:${port} ${remoteFilePath} -> ${localDestPath}`);

  // 确保 SFTP 服务 (5003) 就绪
  const wikiReady = await waitForPort('127.0.0.1', 5003, 5000, 200);
  if (!wikiReady) {
    return { success: false, message: 'SFTP 服务 (5003) 未就绪' };
  }

  const http = require('http');
  const resp = await new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      host,
      port,
      username,
      password,
      remote_path: remoteFilePath,
      local_path: localDestPath,
      timeout: 120,
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 5003,
      path: '/api/sftp/download',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 120000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body });
        } catch { reject(new Error('Response parse error')); }
      });
    });
    req.on('error', (err) => resolve({ statusCode: 0, body: '', error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 0, body: '', error: 'timeout' }); });
    req.write(postData);
    req.end();
  });

  if (resp.statusCode === 200) {
    try {
      const data = JSON.parse(resp.body);
      if (data.success) {
        const fs = require('fs');
        if (fs.existsSync(localDestPath) && fs.statSync(localDestPath).size > 1024) {
          return { success: true, localPath: localDestPath };
        }
        return { success: false, message: '下载文件大小异常' };
      }
      return { success: false, message: data.message || 'SFTP 下载失败' };
    } catch {
      return { success: false, message: 'SFTP 响应解析失败' };
    }
  }

  return { success: false, message: `SFTP HTTP ${resp.statusCode}: ${resp.error || resp.body?.substring(0, 200) || '未知错误'}` };
}

// ==================== 预处理服务自动部署 IPC ====================

/**
 * 启动预处理服务：从远端 SFTP 下载 cloudmodeling-processor.exe 并启动
 * 供 auto-start 和 IPC handler 共用
 * @param {number} port - 监听端口，默认 5900
 * @param {object} remoteConfig - 远端配置 { ip, remotePath }
 * @returns {object} { success, wasRunning?, pid?, message?, logs }
 */
async function doStartPreprocessorService(port, remoteConfig) {
  const targetPort = port || 5900;
  const remoteHost = remoteConfig?.ip || '7.212.122.246';
  const remotePath = remoteConfig?.remotePath || '/home/Knowledge_Management/cloudmodeling-processor.exe';
  const logs = [];
  const t = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const addLog = (msg) => { logs.push(`[${t()}] ${msg}`); console.log(`[preprocessor] ${msg}`); };
  addLog(`开始部署预处理服务，目标端口: ${targetPort}`);

  // 1. 先检查目标端口是否已就绪
  addLog('检查端口是否已就绪...');
  const alreadyHealthy = await checkPort('127.0.0.1', targetPort);
  if (alreadyHealthy) {
    addLog(`端口 ${targetPort} 已就绪，无需重复启动`);
    return { success: true, wasRunning: true, logs };
  }
  addLog(`端口 ${targetPort} 未就绪`);

  // 2. 检查并清理残留的 cloudmodeling-processor.exe 进程
  addLog('清理残留进程...');
  killPreprocessorProcesses();
  await new Promise(r => setTimeout(r, 2000));
  addLog('残留进程清理完成');

  // 3. 确保 SFTP 服务就绪（用于 SCP 下载）
  addLog('确保 SFTP 服务就绪...');
  if (!sftpProcess || sftpProcess.killed) {
    addLog('SFTP 服务未运行，正在启动...');
    const sftpResult = await startSftpService();
    if (!sftpResult.success) {
      addLog('错误: SFTP 服务启动失败');
      return { success: false, message: 'SFTP 服务启动失败，无法下载预处理服务', logs };
    }
  }
  addLog('SFTP 服务已就绪');

  // 4. 获取本地存储路径，若已存在则直接启动
  const os = require('os');
  const destPath = path.join(os.tmpdir(), 'cloudmodeling-processor.exe');
  const fs = require('fs');

  // 优先从远端拉取最新 exe，失败时才回退到本地缓存
  const remoteFileName = path.basename(remotePath);
  const remoteDir = path.dirname(remotePath);
  addLog(`从远端下载: ${remoteHost}:${remotePath}`);
  const scpResult = await tryScpFileFromHost(remoteHost, remoteFileName, destPath, remoteDir);

  if (!scpResult.success) {
    addLog(`远端下载失败: ${scpResult.message || '未知错误'}`);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) {
      addLog('使用本地缓存的 exe');
    } else {
      addLog('错误: 本地也无缓存，部署失败');
      return { success: false, message: '预处理服务下载失败: ' + (scpResult.message || '未知错误'), logs };
    }
  } else {
    addLog('下载完成');
  }

  // 5. 启动 exe（通过命令行参数指定端口）
  try {
    const { spawn } = require('child_process');
    const args = ['--port', String(targetPort)];
    addLog(`启动进程: cloudmodeling-processor.exe --port ${targetPort}`);
    preprocessorProcess = spawn(destPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    preprocessorProcess.unref();
    spawnedPids.add(preprocessorProcess.pid);
    addLog(`进程已启动, PID: ${preprocessorProcess.pid}`);

    // 6. 等待端口就绪（最多 30 秒）
    addLog('等待服务就绪（最多 30 秒）...');
    const healthy = await waitForPort('127.0.0.1', targetPort, 30000, 1000);
    if (healthy) {
      addLog(`服务已在端口 ${targetPort} 上就绪`);
      return { success: true, wasRunning: false, pid: preprocessorProcess.pid, logs };
    } else {
      addLog('错误: 服务启动超时');
      return { success: false, message: '预处理服务启动超时，请稍后重试或手动启动', logs };
    }
  } catch (err) {
    addLog(`错误: 启动失败 - ${err.message}`);
    return { success: false, message: '预处理服务启动失败: ' + err.message, logs };
  }
}

/**
 * 设置预处理服务 IPC handler
 */
ipcMain.handle('setup-preprocessor-service', async (event, { port, remoteConfig }) => {
  const result = await doStartPreprocessorService(port, remoteConfig);
  if (result.success && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('preprocessor-status-changed', { running: true, port: port || 5900 });
  }
  return result;
});

/**
 * 停止预处理服务
 */
ipcMain.handle('stop-preprocessor-service', async () => {
  const logs = [];
  const t = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const addLog = (msg) => { logs.push(`[${t()}] ${msg}`); console.log(`[preprocessor] ${msg}`); };
  addLog('正在停止预处理服务...');
  killPreprocessorProcesses();
  addLog('预处理服务已停止');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('preprocessor-status-changed', { running: false });
  }
  return { success: true, logs };
});

/**
 * 获取预处理服务状态
 */
ipcMain.handle('get-preprocessor-status', async (event, port = 5900) => {
  const processRunning = preprocessorProcess && !preprocessorProcess.killed;
  const portHealthy = await checkPort('127.0.0.1', port, 2000);
  return {
    running: processRunning,
    portHealthy,
    pid: processRunning ? preprocessorProcess.pid : null,
  };
});

// ==================== 进程树查询 IPC ====================

/**
 * 获取当前应用 spawn 的所有进程及其子进程树
 */
ipcMain.handle('get-process-tree', async () => {
  try {
    const [raw, pidPorts] = await Promise.all([queryProcessTree(), queryListeningPorts()]);
    const tree = buildProcessTree(raw, spawnedPids, pidPorts);
    return { success: true, tree };
  } catch (err) {
    console.error('[process-tree] Query failed:', err.message);
    return { success: false, message: err.message };
  }
});

/**
 * 杀死指定进程及其所有子进程（树状 kill）
 */
ipcMain.handle('kill-process-tree', async (_event, pid) => {
  try {
    const { execSync } = require('child_process');
    const result = execSync(`taskkill /F /T /PID ${pid} 2>&1`, { timeout: 10000, encoding: 'utf-8' });
    console.log(`[process-tree] Killed PID ${pid} tree:`, result.trim());
    spawnedPids.delete(pid);
    return { success: true, message: result.trim() };
  } catch (err) {
    console.error(`[process-tree] Kill PID ${pid} failed:`, err.message);
    return { success: false, message: err.message };
  }
});

function queryProcessTree() {
  return new Promise((resolve, reject) => {
    // 优先使用 Get-WmiObject（兼容性更广，不依赖 CIM/WinRM）
    const cmd = `Get-WmiObject Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
    const { exec } = require('child_process');
    exec(cmd, { shell: 'powershell.exe', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // WMIC 回退：CSV 列顺序为 Node, ProcessId, ParentProcessId, Name, CommandLine
        exec('wmic process get ProcessId,ParentProcessId,Name,CommandLine /format:csv', { timeout: 10000 }, (err2, stdout2) => {
          if (err2) return reject(err2);
          resolve(parseWmicOutput(stdout2));
        });
        return;
      }
      try {
        const arr = JSON.parse(stdout.trim() || '[]');
        resolve(Array.isArray(arr) ? arr : [arr]);
      } catch {
        resolve(parseWmicOutput(stdout));
      }
    });
  });
}

function parseWmicOutput(output) {
  const lines = output.trim().split('\n').slice(1); // skip header
  const result = [];
  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length >= 4) {
      // WMIC CSV 格式: Node,ProcessId,ParentProcessId,Name,CommandLine...
      result.push({
        ProcessId: parseInt(cols[1], 10) || 0,
        ParentProcessId: parseInt(cols[2], 10) || 0,
        Name: cols[3]?.trim() || '',
        CommandLine: cols.slice(4).join(',').trim() || '',
      });
    }
  }
  return result;
}

function queryListeningPorts() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('netstat -ano | findstr LISTENING', { timeout: 10000 }, (err, stdout) => {
      if (err) { resolve(new Map()); return; }
      const pidPorts = new Map(); // pid -> Set of ports
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // netstat 输出格式: Proto  Local Address  Foreign Address  State  PID
        // 例如: TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    12345
        if (parts.length >= 2) {
          const localAddr = parts[1];
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!pid) continue;
          const colonIdx = localAddr.lastIndexOf(':');
          if (colonIdx === -1) continue;
          const port = localAddr.substring(colonIdx + 1);
          if (!pidPorts.has(pid)) pidPorts.set(pid, new Set());
          pidPorts.get(pid).add(port);
        }
      }
      resolve(pidPorts);
    });
  });
}

function buildProcessTree(allProcesses, rootPids, pidPorts) {
  // 构建 pid -> children 映射
  const childrenMap = new Map();
  const processMap = new Map();
  for (const p of allProcesses) {
    const pid = p.ProcessId;
    if (!pid) continue;
    processMap.set(pid, p);
    const ppid = p.ParentProcessId;
    if (!childrenMap.has(ppid)) childrenMap.set(ppid, []);
    childrenMap.get(ppid).push(p);
  }

  // 从 spawnPids 出发，向上查找祖先链，向下查找子进程
  const visited = new Set();
  const roots = [];

  function buildNode(pid, depth = 0) {
    if (visited.has(pid)) return null;
    visited.add(pid);
    const proc = processMap.get(pid);
    if (!proc && depth > 0) return null; // 非根节点且查不到，跳过
    const name = proc ? proc.Name : `PID ${pid} (已退出)`;
    const commandLine = proc ? (proc.CommandLine || '') : '';
    const ports = pidPorts.get(pid);
    const listeningPorts = ports ? Array.from(ports).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)) : [];
    const children = (childrenMap.get(pid) || [])
      .map(c => buildNode(c.ProcessId, depth + 1))
      .filter(Boolean);
    return { name, pid, commandLine, listeningPorts, children };
  }

  // 直接以 spawnedPids 为根节点构建树（只展示本工具管理的进程及其子进程）
  for (const rootPid of rootPids) {
    const rootNode = buildNode(rootPid);
    if (rootNode) {
      rootNode.isSpawnedRoot = true;
      roots.push(rootNode);
    }
  }

  // 去重：相同 root pid 只保留一个
  const seenRoots = new Set();
  return roots.filter(r => {
    if (seenRoots.has(r.pid)) return false;
    seenRoots.add(r.pid);
    return true;
  });
}

// ==================== 依赖工具更新 IPC 处理器 ====================

ipcMain.handle('check-dependency-tool-updates', async () => {
  const updates = await checkDependencyToolUpdates();
  return { success: true, updates, allStatus: { ...dependencyToolUpdateStatus }, checkedAt: Date.now() };
});

ipcMain.handle('get-dependency-tool-update-status', () => {
  return { allStatus: { ...dependencyToolUpdateStatus } };
});

ipcMain.handle('update-local-tool-record', async (event, { toolId, info }) => {
  try {
    updateLocalToolRecord(toolId, info);
    return { success: true };
  } catch (err) {
    console.error('[tool-update] Failed to update local tool record:', err.message);
    return { success: false, message: err.message };
  }
});

// ==================== 网络搜索与网页抓取 ====================

ipcMain.handle('web-search', async (event, { query, engine, searxngUrl, maxResults, proxyUrl }) => {
  const https = require('https');
  const http = require('http');
  const url = require('url');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const { SocksProxyAgent } = require('socks-proxy-agent');

  const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';

  const createProxyAgent = (proxyStr) => {
    if (!proxyStr) return undefined;
    try {
      if (proxyStr.startsWith('socks')) {
        return new SocksProxyAgent(proxyStr);
      }
      return new HttpsProxyAgent(proxyStr);
    } catch (e) {
      console.error('[web-search] Failed to create proxy agent:', e.message);
      return undefined;
    }
  };

  const proxyAgent = createProxyAgent(effectiveProxy);

  const results = [];
  const limit = maxResults || 10;

  const httpGet = (targetUrl, options = {}) => {
    return new Promise((resolve, reject) => {
      const parsedUrl = url.parse(targetUrl);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const defaultOptions = {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      };
      const mergedOptions = { ...defaultOptions, ...options, headers: { ...defaultOptions.headers, ...(options.headers || {}) } };
      if (proxyAgent) {
        mergedOptions.agent = proxyAgent;
      }

      const req = transport.get(targetUrl, mergedOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = url.resolve(targetUrl, res.headers.location);
          httpGet(redirectUrl, options).then(resolve).catch(reject);
          return;
        }
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  };

  const searchDuckDuckGo = async (q) => {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const data = await httpGet(searchUrl);

    const urls = [];
    const urlRegex = /uddg=([^&"]+)/gi;
    let match;
    while ((match = urlRegex.exec(data)) !== null) {
      try { urls.push(decodeURIComponent(match[1])); } catch {}
    }

    const titles = [];
    const titleRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = titleRegex.exec(data)) !== null) {
      titles.push(match[1].replace(/<[^>]*>/g, '').trim());
    }

    const snippets = [];
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = snippetRegex.exec(data)) !== null) {
      snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
    }

    const count = Math.min(urls.length, titles.length, limit);
    for (let i = 0; i < count; i++) {
      results.push({
        title: titles[i] || '',
        url: urls[i] || '',
        snippet: snippets[i] || '',
        engine: 'duckduckgo',
      });
    }
  };

  const searchDuckDuckGoLite = async (q) => {
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
    const data = await httpGet(searchUrl);

    const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

    let match;
    const items = [];
    while ((match = linkRegex.exec(data)) !== null) {
      items.push({
        url: match[1] || '',
        title: match[2].replace(/<[^>]*>/g, '').trim(),
      });
    }

    const snippetItems = [];
    while ((match = snippetRegex.exec(data)) !== null) {
      snippetItems.push(match[1].replace(/<[^>]*>/g, '').trim());
    }

    const count = Math.min(items.length, limit);
    for (let i = 0; i < count; i++) {
      results.push({
        title: items[i].title || '',
        url: items[i].url || '',
        snippet: snippetItems[i] || '',
        engine: 'duckduckgo-lite',
      });
    }
  };

  const searchBing = async (q) => {
    const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(q)}`;
    const data = await httpGet(searchUrl);

    const resultBlockRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let m, items = [];
    while ((m = resultBlockRegex.exec(data)) !== null) {
      const block = m[1];
      const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
        || block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
      if (titleMatch) {
        items.push({
          url: titleMatch[1],
          title: titleMatch[2].replace(/<[^>]*>/g, '').trim(),
          snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '',
        });
      }
    }

    if (items.length === 0) {
      const hrefRegex = /href="(https?:\/\/(?!.*bing\.com)(?!.*microsoft\.com)(?!.*go\.microsoft)[^"]*)"/gi;
      const seen = new Set();
      let m2;
      while ((m2 = hrefRegex.exec(data)) !== null) {
        if (!seen.has(m2[1])) {
          seen.add(m2[1]);
          items.push({ url: m2[1], title: m2[1], snippet: '' });
        }
      }
    }

    for (const item of items.slice(0, limit)) {
      results.push({
        title: item.title || '',
        url: item.url || '',
        snippet: item.snippet || '',
        engine: 'bing',
      });
    }
  };

  const searchSearXNG = async (q) => {
    if (!searxngUrl) throw new Error('SearXNG URL is required');
    const searchUrl = `${searxngUrl}/search?q=${encodeURIComponent(q)}&format=json&categories=general`;
    const data = await httpGet(searchUrl);
    let parsed;
    try { parsed = JSON.parse(data); }
    catch (e) { throw new Error('SearXNG response parse failed'); }

    if (parsed.results) {
      for (const r of parsed.results.slice(0, limit)) {
        results.push({
          title: r.title || '',
          url: r.url || '',
          snippet: r.content || '',
          engine: r.engine || 'searxng',
        });
      }
    }
  };

  try {
    if (engine === 'searxng') {
      await searchSearXNG(query);
    } else if (engine === 'bing') {
      await searchBing(query);
    } else if (engine === 'duckduckgo') {
      try {
        await searchDuckDuckGo(query);
      } catch (e) {
        console.log('[web-search] DuckDuckGo HTML failed, trying lite version:', e.message);
        try {
          await searchDuckDuckGoLite(query);
        } catch (e2) {
          console.log('[web-search] DuckDuckGo Lite also failed, falling back to Bing:', e2.message);
          await searchBing(query);
        }
      }
    } else {
      try {
        await searchBing(query);
      } catch (e) {
        console.log('[web-search] Bing failed, trying DuckDuckGo:', e.message);
        try {
          await searchDuckDuckGo(query);
        } catch (e2) {
          try {
            await searchDuckDuckGoLite(query);
          } catch (e3) {
            throw new Error('All search engines failed. Please check your network or configure a proxy.');
          }
        }
      }
    }

    return { success: true, results };
  } catch (err) {
    console.error('[web-search] Error:', err.message);
    return { success: false, message: err.message, results: [] };
  }
});

ipcMain.handle('web-fetch-page', async (event, { pageUrl, proxyUrl }) => {
  const https = require('https');
  const http = require('http');
  const url = require('url');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const { SocksProxyAgent } = require('socks-proxy-agent');

  const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
  let fetchProxyAgent;
  if (effectiveProxy) {
    try {
      if (effectiveProxy.startsWith('socks')) {
        fetchProxyAgent = new SocksProxyAgent(effectiveProxy);
      } else {
        fetchProxyAgent = new HttpsProxyAgent(effectiveProxy);
      }
    } catch (e) {
      console.error('[web-fetch-page] Failed to create proxy agent:', e.message);
    }
  }

  const fetchPage = async (targetUrl, maxRedirects = 3) => {
    const parsedUrl = url.parse(targetUrl);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const requestOptions = {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    };
    if (fetchProxyAgent) {
      requestOptions.agent = fetchProxyAgent;
    }

    const data = await new Promise((resolve, reject) => {
      const req = transport.get(targetUrl, requestOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = url.resolve(targetUrl, res.headers.location);
          resolve({ redirect: redirectUrl });
          return;
        }
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ content: body }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    });

    if (data.redirect && maxRedirects > 0) {
      return await fetchPage(data.redirect, maxRedirects - 1);
    }

    const html = data.content || '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);

    return { success: true, content: text, url: targetUrl };
  };

  try {
    return await fetchPage(pageUrl);
  } catch (err) {
    console.error('[web-fetch-page] Error:', err.message);
    return { success: false, message: err.message };
  }
});