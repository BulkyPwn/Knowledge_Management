// 知识管理页面本地持久化（~/.SSSC_AI/knowledge_management.json）
// 使用模块级缓存替代组件内 useRef，行为完全一致。

let _memoryFilePath = null;
let _fs = null;

function getFs() {
  if (!_fs) _fs = window.require('fs');
  return _fs;
}

function getMemoryFile() {
  if (!_memoryFilePath) {
    const pathMod = window.require('path');
    const osMod = window.require('os');
    _memoryFilePath = pathMod.join(osMod.homedir(), '.SSSC_AI', 'knowledge_management.json');
  }
  return _memoryFilePath;
}

export { getMemoryFile, getFs };

export function readMemoryFile() {
  try {
    const fs = getFs();
    if (fs.existsSync(getMemoryFile())) return JSON.parse(fs.readFileSync(getMemoryFile(), 'utf-8'));
  } catch (_) {}
  return {};
}

export function writeMemoryFile(updates) {
  const doWrite = () => {
    try {
      const fs = getFs();
      const pathMod = window.require('path');
      const f = getMemoryFile();
      const dir = pathMod.dirname(f);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let data = {};
      if (fs.existsSync(f)) {
        try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (_) {}
      }
      const mergedUpdates = { ...updates };
      if (updates.pptSettings) {
        mergedUpdates.pptSettings = {
          ...(data.pptSettings || {}),
          ...updates.pptSettings,
        };
      }
      Object.assign(data, mergedUpdates);
      fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf-8');
    } catch (_) {}
  };
  setTimeout(doWrite, 0);
}
