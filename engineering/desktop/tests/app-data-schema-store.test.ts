import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { AppDataStore, type AppDataMigrateRequest } from '../src/main/app-data-store';
import { APP_DATA_LIMITS } from '../src/main/app-data-protocol';
import { dataSchemaHash } from '../src/main/data-schema-protocol';
import { ProjectStore } from '../src/main/project-store';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';
import type { AppDataSnapshot } from '../src/shared/app-data-contracts';
import type { DataSchemaDefinition } from '../src/shared/data-schema-contracts';

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const schema1: DataSchemaDefinition = { version: 1, keys: { articles: { type: 'string' } } };
const schema2: DataSchemaDefinition = { version: 2, keys: { posts: { type: 'string' } } };
const apply = (expectedRevision: number, key = 'articles', value = 'original') => ({
  requestId: randomUUID(),
  expectedRevision,
  changes: [{ operation: 'put' as const, key, value }],
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-data-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '结构迁移合成测试', idea: '不连接真实应用' });
  const directory = join(root, 'projects', project.id, 'data', 'generated');
  const file = join(directory, 'state.json');
  const inner = join(directory, 'identity.json');
  const outer = join(directory, '..', 'generated.initialized.json');
  const store = new AppDataStore(projects);
  const reopen = () => new AppDataStore(new ProjectStore(root));
  const base = () => {
    const inspected = store.inspect(project.id)!;
    return {
      requestId: randomUUID(),
      storeId: inspected.storeId,
      expectedRevision: inspected.snapshot.revision,
      expectedHash: inspected.sha256,
      fromSchemaHash: dataSchemaHash(inspected.schema ?? null),
    };
  };
  const migrate = (
    schema: DataSchemaDefinition | null = schema1,
    values: AppDataSnapshot['values'] = { articles: 'migrated' },
  ): AppDataMigrateRequest => ({ ...base(), schema, values });
  const raw = () => JSON.parse(readFileSync(file, 'utf8'));
  return {
    root,
    projects,
    id: project.id,
    directory,
    file,
    inner,
    outer,
    store,
    reopen,
    base,
    migrate,
    raw,
  };
}

test('legacy records stay schema 1 until explicit migration and inspecting never initializes schema state', (t) => {
  const f = fixture(t);
  assert.equal(f.store.inspect(f.id), null);
  assert.equal(existsSync(f.directory), false);
  const initial = apply(0);
  f.store.apply(f.id, initial);
  const before = readFileSync(f.file);
  assert.equal(f.raw().schemaVersion, 1);
  assert.equal(Object.hasOwn(f.store.inspect(f.id)!, 'schema'), false);
  assert.throws(() => f.reopen().get(f.id, schema1), code('APP_DATA_SCHEMA_MISMATCH'));
  assert.throws(() => f.reopen().apply(f.id, apply(1), schema1), code('APP_DATA_SCHEMA_MISMATCH'));
  assert.deepEqual(f.reopen().get(f.id), { revision: 1, values: { articles: 'original' } });
  assert.deepEqual(f.store.apply(f.id, initial), {
    revision: 1,
    appliedRevision: 1,
    replayed: true,
  });
  assert.deepEqual(readFileSync(f.file), before);
});

test('fresh expected schema initializes atomically and every subsequent get/apply must match and validate values', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.get(f.id, schema1), { revision: 0, values: {} });
  assert.equal(f.raw().schemaVersion, 2);
  assert.equal(f.raw().schemaHash, dataSchemaHash(schema1));
  assert.equal(f.raw().migration, null);
  const request = apply(0);
  f.store.apply(f.id, request, schema1);
  assert.deepEqual(f.reopen().apply(f.id, request, structuredClone(schema1)), {
    revision: 1,
    appliedRevision: 1,
    replayed: true,
  });
  const before = readFileSync(f.file);
  for (const expected of [
    null,
    schema2,
    { ...schema1, keys: { unknown: { type: 'string' as const } } },
  ]) {
    assert.throws(() => f.store.get(f.id, expected), code('APP_DATA_SCHEMA_MISMATCH'));
    assert.throws(() => f.store.apply(f.id, request, expected), code('APP_DATA_SCHEMA_MISMATCH'));
  }
  assert.throws(
    () => f.store.apply(f.id, apply(1, 'undeclared'), schema1),
    code('DATA_SCHEMA_MISMATCH'),
  );
  assert.throws(
    () =>
      f.store.apply(
        f.id,
        { ...apply(1), changes: [{ operation: 'put', key: 'articles', value: 1 }] },
        schema1,
      ),
    code('DATA_SCHEMA_MISMATCH'),
  );
  assert.deepEqual(readFileSync(f.file), before);
  const inspected = f.store.inspect(f.id)!;
  inspected.schema!.keys.articles = { type: 'number' };
  assert.deepEqual(f.reopen().inspect(f.id)!.schema, schema1);
});

