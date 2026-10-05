import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ModelService, type Cipher } from '../src/main/model-service';
import { AppError } from '../src/main/validation';
import type {
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
} from '../src/shared/model-tool-contracts';

// Synthetic credential and isolated cipher only; no user appData or real API calls.
const syntheticKey = 'synthetic-tool-key-no-account';
const encryptionKey = randomBytes(32);
const cipher: Cipher = {
  available: () => true,
  encrypt: (value) => {
    const iv = randomBytes(12);
    const encryptor = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const bytes = Buffer.concat([encryptor.update(value, 'utf8'), encryptor.final()]);
    return Buffer.concat([iv, encryptor.getAuthTag(), bytes]);
  },
  decrypt: (value) => {
    const decryptor = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
    decryptor.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decryptor.update(value.subarray(28)), decryptor.final()]).toString(
      'utf8',
    );
  },
};
const config = {
  provider: 'deepseek' as const,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: syntheticKey,
  maxCalls: 100,
};
const messages: ModelMessage[] = [
  { role: 'system', content: '使用受限工具，不执行代码。' },
  { role: 'user', content: '列出合成项目源码。' },
];
const tools: ModelToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出源码',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const call = (id = 'call_first', name = 'list_files', argumentsText = '{}'): ModelToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: argumentsText },
});
function body(
  toolCalls: unknown = [call()],
  content: unknown = null,
  finishReason: unknown = 'tool_calls',
  usage: unknown = { prompt_tokens: 12, completion_tokens: 4 },
) {
  return {
    choices: [
      {
        message: { role: 'assistant', content, tool_calls: toolCalls },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}
const response = (value: unknown = body()) => new Response(JSON.stringify(value), { status: 200 });
function setup(
  t: { after: (callback: () => void) => void },
  request: typeof fetch = async () => response(),
  timeout = 1000,
) {
  const root = mkdtempSync(join(tmpdir(), 'factory-model-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new ModelService(root, cipher, request, timeout);
  service.save(config);
  return { root, service };
}

test('tool turns send the exact non-streaming contract and retain tool call IDs on the next round', async (t) => {
  const sent: Record<string, any>[] = [];
  const { root, service } = setup(t, async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options!.method, 'POST');
    assert.equal(options!.redirect, 'error');
    assert.equal(
      (options!.headers as Record<string, string>).Authorization,
      `Bearer ${syntheticKey}`,
    );
    const payload = JSON.parse(String(options!.body));
    assert.equal(payload.max_tokens, 4096);
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.thinking, { type: 'disabled' });
    assert.equal(payload.tool_choice, 'auto');
    assert.equal(Object.hasOwn(payload, 'response_format'), false);
    assert.deepEqual(payload.tools, tools);
    assert.equal(JSON.stringify(payload).includes(syntheticKey), false);
    sent.push(payload);
    return sent.length === 1
      ? response()
      : response(body(null, '已查看源码列表，尚未执行代码。', 'stop'));
  });
  const first = await service.toolTurn(messages, tools);
  assert.deepEqual(first, {
    finishReason: 'tool_calls',
    message: { role: 'assistant', content: null, tool_calls: [call()] },
  });
  const continuation: ModelMessage[] = [
    ...messages,
    first.message,
    { role: 'tool', tool_call_id: 'call_first', content: '{"files":[]}' },
  ];
  const second = await service.toolTurn(continuation, tools);
  assert.equal(second.finishReason, 'stop');
  assert.deepEqual(sent[1].messages, continuation);
  assert.deepEqual(new ModelService(root, cipher).usage(), {
    calls: 2,
    inputTokens: 24,
    outputTokens: 8,
    unknownUsageCalls: 0,
  });
  const stored = readFileSync(join(root, 'provider.json'), 'utf8');
  assert.equal(stored.includes(syntheticKey), false);
  assert.equal(stored.includes('call_first'), false);
  assert.deepEqual(readdirSync(root), ['provider.json']);
});

test('custom providers use the same tools contract without a provider-specific thinking parameter', async (t) => {
  let payload: any;
  const { service } = setup(t, async (_url, options) => {
    payload = JSON.parse(String(options!.body));
    return response();
  });
  service.save({ ...config, provider: 'custom', baseUrl: 'https://synthetic.example' });
  await service.toolTurn(messages, tools);
  assert.equal(Object.hasOwn(payload, 'thinking'), false);
  assert.equal(Object.hasOwn(payload, 'response_format'), false);
});

test('up to four calls are returned together; an unknown well-formed tool is left to the executor', async (t) => {
  const calls = [
    call('one'),
    call('two', 'read_file', '{"path":"src/app.ts"}'),
    call('three', 'unknown_tool'),
    call('four'),
  ];
  const { service } = setup(t, async () => response(body(calls, '将依次读取受限源码。')));
  const result = await service.toolTurn(messages, tools);
  assert.deepEqual(result.message.tool_calls, calls);
  assert.equal(result.message.content, '将依次读取受限源码。');
});

test('malformed tool calls reject the entire response, including any earlier valid call', async (t) => {
  const cases: unknown[] = [
    null,
    [],
    [call(), call()],
    Array.from({ length: 5 }, (_, index) => call(`call_${index}`)),
    [call(), { ...call('second'), id: '../private' }],
    [{ ...call(), type: 'shell' }],
    [{ ...call(), function: null }],
    [call('first', '../shell')],
    [call('first', 'a'.repeat(65))],
    [call('first', 'list_files', '[]')],
    [call('first', 'list_files', 'null')],
    [call('first', 'list_files', '"string"')],
    [call('first', 'list_files', '{"partial":')],
    [{ ...call(), function: { name: 'list_files', arguments: {} } }],
    [call('first', 'list_files', JSON.stringify({ content: 'a'.repeat(512 * 1024) }))],
    [call('first', 'list_files', '{"value":"\ud800"}')],
  ];
  let cursor = 0;
  const { service } = setup(t, async () => response(body(cases[cursor++])));
  for (const _case of cases)
    await assert.rejects(service.toolTurn(messages, tools), code('INVALID_RESPONSE'));
  assert.equal(service.usage().calls, cases.length);
});

test('finish reasons and message payloads must agree before any tool call is returned', async (t) => {
  const cases: [unknown, string][] = [
    [body([call()], null, 'length'), 'TRUNCATED_RESPONSE'],
    ...['content_filter', 'insufficient_system_resource', 'aborted', 'unknown'].map(
      (reason) => [body([call()], null, reason), 'INVALID_RESPONSE'] as [unknown, string],
    ),
    [body([call()], 'claimed complete', 'stop'), 'INVALID_RESPONSE'],
    [body([], null, 'tool_calls'), 'INVALID_RESPONSE'],
    [body(null, '   ', 'stop'), 'INVALID_RESPONSE'],
    [body(null, null, 'stop'), 'INVALID_RESPONSE'],
    [body([call()], 'a'.repeat(256 * 1024 + 1)), 'INVALID_RESPONSE'],
    [
      {
        choices: [
          {
            message: { role: 'user', content: null, tool_calls: [call()] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'INVALID_RESPONSE',
    ],
    [{ choices: [{ ...body().choices[0] }, { ...body().choices[0] }] }, 'INVALID_RESPONSE'],
  ];
  for (const [value, expected] of cases) {
    const { service } = setup(t, async () => response(value));
    await assert.rejects(service.toolTurn(messages, tools), code(expected));
  }
});

test('raw, Unicode-escaped and nested JSON credentials never enter returned tool calls or text', async (t) => {
  const escaped = [...syntheticKey]
    .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  const decodedArguments = `{"content":"${escaped}"}`;
  assert.equal(decodedArguments.includes(syntheticKey), false);
  const nestedArguments = JSON.stringify({ content: JSON.stringify({ secret: escaped }) });
  const cases = [
    body(null, `key=${syntheticKey}`, 'stop'),
    body(null, `{"secret":"${escaped}"}`, 'stop'),
    body([call('first', 'apply_changes', JSON.stringify({ content: syntheticKey }))]),
    body([call('first', 'apply_changes', decodedArguments)]),
    body([call('first', 'apply_changes', nestedArguments)]),
    body([call(syntheticKey)]),
    body([call('first', syntheticKey)]),
    body([call('first', 'apply_changes', JSON.stringify({ [syntheticKey]: 'value' }))]),
    body([call(), call('second', 'apply_changes', decodedArguments)]),
  ];
  for (const value of cases) {
    const { root, service } = setup(t, async () => response(value));
    await assert.rejects(
      service.toolTurn(messages, tools),
      (error) => code('SENSITIVE_RESPONSE')(error) && !String(error).includes(syntheticKey),
    );
    assert.equal(readFileSync(join(root, 'provider.json'), 'utf8').includes(syntheticKey), false);
  }
});

test('the whole network response and raw JSON encoding have bounded validated reads', async (t) => {
  const cases = [
    new Response('not-json'),
    new Response('x'.repeat(1024 * 1024 + 1)),
    new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])),
    response(null),
    response([]),
    new Response(null),
  ];
  for (const result of cases) {
    const { service } = setup(t, async () => result);
    await assert.rejects(service.toolTurn(messages, tools), code('INVALID_RESPONSE'));
    assert.equal(service.usage().unknownUsageCalls, 1);
  }
});

test('failed paid turns remain counted after reopening and are never automatically retried', async (t) => {
  let dispatched = 0;
  const { root, service } = setup(t, async () => {
    dispatched += 1;
    return new Response(syntheticKey, { status: 429 });
  });
  service.save({ ...config, maxCalls: 1 });
  await assert.rejects(
    service.toolTurn(messages, tools),
    (error) => code('RATE_LIMITED')(error) && !String(error).includes(syntheticKey),
  );
  assert.equal(dispatched, 1);
  const reopened = new ModelService(root, cipher, async () => {
    throw new Error('must not dispatch');
  });
  await assert.rejects(reopened.toolTurn(messages, tools), code('BUDGET_EXCEEDED'));
  assert.deepEqual(reopened.usage(), {
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    unknownUsageCalls: 1,
  });
});

test('missing, invalid and overflowing token usage remains explicitly unknown', async (t) => {
  for (const usage of [
    undefined,
    null,
    {},
    { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: '1', completion_tokens: 2 },
    { prompt_tokens: 1, completion_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const { root, service } = setup(t, async () => response({ choices: body().choices, usage }));
    await service.toolTurn(messages, tools);
    assert.deepEqual(new ModelService(root, cipher).usage(), {
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      unknownUsageCalls: 1,
    });
  }
});

test('invalid input and unresolved or orphaned tool results are rejected before reserving a request', async (t) => {
  let dispatched = false;
  const { service } = setup(t, async () => {
    dispatched = true;
    return response();
  });
  const invalidMessages: unknown[] = [
    [],
    null,
    [{ role: 'user', content: null }],
    [{ role: 'developer', content: 'invalid role' }],
    [...messages, { role: 'tool', tool_call_id: 'orphan', content: '{}' }],
    [...messages, { role: 'assistant', content: null, tool_calls: [call()] }],
    [
      ...messages,
      { role: 'assistant', content: null, tool_calls: [call()] },
      { role: 'user', content: 'skip result' },
    ],
    [
      ...messages,
      { role: 'assistant', content: null, tool_calls: [call()] },
      { role: 'tool', tool_call_id: 'different', content: '{}' },
    ],
    [{ role: 'user', content: 'a'.repeat(2 * 1024 * 1024 + 1) }],
    [{ role: 'user', content: '\ud800' }],
    Array.from({ length: 65 }, () => messages[1]),
  ];
  for (const value of invalidMessages)
    await assert.rejects(service.toolTurn(value as ModelMessage[], tools), code('INVALID_INPUT'));
  for (const value of [
    [],
    null,
    [...tools, tools[0]],
    [{ ...tools[0], type: 'shell' }],
    [{ type: 'function', function: { name: '../shell', description: 'invalid', parameters: {} } }],
    [{ type: 'function', function: { name: 'tool', description: '', parameters: [] } }],
  ])
    await assert.rejects(
      service.toolTurn(messages, value as ModelToolDefinition[]),
      code('INVALID_INPUT'),
    );
  assert.equal(dispatched, false);
  assert.equal(service.usage().calls, 0);
});

test('a provider cannot reuse an earlier tool call ID in a new response', async (t) => {
  const { service } = setup(t);
  const history: ModelMessage[] = [
    ...messages,
    { role: 'assistant', content: null, tool_calls: [call()] },
    { role: 'tool', content: '{}', tool_call_id: 'call_first' },
  ];
  await assert.rejects(service.toolTurn(history, tools), code('INVALID_RESPONSE'));
});

test('external cancellation before dispatch consumes no call and leaves the service idle', async (t) => {
  let dispatched = false;
  const { service } = setup(t, async () => {
    dispatched = true;
    return response();
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.toolTurn(messages, tools, controller.signal), code('CANCELLED'));
  assert.equal(dispatched, false);
  assert.equal(service.usage().calls, 0);
  assert.equal(service.isBusy(), false);
});

test('external cancellation wins even when a provider ignores abort and later returns executable calls', async (t) => {
  let resolveResponse!: (response: Response) => void;
  const { root, service } = setup(
    t,
    async () =>
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = service.toolTurn(messages, tools, controller.signal);
  assert.equal(service.isBusy(), true);
  controller.abort();
  await assert.rejects(pending, code('CANCELLED'));
  assert.equal(service.isBusy(), false);
  resolveResponse(response());
  await nextTurn();
  assert.deepEqual(new ModelService(root, cipher).usage(), {
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    unknownUsageCalls: 1,
  });
});

test('service.cancel shares the busy slot with JSON calls and cannot release a late executable response', async (t) => {
  let resolveResponse!: (response: Response) => void;
  const { service } = setup(
    t,
    async () =>
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
  );
  const pending = service.toolTurn(messages, tools);
  await assert.rejects(service.toolTurn(messages, tools), code('BUSY'));
  await assert.rejects(service.check(), code('BUSY'));
  assert.throws(() => service.save(config), code('BUSY'));
  assert.throws(() => service.deleteKey(), code('BUSY'));
  service.cancel();
  await assert.rejects(pending, code('CANCELLED'));
  resolveResponse(response());
  await nextTurn();
  assert.equal(service.usage().calls, 1);
  assert.equal(service.isBusy(), false);
});

test('timeout wins against an abort-ignoring provider without waiting indefinitely or retrying', async (t) => {
  let resolveResponse!: (response: Response) => void;
  let dispatched = 0;
  const { service } = setup(
    t,
    async () => {
      dispatched += 1;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    },
    10,
  );
  await assert.rejects(service.toolTurn(messages, tools), code('TIMEOUT'));
  assert.equal(service.isBusy(), false);
  resolveResponse(response());
  await nextTurn();
  assert.equal(dispatched, 1);
  assert.equal(service.usage().unknownUsageCalls, 1);
});

test('cancelling while reading a partial body closes its stream and never returns partial tool calls', async (t) => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":['));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { service } = setup(t, async () => new Response(stream));
  const pending = service.toolTurn(messages, tools);
  await nextTurn();
  service.cancel();
  await assert.rejects(pending, code('CANCELLED'));
  assert.equal(cancelled, true);
  assert.equal(service.usage().unknownUsageCalls, 1);
});

test('abort listeners from a finished turn cannot cancel a later turn', async (t) => {
  let count = 0;
  let resolveResponse!: (response: Response) => void;
  const { service } = setup(t, async () => {
    count += 1;
    return count === 1
      ? response()
      : new Promise((resolve) => {
          resolveResponse = resolve;
        });
  });
  const oldController = new AbortController();
  await service.toolTurn(messages, tools, oldController.signal);
  const next = service.toolTurn(messages, tools);
  oldController.abort();
  assert.equal(service.isBusy(), true);
  resolveResponse(response());
  assert.equal((await next).finishReason, 'tool_calls');
});

test('HTTP and transport failures do not expose upstream text, headers or credentials', async (t) => {
  for (const [status, expected] of [
    [401, 'AUTH_FAILED'],
    [402, 'QUOTA_EXCEEDED'],
    [403, 'ACCESS_DENIED'],
    [404, 'MODEL_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [503, 'PROVIDER_ERROR'],
  ] as const) {
    const { service } = setup(
      t,
      async () => new Response(`Authorization: Bearer ${syntheticKey}`, { status }),
    );
    await assert.rejects(
      service.toolTurn(messages, tools),
      (error) => code(expected)(error) && !String(error).includes(syntheticKey),
    );
  }
  const { service } = setup(t, async () => {
    throw new Error(`private host ${syntheticKey}`);
  });
  await assert.rejects(
    service.toolTurn(messages, tools),
    (error) => code('NETWORK_ERROR')(error) && !String(error).includes(syntheticKey),
  );
});

test('failed durable reservation prevents tool dispatch and leaves accounting unchanged', async (t) => {
  let dispatched = false;
  const { root, service } = setup(t, async () => {
    dispatched = true;
    return response();
  });
  const moved = `${root}-moved`;
  renameSync(root, moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  await assert.rejects(service.toolTurn(messages, tools), code('STORAGE_ERROR'));
  assert.equal(dispatched, false);
  assert.equal(service.usage().calls, 0);
  assert.equal(service.isBusy(), false);
});

test('completed calls do not mutate caller-owned input messages or tool schemas', async (t) => {
  const { service } = setup(t);
  const inputMessages = structuredClone(messages);
  const inputTools = structuredClone(tools);
  const before = JSON.stringify({ inputMessages, inputTools });
  await service.toolTurn(inputMessages, inputTools);
  assert.equal(JSON.stringify({ inputMessages, inputTools }), before);
});
