import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import fs, {
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
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RepairRun } from '../src/shared/repair-contracts';
import { ProjectStore } from '../src/main/project-store';
import { RepairStore } from '../src/main/repair-store';
import { CompileFailure, compileSource } from '../src/main/source-compiler';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const diagnostic = () => ({
  path: 'src/app.tsx',
  line: 2,
  message: '源码语法无法编译，请检查此处。',
});
const run = (overrides: Partial<RepairRun> = {}): RepairRun => ({
  id: randomUUID(),
  requestHash: sourceHash('synthetic repair request'),
  planRunId: randomUUID(),
  planInputHash: sourceHash('synthetic plan input'),
  planArtifactHash: sourceHash('synthetic plan artifact'),
  createdAt: '2026-10-03T02:00:00.000Z',
  updatedAt: '2026-10-03T02:00:00.000Z',
  status: 'running',
  phase: 'checking',
  initialRevision: 2,
  latestRevision: 2,
  rounds: 0,
  toolCalls: 0,
  toolRequests: [],
  builds: 0,
  buildId: null,
  diagnostics: [],
  errorCode: null,
  ...overrides,
});

function fixture(t: TestContext) {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'factory-repair-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, '中文 修复 🌱');
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '有限修复记录', idea: '合成持久化测试，不调用模型' });
  const store = new RepairStore(projects);
  const directory = join(root, 'projects', project.id, 'runs');
  const file = join(directory, 'repairs.json');
  return { root, projects, project, store, directory, file };
}

test('empty reads do not write and bounded repair records reopen without changing project state', (t) => {
  const { root, project, store, directory, file } = fixture(t);
  const manifest = join(root, 'projects', project.id, 'project.json');
  const before = readFileSync(manifest);
  assert.deepEqual(store.list(project.id), []);
  assert.equal(existsSync(file), false);
  const first = run();
  store.save(project.id, first);
  assert.deepEqual(new RepairStore(new ProjectStore(root)).list(project.id), [first]);
  assert.deepEqual(readFileSync(manifest), before);
  assert.deepEqual(readdirSync(directory), ['repairs.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const copy = store.list(project.id);
  copy[0].status = 'succeeded';
  assert.deepEqual(store.list(project.id), [first]);
});

test('running updates advance phases, counters, source revisions and attempted build id in place', (t) => {
  const { project, store, file } = fixture(t);
  const first = run();
  const other = run();
  store.save(project.id, first);
  store.save(project.id, other);
  const checked = { ...first, builds: 1, buildId: randomUUID(), diagnostics: [diagnostic()] };
  store.save(project.id, checked);
  const repairing: RepairRun = {
    ...checked,
    phase: 'repairing',
    rounds: 1,
    toolCalls: 1,
    latestRevision: 3,
    toolRequests: [{ callHash: sourceHash('call1'), requestId: randomUUID() }],
    updatedAt: '2026-10-03T02:00:01.000Z',
  };
  store.save(project.id, repairing);
  const completed: RepairRun = {
    ...repairing,
    phase: 'checking',
    status: 'succeeded',
    builds: 2,
    buildId: randomUUID(),
    diagnostics: [],
    updatedAt: '2026-10-03T02:00:02.000Z',
  };
  store.save(project.id, completed);
  assert.deepEqual(store.list(project.id), [completed, other]);
  const before = readFileSync(file);
  const modified = statSync(file).mtimeMs;
  store.save(project.id, structuredClone(completed));
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).mtimeMs, modified);
});

