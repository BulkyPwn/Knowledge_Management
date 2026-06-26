const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const WIN_UNPACKED_DIR = path.join(DIST_DIR, 'win-unpacked');
const WIX_DIR = path.join(PROJECT_ROOT, 'wix');
const WIX_BUILD_DIR = path.join(DIST_DIR, 'wix-build');
const LOCAL_CACHE_DIR = path.join(PROJECT_ROOT, '.electron-builder-cache', 'wix');
const WIX_VERSION = '4.0.0.5512.2';
const WIX_MIRROR_URL = `https://npmmirror.com/mirrors/electron-builder-binaries/wix-${WIX_VERSION}/wix-${WIX_VERSION}.7z`;
const SEVEN_ZIP = path.join(PROJECT_ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

const WIX_BIN_DIR = findWixBinDir();
const idCache = new Map();

function findWixBinDir() {
  // 1. Try electron-builder cache
  const appDataCache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'wix');
  const dir = findWixInCache(appDataCache);
  if (dir) return dir;

  // 2. Try project-local cache
  const dir2 = findWixInCache(LOCAL_CACHE_DIR);
  if (dir2) return dir2;

  // 3. Download from mirror
  console.log('WiX not found in cache, downloading from mirror...');
  return downloadAndExtractWix();
}

function findWixInCache(cacheDir) {
  if (!fs.existsSync(cacheDir)) return null;
  const dirs = fs.readdirSync(cacheDir).filter(d => {
    const p = path.join(cacheDir, d);
    return fs.statSync(p).isDirectory();
  });
  if (dirs.length === 0) return null;
  const wixDir = path.join(cacheDir, dirs[0]);
  const candleExe = path.join(wixDir, 'candle.exe');
  if (!fs.existsSync(candleExe)) return null;
  console.log(`Using WiX from: ${wixDir}`);
  return wixDir;
}

function downloadAndExtractWix() {
  if (!fs.existsSync(LOCAL_CACHE_DIR)) {
    fs.mkdirSync(LOCAL_CACHE_DIR, { recursive: true });
  }

  const targetDir = path.join(LOCAL_CACHE_DIR, `wix-${WIX_VERSION}`);
  if (fs.existsSync(targetDir)) {
    console.log(`Using WiX from: ${targetDir}`);
    return targetDir;
  }

  const archivePath = path.join(LOCAL_CACHE_DIR, `wix-${WIX_VERSION}.7z`);

  // Download
  if (!fs.existsSync(archivePath)) {
    console.log(`Downloading ${WIX_MIRROR_URL}...`);
    try {
      execSync(`curl -L -o "${archivePath}" "${WIX_MIRROR_URL}"`, { stdio: 'inherit', shell: true });
    } catch (_) {
      // curl may not be available, try PowerShell
      try {
        execSync(`powershell -Command "Invoke-WebRequest -Uri '${WIX_MIRROR_URL}' -OutFile '${archivePath}'"`, {
          stdio: 'inherit', shell: true
        });
      } catch (e2) {
        console.error('Failed to download WiX:', e2.message);
        process.exit(1);
      }
    }
    console.log('Download complete.');
  }

  // Extract
  console.log('Extracting WiX...');
  try {
    execSync(`"${SEVEN_ZIP}" x "${archivePath}" -o"${targetDir}" -y -snl`, {
      stdio: 'inherit', shell: true
    });
  } catch (e) {
    // 7za might exit with non-zero for symlinks, check if candle.exe exists
    if (fs.existsSync(path.join(targetDir, 'candle.exe'))) {
      console.log('Extraction completed (symlink warnings ignored).');
    } else {
      console.error('WiX extraction failed:', e.message);
      process.exit(1);
    }
  }
  console.log(`WiX installed to: ${targetDir}`);
  return targetDir;
}
function shortId(prefix, seed) {
  if (idCache.has(seed)) return idCache.get(seed);
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
  const id = `${prefix}_${hash}`;
  idCache.set(seed, id);
  return id;
}

function generateGuid(seed) {
  const hash = crypto.createHash('sha256').update(seed).digest();
  const hex = hash.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join('-').toUpperCase();
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function harvestFiles(sourceDir) {
  console.log('Harvesting files from:', sourceDir);

  const directoryIds = new Map();
  const directoryEntries = [];
  const dirFiles = new Map();
  let fileCount = 0;

  function getDirectoryId(relPath) {
    if (directoryIds.has(relPath)) return directoryIds.get(relPath);
    const id = relPath === '' ? 'INSTALLDIR' : shortId('d', relPath);
    directoryIds.set(relPath, id);
    return id;
  }

  function buildDirectoryTree(relPath) {
    if (relPath === '' || directoryIds.has(relPath)) return;
    const parts = relPath.split('/');
    const dirName = parts[parts.length - 1];
    const parentRelPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const myId = getDirectoryId(relPath);
    const parentId = getDirectoryId(parentRelPath);

    buildDirectoryTree(parentRelPath);
    if (!directoryEntries.find(d => d.id === myId)) {
      directoryEntries.push({ id: myId, parentId, name: dirName });
    }
  }

  function walkDir(dir, relBase) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const filesInDir = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        buildDirectoryTree(relPath);
        walkDir(fullPath, relPath);
      } else {
        filesInDir.push({ fileName: entry.name, relPath });
        fileCount++;
      }
    }

    if (filesInDir.length > 0) {
      const dirId = getDirectoryId(relBase);
      dirFiles.set(dirId, filesInDir);
    }
  }

  walkDir(sourceDir, '');

  const compCount = dirFiles.size;
  console.log(`Harvested ${fileCount} files in ${directoryIds.size} directories, ${compCount} components`);

  return { dirFiles, directoryEntries, directoryIds, fileCount, compCount };
}

