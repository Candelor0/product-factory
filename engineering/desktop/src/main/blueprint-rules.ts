/**
 * SPDX-License-Identifier: MIT
 * Deterministic rules adapted from hubooooooo/agent-blueprint.
 * Source: 776c0fc778f57eb38a63de3a39014bfcf60a43b8, blueprint/rules.py
 * and blueprint/knowledge/__init__.py. See licenses/agent-blueprint.txt.
 * The LLM, scanner, Python pipeline and prompts are not included.
 */
import { AppError, assertFields, assertRecord, parseText } from './validation.js';

export const BLUEPRINT_SOURCE = Object.freeze({
  repository: 'https://github.com/hubooooooo/agent-blueprint',
  revision: '776c0fc778f57eb38a63de3a39014bfcf60a43b8',
  files: Object.freeze(['blueprint/rules.py', 'blueprint/knowledge/__init__.py'] as const),
  scope: 'rules.py select_components and component/feature metadata only',
  license: 'MIT',
} as const);

const components = [
  {
    id: 's01',
    name: 'Agent Loop',
    domain: '行动域',
    one_liner: '最小可运行闭环',
    when: '一切基础：循环 + 工具',
    production_points: '重试、超时、token 上限、stop_reason 完整处理',
    readme: 's01_agent_loop/README.md',
    signals: [
      'tool_use',
      'tool_calls',
      'messages\\.create',
      'chat\\.completions',
      'function_call',
      'agent_loop',
      'while\\s+True',
    ],
    always: true,
  },
  {
    id: 's02',
    name: '工具系统',
    domain: '行动域',
    one_liner: '循环不变，工具可增',
    when: '需要调用外部系统/API/数据源',
    production_points: 'JSON schema 严格、参数校验、错误回传格式统一',
    readme: 's02_tool_use/README.md',
    signals: [
      'input_schema',
      'TOOL_HANDLERS',
      '\\"parameters\\"\\s*:',
      'def run_\\w+\\(',
      '@tool',
      'tools\\s*=\\s*\\[',
    ],
    always: true,
  },
  {
    id: 's03',
    name: '权限系统',
    domain: '约束域',
    one_liner: '先划边界，再给自由',
    when: '涉及破坏性/敏感操作',
    production_points: '白名单/黑名单、破坏性操作二次确认、审计日志、默认拒绝',
    readme: 's03_permission/README.md',
    signals: [
      'permission',
      'DENY_LIST',
      'allow.?list',
      'deny',
      'check_permission',
      'is_relative_to',
      'safe_path',
    ],
    always: false,
  },
  {
    id: 's04',
    name: '钩子系统',
    domain: '约束域',
    one_liner: '挂循环上，不写循环里',
    when: '需要审计、拦截、埋点',
    production_points: 'PreToolUse 可阻断、PostToolUse 可观察、异常不影响主循环',
    readme: 's04_hooks/README.md',
    signals: [
      'PreToolUse',
      'PostToolUse',
      'register_hook',
      'trigger_hooks',
      '\\bhooks?\\b',
      'middleware',
      'interceptor',
    ],
    always: false,
  },
  {
    id: 's05',
    name: '任务规划',
    domain: '认知域',
    one_liner: '先计划后执行',
    when: '多步骤、需跟踪进度',
    production_points: '计划持久化、状态流转、进度可查询',
    readme: 's05_todo_write/README.md',
    signals: ['todo_write', 'TodoManager', '\\btodos?\\b', 'plan(?:ning)?_step', 'checklist'],
    always: false,
  },
  {
    id: 's06',
    name: '子 Agent',
    domain: '上下文域',
    one_liner: '全新消息列表，隔离噪声',
    when: '上下文会爆、任务可并行',
    production_points: '独立消息列表、最终文本回传、超时回收',
    readme: 's06_subagent/README.md',
    signals: ['subagent', 'sub_agent', 'spawn_subagent', 'run_subagent', 'delegate', 'child_agent'],
    always: false,
  },
  {
    id: 's07',
    name: '技能加载',
    domain: '认知域',
    one_liner: '用到时再加载',
    when: '领域知识库庞大',
    production_points: '目录先行、按需展开、版本管理',
    readme: 's07_skill_loading/README.md',
    signals: [
      'SKILL\\.md',
      'load_skill',
      'SkillLoader',
      'skills_dir',
      'knowledge_base',
      '\\brag\\b',
      'retriev',
    ],
    always: false,
  },
  {
    id: 's08',
    name: '上下文压缩',
    domain: '上下文域',
    one_liner: '长上下文腾空间',
    when: '长会话、日志量大',
    production_points: '分层压缩、先裁工具结果再摘要历史、保留权威指令',
    readme: 's08_context_compact/README.md',
    signals: [
      'compact',
      'summariz',
      'truncat',
      'context_window',
      'micro_compact',
      'prompt_too_long',
    ],
    always: false,
  },
  {
    id: 's09',
    name: '记忆系统',
    domain: '认知域',
    one_liner: '记住该记的，忘掉该忘的',
    when: '需跨会话记住偏好/决策',
    production_points: '筛选→提取→整合三子系统、持久化 + 检索、冲突时用户指令优先',
    readme: 's09_memory/README.md',
    signals: ['MEMORY\\.md', '\\.memory', 'memor(?:y|ies)', 'remember', 'consolidate'],
    always: false,
  },
  {
    id: 's10',
    name: '任务系统',
    domain: '协作域',
    one_liner: '大目标拆小任务，持久化',
    when: '目标需持久化、断点续跑',
    production_points: '文件持久化、依赖图、原子状态变更、并发锁',
    readme: 's10_task_system/README.md',
    signals: ['TaskStore', 'blockedBy', '\\.tasks/', 'claim_task', 'complete_task', 'task_graph'],
    always: false,
  },
  {
    id: 's11',
    name: '后台任务',
    domain: '协作域',
    one_liner: '慢操作丢后台',
    when: '有慢操作需不阻塞',
    production_points: '线程池、完成通知注入、超时与清理',
    readme: 's11_background_tasks/README.md',
    signals: [
      'run_in_background',
      'BackgroundManager',
      'threading\\.Thread',
      'task_notification',
      'asyncio\\.create_task',
      'celery',
      'queue',
    ],
    always: false,
  },
  {
    id: 's12',
    name: '定时调度',
    domain: '协作域',
    one_liner: '到点自动触发',
    when: '需定时自治触发',
    production_points: '持久化调度、幂等、会话级作用域',
    readme: 's12_cron_scheduler/README.md',
    signals: [
      '\\bcron\\b',
      'schedule',
      'scheduled_tasks',
      'apscheduler',
      'every\\s+\\d+',
      'interval',
    ],
    always: false,
  },
  {
    id: 's13',
    name: 'Agent 团队',
    domain: '协作域',
    one_liner: '队友分工协作',
    when: '多任务并行、需隔离工作区',
    production_points: '原子认领、任务绑定 worktree、异步邮箱、类型化协议、关停流程',
    readme: 's13_agent_teams/README.md',
    signals: [
      'teammate',
      'worktree',
      'MessageBus',
      '\\.mailboxes',
      'spawn_teammate',
      'crew',
      'swarm',
    ],
    always: false,
  },
  {
    id: 's14',
    name: 'MCP 插件',
    domain: '行动域',
    one_liner: '外部工具接入同一工具池',
    when: '需接入外部工具生态',
    production_points: '工具发现、mcp__server__tool 命名空间、连接失败降级',
    readme: 's14_mcp_plugin/README.md',
    signals: [
      '\\bmcp\\b',
      'mcp__',
      'MCPClient',
      'connect_mcp',
      'tools/list',
      'tools/call',
      'plugin',
    ],
    always: false,
  },
  {
    id: 's15',
    name: '集成 Harness',
    domain: '编排域',
    one_liner: '多机制归一循环',
    when: '上述机制需协同（选了 3 个以上可选组件）',
    production_points: '单一循环、动态重建系统提示词、共享客户端、跨模块状态协调',
    readme: 's15_integrated_harness/README.md',
    signals: ['assemble_system_prompt', 'assemble_tool_pool', 'integrated', 'harness'],
    always: false,
  },
  {
    id: 's16',
    name: '工作流运行时',
    domain: '编排域',
    one_liner: '编排形状固定就写进代码',
    when: '编排形态固定',
    production_points: '脚本拥有编排、生命周期事件、journal 断点续跑',
    readme: 's16_workflow_runtime/README.md',
    signals: [
      'workflow',
      'journal',
      'pipeline\\(',
      'WorkflowRunner',
      'langgraph',
      'state_machine',
      '\\bdag\\b',
    ],
    always: false,
  },
  {
    id: 's17',
    name: '目标闭环',
    domain: '认知域',
    one_liner: '目标决定循环何时停止',
    when: '需自动判断「何时算完成」',
    production_points: '独立评估器、目标不可能/失败/超限时交还控制权',
    readme: 's17_goal_loop/README.md',
    signals: [
      'goal',
      'evaluator',
      'judge',
      'acceptance',
      'verify_done',
      'is_complete',
      'stop_hook',
    ],
    always: false,
  },
] as const;
for (const component of components) {
  Object.freeze(component.signals);
  Object.freeze(component);
}
export const BLUEPRINT_COMPONENTS = Object.freeze(components);