test('request and plan bindings cannot change and counters, revisions and timestamps cannot rewind', (t) => {
  const { project, store, file } = fixture(t);
  const first = run({
    rounds: 2,
    toolCalls: 3,
    builds: 3,
    latestRevision: 4,
    updatedAt: '2026-10-03T02:00:02.000Z',
  });
  store.save(project.id, first);
  const before = readFileSync(file);
  for (const change of [
    { requestHash: sourceHash('other request') },
    { planRunId: randomUUID() },
    { planInputHash: sourceHash('other input') },
    { planArtifactHash: sourceHash('other plan') },
    { createdAt: '2026-10-03T02:00:01.000Z' },
    { initialRevision: 1 },
    { latestRevision: 3 },
    { rounds: 1 },
    { toolCalls: 2 },
    { builds: 2 },
    { updatedAt: '2026-10-03T02:00:01.000Z' },
  ]) {
    assert.throws(
      () => store.save(project.id, { ...first, ...change }),
      hasCode('REPAIR_CONFLICT'),
    );
    assert.deepEqual(readFileSync(file), before);
  }
});

test('every terminal state is immutable except exact retry, including diagnostic and same-status edits', (t) => {
  const { project, store, file } = fixture(t);
  const statuses: RepairRun['status'][] = [
    'succeeded',
    'limited',
    'no_progress',
    'cancelled',
    'failed',
    'interrupted',
  ];
  for (const status of statuses) {
    const first = run();
    store.save(project.id, first);
    const terminal: RepairRun = { ...first, status, diagnostics: [diagnostic()] };
    store.save(project.id, terminal);
    const before = readFileSync(file);
    store.save(project.id, terminal);
    for (const changed of [
      { ...terminal, status: 'running' as const },
      { ...terminal, updatedAt: '2026-10-03T02:00:01.000Z' },
      { ...terminal, rounds: 1 },
      { ...terminal, diagnostics: [] },
      { ...terminal, buildId: randomUUID() },
      { ...terminal, errorCode: 'REPAIR_FAILED' },
    ]) {
      assert.throws(() => store.save(project.id, changed), hasCode('REPAIR_CONFLICT'));
      assert.deepEqual(readFileSync(file), before);
    }
  }
});

test('tool mappings append durably and reject replacement, truncation and duplicate associations', (t) => {
  const { root, project, store, file } = fixture(t);
  const mapping = { callHash: sourceHash('provider-call-1'), requestId: randomUUID() };
  const first = run({ rounds: 1, toolCalls: 1, toolRequests: [mapping] });
  store.save(project.id, first);
  const secondMapping = { callHash: sourceHash('provider-call-2'), requestId: randomUUID() };
  const advanced = { ...first, toolCalls: 2, toolRequests: [mapping, secondMapping] };
  store.save(project.id, advanced);
  assert.deepEqual(new RepairStore(new ProjectStore(root)).list(project.id), [advanced]);
  assert.equal(readFileSync(file, 'utf8').includes('provider-call-'), false);
  const before = readFileSync(file);
  for (const mappings of [
    [],
    [mapping],
    [secondMapping, mapping],
    [{ ...mapping, requestId: randomUUID() }, secondMapping],
  ])
    assert.throws(
      () => store.save(project.id, { ...advanced, toolRequests: mappings }),
      hasCode('REPAIR_CONFLICT'),
    );
  for (const mappings of [
    [mapping, { ...secondMapping, callHash: mapping.callHash }],
    [mapping, { ...secondMapping, requestId: mapping.requestId }],
    [{ ...mapping, arguments: 'PRIVATE_PAYLOAD' }],
    [{ ...mapping, callHash: 'raw provider call id' }],
    [{ ...mapping, requestId: '../private' }],
    new Array(1),
  ])
    assert.throws(
      () => store.save(project.id, { ...advanced, toolRequests: mappings }),
      hasCode('INVALID_INPUT'),
    );
  assert.deepEqual(readFileSync(file), before);
});

