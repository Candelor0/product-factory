import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence/2026-10-03/S3-03/process-recovery', stamp);
const base = resolve('../../artifacts/recovery-process', stamp);
mkdirSync(output, { recursive: true });
mkdirSync(base, { recursive: true });
const entry = join(base, 'recovery-process-smoke.cjs');
await build({
  entryPoints: ['tests/recovery-process-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: entry,
});
const results = [];
let passed = 0;
for (const boundary of [
  'model-partial',
  'source-before',
  'source-after',
  'build-before-artifact',
  'build-after-artifact',
  'stage-saved',
  'restore-source-before',
  'restore-source-after',
]) {
  const data = join(base, boundary, '中文 空格数据');
  mkdirSync(data, { recursive: true });
  for (const phase of ['seed', 'crash', 'recover']) {
    const child = spawnSync(process.execPath, [entry], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        FACTORY_RECOVERY_TOOLCHAIN: resolve('dist/toolchain'),
        FACTORY_RECOVERY_DATA: realpathSync(data),
        FACTORY_RECOVERY_OUTPUT: output,
        FACTORY_RECOVERY_PHASE: phase,
        FACTORY_RECOVERY_BOUNDARY: boundary,
      },
    });
    results.push({
      boundary,
      phase,
      exitCode: child.status,
      signal: child.signal,
      stdout: child.stdout,
      stderr: child.stderr,
    });
    writeFileSync(join(output, 'process-results.json'), JSON.stringify(results, null, 2));
    if (child.error || (phase === 'crash' ? child.signal !== 'SIGKILL' : child.status !== 0))
      throw new Error(`Recovery ${boundary}/${phase} failed. Evidence: ${output}`);
    if (phase !== 'crash')
      passed += JSON.parse(readFileSync(join(output, `${boundary}-${phase}.json`), 'utf8')).passed;
    if (child.stdout) process.stdout.write(child.stdout);
  }
}
writeFileSync(
  join(output, 'result.json'),
  JSON.stringify(
    {
      passed,
      killedBoundaries: 8,
      realProviderRequests: 0,
      limitation:
        'Owned Node processes killed at injected boundaries, not power loss or Windows validation',
      results: results.map(({ stdout, stderr, ...rest }) => rest),
    },
    null,
    2,
  ),
);
console.log(`Evidence: ${output}`);
