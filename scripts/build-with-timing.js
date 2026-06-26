/**
 * 构建脚本 - 显示每一阶段的耗时
 */
const { execSync } = require('child_process');

const stages = [
  { name: 'build:react',    command: 'npm run build:react' },
  { name: 'pip:install',    command: 'npm run pip:install' },
  { name: 'python:runtime', command: 'npm run python:runtime' },
  { name: 'electron-builder', command: 'npx electron-builder' },
  { name: 'wix-msi',          command: 'npm run build:msi' },
];

const totalStart = Date.now();

for (const stage of stages) {
  const start = Date.now();
  console.log(`\n[${new Date().toLocaleTimeString()}] >>> ${stage.name} 开始...`);
  try {
    execSync(stage.command, { stdio: 'inherit', shell: true });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[${new Date().toLocaleTimeString()}] <<< ${stage.name} 完成, 耗时: ${elapsed}s`);
  } catch (err) {
    console.error(`\n!!! ${stage.name} 失败, 退出码: ${err.status}`);
    process.exit(1);
  }
}

const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
console.log(`\n========================================`);
console.log(`  全部构建完成，总耗时: ${totalElapsed}s`);
console.log(`========================================\n`);
