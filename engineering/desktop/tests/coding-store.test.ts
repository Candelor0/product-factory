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
import test, { type TestContext } from 'node:test';
import type { CodingRun } from '../src/shared/coding-contracts';
import { CodingStore } from '../src/main/coding-store';
import { ProjectStore } from '../src/main/project-store';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const run = (overrides: Partial<CodingRun> = {}): CodingRun => ({
  id: randomUUID(),
  requestHash: sourceHash('synthetic coding request'),
  planRunId: randomUUID(),
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
  status: 'running',
  initialRevision: 0,
  rounds: 0,
  toolCalls: 0,
  toolRequests: [],
  errorCode: null,
  ...overrides,
});

function fixture(t: TestContext) {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'factory-coding-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, '中文 资料 🌱');
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '源码元数据', idea: '合成记录，不调用模型' });
  const store = new CodingStore(projects);
  const directory = join(root, 'projects', project.id, 'runs');
  const file = join(directory, 'coding.json');
  return { root, projects, project, store, directory, file };
}

test('empty reads do not write; bounded metadata survives reopening without changing a running state', (t) => {
  const { root, project, store, file, directory } = fixture(t);
  const manifest = join(root, 'projects', project.id, 'project.json');
  const before = readFileSync(manifest);
  assert.deepEqual(store.list(project.id), []);
  assert.equal(existsSync(file), false);
  const first = run();
  store.save(project.id, first);
  assert.deepEqual(new CodingStore(new ProjectStore(root)).list(project.id), [first]);
  assert.deepEqual(readFileSync(manifest), before);
  assert.deepEqual(readdirSync(directory), ['coding.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const detached = store.list(project.id);
  detached[0].status = 'failed';
  detached[0].errorCode = 'MUTATED';
  assert.deepEqual(store.list(project.id), [first]);
});

test('upsert advances one run in place and identical retries leave the file unchanged', (t) => {
  const { project, store, file } = fixture(t);
  const first = run();
  const second = run();
  store.save(project.id, first);
  store.save(project.id, second);
  const completed: CodingRun = {
    ...first,
    updatedAt: '2026-10-03T00:00:01.000Z',
    rounds: 2,
    toolCalls: 3,
    status: 'draft_saved',
  };
  store.save(project.id, completed);
  assert.deepEqual(store.list(project.id), [completed, second]);
  const before = readFileSync(file);
  const modified = statSync(file).mtimeMs;
  store.save(project.id, completed);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).mtimeMs, modified);
});

test('tool transaction associations append durably and retain only hashes and trusted request IDs', (t) => {
  const { root, project, store, file } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const firstMapping = { callHash: sourceHash('provider-call-1'), requestId: randomUUID() };
  const secondMapping = { callHash: sourceHash('provider-call-2'), requestId: randomUUID() };
  const started = { ...first, rounds: 1, toolCalls: 1, toolRequests: [firstMapping] };
  store.save(project.id, started);
  const continued = { ...started, toolCalls: 2, toolRequests: [firstMapping, secondMapping] };
  store.save(project.id, continued);
  assert.deepEqual(new CodingStore(new ProjectStore(root)).list(project.id), [continued]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).runs[0].toolRequests, [
    firstMapping,
    secondMapping,
  ]);
  assert.equal(readFileSync(file, 'utf8').includes('provider-call-'), false);
});

test('tool associations reject replacement, truncation, duplicate identities and malformed metadata', (t) => {
  const { project, store, file } = fixture(t);
  const mapping = { callHash: sourceHash('provider-call'), requestId: randomUUID() };
  const first = run({ rounds: 1, toolCalls: 1, toolRequests: [mapping] });
  store.save(project.id, first);
  const before = readFileSync(file);
  for (const changed of [
    { ...first, toolRequests: [] },
    { ...first, toolRequests: [{ ...mapping, callHash: sourceHash('replacement') }] },
    { ...first, toolRequests: [{ ...mapping, requestId: randomUUID() }] },
  ]) {
    assert.throws(() => store.save(project.id, changed), hasCode('CODING_CONFLICT'));
    assert.deepEqual(readFileSync(file), before);
  }
  const invalid: unknown[] = [
    { ...first, toolRequests: null },
    { ...first, toolRequests: undefined },
    { ...first, toolRequests: new Array(1) },
    { ...first, toolCalls: 2, toolRequests: [mapping, { ...mapping, requestId: randomUUID() }] },
    {
      ...first,
      toolCalls: 2,
      toolRequests: [mapping, { ...mapping, callHash: sourceHash('other') }],
    },
    { ...first, toolRequests: [{ ...mapping, callHash: 'provider-call' }] },
    { ...first, toolRequests: [{ ...mapping, requestId: '../private' }] },
    { ...first, toolRequests: [{ ...mapping, arguments: 'PRIVATE_MODEL_OUTPUT' }] },
    { ...first, toolCalls: 0 },
    { ...first, toolCalls: 12, toolRequests: Array(13).fill(mapping) },
  ];
  for (const value of invalid) {
    assert.throws(() => store.save(project.id, value as CodingRun), hasCode('INVALID_INPUT'));
    assert.deepEqual(readFileSync(file), before);
  }
});

