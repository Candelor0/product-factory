import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setImmediate } from 'node:timers/promises';
import type { CodingRequest, CodingRun, CodingState } from '../shared/coding-contracts';
import type { ModelMessage } from '../shared/model-tool-contracts';
import type { SourceToolResponse } from '../shared/source-contracts';
import type { ModelService } from './model-service';
import { CodingStore } from './coding-store';
import { SourceStore } from './source-store';
import { SourceToolExecutor } from './source-tools';
import { codingPrompt, codingTools } from './coding-tool-schema';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';
import { parseSourcePath } from './source-protocol';

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
  'SOURCE_LIMIT',
  'SOURCE_IO',
  'SOURCE_COMMIT_UNCERTAIN',
  'CORRUPT_SOURCE',
  'MISSING_SOURCE',
  'UNSAFE_PATH',
  'CODING_LIMIT',
  'CODING_CONFLICT',
  'CORRUPT_CODING',
  'CODING_IO',
  'CODING_COMMIT_UNCERTAIN',
  'MISSING_CODING',
]);
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function request(value: unknown): CodingRequest {
  assertRecord(value);
  assertFields(value, ['schemaVersion', 'requestId', 'projectId', 'planRunId']);
  if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '源码请求版本无效。');
  return {
    schemaVersion: 1,
    requestId: parseRevisionId(value.requestId),
    projectId: parseProjectId(value.projectId),
    planRunId: parseRevisionId(value.planRunId),
  };
}
/** Stable trusted UUID; the model does not choose transaction IDs or project bindings. */
function toolId(runId: string, callId: string) {
  const chars = hash([runId, callId]).slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = '8';
  const s = chars.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** One trusted workbench run at a time. Generated content is never executed. */
export class CodingRunner {
  private active: { id: string; projectId: string; controller: AbortController } | null = null;
  constructor(
    private readonly records: CodingStore,
    private readonly source: SourceStore,
    private readonly tools: SourceToolExecutor,
    private readonly models: Pick<ModelService, 'toolTurn'>,
  ) {}

  cancel() {
    this.active?.controller.abort();
  }

  history(projectId: string): CodingRun[] {
    const id = parseProjectId(projectId);
    return this.records.list(id).map((run) => {
      if (run.status === 'running' && (this.active?.id !== run.id || this.active.projectId !== id))
        run.status = 'interrupted';
      return run;
    });
  }

  state(projectId: string): CodingState {
    const id = parseProjectId(projectId);
    const snapshot = this.source.get(id);
    const run = this.history(id).at(-1) ?? null;
    return {
      projectId: id,
      run,
      revision: snapshot.revision,
      execution: 'disabled',
      files: snapshot.files.map(({ path, sha256, content }) => ({
        path,
        sha256,
        bytes: Buffer.byteLength(content),
      })),
    };
  }

  file(projectId: string, path: unknown) {
    const allowed = parseSourcePath(path);
    const file = this.source
      .get(parseProjectId(projectId))
      .files.find((item) => item.path === allowed);
    if (!file) throw new AppError('SOURCE_NOT_FOUND', '源码文件不存在。');
    return file;
  }

  async generate(input: unknown): Promise<CodingState> {
    const parsed = request(input);
    const { projectId, planRunId } = parsed;
    const prior = this.records.list(projectId).find((item) => item.id === parsed.requestId);
    if (prior) {
      if (prior.requestHash !== hash(parsed))
        throw new AppError('CODING_CONFLICT', '此请求已用于其他输入。');
      return this.state(projectId);
    }
    if (this.active) throw new AppError('BUSY', '源码生成正在进行，请等待或取消。');
    const context = { projectId, planRunId };
    const prepared = this.tools.prepare(context);
    const now = new Date().toISOString();
    const run: CodingRun = {
      id: parsed.requestId,
      requestHash: hash(parsed),
      planRunId,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      initialRevision: prepared.sourceRevision,
      rounds: 0,
      toolCalls: 0,
      toolRequests: [],
      errorCode: null,
    };
    let persistenceFailed = false;
    const persist = () => {
      const intended = structuredClone(run);
      try {
        this.records.save(projectId, run);
      } catch (error) {
        if (error instanceof AppError && error.code === 'CODING_COMMIT_UNCERTAIN') {
          try {
            const stored = this.records.list(projectId).find((item) => item.id === run.id);
            if (isDeepStrictEqual(stored, intended)) return;
          } catch {
            /* Keep the original uncertainty if verification also fails. */
          }
        }
        persistenceFailed = true;
        throw error;
      }
    };
    // Persist intent before the first paid request. A crash cannot trigger paid automatic replay.
    persist();
    const controller = new AbortController();
    this.active = { id: run.id, projectId, controller };
    const save = () => {
      run.updatedAt = new Date().toISOString();
      persist();
    };
    const check = () => {
      if (controller.signal.aborted) throw new AppError('MODEL_CANCELLED', '源码生成已取消。');
      this.tools.prepare(context);
    };
    const messages: ModelMessage[] = [
      { role: 'system', content: codingPrompt },
      { role: 'user', content: JSON.stringify(prepared) },
    ];
    const receipts = new Map<string, { hash: string; response: SourceToolResponse }>();
    try {
      for (let round = 0; round < 4; round++) {
        check();
        if (Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024)
          throw new AppError('CODING_LIMIT', '本次上下文已达上限。');
        run.rounds++;
        save();
        const turn = await this.models.toolTurn(messages, codingTools, controller.signal);
        check();
        messages.push(turn.message);
        if (turn.finishReason === 'stop') {
          run.status =
            this.source.get(projectId).revision > run.initialRevision
              ? 'draft_saved'
              : 'no_changes';
          break;
        }
        const calls = turn.message.tool_calls!;
        if (run.toolCalls + calls.length > 12)
          throw new AppError('CODING_LIMIT', '本次工具调用已达上限。');
        for (const call of calls) {
          await setImmediate();
          check();
          const fingerprint = hash(call.function);
          const cached = receipts.get(call.id);
          if (cached && cached.hash !== fingerprint)
            throw new AppError('CODING_CONFLICT', '工具调用标识重复且参数不同。');
          run.toolCalls++;
          if (!cached)
            run.toolRequests.push({ callHash: hash(call.id), requestId: toolId(run.id, call.id) });
          save();
          const input = {
            schemaVersion: 1,
            requestId: toolId(run.id, call.id),
            tool: call.function.name,
            arguments: JSON.parse(call.function.arguments),
          };
          let response = cached?.response ?? this.tools.execute(context, input);
          if (!response.ok && response.error.retryable) {
            check();
            // Local receipt reconciliation, using the same ID; no additional model request.
            response = this.tools.execute(context, input);
          }
          receipts.set(call.id, { hash: fingerprint, response });
          if (!response.ok && !recoverable.has(response.error.code))
            throw new AppError(response.error.code, '源码工具已停止。');
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(response) });
        }
      }
      if (run.status === 'running') {
        run.status = 'limited';
        run.errorCode = 'CODING_LIMIT';
      }
      save();
    } catch (error) {
      if (persistenceFailed) throw error;
      const code = controller.signal.aborted
        ? 'MODEL_CANCELLED'
        : error instanceof AppError && publicCodes.has(error.code)
          ? error.code
          : 'CODING_FAILED';
      run.status =
        code === 'MODEL_CANCELLED' || code === 'CANCELLED'
          ? 'cancelled'
          : code === 'CODING_LIMIT'
            ? 'limited'
            : 'failed';
      run.errorCode = code;
      save();
    } finally {
      this.active = null;
    }
    return this.state(projectId);
  }
}
