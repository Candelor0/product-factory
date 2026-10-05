import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setImmediate } from 'node:timers/promises';
import type { CodingExecutionRequest, CodingRun, CodingState } from '../shared/coding-contracts';
import type { ModelMessage } from '../shared/model-tool-contracts';
import type { SourceToolResponse } from '../shared/source-contracts';
import type { ModelService } from './model-service';
import { CodingStore } from './coding-store';
import { SourceStore } from './source-store';
import { SourceToolExecutor } from './source-tools';
import { codingPrompt, codingTools, modificationPrompt } from './coding-tool-schema';
import { assertExportContentsSafe } from './export-security';
import { parseModificationInstruction } from './modification-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';
import {
  parseSourceHash,
  parseSourcePath,
  parseSourceRevision,
  parseSourceToolRequest,
} from './source-protocol';

const recoverable = new Set([
  'INVALID_INPUT',
  'UNKNOWN_TOOL',
  'SOURCE_PATH_DENIED',
  'SOURCE_NOT_FOUND',
  'SOURCE_CONFLICT',
  'SOURCE_READ_REQUIRED',
]);
const publicCodes = new Set([
  'MODEL_CANCELLED',
  'CANCELLED',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'TRUNCATED_RESPONSE',
  'SENSITIVE_RESPONSE',
  'BUDGET_EXCEEDED',
  'TOKEN_BUDGET_EXCEEDED',
  'TOKEN_USAGE_UNKNOWN',
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
function request(value: unknown): CodingExecutionRequest {
  assertRecord(value);
  const schema = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  if (!schema || !('value' in schema)) throw new AppError('INVALID_INPUT', '源码请求版本无效。');
  const fields = ['schemaVersion', 'requestId', 'projectId', 'planRunId'];
  if (schema.value === 2) {
    fields.push('sourceRevision', 'sourceHash', 'instruction');
    if (
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        return (
          typeof key !== 'string' ||
          !fields.includes(key) ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        );
      })
    )
      throw new AppError('INVALID_INPUT', '源码修改请求格式无效。');
  } else if (schema.value !== 1) throw new AppError('INVALID_INPUT', '源码请求版本无效。');
  assertFields(value, fields);
  const base = {
    schemaVersion: 1 as const,
    requestId: parseRevisionId(value.requestId),
    projectId: parseProjectId(value.projectId),
    planRunId: parseRevisionId(value.planRunId),
  };
  return schema.value === 2
    ? {
        ...base,
        schemaVersion: 2,
        sourceRevision: parseSourceRevision(value.sourceRevision),
        sourceHash: parseSourceHash(value.sourceHash),
        instruction: parseModificationInstruction(value.instruction),
      }
    : base;
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
    private readonly options: { assertModificationSafe?: (text: string) => void } = {},
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
    let expected = this.source.get(projectId);
    const initialFilesHash = hash(expected.files);
    const modifying = parsed.schemaVersion === 2;
    const sameBinding = (binding: typeof prepared.binding | null) =>
      binding?.planRunId === prepared.binding.planRunId &&
      binding.planInputHash === prepared.binding.planInputHash &&
      binding.planArtifactHash === prepared.binding.planArtifactHash;
    if (parsed.schemaVersion === 2) {
      if (
        !expected.files.length ||
        expected.revision !== parsed.sourceRevision ||
        hash(expected) !== parsed.sourceHash
      )
        throw new AppError('STALE_SOURCE', '修改基于的源码已变化，请刷新后重新提交。');
      if (!sameBinding(this.source.history(projectId).at(-1)?.binding ?? null))
        throw new AppError('STALE_PLAN', '已有源码不属于当前确认计划，请先核对方向。');
      try {
        (this.options.assertModificationSafe ?? ((text) => assertExportContentsSafe([text])))(
          parsed.instruction,
        );
      } catch (error) {
        if (error instanceof AppError && error.code === 'EXPORT_SENSITIVE')
          throw new AppError('MODIFICATION_SENSITIVE', '修改要求中发现疑似凭据，请移除后再提交。');
        throw error;
      }
    }
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
    const check = (source = true) => {
      if (controller.signal.aborted) throw new AppError('MODEL_CANCELLED', '源码生成已取消。');
      const fresh = this.tools.prepare(context);
      if (modifying && !sameBinding(fresh.binding))
        throw new AppError('STALE_PLAN', '确认方向已变化，本次修改已停止。');
      if (modifying && source && hash(this.source.get(projectId)) !== hash(expected))
        throw new AppError('STALE_SOURCE', '源码已被其他操作修改，本次修改已停止。');
    };
    const messages: ModelMessage[] = [
      { role: 'system', content: modifying ? modificationPrompt : codingPrompt },
      { role: 'user', content: JSON.stringify(prepared) },
      ...(parsed.schemaVersion === 2
        ? [
            {
              role: 'user' as const,
              content: JSON.stringify({
                type: 'user_modification',
                sourceRevision: parsed.sourceRevision,
                sourceHash: parsed.sourceHash,
                instruction: parsed.instruction,
              }),
            },
          ]
        : []),
    ];
    const receipts = new Map<string, { hash: string; response: SourceToolResponse }>();
    const readHashes = new Map<string, string>();
    const ownCommit = (requestId: string) => {
      const snapshot = this.source.get(projectId);
      const checkpoint = this.source.history(projectId).at(-1);
      if (
        snapshot.revision !== expected.revision + 1 ||
        checkpoint?.revision !== snapshot.revision ||
        checkpoint.requestId !== requestId ||
        checkpoint.restoredFrom !== null ||
        checkpoint.snapshotHash !== hash(snapshot) ||
        !sameBinding(checkpoint.binding)
      )
        throw new AppError('STALE_SOURCE', '源码提交不属于本次修改，已停止后续操作。');
      return snapshot;
    };
    const execute = (input: unknown): SourceToolResponse => {
      if (modifying) {
        // Invalid arguments still go through the trusted dispatcher for its fixed error text.
        let parsedTool;
        try {
          parsedTool = parseSourceToolRequest(input);
        } catch {
          /* Dispatcher validates below. */
        }
        if (
          parsedTool?.tool === 'apply_changes' &&
          (parsedTool.arguments.expectedRevision !== expected.revision ||
            parsedTool.arguments.changes.some((change) => {
              const existing = expected.files.find((file) => file.path === change.path);
              return change.expectedHash !== (existing?.sha256 ?? null);
            }))
        )
          return {
            schemaVersion: 1,
            requestId: parsedTool.requestId,
            ok: false,
            error: {
              code: 'SOURCE_CONFLICT',
              message: '修改必须基于本次已核对的源码版本和文件哈希，整批修改尚未执行。',
              retryable: false,
            },
          };
        if (
          parsedTool?.tool === 'apply_changes' &&
          parsedTool.arguments.changes.some((change) => {
            const existing = expected.files.find((file) => file.path === change.path);
            return existing && readHashes.get(change.path) !== existing.sha256;
          })
        )
          return {
            schemaVersion: 1,
            requestId: parsedTool.requestId,
            ok: false,
            error: {
              code: 'SOURCE_READ_REQUIRED',
              message:
                '修改或删除已有文件前，请先用 read_file 读取该文件的当前内容。整批修改尚未执行。',
              retryable: false,
            },
          };
      }
      return this.tools.execute(context, input);
    };
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
          run.status = (
            modifying
              ? hash(expected.files) !== initialFilesHash
              : this.source.get(projectId).revision > run.initialRevision
          )
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
          let response = cached?.response ?? execute(input);
          if (!response.ok && response.error.retryable) {
            if (modifying) {
              check(false);
              // A rename may have committed before returning an uncertain response.
              // Only this exact tool receipt can authorize the one local replay.
              if (hash(this.source.get(projectId)) !== hash(expected)) ownCommit(input.requestId);
            } else check();
            // Local receipt reconciliation, using the same ID; no additional model request.
            response = this.tools.execute(context, input);
          }
          if (modifying && !cached && response.ok) {
            if (response.requestId !== input.requestId)
              throw new AppError('STALE_SOURCE', '源码工具回执不匹配，本次修改已停止。');
            if (response.data.tool === 'apply_changes') {
              const next = ownCommit(input.requestId);
              if (
                response.data.previousRevision !== expected.revision ||
                response.data.revision !== next.revision
              )
                throw new AppError('STALE_SOURCE', '源码修改结果不匹配当前版本。');
              for (const file of expected.files) {
                if (
                  next.files.find((candidate) => candidate.path === file.path)?.sha256 !==
                  file.sha256
                )
                  readHashes.delete(file.path);
              }
              expected = next;
            } else if (response.data.tool === 'read_file') {
              check();
              const read = response.data;
              const file = expected.files.find((candidate) => candidate.path === read.file.path);
              if (read.revision !== expected.revision || !file || hash(file) !== hash(read.file))
                throw new AppError('STALE_SOURCE', '读取结果不匹配当前源码，本次修改已停止。');
              readHashes.set(file.path, file.sha256);
            }
            check();
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
          : [
                'CODING_LIMIT',
                'BUDGET_EXCEEDED',
                'TOKEN_BUDGET_EXCEEDED',
                'TOKEN_USAGE_UNKNOWN',
              ].includes(code)
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
