export interface ModelToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ModelAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ModelToolCall[];
}
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | ModelAssistantMessage
  | { role: 'tool'; content: string; tool_call_id: string };
export interface ModelToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ModelToolTurn {
  message: ModelAssistantMessage;
  finishReason: 'stop' | 'tool_calls';
}
