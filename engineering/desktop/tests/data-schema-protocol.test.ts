import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  dataSchemaHash,
  migrateSchemaValues,
  readSourceDataSchema,
  schemaDefinition,
  validateDataSchemaDefinition,
  validateSchemaValues,
} from '../src/main/data-schema-protocol';
import { AppError } from '../src/main/validation';
import type {
  DataSchemaDeclaration,
  DataSchemaDefinition,
  DataShape,
  MigrationStep,
} from '../src/shared/data-schema-contracts';
import { DATA_SCHEMA_LIMITS } from '../src/shared/data-schema-contracts';
import type { AppDataSnapshot } from '../src/shared/app-data-contracts';

const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const read = (value: unknown) =>
  readSourceDataSchema([{ path: 'src/data-schema.json', content: JSON.stringify(value) }]);
const object = (
  properties: Record<string, DataShape>,
  required = Object.keys(properties),
): DataShape => ({ type: 'object', properties, required });
const posts = (
  properties: Record<string, DataShape>,
  required = Object.keys(properties),
): DataShape => ({ type: 'array', items: object(properties, required) });
const definition = (): DataSchemaDefinition => ({
  version: 1,
  keys: { posts: posts({ title: { type: 'string' } }) },
});
const declare = (
  steps: MigrationStep[],
  keys: DataSchemaDefinition['keys'] = definition().keys,
): DataSchemaDeclaration => ({
  schemaVersion: 1,
  version: 1,
  keys,
  migration: { fromVersion: 0, steps },
});

test('schema source is optional and only the reserved exact path is interpreted', () => {
  assert.equal(readSourceDataSchema([]), null);
  assert.equal(readSourceDataSchema([{ path: 'src/other.json', content: 'invalid JSON' }]), null);
  const source = {
    path: 'src/data-schema.json',
    content: JSON.stringify({ schemaVersion: 1, ...definition() }),
  };
  assert.deepEqual(readSourceDataSchema([source]), { schemaVersion: 1, ...definition() });
  assert.throws(() => readSourceDataSchema([source, source]), code('DATA_SCHEMA_INVALID'));
});

test('source declaration lookup rejects accessors and sparse file lists without evaluating them', () => {
  let accessed = 0;
  const file = Object.defineProperty({ path: 'src/data-schema.json' }, 'content', {
    enumerable: true,
    get() {
      accessed++;
      return '{}';
    },
  });
  assert.throws(
    () => readSourceDataSchema([file as { path: string; content: string }]),
    code('DATA_SCHEMA_INVALID'),
  );
  assert.throws(() => readSourceDataSchema(new Array(1)), code('DATA_SCHEMA_INVALID'));
  assert.equal(accessed, 0);
});

test('declaration parser rejects invalid JSON, BOM, unknown fields and incompatible protocol', () => {
  for (const content of [
    '{',
    '\ufeff{}',
    'null',
    '[]',
    '{"schemaVersion":2,"version":1,"keys":{}}',
  ])
    assert.throws(
      () => readSourceDataSchema([{ path: 'src/data-schema.json', content }]),
      code('DATA_SCHEMA_INVALID'),
    );
  for (const value of [
    { schemaVersion: 1, ...definition(), execute: 'untrusted sentinel' },
    { ...definition() },
    { schemaVersion: 1, version: 1 },
    { schemaVersion: 1, ...definition(), migration: null },
  ])
    assert.throws(() => read(value), code('DATA_SCHEMA_INVALID'));
});

test('definitions canonicalize keys, properties and required without mutating input', () => {
  const original = {
    version: 1,
    keys: {
      z: object({ z: { type: 'string' }, a: { type: 'number' } }, ['z', 'a']),
      a: { type: 'null' },
    },
  };
  const before = JSON.stringify(original);
  const parsed = validateDataSchemaDefinition(original);
  assert.deepEqual(Object.keys(parsed.keys), ['a', 'z']);
  assert.deepEqual(
    parsed.keys.z,
    object({ a: { type: 'number' }, z: { type: 'string' } }, ['a', 'z']),
  );
  assert.equal(JSON.stringify(original), before);
  assert.equal(dataSchemaHash(parsed), dataSchemaHash(original as DataSchemaDefinition));
  assert.equal(dataSchemaHash(null), createHash('sha256').update('null').digest('hex'));
  assert.notEqual(dataSchemaHash(null), dataSchemaHash({ version: 1, keys: {} }));
});

test('schema definition deliberately excludes migration while validating its declaration', () => {
  const raw = declare([]);
  assert.deepEqual(schemaDefinition(raw), definition());
  assert.equal(dataSchemaHash(schemaDefinition(raw)), dataSchemaHash(definition()));
  assert.throws(
    () => schemaDefinition({ ...raw, migration: { fromVersion: 2, steps: [] } }),
    code('DATA_SCHEMA_INVALID'),
  );
});

