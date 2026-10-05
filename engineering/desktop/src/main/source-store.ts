import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  SourceApplyInput,
  SourceApplyResult,
  SourceCheckpoint,
  SourceFile,
  SourceRestoreInput,
  SourceSnapshot,
} from '../shared/source-contracts';
import { ProjectStore } from './project-store';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';
import {
  parseSourceApplyInput,
  parseSourceBinding,
  parseSourceContent,
  parseSourceHash,
  parseSourcePath,
  parseSourceRevision,
  SOURCE_LIMITS,
  sourceHash,
  sourceRequestHash,
} from './source-protocol';

interface SourceCommitBase {
  revision: number;
  createdAt: string;
  requestHash: string;
  snapshot: SourceSnapshot;
}
interface SourceApplyCommit extends SourceCommitBase {
  kind: 'apply';
  request: SourceApplyInput;
}
interface SourceRestoreCommit extends SourceCommitBase {
  kind: 'restore';
  request: SourceRestoreInput;
  targetSnapshotHash: string;
}
type SourceCommit = SourceApplyCommit | SourceRestoreCommit;
interface SourceRecord {
  schemaVersion: 1 | 2;
  projectId: string;
  commits: SourceCommit[];
}
interface LoadedRecord {
  record: SourceRecord;
  bytesHash: string | null;
}
interface SourceStoreOptions {
  /** Trusted fault-injection hooks only; never supplied through tool arguments. */
  beforeRename?: () => void;
  afterRename?: () => void;
}
const temporaryName =
  /^\.source-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const emptySnapshot = (): SourceSnapshot => ({ revision: 0, files: [] });
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const conflict = () =>
  new AppError('SOURCE_CONFLICT', '源码版本或文件校验值已变化，请刷新后重新修改。');
const corrupt = () =>
  new AppError('CORRUPT_SOURCE', '源码记录校验失败，原文件已保留，请先检查备份。');
const unsafe = () => new AppError('UNSAFE_PATH', '源码存储不是独立普通文件或目录，已停止访问。');
const limit = () => new AppError('SOURCE_LIMIT', '源码记录达到容量上限，本次未写入。');
const checkpointMissing = () =>
  new AppError('SOURCE_CHECKPOINT_NOT_FOUND', '所选源码检查点不存在，已停止恢复。');
const snapshotHash = (snapshot: SourceSnapshot) => sourceHash(JSON.stringify(snapshot));
const restoreRequestHash = (request: SourceRestoreInput) =>
  sourceHash(JSON.stringify({ kind: 'restore', request }));

function parseRestoreInput(value: unknown): SourceRestoreInput {
  assertRecord(value);
  assertFields(value, ['requestId', 'binding', 'expectedRevision', 'targetRevision']);
  return {
    requestId: parseRevisionId(value.requestId),
    binding: parseSourceBinding(value.binding),
    expectedRevision: parseSourceRevision(value.expectedRevision),
    targetRevision: parseSourceRevision(value.targetRevision),
  };
}

function snapshotAt(commits: SourceCommit[], revision: number): SourceSnapshot {
  if (revision === 0) return emptySnapshot();
  const commit = commits[revision - 1];
  if (!commit || commit.revision !== revision) throw checkpointMissing();
  return commit.snapshot;
}

function restoredSnapshot(commits: SourceCommit[], input: SourceRestoreInput): SourceSnapshot {
  const previous = commits.at(-1)?.snapshot ?? emptySnapshot();
  if (input.expectedRevision !== previous.revision) throw conflict();
  const target = snapshotAt(commits, input.targetRevision);
  if (
    input.targetRevision !== 0 &&
    JSON.stringify(commits[input.targetRevision - 1].request.binding) !==
      JSON.stringify(input.binding)
  )
    throw new AppError('SOURCE_BINDING_CHANGED', '检查点属于其他确认版本，请先核对需求与计划。');
  return { revision: previous.revision + 1, files: structuredClone(target.files) };
}

function changedPaths(before: SourceSnapshot, after: SourceSnapshot): string[] {
  const original = new Map(before.files.map((file) => [file.path, file.sha256]));
  const updated = new Map(after.files.map((file) => [file.path, file.sha256]));
  return [...new Set([...original.keys(), ...updated.keys()])]
    .filter((path) => original.get(path) !== updated.get(path))
    .sort();
}

