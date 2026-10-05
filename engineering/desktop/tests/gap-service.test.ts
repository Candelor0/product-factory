import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GapService } from '../src/main/gap-service';
import { GapEvidenceStore } from '../src/main/gap-evidence-store';
import { ProjectStore } from '../src/main/project-store';
import { PlanStore } from '../src/main/plan-store';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { BuildStore } from '../src/main/build-store';
import { BuildService } from '../src/main/build-service';
import { RuntimeStore } from '../src/main/runtime-store';
import { RuntimeService } from '../src/main/runtime-service';
import { AppDataStore } from '../src/main/app-data-store';
import { assertExportContentsSafe } from '../src/main/export-security';
import { AppError } from '../src/main/validation';
import type { GapEvidenceRequest } from '../src/shared/gap-contracts';
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const requirement = {
  summary: '本地计数工具',
  audience: '自己',
  features: ['点击增加数字'],
  pages: ['计数器'],
  data: ['临时数字'],
  outOfScope: ['外网'],
  questions: [],
  acceptance: ['点击后数字加一'],
};
const design = {
  direction: '简洁浅色',
  palette: ['#ffffff'],
  pages: [{ name: '计数器', sections: ['数字', '按钮'] }],
  notes: [],
};
const source =
  "import {useState} from 'react';export default function App(){const[n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>数字{n}</button>}";
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-gap-service-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root),
    plans = new PlanStore(projects),
    sources = new SourceStore(projects),
    tools = new SourceToolExecutor(projects, plans, sources);
  let p = projects.create({ name: '合成计数器', idea: '用证据核对计数需求' });
  const id = p.id;
  const plan = () => {
    p = projects.saveRequirements(id, requirement);
    p = projects.approveRequirements(id, p.requirements.at(-1)!.id);
    p = projects.saveDesign(id, design);
    p = projects.approveDesign(id, p.designs.at(-1)!.id);
    return plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      requirementId: p.requirements.at(-1)!.id,
      designId: p.designs.at(-1)!.id,
      profile: 'web',
    }).run!;
  };
  let run = plan();
  const binding = () => ({
    planRunId: run.id,
    planInputHash: run.inputHash,
    planArtifactHash: run.artifactHash,
  });
  const write = (content = source) => {
    const s = sources.get(id);
    sources.apply(id, {
      requestId: randomUUID(),
      binding: binding(),
      expectedRevision: s.revision,
      changes: [
        {
          operation: 'write',
          path: 'src/app.tsx',
          expectedHash: s.files.find((f) => f.path === 'src/app.tsx')?.sha256 ?? null,
          content,
        },
      ],
    });
  };
  const builds = new BuildService(projects, sources, tools, new BuildStore(projects));
  let observations = 0;
  const runtime = new RuntimeService(projects, sources, tools, builds, new RuntimeStore(projects), {
    check: async () => {
      observations++;
      return { status: 'observed', observedMs: 1200, issues: [] };
    },
    open: async () => {
      throw new Error('unused');
    },
  });
  const evidence = new GapEvidenceStore(projects);
  const secret = 'synthetic-gap-private-key-no-account';
  const makeService = (store = evidence) =>
    new GapService(projects, plans, sources, builds, runtime, store, (contents) =>
      assertExportContentsSafe(contents, [secret]),
    );
  const service = makeService();
  const state = () => service.state({ projectId: id });
  const request = (overrides: Partial<GapEvidenceRequest> = {}): GapEvidenceRequest => ({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: id,
    binding: state().binding!,
    taskId: 'F001',
    verdict: 'passed',
    filePaths: ['src/app.tsx'],
    steps: '打开本地应用，点击增加按钮一次',
    expected: '数字从0变为1',
    actual: '数字显示1',
    ...overrides,
  });
  const build = () =>
    builds.build({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      planRunId: run.id,
      sourceRevision: sources.get(id).revision,
    });
  const replacePlan = () => {
    run = plan();
  };
  return {
    root,
    id,
    projects,
    plans,
    sources,
    tools,
    builds,
    runtime,
    evidence,
    service,
    state,
    request,
    write,
    build,
    replacePlan,
    makeService,
    secret,
    binding,
    observations: () => observations,
  };
}

