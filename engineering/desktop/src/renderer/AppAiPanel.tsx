import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react';
import type { AppAiConnection, AppAiState } from '../shared/app-ai-contracts';
import { api } from './api';
import './app-ai.css';

const labels: Record<AppAiState['status'], string> = {
  unauthorized: '未授权',
  authorized: '已授权',
  revoked: '已撤销',
  stale: '授权已失效',
  limited: '已达到额度',
  unavailable: '连接暂不可用',
};
const connectionName = (connection: AppAiConnection) =>
  `${connection.provider === 'deepseek' ? 'DeepSeek' : '自定义服务'} · ${connection.model}`;
const integerInRange = (value: string, maximum: number) =>
  value.trim() !== '' &&
  Number.isInteger(Number(value)) &&
  Number(value) >= 1 &&
  Number(value) <= maximum;

export function AppAiPanel({
  projectId,
  planRunId,
  archived,
  disabled,
  onWorkingChange,
}: {
  projectId: string;
  planRunId: string | null;
  archived: boolean;
  disabled: boolean;
  onWorkingChange: (working: boolean) => void;
}) {
  const [state, setState] = useState<AppAiState | null>(null);
  const [purpose, setPurpose] = useState('');
  const [maxCalls, setMaxCalls] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<'grant' | 'revoke' | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const lifecycle = useRef(0);
  const reads = useRef(0);
  const locked = useRef(false);
  const initialised = useRef(false);
  const callback = useRef(onWorkingChange);
  callback.current = onWorkingChange;

  const acceptState = (next: AppAiState, replaceDraft = false) => {
    setState(next);
    if (!initialised.current || replaceDraft) {
      setPurpose(next.grant?.purpose ?? '');
      setMaxCalls(next.grant ? String(next.grant.maxCalls) : '');
      setMaxTokens(next.grant ? String(next.grant.maxTokens) : '');
      initialised.current = true;
    }
  };
  useEffect(() => {
    lifecycle.current++;
    initialised.current = false;
    locked.current = false;
    setState(null);
    setPurpose('');
    setMaxCalls('');
    setMaxTokens('');
    setWorking(null);
    setReadError('');
    setActionError('');
    setNotice('');
    return () => {
      lifecycle.current++;
      reads.current++;
      callback.current(false);
    };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const read = async () => {
      if (locked.current) {
        timer = setTimeout(() => void read(), 2000);
        return;
      }
      const current = ++reads.current;
      try {
        const response = await api.appAiState({ projectId });
        if (!active || current !== reads.current) return;
        if (response.ok) {
          acceptState(response.value);
          setReadError('');
        } else setReadError(response.error.message);
      } catch {
        if (active && current === reads.current)
          setReadError('暂时无法读取应用 AI 授权，请重新读取。');
      } finally {
        if (active) {
          if (current === reads.current) setLoading(false);
          timer = setTimeout(() => void read(), 2000);
        }
      }
    };
    void read();
    return () => {
      active = false;
      reads.current++;
      clearTimeout(timer);
    };
  }, [projectId, planRunId, disabled, reload]);

  const purposeBytes = new TextEncoder().encode(purpose.trim()).length;
  const valid =
    purposeBytes > 0 &&
    purposeBytes <= 500 &&
    integerInRange(maxCalls, 1000) &&
    integerInRange(maxTokens, 100000000);
  const unchanged =
    state?.status === 'authorized' &&
    state.grant?.purpose === purpose.trim() &&
    state.grant.maxCalls === Number(maxCalls) &&
    state.grant.maxTokens === Number(maxTokens);
  const grantDisabled =
    disabled ||
    archived ||
    loading ||
    !!readError ||
    !!working ||
    !state?.hasKey ||
    !planRunId ||
    !valid ||
    unchanged;
  const act = async (kind: 'grant' | 'revoke', event?: FormEvent) => {
    event?.preventDefault();
    if (locked.current || (kind === 'grant' ? grantDisabled : !state?.grant?.enabled)) return;
    const current = lifecycle.current;
    locked.current = true;
    reads.current++;
    setWorking(kind);
    setActionError('');
    setNotice('');
    callback.current(true);
    try {
      const response =
        kind === 'revoke'
          ? await api.revokeAppAi({ projectId })
          : await api.grantAppAi({
              schemaVersion: 1,
              projectId,
              planRunId: planRunId!,
              expectedRevision: state!.revision,
              connectionId: state!.connection.id,
              purpose: purpose.trim(),
              maxCalls: Number(maxCalls),
              maxTokens: Number(maxTokens),
            });
      if (current !== lifecycle.current) return;
      if (response.ok) {
        acceptState(response.value, true);
        setNotice(
          kind === 'revoke'
            ? '授权已撤销，后续调用已停止；已发送请求可能仍计费。'
            : '本项目授权与额度已保存，累计用量保留。',
        );
      } else setActionError(response.error.message);
    } catch {
      if (current === lifecycle.current)
        setActionError('操作结果暂未确认，请重新读取授权状态后再操作。');
    } finally {
      if (current === lifecycle.current) {
        locked.current = false;
        setWorking(null);
        callback.current(false);
        setReload((value) => value + 1);
      }
    }
  };
  return (
    <section
      className="app-ai-panel"
      aria-label="应用 AI 授权"
      data-testid="app-ai-state"
      data-status={readError ? 'error' : (state?.status ?? 'loading')}
      aria-busy={!!working}
    >
      <details className="app-ai-details" data-testid="app-ai-details">
        <summary>
          <ChevronRight className="app-ai-chevron" size={16} />
          <span>应用 AI 授权</span>
          <span className="muted">
            {readError ? '读取失败' : state ? labels[state.status] : '正在读取'}
          </span>
        </summary>
        <div className="app-ai-content">
          <p className="muted small">
            仅用于本项目应用自身的文本 AI
            功能。授权和调整额度不调用模型，开发额度与本项目额度分别累计，重启或重新授权不会清零。
          </p>
          {state && (
            <>
              <dl className="app-ai-connections">
                <div>
                  <dt>当前模型连接</dt>
                  <dd data-testid="app-ai-current-connection">
                    {connectionName(state.connection)}
                    <span>{state.connection.baseUrl}</span>
                  </dd>
                </div>
                {state.grant && (
                  <div>
                    <dt>{state.grant.enabled ? '已授权连接' : '上次授权连接'}</dt>
                    <dd data-testid="app-ai-granted-connection">
                      {connectionName(state.grant.connection)}
                      <span>{state.grant.connection.baseUrl}</span>
                    </dd>
                  </div>
                )}
              </dl>
              {state.status === 'stale' && (
                <p className="app-ai-warning" role="status">
                  模型连接或确认计划已变化，原授权已失效。请核对当前连接和用途后重新授权。
                </p>
              )}
              {state.status === 'limited' && (
                <p className="app-ai-warning" role="status">
                  本项目调用额度或 token 额度已到上限，新调用已暂停。
                </p>
              )}
              {!state.hasKey && (
                <p className="app-ai-warning">
                  请先在「模型与设置」保存可用的模型连接，再授权本项目。
                </p>
              )}
              {archived ? (
                <p className="muted small">项目已归档，不能新增授权；仍可撤销已有授权。</p>
              ) : (
                !planRunId && (
                  <p className="muted small">请先确认需求和页面方向，再整理当前开发计划。</p>
                )
              )}
              <dl className="app-ai-usage" data-testid="app-ai-usage">
                <div>
                  <dt>累计调用</dt>
                  <dd>
                    {state.usage.calls.toLocaleString()}
                    {state.grant ? ` / ${state.grant.maxCalls.toLocaleString()}` : ''} 次
                  </dd>
                </div>
                <div>
                  <dt>token 额度已占用</dt>
                  <dd>
                    {state.budgetTokens.toLocaleString()}
                    {state.grant ? ` / ${state.grant.maxTokens.toLocaleString()}` : ''}
                  </dd>
                </div>
                <div>
                  <dt>供应商返回的已知 token</dt>
                  <dd>{(state.usage.inputTokens + state.usage.outputTokens).toLocaleString()}</dd>
                </div>
              </dl>
              {state.usage.unknownUsageCalls > 0 && (
                <p className="app-ai-warning">
                  {state.usage.unknownUsageCalls}{' '}
                  次调用未返回完整用量，继续按预留额度占用，实际用量仍待核对。
                </p>
              )}
              <p className="muted small">
                额度已占用包括仍在等待或用量未知的请求，不能当作实际费用。费用以供应商账单为准。
              </p>
              <form className="app-ai-form" onSubmit={(event) => void act('grant', event)}>
                <label>
                  用途
                  <textarea
                    data-testid="app-ai-purpose"
                    rows={2}
                    value={purpose}
                    maxLength={500}
                    placeholder="例如：为文章生成摘要"
                    disabled={disabled || archived || !!working}
                    onChange={(event) => setPurpose(event.target.value)}
                    required
                  />
                </label>
                {purposeBytes > 500 && (
                  <p className="field-error">用途说明过长，请缩短后再保存。</p>
                )}
                <div className="app-ai-limits">
                  <label>
                    本项目累计调用额度
                    <input
                      data-testid="app-ai-call-limit"
                      type="number"
                      min={1}
                      max={1000}
                      step={1}
                      value={maxCalls}
                      required
                      disabled={disabled || archived || !!working}
                      onChange={(event) => setMaxCalls(event.target.value)}
                    />
                  </label>
                  <label>
                    本项目累计 token 额度
                    <input
                      data-testid="app-ai-token-limit"
                      type="number"
                      min={1}
                      max={100000000}
                      step={1}
                      value={maxTokens}
                      required
                      disabled={disabled || archived || !!working}
                      onChange={(event) => setMaxTokens(event.target.value)}
                    />
                  </label>
                </div>
                <p className="app-ai-consent">
                  授权后，持久本地应用运行时可以把提供的文本发送到上述当前模型服务，并产生费用。密钥由工作台保管，不交给应用；临时预览和自动启动检查不会调用真实模型。
                </p>
                <button
                  className="button compact"
                  type="submit"
                  data-testid="grant-app-ai"
                  disabled={grantDisabled}
                >
                  {working === 'grant' && <LoaderCircle size={15} className="spin" />}
                  {working === 'grant'
                    ? '正在保存授权'
                    : state.status === 'authorized' || state.status === 'limited'
                      ? '保存本项目额度'
                      : state.grant
                        ? '重新授权当前连接'
                        : '授权本项目调用文本 AI'}
                </button>
              </form>
            </>
          )}
          {readError && (
            <div className="app-ai-actions">
              <p className="field-error" role="alert">
                {readError}
              </p>
              <button
                className="button compact"
                disabled={!!working}
                onClick={() => setReload((value) => value + 1)}
              >
                <RefreshCw size={14} />
                重新读取
              </button>
            </div>
          )}
          {actionError && (
            <p className="field-error" role="alert">
              {actionError}
            </p>
          )}
          {notice && (
            <p className="muted small" role="status" data-testid="app-ai-notice">
              {notice}
            </p>
          )}
        </div>
      </details>
      {state?.grant?.enabled && (
        <button
          className="button compact app-ai-revoke"
          data-testid="revoke-app-ai"
          disabled={!!working}
          onClick={() => void act('revoke')}
        >
          {working === 'revoke' && <LoaderCircle size={15} className="spin" />}
          {working === 'revoke' ? '正在撤销' : '撤销授权'}
        </button>
      )}
    </section>
  );
}
