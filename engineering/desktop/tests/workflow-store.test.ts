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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ProjectStore } from '../src/main/project-store';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';
import {
  WORKFLOW_LIMITS,
  WorkflowStore,
  parseWorkflowRequest,
  parseWorkflowRun,
} from '../src/main/workflow-store';
import type { WorkflowRun, WorkflowStage } from '../src/shared/workflow-contracts';

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const time = (seconds: number) => new Date(Date.UTC(2026, 9, 5, 0, 0, seconds)).toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function initial(
  projectId: string = randomUUID(),
  mode: 'generate' | 'check' = 'generate',
): WorkflowRun {
  const id = randomUUID(),
    planRunId = randomUUID();
  return {
    id,
    request: { schemaVersion: 1, requestId: id, projectId, planRunId, sourceRevision: 0, mode },
    binding: { planRunId, planInputHash: 'a'.repeat(64), planArtifactHash: 'b'.repeat(64) },
    initialSourceHash: 'c'.repeat(64),
    createdAt: time(0),
    updatedAt: time(0),
    status: 'running',
    stages: [],
    latestRevision: 0,
    latestSourceHash: 'c'.repeat(64),
    buildId: null,
    runtimeReportId: null,
    errorCode: null,
  };
}
function modification(
  projectId: string,
  instruction = '将列表改为卡片布局，保留已有数据',
): WorkflowRun {
  const run = initial(projectId);
  return { ...run, request: { ...run.request, schemaVersion: 2, mode: 'modify', instruction } };
}
function begin(run: WorkflowRun, kind: WorkflowStage['kind'], seconds: number): WorkflowRun {
  return {
    ...clone(run),
    updatedAt: time(seconds),
    stages: [
      ...clone(run.stages),
      {
        kind,
        requestId: randomUUID(),
        status: 'running',
        createdAt: time(seconds),
        updatedAt: time(seconds),
        sourceRevision: run.latestRevision,
        sourceHash: run.latestSourceHash,
        buildId: null,
        runtimeReportId: null,
        errorCode: null,
      },
    ],
  };
}
function finish(
  run: WorkflowRun,
  seconds: number,
  updates: Partial<WorkflowStage> = {},
): WorkflowRun {
  const next = clone(run),
    stage = next.stages.at(-1)!;
  Object.assign(stage, { status: 'succeeded', updatedAt: time(seconds) }, updates);
  next.updatedAt = time(seconds);
  next.latestRevision = stage.sourceRevision;
  next.latestSourceHash = stage.sourceHash;
  next.buildId = stage.buildId;
  next.runtimeReportId = stage.runtimeReportId;
  return next;
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const id = projects.create({ name: '通用自动开发流程', idea: '仅合成项目及元数据' }).id;
  const store = new WorkflowStore(projects),
    file = join(root, 'projects', id, 'runs', 'workflows.json');
  const reopen = () => new WorkflowStore(new ProjectStore(root));
  const marker = join(dirname(file), 'workflows.initialized.json');
  return { root, projects, id, store, file, marker, reopen, input: initial(id) };
}
function beforeModificationRepair(f: ReturnType<typeof fixture>) {
  let run = modification(f.id);
  f.store.save(f.id, run);
  run = begin(run, 'generation', 1);
  f.store.save(f.id, run);
  run = finish(run, 2, { sourceRevision: 1, sourceHash: 'e'.repeat(64) });
  f.store.save(f.id, run);
  run = begin(run, 'build', 3);
  f.store.save(f.id, run);
  run = finish(run, 4, { status: 'failed', errorCode: 'BUILD_FAILED' });
  f.store.save(f.id, run);
  const next = begin(run, 'repair', 5);
  next.stages.at(-1)!.repairRequestVersion = 2;
  return { run, next };
}
const disk = (projectId: string, storeId: string, runs: WorkflowRun[]) =>
  JSON.stringify({ schemaVersion: 1, projectId, storeId, runs }) + '\n';

test('modification repair protocol marker is strict and cannot be attached to other stages or modes', (t) => {
  const f = fixture(t),
    { next } = beforeModificationRepair(f);
  assert.deepEqual(parseWorkflowRun(next), next);
  for (const value of [null, 1, 3, '2', undefined]) {
    const invalid = clone(next);
    Object.assign(invalid.stages.at(-1)!, { repairRequestVersion: value });
    assert.throws(() => parseWorkflowRun(invalid), code('INVALID_INPUT'));
  }
  const generation = begin(modification(f.id), 'generation', 1);
  generation.stages[0]!.repairRequestVersion = 2;
  assert.throws(() => parseWorkflowRun(generation), code('INVALID_INPUT'));
  const legacy = clone(next);
  legacy.request = {
    ...initial().request,
    requestId: legacy.id,
    projectId: f.id,
    planRunId: legacy.binding.planRunId,
  };
  assert.throws(() => parseWorkflowRun(legacy), code('INVALID_INPUT'));
});

test('the first intent-bound repair upgrades schema2 to schema3 and preserves legacy records and identity', (t) => {
  const f = fixture(t),
    { next } = beforeModificationRepair(f);
  const before = JSON.parse(readFileSync(f.file, 'utf8')),
    marker = readFileSync(f.marker);
  assert.equal(before.schemaVersion, 2);
  f.store.save(f.id, next);
  const upgraded = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(upgraded.schemaVersion, 3);
  assert.equal(upgraded.storeId, before.storeId);
  assert.deepEqual(upgraded.runs[0].request, before.runs[0].request);
  assert.deepEqual(upgraded.runs[0].stages.slice(0, -1), before.runs[0].stages);
  assert.deepEqual(readFileSync(f.marker), marker);
  assert.deepEqual(f.reopen().list(f.id), [next]);
  const bytes = readFileSync(f.file);
  f.reopen().save(f.id, next);
  assert.deepEqual(readFileSync(f.file), bytes);
  f.reopen().save(f.id, initial(f.id, 'check'));
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).schemaVersion, 3);
});

