import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AppDataApplyRequest,
  AppDataApplyResult,
  AppDataSnapshot,
} from '../shared/app-data-contracts';
import type { DataSchemaDefinition } from '../shared/data-schema-contracts';
import {
  dataSchemaHash,
  validateDataSchemaDefinition,
  validateSchemaValues,
} from './data-schema-protocol';
import {
  APP_DATA_LIMITS,
  applyAppDataSnapshot,
  validateAppDataApplyRequest,
  validateAppDataSnapshot,
} from './app-data-protocol';
import { ProjectStore } from './project-store';
import { sourceHash } from './source-protocol';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';

interface Identity {
  schemaVersion: 1;
  projectId: string;
  storeId: string;
  initializedAt: string;
}
interface SavedSnapshot {
  snapshot: AppDataSnapshot;
  sha256: string;
}
interface Receipt {
  requestId: string;
  requestHash: string;
  expectedRevision: number;
  appliedRevision: number;
}
interface DataRecordBase {
  projectId: string;
  storeId: string;
  current: SavedSnapshot;
  history: SavedSnapshot[];
  receipts: Receipt[];
}
interface MigrationCheckpoint {
  requestId: string;
  before: SavedSnapshot;
  beforeSchema: DataSchemaDefinition | null;
  afterSchema: DataSchemaDefinition;
  appliedRevision: number;
  rolledBack: boolean;
  sha256: string;
}
type DataRecord = DataRecordBase &
  (
    | { schemaVersion: 1 }
    | {
        schemaVersion: 2;
        schema: DataSchemaDefinition | null;
        schemaHash: string;
        migration: MigrationCheckpoint | null;
      }
  );
