import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BlogStore } from '../src/main/blog-store.js';
import { AppError } from '../src/main/validation.js';
import {
  BLOG_LIMITS,
  type BlogArticle,
  type BlogArticleInput,
  type BlogArticleUpdateInput,
} from '../src/shared/blog-contracts.js';

const input = (title = '第一篇本地文章'): BlogArticleInput => ({
  title,
  body: '第一段正文。\n\n  保留段落和缩进。\n',
  tags: ['生活', '随笔'],
  status: 'draft',
});

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-blog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, '中文 空格 🌱');
  mkdirSync(project, { mode: 0o700 });
  const store = new BlogStore(project);
  return { root, project, store, file: join(project, 'data', 'blog', 'articles.json') };
}

function code(expected: string) {
  return (error: unknown) => error instanceof AppError && error.code === expected;
}

function savedDocument(file: string, articles: BlogArticle[]) {
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, articles })}\n`, { mode: 0o600 });
}

test('create, edit, locally publish and reopen retain exact article content and revisions', (t) => {
  const { store, project, file } = fixture(t);
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(file), false);
  const created = store.create(input());
  assert.match(created.id, /^[a-f0-9-]{36}$/u);
  assert.equal(created.revision, 1);
  assert.equal(created.body, input().body);
  const updated = new BlogStore(project).update(created.id, {
    ...input('编辑后的标题'),
    tags: ['本地'],
    status: 'published',
    revision: 1,
  });
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.revision, 2);
  assert.ok(updated.updatedAt >= updated.createdAt);
  assert.deepEqual(new BlogStore(project).list(), [updated]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1);
  assert.deepEqual(readdirSync(join(project, 'data', 'blog')), ['articles.json']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(project, 'data')).mode & 0o777, 0o700);
    assert.equal(statSync(join(project, 'data', 'blog')).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test('projects cannot read or update one another and returned objects do not alias disk data', (t) => {
  const { root, project, store } = fixture(t);
  const otherProject = join(root, '其他项目');
  mkdirSync(otherProject);
  const other = new BlogStore(otherProject);
  const created = store.create(input());
  assert.deepEqual(other.list(), []);
  assert.throws(
    () => other.update(created.id, { ...input('越界修改'), revision: 1 }),
    code('BLOG_NOT_FOUND'),
  );
  const publicValue = store.list()[0];
  publicValue.tags.push('未保存修改');
  publicValue.body = '未保存修改';
  created.title = '未保存修改';
  assert.equal(new BlogStore(project).list()[0].title, input().title);
  assert.deepEqual(store.list()[0].tags, input().tags);
  assert.equal(store.list()[0].body, input().body);
});

test('concurrent same-coordinator editors cannot overwrite an accepted revision', async (t) => {
  const { project, store } = fixture(t);
  const article = store.create(input());
  const editorA = new BlogStore(project);
  const editorB = new BlogStore(project);
  const results = await Promise.allSettled([
    Promise.resolve().then(() =>
      editorA.update(article.id, { ...input('先保存的编辑'), revision: article.revision }),
    ),
    Promise.resolve().then(() =>
      editorB.update(article.id, { ...input('过期编辑'), revision: article.revision }),
    ),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  if (results[1].status === 'rejected') assert.ok(code('BLOG_CONFLICT')(results[1].reason));
  assert.equal(store.list()[0].title, '先保存的编辑');
  assert.equal(store.list()[0].revision, 2);
});

test('input fields, identifiers, statuses, sizes and revisions are strictly validated before writing', (t) => {
  const { store, file } = fixture(t);
  const article = store.create(input());
  const before = readFileSync(file);
  const invalid: unknown[] = [
    { ...input(), projectId: randomUUID() },
    { ...input(), id: randomUUID() },
    { ...input(), revision: 1 },
    { ...input(), title: '' },
    { ...input(), title: 'x'.repeat(BLOG_LIMITS.titleLength + 1) },
    { ...input(), body: 'x'.repeat(BLOG_LIMITS.bodyLength + 1) },
    { ...input(), body: 'private-data\u0000' },
    { ...input(), status: 'public' },
    { ...input(), tags: ['一样', ' 一样 '] },
    { ...input(), tags: [''] },
    { ...input(), tags: new Array(1) },
    { ...input(), tags: [123] },
    { ...input(), tags: ['x'.repeat(BLOG_LIMITS.tagLength + 1)] },
    { ...input(), tags: Array.from({ length: BLOG_LIMITS.tagCount + 1 }, (_, i) => String(i)) },
    { ...input(), title: undefined },
    { ...input(), body: undefined },
    null,
  ];
  for (const value of invalid)
    assert.throws(() => store.create(value as BlogArticleInput), code('INVALID_INPUT'));
  for (const revision of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined]) {
    assert.throws(
      () => store.update(article.id, { ...input(), revision } as BlogArticleUpdateInput),
      code('INVALID_INPUT'),
    );
  }
  for (const id of ['../../credentials', 'articles.json', randomUUID().toUpperCase()]) {
    assert.throws(() => store.update(id, { ...input(), revision: 1 }), code('INVALID_INPUT'));
  }
  assert.deepEqual(readFileSync(file), before);
});

test('corrupt JSON and structurally invalid persisted data are retained without leaking original values', (t) => {
  const { store, project, file } = fixture(t);
  const article = store.create(input());
  const invalid: unknown[] = [
    { schemaVersion: 1, articles: [article], extra: 'untrusted-original-value' },
    { schemaVersion: 1, articles: [{ ...article, revision: 0 }] },
    { schemaVersion: 1, articles: [{ ...article, body: null }] },
    { schemaVersion: 1, articles: [{ ...article, tags: ['重复', '重复'] }] },
    { schemaVersion: 1, articles: [{ ...article, title: ' 非规范标题 ' }] },
    { schemaVersion: 1, articles: [{ ...article, id: '../../credentials' }] },
    { schemaVersion: 1, articles: [{ ...article, createdAt: 'tomorrow' }] },
    { schemaVersion: 1, articles: [{ ...article, updatedAt: '2000-01-01T00:00:00.000Z' }] },
    { schemaVersion: 1, articles: [article, article] },
    { schemaVersion: 1, articles: 'untrusted-original-value' },
  ];
  for (const data of [
    '{"untrusted-original-value":',
    ...invalid.map((value) => JSON.stringify(value)),
  ]) {
    writeFileSync(file, data);
    const reopened = new BlogStore(project);
    for (const operation of [
      () => reopened.list(),
      () => reopened.create(input()),
      () => reopened.update(article.id, { ...input(), revision: 1 }),
    ]) {
      assert.throws(
        operation,
        (error: unknown) =>
          code('CORRUPT_BLOG')(error) &&
          !(error as Error).message.includes('untrusted-original-value'),
      );
    }
    assert.equal(readFileSync(file, 'utf8'), data);
  }
});

test('unsupported schemas remain untouched and are reported distinctly', (t) => {
  const { store, file } = fixture(t);
  store.create(input());
  const before = '{"schemaVersion":2,"articles":[]}';
  writeFileSync(file, before);
  assert.throws(() => store.list(), code('UNSUPPORTED_BLOG_SCHEMA'));
  assert.throws(() => store.create(input()), code('UNSUPPORTED_BLOG_SCHEMA'));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('an already-read data file disappearing is not silently reset to an empty blog', (t) => {
  const { store, file } = fixture(t);
  store.create(input());
  unlinkSync(file);
  assert.throws(() => store.list(), code('CORRUPT_BLOG'));
  assert.throws(() => store.create(input()), code('CORRUPT_BLOG'));
  assert.equal(existsSync(file), false);
});

test('symbolic links in project ancestors and replaced storage directories are rejected', (t) => {
  const { root, project, store, file } = fixture(t);
  store.create(input());
  const before = readFileSync(file);
  const alias = join(root, '项目别名');
  symlinkSync(project, alias, 'dir');
  assert.throws(() => new BlogStore(alias), code('UNSAFE_PATH'));
  const directory = join(project, 'data', 'blog');
  const moved = join(root, 'moved-blog');
  renameSync(directory, moved);
  symlinkSync(moved, directory, 'dir');
  assert.throws(() => store.list(), code('UNSAFE_PATH'));
  assert.throws(() => store.create(input()), code('UNSAFE_PATH'));
  assert.throws(() => new BlogStore(project), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(join(moved, 'articles.json')), before);
});

test('symbolic links, hard links and directory substitutions at articles.json cannot be read or overwritten', (t) => {
  const { root, store, file } = fixture(t);
  store.create(input());
  const victim = join(root, 'outside-private.json');
  const original = readFileSync(file);
  writeFileSync(victim, original);
  unlinkSync(file);
  for (const makeUnsafe of [
    () => symlinkSync(victim, file),
    () => symlinkSync(join(root, 'missing.json'), file),
    () => linkSync(victim, file),
    () => mkdirSync(file),
  ]) {
    makeUnsafe();
    assert.throws(() => store.list(), code('UNSAFE_PATH'));
    assert.throws(() => store.create(input()), code('UNSAFE_PATH'));
    assert.deepEqual(readFileSync(victim), original);
    rmSync(file, { recursive: true });
  }
});

test('article count limits preserve existing content and malformed over-limit documents are rejected', (t) => {
  const { store, file } = fixture(t);
  const article = store.create(input());
  const articles = Array.from({ length: BLOG_LIMITS.articleCount }, () => ({
    ...article,
    id: randomUUID(),
  }));
  savedDocument(file, articles);
  const before = readFileSync(file);
  assert.equal(store.list().length, BLOG_LIMITS.articleCount);
  assert.throws(() => store.create(input()), code('STORAGE_LIMIT'));
  assert.deepEqual(readFileSync(file), before);
  savedDocument(file, [...articles, { ...article, id: randomUUID() }]);
  assert.throws(() => store.list(), code('CORRUPT_BLOG'));
});

test('UTF-8 byte capacity is enforced independently of character limits, without replacing the previous document', (t) => {
  const { store, file } = fixture(t);
  const article = store.create(input());
  const large = { ...article, body: '中'.repeat(BLOG_LIMITS.bodyLength) };
  const articles = Array.from({ length: 46 }, () => ({ ...large, id: randomUUID() }));
  savedDocument(file, articles);
  const before = readFileSync(file);
  assert.ok(before.length < BLOG_LIMITS.documentBytes);
  assert.equal(store.list().length, 46);
  assert.throws(() => store.create({ ...input(), body: large.body }), code('STORAGE_LIMIT'));
  assert.deepEqual(readFileSync(file), before);
  writeFileSync(file, Buffer.alloc(BLOG_LIMITS.documentBytes + 1, 0x20));
  assert.throws(() => store.list(), code('CORRUPT_BLOG'));
  assert.throws(() => store.create(input()), code('CORRUPT_BLOG'));
  assert.equal(statSync(file).size, BLOG_LIMITS.documentBytes + 1);
});

test('invalid UTF-8 and stale temporary files cannot replace committed articles', (t) => {
  const { store, project, file } = fixture(t);
  const article = store.create(input());
  const temporary = join(project, 'data', 'blog', '.articles-interrupted.tmp');
  writeFileSync(temporary, '{uncommitted data');
  assert.deepEqual(new BlogStore(project).list(), [article]);
  store.update(article.id, { ...input('继续保存'), revision: 1 });
  assert.equal(readFileSync(temporary, 'utf8'), '{uncommitted data');
  const invalid = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  writeFileSync(file, invalid);
  assert.throws(() => store.list(), code('CORRUPT_BLOG'));
  assert.deepEqual(readFileSync(file), invalid);
});
