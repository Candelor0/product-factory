import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Play,
  Square,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import type { BlogRuntimeStatus, Project } from '../shared/contracts';
import type { BuildState } from '../shared/build-contracts';
import type { RepairRequest, RepairState } from '../shared/repair-contracts';
import {
  runtimeIssueMessages,
  type RuntimeCheckRequest,
  type RuntimeReport,
  type RuntimeState,
} from '../shared/runtime-contracts';
import { api } from './api';

export function BlogRuntimePanel({ project, disabled }: { project: Project; disabled: boolean }) {
  const [state, setState] = useState<BlogRuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await api.blogStatus({ projectId: project.id });
        if (!active) return;
        if (result.ok) setState(result.value);
        else setError(result.error.message);
      } catch {
        if (active) setError('暂时无法读取运行状态，请稍后重试。');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [project.id]);
  const act = async (stop: boolean) => {
    setBusy(true);
    setError('');
    try {
      const result = await (stop ? api.stopBlog : api.startBlog)({ projectId: project.id });
      if (result.ok) setState(result.value);
      else setError(result.error.message);
    } catch {
      setError('操作未完成，请重试。已经保存的文章会保留。');
    } finally {
      setBusy(false);
    }
  };
  const running = state?.status === 'running';
  return (
    <section className="content-stack runtime-panel" aria-label="博客运行样例">
      <div className="tool-panel-heading">
        <div className="tool-panel-title">
          <h2>运行样例</h2>
          <span className={`runtime-status ${running ? 'is-running' : ''}`} role="status">
            <span aria-hidden="true" />
            {running ? '正在运行' : '已停止'}
          </span>
        </div>
      </div>
      <p className="runtime-introduction">
        固定博客模板，非按当前需求生成；不调用模型，不改变确认状态。
      </p>
      <div className="runtime-sample">
        <div className="runtime-sample-heading">
          <span className="runtime-sample-icon">
            <BookOpen size={22} aria-hidden="true" />
          </span>
          <div>
            <h3>博客样例</h3>
            <p>文章编辑 · 草稿与发布 · 标签浏览</p>
          </div>
        </div>
        <div className="runtime-sample-actions">
          <button
            className="button primary"
            data-testid="start-blog"
            disabled={busy || disabled || project.archived}
            onClick={() => void act(false)}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : running ? (
              <ExternalLink size={16} />
            ) : (
              <Play size={16} />
            )}{' '}
            {running ? '打开博客样例' : '启动博客样例'}
          </button>
          <button
            className="button"
            data-testid="stop-blog"
            disabled={busy || disabled || !running}
            onClick={() => void act(true)}
          >
            <Square size={15} />
            停止
          </button>
        </div>
      </div>
      <p className="runtime-lifecycle-note">
        文章保存在当前项目中。关闭窗口、归档或退出工作台会停止样例；已保存内容会保留。
      </p>
      {error && (
        <div className="info-strip" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

const runtimeLabels: Record<RuntimeReport['status'], string> = {
  observing: '正在观察页面启动',
  observed: '启动观察期未发现错误',
  issues: '已记录页面运行错误',
  cancelled: '检查已取消，未得出通过结论',
  interrupted: '上次检查已中断，未自动重试',
};

export function RuntimePanel({
  projectId,
  planRunId,
  revision,
  build,
  refreshKey,
  disabled,
  onCheck,
  onRepair,
  onFinished,
}: {
  projectId: string;
  planRunId: string | null;
  revision: number;
  build: BuildState | null;
  refreshKey: number;
  disabled: boolean;
  onCheck: (input: RuntimeCheckRequest) => Promise<RuntimeReport | undefined>;
  onRepair: (input: RepairRequest) => Promise<RepairState | undefined>;
  onFinished: () => Promise<void>;
}) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [working, setWorking] = useState<'check' | 'repair' | null>(null);
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const pendingCheck = useRef<RuntimeCheckRequest | null>(null);
  const pendingRepair = useRef<RepairRequest | null>(null);
  const locked = useRef(false);
  const lifecycle = useRef(0);
  const callbacks = useRef({ onFinished });
  callbacks.current = { onFinished };

  useEffect(() => {
    lifecycle.current++;
    setState(null);
    setReadError('');
    setActionError('');
    pendingCheck.current = null;
    pendingRepair.current = null;
    return () => {
      lifecycle.current++;
    };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRefreshing(true);
    const read = async () => {
      try {
        const result = await api.runtimeState({ projectId });
        if (!active) return;
        if (result.ok) {
          setState(result.value);
          setReadError('');
        } else setReadError(result.error.message);
      } catch {
        if (active) setReadError('暂时无法读取启动检查记录，请重试读取。');
      } finally {
        if (active) {
          setRefreshing(false);
          // Reports can finish after a preview fails to open, so poll even without a window.
          timer = setTimeout(() => void read(), 1500);
        }
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, planRunId, revision, build?.artifact?.id, refreshKey, disabled, reload]);

  const artifact = build?.artifact;
  const currentBuild = !!(
    artifact &&
    build?.status === 'current' &&
    artifact.sourceRevision === revision &&
    artifact.planRunId === planRunId
  );
  const report = state?.report;
  const currentReport = !!(
    state?.current &&
    currentBuild &&
    report &&
    artifact &&
    report.buildId === artifact.id &&
    report.artifactHash === artifact.artifactHash &&
    report.sourceRevision === revision &&
    report.sourceHash === artifact.sourceHash &&
    report.planRunId === planRunId &&
    report.planInputHash === artifact.planInputHash &&
    report.planArtifactHash === artifact.planArtifactHash
  );
  const canRepair = currentReport && report?.status === 'issues' && !!report.issues.length;
  const busy = disabled || !!working;

  const act = async (kind: 'check' | 'repair') => {
    if (
      locked.current ||
      busy ||
      refreshing ||
      readError ||
      !artifact ||
      !currentBuild ||
      !planRunId ||
      (kind === 'repair' && !canRepair)
    )
      return;
    locked.current = true;
    const generation = lifecycle.current;
    setWorking(kind);
    setActionError('');
    try {
      if (kind === 'check') {
        const input =
          pendingCheck.current?.buildId === artifact.id
            ? pendingCheck.current
            : {
                schemaVersion: 1 as const,
                requestId: crypto.randomUUID(),
                projectId,
                buildId: artifact.id,
              };
        pendingCheck.current = input;
        const result = await onCheck(input);
        if (generation !== lifecycle.current) return;
        if (result) pendingCheck.current = null;
        else setActionError('检查未完成或结果尚待核对。已有源码与产物保留。');
      } else {
        const input =
          pendingRepair.current?.runtimeReportId === report!.id &&
          pendingRepair.current.sourceRevision === revision
            ? pendingRepair.current
            : {
                schemaVersion: 1 as const,
                requestId: crypto.randomUUID(),
                projectId,
                planRunId,
                sourceRevision: revision,
                runtimeReportId: report!.id,
              };
        pendingRepair.current = input;
        const result = await onRepair(input);
        if (generation !== lifecycle.current) return;
        if (result) pendingRepair.current = null;
        else setActionError('运行错误修复未完成或结果尚待核对，请先查看修复记录。');
        await callbacks.current.onFinished();
      }
    } catch {
      if (generation === lifecycle.current)
        setActionError('操作结果尚未确认，请核对下方记录后重试。');
    } finally {
      if (generation === lifecycle.current) {
        locked.current = false;
        setWorking(null);
        setReload((value) => value + 1);
      }
    }
  };

  return (
    <section
      className="runtime-feedback"
      aria-label="页面启动检查"
      data-testid="runtime-state"
      data-status={report?.status ?? 'empty'}
      data-current={currentReport}
      aria-busy={!!working || (currentReport && report?.status === 'observing')}
    >
      <div className="runtime-feedback-heading">
        <h4>页面启动检查</h4>
        <button
          className="button compact"
          data-testid="check-runtime"
          disabled={
            busy ||
            refreshing ||
            !!readError ||
            !currentBuild ||
            (currentReport && report?.status === 'observing')
          }
          onClick={() => void act('check')}
        >
          {working === 'check' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
          {working === 'check' ? '正在检查启动' : '检查当前页面启动'}
        </button>
      </div>
      <p className="muted small">
        检查当前构建的页面启动，不调用模型；观察期未发现错误不等于业务验收，也不覆盖所有交互。
      </p>
      {!currentBuild && (
        <p className="muted small">
          {artifact ? '源码或确认方向已有变化，请先构建当前版本。' : '先构建源码，再检查页面启动。'}
        </p>
      )}
      {report ? (
        <div className="runtime-observation" role="status">
          <p>
            {!currentReport && '此前记录：'}
            {runtimeLabels[report.status]}
          </p>
          <p className="muted small">
            源码版本 {report.sourceRevision} ·{' '}
            {report.mode === 'preview'
              ? '临时预览记录'
              : report.mode === 'application'
                ? '本地应用窗口记录'
                : '主动启动检查'}{' '}
            · {new Date(report.updatedAt).toLocaleString('zh-CN', { hour12: false })}
          </p>
          {!currentReport && (
            <p className="muted small" data-testid="runtime-stale">
              这份记录对应此前的源码、构建或确认方向，不能用于当前版本的修复。
            </p>
          )}
          {!!report.issues.length && (
            <ul data-testid="runtime-issues">
              {report.issues.map((issue) => (
                <li key={issue}>{runtimeIssueMessages[issue]}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="muted small">{refreshing ? '正在读取启动检查记录…' : '尚无启动检查记录。'}</p>
      )}
      {canRepair && (
        <div className="repair-entry">
          <button
            className="button compact"
            data-testid="repair-runtime"
            disabled={busy || refreshing || !!readError}
            onClick={() => void act('repair')}
          >
            {working === 'repair' ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Wrench size={15} />
            )}
            {working === 'repair' ? '正在尝试修复' : '尝试修复并检查启动'}
          </button>
          <span className="muted small">
            主动开始一轮修复，最多 4 轮模型、3 分钟，计入设置中的额度。
          </span>
        </div>
      )}
      {readError && (
        <div className="recovery-error">
          <p className="field-error" role="alert">
            {readError}
          </p>
          <button
            className="button compact"
            disabled={busy || refreshing}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={14} />
            重试读取
          </button>
        </div>
      )}
      {actionError && (
        <p className="field-error" role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}
