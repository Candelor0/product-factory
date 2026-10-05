export interface BuildDiagnostic {
  path: string | null;
  line: number | null;
  message: string;
}
export interface BuildAttempt {
  id: string;
  planRunId: string;
  planInputHash: string;
  planArtifactHash: string;
  sourceRevision: number;
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  diagnostics: BuildDiagnostic[];
  errorCode: string | null;
}
export interface CompiledSource {
  javascript: string;
  css: string;
  warnings: BuildDiagnostic[];
}
export interface BuildArtifact extends CompiledSource {
  schemaVersion: 1;
  id: string;
  projectId: string;
  createdAt: string;
  sourceRevision: number;
  sourceHash: string;
  planRunId: string;
  planInputHash: string;
  planArtifactHash: string;
  templateVersion: 'react-preview-v1';
  compilerVersion: string;
  artifactHash: string;
}
export type BuildSummary = Omit<BuildArtifact, 'javascript' | 'css'>;
export interface BuildState {
  projectId: string;
  status: 'empty' | 'current' | 'stale';
  artifact: BuildSummary | null;
  preview: 'open' | 'closed';
  previewBuildId: string | null;
}
export interface BuildRequest {
  schemaVersion: 1;
  requestId: string;
  projectId: string;
  planRunId: string;
  sourceRevision: number;
}
export interface BuildResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  state: BuildState;
  diagnostics: BuildDiagnostic[];
}
