import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deriveGapReport } from '../src/main/gap-report';
import { sourceHash } from '../src/main/source-protocol';
import type { GapBinding, GapEvidence } from '../src/shared/gap-contracts';
import type { BuildSummary } from '../src/shared/build-contracts';
import type { PlanTask } from '../src/shared/plan-contracts';
import { codingPrompt, codingTools } from '../src/main/coding-tool-schema';

type Input = Parameters<typeof deriveGapReport>[0];
const task = (id: string, kind: PlanTask['kind'] = 'feature'): PlanTask => ({
  id,
  kind,
  title: `合成任务${id}`,
  source: 'requirements.features[0]',
  dependsOn: [],
  implementation: 'pending',
  verification: 'not_run',
});
function fixture(): Input {
  const projectId = randomUUID(),
    planId = randomUUID();
  const planBinding = {
    planRunId: planId,
    planInputHash: 'a'.repeat(64),
    planArtifactHash: 'b'.repeat(64),
  };
  const content = 'export default function App(){return null}';
  const source = {
    revision: 1,
    files: [{ path: 'src/app.tsx', content, sha256: sourceHash(content) }],
  };
  const artifact: BuildSummary = {
    schemaVersion: 1,
    id: randomUUID(),
    projectId,
    createdAt: '2026-10-05T00:00:00.000Z',
    ...planBinding,
    sourceRevision: source.revision,
    sourceHash: sourceHash(JSON.stringify(source)),
    artifactHash: 'c'.repeat(64),
    templateVersion: 'react-preview-v1',
    compilerVersion: 'esbuild-0.28.2',
    warnings: [],
  };
  return {
    projectId,
    archived: false,
    source,
    sourceBinding: planBinding,
    plan: {
      status: 'current',
      history: [],
      run: {
        schemaVersion: 1,
        id: planId,
        inputHash: planBinding.planInputHash,
        artifactHash: planBinding.planArtifactHash,
        createdAt: artifact.createdAt,
        request: {
          schemaVersion: 1,
          requestId: planId,
          projectId,
          requirementId: randomUUID(),
          designId: randomUUID(),
          profile: 'web',
        },
        adapterVersion: 'blueprint-rules-v1',
        sourceRevision: 'synthetic',
        state: 'succeeded',
        events: [
          { sequence: 1, type: 'stage.completed', stage: 'binding' },
          { sequence: 2, type: 'stage.completed', stage: 'rules' },
          { sequence: 3, type: 'stage.completed', stage: 'tasks' },
        ],
        plan: {
          summary: '合成计划',
          profile: 'web',
          tasks: [
            task('F001'),
            task('P001', 'page'),
            task('D001', 'data'),
            task('A001', 'acceptance'),
          ],
          openQuestions: [],
          reviewNotes: [],
          components: [],
          checks: [],
        },
      },
    },
    build: { projectId, status: 'current', artifact, preview: 'closed', previewBuildId: null },
    runtime: {
      projectId,
      current: true,
      report: {
        id: randomUUID(),
        ...planBinding,
        buildId: artifact.id,
        artifactHash: artifact.artifactHash,
        sourceRevision: artifact.sourceRevision,
        sourceHash: artifact.sourceHash,
        mode: 'check',
        createdAt: artifact.createdAt,
        updatedAt: artifact.createdAt,
        status: 'observed',
        observedMs: 1200,
        issues: [],
      },
    },
    evidence: [],
  };
}
function updateTechnicalBinding(input: Input) {
  const hash = sourceHash(JSON.stringify(input.source));
  if (input.build.artifact)
    Object.assign(input.build.artifact, {
      sourceRevision: input.source.revision,
      sourceHash: hash,
    });
  if (input.runtime.report)
    Object.assign(input.runtime.report, {
      sourceRevision: input.source.revision,
      sourceHash: hash,
    });
}
function mapping(
  input: Input,
  rows: unknown = [{ taskId: 'F001', files: ['src/app.tsx'] }],
  extra: object = {},
) {
  const content = JSON.stringify({
    schemaVersion: 1,
    planRunId: input.plan.run!.id,
    requirements: rows,
    ...extra,
  });
  input.source.files = input.source.files.filter((file) => file.path !== 'src/requirements.json');
  input.source.files.push({ path: 'src/requirements.json', content, sha256: sourceHash(content) });
  updateTechnicalBinding(input);
}
function evidence(
  input: Input,
  verdict: GapEvidence['request']['verdict'] = 'passed',
  options: { binding?: Partial<GapBinding>; files?: string[]; taskId?: string } = {},
): GapEvidence {
  const binding = deriveGapReport({ ...input, evidence: [] }).binding!;
  return {
    id: randomUUID(),
    createdAt: '2026-10-05T00:00:01.000Z',
    origin: 'user',
    request: {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: input.projectId,
      binding: { ...binding, ...options.binding },
      taskId: options.taskId ?? 'F001',
      verdict,
      filePaths: options.files ?? ['src/app.tsx'],
      steps: '点击合成按钮',
      expected: '显示合成结果',
      actual: '实际合成观察',
    },
  };
}

