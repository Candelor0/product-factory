/** Only project business JSON; never host paths, model credentials or execution. */
export type AppDataValue =
  null | boolean | number | string | AppDataValue[] | { [key: string]: AppDataValue };
export interface AppDataSnapshot {
  revision: number;
  values: Record<string, AppDataValue>;
}
export type AppDataChange =
  { operation: 'put'; key: string; value: AppDataValue } | { operation: 'remove'; key: string };
export interface AppDataApplyRequest {
  requestId: string;
  expectedRevision: number;
  changes: AppDataChange[];
}
export interface AppDataApplyResult {
  revision: number;
  appliedRevision: number;
  replayed: boolean;
}
export type AppDataRequest =
  | { schemaVersion: 1; operation: 'read' }
  | ({ schemaVersion: 1; operation: 'apply' } & AppDataApplyRequest);
export type AppDataResponse =
  | { ok: true; value: AppDataSnapshot | AppDataApplyResult }
  | { ok: false; error: { code: string; message: string } };
export interface AppDataSession {
  readonly mode: 'temporary' | 'persistent';
  execute(input: unknown): AppDataResponse;
  revoke(): void;
}
export interface ApplicationState {
  projectId: string;
  status: 'running' | 'stopped';
  buildId: string | null;
}
