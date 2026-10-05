import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { BuildService } from '../src/main/build-service';
import { BuildStore } from '../src/main/build-store';
import { CodingRunner } from '../src/main/coding-runner';
import { CodingStore } from '../src/main/coding-store';
import { ModelService } from '../src/main/model-service';
import { PlanStore } from '../src/main/plan-store';
import { ProjectStore } from '../src/main/project-store';
import { RepairRunner } from '../src/main/repair-runner';
import { RepairStore } from '../src/main/repair-store';
import { RuntimeService, type RuntimeExecutor } from '../src/main/runtime-service';
import { RuntimeStore } from '../src/main/runtime-store';
import { compileSource } from '../src/main/source-compiler';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { WorkflowRunner } from '../src/main/workflow-runner';
import { WorkflowStore } from '../src/main/workflow-store';
import { AppError } from '../src/main/validation';
import type { ModelToolCall, ModelToolTurn } from '../src/shared/model-tool-contracts';
import type { RuntimeProbeResult } from '../src/shared/runtime-contracts';
import type { WorkflowRequest } from '../src/shared/workflow-contracts';
import { workflowRepairRequest } from '../src/shared/modification';
import { sourceHash } from '../src/main/source-protocol';

// All provider responses and startup observations are synthetic. Stores, accounting,
// child runners and the compiler are real; no transport can fall back to the network.
const syntheticKey = 'WORKFLOW-SYNTHETIC-KEY-NOT-A-CREDENTIAL';
const valid = 'export default function App(){return <h1>合成任务</h1>}';
const invalid = 'export default function App( {';
const runtimeInvalid = 'export default function App(){return <h1>{missingRuntimeValue}</h1>}';
const requirements = {
  summary: '合成本地任务列表',
  audience: '自己',
  features: ['阅读任务'],
  pages: ['任务列表'],
  data: ['任务'],
  outOfScope: ['联网'],
  questions: [],
  acceptance: ['列表可阅读'],
};
const design = {
  direction: '浅色清晰',
  palette: ['#ffffff'],
  pages: [{ name: '任务列表', sections: ['标题', '列表'] }],
  notes: [],
};
const stop = (): ModelToolTurn => ({
  finishReason: 'stop',
  message: { role: 'assistant', content: '所有业务功能均已验收通过。' },
});
const call = (name: string, args: object = {}): ModelToolCall => ({
  id: randomUUID(),
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: ModelToolCall[]): ModelToolTurn => ({
  finishReason: 'tool_calls',
  message: { role: 'assistant', content: null, tool_calls: calls },
});
const observed = (): RuntimeProbeResult => ({ status: 'observed', observedMs: 1200, issues: [] });
const issues = (): RuntimeProbeResult => ({
  status: 'issues',
  observedMs: 12,
  issues: ['REFERENCE_ERROR'],
});
const response = (reply: ModelToolTurn) =>
  Response.json({
    choices: [{ finish_reason: reply.finishReason, message: reply.message }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Reply = ModelToolTurn | (() => ModelToolTurn | Promise<ModelToolTurn>);
function fixture(
  t: TestContext,
  options: {
    maxCalls?: number;
    maxTokens?: number;
    compile?: typeof compileSource;
    timeoutMs?: number;
    repairTimeoutMs?: number;
    beforeRun?: (projectId: string) => void;
    assertModificationSafe?: (instruction: string) => void;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-development-workflow-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const sources = new SourceStore(projects);
  const tools = new SourceToolExecutor(projects, plans, sources);
  let project = projects.create({ name: '编排合成项目', idea: '只验证本地编排边界' });
  project = projects.saveRequirements(project.id, requirements);
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, design);
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const plan = plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)!.id,
    designId: project.designs.at(-1)!.id,
    profile: 'web',
  }).run!;
  const context = { projectId: project.id, planRunId: plan.id };
  const replies: Reply[] = [];
  const requests: unknown[] = [];
  const records = new WorkflowStore(projects);
  const models = new ModelService(
    join(root, 'credentials'),
    {
      available: () => false,
      encrypt: () => {
        throw new Error('Synthetic session-only key');
      },
      decrypt: () => {
        throw new Error('Synthetic session-only key');
      },
    },
    async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      assert.equal(
        records.list(project.id).at(-1)?.status,
        'running',
        'Parent intent precedes dispatch.',
      );
      const next = replies.shift();
      assert.ok(next, 'Unexpected model request: no network fallback is permitted.');
      return response(typeof next === 'function' ? await next() : next);
    },
  );
  models.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: syntheticKey,
    maxCalls: options.maxCalls ?? 30,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  });
  const codingRecords = new CodingStore(projects);
  const coding = new CodingRunner(codingRecords, sources, tools, models);
  const artifacts = new BuildStore(projects);
  let compileCount = 0;
  const builds = new BuildService(projects, sources, tools, artifacts, async (...args) => {
    compileCount++;
    return (options.compile ?? compileSource)(...args);
  });
  const observations: Array<RuntimeProbeResult | (() => Promise<RuntimeProbeResult>)> = [];
  let checkCount = 0;
  const executor: RuntimeExecutor = {
    check: async () => {
      checkCount++;
      const next = observations.shift();
      assert.ok(next, 'Unexpected startup check.');
      return typeof next === 'function' ? next() : next;
    },
    open: async () => assert.fail('Workflow must not open a preview window.'),
    openApplication: async () => assert.fail('Workflow must not open a persistent application.'),
  };
  const runtimeRecords = new RuntimeStore(projects);
  const runtime = new RuntimeService(projects, sources, tools, builds, runtimeRecords, executor);
  const repairRecords = new RepairStore(projects);
  const repairs = new RepairRunner(repairRecords, sources, tools, models, builds, {
    runtime,
    timeoutMs: options.repairTimeoutMs,
  });
  const runner = () =>
    new WorkflowRunner(
      projects,
      sources,
      tools,
      coding,
      builds,
      runtime,
      repairs,
      new WorkflowStore(projects),
      {
        timeoutMs: options.timeoutMs,
        beforeRun: options.beforeRun,
        assertModificationSafe: options.assertModificationSafe,
      },
    );
  const apply = (content: string, path = 'src/app.tsx') => {
    const source = sources.get(project.id);
    return call('apply_changes', {
      expectedRevision: source.revision,
      changes: [
        {
          operation: 'write',
          path,
          expectedHash: source.files.find((file) => file.path === path)?.sha256 ?? null,
          content,
        },
      ],
    });
  };
  const write = (content = valid) => {
    const change = apply(content);
    const result = tools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: JSON.parse(change.function.arguments),
    });
    assert.ok(result.ok);
  };
  const request = (mode: 'generate' | 'check' = 'generate'): WorkflowRequest => ({
    schemaVersion: 1,
    requestId: randomUUID(),
    ...context,
    sourceRevision: sources.get(project.id).revision,
    mode,
  });
  return {
    root,
    project,
    context,
    projects,
    plans,
    sources,
    tools,
    records,
    models,
    requests,
    replies,
    codingRecords,
    coding,
    builds,
    artifacts,
    runtime,
    runtimeRecords,
    repairs,
    repairRecords,
    observations,
    runner,
    apply,
    write,
    request,
    counts: () => ({ compile: compileCount, check: checkCount }),
  };
}

