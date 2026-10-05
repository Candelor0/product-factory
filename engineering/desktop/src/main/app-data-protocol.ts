import type {
  AppDataApplyRequest,
  AppDataChange,
  AppDataRequest,
  AppDataSnapshot,
  AppDataValue,
} from '../shared/app-data-contracts';
import { AppError, parseRevisionId } from './validation';

export const APP_DATA_LIMITS = Object.freeze({
  keys: 128,
  changes: 32,
  valueBytes: 128 * 1024,
  snapshotBytes: 1024 * 1024,
  requestBytes: 1024 * 1024 + 64 * 1024,
  depth: 16,
  nodes: 20_000,
  receipts: 256,
  history: 5,
  recordBytes: 8 * 1024 * 1024,
});
const invalid = () => new AppError('APP_DATA_INVALID', '应用数据请求不是允许的 JSON 格式。');
const limit = () => new AppError('APP_DATA_LIMIT', '应用数据达到大小或复杂度上限，本次未写入。');
export const appDataConflict = () =>
  new AppError('APP_DATA_CONFLICT', '应用数据已变化，请重新读取后再保存。');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || forbidden.has(key) || (fields && !fields.includes(key)))
      throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  }
  if (fields && fields.some((field) => !Object.hasOwn(value, field))) throw invalid();
  return value as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
}
function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value) || forbidden.has(value))
    throw invalid();
  return value;
}
function json(value: unknown, depth: number, budget: { nodes: number }): AppDataValue {
  if (depth > APP_DATA_LIMITS.depth || ++budget.nodes > APP_DATA_LIMITS.nodes) throw limit();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > APP_DATA_LIMITS.valueBytes) throw limit();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > APP_DATA_LIMITS.nodes) throw limit();
    if (Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
    return Array.from({ length: value.length }, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item || !item.enumerable || !('value' in item)) throw invalid();
      return json(item.value, depth + 1, budget);
    });
  }
  const original = record(value);
  const result: Record<string, AppDataValue> = {};
  for (const name of Object.keys(original).sort()) {
    if (Buffer.byteLength(name) > APP_DATA_LIMITS.valueBytes) throw limit();
    result[name] = json(original[name], depth + 1, budget);
  }
  return result;
}
function value(input: unknown, budget: { nodes: number }): AppDataValue {
  const parsed = json(input, 1, budget);
  if (Buffer.byteLength(JSON.stringify(parsed)) > APP_DATA_LIMITS.valueBytes) throw limit();
  return parsed;
}
export function validateAppDataSnapshot(input: unknown): AppDataSnapshot {
  const raw = record(input, ['revision', 'values']);
  const original = record(raw.values);
  if (Object.keys(original).length > APP_DATA_LIMITS.keys) throw limit();
  const values: Record<string, AppDataValue> = {};
  const budget = { nodes: 1 };
  for (const name of Object.keys(original).sort())
    values[key(name)] = value(original[name], budget);
  const snapshot = { revision: revision(raw.revision), values };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > APP_DATA_LIMITS.snapshotBytes) throw limit();
  return snapshot;
}
export function validateAppDataApplyRequest(input: unknown): AppDataApplyRequest {
  const raw = record(input, ['requestId', 'expectedRevision', 'changes']);
  let requestId: string;
  try {
    requestId = parseRevisionId(raw.requestId);
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(raw.changes) ||
    raw.changes.length < 1 ||
    raw.changes.length > APP_DATA_LIMITS.changes
  )
    throw limit();
  // Also reject sparse arrays, custom properties and accessors before reading entries.
  if (Reflect.ownKeys(raw.changes).length !== raw.changes.length + 1) throw invalid();
  const seen = new Set<string>();
  const budget = { nodes: 1 };
  const changes: AppDataChange[] = Array.from({ length: raw.changes.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(raw.changes, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    const change = record(descriptor.value);
    if (change.operation !== 'put' && change.operation !== 'remove') throw invalid();
    record(
      change,
      change.operation === 'put' ? ['operation', 'key', 'value'] : ['operation', 'key'],
    );
    const name = key(change.key);
    if (seen.has(name)) throw invalid();
    seen.add(name);
    return change.operation === 'put'
      ? { operation: 'put', key: name, value: value(change.value, budget) }
      : { operation: 'remove', key: name };
  });
  const request = { requestId, expectedRevision: revision(raw.expectedRevision), changes };
  if (Buffer.byteLength(JSON.stringify(request)) > APP_DATA_LIMITS.requestBytes) throw limit();
  return request;
}
export function validateAppDataRequest(input: unknown): AppDataRequest {
  const raw = record(input);
  if (raw.schemaVersion !== 1) throw invalid();
  if (raw.operation === 'read') {
    record(raw, ['schemaVersion', 'operation']);
    return { schemaVersion: 1, operation: 'read' };
  }
  if (raw.operation !== 'apply') throw invalid();
  record(raw, ['schemaVersion', 'operation', 'requestId', 'expectedRevision', 'changes']);
  return {
    schemaVersion: 1,
    operation: 'apply',
    ...validateAppDataApplyRequest({
      requestId: raw.requestId,
      expectedRevision: raw.expectedRevision,
      changes: raw.changes,
    }),
  };
}
/** Pure temporary-session primitive. Callers own their independent receipt window. */
export function applyAppDataSnapshot(
  input: AppDataSnapshot,
  value: AppDataApplyRequest,
): AppDataSnapshot {
  const snapshot = validateAppDataSnapshot(input);
  const request = validateAppDataApplyRequest(value);
  if (snapshot.revision !== request.expectedRevision) throw appDataConflict();
  if (snapshot.revision === Number.MAX_SAFE_INTEGER) throw limit();
  for (const change of request.changes) {
    if (change.operation === 'remove') {
      if (!Object.hasOwn(snapshot.values, change.key)) throw appDataConflict();
      delete snapshot.values[change.key];
    } else snapshot.values[change.key] = change.value;
  }
  return validateAppDataSnapshot({ revision: snapshot.revision + 1, values: snapshot.values });
}
