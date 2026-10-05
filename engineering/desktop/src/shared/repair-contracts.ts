import type { BuildDiagnostic, BuildRequest } from './build-contracts';

export type RepairRequest = BuildRequest & { runtimeReportId?: string };
/** Internal workflow request only. The child journal persists its hash, never this text. */
export type ModificationRepairRequest = Omit<RepairRequest, 'schemaVersion'> & {
  schemaVersion: 2;
  modification: {
    workflowId: string;
    sourceRevision: number;
    sourceHash: string;
    instruction: string;
  };
};
export type RepairExecutionRequest = RepairRequest | ModificationRepairRequest;
export type RepairStatus =
  'running' | 'succeeded' | 'limited' | 'no_progress' | 'cancelled' | 'failed' | 'interrupted';
/** Metadata and fixed compiler diagnostics only; never raw model messages or credentials. */
export interface RepairRun {
  id: string;
  requestHash: string;
  planRunId: string;
  planInputHash: string;
  planArtifactHash: string;
  createdAt: string;
  updatedAt: string;
  status: RepairStatus;
  phase: 'checking' | 'repairing' | 'runtime_checking';
  /** Absent on legacy compiler-only repairs. */
  runtimeReportId?: string;
  runtimeResultId?: string;
  initialRevision: number;
  latestRevision: number;
  rounds: number;
  toolCalls: number;
  toolRequests: { callHash: string; requestId: string }[];
  builds: number;
  buildId: string | null;
  diagnostics: BuildDiagnostic[];
  errorCode: string | null;
}
export interface RepairState {
  projectId: string;
  run: RepairRun | null;
}
