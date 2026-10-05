import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { GeneratedPreview } from '../src/main/generated-preview';
import { compileSource } from '../src/main/source-compiler';
import { buildArtifactHash } from '../src/main/build-store';
import { snapshotHash } from '../src/main/build-service';
import { sourceHash } from '../src/main/source-protocol';
import { loadToolchain } from '../src/main/toolchain';
import type { BuildArtifact } from '../src/shared/build-contracts';
import type { AppAiResponse, AppAiSession } from '../src/shared/app-ai-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
app.setPath('userData', process.env.FACTORY_TEST_DATA!);
app.on('window-all-closed', () => {});
const checks: string[] = [];
let current = 'initialization';
const projectId = randomUUID(),
  otherId = randomUUID();
let calls = 0,
  temporaryCalls = 0,
  active = 0,
  peak = 0,
  cancelled = 0;
let visibleBeforeCall = true;
const created: {
  projectId: string;
  mode: AppAiSession['mode'];
  revoked: boolean;
  window?: BrowserWindow;
  release?: () => void;
}[] = [];
app.on('browser-window-created', (_event, window) => {
  const record = created.at(-1);
  if (record && !record.window) record.window = window;
});
const previews = new GeneratedPreview(true, undefined, (artifact, mode) => {
  const record: (typeof created)[number] = { projectId: artifact.projectId, mode, revoked: false };
  created.push(record);
  return {
    mode,
    async execute(input): Promise<AppAiResponse> {
      if (mode === 'temporary') {
        temporaryCalls++;
        throw new Error('temporary execution forbidden');
      }
      calls++;
      active++;
      peak = Math.max(peak, active);
      visibleBeforeCall &&=
        !!record.window && !record.window.isDestroyed() && record.window.isVisible();
      const value = input as { text: string };
      try {
        if (value.text === 'hold')
          await new Promise<void>((resolve) => {
            record.release = resolve;
          });
        if (value.text === 'throw') throw new Error('SYNTHETIC_PRIVATE_EXCEPTION');
        if (record.revoked)
          return { ok: false, error: { code: 'APP_AI_REVOKED', message: '会话已撤销。' } };
        return { ok: true, value: { text: `synthetic:${record.projectId}` } };
      } finally {
        active--;
        record.release = undefined;
      }
    },
    revoke() {
      record.revoked = true;
      if (record.release) {
        cancelled++;
        record.release();
      }
    },
  };
});
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function check(label: string, condition: unknown): asserts condition {
  current = label;
  assert.ok(condition, label);
  checks.push(label);
}
async function until(label: string, condition: () => boolean) {
  current = label;
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error();
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
    planRunId: randomUUID(),
    planInputHash: sourceHash('synthetic'),
    planArtifactHash: sourceHash('synthetic plan'),
    templateVersion: 'react-preview-v1',
    compilerVersion: 'esbuild-0.28.2',
    artifactHash: buildArtifactHash(compiled),
  };
}
const source = `import {appAi} from '@factory/ai';
globalThis.runAi=text=>appAi.generateText({requestId:crypto.randomUUID(),text}).then(text=>({text}),error=>({code:error.code}));
export default function App(){return <main><h1>AI边界验证</h1><button id="ask" onClick={()=>{globalThis.clicked=globalThis.runAi('click')}}>发送输入给已授权模型</button></main>}`;
const request = (text = 'synthetic') => ({ schemaVersion: 1, requestId: randomUUID(), text });
const rpc = (
  window: BrowserWindow,
  input: unknown,
  path = '/app-ai',
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
) =>
  window.webContents.executeJavaScript(
    `fetch(new URL(${JSON.stringify(path)},location.href),{method:'POST',credentials:'omit',headers:${JSON.stringify(headers)},body:${JSON.stringify(JSON.stringify(input))}}).then(async response=>({status:response.status,body:await response.json()})).catch(()=>({status:0}))`,
  );
