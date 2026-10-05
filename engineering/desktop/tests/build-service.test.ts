import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BuildService, snapshotHash } from '../src/main/build-service';
import { BuildStore, buildArtifactHash } from '../src/main/build-store';
import { BuildRunStore } from '../src/main/build-run-store';
import { PlanStore } from '../src/main/plan-store';
import { ProjectStore } from '../src/main/project-store';
import { CompileFailure, compileSource } from '../src/main/source-compiler';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { AppError } from '../src/main/validation';
import type { BuildAttempt, BuildRequest, CompiledSource } from '../src/shared/build-contracts';
import type { SourceSnapshot, SourceToolContext } from '../src/shared/source-contracts';

const requirements = {
  summary: '本地计数器',
  audience: '自己',
  features: ['点击增加计数'],
  pages: ['计数器'],
  data: ['临时数字'],
  outOfScope: ['联网服务'],
  questions: [],
  acceptance: ['点击按钮后数字增加'],
};
const design = {
  direction: '简洁的单页工具',
  palette: ['#ffffff', '#24272b'],
  pages: [{ name: '计数器', sections: ['数字', '增加按钮'] }],
  notes: [],
};
const appSource = `import { useState } from 'react';
import './style.css';
export default function App() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>合成计数器 {count}</button>;
}`;
const compiled = (): CompiledSource => ({
  javascript: 'console.log("synthetic compiler output");',
  css: 'body { color: #24272b; }',
  warnings: [],
});
const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

function fixture(
  t: TestContext,
  compile?: typeof compileSource,
  journalOptions: ConstructorParameters<typeof BuildRunStore>[1] = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), '构建 协调器-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const sources = new SourceStore(projects);
  const tools = new SourceToolExecutor(projects, plans, sources);
  const builds = new BuildStore(projects);
  const journal = new BuildRunStore(projects, journalOptions);
  const service = new BuildService(projects, sources, tools, builds, compile, journal);
  function plan(projectId: string): SourceToolContext {
    const project = projects.get(projectId);
    const run = plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId,
      requirementId: project.requirements.at(-1)!.id,
      designId: project.designs.at(-1)!.id,
      profile: 'web',
    }).run!;
    return { projectId, planRunId: run.id };
  }
  function ready(): SourceToolContext {
    let project = projects.create({ name: '合成计数器', idea: '仅验证受控构建，不执行生成代码' });
    project = projects.saveRequirements(project.id, requirements);
    project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = projects.saveDesign(project.id, design);
    project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
    return plan(project.id);
  }
  function replacePlan(context: SourceToolContext): SourceToolContext {
    let project = projects.saveRequirements(context.projectId, {
      ...requirements,
      summary: '可调整步长的计数器',
    });
    project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = projects.saveDesign(project.id, design);
    project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
    return plan(project.id);
  }
  function write(
    context: SourceToolContext,
    files: Record<string, string> = {
      'src/app.tsx': appSource,
      'src/style.css': 'button { color: #24272b; }',
    },
  ): void {
    const snapshot = sources.get(context.projectId);
    const response = tools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: snapshot.revision,
        changes: Object.entries(files).map(([path, content]) => ({
          operation: 'write',
          path,
          content,
          expectedHash: snapshot.files.find((file) => file.path === path)?.sha256 ?? null,
        })),
      },
    });
    assert.equal(response.ok, true, JSON.stringify(response));
  }
  function request(
    context: SourceToolContext,
    overrides: Partial<BuildRequest> = {},
  ): BuildRequest {
    return {
      schemaVersion: 1,
      requestId: randomUUID(),
      ...context,
      sourceRevision: sources.get(context.projectId).revision,
      ...overrides,
    };
  }
  const buildFile = (projectId: string) => join(root, 'projects', projectId, 'runs', 'builds.json');
  return {
    root,
    projects,
    plans,
    sources,
    tools,
    builds,
    service,
    journal,
    ready,
    replacePlan,
    write,
    request,
    buildFile,
  };
}

