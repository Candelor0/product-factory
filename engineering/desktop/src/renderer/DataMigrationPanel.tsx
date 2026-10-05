import { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, ChevronRight, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import type {
  DataMigrationOperation,
  DataMigrationPreview,
  DataMigrationState,
} from '../shared/data-migration-contracts';
import { api } from './api';
import './data-migration.css';

// An uncertain confirmation keeps its original token across project/tab navigation.
const unresolved = new Map<string, DataMigrationPreview>();
const operationLabel = (operation: DataMigrationOperation) =>
  operation === 'migrate' ? '迁移' : '回退';

export function DataMigrationPanel({
  projectId,
  archived,
  disabled,
  onWorkingChange,
}: {
  projectId: string;
  archived: boolean;
  disabled: boolean;
  onWorkingChange: (working: boolean) => void;
}) {
  const [state, setState] = useState<DataMigrationState | null>(null);
  const [preview, setPreview] = useState<DataMigrationPreview | null>(
    () => unresolved.get(projectId) ?? null,
  );
  const [attempted, setAttempted] = useState(() => unresolved.has(projectId));
  const [expanded, setExpanded] = useState(() => unresolved.has(projectId));
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<'preview' | 'confirm' | 'discard' | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const lifecycle = useRef(0);
  const reads = useRef(0);
  const locked = useRef(false);
  const selected = useRef(preview);
  const callback = useRef(onWorkingChange);
  const impactTitle = useRef<HTMLHeadingElement | null>(null);
  const resultNotice = useRef<HTMLParagraphElement | null>(null);
  selected.current = preview;
  callback.current = onWorkingChange;
  const discard = (item: DataMigrationPreview) =>
    api.discardDataMigration({
      schemaVersion: 1,
      projectId: item.projectId,
      previewId: item.previewId,
    });

  useEffect(() => {
    lifecycle.current++;
    locked.current = false;
    setState(null);
    setPreview(unresolved.get(projectId) ?? null);
    setAttempted(unresolved.has(projectId));
    setExpanded(unresolved.has(projectId));
    setAcknowledged(false);
    setWorking(null);
    setReadError('');
    setActionError('');
    setNotice('');
    return () => {
      lifecycle.current++;
      reads.current++;
      callback.current(false);
      const item = selected.current;
      if (item && !unresolved.has(item.projectId)) void discard(item).catch(() => {});
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
        const response = await api.dataMigrationState({ schemaVersion: 1, projectId });
        if (!active || current !== reads.current) return;
        if (response.ok) {
          setState(response.value);
          setReadError('');
        } else setReadError(response.error.message);
      } catch {
        if (active && current === reads.current)
          setReadError('暂时无法读取数据结构状态，请重新读取。');
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
  }, [projectId, archived, disabled, reload]);
  useEffect(() => {
    if (preview) impactTitle.current?.focus();
  }, [preview?.previewId]);
  useEffect(() => {
    if (notice) resultNotice.current?.focus();
  }, [notice]);

  const blocked = disabled || !!working || loading || !!readError;
  const stale =
    !!preview &&
    !!state &&
    (state.revision !== preview.currentRevision ||
      state.currentVersion !== preview.currentVersion ||
      state.targetVersion !== preview.targetVersion);
  const expired = !!preview && Date.now() >= Date.parse(preview.expiresAt);
  const previewAllowed = (operation: DataMigrationOperation) =>
    !!state &&
    !archived &&
    !preview &&
    (operation === 'migrate' ? state.canMigrate : state.canRollback);
  const operate = async (
    action: 'preview' | 'confirm' | 'discard',
    operation?: DataMigrationOperation,
  ) => {
    if (locked.current || disabled || (action !== 'discard' && (loading || readError))) return;
    if (action === 'preview' && (!operation || !previewAllowed(operation))) return;
    if (
      action === 'confirm' &&
      (archived || !preview || !acknowledged || (!attempted && (stale || expired)))
    )
      return;
    if (action === 'discard' && !preview) return;
    const current = lifecycle.current;
    const selectedPreview = preview;
    if (action === 'confirm') {
      unresolved.set(projectId, selectedPreview!);
      setAttempted(true);
    }
    locked.current = true;
    reads.current++;
    setWorking(action);
    setActionError('');
    setNotice('');
    callback.current(true);
    try {
      if (action === 'preview') {
        const result = await api.previewDataMigration({
          schemaVersion: 1,
          projectId,
          operation: operation!,
        });
        if (current !== lifecycle.current) {
          if (result.ok) void discard(result.value).catch(() => {});
          return;
        }
        if (!result.ok) setActionError(result.error.message);
        else {
          setPreview(result.value);
          setExpanded(true);
          setAcknowledged(false);
          setAttempted(false);
        }
      } else if (action === 'confirm') {
        const result = await api.confirmDataMigration({
          schemaVersion: 1,
          projectId,
          previewId: selectedPreview!.previewId,
        });
        if (result.ok && unresolved.get(projectId)?.previewId === selectedPreview!.previewId)
          unresolved.delete(projectId);
        if (current !== lifecycle.current) return;
        if (!result.ok) setActionError(result.error.message);
        else {
          setPreview(null);
          setAcknowledged(false);
          setAttempted(false);
          setNotice(
            result.value.replayed
              ? `已核对这次${operationLabel(selectedPreview!.operation)}，提交为数据版本 ${result.value.appliedRevision}；当前版本 ${result.value.revision}。请核对后再继续使用应用。`
              : `已完成${operationLabel(selectedPreview!.operation)}，数据结构为版本 ${selectedPreview!.targetVersion}，数据保存为版本 ${result.value.revision}。本地应用已关闭，不会自动重新打开。`,
          );
        }
      } else {
        const result = await discard(selectedPreview!);
        if (result.ok && unresolved.get(projectId)?.previewId === selectedPreview!.previewId)
          unresolved.delete(projectId);
        if (current !== lifecycle.current) return;
        if (!result.ok) setActionError(result.error.message);
        else {
          setPreview(null);
          setAcknowledged(false);
          setAttempted(false);
          setNotice(
            attempted
              ? '已关闭预览。此前已经提交的变更不会因此撤销，请核对当前数据结构和版本。'
              : '已取消，当前数据未变。',
          );
        }
      }
    } catch {
      if (current === lifecycle.current)
        setActionError(
          action === 'confirm'
            ? '操作结果尚未确认。请保留本次预览，手动核对同一次请求；不要重新发起另一轮迁移或回退。'
            : '操作结果暂未确认，请核对状态后再操作。',
        );
    } finally {
      if (current === lifecycle.current) {
        locked.current = false;
        setWorking(null);
        callback.current(false);
        setReload((value) => value + 1);
      }
    }
  };
  const changes = preview
    ? [
        { label: '新增', keys: preview.addedKeys },
        { label: '移除', keys: preview.removedKeys },
        { label: '替换内容', keys: preview.changedKeys },
      ]
    : [];
  const label = preview ? operationLabel(preview.operation) : '迁移';
  return (
    <section
      className="data-migration-panel"
      aria-label="应用数据结构"
      data-testid="data-migration-state"
      data-status={
        working ??
        (readError
          ? 'error'
          : preview
            ? 'preview'
            : loading
              ? 'loading'
              : state?.compatible
                ? 'compatible'
                : 'incompatible')
      }
      aria-busy={!!working}
    >
      <details
        className="data-migration-details"
        data-testid="data-migration-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <ChevronRight size={16} className="data-migration-chevron" />
          <span>应用数据结构</span>
          <span className="muted">
            {readError
              ? '读取失败'
              : loading
                ? '正在读取'
                : state?.compatible
                  ? '与当前源码兼容'
                  : '需要核对'}
          </span>
        </summary>
        <div className="data-migration-content">
          <p className="muted small">
            用于调整已保存的数据项。目前支持重命名和补默认值，图片暂不支持。只处理当前项目，不调用模型。
          </p>
          {state && (
            <>
              <dl className="data-migration-meta">
                <div>
                  <dt>数据结构</dt>
                  <dd data-testid="data-migration-versions">
                    当前版本 {state.currentVersion} · 当前源码需要版本 {state.targetVersion}
                  </dd>
                </div>
                <div>
                  <dt>数据快照</dt>
                  <dd>
                    {state.initialized
                      ? `版本 ${state.revision}`
                      : '尚未初始化；查看此处不会创建数据存储'}
                  </dd>
                </div>
              </dl>
              <p className="muted small" data-testid="data-migration-message">
                {state.message}
              </p>
            </>
          )}
          <p className="muted small">
            建议先在「应用数据备份」中单独导出当前数据。迁移前的值会保留在本项目中；迁移后没有再写入数据，且源码已经回到原结构版本时，才可回退最近一次迁移。
          </p>
          {archived && <p className="muted small">项目已归档，恢复项目后才能迁移或回退数据。</p>}
          <div className="data-migration-actions">
            <button
              className="button compact"
              data-testid="preview-data-migration"
              disabled={blocked || !previewAllowed('migrate')}
              onClick={() => void operate('preview', 'migrate')}
            >
              <ArrowRightLeft size={15} />
              预览数据迁移
            </button>
            <button
              className="button compact"
              data-testid="preview-data-rollback"
              disabled={blocked || !previewAllowed('rollback')}
              onClick={() => void operate('preview', 'rollback')}
            >
              <RotateCcw size={15} />
              预览迁移回退
            </button>
          </div>
          {working === 'preview' && (
            <p className="muted small" role="status">
              正在核对声明和当前数据，尚未提交变更。
            </p>
          )}
          {preview && (
            <div
              className="data-migration-impact"
              data-testid="data-migration-impact"
              data-preview-id={preview.previewId}
              data-operation={preview.operation}
            >
              <h4 ref={impactTitle} tabIndex={-1}>
                {label}前核对
              </h4>
              <dl className="data-migration-meta">
                <div>
                  <dt>数据结构</dt>
                  <dd>
                    版本 {preview.currentVersion} → 版本 {preview.targetVersion}
                  </dd>
                </div>
                <div>
                  <dt>当前数据</dt>
                  <dd>
                    快照版本 {preview.currentRevision} · {preview.keyCount} 个数据项
                  </dd>
                </div>
                <div>
                  <dt>变更步骤</dt>
                  <dd>
                    {preview.operation === 'rollback'
                      ? '恢复最近迁移前的数据'
                      : `${preview.stepCount} 步`}
                  </dd>
                </div>
                <div>
                  <dt>预览有效期</dt>
                  <dd>{new Date(preview.expiresAt).toLocaleString('zh-CN', { hour12: false })}</dd>
                </div>
              </dl>
              <div className="data-migration-changes">
                {changes.map((change) => (
                  <div key={change.label}>
                    <strong>
                      {change.label} · {change.keys.length}
                    </strong>
                    {change.keys.length ? (
                      <ul>
                        {change.keys.map((key) => (
                          <li key={key}>{key}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted small">无</p>
                    )}
                  </div>
                ))}
              </div>
              <p className="muted small">
                这里只显示数据项名称，不显示个人内容。源码、模型用量和授权不会随数据结构变更回退。
              </p>
              <p className="data-migration-warning">
                确认后会关闭持久本地应用，未保存的编辑会丢失，并将{label}
                结果保存为新数据版本；不会自动重新打开应用。
                {preview.operation === 'migrate'
                  ? '迁移前的值会保留，仍建议先单独备份。'
                  : '此次回退只恢复最近一次迁移前的值；迁移后有新写入时不能执行。'}
              </p>
              {stale && !attempted && (
                <p className="field-error" role="alert">
                  当前数据或源码所需版本已有变化，请取消并重新预览。
                </p>
              )}
              {expired && !attempted && (
                <p className="field-error" role="alert">
                  预览已过期，请取消并重新核对影响。
                </p>
              )}
              {attempted && (
                <p className="muted small">
                  这次{label}已经发起，再次点击会按原请求核对结果，不会新建另一轮操作。
                </p>
              )}
              <label className="data-migration-confirm-label">
                <input
                  type="checkbox"
                  data-testid="acknowledge-data-migration"
                  checked={acknowledged}
                  disabled={disabled || !!working || archived}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>我已了解关闭应用和数据变更的影响，确认执行这次{label}。</span>
              </label>
              <div className="data-migration-actions">
                <button
                  className="button primary compact"
                  data-testid="confirm-data-migration"
                  disabled={
                    blocked || archived || !acknowledged || (!attempted && (stale || expired))
                  }
                  onClick={() => void operate('confirm')}
                >
                  {working === 'confirm' && <LoaderCircle size={15} className="spin" />}
                  {working === 'confirm'
                    ? '正在核对并执行'
                    : attempted
                      ? '重试同一次请求'
                      : `确认${label}数据`}
                </button>
                <button
                  className="button compact"
                  data-testid="discard-data-migration"
                  disabled={disabled || !!working}
                  onClick={() => void operate('discard')}
                >
                  {working === 'discard' ? '正在关闭预览' : attempted ? '关闭预览' : `取消${label}`}
                </button>
              </div>
            </div>
          )}
          {readError && (
            <div className="data-migration-actions">
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
            <p
              className="muted small"
              ref={resultNotice}
              tabIndex={-1}
              role="status"
              data-testid="data-migration-notice"
            >
              {notice}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
