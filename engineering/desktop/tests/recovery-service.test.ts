import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProjectStore } from '../src/main/project-store';
import { PlanStore } from '../src/main/plan-store';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { CodingStore } from '../src/main/coding-store';
import { CodingRunner } from '../src/main/coding-runner';
import { RepairStore } from '../src/main/repair-store';
import { RepairRunner } from '../src/main/repair-runner';
import { BuildStore } from '../src/main/build-store';
import { BuildService } from '../src/main/build-service';
import { RecoveryService } from '../src/main/recovery-service';
import type { CodingRun } from '../src/shared/coding-contracts';
import { sourceHash } from '../src/main/source-protocol';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), '恢复 服务-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const sources = new SourceStore(projects);
  const tools = new SourceToolExecutor(projects, plans, sources);
  const records = new CodingStore(projects);
  const repairRecords = new RepairStore(projects);
  const model = {
    toolTurn: async () => {
      throw new Error('No model request permitted');
    },
  };
  const coding = new CodingRunner(records, sources, tools, model);
  const artifacts = new BuildStore(projects);
  const builds = new BuildService(projects, sources, tools, artifacts, async () => ({
    javascript: 'console.log("synthetic")',
    css: '',
    warnings: [],
  }));
  const repairs = new RepairRunner(repairRecords, sources, tools, model, builds);
  const recovery = new RecoveryService(
    projects,
    plans,
    sources,
    tools,
    coding,
    repairs,
    builds,
    artifacts,
  );
  let project = projects.create({ name: '合成恢复', idea: '检查点测试' });
  const requirement = {
    summary: '本地页面',
    audience: '自己',
    features: ['显示文字'],
    pages: ['首页'],
    data: ['文字'],
    outOfScope: ['联网'],
    questions: [],
    acceptance: ['显示文字'],
  };
  project = projects.saveRequirements(project.id, requirement);
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, {
    direction: '浅色',
    palette: ['#ffffff'],
    pages: [{ name: '首页', sections: ['文字'] }],
    notes: [],
  });
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
  const binding = tools.prepare(context).binding;
  const write = (text: string, requestId = randomUUID()) => {
    const snapshot = sources.get(project.id);
    sources.apply(project.id, {
      requestId,
      binding,
      expectedRevision: snapshot.revision,
      changes: [
        {
          operation: 'write',
          path: 'src/app.tsx',
          expectedHash: snapshot.files[0]?.sha256 ?? null,
          content: text,
        },
      ],
    });
    return requestId;
  };
  const restore = (targetRevision = 1) => ({
    schemaVersion: 1 as const,
    requestId: randomUUID(),
    ...context,
    sourceRevision: sources.get(project.id).revision,
    targetRevision,
  });
  return {
    root,
    projects,
    plans,
    sources,
    tools,
    records,
    coding,
    artifacts,
    builds,
    repairs,
    recovery,
    project,
    requirement,
    context,
    binding,
    write,
    restore,
  };
}

test('checkpoint restore appends code and leaves project, data, plans and previous successful artifact intact', async (t) => {
  const f = fixture(t);
  f.write('first');
  const buildId = randomUUID();
  await f.builds.build({ schemaVersion: 1, requestId: buildId, ...f.context, sourceRevision: 1 });
  f.write('second');
  const base = join(f.root, 'projects', f.project.id);
  const data = join(base, 'data', 'new.json');
  writeFileSync(data, '{"new":"保留"}');
  const manifest = readFileSync(join(base, 'project.json'));
  const state = f.recovery.state(f.project.id);
  assert.equal(state.checkpoints[1].buildId, buildId);
  assert.equal(state.checkpoints[1].canRestore, true);
  const request = f.restore();
  assert.equal(f.recovery.restore(request).revision, 3);
  assert.equal(f.sources.get(f.project.id).files[0].content, 'first');
  assert.equal(f.sources.at(f.project.id, 2).files[0].content, 'second');
  assert.equal(f.recovery.restore(request).replayed, true);
  assert.equal(readFileSync(data, 'utf8'), '{"new":"保留"}');
  assert.deepEqual(readFileSync(join(base, 'project.json')), manifest);
  assert.equal(f.artifacts.get(f.project.id, buildId).sourceRevision, 1);
  assert.equal(f.builds.state(f.project.id).status, 'stale');
});

test('stale source and nonexistent checkpoint cannot overwrite current code', (t) => {
  const f = fixture(t);
  f.write('one');
  const request = f.restore(0);
  f.write('two');
  assert.throws(() => f.recovery.restore(request), { code: 'SOURCE_CONFLICT' });
  assert.throws(() => f.recovery.restore(f.restore(99)), { code: 'CHECKPOINT_NOT_FOUND' });
  assert.equal(f.sources.get(f.project.id).revision, 2);
});

