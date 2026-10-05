import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BLOG_LIMITS, type BlogArticle } from '../../src/shared/blog-contracts';

type ArticleStatus = 'draft' | 'published';
type View =
  { name: 'home' | 'articles' | 'manage' } | { name: 'detail'; id: string } | { name: 'edit' };
type Editor = {
  id?: string;
  revision?: number;
  title: string;
  body: string;
  tags: string;
  status: ArticleStatus;
};
type Feedback = { kind: 'success' | 'error'; message: string } | null;
type PendingNavigation = { view: View; editor?: Editor } | null;

const blankEditor = (): Editor => ({ title: '', body: '', tags: '', status: 'draft' });
const fromArticle = (article: BlogArticle): Editor => ({
  id: article.id,
  revision: article.revision,
  title: article.title,
  body: article.body,
  tags: article.tags.join('，'),
  status: article.status,
});
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(value));

class RequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    throw new RequestError(
      options?.method
        ? '保存结果尚未确认。请保持当前内容，先在文章管理中核对是否已保存。'
        : '暂时无法读取文章，请确认工作台中的博客样例仍在运行，然后重试。',
      'NETWORK_ERROR',
    );
  }
  let payload: { ok: boolean; value?: T; error?: { code?: string; message?: string } };
  try {
    payload = await response.json();
  } catch {
    throw new RequestError(
      '本地服务返回了无法识别的结果，请保留编辑内容并重试。',
      'INVALID_RESPONSE',
    );
  }
  if (!response.ok || !payload.ok) {
    throw new RequestError(
      payload.error?.message || '这次操作未完成，请稍后重试。',
      payload.error?.code || 'REQUEST_FAILED',
    );
  }
  return payload.value as T;
}

