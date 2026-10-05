import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { APP_DATA_SDK_SOURCE } from '../src/main/app-data-sdk';
import type {
  AppDataApplyRequest,
  AppDataApplyResult,
  AppDataSnapshot,
} from '../src/shared/app-data-contracts';

function client(fetcher: (url: URL, init: RequestInit) => Promise<unknown>) {
  const source = APP_DATA_SDK_SOURCE.replace(
    'import.meta.url',
    JSON.stringify('factory-preview://isolated/data.js'),
  ).replace('export const appData', 'globalThis.appData');
  const context: {
    fetch: typeof fetcher;
    URL: typeof URL;
    appData?: {
      read(): Promise<AppDataSnapshot>;
      apply(input: AppDataApplyRequest): Promise<AppDataApplyResult>;
    };
  } = { fetch: fetcher, URL };
  runInNewContext(source, context);
  return context.appData!;
}
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });
const request: AppDataApplyRequest = {
  requestId: '12345678-1234-4234-8234-123456789012',
  expectedRevision: 2,
  changes: [{ operation: 'put', key: 'posts', value: [{ title: '用户内容' }] }],
};

test('SDK is browser ESM and read posts only its fixed same-origin protocol without credentials', async () => {
  assert.doesNotThrow(() =>
    parse(APP_DATA_SDK_SOURCE, { ecmaVersion: 'latest', sourceType: 'module' }),
  );
  let calls = 0;
  const sdk = client(async (url, init) => {
    calls++;
    assert.equal(url.href, 'factory-preview://isolated/app-data');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body as string), { schemaVersion: 1, operation: 'read' });
    return response({ ok: true, value: { revision: 2, values: { posts: [] } } });
  });
  assert.equal((await sdk.read()).revision, 2);
  assert.equal(calls, 1);
});

test('apply preserves caller request IDs and receipt revisions, and cannot override its operation', async () => {
  const sent: unknown[] = [];
  const sdk = client(async (_url, init) => {
    sent.push(JSON.parse(init.body as string));
    return response({ ok: true, value: { revision: 4, appliedRevision: 3, replayed: true } });
  });
  const result = await sdk.apply({
    ...request,
    operation: 'read',
    schemaVersion: 99,
  } as AppDataApplyRequest);
  assert.equal(result.replayed, true);
  assert.equal(result.revision, 4);
  assert.equal(result.appliedRevision, 3);
  assert.deepEqual(sent, [{ schemaVersion: 1, operation: 'apply', ...request }]);
});

test('CAS rejection preserves fixed server code and message without automatically retrying', async () => {
  let calls = 0;
  const sdk = client(async () => {
    calls++;
    return response(
      {
        ok: false,
        error: { code: 'APP_DATA_CONFLICT', message: '内容已变化，请重新读取并核对。' },
      },
      false,
    );
  });
  await assert.rejects(sdk.apply(request), {
    code: 'APP_DATA_CONFLICT',
    message: '内容已变化，请重新读取并核对。',
  });
  assert.equal(calls, 1);
});

test('unknown network result is explicit and an explicit retry uses the exact original request', async () => {
  const bodies: string[] = [];
  const sdk = client(async (_url, init) => {
    bodies.push(init.body as string);
    if (bodies.length === 1) throw new Error('private transport details');
    return response({ ok: true, value: { revision: 3, appliedRevision: 3, replayed: true } });
  });
  await assert.rejects(sdk.apply(request), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'APP_DATA_NETWORK');
    assert.equal(String(error).includes('private transport details'), false);
    return true;
  });
  assert.equal(bodies.length, 1);
  await sdk.apply(request);
  assert.equal(bodies[0], bodies[1]);
});

test('malformed responses and unserializable input never masquerade as a confirmed save', async () => {
  for (const value of [
    null,
    { ok: true, value: {} },
    { ok: true, value: { revision: 3, appliedRevision: 4, replayed: false } },
    { ok: false, error: { code: 'raw private error', message: 'raw details' } },
  ]) {
    const sdk = client(async () => response(value));
    await assert.rejects(sdk.apply(request), { code: 'APP_DATA_RESPONSE' });
  }
  const sdk = client(async () => assert.fail('invalid input must not be sent'));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(
    sdk.apply({
      ...request,
      changes: [{ operation: 'put', key: 'posts', value: cyclic as never }],
    }),
    { code: 'APP_DATA_INVALID_INPUT' },
  );
  for (const value of [NaN, Infinity, undefined, { title: undefined }, [undefined]]) {
    await assert.rejects(
      sdk.apply({
        ...request,
        changes: [{ operation: 'put', key: 'posts', value: value as never }],
      }),
      { code: 'APP_DATA_INVALID_INPUT' },
    );
  }
});
