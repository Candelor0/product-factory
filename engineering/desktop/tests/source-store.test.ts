import assert from 'node:assert/strict';
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
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../src/main/project-store';
import { SourceStore } from '../src/main/source-store';
import { SOURCE_LIMITS, sourceHash, sourceRequestHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';
import type { SourceApplyInput, SourceBinding, SourceChange } from '../src/shared/source-contracts';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const binding = (): SourceBinding => ({
  planRunId: randomUUID(),
  planInputHash: sourceHash('confirmed input'),
  planArtifactHash: sourceHash('plan artifact'),
});
const input = (
  expectedRevision = 0,
  changes: SourceChange[] = [
    {
      operation: 'write',
      path: 'src/app.ts',
      expectedHash: null,
      content: 'export const title = "博客";\n',
    },
  ],
): SourceApplyInput => ({ requestId: randomUUID(), binding: binding(), expectedRevision, changes });
const newFile = (path: string, content = 'export {};'): SourceChange => ({
  operation: 'write',
  path,
  expectedHash: null,
  content,
});

function fixture(t: { after: (callback: () => void) => void }) {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'factory-source-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, '中文 空格 🌱', '项目资料');
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '源码事务', idea: '合成测试，不调用模型' });
  const source = new SourceStore(projects);
  const directory = join(root, 'projects', project.id, 'source');
  const file = join(directory, 'workspace.json');
  return { root, projects, project, source, directory, file };
}

test('an empty source view does not write; a text transaction persists across independent stores', (t) => {
  const { root, project, source, directory, file } = fixture(t);
  const manifest = join(root, 'projects', project.id, 'project.json');
  const before = readFileSync(manifest);
  assert.deepEqual(source.get(project.id), { revision: 0, files: [] });
  assert.equal(existsSync(file), false);
  const request = input(0, [
    newFile('src/z.css', 'body {}\n'),
    newFile('src/a.ts', 'export const title = "🌱";\n'),
  ]);
  const result = source.apply(project.id, request);
  assert.deepEqual(result, {
    revision: 1,
    previousRevision: 0,
    changedPaths: ['src/a.ts', 'src/z.css'],
    replayed: false,
  });
  const expected = {
    revision: 1,
    files: [...request.changes].reverse().map((change) => ({
      path: change.path,
      content: change.operation === 'write' ? change.content : '',
      sha256: sourceHash(change.operation === 'write' ? change.content : ''),
    })),
  };
  assert.deepEqual(source.get(project.id), expected);
  assert.deepEqual(new SourceStore(new ProjectStore(root)).get(project.id), expected);
  assert.deepEqual(readFileSync(manifest), before);
  assert.deepEqual(
    readdirSync(directory),
    ['workspace.json'],
    'virtual source paths never become host paths',
  );
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const mutated = source.get(project.id);
  mutated.files[0].content = 'external mutation';
  assert.deepEqual(source.get(project.id), expected);
});

test('multi-file write and delete commit together, retaining the prior full tree and request receipt', (t) => {
  const { project, source, file } = fixture(t);
  source.apply(
    project.id,
    input(0, [newFile('src/app.ts', 'first'), newFile('src/style.css', 'old style')]),
  );
  const original = source.get(project.id);
  const request = input(1, [
    {
      operation: 'write',
      path: 'src/app.ts',
      expectedHash: sourceHash('first'),
      content: 'second',
    },
    { operation: 'delete', path: 'src/style.css', expectedHash: sourceHash('old style') },
    newFile('src/components/card.tsx', 'export const Card = () => null;'),
  ]);
  assert.equal(source.apply(project.id, request).revision, 2);
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(persisted.commits[0].snapshot, original);
  assert.equal(persisted.commits[1].requestHash, sourceRequestHash(request));
  assert.deepEqual(persisted.commits[1].request, request);
  assert.deepEqual(
    source.get(project.id).files.map((item) => item.path),
    ['src/app.ts', 'src/components/card.tsx'],
  );
});