function pendingCompiler() {
  let resolve!: (value: CompiledSource) => void;
  let reject!: (reason: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const result = new Promise<CompiledSource>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  let signal: AbortSignal | undefined;
  let captured: SourceSnapshot | undefined;
  const compile: typeof compileSource = (snapshot, options) => {
    signal = options?.signal;
    captured = structuredClone(snapshot);
    entered();
    return result;
  };
  return { compile, started, resolve, reject, signal: () => signal, snapshot: () => captured };
}

test('real compiler output binds the confirmed plan and exact source snapshot without promoting acceptance', async (t) => {
  const f = fixture(t);
  const context = f.ready();
  assert.deepEqual(f.service.state(context.projectId), {
    projectId: context.projectId,
    status: 'empty',
    artifact: null,
    preview: 'closed',
    previewBuildId: null,
  });
  f.write(context);
  const input = f.request(context);
  const source = f.sources.get(context.projectId);
  const bound = f.tools.prepare(context).binding;
  const manifest = join(f.root, 'projects', context.projectId, 'project.json');
  const planFile = join(f.root, 'projects', context.projectId, 'runs', 'development-plans.json');
  const beforeManifest = readFileSync(manifest);
  const beforePlan = readFileSync(planFile);
  const result = await f.service.build(input);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.state.status, 'current');
  assert.deepEqual(result.diagnostics, []);
  const artifact = f.builds.get(context.projectId, input.requestId);
  assert.equal(artifact.sourceRevision, source.revision);
  assert.equal(artifact.sourceHash, snapshotHash(source));
  assert.equal(artifact.planRunId, bound.planRunId);
  assert.equal(artifact.planInputHash, bound.planInputHash);
  assert.equal(artifact.planArtifactHash, bound.planArtifactHash);
  assert.equal(artifact.artifactHash, buildArtifactHash(artifact));
  assert.equal(artifact.templateVersion, 'react-preview-v1');
  assert.match(artifact.javascript, /合成计数器/u);
  assert.match(artifact.javascript, /runtime\.js/u);
  assert.match(artifact.css, /#24272b/u);
  assert.equal(Object.hasOwn(result.state.artifact!, 'javascript'), false);
  assert.equal(Object.hasOwn(result.state.artifact!, 'css'), false);
  assert.deepEqual(readFileSync(manifest), beforeManifest);
  assert.deepEqual(readFileSync(planFile), beforePlan);
  const plan = f.plans.get(context.projectId).run!.plan;
  assert.ok(
    plan.tasks.every(
      (item) => item.implementation === 'pending' && item.verification === 'not_run',
    ),
  );
  assert.ok(plan.checks.every((item) => item.status === 'not_run'));
  assert.equal(existsSync(join(f.root, 'projects', context.projectId, 'source', 'src')), false);
  const reopenedProjects = new ProjectStore(f.root);
  const reopenedSources = new SourceStore(reopenedProjects);
  const reopened = new BuildService(
    reopenedProjects,
    reopenedSources,
    new SourceToolExecutor(reopenedProjects, new PlanStore(reopenedProjects), reopenedSources),
    new BuildStore(reopenedProjects),
  );
  assert.deepEqual(reopened.state(context.projectId), result.state);
  assert.deepEqual(reopened.artifact(context.projectId, input.requestId), artifact);
});

test('a real syntax failure preserves the previous artifact and returns diagnostics without false completion', async (t) => {
  const f = fixture(t);
  const context = f.ready();
  f.write(context);
  const first = f.request(context);
  assert.equal((await f.service.build(first)).status, 'succeeded');
  const before = readFileSync(f.buildFile(context.projectId));
  f.write(context, { 'src/app.tsx': 'export default function App( {' });
  const result = await f.service.build(f.request(context));
  assert.equal(result.status, 'failed');
  assert.equal(result.state.status, 'stale');
  assert.equal(result.state.artifact!.id, first.requestId);
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every((item) => !item.message.includes(f.root)));
  assert.deepEqual(readFileSync(f.buildFile(context.projectId)), before);
  assert.equal(f.builds.list(context.projectId).length, 1);
  assert.equal(f.service.artifact(context.projectId, first.requestId).id, first.requestId);
});

test('cancellation discards a late successful compiler result and releases the busy slot', async (t) => {
  const pending = pendingCompiler();
  const f = fixture(t, pending.compile);
  const context = f.ready();
  f.write(context);
  const input = f.request(context);
  const running = f.service.build(input);
  await pending.started;
  assert.deepEqual(pending.snapshot(), f.sources.get(context.projectId));
  await assert.rejects(f.service.build(f.request(context)), hasCode('BUSY'));
  f.service.cancel();
  assert.equal(pending.signal()!.aborted, true);
  pending.resolve(compiled());
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.state.status, 'empty');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(existsSync(f.buildFile(context.projectId)), false);
  assert.equal((await f.service.build(f.request(context))).status, 'succeeded');
});

