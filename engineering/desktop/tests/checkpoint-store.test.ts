import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../src/main/project-store';
import { SourceStore } from '../src/main/source-store';
import { SOURCE_LIMITS, sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';
import type {
  SourceApplyInput,
  SourceBinding,
  SourceChange,
  SourceRestoreInput,
} from '../src/shared/source-contracts';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const binding: SourceBinding = {
  planRunId: randomUUID(),
  planInputHash: sourceHash('confirmed input'),
  planArtifactHash: sourceHash('plan artifact'),
};
const write = (path: string, content = 'export {};', old: string | null = null): SourceChange => ({
  operation: 'write',
  path,
  content,
  expectedHash: old === null ? null : sourceHash(old),
});
const applyInput = (expectedRevision: number, changes: SourceChange[]): SourceApplyInput => ({
  requestId: randomUUID(),
  binding,
  expectedRevision,
  changes,
});
const restoreInput = (expectedRevision: number, targetRevision: number): SourceRestoreInput => ({
  requestId: randomUUID(),
  binding,
  expectedRevision,
  targetRevision,
});
function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-checkpoints-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '检查点合成测试', idea: '无模型请求' });
  const source = new SourceStore(projects);
  const directory = join(root, 'projects', project.id, 'source');
  const file = join(directory, 'workspace.json');
  return { root, projects, project, source, directory, file };
}

test('history includes the initial empty tree and complete verifiable checkpoint metadata without writes', (t) => {
  const { project, source, file } = fixture(t);
  assert.deepEqual(source.history(project.id), [
    {
      revision: 0,
      createdAt: null,
      binding: null,
      changedPaths: [],
      files: [],
      restoredFrom: null,
      requestId: null,
      snapshotHash: sourceHash(JSON.stringify({ revision: 0, files: [] })),
    },
  ]);
  assert.deepEqual(source.at(project.id, 0), { revision: 0, files: [] });
  assert.equal(existsSync(file), false);
  const request = applyInput(0, [write('src/app.ts', '你好')]);
  source.apply(project.id, request);
  const history = source.history(project.id);
  assert.equal(history.length, 2);
  assert.deepEqual(history[1], {
    revision: 1,
    createdAt: JSON.parse(readFileSync(file, 'utf8')).commits[0].createdAt,
    binding,
    changedPaths: ['src/app.ts'],
    files: [{ path: 'src/app.ts', sha256: sourceHash('你好'), bytes: 6 }],
    restoredFrom: null,
    requestId: request.requestId,
    snapshotHash: sourceHash(JSON.stringify(source.at(project.id, 1))),
  });
  history[1].binding!.planArtifactHash = 'mutated';
  history[1].files[0].sha256 = 'mutated';
  const snapshot = source.at(project.id, 1);
  snapshot.files[0].content = 'mutated';
  assert.equal(source.history(project.id)[1].binding!.planArtifactHash, binding.planArtifactHash);
  assert.equal(source.at(project.id, 1).files[0].content, '你好');
});

test('restore atomically adds a monotonic version and preserves both original versions and unrelated business data', (t) => {
  const { root, project, source, file } = fixture(t);
  const projectRoot = join(root, 'projects', project.id);
  const business = join(projectRoot, 'data', 'articles.json');
  writeFileSync(business, JSON.stringify({ articles: [{ title: 'newer user content' }] }));
  const businessBefore = readFileSync(business);
  const manifestBefore = readFileSync(join(projectRoot, 'project.json'));
  source.apply(
    project.id,
    applyInput(0, [write('src/a.ts', 'first'), write('src/style.css', 'before')]),
  );
  const first = source.get(project.id);
  source.apply(
    project.id,
    applyInput(1, [
      write('src/a.ts', 'second', 'first'),
      { operation: 'delete', path: 'src/style.css', expectedHash: sourceHash('before') },
      write('src/new.ts', 'new'),
    ]),
  );
  const second = source.get(project.id);
  const request = restoreInput(2, 1);
  assert.deepEqual(source.restore(project.id, request), {
    revision: 3,
    previousRevision: 2,
    changedPaths: ['src/a.ts', 'src/new.ts', 'src/style.css'],
    replayed: false,
  });
  const reopened = new SourceStore(new ProjectStore(root));
  assert.deepEqual(reopened.get(project.id), { ...first, revision: 3 });
  assert.deepEqual(reopened.at(project.id, 1), first);
  assert.deepEqual(reopened.at(project.id, 2), second);
  assert.deepEqual(
    reopened.history(project.id).map((item) => item.revision),
    [0, 1, 2, 3],
  );
  assert.equal(reopened.history(project.id)[3].restoredFrom, 1);
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.schemaVersion, 2);
  assert.equal(disk.commits[2].kind, 'restore');
  assert.deepEqual(disk.commits[2].request, request);
  assert.equal(disk.commits[2].targetSnapshotHash, sourceHash(JSON.stringify(first)));
  assert.deepEqual(readFileSync(business), businessBefore);
  assert.deepEqual(readFileSync(join(projectRoot, 'project.json')), manifestBefore);
});