test('empty report does not initialize evidence or business data', (t) => {
  const f = fixture(t);
  const p = f.projects.create({ name: '未确认', idea: '保留空报告' });
  const report = f.service.state({ projectId: p.id });
  assert.equal(report.status, 'empty');
  assert.equal(report.writable, false);
  assert.deepEqual(report.rows, []);
  assert.equal(
    readdirSync(join(f.root, 'projects', p.id, 'runs')).includes('gap-evidence.json'),
    false,
  );
  assert.equal(new AppDataStore(f.projects).inspect(p.id), null);
});

test('real compilation and synthetic startup observation never pass requirements', async (t) => {
  const f = fixture(t);
  f.write();
  const result = await f.build();
  assert.equal(result.status, 'succeeded');
  await f.runtime.check({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: f.id,
    buildId: result.state.artifact!.id,
  });
  const report = f.state();
  assert.ok(report.build);
  assert.equal(report.runtime?.status, 'observed');
  assert.equal(report.runtimeCurrent, true);
  assert.ok(report.rows.every((row) => row.verification === 'not_run'));
  assert.equal(report.mapping, 'absent');
  assert.equal(f.observations(), 1);
});

test('user evidence survives re-open and leaves plan/source/business data intact', async (t) => {
  const f = fixture(t);
  f.write();
  await f.build();
  const data = new AppDataStore(f.projects);
  data.apply(f.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    changes: [{ operation: 'put', key: 'private', value: '合成业务内容不应进入差距报告' }],
  });
  const before = { plan: f.plans.get(f.id), source: f.sources.get(f.id), data: data.inspect(f.id) };
  const report = f.service.record(f.request());
  const row = report.rows.find((row) => row.id === 'F001')!;
  assert.equal(row.verification, 'passed');
  assert.equal(row.record?.origin, 'user');
  assert.equal(row.implementation, 'linked');
  const fresh = f
    .makeService(new GapEvidenceStore(new ProjectStore(f.root)))
    .state({ projectId: f.id });
  assert.deepEqual(fresh, report);
  assert.deepEqual(
    { plan: f.plans.get(f.id), source: f.sources.get(f.id), data: data.inspect(f.id) },
    before,
  );
  assert.ok(!JSON.stringify(report).includes('合成业务内容不应进入差距报告'));
  assert.equal(f.observations(), 0);
});

test('pass requires current build and current source file', async (t) => {
  const f = fixture(t);
  f.write();
  assert.throws(() => f.service.record(f.request()), code('GAP_EVIDENCE_REQUIRED'));
  await f.build();
  assert.throws(
    () => f.service.record(f.request({ filePaths: [] })),
    code('GAP_EVIDENCE_REQUIRED'),
  );
  assert.throws(
    () => f.service.record(f.request({ filePaths: ['src/not-there.tsx'] })),
    code('GAP_FILE_MISSING'),
  );
  assert.equal(f.evidence.list(f.id).length, 0);
});

test('missing and failed observations append without erasing earlier records', (t) => {
  const f = fixture(t);
  let report = f.service.record(
    f.request({ verdict: 'missing', filePaths: [], actual: '尚无源码或增加按钮' }),
  );
  assert.equal(report.rows.find((row) => row.id === 'F001')!.implementation, 'missing');
  report = f.service.record(
    f.request({ verdict: 'failed', filePaths: [], actual: '未能执行计数操作' }),
  );
  assert.equal(report.rows.find((row) => row.id === 'F001')!.verification, 'failed');
  assert.equal(report.historyCount, 2);
});

test('stale input rejects and source restore cannot revive old passing evidence', async (t) => {
  const f = fixture(t);
  f.write();
  await f.build();
  const request = f.request();
  f.service.record(request);
  f.write(source + '\n// new revision');
  assert.equal(f.state().rows.find((row) => row.id === 'F001')!.verification, 'stale');
  assert.throws(() => f.service.record({ ...request, requestId: randomUUID() }), code('GAP_STALE'));
  f.sources.restore(f.id, {
    requestId: randomUUID(),
    binding: f.binding(),
    expectedRevision: f.sources.get(f.id).revision,
    targetRevision: 1,
  });
  await f.build();
  assert.equal(f.state().rows.find((row) => row.id === 'F001')!.verification, 'stale');
  assert.equal(f.evidence.list(f.id).length, 1);
});

