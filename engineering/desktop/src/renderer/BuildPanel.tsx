import { useEffect, useRef, useState } from 'react';
import { Play, Square, LoaderCircle } from 'lucide-react';
import type {
  BuildDiagnostic,
  BuildRequest,
  BuildResult,
  BuildState,
} from '../shared/build-contracts';
import { api } from './api';
import type { RepairRequest, RepairState } from '../shared/repair-contracts';
import { RepairPanel } from './RepairPanel';
import { RuntimePanel } from './RuntimePanel';
import type { RuntimeCheckRequest, RuntimeReport } from '../shared/runtime-contracts';
import type { ApplicationState } from '../shared/app-data-contracts';

export function BuildPanel({
  projectId,
  planRunId,
  revision,
  hasSource,
  refreshKey,
  disabled,
  onBuild,
  onRepair,
  onCheckRuntime,
  onOpenApplication,
  onSourceChanged,
}: {
  projectId: string;
  planRunId: string | null;
  revision: number;
  hasSource: boolean;
  refreshKey: number;
  disabled: boolean;
  onBuild: (input: BuildRequest) => Promise<BuildResult | undefined>;
  onRepair: (input: RepairRequest) => Promise<RepairState | undefined>;
  onCheckRuntime: (input: RuntimeCheckRequest) => Promise<RuntimeReport | undefined>;
  onOpenApplication: (input: {
    projectId: string;
    buildId: string;
  }) => Promise<ApplicationState | undefined>;
  onSourceChanged: () => void;
}) {
  const [state, setState] = useState<BuildState | null>(null);
  const [diagnostics, setDiagnostics] = useState<BuildDiagnostic[]>([]);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [runtimeRefresh, setRuntimeRefresh] = useState(0);
  const [application, setApplication] = useState<ApplicationState | null>(null);
  const [applicationError, setApplicationError] = useState('');
  const [applicationWorking, setApplicationWorking] = useState(false);
  const [applicationRefresh, setApplicationRefresh] = useState(0);
  const locked = useRef(false);
  const mounted = useRef(true);
  const lifecycle = useRef(0);
  useEffect(() => {
    lifecycle.current++;
    return () => {
      lifecycle.current++;
    };
  }, [projectId]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const read = async () => {
      try {
        const result = await api.buildState({ projectId });
        if (!active) return;
        if (result.ok) setState(result.value);
        else setError(result.error.message);
      } catch {
        if (active) setError('暂时无法读取构建记录，请重新进入开发计划。');
      }
    };
    void read();
    const timer =
      state?.preview === 'open'
        ? setInterval(() => {
            if (document.visibilityState === 'visible') void read();
          }, 2000)
        : undefined;
    return () => {
      active = false;
      mounted.current = false;
      clearInterval(timer);
    };
  }, [projectId, revision, planRunId, refreshKey, state?.preview]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await api.applicationState({ projectId });
        if (!active) return;
        if (result.ok) {
          setApplication(result.value);
          if (result.value.status === 'running') timer = setTimeout(() => void read(), 1500);
        } else setApplicationError(result.error.message);
      } catch {
        if (active) setApplicationError('暂时无法读取本地应用状态，请重试读取。');
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, refreshKey, applicationRefresh, disabled]);

  useEffect(() => {
    setDiagnostics([]);
    setCancelled(false);
  }, [projectId, revision]);

  const preview = async (buildId: string) => {
    try {
      const result = await api.openPreview({ projectId, buildId });
      if (!mounted.current) return;
      if (result.ok) setState(result.value);
      else setError(result.error.message);
    } finally {
      if (mounted.current) setRuntimeRefresh((value) => value + 1);
    }
  };
  const refreshAfterRepair = async () => {
    onSourceChanged();
    const result = await api.buildState({ projectId });
    if (!mounted.current) return;
    if (result.ok) {
      setState(result.value);
      if (result.value.status === 'current') setDiagnostics([]);
    } else setError(result.error.message);
    setRuntimeRefresh((value) => value + 1);
  };
  const build = async () => {
    if (locked.current || disabled || !planRunId || !revision || !hasSource) return;
    locked.current = true;
    setWorking(true);
    setError('');
    setDiagnostics([]);
    setCancelled(false);
    try {
      const result = await onBuild({
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        projectId,
        planRunId,
        sourceRevision: revision,
      });
      if (!mounted.current || !result) return;
      setState(result.state);
      setDiagnostics(result.diagnostics);
      setCancelled(result.status === 'cancelled');
      if (result.status === 'succeeded' && result.state.artifact)
        await preview(result.state.artifact.id);
    } catch {
      if (mounted.current) setError('构建或预览未完成，已有源码和成功产物保留。');
    } finally {
      locked.current = false;
      if (mounted.current) setWorking(false);
    }
  };
  const open = async () => {
    if (!state?.artifact || locked.current || disabled) return;
    locked.current = true;
    setWorking(true);
    setError('');
    try {
      await preview(state.artifact.id);
    } catch {
      setError('预览未能打开，构建产物仍保留。');
    } finally {
      locked.current = false;
      setWorking(false);
    }
  };
  const stop = async () => {
    setError('');
    try {
      const result = await api.closePreview({ projectId });
      if (result.ok) setState(result.value);
      else setError(result.error.message);
    } catch {
      setError('暂时无法关闭预览。');
    }
  };
  const actApplication = async (close: boolean) => {
    if (locked.current || disabled || working || applicationWorking) return;
    const artifact = state?.artifact;
    if (
      close
        ? application?.status !== 'running'
        : !artifact ||
          state?.status !== 'current' ||
          artifact.sourceRevision !== revision ||
          artifact.planRunId !== planRunId
    )
      return;
    locked.current = true;
    const generation = lifecycle.current;
    setApplicationWorking(true);
    setApplicationError('');
    try {
      if (close) {
        const result = await api.closeApplication({ projectId });
        if (generation !== lifecycle.current) return;
        if (result.ok) setApplication(result.value);
        else setApplicationError(result.error.message);
      } else {
        const result = await onOpenApplication({ projectId, buildId: artifact!.id });
        if (generation !== lifecycle.current) return;
        if (result) setApplication(result);
        else setApplicationError('本地应用未能打开，原应用和已保存内容保留。请核对启动记录。');
      }
    } catch {
      if (generation === lifecycle.current)
        setApplicationError('操作结果暂未确认，请先重新读取本地应用状态。');
    } finally {
      if (generation === lifecycle.current) {
        locked.current = false;
        setApplicationWorking(false);
        setApplicationRefresh((value) => value + 1);
        setRuntimeRefresh((value) => value + 1);
      }
    }
  };
  const panelBusy = disabled || working || applicationWorking;
  const currentArtifact =
    state?.status === 'current' &&
    state.artifact?.sourceRevision === revision &&
    state.artifact.planRunId === planRunId;
  return (
    <section
      className="build-panel"
      aria-label="页面预览"
      data-testid="build-state"
      data-status={state?.status ?? 'loading'}
    >
      <div className="coding-heading">
        <div>
          <h3>页面预览</h3>
          <p>把当前源码构建成可以操作的页面，不调用模型。</p>
        </div>
        <button
          className="button primary"
          data-testid="build-source"
          onClick={() => void build()}
          disabled={panelBusy || !planRunId || !revision || !hasSource}
        >
          {working ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}{' '}
          {working ? '正在处理' : '构建并预览'}
        </button>
      </div>
      <p className="muted small">
        预览使用临时数据；本地应用可保存内容，是否支持保存取决于生成的功能。编译通过后，仍需检查功能和交互。
      </p>
      {state?.artifact && (
        <div className="build-actions">
          <span className="muted small">
            {state.status === 'current' ? '当前源码已构建' : '保留上次成功构建'} · 源码版本{' '}
            {state.artifact.sourceRevision}
          </span>
          <button
            className="button compact"
            disabled={panelBusy || state.artifact.planRunId !== planRunId}
            onClick={() => void open()}
          >
            {state.preview === 'open'
              ? state.previewBuildId === state.artifact.id
                ? '显示预览窗口'
                : '打开最新预览'
              : state.status === 'current'
                ? '打开预览'
                : '查看上次预览'}
          </button>
          {state.preview === 'open' && (
            <button className="button compact" disabled={panelBusy} onClick={() => void stop()}>
              <Square size={13} /> 关闭预览
            </button>
          )}
        </div>
      )}
      <section
        className="application-panel"
        aria-label="本地应用"
        data-testid="application-state"
        data-status={application?.status ?? 'loading'}
      >
        <div className="runtime-feedback-heading">
          <h4>本地应用</h4>
          <div className="application-actions">
            <button
              className="button compact"
              data-testid="open-application"
              disabled={panelBusy || !currentArtifact}
              onClick={() => void actApplication(false)}
            >
              {applicationWorking ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Play size={15} />
              )}
              {applicationWorking
                ? '正在处理'
                : application?.status === 'running' && application.buildId === state?.artifact?.id
                  ? '显示本地应用'
                  : '打开本地应用'}
            </button>
            {application?.status === 'running' && (
              <button
                className="button compact"
                data-testid="close-application"
                disabled={panelBusy}
                onClick={() => void actApplication(true)}
              >
                <Square size={13} />
                关闭本地应用
              </button>
            )}
          </div>
        </div>
        <p className="muted small" role="status">
          {!application
            ? '正在核对本地应用状态。'
            : application.status === 'running'
              ? `本地应用正在运行${application.buildId !== state?.artifact?.id ? '，对应此前构建' : ''}。关闭后，已保存内容保留。`
              : '尚未打开本地应用。保存的内容属于当前项目，与临时预览分开。'}
        </p>
        {!currentArtifact && (
          <p className="muted small">请先构建当前源码与确认方向，再打开本地应用。</p>
        )}
        {applicationError && (
          <div className="recovery-error">
            <p className="field-error" role="alert">
              {applicationError}
            </p>
            <button
              className="button compact"
              disabled={panelBusy}
              onClick={() => {
                setApplicationError('');
                setApplicationRefresh((value) => value + 1);
              }}
            >
              重新读取状态
            </button>
          </div>
        )}
      </section>
      {cancelled && (
        <p className="muted" role="status">
          构建已取消或超时，之前的成功产物仍保留。
        </p>
      )}
      {!!diagnostics.length && (
        <div className="error-box" role="alert" data-testid="build-diagnostics">
          <strong>本次构建未通过</strong>
          <ul>
            {diagnostics.map((item, index) => (
              <li key={index}>
                {item.path ? `${item.path}${item.line ? `:${item.line}` : ''} · ` : ''}
                {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <RepairPanel
        projectId={projectId}
        planRunId={planRunId}
        revision={revision}
        refreshKey={refreshKey}
        disabled={panelBusy}
        enabled={!!diagnostics.length}
        onRepair={onRepair}
        onFinished={refreshAfterRepair}
      />
      <RuntimePanel
        projectId={projectId}
        planRunId={planRunId}
        revision={revision}
        build={state}
        refreshKey={refreshKey + runtimeRefresh}
        disabled={panelBusy}
        onCheck={onCheckRuntime}
        onRepair={onRepair}
        onFinished={refreshAfterRepair}
      />
      {!!state?.artifact?.warnings.length && (
        <details className="build-warnings">
          <summary>构建提示（{state.artifact.warnings.length}）</summary>
          <ul>
            {state.artifact.warnings.map((item, index) => (
              <li key={index}>
                {item.path} {item.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
