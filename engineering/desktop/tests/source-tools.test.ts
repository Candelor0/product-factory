import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProjectStore } from '../src/main/project-store';
import { PlanStore } from '../src/main/plan-store';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { AppError } from '../src/main/validation';
import type {
  SourceToolContext,
  SourceToolRequest,
  SourceToolResponse,
} from '../src/shared/source-contracts';

const requirements = {
  summary: '可保存文章的博客',
  audience: '作者',
  features: ['保存文章'],
  pages: ['文章列表'],
  data: ['文章'],
  outOfScope: ['公网发布'],
  questions: [],
  acceptance: ['重开后仍有文章'],
};
const design = {
  direction: '浅色',
  palette: ['#ffffff'],
  pages: [{ name: '文章列表', sections: ['文章'] }],
  notes: [],
};
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), '工具 闭环-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const sources = new SourceStore(projects);
  const tools = new SourceToolExecutor(projects, plans, sources);
  function ready() {
    let p = projects.create({ name: '合成博客', idea: '仅测试源码协议，不运行生成代码' });
    p = projects.saveRequirements(p.id, requirements);
    p = projects.approveRequirements(p.id, p.requirements.at(-1)!.id);
    p = projects.saveDesign(p.id, design);
    p = projects.approveDesign(p.id, p.designs.at(-1)!.id);
    const run = plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: p.id,
      requirementId: p.requirements.at(-1)!.id,
      designId: p.designs.at(-1)!.id,
      profile: 'web',
    }).run!;
    return { projectId: p.id, planRunId: run.id };
  }
  return { root, projects, plans, sources, tools, ready };
}
const list = (): SourceToolRequest => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  tool: 'list_files',
  arguments: {},
});
const create = (content = 'export const title = "合成博客";'): SourceToolRequest => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  tool: 'apply_changes',
  arguments: {
    expectedRevision: 0,
    changes: [{ operation: 'write', path: 'src/app.tsx', expectedHash: null, content }],
  },
});
function success(value: SourceToolResponse) {
  assert.equal(value.ok, true, JSON.stringify(value));
  if (!value.ok) throw new Error('expected success');
  return value.data;
}
function failure(value: SourceToolResponse, code: string) {
  assert.equal(value.ok, false);
  if (value.ok) throw new Error('expected failure');
  assert.equal(value.error.code, code);
  return value;
}

test('confirmed plan routes create/list/read/delete through a real atomic source record and survives reopen', (t) => {
  const { root, projects, tools, ready } = fixture(t);
  const context = ready();
  const manifest = join(root, 'projects', context.projectId, 'project.json');
  const before = readFileSync(manifest);
  assert.deepEqual(success(tools.execute(context, list())), {
    tool: 'list_files',
    revision: 0,
    files: [],
  });
  const request = create('  export const title = "你好";\n');
  const committed = success(tools.execute(context, request));
  assert.equal(committed.tool, 'apply_changes');
  if (committed.tool !== 'apply_changes') throw new Error();
  assert.deepEqual(committed, {
    tool: 'apply_changes',
    revision: 1,
    previousRevision: 0,
    changedPaths: ['src/app.tsx'],
    replayed: false,
  });
  const reopened = new SourceToolExecutor(
    new ProjectStore(root),
    new PlanStore(projects),
    new SourceStore(projects),
  );
  const read = success(
    reopened.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'read_file',
      arguments: { path: 'src/app.tsx' },
    }),
  );
  assert.equal(read.tool, 'read_file');
  if (read.tool !== 'read_file') throw new Error();
  assert.equal(read.file.content, '  export const title = "你好";\n');
  assert.deepEqual(success(reopened.execute(context, request)), { ...committed, replayed: true });
  const listing = success(reopened.execute(context, list()));
  assert.equal(listing.tool, 'list_files');
  if (listing.tool !== 'list_files') throw new Error();
  assert.deepEqual(listing.files, [
    { path: read.file.path, sha256: read.file.sha256, bytes: Buffer.byteLength(read.file.content) },
  ]);
  const remove: SourceToolRequest = {
    schemaVersion: 1,
    requestId: randomUUID(),
    tool: 'apply_changes',
    arguments: {
      expectedRevision: 1,
      changes: [{ operation: 'delete', path: read.file.path, expectedHash: read.file.sha256 }],
    },
  };
  success(reopened.execute(context, remove));
  failure(
    reopened.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'read_file',
      arguments: { path: read.file.path },
    }),
    'SOURCE_NOT_FOUND',
  );
  assert.deepEqual(readFileSync(manifest), before);
  assert.equal(existsSync(join(root, 'projects', context.projectId, 'source', 'src')), false);
});

