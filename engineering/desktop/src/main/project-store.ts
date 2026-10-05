import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';
import type {
  DesignContent,
  Project,
  RequirementContent,
  Revision,
  Stage,
} from '../shared/contracts.js';
import {
  AppError,
  assertFields,
  assertRecord,
  parseDesign,
  parseIdea,
  parseProjectId,
  parseProjectName,
  parseRequirements,
  parseRevisionId,
  parseText,
} from './validation.js';

const PROJECT_DIRECTORIES = ['documents', 'source', 'data', 'checkpoints', 'runs'] as const;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function hash(content: RequirementContent | DesignContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function assertConfirmableRequirements(content: RequirementContent): void {
  if (
    content.features.length === 0 ||
    content.pages.length === 0 ||
    content.acceptance.length === 0
  ) {
    throw new AppError(
      'INCOMPLETE_REQUIREMENTS',
      '确认前请至少填写一项功能、一个页面和一项可检验的验收目标。草稿已保留。',
    );
  }
}

function stageFor(project: Pick<Project, 'requirements' | 'designs'>): Stage {
  const requirements = project.requirements.at(-1);
  if (!requirements) return 'idea';
  if (!requirements.approvedAt) return 'requirements';
  const design = project.designs.at(-1);
  if (!design || design.basedOn !== requirements.id || !design.approvedAt) return 'design';
  return 'ready';
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new AppError('INVALID_INPUT', `${label}无效。`);
  }
  return value;
}

function parseRevision<T extends RequirementContent | DesignContent>(
  value: unknown,
  index: number,
  contentParser: (input: unknown) => T,
  design: boolean,
): Revision<T> {
  assertRecord(value, '历史版本');
  assertFields(
    value,
    design
      ? ['id', 'version', 'content', 'hash', 'createdAt', 'approvedAt', 'basedOn']
      : ['id', 'version', 'content', 'hash', 'createdAt', 'approvedAt'],
    '历史版本',
  );
  const content = contentParser(value.content);
  if (value.version !== index + 1 || value.hash !== hash(content)) {
    throw new AppError('INVALID_INPUT', '历史版本的序号或内容校验不匹配。');
  }
  const createdAt = timestamp(value.createdAt, '版本时间');
  const approvedAt = value.approvedAt === null ? null : timestamp(value.approvedAt, '确认时间');
  return {
    id: parseRevisionId(value.id),
    version: index + 1,
    content,
    hash: hash(content),
    createdAt,
    approvedAt,
    ...(design ? { basedOn: parseRevisionId(value.basedOn) } : {}),
  };
}

function parseProject(value: unknown, expectedId: string): Project {
  assertRecord(value, '项目文件');
  // Version 1 is the initial persisted format. Migration is intentionally not implemented yet.
  if (value.schemaVersion !== 1) {
    throw new AppError(
      'UNSUPPORTED_SCHEMA',
      '项目文件版本不受当前工作台支持。原文件已保留，请使用对应版本的软件。',
    );
  }
  assertFields(
    value,
    [
      'schemaVersion',
      'id',
      'name',
      'idea',
      'createdAt',
      'updatedAt',
      'archived',
      'stage',
      'requirements',
      'designs',
      'activity',
    ],
    '项目文件',
  );
  if (
    value.id !== expectedId ||
    typeof value.archived !== 'boolean' ||
    !Array.isArray(value.requirements) ||
    !Array.isArray(value.designs) ||
    !Array.isArray(value.activity)
  ) {
    throw new AppError('INVALID_INPUT', '项目文件结构或标识无效。');
  }
  const requirements = value.requirements.map((item: unknown, index: number) =>
    parseRevision(item, index, parseRequirements, false),
  );
  for (const requirement of requirements) {
    if (requirement.approvedAt) assertConfirmableRequirements(requirement.content);
  }
  const designs = value.designs.map((item: unknown, index: number) =>
    parseRevision(item, index, parseDesign, true),
  );
  const ids = [...requirements, ...designs].map((revision) => revision.id);
  if (
    new Set(ids).size !== ids.length ||
    designs.some(
      (design) => !requirements.some((req) => req.id === design.basedOn && req.approvedAt),
    )
  ) {
    throw new AppError('INVALID_INPUT', '项目版本引用无效。');
  }
  const project: Project = {
    schemaVersion: 1,
    id: expectedId,
    name: parseProjectName(value.name),
    idea: parseIdea(value.idea),
    createdAt: timestamp(value.createdAt, '创建时间'),
    updatedAt: timestamp(value.updatedAt, '更新时间'),
    archived: value.archived,
    stage: stageFor({ requirements, designs }),
    requirements,
    designs,
    activity: value.activity.map((item: unknown) => {
      assertRecord(item, '活动记录');
      assertFields(item, ['id', 'at', 'message'], '活动记录');
      return {
        id: parseRevisionId(item.id),
        at: timestamp(item.at, '活动时间'),
        message: parseText(item.message, '活动说明', 1_000),
      };
    }),
  };
  if (value.stage !== project.stage)
    throw new AppError('INVALID_INPUT', '项目阶段与确认版本不一致。');
  return project;
}

