import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import type { WorkflowRequest, WorkflowStage, WorkflowState } from '../shared/workflow-contracts';
import { MODIFICATION_LIMITS } from '../shared/modification';
import { api } from './api';
import './workflow.css';

// Keep the exact uncertain request when the user changes tabs or projects.
const pendingRequests = new Map<string, WorkflowRequest>();
const modificationDrafts = new Map<string, string>();
const modeNames = { generate: '自动开发', check: '检查已有源码', modify: '修改并检查' };
const historyStatus = {
  running: '进行中',
  ready: '启动检查通过',
  stopped: '流程停止',
  cancelled: '已取消',
  limited: '达到上限',
  interrupted: '已中断',
};
const changeNames = { added: '新增', modified: '修改', deleted: '删除' };
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const stageNames = {
  generation: '生成源码',
  build: '受控构建',
  startup: '启动检查',
  repair: '有限修复',
};
const stageStatus = {
  running: '进行中',
  succeeded: '已完成',
  no_changes: '没有新改动',
  failed: '未完成',
  cancelled: '已取消',
  limited: '达到上限',
  interrupted: '已中断',
};
const reasons: Record<string, string> = {
  KEY_REQUIRED: '请先在模型设置中保存 API Key。',
  CREDENTIAL_UNAVAILABLE: '当前系统无法读取模型凭据，请在设置中重新保存。',
  BUDGET_EXCEEDED: '模型调用额度已用完，请核对设置中的累计额度。',
  TOKEN_BUDGET_EXCEEDED: '剩余 token 额度不足以继续下一次模型请求。',
  TOKEN_USAGE_UNKNOWN: '历史用量尚未核对，暂不能按 token 额度继续。',
  AUTH_FAILED: '模型凭据无效或已过期，请检查设置。',
  QUOTA_EXCEEDED: '供应商账户余额或额度不足。',
  RATE_LIMITED: '供应商限制了请求频率，当前流程已停止。',
  NETWORK_ERROR: '模型请求未能确认，请核对记录；已发送的请求可能计费。',
  TIMEOUT: '模型响应超时，已发送的请求可能计费。',
  WORKFLOW_TIMEOUT: '已达到整个流程的时间上限，已保存的源码保留。',
  WORKFLOW_LIMIT: '已达到本次流程的调用、工具或构建上限。',
  CODING_LIMIT: '源码生成已达到本次上限，已保存的修改保留。',
  REPAIR_LIMIT: '有限修复已达到本次上限，已保存的修改保留。',
  STALE_PLAN: '当前确认计划已有变化，请先整理最新计划。',
  STALE_SOURCE: '源码已变化，请读取当前版本后再开始新的流程。',
  CONFIRMATION_REQUIRED: '请先确认需求和页面方向，并整理当前计划。',
  EMPTY_SOURCE: '当前没有可检查的源码，请先自动开发。',
  SOURCE_REQUIRED: '当前没有可检查的源码，请先自动开发。',
  RUNTIME_NOT_REPRODUCED: '本次启动未复现原问题，尚未验证原交互错误。',
  RUNTIME_ISSUES: '启动检查仍发现错误，候选尚未就绪。',
  BUILD_FAILED: '编译没有通过，请查看下方构建记录。',
  CANCELLED: '已停止后续阶段，已经保存的源码保留。',
  MODEL_CANCELLED: '已取消模型请求，已提交的修改保留。',
};
const statusLabel = (state: WorkflowState | null) => {
  const run = state?.run;
  if (!run) return '尚未开始';
  if (run.status === 'ready')
    return state.current
      ? '候选已通过启动检查，仍需业务核验'
      : '旧候选曾通过启动检查，当前版本需重新检查';
  return {
    running: run.request.mode === 'modify' ? '正在修改并检查' : '自动开发进行中',
    stopped: '流程已停止，尚未得到就绪候选',
    cancelled: '流程已取消，已保存的修改保留',
    limited: '流程达到上限，已保存的修改保留',
    interrupted: '上次流程已中断，重开后未自动续跑',
  }[run.status];
};
const stageLabel = (stage: WorkflowStage, mode: WorkflowRequest['mode']) =>
  stage.status !== 'succeeded'
    ? stageStatus[stage.status]
    : stage.kind === 'build'
      ? '编译通过'
      : stage.kind === 'startup'
        ? '启动观察通过'
        : stage.kind === 'generation'
          ? mode === 'modify'
            ? '修改阶段完成'
            : '生成阶段完成'
          : '修复阶段完成';