function snapshotAfter(previous: SourceSnapshot, input: SourceApplyInput): SourceSnapshot {
  if (input.expectedRevision !== previous.revision) throw conflict();
  const files = new Map(previous.files.map((file) => [file.path, file]));
  for (const change of input.changes) {
    const current = files.get(change.path);
    if (change.expectedHash !== (current?.sha256 ?? null)) throw conflict();
    if (change.operation === 'delete') {
      if (!current) throw conflict();
      files.delete(change.path);
    } else {
      files.set(change.path, {
        path: change.path,
        content: change.content,
        sha256: sourceHash(change.content),
      });
    }
  }
  const sorted = [...files.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (
    sorted.length > SOURCE_LIMITS.fileCount ||
    sorted.reduce((size, file) => size + Buffer.byteLength(file.content), 0) >
      SOURCE_LIMITS.workspaceBytes
  )
    throw limit();
  for (const file of sorted) {
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index += 1)
      if (files.has(parts.slice(0, index).join('/'))) throw conflict();
  }
  return { revision: previous.revision + 1, files: sorted };
}

function parseSnapshot(value: unknown): SourceSnapshot {
  assertRecord(value);
  assertFields(value, ['revision', 'files']);
  if (
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !Array.isArray(value.files) ||
    value.files.length > SOURCE_LIMITS.fileCount
  )
    throw corrupt();
  const files: SourceFile[] = Array.from(value.files, (raw) => {
    assertRecord(raw);
    assertFields(raw, ['path', 'content', 'sha256']);
    const content = parseSourceContent(raw.content);
    const sha256 = parseSourceHash(raw.sha256);
    if (sha256 !== sourceHash(content)) throw corrupt();
    return { path: parseSourcePath(raw.path), content, sha256 };
  });
  return { revision: value.revision as number, files };
}

/**
 * One trusted synchronous writer. Model paths stay inside a JSON virtual tree and
 * are never joined to host paths or executed. This is not an OS execution sandbox.
 */