test('empty plan yields no writable binding or rows, preserving history count and selectable source', () => {
  const input = fixture();
  mapping(input);
  input.evidence = [evidence(input)];
  input.plan = { status: 'empty', run: null, history: [] };
  const result = deriveGapReport(input);
  assert.equal(result.status, 'empty');
  assert.equal(result.writable, false);
  assert.equal(result.binding, null);
  assert.deepEqual(result.rows, []);
  assert.equal(result.build, null);
  assert.equal(result.runtime, null);
  assert.deepEqual(result.sourceFiles, ['src/app.tsx']);
  assert.equal(result.historyCount, 1);
});

test('current technical evidence never promotes unlinked or model-linked tasks to business verified', () => {
  const input = fixture();
  mapping(input);
  const result = deriveGapReport(input);
  assert.equal(result.status, 'current');
  assert.equal(result.writable, true);
  assert.equal(result.mapping, 'valid');
  assert.equal(result.rows[0]!.implementation, 'linked');
  assert.ok(result.rows.every((row) => row.verification === 'not_run'));
  assert.equal(result.rows[1]!.implementation, 'unlinked');
  assert.equal(result.build?.id, input.build.artifact!.id);
  assert.equal(result.runtimeCurrent, true);
  assert.equal(result.runtime?.status, 'observed');
});

test('missing model-declared files are visible clues without asserting missing implementation', () => {
  const input = fixture();
  mapping(input, [{ taskId: 'F001', files: ['src/absent.tsx'] }]);
  const row = deriveGapReport(input).rows[0]!;
  assert.equal(row.implementation, 'unlinked');
  assert.equal(row.verification, 'not_run');
  assert.deepEqual(row.missingPaths, ['src/absent.tsx']);
  assert.deepEqual(row.files, []);
});

test('malformed declarations are ignored atomically with a fixed note and no hostile content reflected', () => {
  const invalid = [
    null,
    [],
    { schemaVersion: 1 },
    { schemaVersion: 2, planRunId: randomUUID(), requirements: [] },
    { schemaVersion: 1, planRunId: randomUUID(), requirements: [] },
    { schemaVersion: 1, planRunId: 'credential sentinel', requirements: [] },
  ];
  for (const declaration of invalid) {
    const input = fixture(),
      content = JSON.stringify(declaration);
    input.source.files.push({
      path: 'src/requirements.json',
      content,
      sha256: sourceHash(content),
    });
    const report = deriveGapReport(input);
    assert.equal(report.mapping, 'invalid');
    assert.equal(report.mappingNotes.length, 1);
    assert.ok(!JSON.stringify(report.mappingNotes).includes('sentinel'));
    assert.ok(report.rows.every((row) => row.files.length === 0 && row.verification === 'not_run'));
  }
  const input = fixture();
  mapping(input);
  input.source.files.at(-1)!.content = '{secret sentinel';
  assert.equal(deriveGapReport(input).mapping, 'invalid');
});

