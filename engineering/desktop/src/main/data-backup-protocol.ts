import type { DataSchemaDefinition } from '../shared/data-schema-contracts';
import {
  dataSchemaHash,
  validateDataSchemaDefinition,
  validateSchemaValues,
} from './data-schema-protocol';
import type { AppDataSnapshot } from '../shared/app-data-contracts';
import { APP_DATA_LIMITS, validateAppDataSnapshot } from './app-data-protocol';
import { sourceHash } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseProjectName,
  parseRevisionId,
} from './validation';

export const DATA_BACKUP_MAX_BYTES = APP_DATA_LIMITS.snapshotBytes + 128 * 1024;
export interface DataBackup {
  schemaVersion: 1 | 2;
  format: 'product-factory-app-data-v1' | 'product-factory-app-data-v2';
  dataSchema?: DataSchemaDefinition | null;
  dataSchemaHash?: string;
  exportedAt: string;
  productFactoryVersion: string;
  project: { id: string; name: string };
  storeId: string;
  sourceContentHash: string;
  snapshot: AppDataSnapshot;
  snapshotHash: string;
  integrity: string;
}
const invalid = () =>
  new AppError('DATA_BACKUP_INVALID', '备份格式或完整性不正确，当前数据未修改。');
function hash(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) throw invalid();
  return input;
}
export function encodeDataBackup(
  input: Omit<
    DataBackup,
    'schemaVersion' | 'format' | 'integrity' | 'snapshotHash' | 'dataSchemaHash'
  >,
): Buffer {
  const snapshot = validateAppDataSnapshot(input.snapshot);
  const schema = input.dataSchema == null ? null : validateDataSchemaDefinition(input.dataSchema);
  validateSchemaValues(snapshot.values, schema);
  const payload = {
    schemaVersion: 2 as const,
    format: 'product-factory-app-data-v2' as const,
    exportedAt: input.exportedAt,
    productFactoryVersion: input.productFactoryVersion,
    project: { id: input.project.id, name: input.project.name },
    storeId: input.storeId,
    sourceContentHash: input.sourceContentHash,
    snapshot,
    snapshotHash: sourceHash(JSON.stringify(snapshot)),
    dataSchema: schema,
    dataSchemaHash: dataSchemaHash(schema),
  };
  const result = { ...payload, integrity: sourceHash(JSON.stringify(payload)) };
  const bytes = Buffer.from(JSON.stringify(result) + '\n');
  // The same parser validates trusted export construction and untrusted imported files.
  decodeDataBackup(bytes);
  return bytes;
}
export function decodeDataBackup(bytes: Buffer): DataBackup {
  if (bytes.length > DATA_BACKUP_MAX_BYTES)
    throw new AppError('DATA_BACKUP_LIMIT', '备份文件超过允许的大小。');
  try {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw invalid();
    const raw: unknown = JSON.parse(text);
    assertRecord(raw);
    if (!(
      (raw.schemaVersion === 1 && raw.format === 'product-factory-app-data-v1') ||
      (raw.schemaVersion === 2 && raw.format === 'product-factory-app-data-v2')
    ))
      throw new AppError('DATA_BACKUP_UNSUPPORTED', '这个备份版本或类型尚不支持。');
    assertFields(raw, [
      'schemaVersion',
      'format',
      'exportedAt',
      'productFactoryVersion',
      'project',
      'storeId',
      'sourceContentHash',
      'snapshot',
      'snapshotHash',
      'integrity',
      ...(raw.schemaVersion === 2 ? ['dataSchema', 'dataSchemaHash'] : []),
    ]);
    assertRecord(raw.project);
    assertFields(raw.project, ['id', 'name']);
    if (
      typeof raw.exportedAt !== 'string' ||
      !Number.isFinite(Date.parse(raw.exportedAt)) ||
      new Date(raw.exportedAt).toISOString() !== raw.exportedAt ||
      typeof raw.productFactoryVersion !== 'string' ||
      raw.productFactoryVersion.length > 64 ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(raw.productFactoryVersion)
    )
      throw invalid();
    const snapshot = validateAppDataSnapshot(raw.snapshot);
    if (snapshot.revision === 0 && Object.keys(snapshot.values).length) throw invalid();
    const payload = {
      schemaVersion: raw.schemaVersion as 1 | 2,
      format: raw.format as DataBackup['format'],
      exportedAt: raw.exportedAt,
      productFactoryVersion: raw.productFactoryVersion,
      project: { id: parseProjectId(raw.project.id), name: parseProjectName(raw.project.name) },
      storeId: parseRevisionId(raw.storeId),
      sourceContentHash: hash(raw.sourceContentHash),
      snapshot,
      snapshotHash: hash(raw.snapshotHash),
      ...(raw.schemaVersion === 2
        ? {
            dataSchema:
              raw.dataSchema === null ? null : validateDataSchemaDefinition(raw.dataSchema),
            dataSchemaHash: hash(raw.dataSchemaHash),
          }
        : {}),
    };
    if (
      payload.snapshotHash !== sourceHash(JSON.stringify(snapshot)) ||
      hash(raw.integrity) !== sourceHash(JSON.stringify(payload))
    )
      throw invalid();
    if (
      raw.schemaVersion === 2 &&
      payload.dataSchemaHash !== dataSchemaHash(payload.dataSchema ?? null)
    )
      throw invalid();
    validateSchemaValues(snapshot.values, payload.dataSchema ?? null);
    return { ...payload, integrity: raw.integrity as string };
  } catch (error) {
    if (error instanceof AppError && error.code === 'DATA_BACKUP_UNSUPPORTED') throw error;
    throw invalid();
  }
}
