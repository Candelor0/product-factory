import type {
  CodingInput,
  SourceToolContext,
  SourceToolResponse,
} from '../shared/source-contracts';
import { PlanStore } from './plan-store';
import { ProjectStore } from './project-store';
import { SourceStore } from './source-store';
import { parseSourceToolRequest } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

const errors: Record<string, { message: string; retryable: boolean }> = {
  INVALID_INPUT: { message: '工具参数无效，请按协议修正。', retryable: false },
  UNKNOWN_TOOL: { message: '此工具未开放。', retryable: false },
  SOURCE_PATH_DENIED: { message: '只能访问允许的项目源码路径。', retryable: false },
  SOURCE_LIMIT: { message: '源码操作超过当前容量限制。', retryable: false },
  SOURCE_NOT_FOUND: { message: '源码文件不存在，请先查看文件列表。', retryable: false },
  SOURCE_CONFLICT: { message: '源码已变化，请重新读取后提交。', retryable: false },
  REQUEST_CONFLICT: { message: '请求标识已经用于不同的修改。', retryable: false },
  ARCHIVED: { message: '项目已归档，当前工具会话不可继续。', retryable: false },
  CONFIRMATION_REQUIRED: { message: '需要先确认当前需求和页面方向。', retryable: false },
  STALE_PLAN: { message: '开发计划已变化，请重新建立工具会话。', retryable: false },
  UNSAFE_PATH: { message: '存储路径异常，操作已停止。', retryable: false },
  CORRUPT_SOURCE: { message: '源码记录校验失败，原文件已保留。', retryable: false },
  UNSUPPORTED_SOURCE: { message: '此源码记录版本尚不受支持。', retryable: false },
  MISSING_SOURCE: { message: '原源码记录已被移走，请恢复后再继续。', retryable: false },
  SOURCE_IO: { message: '源码存储操作未确认完成，可使用同一请求标识核对重试。', retryable: true },
  SOURCE_COMMIT_UNCERTAIN: {
    message: '修改可能已经保存，请使用同一请求标识核对结果，勿重复创建新请求。',
    retryable: true,
  },
  CORRUPT_PLAN: { message: '开发计划校验失败，请先恢复记录。', retryable: false },
  MISSING_PLAN: { message: '开发计划记录缺失，请先恢复记录。', retryable: false },
  UNSUPPORTED_PLAN: { message: '开发计划版本尚不受支持。', retryable: false },
  CORRUPT_PROJECT: { message: '项目记录校验失败，请先恢复记录。', retryable: false },
  PROJECT_NOT_FOUND: { message: '项目不存在或已被移走。', retryable: false },
};

/** Synchronous trusted dispatcher. Never expose its context setter to generated code or models. */
export class SourceToolExecutor {
  constructor(
    private readonly projects: ProjectStore,
    private readonly plans: PlanStore,
    private readonly sources: SourceStore,
  ) {}

  private bound(context: SourceToolContext) {
    assertRecord(context);
    assertFields(context, ['projectId', 'planRunId']);
    const projectId = parseProjectId(context.projectId);
    const planRunId = parseRevisionId(context.planRunId);
    const project = this.projects.get(projectId);
    if (project.archived) throw new AppError('ARCHIVED', '项目已归档。');
    if (project.stage !== 'ready')
      throw new AppError('CONFIRMATION_REQUIRED', '请先确认当前需求和页面方向。');
    const state = this.plans.get(projectId);
    if (state.status !== 'current' || !state.run || state.run.id !== planRunId)
      throw new AppError('STALE_PLAN', '请基于当前开发计划重新建立会话。');
    return { projectId, project, run: state.run };
  }

  /** Trusted preparation only; keeps audience, exclusions and visual details from confirmed versions. */
  prepare(context: SourceToolContext): CodingInput {
    const { projectId, project, run } = this.bound(context);
    const requirements = project.requirements.at(-1)!;
    const design = project.designs.at(-1)!;
    return {
      schemaVersion: 1,
      binding: {
        planRunId: run.id,
        planInputHash: run.inputHash,
        planArtifactHash: run.artifactHash,
      },
      requirements: { id: requirements.id, hash: requirements.hash, content: requirements.content },
      design: { id: design.id, hash: design.hash, content: design.content },
      plan: run.plan,
      sourceRevision: this.sources.get(projectId).revision,
      capabilities: ['list_files', 'read_file', 'apply_changes'],
      execution: 'disabled',
    };
  }

  execute(context: SourceToolContext, input: unknown): SourceToolResponse {
    let requestId: string | null = null;
    try {
      const request = parseSourceToolRequest(input);
      requestId = request.requestId;
      const { projectId, run } = this.bound(context);
      // Even a replay is checked against today's confirmations before consulting its receipt.
      if (request.tool === 'apply_changes') {
        const result = this.sources.apply(projectId, {
          requestId,
          binding: {
            planRunId: run.id,
            planInputHash: run.inputHash,
            planArtifactHash: run.artifactHash,
          },
          ...request.arguments,
        });
        return { schemaVersion: 1, requestId, ok: true, data: { tool: request.tool, ...result } };
      }
      const snapshot = this.sources.get(projectId);
      if (request.tool === 'list_files') {
        return {
          schemaVersion: 1,
          requestId,
          ok: true,
          data: {
            tool: request.tool,
            revision: snapshot.revision,
            files: snapshot.files.map((file) => ({
              path: file.path,
              sha256: file.sha256,
              bytes: Buffer.byteLength(file.content, 'utf8'),
            })),
          },
        };
      }
      const file = snapshot.files.find((file) => file.path === request.arguments.path);
      if (!file) throw new AppError('SOURCE_NOT_FOUND', '');
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        data: { tool: request.tool, revision: snapshot.revision, file },
      };
    } catch (error) {
      // Never forward native messages, stack traces, host paths, or rejected model arguments.
      const code =
        error instanceof AppError && Object.hasOwn(errors, error.code)
          ? error.code
          : 'SOURCE_INTERNAL';
      return {
        schemaVersion: 1,
        requestId,
        ok: false,
        error: {
          code,
          ...(errors[code] ?? {
            message: '源码工具未完成，现有记录已保留，请检查工作台。',
            retryable: false,
          }),
        },
      };
    }
  }
}