test('a failed operation in a multi-file transaction leaves every file and receipt unchanged', (t) => {
  const { project, source, file } = fixture(t);
  source.apply(project.id, input(0, [newFile('src/a.ts', 'a'), newFile('src/b.ts', 'b')]));
  const before = readFileSync(file);
  const request = input(1, [
    { operation: 'write', path: 'src/a.ts', expectedHash: sourceHash('a'), content: 'updated' },
    { operation: 'delete', path: 'src/b.ts', expectedHash: sourceHash('wrong') },
  ]);
  assert.throws(() => source.apply(project.id, request), hasCode('SOURCE_CONFLICT'));
  assert.deepEqual(readFileSync(file), before);
  request.changes[1].expectedHash = sourceHash('b');
  assert.equal(
    source.apply(project.id, request).revision,
    2,
    'rejected requests consume no receipt',
  );
});

test('stale revisions, existing-file creates, missing updates and deletes fail without overwriting', (t) => {
  const { project, source, file } = fixture(t);
  source.apply(project.id, input());
  const before = readFileSync(file);
  for (const request of [
    input(0, [newFile('src/new.ts')]),
    input(2, [newFile('src/new.ts')]),
    input(1),
    input(1, [
      {
        operation: 'write',
        path: 'src/missing.ts',
        expectedHash: sourceHash('missing'),
        content: 'replacement',
      },
    ]),
    input(1, [
      { operation: 'delete', path: 'src/missing.ts', expectedHash: sourceHash('missing') },
    ]),
    input(1, [
      {
        operation: 'write',
        path: 'src/app.ts',
        expectedHash: sourceHash('wrong'),
        content: 'replacement',
      },
    ]),
  ]) {
    assert.throws(() => source.apply(project.id, request), hasCode('SOURCE_CONFLICT'));
    assert.deepEqual(readFileSync(file), before);
  }
});

test('canonical retries survive later commits and reopening; request ID reuse checks the complete binding and payload', (t) => {
  const { root, project, source, file } = fixture(t);
  const request = input();
  const first = source.apply(project.id, request);
  source.apply(project.id, input(1, [newFile('src/next.ts')]));
  const before = readFileSync(file);
  const reopened = new SourceStore(new ProjectStore(root));
  const reordered = {
    changes: request.changes.map((change) => Object.fromEntries(Object.entries(change).reverse())),
    expectedRevision: request.expectedRevision,
    binding: Object.fromEntries(Object.entries(request.binding).reverse()),
    requestId: request.requestId,
  };
  assert.deepEqual(reopened.apply(project.id, reordered), { ...first, replayed: true });
  for (const changed of [
    { ...request, expectedRevision: 2 },
    { ...request, changes: [newFile('src/different.ts')] },
    { ...request, changes: [newFile('src/app.ts', 'different content')] },
    ...(['planRunId', 'planInputHash', 'planArtifactHash'] as const).map((key) => ({
      ...request,
      binding: {
        ...request.binding,
        [key]: key === 'planRunId' ? randomUUID() : sourceHash('different'),
      },
    })),
  ])
    assert.throws(() => reopened.apply(project.id, changed), hasCode('REQUEST_CONFLICT'));
  assert.deepEqual(readFileSync(file), before);
  assert.equal(reopened.get(project.id).revision, 2);
});

test('independent stores reread revisions and reject an update based on an older read', (t) => {
  const { root, project, source, file } = fixture(t);
  const second = new SourceStore(new ProjectStore(root));
  assert.equal(second.get(project.id).revision, 0);
  source.apply(project.id, input());
  const before = readFileSync(file);
  assert.throws(
    () => second.apply(project.id, input(0, [newFile('src/new.ts')])),
    hasCode('SOURCE_CONFLICT'),
  );
  assert.deepEqual(readFileSync(file), before);
  assert.equal(second.apply(project.id, input(1, [newFile('src/new.ts')])).revision, 2);
  assert.equal(source.get(project.id).revision, 2);
});

test('a write appearing at the pre-rename boundary cannot be overwritten by an older transaction', (t) => {
  const { projects, project, source, file } = fixture(t);
  source.apply(project.id, input());
  const injected = new SourceStore(projects, {
    beforeRename: () => source.apply(project.id, input(1, [newFile('src/winner.ts', 'retained')])),
  });
  assert.throws(
    () => injected.apply(project.id, input(1, [newFile('src/loser.ts')])),
    hasCode('SOURCE_CONFLICT'),
  );
  assert.equal(source.get(project.id).revision, 2);
  assert.deepEqual(
    source.get(project.id).files.map((item) => item.path),
    ['src/app.ts', 'src/winner.ts'],
  );
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).commits.length, 2);
});

