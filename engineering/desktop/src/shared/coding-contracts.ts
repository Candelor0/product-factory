export interface CodingRequest {
  schemaVersion: 1;
  requestId: string;
  projectId: string;
  planRunId: string;
}
/** Internal workflow input. The standalone generateSource IPC accepts v1 only. */
export interface ModificationCodingRequest {
  schemaVersion: 2;
  requestId: string;
  projectId: string;
  planRunId: string;
  sourceRevision: number;
  sourceHash: string;
  instruction: string;
}
export type CodingExecutionRequest = CodingRequest | ModificationCodingRequest;
export type CodingStatus =
  'running' | 'draft_saved' | 'no_changes' | 'cancelled' | 'failed' | 'limited' | 'interrupted';
/** Metadata only: never persist model messages, tool arguments, or credentials here. */
export interface CodingRun {
  id: string;
  requestHash: string;
  planRunId: string;
  createdAt: string;
  updatedAt: string;
  status: CodingStatus;
  initialRevision: number;
  rounds: number;
  toolCalls: number;
  toolRequests: { callHash: string; requestId: string }[];
  errorCode: string | null;
}
export interface CodingState {
  projectId: string;
  run: CodingRun | null;
  revision: number;
  files: { path: string; sha256: string; bytes: number }[];
  execution: 'disabled';
}
