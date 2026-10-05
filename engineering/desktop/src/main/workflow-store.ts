import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkflowRequest, WorkflowRun, WorkflowStage } from '../shared/workflow-contracts';
import { ProjectStore } from './project-store';
import { parseModificationInstruction } from './modification-protocol';
import { parseSourceHash, parseSourceRevision, sourceHash } from './source-protocol';
import { AppError, assertRecord, parseProjectId, parseRevisionId } from './validation';

export const WORKFLOW_LIMITS = Object.freeze({ runs: 50, bytes: 2 * 1024 * 1024, stages: 4 });
interface WorkflowStoreOptions {
  /** Trusted fault injection only; never read from IPC or model input. */
  beforeRename?: () => void;
  afterRename?: () => void;
}
const invalid = () => new AppError('INVALID_INPUT', '自动开发流程记录格式不正确。');
const conflict = () =>
  new AppError('WORKFLOW_CONFLICT', '自动开发流程记录已变化或状态不能回退，未覆盖已有记录。');
const corrupt = () => new AppError('CORRUPT_WORKFLOW', '自动开发流程记录校验失败，原文件已保留。');
const limit = () => new AppError('WORKFLOW_LIMIT', '自动开发流程记录达到容量上限，已有记录保留。');
const unsafe = () => new AppError('UNSAFE_PATH', '自动开发流程记录不是独立普通文件，已停止访问。');
const missing = () =>
  new AppError('MISSING_WORKFLOW', '已初始化的自动开发流程记录或标记缺失，请先恢复原文件。');
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
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
function iso(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}
const idOrNull = (value: unknown) => (value === null ? null : parseRevisionId(value));
function errorCode(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)))
    throw invalid();
  return value as string | null;
}
export function parseWorkflowRequest(value: unknown): WorkflowRequest {
  assertRecord(value);
  const version = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  const schemaVersion = version && 'value' in version ? version.value : undefined;
  fields(value, [
    'schemaVersion',
    'requestId',
    'projectId',
    'planRunId',
    'sourceRevision',
    'mode',
    ...(schemaVersion === 2 ? ['instruction'] : []),
  ]);
  if (schemaVersion === 2) {
    if (value.mode !== 'modify') throw invalid();
    return {
      schemaVersion: 2,
      requestId: parseRevisionId(value.requestId),
      projectId: parseProjectId(value.projectId),
      planRunId: parseRevisionId(value.planRunId),
      sourceRevision: parseSourceRevision(value.sourceRevision),
      mode: 'modify',
      instruction: parseModificationInstruction(value.instruction),
    };
  }
  if (schemaVersion !== 1 || !['generate', 'check'].includes(value.mode as string)) throw invalid();
  return {
    schemaVersion: 1,
    requestId: parseRevisionId(value.requestId),
    projectId: parseProjectId(value.projectId),
    planRunId: parseRevisionId(value.planRunId),
    sourceRevision: parseSourceRevision(value.sourceRevision),
    mode: value.mode as 'generate' | 'check',
  };
}
function parseStage(value: unknown): WorkflowStage {
  assertRecord(value);
  const hasRepairVersion = Object.prototype.hasOwnProperty.call(value, 'repairRequestVersion');
  fields(value, [
    'kind',
    'requestId',
    'status',
    'createdAt',
    'updatedAt',
    'sourceRevision',
    'sourceHash',
    'buildId',
    'runtimeReportId',
    'errorCode',
    ...(hasRepairVersion ? ['repairRequestVersion'] : []),
  ]);
  const createdAt = iso(value.createdAt),
    updatedAt = iso(value.updatedAt);
  if (
    !['generation', 'build', 'startup', 'repair'].includes(value.kind as string) ||
    ![
      'running',
      'succeeded',
      'no_changes',
      'failed',
      'cancelled',
      'limited',
      'interrupted',
    ].includes(value.status as string) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (hasRepairVersion && (value.kind !== 'repair' || value.repairRequestVersion !== 2))
  )
    throw invalid();
  return {
    kind: value.kind as WorkflowStage['kind'],
    requestId: parseRevisionId(value.requestId),
    status: value.status as WorkflowStage['status'],
    createdAt,
    updatedAt,
    sourceRevision: parseSourceRevision(value.sourceRevision),
    sourceHash: parseSourceHash(value.sourceHash),
    buildId: idOrNull(value.buildId),
    runtimeReportId: idOrNull(value.runtimeReportId),
    errorCode: errorCode(value.errorCode),
    ...(hasRepairVersion ? { repairRequestVersion: 2 as const } : {}),
  };
}
export function parseWorkflowRun(value: unknown): WorkflowRun {
  fields(value, [
    'id',
    'request',
    'binding',
    'initialSourceHash',
    'createdAt',
    'updatedAt',
    'status',
    'stages',
    'latestRevision',
    'latestSourceHash',
    'buildId',
    'runtimeReportId',
    'errorCode',
  ]);
  const id = parseRevisionId(value.id),
    request = parseWorkflowRequest(value.request);
  fields(value.binding, ['planRunId', 'planInputHash', 'planArtifactHash']);
  const binding = {
    planRunId: parseRevisionId(value.binding.planRunId),
    planInputHash: parseSourceHash(value.binding.planInputHash),
    planArtifactHash: parseSourceHash(value.binding.planArtifactHash),
  };
  const initialSourceHash = parseSourceHash(value.initialSourceHash),
    latestSourceHash = parseSourceHash(value.latestSourceHash);
  const latestRevision = parseSourceRevision(value.latestRevision);
  const createdAt = iso(value.createdAt),
    updatedAt = iso(value.updatedAt);
  if (
    id !== request.requestId ||
    binding.planRunId !== request.planRunId ||
    !['running', 'ready', 'stopped', 'cancelled', 'limited', 'interrupted'].includes(
      value.status as string,
    ) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    latestRevision < request.sourceRevision ||
    (latestRevision === request.sourceRevision && latestSourceHash !== initialSourceHash)
  )
    throw invalid();
  const stages = array(value.stages, WORKFLOW_LIMITS.stages).map(parseStage);
  if (request.mode !== 'modify' && stages.some((stage) => stage.repairRequestVersion !== undefined))
    throw invalid();
  const prefixes: WorkflowStage['kind'][][] =
    request.mode !== 'check'
      ? [
          ['generation', 'build', 'startup', 'repair'],
          ['generation', 'build', 'repair', 'startup'],
        ]
      : [
          ['build', 'startup', 'repair'],
          ['build', 'repair', 'startup'],
        ];
  if (
    !prefixes.some(
      (prefix) =>
        stages.length <= prefix.length &&
        stages.every((stage, index) => stage.kind === prefix[index]),
    )
  )
    throw invalid();
  const ids = new Set([id]);
  let previousDate = createdAt,
    previousRevision = request.sourceRevision,
    previousHash = initialSourceHash;
  for (const [index, stage] of stages.entries()) {
    if (
      ids.has(stage.requestId) ||
      Date.parse(stage.createdAt) < Date.parse(previousDate) ||
      Date.parse(stage.updatedAt) > Date.parse(updatedAt) ||
      stage.sourceRevision < previousRevision ||
      stage.sourceRevision > latestRevision ||
      (stage.sourceRevision === previousRevision && stage.sourceHash !== previousHash) ||
      (stage.sourceRevision === latestRevision && stage.sourceHash !== latestSourceHash) ||
      (stage.status === 'running' && (index !== stages.length - 1 || value.status !== 'running'))
    )
      throw invalid();
    ids.add(stage.requestId);
    previousDate = stage.updatedAt;
    previousRevision = stage.sourceRevision;
    previousHash = stage.sourceHash;
  }
  return {
    id,
    request,
    binding,
    initialSourceHash,
    createdAt,
    updatedAt,
    status: value.status as WorkflowRun['status'],
    stages,
    latestRevision,
    latestSourceHash,
    buildId: idOrNull(value.buildId),
    runtimeReportId: idOrNull(value.runtimeReportId),
    errorCode: errorCode(value.errorCode),
  };
}
function validTransition(previous: WorkflowRun, next: WorkflowRun): void {
  if (same(previous, next)) return;
  if (
    previous.status !== 'running' ||
    !same(previous.request, next.request) ||
    !same(previous.binding, next.binding) ||
    previous.createdAt !== next.createdAt ||
    previous.initialSourceHash !== next.initialSourceHash ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) ||
    next.latestRevision < previous.latestRevision ||
    (next.latestRevision === previous.latestRevision &&
      next.latestSourceHash !== previous.latestSourceHash)
  )
    throw conflict();
  if (next.stages.length === previous.stages.length + 1) {
    if (
      !same(previous.stages, next.stages.slice(0, -1)) ||
      previous.stages.some((stage) => stage.status === 'running') ||
      next.stages.at(-1)!.status !== 'running' ||
      Date.parse(next.stages.at(-1)!.createdAt) < Date.parse(previous.updatedAt)
    )
      throw conflict();
    return;
  }
  if (next.stages.length !== previous.stages.length) throw conflict();
  for (const [index, before] of previous.stages.entries()) {
    const after = next.stages[index]!;
    if (same(before, after)) continue;
    if (
      index !== previous.stages.length - 1 ||
      before.status !== 'running' ||
      after.status === 'running' ||
      before.kind !== after.kind ||
      before.requestId !== after.requestId ||
      before.repairRequestVersion !== after.repairRequestVersion ||
      before.createdAt !== after.createdAt ||
      Date.parse(after.updatedAt) < Date.parse(before.updatedAt) ||
      after.sourceRevision < before.sourceRevision ||
      (after.sourceRevision === before.sourceRevision && after.sourceHash !== before.sourceHash)
    )
      throw conflict();
  }
}
function uniqueRuns(runs: WorkflowRun[], projectId: string): void {
  const ids = new Set<string>();
  for (const run of runs) {
    if (run.request.projectId !== projectId) throw corrupt();
    for (const id of [run.id, ...run.stages.map((stage) => stage.requestId)]) {
      if (ids.has(id)) throw corrupt();
      ids.add(id);
    }
  }
}

