import type { PlanRequest, PlanState } from './plan-contracts';
export type Stage = 'idea' | 'requirements' | 'design' | 'ready';
export type ProviderId = 'deepseek' | 'custom';
export interface RequirementContent {
  summary: string;
  audience: string;
  features: string[];
  pages: string[];
  data: string[];
  outOfScope: string[];
  questions: string[];
  acceptance: string[];
}
export interface DesignContent {
  direction: string;
  palette: string[];
  pages: { name: string; sections: string[] }[];
  notes: string[];
}
export interface Revision<T> {
  id: string;
  version: number;
  content: T;
  hash: string;
  createdAt: string;
  approvedAt: string | null;
  basedOn?: string;
}
export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  idea: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  stage: Stage;
  requirements: Revision<RequirementContent>[];
  designs: Revision<DesignContent>[];
  activity: { id: string; at: string; message: string }[];
}
export interface ProviderSettings {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  storage: 'encrypted' | 'session' | 'none';
  lastCheckedAt: string | null;
  maxCalls: number;
  maxTokens: number | null;
  budgetTokens: number;
  legacyUnknownUsageCalls: number;
  connectionId: string;
}
export interface ProviderInput {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxCalls: number;
  maxTokens?: number | null;
}
export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  unknownUsageCalls: number;
}
export interface EnvironmentInfo {
  platform: string;
  arch: string;
  version: string;
  dataPath: string;
  secureStorage: boolean;
  mode: 'desktop' | 'browser-preview';
}
export interface AppSnapshot {
  projects: Project[];
  settings: ProviderSettings;
  usage: Usage;
  environment: EnvironmentInfo;
}
export type ApiResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface BlogRuntimeStatus {
  projectId: string;
  status: 'running' | 'stopped';
  startedAt: string | null;
  templateId: 'blog-sample-v1';
}
export interface FactoryApi {
  dataMigrationState(
    input: import('./data-migration-contracts').DataMigrationRequest,
  ): Promise<ApiResult<import('./data-migration-contracts').DataMigrationState>>;
  previewDataMigration(
    input: import('./data-migration-contracts').DataMigrationPreviewRequest,
  ): Promise<ApiResult<import('./data-migration-contracts').DataMigrationPreview>>;
  confirmDataMigration(
    input: import('./data-migration-contracts').DataMigrationConfirmRequest,
  ): Promise<ApiResult<import('./data-migration-contracts').DataMigrationResult>>;
  discardDataMigration(
    input: import('./data-migration-contracts').DataMigrationConfirmRequest,
  ): Promise<ApiResult<void>>;
  dataBackupState(
    input: import('./data-backup-contracts').DataBackupRequest,
  ): Promise<ApiResult<import('./data-backup-contracts').DataBackupState>>;
  exportAppData(
    input: import('./data-backup-contracts').DataBackupRequest & { expectedRevision: number },
  ): Promise<ApiResult<import('./data-backup-contracts').DataExportResult>>;
  previewDataRestore(
    input: import('./data-backup-contracts').DataBackupRequest,
  ): Promise<ApiResult<import('./data-backup-contracts').DataRestorePreviewResult>>;
  confirmDataRestore(
    input: import('./data-backup-contracts').DataRestoreConfirmRequest,
  ): Promise<ApiResult<import('./data-backup-contracts').DataRestoreResult>>;
  discardDataRestore(
    input: import('./data-backup-contracts').DataRestoreConfirmRequest,
  ): Promise<ApiResult<void>>;
  appAiState(input: {
    projectId: string;
  }): Promise<ApiResult<import('./app-ai-contracts').AppAiState>>;
  grantAppAi(
    input: import('./app-ai-contracts').AppAiGrantRequest,
  ): Promise<ApiResult<import('./app-ai-contracts').AppAiState>>;
  revokeAppAi(input: {
    projectId: string;
  }): Promise<ApiResult<import('./app-ai-contracts').AppAiState>>;
  exportSource(
    input: import('./export-contracts').ExportRequest,
  ): Promise<ApiResult<import('./export-contracts').ExportResult>>;
  applicationState(input: {
    projectId: string;
  }): Promise<ApiResult<import('./app-data-contracts').ApplicationState>>;
  openApplication(input: {
    projectId: string;
    buildId: string;
  }): Promise<ApiResult<import('./app-data-contracts').ApplicationState>>;
  closeApplication(input: {
    projectId: string;
  }): Promise<ApiResult<import('./app-data-contracts').ApplicationState>>;
  runtimeState(input: {
    projectId: string;
  }): Promise<ApiResult<import('./runtime-contracts').RuntimeState>>;
  checkRuntime(
    input: import('./runtime-contracts').RuntimeCheckRequest,
  ): Promise<ApiResult<import('./runtime-contracts').RuntimeReport>>;
  recoveryState(input: {
    projectId: string;
  }): Promise<ApiResult<import('./recovery-contracts').RecoveryState>>;
  restoreCheckpoint(
    input: import('./recovery-contracts').RestoreCheckpointRequest,
  ): Promise<ApiResult<import('./recovery-contracts').RestoreCheckpointResult>>;
  repairState(input: {
    projectId: string;
  }): Promise<ApiResult<import('./repair-contracts').RepairState>>;
  repairSource(
    input: import('./repair-contracts').RepairRequest,
  ): Promise<ApiResult<import('./repair-contracts').RepairState>>;
  buildState(input: {
    projectId: string;
  }): Promise<ApiResult<import('./build-contracts').BuildState>>;
  buildSource(
    input: import('./build-contracts').BuildRequest,
  ): Promise<ApiResult<import('./build-contracts').BuildResult>>;
  openPreview(input: {
    projectId: string;
    buildId: string;
  }): Promise<ApiResult<import('./build-contracts').BuildState>>;
  closePreview(input: {
    projectId: string;
  }): Promise<ApiResult<import('./build-contracts').BuildState>>;
  codingState(input: {
    projectId: string;
  }): Promise<ApiResult<import('./coding-contracts').CodingState>>;
  codingFile(input: {
    projectId: string;
    path: string;
  }): Promise<ApiResult<import('./source-contracts').SourceFile>>;
  generateSource(
    input: import('./coding-contracts').CodingRequest,
  ): Promise<ApiResult<import('./coding-contracts').CodingState>>;
  planState(input: { projectId: string }): Promise<ApiResult<PlanState>>;
  createPlan(input: PlanRequest): Promise<ApiResult<PlanState>>;
  blogStatus(input: { projectId: string }): Promise<ApiResult<BlogRuntimeStatus>>;
  startBlog(input: { projectId: string }): Promise<ApiResult<BlogRuntimeStatus>>;
  stopBlog(input: { projectId: string }): Promise<ApiResult<BlogRuntimeStatus>>;
  snapshot(): Promise<ApiResult<AppSnapshot>>;
  createProject(input: { name: string; idea: string }): Promise<ApiResult<Project>>;
  renameProject(input: { projectId: string; name: string }): Promise<ApiResult<Project>>;
  archiveProject(input: { projectId: string; archived: boolean }): Promise<ApiResult<Project>>;
  saveRequirements(input: {
    projectId: string;
    content: RequirementContent;
  }): Promise<ApiResult<Project>>;
  approveRequirements(input: {
    projectId: string;
    revisionId: string;
  }): Promise<ApiResult<Project>>;
  generateRequirements(input: {
    projectId: string;
    instruction: string;
  }): Promise<ApiResult<Project>>;
  generateDesign(input: { projectId: string; instruction: string }): Promise<ApiResult<Project>>;
  approveDesign(input: { projectId: string; revisionId: string }): Promise<ApiResult<Project>>;
  saveProvider(input: ProviderInput): Promise<ApiResult<ProviderSettings>>;
  checkProvider(): Promise<ApiResult<{ message: string }>>;
  deleteProviderKey(): Promise<ApiResult<ProviderSettings>>;
  cancelGeneration(): Promise<ApiResult<void>>;
  openDataFolder(): Promise<ApiResult<void>>;
}
declare global {
  interface Window {
    factory: FactoryApi;
  }
}
