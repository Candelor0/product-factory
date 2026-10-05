import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { BuildService } from '../src/main/build-service';
import { BuildStore } from '../src/main/build-store';
import { ModelService } from '../src/main/model-service';
import { PlanStore } from '../src/main/plan-store';
import { ProjectStore } from '../src/main/project-store';
import { RepairRunner } from '../src/main/repair-runner';
import { RepairStore } from '../src/main/repair-store';
import { RuntimeStore } from '../src/main/runtime-store';
import { RuntimeService } from '../src/main/runtime-service';
import type { RuntimeProbeResult } from '../src/shared/runtime-contracts';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { AppError } from '../src/main/validation';
import type { BuildRequest, BuildResult } from '../src/shared/build-contracts';
import type { ModelToolCall, ModelToolTurn } from '../src/shared/model-tool-contracts';

const requirements = {
  summary: '本地合成计数器',
  audience: '自己',
  features: ['点击增加数字'],
  pages: ['计数器'],
  data: ['临时数字'],
  outOfScope: ['联网服务'],
  questions: [],
  acceptance: ['点击增加数字'],
};
const design = {
  direction: '简洁浅色',
  palette: ['#ffffff'],
  pages: [{ name: '计数器', sections: ['数字', '按钮'] }],
  notes: [],
};
const valid =
  "import {useState} from 'react'; export default function App(){const [n,s]=useState(0);return <button onClick={()=>s(n+1)}>{n}</button>}";
const invalid = 'export default function App( {';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
function tool(name: string, args: object = {}, id: string = randomUUID()): ModelToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
const turn = (...calls: ModelToolCall[]): ModelToolTurn => ({
  finishReason: 'tool_calls',
  message: { role: 'assistant', content: null, tool_calls: calls },
});
const stop = (): ModelToolTurn => ({
  finishReason: 'stop',
  message: { role: 'assistant', content: '已经完全通过验收。' },
});
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), '有限修复-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const sources = new SourceStore(projects);
  const tools = new SourceToolExecutor(projects, plans, sources);
  const records = new RepairStore(projects);
  const artifacts = new BuildStore(projects);
  const builds = new BuildService(projects, sources, tools, artifacts);
  let project = projects.create({ name: '合成修复', idea: '仅验证有限编译修复' });
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
  function apply(content: string, id: string = randomUUID()) {
    const snapshot = sources.get(project.id);
    return tool(
      'apply_changes',
      {
        expectedRevision: snapshot.revision,
        changes: [
          {
            operation: 'write',
            path: 'src/app.tsx',
            expectedHash:
              snapshot.files.find((file) => file.path === 'src/app.tsx')?.sha256 ?? null,
            content,
          },
        ],
      },
      id,
    );
  }
  function write(content = invalid) {
    const call = apply(content);
    const response = tools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: JSON.parse(call.function.arguments),
    });
    assert.equal(response.ok, true);
  }
  function request(): BuildRequest {
    return {
      schemaVersion: 1,
      requestId: randomUUID(),
      ...context,
      sourceRevision: sources.get(project.id).revision,
    };
  }
  const models: Pick<ModelService, 'toolTurn'> = { toolTurn: async () => stop() };
  const runner = (
    options?: { timeoutMs?: number; runtime?: Pick<RuntimeService, 'get' | 'state' | 'check'> },
    service: Pick<BuildService, 'build' | 'cancel'> = builds,
  ) => new RepairRunner(records, sources, tools, models, service, options);
  const journal = () =>
    readFileSync(join(root, 'projects', project.id, 'runs', 'repairs.json'), 'utf8');
  const sourceFile = () =>
    readFileSync(join(root, 'projects', project.id, 'source', 'workspace.json'));
  const buildFile = () => readFileSync(join(root, 'projects', project.id, 'runs', 'builds.json'));
  return {
    root,
    projects,
    plans,
    sources,
    tools,
    records,
    artifacts,
    builds,
    context,
    project,
    apply,
    write,
    request,
    models,
    runner,
    journal,
    sourceFile,
    buildFile,
  };
}

