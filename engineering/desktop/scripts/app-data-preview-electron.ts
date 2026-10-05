import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { GeneratedPreview } from '../src/main/generated-preview';
import { AppDataService } from '../src/main/app-data-service';
import { applyAppDataSnapshot } from '../src/main/app-data-protocol';
import { compileSource } from '../src/main/source-compiler';
import { buildArtifactHash } from '../src/main/build-store';
import { snapshotHash } from '../src/main/build-service';
import { sourceHash } from '../src/main/source-protocol';
import { loadToolchain } from '../src/main/toolchain';
import { AppError } from '../src/main/validation';
import type { BuildArtifact } from '../src/shared/build-contracts';
import type { AppDataSnapshot, AppDataSession } from '../src/shared/app-data-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const data = process.env.FACTORY_TEST_DATA!;
app.setPath('userData', data);
app.on('window-all-closed', () => {});
const checks: string[] = [];
let current = 'initialization';
const projectId = randomUUID();
const otherId = randomUUID();
const planRunId = randomUUID();
const planInputHash = sourceHash('synthetic-plan');
const planArtifactHash = sourceHash('synthetic-plan-artifact');
const sentinel = 'SYNTHETIC_BUSINESS_SECRET_NOT_FOR_MODEL';
const path = join(data, 'synthetic-business.json');
const initial: Record<string, AppDataSnapshot> = {
  [projectId]: { revision: 0, values: { private: sentinel } },
  [otherId]: { revision: 0, values: { other: true } },
};
writeFileSync(path, JSON.stringify(initial));
const originalBytes = readFileSync(path);
let persistentReads = 0;
let persistentWrites = 0;
let archived = false;
let visibleBeforePersistentRead = true;
let previews: GeneratedPreview;
const created: {
  artifact: BuildArtifact;
  mode: AppDataSession['mode'];
  revoked: boolean;
  window?: BrowserWindow;
}[] = [];
const windows: BrowserWindow[] = [];
app.on('browser-window-created', (_event, window) => {
  windows.push(window);
  const session = created.at(-1);
  if (session && !session.window) session.window = window;
});
const service = new AppDataService(
  {
    get(id) {
      persistentReads++;
      return JSON.parse(readFileSync(path, 'utf8'))[id];
    },
    apply(id, request) {
      persistentWrites++;
      const records = JSON.parse(readFileSync(path, 'utf8'));
      records[id] = applyAppDataSnapshot(records[id], request);
      writeFileSync(path, JSON.stringify(records));
      return {
        revision: records[id].revision,
        appliedRevision: records[id].revision,
        replayed: false,
      };
    },
  },
  {
    prepare(input) {
      if (archived) throw new AppError('ARCHIVED', 'synthetic');
      return {
        binding: { projectId: input.projectId, planRunId, planInputHash, planArtifactHash },
      } as ReturnType<import('../src/main/source-tools').SourceToolExecutor['prepare']>;
    },
  },
);
previews = new GeneratedPreview(true, (artifact, mode) => {
  const record: (typeof created)[number] = { artifact, mode, revoked: false };
  created.push(record);
  const session = service.create(artifact, mode);
  return {
    mode,
    execute: (input) => {
      if (mode === 'persistent')
        visibleBeforePersistentRead &&=
          !!record.window && !record.window.isDestroyed() && record.window.isVisible();
      return session.execute(input);
    },
    revoke() {
      record.revoked = true;
      session.revoke();
    },
  };
});
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function check(label: string, condition: unknown): asserts condition {
  current = label;
  assert.ok(condition, label);
  checks.push(label);
}
async function until(label: string, test: () => boolean) {
  current = label;
  const deadline = Date.now() + 5000;
  while (!test()) {
    if (Date.now() >= deadline) throw new Error();
    await delay(20);
  }
}
async function artifact(source: string, id = projectId): Promise<BuildArtifact> {
  const snapshot = {
    revision: 1,
    files: [{ path: 'src/app.tsx', content: source, sha256: sourceHash(source) }],
  };
  const compiled = await compileSource(snapshot);
  return {
    ...compiled,
    schemaVersion: 1,
    id: randomUUID(),
    projectId: id,
    createdAt: new Date().toISOString(),
    sourceRevision: 1,
    sourceHash: snapshotHash(snapshot),
    planRunId,
    planInputHash,
    planArtifactHash,
    templateVersion: 'react-preview-v1',
    compilerVersion: 'esbuild-0.28.2',
    artifactHash: buildArtifactHash(compiled),
  };
}
const source = `import {appData} from '@factory/data';
globalThis.dataReady=appData.read().then(value=>{globalThis.initialData=value;return true;}).catch(error=>{globalThis.dataError=error.code;return false;});
async function submit(event){event.preventDefault();globalThis.formEntered=true;try{const current=await appData.read();await appData.apply({requestId:crypto.randomUUID(),expectedRevision:current.revision,changes:[{operation:'put',key:'form_probe',value:'saved-by-submit'}]});globalThis.formSaved=true;}catch{globalThis.formSaved=false;}}
export default function App(){return <main><h1>数据边界验证</h1><form onSubmit={submit}><button id="form-submit" type="submit">保存</button></form></main>;}`;
const rpc = (window: BrowserWindow, input: unknown, options = '') =>
  window.webContents.executeJavaScript(
    `fetch(new URL('/app-data',location.href),{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(input))}${options}}).then(async response=>({status:response.status,body:await response.json()})).catch(()=>({status:0}))`,
  );
