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
import test from 'node:test';
import { parsePlanRequest } from '../src/main/development-plan.js';
import { PlanStore } from '../src/main/plan-store.js';
import { ProjectStore } from '../src/main/project-store.js';
import { AppError } from '../src/main/validation.js';
import type { DesignContent, Project, RequirementContent } from '../src/shared/contracts.js';
import type { PlanRequest, PlanRun } from '../src/shared/plan-contracts.js';

const requirements = (summary = '个人博客'): RequirementContent => ({
  summary,
  audience: '我与朋友',
  features: ['创建文章', '编辑文章'],
  pages: ['文章列表', '文章详情'],
  data: ['文章标题与正文'],
  outOfScope: ['公网发布'],
  questions: ['是否需要封面图？'],
  acceptance: ['保存后可查看文章', '重开后文章保留'],
});
const design = (): DesignContent => ({
  direction: '安静的阅读界面',
  palette: ['#224433', '#FFFFFF'],
  pages: [
    { name: '文章列表', sections: ['标题', '文章列表'] },
    { name: '文章详情', sections: ['标题', '正文'] },
  ],
  notes: ['保持文字可读'],
});

function fixture(t: { after: (callback: () => void) => void }) {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'factory-plan-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, '中文 空格 🌱', '项目资料');
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const file = (id: string) => join(root, 'projects', id, 'runs', 'development-plans.json');
  const ready = (name = '博客') => {
    let project = projects.create({ name, idea: '记录生活' });
    project = projects.saveRequirements(project.id, requirements(name));
    project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = projects.saveDesign(project.id, design());
    return projects.approveDesign(project.id, project.designs.at(-1)!.id);
  };
  return { root, projects, plans, file, ready };
}

function request(project: Project, profile: PlanRequest['profile'] = 'web'): PlanRequest {
  return {
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)?.id ?? randomUUID(),
    designId: project.designs.at(-1)?.id ?? randomUUID(),
    profile,
  };
}

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

test('only the latest explicitly confirmed requirements and design permit plan creation', (t) => {
  const { projects, plans, file } = fixture(t);
  let project = projects.create({ name: '博客', idea: '记录生活' });
  assert.equal(plans.get(project.id).status, 'empty');
  assert.throws(() => plans.create(request(project)), hasCode('CONFIRMATION_REQUIRED'));
  project = projects.saveRequirements(project.id, requirements());
  assert.throws(() => plans.create(request(project)), hasCode('CONFIRMATION_REQUIRED'));
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  assert.throws(() => plans.create(request(project)), hasCode('CONFIRMATION_REQUIRED'));
  project = projects.saveDesign(project.id, design());
  assert.throws(() => plans.create(request(project)), hasCode('CONFIRMATION_REQUIRED'));
  assert.equal(existsSync(file(project.id)), false);
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  assert.equal(plans.create(request(project)).status, 'current');
});

