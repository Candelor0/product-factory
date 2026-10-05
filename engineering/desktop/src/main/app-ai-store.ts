import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppAiGrant } from '../shared/app-ai-contracts';
import type { Usage } from '../shared/contracts';
import { ProjectStore } from './project-store';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';
import { parseSourceHash, parseSourceRevision, sourceHash } from './source-protocol';

export interface AppAiReceipt {
  requestId: string;
  requestHash: string;
  reservedTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface AppAiRecord {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  grant: AppAiGrant | null;
  receipts: AppAiReceipt[];
}
export const APP_AI_RECEIPTS = 1000;
const MAX_BYTES = 1024 * 1024;
const absent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const fail = (code: string, message: string): never => {
  throw new AppError(code, message);
};
export function aiInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    return fail('INVALID_INPUT', '应用AI额度或版本格式不正确。');
  return value as number;
}
export function aiText(value: unknown, bytes: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > bytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value)
  )
    return fail('INVALID_INPUT', '应用AI文本格式或长度不正确。');
  return value;
}
function parseGrant(raw: unknown): AppAiGrant {
  assertRecord(raw);
  assertFields(raw, [
    'enabled',
    'purpose',
    'binding',
    'connection',
    'maxCalls',
    'maxTokens',
    'updatedAt',
  ]);
  assertRecord(raw.binding);
  assertFields(raw.binding, ['planRunId', 'planInputHash', 'planArtifactHash']);
  assertRecord(raw.connection);
  assertFields(raw.connection, ['id', 'provider', 'baseUrl', 'model']);
  const url = new URL(raw.connection.baseUrl as string);
  if (
    typeof raw.enabled !== 'boolean' ||
    !['deepseek', 'custom'].includes(raw.connection.provider as string) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof raw.updatedAt !== 'string' ||
    new Date(raw.updatedAt).toISOString() !== raw.updatedAt
  )
    return fail('APP_AI_CORRUPT', '应用AI授权记录校验失败，原文件已保留。');
  return {
    enabled: raw.enabled,
    purpose: aiText(raw.purpose, 500),
    binding: {
      planRunId: parseRevisionId(raw.binding.planRunId),
      planInputHash: parseSourceHash(raw.binding.planInputHash),
      planArtifactHash: parseSourceHash(raw.binding.planArtifactHash),
    },
    connection: {
      id: aiText(raw.connection.id, 128),
      provider: raw.connection.provider as 'deepseek' | 'custom',
      baseUrl: url.href.replace(/\/+$/, ''),
      model: aiText(raw.connection.model, 120),
    },
    maxCalls: aiInteger(raw.maxCalls, 1, APP_AI_RECEIPTS),
    maxTokens: aiInteger(raw.maxTokens, 1, 100_000_000),
    updatedAt: raw.updatedAt,
  };
}
function parseRecord(raw: unknown, projectId: string): AppAiRecord {
  assertRecord(raw);
  assertFields(raw, ['schemaVersion', 'projectId', 'revision', 'grant', 'receipts']);
  if (
    raw.schemaVersion !== 1 ||
    raw.projectId !== projectId ||
    !Array.isArray(raw.receipts) ||
    raw.receipts.length > APP_AI_RECEIPTS
  )
    return fail('APP_AI_CORRUPT', '应用AI用量记录校验失败，原文件已保留。');
  const ids = new Set<string>();
  const receipts = raw.receipts.map((item): AppAiReceipt => {
    assertRecord(item);
    assertFields(item, [
      'requestId',
      'requestHash',
      'reservedTokens',
      'inputTokens',
      'outputTokens',
    ]);
    const requestId = parseRevisionId(item.requestId);
    if (ids.has(requestId) || (item.inputTokens === null) !== (item.outputTokens === null))
      return fail('APP_AI_CORRUPT', '应用AI请求记录校验失败。');
    ids.add(requestId);
    return {
      requestId,
      requestHash: parseSourceHash(item.requestHash),
      reservedTokens: aiInteger(item.reservedTokens, 1),
      inputTokens: item.inputTokens === null ? null : aiInteger(item.inputTokens),
      outputTokens: item.outputTokens === null ? null : aiInteger(item.outputTokens),
    };
  });
  const revision = parseSourceRevision(raw.revision);
  const grant = raw.grant === null ? null : parseGrant(raw.grant);
  if (
    revision < receipts.length ||
    (!grant && receipts.length) ||
    (revision === 0 && (grant || receipts.length))
  )
    return fail('APP_AI_CORRUPT', '应用AI记录顺序校验失败。');
  const record: AppAiRecord = { schemaVersion: 1, projectId, revision, grant, receipts };
  appAiUsage(record);
  return record;
}
export function appAiUsage(record: AppAiRecord): { usage: Usage; budgetTokens: number } {
  const usage: Usage = {
    calls: record.receipts.length,
    inputTokens: 0,
    outputTokens: 0,
    unknownUsageCalls: 0,
  };
  let budgetTokens = 0;
  for (const r of record.receipts) {
    if (r.inputTokens === null) {
      usage.unknownUsageCalls++;
      budgetTokens = Math.min(Number.MAX_SAFE_INTEGER, budgetTokens + r.reservedTokens);
    } else {
      usage.inputTokens += r.inputTokens;
      usage.outputTokens += r.outputTokens!;
      budgetTokens = Math.min(
        Number.MAX_SAFE_INTEGER,
        budgetTokens + r.inputTokens + r.outputTokens!,
      );
    }
  }
  for (const value of [budgetTokens, usage.inputTokens, usage.outputTokens]) aiInteger(value);
  return { usage, budgetTokens };
}
const empty = (projectId: string): AppAiRecord => ({
  schemaVersion: 1,
  projectId,
  revision: 0,
  grant: null,
  receipts: [],
});

