import { useEffect, useRef, useState } from 'react';
import { Wrench, LoaderCircle } from 'lucide-react';
import type { RepairRequest, RepairState } from '../shared/repair-contracts';
import { api } from './api';

const labels = {
  running: '正在修复',
  succeeded: '源码已通过重新编译，可打开预览检查实际功能。',
  limited: '已达到本次上限，修复已停止。',
  no_progress: '本次没有完成修复，已停止继续请求。',
  cancelled: '已停止修复，已保存的源码保留。',
  failed: '本次修复未完成，之前的成功产物保留。',
  interrupted: '上次修复被中断，没有自动继续调用模型。',
};
const reasons: Record<string, string> = {
  KEY_REQUIRED: '请先在模型设置中保存 API Key。',
  AUTH_FAILED: '密钥无效或已过期，请检查模型设置。',
  CREDENTIAL_UNAVAILABLE: '当前系统无法读取密钥，请检查模型设置。',
  BUDGET_EXCEEDED: '已达到模型设置中的累计调用上限。',
  TOKEN_BUDGET_EXCEEDED: '开发 token 额度不足以发送下一次请求，请在模型设置中核对额度。',
  TOKEN_USAGE_UNKNOWN: '历史调用用量尚未核对，暂不能按 token 额度继续，请检查模型设置。',
  QUOTA_EXCEEDED: '供应商账户余额或额度不足。',
  RATE_LIMITED: '供应商限制了请求频率，请稍后再试。',
  NETWORK_ERROR: '模型连接失败，本次请求可能已计费。',
  TIMEOUT: '等待超时，未自动重试；已发出的模型请求可能已计费。',
  STALE_SOURCE: '源码版本已经变化，请核对当前文件后再继续。',
  STALE_PLAN: '开发计划已变化，请先整理当前计划。',
  CONFIRMATION_REQUIRED: '需求或方向已经变化，请先确认当前版本。',
  REPAIR_LIMIT: '已达到轮次、工具次数或内容长度上限。',
  SENSITIVE_RESPONSE: '模型返回了敏感内容，已拒绝保存。',
  STALE_RUNTIME: '运行错误记录已失效，请先检查当前页面启动。',
  RUNTIME_CANCELLED: '启动检查已停止，已保存的源码保留。',
  RUNTIME_INTERRUPTED: '启动检查被中断，请先重新检查当前页面启动。',
  RUNTIME_NOT_REPRODUCED: '本次启动未复现原问题，尚未验证原交互错误。',
};

export function RepairPanel({
  projectId,
  planRunId,
  revision,
  refreshKey,
  disabled,
  enabled,
  onRepair,
  onFinished,
}: {
  projectId: string;
  planRunId: string | null;
  revision: number;
  refreshKey: number;
  disabled: boolean;
  enabled: boolean;
  onRepair: (input: RepairRequest) => Promise<RepairState | undefined>;
  onFinished: () => Promise<void>;
}) {
  const [state, setState] = useState<RepairState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<RepairRequest | null>(null);
  const locked = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await api.repairState({ projectId });
        if (current !== generation.current) return;
        if (result.ok) {
          setState(result.value);
          setError('');
          if (working || result.value.run?.status === 'running') timer = setTimeout(read, 800);
        } else setError(result.error.message);
      } catch {
        if (current === generation.current) setError('暂时无法读取修复记录，请重新进入开发计划。');
      }
    };
    void read();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [projectId, working, revision, refreshKey, disabled]);

  const repair = async () => {
    if (locked.current || disabled || !planRunId || !revision) return;
    locked.current = true;
    setWorking(true);
    setError('');
    const input =
      pending.current?.planRunId === planRunId
        ? pending.current
        : {
            schemaVersion: 1 as const,
            requestId: crypto.randomUUID(),
            projectId,
            planRunId,
            sourceRevision: revision,
          };
    pending.current = input;
    try {
      const result = await onRepair(input);
      if (result) {
        setState(result);
        pending.current = null;
      }
      await onFinished();
    } catch {
      setError('修复状态暂未确认，已保存的源码和成功产物仍保留。');
    } finally {
      locked.current = false;
      setWorking(false);
    }
  };
  const run = state?.run;
  if (!enabled && !run && !error && !working) return null;
  const retry =
    !!run && !run.runtimeReportId && run.status !== 'succeeded' && run.status !== 'running';
  return (
    <div className="repair-panel" data-testid="repair-state" data-status={run?.status ?? 'empty'}>
      {(enabled || retry || working) && (
        <div className="repair-entry">
          <button
            className="button compact"
            data-testid="repair-source"
            disabled={disabled || working || !planRunId || !revision || !!error}
            onClick={() => void repair()}
          >
            {working ? <LoaderCircle size={15} className="spin" /> : <Wrench size={15} />}
            {working ? '正在修复' : '自动修复并构建'}
          </button>
          <span className="muted small">需要时调用模型，最多 4 轮、3 分钟，计入设置中的额度。</span>
        </div>
      )}
      {run && (
        <div className="coding-progress" role="status">
          <span>
            {run.status === 'running'
              ? run.phase === 'runtime_checking'
                ? '正在重新检查页面启动'
                : run.phase === 'checking'
                  ? '正在重新编译检查'
                  : '正在请求模型修复'
              : run.status === 'no_progress' && run.errorCode === 'RUNTIME_NOT_REPRODUCED'
                ? '本次启动未复现原问题，尚未验证原交互错误。'
                : run.status === 'succeeded' && run.runtimeReportId
                  ? '源码已通过重新编译，启动观察期未发现错误；实际功能仍需检查。'
                  : labels[run.status]}
          </span>
          <span className="muted small">
            修复轮次 {run.rounds}/4 · 工具调用 {run.toolCalls}/12 · 构建 {run.builds}/5
          </span>
          {run.errorCode && run.errorCode !== 'RUNTIME_NOT_REPRODUCED' && (
            <span className="muted small">
              {reasons[run.errorCode] ?? '可核对模型设置和源码后重新尝试。'}（{run.errorCode}）
            </span>
          )}
          {run.planRunId !== planRunId && (
            <span className="muted small">这份修复记录对应此前的开发计划。</span>
          )}
          {run.latestRevision !== revision && (
            <span className="muted small">源码已更新，上次修复结果不代表当前版本。</span>
          )}
          {!!run.diagnostics.length && run.status !== 'succeeded' && (
            <details>
              <summary>查看最近一次构建问题</summary>
              <ul>
                {run.diagnostics.map((item, index) => (
                  <li key={index}>
                    {item.path ? `${item.path}${item.line ? `:${item.line}` : ''} · ` : ''}
                    {item.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
