import { isDeepStrictEqual } from 'node:util';
import type {
  BuildArtifact,
  BuildAttempt,
  BuildRequest,
  BuildResult,
  BuildState,
} from '../shared/build-contracts';
import type { SourceSnapshot } from '../shared/source-contracts';
import { BuildStore, buildArtifactHash } from './build-store';
import { BuildRunStore } from './build-run-store';
import { ProjectStore } from './project-store';
import { SourceStore } from './source-store';
import { SourceToolExecutor } from './source-tools';
import { CompileFailure, compileSource } from './source-compiler';
import { parseSourceRevision, sourceHash } from './source-protocol';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

export const snapshotHash = (snapshot: SourceSnapshot) => sourceHash(JSON.stringify(snapshot));
const summary = ({ javascript: _js, css: _css, ...rest }: BuildArtifact) => rest;
const sameBinding = (attempt: BuildAttempt, artifact: BuildArtifact) =>
  attempt.id === artifact.id &&
  attempt.planRunId === artifact.planRunId &&
  attempt.planInputHash === artifact.planInputHash &&
  attempt.planArtifactHash === artifact.planArtifactHash &&
  attempt.sourceRevision === artifact.sourceRevision &&
  attempt.sourceHash === artifact.sourceHash;
const publicCodes = new Set([
  'STALE_SOURCE',
  'STALE_PLAN',
  'ARCHIVED',
  'CONFIRMATION_REQUIRED',
  'TOOLCHAIN_UNAVAILABLE',
  'BUILD_LIMIT',
  'BUILD_IO',
  'BUILD_CONFLICT',
  'CORRUPT_BUILD',
  'MISSING_BUILD',
  'UNSAFE_PATH',
  'BUILD_FAILED',
]);
function parseRequest(value: unknown): BuildRequest {
  assertRecord(value);
  assertFields(value, ['schemaVersion', 'requestId', 'projectId', 'planRunId', 'sourceRevision']);
  if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '构建请求版本不正确。');
  return {
    schemaVersion: 1,
    requestId: parseRevisionId(value.requestId),
    projectId: parseProjectId(value.projectId),
    planRunId: parseRevisionId(value.planRunId),
    sourceRevision: parseSourceRevision(value.sourceRevision),
  };
}

/** Compiles text only; no generated module/config/script executes in this process. */
export class BuildService {
  private controller: AbortController | null = null;
  private active: { id: string; projectId: string } | null = null;
  constructor(
    private readonly projects: ProjectStore,
    private readonly sources: SourceStore,
    private readonly tools: SourceToolExecutor,
    private readonly builds: BuildStore,
    private readonly compile = compileSource,
    private readonly journal = new BuildRunStore(projects),
  ) {}

  cancel() {
    this.controller?.abort();
  }

  private persist(projectId: string, attempt: BuildAttempt): void {
    const intended = structuredClone(attempt);
    try {
      this.journal.save(projectId, attempt);
    } catch (error) {
      if (error instanceof AppError && error.code === 'BUILD_RUN_COMMIT_UNCERTAIN') {
        try {
          if (
            isDeepStrictEqual(
              this.journal.list(projectId).find((item) => item.id === attempt.id),
              intended,
            )
          )
            return;
        } catch {
          /* Preserve the original uncertainty if reconciliation also fails. */
        }
      }
      throw error;
    }
  }