test('cancellation wins over a late compiler failure without saving diagnostics as an artifact', async (t) => {
  const pending = pendingCompiler();
  const f = fixture(t, pending.compile);
  const context = f.ready();
  f.write(context);
  const running = f.service.build(f.request(context));
  await pending.started;
  f.service.cancel();
  pending.reject(new CompileFailure([{ path: 'src/app.tsx', line: 1, message: '合成失败' }]));
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(f.builds.list(context.projectId), []);
});

test('source edits while compilation awaits prevent adoption of a late result', async (t) => {
  const pending = pendingCompiler();
  const f = fixture(t, pending.compile);
  const context = f.ready();
  f.write(context);
  const input = f.request(context);
  const running = f.service.build(input);
  await pending.started;
  f.write(context, { 'src/style.css': 'button { color: blue; }' });
  pending.resolve(compiled());
  await assert.rejects(running, hasCode('STALE_SOURCE'));
  assert.deepEqual(f.builds.list(context.projectId), []);
  assert.equal(f.sources.get(context.projectId).revision, input.sourceRevision + 1);
  assert.equal((await f.service.build(f.request(context))).status, 'succeeded');
});

test('new unconfirmed requirements while awaiting compilation block adoption', async (t) => {
  const pending = pendingCompiler();
  const f = fixture(t, pending.compile);
  const context = f.ready();
  f.write(context);
  const running = f.service.build(f.request(context));
  await pending.started;
  f.projects.saveRequirements(context.projectId, { ...requirements, audience: '家人' });
  pending.resolve(compiled());
  await assert.rejects(running, hasCode('CONFIRMATION_REQUIRED'));
  assert.deepEqual(f.builds.list(context.projectId), []);
});

test('replacement confirmed plan while awaiting compilation blocks adoption under the prior plan', async (t) => {
  const pending = pendingCompiler();
  const f = fixture(t, pending.compile);
  const context = f.ready();
  f.write(context);
  const running = f.service.build(f.request(context));
  await pending.started;
  const replacement = f.replacePlan(context);
  assert.notEqual(replacement.planRunId, context.planRunId);
  pending.resolve(compiled());
  await assert.rejects(running, hasCode('STALE_PLAN'));
  assert.deepEqual(f.builds.list(context.projectId), []);
});

test('archiving while awaiting compilation blocks persistence', async (t) => {
  const pending = pendingCompiler();
  const f = fixture(t, pending.compile);
  const context = f.ready();
  f.write(context);
  const running = f.service.build(f.request(context));
  await pending.started;
  f.projects.archive(context.projectId, true);
  pending.resolve(compiled());
  await assert.rejects(running, hasCode('ARCHIVED'));
  assert.deepEqual(f.builds.list(context.projectId), []);
});

test('older source output remains explicitly previewable for the same plan but not after changing direction', async (t) => {
  const f = fixture(t, async () => compiled());
  const context = f.ready();
  f.write(context);
  const first = f.request(context);
  await f.service.build(first);
  const artifact = f.service.artifact(context.projectId, first.requestId);
  f.write(context, { 'src/style.css': 'button { color: red; }' });
  assert.equal(f.service.state(context.projectId).status, 'stale');
  assert.deepEqual(f.service.artifact(context.projectId, first.requestId), artifact);
  const replacement = f.replacePlan(context);
  assert.equal(f.service.state(context.projectId).status, 'stale');
  assert.throws(
    () => f.service.artifact(context.projectId, first.requestId),
    hasCode('STALE_PLAN'),
  );
  assert.deepEqual(f.builds.get(context.projectId, first.requestId), artifact);
  const second = f.request(replacement);
  assert.equal((await f.service.build(second)).state.status, 'current');
  assert.equal(
    f.service.artifact(context.projectId, second.requestId).planRunId,
    replacement.planRunId,
  );
});

