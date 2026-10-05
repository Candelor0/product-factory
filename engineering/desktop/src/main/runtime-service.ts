import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BuildArtifact } from '../shared/build-contracts';
import {
  runtimeIssueMessages,
  type RuntimeCheckRequest,
  type RuntimeIssueCode,
  type RuntimeProbeResult,
  type RuntimeReport,
  type RuntimeState,
} from '../shared/runtime-contracts';
import type { BuildService } from './build-service';
import type { ProjectStore } from './project-store';
import type { SourceStore } from './source-store';
import type { SourceToolExecutor } from './source-tools';
import { RuntimeStore, parseRuntimeReport } from './runtime-store';
import { sourceHash } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

export interface RuntimeExecutor {
  check(artifact: BuildArtifact, signal?: AbortSignal): Promise<RuntimeProbeResult>;
  open(
    artifact: BuildArtifact,
    onIssue: (code: RuntimeIssueCode) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeProbeResult>;
  openApplication?(
    artifact: BuildArtifact,
    onIssue: (code: RuntimeIssueCode) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeProbeResult>;
}
const staleCodes = new Set(['ARCHIVED', 'CONFIRMATION_REQUIRED', 'STALE_PLAN', 'STALE_BUILD']);
const snapshotHash = (snapshot: unknown) => sourceHash(JSON.stringify(snapshot));
const timestamp = (report: RuntimeReport) =>
  new Date(Math.max(Date.now(), Date.parse(report.updatedAt))).toISOString();
const sameArtifact = (report: RuntimeReport, artifact: BuildArtifact) =>
  report.buildId === artifact.id &&
  report.artifactHash === artifact.artifactHash &&
  report.sourceRevision === artifact.sourceRevision &&
  report.sourceHash === artifact.sourceHash &&
  report.planRunId === artifact.planRunId &&
  report.planInputHash === artifact.planInputHash &&
  report.planArtifactHash === artifact.planArtifactHash;
const failed = () =>
  new AppError('RUNTIME_CHECK_FAILED', '运行观察未能完成，请保留记录并重新检查。');
function parseRequest(value: unknown): RuntimeCheckRequest {
  assertRecord(value);
  assertFields(value, ['schemaVersion', 'requestId', 'projectId', 'buildId']);
  if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '运行检查请求版本无效。');
  return {
    schemaVersion: 1,
    requestId: parseRevisionId(value.requestId),
    projectId: parseProjectId(value.projectId),
    buildId: parseRevisionId(value.buildId),
  };
}

/** Runtime evidence contains only fixed issue codes; it never contains exception text or stacks. */
export class RuntimeService {
  private active: { projectId: string; reportId: string; controller: AbortController } | null =
    null;
  private readonly previewReports = new Map<string, string>();
  private readonly persistenceErrors = new Map<string, AppError>();
  constructor(
    private readonly projects: ProjectStore,
    private readonly sources: SourceStore,
    private readonly tools: SourceToolExecutor,
    private readonly builds: Pick<BuildService, 'artifact'>,
    private readonly records: RuntimeStore,
    private readonly executor: RuntimeExecutor,
  ) {}

  cancel(): void {
    this.active?.controller.abort();
  }

