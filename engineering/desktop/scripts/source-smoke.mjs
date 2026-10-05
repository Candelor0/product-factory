import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('../../docs/evidence', runId.slice(0, 10), 'S0-03', runId);
const data = resolve('../../artifacts/source-smoke', runId, '中文 空格数据');
const entry = resolve('../../artifacts/source-smoke', runId, 'source-process-smoke.cjs');
mkdirSync(output, { recursive: true });
mkdirSync(data, { recursive: true });
await build({
  entryPoints: ['tests/source-process-smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: entry,
});
const phases = [
  ['seed', 0],
  ['crash-before', 71],
  ['recover-before', 0],
  ['crash-after', 72],
  ['recover-after', 0],
];
const results = [];
for (const [phase, expectedExit] of phases) {
  const child = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      FACTORY_SOURCE_DATA: realpathSync(data),
      FACTORY_SOURCE_OUTPUT: output,
      FACTORY_SOURCE_PHASE: phase,
    },
  });
  const result = {
    phase,
    expectedExit,
    exitCode: child.status,
    signal: child.signal,
    stdout: child.stdout,
    stderr: child.stderr,
  };
  results.push(result);
  writeFileSync(join(output, 'process-results.json'), JSON.stringify(results, null, 2) + '\n');
  if (child.error || child.status !== expectedExit)
    throw new Error(`Source smoke failed at ${phase}; inspect ${output}`);
  if (child.stdout) process.stdout.write(child.stdout);
}
const reports = ['seed', 'recover-before', 'recover-after'].map((phase) =>
  JSON.parse(readFileSync(join(output, `${phase}.json`), 'utf8')),
);
writeFileSync(
  join(output, 'result.json'),
  JSON.stringify(
    {
      passed: reports.reduce((sum, report) => sum + report.passed, 0),
      processBoundaries: 2,
      phases: results.map(({ phase, exitCode }) => ({ phase, exitCode })),
      modelCalls: 0,
      limitations: [
        'Synthetic requests; no online model or IPC integration',
        'Owned processes exit at injected commit boundaries; not power-loss validation',
        'Single trusted synchronous writer; not an OS sandbox',
        'No source materialization, build or generated application acceptance',
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(`Evidence: ${output}`);