test('unconfirmed direction and archive block restore while allowing historical inspection', (t) => {
  const f = fixture(t);
  f.write('one');
  f.write('two');
  const request = f.restore();
  f.projects.archive(f.project.id, true);
  assert.ok(f.recovery.state(f.project.id).blockedReason);
  assert.throws(() => f.recovery.restore(request), { code: 'ARCHIVED' });
  f.projects.archive(f.project.id, false);
  f.projects.saveRequirements(f.project.id, { ...f.requirement, summary: '修改方向' });
  assert.ok(f.recovery.state(f.project.id).blockedReason);
  assert.throws(() => f.recovery.restore(request), { code: 'CONFIRMATION_REQUIRED' });
});

test('tool intent is reconciled using matching source receipt and never automatically dispatched', (t) => {
  const f = fixture(t);
  const toolId = randomUUID();
  f.write('committed', toolId);
  const now = new Date().toISOString();
  const run: CodingRun = {
    id: randomUUID(),
    requestHash: sourceHash('synthetic'),
    planRunId: f.context.planRunId,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    initialRevision: 0,
    rounds: 1,
    toolCalls: 2,
    toolRequests: [
      { callHash: sourceHash('write'), requestId: toolId },
      { callHash: sourceHash('read'), requestId: randomUUID() },
    ],
    errorCode: null,
  };
  f.records.save(f.project.id, run);
  const result = f.recovery.state(f.project.id).runs[0];
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(result.committedRevisions, [1]);
  assert.equal(result.unconfirmedTools, 1);
  assert.equal(f.sources.get(f.project.id).revision, 1);
});

test('fresh process detects missing source from retained build evidence instead of treating it as empty', async (t) => {
  const f = fixture(t);
  f.write('first');
  await f.builds.build({
    schemaVersion: 1,
    requestId: randomUUID(),
    ...f.context,
    sourceRevision: 1,
  });
  unlinkSync(join(f.root, 'projects', f.project.id, 'source', 'workspace.json'));
  const source = new SourceStore(f.projects);
  const recovery = new RecoveryService(
    f.projects,
    f.plans,
    source,
    new SourceToolExecutor(f.projects, f.plans, source),
    f.coding,
    f.repairs,
    f.builds,
    f.artifacts,
  );
  assert.throws(() => recovery.state(f.project.id), { code: 'RECOVERY_INCONSISTENT' });
});

test('cross-plan receipt is rejected and never represented as a completed tool', (t) => {
  const f = fixture(t);
  const id = f.write('first');
  const now = new Date().toISOString();
  f.records.save(f.project.id, {
    id: randomUUID(),
    requestHash: sourceHash('synthetic'),
    planRunId: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'running',
    initialRevision: 0,
    rounds: 1,
    toolCalls: 1,
    toolRequests: [{ callHash: sourceHash('call'), requestId: id }],
    errorCode: null,
  });
  assert.throws(() => f.recovery.state(f.project.id), { code: 'RECOVERY_INCONSISTENT' });
});

test('unknown restore fields and cross-project historical request are rejected', (t) => {
  const f = fixture(t);
  f.write('one');
  f.write('two');
  assert.throws(() => f.recovery.restore({ ...f.restore(), data: 'delete' }), {
    code: 'INVALID_INPUT',
  });
  const other = f.projects.create({ name: '另一个项目', idea: '不改动' });
  assert.throws(() => f.recovery.restore({ ...f.restore(), projectId: other.id }), {
    code: 'CONFIRMATION_REQUIRED',
  });
  assert.equal(f.sources.get(f.project.id).revision, 2);
});

test('lost restore acknowledgment is reconciled after confirmations change or project is archived', (t) => {
  const f = fixture(t);
  f.write('one');
  f.write('two');
  const request = f.restore();
  assert.equal(f.recovery.restore(request).revision, 3);
  f.projects.saveRequirements(f.project.id, { ...f.requirement, summary: '新方向' });
  assert.equal(f.recovery.restore(request).replayed, true);
  f.projects.archive(f.project.id, true);
  assert.equal(f.recovery.restore(request).replayed, true);
  assert.throws(() => f.recovery.restore({ ...request, targetRevision: 0 }), {
    code: 'REQUEST_CONFLICT',
  });
  assert.throws(() => f.recovery.restore({ ...request, planRunId: randomUUID() }), {
    code: 'REQUEST_CONFLICT',
  });
  assert.equal(f.sources.get(f.project.id).revision, 3);
});

test('restore cannot adopt an uncommitted model tool identity', (t) => {
  const f = fixture(t);
  f.write('one');
  f.write('two');
  const request = f.restore();
  const now = new Date().toISOString();
  f.records.save(f.project.id, {
    id: randomUUID(),
    requestHash: sourceHash('synthetic'),
    planRunId: f.context.planRunId,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    initialRevision: 2,
    rounds: 1,
    toolCalls: 1,
    toolRequests: [{ callHash: sourceHash('pending'), requestId: request.requestId }],
    errorCode: null,
  });
  assert.throws(() => f.recovery.restore(request), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.sources.get(f.project.id).revision, 2);
});