test('a persisted Web plan covers confirmed inputs without claiming any implementation or check passed', (t) => {
  const { root, projects, plans, file, ready } = fixture(t);
  const project = ready();
  const manifest = join(root, 'projects', project.id, 'project.json');
  const beforeManifest = readFileSync(manifest, 'utf8');
  const input = request(project);
  const state = plans.create(input);
  assert.equal(state.status, 'current');
  assert.ok(state.run);
  assert.equal(state.run.state, 'succeeded', 'only the planning stage has succeeded');
  assert.equal(state.run.request.requirementId, project.requirements.at(-1)!.id);
  assert.equal(state.run.request.designId, project.designs.at(-1)!.id);
  assert.match(state.run.inputHash, /^[a-f0-9]{64}$/u);
  assert.match(state.run.artifactHash, /^[a-f0-9]{64}$/u);
  const tasks = state.run.plan.tasks;
  assert.deepEqual(
    tasks.filter((item) => item.kind === 'feature').map((item) => item.title),
    requirements().features,
  );
  assert.deepEqual(
    tasks.filter((item) => item.kind === 'page').map((item) => item.title),
    requirements().pages,
  );
  assert.deepEqual(
    tasks.filter((item) => item.kind === 'data').map((item) => item.title),
    requirements().data,
  );
  assert.deepEqual(
    tasks.filter((item) => item.kind === 'acceptance').map((item) => item.title),
    requirements().acceptance,
  );
  assert.equal(new Set(tasks.map((item) => item.id)).size, tasks.length);
  for (const [index, task] of tasks.entries()) {
    assert.equal(task.implementation, 'pending');
    assert.equal(task.verification, 'not_run');
    assert.match(task.source, /^requirements\.(data|pages|features|acceptance)\[\d+\]$/u);
    assert.ok(
      task.dependsOn.every((id) =>
        tasks.slice(0, index).some((dependency) => dependency.id === id),
      ),
    );
  }
  assert.ok(state.run.plan.checks.length > 0);
  assert.ok(state.run.plan.checks.every((check) => check.status === 'not_run'));
  assert.ok(state.run.plan.components.every((component) => component.decision === '不适用'));
  assert.deepEqual(state.run.plan.openQuestions, requirements().questions);
  assert.deepEqual(state.run.plan.reviewNotes, []);
  assert.deepEqual(
    state.run.events.map((item) => item.sequence),
    [1, 2, 3],
  );
  assert.equal(readFileSync(manifest, 'utf8'), beforeManifest);
  assert.equal(projects.get(project.id).stage, 'ready');
  const bytes = readFileSync(file(project.id), 'utf8');
  const reopened = new PlanStore(new ProjectStore(root));
  assert.deepEqual(reopened.get(project.id), state);
  assert.equal(readFileSync(file(project.id), 'utf8'), bytes);
  assert.deepEqual(readdirSync(join(root, 'projects', project.id, 'runs')), [
    'development-plans.json',
  ]);
  if (process.platform !== 'win32') assert.equal(statSync(file(project.id)).mode & 0o777, 0o600);
});

test('requirement changes invalidate the plan while retaining immutable historical runs', (t) => {
  const { root, projects, plans, file, ready } = fixture(t);
  let project = ready();
  const originalRequest = request(project);
  const original = plans.create(originalRequest);
  const originalBytes = readFileSync(file(project.id), 'utf8');
  project = projects.saveRequirements(project.id, requirements('新的博客范围'));
  assert.equal(plans.get(project.id).status, 'stale');
  assert.deepEqual(plans.get(project.id).run, original.run);
  assert.equal(
    plans.create(originalRequest).status,
    'stale',
    'a transport retry returns its original outcome',
  );
  assert.equal(readFileSync(file(project.id), 'utf8'), originalBytes);
  assert.throws(() => plans.create(request(project)), hasCode('CONFIRMATION_REQUIRED'));
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, design());
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  assert.throws(
    () => plans.create({ ...originalRequest, requestId: randomUUID() }),
    hasCode('STALE_PLAN'),
  );
  const next = plans.create(request(project));
  assert.equal(next.status, 'current');
  assert.equal(next.history.length, 2);
  assert.notEqual(next.run!.inputHash, original.run!.inputHash);
  const persisted = JSON.parse(readFileSync(file(project.id), 'utf8')) as { runs: PlanRun[] };
  assert.deepEqual(persisted.runs[0], original.run);
  assert.deepEqual(new PlanStore(new ProjectStore(root)).get(project.id), next);
});

test('a new page direction independently invalidates the plan until that version is confirmed', (t) => {
  const { projects, plans, ready } = fixture(t);
  let project = ready();
  const old = plans.create(request(project));
  project = projects.saveDesign(project.id, { ...design(), direction: '新的页面方向' });
  assert.equal(plans.get(project.id).status, 'stale');
  assert.throws(() => plans.create(request(project)), hasCode('CONFIRMATION_REQUIRED'));
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  assert.equal(plans.get(project.id).status, 'stale');
  const next = plans.create(request(project));
  assert.equal(next.run!.request.requirementId, old.run!.request.requirementId);
  assert.notEqual(next.run!.request.designId, old.run!.request.designId);
  assert.notEqual(next.run!.inputHash, old.run!.inputHash);
});

