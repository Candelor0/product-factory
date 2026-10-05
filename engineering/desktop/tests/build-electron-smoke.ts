import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer as createHttpServer } from 'node:http';
import { createServer, connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import type {
  ApiResult,
  AppSnapshot,
  DesignContent,
  Project,
  RequirementContent,
} from '../src/shared/contracts';
import type { BuildState } from '../src/shared/build-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const rendererMessages: string[] = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, _level, message) => rendererMessages.push(message));
});
const cleanup: (() => void)[] = [];
const check = (label: string, condition: unknown) => {
  assert.ok(condition, label);
  checks.push(label);
};
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const appSource = `import { useState } from 'react';
import './style.css';
export default function App() {
  const [count, setCount] = useState(0);
  return <main><p className="eyebrow">本地页面预览</p><h1>一个简单的计数器</h1>
    <p>点击按钮，体验构建后的交互。</p><output data-testid="counter">{count}</output>
    <div className="actions"><button data-testid="minus" onClick={() => setCount(count - 1)}>减一</button>
      <button data-testid="reset" onClick={() => setCount(0)}>归零</button>
      <button data-testid="plus" onClick={() => setCount(count + 1)}>加一</button></div>
    <small>此合成页面的计数仅保存在当前窗口。</small></main>;
}`;
const cssSource = `:root{font-family:system-ui,sans-serif;color:#282d2a;background:#f8f7f3}body{margin:0}main{max-width:560px;margin:12vh auto;padding:48px;text-align:center}.eyebrow{font-size:13px;letter-spacing:2px;color:#788078}h1{font-size:32px;font-weight:550}p,small{color:#6a736e}output{display:block;font-size:104px;margin:34px 0}.actions{display:flex;justify-content:center;gap:12px;margin-bottom:34px}button{padding:12px 24px;border:1px solid #ccd2cc;background:white;border-radius:9px;color:#284e43;font-size:16px}button:last-child{background:#284e43;color:white}button:hover{filter:brightness(.95)}`;
const requirement: RequirementContent = {
  summary: '制作一个仅有加一、减一和归零的前端计数器。',
  audience: '想体验本地生成页面的人',
  features: ['加一和减一', '一键归零'],
  pages: ['计数器'],
  data: ['当前窗口临时计数'],
  outOfScope: ['登录', '外网请求', '持久化'],
  questions: [],
  acceptance: ['加一、减一和归零更新显示的数字'],
};
const design: DesignContent = {
  direction: '浅色，中央大数字与三个清楚的按钮。',
  palette: ['#284E43', '#F8F7F3'],
  pages: [{ name: '计数器', sections: ['标题', '数字', '加一、减一和归零按钮'] }],
  notes: ['合成测试内容，不调用在线模型。'],
};
async function waitFor(label: string, condition: () => Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  do {
    if (await condition()) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
async function capture(window: BrowserWindow, filename: string) {
  await delay(200);
  writeFileSync(join(output, filename), (await window.webContents.capturePage()).toPNG());
}
async function portClosed(port: number) {
  return new Promise<boolean>((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(true));
  });
}
async function proxyPort(window: BrowserWindow) {
  const route = await window.webContents.session.resolveProxy('http://127.0.0.1/');
  check('preview proxy has no DIRECT loopback bypass', /^SOCKS5 127\.0\.0\.1:\d+$/.test(route));
  return Number(route.split(':').at(-1));
}

async function networkBoundary(window: BrowserWindow) {
  const label = `pfpreview-${randomUUID()}`;
  const counters = {
    stun4: 0,
    turn4: 0,
    stun6: 0,
    turn6: 0,
    transport: 0,
    http: 0,
    websocket: 0,
    mdns: 0,
    mdnsControl: 0,
  };
  async function udp(key: 'stun4' | 'stun6' | 'transport', ipv6 = false) {
    const socket = createSocket(ipv6 ? 'udp6' : 'udp4');
    socket.on('message', () => counters[key]++);
    await new Promise<void>((done, reject) => {
      socket.once('error', reject);
      socket.bind(0, ipv6 ? '::1' : '127.0.0.1', done);
    });
    cleanup.push(() => socket.close());
    const sender = createSocket(ipv6 ? 'udp6' : 'udp4');
    sender.send(
      Buffer.from('synthetic-control'),
      socket.address().port,
      ipv6 ? '::1' : '127.0.0.1',
    );
    await waitFor(`${key} listener positive control`, async () => counters[key] === 1);
    sender.close();
    counters[key] = 0;
    return socket.address().port;
  }
  async function tcp(key: 'turn4' | 'turn6', ipv6 = false) {
    const server = createServer((socket) => {
      counters[key]++;
      socket.destroy();
    });
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, ipv6 ? '::1' : '127.0.0.1', done);
    });
    cleanup.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const socket = connect({ host: ipv6 ? '::1' : '127.0.0.1', port });
    socket.on('error', () => {});
    await waitFor(`${key} listener positive control`, async () => counters[key] === 1);
    socket.destroy();
    counters[key] = 0;
    return port;
  }
  const ports = {
    stun4: await udp('stun4'),
    turn4: await tcp('turn4'),
    transport: await udp('transport'),
    stun6: 0,
    turn6: 0,
  };
  let ipv6Available = false;
  try {
    ports.stun6 = await udp('stun6', true);
    ports.turn6 = await tcp('turn6', true);
    ipv6Available = true;
  } catch {
    /* Report this host limitation instead of inventing IPv6 coverage. */
  }
  const server = createHttpServer((_request, response) => {
    counters.http++;
    response.end('synthetic-local-response');
  });
  server.on('upgrade', (_request, socket) => {
    counters.websocket++;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup.push(() => server.close());
  const httpPort = (server.address() as { port: number }).port;
  check(
    'main-process Node fetch still resolves localhost',
    (await (await fetch(`http://localhost:${httpPort}/`)).text()) === 'synthetic-local-response',
  );
  counters.http = 0;
  const mdns = createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((done, reject) => {
    mdns.once('error', reject);
    mdns.bind(5353, '0.0.0.0', done);
  });
  cleanup.push(() => mdns.close());
  const memberships: boolean[] = [];
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? [])
      if (address.family === 'IPv4') {
        try {
          mdns.addMembership('224.0.0.251', address.address);
          memberships.push(true);
        } catch {
          memberships.push(false);
        }
      }
  mdns.on('message', (packet) => {
    if (packet.includes(Buffer.from(`${label}-control`))) counters.mdnsControl++;
    else if (packet.includes(Buffer.from(label))) counters.mdns++;
  });
  const query = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const part of `${label}-control.local`.split('.'))
    query.push(part.length, ...Buffer.from(part));
  const control = createSocket('udp4');
  await new Promise<void>((done) => control.bind(0, '127.0.0.1', done));
  control.setMulticastInterface('127.0.0.1');
  control.setMulticastLoopback(true);
  control.send(Buffer.from([...query, 0, 0, 1, 0, 1]), 5353, '224.0.0.251');
  await waitFor('multicast receiver positive control', async () => counters.mdnsControl > 0);
  control.close();
  const ses = window.webContents.session;
  const logPath = join(output, `temporary-netlog-${phase}.json`);
  const urls = [
    `stun:127.0.0.1:${ports.stun4}`,
    `turn:127.0.0.1:${ports.turn4}?transport=tcp`,
    `stun:${label}.test:${ports.stun4}`,
    `turn:${label}.test:${ports.turn4}?transport=tcp`,
  ];
  if (ipv6Available)
    urls.push(`stun:[::1]:${ports.stun6}`, `turn:[::1]:${ports.turn6}?transport=tcp`);
  await ses.netLog.startLogging(logPath);
  let dnsError = '';
  let dnsTypes: string[] = [];
  let renderer: {
    peersStarted: number;
    mdnsCandidateAdded: boolean;
    transportAttempted: boolean;
    denied: string[];
  };
  try {
    await window.webContents.executeJavaScript(`(async()=>{
      const result={peersStarted:0,mdnsCandidateAdded:false,transportAttempted:false,denied:[]}; window.__probe=result; window.__pcs=[];
      document.addEventListener('securitypolicyviolation',event=>result.denied.push(event.violatedDirective));
      for(const url of ${JSON.stringify(urls)}) {
        const pc=new RTCPeerConnection({iceServers:[{urls:url,username:'synthetic',credential:'synthetic'}]});
        window.__pcs.push(pc); pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer()); result.peersStarted++;
      }
      const pc=new RTCPeerConnection(); window.__pcs.push(pc);pc.createDataChannel('mdns');await pc.setLocalDescription(await pc.createOffer());
      const sdp=pc.localDescription.sdp.replace('a=setup:actpass','a=setup:active').replace(/a=ice-ufrag:[^\\r\\n]+/g,'a=ice-ufrag:probepeer').replace(/a=ice-pwd:[^\\r\\n]+/g,'a=ice-pwd:syntheticpassword123456789');
      await pc.setRemoteDescription({type:'answer',sdp});await pc.addIceCandidate({sdpMid:'0',candidate:'candidate:1234 1 udp 2122260223 ${label}.local ${ports.stun4} typ host'});result.mdnsCandidateAdded=true;
      try{result.transportAttempted=typeof WebTransport==='function'; const transport=new WebTransport('https://127.0.0.1:${ports.transport}/');transport.ready.catch(()=>{});transport.closed.catch(()=>{});}catch{}
      fetch('http://127.0.0.1:${httpPort}/fetch').catch(()=>{});
      try{const ws=new WebSocket('ws://127.0.0.1:${httpPort}/ws');ws.onerror=()=>{};}catch{}
      try{navigator.sendBeacon('http://127.0.0.1:${httpPort}/beacon','synthetic');}catch{}
      const img=new Image();img.src='http://127.0.0.1:${httpPort}/image';
    })()`);
    try {
      await ses.resolveHost(`${label}.test`);
    } catch (error) {
      dnsError = String((error as { code?: string }).code ?? error);
    }
    await delay(5_000);
    renderer = await window.webContents.executeJavaScript('window.__probe');
  } finally {
    await ses.netLog.stopLogging();
    if (existsSync(logPath)) {
      const log = JSON.parse(readFileSync(logPath, 'utf8')) as {
        constants: { logEventTypes: Record<string, number> };
        events: { type: number }[];
      };
      const names = new Map(
        Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]),
      );
      dnsTypes = log.events
        .map((event) => names.get(event.type) ?? '')
        .filter((name) => /DNS|HOST_RESOLVER|MDNS/.test(name));
      unlinkSync(logPath); // Keep only event type names, never raw network logs.
    }
  }
  check(
    'real preview begins every IPv4/IPv6/hostname ICE offer',
    renderer!.peersStarted === urls.length,
  );
  check(
    'real preview accepts the synthetic remote mDNS ICE candidate',
    renderer!.mdnsCandidateAdded,
  );
  check(
    'real preview attempts WebTransport and CSP rejects it',
    renderer!.transportAttempted && renderer!.denied.includes('connect-src'),
  );
  check(
    'RTC STUN UDP and TURN TCP targets receive no IPv4 traffic',
    counters.stun4 === 0 && counters.turn4 === 0,
  );
  if (ipv6Available)
    check(
      'RTC STUN UDP and TURN TCP targets receive no IPv6 traffic',
      counters.stun6 === 0 && counters.turn6 === 0,
    );
  check(
    'WebTransport, HTTP, WebSocket, beacon and image targets receive no traffic',
    counters.transport === 0 && counters.http === 0 && counters.websocket === 0,
  );
  check(
    'mDNS query is absent with a working multicast positive control',
    counters.mdns === 0 && counters.mdnsControl > 0,
  );
  check(
    'Chromium hostname resolution fails locally without a DNS transaction',
    dnsError.includes('ERR_NAME_NOT_RESOLVED') &&
      !dnsTypes.some((name) => name.startsWith('DNS_TRANSACTION')),
  );
  await window.webContents.executeJavaScript('window.__pcs.forEach(pc=>pc.close()); true');
  return {
    counters,
    ipv6Available,
    memberships,
    peersStarted: renderer!.peersStarted,
    dnsError,
    dnsEventTypes: [...new Set(dnsTypes)],
    limitations: [
      'Five-second local target observation, not packet capture of every OS interface',
      'mDNS observation covers IPv4 multicast; no IPv6 multicast capture',
      'No Chromium vulnerability or OS sandbox escape test',
    ],
  };
}