test('successful request retries are idempotent across reopening and a reused id cannot bind another source or plan', async (t) => {
  let calls = 0;
  const compile: typeof compileSource = async () => {
    calls += 1;
    return compiled();
  };
  const f = fixture(t, compile);
  const context = f.ready();
  f.write(context);
  const input = f.request(context);
  const result = await f.service.build(input);
  const before = readFileSync(f.buildFile(context.projectId));
  assert.deepEqual(await f.service.build(input), result);
  const reopened = new BuildService(
    f.projects,
    f.sources,
    f.tools,
    new BuildStore(f.projects),
    compile,
  );
  assert.deepEqual(await reopened.build(input), result);
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(f.buildFile(context.projectId)), before);
  f.write(context, { 'src/style.css': 'button { color: green; }' });
  await assert.rejects(
    f.service.build(f.request(context, { requestId: input.requestId })),
    hasCode('REQUEST_CONFLICT'),
  );
  const replacement = f.replacePlan(context);
  await assert.rejects(
    f.service.build(f.request(replacement, { requestId: input.requestId })),
    hasCode('REQUEST_CONFLICT'),
  );
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(f.buildFile(context.projectId)), before);
});

test('unconfirmed, archived, empty, stale-plan and stale-source requests never reach the compiler', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls += 1;
    return compiled();
  });
  const unconfirmed = f.projects.create({ name: '想法', idea: '未经确认' });
  await assert.rejects(
    f.service.build({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: unconfirmed.id,
      planRunId: randomUUID(),
      sourceRevision: 0,
    }),
    hasCode('CONFIRMATION_REQUIRED'),
  );
  const context = f.ready();
  await assert.rejects(f.service.build(f.request(context)), hasCode('EMPTY_SOURCE'));
  f.write(context);
  await assert.rejects(
    f.service.build(f.request(context, { planRunId: randomUUID() })),
    hasCode('STALE_PLAN'),
  );
  await assert.rejects(
    f.service.build(f.request(context, { sourceRevision: 0 })),
    hasCode('STALE_SOURCE'),
  );
  f.projects.archive(context.projectId, true);
  await assert.rejects(f.service.build(f.request(context)), hasCode('ARCHIVED'));
  assert.equal(calls, 0);
  assert.deepEqual(f.builds.list(context.projectId), []);
});

test('strict request schema rejects malformed identifiers, revisions and unexpected compiler arguments', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls += 1;
    return compiled();
  });
  const context = f.ready();
  f.write(context);
  const input = f.request(context);
  const invalid: unknown[] = [
    null,
    [],
    { ...input, schemaVersion: 2 },
    { ...input, requestId: '../private' },
    { ...input, projectId: '/private' },
    { ...input, planRunId: 'other' },
    { ...input, sourceRevision: -1 },
    { ...input, sourceRevision: 1.5 },
    { ...input, sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, compiler: 'custom' },
    { ...input, arguments: ['--plugin'] },
    { ...input, sourceRevision: undefined },
  ];
  for (const value of invalid)
    await assert.rejects(f.service.build(value), hasCode('INVALID_INPUT'));
  assert.equal(calls, 0);
  assert.deepEqual(f.builds.list(context.projectId), []);
});

test('compiler failure preserves prior bytes and only a new request retries compilation', async (t) => {
  let failure = false;
  const diagnostics = [{ path: 'src/app.tsx', line: 2, message: '源码语法无法编译，请检查此处。' }];
  const f = fixture(t, async () => {
    if (failure) throw new CompileFailure(diagnostics);
    return compiled();
  });
  const context = f.ready();
  f.write(context);
  const first = f.request(context);
  await f.service.build(first);
  const before = readFileSync(f.buildFile(context.projectId));
  const retry = f.request(context);
  failure = true;
  const failed = await f.service.build(retry);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.state.artifact!.id, first.requestId);
  assert.deepEqual(failed.diagnostics, diagnostics);
  assert.deepEqual(readFileSync(f.buildFile(context.projectId)), before);
  failure = false;
  assert.deepEqual(await f.service.build(retry), failed);
  assert.equal((await f.service.build(f.request(context))).status, 'succeeded');
  assert.equal(f.builds.list(context.projectId).length, 2);
});