test('explicit migration atomically upgrades disk schema and retains all receipts, history, identity and exact checkpoint', (t) => {
  const f = fixture(t);
  f.store.apply(f.id, apply(0));
  f.store.apply(f.id, apply(1, 'articles', 'second'));
  const before = f.raw();
  const identity = readFileSync(f.inner),
    marker = readFileSync(f.outer);
  const request = f.migrate();
  assert.deepEqual(f.store.migrate(f.id, request), {
    revision: 3,
    appliedRevision: 3,
    replayed: false,
  });
  const after = f.raw();
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.schema, schema1);
  assert.deepEqual(after.history, [...before.history, before.current]);
  assert.deepEqual(after.receipts.slice(0, -1), before.receipts);
  assert.deepEqual(after.migration.before, before.current);
  assert.equal(after.migration.beforeSchema, null);
  const { sha256, ...payload } = after.migration;
  assert.equal(sha256, sourceHash(JSON.stringify(payload)));
  const inspection = f.reopen().inspect(f.id)!;
  assert.equal(inspection.migration!.canRollback, true);
  assert.deepEqual(inspection.migration!.beforeSnapshot, before.current.snapshot);
  inspection.migration!.beforeSnapshot.values.articles = 'mutated clone';
  assert.equal(f.store.inspect(f.id)!.migration!.beforeSnapshot.values.articles, 'second');
  assert.deepEqual(readFileSync(f.inner), identity);
  assert.deepEqual(readFileSync(f.outer), marker);
  assert.deepEqual(f.reopen().migrate(f.id, request), {
    revision: 3,
    appliedRevision: 3,
    replayed: true,
  });
});

test('migration permits only adjacent schema versions, validates all values and rejects changed request or state', (t) => {
  const f = fixture(t);
  f.store.apply(f.id, apply(0));
  const valid = f.migrate();
  const before = readFileSync(f.file);
  for (const request of [f.migrate(null, {}), f.migrate(schema2, { posts: 'skip' })])
    assert.throws(() => f.store.migrate(f.id, request), code('APP_DATA_MIGRATION_CONFLICT'));
  for (const changed of [
    { ...valid, expectedRevision: 0 },
    { ...valid, expectedHash: '0'.repeat(64) },
    { ...valid, storeId: randomUUID() },
  ])
    assert.throws(() => f.store.migrate(f.id, changed), code('APP_DATA_CONFLICT'));
  assert.throws(
    () => f.store.migrate(f.id, { ...valid, fromSchemaHash: '0'.repeat(64) }),
    code('APP_DATA_SCHEMA_MISMATCH'),
  );
  assert.throws(
    () => f.store.migrate(f.id, { ...valid, values: { undeclared: 'private rejected value' } }),
    (error) => code('DATA_SCHEMA_MISMATCH')(error) && !(error as Error).message.includes('private'),
  );
  assert.deepEqual(readFileSync(f.file), before);
  f.store.migrate(f.id, valid);
  assert.throws(
    () => f.store.migrate(f.id, { ...valid, values: {} }),
    code('APP_DATA_REQUEST_CONFLICT'),
  );
  assert.throws(
    () => f.store.migrate(f.id, f.migrate(schema1)),
    code('APP_DATA_MIGRATION_CONFLICT'),
  );
  f.store.migrate(f.id, f.migrate(schema2, { posts: 'new shape' }));
  const inspection = f.store.inspect(f.id)!;
  assert.equal(inspection.migration!.beforeSchema!.version, 1);
  assert.deepEqual(inspection.migration!.beforeSnapshot.values, { articles: 'migrated' });
  assert.equal(inspection.migration!.afterSchema.version, 2);
});