test('all tools and receipt replay stop after archive, new unconfirmed versions, or replaced current plan', (t) => {
  const { projects, plans, sources, tools, ready } = fixture(t);
  const context = ready();
  const request = create();
  success(tools.execute(context, request));
  const old = sources.get(context.projectId);
  projects.archive(context.projectId, true);
  for (const input of [request, list()]) failure(tools.execute(context, input), 'ARCHIVED');
  projects.archive(context.projectId, false);
  success(tools.execute(context, request));
  let p = projects.saveRequirements(context.projectId, {
    ...requirements,
    summary: '更新后的博客需求',
  });
  failure(tools.execute(context, request), 'CONFIRMATION_REQUIRED');
  failure(tools.execute(context, list()), 'CONFIRMATION_REQUIRED');
  p = projects.approveRequirements(p.id, p.requirements.at(-1)!.id);
  p = projects.saveDesign(p.id, design);
  p = projects.approveDesign(p.id, p.designs.at(-1)!.id);
  failure(tools.execute(context, request), 'STALE_PLAN');
  const run = plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: p.id,
    requirementId: p.requirements.at(-1)!.id,
    designId: p.designs.at(-1)!.id,
    profile: 'web',
  }).run!;
  failure(tools.execute(context, list()), 'STALE_PLAN');
  const newContext = { projectId: p.id, planRunId: run.id };
  failure(tools.execute(newContext, request), 'REQUEST_CONFLICT');
  success(tools.execute(newContext, list()));
  assert.deepEqual(sources.get(p.id), old);
});

test('model payload cannot select project, plan, credentials, host paths, shell, or build commands', (t) => {
  const { root, tools, ready, sources } = fixture(t);
  const first = ready();
  const second = ready();
  mkdirSync(join(root, 'credentials'));
  const sentinel = 'SYNTHETIC-NEVER-EXPOSED';
  writeFileSync(join(root, 'credentials', 'provider.json'), sentinel);
  for (const invalid of [
    { ...list(), projectId: second.projectId },
    { ...list(), planRunId: second.planRunId },
    { ...list(), arguments: { root: root } },
    { ...list(), tool: 'shell', arguments: { command: 'anything' } },
    { ...list(), tool: 'build', arguments: {} },
    ...['../credentials/provider.json', '/etc/passwd', 'src/../../credentials/provider.json'].map(
      (path) => ({ ...list(), tool: 'read_file', arguments: { path } }),
    ),
  ]) {
    const output = tools.execute(first, invalid);
    assert.equal(output.ok, false);
    assert.equal(JSON.stringify(output).includes(root), false);
    assert.equal(JSON.stringify(output).includes(sentinel), false);
  }
  failure(tools.execute({ ...first, planRunId: second.planRunId }, create()), 'STALE_PLAN');
  failure(tools.execute({ ...second, planRunId: first.planRunId }, create()), 'STALE_PLAN');
  assert.deepEqual(sources.get(first.projectId), { revision: 0, files: [] });
  assert.deepEqual(sources.get(second.projectId), { revision: 0, files: [] });
  assert.equal(readFileSync(join(root, 'credentials', 'provider.json'), 'utf8'), sentinel);
});