test('version bounds and exact shape variants reject coercions and unsupported constraints', () => {
  for (const version of [0, -1, 1.5, '1', 1001, Infinity, NaN])
    assert.throws(
      () => validateDataSchemaDefinition({ version, keys: {} }),
      code('DATA_SCHEMA_INVALID'),
    );
  for (const version of [1, 1000])
    assert.equal(validateDataSchemaDefinition({ version, keys: {} }).version, version);
  for (const shape of [
    { type: 'integer' },
    { type: 'string', minLength: 1 },
    { type: 'array' },
    { type: 'object', properties: {} },
    { type: 'object', properties: {}, required: ['missing'] },
    { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] },
    { type: 'object', properties: {}, required: [], additionalProperties: true },
  ])
    assert.throws(
      () => validateDataSchemaDefinition({ version: 1, keys: { value: shape } }),
      code('DATA_SCHEMA_INVALID'),
    );
});

test('accessors, symbols, inherited records and non-enumerable fields are rejected without invoking getters', () => {
  let accessed = 0;
  const getter = Object.defineProperty({}, 'type', {
    enumerable: true,
    get() {
      accessed++;
      return 'string';
    },
  });
  const hidden = Object.defineProperty({ type: 'string' }, 'hidden', { value: true });
  for (const shape of [
    getter,
    hidden,
    Object.assign(Object.create({ inherited: true }), { type: 'string' }),
    { type: 'string', [Symbol('hidden')]: true },
  ])
    assert.throws(
      () => validateDataSchemaDefinition({ version: 1, keys: { value: shape } }),
      code('DATA_SCHEMA_INVALID'),
    );
  assert.equal(accessed, 0);
  assert.deepEqual(
    validateDataSchemaDefinition(Object.assign(Object.create(null), { version: 1, keys: {} })),
    { version: 1, keys: {} },
  );
});

test('sensitive property names and nonportable business keys cannot enter schema or migration', () => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const properties = JSON.parse(`{"${name}":{"type":"string"}}`);
    assert.throws(
      () => validateDataSchemaDefinition({ version: 1, keys: properties }),
      code('DATA_SCHEMA_INVALID'),
    );
    assert.throws(
      () => validateDataSchemaDefinition({ version: 1, keys: { posts: object(properties) } }),
      code('DATA_SCHEMA_INVALID'),
    );
    assert.throws(
      () => read(declare([{ operation: 'addField', key: 'posts', field: name, value: '' }])),
      code('DATA_SCHEMA_INVALID'),
    );
  }
  for (const name of ['../posts', 'Posts', '', 'a'.repeat(65)])
    assert.throws(
      () => validateDataSchemaDefinition({ version: 1, keys: { [name]: { type: 'string' } } }),
      code('DATA_SCHEMA_INVALID'),
    );
  assert.doesNotThrow(() =>
    validateDataSchemaDefinition({
      version: 1,
      keys: { posts: posts({ displayName: { type: 'string' }, 标题: { type: 'string' } }) },
    }),
  );
});

test('sparse, accessor and custom required arrays are rejected', () => {
  let accessed = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() {
      accessed++;
      return 'title';
    },
  });
  for (const required of [
    new Array(1),
    accessor,
    Object.assign(['title'], { hidden: true }),
    Object.setPrototypeOf(['title'], null),
  ])
    assert.throws(
      () =>
        validateDataSchemaDefinition({
          version: 1,
          keys: { posts: { type: 'object', properties: { title: { type: 'string' } }, required } },
        }),
      code('DATA_SCHEMA_INVALID'),
    );
  assert.equal(accessed, 0);
});

test('shape depth and node budgets accept the boundary and reject one beyond or cycles', () => {
  let shape: DataShape = { type: 'string' };
  for (let count = 1; count < DATA_SCHEMA_LIMITS.depth; count++)
    shape = { type: 'array', items: shape };
  assert.doesNotThrow(() => validateDataSchemaDefinition({ version: 1, keys: { value: shape } }));
  assert.throws(
    () =>
      validateDataSchemaDefinition({
        version: 1,
        keys: { value: { type: 'array', items: shape } },
      }),
    code('DATA_SCHEMA_LIMIT'),
  );
  const properties = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => [`field${index}`, { type: 'string' }]),
  );
  assert.doesNotThrow(() =>
    validateDataSchemaDefinition({
      version: 1,
      keys: { value: object(properties as Record<string, DataShape>, []) },
    }),
  );
  properties.extra = { type: 'string' };
  assert.throws(
    () =>
      validateDataSchemaDefinition({
        version: 1,
        keys: { value: object(properties as Record<string, DataShape>, []) },
      }),
    code('DATA_SCHEMA_LIMIT'),
  );
  const cycle: Record<string, unknown> = { type: 'array' };
  cycle.items = cycle;
  assert.throws(
    () => validateDataSchemaDefinition({ version: 1, keys: { value: cycle } }),
    code('DATA_SCHEMA_LIMIT'),
  );
});