let networkRequests = 0;
const network = createServer((_req, res) => {
  networkRequests++;
  res.end('synthetic control');
});
network.on('upgrade', (_req, socket) => {
  networkRequests++;
  socket.destroy();
});
async function main() {
  await app.whenReady();
  const { runtime } = loadToolchain(resolve('dist/toolchain'));
  const good = await artifact(source);
  check(
    'compiled AI SDK preview opens',
    (await previews.open(good, runtime)).status === 'observed',
  );
  const temporary = previews.previewWindow(projectId)!;
  const disabled = await temporary.webContents.executeJavaScript("runAi('temporary')");
  check(
    'temporary preview returns fixed disabled result without session execute',
    disabled.code === 'APP_AI_DISABLED' && calls === 0 && temporaryCalls === 0,
  );
  const auto = await artifact(
    `import {appAi} from '@factory/ai'; appAi.generateText({requestId:crypto.randomUUID(),text:'hidden check'}).catch(()=>{}); export default function App(){return <p>检查</p>}`,
  );
  check(
    'hidden startup check can catch disabled AI without a false runtime failure',
    (await previews.check(auto, runtime)).status === 'observed',
  );
  check(
    'hidden check never enters provider-capable execute and revokes temporary session',
    calls === 0 && temporaryCalls === 0 && created.at(-1)?.revoked,
  );
  check(
    'application launch succeeds with fresh temporary probe and persistent origin',
    (await previews.openApplication(good, runtime)).status === 'observed',
  );
  let live = previews.applicationWindow(projectId)!;
  check('launching passive app does not invoke the synthetic model', calls === 0);
  await live.webContents.executeJavaScript("document.getElementById('ask').click()");
  check(
    'normal user button runs the actual SDK and returns project-bound text',
    (await live.webContents.executeJavaScript('clicked')).text === `synthetic:${projectId}` &&
      calls === 1,
  );
  check('persistent calls occur only after candidate is visibly shown', visibleBeforeCall);
  check(
    'application and temporary preview retain different immutable origins',
    live !== temporary && live.webContents.getURL() !== temporary.webContents.getURL(),
  );
  const prefs = live.webContents.getLastWebPreferences();
  check(
    'AI-enabled renderer retains sandbox and lacks Node or preload',
    prefs.sandbox &&
      prefs.contextIsolation &&
      !prefs.nodeIntegration &&
      !prefs.preload &&
      !prefs.nodeIntegrationInWorker &&
      !prefs.nodeIntegrationInSubFrames,
  );
  check(
    'generated page has no host bridge, Node globals or provider key handle',
    await live.webContents.executeJavaScript(
      "typeof factory==='undefined' && typeof require==='undefined' && typeof process==='undefined' && self.origin==='null'",
    ),
  );
  const beforeInvalid = calls;
  for (const extra of [
    { projectId: otherId },
    { model: 'forged' },
    { url: 'https://example.invalid' },
    { headers: { Authorization: 'synthetic' } },
    { path: '../credentials' },
    { tools: [] },
  ])
    check(
      `forbidden request selector rejected: ${Object.keys(extra)[0]}`,
      (await rpc(live, { ...request(), ...extra })).status === 400,
    );
  check('invalid selectors never reach execute', calls === beforeInvalid);
  check(
    'oversized raw body cannot reach execute',
    (await rpc(live, request('x'.repeat(33 * 1024)))).status !== 200 && calls === beforeInvalid,
  );
  check(
    'invalid content type is rejected',
    (await rpc(live, request(), '/app-ai', { 'Content-Type': 'text/plain' })).status === 400 &&
      calls === beforeInvalid,
  );
  check(
    'query aliases are denied',
    (await rpc(live, request(), '/app-ai?project=other')).status === 0 && calls === beforeInvalid,
  );
  const endpoint = new URL('/app-ai', live.webContents.getURL()).href;
  const host = await live.webContents.session
    .fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-factory-data-request': randomUUID() },
      body: JSON.stringify(request()),
    })
    .then(
      (r) => r.status,
      () => 0,
    );
  check(
    'forged host fetch has no authenticated main-frame permit',
    (host === 0 || host === 403) && calls === beforeInvalid,
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
    'foreign webContents cannot reuse an application session',
    await foreign.webContents.executeJavaScript(
      `fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(request()))}}).then(()=>false,()=>true)`,
    ),
  );
  foreign.destroy();
  check(
    'client nonce spoofing cannot select another project',
    (
      await rpc(live, request(), '/app-ai', {
        'Content-Type': 'application/json',
        'x-factory-data-request': 'forged',
      })
    ).body.value.text === `synthetic:${projectId}`,
  );
  check(
    'second project launches independently',
    (await previews.openApplication(await artifact(source, otherId), runtime)).status ===
      'observed',
  );
  const other = previews.applicationWindow(otherId)!;
  check(
    'second project gets only its own project-bound result',
    (await other.webContents.executeJavaScript("runAi('own')")).text === `synthetic:${otherId}`,
  );
  const cross = new URL('/app-ai', other.webContents.getURL()).href;
  const beforeCross = calls;
  check(
    'cross-origin project API is blocked',
    await live.webContents.executeJavaScript(
      `fetch(${JSON.stringify(cross)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(request()))}}).then(()=>false,()=>true)`,
    ),
  );
  check('cross-origin denial never enters an AI session', calls === beforeCross);
  check(
    'frame and worker execution remain blocked',
    await live.webContents.executeJavaScript(
      `(()=>{let blocked=false,ran=false,frameRan=false;const listener=e=>{if(e.data==='frame-ran')frameRan=true};addEventListener('message',listener);let worker;try{worker=new Worker(URL.createObjectURL(new Blob(['postMessage(true)'])));worker.onmessage=()=>ran=true;worker.onerror=e=>{e.preventDefault();blocked=true;};}catch{blocked=true;}const frame=document.createElement('iframe');frame.srcdoc='<script>parent.postMessage("frame-ran","*")<\\/script>';document.body.append(frame);return new Promise(resolve=>setTimeout(()=>{worker?.terminate();frame.remove();removeEventListener('message',listener);resolve(blocked&&!ran&&!frameRan)},150));})()`,
    ),
  );
  await live.webContents.executeJavaScript("globalThis.pending=runAi('hold'); true");
  await until('synthetic pending AI starts', () => active === 1);
  const beforeBusy = calls;
  check(
    'one active AI request per renderer rejects a concurrent request',
    (await rpc(live, request())).body.error.code === 'APP_AI_RATE_LIMIT' &&
      calls === beforeBusy &&
      peak === 1,
  );
  await previews.stop(projectId);
  check(
    'closing temporary preview does not cancel persistent AI',
    active === 1 && previews.applicationWindow(projectId) === live,
  );
  await previews.stopApplication(projectId);
  await until('close cancels pending synthetic provider request', () => active === 0);
  check(
    'application close revokes AI and destroys renderer',
    cancelled === 1 &&
      live.isDestroyed() &&
      created.filter((r) => r.projectId === projectId).every((r) => r.revoked),
  );
  check(
    'another project remains running after cancellation',
    previews.applicationWindow(otherId) === other && !other.isDestroyed(),
  );
  check(
    'replacement application starts',
    (await previews.openApplication(good, runtime)).status === 'observed',
  );
  live = previews.applicationWindow(projectId)!;
  const oldRecord = created.at(-1)!;
  const oldWindow = live;
  check(
    'same-project replacement succeeds',
    (await previews.openApplication(good, runtime)).status === 'observed',
  );
  live = previews.applicationWindow(projectId)!;
  check(
    'replacement revokes old AI session before its old window can be reused',
    oldRecord.revoked && oldWindow.isDestroyed() && live !== oldWindow,
  );
  const failedSource = await artifact(
    `import {appAi} from '@factory/ai'; appAi.generateText({requestId:crypto.randomUUID(),text:'candidate'}).then(()=>{throw new Error('synthetic candidate failure')}).catch(error=>{if(error.code!=='APP_AI_DISABLED') throw error;}); export default function App(){return <p>合成候选</p>}`,
  );
  const failed = await previews.openApplication(failedSource, runtime);
  check(
    'failed visible AI candidate preserves the existing live application',
    failed.status === 'issues' &&
      previews.applicationWindow(projectId) === live &&
      !live.isDestroyed(),
  );
  check(
    'failed visible candidate revokes its independent AI session',
    created.at(-1)?.mode === 'persistent' && created.at(-1)?.revoked,
  );
  const beforeError = calls;
  check(
    'raw session exceptions become a fixed safe business error',
    (await live.webContents.executeJavaScript("runAi('throw')")).code === 'APP_AI_UNAVAILABLE' &&
      calls === beforeError + 1,
  );
  const rate = await live.webContents.executeJavaScript(
    `(async()=>{let rejected=0;for(let i=0;i<33;i++){const result=await runAi('rate');if(result.code==='APP_AI_RATE_LIMIT')rejected++;}return rejected;})()`,
  );
  check('per-session rate bound stops excessive synthetic requests', rate > 0);
  await new Promise<void>((done) => network.listen(0, '127.0.0.1', done));
  const address = network.address();
  if (!address || typeof address === 'string') throw new Error();
  const networkUrl = `http://127.0.0.1:${address.port}/synthetic`;
  await new Promise<void>((done, reject) => {
    get(networkUrl, (r) => {
      r.resume();
      r.on('end', done);
    }).on('error', reject);
  });
  check(
    'real local network target positive control receives a trusted host request',
    networkRequests === 1,
  );
  await live.webContents.executeJavaScript(
    `(()=>{fetch(${JSON.stringify(networkUrl)}).catch(()=>{});try{navigator.sendBeacon(${JSON.stringify(networkUrl)},'synthetic')}catch{}try{new WebSocket(${JSON.stringify(networkUrl.replace('http:', 'ws:'))})}catch{}const img=new Image();img.src=${JSON.stringify(networkUrl)};document.body.append(img);const form=document.createElement('form');form.method='POST';form.action=${JSON.stringify(networkUrl)};document.body.append(form);form.submit();return true;})()`,
  );
  await delay(350);
  check(
    'adding AI protocol access does not permit HTTP, WebSocket, beacon, image or native form egress',
    networkRequests === 1 && live.webContents.getURL().startsWith('factory-preview://'),
  );
  const crashRecord = created.find((r) => r.window === live)!;
  live.webContents.forcefullyCrashRenderer();
  await until('crashed AI renderer destroyed', () => live.isDestroyed());
  check(
    'native renderer crash revokes its AI session',
    crashRecord.revoked && previews.applicationState(projectId).status === 'stopped',
  );
  const controller = new AbortController();
  const prior = created.length;
  const pending = previews.openApplication(good, runtime, undefined, controller.signal);
  await until('cancel candidate created', () => created.length > prior);
  controller.abort();
  check(
    'cancelled hidden application probe creates no persistent AI session',
    (await pending).status === 'cancelled' &&
      created.slice(prior).every((r) => r.mode === 'temporary' && r.revoked),
  );
  await previews.stopAll();
  check(
    'stopAll removes all AI windows and revokes every AI session',
    BrowserWindow.getAllWindows().length === 0 &&
      created.every((r) => r.revoked) &&
      active === 0 &&
      temporaryCalls === 0,
  );
  writeFileSync(
    join(output, 'result.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        realProviderRequests: 0,
        syntheticCalls: calls,
        limitations: [
          'Mac Electron transport and lifecycle only',
          'Project authorization and durable budget ledger tested separately',
          'Finite startup observation is not business acceptance',
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
