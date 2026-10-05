import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';
import {
  BLOG_LIMITS,
  type BlogArticle,
  type BlogArticleInput,
  type BlogArticleUpdateInput,
  type BlogDocument,
} from '../shared/blog-contracts.js';
import { AppError, assertFields, assertRecord, parseRevisionId, parseText } from './validation.js';

const INPUT_FIELDS = ['title', 'body', 'tags', 'status'] as const;

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function parseInput(value: unknown, updating = false): BlogArticleInput {
  assertRecord(value, '文章');
  assertFields(value, updating ? [...INPUT_FIELDS, 'revision'] : INPUT_FIELDS, '文章');
  if (value.status !== 'draft' && value.status !== 'published') {
    throw new AppError('INVALID_INPUT', '文章状态须为草稿或本地发布。');
  }
  if (!Array.isArray(value.tags) || value.tags.length > BLOG_LIMITS.tagCount) {
    throw new AppError('INVALID_INPUT', `文章标签最多 ${BLOG_LIMITS.tagCount} 个。`);
  }
  const tags = Array.from(value.tags, (tag) => parseText(tag, '标签', BLOG_LIMITS.tagLength));
  if (new Set(tags).size !== tags.length) {
    throw new AppError('INVALID_INPUT', '文章标签不能重复。');
  }
  // Preserve body whitespace because line breaks and indentation belong to the author's text.
  parseText(value.body, '文章正文', BLOG_LIMITS.bodyLength, true);
  return {
    title: parseText(value.title, '文章标题', BLOG_LIMITS.titleLength),
    body: value.body as string,
    tags,
    status: value.status,
  };
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AppError('INVALID_INPUT', '文章版本无效，请重新打开文章。');
  }
  return value as number;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new AppError('INVALID_INPUT', '文章时间无效。');
  }
  return value;
}

function parseDocument(value: unknown): BlogDocument {
  assertRecord(value, '博客数据');
  if (value.schemaVersion !== 1) {
    throw new AppError('UNSUPPORTED_BLOG_SCHEMA', '博客数据版本不受支持，原文件已保留。');
  }
  assertFields(value, ['schemaVersion', 'articles'], '博客数据');
  if (!Array.isArray(value.articles) || value.articles.length > BLOG_LIMITS.articleCount) {
    throw new AppError('INVALID_INPUT', '博客文章列表无效或超过数量上限。');
  }
  const ids = new Set<string>();
  const articles = Array.from(value.articles, (value: unknown): BlogArticle => {
    assertRecord(value, '已保存文章');
    assertFields(
      value,
      [...INPUT_FIELDS, 'id', 'revision', 'createdAt', 'updatedAt'],
      '已保存文章',
    );
    const id = parseRevisionId(value.id);
    if (ids.has(id)) throw new AppError('INVALID_INPUT', '博客文章标识重复。');
    ids.add(id);
    const content = parseInput({
      title: value.title,
      body: value.body,
      tags: value.tags,
      status: value.status,
    });
    if (
      content.title !== value.title ||
      JSON.stringify(content.tags) !== JSON.stringify(value.tags)
    ) {
      throw new AppError('INVALID_INPUT', '已保存文章内容格式无效。');
    }
    const createdAt = timestamp(value.createdAt);
    const updatedAt = timestamp(value.updatedAt);
    if (updatedAt < createdAt) throw new AppError('INVALID_INPUT', '文章更新时间早于创建时间。');
    return { id, ...content, revision: revision(value.revision), createdAt, updatedAt };
  });
  return { schemaVersion: 1, articles };
}

/** Trusted, single-coordinator storage. Path checks are not an OS sandbox for arbitrary code. */
export class BlogStore {
  private readonly directory: string;
  private readonly file: string;
  private hasReadFile = false;

  constructor(projectDirectory: string) {
    if (typeof projectDirectory !== 'string' || projectDirectory.length === 0) {
      throw new AppError('INVALID_PATH', '博客项目目录无效。');
    }
    const project = resolve(projectDirectory);
    this.directory = join(project, 'data', 'blog');
    this.file = join(this.directory, 'articles.json');
    try {
      this.verifyDirectory(project);
      this.ensureDirectory(join(project, 'data'));
      this.ensureDirectory(this.directory);
    } catch (error) {
      this.rethrowStorage(error);
    }
  }

  list(): BlogArticle[] {
    return this.read().articles.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  }

