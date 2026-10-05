import { isDeepStrictEqual } from 'node:util';
import type {
  WorkflowRun,
  WorkflowStage,
  WorkflowStageKind,
  WorkflowState,
} from '../shared/workflow-contracts';
import type { SourceBinding } from '../shared/source-contracts';
import type { BuildArtifact } from '../shared/build-contracts';
import type { RuntimeReport } from '../shared/runtime-contracts';
import { workflowCodingRequest, workflowRepairRequest } from '../shared/modification';
import { assertExportContentsSafe } from './export-security';
import type { ProjectStore } from './project-store';
import type { SourceStore } from './source-store';
import type { SourceToolExecutor } from './source-tools';
import type { CodingRunner } from './coding-runner';
import type { BuildService } from './build-service';
import type { RuntimeService } from './runtime-service';
import type { RepairRunner } from './repair-runner';
import { WorkflowStore, parseWorkflowRequest } from './workflow-store';
import { sourceHash } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

const hash = (value: unknown) => sourceHash(JSON.stringify(value));
const samePlan = (a: SourceBinding | null, b: SourceBinding) =>
  !!a &&
  a.planRunId === b.planRunId &&
  a.planInputHash === b.planInputHash &&
  a.planArtifactHash === b.planArtifactHash;
const limitedCodes = new Set([
  'CODING_LIMIT',
  'REPAIR_LIMIT',
  'BUDGET_EXCEEDED',
  'TOKEN_BUDGET_EXCEEDED',
  'TOKEN_USAGE_UNKNOWN',
  'WORKFLOW_TIMEOUT',
]);
const cancelledCodes = new Set([
  'MODEL_CANCELLED',
  'CANCELLED',
  'BUILD_CANCELLED',
  'RUNTIME_CANCELLED',
  'WORKFLOW_CANCELLED',
]);
const publicCodes = new Set([
  ...limitedCodes,
  ...cancelledCodes,
  'KEY_REQUIRED',
  'CREDENTIAL_UNAVAILABLE',
  'AUTH_FAILED',
  'QUOTA_EXCEEDED',
  'ACCESS_DENIED',
  'MODEL_NOT_FOUND',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'TRUNCATED_RESPONSE',
  'SENSITIVE_RESPONSE',
  'MODIFICATION_SENSITIVE',
  'STORAGE_ERROR',
  'ARCHIVED',
  'CONFIRMATION_REQUIRED',
  'STALE_PLAN',
  'STALE_SOURCE',
  'STALE_RUNTIME',
  'STALE_BUILD',
  'EMPTY_SOURCE',
  'BUILD_FAILED',
  'RUNTIME_ISSUES',
  'RUNTIME_NOT_REPRODUCED',
  'CODING_FAILED',
  'REPAIR_FAILED',
  'REPAIR_NO_PROGRESS',
  'TOOLCHAIN_UNAVAILABLE',
  'UNSAFE_PATH',
  'RECOVERY_INCONSISTENT',
  'WORKFLOW_INCONSISTENT',
  'SOURCE_LIMIT',
  'SOURCE_IO',
  'SOURCE_COMMIT_UNCERTAIN',
  'CORRUPT_SOURCE',
  'MISSING_SOURCE',
  'UNSUPPORTED_SOURCE',
  'CODING_IO',
  'CODING_COMMIT_UNCERTAIN',
  'CORRUPT_CODING',
  'MISSING_CODING',
  'BUILD_IO',
  'BUILD_COMMIT_UNCERTAIN',
  'BUILD_INTERRUPTED',
  'BUILD_LIMIT',
  'BUILD_RUN_IO',
  'BUILD_RUN_COMMIT_UNCERTAIN',
  'CORRUPT_BUILD',
  'MISSING_BUILD',
  'CORRUPT_BUILD_RUN',
  'MISSING_BUILD_RUN',
  'REPAIR_IO',
  'REPAIR_COMMIT_UNCERTAIN',
  'CORRUPT_REPAIR',
  'MISSING_REPAIR',
  'RUNTIME_RECORD_IO',
  'RUNTIME_RECORD_COMMIT_UNCERTAIN',
  'CORRUPT_RUNTIME_RECORD',
  'MISSING_RUNTIME_RECORD',
  'RUNTIME_CHECK_FAILED',
]);
const inconsistent = () =>
  new AppError('WORKFLOW_INCONSISTENT', '阶段记录与实际产物不一致，请保留现场后核对。');