test('rollback restores before values and schema in a new version, stays disk schema 2 and is itself idempotent', (t) => {
  const f = fixture(t);
  f.store.apply(f.id, apply(0));
  const migration = f.migrate();
  f.store.migrate(f.id, migration);
  const rollback = f.base();
  assert.deepEqual(f.store.rollbackMigration(f.id, rollback), {
    revision: 3,
    appliedRevision: 3,
    replayed: false,
  });
  assert.deepEqual(f.reopen().get(f.id), { revision: 3, values: { articles: 'original' } });
  assert.equal(f.raw().schemaVersion, 2);
  assert.equal(f.raw().schema, null);
  assert.equal(f.raw().migration.rolledBack, true);
  assert.equal(f.store.inspect(f.id)!.migration!.canRollback, false);
  f.store.apply(f.id, apply(3, 'articles', 'later'));
  const before = readFileSync(f.file);
  assert.deepEqual(f.reopen().rollbackMigration(f.id, rollback), {
    revision: 4,
    appliedRevision: 3,
    replayed: true,
  });
  assert.deepEqual(f.reopen().migrate(f.id, migration), {
    revision: 4,
    appliedRevision: 2,
    replayed: true,
  });
  assert.throws(
    () => f.store.rollbackMigration(f.id, f.base()),
    code('APP_DATA_MIGRATION_CONFLICT'),
  );
  assert.deepEqual(readFileSync(f.file), before);
});

test('business apply or full restore after migration disables rollback and schema-bound restore cannot migrate', (t) => {
  for (const operation of ['apply', 'restore'] as const) {
    const f = fixture(t);
    f.store.get(f.id, schema1);
    f.store.migrate(f.id, f.migrate(schema2, { posts: 'migrated' }));
    const current = f.base();
    const restore = {
      requestId: randomUUID(),
      storeId: current.storeId,
      expectedRevision: current.expectedRevision,
      expectedHash: current.expectedHash,
      values: { posts: 'business' },
      schema: schema2,
    };
    assert.throws(
      () => f.store.restore(f.id, { ...restore, schema: null }),
      code('APP_DATA_SCHEMA_MISMATCH'),
    );
    assert.throws(
      () => f.store.restore(f.id, { ...restore, values: { articles: 'wrong' } }),
      code('DATA_SCHEMA_MISMATCH'),
    );
    if (operation === 'apply') f.store.apply(f.id, apply(1, 'posts', 'business'), schema2);
    else {
      f.store.restore(f.id, restore);
      assert.equal(f.reopen().restore(f.id, restore).replayed, true);
      assert.throws(
        () => f.store.restore(f.id, { ...restore, schema: schema1 }),
        code('APP_DATA_SCHEMA_MISMATCH'),
      );
    }
    assert.equal(f.store.inspect(f.id)!.migration!.canRollback, false);
    const before = readFileSync(f.file);
    assert.throws(
      () => f.store.rollbackMigration(f.id, f.base()),
      code('APP_DATA_MIGRATION_CONFLICT'),
    );
    assert.deepEqual(readFileSync(f.file), before);
  }
});

test('rollback between declared schemas preserves exact earlier values and a later migration replaces only its checkpoint', (t) => {
  const f = fixture(t);
  f.store.get(f.id, schema1);
  f.store.apply(f.id, apply(0), schema1);
  const migrate = f.migrate(schema2, { posts: 'next' });
  f.store.migrate(f.id, migrate);
  const rollback = f.base();
  f.store.rollbackMigration(f.id, rollback);
  assert.deepEqual(f.reopen().get(f.id, schema1), {
    revision: 3,
    values: { articles: 'original' },
  });
  assert.throws(() => f.store.get(f.id, schema2), code('APP_DATA_SCHEMA_MISMATCH'));
  const receipts = f.raw().receipts;
  const later = f.migrate(schema2, { posts: 'different next' });
  f.store.migrate(f.id, later);
  assert.deepEqual(f.raw().receipts.slice(0, -1), receipts);
  assert.equal(f.store.inspect(f.id)!.migration!.requestId, later.requestId);
  assert.deepEqual(f.store.inspect(f.id)!.migration!.beforeSnapshot, {
    revision: 3,
    values: { articles: 'original' },
  });
  assert.equal(f.store.inspect(f.id)!.migration!.canRollback, true);
  assert.equal(f.store.migrate(f.id, migrate).replayed, true);
});

