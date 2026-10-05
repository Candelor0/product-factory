import { useEffect, useRef, useState } from 'react';
import { ChevronRight, History, LoaderCircle, RefreshCw } from 'lucide-react';
import type {
  RecoveryCheckpoint,
  RecoveryRun,
  RecoveryState,
  RestoreCheckpointRequest,
} from '../shared/recovery-contracts';
import { api } from './api';

// Keep an uncertain request across tab/project navigation. A retry must reuse its receipt.
const unresolved = new Map<string, RestoreCheckpointRequest>();
const rejectedBeforeWrite = new Set([
  'INVALID_INPUT',
  'ARCHIVED',
  'SOURCE_CONFLICT',
  'SOURCE_BINDING_CHANGED',
  'SOURCE_CHECKPOINT_NOT_FOUND',
  'CHECKPOINT_NOT_FOUND',
  'STALE_CHECKPOINT',
  'STALE_PLAN',
  'CONFIRMATION_REQUIRED',
  'SOURCE_LIMIT',
]);
const kinds: Record<RecoveryRun['kind'], string> = {
  coding: '源码生成',
  repair: '编译修复',
  build: '本地构建',
};
const phases: Record<RecoveryRun['phase'], string> = {
  model: '模型请求',
  tools: '工具记录',
  build: '编译检查',
  runtime: '页面启动检查',
  saved: '产物保存',
};

function changedFiles(current: RecoveryCheckpoint, target: RecoveryCheckpoint) {
  const before = new Map(current.files.map((file) => [file.path, file.sha256]));
  const after = new Map(target.files.map((file) => [file.path, file.sha256]));
  return [
    {
      label: '新增',
      paths: target.files.filter((file) => !before.has(file.path)).map((file) => file.path),
    },
    {
      label: '替换',
      paths: target.files
        .filter((file) => before.has(file.path) && before.get(file.path) !== file.sha256)
        .map((file) => file.path),
    },
    {
      label: '移除',
      paths: current.files.filter((file) => !after.has(file.path)).map((file) => file.path),
    },
  ];
}

