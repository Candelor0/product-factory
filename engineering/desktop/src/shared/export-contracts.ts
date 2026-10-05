export interface ExportRequest {
  schemaVersion: 1;
  projectId: string;
  planRunId: string;
  sourceRevision: number;
}

export type ExportResult =
  | {
      status: 'exported';
      fileName: string;
      filePath: string;
      sha256: string;
      fileCount: number;
      bytes: number;
      sourceRevision: number;
    }
  | { status: 'cancelled' };