const features = [
  {
    id: 'destructive_ops',
    question: '是否涉及破坏性或敏感操作（删除、写入外部系统、支付、发送消息、隐私数据）？',
    component: 's03',
  },
  {
    id: 'audit_needed',
    question: '是否需要审计、拦截、埋点、合规记录？',
    component: 's04',
  },
  {
    id: 'multi_step',
    question: '单次交付是否多步骤、需要跟踪进度？',
    component: 's05',
  },
  {
    id: 'context_heavy',
    question: '是否会出现上下文爆炸的子任务，或可并行的探索型子任务？',
    component: 's06',
  },
  {
    id: 'large_knowledge',
    question: '领域知识库是否庞大、需要按需加载？',
    component: 's07',
  },
  {
    id: 'long_sessions',
    question: '会话是否很长、工具输出或日志量是否很大？',
    component: 's08',
  },
  {
    id: 'cross_session_memory',
    question: '是否需要跨会话记住用户偏好、决策、历史？',
    component: 's09',
  },
  {
    id: 'persistent_goals',
    question: '目标是否需要持久化、支持断点续跑？',
    component: 's10',
  },
  {
    id: 'slow_operations',
    question: '是否有耗时几分钟以上的慢操作需要不阻塞主流程？',
    component: 's11',
  },
  {
    id: 'scheduled',
    question: '是否需要定时自动触发？',
    component: 's12',
  },
  {
    id: 'parallel_isolated',
    question: '是否需要多任务并行且各自隔离工作区（多 Agent 团队）？',
    component: 's13',
  },
  {
    id: 'external_ecosystem',
    question: '是否需要接入外部工具生态（MCP、第三方插件）？',
    component: 's14',
  },
  {
    id: 'fixed_orchestration',
    question: '编排形态是否固定、适合写死成工作流？',
    component: 's16',
  },
  {
    id: 'auto_completion',
    question: '是否需要自动判断「何时算完成」（独立评估器）？',
    component: 's17',
  },
] as const;
for (const feature of features) Object.freeze(feature);
export const BLUEPRINT_FEATURES = Object.freeze(features);

