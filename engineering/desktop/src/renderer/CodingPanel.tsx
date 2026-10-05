import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, FileCode2, LoaderCircle } from 'lucide-react';
import type { CodingRequest, CodingState } from '../shared/coding-contracts';
import { api } from './api';
import './coding.css';
import { BuildPanel } from './BuildPanel';
import type { BuildRequest, BuildResult } from '../shared/build-contracts';
import type { RepairRequest, RepairState } from '../shared/repair-contracts';
import { RecoveryPanel } from './RecoveryPanel';
import { ExportPanel } from './ExportPanel';
import type { RuntimeCheckRequest, RuntimeReport } from '../shared/runtime-contracts';
import type { ApplicationState } from '../shared/app-data-contracts';

const labels = {
  running: '正在生成源码草稿',
  draft_saved: '源码草稿已保存',
  no_changes: '本次没有源码改动',
  cancelled: '已停止，已保存的源码保留',
  failed: '本次生成未完成，已保存的源码保留',
  limited: '已达到本次上限，已保存的源码保留',
  interrupted: '上次生成被中断，未自动重试',
};
const reasons: Record<string, string> = {
  BUDGET_EXCEEDED: '已达到模型设置中的累计调用上限。',
  TOKEN_BUDGET_EXCEEDED: '开发 token 额度不足以发送下一次请求，请在模型设置中核对额度。',
  TOKEN_USAGE_UNKNOWN: '历史调用用量尚未核对，暂不能按 token 额度继续，请检查模型设置。',
  KEY_REQUIRED: '请先在模型设置中保存 API Key。',
  CREDENTIAL_UNAVAILABLE: '当前系统无法解密密钥，请在设置中重新保存。',
  AUTH_FAILED: '密钥无效或已过期，请检查模型设置。',
  QUOTA_EXCEEDED: '供应商账户余额或额度不足。',
  RATE_LIMITED: '供应商暂时限制了请求频率，请稍后再试。',
  TIMEOUT: '模型响应超时，本次请求可能已计费。',
  NETWORK_ERROR: '无法连接模型服务，本次请求可能已计费。',
  TRUNCATED_RESPONSE: '模型返回内容被截断，本轮修改未执行。',
  INVALID_RESPONSE: '模型没有返回有效的工具调用，本轮修改未执行。',
  SENSITIVE_RESPONSE: '返回内容包含敏感信息，已拒绝保存。',
  CODING_LIMIT: '本次请求轮数、工具次数或内容长度已达到上限。',
  STALE_PLAN: '开发计划已变化，请整理当前计划后再继续。',
  CONFIRMATION_REQUIRED: '需求或页面方向已变化，请先确认当前版本。',
  MODEL_CANCELLED: '取消后未再写入，已提交的修改仍保留。',
  CANCELLED: '取消后未再写入，已提交的修改仍保留。',
};

