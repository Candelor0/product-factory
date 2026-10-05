import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { APP_DATA_LIMITS } from '../src/main/app-data-protocol';
import {
  DATA_BACKUP_MAX_BYTES,
  decodeDataBackup,
  encodeDataBackup,
  type DataBackup,
} from '../src/main/data-backup-protocol';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';

const input = () => ({
  exportedAt: '2026-10-05T00:00:00.000Z',
  productFactoryVersion: '0.14.0',
  project: { id: randomUUID(), name: '合成数据项目' },
  storeId: randomUUID(),
  sourceContentHash: sourceHash('synthetic source content'),
  snapshot: { revision: 9, values: { zed: { zebra: '文本', alpha: 1 }, alpha: [true, null, 2] } },
});
const valid = () => JSON.parse(encodeDataBackup(input()).toString()) as DataBackup;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected && !error.message.includes('合成数据项目');

test('legacy v1 backups remain readable as unversioned data', () => {
  const current = valid();
  const { integrity: _integrity, dataSchema: _schema, dataSchemaHash: _hash, ...payload } = current;
  const legacy = { ...payload, schemaVersion: 1, format: 'product-factory-app-data-v1' };
  const result = decodeDataBackup(
    bytes({ ...legacy, integrity: sourceHash(JSON.stringify(legacy)) }),
  );
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.dataSchema, undefined);
  assert.deepEqual(result.snapshot, current.snapshot);
});

test('versioned backup binds canonical schema and refuses invalid typed values', () => {
  const value = {
    ...input(),
    dataSchema: { version: 1, keys: { posts: { type: 'string' as const } } },
    snapshot: { revision: 1, values: { posts: 'private' } },
  };
  const result = decodeDataBackup(encodeDataBackup(value));
  assert.deepEqual(result.dataSchema, value.dataSchema);
  const changed = { ...result, dataSchemaHash: '0'.repeat(64) };
  assert.throws(() => decodeDataBackup(resign(changed)), code('DATA_BACKUP_INVALID'));
  assert.throws(() =>
    encodeDataBackup({ ...value, snapshot: { revision: 1, values: { posts: 9 } } }),
  );
  result.snapshot.values.posts = 9;
  assert.throws(() => decodeDataBackup(resign(result)), code('DATA_BACKUP_INVALID'));
});
/** This checksum is public, deliberately not an authenticity signature. */
function resign(value: DataBackup): Buffer {
  value.snapshotHash = sourceHash(JSON.stringify(value.snapshot));
  const { integrity: _integrity, ...payload } = value;
  return bytes({ ...payload, integrity: sourceHash(JSON.stringify(payload)) });
}

test('export and import round-trip canonical business snapshots with stable hashes and isolated values', () => {
  const value = input();
  const backup = encodeDataBackup(value);
  assert.deepEqual(backup, encodeDataBackup(value));
  const result = decodeDataBackup(backup);
  assert.equal(result.format, 'product-factory-app-data-v2');
  assert.equal(result.project.id, value.project.id);
  assert.equal(result.storeId, value.storeId);
  assert.deepEqual(Object.keys(result.snapshot.values), ['alpha', 'zed']);
  assert.deepEqual(Object.keys(result.snapshot.values.zed as object), ['alpha', 'zebra']);
  assert.equal(result.snapshotHash, sourceHash(JSON.stringify(result.snapshot)));
  const { integrity, ...payload } = result;
  assert.equal(integrity, sourceHash(JSON.stringify(payload)));
  result.snapshot.values.alpha = 'changed after parse';
  assert.deepEqual(decodeDataBackup(backup).snapshot.values.alpha, [true, null, 2]);
  assert.deepEqual(value.snapshot.values.alpha, [true, null, 2]);
});

test('envelope excludes source files, credentials, AI records, data history and fixed-blog data', () => {
  const result = valid();
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      'schemaVersion',
      'format',
      'exportedAt',
      'productFactoryVersion',
      'project',
      'storeId',
      'sourceContentHash',
      'snapshot',
      'snapshotHash',
      'integrity',
      'dataSchema',
      'dataSchemaHash',
    ].sort(),
  );
  assert.deepEqual(Object.keys(result.snapshot).sort(), ['revision', 'values']);
  assert.equal(result.schemaVersion, 2);
});

test('malformed JSON, BOM and malformed UTF-8 are rejected rather than silently normalized', () => {
  const backup = encodeDataBackup(input());
  for (const bad of [
    Buffer.alloc(0),
    Buffer.from('{'),
    Buffer.from([0xc3, 0x28]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), backup]),
  ])
    assert.throws(() => decodeDataBackup(bad), code('DATA_BACKUP_INVALID'));
  const invalidUtf8 = Buffer.from(backup);
  invalidUtf8[invalidUtf8.indexOf(Buffer.from('文本'))] = 0xff;
  assert.throws(() => decodeDataBackup(invalidUtf8), code('DATA_BACKUP_INVALID'));
});

test('unknown versions and backup formats are refused', () => {
  for (const update of [
    { schemaVersion: 3 },
    { schemaVersion: '1' },
    { format: 'product-factory-source-v1' },
    { format: 'blog-data-v1' },
  ])
    assert.throws(
      () => decodeDataBackup(bytes({ ...valid(), ...update })),
      code('DATA_BACKUP_UNSUPPORTED'),
    );
});

