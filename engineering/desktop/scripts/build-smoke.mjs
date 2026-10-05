import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import electron from 'electron';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-03/S3-01/build-preview', runId);
const data = resolve('../../artifacts/build-smoke', runId, '中文 空格数据');
mkdirSync(data, { recursive: true });
mkdirSync(output, { recursive: true });
const bundled = await build({
  entryPoints: ['tests/build-electron-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/build-electron-smoke.cjs',
  external: ['electron'],
  metafile: true,
  // Reject runtime package loading, including esbuild's unused package-manager fallback.
  banner: {
    js: `const smokeModules = require('node:module');
const smokeOriginalLoad = smokeModules._load;
smokeModules._load = function(id, ...args) {
  if (id !== 'electron' && !smokeModules.isBuiltin(id)) throw new Error('External package load denied in smoke');
  return smokeOriginalLoad.call(this, id, ...args);
};
process.env.FACTORY_SMOKE_EXTERNAL_PACKAGES_BLOCKED = '1';`,
  },
});
const externalImports = [
  ...new Set(
    Object.values(bundled.metafile.outputs).flatMap((file) =>
      file.imports.filter((item) => item.external).map((item) => item.path),
    ),
  ),
];
writeFileSync(
  resolve(output, 'smoke-bundle-imports.json'),
  JSON.stringify(
    { externalImports, runtimePackageLoading: 'denied except Electron and Node builtins' },
    null,
    2,
  ),
);
for (const phase of ['create', 'reopen']) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, ['dist/tests/build-electron-smoke.cjs'], {
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
    }, 90_000);
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
        reject(new Error(`Build ${phase} timed out; inspect ${output}`));
      } else if (code === 0) resolveRun();
      else {
        terminate('SIGKILL');
        reject(new Error(`Build ${phase} exited ${code}; inspect ${output}`));
      }
    });
  });
}
console.log(`Evidence: ${output}`);
