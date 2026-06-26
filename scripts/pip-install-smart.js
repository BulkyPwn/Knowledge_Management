/**
 * 智能 pip install 脚本
 * - requirements.txt 未变且 vendor/python 已存在：跳过安装（秒级）
 * - 否则使用本地缓存安装
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REQ_FILE = path.join(ROOT, 'requirements.txt');
const VENDOR_PY_DIR = path.join(ROOT, 'vendor', 'python');
const CACHE_DIR = path.join(ROOT, '.pip-cache');
const HASH_FILE = path.join(ROOT, '.pip-cache', 'requirements.hash');

const reqContent = fs.readFileSync(REQ_FILE, 'utf-8');
const newHash = crypto.createHash('sha256').update(reqContent).digest('hex').slice(0, 16);

// 检查是否可以跳过安装
if (fs.existsSync(VENDOR_PY_DIR) && fs.existsSync(HASH_FILE)) {
  const oldHash = fs.readFileSync(HASH_FILE, 'utf-8').trim();
  if (oldHash === newHash) {
    console.log('[pip:install] requirements.txt unchanged, skipping pip install.');
    return;
  }
}

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 清空 vendor/python（避免旧版本残留）
if (fs.existsSync(VENDOR_PY_DIR)) {
  console.log('[pip:install] Cleaning old vendor/python...');
  fs.rmSync(VENDOR_PY_DIR, { recursive: true, force: true });
}

// 执行 pip install（带缓存）
const pythonExe = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
const cmd = [
  `"${pythonExe}" -m pip install`,
  '-r requirements.txt',
  '--target vendor/python',
  '--upgrade',
  '--no-compile',
  `--cache-dir "${CACHE_DIR}"`,
].join(' ');

console.log('[pip:install] Running:', cmd);
execSync(cmd, { stdio: 'inherit', shell: true, cwd: ROOT });

// 安装后清理：移除运行时不需要的文件
stripVendor();

// 写入新的 hash
fs.writeFileSync(HASH_FILE, newHash);
console.log('[pip:install] Done.');

/**
 * 清理 vendor/python 中运行时不需要的文件
 * - tests/ 目录（测试代码）
 * - *.lib 文件（C++ 静态库，编译时用）
 * - *.h / *.hpp 文件（C 头文件，编译时用）
 * - *.pxd 文件（Cython 声明，编译时用）
 */
function stripVendor() {
  const patterns = [
    /[\\/]tests[\\/]/,
  ];
  const extensions = ['.lib', '.h', '.hpp', '.pxd'];

  let removedCount = 0;
  let removedSize = 0;

  // First pass: collect all paths to remove (avoid dirSize overhead)
  const toRemove = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const normalized = fullPath.replace(/\\/g, '/') + '/';
        if (patterns.some(p => p.test(normalized))) {
          toRemove.push(fullPath);
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          toRemove.push(fullPath);
        }
      }
    }
  }

  console.log('[pip:strip] Scanning for unnecessary files...');
  walk(VENDOR_PY_DIR);
  console.log(`[pip:strip] Found ${toRemove.length} items to remove`);

  // Remove all in one pass
  for (const item of toRemove) {
    try {
      const stat = fs.statSync(item);
      if (stat.isDirectory()) {
        fs.rmSync(item, { recursive: true, force: true });
      } else {
        removedSize += stat.size;
        fs.rmSync(item);
      }
      removedCount++;
    } catch (_) {}
  }

  const removedMB = (removedSize / (1024 * 1024)).toFixed(1);
  console.log(`[pip:strip] Removed ${removedCount} items (${removedMB} MB)`);
}
