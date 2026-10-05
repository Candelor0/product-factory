import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import type { GapBinding, GapEvidenceRequest, GapReport, GapRow } from '../shared/gap-contracts';
import { runtimeIssueMessages } from '../shared/runtime-contracts';
import { api } from './api';
import './gap-report.css';

type Verdict = GapEvidenceRequest['verdict'];
type Filter = 'all' | 'not_run' | 'passed' | 'failed' | 'missing' | 'stale';
interface Draft {
  verdict: Verdict | '';
  filePaths: string[];
  steps: string;
  expected: string;
  actual: string;
  binding: GapBinding | null;
  request: GapEvidenceRequest | null;
}
// Uncertain submissions retain their exact payload across tab/project navigation.
const pending = new Map<string, GapEvidenceRequest>();
const pendingKey = (projectId: string, taskId: string) => `${projectId}:${taskId}`;
const sameBinding = (left: GapBinding | null, right: GapBinding | null) =>
  JSON.stringify(left) === JSON.stringify(right);
const groups: { kind: GapRow['kind']; label: string }[] = [
  { kind: 'page', label: '页面' },
  { kind: 'feature', label: '功能' },
  { kind: 'data', label: '数据' },
  { kind: 'acceptance', label: '验收结果' },
];
const labels: Record<Filter, string> = {
  all: '全部',
  not_run: '未验证',
  passed: '用户通过',
  failed: '未通过',
  missing: '缺少实现',
  stale: '已过期',
};
const rowState = (row: GapRow): Exclude<Filter, 'all'> =>
  row.verification === 'stale'
    ? 'stale'
    : row.verification === 'passed'
      ? 'passed'
      : row.verification === 'failed'
        ? 'failed'
        : row.implementation === 'missing'
          ? 'missing'
          : 'not_run';
const verdictLabel: Record<Verdict, string> = {
  passed: '用户核验通过',
  failed: '用户核验未通过',
  missing: '用户确认缺少实现',
};
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const fromRequest = (request: GapEvidenceRequest): Draft => ({ ...request, request });
const runtimeStatus = {
  observing: '正在观察启动',
  observed: '启动观察期未发现错误',
  issues: '发现运行错误',
  cancelled: '检查已取消',
  interrupted: '检查已中断',
};

