import { randomUUID } from 'node:crypto';
import type {
  DataMigrationPreview,
  DataMigrationResult,
  DataMigrationState,
} from '../shared/data-migration-contracts';
import type { AppDataSnapshot } from '../shared/app-data-contracts';
import type { DataSchemaDefinition } from '../shared/data-schema-contracts';
import { AppDataStore } from './app-data-store';
import {
  dataSchemaHash,
  migrateSchemaValues,
  readSourceDataSchema,
  schemaDefinition,
} from './data-schema-protocol';
import { ProjectStore } from './project-store';
import type { SourceStore } from './source-store';
import { sourceHash } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

function request(
  value: unknown,
  fields: string[] = [],
): Record<string, unknown> & { projectId: string } {
  assertRecord(value);
  assertFields(value, ['schemaVersion', 'projectId', ...fields]);
  if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '数据结构请求版本无效。');
  return { ...value, projectId: parseProjectId(value.projectId) };
}
const stale = () =>
  new AppError('DATA_MIGRATION_STALE', '数据、源码或项目状态已变化，请重新预览迁移影响。');
const unavailable = () =>
  new AppError(
    'DATA_MIGRATION_UNAVAILABLE',
    '当前数据与源码不满足这项结构变更条件，请先核对结构版本。',
  );