test('strict schema rejects missing fields, malformed ids and hash/date/revision/counter errors before writing', (t) => {
  const { project, store, directory } = fixture(t);
  const first = run();
  const invalid: unknown[] = [
    null,
    [],
    'run',
    { ...first, modelText: 'SYNTHETIC_SECRET' },
    { ...first, apiKey: 'SYNTHETIC_KEY' },
    { ...first, message: 'raw error' },
    { ...first, id: '../private' },
    { ...first, planRunId: first.planRunId.toUpperCase() },
    { ...first, requestHash: 'bad' },
    { ...first, planInputHash: 'A'.repeat(64) },
    { ...first, planArtifactHash: 'bad' },
    { ...first, createdAt: 'today' },
    { ...first, updatedAt: '2026-10-03T02:00:00Z' },
    { ...first, updatedAt: '2026-10-03T01:59:59.000Z' },
    { ...first, initialRevision: -1 },
    { ...first, latestRevision: 1 },
    { ...first, latestRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...first, rounds: 5 },
    { ...first, rounds: 1.5 },
    { ...first, rounds: -1 },
    { ...first, toolCalls: 13 },
    { ...first, toolCalls: '1' },
    { ...first, builds: 6 },
    { ...first, builds: -1 },
    { ...first, toolRequests: null },
    { ...first, toolRequests: [{ callHash: sourceHash('call'), requestId: randomUUID() }] },
    { ...first, status: 'done' },
    { ...first, phase: 'executing' },
    { ...first, buildId: '/private/build' },
    { ...first, diagnostics: null },
    { ...first, diagnostics: new Array(1) },
    { ...first, diagnostics: Array(21).fill(diagnostic()) },
    { ...first, errorCode: 'Error: /private/SECRET' },
    { ...first, errorCode: 'X'.repeat(65) },
  ];
  for (const key of Object.keys(first)) {
    const incomplete = { ...first } as Record<string, unknown>;
    delete incomplete[key];
    invalid.push(incomplete);
  }
  for (const value of invalid)
    assert.throws(() => store.save(project.id, value as RepairRun), hasCode('INVALID_INPUT'));
  assert.deepEqual(readdirSync(directory), []);
});

test('diagnostics accept the pinned compiler messages but reject even short raw logs, controls and extra fields', (t) => {
  const { project, store, file } = fixture(t);
  const messages = [
    '源码快照无效，无法构建。',
    '缺少 src/app.tsx 入口文件，请提供默认导出的 App 组件。',
    '依赖不在允许范围内；请使用源码树中的相对路径或受支持的 React 模块。',
    '相对引用的源码文件不存在，请核对文件路径。',
    '不支持动态模块路径，请使用明确的字符串导入。',
    '当前模板只支持 ES 模块，请将 require 改为 import。',
    '当前模板不支持 CSS 资源 URL，请使用纯 CSS 样式。',
    '源码语法无法编译，请检查此处。',
    '模块导出不匹配，请检查默认导出和引用的名称。',
    'CSS 内容存在编译问题，请检查此处。',
    '编译器报告了警告，请检查此处。',
    '编译工具未能完成，请保留源码后重试。',
    '编译产物超过大小限制，本次产物未交付。',
    '构建已取消，本次产物未交付。',
  ];
  const first = run({
    diagnostics: messages.map((message) => ({ path: null, line: null, message })),
  });
  store.save(project.id, first);
  const before = readFileSync(file);
  const invalid = [
    null,
    {},
    { ...diagnostic(), message: 'SYNTHETIC_KEY=abc' },
    { ...diagnostic(), message: '/private/host' },
    { ...diagnostic(), message: 'provider rejected' },
    { ...diagnostic(), message: 'x'.repeat(301) },
    { ...diagnostic(), message: diagnostic().message + '\n' },
    { ...diagnostic(), message: '\u0000' },
    { ...diagnostic(), message: '\u0085' },
    { ...diagnostic(), message: '\ud800' },
    { ...diagnostic(), line: 0 },
    { ...diagnostic(), line: 1.5 },
    { ...diagnostic(), line: Number.MAX_SAFE_INTEGER + 1 },
    { ...diagnostic(), detail: 'raw compiler error' },
  ];
  for (const value of invalid)
    assert.throws(
      () => store.save(project.id, { ...first, diagnostics: [value] } as RepairRun),
      hasCode('INVALID_INPUT'),
    );
  for (const path of ['/private/host.ts', '../outside.ts', 'src/../private.ts', 'package.json'])
    assert.throws(
      () => store.save(project.id, { ...first, diagnostics: [{ ...diagnostic(), path }] }),
      hasCode('SOURCE_PATH_DENIED'),
    );
  assert.deepEqual(readFileSync(file), before);
});