function modification(
  f: ReturnType<typeof fixture>,
  instruction = '将列表标题改为我的任务',
): WorkflowRequest {
  return { ...f.request(), schemaVersion: 2, mode: 'modify', instruction };
}
function modificationReplies(
  f: ReturnType<typeof fixture>,
  content = 'export default function App(){return <h1>我的任务</h1>}',
) {
  f.replies.push(
    turn(call('read_file', { path: 'src/app.tsx' })),
    () => turn(f.apply(content)),
    stop(),
  );
  f.observations.push(observed());
}

test('modify keeps explicit instruction and original plan, reports exact file difference and replays without calls', async (t) => {
  const f = fixture(t);
  f.write();
  const planBytes = readFileSync(
    join(f.root, 'projects', f.project.id, 'runs', 'development-plans.json'),
  );
  const before = f.sources.get(f.project.id);
  const input = modification(f, '  将列表标题改为我的任务  ');
  modificationReplies(f);
  const result = await f.runner().run(input);
  assert.equal(result.run?.status, 'ready');
  assert.equal(result.current, true);
  assert.equal(result.run!.request.mode, 'modify');
  assert.equal(result.history[0]!.instruction, '将列表标题改为我的任务');
  assert.deepEqual(result.changes, {
    status: 'available',
    baseRevision: before.revision,
    resultRevision: before.revision + 1,
    files: [{ path: 'src/app.tsx', kind: 'modified' }],
  });
  assert.ok(JSON.stringify(f.requests).includes('将列表标题改为我的任务'));
  assert.deepEqual(
    readFileSync(join(f.root, 'projects', f.project.id, 'runs', 'development-plans.json')),
    planBytes,
  );
  const calls = f.models.usage().calls;
  assert.deepEqual(await f.runner().run(input), result);
  assert.equal(f.models.usage().calls, calls);
  await assert.rejects(f.runner().run({ ...input, instruction: '另一条不同修改' }), {
    code: 'WORKFLOW_CONFLICT',
  });
  assert.equal(
    f.sources.history(f.project.id).find((c) => c.revision === before.revision)?.files[0]?.sha256,
    before.files[0]?.sha256,
  );
});

test('modify with no net changes preserves honest no_changes and an empty verified diff', async (t) => {
  const f = fixture(t);
  f.write();
  modificationReplies(f, valid);
  const result = await f.runner().run(modification(f));
  assert.equal(result.run?.status, 'ready');
  assert.equal(result.run?.stages[0]?.status, 'no_changes');
  assert.equal(result.changes?.status, 'available');
  assert.deepEqual(result.changes?.files, []);
  assert.equal(result.changes?.resultRevision, 2);
  assert.ok(
    f.plans.get(f.project.id).run!.plan.tasks.every((task) => task.verification === 'not_run'),
  );
});

test('modify exact historical diff does not borrow the latest source or latest instruction', async (t) => {
  const f = fixture(t);
  f.write();
  modificationReplies(f);
  const first = await f.runner().run(modification(f));
  modificationReplies(f, 'export default function App(){return <h1>第二次标题</h1>}');
  const second = await f.runner().run(modification(f, '改为第二次标题'));
  const state = f.runner().state({ projectId: f.project.id, requestId: first.run!.id });
  assert.equal(state.current, false);
  assert.deepEqual(state.changes, first.changes);
  assert.deepEqual(
    state.history.map((r) => r.id),
    [second.run!.id, first.run!.id],
  );
  assert.equal(state.history[0]!.instruction, '改为第二次标题');
  assert.equal(f.runner().state({ projectId: f.project.id, requestId: randomUUID() }).run, null);
});

test('modify diff includes real additions and deletions', async (t) => {
  const f = fixture(t);
  f.write();
  const added = f.tools.execute(f.context, {
    schemaVersion: 1,
    requestId: randomUUID(),
    tool: 'apply_changes',
    arguments: JSON.parse(f.apply('/* old */', 'src/old.css').function.arguments),
  });
  assert.ok(added.ok);
  f.replies.push(
    turn(call('read_file', { path: 'src/old.css' })),
    () => {
      const snapshot = f.sources.get(f.project.id);
      return turn(
        call('apply_changes', {
          expectedRevision: snapshot.revision,
          changes: [
            {
              operation: 'delete',
              path: 'src/old.css',
              expectedHash: snapshot.files.find((file) => file.path === 'src/old.css')!.sha256,
            },
            {
              operation: 'write',
              path: 'src/new.css',
              expectedHash: null,
              content: 'h1{color:blue}',
            },
          ],
        }),
      );
    },
    stop(),
  );
  f.observations.push(observed());
  const result = await f.runner().run(modification(f, '用新的样式文件替代旧文件'));
  assert.equal(result.run?.status, 'ready');
  assert.deepEqual(result.changes?.files, [
    { path: 'src/new.css', kind: 'added' },
    { path: 'src/old.css', kind: 'deleted' },
  ]);
});

test('modify requires nonempty source and current plan before creating a paid intent', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.runner().run(modification(f)), { code: 'EMPTY_SOURCE' });
  f.write();
  const input = modification(f);
  f.write('export default function App(){return null}');
  await assert.rejects(f.runner().run(input), { code: 'STALE_SOURCE' });
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
});