/** One trusted synchronous writer. V2 also stores the bounded explicit user instruction;
 * model conversations, source bodies, credentials and application values are excluded. */
export class WorkflowStore {
  private readonly observedFiles = new Set<string>();
  constructor(
    private readonly projects: ProjectStore,
    private readonly options: WorkflowStoreOptions = {},
  ) {}
  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('WORKFLOW_IO', '自动开发流程记录暂时无法安全访问，请保留原记录后核对。');
    }
  }
  private path(projectId: string): string {
    this.projects.get(projectId);
    return join(this.projects.rootPath, 'projects', projectId, 'runs', 'workflows.json');
  }
  private readBytes(
    path: string,
    maximum = WORKFLOW_LIMITS.bytes,
  ): { bytes: string; identity: Stats } | null {
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
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximum) throw limit();
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
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, maximum + 1 - total), total);
        if (!count) break;
        total += count;
        if (total > maximum) throw limit();
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
  private syncDirectory(directory: string): void {
    if (process.platform === 'win32') return;
    const fd = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private marker(projectId: string): { path: string; storeId: string | null } {
    const path = join(dirname(this.path(projectId)), 'workflows.initialized.json');
    const loaded = this.readBytes(path, 1024);
    if (!loaded) {
      if (this.observedFiles.has(path)) throw missing();
      return { path, storeId: null };
    }
    this.observedFiles.add(path);
    try {
      const raw: unknown = JSON.parse(loaded.bytes);
      assertRecord(raw);
      if (raw.schemaVersion !== 1)
        throw new AppError('UNSUPPORTED_WORKFLOW', '自动开发流程记录版本尚不支持，原文件已保留。');
      fields(raw, ['schemaVersion', 'projectId', 'storeId']);
      if (raw.projectId !== projectId) throw corrupt();
      return { path, storeId: parseRevisionId(raw.storeId) };
    } catch (error) {
      if (error instanceof AppError && error.code === 'UNSUPPORTED_WORKFLOW') throw error;
      throw corrupt();
    }
  }
  /** A valid journal without a marker is the recoverable first-commit crash boundary. */
  private initializeMarker(projectId: string, storeId: string, journalHash: string): void {
    const journal = this.path(projectId),
      directory = dirname(journal);
    const directoryIdentity = lstatSync(directory);
    const { path, storeId: existingId } = this.marker(projectId);
    if (existingId !== null) {
      if (existingId !== storeId) throw corrupt();
      return;
    }
    const temp = join(directory, `.workflow-init-${randomUUID()}.tmp`);
    const bytes = JSON.stringify({ schemaVersion: 1, projectId, storeId }) + '\n';
    let fd: number | undefined,
      identity: Stats | undefined,
      published = false;
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
      this.path(projectId);
      const current = this.readBytes(journal),
        staged = this.readBytes(temp, 1024);
      if (!current || sourceHash(current.bytes) !== journalHash) throw conflict();
      if (
        !staged ||
        !sameFile(staged.identity, identity) ||
        staged.bytes !== bytes ||
        !sameFile(lstatSync(directory), directoryIdentity)
      )
        throw unsafe();
      // Persist the journal directory entry before publishing its non-overwriting marker.
      this.syncDirectory(directory);
      try {
        linkSync(temp, path);
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (identity) {
        try {
          const current = lstatSync(temp);
          if (current.isFile() && !current.isSymbolicLink() && sameFile(current, identity))
            unlinkSync(temp);
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
    }
    if (published) this.syncDirectory(directory);
    if (this.marker(projectId).storeId !== storeId) throw corrupt();
  }
  private read(projectId: string): {
    schemaVersion: 1 | 2 | 3;
    runs: WorkflowRun[];
    bytesHash: string | null;
    storeId: string | null;
  } {
    const path = this.path(projectId);
    const marker = this.marker(projectId);
    try {
      lstatSync(path);
      this.observedFiles.add(path);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const loaded = this.readBytes(path);
    if (!loaded) {
      if (marker.storeId !== null || this.observedFiles.has(path)) throw missing();
      return { schemaVersion: 1, runs: [], bytesHash: null, storeId: null };
    }
    let runs: WorkflowRun[], storeId: string, schemaVersion: 1 | 2 | 3;
    try {
      const raw: unknown = JSON.parse(loaded.bytes);
      assertRecord(raw);
      if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3)
        throw new AppError('UNSUPPORTED_WORKFLOW', '自动开发流程记录版本尚不支持，原文件已保留。');
      schemaVersion = raw.schemaVersion;
      fields(raw, ['schemaVersion', 'projectId', 'storeId', 'runs']);
      storeId = parseRevisionId(raw.storeId);
      if (marker.storeId !== null && marker.storeId !== storeId) throw corrupt();
      if (raw.projectId !== projectId || !Array.isArray(raw.runs) || raw.runs.length < 1)
        throw corrupt();
      if (raw.runs.length > WORKFLOW_LIMITS.runs) throw limit();
      runs = array(raw.runs, WORKFLOW_LIMITS.runs).map(parseWorkflowRun);
      if (schemaVersion === 1 && runs.some((run) => run.request.schemaVersion !== 1))
        throw corrupt();
      if (
        schemaVersion < 3 &&
        runs.some((run) => run.stages.some((stage) => stage.repairRequestVersion !== undefined))
      )
        throw corrupt();
      uniqueRuns(runs, projectId);
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSUPPORTED_WORKFLOW', 'WORKFLOW_LIMIT'].includes(error.code)
      )
        throw error;
      throw corrupt();
    }
    const bytesHash = sourceHash(loaded.bytes);
    if (marker.storeId === null) this.initializeMarker(projectId, storeId, bytesHash);
    return { schemaVersion, runs, bytesHash, storeId };
  }
  list(projectId: string): WorkflowRun[] {
    return this.guarded(() => this.read(projectId).runs);
  }
  save(projectId: string, value: WorkflowRun): void {
    this.guarded(() => {
      const run = parseWorkflowRun(value);
      if (run.request.projectId !== parseProjectId(projectId)) throw invalid();
      const loaded = this.read(projectId),
        index = loaded.runs.findIndex((item) => item.id === run.id);
      if (index >= 0) {
        const prior = loaded.runs[index]!;
        validTransition(prior, run);
        if (same(prior, run)) return;
        loaded.runs[index] = run;
      } else {
        if (loaded.runs.length >= WORKFLOW_LIMITS.runs) throw limit();
        if (
          run.status !== 'running' ||
          run.stages.length ||
          run.latestRevision !== run.request.sourceRevision ||
          run.latestSourceHash !== run.initialSourceHash ||
          run.buildId !== null ||
          run.runtimeReportId !== null ||
          run.errorCode !== null
        )
          throw conflict();
        loaded.runs.push(run);
      }
      try {
        uniqueRuns(loaded.runs, projectId);
      } catch {
        throw conflict();
      }
      this.write(
        projectId,
        loaded.runs,
        loaded.bytesHash,
        loaded.storeId ?? randomUUID(),
        loaded.schemaVersion === 3 || run.stages.some((stage) => stage.repairRequestVersion === 2)
          ? 3
          : loaded.schemaVersion === 2 || run.request.schemaVersion === 2
            ? 2
            : 1,
      );
    });
  }
  private write(
    projectId: string,
    runs: WorkflowRun[],
    previousHash: string | null,
    storeId: string,
    schemaVersion: 1 | 2 | 3,
  ): void {
    const path = this.path(projectId),
      directory = dirname(path),
      directoryIdentity = lstatSync(directory);
    if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) throw unsafe();
    const bytes = JSON.stringify({ schemaVersion, projectId, storeId, runs }) + '\n';
    if (Buffer.byteLength(bytes) > WORKFLOW_LIMITS.bytes) throw limit();
    const temp = join(directory, `.workflow-${randomUUID()}.tmp`);
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
      if (this.read(projectId).bytesHash !== previousHash) throw conflict();
      const staged = this.readBytes(temp);
      if (!staged || !sameFile(staged.identity, identity) || staged.bytes !== bytes) throw unsafe();
      if (!sameFile(lstatSync(directory), directoryIdentity)) throw unsafe();
      renameSync(temp, path);
      renamed = true;
      this.observedFiles.add(path);
      this.options.afterRename?.();
      this.syncDirectory(directory);
      if (this.read(projectId).bytesHash !== sourceHash(bytes)) throw conflict();
    } catch (error) {
      if (!renamed) throw error;
      try {
        if (this.read(projectId).bytesHash === sourceHash(bytes)) return;
      } catch {
        /* Keep uncertain state. */
      }
      throw new AppError(
        'WORKFLOW_COMMIT_UNCERTAIN',
        '自动开发流程记录可能已保存，请先核对原请求状态。',
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
            throw new AppError('WORKFLOW_IO', '自动开发临时记录未能清理，请保留现场。');
        }
      }
    }
  }
}
