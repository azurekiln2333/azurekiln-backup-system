import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

async function freePort(start) {
  for (let port = start; port < start + 30; port++) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No free development port available');
}

const apiPort = await freePort(Number(process.env.BACKUP_PORT || 16323));
const webPort = await freePort(Number(process.env.VITE_PORT || 5173));
const env = {
  ...process.env,
  BACKUP_PORT: String(apiPort),
  BACKUP_API_PORT: String(apiPort),
  BACKUP_PUBLIC_URL: `http://127.0.0.1:${webPort}`,
};
const toolsRoot = path.resolve('.artifacts/tools');
if (existsSync(toolsRoot)) {
  const rcloneDir = readdirSync(toolsRoot).find((name) => name.startsWith('rclone-') && !name.endsWith('.zip'));
  const rclone = rcloneDir && path.join(toolsRoot, rcloneDir, 'rclone.exe');
  const sevenZip = path.join(toolsRoot, '7zip', 'x64', '7za.exe');
  if (!env.RCLONE_BINARY && rclone && existsSync(rclone)) env.RCLONE_BINARY = rclone;
  if (!env.SEVEN_ZIP_BINARY && existsSync(sevenZip)) env.SEVEN_ZIP_BINARY = sevenZip;
}

mkdirSync('.artifacts', { recursive: true });
writeFileSync('.artifacts/dev.json', JSON.stringify({ apiPort, webPort, url: `http://127.0.0.1:${webPort}` }));
const children = [
  spawn(process.execPath, ['--watch', 'server/app.mjs'], { env, stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts', '--host', '127.0.0.1', '--port', String(webPort)], { env, stdio: 'inherit', windowsHide: true }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code || 0); });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
console.log(`AzureKiln Backup: http://127.0.0.1:${webPort}`);
