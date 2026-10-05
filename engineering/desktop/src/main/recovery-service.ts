import type {
  RecoveryRun,
  RecoveryState,
  RestoreCheckpointRequest,
} from '../shared/recovery-contracts';
import type { SourceBinding } from '../shared/source-contracts';
import type { BuildService } from './build-service';
import type { BuildStore } from './build-store';
import type { CodingRunner } from './coding-runner';
import type { PlanStore } from './plan-store';
import type { ProjectStore } from './project-store';
import type { RepairRunner } from './repair-runner';
import type { RuntimeService } from './runtime-service';
import type { SourceStore } from './source-store';
import type { SourceToolExecutor } from './source-tools';
import { parseSourceRevision } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

const sameBinding = (a: SourceBinding | null, b: SourceBinding | null) =>
  !!a &&
  !!b &&
  a.planRunId === b.planRunId &&
  a.planInputHash === b.planInputHash &&
  a.planArtifactHash === b.planArtifactHash;
const inconsistent = () =>
  new AppError(
    'RECOVERY_INCONSISTENT',
    '运行记录与源码检查点不一致，已停止恢复。请保留现有文件并检查备份。',
  );

/** Reconcile durable receipts; interrupted build outcomes may be finalized, but work is never replayed. */
export class RecoveryService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly plans: PlanStore,
    private readonly sources: SourceStore,
    private readonly tools: SourceToolExecutor,
    private readonly coding: Pick<CodingRunner, 'state' | 'history'>,
    private readonly repairs: Pick<RepairRunner, 'state' | 'history'>,
    private readonly builds: Pick<BuildService, 'attempts'>,
    private readonly artifacts: BuildStore,
    private readonly runtime?: Pick<RuntimeService, 'get'>,
  ) {}

  state(value: string): RecoveryState {
    const projectId = parseProjectId(value);
    const project = this.projects.get(projectId);
    const plan = this.plans.get(projectId);
    let binding: SourceBinding | null = null;
    let blockedReason: string | null = null;
    if (project.archived) blockedReason = '项目已归档，请先恢复项目。';
    else if (project.stage !== 'ready') blockedReason = '需求或页面方向已变化，请先确认当前版本。';
    else if (plan.status !== 'current' || !plan.run)
      blockedReason = '请先整理当前开发计划，再恢复源码。';
    else binding = this.tools.prepare({ projectId, planRunId: plan.run.id }).binding;

    const history = this.sources.history(projectId);
    const revision = history.at(-1)!.revision;
    const artifacts = this.artifacts.list(projectId);
    // A missing workspace on a fresh process must not be interpreted as an empty project
    // when other durable records prove source used to exist.
    for (const artifact of artifacts) {
      if (
        history.find((item) => item.revision === artifact.sourceRevision)?.snapshotHash !==
        artifact.sourceHash
      )
        throw inconsistent();
    }
    const coding = this.coding.history(projectId);
    const repair = this.repairs.history(projectId);
    const attempts = this.builds.attempts(projectId);
    const runs: RecoveryRun[] = [];
    for (const [kind, run] of [
      ...coding.map((run) => ['coding', run] as const),
      ...repair.map((run) => ['repair', run] as const),
    ] as const) {
      if (!run) continue;
      if (
        run.initialRevision > revision ||
        ('latestRevision' in run && run.latestRevision > revision)
      )
        throw inconsistent();
      const receipts = history.filter(
        (item) =>
          item.requestId && run.toolRequests.some((tool) => tool.requestId === item.requestId),
      );
      if (
        receipts.some(
          (item) =>
            item.restoredFrom !== null ||
            item.revision <= run.initialRevision ||
            item.binding?.planRunId !== run.planRunId ||
            ('planInputHash' in run && !sameBinding(item.binding, run)),
        )
      )
        throw inconsistent();
      if (run.status === 'draft_saved' && !receipts.length) throw inconsistent();
      const artifact =
        'buildId' in run && run.buildId
          ? artifacts.find(
              (item) =>
                item.id === run.buildId &&
                sameBinding(item, run) &&
                item.sourceRevision === run.latestRevision,
            )
          : null;
      if (run.status === 'succeeded' && !artifact) throw inconsistent();
      if (run.status === 'succeeded' && 'runtimeReportId' in run && run.runtimeReportId) {
        const report = run.runtimeResultId
          ? this.runtime?.get(projectId, run.runtimeResultId)
          : null;
        if (
          !report ||
          report.mode !== 'check' ||
          report.status !== 'observed' ||
          report.issues.length ||
          report.buildId !== artifact!.id ||
          report.artifactHash !== artifact!.artifactHash ||
          report.sourceHash !== artifact!.sourceHash ||
          report.sourceRevision !== artifact!.sourceRevision ||
          !sameBinding(report, run)
        )
          throw inconsistent();
      }
      const unconfirmedTools = run.toolRequests.length - receipts.length;
      runs.push({
        id: run.id,
        kind,
        status: run.status,
        phase:
          'phase' in run && run.phase === 'runtime_checking' && run.status !== 'succeeded'
            ? 'runtime'
            : artifact
              ? 'saved'
              : 'phase' in run && run.phase === 'checking'
                ? 'build'
                : unconfirmedTools
                  ? 'tools'
                  : 'model',
        rounds: run.rounds,
        committedRevisions: receipts.map((item) => item.revision),
        unconfirmedTools,
        buildId: artifact?.id ?? null,
      });
    }
    for (const attempt of attempts) {
      if (
        history.find((item) => item.revision === attempt.sourceRevision)?.snapshotHash !==
        attempt.sourceHash
      )
        throw inconsistent();
    }
    const last = attempts.at(-1);
    if (last) {
      if (
        history.find((item) => item.revision === last.sourceRevision)?.snapshotHash !==
        last.sourceHash
      )
        throw inconsistent();
      runs.push({
        id: last.id,
        kind: 'build',
        status: last.status,
        phase: last.status === 'succeeded' ? 'saved' : 'build',
        rounds: 0,
        committedRevisions: [],
        unconfirmedTools: 0,
        buildId: last.status === 'succeeded' ? last.id : null,
      });
    }
    if (runs.some((run) => run.status === 'running'))
      blockedReason = '正在处理当前请求，请完成或取消后再恢复源码。';
    return {
      projectId,
      revision,
      planRunId: binding?.planRunId ?? null,
      blockedReason,
      checkpoints: history.map((item) => ({
        ...item,
        buildId:
          [...artifacts]
            .reverse()
            .find(
              (artifact) =>
                artifact.sourceHash === item.snapshotHash && sameBinding(artifact, binding),
            )?.id ?? null,
        canRestore:
          !blockedReason &&
          item.revision !== revision &&
          (item.revision === 0 || sameBinding(item.binding, binding)),
      })),
      runs: runs.filter(
        (run, index) => !runs.slice(index + 1).some((later) => later.kind === run.kind),
      ),
    };
  }

  restore(value: unknown) {
    assertRecord(value);
    assertFields(value, [
      'schemaVersion',
      'requestId',
      'projectId',
      'planRunId',
      'sourceRevision',
      'targetRevision',
    ]);
    if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '恢复请求版本无效。');
    const request: RestoreCheckpointRequest = {
      schemaVersion: 1,
      requestId: parseRevisionId(value.requestId),
      projectId: parseProjectId(value.projectId),
      planRunId: parseRevisionId(value.planRunId),
      sourceRevision: parseSourceRevision(value.sourceRevision),
      targetRevision: parseSourceRevision(value.targetRevision),
    };
    // Acknowledging a committed restore is read-only and remains safe after the
    // project was archived or its confirmations changed while the response was lost.
    const prior = this.sources
      .history(request.projectId)
      .find((item) => item.requestId === request.requestId);
    if (prior) {
      if (
        prior.restoredFrom !== request.targetRevision ||
        prior.binding?.planRunId !== request.planRunId ||
        prior.revision - 1 !== request.sourceRevision
      )
        throw new AppError('REQUEST_CONFLICT', '此恢复请求已对应其他输入，请核对历史记录。');
      return {
        revision: prior.revision,
        previousRevision: prior.revision - 1,
        changedPaths: prior.changedPaths,
        replayed: true,
      };
    }
    const prepared = this.tools.prepare({
      projectId: request.projectId,
      planRunId: request.planRunId,
    });
    for (const run of [
      ...this.coding.history(request.projectId),
      ...this.repairs.history(request.projectId),
    ]) {
      if (run?.toolRequests.some((tool) => tool.requestId === request.requestId))
        throw new AppError('REQUEST_CONFLICT', '此请求标识已被工具记录占用，请重新选择恢复操作。');
    }
    const state = this.state(request.projectId);
    if (state.blockedReason) throw new AppError('RECOVERY_BLOCKED', state.blockedReason);
    const target = state.checkpoints.find((item) => item.revision === request.targetRevision);
    if (!target) throw new AppError('CHECKPOINT_NOT_FOUND', '检查点不存在，已保留当前源码。');
    if (target.revision !== 0 && !sameBinding(target.binding, prepared.binding))
      throw new AppError('STALE_CHECKPOINT', '此检查点属于其他确认方向，不能直接恢复到当前计划。');
    // SourceStore checks the full persisted receipt before the expected revision, so a
    // lost response can be safely reconciled using the exact original request.
    return this.sources.restore(request.projectId, {
      requestId: request.requestId,
      binding: prepared.binding,
      expectedRevision: request.sourceRevision,
      targetRevision: request.targetRevision,
    });
  }
}