test('valid source compiles for zero paid calls and persists intent before invoking the real compiler', async (t) => {
  const f = fixture(t);
  f.write(valid);
  f.models.toolTurn = async () => {
    assert.fail('valid source must not spend a model call');
  };
  const build: BuildService['build'] = (input) => {
    const saved = f.records.list(f.project.id).at(-1)!;
    assert.equal(saved.status, 'running');
    assert.equal(saved.builds, 1);
    assert.equal(saved.buildId, (input as BuildRequest).requestId);
    return f.builds.build(input);
  };
  const result = await f
    .runner(undefined, { build, cancel: () => f.builds.cancel() })
    .repair(f.request());
  assert.equal(result.run?.status, 'succeeded');
  assert.equal(result.run?.rounds, 0);
  assert.equal(result.run?.toolCalls, 0);
  assert.equal(result.run?.builds, 1);
  assert.equal(f.artifacts.get(f.project.id, result.run!.buildId!).sourceRevision, 1);
});

test('actual syntax failure is repaired and recompiled, with trusted feedback and no business acceptance promotion', async (t) => {
  const f = fixture(t);
  f.write();
  const before = readFileSync(join(f.root, 'projects', f.project.id, 'project.json'));
  let calls = 0;
  f.models.toolTurn = async (messages, tools) => {
    calls++;
    const saved = f.records.list(f.project.id).at(-1)!;
    assert.equal(saved.rounds, calls);
    assert.equal(saved.builds, 1);
    assert.equal(saved.phase, 'repairing');
    assert.deepEqual(
      tools.map((item) => item.function.name),
      ['list_files', 'read_file', 'apply_changes'],
    );
    if (calls === 1) {
      const feedback = JSON.parse(messages.at(-1)!.content!);
      assert.equal(feedback.status, 'failed');
      assert.equal(feedback.diagnostics[0].message, '源码语法无法编译，请检查此处。');
      return turn(tool('read_file', { path: 'src/app.tsx' }, 'read_existing'));
    }
    const response = JSON.parse(messages.at(-1)!.content!);
    assert.equal(response.data.file.content, invalid);
    const savedTool = f.records.list(f.project.id).at(-1)!.toolRequests[0];
    assert.notEqual(savedTool.requestId, 'read_existing');
    return turn(f.apply(valid, 'fix_once'));
  };
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'succeeded');
  assert.equal(calls, 2);
  assert.equal(result.run?.builds, 2);
  assert.equal(result.run?.latestRevision, 2);
  assert.deepEqual(result.run?.diagnostics, []);
  assert.match(f.artifacts.get(f.project.id, result.run!.buildId!).javascript, /runtime\.js/u);
  assert.equal(f.journal().includes('export default'), false);
  assert.equal(f.journal().includes('read_existing'), false);
  assert.deepEqual(readFileSync(join(f.root, 'projects', f.project.id, 'project.json')), before);
  assert.ok(
    f.plans.get(f.project.id).run!.plan.tasks.every((item) => item.verification === 'not_run'),
  );
});

test('unrepairable changed code stops at four model rounds and five actual builds', async (t) => {
  const f = fixture(t);
  f.write();
  let calls = 0;
  f.models.toolTurn = async () =>
    turn(f.apply(`export default function App( { // attempt ${++calls}`));
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.errorCode, 'REPAIR_LIMIT');
  assert.equal(result.run?.rounds, 4);
  assert.equal(result.run?.builds, 5);
  assert.equal(result.run?.toolCalls, 4);
  assert.equal(result.run?.latestRevision, 5);
  assert.equal(f.artifacts.list(f.project.id).length, 0);
  assert.equal(result.run?.diagnostics[0].message, '源码语法无法编译，请检查此处。');
});

test('read-only rounds reach the tool limit without redundant builds', async (t) => {
  const f = fixture(t);
  f.write();
  f.models.toolTurn = async () => turn(tool('list_files'), tool('list_files'), tool('list_files'));
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.rounds, 4);
  assert.equal(result.run?.toolCalls, 12);
  assert.equal(result.run?.toolRequests.length, 12);
  assert.equal(result.run?.builds, 1);
});

