import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBlogServer, PREVIEW_HEADER } from '../src/main/blog-server.js';
import { ProjectStore } from '../src/main/project-store.js';
import type { BlogArticle, BlogArticleInput } from '../src/shared/blog-contracts.js';

type RunningServer = Awaited<ReturnType<typeof createBlogServer>>;
type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
type RequestOptions = {
  path?: string;
  method?: string;
  token?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
  raw?: string;
  value?: unknown;
  chunked?: boolean;
};

const article = (body = '第一段\n\n保留换行与缩进。'): BlogArticleInput => ({
  title: '独立HTTP测试文章',
  body,
  tags: ['测试', '本地'],
  status: 'draft',
});

/** Real loopback requests; capability values are never printed or used in assertion messages. */
function send(server: RunningServer, options: RequestOptions = {}): Promise<Reply> {
  const endpoint = new URL(server.origin);
  const headers: Record<string, string> = {};
  if (options.token !== null) headers[PREVIEW_HEADER] = options.token ?? server.token;
  if (options.origin !== null) headers.Origin = options.origin ?? server.origin;
  const raw =
    options.raw ?? (options.value === undefined ? undefined : JSON.stringify(options.value));
  if (raw !== undefined) headers['Content-Type'] = 'application/json';
  Object.assign(headers, options.headers);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: options.path ?? '/api/articles',
        method: options.method ?? 'GET',
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.setTimeout(3_000, () => req.destroy(new Error('Synthetic HTTP request timed out')));
    req.on('error', reject);
    if (raw !== undefined && options.chunked) {
      for (let i = 0; i < raw.length; i += 16_384) req.write(raw.slice(i, i + 16_384));
      req.end();
    } else req.end(raw);
  });
}

function parsed(reply: Reply): any {
  return JSON.parse(reply.text);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-blog-http-'));
  const projects = new ProjectStore(join(root, '工作台'));
  const assetsDirectory = join(root, 'fixed-assets');
  mkdirSync(assetsDirectory);
  writeFileSync(
    join(assetsDirectory, 'index.html'),
    '<!doctype html><p>HTTP synthetic fixture</p>',
  );
  writeFileSync(join(assetsDirectory, 'app.js'), 'globalThis.syntheticFixture = true;');
  writeFileSync(join(assetsDirectory, 'styles.css'), 'body { color: #163d2e; }');
  const servers: RunningServer[] = [];
  t.after(async () => {
    await Promise.all(servers.map((server) => server.close()));
    rmSync(root, { recursive: true, force: true });
  });
  const project = () => {
    const item = projects.create({ name: 'HTTP合成博客', idea: '仅用于离线服务边界检查' });
    return join(projects.rootPath, 'projects', item.id);
  };
  const start = async (projectDirectory = project()) => {
    const server = await createBlogServer({ projectDirectory, assetsDirectory });
    servers.push(server);
    return {
      server,
      projectDirectory,
      file: join(projectDirectory, 'data', 'blog', 'articles.json'),
    };
  };
  return { start };
}

