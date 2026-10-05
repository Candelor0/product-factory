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
import type { BuildDiagnostic } from '../shared/build-contracts';
import type { RepairRun } from '../shared/repair-contracts';
import { ProjectStore } from './project-store';
import {
  parseSourceHash,
  parseSourcePath,
  parseSourceRevision,
  sourceHash,
} from './source-protocol';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';

const MAX_BYTES = 1024 * 1024;
const MAX_RUNS = 50;
const statuses: readonly RepairRun['status'][] = [
  'running',
  'succeeded',
  'limited',
  'no_progress',
  'cancelled',
  'failed',
  'interrupted',
];
// Deliberately mirror the fixed source-compiler diagnostics. Arbitrary short strings
// are not safe logs: neither model text nor a native exception may enter this journal.
// Adding a compiler diagnostic requires explicitly reviewing this allowlist too.
const diagnosticMessages = new Set([
  '源码快照无效，无法构建。',
  '缺少 src/app.tsx 入口文件，请提供默认导出的 App 组件。',
  '依赖不在允许范围内；请使用源码树中的相对路径或受支持的 React 模块。',
  '相对引用的源码文件不存在，请核对文件路径。',
  '不支持动态模块路径，请使用明确的字符串导入。',
  '当前模板只支持 ES 模块，请将 require 改为 import。',
  '当前模板不支持 CSS 资源 URL，请使用纯 CSS 样式。',
  '源码语法无法编译，请检查此处。',
  '模块导出不匹配，请检查默认导出和引用的名称。',
  'CSS 内容存在编译问题，请检查此处。',
  '编译器报告了警告，请检查此处。',
  '编译工具未能完成，请保留源码后重试。',
  '编译产物超过大小限制，本次产物未交付。',
  '构建已取消，本次产物未交付。',
]);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const invalid = () => new AppError('INVALID_INPUT', '构建修复记录参数无效。');
const corrupt = () => new AppError('CORRUPT_REPAIR', '构建修复记录校验失败，原文件已保留。');
const conflict = () => new AppError('REPAIR_CONFLICT', '构建修复记录已变化，本次没有覆盖。');
const limit = () => new AppError('REPAIR_LIMIT', '构建修复记录达到容量上限，已有记录保留。');
const unsafe = () => new AppError('UNSAFE_PATH', '构建修复记录不是独立普通文件，已停止访问。');
const archived = () => new AppError('ARCHIVED', '归档项目只能结束已有修复，不能继续或开始修复。');

function isoDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}

function counter(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw invalid();
  return value as number;
}

function parseDiagnostic(value: unknown): BuildDiagnostic {
  assertRecord(value);
  assertFields(value, ['path', 'line', 'message']);
  if (
    typeof value.message !== 'string' ||
    !diagnosticMessages.has(value.message) ||
    (value.line !== null && (!Number.isSafeInteger(value.line) || (value.line as number) < 1))
  )
    throw invalid();
  return {
    path: value.path === null ? null : parseSourcePath(value.path),
    line: value.line as number | null,
    message: value.message,
  };
}

function parseRun(value: unknown): RepairRun {
  assertRecord(value);
  assertFields(value, [
    'id',
    'requestHash',
    'planRunId',
    'planInputHash',
    'planArtifactHash',
    'createdAt',
    'updatedAt',
    'status',
    'phase',
    'initialRevision',
    'latestRevision',
    'rounds',
    'toolCalls',
    'toolRequests',
    'builds',
    'buildId',
    'diagnostics',
    'errorCode',
    'runtimeReportId',
    'runtimeResultId',
  ]);
  const createdAt = isoDate(value.createdAt);
  const updatedAt = isoDate(value.updatedAt);
  const initialRevision = parseSourceRevision(value.initialRevision);
  const latestRevision = parseSourceRevision(value.latestRevision);
  const rounds = counter(value.rounds, 4);
  const toolCalls = counter(value.toolCalls, 12);
  const builds = counter(value.builds, 5);
  if (
    !statuses.includes(value.status as RepairRun['status']) ||
    !['checking', 'repairing', 'runtime_checking'].includes(value.phase as string) ||
    (value.runtimeResultId !== undefined && value.runtimeReportId === undefined) ||
    (value.phase === 'runtime_checking' && value.runtimeReportId === undefined) ||
    (value.status === 'succeeded' &&
      value.runtimeReportId !== undefined &&
      value.runtimeResultId === undefined) ||
    latestRevision < initialRevision ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    !Array.isArray(value.toolRequests) ||
    value.toolRequests.length > toolCalls ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 20 ||
    (value.errorCode !== null &&
      (typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.errorCode)))
  )
    throw invalid();
  const callHashes = new Set<string>();
  const requestIds = new Set<string>();
  const toolRequests = Array.from(value.toolRequests, (raw) => {
    assertRecord(raw);
    assertFields(raw, ['callHash', 'requestId']);
    const callHash = parseSourceHash(raw.callHash);
    const requestId = parseRevisionId(raw.requestId);
    if (callHashes.has(callHash) || requestIds.has(requestId)) throw invalid();
    callHashes.add(callHash);
    requestIds.add(requestId);
    return { callHash, requestId };
  });
  return {
    id: parseRevisionId(value.id),
    requestHash: parseSourceHash(value.requestHash),
    planRunId: parseRevisionId(value.planRunId),
    planInputHash: parseSourceHash(value.planInputHash),
    planArtifactHash: parseSourceHash(value.planArtifactHash),
    createdAt,
    updatedAt,
    status: value.status as RepairRun['status'],
    phase: value.phase as RepairRun['phase'],
    ...(value.runtimeReportId === undefined
      ? {}
      : { runtimeReportId: parseRevisionId(value.runtimeReportId) }),
    ...(value.runtimeResultId === undefined
      ? {}
      : { runtimeResultId: parseRevisionId(value.runtimeResultId) }),
    initialRevision,
    latestRevision,
    rounds,
    toolCalls,
    toolRequests,
    builds,
    buildId: value.buildId === null ? null : parseRevisionId(value.buildId),
    diagnostics: Array.from(value.diagnostics, parseDiagnostic),
    errorCode: value.errorCode as string | null,
  };
}