test('an over-limit tool batch is rejected before executing any tool in that batch', async (t) => {
  const f = fixture(t);
  f.write();
  let calls = 0;
  f.models.toolTurn = async () => {
    calls++;
    return turn(...Array.from({ length: calls < 4 ? 4 : 1 }, () => tool('list_files')));
  };
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.rounds, 4);
  assert.equal(result.run?.toolCalls, 12);
  assert.equal(f.sources.get(f.project.id).revision, 1);
});

test('model stop cannot claim success without a passing build', async (t) => {
  const f = fixture(t);
  f.write();
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'no_progress');
  assert.equal(result.run?.rounds, 1);
  assert.equal(result.run?.builds, 1);
  assert.equal(result.run?.diagnostics.length, 1);
  assert.equal(f.journal().includes('完全通过验收'), false);
});

test('identical content writes do not cause redundant compilation', async (t) => {
  const f = fixture(t);
  f.write();
  let calls = 0;
  f.models.toolTurn = async () => (++calls === 1 ? turn(f.apply(invalid)) : stop());
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'no_progress');
  assert.equal(result.run?.builds, 1);
  assert.equal(result.run?.latestRevision, 2);
});

test('cancelling pending model work returns promptly and ignores late successful tool calls', async (t) => {
  const f = fixture(t);
  f.write();
  const gate = pending<ModelToolTurn>();
  const entered = pending<void>();
  let signal: AbortSignal | undefined;
  f.models.toolTurn = (_messages, _tools, value) => {
    signal = value;
    entered.resolve();
    return gate.promise;
  };
  const runner = f.runner();
  const running = runner.repair(f.request());
  await entered.promise;
  const before = f.sourceFile();
  runner.cancel();
  const result = await running;
  assert.equal(result.run?.status, 'cancelled');
  assert.equal(signal?.aborted, true);
  gate.resolve(turn(f.apply(valid)));
  await setImmediate();
  assert.deepEqual(f.sourceFile(), before);
  assert.equal(f.artifacts.list(f.project.id).length, 0);
});

test('total deadline stops work, aborts any active provider, and ignores late results', async (t) => {
  const f = fixture(t);
  f.write();
  const gate = pending<ModelToolTurn>();
  let signal: AbortSignal | undefined;
  f.models.toolTurn = (_messages, _tools, value) => {
    signal = value;
    return gate.promise;
  };
  const before = f.sourceFile();
  let cancelledBuilds = 0;
  const result = await f
    .runner(
      { timeoutMs: 60 },
      {
        build: async () => ({
          status: 'failed',
          state: f.builds.state(f.project.id),
          diagnostics: [
            { path: 'src/app.tsx', line: 1, message: '源码语法无法编译，请检查此处。' },
          ],
        }),
        cancel: () => {
          cancelledBuilds++;
        },
      },
    )
    .repair(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.errorCode, 'TIMEOUT');
  assert.ok(cancelledBuilds >= 1);
  // The deadline covers journal writes and local compilation too. Under parallel
  // tests it may expire before the provider starts; that is also a valid stop.
  if (signal) assert.equal(signal.aborted, true);
  gate.resolve(turn(f.apply(valid)));
  await setImmediate();
  assert.deepEqual(f.sourceFile(), before);
});

test('cancellation during an actual BuildService discards late compiler success and never pays', async (t) => {
  const f = fixture(t);
  f.write(valid);
  const gate = pending<{ javascript: string; css: string; warnings: [] }>();
  const entered = pending<void>();
  const service = new BuildService(f.projects, f.sources, f.tools, f.artifacts, () => {
    entered.resolve();
    return gate.promise;
  });
  f.models.toolTurn = async () => {
    assert.fail('cancelled local compilation must not call model');
  };
  const runner = f.runner(undefined, service);
  const running = runner.repair(f.request());
  await entered.promise;
  runner.cancel();
  assert.equal((await running).run?.status, 'cancelled');
  gate.resolve({ javascript: 'late candidate', css: '', warnings: [] });
  await setImmediate();
  assert.equal(f.artifacts.list(f.project.id).length, 0);
});

