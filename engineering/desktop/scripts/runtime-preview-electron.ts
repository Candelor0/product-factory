import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { GeneratedPreview } from '../src/main/generated-preview';
import { compileSource } from '../src/main/source-compiler';
import { buildArtifactHash } from '../src/main/build-store';
import { snapshotHash } from '../src/main/build-service';
import { sourceHash } from '../src/main/source-protocol';
import { loadToolchain } from '../src/main/toolchain';
import type { BuildArtifact } from '../src/shared/build-contracts';
import { runtimeIssueMessages, type RuntimeIssueCode } from '../src/shared/runtime-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
app.setPath('userData', process.env.FACTORY_TEST_DATA!);
app.on('window-all-closed', () => {});
const previews = new GeneratedPreview(false);
const checks: string[] = [];
const safeResults: {
  scenario: string;
  status: string;
  issues: RuntimeIssueCode[];
  observedMs: number;
}[] = [];
const windows: BrowserWindow[] = [];
const ports: number[] = [];
let current = 'initialization';
let unexpectedRejections = 0;
let rawSentinelObserved = false;
const sentinel = 'SYNTHETIC_RUNTIME_SECRET_DO_NOT_PERSIST';
process.on('unhandledRejection', () => {
  unexpectedRejections++;
});
app.on('browser-window-created', (_event, window) => {
  windows.push(window);
  void window.webContents.session
    .resolveProxy('http://127.0.0.1/')
    .then((route) => {
      const port = /^SOCKS5 127\.0\.0\.1:(\d+)$/u.exec(route)?.[1];
      if (port) ports.push(Number(port));
    })
    .catch(() => {});
  window.webContents.on('console-message', (details) => {
    // Only a boolean is retained; arbitrary console text must never reach evidence.
    if (details.message.includes(sentinel)) rawSentinelObserved = true;
  });
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function check(label: string, condition: unknown): asserts condition {
  current = label;
  assert.ok(condition, label);
  checks.push(label);
}
async function waitFor(label: string, condition: () => boolean) {
  current = label;
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error();
    await delay(20);
  }
}
async function closedPort(port: number) {
  return new Promise<boolean>((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(true));
    socket.setTimeout(500, () => {
      socket.destroy();
      done(false);
    });
  });
}
const projectId = randomUUID();
const planRunId = randomUUID();
async function artifact(source: string): Promise<BuildArtifact> {
  const snapshot = {
    revision: 1,
    files: [{ path: 'src/app.tsx', content: source, sha256: sourceHash(source) }],
  };
  const compiled = await compileSource(snapshot);
  return {
    ...compiled,
    schemaVersion: 1,
    id: randomUUID(),
    projectId,
    createdAt: new Date().toISOString(),
    sourceRevision: 1,
    sourceHash: snapshotHash(snapshot),
    planRunId,
    planInputHash: sourceHash('synthetic-plan'),
    planArtifactHash: sourceHash('synthetic-plan-artifact'),
    templateVersion: 'react-preview-v1',
    compilerVersion: 'esbuild-0.28.2',
    artifactHash: buildArtifactHash(compiled),
  };
}

