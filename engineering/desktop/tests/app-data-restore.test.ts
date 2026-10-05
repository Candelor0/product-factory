import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { AppDataStore, type AppDataRestoreRequest } from '../src/main/app-data-store';
import { APP_DATA_LIMITS } from '../src/main/app-data-protocol';
import { ProjectStore } from '../src/main/project-store';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';
import type { AppDataApplyRequest, AppDataSnapshot } from '../src/shared/app-data-contracts';

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const apply = (expectedRevision = 0, value = 'original'): AppDataApplyRequest => ({
  requestId: randomUUID(),
  expectedRevision,
  changes: [{ operation: 'put', key: 'articles', value }],
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-app-data-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '独立恢复测试', idea: '全部为合成内容' });
  const directory = join(root, 'projects', project.id, 'data', 'generated');
  const file = join(directory, 'state.json');
  const inner = join(directory, 'identity.json');
  const outer = join(directory, '..', 'generated.initialized.json');
  const store = new AppDataStore(projects);
  const reopen = () => new AppDataStore(new ProjectStore(root));
  const request = (
    values: AppDataSnapshot['values'] = { restored: true },
  ): AppDataRestoreRequest => {
    const current = store.inspect(project.id)!;
    return {
      requestId: randomUUID(),
      storeId: current.storeId,
      expectedRevision: current.snapshot.revision,
      expectedHash: current.sha256,
      values,
    };
  };
  const raw = () => JSON.parse(readFileSync(file, 'utf8'));
  return { root, projects, project, directory, file, inner, outer, store, reopen, request, raw };
}

test('inspection never initializes fresh or archived projects and returns a detached canonical snapshot', (t) => {
  const f = fixture(t);
  const data = join(f.directory, '..');
  const before = readdirSync(data);
  assert.equal(f.store.inspect(f.project.id), null);
  assert.equal(f.reopen().inspect(f.project.id), null);
  assert.deepEqual(readdirSync(data), before);
  f.projects.archive(f.project.id, true);
  assert.equal(f.store.inspect(f.project.id), null);
  assert.equal(existsSync(f.directory), false);
  f.projects.archive(f.project.id, false);
  f.store.apply(f.project.id, apply());
  const current = f.store.inspect(f.project.id)!;
  assert.equal(current.storeId, JSON.parse(readFileSync(f.inner, 'utf8')).storeId);
  assert.equal(current.sha256, sourceHash(JSON.stringify(current.snapshot)));
  current.snapshot.values.articles = 'changed local clone';
  const persisted = readFileSync(f.file);
  f.projects.archive(f.project.id, true);
  assert.equal(f.reopen().inspect(f.project.id)!.snapshot.values.articles, 'original');
  assert.deepEqual(readFileSync(f.file), persisted);
});

test('inspection rejects incomplete initialization and damaged data without repairing any file', (t) => {
  const f = fixture(t);
  const interrupted = new AppDataStore(f.projects, {
    afterInitializeRename: () => {
      throw new Error('synthetic interruption');
    },
  });
  assert.throws(() => interrupted.get(f.project.id), code('APP_DATA_INITIALIZATION_UNCERTAIN'));
  const initial = readFileSync(f.file);
  assert.throws(() => f.reopen().inspect(f.project.id), code('APP_DATA_MISSING'));
  assert.equal(existsSync(f.outer), false);
  assert.deepEqual(readFileSync(f.file), initial);
  f.store.get(f.project.id); // Only the explicit live read completes the existing init protocol.
  const savedFile = join(f.root, 'preserved-state');
  renameSync(f.file, savedFile);
  assert.throws(() => f.reopen().inspect(f.project.id), code('APP_DATA_MISSING'));
  assert.equal(existsSync(f.file), false);
  renameSync(savedFile, f.file);
  writeFileSync(f.file, '{"broken":');
  assert.throws(() => f.reopen().inspect(f.project.id), code('APP_DATA_CORRUPT'));
  assert.equal(readFileSync(f.file, 'utf8'), '{"broken":');
  writeFileSync(f.file, initial);
  const savedDirectory = join(f.root, 'preserved-directory');
  renameSync(f.directory, savedDirectory);
  assert.throws(() => f.reopen().inspect(f.project.id), code('APP_DATA_MISSING'));
  assert.equal(existsSync(f.directory), false);
});

