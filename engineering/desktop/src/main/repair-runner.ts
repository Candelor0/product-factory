import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { BuildRequest, BuildResult } from '../shared/build-contracts';
import type { ModelMessage } from '../shared/model-tool-contracts';
import type { RepairRequest, RepairRun, RepairState } from '../shared/repair-contracts';
import { runtimeIssueMessages, type RuntimeReport } from '../shared/runtime-contracts';
import type { RuntimeService } from './runtime-service';
import type { SourceToolResponse } from '../shared/source-contracts';
import type { BuildService } from './build-service';
import type { ModelService } from './model-service';
import { codingPrompt, codingTools } from './coding-tool-schema';
import { RepairStore } from './repair-store';
import { parseSourceRevision, sourceHash } from './source-protocol';
import { SourceStore } from './source-store';
import { SourceToolExecutor } from './source-tools';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

const recoverable = new Set([
  'INVALID_INPUT',
  'UNKNOWN_TOOL',
  'SOURCE_PATH_DENIED',
  'SOURCE_NOT_FOUND',
  'SOURCE_CONFLICT',
]);
const publicCodes = new Set([
  'MODEL_CANCELLED',
  'CANCELLED',
  'BUILD_CANCELLED',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'TRUNCATED_RESPONSE',
  'SENSITIVE_RESPONSE',
  'BUDGET_EXCEEDED',
  'KEY_REQUIRED',
  'CREDENTIAL_UNAVAILABLE',
  'STORAGE_ERROR',
  'AUTH_FAILED',
  'QUOTA_EXCEEDED',
  'ACCESS_DENIED',
  'MODEL_NOT_FOUND',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
  'BUSY',
  'ARCHIVED',
  'CONFIRMATION_REQUIRED',
  'STALE_PLAN',
  'STALE_SOURCE',
  'SOURCE_LIMIT',
  'SOURCE_IO',
  'SOURCE_COMMIT_UNCERTAIN',
  'CORRUPT_SOURCE',
  'MISSING_SOURCE',
  'UNSUPPORTED_SOURCE',
  'UNSAFE_PATH',
  'REPAIR_LIMIT',
  'REPAIR_CONFLICT',
  'REPAIR_IO',
  'REPAIR_COMMIT_UNCERTAIN',
  'CORRUPT_REPAIR',
  'MISSING_REPAIR',
  'UNSUPPORTED_REPAIR',
  'BUILD_LIMIT',
  'BUILD_INTERRUPTED',
  'BUILD_RUN_LIMIT',
  'BUILD_RUN_IO',
  'BUILD_RUN_CONFLICT',
  'BUILD_RUN_COMMIT_UNCERTAIN',
  'CORRUPT_BUILD_RUN',
  'MISSING_BUILD_RUN',
  'UNSUPPORTED_BUILD_RUN',
  'BUILD_IO',
  'BUILD_CONFLICT',
  'BUILD_COMMIT_UNCERTAIN',
  'CORRUPT_BUILD',
  'MISSING_BUILD',
  'UNSUPPORTED_BUILD',
  'EMPTY_SOURCE',
  'TOOLCHAIN_UNAVAILABLE',
  'RUNTIME_LIMIT',
  'RUNTIME_IO',
  'RUNTIME_CONFLICT',
  'RUNTIME_COMMIT_UNCERTAIN',
  'CORRUPT_RUNTIME',
  'MISSING_RUNTIME',
  'UNSUPPORTED_RUNTIME',
  'STALE_RUNTIME',
  'RUNTIME_CANCELLED',
  'PREVIEW_FAILED',
  'RUNTIME_RECORD_IO',
  'RUNTIME_RECORD_LIMIT',
  'RUNTIME_RECORD_CONFLICT',
  'RUNTIME_RECORD_COMMIT_UNCERTAIN',
  'CORRUPT_RUNTIME_RECORD',
  'MISSING_RUNTIME_RECORD',
  'UNSUPPORTED_RUNTIME_RECORD',
  'RUNTIME_CHECK_FAILED',
]);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function request(value: unknown): RepairRequest {
  assertRecord(value);
  assertFields(value, [
    'schemaVersion',
    'requestId',
    'projectId',
    'planRunId',
    'sourceRevision',
    'runtimeReportId',
  ]);
  if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '修复请求版本无效。');
  return {
    schemaVersion: 1,
    requestId: parseRevisionId(value.requestId),
    projectId: parseProjectId(value.projectId),
    planRunId: parseRevisionId(value.planRunId),
    sourceRevision: parseSourceRevision(value.sourceRevision),
    ...(value.runtimeReportId === undefined
      ? {}
      : { runtimeReportId: parseRevisionId(value.runtimeReportId) }),
  };
}
/** Namespaces keep trusted build IDs distinct from model tool call IDs. */
function operationId(
  runId: string,
  kind: 'build' | 'tool' | 'runtime',
  value: string | number,
): string {
  const chars = hash([runId, kind, value]).slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = '8';
  const s = chars.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const repairPrompt = `${codingPrompt}
本轮是已有源码的有限构建修复。可信协调器已经实际编译失败，接下来会提供受限诊断。
先读取相关源码，再保留已确认需求和页面方向进行最小修复；不通过删除必要功能或修改构建标准消除错误。
每轮工具结束后，协调器只在源码内容发生变化时重新编译，并给出真实结果。编译成功后协调器会结束本轮；你的文字不能决定成功，也不能代表业务验收通过。
本次最多4轮模型请求、12次工具、含首次检查在内5次构建。无法修复时停止，保留已保存的源码。`;
const runtimeRepairPrompt = `${codingPrompt}
本轮是已有前端页面的有限运行修复。主进程已在隔离窗口中观察到错误，接下来会提供固定类别反馈；这些观测不是业务验收，也不代表未来交互正常。
先读取相关源码，保留已确认需求和页面方向进行最小修复。不能删除必要功能、吞掉错误、修改全局错误处理器或伪造日志来消除错误。
每次源码内容变化后，协调器重新编译并在新隔离窗口中观察启动。只在编译和有限启动观察均无错误时结束本轮；模型文字不能决定结果。
最多4轮模型请求、12次工具、含首次检查在内5次构建及5次启动检查。无法修复时停止，保留已保存源码。`;

/** Bounded compiler repair; the only success authority is the trusted BuildService. */
export class RepairRunner {
  private active: { id: string; projectId: string; controller: AbortController } | null = null;
  private readonly timeoutMs: number;
  private readonly runtime?: Pick<RuntimeService, 'get' | 'state' | 'check'>;
  constructor(
    private readonly records: RepairStore,
    private readonly source: SourceStore,
    private readonly tools: SourceToolExecutor,
    private readonly models: Pick<ModelService, 'toolTurn'>,
    private readonly builds: Pick<BuildService, 'build' | 'cancel'>,
    options: { timeoutMs?: number; runtime?: Pick<RuntimeService, 'get' | 'state' | 'check'> } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.runtime = options.runtime;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 180_000)
      throw new AppError('INVALID_INPUT', '修复时限无效。');
  }

  cancel() {
    if (!this.active) return;
    this.active.controller.abort();
    this.builds.cancel();
  }

  history(projectId: string): RepairRun[] {
    const id = parseProjectId(projectId);
    return this.records.list(id).map((run) => {
      if (run.status === 'running' && (this.active?.id !== run.id || this.active.projectId !== id))
        run.status = 'interrupted';
      return run;
    });
  }

  state(projectId: string): RepairState {
    const id = parseProjectId(projectId);
    const run = this.history(id).at(-1) ?? null;
    return { projectId: id, run };
  }

  async repair(value: unknown): Promise<RepairState> {
    const parsed = request(value);
    const { projectId, planRunId } = parsed;
    const prior = this.records.list(projectId).find((item) => item.id === parsed.requestId);
    if (prior) {
      if (prior.requestHash !== hash(parsed))
        throw new AppError('REPAIR_CONFLICT', '此修复请求已用于其他输入。');
      // Reopening or retrying never automatically repeats a paid request.
      return this.state(projectId);
    }
    if (this.active) throw new AppError('BUSY', '正在检查和修复，请等待或取消。');
    const context = { projectId, planRunId };
    const prepared = this.tools.prepare(context);
    let expected = this.source.get(projectId);
    if (expected.revision !== parsed.sourceRevision)
      throw new AppError('STALE_SOURCE', '源码已变化，请刷新后重新修复。');
    let runtimeResult: RuntimeReport | null = null;
    if (parsed.runtimeReportId) {
      const state = this.runtime?.state(projectId);
      const report = this.runtime?.get(projectId, parsed.runtimeReportId);
      if (
        !report ||
        !state?.current ||
        state.report?.id !== report.id ||
        report.status !== 'issues' ||
        report.sourceRevision !== expected.revision ||
        report.sourceHash !== hash(expected) ||
        report.planRunId !== planRunId ||
        report.planInputHash !== prepared.binding.planInputHash ||
        report.planArtifactHash !== prepared.binding.planArtifactHash
      )
        throw new AppError('STALE_RUNTIME', '运行问题记录已失效，请先检查当前构建。');
    }
    const now = new Date().toISOString();
    const run: RepairRun = {
      id: parsed.requestId,
      requestHash: hash(parsed),
      ...prepared.binding,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      phase: 'checking',
      initialRevision: expected.revision,
      latestRevision: expected.revision,
      rounds: 0,
      toolCalls: 0,
      toolRequests: [],
      builds: 0,
      buildId: null,
      diagnostics: [],
      errorCode: null,
      ...(parsed.runtimeReportId ? { runtimeReportId: parsed.runtimeReportId } : {}),
    };
    let persistenceFailed = false;
    const persist = () => {
      const intended = structuredClone(run);
      try {
        this.records.save(projectId, run);
      } catch (error) {
        if (error instanceof AppError && error.code === 'REPAIR_COMMIT_UNCERTAIN') {
          try {
            const stored = this.records.list(projectId).find((item) => item.id === run.id);
            if (isDeepStrictEqual(stored, intended)) return;
          } catch {
            // Failure to verify must preserve the original uncertainty, not replace it.
          }
        }
        persistenceFailed = true;
        throw error;
      }
    };
    persist();
    const controller = new AbortController();
    this.active = { id: run.id, projectId, controller };
    let timedOut = false;
    const deadline = Date.now() + this.timeoutMs;
    const expire = () => {
      timedOut = true;
      controller.abort();
      this.builds.cancel();
    };
    const timer = setTimeout(expire, this.timeoutMs);
    const save = () => {
      run.updatedAt = new Date().toISOString();
      persist();
    };
    const checkBinding = () => {
      if (!controller.signal.aborted && Date.now() >= deadline) expire();
      if (controller.signal.aborted)
        throw new AppError(timedOut ? 'TIMEOUT' : 'MODEL_CANCELLED', '本次修复已停止。');
      const fresh = this.tools.prepare(context);
      if (hash(fresh.binding) !== hash(prepared.binding))
        throw new AppError('STALE_PLAN', '确认方向已变化，本次修复已停止。');
    };
    const check = () => {
      checkBinding();
      if (hash(this.source.get(projectId)) !== hash(expected))
        throw new AppError('STALE_SOURCE', '源码已被其他操作修改，本次修复已停止。');
    };
    // A provider ignoring abort cannot keep this coordinator alive or execute a late tool turn.
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      let abort!: () => void;
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new AppError('MODEL_CANCELLED', '本次修复已停止。'));
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      });
      try {
        return await Promise.race([operation, stopped]);
      } finally {
        controller.signal.removeEventListener('abort', abort);
      }
    };
    const compile = async (): Promise<BuildResult> => {
      check();
      runtimeResult = null;
      if (run.builds >= 5) throw new AppError('REPAIR_LIMIT', '本次构建次数已达上限。');
      run.phase = 'checking';
      run.builds++;
      run.buildId = operationId(run.id, 'build', run.builds);
      save();
      const result = await wait(
        this.builds.build({
          schemaVersion: 1,
          requestId: run.buildId,
          ...context,
          sourceRevision: expected.revision,
        }),
      );
      check();
      if (result.status === 'cancelled') throw new AppError('BUILD_CANCELLED', '本次构建已停止。');
      if (result.status === 'succeeded') {
        const artifact = result.state.artifact;
        if (
          result.state.status !== 'current' ||
          !artifact ||
          artifact.id !== run.buildId ||
          artifact.sourceRevision !== expected.revision ||
          artifact.sourceHash !== hash(expected) ||
          artifact.planRunId !== planRunId ||
          artifact.planInputHash !== run.planInputHash ||
          artifact.planArtifactHash !== run.planArtifactHash
        )
          throw new AppError('STALE_SOURCE', '构建结果不匹配当前版本，本次产物未采用。');
        run.diagnostics = [];
        if (run.runtimeReportId) {
          run.phase = 'runtime_checking';
          run.runtimeResultId = operationId(run.id, 'runtime', run.builds);
          save();
          const report = await wait(
            this.runtime!.check(
              {
                schemaVersion: 1,
                requestId: run.runtimeResultId,
                projectId,
                buildId: artifact.id,
              },
              controller.signal,
            ),
          );
          check();
          if (report.status === 'cancelled')
            throw new AppError('RUNTIME_CANCELLED', '启动检查已停止。');
          if (
            report.id !== run.runtimeResultId ||
            report.mode !== 'check' ||
            report.buildId !== artifact.id ||
            report.artifactHash !== artifact.artifactHash ||
            report.sourceRevision !== expected.revision ||
            report.sourceHash !== artifact.sourceHash ||
            report.planRunId !== run.planRunId ||
            report.planInputHash !== run.planInputHash ||
            report.planArtifactHash !== run.planArtifactHash ||
            !['observed', 'issues'].includes(report.status) ||
            (report.status === 'observed' && report.issues.length !== 0) ||
            (report.status === 'issues' && report.issues.length === 0)
          )
            throw new AppError('STALE_RUNTIME', '启动检查结果不匹配当前版本，本次结果未采用。');
          runtimeResult = report;
          if (report.status === 'observed') {
            if (run.builds === 1 && run.latestRevision === run.initialRevision) {
              // A startup-only observation cannot prove an earlier interaction fault was fixed.
              run.status = 'no_progress';
              run.errorCode = 'RUNTIME_NOT_REPRODUCED';
            } else run.status = 'succeeded';
          } else run.phase = 'repairing';
        } else run.status = 'succeeded';
      } else {
        // BuildService emits fixed compiler messages, never compiler source excerpts.
        run.diagnostics = structuredClone(result.diagnostics);
        run.phase = 'repairing';
      }
      if (run.status === 'running') save();
      return result;
    };
    const messages: ModelMessage[] = [
      { role: 'system', content: parsed.runtimeReportId ? runtimeRepairPrompt : repairPrompt },
      { role: 'user', content: JSON.stringify(prepared) },
    ];
    const feedback = () =>
      messages.push({
        role: 'user',
        content: JSON.stringify({
          type: runtimeResult ? 'observed_runtime_issues' : 'trusted_build_result',
          status: 'failed',
          sourceRevision: expected.revision,
          diagnostics: run.diagnostics,
          ...(runtimeResult
            ? {
                observedMs: runtimeResult.observedMs,
                issues: runtimeResult.issues.map((code) => ({
                  code,
                  message: runtimeIssueMessages[code],
                })),
                scope: 'isolated_startup_observation_only',
              }
            : {}),
        }),
      });
    const receipts = new Map<string, { hash: string; response: SourceToolResponse }>();
    try {
      let builtContent = sourceHash(JSON.stringify(expected.files));
      await compile();
      if (run.status === 'running') {
        feedback();
        for (let round = 0; round < 4; round++) {
          check();
          if (Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024)
            throw new AppError('REPAIR_LIMIT', '本次修复上下文已达上限。');
          run.rounds++;
          save();
          const turn = await wait(this.models.toolTurn(messages, codingTools, controller.signal));
          check();
          messages.push(turn.message);
          if (turn.finishReason === 'stop') {
            run.status = 'no_progress';
            break;
          }
          const calls = turn.message.tool_calls!;
          if (run.toolCalls + calls.length > 12)
            throw new AppError('REPAIR_LIMIT', '本次工具次数已达上限。');
          for (const call of calls) {
            await setImmediate();
            check();
            const fingerprint = hash(call.function);
            const cached = receipts.get(call.id);
            if (cached && cached.hash !== fingerprint)
              throw new AppError('REPAIR_CONFLICT', '工具标识重复且参数不同。');
            const requestId = operationId(run.id, 'tool', call.id);
            run.toolCalls++;
            if (!cached) run.toolRequests.push({ callHash: hash(call.id), requestId });
            save();
            const input = {
              schemaVersion: 1,
              requestId,
              tool: call.function.name,
              arguments: JSON.parse(call.function.arguments),
            };
            let response = cached?.response ?? this.tools.execute(context, input);
            if (!response.ok && response.error.retryable) {
              checkBinding();
              // Reconcile an uncertain local commit with the same ID, without a paid retry.
              response = this.tools.execute(context, input);
            }
            receipts.set(call.id, { hash: fingerprint, response });
            if (!response.ok && !recoverable.has(response.error.code))
              throw new AppError(response.error.code, '源码工具已停止。');
            if (!cached && response.ok && response.data.tool === 'apply_changes') {
              const next = this.source.get(projectId);
              if (
                next.revision !== response.data.revision ||
                response.data.previousRevision !== expected.revision
              )
                throw new AppError('STALE_SOURCE', '源码修改结果不匹配当前版本。');
              expected = next;
              run.latestRevision = next.revision;
              save();
            }
            check();
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(response),
            });
          }
          const content = sourceHash(JSON.stringify(expected.files));
          if (content !== builtContent) {
            await compile();
            builtContent = content;
            if ((run.status as RepairRun['status']) === 'succeeded') break;
            feedback();
          }
        }
      }
      if (run.status === 'running') {
        run.status = 'limited';
        run.errorCode = 'REPAIR_LIMIT';
      }
      save();
    } catch (error) {
      // A journal error may follow an atomic commit. Never overwrite that outcome or
      // its counters with a guessed failure status, and never mask the original error.
      if (persistenceFailed) throw error;
      const code = timedOut
        ? 'TIMEOUT'
        : controller.signal.aborted
          ? 'MODEL_CANCELLED'
          : error instanceof AppError && publicCodes.has(error.code)
            ? error.code
            : 'REPAIR_FAILED';
      run.status =
        timedOut || code === 'REPAIR_LIMIT' || code === 'BUDGET_EXCEEDED'
          ? 'limited'
          : ['MODEL_CANCELLED', 'CANCELLED', 'BUILD_CANCELLED', 'RUNTIME_CANCELLED'].includes(code)
            ? 'cancelled'
            : 'failed';
      run.errorCode = code;
      save();
    } finally {
      clearTimeout(timer);
      this.active = null;
    }
    return this.state(projectId);
  }
}