test('whole declaration byte cap and top-level key cap reject excess before accepting a declaration', () => {
  assert.throws(
    () =>
      readSourceDataSchema([
        { path: 'src/data-schema.json', content: ' '.repeat(DATA_SCHEMA_LIMITS.bytes + 1) },
      ]),
    code('DATA_SCHEMA_LIMIT'),
  );
  assert.throws(
    () =>
      read(
        declare(
          [{ operation: 'addKey', key: 'text', value: 'x'.repeat(DATA_SCHEMA_LIMITS.bytes) }],
          { text: { type: 'string' } },
        ),
      ),
    code('DATA_SCHEMA_LIMIT'),
  );
  const keys = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [`key${index}`, { type: 'string' }]),
  );
  assert.doesNotThrow(() => validateDataSchemaDefinition({ version: 1, keys }));
  keys.extra = { type: 'string' };
  assert.throws(
    () => validateDataSchemaDefinition({ version: 1, keys }),
    code('DATA_SCHEMA_LIMIT'),
  );
});

test('closed optional top-level keys and required nested object fields enforce exact primitive types', () => {
  const schema: DataSchemaDefinition = {
    version: 1,
    keys: {
      posts: posts({ title: { type: 'string' }, rating: { type: 'number' } }, ['title']),
      flag: { type: 'boolean' },
      empty: { type: 'null' },
    },
  };
  const accepted: AppDataSnapshot['values'][] = [
    {},
    { posts: [] },
    { posts: [{ title: '合成', rating: 2.5 }], flag: false, empty: null },
  ];
  for (const values of accepted) assert.doesNotThrow(() => validateSchemaValues(values, schema));
  const rejected: AppDataSnapshot['values'][] = [
    { extra: null },
    { posts: [{ rating: 1 }] },
    { posts: [{ title: 'ok', secret: 'no' }] },
    { posts: [{ title: 1 }] },
    { posts: {} },
    { flag: 0 },
    { empty: '' },
  ];
  for (const values of rejected)
    assert.throws(() => validateSchemaValues(values, schema), code('DATA_SCHEMA_MISMATCH'));
});

test('legacy null schema still enforces existing JSON safety and capacity', () => {
  assert.doesNotThrow(() => validateSchemaValues({ arbitrary: [{ nested: 1 }] }, null));
  assert.throws(() => validateSchemaValues({ invalid: Infinity }, null), code('APP_DATA_INVALID'));
  assert.throws(
    () => validateSchemaValues({ text: 'x'.repeat(128 * 1024 + 1) }, null),
    code('APP_DATA_LIMIT'),
  );
});

test('migration validates only adjacent versions and allows explicit empty steps', () => {
  assert.deepEqual(read(declare([])), declare([]));
  for (const fromVersion of [-1, 1, 2, '0'])
    assert.throws(
      () => read({ ...declare([]), migration: { fromVersion, steps: [] } }),
      code('DATA_SCHEMA_INVALID'),
    );
  assert.doesNotThrow(() =>
    read({ schemaVersion: 1, version: 1000, keys: {}, migration: { fromVersion: 999, steps: [] } }),
  );
  assert.throws(
    () =>
      read({
        schemaVersion: 1,
        version: 1000,
        keys: {},
        migration: { fromVersion: 998, steps: [] },
      }),
    code('DATA_SCHEMA_INVALID'),
  );
});

test('migration accepts only four exact operations and bounded dense steps', () => {
  for (const operation of [
    { operation: 'deleteKey', key: 'posts' },
    { operation: 'execute', code: 'sentinel()' },
    { operation: 'renameKey', from: 'posts', to: 'posts' },
    { operation: 'renameField', key: 'posts', from: 'title', to: 'title' },
    { operation: 'addKey', key: 'posts' },
    { operation: 'addKey', key: 'posts', value: [], overwrite: true },
  ])
    assert.throws(
      () => read({ ...declare([]), migration: { fromVersion: 0, steps: [operation] } }),
      code('DATA_SCHEMA_INVALID'),
    );
  const steps: MigrationStep[] = Array.from({ length: 64 }, (_, index) => ({
    operation: 'addKey',
    key: `key${index}`,
    value: null,
  }));
  assert.doesNotThrow(() => read(declare(steps)));
  assert.throws(() => read(declare([...steps, steps[0]!])), code('DATA_SCHEMA_LIMIT'));
  const sparse = declare([]);
  sparse.migration!.steps = new Array(1);
  assert.throws(() => schemaDefinition(sparse), code('DATA_SCHEMA_INVALID'));
});

