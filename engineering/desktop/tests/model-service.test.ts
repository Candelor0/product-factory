import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ModelService, type Cipher } from '../src/main/model-service';
import { AppError } from '../src/main/validation';

// An isolated test cipher exercises the storage contract, not OS keychain guarantees.
const testKey = randomBytes(32);
const cipher: Cipher = {
  available: () => true,
  encrypt: (value) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', testKey, iv);
    const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  },
  decrypt: (value) => {
    const d = createDecipheriv('aes-256-gcm', testKey, value.subarray(0, 12));
    d.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString();
  },
};
const input = {
  provider: 'deepseek' as const,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: 'test-only-secret-not-a-real-key',
  maxCalls: 3,
};
function response(
  content: unknown = { ok: true },
  usage: unknown = { prompt_tokens: 12, completion_tokens: 4 },
) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage,
    }),
    { status: 200 },
  );
}
function setup(
  t: { after: (f: () => void) => void },
  request: typeof fetch = async () => response(),
  encryption = cipher,
  timeout = 1000,
) {
  const root = mkdtempSync(join(tmpdir(), 'factory-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, service: new ModelService(root, encryption, request, timeout) };
}
function code(expected: string) {
  return (error: unknown) => error instanceof AppError && error.code === expected;
}

test('secrets are encrypted on disk and absent from public settings; reload retains usage', async (t) => {
  let auth = '';
  const { root, service } = setup(t, async (_url, options) => {
    auth = (options!.headers as Record<string, string>).Authorization;
    return response();
  });
  const saved = service.save(input);
  assert.equal(saved.storage, 'encrypted');
  assert.equal(JSON.stringify(saved).includes(input.apiKey), false);
  assert.equal(readFileSync(join(root, 'provider.json'), 'utf8').includes(input.apiKey), false);
  await service.check();
  assert.equal(auth, `Bearer ${input.apiKey}`);
  const recovered = new ModelService(root, cipher);
  assert.deepEqual(recovered.usage(), {
    calls: 1,
    inputTokens: 12,
    outputTokens: 4,
    unknownUsageCalls: 0,
  });
  assert.ok(recovered.settings().lastCheckedAt);
});

test('unavailable encryption stores a session key only and loses it on restart', (t) => {
  const unavailable: Cipher = {
    available: () => false,
    encrypt: () => {
      throw new Error();
    },
    decrypt: () => {
      throw new Error();
    },
  };
  const { root, service } = setup(t, undefined, unavailable);
  assert.equal(service.save(input).storage, 'session');
  assert.equal(readFileSync(join(root, 'provider.json'), 'utf8').includes(input.apiKey), false);
  assert.equal(new ModelService(root, unavailable).settings().hasKey, false);
});

test('encryption failure never falls back to plaintext or changes the old configuration', (t) => {
  const broken: Cipher = {
    available: () => true,
    encrypt: () => {
      throw new Error(input.apiKey);
    },
    decrypt: () => {
      throw new Error();
    },
  };
  const { service } = setup(t, undefined, broken);
  assert.throws(() => service.save(input), code('STORAGE_ERROR'));
  assert.equal(service.settings().hasKey, false);
});

test('budget reservation is durable; failures count and block new requests', async (t) => {
  const { root, service } = setup(t, async () => new Response(input.apiKey, { status: 401 }));
  service.save({ ...input, maxCalls: 1 });
  await assert.rejects(
    service.check(),
    (error) => code('AUTH_FAILED')(error) && !String(error).includes(input.apiKey),
  );
  assert.equal(service.usage().unknownUsageCalls, 1);
  const recovered = new ModelService(root, cipher, async () => {
    throw new Error('must not be called');
  });
  await assert.rejects(recovered.check(), code('BUDGET_EXCEEDED'));
  assert.equal(recovered.usage().calls, 1);
});

test('HTTP errors are classified without exposing raw upstream content', async (t) => {
  for (const [status, expected] of [
    [401, 'AUTH_FAILED'],
    [402, 'QUOTA_EXCEEDED'],
    [403, 'ACCESS_DENIED'],
    [404, 'MODEL_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_ERROR'],
  ] as const) {
    const { service } = setup(t, async () => new Response(input.apiKey, { status }));
    service.save(input);
    await assert.rejects(
      service.check(),
      (error) => code(expected)(error) && !String(error).includes(input.apiKey),
    );
  }
});

test('missing usage remains explicitly unknown', async (t) => {
  const { service } = setup(t, async () => response({ ok: true }, null));
  service.save(input);
  await service.check();
  assert.equal(service.usage().unknownUsageCalls, 1);
  assert.equal(service.usage().outputTokens, 0);
});

test('invalid JSON, empty output, oversize, reflected credential and truncated output are rejected', async (t) => {
  const cases: [Response, string][] = [
    [new Response('not JSON'), 'INVALID_RESPONSE'],
    [new Response(JSON.stringify({ choices: [{ message: { content: '' } }] })), 'INVALID_RESPONSE'],
    [new Response('x'.repeat(1024 * 1024 + 1)), 'INVALID_RESPONSE'],
    [response({ secret: input.apiKey }), 'SENSITIVE_RESPONSE'],
    [
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }),
      ),
      'TRUNCATED_RESPONSE',
    ],
  ];
  for (const [result, expected] of cases) {
    const { service } = setup(t, async () => result);
    service.save(input);
    await assert.rejects(service.check(), code(expected));
  }
});

