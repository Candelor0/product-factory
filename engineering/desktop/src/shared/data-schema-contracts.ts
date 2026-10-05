import type { AppDataValue } from './app-data-contracts';

export type DataShape =
  | { type: 'string' | 'number' | 'boolean' | 'null' }
  | { type: 'array'; items: DataShape }
  | { type: 'object'; properties: Record<string, DataShape>; required: string[] };

/** Declared keys are optional; undeclared keys and object properties are rejected. */
export interface DataSchemaDefinition {
  version: number;
  keys: Record<string, DataShape>;
}

export type MigrationStep =
  | { operation: 'renameKey'; from: string; to: string }
  | { operation: 'addKey'; key: string; value: AppDataValue }
  | { operation: 'renameField'; key: string; from: string; to: string }
  | { operation: 'addField'; key: string; field: string; value: AppDataValue };

export interface DataSchemaDeclaration extends DataSchemaDefinition {
  schemaVersion: 1;
  migration?: { fromVersion: number; steps: MigrationStep[] };
}

export const DATA_SCHEMA_LIMITS = Object.freeze({
  bytes: 64 * 1024,
  depth: 8,
  nodes: 256,
  version: 1000,
  steps: 64,
});