test('modify secret guard refuses known key before journal or model writes', async (t) => {
  let safeCalls = 0;
  const f = fixture(t, {
    assertModificationSafe: (instruction) => {
      safeCalls++;
      f.models.assertExportSafe([instruction]);
    },
  });
  f.write();
  await assert.rejects(f.runner().run(modification(f, '把标题设为' + syntheticKey)), {
    code: 'SENSITIVE_INPUT',
  });
  assert.equal(safeCalls, 1);
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
});

test('modify compile failure uses the same bounded repair while diff covers repaired result', async (t) => {
  const f = fixture(t);
  f.write();
  modificationReplies(f, invalid);
  f.replies.push(
    () => turn(f.apply('export default function App(){return <h1>修复后修改</h1>}')),
    stop(),
  );
  const input = modification(f);
  const result = await f.runner().run(input);
  assert.equal(result.run?.status, 'ready');
  assert.deepEqual(
    result.run?.stages.map((s) => s.kind),
    ['generation', 'build', 'repair', 'startup'],
  );
  assert.equal(result.changes?.baseRevision, 1);
  assert.equal(result.changes?.resultRevision, 3);
  assert.deepEqual(result.changes?.files, [{ path: 'src/app.tsx', kind: 'modified' }]);
  const run = result.run!;
  const stage = run.stages.find((item) => item.kind === 'repair')!;
  assert.equal(stage.repairRequestVersion, 2);
  const childRequest = workflowRepairRequest(run, stage.requestId, 2);
  assert.equal(childRequest.schemaVersion, 2);
  assert.equal(
    f.repairs.history(f.project.id)[0].requestHash,
    sourceHash(JSON.stringify(childRequest)),
  );
  const sent = f.requests[3] as { messages: { role: string; content: string }[] };
  assert.deepEqual(JSON.parse(sent.messages[2].content), {
    type: 'user_modification',
    workflowId: run.id,
    sourceRevision: 1,
    sourceHash: run.initialSourceHash,
    instruction: input.mode === 'modify' ? input.instruction : '',
  });
  assert.match(sent.messages[0].content, /不通过撤回用户要求/u);
  assert.match(sent.messages[0].content, /不能声称用户要求已实现/u);
  const childBytes = readFileSync(
    join(f.root, 'projects', f.project.id, 'runs', 'repairs.json'),
    'utf8',
  );
  assert.equal(childBytes.includes('将列表标题改为我的任务'), false);
  assert.equal(
    JSON.parse(
      readFileSync(join(f.root, 'projects', f.project.id, 'runs', 'workflows.json'), 'utf8'),
    ).schemaVersion,
    3,
  );
  const calls = f.models.usage().calls;
  assert.deepEqual(await f.runner().run(input), result);
  assert.equal(f.models.usage().calls, calls);
});

test('modify startup repair receives the exact user intent and failed startup report without extra allowance', async (t) => {
  const f = fixture(t);
  f.write();
  modificationReplies(f, runtimeInvalid);
  f.observations.splice(0, 1, issues(), issues(), observed());
  f.replies.push(() => turn(f.apply('export default function App(){return <h1>我的任务</h1>}')));
  const input = modification(f);
  const result = await f.runner().run(input);
  assert.equal(result.run?.status, 'ready');
  const run = result.run!;
  const startup = run.stages.find((item) => item.kind === 'startup')!;
  const stage = run.stages.find((item) => item.kind === 'repair')!;
  const child = f.repairs.history(f.project.id)[0];
  const request = workflowRepairRequest(run, stage.requestId, 2, startup.runtimeReportId!);
  assert.equal(child.requestHash, sourceHash(JSON.stringify(request)));
  assert.equal(child.runtimeReportId, startup.runtimeReportId);
  const sent = f.requests[3] as { messages: { role: string; content: string }[] };
  assert.equal(JSON.parse(sent.messages[2].content).instruction, '将列表标题改为我的任务');
  assert.equal(JSON.parse(sent.messages[2].content).workflowId, run.id);
  assert.equal(JSON.parse(sent.messages[3].content).type, 'observed_runtime_issues');
  assert.equal(result.rounds, 4);
  assert.equal(result.builds, 3);
  assert.equal(f.counts().check, 3);
  assert.equal(f.models.usage().calls, 4);
  assert.ok(
    f.plans.get(f.project.id).run!.plan.tasks.every((item) => item.verification === 'not_run'),
  );
  assert.deepEqual(f.runner().state({ projectId: f.project.id }), result);
});

test('legacy 0.18 modify history with a v1 repair retains its original hash and read-only replay', async (t) => {
  const f = fixture(t);
  f.write();
  modificationReplies(f, invalid);
  f.replies.push(() => turn(f.apply(valid)));
  const input = modification(f);
  const result = await f.runner().run(input);
  assert.equal(result.run?.status, 'ready');
  // Reconstruct the exact legacy envelope/child hash, without executing an old paid request.
  const parentPath = join(f.root, 'projects', f.project.id, 'runs', 'workflows.json');
  const parent = JSON.parse(readFileSync(parentPath, 'utf8'));
  parent.schemaVersion = 2;
  const run = parent.runs[0];
  const stage = run.stages.find((item: { kind: string }) => item.kind === 'repair');
  delete stage.repairRequestVersion;
  const legacy = workflowRepairRequest(run, stage.requestId, 2);
  assert.deepEqual(legacy, {
    schemaVersion: 1,
    requestId: stage.requestId,
    projectId: f.project.id,
    planRunId: f.context.planRunId,
    sourceRevision: 2,
  });
  const childPath = join(f.root, 'projects', f.project.id, 'runs', 'repairs.json');
  const children = JSON.parse(readFileSync(childPath, 'utf8'));
  children.runs[0].requestHash = sourceHash(JSON.stringify(legacy));
  writeFileSync(parentPath, JSON.stringify(parent));
  writeFileSync(childPath, JSON.stringify(children));
  const calls = f.models.usage().calls;
  const reopened = f.runner();
  assert.equal(reopened.state({ projectId: f.project.id }).run?.status, 'ready');
  assert.equal((await reopened.run(input)).run?.status, 'ready');
  assert.equal((await f.repairs.repair(legacy)).run?.status, 'succeeded');
  assert.equal(f.models.usage().calls, calls);
  assert.equal(JSON.parse(readFileSync(parentPath, 'utf8')).schemaVersion, 2);
});