test('old schema2 modification repairs remain readable without adding a new protocol marker', (t) => {
  const f = fixture(t),
    { next } = beforeModificationRepair(f);
  delete next.stages.at(-1)!.repairRequestVersion;
  f.store.save(f.id, next);
  const complete = finish(next, 6);
  f.store.save(f.id, complete);
  const bytes = readFileSync(f.file);
  assert.equal(JSON.parse(bytes.toString()).schemaVersion, 2);
  assert.deepEqual(f.reopen().list(f.id), [complete]);
  f.reopen().save(f.id, complete);
  assert.deepEqual(readFileSync(f.file), bytes);
});

test('a durable repair intent cannot drop or retrofit the request protocol marker', (t) => {
  for (const marked of [true, false]) {
    const f = fixture(t),
      { next } = beforeModificationRepair(f);
    if (!marked) delete next.stages.at(-1)!.repairRequestVersion;
    f.store.save(f.id, next);
    const completed = finish(next, 6),
      bytes = readFileSync(f.file);
    if (marked) delete completed.stages.at(-1)!.repairRequestVersion;
    else completed.stages.at(-1)!.repairRequestVersion = 2;
    assert.throws(() => f.store.save(f.id, completed), code('WORKFLOW_CONFLICT'));
    assert.deepEqual(readFileSync(f.file), bytes);
  }
});

test('old envelopes cannot hide a new repair intent and future envelopes fail without rewrites', (t) => {
  const f = fixture(t),
    { next } = beforeModificationRepair(f);
  f.store.save(f.id, next);
  const original = JSON.parse(readFileSync(f.file, 'utf8'));
  for (const [schemaVersion, error] of [
    [1, 'CORRUPT_WORKFLOW'],
    [2, 'CORRUPT_WORKFLOW'],
    [4, 'UNSUPPORTED_WORKFLOW'],
  ] as const) {
    const bytes = JSON.stringify({ ...original, schemaVersion });
    writeFileSync(f.file, bytes);
    assert.throws(() => f.reopen().list(f.id), code(error));
    assert.throws(() => f.reopen().save(f.id, initial(f.id)), code(error));
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
  }
});

