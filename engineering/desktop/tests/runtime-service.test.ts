import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BuildService } from '../src/main/build-service';
import { BuildStore } from '../src/main/build-store';
import { PlanStore } from '../src/main/plan-store';
import { ProjectStore } from '../src/main/project-store';
import { RuntimeService, type RuntimeExecutor } from '../src/main/runtime-service';
import { RuntimeStore } from '../src/main/runtime-store';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { AppError } from '../src/main/validation';
import type {
  RuntimeCheckRequest,
  RuntimeIssueCode,
  RuntimeProbeResult,
  RuntimeReport,
} from '../src/shared/runtime-contracts';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const observed = (): RuntimeProbeResult => ({ status: 'observed', observedMs: 1200, issues: [] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const requirements = {
  summary: '本地计数器',
  audience: '自己',
  features: ['计数'],
  pages: ['计数器'],
  data: ['临时数字'],
  outOfScope: ['外网'],
  questions: [],
  acceptance: ['可以点击'],
};

test('application and temporary preview reports keep independent late-error channels and durable modes', async (t) => {
  let previewIssue!: (code: RuntimeIssueCode) => void;
  let applicationIssue!: (code: RuntimeIssueCode) => void;
  const f = await fixture(t, {
    open: async (_artifact, onIssue) => {
      previewIssue = onIssue;
      return observed();
    },
    openApplication: async (_artifact, onIssue) => {
      applicationIssue = onIssue;
      return observed();
    },
  });
  const request = f.request();
  const preview = await f.service.open(request.projectId, request.buildId);
  const application = await f.service.openApplication(request.projectId, request.buildId);
  assert.equal(application.mode, 'application');
  previewIssue('TYPE_ERROR');
  applicationIssue('REFERENCE_ERROR');
  assert.deepEqual(f.service.get(request.projectId, preview.id)?.issues, ['TYPE_ERROR']);
  assert.deepEqual(f.service.get(request.projectId, application.id)?.issues, ['REFERENCE_ERROR']);
  const reopened = f.reopen();
  assert.equal(reopened.get(request.projectId, application.id)?.mode, 'application');
  assert.equal(reopened.get(request.projectId, application.id)?.status, 'issues');
});
const design = {
  direction: '浅色',
  palette: ['#ffffff'],
  pages: [{ name: '计数器', sections: ['数字'] }],
  notes: [],
};
test('application rejects an older build before executing or saving a report', async (t) => {
  let executions = 0;
  const f = await fixture(t, {
    openApplication: async () => {
      executions++;
      return observed();
    },
  });
  f.write('export default function App(){return <p>changed</p>;}');
  await assert.rejects(
    f.service.openApplication(f.project.id, f.artifact.id),
    hasCode('STALE_SOURCE'),
  );
  assert.equal(executions, 0);
  assert.equal(f.service.state(f.project.id).report, null);
});
async function fixture(
  t: TestContext,
  executor: Partial<RuntimeExecutor> = {},
  options: ConstructorParameters<typeof RuntimeStore>[1] = {},
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-runtime-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const sources = new SourceStore(projects);
  const tools = new SourceToolExecutor(projects, plans, sources);
  const artifacts = new BuildStore(projects);
  const builds = new BuildService(projects, sources, tools, artifacts, async () => ({
    javascript: 'synthetic compiled javascript',
    css: '',
    warnings: [],
  }));
  let project = projects.create({ name: '运行观察', idea: '合成测试' });
  project = projects.saveRequirements(project.id, requirements);
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, design);
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const context = {
    projectId: project.id,
    planRunId: plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      requirementId: project.requirements.at(-1)!.id,
      designId: project.designs.at(-1)!.id,
      profile: 'web',
    }).run!.id,
  };
  const write = (content = 'export default function App(){return null;}') => {
    const source = sources.get(project.id);
    const result = tools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: source.revision,
        changes: [
          {
            operation: 'write',
            path: 'src/app.tsx',
            expectedHash: source.files[0]?.sha256 ?? null,
            content,
          },
        ],
      },
    });
    assert.ok(result.ok);
  };
  write();
  const built = await builds.build({
    schemaVersion: 1,
    requestId: randomUUID(),
    ...context,
    sourceRevision: 1,
  });
  const artifact = builds.artifact(project.id, built.state.artifact!.id);
  const records = new RuntimeStore(projects, options);
  const effects: RuntimeExecutor = {
    check: async () => observed(),
    open: async () => observed(),
    ...executor,
  };
  const service = new RuntimeService(projects, sources, tools, builds, records, effects);
  const request = (): RuntimeCheckRequest => ({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    buildId: artifact.id,
  });
  const reopen = (replacement: Partial<RuntimeExecutor> = {}) => {
    const freshProjects = new ProjectStore(root);
    const freshSources = new SourceStore(freshProjects);
    const freshTools = new SourceToolExecutor(
      freshProjects,
      new PlanStore(freshProjects),
      freshSources,
    );
    const freshBuilds = new BuildService(
      freshProjects,
      freshSources,
      freshTools,
      new BuildStore(freshProjects),
    );
    return new RuntimeService(
      freshProjects,
      freshSources,
      freshTools,
      freshBuilds,
      new RuntimeStore(freshProjects),
      { ...effects, ...replacement },
    );
  };
  const file = join(root, 'projects', project.id, 'runs', 'runtime-reports.json');
  return {
    root,
    projects,
    plans,
    sources,
    tools,
    builds,
    records,
    effects,
    service,
    project,
    artifact,
    context,
    request,
    reopen,
    file,
    write,
  };
}
test('check persists intent before execution, returns bounded evidence and deduplicates after reopening', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    check: async (artifact) => {
      calls++;
      const saved = JSON.parse(readFileSync(f.file, 'utf8')).reports.at(-1);
      assert.equal(saved.status, 'observing');
      assert.equal(saved.buildId, artifact.id);
      return observed();
    },
  });
  assert.deepEqual(f.service.state(f.project.id), {
    projectId: f.project.id,
    report: null,
    current: false,
  });
  const input = f.request();
  const result = await f.service.check(input);
  assert.equal(calls, 1);
  assert.equal(result.status, 'observed');
  assert.equal(result.artifactHash, f.artifact.artifactHash);
  assert.equal(f.service.state(f.project.id).current, true);
  const before = readFileSync(f.file);
  assert.deepEqual(
    await f
      .reopen({
        check: async () => {
          throw new Error('must not run');
        },
      })
      .check(input),
    result,
  );
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(f.reopen().get(f.project.id, randomUUID()), null);
  assert.equal(f.sources.get(f.project.id).revision, 1);
});
test('same request identifier cannot switch builds or claim a preview report', async (t) => {
  const f = await fixture(t);
  const input = f.request();
  await f.service.check(input);
  await assert.rejects(
    f.service.check({ ...input, buildId: randomUUID() }),
    hasCode('REQUEST_CONFLICT'),
  );
  const preview = await f.service.open(f.project.id, f.artifact.id);
  await assert.rejects(
    f.service.check({ ...input, requestId: preview.id }),
    hasCode('REQUEST_CONFLICT'),
  );
});
test('an orphaned observing report becomes interrupted and same-ID retry never re-executes', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    check: async () => {
      calls++;
      return observed();
    },
  });
  const input = f.request();
  const now = new Date().toISOString();
  const intent: RuntimeReport = {
    id: input.requestId,
    buildId: f.artifact.id,
    artifactHash: f.artifact.artifactHash,
    ...f.tools.prepare(f.context).binding,
    sourceRevision: 1,
    sourceHash: f.artifact.sourceHash,
    mode: 'check',
    createdAt: now,
    updatedAt: now,
    status: 'observing',
    observedMs: 0,
    issues: [],
  };
  f.records.save(f.project.id, intent);
  const reopened = f.reopen();
  assert.equal(reopened.state(f.project.id).report!.status, 'interrupted');
  assert.equal((await reopened.check(input)).status, 'interrupted');
  assert.equal(calls, 0);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).reports[0].status, 'interrupted');
});
test('check requires current source; explicitly opening an old permitted build records current false', async (t) => {
  let checks = 0,
    opens = 0;
  const f = await fixture(t, {
    check: async () => {
      checks++;
      return observed();
    },
    open: async () => {
      opens++;
      return observed();
    },
  });
  f.write('export default function App(){return 2;}');
  await assert.rejects(f.service.check(f.request()), hasCode('STALE_SOURCE'));
  assert.equal(checks, 0);
  assert.equal(existsSync(f.file), false);
  const opened = await f.service.open(f.project.id, f.artifact.id);
  assert.equal(opened.status, 'observed');
  assert.equal(opens, 1);
  assert.equal(f.service.state(f.project.id).current, false);
});
test('direction change invalidates stored evidence and denies new old-build observations', async (t) => {
  const f = await fixture(t);
  await f.service.check(f.request());
  f.projects.saveRequirements(f.project.id, { ...requirements, summary: '方向已变更' });
  assert.equal(f.service.state(f.project.id).current, false);
  await assert.rejects(f.service.check(f.request()), hasCode('CONFIRMATION_REQUIRED'));
  await assert.rejects(
    f.service.open(f.project.id, f.artifact.id),
    hasCode('CONFIRMATION_REQUIRED'),
  );
});
test('cancellation is prompt even if executor ignores abort and late resolution cannot overwrite cancelled evidence', async (t) => {
  const pending = deferred<RuntimeProbeResult>();
  let signal: AbortSignal | undefined;
  const f = await fixture(t, {
    check: async (_artifact, given) => {
      signal = given;
      return pending.promise;
    },
  });
  const input = f.request();
  const running = f.service.check(input);
  assert.equal(f.service.state(f.project.id).report!.status, 'observing');
  await assert.rejects(f.service.check(f.request()), hasCode('BUSY'));
  f.service.cancel();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(signal!.aborted, true);
  const before = readFileSync(f.file);
  pending.resolve(observed());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal((await f.service.check(input)).status, 'cancelled');
});
test('an already-aborted caller persists cancellation without opening an executor', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    check: async () => {
      calls++;
      return observed();
    },
  });
  const controller = new AbortController();
  controller.abort();
  assert.equal((await f.service.check(f.request(), controller.signal)).status, 'cancelled');
  assert.equal(calls, 0);
});
test('fixed early and late preview issues persist once, and replaced preview callbacks cannot contaminate new reports', async (t) => {
  const callbacks: ((code: RuntimeIssueCode) => void)[] = [];
  const f = await fixture(t, {
    open: async (_artifact, issue) => {
      callbacks.push(issue);
      return observed();
    },
  });
  const first = await f.service.open(f.project.id, f.artifact.id);
  assert.deepEqual(first.issues, []);
  assert.equal(first.status, 'observed');
  callbacks[0]('REFERENCE_ERROR');
  callbacks[0]('TYPE_ERROR');
  assert.deepEqual(f.service.get(f.project.id, first.id)!.issues, [
    'REFERENCE_ERROR',
    'TYPE_ERROR',
  ]);
  const bytes = readFileSync(f.file);
  callbacks[0]('TYPE_ERROR');
  callbacks[0]('private raw text' as RuntimeIssueCode);
  assert.deepEqual(readFileSync(f.file), bytes);
  const second = await f.service.open(f.project.id, f.artifact.id);
  callbacks[0]('SCRIPT_ERROR');
  assert.equal(f.service.state(f.project.id).report!.id, second.id);
  assert.equal(f.service.state(f.project.id).report!.status, 'observed');
  callbacks[1]('UNHANDLED_REJECTION');
  assert.deepEqual(f.service.state(f.project.id).report!.issues, ['UNHANDLED_REJECTION']);
  assert.deepEqual(first.issues, [], 'returned report is a snapshot');
});
test('cancelled preview ignores late callbacks and does not manufacture issue reports', async (t) => {
  const pending = deferred<RuntimeProbeResult>();
  let callback!: (code: RuntimeIssueCode) => void;
  const f = await fixture(t, {
    open: async (_artifact, issue) => {
      callback = issue;
      return pending.promise;
    },
  });
  const opening = f.service.open(f.project.id, f.artifact.id);
  f.service.cancel();
  assert.equal((await opening).status, 'cancelled');
  const before = readFileSync(f.file);
  callback('TYPE_ERROR');
  pending.resolve({ status: 'issues', issues: ['REFERENCE_ERROR'], observedMs: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(readFileSync(f.file), before);
});
test('mid-check source or confirmation changes discard otherwise observed results as cancelled', async (t) => {
  for (const change of ['source', 'plan']) {
    const pending = deferred<RuntimeProbeResult>();
    const f = await fixture(t, { check: async () => pending.promise });
    const running = f.service.check(f.request());
    if (change === 'source') f.write('export default function App(){return 3;}');
    else f.projects.saveRequirements(f.project.id, { ...requirements, summary: '新方向' });
    pending.resolve(observed());
    assert.equal((await running).status, 'cancelled');
    assert.equal(f.service.state(f.project.id).current, false);
  }
});
test('post-rename uncertainty is accepted only after exact record readback', async (t) => {
  let writes = 0;
  const f = await fixture(
    t,
    {},
    {
      afterRename: () => {
        writes++;
        throw new Error('private path');
      },
    },
  );
  const result = await f.service.check(f.request());
  assert.equal(result.status, 'observed');
  assert.equal(writes, 2);
  assert.deepEqual(f.records.list(f.project.id), [result]);
  assert.equal(f.service.state(f.project.id).current, true);
});
test('failed intent persistence prevents execution and is surfaced by state', async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    {
      check: async () => {
        calls++;
        return observed();
      },
    },
    {
      beforeRename: () => {
        throw new Error('secret path');
      },
    },
  );
  await assert.rejects(f.service.check(f.request()), hasCode('RUNTIME_RECORD_IO'));
  assert.equal(calls, 0);
  assert.equal(existsSync(f.file), false);
  assert.throws(() => f.service.state(f.project.id), hasCode('RUNTIME_RECORD_IO'));
});
test('failed terminal persistence never writes a speculative second terminal result', async (t) => {
  let writes = 0;
  const f = await fixture(
    t,
    {},
    {
      beforeRename: () => {
        if (++writes === 2) throw new Error('secret');
      },
    },
  );
  const input = f.request();
  await assert.rejects(f.service.check(input), hasCode('RUNTIME_RECORD_IO'));
  assert.equal(writes, 2);
  assert.equal(f.records.list(f.project.id)[0].status, 'observing');
  assert.throws(() => f.service.get(f.project.id, input.requestId), hasCode('RUNTIME_RECORD_IO'));
  assert.equal((await f.reopen().check(input)).status, 'interrupted');
});
test('late issue persistence failure never throws from callback and remains visible through state/get', async (t) => {
  let writes = 0;
  let callback!: (code: RuntimeIssueCode) => void;
  const f = await fixture(
    t,
    {
      open: async (_artifact, issue) => {
        callback = issue;
        return observed();
      },
    },
    {
      beforeRename: () => {
        if (++writes === 3) throw new Error('secret');
      },
    },
  );
  const result = await f.service.open(f.project.id, f.artifact.id);
  assert.doesNotThrow(() => callback('TYPE_ERROR'));
  assert.throws(() => f.service.state(f.project.id), hasCode('RUNTIME_RECORD_IO'));
  assert.throws(() => f.service.get(f.project.id, result.id), hasCode('RUNTIME_RECORD_IO'));
  assert.equal(f.records.list(f.project.id)[0].status, 'observed');
});
test('executor failures and invalid raw categories are sanitized and leave an interrupted request without retry', async (t) => {
  for (const mode of ['throw', 'invalid']) {
    let calls = 0;
    const f = await fixture(t, {
      check: async () => {
        calls++;
        if (mode === 'throw') throw new Error('private-key-and-host-path');
        return {
          status: 'issues',
          issues: ['private-key-and-host-path' as RuntimeIssueCode],
          observedMs: 50,
        };
      },
    });
    const input = f.request();
    await assert.rejects(
      f.service.check(input),
      (error) =>
        hasCode('RUNTIME_CHECK_FAILED')(error) && !(error as Error).message.includes('private'),
    );
    assert.equal((await f.service.check(input)).status, 'interrupted');
    assert.equal(calls, 1);
    assert.equal(readFileSync(f.file, 'utf8').includes('private-key'), false);
  }
});
test('corrupt records block existing reports and new execution without silently resetting history', async (t) => {
  const f = await fixture(t);
  const input = f.request();
  await f.service.check(input);
  writeFileSync(f.file, '{"partial":');
  const bytes = readFileSync(f.file);
  assert.throws(() => f.service.state(f.project.id), hasCode('CORRUPT_RUNTIME_RECORD'));
  await assert.rejects(f.service.check(f.request()), hasCode('CORRUPT_RUNTIME_RECORD'));
  await assert.rejects(
    f.service.open(f.project.id, f.artifact.id),
    hasCode('CORRUPT_RUNTIME_RECORD'),
  );
  assert.deepEqual(readFileSync(f.file), bytes);
});