  create(input: BlogArticleInput): BlogArticle {
    const content = parseInput(input);
    const document = this.read();
    if (document.articles.length >= BLOG_LIMITS.articleCount) {
      throw new AppError(
        'STORAGE_LIMIT',
        `博客最多保存 ${BLOG_LIMITS.articleCount} 篇文章，本次未保存。`,
      );
    }
    const now = new Date().toISOString();
    const article: BlogArticle = {
      id: randomUUID(),
      ...content,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    document.articles.push(article);
    this.write(document);
    return article;
  }

  update(id: string, input: BlogArticleUpdateInput): BlogArticle {
    const articleId = parseRevisionId(id);
    const content = parseInput(input, true);
    const expectedRevision = revision(input.revision);
    const document = this.read();
    const index = document.articles.findIndex((article) => article.id === articleId);
    if (index === -1) throw new AppError('BLOG_NOT_FOUND', '文章不存在，请重新打开文章列表。');
    const previous = document.articles[index];
    if (previous.revision !== expectedRevision) {
      throw new AppError(
        'BLOG_CONFLICT',
        '文章已有新版本，本次修改未保存。请重新打开文章后再编辑。',
      );
    }
    if (previous.revision >= Number.MAX_SAFE_INTEGER) {
      throw new AppError('STORAGE_LIMIT', '文章版本已达上限，本次修改未保存。');
    }
    const article: BlogArticle = {
      ...previous,
      ...content,
      revision: previous.revision + 1,
      // A clock adjustment must not make the saved timestamp invalid.
      updatedAt: new Date(Math.max(Date.now(), Date.parse(previous.updatedAt))).toISOString(),
    };
    document.articles[index] = article;
    this.write(document);
    return article;
  }

  private read(): BlogDocument {
    let descriptor: number | undefined;
    try {
      this.verifyDirectory(this.directory);
      if (!this.verifyFile(true)) {
        if (this.hasReadFile)
          throw new AppError('CORRUPT_BLOG', '博客数据文件已丢失，已停止写入。');
        return { schemaVersion: 1, articles: [] };
      }
      descriptor = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new AppError('UNSAFE_PATH', '博客数据不是独立普通文件，已拒绝访问。');
      if (stat.size > BLOG_LIMITS.documentBytes)
        throw new AppError('CORRUPT_BLOG', '博客数据文件超过容量上限，已停止读取。');
      const buffer = Buffer.alloc(BLOG_LIMITS.documentBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(descriptor, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > BLOG_LIMITS.documentBytes)
        throw new AppError('CORRUPT_BLOG', '博客数据文件超过容量上限，已停止读取。');
      const document = parseDocument(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))),
      );
      this.hasReadFile = true;
      return document;
    } catch (error) {
      if (
        error instanceof AppError &&
        ['UNSAFE_PATH', 'UNSUPPORTED_BLOG_SCHEMA', 'CORRUPT_BLOG'].includes(error.code)
      )
        throw error;
      throw new AppError(
        'CORRUPT_BLOG',
        '博客数据无法读取或校验失败。原文件已保留，请先恢复备份，避免覆盖文章。',
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private write(document: BlogDocument): void {
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > BLOG_LIMITS.documentBytes) {
      throw new AppError('STORAGE_LIMIT', '博客数据已达到容量上限，本次修改未保存。');
    }
    const temporary = join(this.directory, `.articles-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let createdTemporary = false;
    try {
      this.verifyDirectory(this.directory);
      this.verifyFile(!this.hasReadFile);
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      createdTemporary = true;
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.verifyDirectory(this.directory);
      this.verifyFile(!this.hasReadFile);
      renameSync(temporary, this.file);
      createdTemporary = false;
      this.hasReadFile = true;
      if (process.platform !== 'win32') {
        const directoryDescriptor = openSync(
          this.directory,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      }
    } catch (error) {
      this.rethrowStorage(error);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (createdTemporary) {
        // Cleanup must not conceal the original save failure or remove another file.
        try {
          this.verifyDirectory(this.directory);
          unlinkSync(temporary);
        } catch {
          /* Preserve failure and any crash residue. */
        }
      }
    }
  }

  private verifyFile(allowMissing: boolean): boolean {
    try {
      this.verifyAncestors(this.file);
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new AppError('UNSAFE_PATH', '博客数据不是独立普通文件，已拒绝访问。');
      return true;
    } catch (error) {
      if (allowMissing && codeOf(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private verifyDirectory(path: string): void {
    this.verifyAncestors(path);
    if (!lstatSync(path).isDirectory()) throw new AppError('UNSAFE_PATH', '博客存储路径不是目录。');
  }

  private ensureDirectory(path: string): void {
    this.verifyDirectory(join(path, '..'));
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
    }
    this.verifyDirectory(path);
    if (process.platform !== 'win32') {
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        fchmodSync(descriptor, 0o700);
      } finally {
        closeSync(descriptor);
      }
    }
  }

  private verifyAncestors(path: string): void {
    let current = parse(path).root;
    for (const segment of relative(current, path).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink())
        throw new AppError('UNSAFE_PATH', '博客存储路径包含符号链接，已拒绝访问。');
    }
  }

  private rethrowStorage(error: unknown): never {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'BLOG_STORAGE_FAILED',
      '博客数据保存或目录访问失败，请检查可用磁盘空间和目录权限。',
    );
  }
}