export function GapReportPanel({
  projectId,
  planRunId,
  archived,
  disabled,
  refreshKey = 0,
  onWorkingChange,
}: {
  projectId: string;
  planRunId: string | null;
  archived: boolean;
  disabled: boolean;
  refreshKey?: number;
  onWorkingChange: (working: boolean) => void;
}) {
  const [report, setReport] = useState<GapReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [opened, setOpened] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [refresh, setRefresh] = useState(0);
  const lifecycle = useRef(0),
    reads = useRef(0),
    locked = useRef(false);
  const callback = useRef(onWorkingChange);
  const resultNotice = useRef<HTMLParagraphElement | null>(null);
  const formTitle = useRef<HTMLHeadingElement | null>(null);
  callback.current = onWorkingChange;
  useEffect(() => {
    lifecycle.current++;
    locked.current = false;
    setReport(null);
    setDrafts({});
    setOpened(null);
    setFilter('all');
    setSaving(false);
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
    if (locked.current) return;
    const sequence = ++reads.current;
    setLoading(true);
    void (async () => {
      try {
        const result = await api.gapReport({ projectId });
        if (!active || sequence !== reads.current) return;
        if (result.ok) {
          setReport(result.value);
          setReadError('');
        } else setReadError(result.error.message);
      } catch {
        if (active && sequence === reads.current)
          setReadError('暂时无法读取差距报告，请重新读取后再核验。');
      } finally {
        if (active && sequence === reads.current) setLoading(false);
      }
    })();
    return () => {
      active = false;
      reads.current++;
    };
  }, [projectId, planRunId, archived, disabled, refresh, refreshKey]);
  useEffect(() => {
    if (opened) formTitle.current?.focus();
  }, [opened]);
  useEffect(() => {
    if (notice) resultNotice.current?.focus();
  }, [notice]);

  const currentBuild = !!(
    report?.status === 'current' &&
    report.binding?.buildId &&
    report.build?.id === report.binding.buildId &&
    report.build.artifactHash === report.binding.artifactHash &&
    report.build.sourceRevision === report.binding.sourceRevision &&
    report.build.sourceHash === report.binding.sourceHash
  );
  const writable =
    !!report?.writable && report.status === 'current' && !!report.binding && !archived;
  const busy = disabled || loading || saving;
  const selected = report?.rows.find((row) => row.id === opened);
  const draft = opened ? drafts[opened] : undefined;
  const draftStale = !!draft && !sameBinding(draft.binding, report?.binding ?? null);
  const missingSelections =
    draft?.filePaths.filter((path) => !report?.sourceFiles.includes(path)) ?? [];
  const valid =
    !!draft &&
    !!draft.verdict &&
    !!draft.steps.trim() &&
    !!draft.expected.trim() &&
    !!draft.actual.trim() &&
    !missingSelections.length &&
    draft.filePaths.length <= 32 &&
    (draft.verdict !== 'passed' || (currentBuild && draft.filePaths.length > 0));
  const openForm = (row: GapRow) => {
    if (saving) return;
    setActionError('');
    setNotice('');
    if (opened === row.id) {
      setOpened(null);
      return;
    }
    setDrafts((previous) => {
      if (previous[row.id]) return previous;
      const request = pending.get(pendingKey(projectId, row.id));
      return {
        ...previous,
        [row.id]: request
          ? fromRequest(request)
          : {
              verdict: '',
              filePaths: row.files
                .map((file) => file.path)
                .filter((path) => report?.sourceFiles.includes(path))
                .slice(0, 32),
              steps: '',
              expected: '',
              actual: '',
              binding: report?.binding ?? null,
              request: null,
            },
      };
    });
    setOpened(row.id);
  };
  const edit = (change: Partial<Draft>) => {
    if (!opened || !draft || saving) return;
    pending.delete(pendingKey(projectId, opened));
    setDrafts((previous) => ({
      ...previous,
      [opened]: { ...previous[opened]!, ...change, request: null },
    }));
    setActionError('');
    setNotice('');
  };
  const rebind = () => {
    if (!report?.binding || !opened || busy || !writable) return;
    edit({
      binding: report.binding,
      verdict: '',
      filePaths: draft?.filePaths.filter((path) => report.sourceFiles.includes(path)) ?? [],
    });
  };
  const save = async () => {
    if (
      locked.current ||
      busy ||
      !selected ||
      !draft ||
      (!draft.request && (!writable || !!readError || draftStale || !valid))
    )
      return;
    const request: GapEvidenceRequest = draft.request ?? {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      projectId,
      binding: draft.binding!,
      taskId: selected.id,
      verdict: draft.verdict as Verdict,
      filePaths: [...draft.filePaths].sort(),
      steps: draft.steps.trim(),
      expected: draft.expected.trim(),
      actual: draft.actual.trim(),
    };
    pending.set(pendingKey(projectId, selected.id), request);
    setDrafts((previous) => ({ ...previous, [selected.id]: { ...draft, request } }));
    const current = lifecycle.current;
    locked.current = true;
    reads.current++;
    setSaving(true);
    setActionError('');
    setNotice('');
    callback.current(true);
    try {
      const result = await api.recordGapEvidence(request);
      if (
        result.ok &&
        pending.get(pendingKey(projectId, selected.id))?.requestId === request.requestId
      )
        pending.delete(pendingKey(projectId, selected.id));
      if (current !== lifecycle.current) return;
      if (!result.ok) setActionError(result.error.message);
      else {
        setReport(result.value);
        setReadError('');
        setDrafts((previous) => {
          const next = { ...previous };
          delete next[selected.id];
          return next;
        });
        setOpened(null);
        setNotice(
          sameBinding(request.binding, result.value.binding)
            ? `已保存「${selected.title}」的用户核验记录。记录仅适用于核验时的计划、源码和构建版本。`
            : '已核对原请求，记录属于旧版本；当前报告未沿用旧结论。',
        );
      }
    } catch {
      if (current === lifecycle.current)
        setActionError(
          '保存结果尚未确认。可保留当前内容，按原请求重试核对；编辑后会成为新的核验请求。',
        );
    } finally {
      if (current === lifecycle.current) {
        locked.current = false;
        setSaving(false);
        callback.current(false);
      }
    }
  };
  const filtered = report?.rows.filter((row) => filter === 'all' || rowState(row) === filter) ?? [];
  return (
    <section
      className="gap-panel"
      aria-label="需求实现与验证"
      data-testid="gap-report"
      data-status={readError ? 'error' : (report?.status ?? 'loading')}
      aria-busy={loading || saving}
    >
      <div className="gap-heading">
        <div>
          <h3>需求、实现与验证</h3>
          <p className="muted small">
            逐项核对目标与实际表现。源码关联只是线索，编译和启动观察不能代替业务核验。恢复源码后请刷新报告。
          </p>
        </div>
        <button
          className="button compact"
          data-testid="refresh-gap-report"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={14} />
          {loading ? '正在读取' : '刷新报告'}
        </button>
      </div>
      {readError && (
        <p className="field-error" role="alert">
          {readError}
        </p>
      )}
      {notice && (
        <p
          ref={resultNotice}
          tabIndex={-1}
          className="gap-notice"
          role="status"
          data-testid="gap-notice"
        >
          {notice}
        </p>
      )}
      {report?.status === 'empty' && (
        <p className="muted small">
          整理开发计划后，这里会列出每一项待核验目标。读取报告不调用模型。
        </p>
      )}
      {report?.status === 'stale' && (
        <p className="gap-warning" role="status" data-testid="gap-stale">
          当前计划或源码已不适用于最新确认方向。以下保留旧版本线索与记录；请先更新计划和源码，不能保存当前核验。
        </p>
      )}
      {archived && (
        <p className="muted small">项目已归档，可以查看记录；恢复项目后才能新增核验。</p>
      )}
      {report && report.status !== 'empty' && (
        <>
          <div className="gap-technical" data-testid="gap-technical">
            <div>
              <strong>编译证据</strong>
              <p>
                {currentBuild
                  ? `当前源码 v${report.binding!.sourceRevision} 已编译`
                  : report.build
                    ? '构建不适用于当前版本'
                    : '尚无当前构建'}
              </p>
              {report.build && (
                <span className="muted small">
                  源码 v{report.build.sourceRevision} · {date(report.build.createdAt)}
                </span>
              )}
            </div>
            <div>
              <strong>启动观察</strong>
              <p>
                {report.runtime
                  ? `${runtimeStatus[report.runtime.status]}${report.runtimeCurrent ? '' : ' · 已过期'}`
                  : '尚无启动观察记录'}
              </p>
              {report.runtime && (
                <span className="muted small">
                  源码 v{report.runtime.sourceRevision} · {date(report.runtime.updatedAt)}
                </span>
              )}
              {!!report.runtime?.issues.length && (
                <ul>
                  {report.runtime.issues.map((issue, index) => (
                    <li key={`${issue}:${index}`}>{runtimeIssueMessages[issue]}</li>
                  ))}
                </ul>
              )}
            </div>
            <p className="muted small gap-technical-note">
              以上技术证据独立展示，不会自动将任何需求标记为通过；启动观察也不覆盖所有交互。
            </p>
          </div>
          <div className="gap-mapping" data-testid="gap-mapping">
            <p className="muted small">
              {report.mapping === 'valid'
                ? '已读取源码关联声明。文件存在不代表功能已实现。'
                : report.mapping === 'invalid'
                  ? '源码关联声明无法使用；继续按计划列出目标，不能据此认定功能缺失。'
                  : '尚无源码关联声明；未关联不等于缺少实现。'}
            </p>
            {report.mappingNotes.length > 0 && (
              <ul className="muted small">
                {report.mappingNotes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="gap-toolbar">
            <label>
              查看
              <select
                data-testid="gap-filter"
                value={filter}
                disabled={saving}
                onChange={(event) => setFilter(event.target.value as Filter)}
              >
                {(Object.keys(labels) as Filter[]).map((value) => (
                  <option key={value} value={value}>
                    {labels[value]} ·{' '}
                    {value === 'all'
                      ? report.rows.length
                      : report.rows.filter((row) => rowState(row) === value).length}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted small">
              共 {report.rows.length} 项目标 · 保留 {report.historyCount} 条用户记录
            </span>
          </div>
          <div className="gap-groups" data-testid="gap-rows">
            {groups.map((group) => {
              const rows = filtered.filter((row) => row.kind === group.kind);
              if (!rows.length) return null;
              return (
                <section className="gap-group" key={group.kind}>
                  <h4>
                    {group.label}
                    <span>{rows.length} 项</span>
                  </h4>
                  <ul>
                    {rows.map((row) => (
                      <li
                        className="gap-row"
                        key={row.id}
                        data-testid="gap-row"
                        data-task-id={row.id}
                        data-verification={row.verification}
                        data-implementation={row.implementation}
                      >
                        <div className="gap-row-heading">
                          <div>
                            <h5>{row.title}</h5>
                            <span className="muted small">{row.id}</span>
                          </div>
                          <span
                            className={`gap-status is-${rowState(row)}`}
                            data-testid="gap-row-status"
                          >
                            {rowState(row) === 'passed'
                              ? '用户核验通过'
                              : rowState(row) === 'failed'
                                ? '用户核验未通过'
                                : rowState(row) === 'stale'
                                  ? '旧核验已过期'
                                  : labels[rowState(row)]}
                          </span>
                        </div>
                        <div className="gap-source-clues">
                          <span className="muted small">源码线索</span>
                          {row.files.length ? (
                            <ul>
                              {row.files.map((file) => (
                                <li key={file.path}>
                                  <code>{file.path}</code>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted small">尚未关联现有源码；需结合实际操作核验。</p>
                          )}
                          {row.missingPaths.length > 0 && (
                            <p className="gap-missing-paths">
                              声明中未找到的路径（线索）：
                              {row.missingPaths.map((path, index) => (
                                <span key={path}>
                                  {index > 0 ? '、' : ''}
                                  <code>{path}</code>
                                </span>
                              ))}
                            </p>
                          )}
                        </div>
                        {row.record && (
                          <details className="gap-record" data-testid="gap-record">
                            <summary>
                              {verdictLabel[row.record.request.verdict]} ·{' '}
                              {date(row.record.createdAt)}
                              {row.verification === 'stale' ? ' · 仅作旧版本记录' : ''}
                            </summary>
                            <dl>
                              <div>
                                <dt>操作步骤</dt>
                                <dd>{row.record.request.steps}</dd>
                              </div>
                              <div>
                                <dt>预期结果</dt>
                                <dd>{row.record.request.expected}</dd>
                              </div>
                              <div>
                                <dt>实际结果</dt>
                                <dd>{row.record.request.actual}</dd>
                              </div>
                              <div>
                                <dt>核验版本</dt>
                                <dd>
                                  源码 v{row.record.request.binding.sourceRevision} ·{' '}
                                  {row.record.request.binding.buildId ? '已关联构建' : '无构建'}
                                </dd>
                              </div>
                            </dl>
                          </details>
                        )}
                        <button
                          className="button compact gap-edit"
                          data-testid="open-gap-evidence"
                          disabled={saving || disabled}
                          aria-expanded={opened === row.id}
                          aria-controls={`gap-form-${row.id}`}
                          onClick={() => openForm(row)}
                        >
                          {opened === row.id
                            ? '收起核验'
                            : row.record
                              ? '记录新的用户核验'
                              : '记录用户核验'}
                          <ChevronDown size={14} />
                        </button>
                        {opened === row.id && draft && (
                          <form
                            id={`gap-form-${row.id}`}
                            className="gap-form"
                            data-testid="gap-evidence-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void save();
                            }}
                          >
                            <h6 ref={formTitle} tabIndex={-1}>
                              记录这项需求的核验结果
                            </h6>
                            <p className="muted small">
                              请先实际操作应用，再填写步骤、预期与实际现象。不要填写 API
                              Key、凭据或个人业务内容；此记录不自动发送给模型。
                            </p>
                            {draftStale && (
                              <div className="gap-warning">
                                <p>
                                  计划、源码或构建版本已变化，当前草稿仍属于旧版本。请重新操作核对后，再切换到当前版本。
                                </p>
                                <button
                                  type="button"
                                  className="button compact"
                                  data-testid="rebind-gap-evidence"
                                  disabled={busy || !writable}
                                  onClick={rebind}
                                >
                                  按当前版本重新核验
                                </button>
                              </div>
                            )}
                            {!writable && (
                              <p className="gap-warning">
                                当前版本不能保存核验。请恢复项目，并确认计划与源码适用于当前需求。
                              </p>
                            )}
                            {draft.request && (
                              <p className="muted small" data-testid="gap-pending-request">
                                上一次保存已发起。内容不变时只按原请求核对，不把旧核验当作当前结论；修改内容后将创建新请求。
                              </p>
                            )}
                            <label>
                              核验结果
                              <select
                                data-testid="gap-verdict"
                                value={draft.verdict}
                                disabled={busy}
                                onChange={(event) =>
                                  edit({ verdict: event.target.value as Verdict | '' })
                                }
                              >
                                <option value="">请选择</option>
                                <option value="passed">通过</option>
                                <option value="failed">未通过</option>
                                <option value="missing">确认缺少实现</option>
                              </select>
                            </label>
                            <fieldset className="gap-files" disabled={busy}>
                              <legend>关联当前源码文件</legend>
                              {report.sourceFiles.length ? (
                                <div>
                                  {report.sourceFiles.map((path) => (
                                    <label key={path}>
                                      <input
                                        type="checkbox"
                                        data-testid="gap-file"
                                        value={path}
                                        checked={draft.filePaths.includes(path)}
                                        disabled={
                                          !draft.filePaths.includes(path) &&
                                          draft.filePaths.length >= 32
                                        }
                                        onChange={(event) =>
                                          edit({
                                            filePaths: event.target.checked
                                              ? [...draft.filePaths, path]
                                              : draft.filePaths.filter((file) => file !== path),
                                          })
                                        }
                                      />
                                      <code>{path}</code>
                                    </label>
                                  ))}
                                </div>
                              ) : (
                                <p className="muted small">当前没有源码文件。</p>
                              )}
                            </fieldset>
                            {missingSelections.length > 0 && (
                              <p className="field-error">
                                草稿关联文件已不存在：{missingSelections.join('、')}
                                。请按当前版本重新核验并重新选择文件。
                              </p>
                            )}
                            {draft.verdict === 'passed' &&
                              (!currentBuild || !draft.filePaths.length) && (
                                <p className="muted small">
                                  记录通过需要当前源码的构建，以及至少一个关联源码文件。
                                </p>
                              )}
                            <label>
                              操作步骤
                              <textarea
                                data-testid="gap-steps"
                                value={draft.steps}
                                required
                                maxLength={2000}
                                disabled={busy}
                                rows={3}
                                placeholder="例如：打开应用，填写标题，点击保存，再关闭并重新打开。"
                                onChange={(event) => edit({ steps: event.target.value })}
                              />
                            </label>
                            <div className="gap-results">
                              <label>
                                预期结果
                                <textarea
                                  data-testid="gap-expected"
                                  value={draft.expected}
                                  required
                                  maxLength={2000}
                                  disabled={busy}
                                  rows={3}
                                  placeholder="描述应该出现的行为。"
                                  onChange={(event) => edit({ expected: event.target.value })}
                                />
                              </label>
                              <label>
                                实际结果
                                <textarea
                                  data-testid="gap-actual"
                                  value={draft.actual}
                                  required
                                  maxLength={2000}
                                  disabled={busy}
                                  rows={3}
                                  placeholder="只记录观察到的现象，不填写个人内容。"
                                  onChange={(event) => edit({ actual: event.target.value })}
                                />
                              </label>
                            </div>
                            {actionError && (
                              <p className="field-error" role="alert" data-testid="gap-save-error">
                                {actionError}
                              </p>
                            )}
                            <div className="gap-form-actions">
                              <button
                                className="button primary compact"
                                type="submit"
                                data-testid="save-gap-evidence"
                                disabled={
                                  busy ||
                                  (!draft.request &&
                                    (!!readError || !writable || draftStale || !valid))
                                }
                              >
                                {saving && <LoaderCircle size={14} className="spin" />}
                                {saving
                                  ? '正在保存'
                                  : draft.request
                                    ? '核对原请求'
                                    : '保存用户核验'}
                              </button>
                              <span className="muted small">
                                源码 v{draft.binding?.sourceRevision ?? '—'}
                              </span>
                            </div>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          {!filtered.length && <p className="muted small">此筛选条件下没有目标。</p>}
        </>
      )}
    </section>
  );
}
