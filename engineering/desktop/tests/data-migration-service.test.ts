import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DataMigrationService } from '../src/main/data-migration-service';
import { AppDataStore } from '../src/main/app-data-store';
import { ProjectStore } from '../src/main/project-store';
import { SourceStore } from '../src/main/source-store';
import { AppError } from '../src/main/validation';
import { AppDataService } from '../src/main/app-data-service';
import { dataSchemaHash, schemaDefinition } from '../src/main/data-schema-protocol';
import type { DataSchemaDeclaration } from '../src/shared/data-schema-contracts';
import type { BuildArtifact } from '../src/shared/build-contracts';
import type { SourceToolExecutor } from '../src/main/source-tools';
import { sourceHash } from '../src/main/source-protocol';

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const declaration: DataSchemaDeclaration = {
  schemaVersion: 1,
  version: 1,
  keys: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, published: { type: 'boolean' } },
        required: ['title', 'published'],
      },
    },
  },
  migration: {
    fromVersion: 0,
    steps: [
      { operation: 'renameKey', from: 'articles', to: 'posts' },
      { operation: 'addField', key: 'posts', field: 'published', value: false },
    ],
  },
};
function fixture(t: TestContext, initialize = true) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-migration-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root),
    p = projects.create({ name: '合成结构迁移', idea: '保存文章' }),
    id = p.id;
  const sources = new SourceStore(projects),
    data = new AppDataStore(projects);
  const binding = {
    planRunId: randomUUID(),
    planInputHash: 'a'.repeat(64),
    planArtifactHash: 'b'.repeat(64),
  };
  const setSource = (value: DataSchemaDeclaration | null) => {
    const s = sources.get(id),
      file = s.files.find((f) => f.path === 'src/data-schema.json');
    if (!value && !file) return;
    sources.apply(id, {
      requestId: randomUUID(),
      binding,
      expectedRevision: s.revision,
      changes: value
        ? [
            {
              operation: 'write',
              path: 'src/data-schema.json',
              content: JSON.stringify(value),
              expectedHash: file?.sha256 ?? null,
            },
          ]
        : [{ operation: 'delete', path: 'src/data-schema.json', expectedHash: file!.sha256 }],
    });
  };
  const put = (title: string) =>
    data.apply(id, {
      requestId: randomUUID(),
      expectedRevision: data.get(id).revision,
      changes: [{ operation: 'put', key: 'articles', value: [{ title }] }],
    });
  if (initialize) put('私人业务正文哨兵');
  setSource(declaration);
  let now = Date.now(),
    closes = 0,
    close = async () => {};
  const service = new DataMigrationService(projects, data, sources, {
    now: () => now,
    closeApplication: async () => {
      closes++;
      await close();
    },
  });
  const request = { schemaVersion: 1 as const, projectId: id };
  const preview = (operation: 'migrate' | 'rollback' = 'migrate') =>
    service.preview({ ...request, operation });
  const confirm = (previewId: string) => service.confirm({ ...request, previewId });
  return {
    root,
    id,
    data,
    projects,
    sources,
    binding,
    service,
    request,
    put,
    setSource,
    preview,
    confirm,
    closes: () => closes,
    setClose: (fn: () => Promise<void>) => (close = fn),
    advance: () => (now += 600_001),
  };
}
test('status does not initialize; existing unversioned data requires explicit migration before opening', (t) => {
  const f = fixture(t, false);
  assert.equal(f.service.state(f.request).initialized, false);
  assert.equal(f.data.inspect(f.id), null);
  f.service.assertCompatible(f.id);
  f.put('private');
  assert.equal(f.service.state(f.request).canMigrate, true);
  assert.throws(() => f.service.assertCompatible(f.id), code('APP_DATA_SCHEMA_MISMATCH'));
  assert.equal(f.data.inspect(f.id)?.schema, undefined);
});
test('migration preview omits values; confirmation closes once, preserves source and exactly replays', async (t) => {
  const f = fixture(t),
    source = f.sources.get(f.id),
    p = f.preview();
  assert.equal(JSON.stringify(p).includes('私人业务正文哨兵'), false);
  assert.deepEqual(p.addedKeys, ['posts']);
  assert.deepEqual(p.removedKeys, ['articles']);
  assert.equal(f.closes(), 0);
  assert.equal((await f.confirm(p.previewId)).revision, 2);
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.sources.get(f.id), source);
  assert.equal(f.service.state(f.request).compatible, true);
  f.service.assertCompatible(f.id);
  const current = f.data.get(f.id, schemaDefinition(declaration));
  assert.deepEqual(current.values, { posts: [{ published: false, title: '私人业务正文哨兵' }] });
  assert.equal((await f.confirm(p.previewId)).replayed, true);
  assert.equal(f.closes(), 1);
  assert.equal(new AppDataStore(f.projects).inspect(f.id)?.schema?.version, 1);
});
test('rollback needs old source schema, appends revision and remains idempotent after reopening', async (t) => {
  const f = fixture(t);
  await f.confirm(f.preview().previewId);
  assert.equal(f.service.state(f.request).canRollback, false);
  assert.throws(() => f.preview('rollback'), code('DATA_MIGRATION_UNAVAILABLE'));
  f.setSource(null);
  assert.equal(f.service.state(f.request).canRollback, true);
  const p = f.preview('rollback');
  assert.equal(p.targetVersion, 0);
  assert.equal((await f.confirm(p.previewId)).revision, 3);
  assert.equal((await f.confirm(p.previewId)).replayed, true);
  assert.deepEqual(new AppDataStore(f.projects).get(f.id).values, {
    articles: [{ title: '私人业务正文哨兵' }],
  });
  assert.equal(f.service.state(f.request).compatible, true);
  assert.equal(f.service.state(f.request).canRollback, false);
});
test('business writes after migration permanently block destructive rollback', async (t) => {
  const f = fixture(t);
  await f.confirm(f.preview().previewId);
  f.data.apply(
    f.id,
    {
      requestId: randomUUID(),
      expectedRevision: 2,
      changes: [{ operation: 'put', key: 'posts', value: [] }],
    },
    schemaDefinition(declaration),
  );
  f.setSource(null);
  assert.equal(f.service.state(f.request).canRollback, false);
  assert.throws(() => f.preview('rollback'), code('DATA_MIGRATION_UNAVAILABLE'));
});
test('changed data, source, name and archive invalidate previews before closing', async (t) => {
  for (const change of ['data', 'source', 'archive'] as const) {
    const f = fixture(t),
      p = f.preview();
    if (change === 'data') f.put('new');
    if (change === 'source')
      f.setSource({ ...declaration, migration: { fromVersion: 0, steps: [] } });
    if (change === 'archive') f.projects.archive(f.id, true);
    await assert.rejects(f.confirm(p.previewId), code('DATA_MIGRATION_STALE'));
    assert.equal(f.closes(), 0);
  }
});
test('shutdown await rechecks mutations, discard and expiry without migrating', async (t) => {
  for (const action of ['data', 'cancel', 'discard', 'expire'] as const) {
    const f = fixture(t),
      p = f.preview();
    f.setClose(async () => {
      if (action === 'data') f.put('late');
      if (action === 'cancel') f.service.cancel();
      if (action === 'discard') f.service.discard({ ...f.request, previewId: p.previewId });
      if (action === 'expire') f.advance();
    });
    await assert.rejects(
      f.confirm(p.previewId),
      code(action === 'data' ? 'DATA_MIGRATION_STALE' : 'DATA_MIGRATION_CANCELLED'),
    );
    assert.equal(f.data.inspect(f.id)?.schema, undefined);
  }
});
test('lost acknowledgement reconciles exact migration receipt instead of a second migration', async (t) => {
  const f = fixture(t),
    original = f.data.migrate.bind(f.data);
  let once = true;
  f.data.migrate = (...args) => {
    const result = original(...args);
    if (once) {
      once = false;
      throw new AppError('APP_DATA_COMMIT_UNCERTAIN', '合成响应丢失');
    }
    return result;
  };
  const p = f.preview();
  await assert.rejects(f.confirm(p.previewId));
  const retry = await f.confirm(p.previewId);
  assert.equal(retry.replayed, true);
  assert.equal(retry.revision, 2);
});
test('malformed requests, wrong IDs, new preview and a restarted service cannot confirm prior tokens', async (t) => {
  const f = fixture(t),
    p = f.preview();
  assert.throws(() => f.service.preview({ ...f.request, operation: 'script', values: {} }));
  await assert.rejects(f.confirm(randomUUID()), code('DATA_MIGRATION_CANCELLED'));
  f.preview();
  await assert.rejects(f.confirm(p.previewId), code('DATA_MIGRATION_CANCELLED'));
  const restarted = new DataMigrationService(f.projects, f.data, f.sources, {
    closeApplication: async () => {},
  });
  await assert.rejects(
    restarted.confirm({ ...f.request, previewId: p.previewId }),
    code('DATA_MIGRATION_CANCELLED'),
  );
});
test('same version altered schema and skipped versions do not become migrations', (t) => {
  const f = fixture(t);
  f.setSource({ ...declaration, version: 2, migration: { fromVersion: 1, steps: [] } });
  assert.equal(f.service.state(f.request).canMigrate, false);
  assert.throws(() => f.preview(), code('DATA_MIGRATION_UNAVAILABLE'));
});
test('generated sessions use artifact schema, temporary validation and persistent schema enforcement', async (t) => {
  const f = fixture(t);
  const source = f.sources.get(f.id);
  const artifact = {
    id: randomUUID(),
    projectId: f.id,
    sourceRevision: source.revision,
    sourceHash: sourceHash(JSON.stringify(source)),
    ...f.binding,
  } as BuildArtifact;
  const tools = { prepare: () => ({ binding: f.binding }) } as unknown as Pick<
    SourceToolExecutor,
    'prepare'
  >;
  const runtime = new AppDataService(f.data, tools, f.sources),
    session = runtime.create(artifact, 'persistent');
  assert.equal(session.execute({ schemaVersion: 1, operation: 'read' }).ok, false);
  const temp = runtime.create(artifact, 'temporary');
  assert.equal(
    temp.execute({
      schemaVersion: 1,
      operation: 'apply',
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: [{ operation: 'put', key: 'articles', value: [] }],
    }).ok,
    false,
  );
  assert.deepEqual(temp.execute({ schemaVersion: 1, operation: 'read' }), {
    ok: true,
    value: { revision: 0, values: {} },
  });
  await f.confirm(f.preview().previewId);
  assert.equal(session.execute({ schemaVersion: 1, operation: 'read' }).ok, true);
  const legacySource = f.sources.at(f.id, 0);
  const legacy = runtime.create(
    { ...artifact, sourceRevision: 0, sourceHash: sourceHash(JSON.stringify(legacySource)) },
    'persistent',
  );
  assert.equal(legacy.execute({ schemaVersion: 1, operation: 'read' }).ok, false);
  assert.throws(
    () => runtime.create({ ...artifact, sourceHash: '0'.repeat(64) }, 'persistent'),
    code('STALE_SOURCE'),
  );
  assert.equal(
    dataSchemaHash(f.data.inspect(f.id)!.schema ?? null),
    dataSchemaHash(schemaDefinition(declaration)),
  );
});