test('saved repairs survive cancellation between tools without executing subsequent tools', async (t) => {
  const f = fixture(t);
  f.write();
  const runner = f.runner();
  const original = f.tools.execute.bind(f.tools);
  let executed = 0;
  f.tools.execute = (context, input) => {
    const result = original(context, input);
    if (++executed === 1) runner.cancel();
    return result;
  };
  f.models.toolTurn = async () => turn(f.apply(valid), tool('list_files'));
  const result = await runner.repair(f.request());
  assert.equal(result.run?.status, 'cancelled');
  assert.equal(executed, 1);
  assert.equal(result.run?.latestRevision, 2);
  assert.equal(result.run?.builds, 1);
  assert.equal(f.sources.get(f.project.id).files[0].content, valid);
  assert.equal(f.artifacts.list(f.project.id).length, 0);
});

test('concurrent repair requests are busy while exact running request replay does not call model again', async (t) => {
  const f = fixture(t);
  f.write();
  const gate = pending<ModelToolTurn>();
  const entered = pending<void>();
  let calls = 0;
  f.models.toolTurn = () => {
    calls++;
    entered.resolve();
    return gate.promise;
  };
  const runner = f.runner();
  const request = f.request();
  const running = runner.repair(request);
  await entered.promise;
  await assert.rejects(runner.repair(f.request()), hasCode('BUSY'));
  assert.equal((await runner.repair(request)).run?.status, 'running');
  assert.equal(calls, 1);
  gate.resolve(stop());
  await running;
});

test('terminal and interrupted requests reopen without paid replay, and conflicting payloads fail', async (t) => {
  const f = fixture(t);
  f.write();
  const request = f.request();
  const runner = f.runner();
  const done = await runner.repair(request);
  f.models.toolTurn = async () => {
    assert.fail('replay must not call model');
  };
  assert.deepEqual(await f.runner().repair(request), done);
  await assert.rejects(
    runner.repair({ ...request, sourceRevision: 0 }),
    hasCode('REPAIR_CONFLICT'),
  );
  const second = f.request();
  const saved = f.records.list(f.project.id).at(-1)!;
  const { createHash } = await import('node:crypto');
  f.records.save(f.project.id, {
    ...saved,
    id: second.requestId,
    requestHash: createHash('sha256').update(JSON.stringify(second)).digest('hex'),
    status: 'running',
    rounds: 1,
    toolCalls: 0,
    toolRequests: [],
    errorCode: null,
  });
  assert.equal((await f.runner().repair(second)).run?.status, 'interrupted');
  assert.equal(f.records.list(f.project.id).at(-1)!.status, 'running');
});

test('an external source transaction during a model round is detected before executing a returned tool', async (t) => {
  const f = fixture(t);
  f.write();
  let calls = 0;
  f.models.toolTurn = async () => {
    calls++;
    const proposed = turn(f.apply(valid));
    f.write('export default function Other( {');
    return proposed;
  };
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run?.errorCode, 'STALE_SOURCE');
  assert.equal(result.run?.toolCalls, 0);
  assert.equal(calls, 1);
  assert.equal(f.sources.get(f.project.id).files[0].content, 'export default function Other( {');
});

test('requirements changed during a model round stop all returned writes', async (t) => {
  const f = fixture(t);
  f.write();
  const before = f.sourceFile();
  f.models.toolTurn = async () => {
    f.projects.saveRequirements(f.project.id, { ...requirements, summary: '改变需求' });
    return turn(f.apply(valid));
  };
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run?.errorCode, 'CONFIRMATION_REQUIRED');
  assert.equal(result.run?.toolCalls, 0);
  assert.deepEqual(f.sourceFile(), before);
});

test('archiving during a pending model call records a stopped run while preserving source', async (t) => {
  const f = fixture(t);
  f.write();
  const before = f.sourceFile();
  f.models.toolTurn = async () => {
    f.projects.archive(f.project.id, true);
    return turn(f.apply(valid));
  };
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run?.errorCode, 'ARCHIVED');
  assert.deepEqual(f.sourceFile(), before);
});