test('workflow rejects repair child hashes belonging to another intent, parent or source binding', async (t) => {
  const f = fixture(t);
  f.write();
  modificationReplies(f, invalid);
  f.replies.push(() => turn(f.apply(valid)));
  const result = await f.runner().run(modification(f));
  const run = result.run!;
  const stage = run.stages.find((item) => item.kind === 'repair')!;
  const input = workflowRepairRequest(run, stage.requestId, 2);
  assert.equal(input.schemaVersion, 2);
  if (input.schemaVersion !== 2) assert.fail('Expected intent-aware repair.');
  const actual = f.repairs.history(f.project.id);
  for (const modification of [
    { ...input.modification, instruction: '另一个要求' },
    { ...input.modification, workflowId: randomUUID() },
    { ...input.modification, sourceRevision: 0 },
    { ...input.modification, sourceHash: '0'.repeat(64) },
  ]) {
    const requestHash = sourceHash(JSON.stringify({ ...input, modification }));
    f.repairs.history = () => actual.map((item) => ({ ...item, requestHash }));
    assert.throws(() => f.runner().state({ projectId: f.project.id }), {
      code: 'WORKFLOW_INCONSISTENT',
    });
  }
  // A new marked repair must never silently fall back to a legacy v1 child.
  const { modification: _modification, ...withoutModification } = input;
  const requestHash = sourceHash(JSON.stringify({ ...withoutModification, schemaVersion: 1 }));
  f.repairs.history = () => actual.map((item) => ({ ...item, requestHash }));
  assert.throws(() => f.runner().state({ projectId: f.project.id }), {
    code: 'WORKFLOW_INCONSISTENT',
  });
});

test('modify execution refuses an intent-mismatched repair receipt before adopting its candidate', async (t) => {
  const f = fixture(t);
  f.write();
  modificationReplies(f, invalid);
  f.replies.push(() => turn(f.apply(valid)));
  const history = f.repairs.history.bind(f.repairs);
  f.repairs.history = (projectId) =>
    history(projectId).map((item) => ({ ...item, requestHash: '0'.repeat(64) }));
  await assert.rejects(f.runner().run(modification(f)), { code: 'WORKFLOW_INCONSISTENT' });
  const run = f.records.list(f.project.id).at(-1)!;
  assert.equal(run.status, 'stopped');
  assert.equal(run.errorCode, 'WORKFLOW_INCONSISTENT');
  assert.equal(run.buildId, null);
  assert.equal(
    f.sources.get(f.project.id).revision,
    3,
    'Already saved repair source remains available.',
  );
  assert.equal(f.counts().check, 0, 'The mismatched receipt cannot promote a startup candidate.');
});

for (const phase of ['generation', 'repair'] as const) {
  test(`modify ${phase} journal failure after source commit leaves its difference unconfirmed`, async (t) => {
    const f = fixture(t);
    f.write();
    modificationReplies(f, phase === 'generation' ? valid + '\n' : invalid);
    if (phase === 'repair') f.replies.push(() => turn(f.apply(valid)), stop());
    const store = phase === 'generation' ? f.codingRecords : f.repairRecords;
    const afterRevision = phase === 'generation' ? 1 : 2;
    const code = phase === 'generation' ? 'CODING_IO' : 'REPAIR_IO';
    const save = store.save.bind(store);
    let failed = false;
    // Both stores have distinct run contracts; preserve the exact original call.
    store.save = ((projectId: string, run: never) => {
      if (!failed && f.sources.get(projectId).revision > afterRevision) {
        failed = true;
        throw new AppError(code, 'Synthetic transient journal failure');
      }
      save(projectId, run);
    }) as typeof store.save;
    const input = modification(f);
    const result = await f.runner().run(input);
    assert.equal(failed, true);
    assert.equal(result.run?.status, 'stopped');
    assert.equal(result.run?.errorCode, code);
    assert.equal(result.sourceRevision, afterRevision + 1);
    assert.equal(result.run?.latestRevision, afterRevision);
    assert.equal(result.changes?.status, 'unavailable');
    const calls = f.models.usage().calls;
    const reopened = f.runner().state({ projectId: f.project.id, requestId: input.requestId });
    assert.equal(reopened.changes?.status, 'unavailable');
    assert.equal(f.models.usage().calls, calls);
  });
}

test('modify cancellation after a committed tool leaves checkpoints and marks diff unconfirmed', async (t) => {
  const f = fixture(t);
  f.write();
  const waiting = deferred<void>(),
    release = deferred<ModelToolTurn>();
  f.replies.push(
    turn(call('read_file', { path: 'src/app.tsx' })),
    () => turn(f.apply('export default function App(){return <h1>已提交修改</h1>}')),
    () => {
      waiting.resolve();
      return release.promise;
    },
  );
  const runner = f.runner(),
    input = modification(f),
    resultPromise = runner.run(input);
  await waiting.promise;
  runner.cancel();
  const result = await resultPromise;
  assert.equal(result.run?.status, 'cancelled');
  assert.equal(result.changes?.status, 'unavailable');
  assert.equal(f.sources.get(f.project.id).revision, 2);
  release.resolve(stop());
  await setImmediate();
  await setImmediate();
  assert.equal(f.counts().compile, 0);
  const reopened = f.runner().state({ projectId: f.project.id });
  assert.equal(reopened.changes?.status, 'unavailable');
  assert.equal(reopened.history[0]!.instruction, '将列表标题改为我的任务');
});