test('rebuilding same source invalidates build-specific observation', async (t) => {
  const f = fixture(t);
  f.write();
  await f.build();
  const old = f.request();
  f.service.record(old);
  await f.build();
  assert.equal(f.state().rows.find((row) => row.id === 'F001')!.verification, 'stale');
  assert.throws(() => f.service.record({ ...old, requestId: randomUUID() }), code('GAP_STALE'));
});

test('exact uncertain retry reconciles after source changes; payload reuse conflicts', async (t) => {
  const f = fixture(t);
  f.write();
  await f.build();
  const old = f.request();
  f.service.record(old);
  f.write(source + '\n// later');
  assert.equal(f.service.record(old).historyCount, 1);
  assert.throws(
    () => f.service.record({ ...old, actual: 'changed observation' }),
    code('REQUEST_CONFLICT'),
  );
});

test('new plan cannot inherit old source evidence or reused task ID', async (t) => {
  const f = fixture(t);
  f.write();
  await f.build();
  f.service.record(f.request());
  f.replacePlan();
  const report = f.state();
  assert.equal(report.status, 'stale');
  assert.equal(report.writable, false);
  assert.ok(report.rows.every((row) => row.verification !== 'passed'));
  assert.throws(
    () => f.service.record(f.request({ verdict: 'missing', filePaths: [] })),
    code('GAP_STALE'),
  );
});

test('archive prevents writing but prior request can be reconciled', (t) => {
  const f = fixture(t);
  const input = f.request({ verdict: 'missing', filePaths: [] });
  f.service.record(input);
  f.projects.archive(f.id, true);
  assert.equal(f.state().writable, false);
  assert.equal(f.service.record(input).historyCount, 1);
  assert.throws(() => f.service.record({ ...input, requestId: randomUUID() }), code('ARCHIVED'));
});

test('wrong task, extra IPC fields and claimed model origin rejected', (t) => {
  const f = fixture(t);
  const input = f.request({ verdict: 'missing', filePaths: [] });
  assert.throws(() => f.service.record({ ...input, taskId: 'F099' }), code('INVALID_INPUT'));
  assert.throws(() => f.service.record({ ...input, origin: 'model' }), code('INVALID_INPUT'));
  assert.throws(
    () => f.service.state({ projectId: f.id, path: '/tmp/elsewhere' }),
    code('INVALID_INPUT'),
  );
});

test('configured and encoded key rejected before persistence with safe errors', (t) => {
  const f = fixture(t);
  for (const value of [
    f.secret,
    Buffer.from(f.secret).toString('base64'),
    encodeURIComponent(f.secret),
  ]) {
    assert.throws(
      () => f.service.record(f.request({ verdict: 'missing', filePaths: [], actual: value })),
      (e) => code('GAP_EVIDENCE_SENSITIVE')(e) && !String(e).includes(value),
    );
  }
  assert.equal(f.evidence.list(f.id).length, 0);
});

test('committed uncertain append reconciles without duplicating evidence', (t) => {
  const f = fixture(t);
  const store = new GapEvidenceStore(f.projects);
  const append = store.append.bind(store);
  store.append = (input) => {
    append(input);
    throw new AppError('GAP_EVIDENCE_COMMIT_UNCERTAIN', '核对请求');
  };
  const result = f.makeService(store).record(f.request({ verdict: 'missing', filePaths: [] }));
  assert.equal(result.historyCount, 1);
});

test('mapping metadata is not an implementation source file', (t) => {
  const f = fixture(t);
  f.write();
  const s = f.sources.get(f.id);
  f.sources.apply(f.id, {
    requestId: randomUUID(),
    binding: f.binding(),
    expectedRevision: s.revision,
    changes: [
      { operation: 'write', path: 'src/requirements.json', expectedHash: null, content: '{}' },
    ],
  });
  assert.throws(
    () => f.service.record(f.request({ verdict: 'failed', filePaths: ['src/requirements.json'] })),
    code('GAP_FILE_MISSING'),
  );
});