test('unexpected fields and missing required fields do not become accepted import metadata', () => {
  for (const mutate of [
    (value: DataBackup) => Object.assign(value, { credentials: {} }),
    (value: DataBackup) => Object.assign(value.project, { path: '../other' }),
    (value: DataBackup) => Object.assign(value.snapshot, { receipts: [] }),
    (value: DataBackup) => {
      delete (value as Partial<DataBackup>).integrity;
    },
    (value: DataBackup) => {
      delete (value as Partial<DataBackup>).storeId;
    },
    (value: DataBackup) => {
      delete (value as Partial<DataBackup>).sourceContentHash;
    },
  ]) {
    const value = valid();
    mutate(value);
    assert.throws(() => decodeDataBackup(bytes(value)), code('DATA_BACKUP_INVALID'));
  }
});

test('metadata validates canonical IDs, hashes, timestamps and supported version spelling', () => {
  for (const update of [
    { storeId: '12345678-1234-7234-8234-123456789012' },
    { sourceContentHash: 'F'.repeat(64) },
    { snapshotHash: 'invalid' },
    { exportedAt: '2026-10-05' },
    { exportedAt: 'invalid' },
    { productFactoryVersion: 'version 0.14.0' },
    { project: { id: '../other', name: '合成数据项目' } },
  ])
    assert.throws(
      () => decodeDataBackup(bytes({ ...valid(), ...update })),
      code('DATA_BACKUP_INVALID'),
    );
});

test('value or metadata tampering is detected by canonical snapshot and envelope checksums', () => {
  for (const mutate of [
    (value: DataBackup) => {
      value.snapshot.values.alpha = 'changed';
    },
    (value: DataBackup) => {
      value.snapshot.revision++;
    },
    (value: DataBackup) => {
      value.project.name = 'new name';
    },
    (value: DataBackup) => {
      value.project.id = randomUUID();
    },
    (value: DataBackup) => {
      value.storeId = randomUUID();
    },
    (value: DataBackup) => {
      value.sourceContentHash = 'f'.repeat(64);
    },
    (value: DataBackup) => {
      value.integrity = '0'.repeat(64);
    },
  ]) {
    const value = valid();
    mutate(value);
    assert.throws(() => decodeDataBackup(bytes(value)), code('DATA_BACKUP_INVALID'));
  }
});

test('public checksum recomputation is valid structure, not proof of project authorization or authenticity', () => {
  const value = valid();
  value.snapshot.values.alpha = 'explicitly edited synthetic backup';
  value.project.id = randomUUID();
  value.storeId = randomUUID();
  const parsed = decodeDataBackup(resign(value));
  assert.equal(parsed.snapshot.values.alpha, 'explicitly edited synthetic backup');
  assert.equal(parsed.project.id, value.project.id);
  // The service, not this file parser, checks current project/store/source identity and user consent.
});

test('prototype keys are rejected at every business JSON depth without changing global objects', () => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const value = valid();
    value.snapshot.values = JSON.parse(`{"safe":{"${name}":{"polluted":true}}}`);
    assert.throws(() => decodeDataBackup(resign(value)), code('DATA_BACKUP_INVALID'));
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  }
});

test('snapshot rules reject impossible zero revisions, unsafe revisions and invalid keys', () => {
  for (const snapshot of [
    { revision: 0, values: { data: 1 } },
    { revision: -1, values: {} },
    { revision: 1.2, values: {} },
    { revision: Number.MAX_SAFE_INTEGER + 1, values: {} },
    { revision: 1, values: { '../file': 1 } },
  ]) {
    const value = valid();
    value.snapshot = snapshot as DataBackup['snapshot'];
    assert.throws(() => decodeDataBackup(resign(value)), code('DATA_BACKUP_INVALID'));
  }
  const empty = input();
  empty.snapshot = { revision: 0, values: {} } as typeof empty.snapshot;
  assert.deepEqual(decodeDataBackup(encodeDataBackup(empty)).snapshot, { revision: 0, values: {} });
});

test('full 128-key snapshot is accepted without the SDK 32-change transaction limit', () => {
  const value = input();
  const values = Object.fromEntries(
    Array.from({ length: APP_DATA_LIMITS.keys }, (_, i) => [
      `key_${String(i).padStart(3, '0')}`,
      { title: `合成 ${i}` },
    ]),
  );
  const parsed = decodeDataBackup(
    encodeDataBackup({ ...value, snapshot: { revision: 256, values } }),
  );
  assert.equal(Object.keys(parsed.snapshot.values).length, 128);
  assert.equal(parsed.snapshot.revision, 256);
  assert.deepEqual(parsed.snapshot.values, values);
});

test('file, key count, value size, depth and total snapshot capacity stay bounded on untrusted imports', () => {
  assert.throws(
    () => decodeDataBackup(Buffer.alloc(DATA_BACKUP_MAX_BYTES + 1)),
    code('DATA_BACKUP_LIMIT'),
  );
  let nested: unknown = 'leaf';
  for (let i = 0; i < 18; i++) nested = { child: nested };
  const badValues = [
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`key_${i}`, i])),
    { big: 'x'.repeat(APP_DATA_LIMITS.valueBytes + 1) },
    { nested },
    { many: Array.from({ length: APP_DATA_LIMITS.nodes + 1 }, () => 1) },
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`key_${i}`, 'x'.repeat(120 * 1024)])),
  ];
  for (const values of badValues) {
    const value = valid();
    value.snapshot.values = values as DataBackup['snapshot']['values'];
    assert.throws(() => decodeDataBackup(resign(value)), code('DATA_BACKUP_INVALID'));
  }
});