test('one authorized generation produces exact build/startup receipts without promoting business acceptance', async (t) => {
  const f = fixture(t);
  const originalProject = readFileSync(join(f.root, 'projects', f.project.id, 'project.json'));
  f.replies.push(() => turn(f.apply(valid)), stop());
  f.observations.push(observed());
  const input = f.request();
  const result = await f.runner().run(input);
  assert.equal(result.run?.id, input.requestId);
  assert.equal(result.run?.status, 'ready');
  assert.equal(result.current, true);
  assert.deepEqual(
    result.run?.stages.map((stage) => stage.kind),
    ['generation', 'build', 'startup'],
  );
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.builds, 1);
  assert.deepEqual(f.counts(), { compile: 1, check: 1 });
  assert.equal(f.codingRecords.list(f.project.id).length, 1);
  assert.equal(f.repairRecords.list(f.project.id).length, 0);
  const report = f.runtime.get(f.project.id, result.run!.runtimeReportId!)!;
  const artifact = f.builds.artifact(f.project.id, result.run!.buildId!);
  assert.equal(report.status, 'observed');
  assert.equal(report.mode, 'check');
  assert.equal(report.buildId, artifact.id);
  assert.equal(report.artifactHash, artifact.artifactHash);
  assert.equal(report.sourceHash, result.run!.latestSourceHash);
  assert.deepEqual(
    readFileSync(join(f.root, 'projects', f.project.id, 'project.json')),
    originalProject,
  );
  assert.ok(
    f.plans.get(f.project.id).run!.plan.tasks.every((task) => task.verification === 'not_run'),
  );
  const journal = JSON.stringify(f.records.list(f.project.id));
  assert.equal(journal.includes(syntheticKey), false);
  assert.equal(journal.includes('export default'), false);
  assert.equal(journal.includes('所有业务功能'), false);
});

test('check mode builds existing current-plan source without generating or spending a model call', async (t) => {
  const f = fixture(t);
  f.write();
  f.observations.push(observed());
  const result = await f.runner().run(f.request('check'));
  assert.equal(result.run?.status, 'ready');
  assert.deepEqual(
    result.run?.stages.map((stage) => stage.kind),
    ['build', 'startup'],
  );
  assert.equal(f.models.usage().calls, 0);
  assert.equal(f.codingRecords.list(f.project.id).length, 0);
  assert.deepEqual(f.counts(), { compile: 1, check: 1 });
});

test('generation followed by a real syntax failure gets one compiler repair and an exact startup check', async (t) => {
  const f = fixture(t);
  f.replies.push(
    () => turn(f.apply(invalid)),
    stop(),
    () => turn(f.apply(valid)),
  );
  f.observations.push(observed());
  const result = await f.runner().run(f.request());
  assert.equal(result.run?.status, 'ready');
  assert.equal(result.rounds, 3);
  assert.equal(result.builds, 3);
  assert.equal(result.run!.latestRevision, 2);
  assert.deepEqual(f.counts(), { compile: 3, check: 1 });
  const repair = f.repairRecords.list(f.project.id);
  assert.equal(repair.length, 1);
  assert.equal(repair[0].runtimeReportId ?? null, null);
  assert.equal(repair[0].status, 'succeeded');
  assert.equal(result.run?.buildId, repair[0].buildId);
  assert.equal(
    f.runtime.get(f.project.id, result.run!.runtimeReportId!)?.buildId,
    repair[0].buildId,
  );
});

test('startup issues receive one runtime repair; only its exact observed artifact can make the workflow ready', async (t) => {
  const f = fixture(t);
  f.replies.push(
    () => turn(f.apply(runtimeInvalid)),
    stop(),
    () => turn(f.apply(valid)),
  );
  f.observations.push(issues(), issues(), observed());
  const result = await f.runner().run(f.request());
  assert.equal(result.run?.status, 'ready');
  assert.equal(result.rounds, 3);
  assert.equal(result.builds, 3);
  assert.deepEqual(f.counts(), { compile: 3, check: 3 });
  const repair = f.repairRecords.list(f.project.id)[0];
  assert.ok(repair.runtimeReportId);
  assert.equal(repair.status, 'succeeded');
  assert.equal(result.run?.runtimeReportId, repair.runtimeResultId);
  assert.equal(result.run?.buildId, repair.buildId);
  assert.equal(f.runtime.get(f.project.id, repair.runtimeResultId!)?.status, 'observed');
});

test('a successful compiler repair followed by startup failure stops without a second repair attempt', async (t) => {
  const f = fixture(t);
  f.replies.push(
    () => turn(f.apply(invalid)),
    stop(),
    () => turn(f.apply(runtimeInvalid)),
  );
  f.observations.push(issues());
  const result = await f.runner().run(f.request());
  assert.equal(result.run?.status, 'stopped');
  assert.equal(f.repairRecords.list(f.project.id).length, 1);
  assert.equal(f.models.usage().calls, 3);
  assert.deepEqual(f.counts(), { compile: 3, check: 1 });
  assert.equal(f.runtime.get(f.project.id, result.run!.runtimeReportId!)?.status, 'issues');
  assert.equal(f.replies.length, 0);
});

test('a runtime issue which is not reproduced is not relabeled as a completed repair', async (t) => {
  const f = fixture(t);
  f.write(runtimeInvalid);
  f.observations.push(issues(), observed());
  const result = await f.runner().run(f.request('check'));
  assert.equal(result.run?.status, 'stopped');
  assert.equal(f.repairRecords.list(f.project.id)[0].errorCode, 'RUNTIME_NOT_REPRODUCED');
  assert.equal(f.models.usage().calls, 0);
  assert.deepEqual(f.counts(), { compile: 2, check: 2 });
});

test('four unsuccessful repair rounds stop at the workflow total of six builds', async (t) => {
  const f = fixture(t);
  f.replies.push(() => turn(f.apply(invalid)), stop());
  for (let attempt = 1; attempt <= 4; attempt++)
    f.replies.push(() => turn(f.apply(`${invalid} // attempt ${attempt}`)));
  const result = await f.runner().run(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.rounds, 6);
  assert.equal(result.builds, 6);
  assert.equal(result.toolCalls, 5);
  assert.deepEqual(f.counts(), { compile: 6, check: 0 });
  assert.equal(f.repairRecords.list(f.project.id).length, 1);
  assert.equal(f.repairRecords.list(f.project.id)[0].rounds, 4);
  assert.equal(f.models.usage().calls, 6);
});

