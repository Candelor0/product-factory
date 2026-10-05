import { dataSchemaHash } from './data-schema-protocol';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  DataBackupRequest,
  DataBackupState,
  DataExportResult,
  DataRestorePreviewResult,
  DataRestoreResult,
} from '../shared/data-backup-contracts';
import { AppDataStore } from './app-data-store';
import { readDataBackupFile } from './data-backup-file';
import {
  DATA_BACKUP_MAX_BYTES,
  decodeDataBackup,
  encodeDataBackup,
  type DataBackup,
} from './data-backup-protocol';
import { writeExportArchive } from './export-archive';
import { ProjectStore } from './project-store';
import { SourceStore } from './source-store';
import { sourceHash } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

const unavailable = () => new AppError('DATA_BACKUP_EMPTY', '这个项目尚无已初始化的生成应用数据。');
const stale = () =>
  new AppError('DATA_RESTORE_STALE', '数据、源码或项目状态已变化，请重新选择备份并核对恢复影响。');
const cancelled = () =>
  new AppError('DATA_RESTORE_CANCELLED', '恢复已取消或预览已过期，当前操作未继续写入。');
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new AppError('INVALID_INPUT', '数据版本无效。');
  return value as number;
};
function request(
  value: unknown,
  fields: string[] = [],
): DataBackupRequest & Record<string, unknown> {
  assertRecord(value);
  assertFields(value, ['schemaVersion', 'projectId', ...fields]);
  if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '备份请求版本无效。');
  return { ...value, schemaVersion: 1, projectId: parseProjectId(value.projectId) };
}
interface Pending {
  id: string;
  requestId: string;
  projectId: string;
  expires: number;
  fingerprint: string;
  context: string;
  expectedRevision: number;
  expectedHash: string;
  backup: DataBackup;
  attempted: boolean;
  completed: boolean;
}

