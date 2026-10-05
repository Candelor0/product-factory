import { createHash } from 'node:crypto';
import type { AppDataSnapshot, AppDataValue } from '../shared/app-data-contracts';
import {
  DATA_SCHEMA_LIMITS,
  type DataSchemaDeclaration,
  type DataSchemaDefinition,
  type DataShape,
  type MigrationStep,
} from '../shared/data-schema-contracts';
import { APP_DATA_LIMITS, validateAppDataSnapshot } from './app-data-protocol';
import { AppError } from './validation';

const invalid = () => new AppError('DATA_SCHEMA_INVALID', '数据结构声明不是允许的格式。');
const limit = () => new AppError('DATA_SCHEMA_LIMIT', '数据结构声明超过大小或复杂度上限。');
const mismatch = () => new AppError('DATA_SCHEMA_MISMATCH', '当前数据不符合声明的数据结构。');
const conflict = () =>
  new AppError('DATA_SCHEMA_MIGRATION_CONFLICT', '数据迁移遇到缺失内容或名称冲突，未修改数据。');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function record(input: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw invalid();
  for (const name of Reflect.ownKeys(input)) {
    if (typeof name !== 'string' || forbidden.has(name) || (fields && !fields.includes(name)))
      throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, name)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  }
  if (fields && fields.some((name) => !Object.hasOwn(input, name))) throw invalid();
  return input as Record<string, unknown>;
}

function array(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw invalid();
  if (input.length > max) throw limit();
  if (Reflect.ownKeys(input).length !== input.length + 1) throw invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    return descriptor.value;
  });
}

function field(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !input.length ||
    Buffer.byteLength(input) > 128 ||
    /[\u0000-\u001f\u007f]/u.test(input) ||
    forbidden.has(input)
  )
    throw invalid();
  return input;
}

function key(input: unknown): string {
  const name = field(input);
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name)) throw invalid();
  return name;
}

function version(input: unknown, minimum = 1): number {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < minimum ||
    (input as number) > DATA_SCHEMA_LIMITS.version
  )
    throw invalid();
  return input as number;
}

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > DATA_SCHEMA_LIMITS.bytes) throw limit();
  return value;
}

function shape(input: unknown, depth: number, budget: { nodes: number }): DataShape {
  if (depth > DATA_SCHEMA_LIMITS.depth || ++budget.nodes > DATA_SCHEMA_LIMITS.nodes) throw limit();
  const raw = record(input);
  if (['string', 'number', 'boolean', 'null'].includes(raw.type as string)) {
    record(raw, ['type']);
    return { type: raw.type as 'string' | 'number' | 'boolean' | 'null' };
  }
  if (raw.type === 'array') {
    record(raw, ['type', 'items']);
    return { type: 'array', items: shape(raw.items, depth + 1, budget) };
  }
  if (raw.type !== 'object') throw invalid();
  record(raw, ['type', 'properties', 'required']);
  const original = record(raw.properties);
  const properties: Record<string, DataShape> = {};
  for (const name of Object.keys(original).sort())
    properties[field(name)] = shape(original[name], depth + 1, budget);
  const required = array(raw.required, DATA_SCHEMA_LIMITS.nodes).map(field).sort();
  if (
    new Set(required).size !== required.length ||
    required.some((name) => !Object.hasOwn(properties, name))
  )
    throw invalid();
  return { type: 'object', properties, required };
}

export function validateDataSchemaDefinition(input: unknown): DataSchemaDefinition {
  const raw = record(input, ['version', 'keys']);
  const original = record(raw.keys);
  if (Object.keys(original).length > APP_DATA_LIMITS.keys) throw limit();
  const keys: Record<string, DataShape> = {};
  const budget = { nodes: 0 };
  for (const name of Object.keys(original).sort())
    keys[key(name)] = shape(original[name], 1, budget);
  return bounded({ version: version(raw.version), keys });
}

function migrationValue(input: unknown): AppDataValue {
  const inspectContainers = (value: unknown, depth: number, budget: { nodes: number }): void => {
    if (depth > APP_DATA_LIMITS.depth || ++budget.nodes > APP_DATA_LIMITS.nodes) throw limit();
    if (!value || typeof value !== 'object') return;
    const children = Array.isArray(value)
      ? array(value, APP_DATA_LIMITS.nodes)
      : Object.values(record(value));
    for (const child of children) inspectContainers(child, depth + 1, budget);
  };
  inspectContainers(input, 1, { nodes: 0 });
  try {
    return validateAppDataSnapshot({ revision: 0, values: { value: input } }).values.value!;
  } catch (cause) {
    throw cause instanceof AppError && cause.code === 'APP_DATA_LIMIT' ? limit() : invalid();
  }
}