test('pre-rename failure preserves original bytes and retry safely commits once', (t) => {
  const { root, projects, project, source, file, directory } = fixture(t);
  source.apply(project.id, input());
  const before = readFileSync(file);
  const request = input(1, [newFile('src/next.ts')]);
  const failing = new SourceStore(projects, {
    beforeRename: () => {
      throw new Error('private host path and source text');
    },
  });
  assert.throws(
    () => failing.apply(project.id, request),
    (error) => hasCode('SOURCE_IO')(error) && !(error as Error).message.includes('private'),
  );
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(directory), ['workspace.json']);
  const reopened = new SourceStore(new ProjectStore(root));
  assert.equal(reopened.get(project.id).revision, 1);
  assert.equal(reopened.apply(project.id, request).revision, 2);
  assert.equal(reopened.apply(project.id, request).replayed, true);
});

test('post-rename failure reports an uncertain commit and retry returns the durable receipt without rewriting', (t) => {
  const { root, projects, project, file, directory } = fixture(t);
  const request = input();
  const failing = new SourceStore(projects, {
    afterRename: () => {
      throw new Error('private path');
    },
  });
  assert.throws(() => failing.apply(project.id, request), hasCode('SOURCE_COMMIT_UNCERTAIN'));
  const before = readFileSync(file);
  const reopened = new SourceStore(new ProjectStore(root));
  assert.equal(reopened.get(project.id).revision, 1);
  assert.deepEqual(reopened.apply(project.id, request), {
    revision: 1,
    previousRevision: 0,
    changedPaths: ['src/app.ts'],
    replayed: true,
  });
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(directory), ['workspace.json']);
});

test('archived sources remain readable but even completed retries cannot mutate until restored', (t) => {
  const { projects, project, source, file } = fixture(t);
  const request = input();
  source.apply(project.id, request);
  const before = readFileSync(file);
  projects.archive(project.id, true);
  assert.equal(source.get(project.id).revision, 1);
  assert.throws(() => source.apply(project.id, request), hasCode('ARCHIVED'));
  assert.throws(
    () => source.apply(project.id, input(1, [newFile('src/next.ts')])),
    hasCode('ARCHIVED'),
  );
  assert.deepEqual(readFileSync(file), before);
  projects.archive(project.id, false);
  assert.equal(source.apply(project.id, request).replayed, true);
});

test('project namespaces and copied workspace records cannot cross project boundaries', (t) => {
  const { root, projects, project, source, file } = fixture(t);
  const second = projects.create({ name: '第二项目', idea: '隔离验证' });
  source.apply(project.id, input());
  const before = readFileSync(file);
  const secondFile = join(root, 'projects', second.id, 'source', 'workspace.json');
  assert.equal(source.get(second.id).revision, 0);
  source.apply(second.id, input(0, [newFile('src/second.ts')]));
  assert.deepEqual(readFileSync(file), before);
  writeFileSync(secondFile, before);
  assert.throws(() => source.get(second.id), hasCode('CORRUPT_SOURCE'));
  assert.throws(() => source.apply(second.id, input()), hasCode('CORRUPT_SOURCE'));
  assert.deepEqual(readFileSync(secondFile), before);
  assert.equal(source.get(project.id).revision, 1);
  for (const id of ['../outside', '/etc/passwd', project.id.toUpperCase()]) {
    assert.throws(() => source.get(id), hasCode('INVALID_INPUT'));
    assert.throws(() => source.apply(id, input()), hasCode('INVALID_INPUT'));
  }
});

