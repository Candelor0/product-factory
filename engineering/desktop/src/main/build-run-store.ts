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
import type { BuildAttempt, BuildDiagnostic } from '../shared/build-contracts';
import { ProjectStore } from './project-store';
import {
  parseSourceHash,
  parseSourcePath,
  parseSourceRevision,
  sourceHash,
} from './source-protocol';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';

const MAX_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 100;
const statuses = new Set(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
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
const invalid = () => new AppError('INVALID_INPUT', '构建执行记录参数无效。');
const corrupt = () => new AppError('CORRUPT_BUILD_RUN', '构建执行记录校验失败，原文件已保留。');
const conflict = () => new AppError('BUILD_RUN_CONFLICT', '构建执行记录已变化，本次没有覆盖。');
const limit = () => new AppError('BUILD_RUN_LIMIT', '构建执行记录达到容量上限，已有记录保留。');
const unsafe = () => new AppError('UNSAFE_PATH', '构建执行记录不是独立普通文件，已停止访问。');
const archived = () => new AppError('ARCHIVED', '归档项目只能结束已有构建，不能开始新构建。');

function isoDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
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
function parseAttempt(value: unknown): BuildAttempt {
  assertRecord(value);
  assertFields(value, [
    'id',
    'planRunId',
    'planInputHash',
    'planArtifactHash',
    'sourceRevision',
    'sourceHash',
    'createdAt',
    'updatedAt',
    'status',
    'diagnostics',
    'errorCode',
  ]);
  const createdAt = isoDate(value.createdAt);
  const updatedAt = isoDate(value.updatedAt);
  if (
    typeof value.status !== 'string' ||
    !statuses.has(value.status) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 20 ||
    (value.errorCode !== null &&
      (typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.errorCode))) ||
    (['running', 'succeeded'].includes(value.status) &&
      (value.errorCode !== null || value.diagnostics.length !== 0)) ||
    (value.status === 'cancelled' &&
      (value.errorCode !== 'BUILD_CANCELLED' || value.diagnostics.length !== 0)) ||
    (value.status === 'interrupted' &&
      (value.errorCode !== 'BUILD_INTERRUPTED' || value.diagnostics.length !== 0))
  )
    throw invalid();
  return {
    id: parseRevisionId(value.id),
    planRunId: parseRevisionId(value.planRunId),
    planInputHash: parseSourceHash(value.planInputHash),
    planArtifactHash: parseSourceHash(value.planArtifactHash),
    sourceRevision: parseSourceRevision(value.sourceRevision),
    sourceHash: parseSourceHash(value.sourceHash),
    createdAt,
    updatedAt,
    status: value.status as BuildAttempt['status'],
    diagnostics: Array.from(value.diagnostics, parseDiagnostic),
    errorCode: value.errorCode as string | null,
  };
}

/** A bounded intent/result journal. Source, compiler output and credentials are never copied here. */
export class BuildRunStore {
  private readonly observedFiles = new Set<string>();
  constructor(
    private readonly projects: ProjectStore,
    private readonly options: {
      /** Trusted process-fault injection only; not exposed to renderer/model input. */
      beforeRename?: () => void;
      afterRename?: () => void;
    } = {},
  ) {}

  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('BUILD_RUN_IO', '构建执行记录保存状态未确认，请先核对已有记录。');
    }
  }
  private path(projectId: string) {
    this.projects.get(projectId);
    return join(this.projects.rootPath, 'projects', projectId, 'runs', 'build-attempts.json');
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
        throw new AppError('MISSING_BUILD_RUN', '已读取的构建执行记录被移走，请先恢复原文件。');
      return false;
    }
  }
  private read(projectId: string): { attempts: BuildAttempt[]; bytesHash: string | null } {
    const path = this.path(projectId);
    if (!this.verifyFile(path)) return { attempts: [], bytesHash: null };
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw unsafe();
      if (stat.size > MAX_BYTES) throw limit();
      const bytes = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw limit();
      const value: unknown = JSON.parse(bytes);
      assertRecord(value);
      if (value.schemaVersion !== 1)
        throw new AppError('UNSUPPORTED_BUILD_RUN', '此构建执行记录版本尚不支持，原文件已保留。');
      assertFields(value, ['schemaVersion', 'projectId', 'attempts']);
      if (
        value.projectId !== projectId ||
        !Array.isArray(value.attempts) ||
        value.attempts.length < 1 ||
        value.attempts.length > MAX_ATTEMPTS
      )
        throw corrupt();
      const seen = new Set<string>();
      const attempts = Array.from(value.attempts, (raw) => {
        const attempt = parseAttempt(raw);
        if (seen.has(attempt.id)) throw corrupt();
        seen.add(attempt.id);
        return attempt;
      });
      return { attempts, bytesHash: sourceHash(bytes) };
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSAFE_PATH', 'UNSUPPORTED_BUILD_RUN', 'BUILD_RUN_LIMIT'].includes(error.code)
      )
        throw error;
      throw corrupt();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  list(projectId: string): BuildAttempt[] {
    return this.guarded(() => this.read(projectId).attempts);
  }
  save(projectId: string, value: BuildAttempt): void {
    this.guarded(() => {
      const attempt = parseAttempt(value);
      const loaded = this.read(projectId);
      const index = loaded.attempts.findIndex((item) => item.id === attempt.id);
      const prior = loaded.attempts[index];
      if (prior) {
        if (JSON.stringify(prior) === JSON.stringify(attempt)) return;
        if (
          prior.status !== 'running' ||
          prior.planRunId !== attempt.planRunId ||
          prior.planInputHash !== attempt.planInputHash ||
          prior.planArtifactHash !== attempt.planArtifactHash ||
          prior.sourceRevision !== attempt.sourceRevision ||
          prior.sourceHash !== attempt.sourceHash ||
          prior.createdAt !== attempt.createdAt ||
          Date.parse(prior.updatedAt) > Date.parse(attempt.updatedAt)
        )
          throw conflict();
      } else {
        if (attempt.status !== 'running') throw invalid();
        if (loaded.attempts.length >= MAX_ATTEMPTS) throw limit();
      }
      const finalizeArchived = Boolean(prior && attempt.status !== 'running');
      if (this.projects.get(projectId).archived && !finalizeArchived) throw archived();
      if (prior) loaded.attempts[index] = attempt;
      else loaded.attempts.push(attempt);
      this.write(projectId, loaded.attempts, loaded.bytesHash, finalizeArchived);
    });
  }
  private write(
    projectId: string,
    attempts: BuildAttempt[],
    previousHash: string | null,
    finalizeArchived: boolean,
  ): void {
    const path = this.path(projectId);
    const bytes = JSON.stringify({ schemaVersion: 1, projectId, attempts }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw limit();
    const temporary = join(dirname(path), `.build-run-${randomUUID()}.tmp`);
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
      this.options.beforeRename?.();
      if (this.projects.get(projectId).archived && !finalizeArchived) throw archived();
      if (this.read(projectId).bytesHash !== previousHash) throw conflict();
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
        throw new AppError(
          'BUILD_RUN_COMMIT_UNCERTAIN',
          '构建执行记录可能已保存，请先重新读取核对结果。',
        );
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        if (temporaryCreated) unlinkSync(temporary);
      } catch (error) {
        if (!missing(error))
          throw new AppError('BUILD_RUN_IO', '临时构建记录未清理完成，请保留记录后核对。');
      }
    }
  }
}
