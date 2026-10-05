import type { SourceCheckpoint } from './source-contracts';

export interface RecoveryCheckpoint extends SourceCheckpoint {
  buildId: string | null;
  canRestore: boolean;
}
export interface RecoveryRun {
  id: string;
  kind: 'coding' | 'repair' | 'build';
  status: string;
  phase: 'model' | 'tools' | 'build' | 'runtime' | 'saved';
  rounds: number;
  committedRevisions: number[];
  unconfirmedTools: number;
  buildId: string | null;
}
export interface RecoveryState {
  projectId: string;
  revision: number;
  planRunId: string | null;
  blockedReason: string | null;
  checkpoints: RecoveryCheckpoint[];
  runs: RecoveryRun[];
}
export interface RestoreCheckpointRequest {
  schemaVersion: 1;
  requestId: string;
  projectId: string;
  planRunId: string;
  sourceRevision: number;
  targetRevision: number;
}
export interface RestoreCheckpointResult {
  revision: number;
  previousRevision: number;
  changedPaths: string[];
  replayed: boolean;
}
