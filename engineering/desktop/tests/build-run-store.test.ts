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
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BuildRunStore } from '../src/main/build-run-store';
import { ProjectStore } from '../src/main/project-store';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';
import type { BuildAttempt } from '../src/shared/build-contracts';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const attempt = (overrides: Partial<BuildAttempt> = {}): BuildAttempt => ({
  id: randomUUID(),
  planRunId: randomUUID(),
  planInputHash: sourceHash('plan'),
  planArtifactHash: sourceHash('artifact'),
  sourceRevision: 1,
  sourceHash: sourceHash('source'),
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
  status: 'running',
  diagnostics: [],
  errorCode: null,
  ...overrides,
});
function fixture(t: TestContext, options: ConstructorParameters<typeof BuildRunStore>[1] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), '构建日志 ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '构建日志', idea: '只验证本地持久记录' });
  const store = new BuildRunStore(projects, options);
  const directory = join(root, 'projects', project.id, 'runs');
  const file = join(directory, 'build-attempts.json');
  return { root, projects, project, store, file, directory };
}

test('empty reads do not write; intent and fixed failure diagnostics reopen without changing project data', (t) => {
  const f = fixture(t);
  const manifest = join(f.root, 'projects', f.project.id, 'project.json');
  const before = readFileSync(manifest);
  assert.deepEqual(f.store.list(f.project.id), []);
  assert.equal(existsSync(f.file), false);
  const first = attempt();
  f.store.save(f.project.id, first);
  const failed: BuildAttempt = {
    ...first,
    status: 'failed',
    errorCode: 'BUILD_FAILED',
    diagnostics: [{ path: 'src/app.tsx', line: 2, message: '源码语法无法编译，请检查此处。' }],
  };
  f.store.save(f.project.id, failed);
  const reopened = new BuildRunStore(new ProjectStore(f.root));
  assert.deepEqual(reopened.list(f.project.id), [failed]);
  const detached = reopened.list(f.project.id);
  detached[0].diagnostics[0].message = 'mutated';
  assert.deepEqual(reopened.list(f.project.id), [failed]);
  assert.deepEqual(readFileSync(manifest), before);
  if (process.platform !== 'win32') assert.equal(statSync(f.file).mode & 0o777, 0o600);
});

test('terminal result is immutable; exact retries preserve bytes', (t) => {
  const f = fixture(t);
  const first = attempt();
  f.store.save(f.project.id, first);
  const done: BuildAttempt = { ...first, status: 'succeeded' };
  f.store.save(f.project.id, done);
  const before = readFileSync(f.file);
  f.store.save(f.project.id, structuredClone(done));
  assert.deepEqual(readFileSync(f.file), before);
  assert.throws(
    () => f.store.save(f.project.id, { ...done, status: 'failed' }),
    hasCode('BUILD_RUN_CONFLICT'),
  );
  assert.throws(() => f.store.save(f.project.id, first), hasCode('BUILD_RUN_CONFLICT'));
});

test('source and confirmation bindings cannot be changed under an existing identity', (t) => {
  const f = fixture(t);
  const first = attempt();
  f.store.save(f.project.id, first);
  for (const change of [
    { planRunId: randomUUID() },
    { planInputHash: sourceHash('other') },
    { planArtifactHash: sourceHash('other') },
    { sourceRevision: 2 },
    { sourceHash: sourceHash('other') },
    { createdAt: '2026-10-02T00:00:00.000Z' },
  ])
    assert.throws(
      () => f.store.save(f.project.id, { ...first, ...change }),
      hasCode('BUILD_RUN_CONFLICT'),
    );
  assert.deepEqual(f.store.list(f.project.id), [first]);
});

test('strict schema refuses raw messages, paths, invalid times, terminal intent and impossible states', (t) => {
  const f = fixture(t);
  const first = attempt();
  const values: unknown[] = [
    { ...first, prompt: 'secret' },
    { ...first, id: '../outside' },
    { ...first, planInputHash: 'no' },
    { ...first, sourceRevision: -1 },
    { ...first, updatedAt: '2026-10-02T00:00:00.000Z' },
    { ...first, createdAt: 'today' },
    { ...first, status: 'unknown' },
    { ...first, status: 'succeeded' },
    { ...first, errorCode: 'private native error' },
    { ...first, status: 'cancelled', errorCode: null },
    { ...first, status: 'interrupted', errorCode: null },
    {
      ...first,
      diagnostics: [{ path: 'src/app.tsx', line: 1, message: 'SYNTHETIC_SECRET /private/path' }],
    },
    {
      ...first,
      status: 'failed',
      diagnostics: [{ path: '/private/path', line: 1, message: '源码语法无法编译，请检查此处。' }],
    },
  ];
  for (const value of values)
    assert.throws(() => f.store.save(f.project.id, value as BuildAttempt));
  assert.equal(existsSync(f.file), false);
});

