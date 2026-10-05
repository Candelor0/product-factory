export interface DataBackupRequest {
  schemaVersion: 1;
  projectId: string;
}
export interface DataBackupState {
  projectId: string;
  initialized: boolean;
  revision: number | null;
  keyCount: number;
  bytes: number;
}
export type DataExportResult =
  | { status: 'cancelled' }
  | {
      status: 'exported';
      fileName: string;
      filePath: string;
      sha256: string;
      bytes: number;
      dataRevision: number;
    };
export interface DataRestorePreview {
  status: 'preview';
  previewId: string;
  projectId: string;
  fileName: string;
  exportedAt: string;
  backupRevision: number;
  currentRevision: number;
  backupKeyCount: number;
  currentKeyCount: number;
  backupBytes: number;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  unchangedKeys: number;
}
export type DataRestorePreviewResult = { status: 'cancelled' } | DataRestorePreview;
export interface DataRestoreConfirmRequest extends DataBackupRequest {
  previewId: string;
}
export interface DataRestoreResult {
  status: 'restored';
  revision: number;
  appliedRevision: number;
  replayed: boolean;
}