for (const boundary of ['beforeRename', 'afterRename'] as const) {
  test(`real SIGKILL at ${boundary} preserves either schema2 or the full schema3 repair intent`, (t) => {
    const f = fixture(t),
      { run, next } = beforeModificationRepair(f);
    const marker = readFileSync(f.marker);
    const imports = `import {ProjectStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/project-store.ts')).href)}; import {WorkflowStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/workflow-store.ts')).href)}; const projects=new ProjectStore(${JSON.stringify(f.root)}); const run=${JSON.stringify(next)};`;
    const killed = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} new WorkflowStore(projects,{${boundary}(){process.kill(process.pid,'SIGKILL');}}).save(run.request.projectId,run);`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(
      JSON.parse(readFileSync(f.file, 'utf8')).schemaVersion,
      boundary === 'beforeRename' ? 2 : 3,
    );
    assert.deepEqual(f.reopen().list(f.id), [boundary === 'beforeRename' ? run : next]);
    f.reopen().save(f.id, next);
    f.reopen().save(f.id, next);
    assert.deepEqual(f.reopen().list(f.id), [next]);
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).schemaVersion, 3);
    assert.deepEqual(readFileSync(f.marker), marker);
  });
}

test('request parser is strict, returns a copy and rejects noncanonical identifiers and counters', () => {
  const request = initial().request;
  assert.deepEqual(parseWorkflowRequest(request), request);
  assert.notEqual(parseWorkflowRequest(request), request);
  const { mode: _mode, ...missing } = request;
  for (const value of [
    missing,
    { ...request, extra: true },
    { ...request, schemaVersion: 2 },
    { ...request, requestId: request.requestId.toUpperCase() },
    { ...request, planRunId: '../private' },
    { ...request, projectId: 'private' },
    { ...request, mode: 'repair' },
    { ...request, sourceRevision: -1 },
    { ...request, sourceRevision: 0.5 },
    { ...request, sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...request, sourceRevision: NaN },
    { ...request, [Symbol('private')]: true },
    Object.assign(Object.create({ private: true }), request),
  ])
    assert.throws(() => parseWorkflowRequest(value), code('INVALID_INPUT'));
  let accesses = 0;
  const accessor = { ...request };
  Object.defineProperty(accessor, 'mode', {
    enumerable: true,
    get() {
      accesses++;
      return 'generate';
    },
  });
  assert.throws(() => parseWorkflowRequest(accessor), code('INVALID_INPUT'));
  assert.equal(accesses, 0);
});

test('run parser enforces all fields, plain dense arrays, fixed errors and consistent bindings', () => {
  const run = initial();
  const hidden = { ...run };
  Object.defineProperty(hidden, 'status', { value: 'running', enumerable: false });
  const sparse = new Array<unknown>(1),
    decorated: unknown[] = [];
  Object.defineProperty(decorated, 'private', { value: true });
  const { errorCode: _error, ...missing } = run;
  for (const value of [
    missing,
    hidden,
    { ...run, extra: 'private' },
    { ...run, id: randomUUID() },
    { ...run, binding: { ...run.binding, planRunId: randomUUID() } },
    { ...run, binding: { ...run.binding, planInputHash: 'D'.repeat(64) } },
    { ...run, binding: { ...run.binding, extra: true } },
    { ...run, status: 'succeeded' },
    { ...run, buildId: '' },
    { ...run, runtimeReportId: 'private' },
    { ...run, stages: sparse },
    { ...run, stages: decorated },
    { ...run, errorCode: 'private raw message' },
    { ...run, errorCode: 'A'.repeat(65) },
  ])
    assert.throws(() => parseWorkflowRun(value), code('INVALID_INPUT'));
  assert.equal(
    parseWorkflowRun({ ...run, errorCode: 'WORKFLOW_INTERRUPTED' }).errorCode,
    'WORKFLOW_INTERRUPTED',
  );
  const copy = parseWorkflowRun(begin(run, 'generation', 1));
  copy.binding.planInputHash = 'e'.repeat(64);
  assert.equal(run.binding.planInputHash, 'a'.repeat(64));
});

test('only bounded generation or check stage prefixes and unique request IDs are accepted', () => {
  for (const [mode, sequence] of [
    ['generate', ['generation', 'build', 'startup', 'repair']],
    ['generate', ['generation', 'build', 'repair', 'startup']],
    ['check', ['build', 'startup', 'repair']],
    ['check', ['build', 'repair', 'startup']],
  ] as const) {
    let run = initial(randomUUID(), mode),
      tick = 1;
    for (const kind of sequence) {
      run = begin(run, kind, tick++);
      assert.deepEqual(parseWorkflowRun(run), run);
      run = finish(run, tick++);
    }
    assert.deepEqual(parseWorkflowRun({ ...run, status: 'ready' }), { ...run, status: 'ready' });
    const duplicate = clone(run);
    duplicate.stages.at(-1)!.requestId = duplicate.stages[0]!.requestId;
    assert.throws(() => parseWorkflowRun(duplicate), code('INVALID_INPUT'));
    assert.throws(() => parseWorkflowRun(begin(run, 'generation', tick++)), code('INVALID_INPUT'));
  }
  const run = begin(initial(), 'generation', 1);
  for (const bad of [
    { ...run, stages: [{ ...run.stages[0]!, requestId: run.id }] },
    { ...run, stages: [{ ...run.stages[0]!, kind: 'startup' }] },
    { ...run, stages: [{ ...run.stages[0]!, status: 'ready' }] },
    { ...run, status: 'stopped' },
  ])
    assert.throws(() => parseWorkflowRun(bad), code('INVALID_INPUT'));
});

test('timestamps and source checkpoints cannot move backwards or disagree at the same revision', () => {
  const run = begin(initial(), 'generation', 1);
  const mutate = (change: (copy: WorkflowRun) => void) => {
    const copy = clone(run);
    change(copy);
    return copy;
  };
  for (const bad of [
    { ...run, createdAt: '2026-10-05' },
    { ...run, updatedAt: time(-1) },
    { ...run, initialSourceHash: 'private' },
    { ...run, latestSourceHash: 'd'.repeat(64) },
    { ...run, latestRevision: -1 },
    mutate((copy) => {
      copy.stages[0]!.updatedAt = time(2);
    }),
    mutate((copy) => {
      copy.stages[0]!.createdAt = time(-1);
    }),
    mutate((copy) => {
      copy.stages[0]!.sourceHash = 'd'.repeat(64);
    }),
    mutate((copy) => {
      copy.stages[0]!.sourceRevision = 1;
    }),
  ])
    assert.throws(() => parseWorkflowRun(bad), code('INVALID_INPUT'));
  const completed = finish(run, 2, { sourceRevision: 1, sourceHash: 'e'.repeat(64) });
  assert.deepEqual(parseWorkflowRun(completed), completed);
  const next = begin(completed, 'build', 3);
  next.stages.at(-1)!.createdAt = time(1);
  assert.throws(() => parseWorkflowRun(next), code('INVALID_INPUT'));
});

test('listing does not initialize a journal and new runs must start with a clean running intent', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.list(f.id), []);
  assert.equal(existsSync(f.file), false);
  assert.equal(existsSync(f.marker), false);
  for (const run of [
    { ...f.input, status: 'stopped' as const },
    begin(f.input, 'generation', 1),
    { ...f.input, latestRevision: 1 },
    { ...f.input, buildId: randomUUID() },
    { ...f.input, runtimeReportId: randomUUID() },
    { ...f.input, errorCode: 'WORKFLOW_FAILED' },
  ])
    assert.throws(() => f.store.save(f.id, run), code('WORKFLOW_CONFLICT'));
  const foreign = initial(randomUUID());
  assert.throws(() => f.store.save(f.id, foreign), code('INVALID_INPUT'));
  assert.equal(existsSync(f.file), false);
  f.store.save(f.id, f.input);
  assert.deepEqual(f.reopen().list(f.id), [f.input]);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(statSync(f.marker).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(f.file, 'utf8')).storeId,
    JSON.parse(readFileSync(f.marker, 'utf8')).storeId,
  );
});

test('generation, build and startup outcomes persist independently with exact replay after restart', (t) => {
  const f = fixture(t),
    buildId = randomUUID(),
    runtimeReportId = randomUUID();
  let run = f.input;
  f.store.save(f.id, run);
  run = begin(run, 'generation', 1);
  f.store.save(f.id, run);
  run = finish(run, 2, { sourceRevision: 1, sourceHash: 'd'.repeat(64) });
  f.store.save(f.id, run);
  run = begin(run, 'build', 3);
  f.store.save(f.id, run);
  run = finish(run, 4, { buildId });
  f.store.save(f.id, run);
  run = begin(run, 'startup', 5);
  f.store.save(f.id, run);
  run = finish(run, 6, { buildId, runtimeReportId });
  f.store.save(f.id, run);
  run = { ...run, status: 'ready', updatedAt: time(7) };
  f.store.save(f.id, run);
  const bytes = readFileSync(f.file),
    before = statSync(f.file);
  f.reopen().save(f.id, clone(run));
  assert.deepEqual(f.reopen().list(f.id), [run]);
  assert.deepEqual(readFileSync(f.file), bytes);
  assert.equal(statSync(f.file).ino, before.ino);
  assert.equal(statSync(f.file).mtimeMs, before.mtimeMs);
  run.stages[0]!.errorCode = 'NOT_PERSISTED';
  assert.equal(f.store.list(f.id)[0]!.stages[0]!.errorCode, null);
});

test('check mode can repair once after a failed build and then record startup', (t) => {
  const f = fixture(t);
  let run = initial(f.id, 'check');
  f.store.save(f.id, run);
  run = begin(run, 'build', 1);
  f.store.save(f.id, run);
  run = finish(run, 2, { status: 'failed', errorCode: 'BUILD_FAILED' });
  f.store.save(f.id, run);
  run = begin(run, 'repair', 3);
  f.store.save(f.id, run);
  run = finish(run, 4, { sourceRevision: 2, sourceHash: 'f'.repeat(64), buildId: randomUUID() });
  f.store.save(f.id, run);
  run = begin(run, 'startup', 5);
  f.store.save(f.id, run);
  run = finish(run, 6, { runtimeReportId: randomUUID(), buildId: run.buildId });
  f.store.save(f.id, run);
  run = { ...run, status: 'ready' };
  f.store.save(f.id, run);
  assert.deepEqual(f.reopen().list(f.id), [run]);
});

test('request, binding, creation, initial checkpoint and terminal parent are immutable', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const mutate = (change: (copy: WorkflowRun) => void) => {
    const copy = clone(f.input);
    change(copy);
    return copy;
  };
  for (const changed of [
    mutate((copy) => {
      copy.request.mode = 'check';
    }),
    mutate((copy) => {
      copy.binding.planArtifactHash = 'd'.repeat(64);
    }),
    mutate((copy) => {
      copy.createdAt = time(-1);
    }),
    mutate((copy) => {
      copy.initialSourceHash = copy.latestSourceHash = 'e'.repeat(64);
    }),
  ])
    assert.throws(() => f.store.save(f.id, changed), code('WORKFLOW_CONFLICT'));
  const stopped: WorkflowRun = {
    ...f.input,
    updatedAt: time(1),
    status: 'cancelled',
    errorCode: 'CANCELLED',
  };
  f.store.save(f.id, stopped);
  const bytes = readFileSync(f.file);
  for (const changed of [
    { ...stopped, status: 'running' as const },
    { ...stopped, updatedAt: time(2) },
    { ...stopped, errorCode: null },
    { ...stopped, buildId: randomUUID() },
  ])
    assert.throws(() => f.store.save(f.id, changed), code('WORKFLOW_CONFLICT'));
  f.store.save(f.id, stopped);
  assert.deepEqual(readFileSync(f.file), bytes);
});

test('stages only append a running intent or finish the last stage; terminal stage fields never change', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const running = begin(f.input, 'generation', 1);
  f.store.save(f.id, running);
  const progress = clone(running);
  progress.updatedAt = progress.stages[0]!.updatedAt = time(2);
  assert.throws(() => f.store.save(f.id, progress), code('WORKFLOW_CONFLICT'));
  const completed = finish(running, 2);
  assert.throws(() => f.store.save(f.id, begin(completed, 'build', 3)), code('WORKFLOW_CONFLICT'));
  const changedId = clone(completed);
  changedId.stages[0]!.requestId = randomUUID();
  assert.throws(() => f.store.save(f.id, changedId), code('WORKFLOW_CONFLICT'));
  f.store.save(f.id, completed);
  const changedTerminal = clone(completed);
  changedTerminal.stages[0]!.errorCode = 'CHANGED';
  assert.throws(() => f.store.save(f.id, changedTerminal), code('WORKFLOW_CONFLICT'));
  assert.throws(() => f.store.save(f.id, { ...completed, stages: [] }), code('WORKFLOW_CONFLICT'));
  const terminalAppend = finish(begin(completed, 'build', 3), 4);
  assert.throws(() => f.store.save(f.id, terminalAppend), code('WORKFLOW_CONFLICT'));
  const backwards = { ...completed, updatedAt: time(1) };
  assert.throws(() => f.store.save(f.id, backwards), code('INVALID_INPUT'));
  assert.deepEqual(f.reopen().list(f.id), [completed]);
});

test('interruption closes the current intent while retaining the last recorded source checkpoint', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const running = begin(f.input, 'generation', 1);
  f.store.save(f.id, running);
  const interrupted = finish(running, 2, {
    status: 'interrupted',
    errorCode: 'WORKFLOW_INTERRUPTED',
  });
  interrupted.status = 'interrupted';
  interrupted.errorCode = 'WORKFLOW_INTERRUPTED';
  f.reopen().save(f.id, interrupted);
  assert.deepEqual(f.store.list(f.id), [interrupted]);
  assert.equal(interrupted.latestRevision, f.input.latestRevision);
  assert.equal(interrupted.latestSourceHash, f.input.latestSourceHash);
  assert.throws(() => f.store.save(f.id, running), code('WORKFLOW_CONFLICT'));
});

test('request IDs stay unique across parent and child records in the same project journal', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const stageRun = begin(f.input, 'generation', 1);
  f.store.save(f.id, stageRun);
  const second = initial(f.id);
  second.id = second.request.requestId = stageRun.stages[0]!.requestId;
  assert.throws(() => f.store.save(f.id, second), code('WORKFLOW_CONFLICT'));
  const third = initial(f.id);
  f.store.save(f.id, third);
  const collision = begin(third, 'generation', 1);
  collision.stages[0]!.requestId = f.input.id;
  assert.throws(() => f.store.save(f.id, collision), code('WORKFLOW_CONFLICT'));
  assert.equal(f.store.list(f.id).length, 2);
});

test('fifty runs and the fixed byte limit preserve existing records without eviction', (t) => {
  const f = fixture(t);
  for (let index = 0; index < WORKFLOW_LIMITS.runs; index++) f.store.save(f.id, initial(f.id));
  const bytes = readFileSync(f.file);
  assert.equal(f.reopen().list(f.id).length, 50);
  assert.throws(() => f.store.save(f.id, initial(f.id)), code('WORKFLOW_LIMIT'));
  assert.deepEqual(readFileSync(f.file), bytes);
  const runs = f.store.list(f.id);
  const storeId = JSON.parse(readFileSync(f.file, 'utf8')).storeId as string;
  writeFileSync(f.file, disk(f.id, storeId, [...runs, initial(f.id)]));
  assert.throws(() => f.reopen().list(f.id), code('WORKFLOW_LIMIT'));
  writeFileSync(f.file, Buffer.alloc(WORKFLOW_LIMITS.bytes + 1, 32));
  assert.throws(() => f.reopen().list(f.id), code('WORKFLOW_LIMIT'));
  assert.throws(() => f.reopen().save(f.id, initial(f.id)), code('WORKFLOW_LIMIT'));
  assert.equal(statSync(f.file).size, WORKFLOW_LIMITS.bytes + 1);
});

test('malformed, foreign, future or internally inconsistent journals are rejected without overwrite', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const storeId = JSON.parse(readFileSync(f.file, 'utf8')).storeId as string;
  const badRun = clone(f.input);
  badRun.request.requestId = randomUUID();
  const invalids: Array<[string | Buffer, string]> = [
    ['{private', 'CORRUPT_WORKFLOW'],
    [Buffer.from([0xff, 0xfe]), 'CORRUPT_WORKFLOW'],
    [
      JSON.stringify({ schemaVersion: 4, projectId: f.id, runs: [f.input] }),
      'UNSUPPORTED_WORKFLOW',
    ],
    [
      JSON.stringify({ schemaVersion: 1, projectId: f.id, runs: [f.input], private: true }),
      'CORRUPT_WORKFLOW',
    ],
    [disk(randomUUID(), storeId, [f.input]), 'CORRUPT_WORKFLOW'],
    [disk(f.id, storeId, []), 'CORRUPT_WORKFLOW'],
    [disk(f.id, storeId, [badRun]), 'CORRUPT_WORKFLOW'],
    [disk(f.id, storeId, [initial(randomUUID())]), 'CORRUPT_WORKFLOW'],
    [disk(f.id, storeId, [f.input, f.input]), 'CORRUPT_WORKFLOW'],
    [disk(f.id, randomUUID(), [f.input]), 'CORRUPT_WORKFLOW'],
  ];
  for (const [bytes, expected] of invalids) {
    writeFileSync(f.file, bytes);
    const before = readFileSync(f.file);
    assert.throws(() => f.reopen().list(f.id), code(expected));
    assert.throws(() => f.store.save(f.id, initial(f.id)), code(expected));
    assert.deepEqual(readFileSync(f.file), before);
  }
});

test('symbolic links, hard links and linked ancestors cannot be followed or overwritten', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const outside = join(f.root, 'outside.json'),
    bytes = readFileSync(f.file);
  renameSync(f.file, outside);
  symlinkSync(outside, f.file);
  assert.throws(() => f.reopen().list(f.id), code('UNSAFE_PATH'));
  assert.throws(() => f.reopen().save(f.id, initial(f.id)), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(outside), bytes);
  rmSync(f.file);
  linkSync(outside, f.file);
  assert.throws(() => f.reopen().list(f.id), code('UNSAFE_PATH'));
  assert.throws(() => f.reopen().save(f.id, initial(f.id)), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(outside), bytes);
  rmSync(f.file);
  renameSync(outside, f.file);
  const runs = dirname(f.file),
    moved = join(f.root, 'moved-runs');
  renameSync(runs, moved);
  symlinkSync(moved, runs, 'dir');
  assert.throws(() => f.reopen().list(f.id), code('UNSAFE_PATH'));
  assert.throws(() => f.reopen().save(f.id, initial(f.id)), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(join(moved, 'workflows.json')), bytes);
});

test('a missing initialized journal fails closed after restart instead of starting over', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const observed = f.reopen();
  observed.list(f.id);
  rmSync(f.file);
  assert.throws(() => observed.list(f.id), code('MISSING_WORKFLOW'));
  assert.throws(() => observed.save(f.id, initial(f.id)), code('MISSING_WORKFLOW'));
  assert.equal(existsSync(f.file), false);
  assert.throws(() => f.reopen().list(f.id), code('MISSING_WORKFLOW'));
  assert.throws(() => f.reopen().save(f.id, initial(f.id)), code('MISSING_WORKFLOW'));
  assert.equal(existsSync(f.file), false);
  assert.equal(existsSync(f.marker), true);
});

test('a complete first journal repairs its absent marker without changing intent or journal bytes', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const before = readFileSync(f.file),
    marker = readFileSync(f.marker);
  rmSync(f.marker);
  assert.throws(() => f.store.list(f.id), code('MISSING_WORKFLOW'));
  assert.deepEqual(f.reopen().list(f.id), [f.input]);
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(readFileSync(f.marker), marker);
  // Simultaneous external deletion of both independent files cannot be distinguished from a new journal.
  rmSync(f.file);
  rmSync(f.marker);
  assert.deepEqual(f.reopen().list(f.id), []);
  assert.equal(existsSync(f.file), false);
  assert.equal(existsSync(f.marker), false);
});

test('initialization markers reject malformed, foreign, future or linked records without overwrite', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const journal = readFileSync(f.file),
    original = readFileSync(f.marker);
  const parsed = JSON.parse(original.toString('utf8'));
  for (const [value, expected] of [
    ['{private', 'CORRUPT_WORKFLOW'],
    [JSON.stringify({ ...parsed, projectId: randomUUID() }), 'CORRUPT_WORKFLOW'],
    [JSON.stringify({ ...parsed, storeId: randomUUID() }), 'CORRUPT_WORKFLOW'],
    [JSON.stringify({ ...parsed, extra: true }), 'CORRUPT_WORKFLOW'],
    [JSON.stringify({ ...parsed, schemaVersion: 2 }), 'UNSUPPORTED_WORKFLOW'],
    [' '.repeat(1025), 'WORKFLOW_LIMIT'],
  ] as const) {
    writeFileSync(f.marker, value);
    assert.throws(() => f.reopen().list(f.id), code(expected));
    assert.throws(() => f.reopen().save(f.id, initial(f.id)), code(expected));
    assert.equal(readFileSync(f.marker, 'utf8'), value);
    assert.deepEqual(readFileSync(f.file), journal);
  }
  writeFileSync(f.marker, original);
  const outside = join(f.root, 'outside-marker.json');
  renameSync(f.marker, outside);
  symlinkSync(outside, f.marker);
  assert.throws(() => f.reopen().list(f.id), code('UNSAFE_PATH'));
  rmSync(f.marker);
  linkSync(outside, f.marker);
  assert.throws(() => f.reopen().save(f.id, f.input), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(outside), original);
  assert.deepEqual(readFileSync(f.file), journal);
});

test('before-rename failures preserve the old file, remove owned temporaries and sanitize errors', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const bytes = readFileSync(f.file);
  const broken = new WorkflowStore(f.projects, {
    beforeRename() {
      throw new Error('private original input');
    },
  });
  assert.throws(
    () => broken.save(f.id, begin(f.input, 'generation', 1)),
    (error) => code('WORKFLOW_IO')(error) && !(error as Error).message.includes('private'),
  );
  assert.deepEqual(readFileSync(f.file), bytes);
  assert.deepEqual(readdirSync(dirname(f.file)).sort(), [
    'workflows.initialized.json',
    'workflows.json',
  ]);
});

test('a truncated staged file or replaced parent directory cannot be published', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const bytes = readFileSync(f.file),
    directory = dirname(f.file);
  const truncated = new WorkflowStore(f.projects, {
    beforeRename() {
      const temp = readdirSync(directory).find((name) => name.startsWith('.workflow-'))!;
      writeFileSync(join(directory, temp), '{');
    },
  });
  assert.throws(() => truncated.save(f.id, begin(f.input, 'generation', 1)), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(f.file), bytes);
  const swapped = new WorkflowStore(f.projects, {
    beforeRename() {
      const moved = join(f.root, 'previous-runs');
      renameSync(directory, moved);
      mkdirSync(directory);
      for (const name of readdirSync(moved)) renameSync(join(moved, name), join(directory, name));
    },
  });
  assert.throws(() => swapped.save(f.id, begin(f.input, 'generation', 1)), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(f.file), bytes);
  assert.deepEqual(readdirSync(directory).sort(), ['workflows.initialized.json', 'workflows.json']);
});

test('compare-and-swap preserves another writer and detects deletion before rename', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const competitor = initial(f.id);
  const race = new WorkflowStore(f.projects, {
    beforeRename() {
      f.store.save(f.id, competitor);
    },
  });
  assert.throws(() => race.save(f.id, begin(f.input, 'generation', 1)), code('WORKFLOW_CONFLICT'));
  assert.deepEqual(f.store.list(f.id), [f.input, competitor]);
  const missing = new WorkflowStore(f.projects, {
    beforeRename() {
      rmSync(f.file);
    },
  });
  assert.throws(
    () => missing.save(f.id, begin(f.input, 'generation', 1)),
    code('MISSING_WORKFLOW'),
  );
  assert.equal(existsSync(f.file), false);
});

test('lost acknowledgement succeeds only after exact readback; damaged committed bytes remain uncertain', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const running = begin(f.input, 'generation', 1);
  const lost = new WorkflowStore(f.projects, {
    afterRename() {
      throw new Error('lost acknowledgement');
    },
  });
  lost.save(f.id, running);
  assert.deepEqual(f.reopen().list(f.id), [running]);
  const uncertain = new WorkflowStore(f.projects, {
    afterRename() {
      writeFileSync(f.file, '{damaged');
      throw new Error('private');
    },
  });
  assert.throws(() => uncertain.save(f.id, finish(running, 2)), code('WORKFLOW_COMMIT_UNCERTAIN'));
  assert.equal(readFileSync(f.file, 'utf8'), '{damaged');
  assert.throws(() => f.reopen().list(f.id), code('CORRUPT_WORKFLOW'));
});

for (const boundary of ['beforeRename', 'afterRename'] as const) {
  test(`real SIGKILL at ${boundary} leaves one complete workflow checkpoint and idempotent replay in a new process`, (t) => {
    const f = fixture(t);
    f.store.save(f.id, f.input);
    const running = begin(f.input, 'generation', 1);
    f.store.save(f.id, running);
    const completed = finish(running, 2, { sourceRevision: 1, sourceHash: 'd'.repeat(64) });
    const before = readFileSync(f.file);
    const imports = `import {ProjectStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/project-store.ts')).href)}; import {WorkflowStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/workflow-store.ts')).href)}; const projects=new ProjectStore(${JSON.stringify(f.root)}); const run=${JSON.stringify(completed)};`;
    const killed = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} new WorkflowStore(projects,{${boundary}(){process.kill(process.pid,'SIGKILL');}}).save(run.request.projectId,run);`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    if (boundary === 'beforeRename') assert.deepEqual(readFileSync(f.file), before);
    const fresh = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} const store=new WorkflowStore(projects); const prior=store.list(run.request.projectId); store.save(run.request.projectId,run); store.save(run.request.projectId,run); console.log(JSON.stringify({prior,after:store.list(run.request.projectId)}));`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    const result = JSON.parse(fresh.stdout);
    assert.deepEqual(result.prior, [boundary === 'beforeRename' ? running : completed]);
    assert.deepEqual(result.after, [completed]);
  });
  test(`real SIGKILL during the first ${boundary} completes initialization safely in a new process`, (t) => {
    const f = fixture(t);
    const imports = `import {ProjectStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/project-store.ts')).href)}; import {WorkflowStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/workflow-store.ts')).href)}; const projects=new ProjectStore(${JSON.stringify(f.root)}); const run=${JSON.stringify(f.input)};`;
    const killed = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} new WorkflowStore(projects,{${boundary}(){process.kill(process.pid,'SIGKILL');}}).save(run.request.projectId,run);`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(existsSync(f.file), boundary === 'afterRename');
    assert.equal(existsSync(f.marker), false);
    const fresh = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} const store=new WorkflowStore(projects); const prior=store.list(run.request.projectId); store.save(run.request.projectId,run); store.save(run.request.projectId,run); console.log(JSON.stringify({prior,after:store.list(run.request.projectId)}));`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    const result = JSON.parse(fresh.stdout);
    assert.deepEqual(result.prior, boundary === 'beforeRename' ? [] : [f.input]);
    assert.deepEqual(result.after, [f.input]);
    const marker = JSON.parse(readFileSync(f.marker, 'utf8'));
    assert.equal(marker.storeId, JSON.parse(readFileSync(f.file, 'utf8')).storeId);
    rmSync(f.file);
    const missing = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} try {new WorkflowStore(projects).save(run.request.projectId,run); process.exit(1);} catch(error) {console.log(error.code);}`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout.trim(), 'MISSING_WORKFLOW');
    assert.equal(existsSync(f.file), false);
  });
}