test('operation-specific receipts reject apply/restore/migrate/rollback ID collisions', (t) => {
  const f = fixture(t);
  const prior = apply(0);
  f.store.apply(f.id, prior);
  assert.throws(
    () => f.store.migrate(f.id, { ...f.migrate(), requestId: prior.requestId }),
    code('APP_DATA_REQUEST_CONFLICT'),
  );
  const migration = f.migrate();
  f.store.migrate(f.id, migration);
  assert.throws(
    () => f.store.rollbackMigration(f.id, { ...f.base(), requestId: migration.requestId }),
    code('APP_DATA_REQUEST_CONFLICT'),
  );
  assert.throws(
    () => f.store.apply(f.id, { ...apply(2), requestId: migration.requestId }, schema1),
    code('APP_DATA_REQUEST_CONFLICT'),
  );
  const base = f.base();
  assert.throws(
    () =>
      f.store.restore(f.id, {
        ...base,
        fromSchemaHash: undefined,
        requestId: migration.requestId,
        values: {},
      } as never),
    code('APP_DATA_INVALID'),
  );
  const { fromSchemaHash: _hash, ...restoreBase } = base;
  assert.throws(
    () =>
      f.store.restore(f.id, {
        ...restoreBase,
        requestId: migration.requestId,
        values: {},
        schema: schema1,
      }),
    code('APP_DATA_REQUEST_CONFLICT'),
  );
});

test('schema/checkpoint corruption and excessive checkpoint data fail closed while leaving raw evidence unchanged', (t) => {
  const f = fixture(t);
  f.store.apply(f.id, apply(0));
  f.store.migrate(f.id, f.migrate());
  const original = f.raw();
  const mutations: ((raw: any) => void)[] = [
    (raw) => {
      delete raw.schema;
    },
    (raw) => {
      raw.schemaHash = '0'.repeat(64);
    },
    (raw) => {
      raw.migration.sha256 = '0'.repeat(64);
    },
    (raw) => {
      raw.migration.before.snapshot.values.articles = 'tampered';
    },
    (raw) => {
      raw.migration.appliedRevision = 1;
    },
    (raw) => {
      raw.migration.rolledBack = true;
    },
    (raw) => {
      raw.migration.requestId = randomUUID();
    },
    (raw) => {
      raw.migration.extra = true;
    },
    (raw) => {
      raw.schema.keys.articles.type = 'number';
      raw.schemaHash = dataSchemaHash(raw.schema);
    },
    (raw) => {
      raw.migration.beforeSchema = { version: 1, keys: {} };
    },
  ];
  for (const mutate of mutations) {
    const raw = structuredClone(original);
    mutate(raw);
    const bytes = JSON.stringify(raw);
    writeFileSync(f.file, bytes);
    assert.throws(() => f.reopen().inspect(f.id), code('APP_DATA_CORRUPT'));
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
  }
  for (const mutate of [
    (raw: any) => {
      raw.migration.requestId = randomUUID();
    },
    (raw: any) => {
      raw.migration.before.snapshot.values.articles = 'different checkpoint';
      raw.migration.before.sha256 = sourceHash(JSON.stringify(raw.migration.before.snapshot));
    },
    (raw: any) => {
      raw.migration.afterSchema.version = 3;
    },
  ]) {
    const raw = structuredClone(original);
    mutate(raw);
    const { sha256: _hash, ...checkpoint } = raw.migration;
    raw.migration.sha256 = sourceHash(JSON.stringify(checkpoint));
    writeFileSync(f.file, JSON.stringify(raw));
    assert.throws(() => f.reopen().inspect(f.id), code('APP_DATA_CORRUPT'));
  }
  writeFileSync(f.file, ' '.repeat(APP_DATA_LIMITS.recordBytes + 1));
  assert.throws(() => f.reopen().inspect(f.id), code('APP_DATA_LIMIT'));
  writeFileSync(f.file, JSON.stringify(original));
  const linked = join(f.root, 'linked-state');
  linkSync(f.file, linked);
  assert.throws(() => f.reopen().inspect(f.id), code('UNSAFE_PATH'));
});