const read = { schemaVersion: 1, operation: 'read' };
const save = (revision: number, value: string) => ({
  schemaVersion: 1,
  operation: 'apply',
  requestId: randomUUID(),
  expectedRevision: revision,
  changes: [{ operation: 'put', key: 'note', value }],
});
let networkRequests = 0;
const network = createServer((_request, response) => {
  networkRequests++;
  response.end('control');
});
network.on('upgrade', (_request, socket) => {
  networkRequests++;
  socket.destroy();
});

async function main() {
  await app.whenReady();
  const { runtime } = loadToolchain(resolve('dist/toolchain'));
  const good = await artifact(source);
  const opened = await previews.open(good, runtime);
  check('temporary preview opens with the real compiled data SDK', opened.status === 'observed');
  const temporary = previews.previewWindow(projectId)!;
  check(
    'opaque-origin custom protocol fetch reaches the main-frame-gated SDK',
    await temporary.webContents.executeJavaScript('dataReady'),
  );
  check(
    'temporary preview cannot read the persistent sentinel',
    await temporary.webContents.executeJavaScript(
      'initialData.revision===0 && Object.keys(initialData.values).length===0',
    ),
  );
  await temporary.webContents.executeJavaScript("document.getElementById('form-submit').click()");
  await delay(150);
  check(
    'normal React submit button invokes preventDefault handler and saves through the SDK',
    (await temporary.webContents.executeJavaScript(
      'globalThis.formEntered===true && globalThis.formSaved===true',
    )) && (await rpc(temporary, read)).body.value.values.form_probe === 'saved-by-submit',
  );
  const scratchSaved = await rpc(temporary, save(1, 'scratch-only'));
  check(
    'temporary preview has independently functional writes',
    scratchSaved.body?.ok && scratchSaved.body.value.revision === 2,
  );
  check(
    'temporary writes never touched the persistent backend or file',
    persistentReads === 0 && persistentWrites === 0 && readFileSync(path).equals(originalBytes),
  );
  const checked = await previews.check(good, runtime);
  check(
    'hidden check creates a disposable new temporary session',
    checked.status === 'observed' &&
      created.length === 2 &&
      created[1].mode === 'temporary' &&
      created[1].revoked,
  );
  check(
    'hidden check never reads or writes persistent storage',
    persistentReads === 0 && persistentWrites === 0 && readFileSync(path).equals(originalBytes),
  );
  check(
    'hidden check preserves the temporary preview and its data',
    previews.previewWindow(projectId) === temporary &&
      (await rpc(temporary, read)).body.value.values.note === 'scratch-only',
  );

  const beforeLive = created.length;
  const liveResult = await previews.openApplication(good, runtime);
  check(
    'explicit application launch first probes then creates a distinct persistent session',
    liveResult.status === 'observed' &&
      created.length === beforeLive + 2 &&
      created[beforeLive].mode === 'temporary' &&
      created[beforeLive].revoked &&
      created[beforeLive + 1].mode === 'persistent',
  );
  let live = previews.applicationWindow(projectId)!;
  check(
    'persistent application is separate from the still-open temporary preview',
    live !== temporary &&
      previews.previewWindow(projectId) === temporary &&
      previews.applicationState(projectId).status === 'running',
  );
  check(
    'persistent application uses a new origin and is shown before its data is read',
    live.webContents.getURL() !== temporary.webContents.getURL() &&
      live.isVisible() &&
      visibleBeforePersistentRead,
  );
  check(
    'persistent application reads only its project data',
    await live.webContents.executeJavaScript(
      `dataReady.then(()=>initialData.values.private===${JSON.stringify(sentinel)} && !initialData.values.other)`,
    ),
  );
  check(
    'persistent application writes its project data',
    (await rpc(live, save(0, 'persistent-only'))).body.value.revision === 1,
  );
  check(
    'temporary data remains independent after real writes',
    (await rpc(temporary, read)).body.value.values.note === 'scratch-only',
  );
  check(
    'cross-project selector fields are rejected before store access',
    (await rpc(live, { ...read, projectId: otherId })).status === 400,
  );
  check(
    'path and SQL payload fields are rejected',
    (await rpc(live, { ...read, path: '../credentials.json', sql: 'SELECT secret' })).status ===
      400,
  );
  const other = await artifact(source, otherId);
  check(
    'another project can open its own application',
    (await previews.openApplication(other, runtime)).status === 'observed',
  );
  const otherWindow = previews.applicationWindow(otherId)!;
  check(
    'another project receives only its own project data',
    await otherWindow.webContents.executeJavaScript(
      'dataReady.then(()=>initialData.values.other===true && !initialData.values.private)',
    ),
  );
  const crossUrl = new URL('/app-data', otherWindow.webContents.getURL()).href;
  const accessBefore = persistentReads + persistentWrites;
  check(
    'cross-project origin requests are denied',
    await live.webContents.executeJavaScript(
      `fetch(${JSON.stringify(crossUrl)},{method:'POST',headers:{'Content-Type':'application/json'},body:'{"schemaVersion":1,"operation":"read"}'}).then(()=>false,()=>true)`,
    ),
  );
  check(
    'cross-project denial never calls a persistent backend',
    persistentReads + persistentWrites === accessBefore,
  );
  const prefs = live.webContents.getLastWebPreferences();
  check(
    'persistent renderer keeps sandbox, isolation and no privileged preload',
    prefs.sandbox &&
      prefs.contextIsolation &&
      !prefs.nodeIntegration &&
      !prefs.preload &&
      !prefs.nodeIntegrationInWorker &&
      !prefs.nodeIntegrationInSubFrames,
  );
  check(
    'persistent renderer cannot access host globals or workbench bridge',
    await live.webContents.executeJavaScript(
      "typeof window.factory==='undefined' && typeof require==='undefined' && typeof process==='undefined' && self.origin==='null'",
    ),
  );
  const endpoint = new URL('/app-data', live.webContents.getURL()).href;
  const direct = await live.webContents.session
    .fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-factory-data-request': randomUUID() },
      body: JSON.stringify(read),
    })
    .then(
      (response) => response.status,
      () => 0,
    );
  check(
    'forged host/session requests lack a valid main-frame permit',
    direct === 0 || direct === 403,
  );
  const foreign = new BrowserWindow({
    show: false,
    webPreferences: {
      session: live.webContents.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await foreign.loadURL('about:blank');
  check(
    'a foreign webContents in the same session cannot access the data API',
    await foreign.webContents.executeJavaScript(
      `fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json'},body:'{"schemaVersion":1,"operation":"read"}'}).then(()=>false,()=>true)`,
    ),
  );
  foreign.destroy();
  check(
    'client-supplied permits cannot change the authenticated main-frame project binding',
    await live.webContents.executeJavaScript(
      `fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json','x-factory-data-request':'forged'},body:'{"schemaVersion":1,"operation":"read"}'}).then(response=>response.json()).then(result=>result.ok && result.value.values.private===${JSON.stringify(sentinel)} && !result.value.values.other)`,
    ),
  );
  check(
    'frame and worker creation remain blocked',
    await live.webContents.executeJavaScript(
      `(()=>{let workerBlocked=false,workerRan=false,frameRan=false;const listener=event=>{if(event.data==='synthetic-frame-ran')frameRan=true;};addEventListener('message',listener);let worker;try{worker=new Worker(URL.createObjectURL(new Blob(['postMessage(true)'])));worker.onmessage=()=>{workerRan=true};worker.onerror=event=>{event.preventDefault();workerBlocked=true;};}catch{workerBlocked=true;}const frame=document.createElement('iframe');frame.srcdoc='<script>parent.postMessage("synthetic-frame-ran","*")<\/script>';document.body.append(frame);return new Promise(resolve=>setTimeout(()=>{worker?.terminate();frame.remove();removeEventListener('message',listener);resolve(workerBlocked&&!workerRan&&!frameRan)},200));})()`,
    ),
  );

  const bad = await artifact(
    `import {appData} from '@factory/data'; appData.read().then(value=>{if(value.values.private) throw new Error('synthetic live failure');}); export default function App(){return <p>条件运行失败</p>;}`,
  );
  const temporaryBeforeFailure = previews.previewWindow(projectId);
  const failed = await previews.openApplication(bad, runtime);
  check(
    'failure in the visible persistent application preserves the old application',
    failed.status === 'issues' &&
      previews.applicationWindow(projectId) === live &&
      !live.isDestroyed(),
  );
  check(
    'failed persistent candidate revokes its independent session',
    created.at(-1)?.mode === 'persistent' && created.at(-1)?.revoked,
  );
  check(
    'failed application launch preserves the separate temporary preview',
    previews.previewWindow(projectId) === temporaryBeforeFailure,
  );
  const cancelled = new AbortController();
  const beforeCancel = created.length;
  const pending = previews.openApplication(good, runtime, undefined, cancelled.signal);
  await until('application preliminary probe begins', () => created.length > beforeCancel);
  cancelled.abort();
  check(
    'cancel during preliminary probe creates no persistent session',
    (await pending).status === 'cancelled' &&
      created.slice(beforeCancel).every((item) => item.mode === 'temporary' && item.revoked) &&
      previews.applicationWindow(projectId) === live,
  );
  const beforeStopProbe = created.length;
  const stoppedProbe = previews.openApplication(good, runtime);
  await until(
    'second application preliminary probe begins',
    () => created.length > beforeStopProbe,
  );
  await previews.stopApplication(projectId);
  check(
    'stopApplication cancels its preliminary probe and stops the active application',
    (await stoppedProbe).status === 'cancelled' &&
      created.slice(beforeStopProbe).every((item) => item.mode === 'temporary' && item.revoked) &&
      live.isDestroyed() &&
      previews.applicationState(projectId).status === 'stopped',
  );
  check(
    'stopApplication leaves the temporary preview and its values intact',
    previews.previewWindow(projectId) === temporary &&
      (await rpc(temporary, read)).body.value.values.note === 'scratch-only',
  );
  check(
    'application can restart with saved values after explicit stop',
    (await previews.openApplication(good, runtime)).status === 'observed',
  );
  live = previews.applicationWindow(projectId)!;
  const liveCancel = new AbortController();
  const beforeLiveCancel = created.length;
  const livePending = previews.openApplication(good, runtime, undefined, liveCancel.signal);
  await until(
    'visible persistent candidate begins',
    () => created.length >= beforeLiveCancel + 2 && !!created.at(-1)?.window,
  );
  liveCancel.abort();
  check(
    'cancel during visible application startup revokes the candidate and preserves the previous window',
    (await livePending).status === 'cancelled' &&
      created.at(-1)!.revoked &&
      created.at(-1)!.window!.isDestroyed() &&
      previews.applicationWindow(projectId) === live,
  );
  const oldSession = created.findLast(
    (item) => item.mode === 'persistent' && !item.revoked && item.artifact.projectId === projectId,
  )!;
  check(
    'successful replacement opens a fresh persistent renderer',
    (await previews.openApplication(good, runtime)).status === 'observed',
  );
  check(
    'successful replacement revokes the prior session and destroys its window',
    oldSession.revoked && live.isDestroyed(),
  );
  live = previews.applicationWindow(projectId)!;
  check(
    'replacement retains committed persistent values',
    await live.webContents.executeJavaScript(
      "dataReady.then(()=>initialData.values.note==='persistent-only')",
    ),
  );
  archived = true;
  const writesBeforeArchive = persistentWrites;
  check(
    'archive invalidation rejects subsequent reads and writes',
    !(await rpc(live, read)).body.ok &&
      !(await rpc(live, save(1, 'denied'))).body.ok &&
      persistentWrites === writesBeforeArchive,
  );
  archived = false;

  await new Promise<void>((done) => network.listen(0, '127.0.0.1', done));
  const address = network.address();
  if (!address || typeof address === 'string') throw new Error();
  const url = `http://127.0.0.1:${address.port}/probe`;
  await new Promise<void>((done, reject) => {
    get(url, (response) => {
      response.resume();
      response.on('end', done);
    }).on('error', reject);
  });
  check('network probe control is reachable from the trusted host', networkRequests === 1);
  networkRequests = 0;
  await live.webContents.executeJavaScript(
    `(()=>{fetch(${JSON.stringify(url)}).catch(()=>{});try{new WebSocket(${JSON.stringify(url.replace('http:', 'ws:'))})}catch{};try{navigator.sendBeacon(${JSON.stringify(url)},'probe')}catch{};const image=new Image();image.src=${JSON.stringify(url)};return true;})()`,
  );
  await delay(200);
  check(
    'data endpoint allowance does not allow external fetch, websocket, beacon or image traffic',
    networkRequests === 0,
  );
  const beforeFormUrl = live.webContents.getURL();
  await live.webContents.executeJavaScript(
    `(()=>{const form=document.createElement('form');form.method='POST';form.action=${JSON.stringify(url)};const input=document.createElement('input');input.name='probe';input.value='synthetic';form.append(input);document.body.append(form);HTMLFormElement.prototype.submit.call(form);return true;})()`,
  );
  await delay(150);
  check(
    'native form submission remains blocked by form-action none without network or navigation',
    networkRequests === 0 && live.webContents.getURL() === beforeFormUrl,
  );
  check(
    'data applications retain the closed-loop proxy policy',
    /^SOCKS5 127\.0\.0\.1:\d+$/u.test(await live.webContents.session.resolveProxy(url)),
  );
  const beforeOversized = persistentWrites;
  const oversized = await rpc(live, save(1, 'x'.repeat(1120 * 1024)));
  check(
    'oversized request body is rejected without a persistent write',
    oversized.status !== 200 && persistentWrites === beforeOversized,
  );
  const rate = await live.webContents.executeJavaScript(
    `(async()=>{let limited=0;for(let index=0;index<185;index++){const response=await fetch(new URL('/app-data',location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:'{"schemaVersion":1,"operation":"read"}'});if(response.status===429)limited++;}return limited;})()`,
  );
  check('session request quota rejects excess traffic with fixed errors', rate > 0);
  check(
    'every persistent operation belongs to an explicitly shown application candidate',
    visibleBeforePersistentRead,
  );
  await previews.stop(projectId);
  check(
    'stopping a temporary preview leaves the local application running',
    previews.status(projectId).preview === 'closed' &&
      previews.applicationWindow(projectId) === live,
  );
  await previews.stopApplication(projectId);
  check(
    'stopping an application revokes its session and updates its state',
    live.isDestroyed() && previews.applicationState(projectId).status === 'stopped',
  );
  await previews.stopAll();
  check(
    'stopAll destroys both application classes and revokes every session',
    BrowserWindow.getAllWindows().length === 0 && created.every((item) => item.revoked),
  );
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  check(
    'application shutdown preserves project data and other projects',
    saved[projectId].values.note === 'persistent-only' &&
      saved[otherId].values.other === true &&
      !saved[otherId].values.note,
  );
  writeFileSync(
    join(output, 'result.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        realProviderRequests: 0,
        limitations: [
          'Mac Electron only',
          'Synthetic file backend verifies transport and session boundary; durable AppDataStore is verified independently',
          'Finite runtime observation is not business acceptance',
        ],
      },
      null,
      2,
    ),
  );
  await new Promise<void>((done) => network.close(() => done()));
  app.exit(0);
}
void main().catch(async () => {
  writeFileSync(
    join(output, 'failure.json'),
    JSON.stringify(
      { failedAt: current, passed: checks.length, checks, realProviderRequests: 0 },
      null,
      2,
    ),
  );
  await previews.stopAll().catch(() => {});
  network.close();
  app.exit(1);
});
