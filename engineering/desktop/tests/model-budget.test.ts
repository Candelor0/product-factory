import assert from 'node:assert/strict';
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  ModelService,
  type ApplicationAccounting,
  type Cipher,
  type ModelStorageOptions,
} from '../src/main/model-service';
import { AppError } from '../src/main/validation';

// Isolated reversible test cipher; this is not a test of the OS keychain.
const cipher: Cipher = {
  available: () => true,
  encrypt: (text) => Buffer.from([...Buffer.from(text)].map((byte) => byte ^ 0xa5)),
  decrypt: (bytes) => Buffer.from([...bytes].map((byte) => byte ^ 0xa5)).toString(),
};
const secret = 'synthetic-budget-test-key';
const provider = {
  provider: 'deepseek' as const,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  maxCalls: 30,
  apiKey: secret,
};
const hasCode = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const reply = (
  usage: unknown = { prompt_tokens: 12, completion_tokens: 4 },
  content = '{"ok":true}',
) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage,
    }),
  );
function fixture(
  t: TestContext,
  request: typeof fetch = async () => reply(),
  hooks: ModelStorageOptions = {},
  timeout = 1000,
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-model-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new ModelService(root, cipher, request, timeout, hooks);
  service.save(provider);
  const file = join(root, 'provider.json');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return {
    root,
    file,
    service,
    read,
    reopen: (next = request) => new ModelService(root, cipher, next, timeout),
  };
}
function ledger() {
  const reserved: number[] = [];
  const settled: { inputTokens: number; outputTokens: number }[] = [];
  const accounting: ApplicationAccounting = {
    reserve: (tokens) => {
      reserved.push(tokens);
    },
    settle: (usage) => {
      settled.push(usage);
    },
  };
  return { accounting, reserved, settled };
}
function legacy(f: ReturnType<typeof fixture>, unknown = 0) {
  const {
    maxTokens: _max,
    budgetTokens: _budget,
    legacyUnknownUsageCalls: _unknown,
    connectionId: _connection,
    ...old
  } = f.read();
  const value = {
    ...old,
    schemaVersion: 1,
    usage: { calls: 3, inputTokens: 20, outputTokens: 15, unknownUsageCalls: unknown },
  };
  writeFileSync(f.file, JSON.stringify(value));
  return value;
}

test('schema 1 migrates durably without resetting legacy usage or credentials', (t) => {
  const f = fixture(t);
  const previous = legacy(f);
  const reopened = f.reopen();
  assert.deepEqual(reopened.usage(), previous.usage);
  assert.equal(reopened.settings().budgetTokens, 35);
  assert.equal(reopened.settings().maxTokens, null);
  assert.equal(f.read().schemaVersion, 2);
  assert.equal(f.read().encryptedKey, previous.encryptedKey);
  assert.equal(f.reopen().settings().connectionId, reopened.settings().connectionId);
  assert.equal(readFileSync(f.file, 'utf8').includes(secret), false);
});

test('legacy unknown usage cannot silently become zero token spending or be manually cleared', async (t) => {
  const f = fixture(t);
  legacy(f, 2);
  const service = f.reopen();
  const before = readFileSync(f.file);
  assert.equal(service.settings().legacyUnknownUsageCalls, 2);
  assert.throws(
    () => service.save({ ...provider, apiKey: undefined, maxTokens: 100000 }),
    hasCode('TOKEN_USAGE_UNKNOWN'),
  );
  assert.deepEqual(readFileSync(f.file), before);
  await service.check();
  assert.equal(service.usage().calls, 4);
  assert.equal(service.usage().unknownUsageCalls, 2);
  assert.equal(service.settings().legacyUnknownUsageCalls, 2);
  assert.equal(service.settings().budgetTokens, 51);
  assert.throws(
    () => service.save({ ...provider, maxTokens: 100000 }),
    hasCode('TOKEN_USAGE_UNKNOWN'),
  );
});

test('a development request reserves the exact body-byte formula before transport and settles known usage', async (t) => {
  let reserved = 0;
  const f = fixture(t, async (_url, options) => {
    const body = String(options!.body);
    reserved = Buffer.byteLength(body) + JSON.parse(body).max_tokens + 1024;
    assert.equal(f.read().budgetTokens, reserved);
    assert.deepEqual(f.read().usage, {
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      unknownUsageCalls: 1,
    });
    return reply();
  });
  await f.service.check();
  assert.ok(reserved > 16);
  assert.equal(f.service.settings().budgetTokens, 16);
  assert.equal(f.reopen().settings().budgetTokens, 16);
  assert.equal(f.service.usage().unknownUsageCalls, 0);
});

