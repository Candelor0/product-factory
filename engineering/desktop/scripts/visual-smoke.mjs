import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import electron from 'electron';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-02/S2-03', runId);
const data = resolve('../../artifacts/visual-smoke', runId, '中文 空格数据');
mkdirSync(data, { recursive: true });
mkdirSync(output, { recursive: true });
await build({
  entryPoints: ['tests/visual-electron-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/visual-electron-smoke.cjs',
  external: ['electron'],
});
for (const phase of ['visual']) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, ['dist/tests/visual-electron-smoke.cjs'], {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        // Electron embeds Node; no developer Node/npm is available in the launched test.
        PATH: '/usr/bin:/bin',
        FACTORY_DEV_URL: '',
        FACTORY_TEST_DATA: realpathSync(data),
        FACTORY_TEST_OUTPUT: output,
        FACTORY_TEST_PHASE: phase,
      },
    });
    let timedOut = false;
    let forceKill;
    const terminate = (signal) => {
      if (!child.pid) return;
      try {
        // On this Mac test host, reap the owned Electron process group, including renderers.
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') reject(error);
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      forceKill = setTimeout(() => terminate('SIGKILL'), 2_000);
    }, 45_000);
    const clear = () => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
    };
    child.once('error', (error) => {
      clear();
      terminate('SIGKILL');
      reject(error);
    });
    child.once('close', (code) => {
      clear();
      if (timedOut) {
        terminate('SIGKILL');
        reject(new Error(`Visual ${phase} timed out; inspect ${output}`));
      } else if (code === 0) resolveRun();
      else {
        terminate('SIGKILL');
        reject(new Error(`Visual ${phase} exited ${code}; inspect ${output}`));
      }
    });
  });
}
console.log(`Evidence: ${output}`);
