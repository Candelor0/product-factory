import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import electron from 'electron';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-04/S4-03/app-ai-budget', runId);
const data = resolve('../../artifacts/app-ai-smoke', runId, '工作台 数据');
const legacyData = resolve('../../artifacts/app-ai-smoke', runId, '历史 数据');
for (const path of [data, legacyData, output]) mkdirSync(path, { recursive: true });
await build({
  entryPoints: ['tests/app-ai-electron-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/app-ai-electron-smoke.cjs',
  external: ['electron'],
  banner: {
    js: `const smokeModules = require('node:module');
const smokeOriginalLoad = smokeModules._load;
smokeModules._load = function(id, ...args) {
  if (id !== 'electron' && !smokeModules.isBuiltin(id)) throw new Error('External package load denied in app AI smoke');
  return smokeOriginalLoad.call(this, id, ...args);
};`,
  },
});
mkdirSync(join(legacyData, 'credentials'), { recursive: true });
writeFileSync(
  join(legacyData, 'credentials/provider.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      encryptedKey: null,
      maxCalls: 30,
      lastCheckedAt: null,
      usage: { calls: 3, inputTokens: 20, outputTokens: 15, unknownUsageCalls: 2 },
    },
    null,
    2,
  ),
);
for (const phase of ['create', 'reopen', 'legacy']) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, ['dist/tests/app-ai-electron-smoke.cjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        FACTORY_DEV_URL: '',
        FACTORY_TEST_DATA: realpathSync(phase === 'legacy' ? legacyData : data),
        FACTORY_TEST_OUTPUT: output,
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
    }, 180_000);
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
        reject(new Error(`App AI ${phase} timed out; inspect ${output}`));
      } else if (code === 0) resolveRun();
      else {
        terminate('SIGKILL');
        reject(new Error(`App AI ${phase} exited ${code}; inspect ${output}`));
      }
    });
  });
}
console.log(`Evidence: ${output}`);