test('insufficient token reservation blocks before fetch and does not increment calls', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return reply();
  });
  f.service.save({ ...provider, apiKey: undefined, maxTokens: 1 });
  await assert.rejects(f.service.check(), hasCode('TOKEN_BUDGET_EXCEEDED'));
  assert.equal(calls, 0);
  assert.equal(f.service.usage().calls, 0);
  assert.equal(f.service.settings().budgetTokens, 0);
});

test('missing usage consumes its reservation across later calls and process reconstruction', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return reply(null);
  });
  await f.service.check();
  const reservation = f.service.settings().budgetTokens;
  f.service.save({ ...provider, apiKey: undefined, maxTokens: reservation * 2 });
  await f.service.check();
  assert.equal(f.service.settings().budgetTokens, reservation * 2);
  const reopened = f.reopen();
  await assert.rejects(reopened.check(), hasCode('TOKEN_BUDGET_EXCEEDED'));
  assert.equal(calls, 2);
  assert.equal(reopened.usage().unknownUsageCalls, 2);
});

test('HTTP failure and invalid usage keep conservative spending while observed usage above the reserve is fully counted', async (t) => {
  const failed = fixture(t, async () => new Response('private provider text', { status: 401 }));
  await assert.rejects(failed.service.check(), hasCode('AUTH_FAILED'));
  assert.ok(failed.reopen().settings().budgetTokens > 0);
  for (const usage of [
    null,
    { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: 1.5, completion_tokens: 1 },
  ]) {
    const f = fixture(t, async () => reply(usage));
    await f.service.check();
    assert.ok(f.reopen().settings().budgetTokens > 0);
    assert.equal(f.service.usage().unknownUsageCalls, 1);
  }
  const large = fixture(t, async () => reply({ prompt_tokens: 10000, completion_tokens: 10000 }));
  large.service.save({ ...provider, apiKey: undefined, maxTokens: 5000 });
  await large.service.check();
  assert.equal(large.service.settings().budgetTokens, 20000);
  await assert.rejects(large.service.check(), hasCode('TOKEN_BUDGET_EXCEEDED'));
});

test('cumulative usage overflow durably saturates the token budget without fabricating counters', async (t) => {
  for (const overflow of [
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0 },
    { prompt_tokens: 0, completion_tokens: Number.MAX_SAFE_INTEGER },
  ]) {
    let calls = 0;
    const f = fixture(t, async () => {
      calls++;
      return calls === 1 ? reply() : reply(overflow);
    });
    f.service.save({ ...provider, apiKey: undefined, maxTokens: 100000 });
    await f.service.check();
    await f.service.check();
    const expectedUsage = { calls: 2, inputTokens: 12, outputTokens: 4, unknownUsageCalls: 1 };
    assert.deepEqual(f.service.usage(), expectedUsage);
    assert.equal(f.service.settings().budgetTokens, Number.MAX_SAFE_INTEGER);
    assert.equal(f.read().budgetTokens, Number.MAX_SAFE_INTEGER);
    await assert.rejects(f.service.check(), hasCode('TOKEN_BUDGET_EXCEEDED'));
    const reopened = f.reopen();
    assert.deepEqual(reopened.usage(), expectedUsage);
    assert.equal(reopened.settings().budgetTokens, Number.MAX_SAFE_INTEGER);
    // Even increasing to the largest supported finite limit cannot hide the overflow.
    reopened.save({ ...provider, apiKey: undefined, maxTokens: 100000000 });
    await assert.rejects(reopened.check(), hasCode('TOKEN_BUDGET_EXCEEDED'));
    assert.equal(calls, 2);
  }
});

test('budget edits preserve connection identity; credential, endpoint, model and removal changes revoke its identity', (t) => {
  const f = fixture(t);
  let id = f.service.settings().connectionId;
  f.service.save({ ...provider, apiKey: undefined, maxTokens: 10000, maxCalls: 20 });
  assert.equal(f.service.settings().connectionId, id);
  f.service.save({ ...provider, apiKey: undefined });
  assert.equal(f.service.settings().maxTokens, 10000);
  assert.equal(f.service.settings().connectionId, id);
  for (const input of [
    { ...provider, apiKey: undefined, model: 'another-model' },
    { ...provider },
    { ...provider, provider: 'custom' as const, baseUrl: 'https://example.invalid' },
  ]) {
    f.service.save(input);
    assert.notEqual(f.service.settings().connectionId, id);
    id = f.service.settings().connectionId;
  }
  f.service.deleteKey();
  assert.notEqual(f.service.settings().connectionId, id);
  assert.equal(f.reopen().settings().connectionId, f.service.settings().connectionId);
  for (const maxTokens of [0, -1, 1.1, 100000001, NaN])
    assert.throws(() => f.service.save({ ...provider, maxTokens }), hasCode('INVALID_INPUT'));
});