test('a restore replaces 128 keys in one new revision and preserves identity, history, receipts and unrelated files', (t) => {
  const f = fixture(t);
  for (let batch = 0; batch < 4; batch++)
    f.store.apply(f.project.id, {
      requestId: randomUUID(),
      expectedRevision: batch,
      changes: Array.from({ length: 32 }, (_, index) => ({
        operation: 'put',
        key: `old_${batch * 32 + index}`,
        value: index,
      })),
    });
  const before = f.raw();
  const identity = readFileSync(f.inner);
  const marker = readFileSync(f.outer);
  const unrelated = [
    join(f.root, 'projects', f.project.id, 'source', 'preserve.txt'),
    join(f.root, 'projects', f.project.id, 'runs', 'app-ai.json'),
    join(f.directory, '..', 'blog', 'articles.json'),
  ];
  mkdirSync(join(f.directory, '..', 'blog'));
  for (const path of unrelated) writeFileSync(path, 'exact unrelated synthetic bytes');
  const values = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [`new_${index}`, { b: index, a: '中文' }]),
  );
  const request = f.request(values);
  assert.deepEqual(f.store.restore(f.project.id, request), {
    revision: 5,
    appliedRevision: 5,
    replayed: false,
  });
  const after = f.raw();
  assert.equal(after.storeId, before.storeId);
  assert.deepEqual(after.history, [...before.history, before.current]);
  assert.deepEqual(after.receipts.slice(0, -1), before.receipts);
  assert.equal(Object.keys(after.current.snapshot.values).length, 128);
  assert.equal(Object.hasOwn(after.current.snapshot.values, 'old_0'), false);
  assert.deepEqual(after.current.snapshot.values.new_127, { a: '中文', b: 127 });
  assert.deepEqual(readFileSync(f.inner), identity);
  assert.deepEqual(readFileSync(f.outer), marker);
  for (const path of unrelated)
    assert.equal(readFileSync(path, 'utf8'), 'exact unrelated synthetic bytes');
  assert.deepEqual(f.reopen().inspect(f.project.id)!.snapshot, after.current.snapshot);
  // The generated SDK's smaller mutation limit is unchanged.
  assert.throws(
    () =>
      f.store.apply(f.project.id, {
        ...apply(5),
        changes: Array.from({ length: 33 }, (_, index) => ({
          operation: 'remove',
          key: `new_${index}`,
        })),
      }),
    code('APP_DATA_LIMIT'),
  );
});

test('empty and identical snapshots still append monotonic versions and retain the previous values', (t) => {
  const f = fixture(t);
  f.store.get(f.project.id);
  assert.equal(f.store.restore(f.project.id, f.request({})).revision, 1);
  f.store.apply(f.project.id, apply(1));
  assert.equal(f.store.restore(f.project.id, f.request({})).revision, 3);
  assert.equal(f.store.restore(f.project.id, f.request({})).revision, 4);
  assert.deepEqual(f.store.inspect(f.project.id)!.snapshot, { revision: 4, values: {} });
  assert.deepEqual(f.raw().history[2].snapshot, { revision: 2, values: { articles: 'original' } });
});

test('restore receipts replay before stale checks, canonicalize values and reject cross-operation ID reuse', (t) => {
  const f = fixture(t);
  const original = apply();
  f.store.apply(f.project.id, original);
  const request = f.request({ record: { b: 2, a: 1 } });
  assert.throws(
    () => f.store.restore(f.project.id, { ...request, requestId: original.requestId }),
    code('APP_DATA_REQUEST_CONFLICT'),
  );
  f.store.restore(f.project.id, request);
  f.store.apply(f.project.id, apply(2, 'later'));
  const before = readFileSync(f.file);
  assert.deepEqual(
    f.reopen().restore(f.project.id, { ...request, values: { record: { a: 1, b: 2 } } }),
    {
      revision: 3,
      appliedRevision: 2,
      replayed: true,
    },
  );
  assert.deepEqual(f.reopen().apply(f.project.id, original), {
    revision: 3,
    appliedRevision: 1,
    replayed: true,
  });
  assert.throws(
    () => f.store.apply(f.project.id, { ...apply(3), requestId: request.requestId }),
    code('APP_DATA_REQUEST_CONFLICT'),
  );
  for (const changed of [
    { ...request, values: {} },
    { ...request, expectedRevision: 3 },
    { ...request, expectedHash: '0'.repeat(64) },
  ])
    assert.throws(() => f.store.restore(f.project.id, changed), code('APP_DATA_REQUEST_CONFLICT'));
  assert.deepEqual(readFileSync(f.file), before);
});

test('restoration requires an initialized matching store, revision and hash, and rejects archived projects', (t) => {
  const f = fixture(t);
  const fresh: AppDataRestoreRequest = {
    requestId: randomUUID(),
    storeId: randomUUID(),
    expectedRevision: 0,
    expectedHash: sourceHash(JSON.stringify({ revision: 0, values: {} })),
    values: {},
  };
  assert.throws(() => f.store.restore(f.project.id, fresh), code('APP_DATA_MISSING'));
  assert.equal(existsSync(f.directory), false);
  f.store.apply(f.project.id, apply());
  const request = f.request();
  const before = readFileSync(f.file);
  for (const changed of [
    { ...request, storeId: randomUUID() },
    { ...request, expectedRevision: 0 },
    { ...request, expectedHash: '0'.repeat(64) },
  ])
    assert.throws(() => f.store.restore(f.project.id, changed), code('APP_DATA_CONFLICT'));
  f.projects.archive(f.project.id, true);
  assert.throws(() => f.store.restore(f.project.id, request), code('ARCHIVED'));
  assert.deepEqual(readFileSync(f.file), before);
});

