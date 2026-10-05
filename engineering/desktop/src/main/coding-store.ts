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
import type { CodingRun } from '../shared/coding-contracts';
import { ProjectStore } from './project-store';
import { sourceHash } from './source-protocol';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';

const MAX_BYTES = 512 * 1024;
const MAX_RUNS = 50;
const statuses: readonly CodingRun['status'][] = [
  'running',
  'draft_saved',
  'no_changes',
  'cancelled',
  'failed',
  'limited',
  'interrupted',
];
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const invalid = () => new AppError('INVALID_INPUT', '源码生成记录参数无效。');
const corrupt = () => new AppError('CORRUPT_CODING', '源码生成记录校验失败，原文件已保留。');
const conflict = () => new AppError('CODING_CONFLICT', '源码生成记录已变化，本次没有覆盖。');
const limit = () => new AppError('CODING_LIMIT', '源码生成记录已达容量上限，已有记录保留。');
const unsafe = () => new AppError('UNSAFE_PATH', '源码生成记录不是独立普通文件，已停止访问。');

function isoDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}

function parseRun(value: unknown): CodingRun {
  assertRecord(value);
  assertFields(value, [
    'id',
    'requestHash',
    'planRunId',
    'createdAt',
    'updatedAt',
    'status',
    'initialRevision',
    'rounds',
    'toolCalls',
    'toolRequests',
    'errorCode',
  ]);
  const id = parseRevisionId(value.id);
  const planRunId = parseRevisionId(value.planRunId);
  const createdAt = isoDate(value.createdAt);
  const updatedAt = isoDate(value.updatedAt);
  if (
    typeof value.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.requestHash) ||
    !statuses.includes(value.status as CodingRun['status']) ||
    !Number.isSafeInteger(value.initialRevision) ||
    (value.initialRevision as number) < 0 ||
    !Number.isInteger(value.rounds) ||
    (value.rounds as number) < 0 ||
    (value.rounds as number) > 4 ||
    !Number.isInteger(value.toolCalls) ||
    (value.toolCalls as number) < 0 ||
    (value.toolCalls as number) > 12 ||
    !Array.isArray(value.toolRequests) ||
    value.toolRequests.length > 12 ||
    value.toolRequests.length > (value.toolCalls as number) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (value.errorCode !== null &&
      (typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.errorCode)))
  )
    throw invalid();
  const callHashes = new Set<string>();
  const requestIds = new Set<string>();
  const toolRequests = Array.from(value.toolRequests, (raw) => {
    assertRecord(raw);
    assertFields(raw, ['callHash', 'requestId']);
    const requestId = parseRevisionId(raw.requestId);
    if (
      typeof raw.callHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(raw.callHash) ||
      callHashes.has(raw.callHash) ||
      requestIds.has(requestId)
    )
      throw invalid();
    callHashes.add(raw.callHash);
    requestIds.add(requestId);
    return { callHash: raw.callHash, requestId };
  });
  return {
    id,
    requestHash: value.requestHash,
    planRunId,
    createdAt,
    updatedAt,
    status: value.status as CodingRun['status'],
    initialRevision: value.initialRevision as number,
    rounds: value.rounds as number,
    toolCalls: value.toolCalls as number,
    toolRequests,
    errorCode: value.errorCode as string | null,
  };
}