/**
 * Trusted single-writer metadata journal, not an OS sandbox or proof of compilation.
 * The runner owns authorization, error-code selection and build/source association.
 * This store pins identities, rejects raw diagnostics and never stores model payloads.
 */
export class RepairStore {
  private readonly observedFiles = new Set<string>();
  constructor(private readonly projects: ProjectStore) {}

  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('REPAIR_IO', '构建修复记录保存状态未确认，请先核对现有记录。');
    }
  }

  private path(projectId: string): string {
    this.projects.get(projectId);
    return join(this.projects.rootPath, 'projects', projectId, 'runs', 'repairs.json');
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
        throw new AppError('MISSING_REPAIR', '已读取的构建修复记录被移走，请先恢复原文件。');
      return false;
    }
  }

  private read(projectId: string): { runs: RepairRun[]; bytesHash: string | null } {
    const path = this.path(projectId);
    if (!this.verifyFile(path)) return { runs: [], bytesHash: null };
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw unsafe();
      if (stat.size > MAX_BYTES) throw limit();
      const bytes = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw limit();
      const raw: unknown = JSON.parse(bytes);
      assertRecord(raw);
      if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)
        throw new AppError('UNSUPPORTED_REPAIR', '此构建修复记录版本尚不受支持，原文件已保留。');
      assertFields(raw, ['schemaVersion', 'projectId', 'runs']);
      if (
        raw.projectId !== projectId ||
        !Array.isArray(raw.runs) ||
        raw.runs.length < 1 ||
        raw.runs.length > MAX_RUNS
      )
        throw corrupt();
      const ids = new Set<string>();
      const runs = Array.from(raw.runs, (value) => {
        const run = parseRun(value);
        if (raw.schemaVersion === 1 && run.runtimeReportId !== undefined) throw corrupt();
        if (ids.has(run.id)) throw corrupt();
        ids.add(run.id);
        return run;
      });
      return { runs, bytesHash: sourceHash(bytes) };
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSAFE_PATH', 'UNSUPPORTED_REPAIR', 'REPAIR_LIMIT'].includes(error.code)
      )
        throw error;
      throw corrupt();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  list(projectId: string): RepairRun[] {
    return this.guarded(() => this.read(projectId).runs);
  }

  save(projectId: string, value: RepairRun): void {
    this.guarded(() => {
      const run = parseRun(value);
      const loaded = this.read(projectId);
      const index = loaded.runs.findIndex((item) => item.id === run.id);
      const prior = loaded.runs[index];
      if (prior) {
        if (JSON.stringify(prior) === JSON.stringify(run)) {
          if (run.status === 'running' && this.projects.get(projectId).archived) throw archived();
          return;
        }
        if (
          prior.status !== 'running' ||
          prior.requestHash !== run.requestHash ||
          prior.runtimeReportId !== run.runtimeReportId ||
          prior.planRunId !== run.planRunId ||
          prior.planInputHash !== run.planInputHash ||
          prior.planArtifactHash !== run.planArtifactHash ||
          prior.createdAt !== run.createdAt ||
          prior.initialRevision !== run.initialRevision ||
          prior.latestRevision > run.latestRevision ||
          prior.rounds > run.rounds ||
          prior.toolCalls > run.toolCalls ||
          prior.builds > run.builds ||
          prior.toolRequests.length > run.toolRequests.length ||
          JSON.stringify(prior.toolRequests) !==
            JSON.stringify(run.toolRequests.slice(0, prior.toolRequests.length)) ||
          Date.parse(prior.updatedAt) > Date.parse(run.updatedAt)
        )
          throw conflict();
      } else if (loaded.runs.length >= MAX_RUNS) throw limit();
      const allowArchivedFinalization = Boolean(prior && run.status !== 'running');
      if (this.projects.get(projectId).archived && !allowArchivedFinalization) throw archived();
      if (prior) loaded.runs[index] = run;
      else loaded.runs.push(run);
      this.write(projectId, loaded.runs, loaded.bytesHash, allowArchivedFinalization);
    });
  }

  private write(
    projectId: string,
    runs: RepairRun[],
    previousBytesHash: string | null,
    allowArchivedFinalization: boolean,
  ): void {
    const path = this.path(projectId);
    const bytes =
      JSON.stringify({
        schemaVersion: runs.some((run) => run.runtimeReportId) ? 2 : 1,
        projectId,
        runs,
      }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw limit();
    const temporary = join(dirname(path), `.repair-${randomUUID()}.tmp`);
    let fd: number | undefined;
    let temporaryCreated = false;
    let renamed = false;
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      temporaryCreated = true;
      writeFileSync(fd, bytes, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      if (this.projects.get(projectId).archived && !allowArchivedFinalization) throw archived();
      if (this.read(projectId).bytesHash !== previousBytesHash) throw conflict();
      renameSync(temporary, path);
      renamed = true;
      this.observedFiles.add(path);
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
        throw new AppError(
          'REPAIR_COMMIT_UNCERTAIN',
          '构建修复记录可能已保存，请先重新读取核对结果。',
        );
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        if (temporaryCreated) unlinkSync(temporary);
      } catch (error) {
        if (!missing(error))
          throw new AppError('REPAIR_IO', '临时修复记录未清理完成，请保留现有记录后核对。');
      }
    }
  }
}