test('strict restore fields and JSON limits reject accessors, aliases, oversized or unsafe values before mutation', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, apply());
  const request = f.request();
  const before = readFileSync(f.file);
  const { values: _values, ...missingValues } = request;
  let reads = 0;
  const accessor = { ...request };
  Object.defineProperty(accessor, 'values', {
    enumerable: true,
    get() {
      reads++;
      return {};
    },
  });
  const invalid: unknown[] = [
    missingValues,
    { ...request, extra: true },
    { ...request, [Symbol('extra')]: true },
    accessor,
    { ...request, requestId: request.requestId.toUpperCase() },
    { ...request, storeId: '../foreign' },
    { ...request, expectedHash: 'invalid' },
    { ...request, expectedRevision: 1.5 },
    { ...request, values: { '../outside': null } },
    { ...request, values: { articles: undefined } },
    { ...request, values: { articles: Infinity } },
    { ...request, values: JSON.parse('{"constructor":null}') },
    { ...request, values: { articles: JSON.parse('{"__proto__":null}') } },
  ];
  for (const value of invalid)
    assert.throws(
      () => f.store.restore(f.project.id, value as AppDataRestoreRequest),
      code('APP_DATA_INVALID'),
    );
  assert.equal(reads, 0);
  const hugeValues = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`data_${i}`, 'x'.repeat(120 * 1024)]),
  );
  for (const values of [
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`key_${i}`, null])),
    { articles: 'x'.repeat(APP_DATA_LIMITS.valueBytes) },
    hugeValues,
  ])
    assert.throws(
      () => f.store.restore(f.project.id, { ...request, values }),
      code('APP_DATA_LIMIT'),
    );
  assert.deepEqual(readFileSync(f.file), before);
});

test('mixed apply and restore operations retain only five historical snapshots and 256 receipts', (t) => {
  const f = fixture(t);
  f.store.get(f.project.id);
  const first = f.request({ initial: true });
  f.store.restore(f.project.id, first);
  for (let revision = 1; revision <= 256; revision++)
    f.store.apply(f.project.id, apply(revision, `value ${revision}`));
  const last = f.request({ final: true });
  f.store.restore(f.project.id, last);
  const before = readFileSync(f.file);
  const record = f.raw();
  assert.equal(record.history.length, 5);
  assert.equal(record.receipts.length, 256);
  assert.deepEqual(
    record.history.map((item: any) => item.snapshot.revision),
    [253, 254, 255, 256, 257],
  );
  assert.equal(record.current.snapshot.revision, 258);
  assert.ok(before.length < APP_DATA_LIMITS.recordBytes);
  assert.throws(() => f.reopen().restore(f.project.id, first), code('APP_DATA_CONFLICT'));
  assert.deepEqual(f.reopen().restore(f.project.id, last), {
    revision: 258,
    appliedRevision: 258,
    replayed: true,
  });
  assert.deepEqual(readFileSync(f.file), before);
});

test('restore rejects symlinks, hardlinks, missing markers and corrupt or foreign records without healing them', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, apply());
  const request = f.request();
  const saved = join(f.root, 'preserved-state');
  renameSync(f.file, saved);
  symlinkSync(saved, f.file);
  assert.throws(() => f.store.restore(f.project.id, request), code('UNSAFE_PATH'));
  assert.throws(() => f.store.inspect(f.project.id), code('UNSAFE_PATH'));
  rmSync(f.file);
  renameSync(saved, f.file);
  linkSync(f.file, saved);
  assert.throws(() => f.store.restore(f.project.id, request), code('UNSAFE_PATH'));
  rmSync(saved);
  const baseline = readFileSync(f.file);
  for (const mutate of [
    (raw: any) => {
      raw.storeId = randomUUID();
    },
    (raw: any) => {
      raw.current.snapshot.values.articles = 'tampered';
    },
  ]) {
    const raw = JSON.parse(baseline.toString());
    mutate(raw);
    const bytes = JSON.stringify(raw);
    writeFileSync(f.file, bytes);
    assert.throws(() => f.reopen().restore(f.project.id, request), code('APP_DATA_CORRUPT'));
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
  }
  writeFileSync(f.file, baseline);
  rmSync(f.outer);
  assert.throws(() => f.reopen().restore(f.project.id, request), code('APP_DATA_MISSING'));
  assert.equal(existsSync(f.outer), false);
  assert.deepEqual(readFileSync(f.file), baseline);
});