export type BlueprintProfile = 'web' | 'agent';
export type BlueprintFeatureId = (typeof BLUEPRINT_FEATURES)[number]['id'];
export type BlueprintFeatureValue = 'yes' | 'no' | 'later' | 'unknown';
export type BlueprintDecision = '必选' | '二期' | '待确认' | '放弃' | '不适用';
export interface BlueprintFeatureInput {
  value?: string;
  evidence?: string;
}
export type BlueprintFeatures = Partial<Record<BlueprintFeatureId, BlueprintFeatureInput>>;
export interface BlueprintComponentDecision {
  id: string;
  name: string;
  decision: BlueprintDecision;
  reason: string;
  feature: string;
}

const decisions: Record<BlueprintFeatureValue, BlueprintDecision> = {
  yes: '必选',
  later: '二期',
  unknown: '待确认',
  no: '放弃',
};
const componentById = new Map(BLUEPRINT_COMPONENTS.map((component) => [component.id, component]));
const componentOrder = new Map(
  BLUEPRINT_COMPONENTS.map((component, index) => [component.id, index]),
);
const featureByComponent = new Map(
  BLUEPRINT_FEATURES.map((feature) => [feature.component, feature.id]),
);

function validateFeatures(input: unknown): BlueprintFeatures {
  assertRecord(input, 'Blueprint 特征');
  assertFields(
    input,
    BLUEPRINT_FEATURES.map((feature) => feature.id),
    'Blueprint 特征',
  );
  const result: BlueprintFeatures = {};
  for (const [id, raw] of Object.entries(input)) {
    assertRecord(raw, 'Blueprint 特征');
    assertFields(raw, ['value', 'evidence'], 'Blueprint 特征');
    // As upstream does, unsupported string values become unknown instead of
    // accidentally selecting a component. Malformed transport types are rejected.
    if (raw.value !== undefined && typeof raw.value !== 'string') {
      throw new AppError('INVALID_INPUT', 'Blueprint 特征值必须为文本。');
    }
    if (typeof raw.value === 'string' && raw.value.length > 40) {
      throw new AppError('INVALID_INPUT', 'Blueprint 特征值过长。');
    }
    result[id as BlueprintFeatureId] = {
      value: raw.value,
      evidence:
        raw.evidence === undefined ? '' : parseText(raw.evidence, 'Blueprint 依据', 8_000, true),
    };
  }
  return result;
}

