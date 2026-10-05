import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronRight, ClipboardList, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Project } from '../shared/contracts';
import type { PlanProfile, PlanRequest, PlanState, PlanTask } from '../shared/plan-contracts';
import { api } from './api';
import { CodingPanel } from './CodingPanel';
import { AppAiPanel } from './AppAiPanel';
import { DataBackupPanel } from './DataBackupPanel';
import { DataMigrationPanel } from './DataMigrationPanel';
import type { CodingRequest, CodingState } from '../shared/coding-contracts';
import type { BuildRequest, BuildResult } from '../shared/build-contracts';
import type { RepairRequest, RepairState } from '../shared/repair-contracts';
import type { RuntimeCheckRequest, RuntimeReport } from '../shared/runtime-contracts';
import type { ApplicationState } from '../shared/app-data-contracts';
import './plan.css';

const groups: { kind: PlanTask['kind']; title: string; empty: string }[] = [
  { kind: 'page', title: '要做的页面', empty: '当前版本没有列出页面。' },
  { kind: 'feature', title: '要实现的功能', empty: '当前版本没有列出功能。' },
  { kind: 'data', title: '要保存的内容', empty: '当前版本没有列出数据。' },
  { kind: 'acceptance', title: '要验收的结果', empty: '当前版本没有列出验收要求。' },
];
const profileNames: Record<PlanProfile, string> = { web: '普通网页', agent: 'AI 任务型网页' };
const stageNames = { binding: '核对确认版本', rules: '整理适用规则', tasks: '整理任务清单' };

function displayDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function PlanPanel({
  project,
  disabled,
  onRequirements,
  onDesign,
  onGenerate,
  onBuild,
  onCheckRuntime,
  onOpenApplication,
  onRepair,
}: {
  project: Project;
  disabled: boolean;
  onRequirements: () => void;
  onDesign: () => void;
  onGenerate: (input: CodingRequest) => Promise<CodingState | undefined>;
  onBuild: (input: BuildRequest) => Promise<BuildResult | undefined>;
  onCheckRuntime: (input: RuntimeCheckRequest) => Promise<RuntimeReport | undefined>;
  onOpenApplication: (input: {
    projectId: string;
    buildId: string;
  }) => Promise<ApplicationState | undefined>;
  onRepair: (input: RepairRequest) => Promise<RepairState | undefined>;
}) {
  const requirement = project.requirements.at(-1);
  const design = project.designs.at(-1);
  const confirmed = !!(
    requirement?.approvedAt &&
    design?.approvedAt &&
    design.basedOn === requirement.id
  );
  const [state, setState] = useState<PlanState | null>(null);
  const [profile, setProfile] = useState<PlanProfile>('web');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [appAiWorking, setAppAiWorking] = useState(false);
  const [dataBackupWorking, setDataBackupWorking] = useState(false);
  const [dataMigrationWorking, setDataMigrationWorking] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const pendingRequest = useRef<PlanRequest | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    inFlight.current = false;
    pendingRequest.current = null;
    setCreating(false);
    setLoading(true);
    setReadError('');
    setActionError('');
    setState(null);
    setProfile('web');
    void (async () => {
      try {
        const result = await api.planState({ projectId: project.id });
        if (current !== generation.current) return;
        if (result.ok) {
          setState(result.value);
          setProfile(result.value.run?.plan.profile ?? 'web');
        } else {
          setReadError(result.error.message);
        }
      } catch {
        if (current === generation.current) {
          setReadError('暂时无法读取已保存的计划。请重试读取，再继续整理。');
        }
      } finally {
        if (current === generation.current) setLoading(false);
      }
    })();
    return () => {
      generation.current++;
    };
  }, [
    project.id,
    project.archived,
    requirement?.id,
    requirement?.approvedAt,
    design?.id,
    design?.approvedAt,
    design?.basedOn,
    readAttempt,
  ]);

  const create = async () => {
    if (
      inFlight.current ||
      disabled ||
      appAiWorking ||
      dataBackupWorking ||
      dataMigrationWorking ||
      project.archived ||
      loading ||
      readError ||
      !state ||
      !confirmed ||
      !requirement ||
      !design
    )
      return;
    inFlight.current = true;
    const current = ++generation.current;
    const previous = pendingRequest.current;
    const request: PlanRequest =
      previous?.profile === profile &&
      previous.projectId === project.id &&
      previous.requirementId === requirement.id &&
      previous.designId === design.id
        ? previous
        : {
            schemaVersion: 1,
            requestId: crypto.randomUUID(),
            projectId: project.id,
            requirementId: requirement.id,
            designId: design.id,
            profile,
          };
    pendingRequest.current = request;
    setCreating(true);
    setActionError('');
    try {
      const result = await api.createPlan(request);
      if (current !== generation.current) return;
      if (result.ok) {
        setState(result.value);
        pendingRequest.current = null;
      } else {
        setActionError(result.error.message);
      }
    } catch {
      if (current === generation.current) {
        setActionError('整理结果暂时未能返回，请重试。重复重试会核对同一次请求。');
      }
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setCreating(false);
      }
    }
  };

  const run = state?.run;
  const plan = run?.plan;
  const stale = !!(
    run &&
    (state?.status === 'stale' ||
      !confirmed ||
      run.request.requirementId !== requirement?.id ||
      run.request.designId !== design?.id)
  );
  const busy =
    disabled || loading || creating || appAiWorking || dataBackupWorking || dataMigrationWorking;
  const status = loading ? 'loading' : readError ? 'error' : stale ? 'stale' : state?.status;
  const statusLabel = loading
    ? '正在读取'
    : readError
      ? '读取失败'
      : stale
        ? '旧计划已失效'
        : run
          ? '计划已整理'
          : '尚未整理';

  return (
    <section
      className="content-stack plan-panel"
      aria-label="开发计划"
      data-testid="plan-state"
      data-status={status}
      aria-busy={loading || creating}
    >
      <div className="tool-panel-heading">
        <div className="tool-panel-title">
          <h2>开发计划</h2>
          <span className={`plan-status ${stale ? 'is-stale' : ''}`} role="status">
            {statusLabel}
          </span>
        </div>
        <button
          className="button primary"
          data-testid="create-plan"
          disabled={busy || project.archived || !!readError || !state || !confirmed}
          onClick={() => void create()}
        >
          {creating ? <LoaderCircle size={16} className="spin" /> : <ClipboardList size={16} />}
          {creating ? '正在整理' : '整理开发计划'}
        </button>
      </div>
      <p className="plan-basis">
        {project.archived
          ? '恢复项目后可以重新整理。'
          : confirmed
            ? `依据需求 v${requirement?.version} · 页面 v${design?.version}，使用本地规则整理，不调用模型。`
            : '确认需求和页面方向后，即可整理清单。'}
      </p>
      <p className="plan-execution-note">任务待开发，验收未运行。</p>
      <CodingPanel
        projectId={project.id}
        planRunId={run && !stale && confirmed ? run.id : null}
        disabled={busy || project.archived}
        onGenerate={onGenerate}
        onBuild={onBuild}
        onCheckRuntime={onCheckRuntime}
        onOpenApplication={onOpenApplication}
        onRepair={onRepair}
      />
      <AppAiPanel
        key={`app-ai:${project.id}`}
        projectId={project.id}
        planRunId={run && !stale && confirmed ? run.id : null}
        archived={project.archived}
        disabled={disabled || loading || creating || dataBackupWorking || dataMigrationWorking}
        onWorkingChange={setAppAiWorking}
      />
      <DataBackupPanel
        key={`data-backup:${project.id}`}
        projectId={project.id}
        archived={project.archived}
        disabled={disabled || creating || appAiWorking || dataMigrationWorking}
        onWorkingChange={setDataBackupWorking}
      />
      <DataMigrationPanel
        key={`data-migration:${project.id}`}
        projectId={project.id}
        archived={project.archived}
        disabled={disabled || creating || appAiWorking || dataBackupWorking}
        onWorkingChange={setDataMigrationWorking}
      />

      {!confirmed && !project.archived && (
        <div className="info-strip plan-notice">
          <span>
            {requirement?.approvedAt
              ? '当前页面方向尚未确认，或对应的是旧需求。'
              : '当前需求尚未确认。确认后，再确认以它为依据的页面方向。'}
          </span>
          <button
            className="button compact"
            disabled={busy}
            onClick={requirement?.approvedAt ? onDesign : onRequirements}
          >
            {requirement?.approvedAt ? '查看页面方向' : '查看需求'} <ArrowRight size={14} />
          </button>
        </div>
      )}

      {readError && (
        <div className="error-box plan-notice" role="alert">
          <span>{readError}</span>
          <button
            className="button compact"
            disabled={busy}
            onClick={() => setReadAttempt((value) => value + 1)}
          >
            <RefreshCw size={14} /> 重试读取
          </button>
        </div>
      )}
      {actionError && (
        <div className="error-box" role="alert">
          {actionError}
        </div>
      )}
      {stale && (
        <div className="info-strip plan-notice" role="status">
          需求或页面版本已变化，下方保留的是旧计划。确认最新版本后，请重新整理；旧清单不能用于当前版本的开发。
        </div>
      )}

      {plan && run && (
        <>
          <div className="plan-summary">
            <p>{plan.summary}</p>
            <span>
              {profileNames[plan.profile]} · 整理于 {displayDate(run.createdAt)}
            </span>
          </div>
          <div className="plan-task-groups" data-testid="plan-tasks">
            {groups.map((group) => {
              const tasks = plan.tasks.filter((task) => task.kind === group.kind);
              return (
                <details
                  className="plan-task-group"
                  key={group.kind}
                  open={group.kind === 'page' || group.kind === 'feature'}
                >
                  <summary className="plan-group-heading">
                    <ChevronRight size={15} aria-hidden="true" />
                    <h3>{group.title}</h3>
                    <span>{tasks.length} 项</span>
                  </summary>
                  {tasks.length ? (
                    <ul>
                      {tasks.map((task) => (
                        <li key={task.id}>
                          <p>{task.title}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="plan-empty">{group.empty}</p>
                  )}
                </details>
              );
            })}
          </div>
          <section className="plan-questions" data-testid="plan-questions">
            <h3>待明确问题</h3>
            <p>以下内容仍待确认，不会自动计入已确认功能。</p>
            {plan.openQuestions.length ? (
              <ul>
                {plan.openQuestions.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ul>
            ) : (
              <p className="plan-empty">当前需求没有列出待明确问题。</p>
            )}
          </section>
          {!!plan.reviewNotes.length && (
            <section className="plan-review">
              <h3>还需要核对的地方</h3>
              <ul>
                {plan.reviewNotes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <details className="plan-advanced">
        <summary>高级设置与整理依据</summary>
        <div className="plan-advanced-content">
          <label className="plan-profile-field">
            应用类型
            <select
              data-testid="plan-profile"
              value={profile}
              disabled={busy || project.archived || !!readError}
              onChange={(event) => setProfile(event.target.value as PlanProfile)}
            >
              <option value="web">普通网页</option>
              <option value="agent">AI 任务型网页</option>
            </select>
          </label>
          <p>
            博客、清单等通常选择普通网页。只有应用本身要通过 AI 执行任务时，才选择 AI
            任务型网页；系统不会从文字描述中猜测这一点。
          </p>
          {plan && profile !== plan.profile && (
            <p className="plan-profile-change">应用类型已修改，重新整理后生效。</p>
          )}
          {run && plan && (
            <>
              <section>
                <h4>适用的规则组件</h4>
                {plan.components.length ? (
                  <ul className="plan-component-list">
                    {plan.components.map((component) => (
                      <li key={component.id}>
                        <strong>
                          {component.name} · {component.decision}
                        </strong>
                        <p>{component.reason}</p>
                        <small>
                          {component.id}
                          {component.feature ? ` · ${component.feature}` : ''}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>当前类型不需要 Agent 规则组件。</p>
                )}
              </section>
              {!!plan.checks.length && (
                <section>
                  <h4>后续检查项</h4>
                  <ul>
                    {plan.checks.map((check) => (
                      <li key={check.id}>{check.title} · 未运行</li>
                    ))}
                  </ul>
                </section>
              )}
              <section>
                <h4>任务来源与依赖</h4>
                <ul className="plan-source-list">
                  {plan.tasks.map((task) => (
                    <li key={task.id}>
                      <strong>
                        {task.id} · {task.title}
                      </strong>
                      <span>来源：{task.source}</span>
                      {!!task.dependsOn.length && <span>依赖：{task.dependsOn.join('、')}</span>}
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h4>整理记录</h4>
                <ol data-testid="plan-events">
                  {run.events.map((event) => (
                    <li key={event.sequence}>{stageNames[event.stage]} · 已整理</li>
                  ))}
                </ol>
                <p>以上记录只代表规则整理已完成，不代表代码已实现或验收通过。</p>
                <dl className="plan-provenance">
                  <dt>规则来源版本</dt>
                  <dd>{run.sourceRevision}</dd>
                  <dt>适配器版本</dt>
                  <dd>{run.adapterVersion}</dd>
                  <dt>需求版本标识</dt>
                  <dd>{run.request.requirementId}</dd>
                  <dt>页面版本标识</dt>
                  <dd>{run.request.designId}</dd>
                  <dt>输入校验值</dt>
                  <dd>{run.inputHash}</dd>
                  <dt>计划校验值</dt>
                  <dd>{run.artifactHash}</dd>
                </dl>
              </section>
              {state.history.length > 1 && (
                <section>
                  <h4>历次整理</h4>
                  <ul>
                    {state.history.map((item) => (
                      <li key={item.id}>
                        {displayDate(item.createdAt)} · {profileNames[item.profile]}
                        {item.id === run.id ? ' · 当前展示' : ''}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </details>
    </section>
  );
}
