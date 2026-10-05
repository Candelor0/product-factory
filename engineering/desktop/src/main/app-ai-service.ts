import type {
  AppAiConnection,
  AppAiGrantRequest,
  AppAiResponse,
  AppAiSession,
  AppAiState,
} from '../shared/app-ai-contracts';
import type { BuildArtifact } from '../shared/build-contracts';
import { AppAiStore, APP_AI_RECEIPTS, aiInteger, aiText, appAiUsage } from './app-ai-store';
import type { ModelService } from './model-service';
import type { ProjectStore } from './project-store';
import type { SourceToolExecutor } from './source-tools';
import { sourceHash } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

const messages: Record<string, string> = {
  APP_AI_DISABLED: '临时预览和启动检查不会调用模型。请在工作台授权后打开本地应用。',
  APP_AI_UNAUTHORIZED: '本项目尚未授权文本AI，请在工作台的应用AI授权中配置。',
  APP_AI_REVOKED: '应用AI授权或会话已撤销，请返回工作台核对。',
  APP_AI_STALE: '确认方向或模型连接已变化，请在工作台核对后重新授权。',
  APP_AI_LIMIT: '本项目AI额度或请求记录已到上限，新请求已停止。',
  APP_AI_REQUEST_RECORDED:
    '这次请求已登记，不会重复收费。结果未保存在工作台，请核对后再发起新的操作。',
  APP_AI_REQUEST_CONFLICT: '请求标识已用于其他内容，请核对当前操作。',
  APP_AI_CONFLICT: '应用AI设置或用量已变化，请刷新后重试。',
  BUSY: '模型当前有其他请求，请等待结束后再操作。',
  KEY_REQUIRED: '工作台模型密钥尚未配置，请返回模型设置。',
  CREDENTIAL_UNAVAILABLE: '工作台暂时无法使用保存的密钥，请返回模型设置。',
  CANCELLED: '请求已取消；已发送的请求仍可能计费，不会自动重试。',
  TIMEOUT: '请求超时，供应商可能已计费，请核对后再操作。',
  INVALID_INPUT: '应用AI请求格式或文本长度无效。',
  AUTH_FAILED: '模型认证失败，请返回工作台检查模型连接。',
  QUOTA_EXCEEDED: '供应商额度不足，请检查模型账户。',
  RATE_LIMITED: '供应商请求受限，请稍后操作。',
  SENSITIVE_RESPONSE: '响应包含敏感内容，已拒绝交给应用。',
  EXPORT_SENSITIVE: '请求包含疑似凭据，已停止发送。',
  APP_AI_MISSING: '应用AI记录缺失，已停止调用，请返回工作台核对。',
  APP_AI_CORRUPT: '应用AI记录校验失败，已有文件保留。',
  APP_AI_COMMIT_UNCERTAIN: '请求记录结果尚未确认，不会自动重发，请返回工作台核对。',
};
function fail(code: string): never {
  throw new AppError(code, messages[code] ?? '应用AI操作未完成，请返回工作台核对。');
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function response(error: unknown): AppAiResponse {
  const code =
    error instanceof AppError && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : 'APP_AI_FAILED';
  return {
    ok: false,
    error: {
      code,
      message: messages[code] ?? '模型调用未完成，已登记的请求不会自动重发，请返回工作台核对。',
    },
  };
}

/** A purpose-bound text proxy; project/connection/authorization are never supplied by generated pages. */
export class AppAiService {
  private active = new Map<string, Set<AbortController>>();
  private blocked = new Set<string>();
  constructor(
    private readonly projects: ProjectStore,
    private readonly tools: Pick<SourceToolExecutor, 'prepare'>,
    private readonly models: Pick<
      ModelService,
      'settings' | 'applicationText' | 'assertExportSafe'
    >,
    readonly records: AppAiStore,
  ) {}
  private connection(): AppAiConnection {
    const s = this.models.settings();
    return { id: s.connectionId, provider: s.provider, baseUrl: s.baseUrl, model: s.model };
  }
  state(projectId: string): AppAiState {
    const project = this.projects.get(projectId);
    const record = this.records.get(projectId);
    const connection = this.connection();
    const hasKey = this.models.settings().hasKey;
    let status: AppAiState['status'] = 'unauthorized';
    const grant = record.grant;
    if (grant) {
      status = !grant.enabled ? 'revoked' : 'authorized';
      if (grant.enabled) {
        if (project.archived || !hasKey || this.blocked.has(projectId)) status = 'unavailable';
        else if (!equal(connection, grant.connection)) status = 'stale';
        else {
          try {
            if (
              !equal(
                this.tools.prepare({ projectId, planRunId: grant.binding.planRunId }).binding,
                grant.binding,
              )
            )
              status = 'stale';
          } catch {
            status = 'stale';
          }
        }
      }
    }
    const { usage, budgetTokens } = appAiUsage(record);
    if (
      status === 'authorized' &&
      (usage.calls >= grant!.maxCalls ||
        budgetTokens >= grant!.maxTokens ||
        record.receipts.length >= APP_AI_RECEIPTS)
    )
      status = 'limited';
    return {
      projectId,
      revision: record.revision,
      status,
      grant,
      connection,
      hasKey,
      usage,
      budgetTokens,
      receiptCount: record.receipts.length,
    };
  }
  grant(value: unknown): AppAiState {
    assertRecord(value);
    assertFields(value, [
      'schemaVersion',
      'projectId',
      'planRunId',
      'expectedRevision',
      'connectionId',
      'purpose',
      'maxCalls',
      'maxTokens',
    ]);
    if (value.schemaVersion !== 1) fail('INVALID_INPUT');
    const input: AppAiGrantRequest = {
      schemaVersion: 1,
      projectId: parseProjectId(value.projectId),
      planRunId: parseRevisionId(value.planRunId),
      expectedRevision: aiInteger(value.expectedRevision),
      connectionId: aiText(value.connectionId, 128),
      purpose: aiText(value.purpose, 500).trim(),
      maxCalls: aiInteger(value.maxCalls, 1, APP_AI_RECEIPTS),
      maxTokens: aiInteger(value.maxTokens, 1, 100_000_000),
    };
    const { binding } = this.tools.prepare({
      projectId: input.projectId,
      planRunId: input.planRunId,
    });
    const connection = this.connection();
    if (connection.id !== input.connectionId) fail('APP_AI_STALE');
    if (!this.models.settings().hasKey) fail('KEY_REQUIRED');
    this.models.assertExportSafe([input.purpose]);
    this.cancelProject(input.projectId);
    this.records.update(input.projectId, (record) => {
      if (record.revision !== input.expectedRevision) fail('APP_AI_CONFLICT');
      record.grant = {
        enabled: true,
        purpose: input.purpose,
        binding,
        connection,
        maxCalls: input.maxCalls,
        maxTokens: input.maxTokens,
        updatedAt: new Date().toISOString(),
      };
    });
    this.blocked.delete(input.projectId);
    return this.state(input.projectId);
  }
  revoke(projectId: string): AppAiState {
    this.projects.get(projectId);
    this.cancelProject(projectId);
    this.blocked.add(projectId);
    const current = this.records.get(projectId);
    if (current.grant?.enabled)
      this.records.update(projectId, (record) => {
        record.grant!.enabled = false;
        record.grant!.updatedAt = new Date().toISOString();
      });
    this.blocked.delete(projectId);
    return this.state(projectId);
  }
  cancelProject(projectId: string): void {
    for (const controller of this.active.get(projectId) ?? []) controller.abort();
  }
  cancelAll(): void {
    for (const projectId of this.active.keys()) this.cancelProject(projectId);
  }
  create(artifact: BuildArtifact, mode: AppAiSession['mode']): AppAiSession {
    let revoked = false;
    const controllers = new Set<AbortController>();
    const access = () => {
      if (revoked) fail('APP_AI_REVOKED');
      if (mode !== 'persistent') fail('APP_AI_DISABLED');
      if (this.blocked.has(artifact.projectId)) fail('APP_AI_REVOKED');
      const record = this.records.get(artifact.projectId);
      const grant = record.grant;
      if (!grant) fail('APP_AI_UNAUTHORIZED');
      if (!grant.enabled) fail('APP_AI_REVOKED');
      let binding;
      try {
        binding = this.tools.prepare({
          projectId: artifact.projectId,
          planRunId: artifact.planRunId,
        }).binding;
      } catch {
        return fail('APP_AI_STALE');
      }
      if (
        !equal(grant.connection, this.connection()) ||
        !equal(grant.binding, binding) ||
        binding.planInputHash !== artifact.planInputHash ||
        binding.planArtifactHash !== artifact.planArtifactHash
      )
        fail('APP_AI_STALE');
      return { record, grant };
    };
    return {
      mode,
      revoke: () => {
        revoked = true;
        for (const controller of controllers) controller.abort();
      },
      execute: async (input): Promise<AppAiResponse> => {
        let controller: AbortController | undefined;
        try {
          const initial = access();
          assertRecord(input);
          assertFields(input, ['schemaVersion', 'requestId', 'text']);
          if (input.schemaVersion !== 1) fail('INVALID_INPUT');
          const requestId = parseRevisionId(input.requestId);
          const text = aiText(input.text, 16000);
          this.models.assertExportSafe([text]);
          const grantFingerprint = sourceHash(JSON.stringify(initial.grant));
          const requestHash = sourceHash(
            JSON.stringify({
              text,
              purpose: initial.grant.purpose,
              binding: initial.grant.binding,
              connection: initial.grant.connection.id,
            }),
          );
          const checkReceipt = (record: typeof initial.record) => {
            const previous = record.receipts.find((r) => r.requestId === requestId);
            if (previous)
              fail(
                previous.requestHash === requestHash
                  ? 'APP_AI_REQUEST_RECORDED'
                  : 'APP_AI_REQUEST_CONFLICT',
              );
          };
          checkReceipt(initial.record);
          controller = new AbortController();
          const signal = controller.signal;
          controllers.add(controller);
          const active = this.active.get(artifact.projectId) ?? new Set<AbortController>();
          active.add(controller);
          this.active.set(artifact.projectId, active);
          const validate = () => {
            if (signal.aborted) fail('CANCELLED');
            const current = access();
            if (sourceHash(JSON.stringify(current.grant)) !== grantFingerprint)
              fail('APP_AI_STALE');
            return current;
          };
          const answer = await this.models.applicationText(
            { purpose: initial.grant.purpose, text },
            {
              reserve: (reservedTokens) => {
                const current = validate();
                this.records.update(artifact.projectId, (record) => {
                  checkReceipt(record);
                  const usage = appAiUsage(record);
                  const reservation = aiInteger(reservedTokens, 1);
                  if (
                    record.receipts.length >= APP_AI_RECEIPTS ||
                    usage.usage.calls >= current.grant.maxCalls ||
                    reservation > current.grant.maxTokens - usage.budgetTokens
                  )
                    fail('APP_AI_LIMIT');
                  record.receipts.push({
                    requestId,
                    requestHash,
                    reservedTokens,
                    inputTokens: null,
                    outputTokens: null,
                  });
                });
              },
              settle: (usage) => {
                validate();
                this.records.update(artifact.projectId, (record) => {
                  const receipt = record.receipts.find((r) => r.requestId === requestId);
                  if (
                    !receipt ||
                    receipt.requestHash !== requestHash ||
                    receipt.inputTokens !== null
                  )
                    fail('APP_AI_CONFLICT');
                  const inputTokens = aiInteger(usage.inputTokens);
                  const outputTokens = aiInteger(usage.outputTokens);
                  const previous = appAiUsage(record).usage;
                  if (
                    !Number.isSafeInteger(
                      previous.inputTokens + previous.outputTokens + inputTokens + outputTokens,
                    )
                  ) {
                    // Unknown aggregate cannot be represented exactly. Preserve a durable blocking
                    // reservation instead of silently leaving the small preflight estimate spendable.
                    receipt.reservedTokens = Number.MAX_SAFE_INTEGER;
                  } else {
                    receipt.inputTokens = inputTokens;
                    receipt.outputTokens = outputTokens;
                  }
                });
              },
            },
            signal,
          );
          validate();
          return { ok: true, value: { text: answer } };
        } catch (error) {
          return response(error);
        } finally {
          if (controller) {
            controllers.delete(controller);
            const active = this.active.get(artifact.projectId);
            active?.delete(controller);
            if (!active?.size) this.active.delete(artifact.projectId);
          }
        }
      },
    };
  }
}
