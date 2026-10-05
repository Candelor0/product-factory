export type PlanProfile = 'web' | 'agent';
export interface PlanRequest {
  schemaVersion: 1;
  requestId: string;
  projectId: string;
  requirementId: string;
  designId: string;
  profile: PlanProfile;
}
export interface PlanTask {
  id: string;
  kind: 'page' | 'feature' | 'data' | 'acceptance';
  title: string;
  source: string;
  dependsOn: string[];
  implementation: 'pending';
  verification: 'not_run';
}
export interface DevelopmentPlan {
  summary: string;
  profile: PlanProfile;
  tasks: PlanTask[];
  openQuestions: string[];
  reviewNotes: string[];
  components: {
    id: string;
    name: string;
    decision: string;
    reason: string;
    feature: string;
  }[];
  checks: { id: string; title: string; source: 'product-factory'; status: 'not_run' }[];
}
export interface PlanRun {
  schemaVersion: 1;
  id: string;
  request: PlanRequest;
  createdAt: string;
  inputHash: string;
  artifactHash: string;
  adapterVersion: 'blueprint-rules-v1';
  sourceRevision: string;
  state: 'succeeded';
  events: { sequence: number; type: 'stage.completed'; stage: 'binding' | 'rules' | 'tasks' }[];
  plan: DevelopmentPlan;
}
export interface PlanState {
  status: 'empty' | 'current' | 'stale';
  run: PlanRun | null;
  history: { id: string; createdAt: string; profile: PlanProfile }[];
}