function intent(f: ReturnType<typeof fixture>, input: BuildRequest): BuildAttempt {
  const now = new Date().toISOString();
  return {
    id: input.requestId,
    ...f.tools.prepare({ projectId: input.projectId, planRunId: input.planRunId }).binding,
    sourceRevision: input.sourceRevision,
    sourceHash: snapshotHash(f.sources.get(input.projectId)),
    createdAt: now,
    updatedAt: now,
    status: 'running',
    diagnostics: [],
    errorCode: null,
  };
}

test('compiler starts only after persisted intent and active inspection does not mark interruption', async (t) => {
  const pending = pendingCompiler();
  const f = fixture(t, pending.compile);
  const context = f.ready();
  f.write(context);
  const request = f.request(context);
  const running = f.service.build(request);
  await pending.started;
  assert.equal(new BuildRunStore(f.projects).list(context.projectId)[0].status, 'running');
  assert.equal(f.service.attempts(context.projectId)[0].status, 'running');
  pending.resolve(compiled());
  await running;
  const done = f.service.attempts(context.projectId)[0];
  assert.equal(done.id, request.requestId);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.sourceHash, f.builds.get(context.projectId, request.requestId).sourceHash);
});

test('an interrupted intent reopens once, never compiles for the same id, and permits an explicit new request', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return compiled();
  });
  const context = f.ready();
  f.write(context);
  const request = f.request(context);
  f.journal.save(context.projectId, intent(f, request));
  const attempts = f.service.attempts(context.projectId);
  assert.equal(attempts[0].status, 'interrupted');
  assert.equal(attempts[0].errorCode, 'BUILD_INTERRUPTED');
  assert.deepEqual(new BuildRunStore(f.projects).list(context.projectId), attempts);
  await assert.rejects(f.service.build(request), hasCode('BUILD_INTERRUPTED'));
  assert.equal(calls, 0);
  assert.equal((await f.service.build(f.request(context))).status, 'succeeded');
  assert.equal(calls, 1);
});

test('failure diagnostics survive reopen and a repeated failed request never invokes the compiler', async (t) => {
  let calls = 0;
  const diagnostics = [{ path: 'src/app.tsx', line: 2, message: '源码语法无法编译，请检查此处。' }];
  const compile: typeof compileSource = async () => {
    calls++;
    throw new CompileFailure(diagnostics);
  };
  const f = fixture(t, compile);
  const context = f.ready();
  f.write(context);
  const request = f.request(context);
  const failed = await f.service.build(request);
  const reopened = new BuildService(
    f.projects,
    f.sources,
    f.tools,
    new BuildStore(f.projects),
    compile,
  );
  assert.deepEqual(reopened.attempts(context.projectId)[0].diagnostics, diagnostics);
  assert.deepEqual(await reopened.build(request), failed);
  assert.equal(calls, 1);
});

test('artifact committed before journal result is recovered as success without recompilation', async (t) => {
  let writes = 0;
  let calls = 0;
  const compile: typeof compileSource = async () => {
    calls++;
    return compiled();
  };
  const f = fixture(t, compile, {
    beforeRename() {
      if (++writes === 2) throw new Error('SYNTHETIC_CRASH');
    },
  });
  const context = f.ready();
  f.write(context);
  const request = f.request(context);
  await assert.rejects(f.service.build(request), hasCode('BUILD_RUN_IO'));
  assert.equal(f.journal.list(context.projectId)[0].status, 'running');
  assert.equal(f.builds.list(context.projectId).length, 1);
  const beforeArtifact = readFileSync(f.buildFile(context.projectId));
  const reopened = new BuildService(
    f.projects,
    f.sources,
    f.tools,
    new BuildStore(f.projects),
    compile,
  );
  assert.equal(reopened.attempts(context.projectId)[0].status, 'succeeded');
  assert.equal((await reopened.build(request)).status, 'succeeded');
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(f.buildFile(context.projectId)), beforeArtifact);
});

test('uncertain intent and terminal writes are accepted only after exact journal reconciliation', async (t) => {
  let calls = 0;
  const f = fixture(
    t,
    async () => {
      calls++;
      return compiled();
    },
    {
      afterRename() {
        throw new Error('SYNTHETIC_FLUSH');
      },
    },
  );
  const context = f.ready();
  f.write(context);
  const request = f.request(context);
  assert.equal((await f.service.build(request)).status, 'succeeded');
  assert.equal(f.service.attempts(context.projectId)[0].status, 'succeeded');
  assert.equal(calls, 1);
});

