import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [
  spawn(process.execPath, ['--watch', '--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (!child.killed) child.kill();
  process.exitCode = code;
}

for (const child of children) {
  child.on('error', error => {
    console.error(error.message);
    shutdown(1);
  });
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
