import { app, BrowserWindow, protocol, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { AppAiResponse, AppAiSession } from '../shared/app-ai-contracts';
import { APP_AI_SDK_SOURCE } from './app-ai-sdk';
import type { BuildArtifact } from '../shared/build-contracts';
import type {
  AppDataResponse,
  AppDataSession,
  ApplicationState,
} from '../shared/app-data-contracts';
import {
  runtimeIssueMessages,
  type RuntimeIssueCode,
  type RuntimeProbeResult,
} from '../shared/runtime-contracts';
import { AppError } from './validation';
import { APP_DATA_SDK_SOURCE } from './app-data-sdk';
import { APP_DATA_LIMITS } from './app-data-protocol';

// Chromium renderer networking only; model traffic is trusted main-process Node fetch.
// Must run before ready. Local fixed blog/dev HTTP uses literal 127.0.0.1.
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE [::1]',
);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'factory-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const csp = (origin: string) =>
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'none'; connect-src ${origin}/app-data ${origin}/app-ai; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms`;
const ISSUE_MARKER = '__PF_RUNTIME_ISSUE__:';
const bootstrap = `(() => {
  const log = console.error.bind(console);
  const NativeErrorEvent = ErrorEvent;
  const types = [[ReferenceError,'REFERENCE_ERROR'],[TypeError,'TYPE_ERROR'],[RangeError,'RANGE_ERROR'],[SyntaxError,'SYNTAX_ERROR']];
  const classify = error => { try { for(const [type,code] of types) if(error instanceof type) return code; } catch {} return 'SCRIPT_ERROR'; };
  const report = code => {
    log('${ISSUE_MARKER}' + code);
    try { const root=document.getElementById('root'); if(root) { root.textContent='页面执行遇到错误，请返回工作台检查源码。'; root.setAttribute('role','alert'); } } catch {}
  };
  addEventListener('error', event => report(event instanceof NativeErrorEvent ? classify(event.error) : 'RESOURCE_LOAD_FAILED'), true);
  addEventListener('unhandledrejection', () => report('UNHANDLED_REJECTION'));
  Object.defineProperty(globalThis, '__factoryRuntimeError', { configurable:false, writable:false, value: error => {
    const code=classify(error); if(code!=='SCRIPT_ERROR') report(code);
    report('REACT_RENDER_ERROR');
  }});
})();`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>页面预览</title><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bootstrap.js"></script><script type="module" src="/bundle.js"></script></body></html>`;
type Instance = {
  window: BrowserWindow;
  buildId: string;
  sink: Server;
  close: Promise<void>;
  result: RuntimeProbeResult;
  onIssue?: (code: RuntimeIssueCode) => void;
  revoke: () => void;
};
const OBSERVE_MS = 1200;
const HEARTBEAT_MS = 750;
const DEADLINE_MS = 12_000;
const DATA_BODY_LIMIT = APP_DATA_LIMITS.requestBytes;
const DATA_REQUEST_MS = 5000;
const DATA_RATE = 180;
const DATA_CONCURRENCY = 4;
const AI_BODY_LIMIT = 32 * 1024;
const AI_RATE = 30;
const aiError = (code: string): AppAiResponse => ({
  ok: false,
  error: { code, message: '应用 AI 请求未完成，请检查工作台中的项目授权与预算。' },
});
const unavailableAi = (mode: AppAiSession['mode']): AppAiSession => ({
  mode,
  execute: async () => aiError('APP_AI_UNAVAILABLE'),
  revoke: () => {},
});
const REQUEST_NONCE = 'x-factory-data-request';
const unavailableData = (mode: AppDataSession['mode']): AppDataSession => ({
  mode,
  execute: () => dataError('APP_DATA_UNAVAILABLE'),
  revoke: () => {},
});
const dataError = (code: string): AppDataResponse => ({
  ok: false,
  error: { code, message: '应用数据请求未完成，请检查应用状态后重试。' },
});