test('uncertain result that cannot be confirmed is never rewritten as a guessed failure', async (t) => {
  const f = fixture(t, async () => compiled());
  const context = f.ready();
  f.write(context);
  const request = f.request(context);
  const save = f.journal.save.bind(f.journal);
  let calls = 0;
  f.journal.save = (id, value) => {
    calls++;
    if (value.status === 'succeeded')
      throw new AppError('BUILD_RUN_COMMIT_UNCERTAIN', '合成不确定');
    save(id, value);
  };
  await assert.rejects(f.service.build(request), hasCode('BUILD_RUN_COMMIT_UNCERTAIN'));
  assert.equal(calls, 2);
  assert.equal(f.journal.list(context.projectId)[0].status, 'running');
  assert.equal(f.builds.list(context.projectId).length, 1);
  const reopened = new BuildService(f.projects, f.sources, f.tools, new BuildStore(f.projects));
  assert.equal(reopened.attempts(context.projectId)[0].status, 'succeeded');
});

test('failure to persist the initial intent prevents all compiler side effects', async (t) => {
  let calls = 0;
  const f = fixture(
    t,
    async () => {
      calls++;
      return compiled();
    },
    {
      beforeRename() {
        throw new Error('SYNTHETIC_DISK_ERROR');
      },
    },
  );
  const context = f.ready();
  f.write(context);
  await assert.rejects(f.service.build(f.request(context)), hasCode('BUILD_RUN_IO'));
  assert.equal(calls, 0);
  assert.deepEqual(f.journal.list(context.projectId), []);
  assert.deepEqual(f.builds.list(context.projectId), []);
});

test('a same-id artifact with a mismatched source refuses recovery and leaves the intent unchanged', (t) => {
  const f = fixture(t);
  const context = f.ready();
  f.write(context);
  const request = f.request(context);
  const pending = intent(f, request);
  f.journal.save(context.projectId, pending);
  const output = compiled();
  f.builds.save(context.projectId, {
    ...output,
    schemaVersion: 1,
    id: request.requestId,
    projectId: context.projectId,
    createdAt: pending.createdAt,
    ...f.tools.prepare(context).binding,
    sourceRevision: request.sourceRevision + 1,
    sourceHash: pending.sourceHash,
    templateVersion: 'react-preview-v1',
    compilerVersion: 'esbuild-0.28.2',
    artifactHash: buildArtifactHash(output),
  });
  assert.throws(() => f.service.attempts(context.projectId), hasCode('BUILD_RUN_CONFLICT'));
  assert.deepEqual(f.journal.list(context.projectId), [pending]);
});

test('missing successful artifact is detected after a new service opens the journal', async (t) => {
  const f = fixture(t, async () => compiled());
  const context = f.ready();
  f.write(context);
  await f.service.build(f.request(context));
  rmSync(f.buildFile(context.projectId));
  const reopened = new BuildService(f.projects, f.sources, f.tools, new BuildStore(f.projects));
  assert.throws(() => reopened.attempts(context.projectId), hasCode('MISSING_BUILD'));
  assert.equal(f.journal.list(context.projectId)[0].status, 'succeeded');
});

test('matching artifact with a contradictory terminal status is rejected without rewriting either record', (t) => {
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const f = fixture(t);
    const context = f.ready();
    f.write(context);
    const request = f.request(context);
    const pending = intent(f, request);
    f.journal.save(context.projectId, pending);
    f.journal.save(context.projectId, {
      ...pending,
      status,
      errorCode:
        status === 'failed'
          ? 'BUILD_FAILED'
          : status === 'cancelled'
            ? 'BUILD_CANCELLED'
            : 'BUILD_INTERRUPTED',
    });
    const output = compiled();
    f.builds.save(context.projectId, {
      ...output,
      schemaVersion: 1,
      id: pending.id,
      projectId: context.projectId,
      createdAt: pending.createdAt,
      ...f.tools.prepare(context).binding,
      sourceRevision: pending.sourceRevision,
      sourceHash: pending.sourceHash,
      templateVersion: 'react-preview-v1',
      compilerVersion: 'esbuild-0.28.2',
      artifactHash: buildArtifactHash(output),
    });
    const journalFile = join(f.root, 'projects', context.projectId, 'runs', 'build-attempts.json');
    const journalBefore = readFileSync(journalFile);
    const artifactBefore = readFileSync(f.buildFile(context.projectId));
    assert.throws(() => f.service.attempts(context.projectId), hasCode('BUILD_RUN_CONFLICT'));
    assert.deepEqual(readFileSync(journalFile), journalBefore);
    assert.deepEqual(readFileSync(f.buildFile(context.projectId)), artifactBefore);
  }
});