export class SourceStore {
  private readonly observedFiles = new Set<string>();
  constructor(
    private readonly projects: ProjectStore,
    private readonly options: SourceStoreOptions = {},
  ) {}

  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Node I/O errors may contain absolute paths; never return those to a model.
      throw new AppError('SOURCE_IO', '源码存储暂时无法访问，请保留现场后重试。');
    }
  }

  private path(projectId: string): string {
    // Also validates the project identifier and every pre-existing ancestor.
    this.projects.get(projectId);
    return join(this.projects.rootPath, 'projects', projectId, 'source', 'workspace.json');
  }

  private verifyFile(path: string): boolean {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
      this.observedFiles.add(path);
      if (stat.size > SOURCE_LIMITS.recordBytes) throw limit();
      return true;
    } catch (error) {
      if (!missing(error)) throw error;
      if (this.observedFiles.has(path))
        throw new AppError(
          'MISSING_SOURCE',
          '已读取的源码记录被移走，已停止写入，请先恢复原文件。',
        );
      return false;
    }
  }

  private verifyEntries(path: string): void {
    for (const entry of readdirSync(dirname(path), { withFileTypes: true })) {
      if (entry.name === 'workspace.json') continue;
      if (!temporaryName.test(entry.name)) throw corrupt();
      const stat = lstatSync(join(dirname(path), entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
      // Unfinished temporary writes are preserved, never promoted or parsed.
    }
  }

  private read(projectId: string): LoadedRecord {
    const path = this.path(projectId);
    const exists = this.verifyFile(path);
    this.verifyEntries(path);
    if (!exists) return { record: { schemaVersion: 1, projectId, commits: [] }, bytesHash: null };
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw unsafe();
      if (stat.size > SOURCE_LIMITS.recordBytes) throw limit();
      const bytes = readFileSync(fd, 'utf8');
      const raw: unknown = JSON.parse(bytes);
      assertRecord(raw);
      if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)
        throw new AppError('UNSUPPORTED_SOURCE', '源码记录版本暂不支持，原文件已保留。');
      assertFields(raw, ['schemaVersion', 'projectId', 'commits']);
      if (
        raw.projectId !== projectId ||
        !Array.isArray(raw.commits) ||
        raw.commits.length < 1 ||
        raw.commits.length > SOURCE_LIMITS.commits
      )
        throw corrupt();
      const requestIds = new Set<string>();
      let previous = emptySnapshot();
      const commits: SourceCommit[] = [];
      for (const [index, item] of raw.commits.entries()) {
        assertRecord(item);
        const kind = raw.schemaVersion === 1 ? 'apply' : item.kind;
        if (kind !== 'apply' && kind !== 'restore') throw corrupt();
        assertFields(item, [
          'revision',
          'createdAt',
          'request',
          'requestHash',
          'snapshot',
          ...(raw.schemaVersion === 2 ? ['kind'] : []),
          ...(kind === 'restore' ? ['targetSnapshotHash'] : []),
        ]);
        const request =
          kind === 'apply' ? parseSourceApplyInput(item.request) : parseRestoreInput(item.request);
        const requestHash =
          kind === 'apply'
            ? sourceRequestHash(request as SourceApplyInput)
            : restoreRequestHash(request as SourceRestoreInput);
        if (
          requestIds.has(request.requestId) ||
          item.revision !== index + 1 ||
          typeof item.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(item.createdAt)) ||
          new Date(item.createdAt).toISOString() !== item.createdAt ||
          item.requestHash !== requestHash
        )
          throw corrupt();
        requestIds.add(request.requestId);
        const snapshot = parseSnapshot(item.snapshot);
        const replayed =
          kind === 'apply'
            ? snapshotAfter(previous, request as SourceApplyInput)
            : restoredSnapshot(commits, request as SourceRestoreInput);
        if (JSON.stringify(snapshot) !== JSON.stringify(replayed)) throw corrupt();
        previous = replayed;
        const base = {
          revision: index + 1,
          createdAt: item.createdAt,
          requestHash,
          snapshot,
        };
        if (kind === 'apply') {
          commits.push({ ...base, kind, request: request as SourceApplyInput });
        } else {
          const target = snapshotAt(commits, (request as SourceRestoreInput).targetRevision);
          if (item.targetSnapshotHash !== snapshotHash(target)) throw corrupt();
          commits.push({
            ...base,
            kind,
            request: request as SourceRestoreInput,
            targetSnapshotHash: snapshotHash(target),
          });
        }
      }
      return {
        record: { schemaVersion: raw.schemaVersion, projectId, commits },
        bytesHash: sourceHash(bytes),
      };
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSAFE_PATH', 'UNSUPPORTED_SOURCE', 'SOURCE_LIMIT', 'MISSING_SOURCE'].includes(error.code)
      )
        throw error;
      throw corrupt();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  get(projectId: string): SourceSnapshot {
    return this.guarded(() => {
      const { record } = this.read(projectId);
      return structuredClone(record.commits.at(-1)?.snapshot ?? emptySnapshot());
    });
  }

  at(projectId: string, revision: number): SourceSnapshot {
    return this.guarded(() => {
      const target = parseSourceRevision(revision);
      return structuredClone(snapshotAt(this.read(projectId).record.commits, target));
    });
  }

  history(projectId: string): SourceCheckpoint[] {
    return this.guarded(() => {
      const { commits } = this.read(projectId).record;
      const initial = emptySnapshot();
      return structuredClone([
        {
          revision: 0,
          createdAt: null,
          binding: null,
          changedPaths: [],
          files: [],
          restoredFrom: null,
          requestId: null,
          snapshotHash: snapshotHash(initial),
        },
        ...commits.map((commit, index) => ({
          revision: commit.revision,
          createdAt: commit.createdAt,
          binding: commit.request.binding,
          changedPaths: this.result(commit, commits[index - 1]?.snapshot ?? initial, false)
            .changedPaths,
          files: commit.snapshot.files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            bytes: Buffer.byteLength(file.content, 'utf8'),
          })),
          restoredFrom: commit.kind === 'restore' ? commit.request.targetRevision : null,
          requestId: commit.request.requestId,
          snapshotHash: snapshotHash(commit.snapshot),
        })),
      ]);
    });
  }

  apply(projectId: string, value: unknown): SourceApplyResult {
    return this.guarded(() => {
      const input = parseSourceApplyInput(value);
      const project = this.projects.get(projectId);
      if (project.archived) throw new AppError('ARCHIVED', '请先恢复项目，再修改源码。');
      const loaded = this.read(projectId);
      const requestHash = sourceRequestHash(input);
      const prior = loaded.record.commits.find(
        (commit) => commit.request.requestId === input.requestId,
      );
      if (prior) {
        if (prior.kind !== 'apply' || prior.requestHash !== requestHash)
          throw new AppError('REQUEST_CONFLICT', '重复请求标识对应了不同输入，请重新操作。');
        return this.result(prior, snapshotAt(loaded.record.commits, prior.revision - 1), true);
      }
      if (loaded.record.commits.length >= SOURCE_LIMITS.commits) throw limit();
      const snapshot = snapshotAfter(
        loaded.record.commits.at(-1)?.snapshot ?? emptySnapshot(),
        input,
      );
      const commit: SourceCommit = {
        kind: 'apply',
        revision: snapshot.revision,
        createdAt: new Date().toISOString(),
        request: input,
        requestHash,
        snapshot,
      };
      this.write(
        projectId,
        { ...loaded.record, commits: [...loaded.record.commits, commit] },
        loaded.bytesHash,
      );
      return this.result(commit, snapshotAt(loaded.record.commits, snapshot.revision - 1), false);
    });
  }

  restore(projectId: string, value: unknown): SourceApplyResult {
    return this.guarded(() => {
      const input = parseRestoreInput(value);
      if (this.projects.get(projectId).archived)
        throw new AppError('ARCHIVED', '请先恢复项目，再恢复源码。');
      const loaded = this.read(projectId);
      const requestHash = restoreRequestHash(input);
      const prior = loaded.record.commits.find(
        (commit) => commit.request.requestId === input.requestId,
      );
      if (prior) {
        if (prior.kind !== 'restore' || prior.requestHash !== requestHash)
          throw new AppError('REQUEST_CONFLICT', '重复请求标识对应了不同输入，请重新操作。');
        return this.result(prior, snapshotAt(loaded.record.commits, prior.revision - 1), true);
      }
      if (loaded.record.commits.length >= SOURCE_LIMITS.commits) throw limit();
      const snapshot = restoredSnapshot(loaded.record.commits, input);
      const commit: SourceRestoreCommit = {
        kind: 'restore',
        revision: snapshot.revision,
        createdAt: new Date().toISOString(),
        request: input,
        requestHash,
        snapshot,
        targetSnapshotHash: snapshotHash(snapshotAt(loaded.record.commits, input.targetRevision)),
      };
      this.write(
        projectId,
        {
          ...loaded.record,
          schemaVersion: 2,
          commits: [...loaded.record.commits, commit],
        },
        loaded.bytesHash,
      );
      return this.result(commit, snapshotAt(loaded.record.commits, snapshot.revision - 1), false);
    });
  }

  private result(
    commit: SourceCommit,
    previous: SourceSnapshot,
    replayed: boolean,
  ): SourceApplyResult {
    return {
      revision: commit.revision,
      previousRevision: commit.revision - 1,
      changedPaths:
        commit.kind === 'apply'
          ? commit.request.changes.map((change) => change.path).sort()
          : changedPaths(previous, commit.snapshot),
      replayed,
    };
  }

  private write(projectId: string, record: SourceRecord, previousBytesHash: string | null): void {
    const path = this.path(projectId);
    // Preserve legacy apply-only records; the first restore upgrades atomically so old
    // programs reject the new semantic record instead of replaying it as model changes.
    const persisted =
      record.schemaVersion === 1
        ? { ...record, commits: record.commits.map(({ kind: _kind, ...commit }) => commit) }
        : record;
    const bytes = JSON.stringify(persisted) + '\n';
    if (Buffer.byteLength(bytes) > SOURCE_LIMITS.recordBytes) throw limit();
    const temporary = join(dirname(path), `.source-${randomUUID()}.tmp`);
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
      if (this.projects.get(projectId).archived)
        throw new AppError('ARCHIVED', '请先恢复项目，再修改源码。');
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
        throw new AppError(
          'SOURCE_COMMIT_UNCERTAIN',
          '源码可能已保存，请使用相同请求标识重试以核对结果。',
        );
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!missing(error))
          throw new AppError('SOURCE_IO', '临时源码记录无法清理，请保留现场后重试。');
      }
    }
  }
}
