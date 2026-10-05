import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import electron from 'electron';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-04/S4-03/app-ai-preview', runId);
const data = resolve('../../artifacts/app-ai-preview-smoke', runId, '中文 空格数据');
mkdirSync(output, { recursive: true });
mkdirSync(data, { recursive: true });
await build({
  entryPoints: ['scripts/app-ai-preview-electron.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/app-ai-preview-electron.cjs',
  external: ['electron'],
});
const env = {
  ...process.env,
  FACTORY_TEST_DATA: realpathSync(data),
  FACTORY_TEST_OUTPUT: output,
};
delete env.ELECTRON_ENABLE_LOGGING;
await new Promise((done, reject) => {
  const child = spawn(electron, ['dist/tests/app-ai-preview-electron.cjs'], {
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
  }, 120_000);
  child.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (!timedOut && code === 0) done();
    else {
      kill();
      reject(new Error(`App AI preview ${timedOut ? 'timed out' : 'failed'}; inspect ${output}`));
    }
  });
});
const result = JSON.parse(readFileSync(resolve(output, 'result.json'), 'utf8'));
console.log(`App AI preview: ${result.passed} checks passed; real provider requests: 0`);
console.log(`Evidence: ${output}`);