export function WorkflowPanel({
  projectId,
  planRunId,
  disabled,
  onRun,
  onWorkingChange,
  onSettled,
}: {
  projectId: string;
  planRunId: string | null;
  disabled: boolean;
  onRun: (input: WorkflowRequest, reconcile?: boolean) => Promise<WorkflowState | undefined>;
  onWorkingChange: (working: boolean) => void;
  onSettled: () => void;
}) {
  const [state, setState] = useState<WorkflowState | null>(null);
  const [pending, setPending] = useState<WorkflowRequest | null>(
    () => pendingRequests.get(projectId) ?? null,
  );
  const [instruction, setInstruction] = useState(() => modificationDrafts.get(projectId) ?? '');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [viewRequestId, setViewRequestId] = useState<string | undefined>();
  const lifecycle = useRef(0),
    reads = useRef(0),
    locked = useRef(false);
  const callbacks = useRef({ onWorkingChange, onSettled });
  const completed = useRef<string | null>(null);
  const status = useRef<HTMLParagraphElement | null>(null);
  callbacks.current = { onWorkingChange, onSettled };
  const accept = (next: WorkflowState) => {
    setState(next);
    if (next.run && next.run.status !== 'running') {
      const completion = `${next.run.id}:${next.run.status}:${next.run.latestRevision}`;
      if (completed.current !== completion) {
        completed.current = completion;
        callbacks.current.onSettled();
      }
    }
  };
  useEffect(() => {
    lifecycle.current++;
    locked.current = false;
    completed.current = null;
    setState(null);
    setWorking(false);
    setReadError('');
    setActionError('');
    setStopping(false);
    setStopNotice('');
    setPending(pendingRequests.get(projectId) ?? null);
    setViewRequestId(undefined);
    setInstruction(modificationDrafts.get(projectId) ?? '');
    return () => {
      lifecycle.current++;
      reads.current++;
      callbacks.current.onWorkingChange(false);
    };
  }, [projectId]);
  useEffect(() => {
    let active = true,
      first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const read = async () => {
      const sequence = ++reads.current;
      try {
        const result = await api.workflowState({
          projectId,
          ...(viewRequestId ? { requestId: viewRequestId } : {}),
        });
        if (!active || sequence !== reads.current) return;
        if (result.ok) {
          accept(result.value);
          setReadError('');
          if (result.value.run?.status === 'running') timer = setTimeout(() => void read(), 800);
        } else setReadError(result.error.message);
      } catch {
        if (active && sequence === reads.current)
          setReadError('暂时无法读取自动开发记录，请重新核对状态。');
      } finally {
        if (active && first && sequence === reads.current) {
          first = false;
          setLoading(false);
        }
      }
    };
    void read();
    return () => {
      active = false;
      reads.current++;
      clearTimeout(timer);
    };
  }, [projectId, planRunId, disabled, working, refresh, viewRequestId]);
  const running = working || state?.run?.status === 'running';
  useEffect(() => {
    callbacks.current.onWorkingChange(running);
  }, [running]);
  useEffect(() => {
    if (state?.run && state.run.status !== 'running') status.current?.focus();
  }, [state?.run?.id, state?.run?.status]);

  const start = async (mode: WorkflowRequest['mode'], reconcile = false) => {
    if (
      locked.current ||
      disabled ||
      running ||
      (reconcile
        ? !pending
        : loading ||
          readError ||
          !state ||
          !planRunId ||
          (mode !== 'generate' && state.fileCount === 0) ||
          (mode === 'modify' && !validInstruction))
    )
      return;
    const base = {
      requestId: crypto.randomUUID(),
      projectId,
      planRunId: planRunId!,
      sourceRevision: state?.sourceRevision ?? 0,
    };
    const request: WorkflowRequest = reconcile
      ? pending!
      : mode === 'modify'
        ? { ...base, schemaVersion: 2, mode, instruction: instruction.trim() }
        : { ...base, schemaVersion: 1, mode };
    if (!reconcile) setViewRequestId(undefined);
    pendingRequests.set(projectId, request);
    setPending(request);
    const current = lifecycle.current;
    locked.current = true;
    setWorking(true);
    setActionError('');
    setStopNotice('');
    try {
      let result: WorkflowState | undefined;
      if (reconcile) {
        const checked = await api.workflowState({ projectId, requestId: request.requestId });
        if (current !== lifecycle.current) return;
        if (!checked.ok) {
          setActionError(checked.error.message);
          return;
        }
        if (!checked.value.run) {
          setActionError('尚未找到原请求记录，没有继续执行。可明确点击上方操作开始新流程。');
          return;
        }
        setViewRequestId(request.requestId);
        result = checked.value;
      } else result = await onRun(request);
      if (result && pendingRequests.get(projectId)?.requestId === request.requestId)
        pendingRequests.delete(projectId);
      if (current !== lifecycle.current) return;
      if (result) {
        accept(result);
        setPending(null);
        setReadError('');
        if (request.mode === 'modify' && instruction.trim() === request.instruction) {
          modificationDrafts.delete(projectId);
          setInstruction('');
        }
      } else
        setActionError('本次请求结果尚待核对。请先核对原请求，不会自动重新发送生成或修复请求。');
    } catch {
      if (current === lifecycle.current)
        setActionError(
          '本次请求结果尚待核对。保留了原请求，可手动核对；已发送的模型请求可能计费。',
        );
    } finally {
      if (current === lifecycle.current) {
        locked.current = false;
        setWorking(false);
        setRefresh((value) => value + 1);
      }
    }
  };
  const stop = async () => {
    if (stopping || state?.run?.status !== 'running') return;
    const current = lifecycle.current;
    setStopping(true);
    setActionError('');
    try {
      const result = await api.cancelGeneration();
      if (current !== lifecycle.current) return;
      if (result.ok) setStopNotice('已请求停止，正在核对已保存的结果。');
      else setActionError(result.error.message);
    } catch {
      if (current === lifecycle.current) setActionError('停止请求尚未确认，请核对状态后重试。');
    } finally {
      if (current === lifecycle.current) {
        setStopping(false);
        setRefresh((value) => value + 1);
      }
    }
  };
  const validInstruction =
    instruction.trim().length > 0 &&
    instruction.length <= MODIFICATION_LIMITS.characters &&
    new TextEncoder().encode(instruction).length <= MODIFICATION_LIMITS.bytes;
  const selectHistory = (requestId: string) => {
    if (disabled || running || loading) return;
    setActionError('');
    setStopNotice('');
    setViewRequestId(requestId);
  };
  const blocked = disabled || running || loading || !!readError || !state || !planRunId;
  const run = state?.run;
  return (
    <section
      className="workflow-panel"
      aria-label="自动开发"
      data-testid="workflow-state"
      data-status={run?.status ?? 'empty'}
      data-current={state?.current ?? false}
      aria-busy={running}
    >
      <div className="workflow-heading">
        <div>
          <h3>自动开发</h3>
          <p className="muted small">
            按已确认的计划，依次生成源码、构建和检查启动；必要时进行一次有限修复。
          </p>
        </div>
        <button
          className="button compact"
          data-testid="refresh-workflow"
          disabled={disabled || working || loading}
          onClick={() => {
            setViewRequestId(undefined);
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw size={14} />
          {loading ? '正在读取' : '刷新状态'}
        </button>
      </div>
      <div className="workflow-actions">
        <button
          className="button primary"
          data-testid="start-workflow"
          disabled={blocked}
          onClick={() => void start('generate')}
        >
          <Play size={15} />
          自动开发
        </button>
        <button
          className="button"
          data-testid="check-workflow"
          disabled={blocked || !state?.fileCount}
          onClick={() => void start('check')}
        >
          检查已有源码并继续
          <ArrowRight size={15} />
        </button>
      </div>
      <form
        className="workflow-modification"
        data-testid="modification-form"
        onSubmit={(event) => {
          event.preventDefault();
          void start('modify');
        }}
      >
        <label htmlFor={`modification-${projectId}`}>修改已有应用</label>
        <p className="muted small" id={`modification-help-${projectId}`}>
          描述当前确认方向内的页面或行为调整；如果主要功能、页面或使用对象改变，请先重新确认需求和页面方向。
        </p>
        <textarea
          id={`modification-${projectId}`}
          data-testid="modification-instruction"
          rows={3}
          maxLength={MODIFICATION_LIMITS.characters}
          value={instruction}
          disabled={disabled || running}
          aria-describedby={`modification-help-${projectId} modification-privacy-${projectId}`}
          placeholder="例如：把新增按钮放到列表上方，新增后清空输入框。"
          onChange={(event) => {
            setInstruction(event.target.value);
            modificationDrafts.set(projectId, event.target.value);
          }}
        />
        <div className="workflow-modification-actions">
          <p className="muted small" id={`modification-privacy-${projectId}`}>
            提交的要求会保存在本项目并发送给模型。不要填写 API Key、密码或个人业务正文。
          </p>
          <span className="muted small" data-testid="modification-count">
            {instruction.length}/{MODIFICATION_LIMITS.characters}
          </span>
          <button
            className="button primary"
            type="submit"
            data-testid="modify-workflow"
            disabled={blocked || !state?.fileCount || !validInstruction}
          >
            <ArrowRight size={15} /> 修改并检查
          </button>
        </div>
        {!state?.fileCount && (
          <p className="muted small">
            生成源码后即可提出修改。修改使用当前确认计划，不会自动改变需求或页面确认。
          </p>
        )}
      </form>
      <p className="workflow-cost">
        可能产生模型费用。一次最多生成 4 轮、修复 4 轮，总用时上限 5
        分钟；检查已有源码会跳过生成，必要的修复仍可能计费。
      </p>
      <p className="muted small">
        通过启动观察只得到待核验候选，不等于业务验收。不会自动打开持久本地应用或迁移数据。
      </p>
      {!planRunId && <p className="muted small">先确认需求和页面方向，并整理当前开发计划。</p>}
      {pending && !running && (
        <div className="workflow-pending" data-testid="workflow-pending">
          <p>
            保留了上一次{modeNames[pending.mode]}
            请求。核对原请求只读取已有结果，不会继续付费执行；再次选择上方操作会明确开始一轮新流程。
          </p>
          <button
            className="button compact"
            data-testid="reconcile-workflow"
            disabled={disabled || working}
            onClick={() => void start(pending.mode, true)}
          >
            <RefreshCw size={14} />
            核对原请求
          </button>
        </div>
      )}
      {state?.run?.status === 'running' && !working && (
        <button
          className="button compact"
          data-testid="stop-workflow"
          disabled={stopping}
          onClick={() => void stop()}
        >
          {stopping ? '正在请求停止' : '停止此流程'}
        </button>
      )}
      {stopNotice && (
        <p className="muted small" role="status">
          {stopNotice}
        </p>
      )}
      {actionError && (
        <p className="field-error" role="alert" data-testid="workflow-action-error">
          {actionError}
        </p>
      )}
      {readError && (
        <p className="field-error" role="alert">
          {readError}
        </p>
      )}
      {run && (
        <div className="workflow-run">
          <p
            ref={status}
            tabIndex={-1}
            className={`workflow-status is-${run.status}`}
            data-testid="workflow-result"
            role="status"
          >
            {running ? (
              <LoaderCircle size={15} className="spin" />
            ) : run.status === 'ready' && state.current ? (
              <Check size={15} />
            ) : null}
            {statusLabel(state)}
          </p>
          {!state.current && run.status !== 'running' && (
            <p className="workflow-stale" data-testid="workflow-stale">
              这是旧计划或旧源码的流程记录；其结论不适用于当前版本。可按当前确认计划开始新流程。
            </p>
          )}
          {run.status === 'interrupted' && (
            <p className="workflow-stale">
              重开没有自动续跑或重新收费。请先核对已保存源码，再选择“检查已有源码并继续”。
            </p>
          )}
          {run.request.mode === 'modify' && (
            <div className="workflow-instruction" data-testid="workflow-instruction">
              <h4>本次修改要求</h4>
              <p>{run.request.instruction}</p>
            </div>
          )}
          <p className="muted small" data-testid="workflow-counts">
            模型尝试 {state.rounds}/8 · 工具调用 {state.toolCalls}/24 · 构建 {state.builds}/6
          </p>
          <p className="muted small" data-testid="workflow-source">
            本次最近保存源码 v{run.latestRevision} · 当前源码 v{state.sourceRevision} ·{' '}
            {state.fileCount} 个文件
          </p>
          {state.changes && (
            <details
              className="workflow-changes"
              data-testid="workflow-changes"
              data-status={state.changes.status}
              open={run.request.mode === 'modify'}
            >
              <summary>
                源码变化{' '}
                <span>
                  v{state.changes.baseRevision} → v{state.changes.resultRevision}
                </span>
              </summary>
              {state.changes.status === 'unavailable' ? (
                <p className="muted small">
                  暂时无法核对文件差异，不能据此判断没有修改。请保留记录并查看源码检查点。
                </p>
              ) : state.changes.files.length === 0 ? (
                <p className="muted small">本次未产生源码差异。</p>
              ) : (
                <ul>
                  {state.changes.files.map((file) => (
                    <li key={file.path}>
                      <span>{changeNames[file.kind]}</span>
                      <code>{file.path}</code>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
          <ol className="workflow-stages" data-testid="workflow-stages">
            {run.stages.map((stage, index) => (
              <li
                key={`${stage.kind}:${stage.requestId}`}
                data-testid="workflow-stage"
                data-stage={stage.kind}
                data-status={stage.status}
              >
                <span className="workflow-stage-number">{index + 1}</span>
                <div>
                  <strong>
                    {stage.kind === 'generation' && run.request.mode === 'modify'
                      ? '修改源码'
                      : stageNames[stage.kind]}
                  </strong>
                  <span>源码 v{stage.sourceRevision}</span>
                </div>
                <span className={`workflow-stage-status is-${stage.status}`}>
                  {stageLabel(stage, run.request.mode)}
                </span>
              </li>
            ))}
          </ol>
          {run.errorCode && (
            <p className="workflow-stale" data-testid="workflow-stop-reason">
              {reasons[run.errorCode] ??
                '本次流程未能继续，请核对下方源码和检查记录，再决定下一步。'}{' '}
              <span className="muted small">（{run.errorCode}）</span>
            </p>
          )}
          {run.status === 'ready' && state.current && (
            <p className="muted small">
              请使用下方“需求、实现与验证”报告，实际操作候选并逐项记录用户核验。
            </p>
          )}
        </div>
      )}
      {!!state?.history.length && (
        <details className="workflow-history" data-testid="workflow-history">
          <summary>
            开发与修改记录 <span className="muted small">最近 {state.history.length} 条</span>
          </summary>
          <p className="muted small">
            选择记录仅查看已保存结果，不会重新执行。新的操作基于当前源码 v{state.sourceRevision}
            ；记录不会代替业务核验。
          </p>
          <ol>
            {[...state.history]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((item) => (
                <li key={item.id}>
                  <button
                    className="workflow-history-item"
                    type="button"
                    data-testid="view-workflow-history"
                    data-request-id={item.id}
                    aria-pressed={run?.id === item.id}
                    disabled={disabled || running || loading}
                    onClick={() => selectHistory(item.id)}
                  >
                    <span>
                      <strong>{modeNames[item.mode]}</strong>
                      <span>{historyStatus[item.status]}</span>
                    </span>
                    {item.instruction && (
                      <span className="workflow-history-instruction">
                        {item.instruction.length > 90
                          ? `${item.instruction.slice(0, 90)}…`
                          : item.instruction}
                      </span>
                    )}
                    <span className="muted small">
                      {dateLabel(item.createdAt)} · v{item.sourceRevision} → v{item.latestRevision}
                    </span>
                  </button>
                </li>
              ))}
          </ol>
        </details>
      )}
    </section>
  );
}