test('a real compiler failure can be saved without retaining source text or a native error payload', async (t) => {
  const { project, store, file } = fixture(t);
  const content = 'export default function App( { /* SYNTHETIC_PRIVATE_SOURCE */';
  let failure: CompileFailure | undefined;
  try {
    await compileSource({
      revision: 2,
      files: [{ path: 'src/app.tsx', content, sha256: sourceHash(content) }],
    });
  } catch (error) {
    assert.ok(error instanceof CompileFailure);
    failure = error;
  }
  assert.ok(failure?.diagnostics.length);
  const record = run({ builds: 1, buildId: randomUUID(), diagnostics: failure!.diagnostics });
  store.save(project.id, record);
  assert.deepEqual(store.list(project.id), [record]);
  assert.equal(readFileSync(file, 'utf8').includes('SYNTHETIC_PRIVATE_SOURCE'), false);
});

test('limits of four rounds, twelve tools and five builds are retained with bounded diagnostics', (t) => {
  const { project, store } = fixture(t);
  const toolRequests = Array.from({ length: 12 }, (_, index) => ({
    callHash: sourceHash(`call-${index}`),
    requestId: randomUUID(),
  }));
  const first = run({
    rounds: 4,
    toolCalls: 12,
    builds: 5,
    buildId: randomUUID(),
    toolRequests,
    diagnostics: Array.from({ length: 20 }, diagnostic),
  });
  store.save(project.id, first);
  const terminal: RepairRun = { ...first, status: 'limited', errorCode: 'REPAIR_LIMIT' };
  store.save(project.id, terminal);
  assert.deepEqual(store.list(project.id), [terminal]);
});

test('the fiftieth run remains finalizable without evicting history and a fifty-first is refused', (t) => {
  const { project, store, file } = fixture(t);
  const history = Array.from({ length: 50 }, () => run());
  for (const record of history) store.save(project.id, record);
  const before = readFileSync(file);
  assert.throws(() => store.save(project.id, run()), hasCode('REPAIR_LIMIT'));
  assert.deepEqual(readFileSync(file), before);
  const terminal: RepairRun = { ...history[49], status: 'cancelled' };
  store.save(project.id, terminal);
  assert.deepEqual(store.list(project.id), [...history.slice(0, 49), terminal]);
});

test('archive permits only finalization of an existing run and exact terminal replay', (t) => {
  const { projects, project, store, file } = fixture(t);
  const first = run();
  store.save(project.id, first);
  projects.archive(project.id, true);
  const before = readFileSync(file);
  assert.deepEqual(store.list(project.id), [first]);
  assert.throws(() => store.save(project.id, run()), hasCode('ARCHIVED'));
  assert.throws(() => store.save(project.id, run({ status: 'failed' })), hasCode('ARCHIVED'));
  assert.throws(() => store.save(project.id, first), hasCode('ARCHIVED'));
  assert.throws(() => store.save(project.id, { ...first, rounds: 1 }), hasCode('ARCHIVED'));
  assert.deepEqual(readFileSync(file), before);
  const terminal: RepairRun = { ...first, status: 'cancelled', errorCode: 'ARCHIVED' };
  store.save(project.id, terminal);
  const finalized = readFileSync(file);
  store.save(project.id, terminal);
  assert.deepEqual(readFileSync(file), finalized);
  assert.deepEqual(store.list(project.id), [terminal]);
});

