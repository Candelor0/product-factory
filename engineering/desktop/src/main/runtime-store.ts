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
import { runtimeIssueMessages, type RuntimeReport } from '../shared/runtime-contracts';
import { ProjectStore } from './project-store';
import { parseSourceHash, parseSourceRevision, sourceHash } from './source-protocol';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';

const MAX_BYTES = 1024 * 1024;
const MAX_REPORTS = 100;
const statuses = new Set(['observing', 'observed', 'issues', 'cancelled', 'interrupted']);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const invalid = () => new AppError('INVALID_INPUT', '运行观察记录参数无效。');
const corrupt = () =>
  new AppError('CORRUPT_RUNTIME_RECORD', '运行观察记录校验失败，原文件已保留。');
const conflict = () =>
  new AppError('RUNTIME_RECORD_CONFLICT', '运行观察记录已变化，本次没有覆盖。');
const limit = () =>
  new AppError('RUNTIME_RECORD_LIMIT', '运行观察记录达到容量上限，已有记录保留。');
const unsafe = () => new AppError('UNSAFE_PATH', '运行观察记录不是独立普通文件，已停止访问。');
const archived = () => new AppError('ARCHIVED', '归档项目只能结束已有观察，不能开始新观察。');

function isoDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}
export function parseRuntimeReport(value: unknown): RuntimeReport {
  assertRecord(value);
  assertFields(value, [
    'id',
    'buildId',
    'artifactHash',
    'planRunId',
    'planInputHash',
    'planArtifactHash',
    'sourceRevision',
    'sourceHash',
    'mode',
    'createdAt',
    'updatedAt',
    'status',
    'observedMs',
    'issues',
  ]);
  const createdAt = isoDate(value.createdAt);
  const updatedAt = isoDate(value.updatedAt);
  if (
    typeof value.status !== 'string' ||
    !statuses.has(value.status) ||
    !['preview', 'check', 'application'].includes(value.mode as string) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    !Number.isSafeInteger(value.observedMs) ||
    (value.observedMs as number) < 0 ||
    (value.observedMs as number) > 60_000 ||
    !Array.isArray(value.issues) ||
    value.issues.length > Object.keys(runtimeIssueMessages).length ||
    value.issues.some(
      (code) => typeof code !== 'string' || !Object.hasOwn(runtimeIssueMessages, code),
    ) ||
    new Set(value.issues).size !== value.issues.length ||
    (value.status === 'issues' ? value.issues.length === 0 : value.issues.length !== 0) ||
    (value.status === 'observing' && value.observedMs !== 0) ||
    (value.status === 'observed' && value.observedMs === 0)
  )
    throw invalid();
  return {
    id: parseRevisionId(value.id),
    buildId: parseRevisionId(value.buildId),
    artifactHash: parseSourceHash(value.artifactHash),
    planRunId: parseRevisionId(value.planRunId),
    planInputHash: parseSourceHash(value.planInputHash),
    planArtifactHash: parseSourceHash(value.planArtifactHash),
    sourceRevision: parseSourceRevision(value.sourceRevision),
    sourceHash: parseSourceHash(value.sourceHash),
    mode: value.mode as RuntimeReport['mode'],
    createdAt,
    updatedAt,
    status: value.status as RuntimeReport['status'],
    observedMs: value.observedMs as number,
    issues: [...value.issues] as RuntimeReport['issues'],
  };
}
const identity = ({
  updatedAt: _updatedAt,
  status: _status,
  observedMs: _observedMs,
  issues: _issues,
  ...report
}: RuntimeReport) => report;