test('failed replacement candidates preserve monitoring of the previous accepted preview', async (t) => {
  for (const failure of ['issues', 'cancelled', 'throw']) {
    const callbacks: ((code: RuntimeIssueCode) => void)[] = [];
    const f = await fixture(t, {
      open: async (_artifact, issue) => {
        callbacks.push(issue);
        if (callbacks.length === 1) return observed();
        if (failure === 'throw') throw new Error('synthetic private failure');
        if (failure === 'cancelled') return { status: 'cancelled', issues: [], observedMs: 20 };
        issue('TYPE_ERROR');
        return { status: 'issues', issues: ['TYPE_ERROR'], observedMs: 20 };
      },
    });
    const accepted = await f.service.open(f.project.id, f.artifact.id);
    if (failure === 'throw')
      await assert.rejects(
        f.service.open(f.project.id, f.artifact.id),
        hasCode('RUNTIME_CHECK_FAILED'),
      );
    else assert.equal((await f.service.open(f.project.id, f.artifact.id)).status, failure);
    callbacks[0]('UNHANDLED_REJECTION');
    assert.deepEqual(f.service.get(f.project.id, accepted.id)!.issues, ['UNHANDLED_REJECTION']);
    callbacks[1]('SCRIPT_ERROR');
    assert.equal(f.service.state(f.project.id).report!.issues.includes('SCRIPT_ERROR'), false);
  }
});

