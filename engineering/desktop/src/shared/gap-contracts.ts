import type { SourceBinding } from './source-contracts';
import type { PlanTask } from './plan-contracts';
import type { BuildSummary } from './build-contracts';
import type { RuntimeReport } from './runtime-contracts';

export interface GapBinding extends SourceBinding {
  sourceRevision: number;
  sourceHash: string;
  buildId: string | null;
  artifactHash: string | null;
}
export interface GapEvidenceRequest {
  schemaVersion: 1;
  requestId: string;
  projectId: string;
  binding: GapBinding;
  taskId: string;
  verdict: 'passed' | 'failed' | 'missing';
  filePaths: string[];
  steps: string;
  expected: string;
  actual: string;
}
export interface GapEvidence {
  id: string;
  createdAt: string;
  origin: 'user';
  request: GapEvidenceRequest;
}
export interface GapRow {
  id: string;
  title: string;
  kind: PlanTask['kind'];
  source: string;
  implementation: 'unlinked' | 'linked' | 'missing';
  verification: 'not_run' | 'passed' | 'failed' | 'stale';
  files: { path: string; sha256: string }[];
  missingPaths: string[];
  record: GapEvidence | null;
}
export interface GapReport {
  schemaVersion: 1;
  projectId: string;
  status: 'empty' | 'current' | 'stale';
  writable: boolean;
  binding: GapBinding | null;
  mapping: 'absent' | 'valid' | 'invalid';
  mappingNotes: string[];
  rows: GapRow[];
  sourceFiles: string[];
  build: BuildSummary | null;
  runtime: RuntimeReport | null;
  runtimeCurrent: boolean;
  historyCount: number;
}
