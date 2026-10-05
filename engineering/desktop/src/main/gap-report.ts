import type { BuildState, BuildSummary } from '../shared/build-contracts';
import type { GapBinding, GapEvidence, GapReport, GapRow } from '../shared/gap-contracts';
import type { PlanState } from '../shared/plan-contracts';
import type { RuntimeState } from '../shared/runtime-contracts';
import type { SourceBinding, SourceSnapshot } from '../shared/source-contracts';
import { parseSourceContent, parseSourcePath, sourceHash } from './source-protocol';
import { parseRevisionId } from './validation';

const MAPPING_PATH = 'src/requirements.json';
const invalidMappingNote = '需求关联清单格式或计划绑定无效，未采用其中的声明。';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error();
  if (fields.some((name) => !Object.hasOwn(input, name))) throw new Error();
  for (const name of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)!;
    if (
      typeof name !== 'string' ||
      forbidden.has(name) ||
      !fields.includes(name) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw new Error();
  }
  return input as Record<string, unknown>;
}
function list(input: unknown, max: number): unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > max ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
    return descriptor.value;
  });
}
function mapping(
  source: SourceSnapshot,
  plan: NonNullable<PlanState['run']>,
): {
  status: GapReport['mapping'];
  notes: string[];
  paths: Map<string, string[]>;
} {
  const selected = source.files.filter((file) => file.path === MAPPING_PATH);
  if (!selected.length) return { status: 'absent', notes: [], paths: new Map() };
  try {
    if (selected.length !== 1) throw new Error();
    const raw = object(JSON.parse(parseSourceContent(selected[0]!.content)), [
      'schemaVersion',
      'planRunId',
      'requirements',
    ]);
    if (raw.schemaVersion !== 1 || parseRevisionId(raw.planRunId) !== plan.id) throw new Error();
    const tasks = new Set(plan.plan.tasks.map((task) => task.id));
    const paths = new Map<string, string[]>();
    for (const item of list(raw.requirements, 200)) {
      const row = object(item, ['taskId', 'files']);
      if (
        typeof row.taskId !== 'string' ||
        !/^[PFDA][0-9]{3}$/u.test(row.taskId) ||
        !tasks.has(row.taskId) ||
        paths.has(row.taskId)
      )
        throw new Error();
      const files = list(row.files, 32).map(parseSourcePath);
      if (files.includes(MAPPING_PATH) || new Set(files).size !== files.length) throw new Error();
      paths.set(row.taskId, files);
    }
    return { status: 'valid', notes: [], paths };
  } catch {
    return { status: 'invalid', notes: [invalidMappingNote], paths: new Map() };
  }
}
function samePlan(left: SourceBinding, right: SourceBinding): boolean {
  return (
    left.planRunId === right.planRunId &&
    left.planInputHash === right.planInputHash &&
    left.planArtifactHash === right.planArtifactHash
  );
}
function sameSource(
  left: Pick<GapBinding, 'sourceRevision' | 'sourceHash'>,
  right: GapBinding,
): boolean {
  return left.sourceRevision === right.sourceRevision && left.sourceHash === right.sourceHash;
}
function sameBinding(left: GapBinding, right: GapBinding): boolean {
  return (
    samePlan(left, right) &&
    sameSource(left, right) &&
    left.buildId === right.buildId &&
    left.artifactHash === right.artifactHash
  );
}