async function main() {
  await app.whenReady();
  const { runtime } = loadToolchain(resolve('dist/toolchain'));
  const good = await artifact(
    'export default function App(){return <main><button id="good">正常页面</button></main>;}',
  );
  const first = await previews.open(good, runtime);
  check(
    'real compiled baseline receives a timed observation',
    first.status === 'observed' && first.observedMs >= 1200,
  );
  let baseline = previews.previewWindow(projectId)!;
  check(
    'baseline actually renders through the trusted React entry',
    await baseline.webContents.executeJavaScript(
      "document.getElementById('good').textContent==='正常页面'",
    ),
  );
  const prefs = baseline.webContents.getLastWebPreferences();
  check(
    'sandbox, context isolation and no Node or preload remain intact',
    prefs.sandbox &&
      prefs.contextIsolation &&
      !prefs.nodeIntegration &&
      !prefs.preload &&
      !prefs.nodeIntegrationInWorker &&
      !prefs.nodeIntegrationInSubFrames,
  );
  check(
    'preview still lacks workbench and Node capabilities',
    await baseline.webContents.executeJavaScript(
      "typeof window.factory==='undefined' && typeof process==='undefined' && typeof require==='undefined'",
    ),
  );
  check(
    'preview proxy retains its no-DIRECT route',
    /^SOCKS5 127\.0\.0\.1:\d+$/u.test(
      await baseline.webContents.session.resolveProxy('http://127.0.0.1/'),
    ),
  );
  const repeated = await previews.open(good, runtime);
  check(
    'same-build open performs a fresh timed observation',
    repeated.status === 'observed' &&
      repeated.observedMs >= 1200 &&
      previews.previewWindow(projectId) !== baseline &&
      baseline.isDestroyed(),
  );
  baseline = previews.previewWindow(projectId)!;
  const clean = await previews.check(good, runtime);
  check(
    'hidden clean check never replaces the user preview',
    clean.status === 'observed' &&
      previews.previewWindow(projectId) === baseline &&
      BrowserWindow.getAllWindows().length === 1,
  );

  const cases: [string, string, RuntimeIssueCode[]][] = [
    [
      'reference',
      'const n=nonexistentRuntimeValue; export default function App(){return <p>{n}</p>;}',
      ['REFERENCE_ERROR'],
    ],
    [
      'rejection',
      `Promise.reject(new Error('${sentinel}')); export default function App(){return <p>异步失败</p>;}`,
      ['UNHANDLED_REJECTION'],
    ],
    [
      'react-render',
      `export default function App(){throw new Error('${sentinel}');}`,
      ['REACT_RENDER_ERROR'],
    ],
    [
      'react-reference',
      'export default function App(){return <p>{missingRenderValue}</p>;}',
      ['REFERENCE_ERROR'],
    ],
    [
      'react-initial-reference',
      "import {useState} from 'react'; export default function App(){const [n]=useState(missingInitialValue);return <p>{n}</p>;}",
      ['REFERENCE_ERROR'],
    ],
    [
      'console',
      `console.error('${sentinel}'); export default function App(){return <p>控制台错误</p>;}`,
      ['CONSOLE_ERROR'],
    ],
    [
      'spoof-ready',
      `console.log('__PF_RUNTIME_READY__'); throw new Error('${sentinel}'); export default function App(){return <p>伪造完成</p>;}`,
      ['SCRIPT_ERROR'],
    ],
    [
      'resource',
      'export default function App(){return <img src="data:image/png;base64,invalid"/>;}',
      ['RESOURCE_LOAD_FAILED'],
    ],
    [
      'delayed-loop',
      'setTimeout(()=>{while(true){}},100); export default function App(){return <p>稍后卡住</p>;}',
      ['UNRESPONSIVE'],
    ],
    [
      'top-level-loop',
      'while(true){} export default function App(){return <p>不会显示</p>;}',
      ['STARTUP_TIMEOUT', 'UNRESPONSIVE'],
    ],
  ];
  for (const [name, source, expected] of cases) {
    current = name;
    const candidate = await artifact(source);
    const report = await previews.open(candidate, runtime);
    safeResults.push({ scenario: name, ...report });
    check(
      `${name}: real renderer issue is detected`,
      report.status === 'issues' && expected.some((code) => report.issues.includes(code)),
    );
    check(
      `${name}: failed candidate preserves the exact previous window`,
      previews.previewWindow(projectId) === baseline &&
        !baseline.isDestroyed() &&
        BrowserWindow.getAllWindows().length === 1,
    );
    check(
      `${name}: diagnostics are enum-only and bounded`,
      report.issues.every((code) => Object.hasOwn(runtimeIssueMessages, code)) &&
        report.issues.length <= 12 &&
        report.observedMs <= 12000,
    );
  }

  current = 'renderer-crash';
  const beforeCrash = windows.length;
  const crashing = previews.check(good, runtime);
  await waitFor('crash candidate exists', () => windows.length > beforeCrash);
  windows.at(-1)!.webContents.forcefullyCrashRenderer();
  const crashed = await crashing;
  safeResults.push({ scenario: 'renderer-crash', ...crashed });
  check(
    'native renderer crash produces a fixed issue',
    crashed.status === 'issues' && crashed.issues.includes('RENDERER_GONE'),
  );
  check(
    'crash leaves old visible preview alive',
    previews.previewWindow(projectId) === baseline && !baseline.isDestroyed(),
  );

  const controller = new AbortController();
  const beforeCancel = windows.length;
  const cancelling = previews.check(good, runtime, controller.signal);
  await waitFor('cancel candidate exists', () => windows.length > beforeCancel);
  controller.abort();
  const cancelled = await cancelling;
  check(
    'aborting hidden observation cancels without replacing old preview',
    cancelled.status === 'cancelled' &&
      previews.previewWindow(projectId) === baseline &&
      BrowserWindow.getAllWindows().length === 1,
  );

  const lateCodes: RuntimeIssueCode[] = [];
  const interactive = await artifact(
    `export default function App(){return <button id="throw" onClick={()=>{throw new Error('${sentinel}');}}>触发错误</button>;}`,
  );
  const opened = await previews.open(interactive, runtime, async (code) => {
    lateCodes.push(code);
    throw new Error('observer callback failure');
  });
  check(
    'interactive candidate finishes startup before its test click',
    opened.status === 'observed',
  );
  await previews
    .previewWindow(projectId)!
    .webContents.executeJavaScript("document.getElementById('throw').click();true");
  await waitFor('post-open runtime error reaches main callback', () => lateCodes.length > 0);
  check(
    'post-open callback contains only fixed issue codes',
    lateCodes.every((code) => Object.hasOwn(runtimeIssueMessages, code)),
  );
  await delay(50);
  check(
    'rejected observer callback does not produce unhandled main rejection',
    unexpectedRejections === 0,
  );
  check(
    'synthetic raw secret exercised the collector without entering safe result JSON',
    rawSentinelObserved && !JSON.stringify(safeResults).includes(sentinel),
  );

  const afterOpenCrash: RuntimeIssueCode[] = [];
  await previews.open(good, runtime, (code) => afterOpenCrash.push(code));
  previews.previewWindow(projectId)!.webContents.forcefullyCrashRenderer();
  await waitFor('post-open native crash reaches main callback', () => afterOpenCrash.length > 0);
  check(
    'post-open native crash uses fixed renderer-gone classification',
    afterOpenCrash.includes('RENDERER_GONE'),
  );
  check(
    'post-open native crash cleans the active preview',
    previews.status(projectId).preview === 'closed',
  );
  await previews.open(good, runtime);

  const beforeStop = windows.length;
  const stopping = previews.check(good, runtime);
  await waitFor('stopAll candidate exists', () => windows.length > beforeStop);
  await previews.stopAll();
  check(
    'stopAll cancels pending checks and destroys all owned windows',
    (await stopping).status === 'cancelled' && BrowserWindow.getAllWindows().length === 0,
  );
  check(
    'all observation and preview proxy listeners close',
    (await Promise.all(ports.map(closedPort))).every(Boolean),
  );
  writeFileSync(
    join(output, 'result.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        scenarios: safeResults,
        realProviderRequests: 0,
        limitations: [
          'Finite startup observation, not business acceptance',
          'Mac Electron only; no Windows or all-network-interface claim',
        ],
      },
      null,
      2,
    ),
  );
  app.exit(0);
}
void main().catch(async () => {
  writeFileSync(
    join(output, 'failure.json'),
    JSON.stringify(
      {
        failedAt: current,
        passed: checks.length,
        checks,
        scenarios: safeResults,
        realProviderRequests: 0,
      },
      null,
      2,
    ),
  );
  await previews.stopAll().catch(() => {});
  app.exit(1);
});