test('mapping rejects unknown fields, invented task IDs, duplicates, traversal, sensitive keys and self-linking', () => {
  for (const rows of [
    [{ taskId: 'F001', files: ['src/app.tsx'], verdict: 'passed' }],
    [{ taskId: 'F999', files: ['src/app.tsx'] }],
    [{ taskId: 'f001', files: ['src/app.tsx'] }],
    [
      { taskId: 'F001', files: ['src/app.tsx'] },
      { taskId: 'F001', files: [] },
    ],
    [{ taskId: 'F001', files: ['src/app.tsx', 'src/app.tsx'] }],
    [{ taskId: 'F001', files: ['../credentials/provider.json'] }],
    [{ taskId: 'F001', files: ['src/requirements.json'] }],
    [
      { taskId: 'F001', files: ['src/app.tsx'] },
      { taskId: 'P001', files: ['/private/source.ts'] },
    ],
    [JSON.parse('{"taskId":"F001","files":[],"__proto__":{}}')],
  ]) {
    const input = fixture();
    mapping(input, rows);
    const report = deriveGapReport(input);
    assert.equal(report.mapping, 'invalid');
    assert.ok(report.rows.every((row) => !row.files.length));
  }
  const input = fixture();
  mapping(input, [], { passed: true });
  assert.equal(deriveGapReport(input).mapping, 'invalid');
});

test('mapping supports all 200 plan tasks and caps each row at 32 unique source paths', () => {
  const input = fixture();
  input.plan.run!.plan.tasks = ['P', 'F', 'D', 'A'].flatMap((prefix) =>
    Array.from({ length: 50 }, (_, n) => task(`${prefix}${String(n + 1).padStart(3, '0')}`)),
  );
  const rows = input.plan.run!.plan.tasks.map((item) => ({ taskId: item.id, files: [] }));
  mapping(input, rows);
  assert.equal(deriveGapReport(input).mapping, 'valid');
  assert.equal(deriveGapReport(input).rows.length, 200);
  mapping(input, [...rows, { taskId: 'F001', files: [] }]);
  assert.equal(deriveGapReport(input).mapping, 'invalid');
  const files = Array.from({ length: 32 }, (_, n) => `src/file${n}.tsx`);
  mapping(input, [{ taskId: 'F001', files }]);
  assert.equal(deriveGapReport(input).mapping, 'valid');
  mapping(input, [{ taskId: 'F001', files: [...files, 'src/extra.tsx'] }]);
  assert.equal(deriveGapReport(input).mapping, 'invalid');
});

test('mapping raw file size and duplicate reserved filenames are rejected without partial association', () => {
  const input = fixture();
  mapping(input);
  input.source.files.at(-1)!.content = ' '.repeat(128 * 1024 + 1);
  assert.equal(deriveGapReport(input).mapping, 'invalid');
  mapping(input);
  input.source.files.push({ ...input.source.files.at(-1)! });
  assert.equal(deriveGapReport(input).mapping, 'invalid');
});

test('applicable user passed and failed records remain distinct from technical runtime results', () => {
  for (const verdict of ['passed', 'failed'] as const) {
    const input = fixture();
    input.evidence = [evidence(input, verdict)];
    input.runtime.report!.status = 'issues';
    input.runtime.report!.issues = ['TYPE_ERROR'];
    const result = deriveGapReport(input);
    assert.equal(result.rows[0]!.verification, verdict);
    assert.equal(result.rows[0]!.implementation, 'linked');
    assert.equal(result.runtime!.status, 'issues');
    assert.equal(result.runtimeCurrent, true);
    assert.ok(result.rows.slice(1).every((row) => row.verification === 'not_run'));
  }
});

test('a current user missing verdict overrides model linkage without claiming that verification ran', () => {
  const input = fixture();
  mapping(input);
  input.evidence = [evidence(input, 'missing')];
  const row = deriveGapReport(input).rows[0]!;
  assert.equal(row.implementation, 'missing');
  assert.equal(row.verification, 'not_run');
  assert.deepEqual(
    row.files.map((file) => file.path),
    ['src/app.tsx'],
  );
});

test('independent user evidence survives bad mapping clues while its own file selection must exist', () => {
  const input = fixture();
  mapping(input, [{ taskId: 'F001', files: ['src/absent.tsx'] }]);
  input.evidence = [evidence(input)];
  let row = deriveGapReport(input).rows[0]!;
  assert.equal(row.verification, 'passed');
  assert.deepEqual(row.missingPaths, ['src/absent.tsx']);
  input.evidence = [evidence(input, 'passed', { files: ['src/absent.tsx'] })];
  row = deriveGapReport(input).rows[0]!;
  assert.equal(row.verification, 'stale');
  input.evidence = [evidence(input, 'passed', { files: [] })];
  assert.equal(deriveGapReport(input).rows[0]!.verification, 'stale');
  input.evidence = [evidence(input, 'passed', { files: ['src/requirements.json'] })];
  assert.equal(deriveGapReport(input).rows[0]!.verification, 'stale');
});