interface Loaded {
  identity: Identity;
  record: DataRecord;
  bytesHash: string;
}
export interface AppDataInspection {
  storeId: string;
  snapshot: AppDataSnapshot;
  sha256: string;
  schema?: DataSchemaDefinition | null;
  migration?: {
    requestId: string;
    beforeSchema: DataSchemaDefinition | null;
    afterSchema: DataSchemaDefinition;
    beforeSnapshot: AppDataSnapshot;
    appliedRevision: number;
    canRollback: boolean;
  };
}
/** Trusted backup coordinator only; never part of the generated application SDK. */
export interface AppDataRestoreRequest {
  requestId: string;
  storeId: string;
  expectedRevision: number;
  expectedHash: string;
  values: AppDataSnapshot['values'];
  schema?: DataSchemaDefinition | null;
}
export interface AppDataMigrateRequest {
  requestId: string;
  storeId: string;
  expectedRevision: number;
  expectedHash: string;
  fromSchemaHash: string;
  schema: DataSchemaDefinition | null;
  values: AppDataSnapshot['values'];
}
export type AppDataRollbackRequest = Omit<AppDataMigrateRequest, 'schema' | 'values'>;
interface AppDataStoreOptions {
  /** Trusted fault injection only; never transported from generated code. */
  beforeRename?: () => void;
  afterRename?: () => void;
  beforeInitializeRename?: () => void;
  afterInitializeRename?: () => void;
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const corrupt = () =>
  new AppError('APP_DATA_CORRUPT', '应用数据校验失败，原文件已保留，请检查备份。');
const missing = () =>
  new AppError(
    'APP_DATA_MISSING',
    '已初始化的应用数据文件缺失，已停止读取和写入，请先恢复原文件。',
  );
const unsafe = () =>
  new AppError('UNSAFE_PATH', '应用数据路径不是独立普通文件或目录，已停止访问。');
const limit = () => new AppError('APP_DATA_LIMIT', '应用数据达到存储上限，本次未写入。');
const conflict = () => new AppError('APP_DATA_CONFLICT', '应用数据已变化，请重新读取后再保存。');
const archived = () => new AppError('ARCHIVED', '请先恢复项目，再保存应用数据。');
const invalidRestore = () => new AppError('APP_DATA_INVALID', '应用数据恢复请求格式不正确。');
const schemaMismatch = () =>
  new AppError('APP_DATA_SCHEMA_MISMATCH', '应用数据结构与当前源码不匹配，请先核对迁移。');
const migrationConflict = () =>
  new AppError('APP_DATA_MIGRATION_CONFLICT', '迁移版本或回退条件已变化，未修改应用数据。');
const temporaryName =
  /^\.app-data-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const saved = (snapshot: AppDataSnapshot): SavedSnapshot => ({
  snapshot,
  sha256: sourceHash(JSON.stringify(snapshot)),
});
const serialized = (value: unknown) => JSON.stringify(value) + '\n';
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw corrupt();
  return value;
}
function strictFields(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  assertRecord(value);
  const keys = Reflect.ownKeys(value);
  if (fields.some((field) => !Object.hasOwn(value, field))) throw invalidRestore();
  for (const name of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    if (
      typeof name !== 'string' ||
      ![...fields, ...optional].includes(name) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw invalidRestore();
  }
}
const schemaDefinition = (value: unknown): DataSchemaDefinition | null =>
  value === null ? null : validateDataSchemaDefinition(value);
const recordSchema = (record: DataRecord) => (record.schemaVersion === 2 ? record.schema : null);
const requireSchema = (record: DataRecord, schema: DataSchemaDefinition | null) => {
  if (dataSchemaHash(recordSchema(record)) !== dataSchemaHash(schema)) throw schemaMismatch();
};
const checkpoint = (value: Omit<MigrationCheckpoint, 'sha256'>): MigrationCheckpoint => ({
  ...value,
  sha256: sourceHash(JSON.stringify(value)),
});
function restoreRequest(value: unknown): AppDataRestoreRequest {
  // Inspect descriptors before reading fields so accessors/symbols cannot affect validation.
  try {
    const fields = ['requestId', 'storeId', 'expectedRevision', 'expectedHash', 'values'];
    strictFields(value, fields, ['schema']);
    const schema = Object.hasOwn(value, 'schema') ? schemaDefinition(value.schema) : null;
    const requestId = parseRevisionId(value.requestId);
    const storeId = parseRevisionId(value.storeId);
    if (typeof value.expectedHash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.expectedHash))
      throw invalidRestore();
    const snapshot = validateAppDataSnapshot({
      revision: value.expectedRevision,
      values: value.values,
    });
    return {
      requestId,
      storeId,
      expectedRevision: snapshot.revision,
      expectedHash: value.expectedHash,
      values: snapshot.values,
      // Preserve the legacy null-schema receipt hash, including explicit schema:null.
      ...(schema ? { schema } : {}),
    };
  } catch (error) {
    if (error instanceof AppError && error.code === 'APP_DATA_LIMIT') throw error;
    throw invalidRestore();
  }
}
function migrationRequest(value: unknown, rollback: true): AppDataRollbackRequest;
function migrationRequest(value: unknown, rollback?: false): AppDataMigrateRequest;
function migrationRequest(
  value: unknown,
  rollback = false,
): AppDataMigrateRequest | AppDataRollbackRequest {
  try {
    strictFields(value, [
      'requestId',
      'storeId',
      'expectedRevision',
      'expectedHash',
      'fromSchemaHash',
      ...(rollback ? [] : ['schema', 'values']),
    ]);
    const base = {
      requestId: parseRevisionId(value.requestId),
      storeId: parseRevisionId(value.storeId),
      expectedRevision: validateAppDataSnapshot({ revision: value.expectedRevision, values: {} })
        .revision,
      expectedHash: hash(value.expectedHash),
      fromSchemaHash: hash(value.fromSchemaHash),
    };
    if (rollback) return base;
    const schema = schemaDefinition(value.schema);
    const snapshot = validateAppDataSnapshot({
      revision: base.expectedRevision,
      values: value.values,
    });
    validateSchemaValues(snapshot.values, schema);
    return { ...base, schema, values: snapshot.values };
  } catch (error) {
    if (
      error instanceof AppError &&
      [
        'APP_DATA_LIMIT',
        'DATA_SCHEMA_INVALID',
        'DATA_SCHEMA_LIMIT',
        'DATA_SCHEMA_MISMATCH',
      ].includes(error.code)
    )
      throw error;
    throw invalidRestore();
  }
}
function parseIdentity(bytes: string, projectId: string): Identity {
  const value: unknown = JSON.parse(bytes);
  assertRecord(value);
  if (value.schemaVersion !== 1)
    throw new AppError('APP_DATA_UNSUPPORTED', '应用数据版本尚不支持，原文件已保留。');
  assertFields(value, ['schemaVersion', 'projectId', 'storeId', 'initializedAt']);
  if (
    value.projectId !== projectId ||
    typeof value.initializedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.initializedAt)) ||
    new Date(value.initializedAt).toISOString() !== value.initializedAt
  )
    throw corrupt();
  return {
    schemaVersion: 1,
    projectId,
    storeId: parseRevisionId(value.storeId),
    initializedAt: value.initializedAt,
  };
}
function parseSaved(value: unknown): SavedSnapshot {
  assertRecord(value);
  assertFields(value, ['snapshot', 'sha256']);
  const snapshot = validateAppDataSnapshot(value.snapshot);
  if (snapshot.revision === 0 && Object.keys(snapshot.values).length) throw corrupt();
  if (hash(value.sha256) !== sourceHash(JSON.stringify(snapshot))) throw corrupt();
  return saved(snapshot);
}
function parseRecord(bytes: string, identity: Identity): DataRecord {
  const raw: unknown = JSON.parse(bytes);
  assertRecord(raw);
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)
    throw new AppError('APP_DATA_UNSUPPORTED', '应用数据版本尚不支持，原文件已保留。');
  strictFields(raw, [
    'schemaVersion',
    'projectId',
    'storeId',
    'current',
    'history',
    'receipts',
    ...(raw.schemaVersion === 2 ? ['schema', 'schemaHash', 'migration'] : []),
  ]);
  if (
    raw.projectId !== identity.projectId ||
    raw.storeId !== identity.storeId ||
    !Array.isArray(raw.history) ||
    !Array.isArray(raw.receipts)
  )
    throw corrupt();
  const current = parseSaved(raw.current);
  const revision = current.snapshot.revision;
  const rawHistory = raw.history;
  const rawReceipts = raw.receipts;
  if (
    raw.history.length !== Math.min(revision, APP_DATA_LIMITS.history) ||
    raw.receipts.length !== Math.min(revision, APP_DATA_LIMITS.receipts)
  )
    throw corrupt();
  const history = rawHistory.map((entry, index) => {
    const item = parseSaved(entry);
    if (item.snapshot.revision !== revision - rawHistory.length + index) throw corrupt();
    return item;
  });
  const requestIds = new Set<string>();
  const receipts = rawReceipts.map((item, index): Receipt => {
    assertRecord(item);
    assertFields(item, ['requestId', 'requestHash', 'expectedRevision', 'appliedRevision']);
    const appliedRevision = revision - rawReceipts.length + index + 1;
    const requestId = parseRevisionId(item.requestId);
    if (
      requestIds.has(requestId) ||
      item.appliedRevision !== appliedRevision ||
      item.expectedRevision !== appliedRevision - 1
    )
      throw corrupt();
    requestIds.add(requestId);
    return {
      requestId,
      requestHash: hash(item.requestHash),
      expectedRevision: appliedRevision - 1,
      appliedRevision,
    };
  });
  const base: DataRecordBase = {
    projectId: identity.projectId,
    storeId: identity.storeId,
    current,
    history,
    receipts,
  };
  if (raw.schemaVersion === 1) return { schemaVersion: 1, ...base };
  const schema = schemaDefinition(raw.schema);
  const schemaHash = dataSchemaHash(schema);
  if (hash(raw.schemaHash) !== schemaHash) throw corrupt();
  validateSchemaValues(current.snapshot.values, schema);
  let migration: MigrationCheckpoint | null = null;
  if (raw.migration !== null) {
    const value = raw.migration;
    strictFields(value, [
      'requestId',
      'before',
      'beforeSchema',
      'afterSchema',
      'appliedRevision',
      'rolledBack',
      'sha256',
    ]);
    const before = parseSaved(value.before);
    const beforeSchema = schemaDefinition(value.beforeSchema);
    const afterSchema = validateDataSchemaDefinition(value.afterSchema);
    const requestId = parseRevisionId(value.requestId);
    const appliedRevision = value.appliedRevision;
    if (
      !Number.isSafeInteger(appliedRevision) ||
      (appliedRevision as number) < 1 ||
      (appliedRevision as number) > revision ||
      before.snapshot.revision !== (appliedRevision as number) - 1 ||
      typeof value.rolledBack !== 'boolean' ||
      afterSchema.version !== (beforeSchema?.version ?? 0) + 1
    )
      throw corrupt();
    validateSchemaValues(before.snapshot.values, beforeSchema);
    migration = checkpoint({
      requestId,
      before,
      beforeSchema,
      afterSchema,
      appliedRevision: appliedRevision as number,
      rolledBack: value.rolledBack,
    });
    if (
      hash(value.sha256) !== migration.sha256 ||
      schemaHash !== dataSchemaHash(migration.rolledBack ? beforeSchema : afterSchema) ||
      (migration.rolledBack && revision <= migration.appliedRevision)
    )
      throw corrupt();
    const historical = history.find(
      (entry) => entry.snapshot.revision === before.snapshot.revision,
    );
    if (historical && historical.sha256 !== before.sha256) throw corrupt();
    const receipt = receipts.find((item) => item.appliedRevision === migration!.appliedRevision);
    if (receipt && receipt.requestId !== requestId) throw corrupt();
    if (
      migration.rolledBack &&
      revision === migration.appliedRevision + 1 &&
      JSON.stringify(current.snapshot.values) !== JSON.stringify(before.snapshot.values)
    )
      throw corrupt();
  }
  if (schema === null && migration === null) throw corrupt();
  return { schemaVersion: 2, ...base, schema, schemaHash, migration };
}