  private assertStorage(projectId: string): void {
    const error = this.persistenceErrors.get(projectId);
    if (error) throw error;
  }
  private persist(projectId: string, report: RuntimeReport): void {
    const intended = structuredClone(report);
    try {
      this.records.save(projectId, intended);
    } catch (error) {
      if (error instanceof AppError && error.code === 'RUNTIME_RECORD_COMMIT_UNCERTAIN') {
        try {
          if (
            isDeepStrictEqual(
              this.records.list(projectId).find((item) => item.id === intended.id),
              intended,
            )
          )
            return;
        } catch {
          /* Preserve the original uncertainty if the exact record cannot be read back. */
        }
      }
      const safeError =
        error instanceof AppError
          ? error
          : new AppError('RUNTIME_RECORD_IO', '运行观察记录保存失败，请先核对已有记录。');
      this.persistenceErrors.set(projectId, safeError);
      throw safeError;
    }
  }
  private reports(projectId: string): RuntimeReport[] {
    this.assertStorage(projectId);
    const reports = this.records.list(projectId);
    for (const report of reports) {
      if (
        report.status !== 'observing' ||
        (this.active?.projectId === projectId && this.active.reportId === report.id)
      )
        continue;
      report.status = 'interrupted';
      report.updatedAt = timestamp(report);
      this.persist(projectId, report);
    }
    return reports;
  }
  get(value: string, reportId: string): RuntimeReport | null {
    const projectId = parseProjectId(value);
    const id = parseRevisionId(reportId);
    return this.reports(projectId).find((item) => item.id === id) ?? null;
  }
  state(value: string): RuntimeState {
    const projectId = parseProjectId(value);
    this.projects.get(projectId);
    const reports = this.reports(projectId);
    if (!reports.length) return { projectId, report: null, current: false };
    const source = this.sources.get(projectId);
    const sourceHash = snapshotHash(source);
    const artifacts = new Map<string, BuildArtifact | null>();
    const candidates = reports.map((report, index) => {
      let current = false;
      if (source.revision === report.sourceRevision && sourceHash === report.sourceHash) {
        if (!artifacts.has(report.buildId)) {
          try {
            artifacts.set(report.buildId, this.builds.artifact(projectId, report.buildId));
          } catch (error) {
            if (!(error instanceof AppError) || !staleCodes.has(error.code)) throw error;
            artifacts.set(report.buildId, null);
          }
        }
        const artifact = artifacts.get(report.buildId);
        current = !!artifact && sameArtifact(report, artifact);
      }
      return { report, current, index };
    });
    // A visible preview may report a new error after a separate check was saved.
    // Prefer current-source evidence, then its latest activity, without reordering history.
    candidates.sort(
      (left, right) =>
        Number(right.current) - Number(left.current) ||
        Date.parse(right.report.updatedAt) - Date.parse(left.report.updatedAt) ||
        Number(right.report.status === 'issues') - Number(left.report.status === 'issues') ||
        right.index - left.index,
    );
    const selected = candidates[0];
    return { projectId, report: selected.report, current: selected.current };
  }
  async check(value: RuntimeCheckRequest | unknown, signal?: AbortSignal): Promise<RuntimeReport> {
    const request = parseRequest(value);
    const prior = this.get(request.projectId, request.requestId);
    if (prior) {
      if (prior.mode !== 'check' || prior.buildId !== request.buildId)
        throw new AppError('REQUEST_CONFLICT', '此运行检查请求已用于其他构建或操作。');
      return prior;
    }
    const artifact = this.builds.artifact(request.projectId, request.buildId);
    const source = this.sources.get(request.projectId);
    if (artifact.sourceRevision !== source.revision || artifact.sourceHash !== snapshotHash(source))
      throw new AppError('STALE_SOURCE', '源码已变化，请先构建当前版本再检查运行。');
    return this.observe(request.projectId, artifact, request.requestId, 'check', signal);
  }
  async open(value: string, buildId: string): Promise<RuntimeReport> {
    const projectId = parseProjectId(value);
    this.assertStorage(projectId);
    const artifact = this.builds.artifact(projectId, parseRevisionId(buildId));
    this.reports(projectId);
    return this.observe(projectId, artifact, randomUUID(), 'preview');
  }
  async openApplication(value: string, buildId: string): Promise<RuntimeReport> {
    const projectId = parseProjectId(value);
    this.assertStorage(projectId);
    if (!this.executor.openApplication) throw failed();
    const artifact = this.builds.artifact(projectId, parseRevisionId(buildId));
    const source = this.sources.get(projectId);
    if (source.revision !== artifact.sourceRevision || snapshotHash(source) !== artifact.sourceHash)
      throw new AppError('STALE_SOURCE', '源码已变化，请先构建当前版本，再打开本地应用。');
    this.reports(projectId);
    return this.observe(projectId, artifact, randomUUID(), 'application');
  }
  private async observe(
    projectId: string,
    artifact: BuildArtifact,
    id: string,
    mode: RuntimeReport['mode'],
    signal?: AbortSignal,
  ): Promise<RuntimeReport> {
    if (this.active) throw new AppError('BUSY', '正在观察页面运行，请完成或取消后重试。');
    if (this.projects.get(projectId).archived)
      throw new AppError('ARCHIVED', '请先恢复项目，再检查页面运行。');
    const now = new Date().toISOString();
    let report: RuntimeReport = {
      id,
      buildId: artifact.id,
      artifactHash: artifact.artifactHash,
      planRunId: artifact.planRunId,
      planInputHash: artifact.planInputHash,
      planArtifactHash: artifact.planArtifactHash,
      sourceRevision: artifact.sourceRevision,
      sourceHash: artifact.sourceHash,
      mode,
      createdAt: now,
      updatedAt: now,
      status: 'observing',
      observedMs: 0,
      issues: [],
    };
    this.persist(projectId, report);
    const controller = new AbortController();
    this.active = { projectId, reportId: id, controller };
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const earlyIssues = new Set<RuntimeIssueCode>();
    let accepting = true;
    const surface = `${projectId}:${mode}`;
    const onIssue = (code: RuntimeIssueCode) => {
      if (!accepting || controller.signal.aborted) return;
      if (!Object.hasOwn(runtimeIssueMessages, code)) return;
      if (report.status === 'observing') {
        earlyIssues.add(code);
        return;
      }
      if (
        this.previewReports.get(surface) !== id ||
        !['observed', 'issues'].includes(report.status) ||
        report.issues.includes(code)
      )
        return;
      const updated: RuntimeReport = {
        ...report,
        status: 'issues',
        updatedAt: timestamp(report),
        issues: [...report.issues, code].sort(),
      };
      try {
        this.persist(projectId, updated);
        report = updated;
      } catch {
        accepting = false; /* state() surfaces the saved persistence error; event handlers never throw. */
      }
    };
    let abortListener: (() => void) | undefined;
    const cancellation = new Promise<RuntimeProbeResult>((resolve) => {
      abortListener = () => resolve({ status: 'cancelled', issues: [], observedMs: 0 });
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    try {
      const result = controller.signal.aborted
        ? await cancellation
        : await Promise.race([
            mode === 'check'
              ? this.executor.check(artifact, controller.signal)
              : mode === 'application'
                ? this.executor.openApplication!(artifact, onIssue, controller.signal)
                : this.executor.open(artifact, onIssue, controller.signal),
            cancellation,
          ]);
      assertRecord(result);
      assertFields(result, ['status', 'issues', 'observedMs']);
      if (!['observed', 'issues', 'cancelled'].includes(result.status)) throw failed();
      let cancelled = controller.signal.aborted || result.status === 'cancelled';
      if (!cancelled) {
        // An in-flight direction change invalidates the probe result. A visible older-source
        // preview remains permitted only under the original still-confirmed plan.
        try {
          const fresh = this.tools.prepare({ projectId, planRunId: artifact.planRunId });
          cancelled =
            fresh.binding.planInputHash !== artifact.planInputHash ||
            fresh.binding.planArtifactHash !== artifact.planArtifactHash ||
            (mode === 'check' && snapshotHash(this.sources.get(projectId)) !== artifact.sourceHash);
        } catch (error) {
          if (!(error instanceof AppError) || !staleCodes.has(error.code)) throw error;
          cancelled = true;
        }
      }
      const probed = parseRuntimeReport({ ...report, ...result, updatedAt: timestamp(report) });
      const issues = [...new Set([...probed.issues, ...earlyIssues])].sort();
      const terminal: RuntimeReport = cancelled
        ? {
            ...report,
            status: 'cancelled',
            updatedAt: timestamp(report),
            observedMs: probed.observedMs,
            issues: [],
          }
        : { ...probed, status: issues.length ? 'issues' : 'observed', issues };
      if (cancelled) controller.abort();
      this.persist(projectId, terminal);
      report = terminal;
      if (mode !== 'check' && terminal.status === 'observed') this.previewReports.set(surface, id);
      else accepting = false;
      return structuredClone(report);
    } catch (error) {
      accepting = false;
      controller.abort();
      // Once a save is unconfirmed, do not overwrite a possibly committed terminal state.
      if (!this.persistenceErrors.has(projectId) && report.status === 'observing') {
        this.persist(projectId, { ...report, status: 'interrupted', updatedAt: timestamp(report) });
      }
      if (this.persistenceErrors.has(projectId)) this.assertStorage(projectId);
      throw failed();
    } finally {
      signal?.removeEventListener('abort', abort);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      this.active = null;
    }
  }
}