test('generation exhaustion retains committed source but never starts an unauthorized repair or generation retry', async (t) => {
  const f = fixture(t);
  for (let round = 0; round < 4; round++)
    f.replies.push(() => turn(f.apply(`${valid}\n// round ${round}`)));
  const input = f.request();
  const runner = f.runner();
  const result = await runner.run(input);
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.rounds, 4);
  assert.equal(f.sources.get(f.project.id).revision, 4);
  assert.equal(f.repairRecords.list(f.project.id).length, 0);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
  await f.runner().run(input);
  assert.equal(f.models.usage().calls, 4);
  assert.equal(f.codingRecords.list(f.project.id).length, 1);
});

test('the aggregate counters include both full four-round budgets and all twenty-four tool slots', async (t) => {
  const f = fixture(t);
  // Three batches consume twelve generation tools; the fourth round ends generation.
  for (let index = 0; index < 3; index++)
    f.replies.push(() =>
      turn(
        ...(index === 0 ? [f.apply(invalid)] : [call('list_files')]),
        call('list_files'),
        call('list_files'),
        call('list_files'),
      ),
    );
  f.replies.push(stop());
  // Four repair batches consume twelve tools and mutate source each time.
  for (let index = 0; index < 4; index++)
    f.replies.push(() =>
      turn(f.apply(`${invalid} // repair ${index}`), call('list_files'), call('list_files')),
    );
  const result = await f.runner().run(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.rounds, 8);
  assert.equal(result.toolCalls, 24);
  assert.equal(result.builds, 6);
  assert.equal(f.models.usage().calls, 8);
  assert.equal(f.repairRecords.list(f.project.id).length, 1);
  assert.deepEqual(f.counts(), { compile: 6, check: 0 });
});

test('same request replay returns its original run even after a newer workflow and performs no work', async (t) => {
  const f = fixture(t);
  f.replies.push(() => turn(f.apply(valid)), stop());
  f.observations.push(observed(), observed());
  const firstInput = f.request();
  const first = await f.runner().run(firstInput);
  const second = await f.runner().run(f.request('check'));
  assert.notEqual(first.run!.id, second.run!.id);
  const counts = f.counts();
  const replayed = await f.runner().run(firstInput);
  assert.equal(replayed.run?.id, firstInput.requestId);
  assert.equal(replayed.run?.buildId, first.run!.buildId);
  assert.equal(replayed.run?.runtimeReportId, first.run!.runtimeReportId);
  assert.equal(replayed.run?.status, 'ready');
  assert.equal(f.models.usage().calls, 2);
  assert.deepEqual(f.counts(), counts);
});

test('reusing a workflow ID with different arguments rejects before any additional work', async (t) => {
  const f = fixture(t);
  f.write();
  f.observations.push(observed());
  const input = f.request('check');
  await f.runner().run(input);
  await assert.rejects(f.runner().run({ ...input, mode: 'generate' }));
  assert.equal(f.models.usage().calls, 0);
  assert.deepEqual(f.counts(), { compile: 1, check: 1 });
});

test('generation which only claims success without committed source cannot become ready', async (t) => {
  const f = fixture(t);
  f.replies.push(stop());
  const result = await f.runner().run(f.request());
  assert.equal(result.run?.status, 'stopped');
  assert.equal(result.run?.stages[0].status, 'no_changes');
  assert.equal(result.sourceRevision, 0);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
  assert.equal(f.repairRecords.list(f.project.id).length, 0);
});

test('source revision, plan confirmation and archived-project preconditions stop before intent and model dispatch', async (t) => {
  const f = fixture(t);
  const outdated = f.request();
  f.write();
  await assert.rejects(f.runner().run(outdated));
  const current = f.request('check');
  f.projects.archive(f.project.id, true);
  await assert.rejects(f.runner().run(current));
  f.projects.archive(f.project.id, false);
  f.projects.saveRequirements(f.project.id, { ...requirements, summary: '新的未确认需求' });
  await assert.rejects(f.runner().run(current));
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
});

test('a source commit by another owner during generation is never adopted into the workflow', async (t) => {
  const f = fixture(t);
  f.replies.push(() => {
    f.write('export default function App(){return <p>outside owner</p>}');
    return stop();
  });
  const result = await f.runner().run(f.request());
  assert.equal(result.run?.status, 'stopped');
  assert.equal(result.run?.errorCode, 'STALE_SOURCE');
  assert.equal(f.sources.get(f.project.id).revision, 1);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
});

test('cancellation ignores a provider that returns tools after abort and prevents all later phases', async (t) => {
  const f = fixture(t);
  const entered = deferred<void>();
  const late = deferred<ModelToolTurn>();
  f.replies.push(() => {
    entered.resolve();
    return late.promise;
  });
  const runner = f.runner();
  const operation = runner.run(f.request());
  await entered.promise;
  runner.cancel();
  const result = await operation;
  assert.equal(result.run?.status, 'cancelled');
  late.resolve(turn(f.apply(valid)));
  await setImmediate();
  await setImmediate();
  assert.equal(f.sources.get(f.project.id).revision, 0);
  assert.equal(f.models.usage().calls, 1);
  assert.equal(f.models.usage().unknownUsageCalls, 1);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
  assert.equal(f.records.list(f.project.id).at(-1)?.status, 'cancelled');
});

test('the workflow deadline cancels an unresolved model request and cannot be reset by replay', async (t) => {
  const f = fixture(t, { timeoutMs: 500 });
  f.replies.push(() => new Promise<ModelToolTurn>(() => {}));
  const input = f.request();
  const result = await f.runner().run(input);
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.errorCode, 'WORKFLOW_TIMEOUT');
  assert.equal(f.models.usage().calls, 1);
  const replayed = await f.runner().run(input);
  assert.equal(replayed.run?.status, 'limited');
  assert.equal(f.models.usage().calls, 1);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
});

test('cancel during a startup observation cancels the exact report and does not begin repair', async (t) => {
  const f = fixture(t);
  f.write();
  const entered = deferred<void>();
  const late = deferred<RuntimeProbeResult>();
  f.observations.push(() => {
    entered.resolve();
    return late.promise;
  });
  const runner = f.runner();
  const operation = runner.run(f.request('check'));
  await entered.promise;
  runner.cancel();
  const result = await operation;
  assert.equal(result.run?.status, 'cancelled');
  late.resolve(issues());
  await setImmediate();
  const reports = f.runtimeRecords.list(f.project.id);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'cancelled');
  assert.equal(f.repairRecords.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
});