test('failed reservation dispatches nothing and failed settlement retains durable unknown spending', async (t) => {
  let writes = 0,
    calls = 0;
  const f = fixture(
    t,
    async () => {
      calls++;
      return reply();
    },
    {
      beforeRename: () => {
        if (++writes === 2) throw new Error('reserve fault');
      },
    },
  );
  await assert.rejects(f.service.check(), hasCode('STORAGE_ERROR'));
  assert.equal(calls, 0);
  assert.equal(f.service.settings().budgetTokens, 0);
  assert.equal(f.read().usage.calls, 0);
  writes = 0;
  const settled = fixture(
    t,
    async () => {
      calls++;
      return reply();
    },
    {
      beforeRename: () => {
        if (++writes === 3) throw new Error('settle fault');
      },
    },
  );
  await assert.rejects(settled.service.check(), hasCode('STORAGE_ERROR'));
  assert.equal(calls, 1);
  assert.equal(settled.service.usage().unknownUsageCalls, 1);
  assert.equal(settled.service.usage().inputTokens, 0);
  assert.ok(settled.service.settings().budgetTokens > 16);
  assert.equal(settled.read().budgetTokens, settled.service.settings().budgetTokens);
  await assert.rejects(settled.service.check(), hasCode('STORAGE_ERROR'));
  assert.equal(calls, 1);
  assert.equal(settled.reopen().settings().budgetTokens, settled.service.settings().budgetTokens);
});

test('exact readback reconciles a lost write acknowledgement and corrupted publication blocks later requests', async (t) => {
  let armed = false;
  const f = fixture(t, undefined, {
    afterRename: () => {
      if (armed) throw new Error('lost acknowledgement');
    },
  });
  armed = true;
  await f.service.check();
  assert.equal(f.service.settings().budgetTokens, 16);
  assert.equal(f.reopen().usage().unknownUsageCalls, 0);
  armed = false;
  let calls = 0;
  const corrupted = fixture(
    t,
    async () => {
      calls++;
      return reply();
    },
    {
      afterRename: () => {
        if (armed) {
          writeFileSync(corrupted.file, '{corrupted');
          throw new Error('uncertain');
        }
      },
    },
  );
  armed = true;
  await assert.rejects(corrupted.service.check(), hasCode('STORAGE_COMMIT_UNCERTAIN'));
  await assert.rejects(corrupted.service.check(), hasCode('STORAGE_ERROR'));
  assert.equal(calls, 0);
  assert.equal(readFileSync(corrupted.file, 'utf8'), '{corrupted');
});

test('stale instances, disappeared settings and hardlinks cannot overwrite newer accounting', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return reply();
  });
  const stale = f.reopen();
  await f.service.check();
  const current = readFileSync(f.file);
  await assert.rejects(stale.check(), hasCode('STORAGE_ERROR'));
  assert.deepEqual(readFileSync(f.file), current);
  assert.equal(calls, 1);
  const missing = fixture(t);
  unlinkSync(missing.file);
  await assert.rejects(missing.service.check(), hasCode('STORAGE_ERROR'));
  const linked = fixture(t);
  linkSync(linked.file, join(linked.root, 'linked.json'));
  await assert.rejects(linked.service.check(), hasCode('UNSAFE_PATH'));
});

test('application text uses only its accounting and transmits a fixed text-only request', async (t) => {
  const book = ledger();
  let calls = 0;
  const f = fixture(t, async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options!.body));
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.stream, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.response_format, undefined);
    assert.equal(book.reserved[0], Buffer.byteLength(String(options!.body)) + 1024 + 1024);
    return reply(undefined, '只返回合成文本');
  });
  f.service.save({ ...provider, apiKey: undefined, maxTokens: 1 });
  const before = readFileSync(f.file);
  assert.equal(
    await f.service.applicationText({ purpose: '总结', text: '普通输入' }, book.accounting),
    '只返回合成文本',
  );
  assert.equal(calls, 1);
  assert.equal(book.reserved.length, 1);
  assert.deepEqual(book.settled, [{ inputTokens: 12, outputTokens: 4 }]);
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(readFileSync(f.file, 'utf8').includes('普通输入'), false);
  assert.equal(f.service.usage().calls, 0);
});

