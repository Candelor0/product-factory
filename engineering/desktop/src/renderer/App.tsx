import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  Archive,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Code2,
  FileText,
  Folder,
  FolderOpen,
  History,
  LayoutTemplate,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import type {
  ApiResult,
  AppSnapshot,
  DesignContent,
  Project,
  ProviderInput,
  RequirementContent,
  Revision,
  Stage,
} from '../shared/contracts';
import { api } from './api';
import { BlogRuntimePanel } from './RuntimePanel';
import { PlanPanel } from './PlanPanel';

type Tab = 'requirements' | 'design' | 'plan' | 'runtime' | 'history';
type SettingsTab = 'model' | 'environment';
type Notice = { kind: 'success' | 'error' | 'info'; message: string };
const stages: { id: Stage; label: string; caption: string }[] = [
  { id: 'idea', label: '描述想法', caption: '说说你想做什么' },
  { id: 'requirements', label: '确认需求', caption: '一起把方向想清楚' },
  { id: 'design', label: '确认页面', caption: '看看作品的样子' },
  { id: 'ready', label: '方向已确认', caption: '可整理计划并开发' },
];
const emptyRequirements: RequirementContent = {
  summary: '',
  audience: '',
  features: [],
  pages: [],
  data: [],
  outOfScope: [],
  questions: [],
  acceptance: [],
};
const listFields: {
  key: keyof Omit<RequirementContent, 'summary' | 'audience'>;
  label: string;
  hint: string;
}[] = [
  { key: 'features', label: '核心功能', hint: '这一版必须能做的事情' },
  { key: 'pages', label: '需要的页面', hint: '用户会看到哪些页面' },
  { key: 'data', label: '需要保存的内容', hint: '例如文章、分类和图片' },
  { key: 'outOfScope', label: '这一版暂时不做', hint: '明确边界，把重要的事情做好' },
  { key: 'questions', label: '还需要想清楚的问题', hint: '确认前请补充答案或删除已解决的问题' },
  { key: 'acceptance', label: '怎样算做好了', hint: '可以实际检查的完成标准' },
];
function date(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function last<T>(items: T[]): T | undefined {
  return items.at(-1);
}
function Brand({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? 'brand-symbol small' : 'brand-symbol'}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="34" height="34" rx="6" fill="currentColor" />
      <path d="M12 12h16v4H16v5h10v4H16v7h-4V12Z" fill="#fff" />
    </svg>
  );
}
function Button({
  children,
  className = '',
  loading = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button className={`button ${className}`} {...props}>
      {loading && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.tabIndex >= 0 && element.checkVisibility());
    focusables()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const elements = focusables();
        const first = elements[0];
        const end = elements.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialog?.contains(document.activeElement))
        ) {
          event.preventDefault();
          end?.focus();
        } else if (!event.shiftKey && document.activeElement === end) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="关闭窗口" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('requirements');
  const [archived, setArchived] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [ideaDraft, setIdeaDraft] = useState('');
  const [homeFocus, setHomeFocus] = useState(0);
  const creating = useRef(false);
  const [rename, setRename] = useState<Project | null>(null);
  const [busy, setBusy] = useState('');
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [help, setHelp] = useState(false);
  const project = snapshot?.projects.find((p) => p.id === selectedId);
  const activeProjects = snapshot?.projects.filter((p) => p.archived === archived) ?? [];

  const refresh = async () => {
    try {
      const result = await api.snapshot();
      if (result.ok) {
        setSnapshot(result.value);
        setLoadError('');
      } else setLoadError(result.error.message);
    } catch {
      setLoadError('工作台暂时无法读取本地数据，请重试。');
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (notice?.kind !== 'success') return;
    const timer = window.setTimeout(() => setNotice(null), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const run = async <T,>(
    label: string,
    task: () => Promise<ApiResult<T>>,
    success?: string,
    generation = false,
  ): Promise<T | undefined> => {
    if (busy) return;
    setBusy(label);
    setGenerating(generation);
    setNotice(null);
    try {
      const result = await task();
      if (!result.ok) {
        setNotice({ kind: 'error', message: result.error.message });
        return;
      }
      if (success) setNotice({ kind: 'success', message: success });
      return result.value;
    } catch {
      setNotice({ kind: 'error', message: '操作未完成。请检查桌面服务是否可用，再重试。' });
    } finally {
      await refresh();
      setBusy('');
      setGenerating(false);
    }
  };
  const choose = (id: string | null) => {
    setSelectedId(id);
    setTab('requirements');
  };
  const openHome = () => {
    setArchived(false);
    choose(null);
    setHomeFocus((value) => value + 1);
  };
  const create = async (idea: string) => {
    const content = idea.trim();
    if (!content || busy || creating.current) return;
    creating.current = true;
    try {
      const name = Array.from(content).slice(0, 18).join('').replace(/\s+/g, ' ').trim();
      const result = await run('正在创建项目', () => api.createProject({ name, idea: content }));
      if (result) {
        setIdeaDraft('');
        setArchived(false);
        choose(result.id);
      }
    } finally {
      creating.current = false;
    }
  };
  const archive = async (target: Project) => {
    const result = await run(
      '正在更新项目',
      () => api.archiveProject({ projectId: target.id, archived: !target.archived }),
      target.archived ? '项目已恢复。' : '项目已归档，随时可以恢复。',
    );
    if (result) {
      setArchived(result.archived);
    }
  };
  const cancel = async () => {
    try {
      const result = await api.cancelGeneration();
      setNotice(
        result.ok
          ? { kind: 'info', message: '已发送停止请求，正在结束当前调用。已保存的版本会保留。' }
          : { kind: 'error', message: result.error.message },
      );
    } catch {
      setNotice({ kind: 'error', message: '停止请求未送达，请稍后重试。' });
    }
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={openHome} aria-label="产品工厂首页">
          <Brand />
          <div>
            <strong>产品工厂</strong>
          </div>
        </button>
        <Button className="new-project-button" onClick={openHome} disabled={!!busy}>
          <Plus size={17} /> 新建项目
        </Button>
        <div className="project-list-heading" aria-label="项目分类">
          <button
            aria-pressed={!archived}
            onClick={() => {
              setArchived(false);
              choose(null);
            }}
          >
            项目
          </button>
          <button
            aria-pressed={archived}
            onClick={() => {
              setArchived(true);
              choose(null);
            }}
          >
            归档
          </button>
        </div>
        <nav className="project-list" aria-label="项目列表">
          {activeProjects.length ? (
            activeProjects.map((p) => (
              <button
                key={p.id}
                className={`project-item ${project?.id === p.id ? 'selected' : ''}`}
                onClick={() => choose(p.id)}
              >
                <span className="project-item-name" title={p.name}>
                  {p.name}
                </span>
                {project?.id === p.id && <span className="selected-dot" />}
              </button>
            ))
          ) : (
            <div className="sidebar-empty">
              <Folder size={20} />
              <span>{archived ? '暂无归档项目' : '暂无项目'}</span>
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            data-testid="settings-button"
            onClick={() => setSettingsTab('model')}
          >
            <Settings2 size={17} />
            模型与设置
            <span
              className={`connection-dot ${snapshot?.settings.lastCheckedAt && snapshot.settings.hasKey ? 'connected' : ''}`}
            />
          </button>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={17} />
            使用指南
          </button>
          <div className="sidebar-footnote">
            <span>本地工作台</span>
            <span>{snapshot?.environment.version ?? '0.8.0'}</span>
          </div>
        </div>
      </aside>
      <div className={`main-shell ${!project ? 'home-shell' : ''}`}>
        {project && (
          <header className="topbar">
            <div className="breadcrumbs">
              <span>工作空间</span>
              <ChevronRight size={13} />
              <strong>{project?.name ?? (archived ? '已归档' : '项目')}</strong>
            </div>
            <span className="topbar-caption">Web 应用 · 本地保存</span>
          </header>
        )}
        {snapshot?.environment.mode === 'browser-preview' && (
          <div className="preview-banner">
            <Monitor size={14} />
            <span>浏览器界面预览 · 项目保存与模型调用需在桌面版使用</span>
          </div>
        )}
        <div className="workspace">
          <main className="main-content">
            {loadError && (
              <div className="error-box" role="alert">
                <p>{loadError}</p>
                <Button onClick={() => void refresh()}>
                  <RefreshCw size={14} />
                  重新读取
                </Button>
              </div>
            )}
            {!snapshot && !loadError ? (
              <div className="loading-state">
                <LoaderCircle className="spin" size={26} />
                <p>正在打开你的工作空间…</p>
              </div>
            ) : project ? (
              <>
                <div className="project-heading">
                  <div>
                    <div className="project-title-row">
                      <h1>{project.name}</h1>
                      <button
                        className="icon-button"
                        disabled={!!busy}
                        aria-label="重命名项目"
                        onClick={() => setRename(project)}
                      >
                        <Pencil size={16} />
                      </button>
                    </div>
                    <p className="project-stage">
                      <span className="status-dot" />
                      {project.archived
                        ? '已归档'
                        : stages.find((stage) => stage.id === project.stage)?.label}
                      <span className="stage-separator">/</span>更新于 {date(project.updatedAt)}
                    </p>
                  </div>
                  <button
                    className="icon-button outlined"
                    disabled={!!busy}
                    aria-label={project.archived ? '恢复归档项目' : '归档项目'}
                    title={project.archived ? '恢复项目' : '归档项目'}
                    onClick={() => void archive(project)}
                  >
                    {project.archived ? <FolderOpen size={18} /> : <Archive size={18} />}
                  </button>
                </div>
                {project.archived && (
                  <div className="info-strip">
                    <Archive size={17} />
                    <span>这个项目已归档。恢复后可以继续修改与生成。</span>
                    <Button
                      className="compact"
                      disabled={!!busy}
                      onClick={() => void archive(project)}
                    >
                      恢复项目
                    </Button>
                  </div>
                )}
                <div className="tabs project-tabs" role="tablist" aria-label="项目内容">
                  {(
                    [
                      { id: 'requirements', title: '需求', icon: FileText },
                      { id: 'design', title: '页面方向', icon: LayoutTemplate },
                      { id: 'plan', title: '开发计划', icon: ClipboardList },
                      { id: 'runtime', title: '运行样例', icon: Monitor },
                      { id: 'history', title: '版本记录', icon: History },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      role="tab"
                      aria-selected={tab === item.id}
                      className={tab === item.id ? 'active' : ''}
                      onClick={() => setTab(item.id)}
                    >
                      <item.icon size={16} />
                      {item.title}
                      {item.id === 'history' && (
                        <span>{project.requirements.length + project.designs.length}</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="tab-panel" role="tabpanel">
                  {tab === 'requirements' && (
                    <Requirements
                      key={project.id}
                      project={project}
                      busy={!!busy}
                      hasKey={!!snapshot?.settings.hasKey}
                      onConfigure={() => setSettingsTab('model')}
                      onGenerate={(instruction) =>
                        run(
                          '正在整理需求',
                          () => api.generateRequirements({ projectId: project.id, instruction }),
                          '新的需求版本已生成，请审阅。',
                          true,
                        )
                      }
                      onSave={(content) =>
                        run(
                          '正在保存需求',
                          () => api.saveRequirements({ projectId: project.id, content }),
                          '需求已保存为新版本。',
                        )
                      }
                      onApprove={(revisionId) =>
                        run(
                          '正在确认需求',
                          () => api.approveRequirements({ projectId: project.id, revisionId }),
                          '需求已确认，可以继续选择页面方向。',
                        )
                      }
                      onNext={() => setTab('design')}
                    />
                  )}
                  {tab === 'design' && (
                    <Design
                      project={project}
                      busy={!!busy}
                      hasKey={!!snapshot?.settings.hasKey}
                      onConfigure={() => setSettingsTab('model')}
                      onBack={() => setTab('requirements')}
                      onPlan={() => setTab('plan')}
                      onGenerate={(instruction) =>
                        run(
                          '正在构思页面方向',
                          () => api.generateDesign({ projectId: project.id, instruction }),
                          '页面方向已生成，请审阅草案。',
                          true,
                        )
                      }
                      onApprove={(revisionId) =>
                        run(
                          '正在确认页面方向',
                          () => api.approveDesign({ projectId: project.id, revisionId }),
                          '页面方向已确认。前往开发计划，整理后可开始自动开发。',
                        )
                      }
                    />
                  )}
                  {tab === 'history' && <ProjectHistory project={project} />}
                  {tab === 'plan' && (
                    <PlanPanel
                      key={project.id}
                      project={project}
                      disabled={!!busy}
                      onRequirements={() => setTab('requirements')}
                      onDesign={() => setTab('design')}
                      onWorkflow={(input, reconcile) =>
                        run(
                          reconcile
                            ? '正在核对自动开发记录'
                            : input.mode === 'generate'
                              ? '正在自动开发'
                              : input.mode === 'modify'
                                ? '正在修改并检查'
                                : '正在检查已有源码并继续',
                          () => api.runWorkflow(input),
                          undefined,
                          true,
                        )
                      }
                      onGenerate={(input) =>
                        run('正在生成源码草稿', () => api.generateSource(input), undefined, true)
                      }
                      onBuild={(input) =>
                        run('正在构建页面', () => api.buildSource(input), undefined, true)
                      }
                      onCheckRuntime={(input) =>
                        run('正在检查页面启动', () => api.checkRuntime(input), undefined, true)
                      }
                      onOpenApplication={(input) =>
                        run('正在打开本地应用', () => api.openApplication(input), undefined, true)
                      }
                      onRepair={(input) =>
                        run(
                          input.runtimeReportId ? '正在修复运行错误并复检' : '正在自动修复并构建',
                          () => api.repairSource(input),
                          undefined,
                          true,
                        )
                      }
                    />
                  )}
                  {tab === 'runtime' && (
                    <BlogRuntimePanel key={project.id} project={project} disabled={!!busy} />
                  )}
                </div>
              </>
            ) : snapshot ? (
              <section
                className="idea-home"
                data-testid="idea-home"
                aria-labelledby="idea-home-title"
              >
                <h1 id="idea-home-title">你想做一个什么应用？</h1>
                <IdeaComposer
                  idea={ideaDraft}
                  onChange={setIdeaDraft}
                  onCreate={create}
                  busy={!!busy}
                  focusSignal={homeFocus}
                />
              </section>
            ) : null}
          </main>
        </div>
      </div>
      {busy && (
        <div className="activity-bar" role="status">
          <LoaderCircle size={17} className="spin" />
          <span>
            {busy}
            {generating ? '，请稍候…' : '…'}
          </span>
          {generating && (
            <button onClick={() => void cancel()}>
              <Square size={12} />
              停止
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'success' ? <Check size={18} /> : <CircleHelp size={18} />}
          <span>{notice.message}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {rename && (
        <Modal title="重命名项目" onClose={() => setRename(null)}>
          <RenameForm
            project={rename}
            busy={!!busy}
            onRename={async (name) => {
              const result = await run(
                '正在重命名',
                () => api.renameProject({ projectId: rename.id, name }),
                '项目名称已更新。',
              );
              if (result) setRename(null);
            }}
          />
        </Modal>
      )}
      {settingsTab && snapshot && (
        <Modal title="模型与设置" wide onClose={() => setSettingsTab(null)}>
          <SettingsPanel
            snapshot={snapshot}
            tab={settingsTab}
            onTab={setSettingsTab}
            busy={!!busy}
            onSave={(input) =>
              run('正在保存模型设置', () => api.saveProvider(input), '模型设置已保存。')
            }
            onTest={() =>
              run('正在检测模型连接', () => api.checkProvider(), undefined, true).then((result) => {
                if (result) setNotice({ kind: 'success', message: result.message });
              })
            }
            onDelete={() => run('正在移除密钥', () => api.deleteProviderKey(), '密钥已移除。')}
            onOpenData={() => run('正在打开数据目录', () => api.openDataFolder())}
          />
        </Modal>
      )}
      {help && (
        <Modal title="使用指南" onClose={() => setHelp(false)}>
          <div className="guide-content">
            <p>
              产品工厂是你的本地创作工作台。从想法开始，确认需求和页面方向，再开发、检查和调整应用。
            </p>
            <ol>
              <li>
                <strong>连接模型</strong>
                <p>在「模型与设置」填入你自己的 API Key，然后检测连接。</p>
              </li>
              <li>
                <strong>写下想法</strong>
                <p>说清楚谁会使用、想解决什么问题。无需使用专业术语。</p>
              </li>
              <li>
                <strong>确认需求与页面</strong>
                <p>审阅 AI 整理的内容，可以直接修改、补充。确认后会保存对应版本。</p>
              </li>
              <li>
                <strong>整理计划并自动开发</strong>
                <p>
                  前往「开发计划」，先整理任务，再点击「自动开发」。确认方向和整理计划不会自动调用模型开发。
                </p>
              </li>
              <li>
                <strong>核验功能并继续调整</strong>
                <p>
                  启动检查通过后，打开本地应用实际操作，在差距报告记录结果。已有应用可用文字描述修改要求。
                </p>
              </li>
            </ol>
            <div className="info-strip">
              <Code2 size={18} />
              <span>
                自动开发和修改可能产生模型费用。编译与启动检查不能代替业务核验；本地应用是否保存内容取决于生成的功能。
              </span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function IdeaComposer({
  idea,
  onChange,
  onCreate,
  busy,
  focusSignal,
}: {
  idea: string;
  onChange: (value: string) => void;
  onCreate: (idea: string) => Promise<void>;
  busy: boolean;
  focusSignal: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [focusSignal]);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }, [idea]);
  return (
    <form
      className="idea-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && idea.trim()) void onCreate(idea);
      }}
    >
      <textarea
        ref={ref}
        id="idea-input"
        aria-label="描述你的应用想法"
        placeholder="说说你的想法，比如做一个记录生活的博客…"
        value={idea}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (!busy && idea.trim()) event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={busy}
        maxLength={8000}
        rows={1}
        required
      />
      <button
        className="idea-submit"
        type="submit"
        aria-label="创建项目"
        title="开始 · Enter提交，Shift+Enter换行"
        disabled={!idea.trim() || busy}
      >
        {busy ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}
        <span>开始</span>
      </button>
    </form>
  );
}
function RenameForm({
  project,
  busy,
  onRename,
}: {
  project: Project;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(project.name);
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void onRename(name.trim());
      }}
    >
      <label>
        项目名称
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
      </label>
      <Button
        className="primary full"
        type="submit"
        disabled={busy || !name.trim() || name.trim() === project.name}
      >
        保存名称
      </Button>
    </form>
  );
}
function Requirements({
  project,
  busy,
  hasKey,
  onConfigure,
  onGenerate,
  onSave,
  onApprove,
  onNext,
}: {
  project: Project;
  busy: boolean;
  hasKey: boolean;
  onConfigure: () => void;
  onGenerate: (instruction: string) => Promise<unknown>;
  onSave: (content: RequirementContent) => Promise<unknown>;
  onApprove: (id: string) => Promise<unknown>;
  onNext: () => void;
}) {
  const revision = last(project.requirements);
  const [draft, setDraft] = useState<RequirementContent>(revision?.content ?? emptyRequirements);
  const [instruction, setInstruction] = useState('');
  useEffect(() => {
    setDraft(revision?.content ?? emptyRequirements);
  }, [revision?.id]);
  const dirty = !!revision && JSON.stringify(draft) !== JSON.stringify(revision.content);
  const locked = busy || project.archived;
  return (
    <div className="content-stack">
      <details className="idea-summary" open={!revision}>
        <summary>最初的想法</summary>
        <p>{project.idea}</p>
      </details>
      {revision ? (
        <>
          <div className="section-heading">
            <div>
              <h2>需求</h2>
              <p>修改后保存为新版本，再确认。</p>
            </div>
            <span className={`revision-badge ${revision.approvedAt ? 'approved' : ''}`}>
              v{revision.version} · {revision.approvedAt ? '已确认' : '待确认'}
            </span>
          </div>
          <div className="requirements-form">
            <label>
              你要做什么
              <textarea
                rows={3}
                value={draft.summary}
                disabled={locked}
                maxLength={8000}
                onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
              />
            </label>
            <label>
              谁会使用它
              <textarea
                rows={2}
                value={draft.audience}
                disabled={locked}
                maxLength={2000}
                onChange={(e) => setDraft({ ...draft, audience: e.target.value })}
              />
            </label>
            {listFields.slice(0, 2).map((field) => (
              <label key={field.key}>
                {field.label}
                <textarea
                  rows={Math.min(5, Math.max(2, draft[field.key].length + 1))}
                  disabled={locked}
                  value={draft[field.key].join('\n')}
                  maxLength={16000}
                  placeholder="每行写一项"
                  onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value.split('\n') })}
                />
              </label>
            ))}
            <details className="requirements-details">
              <summary data-testid="requirements-details-toggle">
                更多需求 <span>数据、范围与验收</span>
              </summary>
              <div className="requirements-extra">
                {listFields.slice(2).map((field) => (
                  <label key={field.key}>
                    {field.label}
                    <small>{field.hint}</small>
                    <textarea
                      rows={Math.min(5, Math.max(2, draft[field.key].length + 1))}
                      disabled={locked}
                      value={draft[field.key].join('\n')}
                      maxLength={16000}
                      placeholder="每行写一项"
                      onChange={(e) =>
                        setDraft({ ...draft, [field.key]: e.target.value.split('\n') })
                      }
                    />
                  </label>
                ))}
              </div>
            </details>
          </div>
          {draft.questions.some((question) => question.trim()) && (
            <div className="info-strip">
              <CircleHelp size={17} />
              <span>
                仍有 {draft.questions.filter((question) => question.trim()).length}{' '}
                项待明确问题，可展开「更多需求」查看。确认版本不会将它们标记为已解决。
              </span>
            </div>
          )}
          <div className="document-actions">
            <span>{dirty ? '有尚未保存的修改' : `保存于 ${date(revision.createdAt)}`}</span>
            <div>
              <Button
                disabled={locked || !dirty || !draft.summary.trim() || !draft.audience.trim()}
                onClick={() =>
                  void onSave({
                    ...draft,
                    features: draft.features.filter((v) => v.trim()),
                    pages: draft.pages.filter((v) => v.trim()),
                    data: draft.data.filter((v) => v.trim()),
                    outOfScope: draft.outOfScope.filter((v) => v.trim()),
                    questions: draft.questions.filter((v) => v.trim()),
                    acceptance: draft.acceptance.filter((v) => v.trim()),
                  })
                }
              >
                保存修改
              </Button>
              {revision.approvedAt && !dirty ? (
                <Button className="primary" data-testid="requirements-design-next" onClick={onNext}>
                  查看页面方向
                  <ArrowRight size={15} />
                </Button>
              ) : (
                <Button
                  className="primary"
                  data-testid="approve-requirements"
                  disabled={locked || dirty}
                  title={dirty ? '请先保存修改，再确认当前版本' : undefined}
                  onClick={() => void onApprove(revision.id)}
                >
                  确认这版需求
                  <Check size={15} />
                </Button>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="prepare-state">
          <span className="empty-icon">
            <FileText size={26} />
          </span>
          <h2>整理需求</h2>
          <p>从想法中整理功能、页面和待明确问题，审阅后确认。</p>
        </div>
      )}
      <GenerationComposer
        label={revision ? '调整需求' : '补充说明（可选）'}
        placeholder={
          revision
            ? '比如：先不做评论功能，文章分类可以简单一点……'
            : '比如：主要给自己使用，希望页面简单清爽。不确定的地方也可以直接说。'
        }
        instruction={instruction}
        onChange={setInstruction}
        busy={locked}
        hasKey={hasKey}
        onConfigure={onConfigure}
        onGenerate={() => {
          void onGenerate(instruction);
        }}
        buttonText={revision ? '重新整理需求' : '整理需求'}
        disabledReason={dirty ? '请先保存修改，再请 AI 重新整理。' : undefined}
      />
    </div>
  );
}
function GenerationComposer({
  label,
  placeholder,
  instruction,
  onChange,
  busy,
  hasKey,
  onConfigure,
  onGenerate,
  buttonText,
  disabledReason,
}: {
  label: string;
  placeholder: string;
  instruction: string;
  onChange: (value: string) => void;
  busy: boolean;
  hasKey: boolean;
  onConfigure: () => void;
  onGenerate: () => void;
  buttonText: string;
  disabledReason?: string;
}) {
  return (
    <div className="generation-composer">
      <label>
        {label}
        <textarea
          value={instruction}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy}
          placeholder={placeholder}
          rows={3}
          maxLength={8000}
        />
      </label>
      <div className="generation-footer">
        <span>
          {disabledReason || (hasKey ? '将调用模型，消耗账户额度' : '先连接模型，即可开始整理')}
        </span>
        {hasKey ? (
          <Button className="primary" disabled={busy || !!disabledReason} onClick={onGenerate}>
            {buttonText}
            <ArrowRight size={15} />
          </Button>
        ) : (
          <Button className="soft" onClick={onConfigure}>
            连接模型
            <ArrowRight size={15} />
          </Button>
        )}
      </div>
    </div>
  );
}
function Design({
  project,
  busy,
  hasKey,
  onConfigure,
  onBack,
  onPlan,
  onGenerate,
  onApprove,
}: {
  project: Project;
  busy: boolean;
  hasKey: boolean;
  onConfigure: () => void;
  onBack: () => void;
  onPlan: () => void;
  onGenerate: (instruction: string) => Promise<unknown>;
  onApprove: (id: string) => Promise<unknown>;
}) {
  const requirements = last(project.requirements);
  const revision = last(project.designs.filter((item) => item.basedOn === requirements?.id));
  const [instruction, setInstruction] = useState('');
  if (!requirements?.approvedAt)
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <LayoutTemplate size={29} />
        </span>
        <h2>页面方向</h2>
        <p>请先确认当前需求版本，页面方向会以它为依据。</p>
        <Button className="primary" onClick={onBack}>
          返回确认需求
          <ArrowLeft size={15} />
        </Button>
      </div>
    );
  return (
    <div className="content-stack">
      {revision ? (
        <>
          <div className="section-heading">
            <div>
              <h2>页面方向</h2>
              <p>内容结构与配色草案，尚未接入真实功能。</p>
            </div>
            <span className={`revision-badge ${revision.approvedAt ? 'approved' : ''}`}>
              v{revision.version} · {revision.approvedAt ? '已确认' : '待确认'}
            </span>
          </div>
          <DesignPreview content={revision.content} />
          {revision.approvedAt && project.stage === 'ready' ? (
            <div className="ready-state">
              <span>
                <CheckCheck size={22} />
              </span>
              <div>
                <h3>方向已确认</h3>
                <p>先整理开发计划，再点击「自动开发」生成和检查应用。</p>
                <Button
                  className="primary compact"
                  data-testid="design-plan-next"
                  disabled={busy}
                  onClick={onPlan}
                >
                  前往开发计划 <ArrowRight size={14} />
                </Button>
              </div>
            </div>
          ) : (
            <div className="document-actions">
              <span>确认代表你认可这版方向草案</span>
              <Button
                className="primary"
                data-testid="approve-design"
                disabled={busy || project.archived}
                onClick={() => void onApprove(revision.id)}
              >
                确认页面方向
                <Check size={15} />
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="prepare-state">
          <span className="empty-icon">
            <LayoutTemplate size={28} />
          </span>
          <h2>生成页面方向</h2>
          <p>根据已确认需求整理配色与页面结构，审阅后确认。</p>
        </div>
      )}
      <GenerationComposer
        label="外观偏好（可选）"
        placeholder="比如：暖白色背景，留白多一些，像一本安静的杂志。也可以交给 AI 建议。"
        instruction={instruction}
        onChange={setInstruction}
        busy={busy || project.archived}
        hasKey={hasKey}
        onConfigure={onConfigure}
        onGenerate={() => void onGenerate(instruction)}
        buttonText={revision ? '重新构思页面' : '生成页面方向'}
      />
    </div>
  );
}
function DesignPreview({ content }: { content: DesignContent }) {
  return (
    <>
      <div className="design-direction">
        <h3>视觉方向</h3>
        <p>{content.direction}</p>
        <div className="palette" aria-label="建议配色">
          {content.palette.map((color, i) => (
            <span
              key={`${color}-${i}`}
              style={{ backgroundColor: color }}
              title={color}
              aria-label={color}
            />
          ))}
        </div>
        <details className="palette-details">
          <summary>颜色值</summary>
          <p>{content.palette.join(' · ')}</p>
        </details>
      </div>
      <div className="wireframes">
        {content.pages.map((page, index) => (
          <article className="wireframe-card" key={`${page.name}-${index}`}>
            <div className="wireframe-title">
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h3>{page.name}</h3>
            </div>
            <ol>
              {page.sections.map((section, sectionIndex) => (
                <li key={`${section}-${sectionIndex}`}>{section}</li>
              ))}
            </ol>
          </article>
        ))}
      </div>
      {!!content.notes.length && (
        <details className="design-notes">
          <summary>方案说明</summary>
          <ul>
            {content.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
function ProjectHistory({ project }: { project: Project }) {
  const [view, setView] = useState<
    | { kind: 'requirements'; revision: Revision<RequirementContent> }
    | { kind: 'design'; revision: Revision<DesignContent> }
    | null
  >(null);
  const revisions = [
    ...project.requirements.map((revision) => ({ kind: 'requirements' as const, revision })),
    ...project.designs.map((revision) => ({ kind: 'design' as const, revision })),
  ].sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt));
  return (
    <div className="content-stack">
      <div className="section-heading">
        <div>
          <h2>版本记录</h2>
          <p>已保存的内容和确认记录，会保留在这里。</p>
        </div>
      </div>
      {revisions.length ? (
        <div className="history-list">
          {revisions.map((item) => (
            <button className="history-item" key={item.revision.id} onClick={() => setView(item)}>
              <span className="history-icon">
                {item.kind === 'requirements' ? (
                  <FileText size={18} />
                ) : (
                  <LayoutTemplate size={18} />
                )}
              </span>
              <span>
                <strong>
                  {item.kind === 'requirements' ? '需求' : '页面方向'} · v{item.revision.version}
                </strong>
                <small>{date(item.revision.createdAt)}</small>
              </span>
              <span className={`revision-badge ${item.revision.approvedAt ? 'approved' : ''}`}>
                {item.revision.approvedAt ? '已确认' : '已保存'}
              </span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state small-empty">
          <History size={27} />
          <h3>还没有保存的版本</h3>
          <p>生成或保存需求后，版本会显示在这里。</p>
        </div>
      )}
      {!!project.activity.length && (
        <div>
          <h3 className="subheading">活动记录</h3>
          <ol className="activity-list">
            {[...project.activity].reverse().map((activity) => (
              <li key={activity.id}>
                <span />
                <div>
                  <p>{activity.message}</p>
                  <time>{date(activity.at)}</time>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {view && (
        <Modal
          title={`${view.kind === 'requirements' ? '需求' : '页面方向'} · v${view.revision.version}`}
          eyebrow="只读历史"
          wide
          onClose={() => setView(null)}
        >
          <div className="history-preview">
            <p className="history-date">
              保存于 {date(view.revision.createdAt)}
              {view.revision.approvedAt && ` · 确认于 ${date(view.revision.approvedAt)}`}
            </p>
            {view.kind === 'design' ? (
              <DesignPreview content={view.revision.content} />
            ) : (
              <>
                <h3>项目概述</h3>
                <p>{view.revision.content.summary}</p>
                <h3>谁会使用</h3>
                <p>{view.revision.content.audience}</p>
                {listFields.map((field) => (
                  <section key={field.key}>
                    <h3>{field.label}</h3>
                    <ul>
                      {view.revision.content[field.key].map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                    {!view.revision.content[field.key].length && <p className="muted">未填写</p>}
                  </section>
                ))}
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
function SettingsPanel({
  snapshot,
  tab,
  onTab,
  busy,
  onSave,
  onTest,
  onDelete,
  onOpenData,
}: {
  snapshot: AppSnapshot;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  busy: boolean;
  onSave: (input: ProviderInput) => Promise<unknown>;
  onTest: () => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onOpenData: () => Promise<unknown>;
}) {
  const { settings, environment } = snapshot;
  const [provider, setProvider] = useState(settings.provider);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [key, setKey] = useState('');
  const [maxCalls, setMaxCalls] = useState(String(settings.maxCalls));
  const [limitTokens, setLimitTokens] = useState(settings.maxTokens !== null);
  const [maxTokens, setMaxTokens] = useState(
    settings.maxTokens === null ? '' : String(settings.maxTokens),
  );
  const [advanced, setAdvanced] = useState(settings.provider === 'custom');
  const tokenLimit = limitTokens ? Number(maxTokens) : null;
  const tokenLimitValid =
    !limitTokens ||
    (settings.legacyUnknownUsageCalls === 0 &&
      Number.isInteger(tokenLimit) &&
      tokenLimit !== null &&
      tokenLimit >= 1 &&
      tokenLimit <= 100000000);
  const changed =
    provider !== settings.provider ||
    baseUrl !== settings.baseUrl ||
    model !== settings.model ||
    key !== '' ||
    Number(maxCalls) !== settings.maxCalls ||
    tokenLimit !== settings.maxTokens;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!tokenLimitValid) return;
    const input: ProviderInput = {
      provider,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      maxCalls: Number(maxCalls),
      maxTokens: tokenLimit,
      ...(key.trim() ? { apiKey: key.trim() } : {}),
    };
    setKey('');
    await onSave(input);
  };
  return (
    <>
      <div className="settings-tabs">
        <button className={tab === 'model' ? 'active' : ''} onClick={() => onTab('model')}>
          模型连接
        </button>
        <button
          className={tab === 'environment' ? 'active' : ''}
          onClick={() => onTab('environment')}
        >
          工作空间
        </button>
      </div>
      {tab === 'model' ? (
        <form onSubmit={(e) => void save(e)} className="form-stack settings-form">
          <div className="provider-intro">
            <div>
              <strong>{provider === 'deepseek' ? 'DeepSeek' : '自定义服务'}</strong>
              <p>
                {provider === 'deepseek'
                  ? settings.model
                  : '兼容性需要实际检测，不保证所有服务可用'}
              </p>
            </div>
            <span
              className={`revision-badge ${settings.hasKey && settings.lastCheckedAt ? 'approved' : ''}`}
            >
              {settings.hasKey ? (settings.lastCheckedAt ? '已检测' : '待检测') : '未连接'}
            </span>
          </div>
          <label>
            模型服务
            <select
              value={provider}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value as 'deepseek' | 'custom';
                setProvider(next);
                if (next === 'deepseek') {
                  setBaseUrl('https://api.deepseek.com');
                  setModel('deepseek-flash');
                } else setAdvanced(true);
              }}
            >
              <option value="deepseek">DeepSeek</option>
              <option value="custom">自定义兼容服务（需验证）</option>
            </select>
          </label>
          <label>
            API Key <span className="label-note">仅用于你自己的模型账户</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              disabled={busy}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                settings.hasKey ? '已保存密钥，留空保留；输入以替换' : '粘贴你的 API Key'
              }
              maxLength={4096}
            />
          </label>
          <div className="form-help">
            <LockKeyhole size={14} />
            <span>
              {settings.storage === 'encrypted'
                ? '密钥已通过系统安全能力加密保存，不会回传到界面。'
                : settings.storage === 'session'
                  ? '当前密钥仅本次打开有效，退出后需要重新填写。'
                  : '密钥由桌面服务管理，不会写入生成页面或普通日志。'}
            </span>
          </div>
          <button className="advanced-toggle" type="button" onClick={() => setAdvanced(!advanced)}>
            <ChevronRight size={15} className={advanced ? 'rotated' : ''} />
            高级连接设置
          </button>
          {advanced && (
            <div className="advanced-fields">
              <label>
                服务地址
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  required
                  disabled={busy}
                  placeholder="https://api.deepseek.com"
                />
              </label>
              <label>
                模型名称
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  required
                  disabled={busy}
                  placeholder="deepseek-flash"
                  maxLength={120}
                />
              </label>
            </div>
          )}
          <label>
            开发调用额度
            <div className="budget-input">
              <input
                type="number"
                data-testid="development-call-limit"
                min={1}
                max={10000}
                step={1}
                required
                value={maxCalls}
                onChange={(e) => setMaxCalls(e.target.value)}
                disabled={busy}
              />
              <span>次调用</span>
            </div>
            <small>
              已调用 {snapshot.usage.calls} 次。需求、源码生成与修复共用累计额度，重启不会清零。
            </small>
          </label>
          <div className="development-token-budget">
            <label className="token-limit-toggle">
              <input
                type="checkbox"
                data-testid="development-token-toggle"
                checked={limitTokens}
                disabled={busy || settings.legacyUnknownUsageCalls > 0}
                onChange={(event) => setLimitTokens(event.target.checked)}
              />
              限制开发 token 总量（输入＋输出）
            </label>
            {limitTokens && (
              <label>
                开发 token 额度
                <div className="budget-input">
                  <input
                    type="number"
                    data-testid="development-token-limit"
                    min={1}
                    max={100000000}
                    step={1}
                    required
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    disabled={busy || settings.legacyUnknownUsageCalls > 0}
                  />
                  <span>token</span>
                </div>
              </label>
            )}
            <p className="muted small">
              {limitTokens
                ? '额度不足以发送下一次请求时暂停，已保存的成果保留。'
                : '未设置 token 额度，仍受开发调用额度限制。'}
              费用由模型供应商结算，已发送的请求可能仍计费。
            </p>
            {settings.legacyUnknownUsageCalls > 0 && (
              <p className="warning-text small" data-testid="legacy-token-warning">
                有 {settings.legacyUnknownUsageCalls} 次历史调用缺少用量，无法核对累计
                token，暂不能启用 token 额度。开发调用额度仍有效。
              </p>
            )}
          </div>
          <details className="settings-usage" data-testid="settings-usage">
            <summary>
              开发累计用量 <span>{snapshot.usage.calls} 次调用</span>
            </summary>
            <dl>
              <div>
                <dt>token 额度已占用</dt>
                <dd>{settings.budgetTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>已知 token</dt>
                <dd>
                  {(snapshot.usage.inputTokens + snapshot.usage.outputTokens).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>费用</dt>
                <dd>未知，以供应商账单为准</dd>
              </div>
            </dl>
            {!!snapshot.usage.unknownUsageCalls && (
              <p className="warning-text">
                {snapshot.usage.unknownUsageCalls}{' '}
                次调用未返回完整用量，实际用量仍待核对。有预留记录的请求继续占用额度，不按零计算。
              </p>
            )}
          </details>
          <div className="privacy-note">
            <ShieldCheck size={17} />
            <p>调用模型时，当前项目的相关需求会发送给所选服务。只会发送完成任务所需的内容。</p>
          </div>
          <div className="settings-actions">
            <Button
              type="button"
              className="danger-quiet"
              disabled={busy || !settings.hasKey}
              onClick={() => void onDelete()}
            >
              移除密钥
            </Button>
            <div>
              <Button
                type="button"
                disabled={busy || !settings.hasKey || changed}
                title={
                  changed
                    ? '请先保存新的配置，再检测连接'
                    : !settings.hasKey
                      ? '请先保存 API Key'
                      : undefined
                }
                onClick={() => void onTest()}
                data-testid="test-model-connection"
              >
                <RefreshCw size={14} />
                检测连接
              </Button>
              <Button
                className="primary"
                type="submit"
                data-testid="save-model-settings"
                disabled={
                  busy ||
                  !changed ||
                  !model.trim() ||
                  !baseUrl.trim() ||
                  !Number.isInteger(Number(maxCalls)) ||
                  Number(maxCalls) < 1 ||
                  Number(maxCalls) > 10000 ||
                  !tokenLimitValid
                }
              >
                保存设置
                <Check size={15} />
              </Button>
            </div>
          </div>
          {changed && (
            <p className="settings-hint">先保存设置，再检测连接。检测会产生一次真实模型调用。</p>
          )}
          {settings.lastCheckedAt && (
            <p className="settings-hint">最近检测：{date(settings.lastCheckedAt)}</p>
          )}
        </form>
      ) : (
        <div className="environment-content">
          <div className="environment-lead">
            <span className="empty-icon">
              <Monitor size={25} />
            </span>
            <div>
              <h3>你的本地工作空间</h3>
              <p>项目、需求和版本由工作台保存在本机。</p>
            </div>
          </div>
          <dl className="environment-list">
            <div>
              <dt>当前模式</dt>
              <dd>{environment.mode === 'desktop' ? '桌面工作台' : '浏览器界面预览'}</dd>
            </div>
            <div>
              <dt>系统与架构</dt>
              <dd>
                {environment.platform} · {environment.arch}
              </dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>{environment.version}</dd>
            </div>
            <div>
              <dt>安全密钥存储</dt>
              <dd>
                {environment.secureStorage ? '系统加密可用' : '系统加密不可用，密钥仅会话保管'}
              </dd>
            </div>
            <div>
              <dt>数据目录</dt>
              <dd className="data-path">{environment.dataPath}</dd>
            </div>
          </dl>
          <Button
            disabled={busy || environment.mode !== 'desktop'}
            onClick={() => void onOpenData()}
          >
            <FolderOpen size={16} />
            打开数据文件夹
          </Button>
          <div className="info-strip">
            <CircleHelp size={17} />
            <span>
              支持源码生成、前端构建、有限修复、项目数据保存和源码导出。功能范围与验证情况可在项目文档中查看。
            </span>
          </div>
        </div>
      )}
    </>
  );
}
