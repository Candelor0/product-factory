import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import electron from 'electron';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-04/S4-03/source-export', runId);
const data = resolve('../../artifacts/exports-smoke', runId, '工作台 数据');
const exports = resolve('../../artifacts/exports-smoke', runId, '导出 文件');
for (const path of [data, exports, output]) mkdirSync(path, { recursive: true });
await build({
  entryPoints: ['tests/export-electron-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/export-electron-smoke.cjs',
  external: ['electron'],
  banner: {
    js: `const smokeModules = require('node:module');
const smokeOriginalLoad = smokeModules._load;
smokeModules._load = function(id, ...args) {
  if (id !== 'electron' && !smokeModules.isBuiltin(id)) throw new Error('External package load denied in export smoke');
  return smokeOriginalLoad.call(this, id, ...args);
};`,
  },
});
for (const phase of ['create', 'reopen']) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, ['dist/tests/export-electron-smoke.cjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        FACTORY_DEV_URL: '',
        FACTORY_TEST_DATA: realpathSync(data),
        FACTORY_TEST_OUTPUT: output,
        FACTORY_TEST_EXPORTS: realpathSync(exports),
        FACTORY_TEST_NODE: process.execPath,
        FACTORY_TEST_PHASE: phase,
      },
    });
    let childOutput = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        process.stdout.write(chunk);
        if (childOutput.length < 2 * 1024 * 1024) childOutput += chunk.toString();
      });
    }
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
    }, 120_000);
    const clear = () => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
    };
    child.once('error', (error) => {
      clear();
      terminate('SIGKILL');
      reject(error);
    });
    child.once('close', (code, signal) => {
      clear();
      writeFileSync(
        join(output, `runner-${phase}.json`),
        JSON.stringify({ code, signal, timedOut }, null, 2),
      );
      writeFileSync(join(output, `runner-${phase}.log`), childOutput);
      if (timedOut) {
        terminate('SIGKILL');
        reject(new Error(`Export ${phase} timed out; inspect ${output}`));
      } else if (code === 0) resolveRun();
      else {
        terminate('SIGKILL');
        reject(new Error(`Export ${phase} exited ${code}; inspect ${output}`));
      }
    });
  });
}
console.log(`Evidence: ${output}`);