test('corrupt records, duplicate ids, unknown fields and cross-project copies fail closed', (t) => {
  const { root, projects, project, store, file } = fixture(t);
  store.save(project.id, run());
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  const first = baseline.runs[0];
  const invalid = [
    '{"partial":',
    'null',
    '[]',
    JSON.stringify({ ...baseline, projectId: randomUUID() }),
    JSON.stringify({ ...baseline, extra: true }),
    JSON.stringify({ ...baseline, runs: [] }),
    JSON.stringify({ ...baseline, runs: [first, first] }),
    JSON.stringify({ ...baseline, runs: Array(51).fill(first) }),
    JSON.stringify({ ...baseline, runs: [{ ...first, rounds: 5 }] }),
    JSON.stringify({ ...baseline, runs: [{ ...first, latestRevision: 0 }] }),
    JSON.stringify({
      ...baseline,
      runs: [{ ...first, diagnostics: [{ ...diagnostic(), message: 'SECRET' }] }],
    }),
    JSON.stringify({ ...baseline, runs: [{ ...first, prompt: 'raw prompt' }] }),
  ];
  for (const bytes of invalid) {
    writeFileSync(file, bytes);
    assert.throws(() => store.list(project.id), hasCode('CORRUPT_REPAIR'));
    assert.throws(() => store.save(project.id, run()), hasCode('CORRUPT_REPAIR'));
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
  const other = projects.create({ name: '另一个项目', idea: '修复记录命名空间' });
  const copied = join(root, 'projects', other.id, 'runs', 'repairs.json');
  writeFileSync(copied, JSON.stringify(baseline));
  assert.throws(() => store.list(other.id), hasCode('CORRUPT_REPAIR'));
});

test('future schema and records beyond one MiB remain untouched', (t) => {
  const { project, store, file } = fixture(t);
  store.save(project.id, run());
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...baseline, schemaVersion: 3 }));
  const before = readFileSync(file);
  assert.throws(() => store.list(project.id), hasCode('UNSUPPORTED_REPAIR'));
  assert.throws(() => store.save(project.id, run()), hasCode('UNSUPPORTED_REPAIR'));
  assert.deepEqual(readFileSync(file), before);
  truncateSync(file, 1024 * 1024 + 1);
  assert.throws(() => store.list(project.id), hasCode('REPAIR_LIMIT'));
  assert.throws(() => store.save(project.id, run()), hasCode('REPAIR_LIMIT'));
  assert.equal(statSync(file).size, 1024 * 1024 + 1);
});

test('observed missing records cannot be recreated until the original is restored', (t) => {
  const { root, projects, project, store, file } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const reopened = new RepairStore(projects);
  reopened.list(project.id);
  const moved = join(root, 'moved-repairs.json');
  renameSync(file, moved);
  for (const instance of [store, reopened]) {
    assert.throws(() => instance.list(project.id), hasCode('MISSING_REPAIR'));
    assert.throws(() => instance.save(project.id, first), hasCode('MISSING_REPAIR'));
  }
  assert.equal(existsSync(file), false);
  renameSync(moved, file);
  assert.deepEqual(store.list(project.id), [first]);
});

test('symlinked records and parent directories cannot redirect repair metadata', (t) => {
  const { root, project, store, file, directory } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const moved = join(root, 'moved-repairs.json');
  renameSync(file, moved);
  const before = readFileSync(moved);
  symlinkSync(moved, file, 'file');
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(moved), before);
  rmSync(file);
  renameSync(moved, file);
  const movedDirectory = join(root, 'moved-runs');
  renameSync(directory, movedDirectory);
  symlinkSync(movedDirectory, directory, 'dir');
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(join(movedDirectory, 'repairs.json')), before);
});

test('hardlinked records and non-file entries are rejected without affecting the linked bytes', (t) => {
  const { root, project, store, file } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const linked = join(root, 'linked-repairs.json');
  linkSync(file, linked);
  const before = readFileSync(linked);
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(linked), before);
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
});