test('v1 requests retain their exact canonical field order and hashes', () => {
  const run = initial(),
    original = run.request;
  const reordered = {
    mode: original.mode,
    sourceRevision: original.sourceRevision,
    planRunId: original.planRunId,
    projectId: original.projectId,
    requestId: original.requestId,
    schemaVersion: original.schemaVersion,
  };
  const parsed = parseWorkflowRequest(reordered);
  assert.deepEqual(Object.keys(parsed), [
    'schemaVersion',
    'requestId',
    'projectId',
    'planRunId',
    'sourceRevision',
    'mode',
  ]);
  assert.equal(JSON.stringify(parsed), JSON.stringify(original));
  assert.equal(sourceHash(JSON.stringify(parsed)), sourceHash(JSON.stringify(original)));
  assert.equal(JSON.stringify(parseWorkflowRun(run)), JSON.stringify(run));
});

test('v2 modification requests normalize bounded instructions and reject incompatible or unsafe fields', () => {
  const original = modification(randomUUID(), '  调整字号\n保留数据 😀  ').request;
  const parsed = parseWorkflowRequest(original);
  assert.equal(parsed.mode, 'modify');
  if (parsed.mode !== 'modify') assert.fail('v2 request expected');
  assert.equal(parsed.instruction, '调整字号\n保留数据 😀');
  assert.equal(parseWorkflowRequest({ ...parsed, instruction: '字'.repeat(2000) }).mode, 'modify');
  const { instruction: _instruction, ...missingInstruction } = parsed;
  for (const value of [
    missingInstruction,
    { ...parsed, extra: true },
    { ...parsed, schemaVersion: 1 },
    { ...parsed, schemaVersion: 3 },
    { ...parsed, mode: 'generate' },
    { ...parsed, mode: 'check' },
    { ...initial().request, mode: 'modify' },
    ...['', ' \n ', '字'.repeat(2001), '\ud800', 'private\u0000value', null].map((instruction) => ({
      ...parsed,
      instruction,
    })),
  ])
    assert.throws(() => parseWorkflowRequest(value), code('INVALID_INPUT'));
  let accesses = 0;
  for (const field of ['schemaVersion', 'instruction']) {
    const accessor = { ...parsed };
    Object.defineProperty(accessor, field, {
      enumerable: true,
      get() {
        accesses++;
        return parsed[field as keyof typeof parsed];
      },
    });
    assert.throws(() => parseWorkflowRequest(accessor), code('INVALID_INPUT'));
  }
  assert.equal(accesses, 0);
});