test('concurrent calls and settings edits are blocked; cancel releases the slot', async (t) => {
  const { service } = setup(
    t,
    async (_url, options) =>
      new Promise((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      ),
  );
  service.save(input);
  const pending = service.check();
  await assert.rejects(service.check(), code('BUSY'));
  assert.throws(() => service.save(input), code('BUSY'));
  assert.throws(() => service.deleteKey(), code('BUSY'));
  service.cancel();
  await assert.rejects(pending, code('CANCELLED'));
  assert.equal(service.isBusy(), false);
});

test('request timeout has a distinct recoverable message', async (t) => {
  const { service } = setup(
    t,
    async (_url, options) =>
      new Promise((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () => reject(new Error('timeout')), {
          once: true,
        }),
      ),
    cipher,
    10,
  );
  service.save(input);
  await assert.rejects(service.check(), code('TIMEOUT'));
  assert.equal(service.isBusy(), false);
});

test('endpoints cannot silently receive an existing key; HTTP and URL credentials rejected', (t) => {
  const { service } = setup(t);
  service.save(input);
  assert.throws(
    () =>
      service.save({ ...input, provider: 'custom', baseUrl: 'https://example.com', apiKey: '' }),
    code('KEY_REQUIRED'),
  );
  for (const baseUrl of [
    'http://example.com',
    'https://user:password@example.com',
    'https://example.com?api_key=secret',
    'https://example.com#secret',
  ])
    assert.throws(
      () => service.save({ ...input, provider: 'custom', baseUrl }),
      code('INVALID_INPUT'),
    );
});

test('corrupt settings fail closed instead of resetting saved call usage', (t) => {
  const { root } = setup(t);
  writeFileSync(join(root, 'provider.json'), '{broken');
  assert.throws(() => new ModelService(root, cipher), code('CORRUPT_SETTINGS'));
  assert.equal(readFileSync(join(root, 'provider.json'), 'utf8'), '{broken');
});

test('delete key persists removal without resetting accounting', async (t) => {
  const { root, service } = setup(t);
  service.save(input);
  await service.check();
  service.deleteKey();
  const restored = new ModelService(root, cipher);
  assert.equal(restored.settings().hasKey, false);
  assert.equal(restored.usage().calls, 1);
  await assert.rejects(restored.check(), code('KEY_REQUIRED'));
});

test('JSON Unicode escapes cannot reflect a credential into parsed documents', async (t) => {
  const escaped = [...input.apiKey]
    .map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  const content = `{"ok":true,"secret":"${escaped}"}`;
  assert.equal(content.includes(input.apiKey), false);
  const { service } = setup(
    t,
    async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })),
  );
  service.save(input);
  await assert.rejects(service.check(), code('SENSITIVE_RESPONSE'));
});

test('untrusted token counts cannot overflow durable usage', async (t) => {
  const { root, service } = setup(t, async () =>
    response(
      { ok: true },
      { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: Number.MAX_SAFE_INTEGER },
    ),
  );
  service.save(input);
  await service.check();
  await service.check();
  assert.equal(service.usage().unknownUsageCalls, 1);
  assert.equal(new ModelService(root, cipher).usage().inputTokens, Number.MAX_SAFE_INTEGER);
});

test('failed usage reservation prevents dispatch and does not consume budget', async (t) => {
  let dispatched = false;
  const { root, service } = setup(t, async () => {
    dispatched = true;
    return response();
  });
  service.save(input);
  renameSync(root, `${root}-moved`);
  t.after(() => rmSync(`${root}-moved`, { recursive: true, force: true }));
  await assert.rejects(service.check(), code('STORAGE_ERROR'));
  assert.equal(dispatched, false);
  assert.equal(service.usage().calls, 0);
});