export function RecoveryPanel({
  projectId,
  planRunId,
  revision,
  refreshKey,
  disabled,
  onWorkingChange,
  onRestored,
}: {
  projectId: string;
  planRunId: string | null;
  revision: number;
  refreshKey: number;
  disabled: boolean;
  onWorkingChange: (working: boolean) => void;
  onRestored: () => void;
}) {
  const [state, setState] = useState<RecoveryState | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [pending, setPending] = useState<RestoreCheckpointRequest | null>(
    () => unresolved.get(projectId) ?? null,
  );
  const lifecycle = useRef(0);
  const reads = useRef(0);
  const locked = useRef(false);
  const selectionButton = useRef<HTMLButtonElement | null>(null);
  const impactTitle = useRef<HTMLHeadingElement | null>(null);
  const successNotice = useRef<HTMLParagraphElement | null>(null);
  const callbacks = useRef({ onWorkingChange, onRestored });
  callbacks.current = { onWorkingChange, onRestored };

  useEffect(() => {
    lifecycle.current++;
    setState(null);
    setSelectedRevision(null);
    setPending(unresolved.get(projectId) ?? null);
    setWorking(false);
    setActionError('');
    setNotice('');
    locked.current = false;
    return () => {
      lifecycle.current++;
      callbacks.current.onWorkingChange(false);
    };
  }, [projectId]);

  useEffect(() => {
    const current = ++reads.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const read = async () => {
      try {
        const result = await api.recoveryState({ projectId });
        if (current !== reads.current) return;
        if (result.ok) {
          setState(result.value);
          setReadError('');
          if (result.value.runs.some((run) => run.status === 'running'))
            timer = setTimeout(read, 800);
        } else setReadError(result.error.message);
      } catch {
        if (current === reads.current) setReadError('暂时无法核对检查点，请重试读取。');
      } finally {
        if (current === reads.current) setLoading(false);
      }
    };
    void read();
    return () => {
      reads.current++;
      clearTimeout(timer);
    };
  }, [projectId, planRunId, revision, refreshKey, attempt, disabled]);

  useEffect(() => {
    if (selectedRevision !== null) impactTitle.current?.focus();
  }, [selectedRevision]);

  useEffect(() => {
    if (notice) successNotice.current?.focus();
  }, [notice]);

  const targetRevision = pending?.targetRevision ?? selectedRevision;
  const target = state?.checkpoints.find((item) => item.revision === targetRevision);
  const current = state?.checkpoints.find((item) => item.revision === state.revision);
  const changes = current && target ? changedFiles(current, target) : [];
  const interrupted = state?.runs.filter((run) => run.status === 'interrupted') ?? [];
  const blocked = disabled || working || loading || !!readError;

  const restore = async () => {
    if (locked.current || blocked || !state) return;
    const retry = unresolved.get(projectId) ?? pending;
    if (
      !retry &&
      (!target?.canRestore || !planRunId || state.planRunId !== planRunId || state.blockedReason)
    )
      return;
    const input: RestoreCheckpointRequest = retry ?? {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      projectId,
      planRunId: planRunId!,
      sourceRevision: state.revision,
      targetRevision: target!.revision,
    };
    unresolved.set(projectId, input);
    setPending(input);
    locked.current = true;
    const generation = lifecycle.current;
    setWorking(true);
    callbacks.current.onWorkingChange(true);
    setActionError('');
    setNotice('');
    try {
      const result = await api.restoreCheckpoint(input);
      if (
        (result.ok || rejectedBeforeWrite.has(result.error.code)) &&
        unresolved.get(projectId) === input
      )
        unresolved.delete(projectId);
      if (generation !== lifecycle.current) return;
      setPending(unresolved.get(projectId) ?? null);
      if (result.ok) {
        setSelectedRevision(null);
        setNotice(
          `已将版本 ${input.targetRevision} 的源码保存为版本 ${result.value.revision}。可重新构建并检查页面。`,
        );
        callbacks.current.onRestored();
      } else setActionError(result.error.message);
    } catch {
      if (generation === lifecycle.current)
        setActionError('恢复结果尚未确认。请核对并重试同一次恢复，避免重复创建版本。');
    } finally {
      if (generation === lifecycle.current) {
        locked.current = false;
        setWorking(false);
        callbacks.current.onWorkingChange(false);
        setAttempt((value) => value + 1);
      }
    }
  };

  return (
    <section
      className="recovery-panel"
      aria-label="检查点与中断恢复"
      data-testid="recovery-state"
      aria-busy={working}
    >
      {!!interrupted.length && (
        <div className="recovery-interrupted" data-testid="interrupted-runs">
          <p>上次中断后的记录已核对</p>
          <p className="muted small">
            已保存的源码和实际产物见下方。工具和模型请求不会自动重发；核对后，可用「继续生成源码」或「自动修复并构建」主动开始新一轮，模型请求仍计入额度。
          </p>
          <ul>
            {interrupted.map((run) => (
              <li key={run.id}>
                <strong>{kinds[run.kind]}</strong>
                <span>
                  记录位置：{phases[run.phase]}
                  {run.rounds ? ` · 已发起 ${run.rounds} 轮模型请求` : ''}
                </span>
                <span>
                  {run.committedRevisions.length
                    ? `已确认源码提交：版本 ${run.committedRevisions.join('、')}`
                    : '本次未发现新增源码提交'}
                </span>
                <span>
                  未发现源码提交的工具记录：{run.unconfirmedTools} 条
                  {run.unconfirmedTools ? '（可能为读取、失败或尚未执行的工具）' : ''}
                </span>
                <span>
                  {run.buildId
                    ? '已找到实际保存的编译产物，可在页面预览中查看。'
                    : '此轮未确认新的编译产物，之前保存的成功产物仍可核对。'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="recovery-history" data-testid="checkpoint-history">
        <summary>
          <ChevronRight size={15} className="recovery-chevron" aria-hidden="true" />
          <History size={15} aria-hidden="true" />
          <span>源码检查点</span>
          {state && (
            <span className="muted">
              {state.checkpoints.length} 个版本 · 当前 {state.revision}
            </span>
          )}
        </summary>
        <div className="recovery-content">
          <p className="muted small">
            每次修改保留前版。编译记录只说明源码曾通过编译，实际功能仍需检查。
          </p>
          {loading && !state && (
            <p className="muted small" role="status">
              正在核对检查点…
            </p>
          )}
          {state?.blockedReason && <p className="muted small">{state.blockedReason}</p>}
          <ol className="checkpoint-list">
            {state?.checkpoints
              .slice()
              .reverse()
              .map((checkpoint) => (
                <li key={checkpoint.revision} data-testid={`checkpoint-${checkpoint.revision}`}>
                  <div className="checkpoint-row">
                    <div className="checkpoint-meta">
                      <strong>
                        版本 {checkpoint.revision}
                        {checkpoint.revision === state.revision ? ' · 当前源码' : ''}
                      </strong>
                      <span className="muted small">
                        {checkpoint.createdAt
                          ? new Date(checkpoint.createdAt).toLocaleString('zh-CN', {
                              hour12: false,
                            })
                          : '初始空源码'}{' '}
                        · {checkpoint.files.length} 个文件
                        {checkpoint.restoredFrom !== null
                          ? ` · 从版本 ${checkpoint.restoredFrom} 恢复`
                          : ''}
                      </span>
                      <span className="muted small">
                        {checkpoint.buildId ? '有匹配的编译产物' : '无匹配的编译产物'}
                        {checkpoint.revision !== 0 &&
                        checkpoint.binding?.planRunId !== state.planRunId
                          ? ' · 对应此前确认方向'
                          : ''}
                      </span>
                    </div>
                    {checkpoint.revision !== state.revision && (
                      <button
                        className="button compact"
                        disabled={blocked || !!pending || !checkpoint.canRestore}
                        aria-label={`查看恢复到版本 ${checkpoint.revision} 的影响`}
                        onClick={(event) => {
                          selectionButton.current = event.currentTarget;
                          setSelectedRevision(checkpoint.revision);
                          setActionError('');
                          setNotice('');
                        }}
                      >
                        查看恢复影响
                      </button>
                    )}
                  </div>
                  {!!checkpoint.changedPaths.length && (
                    <details className="checkpoint-files">
                      <summary>此版变更 {checkpoint.changedPaths.length} 个文件</summary>
                      <ul>
                        {checkpoint.changedPaths.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
          </ol>
        </div>
      </details>
      {(target || pending) && (
        <div
          className="recovery-confirm"
          data-testid="restore-impact"
          role="region"
          aria-label="恢复源码的影响"
        >
          <h4 ref={impactTitle} tabIndex={-1}>
            {pending ? '核对尚未确认的恢复' : `恢复到版本 ${target!.revision}`}
          </h4>
          <p>
            恢复会把所选源码保存为新版本，并保留恢复前的源码。仅恢复源码，不改变业务数据、需求确认和模型用量。
          </p>
          <p className="muted small">现有预览保持原内容，恢复后请重新构建。</p>
          {pending ? (
            <p>
              这次请求从版本 {pending.sourceRevision} 恢复到版本 {pending.targetRevision}
              ，结果尚待确认。重试沿用原请求，不自动开始另一轮恢复。
            </p>
          ) : (
            <>
              <p>
                当前版本 {state?.revision} → 所选版本 {target!.revision}：
                {changes.map((group) => `${group.label} ${group.paths.length} 个文件`).join('、')}。
              </p>
              {!changes.some((group) => group.paths.length) && (
                <p className="muted small">文件内容相同，恢复会另存新版本。</p>
              )}
              <ul className="recovery-diff">
                {changes.flatMap((group) =>
                  group.paths.map((path) => (
                    <li key={path}>
                      <span>{group.label}</span>
                      <code>{path}</code>
                    </li>
                  )),
                )}
              </ul>
            </>
          )}
          <div className="recovery-actions">
            <button
              className="button primary"
              data-testid="restore-checkpoint"
              disabled={
                blocked ||
                (!pending &&
                  (!target?.canRestore || !!state?.blockedReason || state?.planRunId !== planRunId))
              }
              onClick={() => void restore()}
            >
              {working && <LoaderCircle size={15} className="spin" />}
              {working ? '正在核对并恢复' : pending ? '核对并重试恢复' : '确认恢复源码'}
            </button>
            {!pending && (
              <button
                className="button compact"
                onClick={() => {
                  setSelectedRevision(null);
                  selectionButton.current?.focus();
                }}
              >
                取消
              </button>
            )}
          </div>
        </div>
      )}
      {readError && (
        <div className="recovery-error">
          <p className="field-error" role="alert">
            {readError}
          </p>
          <button
            className="button compact"
            disabled={working || loading}
            onClick={() => setAttempt((value) => value + 1)}
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
      {notice && (
        <p
          className="recovery-notice"
          role="status"
          data-testid="restore-success"
          ref={successNotice}
          tabIndex={-1}
        >
          {notice}
        </p>
      )}
    </section>
  );
}
