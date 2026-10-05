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
import type { BuildArtifact, BuildDiagnostic } from '../shared/build-contracts';
import { ProjectStore } from './project-store';
import {
  parseSourceHash,
  parseSourcePath,
  parseSourceRevision,
  sourceHash,
} from './source-protocol';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACTS = 20;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const invalid = () => new AppError('INVALID_INPUT', '构建产物参数无效。');
const corrupt = () => new AppError('CORRUPT_BUILD', '构建产物记录校验失败，原文件已保留。');
const conflict = () => new AppError('BUILD_CONFLICT', '构建产物记录已变化，本次没有覆盖。');
const limit = () => new AppError('BUILD_LIMIT', '构建产物达到容量上限，已有产物保留。');
const unsafe = () => new AppError('UNSAFE_PATH', '构建产物记录不是独立普通文件，已停止访问。');

export const buildArtifactHash = (value: Pick<BuildArtifact, 'javascript' | 'css'>): string =>
  sourceHash(JSON.stringify({ javascript: value.javascript, css: value.css }));

function parseDiagnostic(value: unknown): BuildDiagnostic {
  assertRecord(value);
  assertFields(value, ['path', 'line', 'message']);
  if (
    (value.line !== null && (!Number.isSafeInteger(value.line) || (value.line as number) < 1)) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 300 ||
    /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value.message)
  )
    throw invalid();
  return {
    path: value.path === null ? null : parseSourcePath(value.path),
    line: value.line as number | null,
    message: value.message,
  };
}

function parseArtifact(value: unknown): BuildArtifact {
  assertRecord(value);
  assertFields(value, [
    'schemaVersion',
    'id',
    'projectId',
    'createdAt',
    'sourceRevision',
    'sourceHash',
    'planRunId',
    'planInputHash',
    'planArtifactHash',
    'templateVersion',
    'compilerVersion',
    'javascript',
    'css',
    'artifactHash',
    'warnings',
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    value.templateVersion !== 'react-preview-v1' ||
    typeof value.compilerVersion !== 'string' ||
    value.compilerVersion.length === 0 ||
    value.compilerVersion.length > 80 ||
    /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value.compilerVersion) ||
    typeof value.javascript !== 'string' ||
    typeof value.css !== 'string' ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 20
  )
    throw invalid();
  if (Buffer.byteLength(value.javascript) + Buffer.byteLength(value.css) > MAX_OUTPUT_BYTES)
    throw limit();
  const artifact: BuildArtifact = {
    schemaVersion: 1,
    id: parseRevisionId(value.id),
    projectId: parseRevisionId(value.projectId),
    createdAt: value.createdAt,
    sourceRevision: parseSourceRevision(value.sourceRevision),
    sourceHash: parseSourceHash(value.sourceHash),
    planRunId: parseRevisionId(value.planRunId),
    planInputHash: parseSourceHash(value.planInputHash),
    planArtifactHash: parseSourceHash(value.planArtifactHash),
    templateVersion: 'react-preview-v1',
    compilerVersion: value.compilerVersion,
    javascript: value.javascript,
    css: value.css,
    artifactHash: parseSourceHash(value.artifactHash),
    warnings: Array.from(value.warnings, parseDiagnostic),
  };
  if (artifact.artifactHash !== buildArtifactHash(artifact)) throw invalid();
  return artifact;
}

/** Immutable compiler outputs, not evidence that generated code has run or passed acceptance. */
export class BuildStore {
  private readonly observedFiles = new Set<string>();
  constructor(private readonly projects: ProjectStore) {}

  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('BUILD_IO', '构建产物保存状态未确认，请先核对现有记录。');
    }
  }

  private path(projectId: string): string {
    // ProjectStore validates the identifier and every existing storage ancestor.
    this.projects.get(projectId);
    return join(this.projects.rootPath, 'projects', projectId, 'runs', 'builds.json');
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
        throw new AppError('MISSING_BUILD', '已读取的构建产物记录被移走，请先恢复原文件。');
      return false;
    }
  }

  private read(projectId: string): { artifacts: BuildArtifact[]; bytesHash: string | null } {
    const path = this.path(projectId);
    if (!this.verifyFile(path)) return { artifacts: [], bytesHash: null };
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
      if (raw.schemaVersion !== 1)
        throw new AppError('UNSUPPORTED_BUILD', '此构建记录版本尚不受支持，原文件已保留。');
      assertFields(raw, ['schemaVersion', 'projectId', 'artifacts']);
      if (
        raw.projectId !== projectId ||
        !Array.isArray(raw.artifacts) ||
        raw.artifacts.length < 1 ||
        raw.artifacts.length > MAX_ARTIFACTS
      )
        throw corrupt();
      const seen = new Set<string>();
      const artifacts = Array.from(raw.artifacts, (value) => {
        const artifact = parseArtifact(value);
        if (artifact.projectId !== projectId || seen.has(artifact.id)) throw corrupt();
        seen.add(artifact.id);
        return artifact;
      });
      return { artifacts, bytesHash: sourceHash(bytes) };
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSAFE_PATH', 'UNSUPPORTED_BUILD', 'BUILD_LIMIT'].includes(error.code)
      )
        throw error;
      throw corrupt();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  list(projectId: string): BuildArtifact[] {
    return this.guarded(() => this.read(projectId).artifacts);
  }

  get(projectId: string, buildId: string): BuildArtifact {
    return this.guarded(() => {
      const id = parseRevisionId(buildId);
      const artifact = this.read(projectId).artifacts.find((item) => item.id === id);
      if (!artifact) throw new AppError('BUILD_NOT_FOUND', '找不到此构建产物，请刷新后重试。');
      return artifact;
    });
  }

  save(projectId: string, value: BuildArtifact): void {
    this.guarded(() => {
      const artifact = parseArtifact(value);
      if (artifact.projectId !== projectId) throw invalid();
      if (this.projects.get(projectId).archived)
        throw new AppError('ARCHIVED', '请先恢复项目，再保存构建产物。');
      const loaded = this.read(projectId);
      const prior = loaded.artifacts.find((item) => item.id === artifact.id);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(artifact)) throw conflict();
        return;
      }
      if (loaded.artifacts.length >= MAX_ARTIFACTS) throw limit();
      this.write(projectId, [...loaded.artifacts, artifact], loaded.bytesHash);
    });
  }

  private write(
    projectId: string,
    artifacts: BuildArtifact[],
    previousBytesHash: string | null,
  ): void {
    const path = this.path(projectId);
    const bytes = JSON.stringify({ schemaVersion: 1, projectId, artifacts }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw limit();
    const temporary = join(dirname(path), `.build-${randomUUID()}.tmp`);
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
      if (this.projects.get(projectId).archived)
        throw new AppError('ARCHIVED', '请先恢复项目，再保存构建产物。');
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
        throw new AppError('BUILD_COMMIT_UNCERTAIN', '构建产物可能已保存，请先重新读取核对结果。');
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        if (temporaryCreated) unlinkSync(temporary);
      } catch (error) {
        if (!missing(error))
          throw new AppError('BUILD_IO', '临时构建记录未清理完成，请保留现有记录后核对。');
      }
    }
  }
}
