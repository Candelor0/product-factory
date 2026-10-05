import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { GapBinding, GapEvidence, GapEvidenceRequest } from '../shared/gap-contracts';
import { assertExportContentsSafe } from './export-security';
import { ProjectStore } from './project-store';
import {
  parseSourceHash,
  parseSourcePath,
  parseSourceRevision,
  sourceHash,
} from './source-protocol';
import { AppError, assertRecord, parseProjectId, parseRevisionId } from './validation';

export const GAP_EVIDENCE_LIMITS = Object.freeze({
  records: 500,
  bytes: 4 * 1024 * 1024,
  paths: 32,
  text: 2000,
});
interface GapEvidenceStoreOptions {
  /** Trusted fault injection only; never passed from renderer, model or generated application. */
  beforeRename?: () => void;
  afterRename?: () => void;
}
const invalid = () => new AppError('INVALID_INPUT', '用户核验记录格式不正确，请检查输入。');
const corrupt = () => new AppError('CORRUPT_GAP_EVIDENCE', '用户核验记录校验失败，原文件已保留。');
const limit = () => new AppError('GAP_EVIDENCE_LIMIT', '用户核验记录达到容量上限，已有记录保留。');
const unsafe = () => new AppError('UNSAFE_PATH', '用户核验记录不是独立普通文件，已停止访问。');
const conflict = () => new AppError('GAP_EVIDENCE_CONFLICT', '用户核验记录已变化，本次没有覆盖。');
const requestConflict = () =>
  new AppError('REQUEST_CONFLICT', '重复请求标识对应了不同核验内容，请重新操作。');
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) =>
  sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function fields(
  value: unknown,
  names: readonly string[],
): asserts value is Record<string, unknown> {
  assertRecord(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length) throw invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== 'string' ||
      !names.includes(key) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw invalid();
  }
}
function array(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    return descriptor.value;
  });
}
function text(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > GAP_EVIDENCE_LIMITS.text ||
    !value.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)
  )
    throw invalid();
  return value.trim();
}
export function parseGapBinding(value: unknown): GapBinding {
  fields(value, [
    'planRunId',
    'planInputHash',
    'planArtifactHash',
    'sourceRevision',
    'sourceHash',
    'buildId',
    'artifactHash',
  ]);
  if ((value.buildId === null) !== (value.artifactHash === null)) throw invalid();
  return {
    planRunId: parseRevisionId(value.planRunId),
    planInputHash: parseSourceHash(value.planInputHash),
    planArtifactHash: parseSourceHash(value.planArtifactHash),
    sourceRevision: parseSourceRevision(value.sourceRevision),
    sourceHash: parseSourceHash(value.sourceHash),
    buildId: value.buildId === null ? null : parseRevisionId(value.buildId),
    artifactHash: value.artifactHash === null ? null : parseSourceHash(value.artifactHash),
  };
}
export function parseGapEvidenceRequest(value: unknown): GapEvidenceRequest {
  fields(value, [
    'schemaVersion',
    'requestId',
    'projectId',
    'binding',
    'taskId',
    'verdict',
    'filePaths',
    'steps',
    'expected',
    'actual',
  ]);
  // The authoritative requirements parser currently caps each task category at 50 entries.
  if (
    value.schemaVersion !== 1 ||
    typeof value.taskId !== 'string' ||
    !/^[PDFA][0-9]{3}$/u.test(value.taskId) ||
    !['passed', 'failed', 'missing'].includes(value.verdict as string)
  )
    throw invalid();
  const filePaths = array(value.filePaths, GAP_EVIDENCE_LIMITS.paths).map(parseSourcePath);
  if (new Set(filePaths).size !== filePaths.length) throw invalid();
  const request: GapEvidenceRequest = {
    schemaVersion: 1,
    requestId: parseRevisionId(value.requestId),
    projectId: parseProjectId(value.projectId),
    binding: parseGapBinding(value.binding),
    taskId: value.taskId,
    verdict: value.verdict as GapEvidenceRequest['verdict'],
    filePaths,
    steps: text(value.steps),
    expected: text(value.expected),
    actual: text(value.actual),
  };
  try {
    assertExportContentsSafe([
      request.steps,
      request.expected,
      request.actual,
      ...request.filePaths,
    ]);
  } catch {
    throw new AppError('GAP_EVIDENCE_SENSITIVE', '核验内容包含疑似凭据，请移除后再保存。');
  }
  return request;
}
function parseEvidence(value: unknown, projectId: string): GapEvidence {
  fields(value, ['id', 'createdAt', 'origin', 'request']);
  const request = parseGapEvidenceRequest(value.request);
  if (
    request.projectId !== projectId ||
    value.origin !== 'user' ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    throw corrupt();
  return { id: parseRevisionId(value.id), createdAt: value.createdAt, origin: 'user', request };
}

/** Append-only user evidence; business/current-binding checks belong to the trusted coordinator. */
export class GapEvidenceStore {
  private readonly observedFiles = new Set<string>();
  constructor(
    private readonly projects: ProjectStore,
    private readonly options: GapEvidenceStoreOptions = {},
  ) {}
  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('GAP_EVIDENCE_IO', '用户核验记录暂时无法安全访问，请保留文件后重试。');
    }
  }
  private path(projectId: string): string {
    this.projects.get(projectId);
    return join(this.projects.rootPath, 'projects', projectId, 'runs', 'gap-evidence.json');
  }
  private readBytes(path: string): { bytes: string; identity: Stats } | null {
    let fd: number | undefined;
    try {
      let before: Stats;
      try {
        before = lstatSync(path);
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
      const regular = (stat: Stats) => {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
        if (
          !Number.isSafeInteger(stat.size) ||
          stat.size < 0 ||
          stat.size > GAP_EVIDENCE_LIMITS.bytes
        )
          throw limit();
      };
      regular(before);
      fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const opened = fstatSync(fd);
      regular(opened);
      if (!unchanged(before, opened)) throw unsafe();
      const chunk = Buffer.alloc(64 * 1024),
        chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const count = readSync(
          fd,
          chunk,
          0,
          Math.min(chunk.length, GAP_EVIDENCE_LIMITS.bytes + 1 - total),
          total,
        );
        if (!count) break;
        total += count;
        if (total > GAP_EVIDENCE_LIMITS.bytes) throw limit();
        chunks.push(Buffer.from(chunk.subarray(0, count)));
      }
      const after = fstatSync(fd),
        current = lstatSync(path);
      regular(after);
      regular(current);
      if (total !== opened.size || !unchanged(opened, after) || !unchanged(opened, current))
        throw unsafe();
      const bytes = Buffer.concat(chunks, total),
        decoded = bytes.toString('utf8');
      if (!Buffer.from(decoded).equals(bytes)) throw corrupt();
      return { bytes: decoded, identity: opened };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private read(projectId: string): { evidence: GapEvidence[]; bytesHash: string | null } {
    const path = this.path(projectId);
    // Remember even invalid existing files so deleting one cannot silently reset this process.
    try {
      lstatSync(path);
      this.observedFiles.add(path);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const loaded = this.readBytes(path);
    if (!loaded) {
      if (this.observedFiles.has(path))
        throw new AppError(
          'MISSING_GAP_EVIDENCE',
          '已读取的用户核验记录缺失，请恢复原文件后再操作。',
        );
      return { evidence: [], bytesHash: null };
    }
    try {
      const raw: unknown = JSON.parse(loaded.bytes);
      assertRecord(raw);
      if (raw.schemaVersion !== 1)
        throw new AppError('UNSUPPORTED_GAP_EVIDENCE', '用户核验记录版本尚不支持，原文件已保留。');
      fields(raw, ['schemaVersion', 'projectId', 'evidence']);
      if (raw.projectId !== projectId) throw corrupt();
      if (Array.isArray(raw.evidence) && raw.evidence.length > GAP_EVIDENCE_LIMITS.records)
        throw limit();
      const ids = new Set<string>(),
        requestIds = new Set<string>();
      const evidence = array(raw.evidence, GAP_EVIDENCE_LIMITS.records).map((item) => {
        const parsed = parseEvidence(item, projectId);
        if (ids.has(parsed.id) || requestIds.has(parsed.request.requestId)) throw corrupt();
        ids.add(parsed.id);
        requestIds.add(parsed.request.requestId);
        return parsed;
      });
      return { evidence, bytesHash: sourceHash(loaded.bytes) };
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSUPPORTED_GAP_EVIDENCE', 'GAP_EVIDENCE_LIMIT'].includes(error.code)
      )
        throw error;
      throw corrupt();
    }
  }
  list(projectId: string): GapEvidence[] {
    return this.guarded(() => this.read(projectId).evidence);
  }
  private prior(evidence: GapEvidence[], request: GapEvidenceRequest): GapEvidence | null {
    const previous = evidence.find((item) => item.request.requestId === request.requestId);
    if (previous && JSON.stringify(previous.request) !== JSON.stringify(request))
      throw requestConflict();
    return previous ?? null;
  }
  replay(input: GapEvidenceRequest): GapEvidence | null {
    return this.guarded(() => {
      const request = parseGapEvidenceRequest(input);
      return this.prior(this.read(request.projectId).evidence, request);
    });
  }
  append(input: GapEvidenceRequest): GapEvidence {
    return this.guarded(() => {
      const request = parseGapEvidenceRequest(input);
      const project = this.projects.get(request.projectId);
      const loaded = this.read(request.projectId);
      const previous = this.prior(loaded.evidence, request);
      if (previous) return previous;
      if (project.archived) throw new AppError('ARCHIVED', '归档项目不能新增用户核验记录。');
      if (loaded.evidence.length >= GAP_EVIDENCE_LIMITS.records) throw limit();
      const entry: GapEvidence = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        origin: 'user',
        request,
      };
      this.write(request.projectId, [...loaded.evidence, entry], loaded.bytesHash);
      return structuredClone(entry);
    });
  }
  private write(projectId: string, evidence: GapEvidence[], previousHash: string | null): void {
    const path = this.path(projectId),
      directory = dirname(path);
    const bytes = JSON.stringify({ schemaVersion: 1, projectId, evidence }) + '\n';
    if (Buffer.byteLength(bytes) > GAP_EVIDENCE_LIMITS.bytes) throw limit();
    const temp = join(directory, `.gap-evidence-${randomUUID()}.tmp`);
    let fd: number | undefined,
      identity: Stats | undefined,
      renamed = false;
    try {
      fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      identity = fstatSync(fd);
      writeFileSync(fd, bytes, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.options.beforeRename?.();
      if (this.projects.get(projectId).archived)
        throw new AppError('ARCHIVED', '归档项目不能新增用户核验记录。');
      if (this.read(projectId).bytesHash !== previousHash) throw conflict();
      const staged = this.readBytes(temp);
      if (!staged || !sameFile(staged.identity, identity) || staged.bytes !== bytes) throw unsafe();
      renameSync(temp, path);
      renamed = true;
      this.observedFiles.add(path);
      this.options.afterRename?.();
      if (process.platform !== 'win32') {
        const directoryFd = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      }
      if (this.read(projectId).bytesHash !== sourceHash(bytes)) throw conflict();
    } catch (error) {
      if (!renamed) throw error;
      try {
        if (this.read(projectId).bytesHash === sourceHash(bytes)) return;
      } catch {
        /* Preserve uncertain state. */
      }
      throw new AppError(
        'GAP_EVIDENCE_COMMIT_UNCERTAIN',
        '用户核验记录可能已保存，请保留原请求并重新核对。',
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (identity) {
        try {
          const current = lstatSync(temp);
          if (current.isFile() && !current.isSymbolicLink() && sameFile(current, identity))
            unlinkSync(temp);
        } catch (error) {
          if (!absent(error))
            throw new AppError('GAP_EVIDENCE_IO', '用户核验临时记录未能清理，请保留现场。');
        }
      }
    }
  }
}