test('application busy, pre-abort, key absence and rejected reservation never dispatch or double reserve', async (t) => {
  let calls = 0;
  let resolve!: (response: Response) => void;
  const f = fixture(t, async () => {
    calls++;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  const first = ledger(),
    second = ledger();
  const pending = f.service.applicationText({ purpose: '测试', text: 'first' }, first.accounting);
  await assert.rejects(
    f.service.applicationText({ purpose: '测试', text: 'second' }, second.accounting),
    hasCode('BUSY'),
  );
  assert.deepEqual(second.reserved, []);
  resolve(reply(undefined, 'done'));
  await pending;
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(
    f.service.applicationText(
      { purpose: '测试', text: 'aborted' },
      second.accounting,
      stopped.signal,
    ),
    hasCode('CANCELLED'),
  );
  await assert.rejects(
    f.service.applicationText(
      { purpose: '测试', text: 'limited' },
      {
        reserve: () => {
          throw new AppError('APP_AI_LIMIT', 'budget denied');
        },
        settle: () => assert.fail('must not settle'),
      },
    ),
    hasCode('APP_AI_LIMIT'),
  );
  f.service.deleteKey();
  await assert.rejects(
    f.service.applicationText({ purpose: '测试', text: 'keyless' }, second.accounting),
    hasCode('KEY_REQUIRED'),
  );
  assert.deepEqual(second.reserved, []);
  assert.equal(calls, 1);
});

test('cancelled application late response cannot settle, consume development usage or affect the next request', async (t) => {
  let resolve!: (response: Response) => void;
  let calls = 0;
  const f = fixture(t, async () =>
    ++calls === 1
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : reply(undefined, 'next'),
  );
  const previous = ledger(),
    current = ledger();
  const controller = new AbortController();
  const pending = f.service.applicationText(
    { purpose: '测试', text: 'old' },
    previous.accounting,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, hasCode('CANCELLED'));
  assert.equal(
    await f.service.applicationText({ purpose: '测试', text: 'new' }, current.accounting),
    'next',
  );
  resolve(reply(undefined, 'late'));
  await new Promise((done) => setImmediate(done));
  assert.equal(previous.reserved.length, 1);
  assert.deepEqual(previous.settled, []);
  assert.deepEqual(current.settled, [{ inputTokens: 12, outputTokens: 4 }]);
  assert.equal(f.service.usage().calls, 0);
});

test('application unknown usage and timeouts retain reservation while invalid input is rejected before charging', async (t) => {
  const book = ledger();
  const f = fixture(t, async () => reply(null, 'text'));
  await f.service.applicationText({ purpose: '用途', text: '输入' }, book.accounting);
  assert.equal(book.reserved.length, 1);
  assert.deepEqual(book.settled, []);
  for (const input of [
    { purpose: '中'.repeat(167), text: 'ok' },
    { purpose: 'ok', text: '中'.repeat(5334) },
    { purpose: '', text: 'ok' },
  ])
    await assert.rejects(
      f.service.applicationText(input, book.accounting),
      hasCode('INVALID_INPUT'),
    );
  assert.equal(book.reserved.length, 1);
  const timeoutBook = ledger();
  const timeout = fixture(t, async () => new Promise<Response>(() => {}), {}, 10);
  await assert.rejects(
    timeout.service.applicationText({ purpose: '用途', text: '输入' }, timeoutBook.accounting),
    hasCode('TIMEOUT'),
  );
  assert.equal(timeoutBook.reserved.length, 1);
  assert.deepEqual(timeoutBook.settled, []);
});

test('application rejects tools, truncated/oversized text and reflected credentials without persisting response bodies', async (t) => {
  const cases: [() => Response, string][] = [
    [() => reply(undefined, secret), 'SENSITIVE_RESPONSE'],
    [() => reply(undefined, 'x'.repeat(65537)), 'INVALID_RESPONSE'],
    [
      () =>
        new Response(
          JSON.stringify({
            choices: [
              { finish_reason: 'length', message: { role: 'assistant', content: 'partial' } },
            ],
          }),
        ),
      'TRUNCATED_RESPONSE',
    ],
    [
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: { role: 'assistant', content: '', tool_calls: [] },
              },
            ],
          }),
        ),
      'INVALID_RESPONSE',
    ],
  ];
  for (const [response, code] of cases) {
    const f = fixture(t, async () => response());
    const before = readFileSync(f.file);
    await assert.rejects(
      f.service.applicationText({ purpose: '用途', text: 'private text' }, ledger().accounting),
      hasCode(code),
    );
    assert.deepEqual(readFileSync(f.file), before);
  }
});