/** Only fixed assets and a project-bound data session are served; never a filesystem route. */
export class GeneratedPreview {
  private instances = new Map<string, Instance>();
  private applications = new Map<string, Instance>();
  private retired = new Set<Promise<void>>();
  private candidates = new Set<{
    projectId: string;
    application: boolean;
    controller: AbortController;
    done: Promise<void>;
  }>();
  constructor(
    private readonly show = true,
    private readonly dataFactory?: (
      artifact: BuildArtifact,
      mode: AppDataSession['mode'],
    ) => AppDataSession,
    private readonly aiFactory?: (
      artifact: BuildArtifact,
      mode: AppAiSession['mode'],
    ) => AppAiSession,
  ) {}
  status(projectId: string) {
    const instance = this.instances.get(projectId);
    return {
      preview: instance ? ('open' as const) : ('closed' as const),
      previewBuildId: instance?.buildId ?? null,
    };
  }
  previewWindow(projectId: string) {
    return this.instances.get(projectId)?.window;
  }
  applicationState(projectId: string): ApplicationState {
    const instance = this.applications.get(projectId);
    return {
      projectId,
      status: instance ? 'running' : 'stopped',
      buildId: instance?.buildId ?? null,
    };
  }
  applicationWindow(projectId: string) {
    return this.applications.get(projectId)?.window;
  }