/** No prompts, answers or keys. One trusted writer, atomic intent/usage/permission updates. */
export class AppAiStore {
  constructor(
    private readonly projects: ProjectStore,
    private readonly hooks: { beforeRename?: () => void; afterRename?: () => void } = {},
  ) {}
  private paths(projectId: string) {
    this.projects.get(projectId);
    const root = join(this.projects.rootPath, 'projects', projectId, 'runs');
    return { file: join(root, 'app-ai.json'), marker: join(root, 'app-ai.initialized.json') };
  }
  private readFile(path: string): string | null {
    let fd: number | undefined;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES)
        return fail('APP_AI_UNSAFE_PATH', '应用AI记录文件类型或大小异常。');
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.size > MAX_BYTES ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino
      )
        return fail('APP_AI_UNSAFE_PATH', '应用AI记录文件已变化。');
      const bytes = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(bytes) > MAX_BYTES) return fail('APP_AI_LIMIT', '应用AI记录超过容量。');
      return bytes;
    } catch (e) {
      if (absent(e)) return null;
      throw e;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private loaded(projectId: string) {
    const { file, marker } = this.paths(projectId);
    const bytes = this.readFile(file);
    const mark = this.readFile(marker);
    if (mark !== null && mark !== JSON.stringify({ schemaVersion: 1, projectId }) + '\n')
      return fail('APP_AI_CORRUPT', '应用AI初始化标记校验失败。');
    if (bytes === null) {
      if (mark !== null)
        return fail('APP_AI_MISSING', '已初始化的应用AI记录缺失，已停止调用，请恢复原文件。');
      return { record: empty(projectId), hash: null, marked: false };
    }
    let record: AppAiRecord;
    try {
      record = parseRecord(JSON.parse(bytes), projectId);
    } catch {
      return fail('APP_AI_CORRUPT', '应用AI记录损坏，未重置授权或用量。');
    }
    if (mark === null && record.revision !== 0)
      return fail('APP_AI_MISSING', '应用AI初始化标记缺失，已停止调用。');
    return { record, hash: sourceHash(bytes), marked: mark !== null };
  }
  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof AppError) throw e;
      return fail('APP_AI_STORAGE', '应用AI记录未能安全保存，请保留原文件并核对。');
    }
  }
  get(projectId: string): AppAiRecord {
    return this.guard(() => this.loaded(projectId).record);
  }
  private syncDirectory(file: string) {
    if (process.platform === 'win32') return;
    const fd = openSync(dirname(file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private createFile(path: string, bytes: string) {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.syncDirectory(path);
  }
  update(projectId: string, change: (record: AppAiRecord) => void): AppAiRecord {
    return this.guard(() => {
      let loaded = this.loaded(projectId);
      const originalHash = loaded.hash;
      const next = structuredClone(loaded.record);
      change(next);
      next.revision++;
      const checked = parseRecord(next, projectId);
      const bytes = JSON.stringify(checked) + '\n';
      if (Buffer.byteLength(bytes) > MAX_BYTES)
        return fail('APP_AI_LIMIT', '应用AI记录达到容量上限，已有用量保留。');
      const { file, marker } = this.paths(projectId);
      // An empty first record is safe to finish initializing after a crash; nonempty records require their marker.
      if (loaded.hash === null) this.createFile(file, JSON.stringify(empty(projectId)) + '\n');
      if (!loaded.marked)
        this.createFile(marker, JSON.stringify({ schemaVersion: 1, projectId }) + '\n');
      loaded = this.loaded(projectId);
      const originalRevision = next.revision - 1;
      if (
        loaded.record.revision !== originalRevision ||
        (originalHash !== null && loaded.hash !== originalHash)
      )
        return fail('APP_AI_CONFLICT', '应用AI用量已变化，请刷新后重试。');
      const temp = join(dirname(file), `.app-ai-${randomUUID()}.tmp`);
      let renamed = false;
      try {
        this.createFile(temp, bytes);
        this.hooks.beforeRename?.();
        if (this.loaded(projectId).hash !== loaded.hash)
          return fail('APP_AI_CONFLICT', '应用AI记录已变化，未覆盖已有内容。');
        if (this.readFile(temp) !== bytes)
          return fail('APP_AI_UNSAFE_PATH', '应用AI临时记录已变化，已停止保存。');
        renameSync(temp, file);
        renamed = true;
        this.hooks.afterRename?.();
        this.syncDirectory(file);
      } catch (e) {
        if (renamed)
          return fail(
            'APP_AI_COMMIT_UNCERTAIN',
            '应用AI记录可能已保存，请重新读取核对；不会自动重发请求。',
          );
        throw e;
      } finally {
        try {
          unlinkSync(temp);
        } catch (e) {
          if (!absent(e)) return fail('APP_AI_STORAGE', '临时应用AI记录未能清理，请保留现场核对。');
        }
      }
      return checked;
    });
  }
}
