import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import electron from 'electron';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-04/S3-02/runtime-preview', runId);
const data = resolve('../../artifacts/runtime-preview-smoke', runId, '中文 空格数据');
mkdirSync(output, { recursive: true });
mkdirSync(data, { recursive: true });
await build({
  entryPoints: ['scripts/runtime-preview-electron.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/runtime-preview-electron.cjs',
  external: ['electron'],
});
const env = {
  ...process.env,
  FACTORY_TEST_DATA: realpathSync(data),
  FACTORY_TEST_OUTPUT: output,
};
delete env.ELECTRON_ENABLE_LOGGING;
await new Promise((done, reject) => {
  // Renderer console output is deliberately not copied to evidence or terminal logs.
  const child = spawn(electron, ['dist/tests/runtime-preview-electron.cjs'], {
    env,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  let timedOut = false;
  const kill = () => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 90_000);
  child.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (!timedOut && code === 0) done();
    else {
      kill();
      reject(
        new Error(`Runtime preview smoke ${timedOut ? 'timed out' : 'failed'}; inspect ${output}`),
      );
    }
  });
});
const result = JSON.parse(readFileSync(resolve(output, 'result.json'), 'utf8'));
console.log(`Runtime preview: ${result.passed} checks passed; real provider requests: 0`);
console.log(`Evidence: ${output}`);