test('unconfirmed projects and missing plan cannot authorize any tool', (t) => {
  const { projects, tools, ready, plans } = fixture(t);
  const unconfirmed = projects.create({ name: '未确认', idea: '尚未确认的想法' });
  failure(
    tools.execute({ projectId: unconfirmed.id, planRunId: randomUUID() }, list()),
    'CONFIRMATION_REQUIRED',
  );
  const context = ready();
  failure(tools.execute({ ...context, planRunId: randomUUID() }, list()), 'STALE_PLAN');
  const snapshot = plans.get(context.projectId);
  assert.equal(snapshot.status, 'current');
});

test('source content is inert and tool failures never echo native exceptions or malformed request ids', (t) => {
  const { root, projects, plans, tools, ready } = fixture(t);
  const context = ready();
  const sentinel = join(root, 'executed-marker');
  success(
    tools.execute(
      context,
      create(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad');`),
    ),
  );
  assert.equal(existsSync(sentinel), false);
  const source = new SourceStore(projects);
  source.get = () => {
    throw new Error(`credential:${root}/SECRET`);
  };
  const broken = new SourceToolExecutor(projects, plans, source);
  const response = failure(broken.execute(context, list()), 'SOURCE_INTERNAL');
  assert.equal(JSON.stringify(response).includes(root), false);
  assert.equal(JSON.stringify(response).includes('SECRET'), false);
  source.get = () => {
    throw new AppError('CORRUPT_SOURCE', `sensitive:${root}`);
  };
  assert.equal(JSON.stringify(broken.execute(context, list())).includes(root), false);
  const malformed = failure(
    tools.execute(context, { ...list(), requestId: `secret:${root}` }),
    'INVALID_INPUT',
  );
  assert.equal(malformed.requestId, null);
  assert.equal(JSON.stringify(malformed).includes(root), false);
});

test('coding input includes full confirmed requirements, exclusions and visual direction without credentials or false completion', (t) => {
  const { tools, ready, projects } = fixture(t);
  const context = ready();
  const packet = tools.prepare(context);
  assert.deepEqual(packet.requirements.content, requirements);
  assert.deepEqual(packet.design.content, design);
  assert.equal(packet.execution, 'disabled');
  assert.equal(packet.sourceRevision, 0);
  assert.deepEqual(packet.capabilities, ['list_files', 'read_file', 'apply_changes']);
  assert.equal(packet.binding.planRunId, context.planRunId);
  assert.ok(
    packet.plan.tasks.every(
      (task) => task.implementation === 'pending' && task.verification === 'not_run',
    ),
  );
  packet.requirements.content.outOfScope.push('test-only-mutation');
  assert.deepEqual(tools.prepare(context).requirements.content.outOfScope, requirements.outOfScope);
  projects.saveRequirements(context.projectId, { ...requirements, audience: '新的用户' });
  assert.throws(
    () => tools.prepare(context),
    (error: unknown) => error instanceof AppError && error.code === 'CONFIRMATION_REQUIRED',
  );
});

test('a post-rename failure is reported as uncertain and retry through the tool confirms exactly one revision', (t) => {
  const { projects, plans, ready, sources } = fixture(t);
  const context = ready();
  const request = create();
  const faulted = new SourceToolExecutor(
    projects,
    plans,
    new SourceStore(projects, {
      afterRename() {
        throw new Error('SYNTHETIC_PRIVATE_NATIVE_ERROR');
      },
    }),
  );
  const response = failure(faulted.execute(context, request), 'SOURCE_COMMIT_UNCERTAIN');
  assert.equal(response.error.retryable, true);
  assert.equal(JSON.stringify(response).includes('SYNTHETIC_PRIVATE_NATIVE_ERROR'), false);
  const retried = success(
    new SourceToolExecutor(projects, plans, new SourceStore(projects)).execute(context, request),
  );
  assert.equal(retried.tool, 'apply_changes');
  if (retried.tool !== 'apply_changes') throw new Error();
  assert.equal(retried.replayed, true);
  assert.equal(retried.revision, 1);
  assert.equal(sources.get(context.projectId).revision, 1);
});