test('failure before rename preserves the previous run and unrelated artifacts and removes its own temporary', (t) => {
  const { projects, project, store, file, directory } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const before = readFileSync(file);
  const other = join(directory, 'builds.json');
  writeFileSync(other, 'unrelated artifact');
  const get = projects.get.bind(projects);
  projects.get = (id) => {
    if (readdirSync(directory).some((name) => name.startsWith('.repair-')))
      throw new Error('SYNTHETIC_SECRET /private/host');
    return get(id);
  };
  assert.throws(
    () => store.save(project.id, { ...first, rounds: 1 }),
    (error: unknown) =>
      hasCode('REPAIR_IO')(error) && !(error as Error).message.includes('SYNTHETIC_SECRET'),
  );
  projects.get = get;
  assert.deepEqual(readFileSync(file), before);
  assert.equal(readFileSync(other, 'utf8'), 'unrelated artifact');
  assert.deepEqual(readdirSync(directory).sort(), ['builds.json', 'repairs.json']);
  store.save(project.id, { ...first, rounds: 1 });
  assert.equal(store.list(project.id)[0].rounds, 1);
});

test('another writer update during preparation is retained instead of overwritten', (t) => {
  const { projects, project, store, file, directory } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const concurrent = { ...first, rounds: 2 };
  const get = projects.get.bind(projects);
  let injected = false;
  projects.get = (id) => {
    if (!injected && readdirSync(directory).some((name) => name.startsWith('.repair-'))) {
      injected = true;
      writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, projectId: project.id, runs: [concurrent] }) + '\n',
      );
    }
    return get(id);
  };
  assert.throws(() => store.save(project.id, { ...first, rounds: 1 }), hasCode('REPAIR_CONFLICT'));
  projects.get = get;
  assert.deepEqual(store.list(project.id), [concurrent]);
  assert.deepEqual(readdirSync(directory), ['repairs.json']);
});

test('a post-rename directory flush failure is uncertain and exact retry confirms the already saved run', (t) => {
  if (process.platform === 'win32') return t.skip('directory fsync is not used on Windows');
  const { project, store, file, directory } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const updated = { ...first, rounds: 1 };
  const original = fs.fsyncSync;
  const fault = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('SYNTHETIC_PRIVATE_FLUSH_ERROR');
    original(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => store.save(project.id, updated),
      (error: unknown) =>
        hasCode('REPAIR_COMMIT_UNCERTAIN')(error) &&
        !(error as Error).message.includes('SYNTHETIC_PRIVATE'),
    );
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(store.list(project.id), [updated]);
  const before = readFileSync(file);
  store.save(project.id, updated);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(directory), ['repairs.json']);
});

test('exclusive temporary creation failure never cleans a pre-existing temporary file', (t) => {
  const { project, store, file, directory } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const before = readFileSync(file);
  const fixedId = randomUUID();
  const existing = join(directory, `.repair-${fixedId}.tmp`);
  writeFileSync(existing, 'older interrupted writer');
  const collision = t.mock.method(crypto, 'randomUUID', () => fixedId);
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.save(project.id, { ...first, rounds: 1 }), hasCode('REPAIR_IO'));
  } finally {
    collision.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(existing, 'utf8'), 'older interrupted writer');
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.list(project.id), [first]);
});

test('archiving during a prepared running update prevents commit and retains the original record', (t) => {
  const { projects, project, store, file, directory } = fixture(t);
  const first = run();
  store.save(project.id, first);
  const before = readFileSync(file);
  const get = projects.get.bind(projects);
  projects.get = (id) => {
    const current = get(id);
    if (readdirSync(directory).some((name) => name.startsWith('.repair-')))
      return { ...current, archived: true };
    return current;
  };
  assert.throws(() => store.save(project.id, { ...first, rounds: 1 }), hasCode('ARCHIVED'));
  projects.get = get;
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(directory), ['repairs.json']);
});

test('invalid project identifiers never select another journal and unrelated run files remain untouched', (t) => {
  const { project, store, directory } = fixture(t);
  const other = join(directory, 'coding.json');
  writeFileSync(other, 'unrelated coding metadata');
  for (const id of ['../outside', '/etc/passwd', project.id.toUpperCase()]) {
    assert.throws(() => store.list(id), hasCode('INVALID_INPUT'));
    assert.throws(() => store.save(id, run()), hasCode('INVALID_INPUT'));
  }
  store.save(project.id, run());
  assert.equal(readFileSync(other, 'utf8'), 'unrelated coding metadata');
});