test('passed cannot apply without a current matching build even if a no-build record was supplied', () => {
  const input = fixture();
  input.build = { ...input.build, status: 'empty', artifact: null };
  input.evidence = [evidence(input)];
  const result = deriveGapReport(input);
  assert.equal(result.binding!.buildId, null);
  assert.equal(result.rows[0]!.verification, 'stale');
  assert.equal(result.runtime, null);
  assert.equal(result.runtimeCurrent, false);
});

test('current empty source can record missing implementation before its first build', () => {
  const input = fixture();
  input.source = { revision: 0, files: [] };
  input.sourceBinding = null;
  input.evidence = [evidence(input, 'missing', { files: [] })];
  const result = deriveGapReport(input);
  assert.equal(result.status, 'current');
  assert.equal(result.writable, true);
  assert.equal(result.build, null);
  assert.equal(result.rows[0]!.implementation, 'missing');
  assert.equal(result.rows[0]!.verification, 'not_run');
});

test('plan invalidation retains rows and historical records but promotes no manual conclusion', () => {
  for (const verdict of ['passed', 'failed', 'missing'] as const) {
    const input = fixture();
    input.evidence = [evidence(input, verdict)];
    input.plan.status = 'stale';
    const report = deriveGapReport(input),
      row = report.rows[0]!;
    assert.equal(report.status, 'stale');
    assert.equal(report.writable, false);
    assert.equal(report.rows.length, 4);
    assert.equal(row.verification, 'stale');
    assert.equal(row.implementation, 'unlinked');
    assert.deepEqual(row.files, []);
    assert.equal(row.record!.id, input.evidence[0]!.id);
    assert.equal(report.build, null);
    assert.equal(report.runtime, null);
  }
});

test('source binding mismatch or missing provenance makes existing source stale even with matching technical flags', () => {
  for (const field of ['planRunId', 'planInputHash', 'planArtifactHash', 'null'] as const) {
    const input = fixture();
    input.evidence = [evidence(input)];
    if (field === 'null') input.sourceBinding = null;
    else input.sourceBinding![field] = field === 'planRunId' ? randomUUID() : 'f'.repeat(64);
    const report = deriveGapReport(input);
    assert.equal(report.status, 'stale');
    assert.equal(report.writable, false);
    assert.equal(report.rows[0]!.verification, 'stale');
    assert.equal(report.build, null);
    assert.equal(report.runtime, null);
  }
});

test('source edits and restored identical content at a later revision invalidate prior user evidence', () => {
  for (const edit of ['content', 'revision'] as const) {
    const input = fixture();
    input.evidence = [evidence(input, 'missing')];
    if (edit === 'content') {
      input.source.files[0]!.content += ';';
      input.source.files[0]!.sha256 = sourceHash(input.source.files[0]!.content);
    } else input.source.revision++;
    const report = deriveGapReport(input);
    assert.equal(report.status, 'current');
    assert.equal(report.rows[0]!.verification, 'stale');
    assert.equal(report.rows[0]!.implementation, 'unlinked');
    assert.equal(report.build, null);
  }
});

test('each evidence binding component independently prevents old passed records from applying', () => {
  const changed: Partial<GapBinding>[] = [
    { planInputHash: 'd'.repeat(64) },
    { planArtifactHash: 'd'.repeat(64) },
    { sourceRevision: 0 },
    { sourceHash: 'd'.repeat(64) },
    { buildId: randomUUID() },
    { artifactHash: 'd'.repeat(64) },
  ];
  for (const binding of changed) {
    const input = fixture();
    input.evidence = [evidence(input, 'passed', { binding })];
    assert.equal(deriveGapReport(input).rows[0]!.verification, 'stale');
  }
});

test('new build identity invalidates prior business verification even when output bytes and source match', () => {
  const input = fixture();
  input.evidence = [evidence(input)];
  input.build.artifact!.id = randomUUID();
  const report = deriveGapReport(input);
  assert.equal(report.rows[0]!.verification, 'stale');
  assert.equal(report.runtime, null);
  assert.equal(report.binding!.buildId, input.build.artifact!.id);
});