async function run() {
  if (!['create', 'reopen'].includes(phase)) throw new Error('Invalid phase');
  let providerCalls = 0;
  const desktop = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    toolchainPath: resolve('dist/toolchain'),
    show: false,
    modelRequest: async () => {
      providerCalls++;
      throw new Error('No model request permitted in this synthetic test');
    },
  });
  const { window, store, sources, sourceTools, plans, previews, builds } = desktop;
  window.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(code: string) =>
    window.webContents.executeJavaScript(code) as Promise<T>;
  const invoke = async <T>(method: string, payload?: unknown): Promise<T> => {
    const response = await exec<ApiResult<T>>(
      `window.factory[${JSON.stringify(method)}](${JSON.stringify(payload)})`,
    );
    if (!response.ok) throw new Error(`${method}: ${response.error.code}`);
    return response.value;
  };
  const openPlan = async () => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await waitFor('project link', () => exec('!!document.querySelector(".project-item")'));
    await exec('document.querySelector(".project-item").click();true');
    await waitFor('plan tab', () =>
      exec(
        "Array.from(document.querySelectorAll('[role=tab]')).some(item=>item.textContent.includes('开发计划'))",
      ),
    );
    await exec(
      "Array.from(document.querySelectorAll('[role=tab]')).find(item=>item.textContent.includes('开发计划')).click();true",
    );
    await waitFor('build panel', () =>
      exec(
        '!!document.querySelector("[data-testid=build-state]") && document.querySelector("[data-testid=build-state]").dataset.status !== "loading"',
      ),
    );
  };
  const snapshot = await invoke<AppSnapshot>('snapshot');
  check(
    'isolated workspace has no API Key and no prior model use',
    !snapshot.settings.hasKey && snapshot.usage.calls === 0,
  );
  check('Electron process has no developer Node/npm on PATH', process.env.PATH === '/usr/bin:/bin');
  check(
    'test runtime rejects external JavaScript packages',
    process.env.FACTORY_SMOKE_EXTERNAL_PACKAGES_BLOCKED === '1',
  );
  let project: Project;
  if (phase === 'create') {
    check('clean synthetic workspace', snapshot.projects.length === 0);
    project = store.create({ name: '构建实测 · 合成计数器', idea: requirement.summary });
    project = store.saveRequirements(project.id, requirement);
    project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = store.saveDesign(project.id, design);
    project = store.approveDesign(project.id, project.designs.at(-1)!.id);
    plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      requirementId: project.requirements.at(-1)!.id,
      designId: project.designs.at(-1)!.id,
      profile: 'web',
    });
  } else {
    check(
      'project survives process restart',
      snapshot.projects.length === 1 && snapshot.projects[0].stage === 'ready',
    );
    project = snapshot.projects[0];
  }
  const planRunId = plans.get(project.id).run!.id;
  const sourcePath = join(store.rootPath, 'projects', project.id, 'source', 'workspace.json');
  const buildPath = join(store.rootPath, 'projects', project.id, 'runs', 'builds.json');
  const applySource = (content: string, initial = false) => {
    const current = sources.get(project.id);
    const result = sourceTools.execute(
      { projectId: project.id, planRunId },
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'apply_changes',
        arguments: {
          expectedRevision: current.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash:
                current.files.find((file) => file.path === 'src/app.tsx')?.sha256 ?? null,
              content,
            },
            ...(initial
              ? [
                  {
                    operation: 'write',
                    path: 'src/style.css',
                    expectedHash: null,
                    content: cssSource,
                  },
                ]
              : []),
          ],
        },
      },
    );
    check('synthetic source transaction accepted by confirmed-plan dispatcher', result.ok);
  };
  const previewReady = async () => {
    await waitFor('actual preview React render', async () => {
      const preview = previews.previewWindow(project.id);
      return (
        !!preview &&
        (await preview.webContents.executeJavaScript(
          '!!document.querySelector("[data-testid=counter]")',
        ))
      );
    });
    const preview = previews.previewWindow(project.id)!;
    preview.webContents.setBackgroundThrottling(false);
    return preview;
  };
  const clickBuild = async () => {
    await openPlan();
    await waitFor('enabled build button', () =>
      exec('!document.querySelector("[data-testid=build-source]").disabled'),
    );
    await exec('document.querySelector("[data-testid=build-source]").click();true');
  };
  let network: Awaited<ReturnType<typeof networkBoundary>> | undefined;
  let originalBuildId: string;
  if (phase === 'create') {
    applySource(appSource, true);
    await clickBuild();
    const preview = await previewReady();
    const state = await invoke<BuildState>('buildState', { projectId: project.id });
    originalBuildId = state.artifact!.id;
    check(
      'compile uses the fixed bundled native toolchain',
      process.env.ESBUILD_BINARY_PATH ===
        resolve('dist/toolchain', process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'),
    );
    check(
      'actual React build button compiles source and opens its exact artifact through IPC',
      state.status === 'current' &&
        state.preview === 'open' &&
        state.previewBuildId === originalBuildId &&
        state.artifact?.sourceRevision === 1,
    );
    const pexec = <T = unknown>(code: string) =>
      preview.webContents.executeJavaScript(code) as Promise<T>;
    for (const [button, expected] of [
      ['plus', '1'],
      ['plus', '2'],
      ['minus', '1'],
      ['reset', '0'],
    ]) {
      await pexec(`document.querySelector('[data-testid=${button}]').click();true`);
      await waitFor(`counter ${button}`, () =>
        pexec(`document.querySelector('[data-testid=counter]').textContent === '${expected}'`),
      );
      check(`compiled React ${button} interaction displays ${expected}`, true);
    }
    // Electron's test-only inspector is not part of the public TypeScript declarations.
    const preferences = (
      preview.webContents as typeof preview.webContents & {
        getLastWebPreferences(): Electron.WebPreferences;
      }
    ).getLastWebPreferences();
    check(
      'preview has sandbox, context isolation, web security and no Node/preload',
      preferences.sandbox &&
        preferences.contextIsolation &&
        preferences.webSecurity &&
        !preferences.nodeIntegration &&
        !preferences.nodeIntegrationInWorker &&
        !preferences.preload,
    );
    check(
      'preview exposes neither workbench bridge nor Node and has opaque origin',
      await pexec(
        "typeof window.factory==='undefined' && typeof require==='undefined' && typeof process==='undefined' && self.origin==='null'",
      ),
    );
    check(
      'preview owns a separate nonpersistent session',
      preview.webContents.session !== window.webContents.session &&
        !preview.webContents.session.isPersistent(),
    );
    check(
      'WebRTC nonproxied UDP is disabled',
      preview.webContents.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp',
    );
    const firstProxyPort = await proxyPort(preview);
    await capture(preview, 'counter-preview.png');
    window.setContentSize(1440, 900);
    await exec(
      'document.querySelector("[data-testid=build-state]").scrollIntoView({block:"center"});true',
    );
    await capture(window, 'build-success-1440.png');
    network = await networkBoundary(preview);
    const priorURL = preview.webContents.getURL();
    const windowsBefore = BrowserWindow.getAllWindows().length;
    check('window.open is denied', await pexec("window.open('https://example.invalid')===null"));
    await pexec("location.href='https://example.invalid/navigation';true");
    await delay(250);
    check(
      'renderer navigation and popup creation are blocked',
      preview.webContents.getURL() === priorURL &&
        BrowserWindow.getAllWindows().length === windowsBefore,
    );
    check(
      'worker execution is blocked by CSP',
      await pexec(
        "new Promise(resolve=>{try{const url=URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'}));const worker=new Worker(url);const timer=setTimeout(()=>{worker.terminate();URL.revokeObjectURL(url);resolve(false)},2000);worker.onmessage=()=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve(false)};worker.onerror=event=>{event.preventDefault();clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve(true)}}catch{resolve(true)}})",
      ),
    );
    check(
      'geolocation permission is denied',
      await pexec(
        'new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve(false),error=>resolve(error.code===1)))',
      ),
    );
    let downloadPrevented = false;
    preview.webContents.session.once('will-download', (event) => {
      downloadPrevented = event.defaultPrevented;
    });
    preview.webContents.downloadURL('data:text/plain,synthetic-download');
    await waitFor('download denied', async () => downloadPrevented);
    check('session download handler cancels real download attempt', downloadPrevented);
    const successfulBytes = readFileSync(buildPath);
    applySource('export default function App() { return <div>; }');
    await clickBuild();
    await waitFor('syntax diagnostic in real workbench UI', () =>
      exec('!!document.querySelector("[data-testid=build-diagnostics]")'),
    );
    const failureState = await invoke<BuildState>('buildState', { projectId: project.id });
    check(
      'failed native compilation preserves exact previous artifact bytes and live preview',
      readFileSync(buildPath).equals(successfulBytes) &&
        failureState.status === 'stale' &&
        failureState.artifact?.id === originalBuildId &&
        previews.previewWindow(project.id) === preview,
    );
    check(
      'compile diagnostic identifies virtual source without host paths',
      await exec(
        "document.querySelector('[data-testid=build-diagnostics]').textContent.includes('src/app.tsx') && !document.querySelector('[data-testid=build-diagnostics]').textContent.includes('/Users/')",
      ),
    );
    await exec(
      'document.querySelector("[data-testid=build-state]").scrollIntoView({block:"center"});true',
    );
    await capture(window, 'build-error-preserves-preview.png');
    await exec(
      "Array.from(document.querySelectorAll('[data-testid=build-state] button')).find(button=>button.textContent.includes('关闭预览')).click();true",
    );
    await waitFor(
      'close removes preview and rejects proxy port',
      async () =>
        previews.status(project.id).preview === 'closed' && (await portClosed(firstProxyPort)),
    );
    check(
      'real close button destroys preview and closes owned proxy listener',
      preview.isDestroyed(),
    );
    await exec(
      "Array.from(document.querySelectorAll('[data-testid=build-state] button')).find(button=>button.textContent.includes('查看上次预览')).click();true",
    );
    const restored = await previewReady();
    const archiveProxyPort = await proxyPort(restored);
    check(
      'old successful preview can reopen after syntax failure',
      await restored.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent === '0'",
      ),
    );
    await invoke('archiveProject', { projectId: project.id, archived: true });
    check(
      'archive destroys preview and closes owned proxy listener',
      restored.isDestroyed() &&
        previews.status(project.id).preview === 'closed' &&
        (await portClosed(archiveProxyPort)),
    );
    await invoke('archiveProject', { projectId: project.id, archived: false });
  } else {
    const prior = JSON.parse(readFileSync(join(output, 'build-create.json'), 'utf8')) as {
      buildSha256: string;
      sourceSha256: string;
      originalBuildId: string;
    };
    originalBuildId = prior.originalBuildId;
    check(
      'build and source journal bytes survive separate Electron launch',
      hash(readFileSync(buildPath)) === prior.buildSha256 &&
        hash(readFileSync(sourcePath)) === prior.sourceSha256,
    );
    check(
      'reopening performs no automatic build or preview execution',
      builds.state(project.id).artifact?.id === originalBuildId &&
        previews.status(project.id).preview === 'closed',
    );
    await invoke('openPreview', { projectId: project.id, buildId: originalBuildId });
    const restored = await previewReady();
    check(
      'persisted successful artifact renders after full process restart',
      await restored.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent === '0'",
      ),
    );
    const oldProxyPort = await proxyPort(restored);
    applySource(appSource.replace('一个简单的计数器', '重新构建的计数器'));
    await clickBuild();
    await waitFor(
      'new build replaces old preview',
      async () =>
        builds.state(project.id).artifact?.id !== originalBuildId &&
        !!previews.previewWindow(project.id) &&
        previews.previewWindow(project.id) !== restored,
    );
    const replacement = await previewReady();
    check(
      'fresh native compile works with system Node/npm absent',
      await replacement.webContents.executeJavaScript(
        "document.querySelector('h1').textContent==='重新构建的计数器'",
      ),
    );
    check(
      'restarted compile uses the fixed bundled native toolchain',
      process.env.ESBUILD_BINARY_PATH ===
        resolve('dist/toolchain', process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'),
    );
    check(
      'replacement disposes previous window and proxy listener',
      restored.isDestroyed() && (await portClosed(oldProxyPort)),
    );
    await replacement.webContents.executeJavaScript(
      "document.querySelector('[data-testid=plus]').click();true",
    );
    await waitFor('restored plus interaction', () =>
      replacement.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent==='1'",
      ),
    );
    await capture(replacement, 'counter-reopen-rebuilt.png');
    const newProxyPort = await proxyPort(replacement);
    await invoke('closePreview', { projectId: project.id });
    check(
      'reopened build closes without listener leakage',
      replacement.isDestroyed() && (await portClosed(newProxyPort)),
    );
  }
  const finalSnapshot = await invoke<AppSnapshot>('snapshot');
  check(
    'build workflow makes zero model calls',
    providerCalls === 0 && finalSnapshot.usage.calls === 0,
  );
  check(
    'compilation does not claim business acceptance or implementation completion',
    store.get(project.id).stage === 'ready' &&
      plans
        .get(project.id)
        .run!.plan.tasks.every(
          (task) => task.implementation === 'pending' && task.verification === 'not_run',
        ),
  );
  check(
    'generated source remains virtual without a host src directory',
    !existsSync(join(store.rootPath, 'projects', project.id, 'source', 'src')),
  );
  await previews.stopAll();
  for (const close of cleanup) close();
  writeFileSync(
    join(output, `build-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        runtime: process.versions,
        systemPath: process.env.PATH,
        modelCalls: providerCalls,
        originalBuildId,
        buildSha256: hash(readFileSync(buildPath)),
        sourceSha256: hash(readFileSync(sourcePath)),
        network,
        limitations: [
          'Synthetic counter, not an arbitrary full generated application',
          'No live model request or user data',
          'No signed/clean-system/Windows installation test',
          'No persistent generated-app data service',
          ...(network?.limitations ?? []),
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Build ${phase}: ${checks.length} checks passed`);
  app.exit(0);
}
mkdirSync(output, { recursive: true });
run().catch(async (error) => {
  console.error(String(error));
  const windows = await Promise.all(
    BrowserWindow.getAllWindows().map(async (window) => ({
      title: window.getTitle(),
      body: await window.webContents
        .executeJavaScript('document.body.innerText')
        .catch(() => 'unavailable'),
    })),
  );
  writeFileSync(
    join(output, `build-${phase}-renderer-failure.json`),
    JSON.stringify({ rendererMessages, windows }, null, 2),
  );
  writeFileSync(
    join(output, `build-${phase}-failure.txt`),
    `${String(error)}\nCompleted: ${checks.join('; ')}`,
  );
  for (const close of cleanup)
    try {
      close();
    } catch {
      /* Failed fixture cleanup is bounded by parent timeout. */
    }
  app.exit(1);
});