test('modification stages follow the generation sequence, including one repair in either position', () => {
  for (const sequence of [
    ['generation', 'build', 'repair', 'startup'],
    ['generation', 'build', 'startup', 'repair'],
  ] as const) {
    let run = modification(randomUUID()),
      tick = 1;
    for (const kind of sequence) {
      run = finish(begin(run, kind, tick++), tick++);
      assert.deepEqual(parseWorkflowRun(run), run);
    }
  }
  assert.throws(
    () => parseWorkflowRun(begin(modification(randomUUID()), 'build', 1)),
    code('INVALID_INPUT'),
  );
});

test('first modification upgrades only the journal to v2 and retains v1 identity, bytes and exact replay', (t) => {
  const f = fixture(t);
  f.store.save(f.id, f.input);
  const legacy = {
    ...f.input,
    status: 'cancelled' as const,
    updatedAt: time(1),
    errorCode: 'CANCELLED',
  };
  f.store.save(f.id, legacy);
  const before = JSON.parse(readFileSync(f.file, 'utf8'));
  const marker = readFileSync(f.marker),
    v1Request = JSON.stringify(before.runs[0].request);
  assert.equal(before.schemaVersion, 1);
  assert.deepEqual(f.reopen().list(f.id), [legacy]);
  const next = modification(f.id, '  调整卡片间距  ');
  f.reopen().save(f.id, next);
  const upgraded = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.storeId, before.storeId);
  assert.equal(JSON.stringify(upgraded.runs[0].request), v1Request);
  assert.deepEqual(upgraded.runs[0], before.runs[0]);
  assert.equal(upgraded.runs[1].request.instruction, '调整卡片间距');
  assert.deepEqual(readFileSync(f.marker), marker);
  assert.equal(JSON.parse(marker.toString()).schemaVersion, 1);
  const bytes = readFileSync(f.file),
    stat = statSync(f.file);
  f.reopen().save(f.id, legacy);
  f.reopen().save(f.id, next);
  assert.deepEqual(readFileSync(f.file), bytes);
  assert.equal(statSync(f.file).ino, stat.ino);
  const anotherV1 = initial(f.id, 'check');
  f.reopen().save(f.id, anotherV1);
  f.reopen().save(f.id, { ...anotherV1, status: 'stopped', errorCode: 'EMPTY_SOURCE' });
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).schemaVersion, 2);
  assert.deepEqual(readFileSync(f.marker), marker);
});

