import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  APP_DATA_LIMITS,
  applyAppDataSnapshot,
  validateAppDataApplyRequest,
  validateAppDataRequest,
  validateAppDataSnapshot,
} from '../src/main/app-data-protocol';
import { AppError } from '../src/main/validation';
import type { AppDataApplyRequest } from '../src/shared/app-data-contracts';
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const request = (value: unknown): unknown => ({
  requestId: randomUUID(),
  expectedRevision: 0,
  changes: [{ operation: 'put', key: 'articles', value }],
});
test('pure JSON operations canonicalize objects, preserve original inputs and enforce a whole-snapshot revision', () => {
  const input = { revision: 0, values: {} };
  const raw = request({ z: ['文字', true, null, 1.5], a: { body: '<script>text only</script>' } });
  const parsed = validateAppDataApplyRequest(raw);
  const result = applyAppDataSnapshot(input, parsed);
  assert.deepEqual(Object.keys(result.values.articles as object), ['a', 'z']);
  assert.deepEqual(input, { revision: 0, values: {} });
  assert.equal(result.revision, 1);
  assert.throws(() => applyAppDataSnapshot(result, parsed), code('APP_DATA_CONFLICT'));
  const removed = applyAppDataSnapshot(result, {
    requestId: randomUUID(),
    expectedRevision: 1,
    changes: [{ operation: 'remove', key: 'articles' }],
  });
  assert.deepEqual(removed, { revision: 2, values: {} });
  assert.throws(
    () =>
      applyAppDataSnapshot(removed, {
        requestId: randomUUID(),
        expectedRevision: 2,
        changes: [{ operation: 'remove', key: 'articles' }],
      }),
    code('APP_DATA_CONFLICT'),
  );
});
test('strict requests reject unsupported operations, unknown fields, identifiers and nonportable or duplicate keys', () => {
  assert.deepEqual(validateAppDataRequest({ schemaVersion: 1, operation: 'read' }), {
    schemaVersion: 1,
    operation: 'read',
  });
  const valid = validateAppDataApplyRequest(request('value'));
  assert.deepEqual(validateAppDataRequest({ schemaVersion: 1, operation: 'apply', ...valid }), {
    schemaVersion: 1,
    operation: 'apply',
    ...valid,
  });
  for (const key of [
    '../key',
    'SomeKey',
    '_name',
    'a/b',
    '中文',
    '',
    'a'.repeat(65),
    '__proto__',
    'prototype',
    'constructor',
  ])
    assert.throws(
      () =>
        validateAppDataApplyRequest({ ...valid, changes: [{ operation: 'put', key, value: 1 }] }),
      code('APP_DATA_INVALID'),
    );
  for (const raw of [
    null,
    [],
    { ...valid, requestId: '../host' },
    { ...valid, expectedRevision: -1 },
    { ...valid, expectedRevision: 0.2 },
    { ...valid, hostPath: '/etc' },
    { ...valid, changes: [{ operation: 'execute', key: 'a' }] },
    {
      ...valid,
      changes: [
        { operation: 'put', key: 'a', value: 1 },
        { operation: 'remove', key: 'a' },
      ],
    },
  ])
    assert.throws(() => validateAppDataApplyRequest(raw), code('APP_DATA_INVALID'));
  for (const raw of [
    { schemaVersion: 2, operation: 'read' },
    { schemaVersion: 1, operation: 'read', projectId: randomUUID() },
    { schemaVersion: 1, operation: 'execute' },
  ])
    assert.throws(() => validateAppDataRequest(raw), code('APP_DATA_INVALID'));
});
test('JSON validation rejects prototypes, poison keys, accessors, symbols, sparse arrays and non-JSON values without invoking getters', () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'secret';
    },
  });
  const nonenumerable = Object.defineProperty({}, 'value', { value: 1 });
  const symbol = { [Symbol('secret')]: 1 };
  const array: unknown[] = [];
  Object.defineProperty(array, '0', {
    enumerable: true,
    get() {
      getterCalls++;
      return 1;
    },
  });
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol('x'),
    () => 1,
    new Date(),
    new Map(),
    Buffer.from('x'),
    Object.create({ inherited: true }),
    accessor,
    nonenumerable,
    symbol,
    [undefined],
    new Array(2),
    array,
    JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'),
    { nested: { constructor: 1 } },
    { nested: { prototype: 1 } },
  ])
    assert.throws(() => validateAppDataApplyRequest(request(value)), code('APP_DATA_INVALID'));
  assert.equal(getterCalls, 0);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const safeNull = Object.create(null);
  safeNull.field = 'data';
  assert.deepEqual(validateAppDataApplyRequest(request(safeNull)).changes[0], {
    operation: 'put',
    key: 'articles',
    value: { field: 'data' },
  });
});
test('all size, key, change, depth and aggregate node ceilings are checked by pure helpers', () => {
  for (const changes of [
    [],
    Array.from({ length: 33 }, (_, index) => ({ operation: 'remove', key: `k${index}` })),
  ])
    assert.throws(
      () => validateAppDataApplyRequest({ requestId: randomUUID(), expectedRevision: 0, changes }),
      code('APP_DATA_LIMIT'),
    );
  assert.throws(
    () => validateAppDataApplyRequest(request('x'.repeat(APP_DATA_LIMITS.valueBytes))),
    code('APP_DATA_LIMIT'),
  );
  assert.throws(
    () => validateAppDataApplyRequest(request(Array.from({ length: 20_000 }, () => null))),
    code('APP_DATA_LIMIT'),
  );
  let nested: unknown = null;
  for (let index = 0; index < 16; index++) nested = [nested];
  assert.throws(() => validateAppDataApplyRequest(request(nested)), code('APP_DATA_LIMIT'));
  const many = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, null]));
  assert.throws(
    () => validateAppDataSnapshot({ revision: 0, values: many }),
    code('APP_DATA_LIMIT'),
  );
  const large = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`k${index}`, 'x'.repeat(120_000)]),
  );
  assert.throws(
    () => validateAppDataSnapshot({ revision: 0, values: large }),
    code('APP_DATA_LIMIT'),
  );
  const exhausted = { revision: Number.MAX_SAFE_INTEGER, values: {} };
  assert.throws(
    () =>
      applyAppDataSnapshot(exhausted, {
        ...(request(1) as AppDataApplyRequest),
        expectedRevision: exhausted.revision,
      }),
    code('APP_DATA_LIMIT'),
  );
});