/** The profile is explicit; no keyword classifier infers Agent requirements. */
export function selectBlueprintComponents(
  profile: BlueprintProfile,
  input: BlueprintFeatures = {},
): BlueprintComponentDecision[] {
  if (profile !== 'web' && profile !== 'agent') {
    throw new AppError('INVALID_INPUT', 'Blueprint 产品类型无效。');
  }
  const inputFeatures = validateFeatures(input);
  if (profile === 'web') {
    return BLUEPRINT_COMPONENTS.map((component) => ({
      id: component.id,
      name: component.name,
      decision: '不适用',
      reason: '当前为普通 Web 项目，Agent Harness 组件不适用；不作为缺失项计分。',
      feature:
        featureByComponent.get(component.id as (typeof BLUEPRINT_FEATURES)[number]['component']) ??
        '',
    }));
  }

  const result: BlueprintComponentDecision[] = [];
  for (const component of BLUEPRINT_COMPONENTS) {
    if (component.always) {
      result.push({
        id: component.id,
        name: component.name,
        decision: '必选',
        reason: `${component.when}（一切基础，恒选）`,
        feature: '',
      });
    }
  }
  for (const feature of BLUEPRINT_FEATURES) {
    const component = componentById.get(feature.component)!;
    const raw = inputFeatures[feature.id] ?? {};
    const value =
      raw.value && Object.hasOwn(decisions, raw.value)
        ? (raw.value as BlueprintFeatureValue)
        : 'unknown';
    const decision = decisions[value];
    const evidence = raw.evidence ?? '';
    const reason =
      decision === '待确认'
        ? `输入未说明：${feature.question}`
        : decision === '放弃'
          ? evidence || `输入表明不需要：${component.when}`
          : evidence || component.when;
    result.push({ id: component.id, name: component.name, decision, reason, feature: feature.id });
  }

  const optional = result.filter((item) => !['s01', 's02', 's15'].includes(item.id));
  const mvp = optional.filter((item) => item.decision === '必选');
  const later = optional.filter((item) => item.decision === '必选' || item.decision === '二期');
  const harness = componentById.get('s15')!;
  result.push({
    id: harness.id,
    name: harness.name,
    decision: mvp.length >= 3 ? '必选' : later.length >= 3 ? '二期' : '放弃',
    reason:
      mvp.length >= 3
        ? `第一版已选 ${mvp.length} 个可选组件（${mvp.map((item) => item.id).join(', ')}），需归一到单一循环`
        : later.length >= 3
          ? `含二期共 ${later.length} 个可选组件，二期集成时需要`
          : '可选组件不足 3 个，直接在 loop 里挂接即可',
    feature: '',
  });
  result.sort(
    (a, b) =>
      componentOrder.get(a.id as (typeof BLUEPRINT_COMPONENTS)[number]['id'])! -
      componentOrder.get(b.id as (typeof BLUEPRINT_COMPONENTS)[number]['id'])!,
  );
  return result;
}