/** Trusted stores supply validated snapshots; only the optional model-authored mapping is untrusted JSON. */
export function deriveGapReport(input: {
  projectId: string;
  archived: boolean;
  plan: PlanState;
  source: SourceSnapshot;
  sourceBinding: SourceBinding | null;
  build: BuildState;
  runtime: RuntimeState;
  evidence: GapEvidence[];
}): GapReport {
  const sourceFiles = input.source.files
    .filter((file) => file.path !== MAPPING_PATH)
    .map((file) => file.path)
    .sort();
  const base = {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    sourceFiles,
    historyCount: input.evidence.length,
  };
  const plan = input.plan.run;
  if (input.plan.status === 'empty' || !plan)
    return {
      ...base,
      status: 'empty',
      writable: false,
      binding: null,
      mapping: 'absent',
      mappingNotes: [],
      rows: [],
      build: null,
      runtime: null,
      runtimeCurrent: false,
    };
  const planBinding: SourceBinding = {
    planRunId: plan.id,
    planInputHash: plan.inputHash,
    planArtifactHash: plan.artifactHash,
  };
  const current =
    input.plan.status === 'current' &&
    plan.request.projectId === input.projectId &&
    ((input.source.revision === 0 && input.sourceBinding === null) ||
      (input.sourceBinding !== null && samePlan(input.sourceBinding, planBinding)));
  const binding: GapBinding = {
    ...planBinding,
    sourceRevision: input.source.revision,
    sourceHash: sourceHash(JSON.stringify(input.source)),
    buildId: null,
    artifactHash: null,
  };
  const candidate = input.build.artifact;
  const build: BuildSummary | null =
    current &&
    input.build.status === 'current' &&
    input.build.projectId === input.projectId &&
    candidate?.projectId === input.projectId &&
    samePlan(candidate, binding) &&
    sameSource(candidate, binding)
      ? candidate
      : null;
  if (build) {
    binding.buildId = build.id;
    binding.artifactHash = build.artifactHash;
  }
  const probe = input.runtime.report;
  const runtimeCurrent =
    !!build &&
    input.runtime.current &&
    input.runtime.projectId === input.projectId &&
    !!probe &&
    sameBinding(probe, binding);
  const linked = mapping(input.source, plan);
  const fileMap = new Map(
    input.source.files
      .filter((file) => file.path !== MAPPING_PATH)
      .map((file) => [file.path, file]),
  );
  const latest = new Map<string, GapEvidence>();
  // The store's append order is authoritative; wall-clock timestamps may go backwards.
  for (const record of input.evidence)
    if (
      record.origin === 'user' &&
      record.request.projectId === input.projectId &&
      record.request.binding.planRunId === plan.id
    )
      latest.set(record.request.taskId, record);
  const rows: GapRow[] = plan.plan.tasks.map((task) => {
    const record = latest.get(task.id) ?? null;
    const applicable = current && !!record && sameBinding(record.request.binding, binding);
    const paths = [
      ...new Set([
        ...(linked.paths.get(task.id) ?? []),
        ...(applicable ? record.request.filePaths : []),
      ]),
    ]
      .filter((path) => path !== MAPPING_PATH)
      .sort();
    const files = paths
      .filter((path) => fileMap.has(path))
      .map((path) => ({ path, sha256: fileMap.get(path)!.sha256 }));
    const missingPaths = paths.filter((path) => !fileMap.has(path));
    let implementation: GapRow['implementation'] = files.length ? 'linked' : 'unlinked';
    let verification: GapRow['verification'] = record ? 'stale' : 'not_run';
    if (applicable) {
      if (record.request.verdict === 'missing') {
        implementation = 'missing';
        verification = 'not_run';
      } else if (record.request.verdict === 'failed') verification = 'failed';
      else if (
        build &&
        record.request.filePaths.length &&
        record.request.filePaths.every((path) => fileMap.has(path))
      )
        verification = 'passed';
    }
    return {
      id: task.id,
      title: task.title,
      kind: task.kind,
      source: task.source,
      implementation,
      verification,
      files,
      missingPaths,
      record: record ? structuredClone(record) : null,
    };
  });
  return {
    ...base,
    status: current ? 'current' : 'stale',
    writable: current && !input.archived,
    binding,
    mapping: linked.status,
    mappingNotes: linked.notes,
    rows,
    build: build ? structuredClone(build) : null,
    runtime: runtimeCurrent ? structuredClone(probe!) : null,
    runtimeCurrent,
  };
}