test('current technical flags never override project, full plan, source or artifact identity mismatches', () => {
  for (const field of [
    'projectId',
    'planRunId',
    'planInputHash',
    'planArtifactHash',
    'sourceRevision',
    'sourceHash',
    'stateProject',
    'status',
  ] as const) {
    const input = fixture();
    if (field === 'stateProject') input.build.projectId = randomUUID();
    else if (field === 'status') input.build.status = 'stale';
    else if (field === 'sourceRevision') input.build.artifact!.sourceRevision++;
    else input.build.artifact![field] = field.includes('Hash') ? 'f'.repeat(64) : randomUUID();
    const result = deriveGapReport(input);
    assert.equal(result.build, null);
    assert.equal(result.binding!.buildId, null);
    assert.equal(result.runtime, null);
  }
  for (const field of [
    'planRunId',
    'planInputHash',
    'planArtifactHash',
    'sourceRevision',
    'sourceHash',
    'buildId',
    'artifactHash',
    'projectId',
    'current',
  ] as const) {
    const input = fixture();
    if (field === 'projectId') input.runtime.projectId = randomUUID();
    else if (field === 'current') input.runtime.current = false;
    else if (field === 'sourceRevision') input.runtime.report!.sourceRevision++;
    else input.runtime.report![field] = field.includes('Hash') ? 'f'.repeat(64) : randomUUID();
    const result = deriveGapReport(input);
    assert.ok(result.build);
    assert.equal(result.runtime, null);
    assert.equal(result.runtimeCurrent, false);
  }
});

test('latest append for the same project, plan and task wins regardless of wall-clock order', () => {
  const input = fixture(),
    old = evidence(input),
    latest = evidence(input, 'failed');
  old.createdAt = '2026-10-05T01:00:00.000Z';
  const anotherPlan = evidence(input, 'missing', { binding: { planRunId: randomUUID() } });
  const anotherTask = evidence(input, 'passed', { taskId: 'F999' });
  const anotherProject = evidence(input, 'missing');
  anotherProject.request.projectId = randomUUID();
  input.evidence = [old, latest, anotherPlan, anotherTask, anotherProject];
  const report = deriveGapReport(input);
  assert.equal(report.historyCount, 5);
  assert.equal(report.rows[0]!.record!.id, latest.id);
  assert.equal(report.rows[0]!.verification, 'failed');
});

test('latest stale record cannot fall back to an older apparently matching passed record', () => {
  const input = fixture();
  input.evidence = [
    evidence(input),
    evidence(input, 'missing', { binding: { sourceRevision: 0 } }),
  ];
  const row = deriveGapReport(input).rows[0]!;
  assert.equal(row.verification, 'stale');
  assert.equal(row.implementation, 'unlinked');
});

test('archive disables writing without inventing a stale plan; stale build removes build binding', () => {
  const input = fixture();
  input.evidence = [evidence(input)];
  input.archived = true;
  let report = deriveGapReport(input);
  assert.equal(report.status, 'current');
  assert.equal(report.writable, false);
  input.build.status = 'stale';
  report = deriveGapReport(input);
  assert.equal(report.rows[0]!.verification, 'stale');
  assert.equal(report.build, null);
});

test('derived files are deduplicated and output changes cannot mutate trusted inputs', () => {
  const input = fixture();
  mapping(input);
  input.evidence = [evidence(input)];
  const before = JSON.stringify(input),
    report = deriveGapReport(input);
  assert.equal(report.rows[0]!.files.length, 1);
  assert.equal(JSON.stringify(input), before);
  report.rows[0]!.record!.request.actual = 'changed';
  report.build!.warnings.push({ path: null, line: null, message: 'changed' });
  report.runtime!.issues.push('TYPE_ERROR');
  assert.equal(JSON.stringify(input), before);
});

test('coding prompt can declare bounded links but adds no tool for writing user verification', () => {
  assert.match(codingPrompt, /src\/requirements\.json/u);
  assert.match(codingPrompt, /最多200行/u);
  assert.match(codingPrompt, /每项最多32个/u);
  assert.match(codingPrompt, /当前plan\.tasks/u);
  assert.match(codingPrompt, /用户核验记录只由工作台保存/u);
  assert.deepEqual(
    codingTools.map((tool) => tool.function.name),
    ['list_files', 'read_file', 'apply_changes'],
  );
});