test('untrusted virtual paths, unsupported operations, unknown fields and invalid text never touch disk', (t) => {
  const { project, source, directory } = fixture(t);
  for (const path of [
    '../credentials.json',
    '/tmp/file.ts',
    'src/../../private.ts',
    'src\\file.ts',
    'src/%2e%2e/file.ts',
    'src/Foo.ts',
    'src/.env',
    'src/con.ts',
    'src/app.ts/child.ts',
    'src/tests/check.ts',
    'src/package.json',
    'src/app.test.ts',
    'src/汉字.ts',
    'src/a.ts\u0000',
  ]) {
    assert.throws(
      () => source.apply(project.id, input(0, [newFile(path)])),
      hasCode('SOURCE_PATH_DENIED'),
    );
  }
  for (const value of [
    null,
    [],
    { ...input(), shell: 'anything' },
    { ...input(), requestId: '../outside' },
    { ...input(), binding: { ...binding(), apiKey: 'synthetic' } },
    input(0, [
      { operation: 'execute', path: 'src/a.ts', content: 'anything' } as unknown as SourceChange,
    ]),
    input(0, [newFile('src/a.ts', '\u0000')]),
    input(0, [newFile('src/a.ts', '\ud800')]),
  ])
    assert.throws(
      () => source.apply(project.id, value),
      (error) => error instanceof AppError,
    );
  assert.deepEqual(readdirSync(directory), []);
});

test('duplicate paths in one request are rejected before a transaction is recorded', (t) => {
  const { project, source, file } = fixture(t);
  assert.throws(
    () =>
      source.apply(project.id, input(0, [newFile('src/app.ts'), newFile('src/app.ts', 'second')])),
    hasCode('INVALID_INPUT'),
  );
  assert.equal(existsSync(file), false);
});