/** This validates storage paths; it is not an operating-system sandbox for generated code. */
export class ProjectStore {
  readonly rootPath: string;
  private readonly projectsPath: string;

  constructor(rootPath: string) {
    if (typeof rootPath !== 'string' || rootPath.length === 0)
      throw new AppError('INVALID_PATH', '项目存储目录无效。');
    this.rootPath = resolve(rootPath);
    this.projectsPath = join(this.rootPath, 'projects');
    this.ensureDirectory(this.rootPath);
    this.ensureDirectory(this.projectsPath);
  }

  list(): Project[] {
    this.verifyDirectory(this.projectsPath);
    const entries = readdirSync(this.projectsPath, { withFileTypes: true });
    return entries
      .map((entry) => {
        if (entry.isSymbolicLink())
          throw new AppError('UNSAFE_PATH', '项目目录中存在符号链接，已停止读取。');
        if (!entry.isDirectory())
          throw new AppError('CORRUPT_PROJECT', '项目目录包含无法识别的文件，请保留现场并检查。');
        let id: string;
        try {
          id = parseProjectId(entry.name);
        } catch {
          throw new AppError('CORRUPT_PROJECT', '项目目录标识无效，请保留现场并检查。');
        }
        return this.get(id);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  get(projectId: string): Project {
    const id = parseProjectId(projectId);
    const directory = this.projectPath(id);
    try {
      this.verifyProjectDirectory(directory);
    } catch (error) {
      if (codeOf(error) === 'ENOENT')
        throw new AppError('PROJECT_NOT_FOUND', '项目不存在或存储目录已被移走。');
      throw error;
    }
    const file = join(directory, 'project.json');
    let descriptor: number | undefined;
    try {
      this.verifyRegularFile(file);
      descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES)
        throw new AppError('CORRUPT_PROJECT', '项目文件大小或类型异常，已停止读取。');
      return parseProject(JSON.parse(readFileSync(descriptor, 'utf8')), id);
    } catch (error) {
      if (error instanceof AppError && ['UNSAFE_PATH', 'UNSUPPORTED_SCHEMA'].includes(error.code))
        throw error;
      throw new AppError(
        'CORRUPT_PROJECT',
        '项目文件无法读取或内容校验失败。原文件已保留，请先恢复备份，避免覆盖现有成果。',
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  create(input: { name: string; idea: string }): Project {
    assertRecord(input, '新建项目');
    assertFields(input, ['name', 'idea'], '新建项目');
    const name = parseProjectName(input.name);
    const idea = parseIdea(input.idea);
    this.verifyDirectory(this.projectsPath);
    const id = randomUUID();
    const directory = this.projectPath(id);
    // Exclusive mkdir avoids replacing any existing directory, even on a UUID collision.
    mkdirSync(directory, { mode: 0o700 });
    for (const child of PROJECT_DIRECTORIES) mkdirSync(join(directory, child), { mode: 0o700 });
    const now = new Date().toISOString();
    const project: Project = {
      schemaVersion: 1,
      id,
      name,
      idea,
      createdAt: now,
      updatedAt: now,
      archived: false,
      stage: 'idea',
      requirements: [],
      designs: [],
      activity: [],
    };
    this.record(project, '创建项目');
    this.write(project, true);
    return project;
  }

  rename(projectId: string, name: string): Project {
    const parsedName = parseProjectName(name);
    return this.update(projectId, (project) => {
      project.name = parsedName;
      this.record(project, '更新项目名称');
    });
  }

  archive(projectId: string, archived: boolean): Project {
    if (typeof archived !== 'boolean') throw new AppError('INVALID_INPUT', '归档状态无效。');
    return this.update(
      projectId,
      (project) => {
        project.archived = archived;
        this.record(project, archived ? '归档项目' : '恢复项目');
      },
      true,
    );
  }

  saveRequirements(projectId: string, content: RequirementContent): Project {
    const parsed = parseRequirements(content);
    return this.update(projectId, (project) => {
      project.requirements.push(this.revision(parsed, project.requirements.length + 1));
      this.record(project, `保存需求版本 ${project.requirements.length}，等待确认`);
    });
  }

  approveRequirements(projectId: string, revisionId: string): Project {
    const id = parseRevisionId(revisionId);
    return this.update(projectId, (project) => {
      const latest = project.requirements.at(-1);
      if (!latest || latest.id !== id)
        throw new AppError('STALE_REVISION', '只能确认当前最新需求，请刷新后核对内容。');
      assertConfirmableRequirements(latest.content);
      if (!latest.approvedAt) {
        latest.approvedAt = new Date().toISOString();
        const unresolved = latest.content.questions.length;
        this.record(
          project,
          `确认需求版本 ${latest.version}${unresolved ? `（保留 ${unresolved} 项待明确问题）` : ''}`,
        );
      }
    });
  }

  saveDesign(projectId: string, content: DesignContent): Project {
    const parsed = parseDesign(content);
    return this.update(projectId, (project) => {
      const requirements = project.requirements.at(-1);
      if (!requirements?.approvedAt)
        throw new AppError('REQUIREMENTS_NOT_APPROVED', '请先确认当前需求，再生成页面方案。');
      project.designs.push({
        ...this.revision(parsed, project.designs.length + 1),
        basedOn: requirements.id,
      });
      this.record(project, `保存页面方案版本 ${project.designs.length}，等待确认`);
    });
  }

  approveDesign(projectId: string, revisionId: string): Project {
    const id = parseRevisionId(revisionId);
    return this.update(projectId, (project) => {
      const requirements = project.requirements.at(-1);
      const latest = project.designs.at(-1);
      if (!latest || latest.id !== id)
        throw new AppError('STALE_REVISION', '只能确认当前最新页面方案，请刷新后核对内容。');
      if (!requirements?.approvedAt || latest.basedOn !== requirements.id) {
        throw new AppError('STALE_REVISION', '需求已更新，请确认新需求并重新生成页面方案。');
      }
      if (!latest.approvedAt) {
        latest.approvedAt = new Date().toISOString();
        this.record(project, `确认页面方案版本 ${latest.version}`);
      }
    });
  }

  private revision<T extends RequirementContent | DesignContent>(
    content: T,
    version: number,
  ): Revision<T> {
    return {
      id: randomUUID(),
      version,
      content,
      hash: hash(content),
      createdAt: new Date().toISOString(),
      approvedAt: null,
    };
  }

  private record(project: Project, message: string): void {
    project.activity.push({ id: randomUUID(), at: new Date().toISOString(), message });
    project.activity = project.activity.slice(-200);
  }

  private update(
    projectId: string,
    change: (project: Project) => void,
    allowArchived = false,
  ): Project {
    const project = this.get(projectId);
    if (project.archived && !allowArchived)
      throw new AppError('ARCHIVED', '请先恢复已归档的项目，再修改或确认内容。');
    change(project);
    project.stage = stageFor(project);
    project.updatedAt = new Date().toISOString();
    this.write(project, false);
    return project;
  }

  private write(project: Project, creating: boolean): void {
    const directory = this.projectPath(project.id);
    this.verifyProjectDirectory(directory);
    const file = join(directory, 'project.json');
    if (creating) {
      if (existsSync(file)) throw new AppError('CORRUPT_PROJECT', '项目文件已存在，已拒绝覆盖。');
    } else {
      this.verifyRegularFile(file);
    }
    const serialized = `${JSON.stringify(project, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES)
      throw new AppError('STORAGE_LIMIT', '项目历史文件已达到容量上限，本次修改未保存。');
    const temporary = join(directory, `.project-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.verifyProjectDirectory(directory);
      if (!creating) this.verifyRegularFile(file);
      renameSync(temporary, file);
      // Persist the rename where directory fsync is supported (macOS/Linux).
      if (process.platform !== 'win32') {
        const dirDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          fsyncSync(dirDescriptor);
        } finally {
          closeSync(dirDescriptor);
        }
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      // Only the temporary file created for this write is removed; crash leftovers are ignored.
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
      }
    }
  }

  private projectPath(id: string): string {
    const path = join(this.projectsPath, parseProjectId(id));
    const fromRoot = relative(this.projectsPath, path);
    if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === '..')
      throw new AppError('UNSAFE_PATH', '项目路径越界。');
    return path;
  }

  private verifyProjectDirectory(directory: string): void {
    this.verifyDirectory(directory);
    for (const child of PROJECT_DIRECTORIES) this.verifyDirectory(join(directory, child));
  }

  private verifyDirectory(path: string): void {
    this.verifyAncestors(path);
    if (!lstatSync(path).isDirectory()) throw new AppError('UNSAFE_PATH', '项目路径不是目录。');
  }

  private verifyRegularFile(path: string): void {
    this.verifyAncestors(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new AppError('UNSAFE_PATH', '项目清单不是独立普通文件，已拒绝访问。');
  }

  private ensureDirectory(path: string): void {
    this.verifyAncestors(path, true);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    this.verifyDirectory(path);
  }

  private verifyAncestors(path: string, allowMissing = false): void {
    let current = parse(path).root;
    for (const segment of relative(current, path).split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new AppError('UNSAFE_PATH', '存储路径包含符号链接，已拒绝访问。');
      } catch (error) {
        if (allowMissing && codeOf(error) === 'ENOENT') continue;
        throw error;
      }
    }
  }
}