test('restoring the empty checkpoint preserves the removed tree and allows ordinary bounded changes afterward', (t) => {
  const { project, source } = fixture(t);
  source.apply(project.id, applyInput(0, [write('src/a.ts', 'retained')]));
  assert.deepEqual(source.restore(project.id, restoreInput(1, 0)), {
    revision: 2,
    previousRevision: 1,
    changedPaths: ['src/a.ts'],
    replayed: false,
  });
  assert.deepEqual(source.get(project.id), { revision: 2, files: [] });
  assert.equal(source.at(project.id, 1).files[0].content, 'retained');
  source.apply(project.id, applyInput(2, [write('src/new.ts')]));
  assert.equal(source.get(project.id).revision, 3);
  assert.equal(source.history(project.id)[3].restoredFrom, null);
});

test('an empty project can explicitly restore revision zero without inventing source files', (t) => {
  const { root, project, source } = fixture(t);
  assert.deepEqual(source.restore(project.id, restoreInput(0, 0)), {
    revision: 1,
    previousRevision: 0,
    changedPaths: [],
    replayed: false,
  });
  assert.deepEqual(new SourceStore(new ProjectStore(root)).get(project.id), {
    revision: 1,
    files: [],
  });
});

test('one restore supports a 128-file tree replacement with 256 path changes without widening model writes', (t) => {
  const { root, project, source, file } = fixture(t);
  for (let batch = 0; batch < 4; batch += 1)
    source.apply(
      project.id,
      applyInput(
        batch,
        Array.from({ length: 32 }, (_, index) => write(`src/a${batch * 32 + index}.ts`)),
      ),
    );
  const original = source.get(project.id);
  source.restore(project.id, restoreInput(4, 0));
  for (let batch = 0; batch < 4; batch += 1)
    source.apply(
      project.id,
      applyInput(
        batch + 5,
        Array.from({ length: 32 }, (_, index) => write(`src/b${batch * 32 + index}.ts`)),
      ),
    );
  const request = restoreInput(9, 4);
  const result = source.restore(project.id, request);
  assert.equal(result.revision, 10);
  assert.equal(result.changedPaths.length, 256);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).commits.length, 10);
  assert.deepEqual(new SourceStore(new ProjectStore(root)).get(project.id), {
    ...original,
    revision: 10,
  });
  const before = readFileSync(file);
  assert.throws(
    () =>
      source.apply(
        project.id,
        applyInput(
          10,
          Array.from({ length: 33 }, (_, index) => write(`src/new${index}.ts`)),
        ),
      ),
    hasCode('SOURCE_LIMIT'),
  );
  assert.deepEqual(readFileSync(file), before);
});

test('restore receipts deduplicate after later commits and reject every changed input or operation kind', (t) => {
  const { root, project, source, file } = fixture(t);
  const initial = applyInput(0, [write('src/app.ts')]);
  source.apply(project.id, initial);
  const request = restoreInput(1, 0);
  const result = source.restore(project.id, request);
  source.apply(project.id, applyInput(2, [write('src/new.ts')]));
  const before = readFileSync(file);
  const reopened = new SourceStore(new ProjectStore(root));
  assert.deepEqual(reopened.restore(project.id, request), { ...result, replayed: true });
  for (const changed of [
    { ...request, targetRevision: 1 },
    { ...request, expectedRevision: 3 },
    { ...request, binding: { ...binding, planRunId: randomUUID() } },
    { ...request, binding: { ...binding, planInputHash: sourceHash('other') } },
    { ...request, binding: { ...binding, planArtifactHash: sourceHash('other') } },
  ])
    assert.throws(() => reopened.restore(project.id, changed), hasCode('REQUEST_CONFLICT'));
  assert.throws(
    () => reopened.restore(project.id, { ...request, requestId: initial.requestId }),
    hasCode('REQUEST_CONFLICT'),
  );
  assert.throws(
    () => reopened.apply(project.id, { ...initial, requestId: request.requestId }),
    hasCode('REQUEST_CONFLICT'),
  );
  assert.deepEqual(readFileSync(file), before);
  assert.equal(reopened.get(project.id).revision, 3);
});