function App() {
  const [articles, setArticles] = useState<BlogArticle[]>([]);
  const [view, setView] = useState<View>({ name: 'home' });
  const [tag, setTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [editor, setEditor] = useState<Editor>(blankEditor);
  const [savedEditor, setSavedEditor] = useState(() => JSON.stringify(blankEditor()));
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation>(null);
  const mainRef = useRef<HTMLElement>(null);
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dirty = view.name === 'edit' && JSON.stringify(editor) !== savedEditor;
  const published = articles.filter((article) => article.status === 'published');
  const allTags = [...new Set(published.flatMap((article) => article.tags))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  const filtered = published.filter((article) => tag === null || article.tags.includes(tag));
  const selected =
    view.name === 'detail' ? articles.find((article) => article.id === view.id) : undefined;

  async function loadArticles() {
    setLoading(true);
    setFeedback(null);
    try {
      setArticles(await request<BlogArticle[]>('/api/articles'));
    } catch (error) {
      setFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : '文章读取失败，请重试。',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadArticles();
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || saving) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, saving]);
  useEffect(() => {
    if (pendingNavigation) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      stayButtonRef.current?.focus();
    }
  }, [pendingNavigation]);

  function commitNavigation(next: View, nextEditor?: Editor) {
    if (nextEditor) {
      setEditor(nextEditor);
      setSavedEditor(JSON.stringify(nextEditor));
    }
    setView(next);
    setFeedback(null);
    if (next.name === 'articles') setTag(null);
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => mainRef.current?.focus());
  }

  function navigate(next: View, nextEditor?: Editor) {
    if (saving) return;
    if (dirty) {
      setPendingNavigation({ view: next, editor: nextEditor });
      return;
    }
    commitNavigation(next, nextEditor);
  }

  function stayEditing() {
    setPendingNavigation(null);
    previousFocusRef.current?.focus();
  }

  async function saveArticle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const tags = [
      ...new Set(
        editor.tags
          .split(/[,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!editor.title.trim()) {
      setFeedback({ kind: 'error', message: '请填写文章标题，再保存文章。' });
      return;
    }
    if (
      tags.length > BLOG_LIMITS.tagCount ||
      tags.some((value) => value.length > BLOG_LIMITS.tagLength)
    ) {
      setFeedback({ kind: 'error', message: '每篇最多添加 20 个标签，每个标签不超过 32 个字。' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const article = await request<BlogArticle>(
        editor.id ? `/api/articles/${encodeURIComponent(editor.id)}` : '/api/articles',
        {
          method: editor.id ? 'PUT' : 'POST',
          body: JSON.stringify({
            title: editor.title.trim(),
            body: editor.body,
            tags,
            status: editor.status,
            ...(editor.id ? { revision: editor.revision } : {}),
          }),
        },
      );
      setArticles((current) => [article, ...current.filter((item) => item.id !== article.id)]);
      const saved = fromArticle(article);
      setEditor(saved);
      setSavedEditor(JSON.stringify(saved));
      setFeedback({
        kind: 'success',
        message:
          article.status === 'published'
            ? '文章已保存并在本地发布，现在可以在博客首页看到。'
            : '草稿已保存到本机，稍后可以在文章管理中继续编辑。',
      });
    } catch (error) {
      setFeedback({
        kind: 'error',
        message:
          error instanceof RequestError &&
          ['BLOG_CONFLICT', 'REVISION_CONFLICT'].includes(error.code)
            ? '这篇文章已在其他窗口更新，当前输入仍保留。请先复制要保留的内容，再返回文章管理重新读取最新版。'
            : error instanceof Error
              ? error.message
              : '保存未完成，编辑内容已保留。',
      });
    } finally {
      setSaving(false);
    }
  }

  function newArticle() {
    navigate({ name: 'edit' }, blankEditor());
  }
  function editArticle(article: BlogArticle) {
    navigate({ name: 'edit' }, fromArticle(article));
  }
  function readArticle(article: BlogArticle) {
    navigate({ name: 'detail', id: article.id });
  }

  return (
    <>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <div className="sample-strip">
        <span className="sample-dot" />
        博客运行样例 · 本地保存<span className="sample-note">产品工厂固定模板</span>
      </div>
      <header className="site-header">
        <button
          className="wordmark"
          onClick={() => navigate({ name: 'home' })}
          aria-label="一页之间，返回首页"
          disabled={saving}
        >
          <span className="brand-icon" aria-hidden="true">
            页
          </span>
          <span>
            一页之间<small>记录生活，也记录灵感</small>
          </span>
        </button>
        <nav aria-label="博客导航">
          <button
            className={view.name === 'home' ? 'nav-button active' : 'nav-button'}
            aria-current={view.name === 'home' ? 'page' : undefined}
            onClick={() => navigate({ name: 'home' })}
            disabled={saving}
          >
            首页
          </button>
          <button
            className={view.name === 'articles' ? 'nav-button active' : 'nav-button'}
            aria-current={view.name === 'articles' ? 'page' : undefined}
            onClick={() => navigate({ name: 'articles' })}
            disabled={saving}
          >
            全部文章
          </button>
          <button
            className={
              view.name === 'manage' || view.name === 'edit' ? 'nav-button active' : 'nav-button'
            }
            aria-current={view.name === 'manage' ? 'page' : undefined}
            onClick={() => navigate({ name: 'manage' })}
            disabled={saving}
          >
            文章管理
          </button>
        </nav>
        <button
          className="button button-primary header-write"
          onClick={newArticle}
          disabled={saving || loading}
          data-testid="new-article"
        >
          ＋ 写文章
        </button>
      </header>

      <main id="main" className="main" ref={mainRef} tabIndex={-1}>
        {feedback && (
          <div
            className={`feedback ${feedback.kind}`}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            data-testid="feedback"
          >
            <span aria-hidden="true">{feedback.kind === 'error' ? '!' : '✓'}</span>
            <span>{feedback.message}</span>
            {view.name !== 'edit' && feedback.kind === 'error' && (
              <button className="text-button" onClick={() => void loadArticles()}>
                重新读取
              </button>
            )}
          </div>
        )}

        {loading ? (
          <section className="loading-state" role="status">
            <span className="loading-ring" />
            <p>正在读取本机的文章…</p>
          </section>
        ) : (
          <>
            {view.name === 'home' && (
              <>
                <section className="hero">
                  <div className="hero-copy">
                    <p className="eyebrow">一个留给自己的小角落</p>
                    <h1>
                      把日常的片刻，
                      <br />
                      写成值得留下的<span>一页。</span>
                    </h1>
                    <p className="hero-description">
                      有些想法，在写下来的时候才变得清晰。
                      <br className="wide-only" />
                      从一篇短文开始，慢慢收集生活里的发现。
                    </p>
                    <button className="button button-primary" onClick={newArticle}>
                      写下新的一页 <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                  <div className="hero-art" aria-hidden="true">
                    <div className="art-orbit" />
                    <div className="art-leaf leaf-one" />
                    <div className="art-leaf leaf-two" />
                    <div className="art-paper">
                      <span className="art-caption">一页之间</span>
                      <span className="art-title">
                        慢慢写，
                        <br />
                        好好生活。
                      </span>
                      <div className="art-lines">
                        <i />
                        <i />
                        <i />
                      </div>
                      <span className="art-bottom">NOTES OF EVERYDAY</span>
                    </div>
                    <span className="art-label">想法，在这里生根。</span>
                  </div>
                </section>
                <section className="articles-section" aria-labelledby="latest-heading">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">随手记，也认真写</p>
                      <h2 id="latest-heading">
                        最近的文章 <span className="count">{published.length}</span>
                      </h2>
                    </div>
                    <button className="text-button" onClick={() => navigate({ name: 'articles' })}>
                      查看全部 <span aria-hidden="true">→</span>
                    </button>
                  </div>
                  {published.length ? (
                    <div className="article-grid">
                      {published.slice(0, 6).map((article) => (
                        <ArticleCard
                          key={article.id}
                          article={article}
                          onRead={() => readArticle(article)}
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="你的第一篇文章，正等着被写下。"
                      description="创建一篇文章，在本地发布后，它就会出现在这里。草稿会安静地留在文章管理中。"
                      action="写第一篇文章"
                      onAction={newArticle}
                    />
                  )}
                </section>
                <aside className="local-note">
                  <span className="note-symbol" aria-hidden="true">
                    ⌂
                  </span>
                  <div>
                    <strong>让文字留在自己身边</strong>
                    <p>
                      文章保存在当前项目的本机数据中，停止后重新打开仍可读取。本地发布仅在这个博客中展示。
                    </p>
                  </div>
                </aside>
              </>
            )}

            {view.name === 'articles' && (
              <>
                <section className="page-heading">
                  <p className="eyebrow">文字的收藏夹</p>
                  <h1>
                    全部文章<span className="count">{published.length}</span>
                  </h1>
                  <p>随标签翻一翻，重新遇见曾经的灵感。</p>
                </section>
                <div className="tag-filter" aria-label="按标签筛选文章">
                  <button
                    className={tag === null ? 'filter-tag selected' : 'filter-tag'}
                    onClick={() => setTag(null)}
                    aria-pressed={tag === null}
                    aria-label="显示全部已发布文章"
                  >
                    全部
                  </button>
                  {allTags.map((item) => (
                    <button
                      className={tag === item ? 'filter-tag selected' : 'filter-tag'}
                      key={item}
                      onClick={() => setTag(item)}
                      aria-pressed={tag === item}
                      aria-label={`按标签筛选：${item}`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <p className="list-summary" role="status">
                  {tag === null ? '所有已发布文章' : `标签「${tag}」`} · {filtered.length} 篇
                </p>
                {filtered.length ? (
                  <div className="article-grid">
                    {filtered.map((article) => (
                      <ArticleCard
                        key={article.id}
                        article={article}
                        onRead={() => readArticle(article)}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="这里还没有已发布的文章"
                    description="保存草稿后，将文章状态改为“本地发布”，就能在这里读到它。"
                    action="前往文章管理"
                    onAction={() => navigate({ name: 'manage' })}
                  />
                )}
              </>
            )}

            {view.name === 'detail' &&
              (selected ? (
                <article className="article-detail" data-testid="article-detail">
                  <button
                    className="text-button back-button"
                    onClick={() =>
                      navigate({ name: selected.status === 'published' ? 'articles' : 'manage' })
                    }
                  >
                    ← 返回{selected.status === 'published' ? '文章列表' : '文章管理'}
                  </button>
                  <div className="detail-meta">
                    <span className={`status-badge ${selected.status}`}>
                      {selected.status === 'published' ? '本地发布' : '草稿预览'}
                    </span>
                    <span>更新于 {dateLabel(selected.updatedAt)}</span>
                  </div>
                  <h1>{selected.title}</h1>
                  <Tags values={selected.tags} />
                  <div className="article-body" data-testid="article-body">
                    {selected.body}
                  </div>
                  <div className="detail-end">
                    <span>这一页，记录于 {dateLabel(selected.createdAt)}</span>
                    <button
                      className="button button-secondary"
                      onClick={() => editArticle(selected)}
                    >
                      编辑这篇文章
                    </button>
                  </div>
                </article>
              ) : (
                <EmptyState
                  title="暂时找不到这篇文章"
                  description="返回文章管理，重新读取本机保存的内容。"
                  action="返回文章管理"
                  onAction={() => navigate({ name: 'manage' })}
                />
              ))}

            {view.name === 'manage' && (
              <>
                <section className="page-heading management-heading">
                  <div>
                    <p className="eyebrow">你的写作桌</p>
                    <h1>
                      文章管理<span className="count">{articles.length}</span>
                    </h1>
                    <p>每一篇草稿，都有成为好文章的可能。</p>
                  </div>
                  <button
                    className="button button-secondary"
                    onClick={() => void loadArticles()}
                    data-testid="refresh-articles"
                  >
                    重新读取
                  </button>
                </section>
                <div className="management-summary">
                  <div>
                    <span className="stat-number">{published.length}</span>
                    <span>本地已发布</span>
                  </div>
                  <div>
                    <span className="stat-number">{articles.length - published.length}</span>
                    <span>等待打磨的草稿</span>
                  </div>
                  <p>
                    发布仅改变本地可见状态
                    <br />
                    不会上传到互联网
                  </p>
                </div>
                {articles.length ? (
                  <div className="management-list" data-testid="management-list">
                    {articles.map((article) => (
                      <article className="management-row" key={article.id}>
                        <div className="management-content">
                          <div className="management-title">
                            <span className={`status-badge ${article.status}`}>
                              {article.status === 'draft' ? '草稿' : '本地发布'}
                            </span>
                            <h2>{article.title}</h2>
                          </div>
                          <p className="management-meta">
                            {dateLabel(article.updatedAt)} 更新<span>·</span>
                            {article.body.length.toLocaleString('zh-CN')} 字符
                            {article.tags.length > 0 && (
                              <>
                                <span>·</span>
                                {article.tags.join(' / ')}
                              </>
                            )}
                          </p>
                        </div>
                        <div className="row-actions">
                          <button
                            className="text-button"
                            onClick={() => readArticle(article)}
                            aria-label={`查看：${article.title}`}
                          >
                            查看
                          </button>
                          <button
                            className="button button-secondary"
                            onClick={() => editArticle(article)}
                            aria-label={`编辑：${article.title}`}
                          >
                            编辑
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="写作，从这一页开始"
                    description="文章支持保存草稿、继续编辑和本地发布。所有文字仅保存在这个项目中。"
                    action="创建第一篇文章"
                    onAction={newArticle}
                  />
                )}
              </>
            )}

            {view.name === 'edit' && (
              <section className="editor-page">
                <button
                  className="text-button back-button"
                  onClick={() => navigate({ name: 'manage' })}
                  disabled={saving}
                >
                  ← 返回文章管理
                </button>
                <div className="editor-heading">
                  <div>
                    <p className="eyebrow">给想法留一点空间</p>
                    <h1>{editor.id ? '编辑文章' : '写一篇新文章'}</h1>
                  </div>
                  <span
                    className={dirty ? 'edit-indicator unsaved' : 'edit-indicator'}
                    role="status"
                    data-testid="editor-state"
                  >
                    {saving
                      ? '正在保存…'
                      : dirty
                        ? '有未保存的更改'
                        : editor.id
                          ? '更改已保存'
                          : '尚未保存'}
                  </span>
                </div>
                <form
                  onSubmit={(event) => void saveArticle(event)}
                  className="editor-form"
                  data-testid="article-form"
                >
                  <fieldset disabled={saving}>
                    <label htmlFor="article-title">
                      文章标题<span className="field-hint">一句话，开启这一页</span>
                    </label>
                    <input
                      id="article-title"
                      name="title"
                      data-testid="article-title"
                      value={editor.title}
                      onChange={(event) => setEditor({ ...editor, title: event.target.value })}
                      placeholder="为这篇文章起一个名字"
                      required
                      maxLength={BLOG_LIMITS.titleLength}
                      autoComplete="off"
                    />
                    <label htmlFor="article-body">
                      文章正文<span className="field-hint">支持换行，按纯文本保存</span>
                    </label>
                    <textarea
                      id="article-body"
                      name="body"
                      data-testid="article-body-input"
                      value={editor.body}
                      onChange={(event) => setEditor({ ...editor, body: event.target.value })}
                      placeholder="今天，有什么想记下来的？"
                      maxLength={BLOG_LIMITS.bodyLength}
                      rows={14}
                    />
                    <div className="character-count">
                      {editor.body.length.toLocaleString('zh-CN')} 字符
                    </div>
                    <div className="editor-options">
                      <div>
                        <label htmlFor="article-tags">
                          文章标签<span className="optional">选填</span>
                        </label>
                        <input
                          id="article-tags"
                          name="tags"
                          data-testid="article-tags"
                          value={editor.tags}
                          onChange={(event) => setEditor({ ...editor, tags: event.target.value })}
                          placeholder="如：生活，读书，灵感"
                          maxLength={700}
                          aria-describedby="tags-hint"
                        />
                        <p id="tags-hint" className="field-description">
                          用逗号分隔，最多 20 个，每个不超过 32 字。
                        </p>
                      </div>
                      <div>
                        <label htmlFor="article-status">文章状态</label>
                        <select
                          id="article-status"
                          name="status"
                          data-testid="article-status"
                          value={editor.status}
                          onChange={(event) =>
                            setEditor({ ...editor, status: event.target.value as ArticleStatus })
                          }
                        >
                          <option value="draft">草稿 · 仅在管理中可见</option>
                          <option value="published">本地发布 · 在博客中展示</option>
                        </select>
                        <p className="field-description">发布后也可以改回草稿。</p>
                      </div>
                    </div>
                    <div className="editor-footer">
                      <p>文章只保存在本机。关闭前记得保存。</p>
                      <div>
                        {editor.id && !dirty && (
                          <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => navigate({ name: 'detail', id: editor.id! })}
                          >
                            查看文章
                          </button>
                        )}
                        <button
                          type="submit"
                          className="button button-primary"
                          data-testid="save-article"
                        >
                          {saving ? '正在保存…' : '保存文章'}
                        </button>
                      </div>
                    </div>
                  </fieldset>
                </form>
              </section>
            )}
          </>
        )}
      </main>

      <footer className="site-footer">
        <span>一页之间 · 认真记录，慢慢生长</span>
        <span>博客运行样例 / 仅在本机使用</span>
      </footer>
      {pendingNavigation && (
        <div
          className="dialog-backdrop"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              stayEditing();
            }
            if (event.key === 'Tab') {
              const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              event.preventDefault();
              buttons[
                (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
              ]?.focus();
            }
          }}
        >
          <section
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-title"
            aria-describedby="discard-description"
          >
            <div className="dialog-symbol" aria-hidden="true">
              !
            </div>
            <h2 id="discard-title">还有文字没有保存</h2>
            <p id="discard-description">离开后，本次未保存的更改会丢失。已保存的文章不受影响。</p>
            <div className="dialog-actions">
              <button ref={stayButtonRef} className="button button-primary" onClick={stayEditing}>
                继续编辑
              </button>
              <button
                className="button button-secondary"
                data-testid="discard-changes"
                onClick={() => {
                  const next = pendingNavigation;
                  setPendingNavigation(null);
                  commitNavigation(next.view, next.editor);
                }}
              >
                放弃更改并离开
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Tags({ values }: { values: string[] }) {
  return values.length > 0 ? (
    <div className="tags">
      {values.map((value) => (
        <span className="tag" key={value}>
          {value}
        </span>
      ))}
    </div>
  ) : null;
}
function ArticleCard({ article, onRead }: { article: BlogArticle; onRead: () => void }) {
  return (
    <article className="article-card">
      <div className="card-date">
        {dateLabel(article.updatedAt)}
        <span aria-hidden="true">↗</span>
      </div>
      <h3>
        <button onClick={onRead}>{article.title}</button>
      </h3>
      <p className="article-excerpt">{article.body.slice(0, 200)}</p>
      <Tags values={article.tags} />
      <button className="card-read" onClick={onRead} aria-label={`阅读全文：${article.title}`}>
        阅读全文 <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}
function EmptyState({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        页
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="button button-secondary" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