test('identities, input versions, counters and dates cannot be rewound or reassigned', (t) => {
  const { root, project, store, file } = fixture(t);
  const first = run({ rounds: 2, toolCalls: 4, updatedAt: '2026-10-03T00:00:02.000Z' });
  store.save(project.id, first);
  const before = readFileSync(file);
  const reopened = new CodingStore(new ProjectStore(root));
  for (const changed of [
    { ...first, requestHash: sourceHash('another') },
    { ...first, planRunId: randomUUID() },
    { ...first, createdAt: '2026-10-03T00:00:01.000Z' },
    { ...first, initialRevision: 1 },
    { ...first, rounds: 1 },
    { ...first, toolCalls: 3 },
    { ...first, updatedAt: '2026-10-03T00:00:01.000Z' },
  ]) {
    assert.throws(() => reopened.save(project.id, changed), hasCode('CODING_CONFLICT'));
    assert.deepEqual(readFileSync(file), before);
  }
});

test('every terminal state persists and cannot silently restart a paid run', (t) => {
  const { project, store } = fixture(t);
  const statuses: CodingRun['status'][] = [
    'draft_saved',
    'no_changes',
    'cancelled',
    'failed',
    'limited',
    'interrupted',
  ];
  for (const status of statuses) {
    const first = run();
    store.save(project.id, first);
    const terminal = { ...first, status, errorCode: status === 'failed' ? 'MODEL_FAILED' : null };
    store.save(project.id, terminal);
    assert.throws(() => store.save(project.id, first), hasCode('CODING_CONFLICT'));
  }
  assert.deepEqual(
    store.list(project.id).map((item) => item.status),
    statuses,
  );
});

test('unknown fields, text-bearing errors, malformed identifiers and out-of-range counters never persist', (t) => {
  const { project, store, directory } = fixture(t);
  const first = run();
  const invalid: unknown[] = [
    null,
    [],
    'record',
    { ...first, prompt: 'SYNTHETIC_PRIVATE_TEXT' },
    { ...first, apiKey: 'SYNTHETIC_KEY' },
    { ...first, modelText: 'SYNTHETIC_OUTPUT' },
    { ...first, id: '../private' },
    { ...first, planRunId: first.planRunId.toUpperCase() },
    { ...first, requestHash: 'not a hash' },
    { ...first, status: 'completed' },
    { ...first, createdAt: 'yesterday' },
    { ...first, updatedAt: '2026-10-02T23:59:59.000Z' },
    { ...first, updatedAt: '2026-10-03T00:00:00Z' },
    { ...first, rounds: -1 },
    { ...first, rounds: 5 },
    { ...first, rounds: 1.5 },
    { ...first, toolCalls: 13 },
    { ...first, toolCalls: '1' },
    { ...first, initialRevision: -1 },
    { ...first, initialRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...first, errorCode: 'Error at /Users/private/SECRET' },
    { ...first, errorCode: 'X'.repeat(65) },
    { ...first, errorCode: undefined },
  ];
  for (const value of invalid)
    assert.throws(() => store.save(project.id, value as CodingRun), hasCode('INVALID_INPUT'));
  assert.deepEqual(readdirSync(directory), []);
});

test('the fiftieth record is retained and remains updateable without dropping earlier history', (t) => {
  const { project, store, file } = fixture(t);
  const history = Array.from({ length: 50 }, () => run());
  for (const item of history) store.save(project.id, item);
  const before = readFileSync(file);
  assert.throws(() => store.save(project.id, run()), hasCode('CODING_LIMIT'));
  assert.deepEqual(readFileSync(file), before);
  const final = { ...history[49], status: 'limited' as const, rounds: 4, toolCalls: 12 };
  store.save(project.id, final);
  assert.deepEqual(store.list(project.id), [...history.slice(0, 49), final]);
});