/** Workbench-only backup coordinator. File paths and business payloads never come from renderer IPC. */
export class DataBackupService {
  private active = false;
  private epoch = 0;
  private pending: Pending | null = null;
  constructor(
    private readonly projects: ProjectStore,
    private readonly data: AppDataStore,
    private readonly sources: Pick<SourceStore, 'get'>,
    private readonly options: {
      version: string;
      assertSafe: (contents: readonly string[]) => void;
      protectedDirectories: string[];
      chooseDestination: (suggestedName: string) => Promise<string | null>;
      chooseBackup: () => Promise<string | null>;
      closeApplication: (projectId: string) => Promise<void>;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  cancel() {
    this.epoch++;
    this.pending = null;
  }
  discard(value: unknown): void {
    const input = request(value, ['previewId']);
    const id = parseRevisionId(input.previewId);
    if (this.pending?.id === id && this.pending.projectId === input.projectId) this.cancel();
  }
  private capture(projectId: string) {
    const project = this.projects.get(projectId);
    const data = this.data.inspect(projectId);
    if (!data) throw unavailable();
    const context = {
      project: { id: project.id, name: project.name, archived: project.archived },
      storeId: data.storeId,
      dataSchemaHash: dataSchemaHash(data.schema ?? null),
      sourceContentHash: sourceHash(JSON.stringify(this.sources.get(projectId).files)),
    };
    return {
      project,
      data,
      context: sourceHash(JSON.stringify(context)),
      sourceContentHash: context.sourceContentHash,
      fingerprint: sourceHash(
        JSON.stringify({ ...context, snapshotHash: data.sha256, revision: data.snapshot.revision }),
      ),
    };
  }
  state(value: unknown): DataBackupState {
    const input = request(value);
    const data = this.data.inspect(input.projectId);
    return {
      projectId: input.projectId,
      initialized: !!data,
      revision: data?.snapshot.revision ?? null,
      keyCount: Object.keys(data?.snapshot.values ?? {}).length,
      bytes: data ? Buffer.byteLength(JSON.stringify(data.snapshot)) : 0,
    };
  }
  private safePath(destination: string) {
    if (!isAbsolute(destination))
      throw new AppError('EXPORT_UNSAFE_PATH', '请选择有效的备份文件位置。');
    let target: string;
    try {
      target = join(realpathSync(dirname(destination)), basename(destination));
    } catch {
      throw new AppError('EXPORT_UNSAFE_PATH', '所选目录不可用，请选择其他位置。');
    }
    for (const root of this.options.protectedDirectories) {
      const canonical = existsSync(root) ? realpathSync(root) : resolve(root);
      const path = relative(canonical, target);
      if (!path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)))
        throw new AppError('EXPORT_PROTECTED_PATH', '请选择工作台程序和数据目录以外的备份文件。');
    }
  }
  private async exclusive<T>(operation: (epoch: number) => Promise<T>): Promise<T> {
    if (this.active) throw new AppError('BUSY', '正在处理数据备份或恢复，请等待完成。');
    this.active = true;
    try {
      return await operation(this.epoch);
    } finally {
      this.active = false;
    }
  }
  async export(value: unknown): Promise<DataExportResult> {
    const input = request(value, ['expectedRevision']);
    const expected = revision(input.expectedRevision);
    return this.exclusive(async (epoch) => {
      const captured = this.capture(input.projectId);
      if (captured.data.snapshot.revision !== expected) throw stale();
      const bytes = encodeDataBackup({
        exportedAt: new Date(this.now()).toISOString(),
        productFactoryVersion: this.options.version,
        project: { id: captured.project.id, name: captured.project.name },
        storeId: captured.data.storeId,
        sourceContentHash: captured.sourceContentHash,
        snapshot: captured.data.snapshot,
        dataSchema: captured.data.schema ?? null,
      });
      this.options.assertSafe([bytes.toString('utf8')]);
      const path = await this.options.chooseDestination(
        `product-factory-${input.projectId.slice(0, 8)}-data-v${expected}-${this.now()}.json`,
      );
      if (!path || epoch !== this.epoch) return { status: 'cancelled' };
      if (this.capture(input.projectId).fingerprint !== captured.fingerprint) throw stale();
      this.options.assertSafe([bytes.toString('utf8')]);
      this.safePath(path);
      const saved = writeExportArchive(path, bytes, { format: 'data-backup-json' });
      return {
        status: 'exported',
        fileName: basename(path),
        filePath: path,
        bytes: saved.bytes,
        sha256: saved.sha256,
        dataRevision: expected,
      };
    });
  }
  async preview(value: unknown): Promise<DataRestorePreviewResult> {
    const input = request(value);
    return this.exclusive(async (epoch) => {
      this.pending = null;
      const captured = this.capture(input.projectId);
      if (captured.project.archived)
        throw new AppError('ARCHIVED', '请先恢复项目，再恢复应用数据。');
      const path = await this.options.chooseBackup();
      if (!path || epoch !== this.epoch) return { status: 'cancelled' };
      if (this.capture(input.projectId).fingerprint !== captured.fingerprint) throw stale();
      this.safePath(path);
      const backup = decodeDataBackup(readDataBackupFile(path, DATA_BACKUP_MAX_BYTES));
      if (backup.project.id !== input.projectId || backup.storeId !== captured.data.storeId)
        throw new AppError('DATA_BACKUP_IDENTITY', '备份不属于这个项目或当前数据存储，不能恢复。');
      if (backup.sourceContentHash !== captured.sourceContentHash)
        throw new AppError(
          'DATA_BACKUP_SOURCE',
          '备份对应的源码内容与当前不同，请先核对源码版本；当前数据未修改。',
        );
      if (
        dataSchemaHash(backup.dataSchema ?? null) !== dataSchemaHash(captured.data.schema ?? null)
      )
        throw new AppError(
          'DATA_BACKUP_SCHEMA',
          '备份与当前数据结构不同，不能通过恢复更改结构版本。',
        );
      const oldValues = captured.data.snapshot.values;
      const newValues = backup.snapshot.values;
      const currentKeys = Object.keys(oldValues);
      const backupKeys = Object.keys(newValues);
      const changedKeys = backupKeys.filter(
        (key) =>
          Object.hasOwn(oldValues, key) &&
          JSON.stringify(oldValues[key]) !== JSON.stringify(newValues[key]),
      );
      const addedKeys = backupKeys.filter((key) => !Object.hasOwn(oldValues, key));
      const removedKeys = currentKeys.filter((key) => !Object.hasOwn(newValues, key));
      const id = randomUUID();
      this.pending = {
        id,
        requestId: randomUUID(),
        projectId: input.projectId,
        expires: this.now() + 10 * 60 * 1000,
        fingerprint: captured.fingerprint,
        context: captured.context,
        expectedRevision: captured.data.snapshot.revision,
        expectedHash: captured.data.sha256,
        backup,
        attempted: false,
        completed: false,
      };
      return {
        status: 'preview',
        previewId: id,
        projectId: input.projectId,
        fileName: basename(path),
        exportedAt: backup.exportedAt,
        backupRevision: backup.snapshot.revision,
        currentRevision: captured.data.snapshot.revision,
        backupKeyCount: backupKeys.length,
        currentKeyCount: currentKeys.length,
        backupBytes: Buffer.byteLength(JSON.stringify(backup.snapshot)),
        addedKeys,
        removedKeys,
        changedKeys,
        unchangedKeys: backupKeys.length - changedKeys.length - addedKeys.length,
      };
    });
  }
  async confirm(value: unknown): Promise<DataRestoreResult> {
    const input = request(value, ['previewId']);
    const id = parseRevisionId(input.previewId);
    return this.exclusive(async (epoch) => {
      const pending = this.pending;
      const check = () => {
        if (
          !pending ||
          pending !== this.pending ||
          pending.id !== id ||
          pending.projectId !== input.projectId ||
          epoch !== this.epoch ||
          this.now() > pending.expires
        )
          throw cancelled();
        const captured = this.capture(input.projectId);
        if (
          captured.project.archived ||
          captured.context !== pending.context ||
          (!pending.attempted && captured.fingerprint !== pending.fingerprint)
        )
          throw stale();
        return pending;
      };
      const selected = check();
      if (!selected.completed) {
        await this.options.closeApplication(input.projectId);
        check(); // Window shutdown is asynchronous; no blind write after it.
      }
      selected.attempted = true;
      const result = this.data.restore(input.projectId, {
        requestId: selected.requestId,
        storeId: selected.backup.storeId,
        expectedRevision: selected.expectedRevision,
        expectedHash: selected.expectedHash,
        values: selected.backup.snapshot.values,
        schema: selected.backup.dataSchema ?? null,
      });
      selected.completed = true;
      return { status: 'restored', ...result };
    });
  }
}