test('a visible preview late error takes precedence over a separately saved successful check', async (t) => {
  let issue!: (code: RuntimeIssueCode) => void;
  const f = await fixture(t, {
    open: async (_artifact, callback) => {
      issue = callback;
      return observed();
    },
  });
  const visible = await f.service.open(f.project.id, f.artifact.id);
  const checked = await f.service.check(f.request());
  assert.equal(f.service.state(f.project.id).report!.id, checked.id);
  issue('TYPE_ERROR');
  const before = readFileSync(f.file);
  const state = f.service.state(f.project.id);
  assert.equal(state.report!.id, visible.id);
  assert.equal(state.report!.status, 'issues');
  assert.equal(state.current, true);
  assert.deepEqual(f.service.get(f.project.id, checked.id), checked);
  assert.deepEqual(
    readFileSync(f.file),
    before,
    'selecting recent activity does not reorder persisted history',
  );
  assert.deepEqual(
    f.records.list(f.project.id).map((report) => report.id),
    [visible.id, checked.id],
  );
  const controller = new AbortController();
  controller.abort();
  const cancelled = await f.service.check(f.request(), controller.signal);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(
    f.service.state(f.project.id).report!.id,
    cancelled.id,
    'a newer cancellation remains visible',
  );
});

test('late errors from an old-source preview cannot conceal a report for the current source', async (t) => {
  let issue!: (code: RuntimeIssueCode) => void;
  const f = await fixture(t, {
    open: async (_artifact, callback) => {
      issue = callback;
      return observed();
    },
  });
  const visible = await f.service.open(f.project.id, f.artifact.id);
  f.write('export default function App(){return 9;}');
  const built = await f.builds.build({
    schemaVersion: 1,
    requestId: randomUUID(),
    ...f.context,
    sourceRevision: 2,
  });
  const checked = await f.service.check({ ...f.request(), buildId: built.state.artifact!.id });
  issue('REFERENCE_ERROR');
  assert.equal(f.service.get(f.project.id, visible.id)!.status, 'issues');
  assert.equal(f.service.state(f.project.id).report!.id, checked.id);
  assert.equal(f.service.state(f.project.id).current, true);
  f.projects.saveRequirements(f.project.id, { ...requirements, summary: '尚未确认的新方向' });
  const historical = f.service.state(f.project.id);
  assert.equal(historical.current, false);
  assert.equal(
    historical.report!.id,
    visible.id,
    'without current reports, show the most recently active historical report',
  );
});
