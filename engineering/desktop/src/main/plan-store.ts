import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { PlanRequest, PlanRun, PlanState } from '../shared/plan-contracts';
import type { Project } from '../shared/contracts';
import { ProjectStore } from './project-store';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';
import {
  boundPlanInput,
  buildDevelopmentPlan,
  parsePlanRequest,
  planHash,
  PLAN_ADAPTER_VERSION,
  PLAN_SOURCE_REVISION,
} from './development-plan';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RUNS = 100;
const events: PlanRun['events'] = [
  { sequence: 1, type: 'stage.completed', stage: 'binding' },
  { sequence: 2, type: 'stage.completed', stage: 'rules' },
  { sequence: 3, type: 'stage.completed', stage: 'tasks' },
];
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** One trusted synchronous writer. Plans are derived from authoritative project revisions. */
export class PlanStore {
  private readonly observedFiles = new Set<string>();
  constructor(private readonly projects: ProjectStore) {}

  private path(project: Project) {
    // get() verifies every ancestor and the pre-existing runs directory without following symlinks.
    this.projects.get(project.id);
    return join(this.projects.rootPath, 'projects', project.id, 'runs', 'development-plans.json');
  }

  private verifyFile(path: string): boolean {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new AppError('UNSAFE_PATH', '开发计划文件不是独立普通文件，已停止访问。');
      if (stat.size > MAX_BYTES)
        throw new AppError('PLAN_LIMIT', '开发计划记录过大，原文件已保留。');
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private read(project: Project): PlanRun[] {
    const path = this.path(project);
    if (!this.verifyFile(path)) {
      if (this.observedFiles.has(path))
        throw new AppError(
          'MISSING_PLAN',
          '已读取的开发计划文件被移走，已停止写入。请先恢复原文件。',
        );
      return [];
    }
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error();
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      assertRecord(value);
      assertFields(value, ['schemaVersion', 'projectId', 'runs']);
      if (value.schemaVersion !== 1)
        throw new AppError('UNSUPPORTED_PLAN', '开发计划文件版本暂不支持，原文件已保留。');
      if (
        value.projectId !== project.id ||
        !Array.isArray(value.runs) ||
        value.runs.length > MAX_RUNS
      )
        throw new Error();
      const runIds = new Set<string>();
      const requestIds = new Set<string>();
      const runs = value.runs.map((raw: unknown): PlanRun => {
        assertRecord(raw);
        assertFields(raw, [
          'schemaVersion',
          'id',
          'request',
          'createdAt',
          'inputHash',
          'artifactHash',
          'adapterVersion',
          'sourceRevision',
          'state',
          'events',
          'plan',
        ]);
        const request = parsePlanRequest(raw.request);
        const id = parseRevisionId(raw.id);
        if (runIds.has(id) || requestIds.has(request.requestId)) throw new Error();
        runIds.add(id);
        requestIds.add(request.requestId);
        const { inputHash } = boundPlanInput(project, request);
        const plan = buildDevelopmentPlan(project, request);
        if (
          raw.adapterVersion !== PLAN_ADAPTER_VERSION ||
          raw.sourceRevision !== PLAN_SOURCE_REVISION
        )
          throw new AppError('UNSUPPORTED_PLAN', '此开发计划来自其他规则版本，原文件已保留。');
        if (
          raw.schemaVersion !== 1 ||
          raw.state !== 'succeeded' ||
          raw.inputHash !== inputHash ||
          raw.artifactHash !== planHash(plan) ||
          JSON.stringify(raw.plan) !== JSON.stringify(plan) ||
          JSON.stringify(raw.events) !== JSON.stringify(events) ||
          typeof raw.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(raw.createdAt)) ||
          new Date(raw.createdAt).toISOString() !== raw.createdAt
        )
          throw new Error();
        return {
          schemaVersion: 1,
          id,
          request,
          createdAt: raw.createdAt,
          inputHash,
          artifactHash: planHash(plan),
          adapterVersion: PLAN_ADAPTER_VERSION,
          sourceRevision: PLAN_SOURCE_REVISION,
          state: 'succeeded',
          events: structuredClone(events),
          plan,
        };
      });
      this.observedFiles.add(path);
      return runs;
    } catch (error) {
      if (error instanceof AppError && ['UNSAFE_PATH', 'UNSUPPORTED_PLAN'].includes(error.code))
        throw error;
      throw new AppError(
        'CORRUPT_PLAN',
        '开发计划记录校验失败，原文件已保留。请检查备份，不会覆盖现有记录。',
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private state(project: Project, runs: PlanRun[], run = runs.at(-1)): PlanState {
    const requirements = project.requirements.at(-1);
    const design = project.designs.at(-1);
    return {
      status: !run
        ? 'empty'
        : requirements?.approvedAt &&
            design?.approvedAt &&
            requirements.id === run.request.requirementId &&
            design.id === run.request.designId &&
            design.basedOn === requirements.id
          ? 'current'
          : 'stale',
      run: run ?? null,
      history: runs.map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        profile: item.request.profile,
      })),
    };
  }

  get(projectId: string): PlanState {
    const project = this.projects.get(projectId);
    return this.state(project, this.read(project));
  }

  create(input: unknown): PlanState {
    const request: PlanRequest = parsePlanRequest(input);
    const project = this.projects.get(request.projectId);
    if (project.archived) throw new AppError('ARCHIVED', '请先恢复项目，再整理开发计划。');
    const runs = this.read(project);
    const previous = runs.find((run) => run.request.requestId === request.requestId);
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request))
        throw new AppError('REQUEST_CONFLICT', '重复请求标识对应了不同输入，请重新操作。');
      return this.state(project, runs, previous);
    }
    if (project.stage !== 'ready')
      throw new AppError('CONFIRMATION_REQUIRED', '请先确认最新需求和页面方向，再整理开发计划。');
    if (
      project.requirements.at(-1)?.id !== request.requirementId ||
      project.designs.at(-1)?.id !== request.designId
    )
      throw new AppError('STALE_PLAN', '需求或页面版本已更新，请刷新后重新整理开发计划。');
    if (runs.length >= MAX_RUNS)
      throw new AppError('PLAN_LIMIT', '本项目开发计划已达100版，现有记录保留。');
    const { inputHash } = boundPlanInput(project, request);
    const plan = buildDevelopmentPlan(project, request);
    const run: PlanRun = {
      schemaVersion: 1,
      id: randomUUID(),
      request,
      createdAt: new Date().toISOString(),
      inputHash,
      artifactHash: planHash(plan),
      adapterVersion: PLAN_ADAPTER_VERSION,
      sourceRevision: PLAN_SOURCE_REVISION,
      state: 'succeeded',
      events: structuredClone(events),
      plan,
    };
    this.write(project, [...runs, run]);
    return this.state(project, [...runs, run]);
  }

  private write(project: Project, runs: PlanRun[]) {
    const path = this.path(project);
    this.verifyFile(path);
    const bytes = JSON.stringify({ schemaVersion: 1, projectId: project.id, runs }, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES)
      throw new AppError('PLAN_LIMIT', '开发计划记录达到容量上限，本次未写入。');
    const temp = join(
      this.projects.rootPath,
      'projects',
      project.id,
      'runs',
      `.plan-${randomUUID()}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, bytes, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.path(project);
      this.verifyFile(path);
      renameSync(temp, path);
      this.observedFiles.add(path);
      if (process.platform !== 'win32') {
        const directory = openSync(
          join(path, '..'),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
}
