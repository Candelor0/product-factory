import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import electron from 'electron';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-02/S1-01', runId);
const data = resolve('../../artifacts/smoke', runId, '中文 空格数据');
mkdirSync(data, { recursive: true });
mkdirSync(output, { recursive: true });
await build({
  entryPoints: ['tests/electron-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/electron-smoke.cjs',
  external: ['electron'],
});
for (const phase of ['create', 'reopen']) {
  await new Promise((resolveRun, reject) => {
    // Electron embeds Node. The launched application cannot rely on developer Node/npm in PATH.
    const child = spawn(electron, ['dist/tests/electron-smoke.cjs'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        FACTORY_TEST_DATA: realpathSync(data),
        FACTORY_TEST_OUTPUT: output,
        FACTORY_TEST_PHASE: phase,
      },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Desktop smoke timed out'));
    }, 45000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolveRun()
        : reject(new Error(`Desktop ${phase} exited ${code}; inspect ${output}`));
    });
  });
}
console.log(`Evidence: ${output}`);
