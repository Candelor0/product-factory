import type { SourceBinding } from './source-contracts';

interface WorkflowRequestBase {
  requestId: string;
  projectId: string;
  planRunId: string;
  sourceRevision: number;
}
export type WorkflowRequest = WorkflowRequestBase &
  (
    | { schemaVersion: 1; mode: 'generate' | 'check' }
    | { schemaVersion: 2; mode: 'modify'; instruction: string }
  );
export type WorkflowStageKind = 'generation' | 'build' | 'startup' | 'repair';
export type WorkflowStageStatus =
  'running' | 'succeeded' | 'no_changes' | 'failed' | 'cancelled' | 'limited' | 'interrupted';
export interface WorkflowStage {
  kind: WorkflowStageKind;
  /** Present only for new modification repairs; absent legacy stages keep their v1 hash. */
  repairRequestVersion?: 2;
  requestId: string;
  status: WorkflowStageStatus;
  createdAt: string;
  updatedAt: string;
  sourceRevision: number;
  sourceHash: string;
  buildId: string | null;
  runtimeReportId: string | null;
  errorCode: string | null;
}
/** Execution metadata and, in v2, the user's explicit bounded modification request.
 * Full model conversations, source bodies, application values and credentials are excluded. */
export interface WorkflowRun {
  id: string;
  request: WorkflowRequest;
  binding: SourceBinding;
  initialSourceHash: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'ready' | 'stopped' | 'cancelled' | 'limited' | 'interrupted';
  stages: WorkflowStage[];
  latestRevision: number;
  latestSourceHash: string;
  buildId: string | null;
  runtimeReportId: string | null;
  errorCode: string | null;
}
export interface WorkflowState {
  projectId: string;
  run: WorkflowRun | null;
  current: boolean;
  sourceRevision: number;
  fileCount: number;
  rounds: number;
  toolCalls: number;
  builds: number;
  history: {
    id: string;
    createdAt: string;
    status: WorkflowRun['status'];
    mode: WorkflowRequest['mode'];
    sourceRevision: number;
    latestRevision: number;
    instruction: string | null;
  }[];
  changes: {
    status: 'available' | 'unavailable';
    baseRevision: number;
    resultRevision: number;
    files: { path: string; kind: 'added' | 'modified' | 'deleted' }[];
  } | null;
}
