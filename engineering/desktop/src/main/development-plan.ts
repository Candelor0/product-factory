import { createHash } from 'node:crypto';
import type { Project } from '../shared/contracts';
import type { DevelopmentPlan, PlanRequest, PlanTask } from '../shared/plan-contracts';
import { BLUEPRINT_SOURCE, selectBlueprintComponents } from './blueprint-rules';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

export const PLAN_ADAPTER_VERSION = 'blueprint-rules-v1' as const;
export const PLAN_SOURCE_REVISION = BLUEPRINT_SOURCE.revision;
export const planHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function parsePlanRequest(input: unknown): PlanRequest {
  assertRecord(input, '开发计划请求');
  assertFields(input, [
    'schemaVersion',
    'requestId',
    'projectId',
    'requirementId',
    'designId',
    'profile',
  ]);
  if (input.schemaVersion !== 1 || (input.profile !== 'web' && input.profile !== 'agent'))
    throw new AppError('INVALID_INPUT', '开发计划版本或项目类型无效。');
  return {
    schemaVersion: 1,
    requestId: parseRevisionId(input.requestId),
    projectId: parseProjectId(input.projectId),
    requirementId: parseRevisionId(input.requirementId),
    designId: parseRevisionId(input.designId),
    profile: input.profile as PlanRequest['profile'],
  };
}

export function boundPlanInput(project: Project, request: PlanRequest) {
  const requirements = project.requirements.find((item) => item.id === request.requirementId);
  const design = project.designs.find((item) => item.id === request.designId);
  if (
    project.id !== request.projectId ||
    !requirements?.approvedAt ||
    !design?.approvedAt ||
    design.basedOn !== requirements.id
  )
    throw new AppError('STALE_PLAN', '开发计划引用的确认版本无效，请重新核对需求与页面。');
  const inputHash = planHash({
    projectId: project.id,
    requirementId: requirements.id,
    requirementHash: requirements.hash,
    designId: design.id,
    designHash: design.hash,
    profile: request.profile,
    adapterVersion: PLAN_ADAPTER_VERSION,
    sourceRevision: PLAN_SOURCE_REVISION,
  });
  return { requirements, design, inputHash };
}

/** Local deterministic planning only. Neither model judgment nor runtime verification. */
export function buildDevelopmentPlan(project: Project, request: PlanRequest): DevelopmentPlan {
  const { requirements, design } = boundPlanInput(project, request);
  const content = requirements.content;
  const tasks: PlanTask[] = [];
  const add = (kind: PlanTask['kind'], values: string[], prefix: string, dependsOn: string[]) => {
    const ids = values.map((title, index) => {
      const id = `${prefix}${String(index + 1).padStart(3, '0')}`;
      tasks.push({
        id,
        kind,
        title,
        source: `requirements.${kind === 'feature' ? 'features' : kind === 'page' ? 'pages' : kind}[${index}]`,
        dependsOn: [...dependsOn],
        implementation: 'pending',
        verification: 'not_run',
      });
      return id;
    });
    return ids;
  };
  const dataIds = add('data', content.data, 'D', []);
  const pageIds = add('page', content.pages, 'P', []);
  const featureIds = add('feature', content.features, 'F', [...dataIds, ...pageIds]);
  add('acceptance', content.acceptance, 'A', [...dataIds, ...pageIds, ...featureIds]);
  const designNames = new Set(design.content.pages.map((item) => item.name));
  const requirementNames = new Set(content.pages);
  const reviewNotes = [
    ...content.pages
      .filter((name) => !designNames.has(name))
      .map((name) => `需求页面“${name}”与方案中的页面名称未完全匹配，请核对覆盖关系。`),
    ...design.content.pages
      .filter((page) => !requirementNames.has(page.name))
      .map((page) => `方案页面“${page.name}”与需求中的页面名称未完全匹配，请核对是否为同一页面。`),
  ];
  if (request.profile === 'agent')
    reviewNotes.push('尚未分析自主任务的具体能力；Agent 可选组件保持待确认，不据此启动实现。');
  return {
    summary: content.summary,
    profile: request.profile,
    tasks,
    openQuestions: [...content.questions],
    reviewNotes,
    components: selectBlueprintComponents(request.profile),
    checks: [
      {
        id: 'local-run',
        title: '在工作台启动、停止并重新打开应用',
        source: 'product-factory',
        status: 'not_run',
      },
      {
        id: 'data-retention',
        title: '重开及修改代码后保留已保存的业务数据',
        source: 'product-factory',
        status: 'not_run',
      },
      {
        id: 'credential-boundary',
        title: '生成应用和导出文件不含工作台凭据',
        source: 'product-factory',
        status: 'not_run',
      },
      {
        id: 'failure-recovery',
        title: '失败或中断后保留可恢复的成果与错误记录',
        source: 'product-factory',
        status: 'not_run',
      },
    ],
  };
}