interface Pending {
  id: string;
  requestId: string;
  projectId: string;
  operation: 'migrate' | 'rollback';
  expires: number;
  context: string;
  fingerprint: string;
  storeId: string;
  expectedRevision: number;
  expectedHash: string;
  fromSchemaHash: string;
  schema: DataSchemaDefinition | null;
  values: AppDataSnapshot['values'];
  attempted: boolean;
  completed: boolean;
}
/** No business values leave this trusted coordinator through the workbench API. */
export class DataMigrationService {
  private pending: Pending | null = null;
  private active = false;
  private epoch = 0;
  constructor(
    private readonly projects: ProjectStore,
    private readonly data: AppDataStore,
    private readonly sources: Pick<SourceStore, 'get'>,
    private readonly options: {
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
  discard(value: unknown) {
    const input = request(value, ['previewId']);
    const id = parseRevisionId(input.previewId);
    if (this.pending?.id === id && this.pending.projectId === input.projectId) this.cancel();
  }
  private capture(id: string) {
    const project = this.projects.get(id);
    const data = this.data.inspect(id);
    const source = this.sources.get(id);
    const declaration = readSourceDataSchema(source.files);
    const target = declaration ? schemaDefinition(declaration) : null;
    const context = sourceHash(
      JSON.stringify({
        project: { id, name: project.name, archived: project.archived },
        storeId: data?.storeId,
        sourceHash: sourceHash(JSON.stringify(source)),
      }),
    );
    const fingerprint = sourceHash(
      JSON.stringify({
        context,
        revision: data?.snapshot.revision,
        hash: data?.sha256,
        schema: dataSchemaHash(data?.schema ?? null),
      }),
    );
    return { project, data, declaration, target, context, fingerprint };
  }
  private status(c: ReturnType<DataMigrationService['capture']>): DataMigrationState {
    const current = c.data?.schema ?? null;
    const compatible = !c.data || dataSchemaHash(current) === dataSchemaHash(c.target);
    const currentVersion = current?.version ?? 0;
    const targetVersion = c.target?.version ?? 0;
    const canMigrate =
      !!c.data &&
      !c.project.archived &&
      !compatible &&
      targetVersion === currentVersion + 1 &&
      c.declaration?.migration?.fromVersion === currentVersion;
    const canRollback =
      !!c.data?.migration?.canRollback &&
      !c.project.archived &&
      dataSchemaHash(c.data.migration.beforeSchema) === dataSchemaHash(c.target);
    return {
      projectId: c.project.id,
      initialized: !!c.data,
      revision: c.data?.snapshot.revision ?? null,
      currentVersion,
      targetVersion,
      compatible,
      canMigrate,
      canRollback,
      message: !c.data
        ? '尚未初始化数据；首次打开应用时使用当前结构。'
        : compatible
          ? '源码与数据结构一致。'
          : canMigrate
            ? '需要预览并确认迁移后才能打开当前应用。'
            : canRollback
              ? '源码已回到迁移前结构，可预览回退。'
              : '结构不一致；需要相邻版本迁移声明，或满足条件的迁移回退。',
    };
  }
  state(value: unknown): DataMigrationState {
    return this.status(this.capture(request(value).projectId));
  }
  /** Read-only opening guard: opening or checking must never silently migrate an existing store. */
  assertCompatible(projectId: string) {
    if (!this.status(this.capture(projectId)).compatible)
      throw new AppError(
        'APP_DATA_SCHEMA_MISMATCH',
        '源码与已保存的数据结构不一致，请先在数据结构面板完成迁移或回退。',
      );
  }
  preview(value: unknown): DataMigrationPreview {
    if (this.active) throw new AppError('BUSY', '正在确认数据结构变更，请稍后重试。');
    const input = request(value, ['operation']);
    if (input.operation !== 'migrate' && input.operation !== 'rollback')
      throw new AppError('INVALID_INPUT', '结构变更类型无效。');
    this.pending = null;
    const c = this.capture(input.projectId),
      state = this.status(c);
    if (!c.data || (input.operation === 'migrate' ? !state.canMigrate : !state.canRollback))
      throw unavailable();
    const values =
      input.operation === 'migrate'
        ? migrateSchemaValues(c.data.snapshot.values, c.declaration!)
        : c.data.migration!.beforeSnapshot.values;
    const schema = input.operation === 'migrate' ? c.target : c.data.migration!.beforeSchema;
    const old = c.data.snapshot.values;
    const keys = Object.keys(values),
      oldKeys = Object.keys(old);
    const pending: Pending = {
      id: randomUUID(),
      requestId: randomUUID(),
      projectId: input.projectId,
      operation: input.operation,
      expires: this.now() + 600_000,
      context: c.context,
      fingerprint: c.fingerprint,
      storeId: c.data.storeId,
      expectedRevision: c.data.snapshot.revision,
      expectedHash: c.data.sha256,
      fromSchemaHash: dataSchemaHash(c.data.schema ?? null),
      schema,
      values,
      attempted: false,
      completed: false,
    };
    this.pending = pending;
    return {
      projectId: input.projectId,
      previewId: pending.id,
      operation: pending.operation,
      currentVersion: state.currentVersion,
      targetVersion: schema?.version ?? 0,
      currentRevision: pending.expectedRevision,
      keyCount: keys.length,
      addedKeys: keys.filter((k) => !Object.hasOwn(old, k)),
      removedKeys: oldKeys.filter((k) => !Object.hasOwn(values, k)),
      changedKeys: keys.filter(
        (k) => Object.hasOwn(old, k) && JSON.stringify(old[k]) !== JSON.stringify(values[k]),
      ),
      stepCount: input.operation === 'migrate' ? c.declaration!.migration!.steps.length : 0,
      expiresAt: new Date(pending.expires).toISOString(),
    };
  }
  async confirm(value: unknown): Promise<DataMigrationResult> {
    const input = request(value, ['previewId']);
    const id = parseRevisionId(input.previewId);
    if (this.active) throw new AppError('BUSY', '正在确认数据结构变更，请稍后重试。');
    this.active = true;
    const epoch = this.epoch;
    try {
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
          throw new AppError('DATA_MIGRATION_CANCELLED', '迁移预览已取消或过期，请重新核对。');
        const c = this.capture(input.projectId);
        if (
          c.project.archived ||
          c.context !== pending.context ||
          (!pending.attempted && c.fingerprint !== pending.fingerprint)
        )
          throw stale();
        return pending;
      };
      const selected = check();
      if (!selected.completed) {
        await this.options.closeApplication(input.projectId);
        check();
      }
      selected.attempted = true;
      const base = {
        requestId: selected.requestId,
        storeId: selected.storeId,
        expectedRevision: selected.expectedRevision,
        expectedHash: selected.expectedHash,
        fromSchemaHash: selected.fromSchemaHash,
      };
      const result =
        selected.operation === 'migrate'
          ? this.data.migrate(input.projectId, {
              ...base,
              schema: selected.schema,
              values: selected.values,
            })
          : this.data.rollbackMigration(input.projectId, base);
      selected.completed = true;
      return { projectId: input.projectId, ...result };
    } finally {
      this.active = false;
    }
  }
}
