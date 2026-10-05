import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Download, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import type {
  DataBackupState,
  DataExportResult,
  DataRestorePreview,
} from '../shared/data-backup-contracts';
import { api } from './api';
import './data-backup.css';

// Keep the original confirmation token if its outcome is uncertain across navigation.
const unresolved = new Map<string, DataRestorePreview>();
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const size = (bytes: number) => `${bytes.toLocaleString()} 字节`;

export function DataBackupPanel({
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
  const [state, setState] = useState<DataBackupState | null>(null);
  const [preview, setPreview] = useState<DataRestorePreview | null>(
    () => unresolved.get(projectId) ?? null,
  );
  const [exported, setExported] = useState<Extract<
    DataExportResult,
    { status: 'exported' }
  > | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [attempted, setAttempted] = useState(() => unresolved.has(projectId));
  const [expanded, setExpanded] = useState(() => unresolved.has(projectId));
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<'export' | 'preview' | 'confirm' | 'discard' | null>(null);
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
  const chooseButton = useRef<HTMLButtonElement | null>(null);
  const resultNotice = useRef<HTMLParagraphElement | null>(null);
  selected.current = preview;
  callback.current = onWorkingChange;

  const discard = (item: DataRestorePreview) =>
    api.discardDataRestore({
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
    setExported(null);
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
        const response = await api.dataBackupState({ schemaVersion: 1, projectId });
        if (!active || current !== reads.current) return;
        if (response.ok) {
          setState(response.value);
          setReadError('');
        } else setReadError(response.error.message);
      } catch {
        if (active && current === reads.current)
          setReadError('暂时无法读取应用数据状态，请重新读取。');
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
  const initialized = state?.initialized && state.revision !== null;
  const stale = !!preview && state?.revision !== preview.currentRevision;

  const operate = async (operation: 'export' | 'preview' | 'confirm' | 'discard') => {
    if (locked.current || disabled || (operation !== 'discard' && (loading || readError))) return;
    if (operation === 'export' && (!initialized || preview)) return;
    if (operation === 'preview' && (archived || !initialized || preview)) return;
    if (operation === 'confirm' && (archived || !preview || !acknowledged || (stale && !attempted)))
      return;
    if (operation === 'discard' && !preview) return;
    const current = lifecycle.current;
    const selectedPreview = preview;
    if (operation === 'confirm') {
      unresolved.set(projectId, selectedPreview!);
      setAttempted(true);
    }
    locked.current = true;
    reads.current++;
    setWorking(operation);
    setActionError('');
    setNotice('');
    callback.current(true);
    try {
      if (operation === 'export') {
        setExported(null);
        const result = await api.exportAppData({
          schemaVersion: 1,
          projectId,
          expectedRevision: state!.revision!,
        });
        if (current !== lifecycle.current) return;
        if (!result.ok) setActionError(result.error.message);
        else if (result.value.status === 'exported') {
          setExported(result.value);
          setNotice(
            `已导出 ${result.value.fileName} · 数据版本 ${result.value.dataRevision}。请妥善保管备份中的个人内容。`,
          );
        } else setNotice('已取消导出，未创建备份文件。');
      } else if (operation === 'preview') {
        const result = await api.previewDataRestore({ schemaVersion: 1, projectId });
        if (current !== lifecycle.current) {
          if (result.ok && result.value.status === 'preview')
            void discard(result.value).catch(() => {});
          return;
        }
        if (!result.ok) setActionError(result.error.message);
        else if (result.value.status === 'preview') {
          setPreview(result.value);
          setExpanded(true);
          setAcknowledged(false);
          setAttempted(false);
        } else setNotice('已取消选择备份，当前数据未变。');
      } else if (operation === 'confirm') {
        const result = await api.confirmDataRestore({
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
              ? `已核对这次恢复，提交为数据版本 ${result.value.appliedRevision}；当前版本 ${result.value.revision}。请核对当前数据后再继续使用应用。`
              : `已恢复备份并保存为数据版本 ${result.value.revision}。本地应用已关闭，可在核对后主动打开。`,
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
              ? '已关闭恢复预览。若此前提交已生效，关闭预览不会撤销数据变更，请核对当前版本。'
              : '已取消恢复，当前数据未变。',
          );
          chooseButton.current?.focus();
        }
      }
    } catch {
      if (current === lifecycle.current)
        setActionError(
          operation === 'confirm'
            ? '恢复结果尚未确认。请保留本次预览，手动重试同一次恢复以核对结果，不要重新提交另一份恢复。'
            : operation === 'export'
              ? '导出结果尚未确认，请先检查所选位置，再决定是否重新导出。'
              : '操作结果尚未确认，请核对后再操作。',
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
  return (
    <section
      className="data-backup-panel"
      aria-label="应用数据备份"
      data-testid="data-backup-state"
      data-status={
        working ??
        (readError
          ? 'error'
          : preview
            ? 'preview'
            : loading
              ? 'loading'
              : initialized
                ? 'ready'
                : 'empty')
      }
      aria-busy={!!working}
    >
      <details
        className="data-backup-details"
        data-testid="data-backup-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <ChevronRight className="data-backup-chevron" size={16} />
          <span>应用数据备份</span>
          <span className="muted">
            {readError
              ? '读取失败'
              : loading
                ? '正在读取'
                : initialized
                  ? `数据版本 ${state!.revision}`
                  : '尚无应用数据'}
          </span>
        </summary>
        <div className="data-backup-content">
          <p className="muted small">
            单独备份本项目生成应用保存的 JSON
            数据。备份包含个人内容，请妥善保管；不包含源码、凭据、AI
            授权或固定样例数据，不调用模型。
          </p>
          {state && (
            <p className="muted small" data-testid="data-backup-summary">
              {initialized
                ? `当前保存 ${state.keyCount} 个数据项 · ${size(state.bytes)}`
                : '本项目尚未保存生成应用数据。查看此处不会创建数据存储。'}
            </p>
          )}
          <p className="muted small">
            仅支持恢复到原项目、原数据存储，且源码内容须与备份时一致；这不是数据结构迁移。工作台只保留最近
            5 份数据历史，不能替代另存的备份。
          </p>
          {archived && (
            <p className="muted small">
              项目已归档，可导出已保存的数据；恢复项目后才能从备份恢复。
            </p>
          )}
          <div className="data-backup-actions">
            <button
              className="button compact"
              data-testid="export-app-data"
              disabled={blocked || !initialized || !!preview}
              onClick={() => void operate('export')}
            >
              {working === 'export' ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Download size={15} />
              )}
              导出数据备份
            </button>
            <button
              className="button compact"
              data-testid="preview-data-restore"
              ref={chooseButton}
              disabled={blocked || archived || !initialized || !!preview}
              onClick={() => void operate('preview')}
            >
              {working === 'preview' ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <FolderOpen size={15} />
              )}
              选择备份并预览
            </button>
          </div>
          {(working === 'export' || working === 'preview') && (
            <p className="muted small" role="status">
              请在系统文件对话框中选择{working === 'export' ? '保存位置' : '备份文件'}，或取消操作。
            </p>
          )}
          {preview && (
            <div
              className="data-restore-impact"
              data-testid="data-restore-impact"
              data-preview-id={preview.previewId}
            >
              <h4 ref={impactTitle} tabIndex={-1}>
                恢复前核对
              </h4>
              <dl className="data-backup-meta">
                <div>
                  <dt>备份文件</dt>
                  <dd>{preview.fileName}</dd>
                </div>
                <div>
                  <dt>备份时间</dt>
                  <dd>{date(preview.exportedAt)}</dd>
                </div>
                <div>
                  <dt>数据版本</dt>
                  <dd>
                    当前 {preview.currentRevision} → 备份 {preview.backupRevision}（将另存为新版本）
                  </dd>
                </div>
                <div>
                  <dt>数据项</dt>
                  <dd>
                    当前 {preview.currentKeyCount} 项 → 备份 {preview.backupKeyCount} 项 ·{' '}
                    {size(preview.backupBytes)}
                  </dd>
                </div>
              </dl>
              <div className="data-backup-changes">
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
                另有 {preview.unchangedKeys} 项内容相同；这里只展示数据项名称，不展示个人内容。
              </p>
              <p className="data-backup-warning">
                确认后会整体替换当前应用数据，并关闭持久本地应用，未保存的编辑会丢失。完成后不会自动重新打开应用。源码、调用用量与授权不随数据回退。
              </p>
              {stale && !attempted && (
                <p className="field-error" role="alert">
                  预览后当前数据已有变化，请取消并重新选择备份以核对最新影响。
                </p>
              )}
              {attempted && (
                <p className="muted small">
                  这次恢复已发起，结果需按原请求核对；再次点击只核对同一次恢复。
                </p>
              )}
              <label className="data-restore-confirm-label">
                <input
                  type="checkbox"
                  data-testid="acknowledge-data-restore"
                  checked={acknowledged}
                  disabled={disabled || !!working || archived}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>我已了解整体替换和关闭应用的影响，确认恢复这份备份。</span>
              </label>
              <div className="data-backup-actions">
                <button
                  className="button primary compact"
                  data-testid="confirm-data-restore"
                  disabled={blocked || archived || !acknowledged || (stale && !attempted)}
                  onClick={() => void operate('confirm')}
                >
                  {working === 'confirm' && <LoaderCircle className="spin" size={15} />}{' '}
                  {working === 'confirm'
                    ? '正在核对并恢复'
                    : attempted
                      ? '重试同一次恢复'
                      : '确认恢复数据'}
                </button>
                <button
                  className="button compact"
                  data-testid="discard-data-restore"
                  disabled={disabled || !!working}
                  onClick={() => void operate('discard')}
                >
                  {working === 'discard' ? '正在关闭预览' : attempted ? '关闭预览' : '取消恢复'}
                </button>
              </div>
            </div>
          )}
          {readError && (
            <div className="data-backup-actions">
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
              data-testid="data-backup-notice"
            >
              {notice}
            </p>
          )}
          {exported && (
            <details className="data-backup-location">
              <summary>备份保存位置</summary>
              <p>{exported.filePath}</p>
            </details>
          )}
        </div>
      </details>
    </section>
  );
}