test('state can query an older exact request without returning or counting the latest workflow', async (t) => {
  const f = fixture(t);
  f.replies.push(() => turn(f.apply(valid)), stop());
  f.observations.push(observed(), observed());
  const first = f.request();
  await f.runner().run(first);
  const second = f.request('check');
  await f.runner().run(second);
  const runner = f.runner();
  assert.equal(runner.state({ projectId: f.project.id }).run?.id, second.requestId);
  const exact = runner.state({ projectId: f.project.id, requestId: first.requestId });
  assert.equal(exact.run?.id, first.requestId);
  assert.equal(exact.rounds, 2);
  assert.equal(exact.toolCalls, 1);
  assert.equal(exact.builds, 1);
  const unknown = runner.state({ projectId: f.project.id, requestId: randomUUID() });
  assert.equal(unknown.run, null);
  assert.equal(unknown.current, false);
  assert.equal(unknown.rounds, 0);
  assert.equal(unknown.builds, 0);
  assert.equal(f.models.usage().calls, 2);
});

test('development token budget rejection remains a limited outcome without any provider dispatch', async (t) => {
  const f = fixture(t, { maxTokens: 1 });
  const result = await f.runner().run(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.errorCode, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(f.codingRecords.list(f.project.id)[0].errorCode, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(f.models.usage().calls, 0);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
});

test('repair budget rejection stops locally after the failing compiler without issuing a new model request', async (t) => {
  const f = fixture(t, { maxTokens: 1 });
  f.write(invalid);
  const result = await f.runner().run(f.request('check'));
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.errorCode, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(f.repairRecords.list(f.project.id)[0].status, 'limited');
  assert.equal(f.models.usage().calls, 0);
  assert.deepEqual(f.counts(), { compile: 2, check: 0 });
});

test('trusted preflight runs only for a new validated workflow and fails before generation intent', async (t) => {
  let preflight = 0;
  const f = fixture(t, {
    beforeRun: () => {
      preflight++;
    },
  });
  f.write();
  f.observations.push(observed());
  const request = f.request('check');
  await f.runner().run(request);
  await f.runner().run(request);
  assert.equal(preflight, 1);
  assert.equal(f.models.usage().calls, 0);
  await assert.rejects(f.runner().run({ ...request, requestId: randomUUID(), sourceRevision: 0 }));
  assert.equal(preflight, 1);
});

test('six failed startup observations exhaust the sole runtime repair without another generation', async (t) => {
  const f = fixture(t);
  f.write(runtimeInvalid);
  for (let attempt = 1; attempt <= 4; attempt++)
    f.replies.push(() => turn(f.apply(`${runtimeInvalid} // repair ${attempt}`)));
  f.observations.push(...Array.from({ length: 6 }, issues));
  const result = await f.runner().run(f.request('check'));
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.builds, 6);
  assert.equal(result.rounds, 4);
  assert.deepEqual(f.counts(), { compile: 6, check: 6 });
  assert.equal(f.codingRecords.list(f.project.id).length, 0);
  assert.equal(f.repairRecords.list(f.project.id).length, 1);
  assert.equal(f.runtimeRecords.list(f.project.id).length, 6);
});

test('a new plan with the same requirements cannot silently adopt source bound to the preceding plan', async (t) => {
  const f = fixture(t);
  f.write();
  const newer = f.plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: f.project.id,
    requirementId: f.project.requirements.at(-1)!.id,
    designId: f.project.designs.at(-1)!.id,
    profile: 'web',
  }).run!;
  await assert.rejects(f.runner().run({ ...f.request('check'), planRunId: newer.id }), {
    code: 'STALE_PLAN',
  });
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
});

test('source rollback preserves content but invalidates an earlier workflow revision and never replays it', async (t) => {
  const f = fixture(t);
  f.write();
  f.observations.push(observed());
  const input = f.request('check');
  const first = await f.runner().run(input);
  assert.equal(first.run?.status, 'ready');
  f.write(`${valid}\n// new version`);
  f.sources.restore(f.project.id, {
    requestId: randomUUID(),
    binding: f.tools.prepare(f.context).binding,
    expectedRevision: 2,
    targetRevision: 1,
  });
  const replay = await f.runner().run(input);
  assert.equal(replay.run?.id, input.requestId);
  assert.equal(replay.current, false);
  assert.equal(replay.sourceRevision, 3);
  assert.deepEqual(f.counts(), { compile: 1, check: 1 });
  assert.equal(f.models.usage().calls, 0);
});

test('a restored interrupted generation intent is reported without paid replay; explicit check uses preserved source', async (t) => {
  const f = fixture(t);
  const entered = deferred<void>();
  const late = deferred<ModelToolTurn>();
  f.replies.push(
    () => turn(f.apply(valid)),
    () => {
      entered.resolve();
      return late.promise;
    },
  );
  const input = f.request();
  const runner = f.runner();
  const operation = runner.run(input);
  await entered.promise;
  const parentPath = join(f.root, 'projects', f.project.id, 'runs', 'workflows.json');
  const childPath = join(f.root, 'projects', f.project.id, 'runs', 'coding.json');
  // Restore real snapshots captured while the two intents were running. Separate
  // process/SIGKILL tests cover the OS boundary; this case covers coordinator replay.
  const parentIntent = readFileSync(parentPath);
  const childIntent = readFileSync(childPath);
  runner.cancel();
  await operation;
  late.resolve(stop());
  await setImmediate();
  await setImmediate();
  writeFileSync(parentPath, parentIntent);
  writeFileSync(childPath, childIntent);
  const coding = new CodingRunner(new CodingStore(f.projects), f.sources, f.tools, f.models);
  const restarted = new WorkflowRunner(
    f.projects,
    f.sources,
    f.tools,
    coding,
    f.builds,
    f.runtime,
    f.repairs,
    new WorkflowStore(f.projects),
  );
  const state = restarted.state({ projectId: f.project.id });
  assert.equal(state.run?.status, 'interrupted');
  assert.equal(state.run?.stages[0].status, 'interrupted');
  assert.equal(state.sourceRevision, 1);
  assert.equal((await restarted.run(input)).run?.status, 'interrupted');
  assert.equal(f.models.usage().calls, 2);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
  f.observations.push(observed());
  const continued = await restarted.run(f.request('check'));
  assert.equal(continued.run?.status, 'ready');
  assert.notEqual(continued.run?.id, input.requestId);
  assert.deepEqual(
    continued.run?.stages.map((stage) => stage.kind),
    ['build', 'startup'],
  );
  assert.equal(f.models.usage().calls, 2);
  assert.equal(f.codingRecords.list(f.project.id).length, 1);
});