test('provider failures are not retried and raw error text never enters run records', async (t) => {
  for (const code of [
    'RATE_LIMITED',
    'PROVIDER_ERROR',
    'NETWORK_ERROR',
    'TIMEOUT',
    'UNTRUSTED_KEY_TEXT',
  ]) {
    const f = fixture(t);
    f.write();
    let calls = 0;
    f.models.toolTurn = async () => {
      calls++;
      throw new AppError(code, 'SYNTHETIC-SECRET-KEY /private/host');
    };
    const result = await f.runner().repair(f.request());
    assert.equal(result.run?.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(result.run?.errorCode, code === 'UNTRUSTED_KEY_TEXT' ? 'REPAIR_FAILED' : code);
    assert.equal(f.journal().includes('SYNTHETIC-SECRET'), false);
    assert.equal(f.journal().includes('/private/host'), false);
  }
});

test('real ModelService tool turn uses synthetic credentials and enforces persistent call budget', async (t) => {
  const f = fixture(t);
  f.write();
  let fetches = 0;
  const models = new ModelService(
    join(f.root, 'credentials'),
    {
      available: () => false,
      encrypt: () => {
        throw new Error();
      },
      decrypt: () => {
        throw new Error();
      },
    },
    async () => {
      fetches++;
      return Response.json({
        choices: [{ finish_reason: 'tool_calls', message: turn(tool('list_files')).message }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      });
    },
  );
  models.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'SYNTHETIC-REPAIR-KEY',
    maxCalls: 1,
  });
  const runner = new RepairRunner(f.records, f.sources, f.tools, models, f.builds);
  const result = await runner.repair(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(fetches, 1);
  assert.equal(models.usage().calls, 1);
  assert.equal(result.run?.rounds, 2);
  assert.equal(result.run?.builds, 1);
  assert.equal(f.journal().includes('SYNTHETIC-REPAIR-KEY'), false);
});

test('duplicate tool calls replay a local receipt while changed arguments for one ID fail', async (t) => {
  const f = fixture(t);
  f.write();
  let index = 0;
  const write = f.apply('export default function Again( {', 'stable_call');
  f.models.toolTurn = async () => {
    index++;
    if (index < 3) return turn(write);
    return turn(tool('list_files', {}, 'stable_call'));
  };
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run?.errorCode, 'REPAIR_CONFLICT');
  assert.equal(result.run?.toolCalls, 2);
  assert.equal(result.run?.toolRequests.length, 1);
  assert.equal(result.run?.latestRevision, 2);
  assert.equal(result.run?.builds, 2);
});

test('uncertain committed source reconciles using the same local request without another paid round', async (t) => {
  const f = fixture(t);
  f.write();
  let injected = false;
  let rounds = 0;
  const sources = new SourceStore(f.projects, {
    afterRename: () => {
      if (!injected) {
        injected = true;
        throw new Error('synthetic interruption');
      }
    },
  });
  const tools = new SourceToolExecutor(f.projects, f.plans, sources);
  f.models.toolTurn = async () => {
    rounds++;
    return turn(f.apply(valid));
  };
  const runner = new RepairRunner(f.records, sources, tools, f.models, f.builds);
  const result = await runner.repair(f.request());
  assert.equal(result.run?.status, 'succeeded');
  assert.equal(rounds, 1);
  assert.equal(result.run?.latestRevision, 2);
  assert.equal(result.run?.toolCalls, 1);
});

test('failed repair preserves the old successful build byte for byte', async (t) => {
  const f = fixture(t);
  f.write(valid);
  const first = f.request();
  await f.builds.build(first);
  const before = f.buildFile();
  f.write();
  f.models.toolTurn = async () =>
    turn(f.apply(`export default function Fail${randomUUID().replaceAll('-', '')}( {`));
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'limited');
  assert.deepEqual(f.buildFile(), before);
  assert.equal(f.builds.artifact(f.project.id, first.requestId).id, first.requestId);
});

test('invalid or stale repair requests fail before intent, compilation, or model calls', async (t) => {
  const f = fixture(t);
  f.write();
  const runner = f.runner();
  const good = f.request();
  const invalids = [
    null,
    { ...good, schemaVersion: 2 },
    { ...good, sourceRevision: -1 },
    { ...good, command: 'arbitrary shell' },
    { ...good, requestId: '../bad' },
  ];
  for (const value of invalids) await assert.rejects(runner.repair(value));
  await assert.rejects(runner.repair({ ...good, sourceRevision: 0 }), hasCode('STALE_SOURCE'));
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.throws(() => f.runner({ timeoutMs: 180001 }), hasCode('INVALID_INPUT'));
});