  /** Reconcile completed compiler side effects; never rerun a compiler or a model here. */
  attempts(projectId: string): BuildAttempt[] {
    const id = parseProjectId(projectId);
    const attempts = this.journal.list(id);
    const artifacts = this.builds.list(id);
    for (const attempt of attempts) {
      const artifact = artifacts.find((item) => item.id === attempt.id);
      if (
        artifact &&
        (!sameBinding(attempt, artifact) || !['running', 'succeeded'].includes(attempt.status))
      )
        throw new AppError('BUILD_RUN_CONFLICT', '构建产物与执行记录不一致，已保留现场。');
      if (attempt.status === 'succeeded' && !artifact)
        throw new AppError('MISSING_BUILD', '已完成构建的产物缺失，请保留现场后核对。');
      if (
        attempt.status !== 'running' ||
        (this.active?.id === attempt.id && this.active.projectId === id)
      )
        continue;
      attempt.status = artifact ? 'succeeded' : 'interrupted';
      attempt.diagnostics = [];
      attempt.errorCode = artifact ? null : 'BUILD_INTERRUPTED';
      attempt.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(attempt.updatedAt)),
      ).toISOString();
      this.persist(id, attempt);
    }
    return attempts;
  }

  state(projectId: string): BuildState {
    const project = this.projects.get(parseProjectId(projectId));
    const source = this.sources.get(project.id);
    const artifact = this.builds.list(project.id).at(-1) ?? null;
    let current = false;
    if (
      artifact &&
      artifact.sourceRevision === source.revision &&
      artifact.sourceHash === snapshotHash(source)
    ) {
      try {
        const input = this.tools.prepare({ projectId, planRunId: artifact.planRunId });
        current =
          input.binding.planArtifactHash === artifact.planArtifactHash &&
          input.binding.planInputHash === artifact.planInputHash;
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['ARCHIVED', 'CONFIRMATION_REQUIRED', 'STALE_PLAN'].includes(error.code)
        )
          throw error;
      }
    }
    return {
      projectId,
      status: !artifact ? 'empty' : current ? 'current' : 'stale',
      artifact: artifact ? summary(artifact) : null,
      preview: 'closed',
      previewBuildId: null,
    };
  }

  /** Explicit older-source preview is allowed only under the same still-confirmed plan. */
  artifact(projectId: string, buildId: string) {
    const artifact = this.builds.get(parseProjectId(projectId), parseRevisionId(buildId));
    const input = this.tools.prepare({ projectId, planRunId: artifact.planRunId });
    if (
      input.binding.planInputHash !== artifact.planInputHash ||
      input.binding.planArtifactHash !== artifact.planArtifactHash
    )
      throw new AppError('STALE_BUILD', '此构建对应的方向已变化，请重新构建。');
    return artifact;
  }

  async build(value: unknown): Promise<BuildResult> {
    const request = parseRequest(value);
    if (this.controller) throw new AppError('BUSY', '正在构建，请等待或取消。');
    const context = { projectId: request.projectId, planRunId: request.planRunId };
    const prepared = this.tools.prepare(context);
    const source = this.sources.get(request.projectId);
    if (source.revision !== request.sourceRevision)
      throw new AppError('STALE_SOURCE', '源码已变化，请刷新后重新构建。');
    if (!source.files.length) throw new AppError('EMPTY_SOURCE', '请先生成源码草稿。');
    const hash = snapshotHash(source);
    const priorAttempt = this.attempts(request.projectId).find(
      (item) => item.id === request.requestId,
    );
    if (priorAttempt) {
      if (
        priorAttempt.sourceRevision !== source.revision ||
        priorAttempt.sourceHash !== hash ||
        priorAttempt.planRunId !== prepared.binding.planRunId ||
        priorAttempt.planInputHash !== prepared.binding.planInputHash ||
        priorAttempt.planArtifactHash !== prepared.binding.planArtifactHash
      )
        throw new AppError('REQUEST_CONFLICT', '此构建请求已用于其他版本。');
      if (priorAttempt.status === 'interrupted' || priorAttempt.status === 'running')
        throw new AppError('BUILD_INTERRUPTED', '上次构建已中断；请明确发起新的构建操作。');
      return {
        status: priorAttempt.status,
        state: this.state(request.projectId),
        diagnostics: priorAttempt.diagnostics,
      };
    }
    const prior = this.builds.list(request.projectId).find((item) => item.id === request.requestId);
    if (prior) {
      if (
        prior.sourceHash !== hash ||
        prior.planRunId !== request.planRunId ||
        prior.planInputHash !== prepared.binding.planInputHash ||
        prior.planArtifactHash !== prepared.binding.planArtifactHash
      )
        throw new AppError('REQUEST_CONFLICT', '此构建请求已用于其他版本。');
      return { status: 'succeeded', state: this.state(request.projectId), diagnostics: [] };
    }
    const now = new Date().toISOString();
    const attempt: BuildAttempt = {
      id: request.requestId,
      ...prepared.binding,
      sourceRevision: source.revision,
      sourceHash: hash,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      diagnostics: [],
      errorCode: null,
    };
    // The intent must commit before starting the compiler, including local retries.
    this.persist(request.projectId, attempt);
    const controller = new AbortController();
    this.controller = controller;
    this.active = { id: attempt.id, projectId: request.projectId };
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let persistenceFailed = false;
    const finish = (
      status: 'succeeded' | 'failed' | 'cancelled',
      diagnostics: BuildResult['diagnostics'] = [],
      errorCode: string | null = null,
    ): BuildResult => {
      attempt.status = status;
      attempt.diagnostics = structuredClone(diagnostics);
      attempt.errorCode = errorCode;
      attempt.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(attempt.updatedAt)),
      ).toISOString();
      try {
        this.persist(request.projectId, attempt);
      } catch (error) {
        persistenceFailed = true;
        throw error;
      }
      return { status, state: this.state(request.projectId), diagnostics };
    };
    try {
      const compiled = await this.compile(source, { signal: controller.signal });
      if (controller.signal.aborted) return finish('cancelled', [], 'BUILD_CANCELLED');
      const fresh = this.tools.prepare(context);
      if (
        JSON.stringify(fresh.binding) !== JSON.stringify(prepared.binding) ||
        snapshotHash(this.sources.get(request.projectId)) !== hash
      )
        throw new AppError('STALE_SOURCE', '构建期间确认版本或源码已变化，本次产物未采用。');
      const artifact: BuildArtifact = {
        ...compiled,
        schemaVersion: 1,
        id: request.requestId,
        projectId: request.projectId,
        createdAt: new Date().toISOString(),
        sourceRevision: source.revision,
        sourceHash: hash,
        ...prepared.binding,
        templateVersion: 'react-preview-v1',
        compilerVersion: 'esbuild-0.28.2',
        artifactHash: buildArtifactHash(compiled),
      };
      try {
        this.builds.save(request.projectId, artifact);
      } catch (error) {
        let confirmed = false;
        if (error instanceof AppError && error.code === 'BUILD_COMMIT_UNCERTAIN') {
          try {
            confirmed = isDeepStrictEqual(
              this.builds.get(request.projectId, artifact.id),
              artifact,
            );
          } catch {
            /* Preserve the original error if the stored artifact cannot be verified. */
          }
        }
        if (!confirmed) {
          persistenceFailed = true;
          throw error;
        }
      }
      return finish('succeeded');
    } catch (error) {
      // A journal or artifact write may have committed already. Never guess a new terminal state.
      if (persistenceFailed || attempt.status !== 'running') throw error;
      if (controller.signal.aborted) return finish('cancelled', [], 'BUILD_CANCELLED');
      if (error instanceof CompileFailure)
        return finish('failed', error.diagnostics, 'BUILD_FAILED');
      finish(
        'failed',
        [],
        error instanceof AppError && publicCodes.has(error.code) ? error.code : 'BUILD_FAILED',
      );
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controller = null;
      this.active = null;
    }
  }
}
