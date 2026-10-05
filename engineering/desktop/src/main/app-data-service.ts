import { createHash } from 'node:crypto';
import type { BuildArtifact } from '../shared/build-contracts';
import type {
  AppDataApplyResult,
  AppDataResponse,
  AppDataSession,
  AppDataSnapshot,
} from '../shared/app-data-contracts';
import { applyAppDataSnapshot, validateAppDataRequest } from './app-data-protocol';
import type { AppDataStore } from './app-data-store';
import type { SourceToolExecutor } from './source-tools';
import { AppError } from './validation';
import type { SourceStore } from './source-store';
import {
  readSourceDataSchema,
  schemaDefinition,
  validateSchemaValues,
} from './data-schema-protocol';
import { sourceHash } from './source-protocol';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messages: Record<string, string> = {
  APP_DATA_SCHEMA_MISMATCH: '源码与数据结构不一致，请在工作台核对迁移。',
  DATA_SCHEMA_MISMATCH: '保存内容与声明的数据结构不符，本次没有保存。',
  APP_DATA_REVOKED: '此应用会话已关闭，请重新打开应用。',
  APP_DATA_CONFLICT: '内容已有新版本，请重新读取并保留当前编辑后再保存。',
  APP_DATA_REQUEST_CONFLICT: '保存标识已用于其他内容，请核对本次操作。',
  APP_DATA_LIMIT: '本项目内容超过保存容量，请精简后重试。',
  APP_DATA_COMMIT_UNCERTAIN: '保存结果尚未确认，请保留内容并用同一保存标识核对。',
  APP_DATA_MISSING: '已有应用数据缺失，已停止读写，请保留目录并检查备份。',
  APP_DATA_CORRUPT: '应用数据校验失败，原文件已保留。',
  APP_DATA_UNSUPPORTED: '应用数据版本不受支持，原文件已保留。',
  ARCHIVED: '项目已归档，请恢复项目后重新打开应用。',
  STALE_PLAN: '确认方向已变化，请先重新确认并打开当前应用。',
  CONFIRMATION_REQUIRED: '确认方向已变化，请先重新确认并打开当前应用。',
  UNSAFE_PATH: '应用数据路径校验失败，已停止读写。',
  INVALID_INPUT: '数据请求格式无效，本次没有保存。',
  APP_DATA_INVALID: '数据请求格式无效，本次没有保存。',
};
function errorResponse(error: unknown): AppDataResponse {
  const code =
    error instanceof AppError && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : 'APP_DATA_IO';
  return {
    ok: false,
    error: {
      code,
      message: messages[code] ?? '应用数据操作未完成，已保留现有文件。请核对后重试。',
    },
  };
}

/** Session identity comes only from the trusted window factory, never from a renderer payload. */
export class AppDataService {
  constructor(
    private readonly records: Pick<AppDataStore, 'get' | 'apply'>,
    private readonly tools: Pick<SourceToolExecutor, 'prepare'>,
    private readonly sources?: Pick<SourceStore, 'at'>,
  ) {}

  create(artifact: BuildArtifact, mode: AppDataSession['mode']): AppDataSession {
    const source = this.sources?.at(artifact.projectId, artifact.sourceRevision);
    if (source && sourceHash(JSON.stringify(source)) !== artifact.sourceHash)
      throw new AppError('STALE_SOURCE', '构建源码校验失败，请重新构建。');
    const declaration = source ? readSourceDataSchema(source.files) : null;
    const schema = declaration ? schemaDefinition(declaration) : null;
    let revoked = false;
    let memory: AppDataSnapshot = { revision: 0, values: {} };
    const receipts = new Map<string, { hash: string; revision: number }>();
    const validateAccess = () => {
      if (revoked) throw new AppError('APP_DATA_REVOKED', messages.APP_DATA_REVOKED);
      if (mode === 'temporary') return;
      const { binding } = this.tools.prepare({
        projectId: artifact.projectId,
        planRunId: artifact.planRunId,
      });
      if (
        binding.planInputHash !== artifact.planInputHash ||
        binding.planArtifactHash !== artifact.planArtifactHash
      )
        throw new AppError('STALE_PLAN', messages.STALE_PLAN);
    };
    return {
      mode,
      revoke: () => {
        revoked = true;
        memory = { revision: 0, values: {} };
        receipts.clear();
      },
      execute: (input): AppDataResponse => {
        try {
          validateAccess();
          const request = validateAppDataRequest(input);
          if (request.operation === 'read')
            return {
              ok: true,
              value:
                mode === 'persistent'
                  ? this.records.get(artifact.projectId, schema)
                  : structuredClone(memory),
            };
          const { schemaVersion: _schema, operation: _operation, ...apply } = request;
          if (mode === 'persistent')
            return { ok: true, value: this.records.apply(artifact.projectId, apply, schema) };
          const fingerprint = digest(apply);
          const receipt = receipts.get(apply.requestId);
          let result: AppDataApplyResult;
          if (receipt) {
            if (receipt.hash !== fingerprint)
              throw new AppError('APP_DATA_REQUEST_CONFLICT', messages.APP_DATA_REQUEST_CONFLICT);
            result = {
              revision: memory.revision,
              appliedRevision: receipt.revision,
              replayed: true,
            };
          } else {
            const next = applyAppDataSnapshot(memory, apply);
            validateSchemaValues(next.values, schema);
            memory = next;
            receipts.set(apply.requestId, { hash: fingerprint, revision: memory.revision });
            if (receipts.size > 256) receipts.delete(receipts.keys().next().value!);
            result = {
              revision: memory.revision,
              appliedRevision: memory.revision,
              replayed: false,
            };
          }
          return { ok: true, value: result };
        } catch (error) {
          return errorResponse(error);
        }
      },
    };
  }
}