test('metadata persistence failure before paid work prevents any provider request', async (t) => {
  const f = fixture(t);
  f.write();
  let calls = 0;
  f.models.toolTurn = async () => {
    calls++;
    return stop();
  };
  const save = f.records.save.bind(f.records);
  let terminalWrites = 0;
  f.records.save = (projectId, run) => {
    if (run.status !== 'running') terminalWrites++;
    if (run.rounds > 0 && run.status === 'running')
      throw new AppError('REPAIR_IO', 'synthetic disk failure');
    return save(projectId, run);
  };
  const request = f.request();
  const runner = f.runner();
  await assert.rejects(runner.repair(request), hasCode('REPAIR_IO'));
  assert.equal(runner.state(f.project.id).run?.status, 'interrupted');
  assert.equal(f.records.list(f.project.id).at(-1)!.rounds, 0);
  assert.equal((await f.runner().repair(request)).run?.status, 'interrupted');
  assert.equal(terminalWrites, 0);
  assert.equal(calls, 0);
});

test('terminal post-rename uncertainty reconciles exact saved success without overwriting it', async (t) => {
  const f = fixture(t);
  f.write(valid);
  const save = f.records.save.bind(f.records);
  let terminalWrites = 0;
  f.records.save = (projectId, run) => {
    save(projectId, run);
    if (run.status !== 'running') {
      terminalWrites++;
      throw new AppError('REPAIR_COMMIT_UNCERTAIN', 'synthetic failure after rename');
    }
  };
  const request = f.request();
  const result = await f.runner().repair(request);
  assert.equal(result.run?.status, 'succeeded');
  assert.equal(terminalWrites, 1);
  assert.deepEqual(f.records.list(f.project.id).at(-1), result.run);
  assert.deepEqual(await f.runner().repair(request), result);
  assert.equal(terminalWrites, 1);
});

test('exact running-intent and counter commits can be reconciled before one paid operation', async (t) => {
  const f = fixture(t);
  f.write();
  const save = f.records.save.bind(f.records);
  let calls = 0;
  f.records.save = (projectId, run) => {
    save(projectId, run);
    throw new AppError('REPAIR_COMMIT_UNCERTAIN', 'synthetic post-rename fault');
  };
  f.models.toolTurn = async () => {
    calls++;
    const run = f.records.list(f.project.id).at(-1)!;
    assert.equal(run.rounds, 1);
    assert.equal(run.builds, 1);
    return stop();
  };
  const result = await f.runner().repair(f.request());
  assert.equal(result.run?.status, 'no_progress');
  assert.equal(calls, 1);
  assert.equal(result.run?.rounds, 1);
});

test('uncertain counter mismatch preserves original error and prevents paid work or guessed rewrites', async (t) => {
  const f = fixture(t);
  f.write();
  const save = f.records.save.bind(f.records);
  let writesAfterFault = 0;
  let faulted = false;
  let calls = 0;
  f.records.save = (projectId, run) => {
    if (faulted) writesAfterFault++;
    if (run.rounds === 1) {
      save(projectId, { ...run, rounds: 0 });
      faulted = true;
      throw new AppError('REPAIR_COMMIT_UNCERTAIN', 'synthetic inconsistent receipt');
    }
    save(projectId, run);
  };
  f.models.toolTurn = async () => {
    calls++;
    return stop();
  };
  const request = f.request();
  const runner = f.runner();
  await assert.rejects(runner.repair(request), hasCode('REPAIR_COMMIT_UNCERTAIN'));
  assert.equal(writesAfterFault, 0);
  assert.equal(calls, 0);
  assert.equal(runner.state(f.project.id).run?.status, 'interrupted');
  assert.equal(f.records.list(f.project.id).at(-1)!.rounds, 0);
  assert.equal((await f.runner().repair(request)).run?.status, 'interrupted');
});