/** A bounded intent/result journal. Source, compiler output and credentials are never copied here. */
export class RuntimeStore {
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
      throw new AppError('RUNTIME_RECORD_IO', '运行观察记录保存状态未确认，请先核对已有记录。');
    }
  }
  private path(projectId: string) {
    this.projects.get(projectId);
    return join(this.projects.rootPath, 'projects', projectId, 'runs', 'runtime-reports.json');
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
        throw new AppError(
          'MISSING_RUNTIME_RECORD',
          '已读取的运行观察记录被移走，请先恢复原文件。',
        );
      return false;
    }
  }
  private read(projectId: string): { reports: RuntimeReport[]; bytesHash: string | null } {
    const path = this.path(projectId);
    if (!this.verifyFile(path)) return { reports: [], bytesHash: null };
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
      if (value.schemaVersion !== 1 && value.schemaVersion !== 2)
        throw new AppError(
          'UNSUPPORTED_RUNTIME_RECORD',
          '此运行观察记录版本尚不支持，原文件已保留。',
        );
      assertFields(value, ['schemaVersion', 'projectId', 'reports']);
      if (
        value.projectId !== projectId ||
        !Array.isArray(value.reports) ||
        value.reports.length < 1 ||
        value.reports.length > MAX_REPORTS
      )
        throw corrupt();
      const seen = new Set<string>();
      const reports = Array.from(value.reports, (raw) => {
        const report = parseRuntimeReport(raw);
        if (value.schemaVersion === 1 && report.mode === 'application') throw corrupt();
        if (seen.has(report.id)) throw corrupt();
        seen.add(report.id);
        return report;
      });
      return { reports, bytesHash: sourceHash(bytes) };
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSAFE_PATH', 'UNSUPPORTED_RUNTIME_RECORD', 'RUNTIME_RECORD_LIMIT'].includes(error.code)
      )
        throw error;
      throw corrupt();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  list(projectId: string): RuntimeReport[] {
    return this.guarded(() => this.read(projectId).reports);
  }
  save(projectId: string, value: RuntimeReport): void {
    this.guarded(() => {
      const report = parseRuntimeReport(value);
      const loaded = this.read(projectId);
      const index = loaded.reports.findIndex((item) => item.id === report.id);
      const prior = loaded.reports[index];
      if (prior) {
        if (JSON.stringify(prior) === JSON.stringify(report)) return;
        const terminalObservation =
          prior.mode !== 'check' &&
          (prior.status === 'observed' || prior.status === 'issues') &&
          report.status === 'issues' &&
          prior.issues.every((code) => report.issues.includes(code));
        if (
          (prior.status !== 'observing' && !terminalObservation) ||
          JSON.stringify(identity(prior)) !== JSON.stringify(identity(report)) ||
          report.observedMs < prior.observedMs ||
          Date.parse(prior.updatedAt) > Date.parse(report.updatedAt)
        )
          throw conflict();
      } else {
        if (report.status !== 'observing') throw invalid();
        if (loaded.reports.length >= MAX_REPORTS) throw limit();
      }
      const finalizeArchived = Boolean(prior && report.status !== 'observing');
      if (this.projects.get(projectId).archived && !finalizeArchived) throw archived();
      if (prior) loaded.reports[index] = report;
      else loaded.reports.push(report);
      this.write(projectId, loaded.reports, loaded.bytesHash, finalizeArchived);
    });
  }
  private write(
    projectId: string,
    reports: RuntimeReport[],
    previousHash: string | null,
    finalizeArchived: boolean,
  ): void {
    const path = this.path(projectId);
    const bytes =
      JSON.stringify({
        schemaVersion: reports.some((report) => report.mode === 'application') ? 2 : 1,
        projectId,
        reports,
      }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw limit();
    const temporary = join(dirname(path), `.runtime-${randomUUID()}.tmp`);
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
          'RUNTIME_RECORD_COMMIT_UNCERTAIN',
          '运行观察记录可能已保存，请先重新读取核对结果。',
        );
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        if (temporaryCreated) unlinkSync(temporary);
      } catch (error) {
        if (!missing(error))
          throw new AppError('RUNTIME_RECORD_IO', '临时运行观察记录未清理完成，请保留记录后核对。');
      }
    }
  }
}
