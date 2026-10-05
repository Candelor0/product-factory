import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
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
import { AppDataStore } from '../src/main/app-data-store';
import { DataBackupService } from '../src/main/data-backup-service';
import { decodeDataBackup, encodeDataBackup } from '../src/main/data-backup-protocol';
import { assertExportContentsSafe } from '../src/main/export-security';
import { ProjectStore } from '../src/main/project-store';
import { SourceStore } from '../src/main/source-store';
import { sourceHash } from '../src/main/source-protocol';
import { writeExportArchive } from '../src/main/export-archive';
import { AppError } from '../src/main/validation';
import type { DataRestorePreview } from '../src/shared/data-backup-contracts';
import { dataSchemaHash } from '../src/main/data-schema-protocol';

const code = (value: string) => (error: unknown) =>
  error instanceof AppError && error.code === value;

test('legacy backup cannot erase schema metadata; versioned backup restores only matching schema', async (t) => {
  const f = fixture(t);
  await f.exportData();
  const initial = f.data.inspect(f.id)!;
  const schema = { version: 1, keys: { posts: { type: 'string' as const } } };
  f.data.migrate(f.id, {
    requestId: randomUUID(),
    storeId: initial.storeId,
    expectedRevision: initial.snapshot.revision,
    expectedHash: initial.sha256,
    fromSchemaHash: dataSchemaHash(null),
    schema,
    values: initial.snapshot.values,
  });
  // Source contents intentionally unchanged: schema equality is an independent restore gate.
  await assert.rejects(f.preview(), code('DATA_BACKUP_SCHEMA'));
  unlinkSync(f.output);
  await f.exportData();
  assert.deepEqual(decodeDataBackup(readFileSync(f.output)).dataSchema, schema);
  f.data.apply(
    f.id,
    {
      requestId: randomUUID(),
      expectedRevision: 2,
      changes: [{ operation: 'put', key: 'posts', value: 'new' }],
    },
    schema,
  );
  await f.confirm(await f.preview());
  assert.deepEqual(f.data.get(f.id, schema).values, initial.snapshot.values);
  assert.deepEqual(f.data.inspect(f.id)?.schema, schema);
});
function fixture(t: TestContext, initialize = true) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-data-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(join(root, '工作台'));
  const project = projects.create({ name: '数据备份', idea: '自己的文章' });
  const sources = new SourceStore(projects);
  const data = new AppDataStore(projects);
  const id = project.id;
  const request = { schemaVersion: 1 as const, projectId: id };
  const binding = {
    planRunId: randomUUID(),
    planInputHash: 'a'.repeat(64),
    planArtifactHash: 'b'.repeat(64),
  };
  const writeSource = (content: string) => {
    const current = sources.get(id);
    sources.apply(id, {
      requestId: randomUUID(),
      binding,
      expectedRevision: current.revision,
      changes: [
        {
          operation: 'write',
          path: 'src/app.tsx',
          content,
          expectedHash: current.files[0]?.sha256 ?? null,
        },
      ],
    });
  };
  writeSource('export default function App(){return <p>private app</p>}');
  const put = (value: string) =>
    data.apply(id, {
      requestId: randomUUID(),
      expectedRevision: data.get(id).revision,
      changes: [{ operation: 'put', key: 'posts', value }],
    });
  if (initialize) put('我的私人文章');
  const output = join(root, '中文 数据备份.json');
  let choose = async (): Promise<string | null> => output;
  let chooseImport = async (): Promise<string | null> => output;
  let close = async () => {};
  let closes = 0,
    scans = 0,
    now = Date.now();
  let scanner = assertExportContentsSafe;
  const service = new DataBackupService(projects, data, sources, {
    version: '0.14.0',
    protectedDirectories: [projects.rootPath],
    assertSafe: (text) => {
      scans++;
      scanner(text);
    },
    chooseDestination: () => choose(),
    chooseBackup: () => chooseImport(),
    closeApplication: async () => {
      closes++;
      await close();
    },
    now: () => now,
  });
  const exportData = () =>
    service.export({ ...request, expectedRevision: data.inspect(id)?.snapshot.revision ?? 0 });
  const preview = async () => {
    const result = await service.preview(request);
    assert.equal(result.status, 'preview');
    return result as DataRestorePreview;
  };
  const confirm = (p: DataRestorePreview) =>
    service.confirm({ ...request, previewId: p.previewId });
  return {
    root,
    project,
    projects,
    sources,
    data,
    id,
    request,
    service,
    output,
    writeSource,
    put,
    exportData,
    preview,
    confirm,
    setChooser: (fn: typeof choose) => (choose = fn),
    setImport: (fn: typeof chooseImport) => (chooseImport = fn),
    setClose: (fn: typeof close) => (close = fn),
    setScanner: (fn: typeof scanner) => (scanner = fn),
    advance: (ms: number) => (now += ms),
    counts: () => ({ closes, scans }),
    dataPath: join(projects.rootPath, 'projects', id, 'data', 'generated'),
  };
}
test('backup status/export/restore selection do not initialize an unused data store', async (t) => {
  const f = fixture(t, false);
  assert.deepEqual(f.service.state(f.request), {
    projectId: f.id,
    initialized: false,
    revision: null,
    keyCount: 0,
    bytes: 0,
  });
  await assert.rejects(f.exportData(), code('DATA_BACKUP_EMPTY'));
  await assert.rejects(f.preview(), code('DATA_BACKUP_EMPTY'));
  assert.equal(existsSync(f.dataPath), false);
  assert.equal(existsSync(f.output), false);
});
test('export is a separate current snapshot with integrity and no history, source, credentials or AI records', async (t) => {
  const f = fixture(t);
  const base = join(f.projects.rootPath, 'projects', f.id);
  writeFileSync(join(base, 'runs', 'app-ai.json'), 'unrelated-ai-ledger-must-not-be-read');
  mkdirSync(join(base, 'data', 'blog'));
  writeFileSync(join(base, 'data', 'blog', 'articles.json'), 'sample-blog-private-text');
  f.put('替换后的私人文章');
  const before = readFileSync(join(f.dataPath, 'state.json'));
  const result = await f.exportData();
  assert.equal(result.status, 'exported');
  const bytes = readFileSync(f.output);
  const backup = decodeDataBackup(bytes);
  assert.equal(backup.snapshot.values.posts, '替换后的私人文章');
  assert.equal(backup.snapshot.revision, 2);
  assert.equal(backup.project.id, f.id);
  assert.ok(!bytes.includes(Buffer.from('我的私人文章')));
  assert.ok(!bytes.includes(Buffer.from('sample-blog-private-text')));
  assert.ok(!bytes.includes(Buffer.from('private app')));
  assert.ok(!bytes.includes(Buffer.from('unrelated-ai-ledger')));
  assert.deepEqual(readFileSync(join(f.dataPath, 'state.json')), before);
  assert.equal(f.counts().scans, 2);
});
test('restore previews only key differences, replaces atomically, retains source and permits idempotent confirmation', async (t) => {
  const f = fixture(t);
  await f.exportData();
  f.put('较新的文字');
  f.data.apply(f.id, {
    requestId: randomUUID(),
    expectedRevision: 2,
    changes: [{ operation: 'put', key: 'extra', value: 1 }],
  });
  const sourceBefore = readFileSync(
    join(f.projects.rootPath, 'projects', f.id, 'source', 'workspace.json'),
  );
  const p = await f.preview();
  assert.deepEqual(p.changedKeys, ['posts']);
  assert.deepEqual(p.removedKeys, ['extra']);
  assert.ok(!JSON.stringify(p).includes('我的私人文章'));
  assert.equal(f.data.get(f.id).revision, 3);
  assert.equal(f.counts().closes, 0);
  assert.deepEqual(await f.confirm(p), {
    status: 'restored',
    revision: 4,
    appliedRevision: 4,
    replayed: false,
  });
  assert.deepEqual(f.data.get(f.id), { revision: 4, values: { posts: '我的私人文章' } });
  const record = JSON.parse(readFileSync(join(f.dataPath, 'state.json'), 'utf8'));
  assert.equal(record.history.at(-1).snapshot.values.extra, 1);
  assert.equal(record.receipts.length, 4);
  assert.deepEqual(await f.confirm(p), {
    status: 'restored',
    revision: 4,
    appliedRevision: 4,
    replayed: true,
  });
  assert.equal(f.counts().closes, 1);
  assert.deepEqual(
    readFileSync(join(f.projects.rootPath, 'projects', f.id, 'source', 'workspace.json')),
    sourceBefore,
  );
});
test('export cancellation and a changed snapshot while choosing never publish', async (t) => {
  const f = fixture(t);
  f.setChooser(async () => null);
  assert.deepEqual(await f.exportData(), { status: 'cancelled' });
  f.setChooser(async () => {
    f.service.cancel();
    return f.output;
  });
  assert.deepEqual(await f.exportData(), { status: 'cancelled' });
  f.setChooser(async () => {
    f.put('dialog changed');
    return f.output;
  });
  await assert.rejects(f.exportData(), code('DATA_RESTORE_STALE'));
  assert.equal(existsSync(f.output), false);
});
test('existing and protected export targets are preserved', async (t) => {
  const f = fixture(t);
  await f.exportData();
  const before = readFileSync(f.output);
  await assert.rejects(f.exportData(), code('EXPORT_EXISTS'));
  assert.deepEqual(readFileSync(f.output), before);
  f.setChooser(async () => join(f.dataPath, 'new.json'));
  await assert.rejects(f.exportData(), code('EXPORT_PROTECTED_PATH'));
  assert.equal(existsSync(join(f.dataPath, 'new.json')), false);
});
test('archive permits read and backup but blocks restore without reopening an application', async (t) => {
  const f = fixture(t);
  f.projects.archive(f.id, true);
  assert.equal(f.service.state(f.request).initialized, true);
  await f.exportData();
  await assert.rejects(f.preview(), code('ARCHIVED'));
  assert.equal(f.counts().closes, 0);
});
test('chooser cancellation, explicit discard, expiry and global cancel invalidate previews without writes', async (t) => {
  const f = fixture(t);
  await f.exportData();
  f.setImport(async () => null);
  assert.deepEqual(await f.service.preview(f.request), { status: 'cancelled' });
  f.setImport(async () => f.output);
  let p = await f.preview();
  f.service.discard({ ...f.request, previewId: p.previewId });
  await assert.rejects(f.confirm(p), code('DATA_RESTORE_CANCELLED'));
  p = await f.preview();
  f.advance(600001);
  await assert.rejects(f.confirm(p), code('DATA_RESTORE_CANCELLED'));
  p = await f.preview();
  f.service.cancel();
  await assert.rejects(f.confirm(p), code('DATA_RESTORE_CANCELLED'));
  assert.equal(f.data.get(f.id).revision, 1);
  assert.equal(f.counts().closes, 0);
});
test('foreign project, storage identity and source content backups are rejected even with valid integrity', async (t) => {
  const f = fixture(t);
  await f.exportData();
  const original = decodeDataBackup(readFileSync(f.output));
  for (const [changes, error] of [
    [{ project: { id: randomUUID(), name: '别的项目' } }, 'DATA_BACKUP_IDENTITY'],
    [{ storeId: randomUUID() }, 'DATA_BACKUP_IDENTITY'],
    [{ sourceContentHash: 'c'.repeat(64) }, 'DATA_BACKUP_SOURCE'],
  ] as const) {
    writeFileSync(f.output, encodeDataBackup({ ...original, ...changes }));
    await assert.rejects(f.preview(), code(error));
  }
  assert.equal(f.data.get(f.id).revision, 1);
});
test('same source contents at a newer source revision still permit data restoration', async (t) => {
  const f = fixture(t);
  await f.exportData();
  const content = f.sources.get(f.id).files[0].content;
  f.writeSource('export default function App(){return <p>v2</p>}');
  await assert.rejects(f.preview(), code('DATA_BACKUP_SOURCE'));
  f.writeSource(content);
  assert.equal(f.sources.get(f.id).revision, 3);
  f.put('v2 data');
  const p = await f.preview();
  assert.equal((await f.confirm(p)).revision, 3);
  assert.equal(f.sources.get(f.id).revision, 3);
});
test('post-preview data/source/archive changes reject before shutting down the running application', async (t) => {
  const f = fixture(t);
  await f.exportData();
  let p = await f.preview();
  f.put('new edit');
  await assert.rejects(f.confirm(p), code('DATA_RESTORE_STALE'));
  p = await f.preview();
  f.writeSource('export default function App(){return <p>changed</p>}');
  await assert.rejects(f.confirm(p), code('DATA_RESTORE_STALE'));
  f.writeSource('export default function App(){return <p>private app</p>}');
  p = await f.preview();
  f.projects.archive(f.id, true);
  await assert.rejects(f.confirm(p), code('DATA_RESTORE_STALE'));
  assert.equal(f.counts().closes, 0);
});
test('shutdown await boundary rechecks data/source/archive and cancellation before restoring', async (t) => {
  for (const kind of ['data', 'source', 'archive', 'cancel']) {
    const f = fixture(t);
    await f.exportData();
    const p = await f.preview();
    f.setClose(async () => {
      if (kind === 'data') f.put('close-time edit');
      if (kind === 'source')
        f.writeSource('export default function App(){return <p>new source</p>}');
      if (kind === 'archive') f.projects.archive(f.id, true);
      if (kind === 'cancel') f.service.cancel();
    });
    await assert.rejects(
      f.confirm(p),
      code(kind === 'cancel' ? 'DATA_RESTORE_CANCELLED' : 'DATA_RESTORE_STALE'),
    );
    assert.equal(f.data.inspect(f.id)!.snapshot.revision, kind === 'data' ? 2 : 1);
  }
});
test('a lost restore acknowledgement is checked using the same durable receipt, never applied twice', async (t) => {
  const f = fixture(t);
  await f.exportData();
  f.put('newer');
  const p = await f.preview();
  const original = f.data.restore.bind(f.data);
  let lose = true;
  f.data.restore = (...args) => {
    const result = original(...args);
    if (lose) {
      lose = false;
      throw new AppError('APP_DATA_COMMIT_UNCERTAIN', '合成确认丢失');
    }
    return result;
  };
  await assert.rejects(f.confirm(p), code('APP_DATA_COMMIT_UNCERTAIN'));
  assert.equal(f.data.get(f.id).revision, 3);
  const result = await f.confirm(p);
  assert.deepEqual(result, { status: 'restored', revision: 3, appliedRevision: 3, replayed: true });
});
test('data changed while choosing import and no original store after restart fail closed', async (t) => {
  const f = fixture(t);
  await f.exportData();
  f.setImport(async () => {
    f.put('chooser write');
    return f.output;
  });
  await assert.rejects(f.preview(), code('DATA_RESTORE_STALE'));
  f.setImport(async () => f.output);
  unlinkSync(join(f.dataPath, 'state.json'));
  assert.throws(() => f.service.state(f.request), code('APP_DATA_MISSING'));
  await assert.rejects(f.preview(), code('APP_DATA_MISSING'));
  assert.equal(existsSync(join(f.dataPath, 'state.json')), false);
});
test('only trusted chooser paths and stored preview payloads are accepted across public requests', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.service.state({ ...f.request, path: f.output }), code('INVALID_INPUT'));
  await assert.rejects(
    f.service.export({ ...f.request, expectedRevision: 1, path: f.output }),
    code('INVALID_INPUT'),
  );
  await assert.rejects(f.service.preview({ ...f.request, values: {} }), code('INVALID_INPUT'));
  await f.exportData();
  const p = await f.preview();
  await assert.rejects(
    f.service.confirm({ ...f.request, previewId: p.previewId, values: {} }),
    code('INVALID_INPUT'),
  );
  await assert.rejects(
    f.service.confirm({ ...f.request, projectId: randomUUID(), previewId: p.previewId }),
    code('DATA_RESTORE_CANCELLED'),
  );
  assert.equal(f.data.get(f.id).revision, 1);
});
test('backup scans fail without publishing and recheck after the chooser', async (t) => {
  const f = fixture(t);
  f.setScanner(() => {
    throw new AppError('EXPORT_SENSITIVE', '合成敏感内容');
  });
  await assert.rejects(f.exportData(), code('EXPORT_SENSITIVE'));
  assert.equal(existsSync(f.output), false);
  f.setScanner(assertExportContentsSafe);
  f.setChooser(async () => {
    f.setScanner(() => {
      throw new AppError('EXPORT_SENSITIVE', '合成后置扫描');
    });
    return f.output;
  });
  await assert.rejects(f.exportData(), code('EXPORT_SENSITIVE'));
  assert.equal(existsSync(f.output), false);
});
test('overlapping export/preview/confirm is busy and does not replace an in-flight request', async (t) => {
  const f = fixture(t);
  let release!: (value: string | null) => void;
  f.setChooser(() => new Promise((resolve) => (release = resolve)));
  const first = f.exportData();
  await assert.rejects(f.service.preview(f.request), code('BUSY'));
  await assert.rejects(f.exportData(), code('BUSY'));
  release(null);
  assert.deepEqual(await first, { status: 'cancelled' });
});
test('confirmation uses the exact inspected backup even if the selected file changes later', async (t) => {
  const f = fixture(t);
  await f.exportData();
  f.put('较新数据');
  const p = await f.preview();
  const old = decodeDataBackup(readFileSync(f.output));
  writeFileSync(
    f.output,
    encodeDataBackup({
      ...old,
      snapshot: { revision: 99, values: { posts: '选中路径随后被改写' } },
    }),
  );
  await f.confirm(p);
  assert.equal(f.data.get(f.id).values.posts, '我的私人文章');
});
test('JSON publication requires a trusted fixed format and preserves no-overwrite/atomic recovery rules', (t) => {
  const f = fixture(t);
  const bytes = Buffer.from(JSON.stringify({ data: 'a'.repeat(100) }));
  assert.throws(() => writeExportArchive(f.output, bytes), code('EXPORT_INVALID'));
  assert.throws(
    () => writeExportArchive(join(f.root, 'data.zip'), bytes, { format: 'data-backup-json' }),
    code('EXPORT_INVALID'),
  );
  assert.throws(
    () =>
      writeExportArchive(f.output, bytes, {
        format: 'data-backup-json',
        beforePublish: () => {
          throw Error('before publish');
        },
      }),
    code('EXPORT_IO'),
  );
  assert.equal(existsSync(f.output), false);
  const result = writeExportArchive(f.output, bytes, {
    format: 'data-backup-json',
    afterPublish: () => {
      throw Error('lost acknowledgement');
    },
  });
  assert.equal(result.sha256, sourceHash(bytes.toString()));
  assert.deepEqual(readFileSync(f.output), bytes);
  assert.throws(
    () => writeExportArchive(f.output, bytes, { format: 'data-backup-json' }),
    code('EXPORT_EXISTS'),
  );
});