test('native compiler errors persist only a fixed code and retain no secret text', async (t) => {
  const f = fixture(t, async () => {
    throw new Error('SYNTHETIC_SECRET /private/path');
  });
  const context = f.ready();
  f.write(context);
  await assert.rejects(f.service.build(f.request(context)));
  const records = f.journal.list(context.projectId);
  assert.equal(records[0].status, 'failed');
  assert.equal(records[0].errorCode, 'BUILD_FAILED');
  assert.equal(JSON.stringify(records).includes('SYNTHETIC_SECRET'), false);
});

for (const boundary of [
  'before-intent',
  'after-intent',
  'after-artifact',
  'after-result',
] as const) {
  test(`actual process exit at ${boundary} recovers persisted facts without replay`, async (t) => {
    const f = fixture(t);
    const context = f.ready();
    f.write(context);
    const request = f.request(context);
    const sourceFile = join(f.root, 'projects', context.projectId, 'source', 'workspace.json');
    const manifest = join(f.root, 'projects', context.projectId, 'project.json');
    const sourceBefore = readFileSync(sourceFile);
    const manifestBefore = readFileSync(manifest);
    const moduleUrl = (name: string) =>
      JSON.stringify(new URL(`../src/main/${name}.ts`, import.meta.url).href);
    const script = `
      import { ProjectStore } from ${moduleUrl('project-store')};
      import { PlanStore } from ${moduleUrl('plan-store')};
      import { SourceStore } from ${moduleUrl('source-store')};
      import { SourceToolExecutor } from ${moduleUrl('source-tools')};
      import { BuildStore } from ${moduleUrl('build-store')};
      import { BuildRunStore } from ${moduleUrl('build-run-store')};
      import { BuildService } from ${moduleUrl('build-service')};
      const projects = new ProjectStore(${JSON.stringify(f.root)});
      const source = new SourceStore(projects);
      const tools = new SourceToolExecutor(projects, new PlanStore(projects), source);
      const boundary = ${JSON.stringify(boundary)};
      let writes = 0;
      const journal = new BuildRunStore(projects, {
        beforeRename() {
          writes++;
          if ((writes === 1 && boundary === 'before-intent') || (writes === 2 && boundary === 'after-artifact')) process.exit(77);
        },
        afterRename() {
          if ((writes === 1 && boundary === 'after-intent') || (writes === 2 && boundary === 'after-result')) process.exit(77);
        }
      });
      const service = new BuildService(projects, source, tools, new BuildStore(projects), async () => ({ javascript: '/* synthetic compiler output */', css: '', warnings: [] }), journal);
      await service.build(${JSON.stringify(request)});
      process.exit(1);
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(child.status, 77, child.stderr);
    assert.deepEqual(readFileSync(sourceFile), sourceBefore);
    assert.deepEqual(readFileSync(manifest), manifestBefore);
    let calls = 0;
    const reopened = new BuildService(
      f.projects,
      f.sources,
      f.tools,
      new BuildStore(f.projects),
      async () => {
        calls++;
        return compiled();
      },
    );
    const attempts = reopened.attempts(context.projectId);
    if (boundary === 'before-intent') {
      assert.deepEqual(attempts, []);
      assert.deepEqual(f.builds.list(context.projectId), []);
    } else if (boundary === 'after-intent') {
      assert.equal(attempts[0].status, 'interrupted');
      await assert.rejects(reopened.build(request), hasCode('BUILD_INTERRUPTED'));
    } else {
      assert.equal(attempts[0].status, 'succeeded');
      assert.equal((await reopened.build(request)).status, 'succeeded');
      assert.equal(f.builds.list(context.projectId).length, 1);
    }
    assert.equal(calls, 0);
    assert.deepEqual(readFileSync(sourceFile), sourceBefore);
    assert.deepEqual(readFileSync(manifest), manifestBefore);
  });
}
