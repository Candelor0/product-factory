import { useEffect, useId, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { ExportResult } from '../shared/export-contracts';
import { api } from './api';

export function ExportPanel({
  projectId,
  planRunId,
  revision,
  fileCount,
  disabled,
  onWorkingChange,
}: {
  projectId: string;
  planRunId: string | null;
  revision: number;
  fileCount: number;
  disabled: boolean;
  onWorkingChange: (working: boolean) => void;
}) {
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const lifecycle = useRef(0);
  const callbacks = useRef({ onWorkingChange });
  const descriptionId = useId();
  callbacks.current = { onWorkingChange };

  useEffect(() => {
    lifecycle.current++;
    locked.current = false;
    setWorking(false);
    setResult(null);
    setError('');
    return () => {
      lifecycle.current++;
      callbacks.current.onWorkingChange(false);
    };
  }, [projectId]);

  const exportSource = async () => {
    if (locked.current || disabled || !planRunId || revision <= 0 || fileCount <= 0) return;
    const current = lifecycle.current;
    locked.current = true;
    setWorking(true);
    setResult(null);
    setError('');
    callbacks.current.onWorkingChange(true);
    try {
      const response = await api.exportSource({
        schemaVersion: 1,
        projectId,
        planRunId,
        sourceRevision: revision,
      });
      if (current !== lifecycle.current) return;
      if (response.ok) setResult(response.value);
      else setError(response.error.message);
    } catch {
      if (current === lifecycle.current) setError('导出结果暂未确认，请检查所选保存位置后再试。');
    } finally {
      if (current === lifecycle.current) {
        locked.current = false;
        setWorking(false);
        callbacks.current.onWorkingChange(false);
      }
    }
  };

  return (
    <section
      className="export-panel"
      aria-label="源码导出"
      aria-busy={working}
      data-testid="export-state"
      data-status={working ? 'exporting' : error ? 'failed' : (result?.status ?? 'idle')}
    >
      <div className="export-heading">
        <h4>源码导出</h4>
        <button
          className="button compact"
          data-testid="export-source"
          aria-describedby={descriptionId}
          disabled={disabled || working || !planRunId || revision <= 0 || fileCount <= 0}
          onClick={() => void exportSource()}
        >
          {working ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
          {working ? '正在导出' : '导出当前源码'}
        </button>
      </div>
      <p className="muted small" id={descriptionId}>
        包含源码、需求方案和固定构建说明，默认不含个人业务数据、凭据、缓存和日志。不调用模型；导出文件不是独立安装包。
      </p>
      {working && (
        <p className="muted small" role="status">
          请在保存对话框中选择位置，或取消导出。
        </p>
      )}
      {result?.status === 'exported' && (
        <div className="export-result" data-testid="export-result">
          <p role="status">
            已导出 {result.fileName} · 源码版本 {result.sourceRevision}
          </p>
          <details>
            <summary>保存位置</summary>
            <p>{result.filePath}</p>
          </details>
        </div>
      )}
      {result?.status === 'cancelled' && (
        <p className="muted small" role="status">
          已取消导出，未保存文件。
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