test('migration defaults reject accessors, pollution, non-JSON and excessive values without revealing content', () => {
  let accessed = 0;
  const getter = Object.defineProperty({}, 'field', {
    enumerable: true,
    get() {
      accessed++;
      return 'sensitive sentinel';
    },
  });
  for (const value of [
    getter,
    Object.setPrototypeOf([], null),
    Object.assign(Object.create({ inherited: true }), { title: 'plain' }),
    NaN,
    undefined,
    () => true,
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) {
    const raw = declare([{ operation: 'addKey', key: 'posts', value: value as never }]);
    assert.throws(
      () => schemaDefinition(raw),
      (error) => code('DATA_SCHEMA_INVALID')(error) && !String(error).includes('sentinel'),
    );
  }
  assert.equal(accessed, 0);
  assert.throws(
    () =>
      schemaDefinition(
        declare([{ operation: 'addKey', key: 'text', value: 'x'.repeat(128 * 1024 + 1) }]),
      ),
    code('DATA_SCHEMA_LIMIT'),
  );
});

test('all four migration operations preserve existing values and return an independent target snapshot', () => {
  const input: AppDataSnapshot['values'] = {
    articles: [{ heading: 'A' }, { heading: 'B', published: true }],
  };
  const before = JSON.stringify(input);
  const schema = declare(
    [
      { operation: 'renameKey', from: 'articles', to: 'posts' },
      { operation: 'renameField', key: 'posts', from: 'heading', to: 'title' },
      { operation: 'addField', key: 'posts', field: 'published', value: false },
      { operation: 'addKey', key: 'theme', value: 'light' },
    ],
    {
      posts: posts({ title: { type: 'string' }, published: { type: 'boolean' } }),
      theme: { type: 'string' },
    },
  );
  const result = migrateSchemaValues(input, schema);
  assert.deepEqual(result, {
    posts: [
      { published: false, title: 'A' },
      { published: true, title: 'B' },
    ],
    theme: 'light',
  });
  assert.equal(JSON.stringify(input), before);
  (result.posts as Array<Record<string, unknown>>)[0]!.title = 'changed';
  assert.equal((input.articles as Array<Record<string, unknown>>)[0]!.heading, 'A');
});

test('top-level rename and addition reject missing or conflicting keys without mutation', () => {
  for (const [values, operation] of [
    [{}, { operation: 'renameKey', from: 'articles', to: 'posts' }],
    [
      { articles: [], posts: [] },
      { operation: 'renameKey', from: 'articles', to: 'posts' },
    ],
    [{ posts: [] }, { operation: 'addKey', key: 'posts', value: [] }],
  ] as Array<[AppDataSnapshot['values'], MigrationStep]>) {
    const before = JSON.stringify(values);
    assert.throws(
      () => migrateSchemaValues(values, declare([operation])),
      code('DATA_SCHEMA_MIGRATION_CONFLICT'),
    );
    assert.equal(JSON.stringify(values), before);
  }
});

test('row migrations reject non-array data, non-object rows and late-row rename conflicts atomically', () => {
  const rejected: AppDataSnapshot['values'][] = [
    {},
    { posts: {} },
    { posts: [null] },
    { posts: [[]] },
    { posts: [{ heading: 'A' }, {}] },
    { posts: [{ heading: 'A' }, { heading: 'B', title: 'preserved' }] },
  ];
  for (const values of rejected) {
    const before = JSON.stringify(values);
    assert.throws(
      () =>
        migrateSchemaValues(
          values,
          declare([{ operation: 'renameField', key: 'posts', from: 'heading', to: 'title' }]),
        ),
      code('DATA_SCHEMA_MIGRATION_CONFLICT'),
    );
    assert.equal(JSON.stringify(values), before);
  }
});

test('target validation prevents implicit deletion, incompatible defaults and incomplete migrations', () => {
  const input = { posts: [{ heading: 'preserve' }] };
  assert.throws(() => migrateSchemaValues(input, declare([])), code('DATA_SCHEMA_MISMATCH'));
  assert.throws(
    () => migrateSchemaValues({}, declare([{ operation: 'addKey', key: 'posts', value: 42 }])),
    code('DATA_SCHEMA_MISMATCH'),
  );
  assert.deepEqual(input, { posts: [{ heading: 'preserve' }] });
  assert.deepEqual(migrateSchemaValues({ posts: [] }, { schemaVersion: 1, ...definition() }), {
    posts: [],
  });
});

test('128-key migration is a whole snapshot and does not inherit the 32-change SDK limit', () => {
  const values = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [`key${index}`, index]),
  );
  const keys: DataSchemaDefinition['keys'] = Object.fromEntries(
    Object.keys(values).map((key) => [key, { type: 'number' }]),
  );
  const result = migrateSchemaValues(values, declare([], keys));
  assert.deepEqual(result, values);
  assert.notEqual(result, values);
});