/** Bounded metadata journal; it never stores prompts, model text or credentials. */
export class CodingStore {
  private readonly observedFiles = new Set<string>();
  constructor(
    private readonly projects: ProjectStore,
    private readonly options: { beforeRename?: () => void; afterRename?: () => void } = {},
  ) {}

  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CODING_IO', '源码生成记录保存状态未确认，请先核对现有记录。');
    }
  }

  private path(projectId: string): string {
    this.projects.get(projectId);
    return join(this.projects.rootPath, 'projects', projectId, 'runs', 'coding.json');
  }

  private verifyFile(path: string): boolean {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
      this.observedFiles.add(path);
      if (stat.size > MAX_BYTES) throw limit();
      return true;
    } catch (error) {
      if (!missing(error)) throw error;
      if (this.observedFiles.has(path))
        throw new AppError('MISSING_CODING', '已读取的源码生成记录被移走，请先恢复原文件。');
      return false;
    }
  }

  private read(projectId: string): { runs: CodingRun[]; bytesHash: string | null } {
    const path = this.path(projectId);
    if (!this.verifyFile(path)) return { runs: [], bytesHash: null };
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw unsafe();
      if (stat.size > MAX_BYTES) throw limit();
      const bytes = readFileSync(fd, 'utf8');
      const value: unknown = JSON.parse(bytes);
      assertRecord(value);
      if (value.schemaVersion !== 1)
        throw new AppError('UNSUPPORTED_CODING', '此源码生成记录版本尚不受支持，原文件已保留。');
      assertFields(value, ['schemaVersion', 'projectId', 'runs']);
      if (
        value.projectId !== projectId ||
        !Array.isArray(value.runs) ||
        value.runs.length < 1 ||
        value.runs.length > MAX_RUNS
      )
        throw corrupt();
      const seen = new Set<string>();
      const runs = Array.from(value.runs, (raw) => {
        const run = parseRun(raw);
        if (seen.has(run.id)) throw corrupt();
        seen.add(run.id);
        return run;
      });
      return { runs, bytesHash: sourceHash(bytes) };
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSAFE_PATH', 'UNSUPPORTED_CODING', 'CODING_LIMIT'].includes(error.code)
      )
        throw error;
      throw corrupt();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  list(projectId: string): CodingRun[] {
    return this.guarded(() => this.read(projectId).runs);
  }

  save(projectId: string, value: CodingRun): void {
    this.guarded(() => {
      const run = parseRun(value);
      const loaded = this.read(projectId);
      const index = loaded.runs.findIndex((item) => item.id === run.id);
      if (index >= 0) {
        const prior = loaded.runs[index];
        if (
          prior.requestHash !== run.requestHash ||
          prior.planRunId !== run.planRunId ||
          prior.createdAt !== run.createdAt ||
          prior.initialRevision !== run.initialRevision ||
          prior.rounds > run.rounds ||
          prior.toolCalls > run.toolCalls ||
          prior.toolRequests.length > run.toolRequests.length ||
          JSON.stringify(prior.toolRequests) !==
            JSON.stringify(run.toolRequests.slice(0, prior.toolRequests.length)) ||
          Date.parse(prior.updatedAt) > Date.parse(run.updatedAt) ||
          (prior.status !== 'running' && prior.status !== run.status)
        )
          throw conflict();
        if (JSON.stringify(prior) === JSON.stringify(run)) return;
        loaded.runs[index] = run;
      } else {
        if (loaded.runs.length >= MAX_RUNS) throw limit();
        loaded.runs.push(run);
      }
      this.write(projectId, loaded.runs, loaded.bytesHash);
    });
  }

  private write(projectId: string, runs: CodingRun[], previousBytesHash: string | null): void {
    const path = this.path(projectId);
    const bytes = JSON.stringify({ schemaVersion: 1, projectId, runs }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw limit();
    const temporary = join(dirname(path), `.coding-${randomUUID()}.tmp`);
    let fd: number | undefined;
    let renamed = false;
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, bytes, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.options.beforeRename?.();
      if (this.read(projectId).bytesHash !== previousBytesHash) throw conflict();
      renameSync(temporary, path);
      renamed = true;
      this.observedFiles.add(path);
      this.options.afterRename?.();
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
    } catch (error) {
      if (renamed)
        throw new AppError('CODING_COMMIT_UNCERTAIN', '源码生成记录可能已保存，请核对原请求结果。');
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!missing(error))
          throw new AppError('CODING_IO', '临时生成记录未清理完成，请保留现有记录后核对。');
      }
    }
  }
}