  async open(
    artifact: BuildArtifact,
    runtime: string,
    onIssue?: (code: RuntimeIssueCode) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeProbeResult> {
    if (signal?.aborted) return { status: 'cancelled', issues: [], observedMs: 0 };
    // Each requested report gets a fresh observation, even for the same artifact.
    return this.launch(artifact, runtime, 'preview', onIssue, signal);
  }

  async check(
    artifact: BuildArtifact,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<RuntimeProbeResult> {
    return this.launch(artifact, runtime, 'check', undefined, signal);
  }

  async openApplication(
    artifact: BuildArtifact,
    runtime: string,
    onIssue?: (code: RuntimeIssueCode) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeProbeResult> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let done!: () => void;
    const operation = {
      projectId: artifact.projectId,
      application: true,
      controller,
      done: new Promise<void>((resolve) => {
        done = resolve;
      }),
    };
    this.candidates.add(operation);
    try {
      // A probe is disposable. Its renderer, origin and data session can never become persistent.
      const probe = await this.launch(
        artifact,
        runtime,
        'check',
        undefined,
        controller.signal,
        true,
      );
      if (probe.status !== 'observed') return probe;
      if (controller.signal.aborted) return { status: 'cancelled', issues: [], observedMs: 0 };
      return await this.launch(artifact, runtime, 'application', onIssue, controller.signal);
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.candidates.delete(operation);
      done();
    }
  }

  private async launch(
    artifact: BuildArtifact,
    runtime: string,
    purpose: 'preview' | 'check' | 'application',
    onIssue?: (code: RuntimeIssueCode) => void,
    signal?: AbortSignal,
    applicationOperation = false,
  ): Promise<RuntimeProbeResult> {
    const started = performance.now();
    const issues = new Set<RuntimeIssueCode>();
    const controller = new AbortController();
    let finishCandidate!: () => void;
    const candidate = {
      projectId: artifact.projectId,
      application: purpose === 'application' || applicationOperation,
      controller,
      done: new Promise<void>((resolve) => {
        finishCandidate = resolve;
      }),
    };
    this.candidates.add(candidate);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let wake!: () => void;
    const stopped = new Promise<void>((resolve) => {
      wake = resolve;
    });
    controller.signal.addEventListener('abort', () => wake(), { once: true });
    let instance: Instance | undefined;
    const instances = purpose === 'application' ? this.applications : this.instances;
    let accepted = false;
    let finishing = false;
    const result = (): RuntimeProbeResult => ({
      status: controller.signal.aborted ? 'cancelled' : issues.size ? 'issues' : 'observed',
      issues: [...issues],
      observedMs: Math.min(DEADLINE_MS, Math.floor(performance.now() - started)),
    });
    const report = (code: RuntimeIssueCode) => {
      if (issues.has(code)) return;
      issues.add(code);
      if (accepted && instance) {
        instance.result = { ...instance.result, status: 'issues', issues: [...issues] };
        try {
          void Promise.resolve(instance.onIssue?.(code)).catch(() => {});
        } catch {
          /* Observer failures never enter the renderer or produce unhandled rejections. */
        }
      }
      wake();
    };
    const timer = setTimeout(() => report('STARTUP_TIMEOUT'), DEADLINE_MS);
    const sockets = new Set<Socket>();
    const sink = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.destroy();
    });
    sink.on('error', () => {
      /* A listener failure never switches to a direct proxy route. */
    });
    const token = randomUUID();
    const origin = `factory-preview://${token}`;
    const isolated = session.fromPartition(`generated-${token}`, { cache: false });
    let window: BrowserWindow | undefined;
    let dataSession: AppDataSession | undefined;
    let aiSession: AppAiSession | undefined;
    let dataRevoked = false;
    const revoke = () => {
      if (dataRevoked) return;
      dataRevoked = true;
      try {
        dataSession?.revoke();
      } catch {
        /* Revocation must never prevent renderer and network teardown. */
      }
      try {
        aiSession?.revoke();
      } catch {
        /* AI cancellation cannot prevent teardown. */
      }
    };
    const dataActive = () =>
      !dataRevoked && !controller.signal.aborted && !!window && !window.isDestroyed();
    const permits = new Map<string, { id: number; url: string }>();
    const requestPermits = new Map<number, string>();
    let closed = false;
    let finishClose!: () => void;
    const close = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      revoke();
      permits.clear();
      requestPermits.clear();
      if (!accepted && !finishing && !issues.size) controller.abort();
      isolated.protocol.unhandle('factory-preview');
      void isolated.closeAllConnections().catch(() => {});
      for (const socket of sockets) socket.destroy();
      sink.close(() => finishClose());
      if (instances.get(artifact.projectId)?.window === window)
        instances.delete(artifact.projectId);
    };
    const wait = async (operation: Promise<unknown>, limit?: number): Promise<boolean> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (limit !== undefined) timeout = setTimeout(() => report('UNRESPONSIVE'), limit);
      try {
        await Promise.race([operation, stopped]);
        return !controller.signal.aborted && issues.size === 0;
      } finally {
        clearTimeout(timeout);
      }
    };
    try {
      if (controller.signal.aborted) return result();
      await new Promise<void>((resolve, reject) => {
        sink.once('error', reject);
        sink.listen(0, '127.0.0.1', () => {
          sink.removeListener('error', reject);
          resolve();
        });
      });
      const address = sink.address();
      if (!address || typeof address === 'string') throw new Error();
      // Block peer traffic as well as ordinary fetch. No DIRECT fallback/bypass list.
      if (
        !(await wait(
          isolated.setProxy({
            mode: 'fixed_servers',
            proxyRules: `socks5://127.0.0.1:${address.port}`,
            proxyBypassRules: '<-loopback>',
          }),
        ))
      )
        return result();
      isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.setDevicePermissionHandler(() => false);
      isolated.on('will-download', (event) => event.preventDefault());
      const own = (url: string) => {
        try {
          const parsed = new URL(url);
          return (
            parsed.protocol === 'factory-preview:' &&
            parsed.host === token &&
            !parsed.username &&
            !parsed.password &&
            !parsed.search &&
            !parsed.hash
          );
        } catch {
          return false;
        }
      };
      const dataUrl = `${origin}/app-data`;
      const aiUrl = `${origin}/app-ai`;
      const rpcUrl = (url: string) => url === dataUrl || url === aiUrl;
      const dataSender = (
        details: Pick<
          Electron.OnBeforeRequestListenerDetails,
          'frame' | 'webContentsId' | 'resourceType' | 'url' | 'method'
        >,
      ) => {
        if (!window || window.isDestroyed() || !dataActive()) return false;
        const frame = details.frame;
        const main = window.webContents.mainFrame;
        return (
          details.webContentsId === window.webContents.id &&
          !!frame &&
          !frame.detached &&
          frame.processId === main.processId &&
          frame.routingId === main.routingId &&
          details.resourceType === 'xhr' &&
          rpcUrl(details.url) &&
          (details.method === 'POST' || details.method === 'OPTIONS')
        );
      };
      isolated.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel:
            !window ||
            window.isDestroyed() ||
            details.webContentsId !== window.webContents.id ||
            !own(details.url) ||
            (['/app-data', '/app-ai'].includes(new URL(details.url).pathname) &&
              !dataSender(details)),
        }),
      );
      isolated.webRequest.onBeforeSendHeaders((details, callback) => {
        if (!rpcUrl(details.url)) return callback({});
        if (!dataSender(details) || permits.size >= DATA_RATE) return callback({ cancel: true });
        const headers = { ...details.requestHeaders };
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === REQUEST_NONCE) delete headers[key];
        const prior = requestPermits.get(details.id);
        if (prior) permits.delete(prior);
        const nonce = randomUUID();
        permits.set(nonce, { id: details.id, url: details.url });
        requestPermits.set(details.id, nonce);
        headers[REQUEST_NONCE] = nonce;
        callback({ requestHeaders: headers });
      });
      const clearPermit = (details: { id: number }) => {
        const nonce = requestPermits.get(details.id);
        if (nonce) permits.delete(nonce);
        requestPermits.delete(details.id);
      };
      isolated.webRequest.onCompleted(clearPermit);
      isolated.webRequest.onErrorOccurred(clearPermit);
      const assets: Record<string, { body: string; type: string }> = {
        '/index.html': { body: html, type: 'text/html; charset=utf-8' },
        '/bootstrap.js': { body: bootstrap, type: 'text/javascript; charset=utf-8' },
        '/bundle.js': { body: artifact.javascript, type: 'text/javascript; charset=utf-8' },
        '/bundle.css': { body: artifact.css, type: 'text/css; charset=utf-8' },
        '/runtime.js': { body: runtime, type: 'text/javascript; charset=utf-8' },
        '/data.js': { body: APP_DATA_SDK_SOURCE, type: 'text/javascript; charset=utf-8' },
        '/ai.js': { body: APP_AI_SDK_SOURCE, type: 'text/javascript; charset=utf-8' },
      };
      let aiRequests = 0;
      let aiPeriod = Date.now();
      let aiActive = false;
      let dataRequests = 0;
      let dataPeriod = Date.now();
      let activeRequests = 0;
      const response = (value: AppDataResponse | AppAiResponse, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Referrer-Policy': 'no-referrer',
          },
        });
      isolated.protocol.handle('factory-preview', async (request) => {
        if (request.url === aiUrl) {
          const nonce = request.headers.get(REQUEST_NONCE);
          const permit = nonce ? permits.get(nonce) : undefined;
          if (!permit || permit.url !== request.url || !dataActive())
            return response(aiError('APP_AI_FORBIDDEN'), 403);
          permits.delete(nonce!);
          requestPermits.delete(permit.id);
          if (request.method === 'OPTIONS')
            return new Response(null, {
              status: 204,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST',
                'Access-Control-Allow-Headers': 'content-type',
                'Access-Control-Max-Age': '0',
                'Cache-Control': 'no-store',
              },
            });
          if (
            request.method !== 'POST' ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
              request.headers.get('content-type') ?? '',
            )
          )
            return response(aiError('APP_AI_INVALID'), 400);
          if (Date.now() - aiPeriod >= 60_000) {
            aiPeriod = Date.now();
            aiRequests = 0;
          }
          if (++aiRequests > AI_RATE || aiActive) return response(aiError('APP_AI_RATE_LIMIT'));
          const length = request.headers.get('content-length');
          if (length && (!/^\d+$/u.test(length) || Number(length) > AI_BODY_LIMIT))
            return response(aiError('APP_AI_LIMIT'), 413);
          aiActive = true;
          const reader = request.body?.getReader();
          let bodyTimer: ReturnType<typeof setTimeout> | undefined;
          let bodyAccepted = false;
          try {
            const read = async () => {
              if (!reader) throw new Error();
              const chunks: Uint8Array[] = [];
              let bytes = 0;
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > AI_BODY_LIMIT) throw new AppError('APP_AI_LIMIT', 'AI request limit');
                chunks.push(chunk.value);
              }
              return JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
              ) as unknown;
            };
            const input = await Promise.race([
              read(),
              new Promise<never>((_resolve, reject) => {
                bodyTimer = setTimeout(() => reject(new Error()), DATA_REQUEST_MS);
              }),
            ]);
            clearTimeout(bodyTimer);
            if (!dataActive()) return response(aiError('APP_AI_REVOKED'));
            if (!input || typeof input !== 'object' || Array.isArray(input))
              return response(aiError('APP_AI_INVALID'), 400);
            const object = input as Record<string, unknown>;
            if (
              object.schemaVersion !== 1 ||
              Object.keys(object).some(
                (key) => !['schemaVersion', 'requestId', 'text'].includes(key),
              ) ||
              typeof object.requestId !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
                object.requestId,
              ) ||
              typeof object.text !== 'string' ||
              !object.text.trim()
            )
              return response(aiError('APP_AI_INVALID'), 400);
            // Probe renderers can never enter the model execution path, even with a supplied factory.
            if (aiSession!.mode !== 'persistent') return response(aiError('APP_AI_DISABLED'));
            bodyAccepted = true;
            const value = await aiSession!.execute(input);
            // Closing/replacing the renderer revokes its AI session and suppresses late results.
            return response(dataActive() ? value : aiError('APP_AI_REVOKED'));
          } catch (error) {
            if (error instanceof AppError && error.code === 'APP_AI_LIMIT')
              return response(aiError('APP_AI_LIMIT'), 413);
            return bodyAccepted
              ? response(aiError('APP_AI_UNAVAILABLE'))
              : response(aiError('APP_AI_INVALID'), 400);
          } finally {
            clearTimeout(bodyTimer);
            void reader?.cancel().catch(() => {});
            aiActive = false;
          }
        }
        if (request.url === dataUrl) {
          const nonce = request.headers.get(REQUEST_NONCE);
          const permit = nonce ? permits.get(nonce) : undefined;
          if (!permit || permit.url !== request.url || !dataActive())
            return response(dataError('APP_DATA_FORBIDDEN'), 403);
          permits.delete(nonce!);
          requestPermits.delete(permit.id);
          if (request.method === 'OPTIONS') {
            return new Response(null, {
              status: 204,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST',
                'Access-Control-Allow-Headers': 'content-type',
                'Access-Control-Max-Age': '0',
                'Cache-Control': 'no-store',
              },
            });
          }
          if (
            request.method !== 'POST' ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
              request.headers.get('content-type') ?? '',
            )
          )
            return response(dataError('APP_DATA_INVALID'), 400);
          if (Date.now() - dataPeriod >= 60_000) {
            dataPeriod = Date.now();
            dataRequests = 0;
          }
          if (++dataRequests > DATA_RATE || activeRequests >= DATA_CONCURRENCY)
            return response(dataError('APP_DATA_RATE_LIMIT'), 429);
          const length = request.headers.get('content-length');
          if (length && (!/^\d+$/u.test(length) || Number(length) > DATA_BODY_LIMIT))
            return response(dataError('APP_DATA_LIMIT'), 413);
          activeRequests++;
          const reader = request.body?.getReader();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const body = async () => {
              const chunks: Uint8Array[] = [];
              let bytes = 0;
              if (!reader) throw new Error();
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > DATA_BODY_LIMIT) throw new Error();
                chunks.push(chunk.value);
              }
              return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            };
            const input = await Promise.race([
              body(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error()), DATA_REQUEST_MS);
              }),
            ]);
            // Body parsing is asynchronous; a closed or replaced session can never execute later.
            if (!dataActive()) return response(dataError('APP_DATA_REVOKED'), 409);
            if (!input || typeof input !== 'object' || Array.isArray(input))
              return response(dataError('APP_DATA_INVALID'), 400);
            const object = input as Record<string, unknown>;
            const fields =
              object.operation === 'read'
                ? ['schemaVersion', 'operation']
                : ['schemaVersion', 'operation', 'requestId', 'expectedRevision', 'changes'];
            if (
              object.schemaVersion !== 1 ||
              (object.operation !== 'read' && object.operation !== 'apply') ||
              Object.keys(object).some((key) => !fields.includes(key))
            )
              return response(dataError('APP_DATA_INVALID'), 400);
            // Synchronous execute performs its own final plan/archive/CAS checks before committing.
            return response(dataSession!.execute(input));
          } catch {
            return response(dataError('APP_DATA_INVALID'), 400);
          } finally {
            clearTimeout(timer);
            void reader?.cancel().catch(() => {});
            activeRequests--;
          }
        }
        const asset =
          own(request.url) && request.method === 'GET'
            ? assets[new URL(request.url).pathname]
            : undefined;
        if (!asset) return new Response('Not found', { status: 404 });
        return new Response(asset.body, {
          headers: {
            'Content-Type': asset.type,
            'Content-Security-Policy': csp(origin),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Access-Control-Allow-Origin': '*',
            'Permissions-Policy':
              'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), bluetooth=(), serial=(), payment=()',
          },
        });
      });
      const dataMode = purpose === 'application' ? 'persistent' : 'temporary';
      dataSession = this.dataFactory?.(artifact, dataMode) ?? unavailableData(dataMode);
      aiSession = this.aiFactory?.(artifact, dataMode) ?? unavailableAi(dataMode);
      if (dataSession.mode !== dataMode || aiSession.mode !== dataMode) throw new Error();
      window = new BrowserWindow({
        width: 1120,
        height: 800,
        minWidth: 640,
        minHeight: 480,
        show: false,
        title:
          purpose === 'application'
            ? `本地应用 · 源码版本 ${artifact.sourceRevision} · 数据保存在本机`
            : `页面预览 · 源码版本 ${artifact.sourceRevision} · 关闭后临时数据不保留`,
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        webPreferences: {
          session: isolated,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          webviewTag: false,
          navigateOnDragDrop: false,
          spellcheck: false,
          safeDialogs: true,
          disableDialogs: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
      window.webContents.on('will-redirect', (event) => event.preventDefault());
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      window.webContents.on('page-title-updated', (event) => event.preventDefault());
      window.webContents.on('will-prevent-unload', (event) => event.preventDefault());
      window.webContents.on('console-message', (details) => {
        const message = details.message;
        if (
          typeof message === 'string' &&
          message.length <= 64 &&
          message.startsWith(ISSUE_MARKER)
        ) {
          const code = message.slice(ISSUE_MARKER.length);
          if (Object.hasOwn(runtimeIssueMessages, code)) {
            report(code as RuntimeIssueCode);
            return;
          }
        }
        if (details.level === 'error') report('CONSOLE_ERROR');
      });
      window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame && !finishing && !controller.signal.aborted) report('RESOURCE_LOAD_FAILED');
      });
      window.webContents.on('render-process-gone', () => {
        if (!finishing && !closed) report('RENDERER_GONE');
        window?.destroy();
      });
      window.on('unresponsive', () => {
        if (!finishing && !closed) report('UNRESPONSIVE');
        window?.destroy();
      });
      window.on('closed', cleanup);
      // This is an explicit user application launch, never a hidden check with real data access.
      if (purpose === 'application' && this.show) window.show();
      const loaded = window.loadURL(`${origin}/index.html`).catch(() => {
        if (!controller.signal.aborted && !issues.size) report('RESOURCE_LOAD_FAILED');
      });
      if (!(await wait(loaded))) return result();
      const heartbeat = async () => {
        if (!window || window.isDestroyed()) {
          report('RENDERER_GONE');
          return false;
        }
        const probe = window.webContents
          .executeJavaScriptInIsolatedWorld(43, [{ code: 'true' }])
          .then((value) => {
            if (value !== true) report('UNRESPONSIVE');
          })
          .catch(() => {
            if (!controller.signal.aborted && !issues.size) report('UNRESPONSIVE');
          });
        return wait(probe, HEARTBEAT_MS);
      };
      if (!(await heartbeat())) return result();
      let observation: ReturnType<typeof setTimeout> | undefined;
      try {
        if (
          !(await wait(
            new Promise<void>((resolve) => {
              observation = setTimeout(resolve, OBSERVE_MS);
            }),
          ))
        )
          return result();
      } finally {
        clearTimeout(observation);
      }
      if (!(await heartbeat())) return result();
      const observed = result();
      if (purpose === 'check') return observed;
      const existing = instances.get(artifact.projectId);
      if (controller.signal.aborted || issues.size || window.isDestroyed()) return result();
      instance = { window, buildId: artifact.id, sink, close, result: observed, onIssue, revoke };
      instances.set(artifact.projectId, instance);
      accepted = true;
      if (existing && existing.window !== window) {
        existing.revoke();
        this.retired.add(existing.close);
        void existing.close.then(() => this.retired.delete(existing.close));
        existing.window.destroy();
      }
      if (this.show && purpose !== 'application') window.show();
      return observed;
    } catch {
      if (controller.signal.aborted || issues.size) return result();
      throw new AppError('PREVIEW_FAILED', '页面预览未能打开，构建产物已保留。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (!accepted) {
        finishing = true;
        window?.destroy();
        cleanup();
        await close;
      }
      this.candidates.delete(candidate);
      finishCandidate();
    }
  }
  async stop(projectId: string) {
    const candidates = [...this.candidates].filter(
      (item) => item.projectId === projectId && !item.application,
    );
    for (const candidate of candidates) candidate.controller.abort();
    await Promise.all(candidates.map((item) => item.done));
    const instance = this.instances.get(projectId);
    if (instance) {
      instance.revoke();
      instance.window.destroy();
      await instance.close;
    }
  }
  async stopApplication(projectId: string) {
    const candidates = [...this.candidates].filter(
      (item) => item.projectId === projectId && item.application,
    );
    for (const candidate of candidates) candidate.controller.abort();
    await Promise.all(candidates.map((item) => item.done));
    const instance = this.applications.get(projectId);
    if (instance) {
      instance.revoke();
      instance.window.destroy();
      await instance.close;
    }
  }
  async stopAll() {
    const candidates = [...this.candidates];
    for (const candidate of candidates) candidate.controller.abort();
    await Promise.all(candidates.map((item) => item.done));
    for (const id of [...this.instances.keys()]) await this.stop(id);
    for (const id of [...this.applications.keys()]) await this.stopApplication(id);
    await Promise.all(this.retired);
  }
}