test('identical request retries survive reopening; conflicting reuse cannot create another run', (t) => {
  const { root, plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  const original = plans.create(input);
  const before = readFileSync(file(project.id), 'utf8');
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.deepEqual(plans.create(reordered), original);
  const reopened = new PlanStore(new ProjectStore(root));
  assert.deepEqual(reopened.create(input), original);
  for (const changes of [
    { profile: 'agent' },
    { requirementId: randomUUID() },
    { designId: randomUUID() },
  ]) {
    assert.throws(() => reopened.create({ ...input, ...changes }), hasCode('REQUEST_CONFLICT'));
    assert.equal(readFileSync(file(project.id), 'utf8'), before);
  }
  assert.equal(reopened.get(project.id).history.length, 1);
});

test('project identities, revision references and plan files stay isolated', (t) => {
  const { plans, file, ready } = fixture(t);
  const first = ready('第一份博客');
  const second = ready('第二份博客');
  const firstRequest = request(first);
  const firstState = plans.create(firstRequest);
  assert.equal(plans.get(second.id).status, 'empty');
  const firstBytes = readFileSync(file(first.id), 'utf8');
  assert.throws(
    () => plans.create({ ...request(second), requirementId: firstRequest.requirementId }),
    hasCode('STALE_PLAN'),
  );
  assert.throws(
    () => plans.create({ ...request(second), designId: firstRequest.designId }),
    hasCode('STALE_PLAN'),
  );
  assert.equal(existsSync(file(second.id)), false);
  const secondState = plans.create({ ...request(second), requestId: firstRequest.requestId });
  assert.equal(secondState.run!.plan.summary, '第二份博客');
  assert.equal(firstState.run!.plan.summary, '第一份博客');
  assert.equal(readFileSync(file(first.id), 'utf8'), firstBytes);
  writeFileSync(file(second.id), firstBytes);
  assert.throws(() => plans.get(second.id), hasCode('CORRUPT_PLAN'));
  assert.deepEqual(plans.get(first.id), firstState);
});

test('archiving keeps readable history but denies plan creation until restored', (t) => {
  const { projects, plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  const baseline = plans.create(input);
  const before = readFileSync(file(project.id), 'utf8');
  projects.archive(project.id, true);
  assert.deepEqual(plans.get(project.id), baseline);
  assert.throws(() => plans.create(input), hasCode('ARCHIVED'));
  assert.throws(() => plans.create(request(project)), hasCode('ARCHIVED'));
  assert.equal(readFileSync(file(project.id), 'utf8'), before);
  projects.archive(project.id, false);
  assert.deepEqual(plans.create(input), baseline);
});

test('Agent rules are explicitly selected and unmatched pages become review notes rather than verified coverage', (t) => {
  const { projects, plans, ready } = fixture(t);
  let project = ready();
  project = projects.saveDesign(project.id, {
    ...design(),
    pages: [{ name: '关于作者', sections: ['介绍'] }],
  });
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const web = plans.create(request(project));
  const agent = plans.create(request(project, 'agent'));
  assert.notEqual(agent.run!.inputHash, web.run!.inputHash);
  assert.equal(agent.run!.plan.components.filter((item) => item.decision === '待确认').length, 14);
  assert.equal(agent.run!.plan.components.filter((item) => item.decision === '必选').length, 2);
  assert.ok(agent.run!.plan.reviewNotes.some((item) => item.includes('尚未分析')));
  assert.ok(web.run!.plan.reviewNotes.some((item) => item.includes('关于作者')));
  assert.ok(web.run!.plan.reviewNotes.some((item) => item.includes('文章列表')));
  assert.ok(
    agent.run!.plan.tasks.every(
      (task) => task.implementation === 'pending' && task.verification === 'not_run',
    ),
  );
  assert.equal(agent.history.length, 2);
});

test('plan requests reject unsupported fields, profiles, schema versions and path-shaped identifiers', (t) => {
  const { plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  for (const invalid of [
    null,
    [],
    'request',
    { ...input, apiKey: 'unknown' },
    { ...input, schemaVersion: '1' },
    { ...input, schemaVersion: 2 },
    { ...input, profile: 'blog' },
    { ...input, profile: ['web'] },
    { ...input, profile: new String('web') },
    { ...input, profile: { toString: () => 'web' } },
    ...['projectId', 'requestId', 'requirementId', 'designId'].flatMap((field) =>
      ['../credentials', '/etc/passwd', '..\\other', randomUUID().toUpperCase(), undefined].map(
        (value) => ({ ...input, [field]: value }),
      ),
    ),
  ]) {
    assert.throws(() => parsePlanRequest(invalid), hasCode('INVALID_INPUT'));
    assert.throws(() => plans.create(invalid), hasCode('INVALID_INPUT'));
  }
  assert.equal(existsSync(file(project.id)), false);
  for (const path of ['../credentials', '/etc/passwd', `${project.id}/../other`])
    assert.throws(() => plans.get(path), hasCode('INVALID_INPUT'));
});

test('corrupt or forged plan state is rejected without replacing the original bytes', (t) => {
  const { plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  plans.create(input);
  const path = file(project.id);
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  const mutations: ((value: any) => void)[] = [
    (value) => {
      value.unexpected = true;
    },
    (value) => {
      value.projectId = randomUUID();
    },
    (value) => {
      value.runs[0].unexpected = true;
    },
    (value) => {
      value.runs[0].id = '../elsewhere';
    },
    (value) => {
      value.runs[0].request.projectId = randomUUID();
    },
    (value) => {
      value.runs[0].request.requirementId = randomUUID();
    },
    (value) => {
      value.runs[0].inputHash = '0'.repeat(64);
    },
    (value) => {
      value.runs[0].artifactHash = '0'.repeat(64);
    },
    (value) => {
      value.runs[0].state = 'running';
    },
    (value) => {
      value.runs[0].createdAt = 'not a date';
    },
    (value) => {
      value.runs[0].plan.tasks[0].implementation = 'succeeded';
    },
    (value) => {
      value.runs[0].plan.checks[0].status = 'passed';
    },
    (value) => {
      value.runs[0].events[1].sequence = 1;
    },
    (value) => {
      value.runs[0].events.push(value.runs[0].events[0]);
    },
    (value) => {
      value.runs.push(structuredClone(value.runs[0]));
    },
    (value) => {
      const copy = structuredClone(value.runs[0]);
      copy.id = randomUUID();
      value.runs.push(copy);
    },
    (value) => {
      value.runs = Array(101).fill(value.runs[0]);
    },
  ];
  const invalidFiles = ['{"incomplete":', 'null', '[]'];
  for (const mutate of mutations) {
    const changed = structuredClone(baseline);
    mutate(changed);
    invalidFiles.push(JSON.stringify(changed));
  }
  for (const invalid of invalidFiles) {
    writeFileSync(path, invalid);
    assert.throws(() => plans.get(project.id), hasCode('CORRUPT_PLAN'));
    assert.throws(
      () => plans.create({ ...input, requestId: randomUUID() }),
      hasCode('CORRUPT_PLAN'),
    );
    assert.equal(readFileSync(path, 'utf8'), invalid);
  }
});

test('unknown persisted schema and rule revisions are preserved for compatible software', (t) => {
  const { plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  plans.create(input);
  const path = file(project.id);
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  for (const mutate of [
    (value: any) => {
      value.schemaVersion = 2;
    },
    (value: any) => {
      value.runs[0].adapterVersion = 'blueprint-rules-v2';
    },
    (value: any) => {
      value.runs[0].sourceRevision = 'future-source';
    },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    const bytes = JSON.stringify(changed);
    writeFileSync(path, bytes);
    assert.throws(() => plans.get(project.id), hasCode('UNSUPPORTED_PLAN'));
    assert.throws(() => plans.create(input), hasCode('UNSUPPORTED_PLAN'));
    assert.equal(readFileSync(path, 'utf8'), bytes);
  }
});

test('symlink plan files and symlink runs directories cannot redirect reads or writes', (t) => {
  const { root, plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  plans.create(input);
  const path = file(project.id);
  const outside = join(root, 'unrelated.json');
  renameSync(path, outside);
  const before = readFileSync(outside, 'utf8');
  symlinkSync(outside, path, 'file');
  assert.throws(() => plans.get(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => plans.create(input), hasCode('UNSAFE_PATH'));
  assert.equal(readFileSync(outside, 'utf8'), before);
  rmSync(path);
  renameSync(outside, path);
  const directory = join(root, 'projects', project.id, 'runs');
  const moved = join(root, 'moved-runs');
  renameSync(directory, moved);
  symlinkSync(moved, directory, 'dir');
  assert.throws(() => plans.get(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => plans.create(input), hasCode('UNSAFE_PATH'));
  assert.equal(readFileSync(join(moved, 'development-plans.json'), 'utf8'), before);
});

test('hardlinked and non-file plan records are rejected before mutation', (t) => {
  const { root, plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  plans.create(input);
  const path = file(project.id);
  const linked = join(root, 'hardlinked.json');
  linkSync(path, linked);
  const before = readFileSync(linked, 'utf8');
  assert.throws(() => plans.get(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => plans.create(input), hasCode('UNSAFE_PATH'));
  assert.equal(readFileSync(linked, 'utf8'), before);
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => plans.get(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => plans.create(input), hasCode('UNSAFE_PATH'));
});

test('oversized records are preserved and unfinished temporary records do not supersede committed plans', (t) => {
  const { root, plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  const baseline = plans.create(input);
  const path = file(project.id);
  const temporary = join(root, 'projects', project.id, 'runs', `.plan-${randomUUID()}.tmp`);
  writeFileSync(temporary, '{"partial":');
  assert.deepEqual(new PlanStore(new ProjectStore(root)).get(project.id), baseline);
  assert.equal(readFileSync(temporary, 'utf8'), '{"partial":');
  truncateSync(path, 16 * 1024 * 1024 + 1);
  const before = readFileSync(path);
  assert.throws(() => plans.get(project.id), hasCode('PLAN_LIMIT'));
  assert.throws(() => plans.create(input), hasCode('PLAN_LIMIT'));
  assert.deepEqual(readFileSync(path), before);
});

test('a record observed in this process cannot disappear and silently reset plan history', (t) => {
  const { root, plans, file, ready } = fixture(t);
  const project = ready();
  const input = request(project);
  const baseline = plans.create(input);
  const reopened = new PlanStore(new ProjectStore(root));
  assert.deepEqual(reopened.get(project.id), baseline);
  const path = file(project.id);
  const moved = join(root, 'moved-plan.json');
  renameSync(path, moved);
  const before = readFileSync(moved, 'utf8');
  for (const instance of [plans, reopened]) {
    assert.throws(() => instance.get(project.id), hasCode('MISSING_PLAN'));
    assert.throws(
      () => instance.create({ ...input, requestId: randomUUID() }),
      hasCode('MISSING_PLAN'),
    );
    assert.equal(existsSync(path), false);
  }
  assert.equal(readFileSync(moved, 'utf8'), before);
  renameSync(moved, path);
  assert.deepEqual(plans.get(project.id), baseline);
});

test('the run limit blocks new work while an existing request remains safely retryable', (t) => {
  const { plans, file, ready } = fixture(t);
  const project = ready();
  let last = request(project);
  for (let index = 0; index < 100; index += 1) {
    last = request(project);
    assert.equal(plans.create(last).history.length, index + 1);
  }
  const before = readFileSync(file(project.id), 'utf8');
  assert.throws(() => plans.create(request(project)), hasCode('PLAN_LIMIT'));
  assert.equal(plans.create(last).history.length, 100);
  assert.equal(readFileSync(file(project.id), 'utf8'), before);
});
