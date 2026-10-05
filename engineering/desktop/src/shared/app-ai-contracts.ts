import type { ProviderId, Usage } from './contracts';
import type { SourceBinding } from './source-contracts';

export interface AppAiConnection {
  id: string;
  provider: ProviderId;
  baseUrl: string;
  model: string;
}
export interface AppAiGrant {
  enabled: boolean;
  purpose: string;
  binding: SourceBinding;
  connection: AppAiConnection;
  maxCalls: number;
  maxTokens: number;
  updatedAt: string;
}
export interface AppAiState {
  projectId: string;
  revision: number;
  status: 'unauthorized' | 'authorized' | 'revoked' | 'stale' | 'limited' | 'unavailable';
  grant: AppAiGrant | null;
  connection: AppAiConnection;
  hasKey: boolean;
  usage: Usage;
  budgetTokens: number;
  receiptCount: number;
}
export interface AppAiGrantRequest {
  schemaVersion: 1;
  projectId: string;
  planRunId: string;
  expectedRevision: number;
  connectionId: string;
  purpose: string;
  maxCalls: number;
  maxTokens: number;
}
export interface AppAiRequest {
  schemaVersion: 1;
  requestId: string;
  text: string;
}
export type AppAiResponse =
  { ok: true; value: { text: string } } | { ok: false; error: { code: string; message: string } };
export interface AppAiSession {
  mode: 'temporary' | 'persistent';
  execute(input: unknown): Promise<AppAiResponse>;
  revoke(): void;
}
