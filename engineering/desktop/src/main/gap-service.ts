import { isDeepStrictEqual } from 'node:util';
import type { GapReport } from '../shared/gap-contracts';
import type { BuildService } from './build-service';
import type { RuntimeService } from './runtime-service';
import type { PlanStore } from './plan-store';
import type { SourceStore } from './source-store';
import { ProjectStore } from './project-store';
import { GapEvidenceStore, parseGapEvidenceRequest } from './gap-evidence-store';
import { deriveGapReport } from './gap-report';
import { assertExportContentsSafe } from './export-security';
import { AppError, assertFields, assertRecord, parseProjectId } from './validation';

/** Only the trusted workbench can write user observations; the model has no evidence tool. */
export class GapService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly plans: Pick<PlanStore, 'get'>,
    private readonly sources: Pick<SourceStore, 'get' | 'history'>,
    private readonly builds: Pick<BuildService, 'state'>,
    private readonly runtime: Pick<RuntimeService, 'state'>,
    private readonly evidence: GapEvidenceStore,
    private readonly assertSafe: (contents: readonly string[]) => void = assertExportContentsSafe,
  ) {}

  state(value: unknown): GapReport {
    assertRecord(value);
    assertFields(value, ['projectId']);
    const projectId = parseProjectId(value.projectId);
    const project = this.projects.get(projectId);
    const source = this.sources.get(projectId);
    const checkpoint = this.sources.history(projectId).find((c) => c.revision === source.revision);
    return deriveGapReport({
      projectId,
      archived: project.archived,
      plan: this.plans.get(projectId),
      source,
      sourceBinding: checkpoint?.binding ?? null,
      build: this.builds.state(projectId),
      runtime: this.runtime.state(projectId),
      evidence: this.evidence.list(projectId),
    });
  }

  record(value: unknown): GapReport {
    const input = parseGapEvidenceRequest(value);
    // An uncertain retry reconciles the original immutable request even after the source changes.
    if (this.evidence.replay(input)) return this.state({ projectId: input.projectId });
    const project = this.projects.get(input.projectId);
    if (project.archived) throw new AppError('ARCHIVED', '请先恢复已归档的项目。');
    const report = this.state({ projectId: input.projectId });
    if (!report.writable || !report.binding || !isDeepStrictEqual(report.binding, input.binding))
      throw new AppError('GAP_STALE', '需求、源码或构建已变化，请刷新报告并重新核验。');
    if (!report.rows.some((row) => row.id === input.taskId))
      throw new AppError('INVALID_INPUT', '这项需求不在当前开发计划中。');
    if (input.filePaths.some((path) => !report.sourceFiles.includes(path)))
      throw new AppError('GAP_FILE_MISSING', '关联源码已不存在或不可作为实现线索，请重新选择。');
    if (input.verdict === 'passed' && (!report.binding.buildId || !input.filePaths.length))
      throw new AppError('GAP_EVIDENCE_REQUIRED', '记录通过前，请构建当前源码并选择关联文件。');
    try {
      this.assertSafe([input.steps, input.expected, input.actual, ...input.filePaths]);
    } catch (error) {
      if (error instanceof AppError && error.code === 'EXPORT_SENSITIVE')
        throw new AppError('GAP_EVIDENCE_SENSITIVE', '核验记录中发现疑似凭据，请移除后再保存。');
      throw error;
    }
    // Synchronous capture + append stays inside the single trusted writer, without a dialog await.
    try {
      this.evidence.append(input);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'GAP_EVIDENCE_COMMIT_UNCERTAIN')
        throw error;
      try {
        if (!this.evidence.replay(input)) throw error;
      } catch {
        throw error;
      }
    }
    return this.state({ projectId: input.projectId });
  }
}
