import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { AppDataStore } from '../src/main/app-data-store';
import { APP_DATA_LIMITS } from '../src/main/app-data-protocol';
import { ProjectStore } from '../src/main/project-store';
import { AppError } from '../src/main/validation';
import type { AppDataApplyRequest, AppDataValue } from '../src/shared/app-data-contracts';
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const request = (expectedRevision = 0, value: AppDataValue = 'content'): AppDataApplyRequest => ({
  requestId: randomUUID(),
  expectedRevision,
  changes: [{ operation: 'put', key: 'articles', value }],
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-app-data-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '独立业务数据', idea: '纯合成测试' });
  const data = join(root, 'projects', project.id, 'data');
  const directory = join(data, 'generated');
  const file = join(directory, 'state.json');
  const inner = join(directory, 'identity.json');
  const outer = join(data, 'generated.initialized.json');
  const store = new AppDataStore(projects);
  const reopen = () => new AppDataStore(new ProjectStore(root));
  return { root, projects, project, data, directory, file, inner, outer, store, reopen };
}
test('explicit first read initializes a paired identity and empty store without touching sample blog, source or project metadata', (t) => {
  const f = fixture(t);
  const projectFile = join(f.root, 'projects', f.project.id, 'project.json');
  const before = readFileSync(projectFile);
  mkdirSync(join(f.data, 'blog'));
  writeFileSync(join(f.data, 'blog', 'articles.json'), 'fixed sample bytes');
  assert.deepEqual(f.store.get(f.project.id), { revision: 0, values: {} });
  assert.equal(readFileSync(f.outer, 'utf8'), readFileSync(f.inner, 'utf8'));
  assert.deepEqual(f.reopen().get(f.project.id), { revision: 0, values: {} });
  assert.deepEqual(readFileSync(projectFile), before);
  assert.equal(readFileSync(join(f.data, 'blog', 'articles.json'), 'utf8'), 'fixed sample bytes');
  assert.deepEqual(readdirSync(join(f.root, 'projects', f.project.id, 'source')), []);
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.file).mode & 0o777, 0o600);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  }
});
test('multi-key data mutations commit atomically and old values survive in bounded snapshots', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, {
    ...request(),
    changes: [
      { operation: 'put', key: 'articles', value: [{ title: '首篇', draft: true }] },
      { operation: 'put', key: 'theme', value: { color: '#fff' } },
    ],
  });
  const before = readFileSync(f.file);
  assert.throws(
    () =>
      f.store.apply(f.project.id, {
        ...request(1),
        changes: [
          { operation: 'put', key: 'theme', value: 'changed' },
          { operation: 'remove', key: 'missing' },
        ],
      }),
    code('APP_DATA_CONFLICT'),
  );
  assert.deepEqual(readFileSync(f.file), before);
  for (let revision = 1; revision < 8; revision++)
    f.store.apply(f.project.id, request(revision, { title: `第${revision}版` }));
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(raw.history.length, 5);
  assert.deepEqual(
    raw.history.map((item: any) => item.snapshot.revision),
    [3, 4, 5, 6, 7],
  );
  assert.equal(raw.current.snapshot.revision, 8);
  assert.equal(raw.receipts.length, 8);
  assert.deepEqual(f.reopen().get(f.project.id).values.articles, { title: '第7版' });
  const clone = f.store.get(f.project.id);
  clone.values.articles = null;
  assert.notEqual(f.store.get(f.project.id).values.articles, null);
});
test('receipts return current and originally applied revisions without rewriting, while changed input is rejected', (t) => {
  const f = fixture(t);
  const first = request(0, { b: 2, a: 1 });
  f.store.apply(f.project.id, first);
  f.store.apply(f.project.id, request(1, 'later'));
  const before = readFileSync(f.file);
  assert.deepEqual(f.reopen().apply(f.project.id, first), {
    revision: 2,
    appliedRevision: 1,
    replayed: true,
  });
  assert.deepEqual(
    f.store.apply(f.project.id, {
      ...first,
      changes: [{ operation: 'put', key: 'articles', value: { a: 1, b: 2 } }],
    }),
    { revision: 2, appliedRevision: 1, replayed: true },
  );
  for (const changed of [
    { ...first, expectedRevision: 2 },
    { ...first, changes: [{ operation: 'put', key: 'articles', value: 'other' }] },
  ])
    assert.throws(
      () => f.store.apply(f.project.id, changed as AppDataApplyRequest),
      code('APP_DATA_REQUEST_CONFLICT'),
    );
  assert.deepEqual(readFileSync(f.file), before);
});
test('receipt eviction keeps only the last 256 and stale evicted requests cannot apply twice', (t) => {
  const f = fixture(t);
  const first = request();
  f.store.apply(f.project.id, first);
  let latest = first;
  for (let revision = 1; revision <= 257; revision++) {
    latest = request(revision, revision);
    f.store.apply(f.project.id, latest);
  }
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  const before = readFileSync(f.file);
  assert.equal(raw.receipts.length, 256);
  assert.equal(raw.history.length, 5);
  assert.ok(statSync(f.file).size < APP_DATA_LIMITS.recordBytes);
  assert.throws(() => f.reopen().apply(f.project.id, first), code('APP_DATA_CONFLICT'));
  assert.deepEqual(f.reopen().apply(f.project.id, latest), {
    revision: 258,
    appliedRevision: 258,
    replayed: true,
  });
  assert.deepEqual(readFileSync(f.file), before);
});
test('initialization before directory rename leaves no committed state; after rename is recoverable with exact inner identity', (t) => {
  const f = fixture(t);
  const pre = new AppDataStore(f.projects, {
    beforeInitializeRename: () => {
      throw new Error('private details');
    },
  });
  assert.throws(() => pre.get(f.project.id), code('APP_DATA_IO'));
  assert.equal(existsSync(f.directory), false);
  assert.equal(existsSync(f.outer), false);
  const post = new AppDataStore(f.projects, {
    afterInitializeRename: () => {
      throw new Error('private details');
    },
  });
  assert.throws(() => post.get(f.project.id), code('APP_DATA_INITIALIZATION_UNCERTAIN'));
  assert.equal(existsSync(f.directory), true);
  assert.equal(existsSync(f.outer), false);
  const before = readFileSync(f.file);
  assert.deepEqual(f.reopen().get(f.project.id), { revision: 0, values: {} });
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(readFileSync(f.inner, 'utf8'), readFileSync(f.outer, 'utf8'));
});
test('fresh stores refuse missing initialized files or a removed generated directory instead of returning empty data', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, request());
  const moved = join(f.root, 'preserved-state.json');
  renameSync(f.file, moved);
  assert.throws(() => f.reopen().get(f.project.id), code('APP_DATA_MISSING'));
  assert.throws(() => f.reopen().apply(f.project.id, request()), code('APP_DATA_MISSING'));
  assert.equal(existsSync(f.file), false);
  renameSync(moved, f.file);
  const movedDirectory = join(f.root, 'preserved-generated');
  renameSync(f.directory, movedDirectory);
  assert.throws(() => f.reopen().get(f.project.id), code('APP_DATA_MISSING'));
  assert.equal(existsSync(f.directory), false);
  renameSync(movedDirectory, f.directory);
  rmSync(f.outer);
  const before = readFileSync(f.file);
  assert.equal(f.reopen().get(f.project.id).revision, 1);
  assert.deepEqual(readFileSync(f.file), before);
  rmSync(f.file);
  rmSync(f.outer);
  assert.throws(
    () => f.reopen().get(f.project.id),
    code('APP_DATA_MISSING'),
    'existing directory with neither marker nor state cannot reinitialize',
  );
});
test('pre-rename failure is atomic and post-rename acknowledgement loss uses exact readback', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, request());
  const before = readFileSync(f.file);
  const next = request(1, 'second');
  const pre = new AppDataStore(f.projects, {
    beforeRename: () => {
      throw new Error('private-path');
    },
  });
  assert.throws(() => pre.apply(f.project.id, next), code('APP_DATA_IO'));
  assert.deepEqual(readFileSync(f.file), before);
  const post = new AppDataStore(f.projects, {
    afterRename: () => {
      throw new Error('lost acknowledgement');
    },
  });
  assert.deepEqual(post.apply(f.project.id, next), {
    revision: 2,
    appliedRevision: 2,
    replayed: false,
  });
  assert.deepEqual(f.reopen().apply(f.project.id, next), {
    revision: 2,
    appliedRevision: 2,
    replayed: true,
  });
  assert.deepEqual(readdirSync(f.directory).sort(), ['identity.json', 'state.json']);
  const bad = new AppDataStore(f.projects, {
    afterRename: () => {
      writeFileSync(f.file, '{"partial":');
      throw new Error('uncertain');
    },
  });
  assert.throws(() => bad.apply(f.project.id, request(2)), code('APP_DATA_COMMIT_UNCERTAIN'));
  assert.equal(readFileSync(f.file, 'utf8'), '{"partial":');
});
test('fresh revision and archive checks at rename preserve competing data and block archived mutation', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, request());
  const competing = new AppDataStore(f.projects, {
    beforeRename: () => f.store.apply(f.project.id, request(1, 'winner')),
  });
  assert.throws(
    () => competing.apply(f.project.id, request(1, 'loser')),
    code('APP_DATA_CONFLICT'),
  );
  assert.equal(f.store.get(f.project.id).values.articles, 'winner');
  const before = readFileSync(f.file);
  const archive = new AppDataStore(f.projects, {
    beforeRename: () => f.projects.archive(f.project.id, true),
  });
  assert.throws(() => archive.apply(f.project.id, request(2)), code('ARCHIVED'));
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(f.reopen().get(f.project.id).revision, 2);
  assert.throws(() => f.store.apply(f.project.id, request(2)), code('ARCHIVED'));
  const empty = f.projects.create({ name: '已归档空项目', idea: 'test' });
  f.projects.archive(empty.id, true);
  assert.throws(() => f.store.get(empty.id), code('ARCHIVED'));
});
test('corrupt values, history, receipts, schemas and foreign identities preserve bytes and fail closed', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, request());
  const baseline = JSON.parse(readFileSync(f.file, 'utf8'));
  const mutations: ((raw: any) => void)[] = [
    (raw) => {
      raw.extra = true;
    },
    (raw) => {
      raw.projectId = randomUUID();
    },
    (raw) => {
      raw.storeId = randomUUID();
    },
    (raw) => {
      raw.current.snapshot.values.articles = 'tampered';
    },
    (raw) => {
      raw.current.sha256 = '0'.repeat(64);
    },
    (raw) => {
      raw.history = [];
    },
    (raw) => {
      raw.history[0].snapshot.revision = 1;
    },
    (raw) => {
      raw.receipts = [];
    },
    (raw) => {
      raw.receipts[0].expectedRevision = 1;
    },
    (raw) => {
      raw.receipts[0].requestHash = 'invalid';
    },
  ];
  for (const mutate of mutations) {
    const raw = structuredClone(baseline);
    mutate(raw);
    const bytes = JSON.stringify(raw);
    writeFileSync(f.file, bytes);
    assert.throws(() => f.reopen().get(f.project.id), code('APP_DATA_CORRUPT'));
    assert.throws(() => f.store.apply(f.project.id, request(1)), code('APP_DATA_CORRUPT'));
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
  }
  writeFileSync(f.file, JSON.stringify({ ...baseline, schemaVersion: 3 }));
  assert.throws(() => f.store.get(f.project.id), code('APP_DATA_UNSUPPORTED'));
  writeFileSync(f.file, JSON.stringify(baseline));
  const outer = JSON.parse(readFileSync(f.outer, 'utf8'));
  outer.storeId = randomUUID();
  writeFileSync(f.outer, JSON.stringify(outer));
  assert.throws(() => f.reopen().get(f.project.id), code('APP_DATA_CORRUPT'));
});
test('linked state, linked initialization markers and linked directories never redirect business data access', (t) => {
  const f = fixture(t);
  f.store.apply(f.project.id, request());
  const saved = join(f.root, 'preserved-state.json');
  renameSync(f.file, saved);
  symlinkSync(saved, f.file);
  assert.throws(() => f.store.get(f.project.id), code('UNSAFE_PATH'));
  rmSync(f.file);
  renameSync(saved, f.file);
  linkSync(f.file, saved);
  assert.throws(() => f.store.apply(f.project.id, request(1)), code('UNSAFE_PATH'));
  rmSync(saved);
  const outer = join(f.root, 'preserved-marker.json');
  renameSync(f.outer, outer);
  symlinkSync(outer, f.outer);
  assert.throws(() => f.reopen().get(f.project.id), code('UNSAFE_PATH'));
  rmSync(f.outer);
  renameSync(outer, f.outer);
  const moved = join(f.root, 'preserved-generated');
  renameSync(f.directory, moved);
  symlinkSync(moved, f.directory, 'dir');
  assert.throws(() => f.reopen().get(f.project.id), code('UNSAFE_PATH'));
});
test('unknown preexisting directory content and malformed requests cannot create or overwrite a business store', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.store.apply(f.project.id, {
        ...request(),
        changes: [{ operation: 'put', key: '../secret', value: null }],
      }),
    code('APP_DATA_INVALID'),
  );
  assert.equal(existsSync(f.directory), false);
  mkdirSync(f.directory);
  writeFileSync(join(f.directory, 'unknown.json'), 'preserve');
  assert.throws(() => f.store.get(f.project.id), code('APP_DATA_CORRUPT'));
  assert.equal(readFileSync(join(f.directory, 'unknown.json'), 'utf8'), 'preserve');
  for (const id of ['../outside', '/tmp', f.project.id.toUpperCase()])
    assert.throws(() => f.store.get(id), code('INVALID_INPUT'));
});
for (const boundary of [
  'beforeInitializeRename',
  'afterInitializeRename',
  'beforeRename',
  'afterRename',
] as const) {
  test(`real child SIGKILL at ${boundary} preserves initialization and data transaction boundaries`, (t) => {
    const f = fixture(t);
    const projectImport = pathToFileURL(resolve('src/main/project-store.ts')).href;
    const storeImport = pathToFileURL(resolve('src/main/app-data-store.ts')).href;
    const initializing = boundary.includes('Initialize');
    if (!initializing) f.store.apply(f.project.id, request(0, 'original'));
    const input = request(1, 'new data');
    const body = `new AppDataStore(projects, { ${boundary}() { process.kill(process.pid, 'SIGKILL'); } }).${initializing ? 'get(id)' : `apply(id, ${JSON.stringify(input)})`};`;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { ProjectStore } from ${JSON.stringify(projectImport)}; import { AppDataStore } from ${JSON.stringify(storeImport)}; const projects = new ProjectStore(${JSON.stringify(f.root)}); const id = ${JSON.stringify(f.project.id)}; ${body}`,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    if (initializing) {
      assert.equal(existsSync(f.outer), false);
      assert.equal(existsSync(f.directory), boundary === 'afterInitializeRename');
      assert.deepEqual(f.reopen().get(f.project.id), { revision: 0, values: {} });
      assert.equal(readFileSync(f.outer, 'utf8'), readFileSync(f.inner, 'utf8'));
    } else {
      const applied = boundary === 'afterRename';
      assert.deepEqual(f.reopen().get(f.project.id), {
        revision: applied ? 2 : 1,
        values: { articles: applied ? 'new data' : 'original' },
      });
      assert.deepEqual(f.reopen().apply(f.project.id, input), {
        revision: 2,
        appliedRevision: 2,
        replayed: applied,
      });
      assert.deepEqual(f.reopen().apply(f.project.id, input), {
        revision: 2,
        appliedRevision: 2,
        replayed: true,
      });
      assert.deepEqual(f.reopen().get(f.project.id), {
        revision: 2,
        values: { articles: 'new data' },
      });
    }
  });
}