test('v1 envelopes cannot contain v2 requests and future envelopes preserve all files', (t) => {
  const f = fixture(t),
    next = modification(f.id);
  f.store.save(f.id, next);
  const current = JSON.parse(readFileSync(f.file, 'utf8')),
    marker = readFileSync(f.marker);
  for (const [schemaVersion, expected] of [
    [1, 'CORRUPT_WORKFLOW'],
    [4, 'UNSUPPORTED_WORKFLOW'],
  ] as const) {
    const bytes = JSON.stringify({ ...current, schemaVersion });
    writeFileSync(f.file, bytes);
    assert.throws(() => f.reopen().list(f.id), code(expected));
    assert.throws(() => f.reopen().save(f.id, initial(f.id)), code(expected));
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
    assert.deepEqual(readFileSync(f.marker), marker);
  }
});

test('changed modification instructions or reused v1 request IDs conflict without rewriting records', (t) => {
  const f = fixture(t),
    next = modification(f.id);
  f.store.save(f.id, f.input);
  f.store.save(f.id, next);
  const bytes = readFileSync(f.file);
  assert.throws(
    () =>
      f.reopen().save(f.id, {
        ...next,
        request: {
          ...next.request,
          schemaVersion: 2,
          mode: 'modify',
          instruction: '改成另一项要求',
        },
      }),
    code('WORKFLOW_CONFLICT'),
  );
  const reused = modification(f.id);
  reused.id = reused.request.requestId = f.input.id;
  assert.throws(() => f.reopen().save(f.id, reused), code('WORKFLOW_CONFLICT'));
  assert.deepEqual(readFileSync(f.file), bytes);
  const running = begin(next, 'generation', 1);
  f.store.save(f.id, running);
  const done = finish(running, 2, { sourceRevision: 1, sourceHash: 'e'.repeat(64) });
  done.status = 'stopped';
  done.errorCode = 'WORKFLOW_FAILED';
  f.store.save(f.id, done);
  assert.deepEqual(f.reopen().list(f.id).at(-1), done);
});