test('corrupt records, duplicates and cross-project copies fail closed without losing bytes', (t) => {
  const { root, projects, project, store, file } = fixture(t);
  store.save(project.id, run());
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  const invalid = [
    '{"partial":',
    'null',
    '[]',
    JSON.stringify({ ...baseline, projectId: randomUUID() }),
    JSON.stringify({ ...baseline, extra: true }),
    JSON.stringify({ ...baseline, runs: [] }),
    JSON.stringify({ ...baseline, runs: [baseline.runs[0], baseline.runs[0]] }),
    JSON.stringify({ ...baseline, runs: [{ ...baseline.runs[0], rounds: 5 }] }),
    JSON.stringify({ ...baseline, runs: [{ ...baseline.runs[0], prompt: 'retain privately' }] }),
  ];
  for (const bytes of invalid) {
    writeFileSync(file, bytes);
    assert.throws(() => store.list(project.id), hasCode('CORRUPT_CODING'));
    assert.throws(() => store.save(project.id, run()), hasCode('CORRUPT_CODING'));
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
  const second = projects.create({ name: '另一项目', idea: '验证命名空间' });
  const secondFile = join(root, 'projects', second.id, 'runs', 'coding.json');
  writeFileSync(secondFile, JSON.stringify(baseline));
  assert.throws(() => store.list(second.id), hasCode('CORRUPT_CODING'));
});

test('future versions and oversized journals remain untouched', (t) => {
  const { project, store, file } = fixture(t);
  store.save(project.id, run());
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...raw, schemaVersion: 2 }));
  const future = readFileSync(file);
  assert.throws(() => store.list(project.id), hasCode('UNSUPPORTED_CODING'));
  assert.throws(() => store.save(project.id, run()), hasCode('UNSUPPORTED_CODING'));
  assert.deepEqual(readFileSync(file), future);
  truncateSync(file, 512 * 1024 + 1);
  const large = readFileSync(file);
  assert.throws(() => store.list(project.id), hasCode('CODING_LIMIT'));
  assert.throws(() => store.save(project.id, run()), hasCode('CODING_LIMIT'));
  assert.deepEqual(readFileSync(file), large);
});

test('observed missing journals cannot be recreated until the original file is restored', (t) => {
  const { root, projects, project, store, file } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const reopened = new CodingStore(projects);
  reopened.list(project.id);
  const moved = join(root, 'moved-coding.json');
  renameSync(file, moved);
  for (const instance of [store, reopened]) {
    assert.throws(() => instance.list(project.id), hasCode('MISSING_CODING'));
    assert.throws(() => instance.save(project.id, run()), hasCode('MISSING_CODING'));
  }
  assert.equal(existsSync(file), false);
  renameSync(moved, file);
  assert.deepEqual(store.list(project.id), [first]);
});

test('symlink records and linked parent directories cannot redirect metadata I/O', (t) => {
  const { root, project, store, directory, file } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const outside = join(root, 'outside.json');
  renameSync(file, outside);
  const before = readFileSync(outside);
  symlinkSync(outside, file, 'file');
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(outside), before);
  rmSync(file);
  renameSync(outside, file);
  const moved = join(root, 'moved-runs');
  renameSync(directory, moved);
  symlinkSync(moved, directory, 'dir');
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(join(moved, 'coding.json')), before);
});

test('hardlinked records and directories at coding.json are rejected', (t) => {
  const { root, project, store, file } = fixture(t);
  store.save(project.id, run());
  const outside = join(root, 'linked.json');
  linkSync(file, outside);
  const before = readFileSync(outside);
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, run()), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(outside), before);
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, run()), hasCode('UNSAFE_PATH'));
});

test('a failure before rename retains the prior record and removes only the writer temporary file', (t) => {
  const { projects, project, store, file, directory } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const before = readFileSync(file);
  const get = projects.get.bind(projects);
  let calls = 0;
  projects.get = (id) => {
    calls += 1;
    if (calls === 3) throw new Error('SYNTHETIC_SECRET /private/host');
    return get(id);
  };
  assert.throws(
    () => store.save(project.id, { ...first, rounds: 1 }),
    (error: unknown) =>
      hasCode('CODING_IO')(error) && !(error as Error).message.includes('SYNTHETIC_SECRET'),
  );
  projects.get = get;
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(directory), ['coding.json']);
  store.save(project.id, { ...first, rounds: 1 });
  assert.equal(store.list(project.id)[0].rounds, 1);
});

test('project ids are validated and unrelated run artifacts are retained', (t) => {
  const { project, store, directory } = fixture(t);
  const other = join(directory, 'development-plans.json');
  writeFileSync(other, 'unrelated synthetic artifact');
  for (const id of ['../outside', '/etc/passwd', project.id.toUpperCase()]) {
    assert.throws(() => store.list(id), hasCode('INVALID_INPUT'));
    assert.throws(() => store.save(id, run()), hasCode('INVALID_INPUT'));
  }
  store.save(project.id, run());
  assert.equal(readFileSync(other, 'utf8'), 'unrelated synthetic artifact');
});
