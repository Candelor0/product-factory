// Explicit, sequential live-test phases. Never run from npm test or another smoke suite.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(desktop, '../..');
const [phase, suppliedRunId, ...extra] = process.argv.slice(2);
const phases = ['prepare', 'generate', 'reopen'];
const runPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
const usage =
  'FACTORY_LIVE_CORE=1 node scripts/core-live-smoke.mjs prepare | generate <runId> | reopen <runId>';
if (
  process.env.FACTORY_LIVE_CORE !== '1' ||
  !phases.includes(phase) ||
  extra.length ||
  (phase === 'prepare' ? suppliedRunId !== undefined : !runPattern.test(suppliedRunId ?? ''))
) {
  console.error(`CORE_LIVE_OPT_IN_REQUIRED: ${usage}`);
  process.exit(2);
}

const runId =
  suppliedRunId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const output = join(project, 'docs/evidence/2026-10-05/S3-02/core-live', runId);
const artifacts = join(project, 'artifacts/core-live', runId);
let evidenceReady = false;
const exclusive = (path, value) => {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dirname(path), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
};

try {
  if (phase === 'prepare') {
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(dirname(artifacts), { recursive: true });
    mkdirSync(output, { mode: 0o700 });
    mkdirSync(artifacts, { mode: 0o700 });
    exclusive(join(output, 'manifest.json'), {
      schemaVersion: 1,
      runId,
      createdAt: new Date().toISOString(),
      callLimit: 4,
      projectName: '核心实测·文章清单',
      fixtureConfirmation: 'Synthetic fixture only; not the user’s formal blog approval.',
    });
  } else {
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.runId !== runId || manifest.callLimit !== 4)
      throw new Error('CORE_LIVE_MANIFEST');
    const prepared = JSON.parse(readFileSync(join(output, 'prepare-result.json'), 'utf8'));
    if (prepared.status !== 'prepared') throw new Error('CORE_LIVE_NOT_PREPARED');
  }
  evidenceReady = true;
  // The exclusive intent is deliberately retained after failure or process death.
  // A second generate command can never create another project or resume paid work.
  exclusive(join(output, `${phase}-intent.json`), {
    schemaVersion: 1,
    runId,
    phase,
    startedAt: new Date().toISOString(),
  });
  const bundle = join(artifacts, `core-live-${phase}.cjs`);
  await build({
    absWorkingDir: desktop,
    entryPoints: ['tests/core-live-smoke.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron'],
    logLevel: 'silent',
  });
  const bundleBytes = readFileSync(bundle);
  exclusive(join(output, `${phase}-bundle.json`), {
    bytes: bundleBytes.length,
    sha256: createHash('sha256').update(bundleBytes).digest('hex'),
  });
  const completion = await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [bundle], {
      cwd: desktop,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        FACTORY_DEV_URL: '',
        FACTORY_LIVE_CORE: '1',
        FACTORY_CORE_RUN_ID: runId,
        FACTORY_CORE_PHASE: phase,
      },
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // Do not persist raw Electron/provider/page output. Safe results are written by the child.
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
    });
    let timedOut = false;
    let forceKill;
    const terminate = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The process may already have exited. */
      }
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        terminate('SIGTERM');
        forceKill = setTimeout(() => terminate('SIGKILL'), 2_000);
      },
      phase === 'generate' ? 330_000 : 60_000,
    );
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
    };
    child.once('error', () => {
      clear();
      terminate('SIGKILL');
      reject(new Error('CORE_LIVE_PROCESS_START'));
    });
    child.once('close', (code, signal) => {
      clear();
      if (timedOut || code !== 0) terminate('SIGKILL');
      resolveRun({ code, signal, timedOut, stdoutBytes, stderrBytes });
    });
  });
  exclusive(join(output, `runner-${phase}.json`), completion);
  console.log(JSON.stringify({ runId, phase, ...completion, evidence: output, artifacts }));
  if (completion.code !== 0 || completion.timedOut) process.exitCode = 1;
} catch {
  // Never print arbitrary exception messages, paths from provider responses, or stack traces.
  try {
    if (evidenceReady)
      exclusive(join(output, `runner-${phase}-failure-${randomUUID()}.json`), {
        runId,
        phase,
        at: new Date().toISOString(),
        code: 'CORE_LIVE_PHASE_REJECTED',
      });
  } catch {
    /* Never retry paid work because recording failed. */
  }
  console.error(
    JSON.stringify({ runId, phase, code: 'CORE_LIVE_PHASE_REJECTED', evidence: output }),
  );
  process.exitCode = 1;
}
