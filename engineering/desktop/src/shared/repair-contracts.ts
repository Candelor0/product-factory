import type { BuildDiagnostic, BuildRequest } from './build-contracts';

export type RepairRequest = BuildRequest & { runtimeReportId?: string };
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