export function CodingPanel({
  projectId,
  planRunId,
  disabled,
  refreshKey = 0,
  onGenerate,
  onBuild,
  onCheckRuntime,
  onOpenApplication,
  onRepair,
}: {
  projectId: string;
  planRunId: string | null;
  disabled: boolean;
  refreshKey?: number;
  onGenerate: (input: CodingRequest) => Promise<CodingState | undefined>;
  onBuild: (input: BuildRequest) => Promise<BuildResult | undefined>;
  onCheckRuntime: (input: RuntimeCheckRequest) => Promise<RuntimeReport | undefined>;
  onOpenApplication: (input: {
    projectId: string;
    buildId: string;
  }) => Promise<ApplicationState | undefined>;
  onRepair: (input: RepairRequest) => Promise<RepairState | undefined>;
}) {
  const [state, setState] = useState<CodingState | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [exporting, setExporting] = useState(false);
  const pending = useRef<CodingRequest | null>(null);
  const locked = useRef(false);
  const generation = useRef(0);
  const fileGeneration = useRef(0);
  const lifecycle = useRef(0);

  useEffect(() => {
    lifecycle.current++;
    return () => {
      lifecycle.current++;
    };
  }, [projectId]);

  useEffect(() => {
    fileGeneration.current++;
    setFile(null);
    setReading(false);
  }, [projectId, refreshKey]);

  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await api.codingState({ projectId });
        if (current !== generation.current) return;
        if (result.ok) {
          setState(result.value);
          setError('');
          if (result.value.run?.status === 'running' || creating) timer = setTimeout(read, 800);
        } else setError(result.error.message);
      } catch {
        if (current === generation.current) setError('暂时无法读取源码记录，请重新进入开发计划。');
      }
    };
    void read();
    return () => {
      generation.current++;
      fileGeneration.current++;
      clearTimeout(timer);
    };
  }, [projectId, creating, refresh, refreshKey]);

  const generate = async () => {
    if (locked.current || disabled || recovering || exporting || !planRunId || !state) return;
    const current = lifecycle.current;
    locked.current = true;
    setCreating(true);
    setError('');
    setFile(null);
    fileGeneration.current++;
    const input =
      pending.current?.planRunId === planRunId
        ? pending.current
        : {
            schemaVersion: 1 as const,
            requestId: crypto.randomUUID(),
            projectId,
            planRunId,
          };
    pending.current = input;
    try {
      const result = await onGenerate(input);
      if (current !== lifecycle.current) return;
      if (result) {
        setState(result);
        pending.current = null;
      }
    } finally {
      if (current === lifecycle.current) {
        locked.current = false;
        setCreating(false);
        setRefresh((value) => value + 1);
      }
    }
  };
  const readFile = async (path: string) => {
    const current = ++fileGeneration.current;
    setReading(true);
    setFile(null);
    setError('');
    try {
      const result = await api.codingFile({ projectId, path });
      if (current !== fileGeneration.current) return;
      if (result.ok) setFile(result.value);
      else setError(result.error.message);
    } catch {
      if (current === fileGeneration.current) setError('暂时无法读取文件。');
    } finally {
      if (current === fileGeneration.current) setReading(false);
    }
  };
  const running = creating || state?.run?.status === 'running';
  return (
    <section
      className="coding-panel"
      aria-label="源码草稿"
      data-testid="coding-state"
      data-status={state?.run?.status ?? 'empty'}
    >
      <div className="coding-heading">
        <div>
          <h3>源码草稿</h3>
          <p>按已确认的方向生成，最多调用模型 4 轮。</p>
        </div>
        <button
          className="button primary"
          data-testid="generate-source"
          disabled={
            disabled || recovering || exporting || !planRunId || !state || !!error || running
          }
          onClick={() => void generate()}
        >
          {running ? <LoaderCircle size={16} className="spin" /> : <ArrowUpRight size={16} />}
          {running ? '正在生成' : state?.run ? '继续生成源码' : '生成源码草稿'}
        </button>
      </div>
      <p className="muted small">
        {planRunId ? '保存源码后，可在下方构建预览。' : '先确认需求、页面方向并整理当前开发计划。'}
        每次生成计入设置中的调用额度。
      </p>
      {state?.run && (
        <div className="coding-progress" role="status">
          <span>{labels[state.run.status]}</span>
          <span className="muted">
            请求轮次 {state.run.rounds}/4 · 工具调用 {state.run.toolCalls}/12
          </span>
          {state.run.errorCode && (
            <span className="muted small">
              {reasons[state.run.errorCode] ?? '请核对模型设置与项目记录后再继续。'}{' '}
              <span>（{state.run.errorCode}）</span>
            </span>
          )}
          {planRunId && state.run.planRunId !== planRunId && (
            <span className="muted small">现有草稿依据旧计划生成，尚未同步当前方向。</span>
          )}
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {!!state?.files.length && (
        <details className="coding-files" data-testid="source-files">
          <summary>
            <FileCode2 size={16} /> 查看源码{' '}
            <span className="muted">
              {state.files.length} 个文件 · 版本 {state.revision}
            </span>
          </summary>
          <div className="coding-browser">
            <nav aria-label="源码文件">
              {state.files.map((item) => (
                <button
                  key={item.path}
                  className={file?.path === item.path ? 'selected' : ''}
                  onClick={() => void readFile(item.path)}
                >
                  {item.path}
                </button>
              ))}
            </nav>
            <div className="coding-viewer">
              {reading ? (
                <p>正在读取…</p>
              ) : file ? (
                <>
                  <p>{file.path}</p>
                  <pre data-testid="source-content">
                    <code>{file.content}</code>
                  </pre>
                </>
              ) : (
                <p>选择一个文件查看内容。</p>
              )}
            </div>
          </div>
        </details>
      )}
      <RecoveryPanel
        key={projectId}
        projectId={projectId}
        planRunId={planRunId}
        revision={state?.revision ?? 0}
        refreshKey={refresh}
        disabled={disabled || exporting || !!running}
        onWorkingChange={setRecovering}
        onRestored={() => {
          pending.current = null;
          setState(null);
          setFile(null);
          setReading(false);
          fileGeneration.current++;
          setRefresh((value) => value + 1);
        }}
      />
      <ExportPanel
        key={`export:${projectId}`}
        projectId={projectId}
        planRunId={planRunId}
        revision={state?.projectId === projectId ? state.revision : 0}
        fileCount={state?.projectId === projectId ? state.files.length : 0}
        disabled={disabled || recovering || !!running || !!error}
        onWorkingChange={setExporting}
      />
      {state && (state.files.length > 0 || state.revision > 0) && (
        <BuildPanel
          projectId={projectId}
          planRunId={planRunId}
          revision={state.revision}
          hasSource={state.files.length > 0}
          disabled={disabled || recovering || exporting || !!running}
          refreshKey={refresh}
          onBuild={async (input) => {
            const current = lifecycle.current;
            try {
              return await onBuild(input);
            } finally {
              if (current === lifecycle.current) setRefresh((value) => value + 1);
            }
          }}
          onRepair={onRepair}
          onCheckRuntime={onCheckRuntime}
          onOpenApplication={onOpenApplication}
          onSourceChanged={() => {
            setFile(null);
            setReading(false);
            fileGeneration.current++;
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