function childId(runId: string, kind: WorkflowStageKind): string {
  const c = hash(['workflow-v1', runId, kind]).slice(0, 32).split('');
  c[12] = '4';
  c[16] = '8';
  const s = c.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
/** One explicit user operation, bounded children, no automatic paid restart. */
export class WorkflowRunner {
  private active: {
    id: string;
    projectId: string;
    controller: AbortController;
    timedOut: boolean;
  } | null = null;
  private readonly timeoutMs: number;
  constructor(
    private readonly projects: Pick<ProjectStore, 'get'>,
    private readonly sources: Pick<SourceStore, 'get' | 'history'>,
    private readonly tools: Pick<SourceToolExecutor, 'prepare'>,
    private readonly coding: Pick<CodingRunner, 'generate' | 'history' | 'cancel'>,
    private readonly builds: Pick<BuildService, 'build' | 'artifact' | 'attempts' | 'cancel'>,
    private readonly runtime: Pick<RuntimeService, 'check' | 'get' | 'cancel'>,
    private readonly repairs: Pick<RepairRunner, 'repair' | 'history' | 'cancel'>,
    private readonly records: WorkflowStore,
    private readonly options: {
      timeoutMs?: number;
      beforeRun?: (projectId: string) => void;
      assertModificationSafe?: (instruction: string) => void;
    } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000)
      throw new AppError('INVALID_INPUT', '自动开发时限无效。');
  }
  cancel(): void {
    if (!this.active) return;
    this.active.controller.abort();
    this.coding.cancel();
    this.repairs.cancel();
    this.builds.cancel();
    this.runtime.cancel();
  }
  private persist(run: WorkflowRun) {
    const intended = structuredClone(run);
    try {
      this.records.save(run.request.projectId, intended);
    } catch (error) {
      if (error instanceof AppError && error.code === 'WORKFLOW_COMMIT_UNCERTAIN') {
        try {
          if (
            isDeepStrictEqual(
              this.records.list(run.request.projectId).find((r) => r.id === run.id),
              intended,
            )
          )
            return;
        } catch {
          /* Preserve uncertainty. */
        }
      }
      throw error;
    }
  }
  private history(projectId: string): WorkflowRun[] {
    const runs = this.records.list(projectId);
    for (const run of runs) {
      if (
        run.status !== 'running' ||
        (this.active?.id === run.id && this.active.projectId === projectId)
      )
        continue;
      const now = new Date(Math.max(Date.now(), Date.parse(run.updatedAt))).toISOString();
      run.status = 'interrupted';
      run.errorCode = 'WORKFLOW_INTERRUPTED';
      run.updatedAt = now;
      const stage = run.stages.at(-1);
      if (stage?.status === 'running') {
        stage.status = 'interrupted';
        stage.errorCode = 'WORKFLOW_INTERRUPTED';
        stage.updatedAt = now;
      }
      this.persist(run);
    }
    return runs;
  }
  private view(projectId: string, run: WorkflowRun | null): WorkflowState {
    this.projects.get(projectId);
    const source = this.sources.get(projectId);
    let current = false;
    if (run && source.revision === run.latestRevision && hash(source) === run.latestSourceHash) {
      try {
        current = samePlan(
          this.tools.prepare({ projectId, planRunId: run.binding.planRunId }).binding,
          run.binding,
        );
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['ARCHIVED', 'CONFIRMATION_REQUIRED', 'STALE_PLAN'].includes(error.code)
        )
          throw error;
      }
    }
    if (current && run?.status === 'ready') {
      if (!run.buildId || !run.runtimeReportId) throw inconsistent();
      const artifact = this.builds.artifact(projectId, run.buildId);
      const report = this.runtime.get(projectId, run.runtimeReportId);
      if (
        artifact.id !== run.buildId ||
        artifact.projectId !== projectId ||
        artifact.sourceRevision !== run.latestRevision ||
        artifact.sourceHash !== run.latestSourceHash ||
        !samePlan(artifact, run.binding) ||
        !report ||
        report.id !== run.runtimeReportId ||
        report.mode !== 'check' ||
        report.status !== 'observed' ||
        report.issues.length !== 0 ||
        report.buildId !== artifact.id ||
        report.artifactHash !== artifact.artifactHash ||
        report.sourceRevision !== artifact.sourceRevision ||
        report.sourceHash !== artifact.sourceHash ||
        !samePlan(report, run.binding)
      )
        throw inconsistent();
    }
    const coding = this.coding.history(projectId),
      repairs = this.repairs.history(projectId),
      attempts = this.builds.attempts(projectId);
    let rounds = 0,
      toolCalls = 0,
      builds = 0;
    let initialRevision = run?.request.sourceRevision ?? 0;
    let repairRuntimeReportId: string | undefined;
    for (const stage of run?.stages ?? []) {
      const childLimited = stage.status === 'limited' && stage.errorCode !== 'WORKFLOW_TIMEOUT';
      const receiptRequired = ['succeeded', 'no_changes'].includes(stage.status) || childLimited;
      if (stage.kind === 'generation') {
        const c = coding.find((c) => c.id === stage.requestId);
        if (
          (receiptRequired && !c) ||
          (c &&
            (c.planRunId !== run!.binding.planRunId ||
              c.initialRevision !== initialRevision ||
              c.requestHash !== hash(workflowCodingRequest(run!, stage.requestId)) ||
              (stage.status === 'succeeded' && c.status !== 'draft_saved') ||
              (stage.status === 'no_changes' && c.status !== 'no_changes') ||
              (childLimited && c.status !== 'limited')))
        )
          throw inconsistent();
        rounds += c?.rounds ?? 0;
        toolCalls += c?.toolCalls ?? 0;
      }
      if (stage.kind === 'repair') {
        const r = repairs.find((r) => r.id === stage.requestId);
        if (
          (receiptRequired && !r) ||
          (r &&
            (!samePlan(r, run!.binding) ||
              r.initialRevision !== initialRevision ||
              r.requestHash !==
                hash(
                  workflowRepairRequest(
                    run!,
                    stage.requestId,
                    initialRevision,
                    repairRuntimeReportId,
                  ),
                ) ||
              (stage.status === 'succeeded' &&
                (r.status !== 'succeeded' ||
                  r.latestRevision !== stage.sourceRevision ||
                  r.buildId !== stage.buildId ||
                  (r.runtimeResultId ?? null) !== stage.runtimeReportId)) ||
              (childLimited && r.status !== 'limited')))
        )
          throw inconsistent();
        rounds += r?.rounds ?? 0;
        toolCalls += r?.toolCalls ?? 0;
        builds += r?.builds ?? 0;
      }
      if (stage.kind === 'build') {
        const b = attempts.find((b) => b.id === stage.requestId);
        if (
          (receiptRequired && !b) ||
          (b &&
            (!samePlan(b, run!.binding) ||
              b.sourceRevision !== stage.sourceRevision ||
              b.sourceHash !== stage.sourceHash ||
              (stage.status === 'succeeded' &&
                (b.status !== 'succeeded' || b.id !== stage.buildId))))
        )
          throw inconsistent();
        if (b) builds++;
      }
      initialRevision = stage.sourceRevision;
      if (stage.kind === 'startup') repairRuntimeReportId = stage.runtimeReportId ?? undefined;
    }
    return {
      projectId,
      run: run ? structuredClone(run) : null,
      current,
      sourceRevision: source.revision,
      fileCount: source.files.length,
      rounds,
      toolCalls,
      builds,
      history: this.records
        .list(projectId)
        .slice(-20)
        .reverse()
        .map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          status: item.status,
          mode: item.request.mode,
          sourceRevision: item.request.sourceRevision,
          latestRevision: item.latestRevision,
          instruction: item.request.mode === 'modify' ? item.request.instruction : null,
        })),
      changes: this.changes(projectId, run),
    };
  }
  private changes(projectId: string, run: WorkflowRun | null): WorkflowState['changes'] {
    if (!run || run.request.mode !== 'modify') return null;
    const result: NonNullable<WorkflowState['changes']> = {
      status: 'unavailable',
      baseRevision: run.request.sourceRevision,
      resultRevision: run.latestRevision,
      files: [],
    };
    if (
      ['running', 'cancelled', 'interrupted'].includes(run.status) ||
      ['WORKFLOW_TIMEOUT', 'STALE_SOURCE', 'WORKFLOW_INCONSISTENT'].includes(run.errorCode ?? '')
    )
      return result;
    const history = this.sources.history(projectId),
      base = history.find((item) => item.revision === run.request.sourceRevision),
      last = history.find((item) => item.revision === run.latestRevision);
    if (
      !base ||
      !last ||
      base.snapshotHash !== run.initialSourceHash ||
      last.snapshotHash !== run.latestSourceHash
    )
      return result;
    let previousRevision = run.request.sourceRevision;
    for (const stage of run.stages) {
      if (stage.kind === 'generation' || stage.kind === 'repair') {
        const child =
          stage.kind === 'generation'
            ? this.coding.history(projectId).find((item) => item.id === stage.requestId)
            : this.repairs.history(projectId).find((item) => item.id === stage.requestId);
        // Source may commit before the child's terminal journal is saved. The
        // parent's old checkpoint alone cannot establish an empty difference.
        if (
          !child ||
          ['running', 'interrupted', 'cancelled'].includes(child.status) ||
          child.initialRevision !== previousRevision
        )
          return result;
        const submitted = new Set(child.toolRequests.map((item) => item.requestId));
        const adopted = history.filter(
          (item) => item.revision > previousRevision && item.revision <= stage.sourceRevision,
        );
        if (
          adopted.length !== stage.sourceRevision - previousRevision ||
          adopted.some(
            (item) =>
              !item.requestId ||
              !submitted.has(item.requestId) ||
              item.restoredFrom !== null ||
              !samePlan(item.binding, run.binding),
          ) ||
          history.some(
            (item) =>
              item.revision > stage.sourceRevision &&
              item.requestId !== null &&
              submitted.has(item.requestId),
          )
        )
          return result;
      }
      previousRevision = stage.sourceRevision;
    }
    const before = new Map(base.files.map((file) => [file.path, file.sha256])),
      after = new Map(last.files.map((file) => [file.path, file.sha256]));
    result.status = 'available';
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      if (before.get(path) === after.get(path)) continue;
      result.files.push({
        path,
        kind: !before.has(path) ? 'added' : !after.has(path) ? 'deleted' : 'modified',
      });
    }
    return result;
  }
  state(value: unknown): WorkflowState {
    assertRecord(value);
    assertFields(value, ['projectId', 'requestId']);
    const projectId = parseProjectId(value.projectId);
    const requestId = value.requestId === undefined ? null : parseRevisionId(value.requestId);
    const history = this.history(projectId);
    return this.view(
      projectId,
      (requestId ? history.find((run) => run.id === requestId) : history.at(-1)) ?? null,
    );
  }
  async run(value: unknown): Promise<WorkflowState> {
    const request = parseWorkflowRequest(value),
      projectId = request.projectId;
    const previous = this.history(projectId).find((r) => r.id === request.requestId);
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request))
        throw new AppError('WORKFLOW_CONFLICT', '此请求已用于另一项自动开发操作。');
      return this.view(projectId, previous);
    }
    if (this.active) throw new AppError('BUSY', '自动开发正在进行，请等待或停止。');
    const prepared = this.tools.prepare({ projectId, planRunId: request.planRunId });
    let expected = this.sources.get(projectId);
    if (expected.revision !== request.sourceRevision)
      throw new AppError('STALE_SOURCE', '源码已变化，请刷新后再开始。');
    if (request.mode !== 'generate') {
      if (!expected.files.length) throw new AppError('EMPTY_SOURCE', '请先生成源码。');
      if (!samePlan(this.sources.history(projectId).at(-1)?.binding ?? null, prepared.binding))
        throw new AppError('STALE_PLAN', '已有源码属于旧方向，请先按当前计划生成源码。');
    }
    if (request.mode === 'modify') {
      try {
        (this.options.assertModificationSafe ?? ((text) => assertExportContentsSafe([text])))(
          request.instruction,
        );
      } catch (error) {
        if (error instanceof AppError && error.code === 'EXPORT_SENSITIVE')
          throw new AppError('SENSITIVE_INPUT', '修改要求中发现疑似凭据，请移除后再提交。');
        throw error;
      }
    }
    this.options.beforeRun?.(projectId);
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: request.requestId,
      request,
      binding: prepared.binding,
      initialSourceHash: hash(expected),
      createdAt: now,
      updatedAt: now,
      status: 'running',
      stages: [],
      latestRevision: expected.revision,
      latestSourceHash: hash(expected),
      buildId: null,
      runtimeReportId: null,
      errorCode: null,
    };
    this.persist(run);
    const active = { id: run.id, projectId, controller: new AbortController(), timedOut: false };
    this.active = active;
    const deadline = Date.now() + this.timeoutMs;
    const expire = () => {
      active.timedOut = true;
      this.cancel();
    };
    const timer = setTimeout(expire, this.timeoutMs);
    let persistenceFailed = false;
    const save = () => {
      run.updatedAt = new Date(
        Math.max(
          Date.now(),
          Date.parse(run.updatedAt),
          ...run.stages.map((stage) => Date.parse(stage.updatedAt)),
        ),
      ).toISOString();
      try {
        this.persist(run);
      } catch (error) {
        persistenceFailed = true;
        throw error;
      }
    };
    const check = (source = true) => {
      if (!active.controller.signal.aborted && Date.now() >= deadline) expire();
      if (active.controller.signal.aborted)
        throw new AppError(
          active.timedOut ? 'WORKFLOW_TIMEOUT' : 'WORKFLOW_CANCELLED',
          '自动开发已停止。',
        );
      if (
        !samePlan(
          this.tools.prepare({ projectId, planRunId: request.planRunId }).binding,
          run.binding,
        )
      )
        throw new AppError('STALE_PLAN', '确认方向已变化。');
      if (source && hash(this.sources.get(projectId)) !== hash(expected))
        throw new AppError('STALE_SOURCE', '源码已被其他操作修改。');
    };
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      let abort!: () => void;
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new AppError('WORKFLOW_CANCELLED', '自动开发已停止。'));
        active.controller.signal.addEventListener('abort', abort, { once: true });
        if (active.controller.signal.aborted) abort();
      });
      try {
        return await Promise.race([operation, stopped]);
      } finally {
        active.controller.signal.removeEventListener('abort', abort);
      }
    };
    const begin = (kind: WorkflowStageKind): WorkflowStage => {
      check();
      const now = new Date(Math.max(Date.now(), Date.parse(run.updatedAt))).toISOString();
      const stage: WorkflowStage = {
        kind,
        requestId: childId(run.id, kind),
        status: 'running',
        createdAt: now,
        updatedAt: now,
        sourceRevision: expected.revision,
        sourceHash: hash(expected),
        buildId: null,
        runtimeReportId: null,
        errorCode: null,
        ...(kind === 'repair' && run.request.mode === 'modify'
          ? { repairRequestVersion: 2 as const }
          : {}),
      };
      run.stages.push(stage);
      save();
      return stage;
    };
    const end = (
      stage: WorkflowStage,
      status: WorkflowStage['status'],
      code: string | null = null,
    ) => {
      stage.status = status;
      stage.errorCode = code;
      stage.updatedAt = new Date(Math.max(Date.now(), Date.parse(run.updatedAt))).toISOString();
      stage.sourceRevision = expected.revision;
      stage.sourceHash = hash(expected);
      run.latestRevision = expected.revision;
      run.latestSourceHash = hash(expected);
      save();
    };
    const adopt = (child: { initialRevision: number; toolRequests: { requestId: string }[] }) => {
      check(false);
      const next = this.sources.get(projectId),
        history = this.sources.history(projectId);
      const added = history.filter((c) => c.revision > expected.revision);
      if (
        child.initialRevision !== expected.revision ||
        next.revision < expected.revision ||
        (next.revision === expected.revision && hash(next) !== hash(expected)) ||
        added.length !== next.revision - expected.revision ||
        added.some(
          (c) =>
            c.restoredFrom !== null ||
            !c.requestId ||
            !child.toolRequests.some((t) => t.requestId === c.requestId) ||
            !samePlan(c.binding, run.binding),
        )
      )
        throw new AppError('STALE_SOURCE', '阶段源码来源已变化。');
      expected = next;
    };
    const artifact = (id: string): BuildArtifact => {
      check();
      const a = this.builds.artifact(projectId, id);
      if (
        a.id !== id ||
        a.projectId !== projectId ||
        a.sourceRevision !== expected.revision ||
        a.sourceHash !== hash(expected) ||
        !samePlan(a, run.binding)
      )
        throw inconsistent();
      return a;
    };
    const probe = (report: RuntimeReport | null, a: BuildArtifact, id: string) => {
      check();
      if (
        !report ||
        report.id !== id ||
        report.mode !== 'check' ||
        report.buildId !== a.id ||
        report.artifactHash !== a.artifactHash ||
        report.sourceRevision !== a.sourceRevision ||
        report.sourceHash !== a.sourceHash ||
        !samePlan(report, run.binding) ||
        !['observed', 'issues'].includes(report.status) ||
        (report.status === 'observed' && report.issues.length !== 0) ||
        (report.status === 'issues' && !report.issues.length)
      )
        throw inconsistent();
      return report;
    };
    const stop = (code: string): never => {
      throw new AppError(code, '自动开发未完成，已保存的结果保留。');
    };
    const repair = async (runtimeReportId?: string): Promise<BuildArtifact> => {
      const stage = begin('repair');
      const childRequest = workflowRepairRequest(
        run,
        stage.requestId,
        expected.revision,
        runtimeReportId,
      );
      await wait(this.repairs.repair(childRequest));
      check(false);
      const child = this.repairs.history(projectId).find((r) => r.id === stage.requestId);
      if (!child || !samePlan(child, run.binding) || child.requestHash !== hash(childRequest))
        throw inconsistent();
      adopt(child);
      if (child.latestRevision !== expected.revision) throw inconsistent();
      stage.buildId = child.buildId;
      stage.runtimeReportId = child.runtimeResultId ?? null;
      if (child.status !== 'succeeded') {
        const code = child.errorCode ?? 'REPAIR_NO_PROGRESS';
        end(
          stage,
          child.status === 'limited'
            ? 'limited'
            : child.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
          code,
        );
        stop(code);
      }
      if (!child.buildId) throw inconsistent();
      const a = artifact(child.buildId);
      if (runtimeReportId) {
        if (!child.runtimeResultId) throw inconsistent();
        const report = probe(
          this.runtime.get(projectId, child.runtimeResultId),
          a,
          child.runtimeResultId,
        );
        if (report.status !== 'observed') throw inconsistent();
        run.runtimeReportId = report.id;
      }
      run.buildId = a.id;
      end(stage, 'succeeded');
      return a;
    };
    try {
      if (request.mode !== 'check') {
        const stage = begin('generation');
        await wait(this.coding.generate(workflowCodingRequest(run, stage.requestId)));
        check(false);
        const child = this.coding.history(projectId).find((c) => c.id === stage.requestId);
        if (!child || child.planRunId !== request.planRunId) throw inconsistent();
        adopt(child);
        if (!['draft_saved', 'no_changes'].includes(child.status)) {
          const code = child.errorCode ?? 'CODING_FAILED';
          end(
            stage,
            child.status === 'limited'
              ? 'limited'
              : child.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
            code,
          );
          stop(code);
        }
        end(stage, child.status === 'no_changes' ? 'no_changes' : 'succeeded');
      }
      check();
      if (!expected.files.length) stop('EMPTY_SOURCE');
      if (!samePlan(this.sources.history(projectId).at(-1)?.binding ?? null, run.binding))
        stop('STALE_SOURCE');
      const buildStage = begin('build');
      const built = await wait(
        this.builds.build({
          schemaVersion: 1,
          requestId: buildStage.requestId,
          projectId,
          planRunId: request.planRunId,
          sourceRevision: expected.revision,
        }),
      );
      check();
      const attempt = this.builds.attempts(projectId).find((b) => b.id === buildStage.requestId);
      if (
        !attempt ||
        attempt.status !== built.status ||
        attempt.sourceRevision !== expected.revision ||
        attempt.sourceHash !== hash(expected) ||
        !samePlan(attempt, run.binding)
      )
        throw inconsistent();
      buildStage.buildId = attempt.id;
      let a: BuildArtifact,
        repairUsed = false;
      if (attempt.status === 'succeeded') {
        a = artifact(attempt.id);
        run.buildId = a.id;
        end(buildStage, 'succeeded');
      } else {
        const code = attempt.errorCode ?? 'BUILD_FAILED';
        end(buildStage, attempt.status === 'cancelled' ? 'cancelled' : 'failed', code);
        if (attempt.status !== 'failed' || code !== 'BUILD_FAILED') stop(code);
        a = await repair();
        repairUsed = true;
      }
      const startup = begin('startup');
      startup.buildId = a.id;
      const observed = probe(
        await wait(
          this.runtime.check(
            { schemaVersion: 1, requestId: startup.requestId, projectId, buildId: a.id },
            active.controller.signal,
          ),
        ),
        a,
        startup.requestId,
      );
      startup.runtimeReportId = observed.id;
      run.runtimeReportId = observed.id;
      end(
        startup,
        observed.status === 'observed' ? 'succeeded' : 'failed',
        observed.status === 'observed' ? null : 'RUNTIME_ISSUES',
      );
      if (observed.status === 'issues') {
        if (repairUsed) stop('RUNTIME_ISSUES');
        a = await repair(observed.id);
      }
      check();
      artifact(a.id);
      if (
        !run.runtimeReportId ||
        probe(this.runtime.get(projectId, run.runtimeReportId), a, run.runtimeReportId).status !==
          'observed'
      )
        throw inconsistent();
      run.status = 'ready';
      run.errorCode = null;
      save();
    } catch (error) {
      this.cancel();
      if (persistenceFailed) throw error;
      const code = active.timedOut
        ? 'WORKFLOW_TIMEOUT'
        : error instanceof AppError && publicCodes.has(error.code)
          ? error.code
          : 'WORKFLOW_FAILED';
      const stage = run.stages.at(-1);
      if (stage?.status === 'running')
        end(
          stage,
          limitedCodes.has(code) ? 'limited' : cancelledCodes.has(code) ? 'cancelled' : 'failed',
          code,
        );
      run.status =
        limitedCodes.has(code) || stage?.status === 'limited'
          ? 'limited'
          : cancelledCodes.has(code)
            ? 'cancelled'
            : 'stopped';
      run.errorCode = code;
      save();
    } finally {
      clearTimeout(timer);
      if (this.active === active) this.active = null;
    }
    return this.view(projectId, run);
  }
}