test('schema upgrade failure retains v1; acknowledged-loss readback retains one v2 modification', (t) => {
  const f = fixture(t),
    next = modification(f.id);
  f.store.save(f.id, f.input);
  const before = readFileSync(f.file),
    marker = readFileSync(f.marker);
  const failed = new WorkflowStore(f.projects, {
    beforeRename() {
      throw new Error('private instruction');
    },
  });
  assert.throws(() => failed.save(f.id, next), code('WORKFLOW_IO'));
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(readFileSync(f.marker), marker);
  const lost = new WorkflowStore(f.projects, {
    afterRename() {
      throw new Error('lost');
    },
  });
  lost.save(f.id, next);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).schemaVersion, 2);
  assert.deepEqual(f.reopen().list(f.id), [f.input, next]);
  f.reopen().save(f.id, next);
  assert.deepEqual(f.reopen().list(f.id), [f.input, next]);
  assert.deepEqual(readFileSync(f.marker), marker);
});

for (const boundary of ['beforeRename', 'afterRename'] as const) {
  test(`real SIGKILL at ${boundary} atomically upgrades v1 to v2 without losing prior workflows or replay`, (t) => {
    const f = fixture(t),
      next = modification(f.id);
    f.store.save(f.id, f.input);
    const before = readFileSync(f.file),
      marker = readFileSync(f.marker);
    const imports = `import {ProjectStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/project-store.ts')).href)}; import {WorkflowStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/workflow-store.ts')).href)}; const projects=new ProjectStore(${JSON.stringify(f.root)}); const run=${JSON.stringify(next)};`;
    const killed = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} new WorkflowStore(projects,{${boundary}(){process.kill(process.pid,'SIGKILL');}}).save(run.request.projectId,run);`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(
      JSON.parse(readFileSync(f.file, 'utf8')).schemaVersion,
      boundary === 'beforeRename' ? 1 : 2,
    );
    if (boundary === 'beforeRename') assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual(readFileSync(f.marker), marker);
    const fresh = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} const store=new WorkflowStore(projects); const prior=store.list(run.request.projectId); store.save(run.request.projectId,run); store.save(run.request.projectId,run); console.log(JSON.stringify({prior,after:store.list(run.request.projectId)}));`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    const result = JSON.parse(fresh.stdout);
    assert.deepEqual(result.prior, boundary === 'beforeRename' ? [f.input] : [f.input, next]);
    assert.deepEqual(result.after, [f.input, next]);
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).schemaVersion, 2);
    assert.deepEqual(readFileSync(f.marker), marker);
  });
}
