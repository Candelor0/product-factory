import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlogStore } from './blog-store';
import { AppError } from './validation';

export const PREVIEW_HEADER = 'x-factory-preview';
const MAX_BODY = 256 * 1024;
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw new AppError('INVALID_INPUT', '请求内容必须为JSON。');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new AppError('PAYLOAD_TOO_LARGE', '文章内容过长，请缩短后重试。');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_INPUT', '文章内容格式不正确。');
  }
}

/** A trusted, fixed CRUD service. No generated backend, shell, filesystem route or model access. */
export async function createBlogServer(options: {
  projectDirectory: string;
  assetsDirectory: string;
  assertWritable?: () => void;
}) {
  const store = new BlogStore(options.projectDirectory);
  store.list(); // Fail before listening when existing data is unreadable.
  const assets = new Map<string, { content: Buffer; type: string }>();
  for (const [route, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ]) {
    const path = join(options.assetsDirectory, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw new AppError('TEMPLATE_INVALID', '博客样例资源无效，请重新安装此版本。');
    assets.set(route, { content: readFileSync(path), type });
  }
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  let origin = '';
  let windowStart = Date.now();
  let requestCount = 0;
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), usb=(), payment=()',
    );
    void (async () => {
      const provided = req.headers[PREVIEW_HEADER];
      const authenticated =
        typeof provided === 'string' &&
        Buffer.byteLength(provided) === tokenBytes.length &&
        timingSafeEqual(Buffer.from(provided), tokenBytes);
      const fetchSite = req.headers['sec-fetch-site'];
      if (
        !authenticated ||
        req.headers.host !== origin.slice('http://'.length) ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')
      ) {
        json(res, 403, {
          ok: false,
          error: { code: 'FORBIDDEN', message: '仅能从当前项目的预览窗口访问。' },
        });
        return;
      }
      if (Date.now() - windowStart >= 60_000) {
        windowStart = Date.now();
        requestCount = 0;
      }
      if (++requestCount > 180) {
        json(res, 429, {
          ok: false,
          error: { code: 'RATE_LIMIT', message: '操作过于频繁，请稍后重试。' },
        });
        return;
      }
      const route = req.url ?? '';
      const asset = assets.get(route);
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'Content-Type': asset.type });
        res.end(asset.content);
        return;
      }
      if (req.method === 'GET' && route === '/api/articles') {
        json(res, 200, { ok: true, value: store.list() });
        return;
      }
      const update = /^\/api\/articles\/([a-f0-9-]{36})$/.exec(route);
      if (
        (req.method === 'POST' && route === '/api/articles') ||
        (req.method === 'PUT' && update)
      ) {
        if (req.headers.origin !== origin) {
          json(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '写入来源不正确。' } });
          return;
        }
        const length = Number(req.headers['content-length'] ?? 0);
        if (!Number.isFinite(length) || length > MAX_BODY)
          throw new AppError('PAYLOAD_TOO_LARGE', '文章内容过长，请缩短后重试。');
        const input = await body(req);
        options.assertWritable?.();
        const value = update
          ? store.update(update[1], input as never)
          : store.create(input as never);
        json(res, update ? 200 : 201, { ok: true, value });
        return;
      }
      json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '此操作不可用。' } });
    })().catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      const safe =
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : {
              code: 'STORAGE_ERROR',
              message: '未能保存文章，原数据已保留。请检查可用空间后重试。',
            };
      const status =
        safe.code === 'PAYLOAD_TOO_LARGE'
          ? 413
          : /CONFLICT|STALE/.test(safe.code)
            ? 409
            : safe.code === 'INVALID_INPUT'
              ? 400
              : 500;
      json(res, status, { ok: false, error: safe });
    });
  });
  server.maxConnections = 20;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new AppError('START_FAILED', '无法启动博客样例。');
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  return { origin, token, close };
}