/** One trusted synchronous writer; generated applications never choose project IDs or host paths. */
export class AppDataStore {
  constructor(
    private readonly projects: ProjectStore,
    private readonly options: AppDataStoreOptions = {},
  ) {}
  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('APP_DATA_IO', '应用数据暂时无法访问，请保留现场后重试。');
    }
  }
  private paths(projectId: string) {
    this.projects.get(projectId);
    const data = join(this.projects.rootPath, 'projects', projectId, 'data');
    const directory = join(data, 'generated');
    return {
      data,
      directory,
      file: join(directory, 'state.json'),
      inner: join(directory, 'identity.json'),
      outer: join(data, 'generated.initialized.json'),
    };
  }
  private directoryExists(path: string): boolean {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
      return true;
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  }
  private bytes(path: string, maximum: number): string | null {
    let fd: number | undefined;
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw unsafe();
      if (entry.size > maximum) throw limit();
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw unsafe();
      if (stat.size > maximum) throw limit();
      const bytes = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(bytes) > maximum) throw limit();
      return bytes;
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private syncDirectory(path: string): void {
    if (process.platform === 'win32') return;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private createFile(path: string, bytes: string): void {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, bytes, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private outerMarker(projectId: string, identity: Identity): void {
    const { data, outer, directory, inner } = this.paths(projectId);
    const previous = this.bytes(outer, 1024);
    if (previous !== null) {
      if (serialized(parseIdentity(previous, projectId)) !== serialized(identity)) throw corrupt();
      return;
    }
    const temporary = join(data, `.generated-marker-${randomUUID()}.tmp`);
    let created = false;
    try {
      this.createFile(temporary, serialized(identity));
      created = true;
      if (!this.directoryExists(directory) || this.bytes(inner, 1024) !== serialized(identity))
        throw corrupt();
      const appeared = this.bytes(outer, 1024);
      if (appeared !== null) {
        if (serialized(parseIdentity(appeared, projectId)) !== serialized(identity))
          throw corrupt();
        return;
      }
      renameSync(temporary, outer);
      this.syncDirectory(data);
    } finally {
      if (created) {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
    }
  }
  private initialize(projectId: string, schema: DataSchemaDefinition | null = null): void {
    const { data, directory, outer } = this.paths(projectId);
    if (this.projects.get(projectId).archived) throw archived();
    if (this.bytes(outer, 1024) !== null || this.directoryExists(directory)) throw missing();
    const identity: Identity = {
      schemaVersion: 1,
      projectId,
      storeId: randomUUID(),
      initializedAt: new Date().toISOString(),
    };
    const base: DataRecord = {
      schemaVersion: 1,
      projectId,
      storeId: identity.storeId,
      current: saved({ revision: 0, values: {} }),
      history: [],
      receipts: [],
    };
    const record: DataRecord = schema
      ? { ...base, schemaVersion: 2, schema, schemaHash: dataSchemaHash(schema), migration: null }
      : base;
    validateSchemaValues(record.current.snapshot.values, schema);
    const staging = join(data, `.generated-init-${randomUUID()}.tmp`);
    mkdirSync(staging, { mode: 0o700 });
    let renamed = false;
    try {
      this.createFile(join(staging, 'identity.json'), serialized(identity));
      this.createFile(join(staging, 'state.json'), serialized(record));
      this.syncDirectory(staging);
      this.options.beforeInitializeRename?.();
      this.paths(projectId);
      if (this.projects.get(projectId).archived) throw archived();
      if (this.bytes(outer, 1024) !== null || this.directoryExists(directory)) throw conflict();
      renameSync(staging, directory);
      renamed = true;
      this.syncDirectory(data);
      this.options.afterInitializeRename?.();
      this.outerMarker(projectId, identity);
    } catch (error) {
      if (renamed)
        throw new AppError(
          'APP_DATA_INITIALIZATION_UNCERTAIN',
          '应用数据初始化可能已完成，请重新读取以核对，已有内容不会覆盖。',
        );
      throw error;
    } finally {
      if (!renamed) {
        // Only our two known staging files are removed. Crash leftovers are never promoted.
        for (const name of ['state.json', 'identity.json']) {
          try {
            unlinkSync(join(staging, name));
          } catch (error) {
            if (!absent(error)) throw error;
          }
        }
        try {
          rmdirSync(staging);
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
    }
  }
  private read(projectId: string, initialize?: true, schema?: DataSchemaDefinition | null): Loaded;
  private read(projectId: string, initialize: false): Loaded | null;
  private read(
    projectId: string,
    initialize = true,
    schema: DataSchemaDefinition | null = null,
  ): Loaded | null {
    const { directory, outer, inner, file } = this.paths(projectId);
    const outerBytes = this.bytes(outer, 1024);
    const exists = this.directoryExists(directory);
    if (!exists) {
      if (outerBytes !== null) throw missing();
      if (!initialize) return null;
      this.initialize(projectId, schema);
      return this.read(projectId);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!['identity.json', 'state.json'].includes(entry.name) && !temporaryName.test(entry.name))
        throw corrupt();
      const stat = lstatSync(join(directory, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
    }
    const identityBytes = this.bytes(inner, 1024);
    const recordBytes = this.bytes(file, APP_DATA_LIMITS.recordBytes);
    if (identityBytes === null || recordBytes === null) throw missing();
    let identity: Identity;
    let record: DataRecord;
    try {
      identity = parseIdentity(identityBytes, projectId);
      if (
        outerBytes !== null &&
        serialized(parseIdentity(outerBytes, projectId)) !== serialized(identity)
      )
        throw corrupt();
      record = parseRecord(recordBytes, identity);
    } catch (error) {
      if (
        error instanceof AppError &&
        ['APP_DATA_UNSUPPORTED', 'UNSAFE_PATH', 'APP_DATA_LIMIT', 'APP_DATA_MISSING'].includes(
          error.code,
        )
      )
        throw error;
      throw corrupt();
    }
    // Directory rename committed both initial files. A crash before outer-marker commit
    // is recoverable from this fully validated store; a missing state file is never recreated.
    if (outerBytes === null) {
      if (!initialize) throw missing();
      this.outerMarker(projectId, identity);
    }
    return { identity, record, bytesHash: sourceHash(recordBytes) };
  }
  inspect(projectId: string): AppDataInspection | null {
    return this.guarded(() => {
      const loaded = this.read(projectId, false);
      if (!loaded) return null;
      return {
        storeId: loaded.identity.storeId,
        snapshot: structuredClone(loaded.record.current.snapshot),
        sha256: loaded.record.current.sha256,
        ...(loaded.record.schemaVersion === 2
          ? {
              schema: structuredClone(loaded.record.schema),
              ...(loaded.record.migration
                ? {
                    migration: {
                      requestId: loaded.record.migration.requestId,
                      beforeSchema: structuredClone(loaded.record.migration.beforeSchema),
                      afterSchema: structuredClone(loaded.record.migration.afterSchema),
                      beforeSnapshot: structuredClone(loaded.record.migration.before.snapshot),
                      appliedRevision: loaded.record.migration.appliedRevision,
                      canRollback:
                        !loaded.record.migration.rolledBack &&
                        loaded.record.current.snapshot.revision ===
                          loaded.record.migration.appliedRevision,
                    },
                  }
                : {}),
            }
          : {}),
      };
    });
  }
  get(projectId: string, expectedSchema: DataSchemaDefinition | null = null): AppDataSnapshot {
    return this.guarded(() => {
      const schema = schemaDefinition(expectedSchema);
      const loaded = this.read(projectId, true, schema);
      requireSchema(loaded.record, schema);
      return structuredClone(loaded.record.current.snapshot);
    });
  }
  apply(
    projectId: string,
    value: AppDataApplyRequest,
    expectedSchema: DataSchemaDefinition | null = null,
  ): AppDataApplyResult {
    return this.guarded(() => {
      const request = validateAppDataApplyRequest(value);
      const schema = schemaDefinition(expectedSchema);
      if (this.projects.get(projectId).archived) throw archived();
      const loaded = this.read(projectId, true, schema);
      requireSchema(loaded.record, schema);
      const requestHash = sourceHash(
        JSON.stringify(
          schema ? { operation: 'apply', schemaHash: dataSchemaHash(schema), ...request } : request,
        ),
      );
      const prior = loaded.record.receipts.find(
        (receipt) => receipt.requestId === request.requestId,
      );
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new AppError(
            'APP_DATA_REQUEST_CONFLICT',
            '重复请求标识对应了不同数据，请重新操作。',
          );
        return {
          revision: loaded.record.current.snapshot.revision,
          appliedRevision: prior.appliedRevision,
          replayed: true,
        };
      }
      const snapshot = applyAppDataSnapshot(loaded.record.current.snapshot, request);
      validateSchemaValues(snapshot.values, schema);
      const record: DataRecord = {
        ...loaded.record,
        current: saved(snapshot),
        history: [...loaded.record.history, loaded.record.current].slice(-APP_DATA_LIMITS.history),
        receipts: [
          ...loaded.record.receipts,
          {
            requestId: request.requestId,
            requestHash,
            expectedRevision: request.expectedRevision,
            appliedRevision: snapshot.revision,
          },
        ].slice(-APP_DATA_LIMITS.receipts),
      };
      this.write(projectId, record, loaded.bytesHash);
      return { revision: snapshot.revision, appliedRevision: snapshot.revision, replayed: false };
    });
  }
  restore(projectId: string, value: AppDataRestoreRequest): AppDataApplyResult {
    return this.guarded(() => {
      const request = restoreRequest(value);
      if (this.projects.get(projectId).archived) throw archived();
      const loaded = this.read(projectId, false);
      if (!loaded) throw missing();
      if (loaded.identity.storeId !== request.storeId) throw conflict();
      requireSchema(loaded.record, request.schema ?? null);
      validateSchemaValues(request.values, request.schema ?? null);
      // Keep SDK apply hashes unchanged and distinguish whole-snapshot restoration receipts.
      const requestHash = sourceHash(JSON.stringify({ operation: 'restore', ...request }));
      const prior = loaded.record.receipts.find(
        (receipt) => receipt.requestId === request.requestId,
      );
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new AppError(
            'APP_DATA_REQUEST_CONFLICT',
            '重复请求标识对应了不同数据，请重新操作。',
          );
        return {
          revision: loaded.record.current.snapshot.revision,
          appliedRevision: prior.appliedRevision,
          replayed: true,
        };
      }
      const current = loaded.record.current;
      if (
        current.snapshot.revision !== request.expectedRevision ||
        current.sha256 !== request.expectedHash
      )
        throw conflict();
      if (current.snapshot.revision === Number.MAX_SAFE_INTEGER) throw limit();
      const snapshot = validateAppDataSnapshot({
        revision: current.snapshot.revision + 1,
        values: request.values,
      });
      const record: DataRecord = {
        ...loaded.record,
        current: saved(snapshot),
        history: [...loaded.record.history, current].slice(-APP_DATA_LIMITS.history),
        receipts: [
          ...loaded.record.receipts,
          {
            requestId: request.requestId,
            requestHash,
            expectedRevision: request.expectedRevision,
            appliedRevision: snapshot.revision,
          },
        ].slice(-APP_DATA_LIMITS.receipts),
      };
      this.write(projectId, record, loaded.bytesHash);
      return { revision: snapshot.revision, appliedRevision: snapshot.revision, replayed: false };
    });
  }
  private migrationBase(projectId: string, request: AppDataRollbackRequest): Loaded {
    if (this.projects.get(projectId).archived) throw archived();
    const loaded = this.read(projectId, false);
    if (!loaded) throw missing();
    if (loaded.identity.storeId !== request.storeId) throw conflict();
    return loaded;
  }
  private replay(
    record: DataRecord,
    requestId: string,
    requestHash: string,
  ): AppDataApplyResult | null {
    const prior = record.receipts.find((receipt) => receipt.requestId === requestId);
    if (!prior) return null;
    if (prior.requestHash !== requestHash)
      throw new AppError('APP_DATA_REQUEST_CONFLICT', '重复请求标识对应了不同数据，请重新操作。');
    return {
      revision: record.current.snapshot.revision,
      appliedRevision: prior.appliedRevision,
      replayed: true,
    };
  }
  private migrationCurrent(record: DataRecord, request: AppDataRollbackRequest): void {
    if (
      record.current.snapshot.revision !== request.expectedRevision ||
      record.current.sha256 !== request.expectedHash
    )
      throw conflict();
    if (dataSchemaHash(recordSchema(record)) !== request.fromSchemaHash) throw schemaMismatch();
    if (record.current.snapshot.revision === Number.MAX_SAFE_INTEGER) throw limit();
  }
  private commitMigration(
    projectId: string,
    loaded: Loaded,
    request: AppDataRollbackRequest,
    requestHash: string,
    snapshot: AppDataSnapshot,
    schema: DataSchemaDefinition | null,
    migration: MigrationCheckpoint,
  ): AppDataApplyResult {
    const record: DataRecord = {
      ...loaded.record,
      schemaVersion: 2,
      schema,
      schemaHash: dataSchemaHash(schema),
      migration,
      current: saved(snapshot),
      history: [...loaded.record.history, loaded.record.current].slice(-APP_DATA_LIMITS.history),
      receipts: [
        ...loaded.record.receipts,
        {
          requestId: request.requestId,
          requestHash,
          expectedRevision: request.expectedRevision,
          appliedRevision: snapshot.revision,
        },
      ].slice(-APP_DATA_LIMITS.receipts),
    };
    this.write(projectId, record, loaded.bytesHash);
    return { revision: snapshot.revision, appliedRevision: snapshot.revision, replayed: false };
  }
  migrate(projectId: string, value: AppDataMigrateRequest): AppDataApplyResult {
    return this.guarded(() => {
      const request = migrationRequest(value);
      const loaded = this.migrationBase(projectId, request);
      const requestHash = sourceHash(JSON.stringify({ operation: 'migrate', ...request }));
      const replay = this.replay(loaded.record, request.requestId, requestHash);
      if (replay) return replay;
      this.migrationCurrent(loaded.record, request);
      const beforeSchema = recordSchema(loaded.record);
      if (!request.schema || request.schema.version !== (beforeSchema?.version ?? 0) + 1)
        throw migrationConflict();
      const snapshot = validateAppDataSnapshot({
        revision: request.expectedRevision + 1,
        values: request.values,
      });
      const migration = checkpoint({
        requestId: request.requestId,
        before: loaded.record.current,
        beforeSchema,
        afterSchema: request.schema,
        appliedRevision: snapshot.revision,
        rolledBack: false,
      });
      return this.commitMigration(
        projectId,
        loaded,
        request,
        requestHash,
        snapshot,
        request.schema,
        migration,
      );
    });
  }
  rollbackMigration(projectId: string, value: AppDataRollbackRequest): AppDataApplyResult {
    return this.guarded(() => {
      const request = migrationRequest(value, true);
      const loaded = this.migrationBase(projectId, request);
      const requestHash = sourceHash(
        JSON.stringify({ operation: 'rollback-migration', ...request }),
      );
      const replay = this.replay(loaded.record, request.requestId, requestHash);
      if (replay) return replay;
      this.migrationCurrent(loaded.record, request);
      const previous = loaded.record.schemaVersion === 2 ? loaded.record.migration : null;
      if (
        !previous ||
        previous.rolledBack ||
        loaded.record.current.snapshot.revision !== previous.appliedRevision
      )
        throw migrationConflict();
      const snapshot = validateAppDataSnapshot({
        revision: request.expectedRevision + 1,
        values: previous.before.snapshot.values,
      });
      validateSchemaValues(snapshot.values, previous.beforeSchema);
      const { sha256: _previousHash, ...payload } = previous;
      const migration = checkpoint({ ...payload, rolledBack: true });
      return this.commitMigration(
        projectId,
        loaded,
        request,
        requestHash,
        snapshot,
        previous.beforeSchema,
        migration,
      );
    });
  }
  private write(projectId: string, record: DataRecord, previousHash: string): void {
    const { directory, file } = this.paths(projectId);
    const bytes = serialized(record);
    if (Buffer.byteLength(bytes) > APP_DATA_LIMITS.recordBytes) throw limit();
    const temporary = join(directory, `.app-data-${randomUUID()}.tmp`);
    let created = false,
      renamed = false;
    try {
      this.createFile(temporary, bytes);
      created = true;
      this.options.beforeRename?.();
      if (this.projects.get(projectId).archived) throw archived();
      const fresh = this.read(projectId, false);
      if (!fresh || fresh.bytesHash !== previousHash || fresh.identity.storeId !== record.storeId)
        throw conflict();
      renameSync(temporary, file);
      renamed = true;
      this.options.afterRename?.();
      this.syncDirectory(directory);
    } catch (error) {
      if (!renamed) throw error;
      // An exact byte readback reconciles a lost acknowledgement; never issue a second write.
      try {
        if (this.read(projectId, false)?.bytesHash === sourceHash(bytes)) return;
      } catch {
        /* Preserve the uncertainty. */
      }
      throw new AppError(
        'APP_DATA_COMMIT_UNCERTAIN',
        '应用数据可能已保存，请保留原请求并重新读取核对。',
      );
    } finally {
      if (created) {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if (!absent(error))
            throw new AppError('APP_DATA_IO', '临时应用数据未清理完成，请保留现场。');
        }
      }
    }
  }
}