test('blog HTTP serves only fixed assets with restrictive response headers', async (t) => {
  const { server } = await fixture(t).start();
  assert.equal(new URL(server.origin).hostname, '127.0.0.1');
  for (const [path, type] of [
    ['/', 'text/html'],
    ['/app.js', 'text/javascript'],
    ['/styles.css', 'text/css'],
  ]) {
    const reply = await send(server, { path, origin: null });
    assert.equal(reply.status, 200);
    assert.ok(reply.headers['content-type']?.startsWith(type));
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal(reply.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(reply.headers['x-frame-options'], 'DENY');
    assert.match(String(reply.headers['content-security-policy']), /worker-src 'none'/);
    assert.match(String(reply.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(reply.headers['access-control-allow-origin'], undefined);
    assert.equal(
      reply.text.includes(server.token),
      false,
      'capability must not appear in asset bodies',
    );
  }
  const list = await send(server);
  assert.deepEqual(parsed(list), { ok: true, value: [] });
});

test('blog HTTP rejects absent, wrong and malformed capabilities even for static assets', async (t) => {
  const { server } = await fixture(t).start();
  for (const token of [null, '', 'x'.repeat(64), 'x'.repeat(63), 'x'.repeat(65)]) {
    for (const path of ['/', '/api/articles']) {
      const reply = await send(server, { path, token });
      assert.equal(reply.status, 403);
      assert.equal(parsed(reply).error.code, 'FORBIDDEN');
      assert.equal(reply.text.includes(server.token), false);
    }
  }
});

test('blog HTTP checks exact Host, Origin and fetch-site instead of trusting loopback clients', async (t) => {
  const { server } = await fixture(t).start();
  const port = new URL(server.origin).port;
  for (const host of [
    `localhost:${port}`,
    '127.0.0.1:1',
    `evil.invalid:${port}`,
    `127.0.0.1:${port}.evil.invalid`,
  ]) {
    assert.equal((await send(server, { headers: { Host: host } })).status, 403);
  }
  for (const origin of [
    'null',
    'https://evil.invalid',
    `http://localhost:${port}`,
    `${server.origin}/`,
  ]) {
    assert.equal((await send(server, { origin })).status, 403);
  }
  for (const site of ['cross-site', 'same-site', 'malformed']) {
    assert.equal((await send(server, { headers: { 'Sec-Fetch-Site': site } })).status, 403);
  }
  assert.equal((await send(server, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
});

test('blog HTTP write requests require their own Origin and leave data unchanged on rejection', async (t) => {
  const { server } = await fixture(t).start();
  for (const origin of [null, 'null', 'https://evil.invalid']) {
    const reply = await send(server, { method: 'POST', origin, value: article() });
    assert.equal(reply.status, 403);
  }
  assert.deepEqual(parsed(await send(server)).value, []);
});

test('blog HTTP rejects raw traversal, alternate files and query routes without exposing files', async (t) => {
  const { server } = await fixture(t).start();
  for (const path of [
    '/../project.json',
    '/%2e%2e/project.json',
    '/%2e%2e%2fproject.json',
    '/..\\project.json',
    '//api/articles',
    '/api/articles?projectId=other',
    '/index.html',
    '/package.json',
    '/app.js.map',
    '/api/articles/../../credentials/provider.json',
    '/api/articles/%2fetc%2fpasswd',
    `${server.origin}/api/articles`,
  ]) {
    const reply = await send(server, { path });
    assert.equal(reply.status, 404, `unavailable route ${path}`);
    assert.equal(parsed(reply).error.code, 'NOT_FOUND');
  }
});

test('blog HTTP denies unsupported methods and cross-origin preflight without mutations', async (t) => {
  const { server } = await fixture(t).start();
  for (const method of ['DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
    const reply = await send(server, { method, value: article() });
    assert.equal(reply.status, 404, method);
  }
  const preflight = await send(server, {
    method: 'OPTIONS',
    token: null,
    origin: 'https://evil.invalid',
    headers: { 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(parsed(await send(server)).value, []);
});

test('blog HTTP validates JSON, content type, input fields and field limits before persisting', async (t) => {
  const { server } = await fixture(t).start();
  for (const raw of ['', '{', 'null', '[]', '"plain text"']) {
    assert.equal((await send(server, { method: 'POST', raw })).status, 400);
  }
  assert.equal(
    (
      await send(server, {
        method: 'POST',
        value: article(),
        headers: { 'Content-Type': 'text/plain' },
      })
    ).status,
    400,
  );
  for (const value of [
    { ...article(), title: '' },
    { ...article(), title: 'x'.repeat(161) },
    { ...article(), body: 'x'.repeat(60_001) },
    { ...article(), body: 12 },
    { ...article(), tags: Array.from({ length: 21 }, (_, i) => String(i)) },
    { ...article(), tags: ['x'.repeat(33)] },
    { ...article(), tags: ['same', 'same'] },
    { ...article(), status: 'remote' },
    { ...article(), projectId: randomUUID() },
    { ...article(), revision: 1 },
  ]) {
    const reply = await send(server, { method: 'POST', value });
    assert.equal(reply.status, 400);
    assert.equal(parsed(reply).error.code, 'INVALID_INPUT');
  }
  assert.deepEqual(parsed(await send(server)).value, []);
});

test('blog HTTP enforces a 256 KiB declared payload ceiling without waiting for the body', async (t) => {
  const { server } = await fixture(t).start();
  const reply = await send(server, {
    method: 'POST',
    raw: '{}',
    headers: { 'Content-Length': String(256 * 1024 + 1) },
  });
  assert.equal(reply.status, 413);
  assert.equal(parsed(reply).error.code, 'PAYLOAD_TOO_LARGE');
  assert.deepEqual(parsed(await send(server)).value, []);
});

test('blog HTTP enforces actual chunked body bytes rather than only Content-Length', async (t) => {
  const { server } = await fixture(t).start();
  const reply = await send(server, {
    method: 'POST',
    raw: JSON.stringify(article('x'.repeat(256 * 1024))),
    chunked: true,
  });
  assert.equal(reply.status, 413);
  assert.equal(parsed(reply).error.code, 'PAYLOAD_TOO_LARGE');
  assert.deepEqual(parsed(await send(server)).value, []);
});

test('blog HTTP supports article changes and rejects stale writes while retaining the winning revision', async (t) => {
  const { server, file } = await fixture(t).start();
  const input = article('<script>globalThis.shouldNotExecute = true</script>\n纯文本正文');
  const created = await send(server, { method: 'POST', value: input });
  assert.equal(created.status, 201);
  const first = parsed(created).value as BlogArticle;
  assert.equal(first.revision, 1);
  assert.equal(
    first.body,
    input.body,
    'service preserves text; HTML rendering is tested separately',
  );
  const changed = {
    ...article('更新后的正文'),
    title: '本地发布文章',
    status: 'published',
    revision: first.revision,
  };
  const updated = await send(server, {
    method: 'PUT',
    path: `/api/articles/${first.id}`,
    value: changed,
  });
  assert.equal(updated.status, 200);
  assert.equal(parsed(updated).value.revision, 2);
  const saved = readFileSync(file, 'utf8');
  const stale = await send(server, {
    method: 'PUT',
    path: `/api/articles/${first.id}`,
    value: changed,
  });
  assert.equal(stale.status, 409);
  assert.equal(
    readFileSync(file, 'utf8'),
    saved,
    'stale mutation does not replace persisted content',
  );
  const result = parsed(await send(server)).value;
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'published');
  assert.equal(result[0].body, changed.body);
});

test('blog HTTP capabilities and business data remain separate across running projects', async (t) => {
  const f = fixture(t);
  const a = await f.start();
  const b = await f.start();
  assert.ok(
    a.server.token !== b.server.token,
    'each running instance must have a unique capability',
  );
  assert.equal((await send(a.server, { method: 'POST', value: article('项目A') })).status, 201);
  assert.equal((await send(b.server, { token: a.server.token })).status, 403);
  assert.equal(
    (await send(a.server, { token: b.server.token, method: 'POST', value: article('禁止跨写') }))
      .status,
    403,
  );
  assert.deepEqual(parsed(await send(b.server)).value, []);
  assert.equal(parsed(await send(a.server)).value[0].body, '项目A');
});

test('blog HTTP persistence survives server restart and old capabilities expire', async (t) => {
  const f = fixture(t);
  const first = await f.start();
  const created = await send(first.server, { method: 'POST', value: article('重启后保留的数据') });
  assert.equal(created.status, 201);
  const before = readFileSync(first.file, 'utf8');
  await first.server.close();
  await first.server.close();
  await assert.rejects(
    send(first.server),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED',
  );
  const second = await f.start(first.projectDirectory);
  assert.ok(first.server.token !== second.server.token, 'restart rotates the capability');
  assert.equal((await send(second.server, { token: first.server.token })).status, 403);
  assert.deepEqual(parsed(await send(second.server)).value, [parsed(created).value]);
  assert.equal(readFileSync(first.file, 'utf8'), before);
});

test('blog HTTP rate limit rejects an authenticated burst without changing article data', async (t) => {
  const { server, file } = await fixture(t).start();
  assert.equal(
    (await send(server, { method: 'POST', value: article('已保存的原始文章') })).status,
    201,
  );
  const before = readFileSync(file, 'utf8');
  for (let i = 0; i < 179; i++) assert.equal((await send(server)).status, 200);
  const reply = await send(server, { method: 'POST', value: article() });
  assert.equal(reply.status, 429);
  assert.equal(parsed(reply).error.code, 'RATE_LIMIT');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('blog HTTP remains usable after a client aborts a partial JSON upload', async (t) => {
  const { server } = await fixture(t).start();
  const endpoint = new URL(server.origin);
  await new Promise<void>((resolve, reject) => {
    const req = request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: '/api/articles',
      method: 'POST',
      agent: false,
      headers: {
        [PREVIEW_HEADER]: server.token,
        Origin: server.origin,
        'Content-Type': 'application/json',
      },
    });
    const deadline = setTimeout(() => {
      req.destroy();
      reject(new Error('Aborted client did not close'));
    }, 1_000);
    req.on('error', () => {
      /* Expected local cancellation. */
    });
    req.on('close', () => {
      clearTimeout(deadline);
      resolve();
    });
    req.on('socket', (socket) =>
      socket.once('connect', () => {
        req.write('{"title":"incomplete');
        setTimeout(() => req.destroy(), 20);
      }),
    );
  });
  assert.deepEqual(parsed(await send(server)).value, []);
  assert.equal(
    (await send(server, { method: 'POST', value: article('中断后可正常保存') })).status,
    201,
  );
});