test('cancel at the build-to-startup boundary remains latched after the child build has already finished', async (t) => {
  const f = fixture(t);
  f.write();
  const build = {
    build: async (input: unknown) => {
      const result = await f.builds.build(input);
      runner.cancel();
      return result;
    },
    artifact: f.builds.artifact.bind(f.builds),
    attempts: f.builds.attempts.bind(f.builds),
    cancel: f.builds.cancel.bind(f.builds),
  };
  const runner = new WorkflowRunner(
    f.projects,
    f.sources,
    f.tools,
    f.coding,
    build,
    f.runtime,
    f.repairs,
    f.records,
  );
  const result = await runner.run(f.request('check'));
  assert.equal(result.run?.status, 'cancelled');
  assert.deepEqual(f.counts(), { compile: 1, check: 0 });
  assert.equal(
    f.artifacts.list(f.project.id).length,
    1,
    'The already committed build is preserved.',
  );
  assert.equal(f.repairRecords.list(f.project.id).length, 0);
});

test('a late compiler result after cancel cannot publish an artifact or start observation', async (t) => {
  const entered = deferred<void>();
  const late = deferred<Awaited<ReturnType<typeof compileSource>>>();
  const f = fixture(t, {
    compile: async () => {
      entered.resolve();
      return late.promise;
    },
  });
  f.write();
  const runner = f.runner();
  const operation = runner.run(f.request('check'));
  await entered.promise;
  runner.cancel();
  const result = await operation;
  assert.equal(result.run?.status, 'cancelled');
  late.resolve({ javascript: 'synthetic late compiled result', css: '', warnings: [] });
  await setImmediate();
  await setImmediate();
  assert.equal(f.artifacts.list(f.project.id).length, 0);
  assert.equal(f.builds.attempts(f.project.id)[0].status, 'cancelled');
  assert.deepEqual(f.counts(), { compile: 1, check: 0 });
});

test('reopening without the exact runtime receipt cannot advertise a current ready candidate', async (t) => {
  const f = fixture(t);
  f.write();
  f.observations.push(observed());
  const input = f.request('check');
  assert.equal((await f.runner().run(input)).run?.status, 'ready');
  rmSync(join(f.root, 'projects', f.project.id, 'runs', 'runtime-reports.json'));
  const runtime = new RuntimeService(
    f.projects,
    f.sources,
    f.tools,
    f.builds,
    new RuntimeStore(f.projects),
    {
      check: async () => assert.fail('No automatic recheck.'),
      open: async () => assert.fail('No opening.'),
    },
  );
  const reopened = new WorkflowRunner(
    f.projects,
    f.sources,
    f.tools,
    f.coding,
    f.builds,
    runtime,
    f.repairs,
    new WorkflowStore(f.projects),
  );
  assert.throws(() => reopened.state({ projectId: f.project.id }), {
    code: 'WORKFLOW_INCONSISTENT',
  });
  await assert.rejects(reopened.run(input), { code: 'WORKFLOW_INCONSISTENT' });
  assert.equal(f.models.usage().calls, 0);
});

test('a failed trusted toolchain preflight leaves no parent or child intent and dispatches no model', async (t) => {
  const f = fixture(t, {
    beforeRun: () => {
      throw new AppError('TOOLCHAIN_UNAVAILABLE', '合成工具链缺失');
    },
  });
  await assert.rejects(f.runner().run(f.request()), { code: 'TOOLCHAIN_UNAVAILABLE' });
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.equal(f.codingRecords.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
  assert.deepEqual(f.counts(), { compile: 0, check: 0 });
});

test('the repair-specific deadline remains a limited outcome at both child and parent levels', async (t) => {
  const f = fixture(t, { repairTimeoutMs: 500 });
  f.write(invalid);
  f.replies.push(() => new Promise<ModelToolTurn>(() => {}));
  const result = await f.runner().run(f.request('check'));
  const child = f.repairRecords.list(f.project.id)[0];
  assert.equal(child.status, 'limited');
  assert.equal(child.errorCode, 'TIMEOUT');
  assert.equal(result.run?.stages.at(-1)?.status, 'limited');
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.errorCode, 'TIMEOUT');
  assert.equal(f.models.usage().calls, 1);
  assert.deepEqual(f.counts(), { compile: 2, check: 0 });
});

for (const limited of [false, true]) {
  test(`reopening a ${limited ? 'limited' : 'successful'} generation with its child journal missing cannot invent zero counters`, async (t) => {
    const f = fixture(t);
    if (limited) f.replies.push(...Array.from({ length: 4 }, () => turn(call('list_files'))));
    else {
      f.replies.push(() => turn(f.apply(valid)), stop());
      f.observations.push(observed());
    }
    const input = f.request();
    const result = await f.runner().run(input);
    assert.equal(result.run?.status, limited ? 'limited' : 'ready');
    const calls = f.models.usage().calls;
    rmSync(join(f.root, 'projects', f.project.id, 'runs', 'coding.json'));
    const coding = new CodingRunner(new CodingStore(f.projects), f.sources, f.tools, f.models);
    const restarted = new WorkflowRunner(
      f.projects,
      f.sources,
      f.tools,
      coding,
      f.builds,
      f.runtime,
      f.repairs,
      new WorkflowStore(f.projects),
    );
    assert.throws(() => restarted.state({ projectId: f.project.id }), {
      code: 'WORKFLOW_INCONSISTENT',
    });
    await assert.rejects(restarted.run(input), { code: 'WORKFLOW_INCONSISTENT' });
    assert.equal(f.models.usage().calls, calls);
  });
}
