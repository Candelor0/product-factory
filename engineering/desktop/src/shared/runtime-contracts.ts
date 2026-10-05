import type { SourceBinding } from './source-contracts';

export const runtimeIssueMessages = {
  REFERENCE_ERROR: '页面引用了无法找到的变量，请检查源码中的名称与初始化顺序。',
  TYPE_ERROR: '页面运行时发生类型错误，请检查对象、函数和数据是否有效。',
  RANGE_ERROR: '页面运行时超出有效范围，请检查递归或数据范围。',
  SYNTAX_ERROR: '页面执行时发生语法错误，请检查动态解析等运行路径。',
  SCRIPT_ERROR: '页面执行遇到未处理的脚本错误。',
  UNHANDLED_REJECTION: '页面有未处理的异步操作失败。',
  REACT_RENDER_ERROR: '页面组件渲染失败，请检查组件初始化和渲染逻辑。',
  CONSOLE_ERROR: '页面报告了运行错误，请检查相关初始化与交互逻辑。',
  RESOURCE_LOAD_FAILED: '页面的受控资源未能加载。',
  RENDERER_GONE: '页面运行进程意外退出。',
  UNRESPONSIVE: '页面未响应，已停止此次检查。',
  STARTUP_TIMEOUT: '页面启动未在规定时间内完成。',
} as const;
export type RuntimeIssueCode = keyof typeof runtimeIssueMessages;
export interface RuntimeProbeResult {
  status: 'observed' | 'issues' | 'cancelled';
  issues: RuntimeIssueCode[];
  observedMs: number;
}
export interface RuntimeReport extends SourceBinding {
  id: string;
  buildId: string;
  artifactHash: string;
  sourceRevision: number;
  sourceHash: string;
  mode: 'preview' | 'check' | 'application';
  createdAt: string;
  updatedAt: string;
  status: 'observing' | 'observed' | 'issues' | 'cancelled' | 'interrupted';
  observedMs: number;
  issues: RuntimeIssueCode[];
}
export interface RuntimeState {
  projectId: string;
  report: RuntimeReport | null;
  current: boolean;
}
export interface RuntimeCheckRequest {
  schemaVersion: 1;
  requestId: string;
  projectId: string;
  buildId: string;
}
