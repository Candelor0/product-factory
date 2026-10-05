import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
await import('./build-main.mjs');
const server = await createServer();
await server.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, FACTORY_DEV_URL: 'http://127.0.0.1:5173' },
});
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  child.kill();
  await server.close();
};
child.on('exit', async (code) => {
  await stop();
  process.exit(code ?? 0);
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