test('unreadable uncertain terminal commit is not rewritten and its original uncertainty is surfaced', async (t) => {
  const f = fixture(t);
  f.write(valid);
  const save = f.records.save.bind(f.records);
  const list = f.records.list.bind(f.records);
  let unreadable = false;
  let terminalWrites = 0;
  f.records.list = (projectId) => {
    if (unreadable) throw new AppError('CORRUPT_REPAIR', 'synthetic unavailable readback');
    return list(projectId);
  };
  f.records.save = (projectId, run) => {
    save(projectId, run);
    if (run.status !== 'running') {
      terminalWrites++;
      unreadable = true;
      throw new AppError('REPAIR_COMMIT_UNCERTAIN', 'synthetic committed but unverified');
    }
  };
  const request = f.request();
  await assert.rejects(f.runner().repair(request), hasCode('REPAIR_COMMIT_UNCERTAIN'));
  assert.equal(terminalWrites, 1);
  unreadable = false;
  assert.equal(list(f.project.id).at(-1)!.status, 'succeeded');
  assert.equal((await f.runner().repair(request)).run?.status, 'succeeded');
});

test('other terminal save errors are surfaced unchanged and do not trigger a second terminal write', async (t) => {
  const f = fixture(t);
  f.write(valid);
  const save = f.records.save.bind(f.records);
  let terminalWrites = 0;
  f.records.save = (projectId, run) => {
    save(projectId, run);
    if (run.status !== 'running') {
      terminalWrites++;
      throw new AppError('REPAIR_IO', 'synthetic cleanup failure');
    }
  };
  await assert.rejects(f.runner().repair(f.request()), hasCode('REPAIR_IO'));
  assert.equal(terminalWrites, 1);
  assert.equal(f.records.list(f.project.id).at(-1)!.status, 'succeeded');
});

test('a successful-looking stale build response is never accepted as repair success', async (t) => {
  const f = fixture(t);
  f.write(valid);
  const old = f.request();
  const successful = await f.builds.build(old);
  const service = { build: async (): Promise<BuildResult> => successful, cancel: () => {} };
  const result = await f.runner(undefined, service).repair(f.request());
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run?.errorCode, 'STALE_SOURCE');
  assert.equal(result.run?.rounds, 0);
});

async function runtimeFixture(t: TestContext) {
  const f = fixture(t);
  f.write(valid);
  let probes = 0;
  let probe: () => Promise<RuntimeProbeResult> = async () => ({
    status: 'issues',
    issues: ['REFERENCE_ERROR'],
    observedMs: 1200,
  });
  const records = new RuntimeStore(f.projects);
  const runtime = new RuntimeService(f.projects, f.sources, f.tools, f.builds, records, {
    check: async () => {
      probes++;
      return probe();
    },
    open: async () => {
      throw new Error('Runtime repair must never replace the visible preview');
    },
  });
  const build = await f.builds.build(f.request());
  const report = await runtime.check({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: f.project.id,
    buildId: build.state.artifact!.id,
  });
  return {
    ...f,
    runtime,
    runtimeRecords: records,
    report,
    probes: () => probes,
    setProbe: (next: typeof probe) => {
      probe = next;
    },
    runtimeRequest: () => ({ ...f.request(), runtimeReportId: report.id }),
  };
}

