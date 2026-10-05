import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import electron from 'electron';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-02/S0-02', runId);
const data = resolve('../../artifacts/runtime-smoke', runId, '中文 空格数据');
mkdirSync(data, { recursive: true });
mkdirSync(output, { recursive: true });
await build({
  entryPoints: ['tests/runtime-electron-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/tests/runtime-electron-smoke.cjs',
  external: ['electron'],
});
for (const phase of ['create', 'reopen']) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, ['dist/tests/runtime-electron-smoke.cjs'], {
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
      reject(new Error(`Runtime ${phase} timed out`));
    }, 45_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolveRun()
        : reject(new Error(`Runtime ${phase} exited ${code}; evidence ${output}`));
    });
  });
  const evidence = JSON.parse(readFileSync(`${output}/runtime-${phase}.json`, 'utf8'));
  for (const origin of evidence.closingOrigins) {
    const closed = await fetch(origin).then(
      () => false,
      () => true,
    );
    if (!closed) throw new Error('A runtime port remained reachable after workbench process exit');
  }
  writeFileSync(
    `${output}/shutdown-${phase}.json`,
    JSON.stringify(
      { observedFromParentProcess: true, listenersClosed: evidence.closingOrigins.length },
      null,
      2,
    ),
  );
}
console.log(`Evidence: ${output}`);