test('malformed, forged and inconsistent historical records preserve bytes and block new work', (t) => {
  const { project, source, file } = fixture(t);
  source.apply(project.id, input());
  source.apply(project.id, input(1, [newFile('src/next.ts')]));
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  const mutations: ((value: any) => void)[] = [
    (value) => {
      value.unexpected = true;
    },
    (value) => {
      value.commits = [];
    },
    (value) => {
      value.commits[0].unexpected = true;
    },
    (value) => {
      value.commits[0].revision = 2;
    },
    (value) => {
      value.commits[0].createdAt = 'yesterday';
    },
    (value) => {
      value.commits[0].request.requestId = '../host';
    },
    (value) => {
      value.commits[0].request.binding.planRunId = '../host';
    },
    (value) => {
      value.commits[0].requestHash = '0'.repeat(64);
    },
    (value) => {
      value.commits[0].snapshot.files[0].sha256 = '0'.repeat(64);
    },
    (value) => {
      value.commits[0].snapshot.files[0].content = 'tampered';
    },
    (value) => {
      value.commits[0].snapshot.files[0].unexpected = true;
    },
    (value) => {
      value.commits[1].snapshot.files.reverse();
    },
    (value) => {
      value.commits[1].snapshot.files.push(value.commits[1].snapshot.files[0]);
    },
    (value) => {
      value.commits[1].snapshot.revision = 3;
    },
    (value) => {
      value.commits[1].request.requestId = value.commits[0].request.requestId;
      value.commits[1].requestHash = sourceRequestHash(value.commits[1].request);
    },
    (value) => {
      value.commits[1].request.expectedRevision = 0;
      value.commits[1].requestHash = sourceRequestHash(value.commits[1].request);
    },
    (value) => {
      value.commits[0].snapshot.files = [];
    },
    (value) => {
      value.commits[1].request.changes[0].content = 'new';
      value.commits[1].requestHash = sourceRequestHash(value.commits[1].request);
    },
  ];
  const cases = [
    '{"partial":',
    'null',
    '[]',
    ...mutations.map((mutate) => {
      const value = structuredClone(baseline);
      mutate(value);
      return JSON.stringify(value);
    }),
  ];
  for (const bytes of cases) {
    writeFileSync(file, bytes);
    assert.throws(() => source.get(project.id), hasCode('CORRUPT_SOURCE'));
    assert.throws(
      () => source.apply(project.id, input(2, [newFile('src/another.ts')])),
      hasCode('CORRUPT_SOURCE'),
    );
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
});

test('future record versions are not migrated or overwritten implicitly', (t) => {
  const { project, source, file } = fixture(t);
  source.apply(project.id, input());
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.schemaVersion = 3;
  writeFileSync(file, JSON.stringify(raw));
  const before = readFileSync(file);
  assert.throws(() => source.get(project.id), hasCode('UNSUPPORTED_SOURCE'));
  assert.throws(() => source.apply(project.id, input()), hasCode('UNSUPPORTED_SOURCE'));
  assert.deepEqual(readFileSync(file), before);
});

test('observed source disappearance is rejected by both instances until the same record is restored', (t) => {
  const { root, project, source, file } = fixture(t);
  source.apply(project.id, input());
  const reopened = new SourceStore(new ProjectStore(root));
  reopened.get(project.id);
  const moved = join(root, 'moved-workspace.json');
  renameSync(file, moved);
  for (const instance of [source, reopened]) {
    assert.throws(() => instance.get(project.id), hasCode('MISSING_SOURCE'));
    assert.throws(() => instance.apply(project.id, input()), hasCode('MISSING_SOURCE'));
  }
  assert.equal(existsSync(file), false);
  renameSync(moved, file);
  assert.equal(source.get(project.id).revision, 1);
});

test('unknown preexisting source content cannot silently become a new workspace', (t) => {
  const { project, source, directory, file } = fixture(t);
  const unknown = join(directory, 'unknown.txt');
  writeFileSync(unknown, 'retain original content');
  assert.throws(() => source.get(project.id), hasCode('CORRUPT_SOURCE'));
  assert.throws(() => source.apply(project.id, input()), hasCode('CORRUPT_SOURCE'));
  assert.equal(readFileSync(unknown, 'utf8'), 'retain original content');
  assert.equal(existsSync(file), false);
});

test('unfinished temporary records are ignored and preserved before and after a committed transaction', (t) => {
  const { root, project, source, directory } = fixture(t);
  const temporary = join(directory, `.source-${randomUUID()}.tmp`);
  writeFileSync(temporary, '{"partial":');
  assert.deepEqual(source.get(project.id), { revision: 0, files: [] });
  source.apply(project.id, input());
  assert.equal(new SourceStore(new ProjectStore(root)).get(project.id).revision, 1);
  assert.equal(readFileSync(temporary, 'utf8'), '{"partial":');
  assert.equal(readdirSync(directory).length, 2);
});

test('symlink files and source directories cannot redirect reads or writes', (t) => {
  const { root, project, source, directory, file } = fixture(t);
  source.apply(project.id, input());
  const outside = join(root, 'unrelated.json');
  renameSync(file, outside);
  const before = readFileSync(outside);
  symlinkSync(outside, file, 'file');
  assert.throws(() => source.get(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => source.apply(project.id, input()), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(outside), before);
  rmSync(file);
  renameSync(outside, file);
  const moved = join(root, 'moved-source');
  renameSync(directory, moved);
  symlinkSync(moved, directory, 'dir');
  assert.throws(() => source.get(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => source.apply(project.id, input()), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(join(moved, 'workspace.json')), before);
});

test('hardlinked files, non-file records and linked temporary records cannot be trusted', (t) => {
  const { root, project, source, directory, file } = fixture(t);
  source.apply(project.id, input());
  const outside = join(root, 'linked.json');
  linkSync(file, outside);
  const before = readFileSync(outside);
  assert.throws(() => source.get(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => source.apply(project.id, input()), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(outside), before);
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => source.get(project.id), hasCode('UNSAFE_PATH'));
  rmSync(file, { recursive: true });
  renameSync(outside, file);
  const temporary = join(directory, `.source-${randomUUID()}.tmp`);
  symlinkSync(file, temporary, 'file');
  assert.throws(() => source.get(project.id), hasCode('UNSAFE_PATH'));
});

test('oversized persisted records are retained and cannot be read or overwritten', (t) => {
  const { project, source, file } = fixture(t);
  source.apply(project.id, input());
  truncateSync(file, SOURCE_LIMITS.recordBytes + 1);
  const before = readFileSync(file);
  assert.throws(() => source.get(project.id), hasCode('SOURCE_LIMIT'));
  assert.throws(() => source.apply(project.id, input()), hasCode('SOURCE_LIMIT'));
  assert.deepEqual(readFileSync(file), before);
});

test('file byte, operation and total workspace capacity limits are checked before committing', (t) => {
  const { project, source, file } = fixture(t);
  assert.throws(
    () =>
      source.apply(
        project.id,
        input(0, [newFile('src/large.ts', 'a'.repeat(SOURCE_LIMITS.fileBytes + 1))]),
      ),
    hasCode('SOURCE_LIMIT'),
  );
  assert.throws(
    () =>
      source.apply(
        project.id,
        input(0, [
          newFile('src/unicode.ts', '中'.repeat(Math.floor(SOURCE_LIMITS.fileBytes / 3) + 1)),
        ]),
      ),
    hasCode('SOURCE_LIMIT'),
  );
  assert.throws(
    () =>
      source.apply(
        project.id,
        input(
          0,
          Array.from({ length: 33 }, (_, index) => newFile(`src/f${index}.ts`)),
        ),
      ),
    hasCode('SOURCE_LIMIT'),
  );
  assert.equal(existsSync(file), false);
  const content = 'a'.repeat(SOURCE_LIMITS.fileBytes);
  source.apply(
    project.id,
    input(
      0,
      Array.from({ length: 16 }, (_, index) => newFile(`src/f${index}.ts`, content)),
    ),
  );
  assert.equal(
    source.get(project.id).files.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0),
    SOURCE_LIMITS.workspaceBytes,
  );
  const before = readFileSync(file);
  assert.throws(
    () => source.apply(project.id, input(1, [newFile('src/overflow.ts', 'a')])),
    hasCode('SOURCE_LIMIT'),
  );
  assert.deepEqual(readFileSync(file), before);
});

test('file count limits keep all prior files intact', (t) => {
  const { project, source, file } = fixture(t);
  for (let batch = 0; batch < 4; batch += 1)
    source.apply(
      project.id,
      input(
        batch,
        Array.from({ length: 32 }, (_, index) => newFile(`src/f${batch * 32 + index}.ts`)),
      ),
    );
  assert.equal(source.get(project.id).files.length, SOURCE_LIMITS.fileCount);
  const before = readFileSync(file);
  assert.throws(
    () => source.apply(project.id, input(4, [newFile('src/overflow.ts')])),
    hasCode('SOURCE_LIMIT'),
  );
  assert.deepEqual(readFileSync(file), before);
});

test('commit limits preserve receipts so the final request remains retryable', (t) => {
  const { root, project, source, file } = fixture(t);
  let request = input(0, [newFile('src/app.ts', 'same')]);
  source.apply(project.id, request);
  for (let revision = 1; revision < SOURCE_LIMITS.commits; revision += 1) {
    request = input(revision, [
      { operation: 'write', path: 'src/app.ts', expectedHash: sourceHash('same'), content: 'same' },
    ]);
    source.apply(project.id, request);
  }
  const before = readFileSync(file);
  assert.throws(
    () => source.apply(project.id, input(SOURCE_LIMITS.commits, [newFile('src/overflow.ts')])),
    hasCode('SOURCE_LIMIT'),
  );
  assert.equal(new SourceStore(new ProjectStore(root)).apply(project.id, request).replayed, true);
  assert.deepEqual(readFileSync(file), before);
});

test('the aggregate history byte limit stops growth without losing the last committed version', (t) => {
  const { project, source, file } = fixture(t);
  const content = 'a'.repeat(SOURCE_LIMITS.fileBytes);
  let request = input(
    0,
    Array.from({ length: 16 }, (_, index) => newFile(`src/f${index}.ts`, content)),
  );
  source.apply(project.id, request);
  let revision = 1;
  let reachedLimit = false;
  while (revision < SOURCE_LIMITS.commits) {
    const before = readFileSync(file);
    const next = input(revision, [
      { operation: 'write', path: 'src/f0.ts', expectedHash: sourceHash(content), content },
    ]);
    try {
      source.apply(project.id, next);
    } catch (error) {
      assert.ok(hasCode('SOURCE_LIMIT')(error));
      assert.deepEqual(readFileSync(file), before);
      reachedLimit = true;
      break;
    }
    request = next;
    revision += 1;
  }
  assert.equal(reachedLimit, true);
  assert.equal(source.get(project.id).revision, revision);
  assert.equal(source.apply(project.id, request).replayed, true);
  assert.ok(statSync(file).size <= SOURCE_LIMITS.recordBytes);
});

test('archiving at the pre-rename boundary aborts before any source commit', (t) => {
  const { projects, project, file } = fixture(t);
  const source = new SourceStore(projects, {
    beforeRename: () => projects.archive(project.id, true),
  });
  assert.throws(() => source.apply(project.id, input()), hasCode('ARCHIVED'));
  assert.equal(existsSync(file), false);
});