test('corrupt, foreign-project, duplicate and future records fail closed without being overwritten', (t) => {
  const f = fixture(t);
  const first = attempt();
  const records = [
    'not JSON',
    JSON.stringify({ schemaVersion: 2, projectId: f.project.id, attempts: [first] }),
    JSON.stringify({ schemaVersion: 1, projectId: randomUUID(), attempts: [first] }),
    JSON.stringify({ schemaVersion: 1, projectId: f.project.id, attempts: [first, first] }),
    JSON.stringify({ schemaVersion: 1, projectId: f.project.id, attempts: [] }),
  ];
  for (const bytes of records) {
    writeFileSync(f.file, bytes);
    assert.throws(() => f.store.list(f.project.id));
    assert.throws(() => f.store.save(f.project.id, first));
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
  }
});

test('observed missing records and oversized records cannot be replaced by an empty journal', (t) => {
  const f = fixture(t);
  f.store.save(f.project.id, attempt());
  rmSync(f.file);
  assert.throws(() => f.store.list(f.project.id), hasCode('MISSING_BUILD_RUN'));
  assert.throws(() => f.store.save(f.project.id, attempt()), hasCode('MISSING_BUILD_RUN'));
  writeFileSync(f.file, '');
  truncateSync(f.file, 1024 * 1024 + 1);
  assert.throws(() => f.store.list(f.project.id), hasCode('BUILD_RUN_LIMIT'));
});

test('symlinks, hard links and directories are rejected without modifying their targets', (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside.json');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, f.file);
  assert.throws(() => f.store.save(f.project.id, attempt()), hasCode('UNSAFE_PATH'));
  rmSync(f.file);
  linkSync(outside, f.file);
  assert.throws(() => f.store.list(f.project.id), hasCode('UNSAFE_PATH'));
  rmSync(f.file);
  mkdirSync(f.file);
  assert.throws(() => f.store.list(f.project.id), hasCode('UNSAFE_PATH'));
  assert.equal(readFileSync(outside, 'utf8'), 'untouched');
});

test('pre-rename failure preserves prior bytes, cleans only its temporary and hides native detail', (t) => {
  let fail = false;
  const f = fixture(t, {
    beforeRename() {
      if (fail) throw new Error('SYNTHETIC_SECRET');
    },
  });
  const first = attempt();
  f.store.save(f.project.id, first);
  const before = readFileSync(f.file);
  fail = true;
  assert.throws(
    () => f.store.save(f.project.id, { ...first, status: 'succeeded' }),
    (error) => hasCode('BUILD_RUN_IO')(error) && !(error as Error).message.includes('SECRET'),
  );
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(readdirSync(f.directory), ['build-attempts.json']);
});

test('post-rename failure preserves committed result and exact retry is harmless', (t) => {
  let fail = false;
  const f = fixture(t, {
    afterRename() {
      if (fail) throw new Error('SYNTHETIC_SECRET');
    },
  });
  const first = attempt();
  f.store.save(f.project.id, first);
  fail = true;
  const done: BuildAttempt = { ...first, status: 'succeeded' };
  assert.throws(() => f.store.save(f.project.id, done), hasCode('BUILD_RUN_COMMIT_UNCERTAIN'));
  assert.deepEqual(f.store.list(f.project.id), [done]);
  const before = readFileSync(f.file);
  f.store.save(f.project.id, done);
  assert.deepEqual(readFileSync(f.file), before);
});

test('concurrent bytes change is detected before rename and retained', (t) => {
  let replace = false;
  let replacement = '';
  const f = fixture(t, {
    beforeRename() {
      if (replace) writeFileSync(f.file, replacement);
    },
  });
  const first = attempt();
  f.store.save(f.project.id, first);
  const other = { ...first, updatedAt: '2026-10-03T00:00:01.000Z' };
  replacement =
    JSON.stringify({ schemaVersion: 1, projectId: f.project.id, attempts: [other] }) + '\n';
  replace = true;
  assert.throws(
    () => f.store.save(f.project.id, { ...first, status: 'succeeded' }),
    hasCode('BUILD_RUN_CONFLICT'),
  );
  assert.equal(readFileSync(f.file, 'utf8'), replacement);
});

test('archive permits finalizing an existing attempt but never starting a new one', (t) => {
  const f = fixture(t);
  const first = attempt();
  f.store.save(f.project.id, first);
  f.projects.archive(f.project.id, true);
  f.store.save(f.project.id, { ...first, status: 'interrupted', errorCode: 'BUILD_INTERRUPTED' });
  assert.throws(() => f.store.save(f.project.id, attempt()), hasCode('ARCHIVED'));
});

test('the bounded journal retains all 100 attempts and refuses another one', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) f.store.save(f.project.id, attempt());
  const before = readFileSync(f.file);
  assert.throws(() => f.store.save(f.project.id, attempt()), hasCode('BUILD_RUN_LIMIT'));
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(f.store.list(f.project.id).length, 100);
});