test('restore rechecks a competing write, archive and marker removal before rename', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, apply());
  const request = f.request();
  const race = new AppDataStore(f.projects, {
    beforeRename: () => f.store.apply(f.project.id, apply(1, 'winner')),
  });
  assert.throws(() => race.restore(f.project.id, request), code('APP_DATA_CONFLICT'));
  assert.equal(f.store.get(f.project.id).values.articles, 'winner');
  const next = f.request();
  const before = readFileSync(f.file);
  const archive = new AppDataStore(f.projects, {
    beforeRename: () => f.projects.archive(f.project.id, true),
  });
  assert.throws(() => archive.restore(f.project.id, next), code('ARCHIVED'));
  f.projects.archive(f.project.id, false);
  const removeMarker = new AppDataStore(f.projects, { beforeRename: () => rmSync(f.outer) });
  assert.throws(() => removeMarker.restore(f.project.id, next), code('APP_DATA_MISSING'));
  assert.equal(existsSync(f.outer), false);
  assert.deepEqual(readFileSync(f.file), before);
});

test('restore reconciles only an exact post-rename acknowledgement and preserves uncertainty otherwise', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, apply());
  const request = f.request();
  const before = readFileSync(f.file);
  const pre = new AppDataStore(f.projects, {
    beforeRename: () => {
      throw new Error('synthetic failure');
    },
  });
  assert.throws(() => pre.restore(f.project.id, request), code('APP_DATA_IO'));
  assert.deepEqual(readFileSync(f.file), before);
  const post = new AppDataStore(f.projects, {
    afterRename: () => {
      throw new Error('lost reply');
    },
  });
  assert.deepEqual(post.restore(f.project.id, request), {
    revision: 2,
    appliedRevision: 2,
    replayed: false,
  });
  assert.deepEqual(f.reopen().restore(f.project.id, request), {
    revision: 2,
    appliedRevision: 2,
    replayed: true,
  });
  assert.deepEqual(readdirSync(f.directory).sort(), ['identity.json', 'state.json']);
  const next = f.request({ last: true });
  const corrupt = new AppDataStore(f.projects, {
    afterRename: () => {
      writeFileSync(f.file, '{"broken":');
      throw new Error();
    },
  });
  assert.throws(() => corrupt.restore(f.project.id, next), code('APP_DATA_COMMIT_UNCERTAIN'));
  assert.equal(readFileSync(f.file, 'utf8'), '{"broken":');
});

for (const boundary of ['beforeRename', 'afterRename'] as const) {
  test(`real SIGKILL at restore ${boundary} retains a complete state and fresh-process retry uses the receipt`, (t) => {
    const f = fixture(t);
    f.store.apply(f.project.id, apply());
    const request = f.request({ restored: ['only', 'synthetic', 'data'] });
    const before = readFileSync(f.file);
    const inner = readFileSync(f.inner);
    const outer = readFileSync(f.outer);
    const imports = `import { ProjectStore } from ${JSON.stringify(pathToFileURL(resolve('src/main/project-store.ts')).href)}; import { AppDataStore } from ${JSON.stringify(pathToFileURL(resolve('src/main/app-data-store.ts')).href)}; const projects = new ProjectStore(${JSON.stringify(f.root)}); const id = ${JSON.stringify(f.project.id)}; const request = ${JSON.stringify(request)};`;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} new AppDataStore(projects, { ${boundary}() { process.kill(process.pid, 'SIGKILL'); } }).restore(id, request);`,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 },
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
        `${imports} const store = new AppDataStore(projects); const before = store.inspect(id); const result = store.restore(id, request); const replay = store.restore(id, request); console.log(JSON.stringify({before, result, replay, after: store.inspect(id)}));`,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    const result = JSON.parse(fresh.stdout);
    const published = boundary === 'afterRename';
    assert.deepEqual(result.before.snapshot, {
      revision: published ? 2 : 1,
      values: published ? request.values : { articles: 'original' },
    });
    assert.deepEqual(result.result, { revision: 2, appliedRevision: 2, replayed: published });
    assert.deepEqual(result.replay, { revision: 2, appliedRevision: 2, replayed: true });
    assert.deepEqual(result.after.snapshot, { revision: 2, values: request.values });
    assert.deepEqual(readFileSync(f.inner), inner);
    assert.deepEqual(readFileSync(f.outer), outer);
    assert.equal(f.raw().receipts.length, 2);
    assert.deepEqual(f.raw().history[1].snapshot, {
      revision: 1,
      values: { articles: 'original' },
    });
  });
}