test('stale revisions, nonexistent checkpoints, different confirmation bindings and invalid inputs fail closed', (t) => {
  const { project, source, file } = fixture(t);
  source.apply(project.id, applyInput(0, [write('src/app.ts')]));
  const before = readFileSync(file);
  assert.throws(() => source.restore(project.id, restoreInput(0, 0)), hasCode('SOURCE_CONFLICT'));
  assert.throws(
    () => source.restore(project.id, restoreInput(1, 2)),
    hasCode('SOURCE_CHECKPOINT_NOT_FOUND'),
  );
  assert.throws(() => source.at(project.id, 2), hasCode('SOURCE_CHECKPOINT_NOT_FOUND'));
  assert.throws(
    () =>
      source.restore(project.id, {
        ...restoreInput(1, 1),
        binding: { ...binding, planInputHash: sourceHash('new confirmation') },
      }),
    hasCode('SOURCE_BINDING_CHANGED'),
  );
  for (const invalid of [
    null,
    [],
    { ...restoreInput(1, 0), extra: true },
    { ...restoreInput(1, 0), targetRevision: -1 },
    { ...restoreInput(1, 0), expectedRevision: 0.1 },
    { ...restoreInput(1, 0), requestId: '../path' },
    { ...restoreInput(1, 0), binding: {} },
  ])
    assert.throws(
      () => source.restore(project.id, invalid),
      (error) => error instanceof AppError,
    );
  assert.deepEqual(readFileSync(file), before);
});

test('archived projects retain history but reject new and repeated restores', (t) => {
  const { projects, project, source, file } = fixture(t);
  source.apply(project.id, applyInput(0, [write('src/app.ts')]));
  const request = restoreInput(1, 0);
  source.restore(project.id, request);
  const before = readFileSync(file);
  projects.archive(project.id, true);
  assert.equal(source.history(project.id).length, 3);
  assert.equal(source.at(project.id, 1).files.length, 1);
  assert.throws(() => source.restore(project.id, request), hasCode('ARCHIVED'));
  assert.throws(() => source.restore(project.id, restoreInput(2, 1)), hasCode('ARCHIVED'));
  assert.deepEqual(readFileSync(file), before);
});

test('pre-rename restore failure leaves the old schema and bytes intact and retry commits once', (t) => {
  const { root, projects, project, source, file, directory } = fixture(t);
  source.apply(project.id, applyInput(0, [write('src/app.ts')]));
  const before = readFileSync(file);
  const request = restoreInput(1, 0);
  const failing = new SourceStore(projects, {
    beforeRename: () => {
      throw new Error('private details');
    },
  });
  assert.throws(
    () => failing.restore(project.id, request),
    (error) => hasCode('SOURCE_IO')(error) && !(error as Error).message.includes('private'),
  );
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(directory), ['workspace.json']);
  const reopened = new SourceStore(new ProjectStore(root));
  assert.equal(reopened.get(project.id).revision, 1);
  assert.equal(reopened.restore(project.id, request).replayed, false);
  assert.equal(reopened.restore(project.id, request).replayed, true);
});

test('post-rename restore failure is uncertain; exact retry verifies the durable receipt without rewriting', (t) => {
  const { root, projects, project, source, file, directory } = fixture(t);
  source.apply(project.id, applyInput(0, [write('src/app.ts')]));
  const request = restoreInput(1, 0);
  const failing = new SourceStore(projects, {
    afterRename: () => {
      throw new Error('private details');
    },
  });
  assert.throws(() => failing.restore(project.id, request), hasCode('SOURCE_COMMIT_UNCERTAIN'));
  const before = readFileSync(file);
  const reopened = new SourceStore(new ProjectStore(root));
  assert.deepEqual(reopened.get(project.id), { revision: 2, files: [] });
  assert.deepEqual(reopened.restore(project.id, request), {
    revision: 2,
    previousRevision: 1,
    changedPaths: ['src/app.ts'],
    replayed: true,
  });
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(directory), ['workspace.json']);
});

test('a concurrent write or archive at the restore rename boundary cannot be overwritten', (t) => {
  const { projects, project, source, file } = fixture(t);
  source.apply(project.id, applyInput(0, [write('src/app.ts')]));
  const competing = new SourceStore(projects, {
    beforeRename: () => source.apply(project.id, applyInput(1, [write('src/winner.ts')])),
  });
  assert.throws(
    () => competing.restore(project.id, restoreInput(1, 0)),
    hasCode('SOURCE_CONFLICT'),
  );
  assert.equal(source.get(project.id).revision, 2);
  assert.equal(source.get(project.id).files.length, 2);
  const before = readFileSync(file);
  const archiving = new SourceStore(projects, {
    beforeRename: () => projects.archive(project.id, true),
  });
  assert.throws(() => archiving.restore(project.id, restoreInput(2, 0)), hasCode('ARCHIVED'));
  assert.deepEqual(readFileSync(file), before);
});