function generateFilesWxs(harvestResult) {
  const { dirFiles, directoryEntries, fileCount, compCount } = harvestResult;

  // 递归生成嵌套的 Directory 元素，保持原始目录层级
  function generateDirectoryXml(parentId, indentLevel) {
    const prefix = '      '.repeat(indentLevel + 1);
    const children = directoryEntries.filter(d => d.parentId === parentId);
    if (children.length === 0) return '';
    return children.map(d => {
      const inner = generateDirectoryXml(d.id, indentLevel + 1);
      if (inner) {
        return `${prefix}<Directory Id="${d.id}" Name="${escapeXml(d.name)}">\n${inner}\n${prefix}</Directory>`;
      }
      return `${prefix}<Directory Id="${d.id}" Name="${escapeXml(d.name)}" />`;
    }).join('\n');
  }
  const dirXml = generateDirectoryXml('INSTALLDIR', 0);

  const dirRefXml = [];
  const compRefXml = [];

  for (const [dirId, files] of dirFiles) {
    const compId = shortId('c', dirId);
    const guid = generateGuid(dirId);

    dirRefXml.push(`    <DirectoryRef Id="${dirId}">`);
    dirRefXml.push(`      <Component Id="${compId}" Guid="${guid}">`);

    for (const file of files) {
      const fileId = shortId('f', file.relPath);
      dirRefXml.push(`        <File Id="${fileId}" Source="$(var.SourceDir)\\${escapeXml(file.relPath.replace(/\//g, '\\'))}" />`);
    }

    dirRefXml.push(`      </Component>`);
    dirRefXml.push(`    </DirectoryRef>`);
    compRefXml.push(`      <ComponentRef Id="${compId}" />`);
  }

  const wxs = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <DirectoryRef Id="INSTALLDIR">
${dirXml}
    </DirectoryRef>
  </Fragment>
  <Fragment>
${dirRefXml.join('\n')}
  </Fragment>
  <Fragment>
    <ComponentGroup Id="AppFiles">
${compRefXml.join('\n')}
    </ComponentGroup>
  </Fragment>
</Wix>
`;
  return wxs;
}

function main() {
  // 从 package.json 读取版本号，归一管理
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  const VERSION = pkg.version;
  if (!VERSION) {
    console.error('package.json 中未找到 version 字段');
    process.exit(1);
  }
  console.log('Version:', VERSION);

  if (!fs.existsSync(WIN_UNPACKED_DIR)) {
    console.error('win-unpacked directory not found. Run "npx electron-builder --dir" first.');
    process.exit(1);
  }

  if (!fs.existsSync(WIX_BUILD_DIR)) {
    fs.mkdirSync(WIX_BUILD_DIR, { recursive: true });
  }

  console.log('\n=== Step 1: Harvesting files ===');
  const harvest = harvestFiles(WIN_UNPACKED_DIR);

  console.log('\n=== Step 2: Generating files.wxs ===');
  const filesWxs = generateFilesWxs(harvest);
  const filesWxsPath = path.join(WIX_BUILD_DIR, 'files.wxs');
  fs.writeFileSync(filesWxsPath, filesWxs, 'utf-8');
  console.log('Written:', filesWxsPath);

  console.log('\n=== Step 3: Compiling with candle.exe ===');
  const candleExe = path.join(WIX_BIN_DIR, 'candle.exe');
  const lightExe = path.join(WIX_BIN_DIR, 'light.exe');
  const uiExtDll = path.join(WIX_BIN_DIR, 'WixUIExtension.dll');
  const utilExtDll = path.join(WIX_BIN_DIR, 'WixUtilExtension.dll');

  const productWxsPath = path.join(WIX_DIR, 'product.wxs');
  const productWxsCopy = path.join(WIX_BUILD_DIR, 'product.wxs');
  fs.copyFileSync(productWxsPath, productWxsCopy);

  const candleCmd = [
    `"${candleExe}"`,
    '-arch x64',
    `-dSourceDir="${WIN_UNPACKED_DIR}"`,
    `-dVersion="${VERSION}"`,
    `-ext "${uiExtDll}"`,
    `-ext "${utilExtDll}"`,
    `"${productWxsCopy}"`,
    `"${filesWxsPath}"`,
  ].join(' ');

  console.log('Running:', candleCmd);
  try {
    execSync(candleCmd, { stdio: 'inherit', shell: true, cwd: WIX_BUILD_DIR });
  } catch (err) {
    console.error('candle.exe failed');
    process.exit(1);
  }

  console.log('\n=== Step 4: Linking with light.exe ===');
  const wixobjFiles = fs.readdirSync(WIX_BUILD_DIR)
    .filter(f => f.endsWith('.wixobj'))
    .map(f => `"${path.join(WIX_BUILD_DIR, f)}"`);

  const msiOutput = path.join(DIST_DIR, `AI_Assistant_Omni-${VERSION}-x64.msi`);

  const lightCmd = [
    `"${lightExe}"`,
    `-out "${msiOutput}"`,
    '-spdb',
    '-sice:ICE03',
    '-sice:ICE30',
    '-sice:ICE38',
    '-sice:ICE64',
    `-ext "${uiExtDll}"`,
    `-ext "${utilExtDll}"`,
    ...wixobjFiles,
  ].join(' ');

  console.log('Running:', lightCmd);
  try {
    execSync(lightCmd, { stdio: 'inherit', shell: true, cwd: WIX_BUILD_DIR });
  } catch (err) {
    console.error('light.exe failed');
    process.exit(1);
  }

  console.log('\n========================================');
  console.log('  MSI built successfully!');
  console.log(`  Output: ${msiOutput}`);
  console.log(`  Files: ${harvest.fileCount}, Components: ${harvest.compCount}`);
  console.log('========================================\n');
}

main();
