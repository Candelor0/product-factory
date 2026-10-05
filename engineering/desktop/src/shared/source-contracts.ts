/** Transport-safe source tools. No host paths, credentials, or executable commands. */
import type { DesignContent, RequirementContent } from './contracts';
import type { DevelopmentPlan } from './plan-contracts';

export interface SourceBinding {
  planRunId: string;
  planInputHash: string;
  planArtifactHash: string;
}
export interface SourceFile {
  path: string;
  content: string;
  sha256: string;
}
export interface SourceSnapshot {
  revision: number;
  files: SourceFile[];
}
export type SourceChange =
  | { operation: 'write'; path: string; expectedHash: string | null; content: string }
  | { operation: 'delete'; path: string; expectedHash: string };
export interface SourceApplyInput {
  requestId: string;
  binding: SourceBinding;
  expectedRevision: number;
  changes: SourceChange[];
}
export interface SourceApplyResult {
  revision: number;
  previousRevision: number;
  changedPaths: string[];
  replayed: boolean;
}
/** Trusted user action. This is deliberately absent from the model tool protocol. */
export interface SourceRestoreInput {
  requestId: string;
  binding: SourceBinding;
  expectedRevision: number;
  targetRevision: number;
}
export interface SourceCheckpoint {
  revision: number;
  createdAt: string | null;
  binding: SourceBinding | null;
  changedPaths: string[];
  files: { path: string; sha256: string; bytes: number }[];
  restoredFrom: number | null;
  requestId: string | null;
  snapshotHash: string;
}
export type SourceToolRequest = {
  schemaVersion: 1;
  requestId: string;
} & (
  | { tool: 'list_files'; arguments: Record<string, never> }
  | { tool: 'read_file'; arguments: { path: string } }
  | {
      tool: 'apply_changes';
      arguments: { expectedRevision: number; changes: SourceChange[] };
    }
);
export type SourceToolData =
  | {
      tool: 'list_files';
      revision: number;
      files: { path: string; sha256: string; bytes: number }[];
    }
  | { tool: 'read_file'; revision: number; file: SourceFile }
  | ({ tool: 'apply_changes' } & SourceApplyResult);
export type SourceToolResponse =
  | { schemaVersion: 1; requestId: string; ok: true; data: SourceToolData }
  | {
      schemaVersion: 1;
      requestId: string | null;
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
/** Chosen by the trusted coordinator, never parsed from model arguments. */
export interface SourceToolContext {
  projectId: string;
  planRunId: string;
}

/** Complete confirmed input, not just the flattened task list. Not a model-generated analysis. */
export interface CodingInput {
  schemaVersion: 1;
  binding: SourceBinding;
  requirements: { id: string; hash: string; content: RequirementContent };
  design: { id: string; hash: string; content: DesignContent };
  plan: DevelopmentPlan;
  sourceRevision: number;
  capabilities: readonly ['list_files', 'read_file', 'apply_changes'];
  execution: 'disabled';
}
