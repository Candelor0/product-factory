import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { APP_AI_SDK_SOURCE } from '../src/main/app-ai-sdk';

const input = { requestId: '12345678-1234-4234-8234-123456789012', text: '合成输入' };
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });
function client(fetcher: (url: URL, init: RequestInit) => Promise<unknown>) {
  const source = APP_AI_SDK_SOURCE.replace(
    'import.meta.url',
    JSON.stringify('factory-preview://isolated/ai.js'),
  )
    .replace('export async function generateText', 'async function generateText')
    .replace('export const appAi', 'globalThis.appAi');
  const context = {
    fetch: fetcher,
    URL,
    TextEncoder,
    appAi: undefined as unknown as { generateText(input: unknown): Promise<string> },
  };
  runInNewContext(source, context);
  return context.appAi;
}
test('AI SDK is browser ESM and sends only fixed request fields to its credential-free origin', async () => {
  parse(APP_AI_SDK_SOURCE, { ecmaVersion: 'latest', sourceType: 'module' });
  let count = 0;
  const sdk = client(async (url, init) => {
    count++;
    assert.equal(url.href, 'factory-preview://isolated/app-ai');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(JSON.parse(init.body as string), { schemaVersion: 1, ...input });
    return response({ ok: true, value: { text: '合成回复' } });
  });
  assert.equal(
    await sdk.generateText({ ...input, model: 'forged', projectId: 'other', schemaVersion: 99 }),
    '合成回复',
  );
  assert.equal(count, 1);
});
test('AI SDK preserves fixed authorization failure and performs no automatic retry', async () => {
  let count = 0;
  const sdk = client(async () => {
    count++;
    return response({
      ok: false,
      error: { code: 'APP_AI_DISABLED', message: '当前会话不能使用 AI。' },
    });
  });
  await assert.rejects(sdk.generateText(input), {
    code: 'APP_AI_DISABLED',
    message: '当前会话不能使用 AI。',
  });
  assert.equal(count, 1);
});
test('unknown transport results stay unknown and explicit retry preserves exact caller request', async () => {
  const bodies: string[] = [];
  const sdk = client(async (_url, init) => {
    bodies.push(init.body as string);
    if (bodies.length === 1) throw new Error('private synthetic transport detail');
    return response({ ok: true, value: { text: 'result' } });
  });
  await assert.rejects(
    sdk.generateText(input),
    (e: unknown) =>
      (e as { code: string }).code === 'APP_AI_NETWORK' && !String(e).includes('private'),
  );
  assert.equal(bodies.length, 1);
  await sdk.generateText(input);
  assert.equal(bodies[0], bodies[1]);
});
test('invalid and oversized input is never sent', async () => {
  const sdk = client(async () => assert.fail('invalid request reached transport'));
  for (const value of [
    null,
    {},
    { ...input, requestId: '../x' },
    { ...input, requestId: '12345678-1234-1234-8234-123456789012' },
    { ...input, requestId: '12345678-1234-7234-8234-123456789012' },
    { ...input, text: '' },
    { ...input, text: ' '.repeat(4) },
    { ...input, text: '中'.repeat(12_000) },
    { ...input, text: 7 },
  ])
    await assert.rejects(sdk.generateText(value), { code: 'APP_AI_INVALID_INPUT' });
});
test('malformed or non-success responses cannot become generated text or leak raw errors', async () => {
  for (const value of [
    null,
    { ok: true, value: {} },
    { ok: true, value: { text: 1 } },
    { ok: false, error: { code: 'private raw error', message: 'private' } },
  ]) {
    const sdk = client(async () => response(value));
    await assert.rejects(sdk.generateText(input), { code: 'APP_AI_RESPONSE' });
  }
  await assert.rejects(
    client(async () => response({ ok: true, value: { text: 'untrusted' } }, false)).generateText(
      input,
    ),
    { code: 'APP_AI_RESPONSE' },
  );
});