function step(input: unknown): MigrationStep {
  const raw = record(input);
  switch (raw.operation) {
    case 'renameKey': {
      record(raw, ['operation', 'from', 'to']);
      const from = key(raw.from),
        to = key(raw.to);
      if (from === to) throw invalid();
      return { operation: 'renameKey', from, to };
    }
    case 'addKey':
      record(raw, ['operation', 'key', 'value']);
      return { operation: 'addKey', key: key(raw.key), value: migrationValue(raw.value) };
    case 'renameField': {
      record(raw, ['operation', 'key', 'from', 'to']);
      const from = field(raw.from),
        to = field(raw.to);
      if (from === to) throw invalid();
      return { operation: 'renameField', key: key(raw.key), from, to };
    }
    case 'addField':
      record(raw, ['operation', 'key', 'field', 'value']);
      return {
        operation: 'addField',
        key: key(raw.key),
        field: field(raw.field),
        value: migrationValue(raw.value),
      };
    default:
      throw invalid();
  }
}

function declaration(input: unknown): DataSchemaDeclaration {
  const raw = record(input);
  const hasMigration = Object.hasOwn(raw, 'migration');
  record(
    raw,
    hasMigration
      ? ['schemaVersion', 'version', 'keys', 'migration']
      : ['schemaVersion', 'version', 'keys'],
  );
  if (raw.schemaVersion !== 1) throw invalid();
  const definition = validateDataSchemaDefinition({ version: raw.version, keys: raw.keys });
  if (!hasMigration) return bounded({ schemaVersion: 1, ...definition });
  const migration = record(raw.migration, ['fromVersion', 'steps']);
  const fromVersion = version(migration.fromVersion, 0);
  if (definition.version !== fromVersion + 1) throw invalid();
  return bounded({
    schemaVersion: 1,
    ...definition,
    migration: { fromVersion, steps: array(migration.steps, DATA_SCHEMA_LIMITS.steps).map(step) },
  });
}

export function readSourceDataSchema(
  files: Array<{ path: string; content: string }>,
): DataSchemaDeclaration | null {
  // Source entries may also include their store-computed hash, but never executable getters.
  const selected = array(files, 128)
    .map((file) => {
      const raw = record(file);
      if (typeof raw.path !== 'string' || typeof raw.content !== 'string') throw invalid();
      return { path: raw.path, content: raw.content };
    })
    .filter((file) => file.path === 'src/data-schema.json');
  if (!selected.length) return null;
  if (selected.length !== 1 || typeof selected[0]!.content !== 'string') throw invalid();
  const content = selected[0]!.content;
  if (Buffer.byteLength(content) > DATA_SCHEMA_LIMITS.bytes) throw limit();
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    throw invalid();
  }
  return declaration(input);
}

export function schemaDefinition(input: DataSchemaDeclaration): DataSchemaDefinition {
  const parsed = declaration(input);
  return { version: parsed.version, keys: parsed.keys };
}

export function dataSchemaHash(schema: DataSchemaDefinition | null): string {
  const parsed = schema === null ? null : validateDataSchemaDefinition(schema);
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
}

function matches(value: AppDataValue, schema: DataShape): boolean {
  switch (schema.type) {
    case 'null':
      return value === null;
    case 'string':
    case 'boolean':
    case 'number':
      return typeof value === schema.type;
    case 'array':
      return Array.isArray(value) && value.every((item) => matches(item, schema.items));
    case 'object':
      return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        schema.required.every((name) => Object.hasOwn(value, name)) &&
        Object.entries(value).every(
          ([name, item]) =>
            Object.hasOwn(schema.properties, name) && matches(item, schema.properties[name]!),
        )
      );
  }
}

export function validateSchemaValues(
  values: AppDataSnapshot['values'],
  schema: DataSchemaDefinition | null,
): void {
  const snapshot = validateAppDataSnapshot({ revision: 0, values });
  if (schema === null) return;
  const definition = validateDataSchemaDefinition(schema);
  if (
    Object.entries(snapshot.values).some(
      ([name, value]) =>
        !Object.hasOwn(definition.keys, name) || !matches(value, definition.keys[name]!),
    )
  )
    throw mismatch();
}

/** Pure all-or-nothing transformation; the caller checks current version/identity and commits once. */
export function migrateSchemaValues(
  values: AppDataSnapshot['values'],
  input: DataSchemaDeclaration,
): AppDataSnapshot['values'] {
  const parsed = declaration(input);
  const result = validateAppDataSnapshot({ revision: 0, values }).values;
  for (const operation of parsed.migration?.steps ?? []) {
    if (operation.operation === 'renameKey') {
      if (!Object.hasOwn(result, operation.from) || Object.hasOwn(result, operation.to))
        throw conflict();
      result[operation.to] = result[operation.from]!;
      delete result[operation.from];
    } else if (operation.operation === 'addKey') {
      if (Object.hasOwn(result, operation.key)) throw conflict();
      result[operation.key] = operation.value;
    } else {
      const rows = result[operation.key];
      if (!Array.isArray(rows)) throw conflict();
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw conflict();
        if (operation.operation === 'renameField') {
          if (!Object.hasOwn(row, operation.from) || Object.hasOwn(row, operation.to))
            throw conflict();
          row[operation.to] = row[operation.from]!;
          delete row[operation.from];
        } else if (!Object.hasOwn(row, operation.field)) row[operation.field] = operation.value;
      }
    }
  }
  validateSchemaValues(result, { version: parsed.version, keys: parsed.keys });
  return validateAppDataSnapshot({ revision: 0, values: result }).values;
}