test('runtime repair requires fresh observed issues and independently rechecks every successful compile', async (t) => {
  const f = await runtimeFixture(t);
  let calls = 0;
  f.models.toolTurn = async (messages) => {
    calls++;
    const feedback = JSON.parse(messages.at(-1)!.content!);
    assert.equal(feedback.type, 'observed_runtime_issues');
    assert.equal(feedback.issues[0].code, 'REFERENCE_ERROR');
    assert.equal(feedback.scope, 'isolated_startup_observation_only');
    assert.equal(f.records.list(f.project.id).at(-1)!.status, 'running');
    f.setProbe(async () => ({ status: 'observed', issues: [], observedMs: 1200 }));
    return turn(f.apply(valid.replace('useState(0)', 'useState(1)')));
  };
  const request = f.runtimeRequest();
  const result = await f.runner({ runtime: f.runtime }).repair(request);
  assert.equal(result.run?.status, 'succeeded');
  assert.equal(result.run?.builds, 2);
  assert.equal(result.run?.rounds, 1);
  assert.equal(f.probes(), 3);
  assert.equal(f.runtime.get(f.project.id, result.run!.runtimeResultId!)?.status, 'observed');
  assert.equal(JSON.parse(f.journal()).schemaVersion, 2);
  assert.equal((await f.runner({ runtime: f.runtime }).repair(request)).run?.status, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(f.probes(), 3);
});

test('nonreproducing runtime issue remains unresolved without a paid call or a false repair success', async (t) => {
  const f = await runtimeFixture(t);
  f.setProbe(async () => ({ status: 'observed', issues: [], observedMs: 1200 }));
  f.models.toolTurn = async () => assert.fail('no reproduced issue must not spend model calls');
  const result = await f.runner({ runtime: f.runtime }).repair(f.runtimeRequest());
  assert.equal(result.run?.status, 'no_progress');
  assert.equal(result.run?.errorCode, 'RUNTIME_NOT_REPRODUCED');
  assert.equal(result.run?.rounds, 0);
  assert.equal(result.run?.builds, 1);
});

test('runtime repair never promotes compiler success or model text over continuing runtime errors', async (t) => {
  const f = await runtimeFixture(t);
  let calls = 0;
  f.models.toolTurn = async () => {
    calls++;
    return stop();
  };
  const result = await f.runner({ runtime: f.runtime }).repair(f.runtimeRequest());
  assert.equal(result.run?.status, 'no_progress');
  assert.equal(result.run?.builds, 1);
  assert.equal(calls, 1);
  assert.equal(f.runtime.get(f.project.id, result.run!.runtimeResultId!)?.status, 'issues');
});

test('runtime repair retains the four-round five-build budget when code changes never repair startup', async (t) => {
  const f = await runtimeFixture(t);
  let calls = 0;
  f.models.toolTurn = async () =>
    turn(f.apply(valid.replace('useState(0)', `useState(${++calls})`)));
  const result = await f.runner({ runtime: f.runtime }).repair(f.runtimeRequest());
  assert.equal(result.run?.status, 'limited');
  assert.equal(result.run?.rounds, 4);
  assert.equal(result.run?.builds, 5);
  assert.equal(f.probes(), 6);
});

test('old or replaced runtime evidence cannot start a paid repair', async (t) => {
  const f = await runtimeFixture(t);
  f.models.toolTurn = async () => assert.fail('stale runtime evidence cannot spend');
  f.write(valid.replace('useState(0)', 'useState(4)'));
  await assert.rejects(
    f.runner({ runtime: f.runtime }).repair(f.runtimeRequest()),
    hasCode('STALE_RUNTIME'),
  );
  assert.equal(f.records.list(f.project.id).length, 0);
});

test('runtime repair cancellation stops a hanging probe and prevents late model work or success', async (t) => {
  const f = await runtimeFixture(t);
  const delayed = pending<RuntimeProbeResult>();
  const entered = pending<void>();
  f.setProbe(() => {
    entered.resolve();
    return delayed.promise;
  });
  f.models.toolTurn = async () => assert.fail('cancelled probe cannot spend');
  const runner = f.runner({ runtime: f.runtime });
  const operation = runner.repair(f.runtimeRequest());
  await entered.promise;
  runner.cancel();
  const result = await operation;
  assert.equal(result.run?.status, 'cancelled');
  delayed.resolve({ status: 'observed', issues: [], observedMs: 1200 });
  await setImmediate();
  assert.equal(f.runtime.get(f.project.id, result.run!.runtimeResultId!)?.status, 'cancelled');
  assert.equal(f.records.list(f.project.id).at(-1)!.status, 'cancelled');
});

test('successful runtime report from another build cannot satisfy repair', async (t) => {
  const f = await runtimeFixture(t);
  const runtime = {
    state: f.runtime.state.bind(f.runtime),
    get: f.runtime.get.bind(f.runtime),
    check: async () => ({
      ...f.report,
      status: 'observed' as const,
      issues: [],
      mode: 'check' as const,
    }),
  };
  f.models.toolTurn = async () => assert.fail('mismatched report cannot spend');
  const result = await f.runner({ runtime }).repair(f.runtimeRequest());
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run?.errorCode, 'STALE_RUNTIME');
});