test('schema-one history remains readable and byte-identical until the first explicit restore', (t) => {
  const { root, project, source, file } = fixture(t);
  const request = applyInput(0, [write('src/app.ts')]);
  source.apply(project.id, request);
  const before = readFileSync(file);
  const old = JSON.parse(before.toString());
  assert.equal(old.schemaVersion, 1);
  assert.equal(old.commits[0].kind, undefined);
  const reopened = new SourceStore(new ProjectStore(root));
  assert.equal(reopened.at(project.id, 1).files.length, 1);
  assert.equal(reopened.history(project.id).length, 2);
  assert.equal(reopened.apply(project.id, request).replayed, true);
  assert.deepEqual(readFileSync(file), before);
  reopened.restore(project.id, restoreInput(1, 0));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 2);
  assert.equal(reopened.apply(project.id, request).replayed, true);
  assert.deepEqual(reopened.at(project.id, 1), old.commits[0].snapshot);
});

test('tampered restore targets, requests, snapshots and missing history block all reads and writes', (t) => {
  const { project, source, file } = fixture(t);
  source.apply(project.id, applyInput(0, [write('src/app.ts', 'first')]));
  source.apply(project.id, applyInput(1, [write('src/app.ts', 'second', 'first')]));
  source.restore(project.id, restoreInput(2, 1));
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  const mutations: ((value: any) => void)[] = [
    (value) => {
      value.commits[2].targetSnapshotHash = '0'.repeat(64);
    },
    (value) => {
      value.commits[2].request.targetRevision = 2;
    },
    (value) => {
      value.commits[2].request.expectedRevision = 1;
    },
    (value) => {
      value.commits[2].request.extra = true;
    },
    (value) => {
      value.commits[2].snapshot.files = [];
    },
    (value) => {
      value.commits[2].kind = 'apply';
    },
    (value) => {
      value.commits[2].targetSnapshotHash = undefined;
    },
    (value) => {
      value.commits[2].kind = undefined;
    },
    (value) => {
      value.commits.splice(0, 1);
    },
    (value) => {
      value.commits[0].snapshot.files[0].content = 'forged';
    },
    (value) => {
      value.schemaVersion = 1;
    },
    (value) => {
      value.commits[2].request.targetRevision = 3;
      value.commits[2].requestHash = sourceHash(
        JSON.stringify({ kind: 'restore', request: value.commits[2].request }),
      );
    },
    (value) => {
      value.commits[2].request.binding.planInputHash = sourceHash('other');
      value.commits[2].requestHash = sourceHash(
        JSON.stringify({ kind: 'restore', request: value.commits[2].request }),
      );
    },
  ];
  for (const mutate of mutations) {
    const raw = structuredClone(baseline);
    mutate(raw);
    const bytes = JSON.stringify(raw);
    writeFileSync(file, bytes);
    assert.throws(() => source.history(project.id), hasCode('CORRUPT_SOURCE'));
    assert.throws(() => source.at(project.id, 0), hasCode('CORRUPT_SOURCE'));
    assert.throws(() => source.get(project.id), hasCode('CORRUPT_SOURCE'));
    assert.throws(() => source.restore(project.id, restoreInput(3, 0)), hasCode('CORRUPT_SOURCE'));
    assert.throws(
      () => source.apply(project.id, applyInput(3, [write('src/new.ts')])),
      hasCode('CORRUPT_SOURCE'),
    );
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
});

test('missing observed records never become a fresh history or a successful empty restore', (t) => {
  const { root, project, source, file } = fixture(t);
  source.apply(project.id, applyInput(0, [write('src/app.ts')]));
  renameSync(file, join(root, 'preserved-source.json'));
  assert.throws(() => source.history(project.id), hasCode('MISSING_SOURCE'));
  assert.throws(() => source.at(project.id, 0), hasCode('MISSING_SOURCE'));
  assert.throws(() => source.restore(project.id, restoreInput(1, 0)), hasCode('MISSING_SOURCE'));
  assert.throws(
    () => new SourceStore(new ProjectStore(root)).restore(project.id, restoreInput(1, 0)),
    hasCode('SOURCE_CONFLICT'),
  );
  assert.equal(existsSync(file), false);
});

test('restore respects the existing history capacity while retained receipts remain replayable', (t) => {
  const { project, source, file } = fixture(t);
  let request = restoreInput(0, 0);
  for (let revision = 0; revision < SOURCE_LIMITS.commits; revision += 1) {
    request = restoreInput(revision, 0);
    source.restore(project.id, request);
  }
  const before = readFileSync(file);
  assert.throws(
    () => source.restore(project.id, restoreInput(SOURCE_LIMITS.commits, 0)),
    hasCode('SOURCE_LIMIT'),
  );
  assert.equal(source.restore(project.id, request).replayed, true);
  assert.deepEqual(readFileSync(file), before);
});
