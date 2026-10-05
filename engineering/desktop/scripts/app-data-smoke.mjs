import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import electron from 'electron';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-04/S4-01/persistent-app', runId);
const data = resolve('../../artifacts/app-data-smoke', runId, '中文 空格数据');
mkdirSync(data, { recursive: true });
mkdirSync(output, { recursive: true });
await build({
  entryPoints: ['tests/app-data-electron-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/app-data-electron-smoke.cjs',
  external: ['electron'],
  banner: {
    js: `const smokeModules = require('node:module');
const smokeOriginalLoad = smokeModules._load;
smokeModules._load = function(id, ...args) {
  if (id !== 'electron' && !smokeModules.isBuiltin(id)) throw new Error('External package load denied in app data smoke');
  return smokeOriginalLoad.call(this, id, ...args);
};`,
  },
});
for (const phase of ['create', 'reopen']) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, ['dist/tests/app-data-electron-smoke.cjs'], {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
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
    }, 150_000);
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
        reject(new Error(`App data ${phase} timed out; inspect ${output}`));
      } else if (code === 0) resolveRun();
      else {
        terminate('SIGKILL');
        reject(new Error(`App data ${phase} exited ${code}; inspect ${output}`));
      }
    });
  });
}
console.log(`Evidence: ${output}`);