test('migration/rollback writes use existing atomic checks and reconcile only exact post-rename contents', (t) => {
  const f = fixture(t);
  f.store.apply(f.id, apply(0));
  const request = f.migrate();
  const before = readFileSync(f.file);
  const pre = new AppDataStore(f.projects, {
    beforeRename: () => {
      throw new Error('synthetic');
    },
  });
  assert.throws(() => pre.migrate(f.id, request), code('APP_DATA_IO'));
  assert.deepEqual(readFileSync(f.file), before);
  const post = new AppDataStore(f.projects, {
    afterRename: () => {
      throw new Error('lost acknowledgement');
    },
  });
  assert.equal(post.migrate(f.id, request).replayed, false);
  assert.equal(f.reopen().migrate(f.id, request).replayed, true);
  const rollback = f.base();
  assert.throws(() => pre.rollbackMigration(f.id, rollback), code('APP_DATA_IO'));
  assert.equal(post.rollbackMigration(f.id, rollback).revision, 3);
  assert.equal(f.reopen().rollbackMigration(f.id, rollback).replayed, true);
  const uncertain = new AppDataStore(f.projects, {
    afterRename: () => {
      writeFileSync(f.file, '{broken');
      throw new Error();
    },
  });
  assert.throws(() => uncertain.migrate(f.id, f.migrate()), code('APP_DATA_COMMIT_UNCERTAIN'));
});

test('strict migration and rollback requests plus fresh archive/CAS checks preserve concurrent business data', (t) => {
  const f = fixture(t);
  f.store.apply(f.id, apply(0));
  const request = f.migrate();
  let reads = 0;
  const accessor = { ...request };
  Object.defineProperty(accessor, 'schema', {
    enumerable: true,
    get() {
      reads++;
      return schema1;
    },
  });
  for (const input of [
    { ...request, extra: true },
    { ...request, requestId: request.requestId.toUpperCase() },
    accessor,
  ])
    assert.throws(() => f.store.migrate(f.id, input), code('APP_DATA_INVALID'));
  assert.equal(reads, 0);
  assert.throws(
    () => f.store.rollbackMigration(f.id, { ...f.base(), values: {} } as never),
    code('APP_DATA_INVALID'),
  );
  const competing = new AppDataStore(f.projects, {
    beforeRename: () => f.store.apply(f.id, apply(1, 'articles', 'winner')),
  });
  assert.throws(() => competing.migrate(f.id, request), code('APP_DATA_CONFLICT'));
  assert.equal(f.store.get(f.id).values.articles, 'winner');
  const next = f.migrate();
  const archive = new AppDataStore(f.projects, {
    beforeRename: () => f.projects.archive(f.id, true),
  });
  assert.throws(() => archive.migrate(f.id, next), code('ARCHIVED'));
  assert.equal(f.store.inspect(f.id)!.schema, undefined);
  assert.throws(() => f.store.migrate(f.id, next), code('ARCHIVED'));
});

for (const boundary of ['beforeRename', 'afterRename'] as const) {
  test(`real SIGKILL at migration ${boundary} leaves one whole schema/data state and a fresh process deduplicates retry`, (t) => {
    const f = fixture(t);
    f.store.apply(f.id, apply(0));
    const request = f.migrate();
    const before = readFileSync(f.file),
      marker = readFileSync(f.outer);
    const imports = `import { ProjectStore } from ${JSON.stringify(pathToFileURL(resolve('src/main/project-store.ts')).href)}; import { AppDataStore } from ${JSON.stringify(pathToFileURL(resolve('src/main/app-data-store.ts')).href)}; const projects = new ProjectStore(${JSON.stringify(f.root)}); const id = ${JSON.stringify(f.id)}; const request = ${JSON.stringify(request)};`;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} new AppDataStore(projects,{ ${boundary}(){process.kill(process.pid,'SIGKILL');} }).migrate(id,request);`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    if (boundary === 'beforeRename') assert.deepEqual(readFileSync(f.file), before);
    const fresh = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} const store=new AppDataStore(projects); const before=store.inspect(id); const result=store.migrate(id,request); const replay=store.migrate(id,request); console.log(JSON.stringify({before,result,replay,after:store.inspect(id)}));`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    const result = JSON.parse(fresh.stdout),
      published = boundary === 'afterRename';
    assert.equal(result.before.snapshot.revision, published ? 2 : 1);
    assert.deepEqual(result.before.schema ?? null, published ? schema1 : null);
    assert.deepEqual(result.result, { revision: 2, appliedRevision: 2, replayed: published });
    assert.deepEqual(result.replay, { revision: 2, appliedRevision: 2, replayed: true });
    assert.deepEqual(result.after.snapshot, { revision: 2, values: request.values });
    assert.deepEqual(result.after.schema, schema1);
    assert.deepEqual(result.after.migration.beforeSnapshot, {
      revision: 1,
      values: { articles: 'original' },
    });
    assert.deepEqual(readFileSync(f.outer), marker);
    assert.equal(f.raw().receipts.length, 2);
  });
}
