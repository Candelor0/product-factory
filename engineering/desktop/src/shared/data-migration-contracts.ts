export type DataMigrationOperation = 'migrate' | 'rollback';
export interface DataMigrationRequest {
  schemaVersion: 1;
  projectId: string;
}
export interface DataMigrationState {
  projectId: string;
  initialized: boolean;
  revision: number | null;
  currentVersion: number;
  targetVersion: number;
  compatible: boolean;
  canMigrate: boolean;
  canRollback: boolean;
  message: string;
}
export interface DataMigrationPreviewRequest extends DataMigrationRequest {
  operation: DataMigrationOperation;
}
export interface DataMigrationPreview {
  projectId: string;
  previewId: string;
  operation: DataMigrationOperation;
  currentVersion: number;
  targetVersion: number;
  currentRevision: number;
  keyCount: number;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  stepCount: number;
  expiresAt: string;
}
export interface DataMigrationConfirmRequest extends DataMigrationRequest {
  previewId: string;
}
export interface DataMigrationResult {
  projectId: string;
  revision: number;
  appliedRevision: number;
  replayed: boolean;
}
