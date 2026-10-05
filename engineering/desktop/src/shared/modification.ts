import type { CodingExecutionRequest } from './coding-contracts';
import type { RepairExecutionRequest } from './repair-contracts';
import type { WorkflowRun } from './workflow-contracts';

export const MODIFICATION_LIMITS = Object.freeze({ characters: 2000, bytes: 8000 });

/** Shared exact child payload: legacy property order is preserved for durable request hashes. */
export function workflowCodingRequest(run: WorkflowRun, requestId: string): CodingExecutionRequest {
  const base = {
    schemaVersion: 1 as const,
    requestId,
    projectId: run.request.projectId,
    planRunId: run.binding.planRunId,
  };
  return run.request.mode === 'modify'
    ? {
        ...base,
        schemaVersion: 2,
        sourceRevision: run.request.sourceRevision,
        sourceHash: run.initialSourceHash,
        instruction: run.request.instruction,
      }
    : base;
}

/** The persisted stage marker distinguishes legacy repairs from intent-aware repairs. */
export function workflowRepairRequest(
  run: WorkflowRun,
  requestId: string,
  sourceRevision: number,
  runtimeReportId?: string,
): RepairExecutionRequest {
  const base = {
    schemaVersion: 1 as const,
    requestId,
    projectId: run.request.projectId,
    planRunId: run.binding.planRunId,
    sourceRevision,
    ...(runtimeReportId ? { runtimeReportId } : {}),
  };
  return run.request.mode === 'modify' &&
    run.stages.find((stage) => stage.requestId === requestId)?.repairRequestVersion === 2
    ? {
        ...base,
        schemaVersion: 2,
        modification: {
          workflowId: run.id,
          sourceRevision: run.request.sourceRevision,
          sourceHash: run.initialSourceHash,
          instruction: run.request.instruction,
        },
      }
    : base;
}
