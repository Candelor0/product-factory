/** Explicit opt-in only. Only ModelService decrypts and uses the existing credential.
 * A local format audit returns booleans, never ciphertext or its digest. No setting is changed
 * except ModelService's ordinary legacy-schema migration. No copied Key or raw model log.
 */
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { startDesktop } from '../src/main/app';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';
import type { ProviderSettings, Usage } from '../src/shared/contracts';
import type { WorkflowState } from '../src/shared/workflow-contracts';
import { version } from '../package.json';

const runId = process.env.FACTORY_CORE_RUN_ID ?? '';
const phase = process.env.FACTORY_CORE_PHASE ?? '';
const output = resolve('../../docs/evidence/2026-10-05/S3-02/core-live', runId);
const artifacts = resolve('../../artifacts/core-live', runId);
const callLimit = 4;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never {
  throw new AppError(code, '核心实测已停止；原记录保留。');
}
let evidenceReady = false;
const safeCode = (error: unknown) =>
  error instanceof AppError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : 'CORE_LIVE_FAILED';
function record(name: string, value: unknown): void {
  const fd = openSync(join(output, name), 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(output, 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function readRecord<T>(name: string): T {
  const path = join(output, name),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024)
    fail('CORE_LIVE_MANIFEST');
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
const configuration = (settings: ProviderSettings) => ({
  provider: settings.provider,
  baseUrl: settings.baseUrl,
  model: settings.model,
  connectionId: settings.connectionId,
  maxCalls: settings.maxCalls,
  maxTokens: settings.maxTokens,
});
type Configuration = ReturnType<typeof configuration>;
function providerFormatAudit() {
  // Called only inside the explicitly enabled Electron process. No decrypted secret is read.
  const path = join(app.getPath('appData'), 'ProductFactory', 'credentials', 'provider.json');
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fail('CORE_LIVE_PROVIDER_AUDIT');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      fail('CORE_LIVE_PROVIDER_AUDIT');
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as {
      schemaVersion: number;
      usage: Usage;
      maxCalls: number;
      encryptedKey: string | null;
    };
    return {
      schemaVersion: parsed.schemaVersion,
      usage: parsed.usage,
      maxCalls: parsed.maxCalls,
      // The fingerprint lives only in this process; the record below emits equality only.
      encryptedDigest: hash(JSON.stringify(parsed.encryptedKey)),
    };
  } finally {
    closeSync(fd);
  }
}
type ProjectTree = { id: string; sha256: string; files: number; directories: number };
function projectTrees(root: string, ids: string[]): ProjectTree[] {
  return [...ids].sort().map((id) => {
    const rows: string[] = [];
    let files = 0,
      directories = 0;
    const walk = (directory: string, prefix: string) => {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CORE_LIVE_UNSAFE_PROJECT');
      directories++;
      rows.push(`D:${prefix}`);
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name),
          item = lstatSync(path),
          relative = `${prefix}/${name}`;
        if (item.isDirectory() && !item.isSymbolicLink()) walk(path, relative);
        else {
          if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1)
            fail('CORE_LIVE_UNSAFE_PROJECT');
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const before = fstatSync(fd);
            const digest = hash(readFileSync(fd));
            const after = fstatSync(fd);
            if (
              before.ino !== item.ino ||
              before.dev !== item.dev ||
              before.size !== after.size ||
              before.mtimeMs !== after.mtimeMs ||
              before.ctimeMs !== after.ctimeMs
            )
              fail('CORE_LIVE_PROJECT_CHANGED');
            rows.push(`F:${relative}:${digest}`);
            files++;
          } finally {
            closeSync(fd);
          }
        }
      }
    };
    walk(join(root, 'projects', id), '');
    return { id, sha256: hash(JSON.stringify(rows)), files, directories };
  });
}
function eligibility(settings: ProviderSettings, usage: Usage): string | null {
  if (!settings.hasKey) return 'CORE_LIVE_KEY_UNAVAILABLE';
  if (settings.provider !== 'deepseek' || settings.baseUrl !== 'https://api.deepseek.com')
    return 'CORE_LIVE_CONNECTION';
  if (settings.maxCalls - usage.calls < callLimit) return 'CORE_LIVE_CALL_BUDGET';
  if (settings.maxTokens !== null && settings.legacyUnknownUsageCalls > 0)
    return 'TOKEN_USAGE_UNKNOWN';
  if (settings.maxTokens !== null && settings.budgetTokens >= settings.maxTokens)
    return 'TOKEN_BUDGET_EXCEEDED';
  return null;
}
const delta = (before: Usage, after: Usage) => ({
  calls: after.calls - before.calls,
  inputTokens: after.inputTokens - before.inputTokens,
  outputTokens: after.outputTokens - before.outputTokens,
  unknownUsageCalls: after.unknownUsageCalls - before.unknownUsageCalls,
});
function workflowSummary(state: WorkflowState) {
  return {
    projectId: state.projectId,
    run: state.run,
    current: state.current,
    sourceRevision: state.sourceRevision,
    fileCount: state.fileCount,
    rounds: state.rounds,
    toolCalls: state.toolCalls,
    builds: state.builds,
  };
}

async function main(): Promise<void> {
  if (
    process.env.FACTORY_LIVE_CORE !== '1' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(runId) ||
    !['prepare', 'generate', 'reopen'].includes(phase)
  )
    fail('CORE_LIVE_OPT_IN_REQUIRED');
  for (const path of [output, artifacts]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CORE_LIVE_MANIFEST');
  }
  const manifest = readRecord<{ schemaVersion: number; runId: string; callLimit: number }>(
    'manifest.json',
  );
  const intent = readRecord<{ runId: string; phase: string }>(`${phase}-intent.json`);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.runId !== runId ||
    manifest.callLimit !== callLimit ||
    intent.runId !== runId ||
    intent.phase !== phase
  )
    fail('CORE_LIVE_MANIFEST');
  evidenceReady = true;
  // This independent child marker also rejects directly relaunching the Electron bundle.
  record(`${phase}-entered.json`, { runId, phase, at: new Date().toISOString() });
  const realFetch = globalThis.fetch.bind(globalThis);
  let paidAllowed = false,
    toolTurns = 0,
    fetches = 0;
  const modelRequest: typeof fetch = async (input, init) => {
    if (phase !== 'generate' || !paidAllowed || fetches >= callLimit || fetches >= toolTurns)
      fail('CORE_LIVE_CALL_LIMIT');
    if (input !== 'https://api.deepseek.com/chat/completions' || init?.method !== 'POST')
      fail('CORE_LIVE_CONNECTION');
    // No access to, serialization of, or logging of headers/body. Forward intact to ModelService's endpoint.
    record(`dispatch-${fetches + 1}-intent.json`, {
      at: new Date().toISOString(),
      ordinal: fetches + 1,
    });
    fetches++;
    return realFetch(input, init);
  };
  const providerBefore = phase === 'prepare' ? providerFormatAudit() : null;
  const desktop = await startDesktop({
    show: false,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    blogPath: resolve('dist/blog'),
    toolchainPath: resolve('dist/toolchain'),
    exportKitPath: resolve('dist/export-kit'),
    modelRequest,
  });
  const { models, store, plans, sources, workflows, previews } = desktop;
  const settings = models.settings(),
    before = models.usage();
  const originalToolTurn = models.toolTurn.bind(models);
  models.toolTurn = async (...args) => {
    if (phase !== 'generate' || !paidAllowed || toolTurns >= callLimit)
      fail('CORE_LIVE_CALL_LIMIT');
    if (!isDeepStrictEqual(configuration(models.settings()), configuration(settings)))
      fail('CORE_LIVE_CONFIGURATION_CHANGED');
    record(`tool-${toolTurns + 1}-intent.json`, {
      at: new Date().toISOString(),
      ordinal: toolTurns + 1,
    });
    toolTurns++;
    return originalToolTurn(...args);
  };
  let result: Record<string, unknown> = { runId, phase, version, at: new Date().toISOString() };
  let failure: unknown;
  let baseline: ProjectTree[] | undefined;
  let projectId: string | undefined;
  let requestId: string | undefined;
  try {
    if (phase === 'prepare') {
      const providerAfter = providerFormatAudit();
      const migration = {
        beforeSchema: providerBefore?.schemaVersion ?? null,
        afterSchema: providerAfter?.schemaVersion ?? null,
        migrated: providerBefore?.schemaVersion === 1 && providerAfter?.schemaVersion === 2,
        usageUnchanged:
          providerBefore === null || isDeepStrictEqual(providerBefore.usage, providerAfter?.usage),
        callLimitUnchanged:
          providerBefore === null || providerBefore.maxCalls === providerAfter?.maxCalls,
        encryptedCredentialUnchanged:
          providerBefore === null ||
          providerBefore.encryptedDigest === providerAfter?.encryptedDigest,
      };
      record('provider-migration-audit.json', migration);
      if (
        !migration.usageUnchanged ||
        !migration.callLimitUnchanged ||
        !migration.encryptedCredentialUnchanged
      )
        fail('CORE_LIVE_MIGRATION_CHANGED');
      const code = eligibility(settings, before);
      result = {
        ...result,
        status: code ? 'ineligible' : 'prepared',
        code,
        configuration: configuration(settings),
        usage: before,
        hasKey: settings.hasKey,
        keyStorage: settings.storage,
        budgetTokens: settings.budgetTokens,
        legacyUnknownUsageCalls: settings.legacyUnknownUsageCalls,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        callLimit,
        noPaidRequest: true,
        providerMigration: migration,
        note: 'Token reservation is checked by ModelService for every actual request; this is not a price estimate.',
      };
      if (code) failure = new AppError(code, '准备条件不满足，未执行付费调用。');
    } else {
      const prepared = readRecord<{
        status: string;
        version: string;
        configuration: Configuration;
      }>('prepare-result.json');
      if (
        prepared.status !== 'prepared' ||
        prepared.version !== version ||
        !isDeepStrictEqual(prepared.configuration, configuration(settings))
      )
        fail('CORE_LIVE_CONFIGURATION_CHANGED');
      if (phase === 'generate') {
        const code = eligibility(settings, before);
        if (code) fail(code);
        baseline = projectTrees(
          store.rootPath,
          store.list().map((p) => p.id),
        );
        record('existing-projects-before.json', baseline);
        let project = store.create({
          name: '核心实测·文章清单',
          idea: '开发验证专用合成应用：单页管理文章标题与正文，可新增、选择查看、编辑、删除，明确保存反馈；关闭并重开工作台后保留。不是正式博客需求确认。',
        });
        projectId = project.id;
        record('project-created.json', { projectId, at: new Date().toISOString() });
        project = store.saveRequirements(projectId, {
          summary:
            '本机单页文章清单，文章有标题和正文；用产品工厂持久数据接口保存，不用localStorage。',
          audience: '使用虚构文章进行开发验证的测试人员',
          features: [
            '新增文章标题和正文',
            '清单选择并查看文章',
            '编辑并保存文章',
            '删除文章',
            '保存成功和失败有明确反馈',
            '关闭重开后仍能读取保存的文章',
          ],
          pages: ['文章清单与编辑表单'],
          data: ['文章数组：稳定标识、标题、正文；使用项目级JSON持久存储，保存后显示结果'],
          outOfScope: [
            '图片',
            'AI功能',
            '账号与权限',
            '网络访问',
            '发布',
            '分类标签',
            '第三方依赖',
          ],
          questions: [],
          acceptance: [
            '保存文章A的标题和正文后清单可见',
            '选择文章A可查看并编辑正文，保存后内容更新',
            '新建文章B并删除后清单和已保存数据均无B',
            '关闭本地应用和工作台，再打开同一应用后A仍存在且内容一致',
          ],
        });
        project = store.approveRequirements(projectId, project.requirements.at(-1)!.id);
        project = store.saveDesign(projectId, {
          direction:
            '浅色简洁中文单页；左侧文章清单，右侧标题输入和正文文本框，下方保存、删除、新建按钮及保存反馈。',
          palette: ['#ffffff', '#263a30', '#e8eee9'],
          pages: [
            {
              name: '文章清单与编辑表单',
              sections: ['文章清单', '标题与正文表单', '保存、删除、新建操作', '保存结果提示'],
            },
          ],
          notes: [
            '合成测试夹具由测试程序确认，不代表用户正式博客功能或视觉认可。',
            '提供明确可识别的中文表单标签与按钮；所有功能在单页完成。',
          ],
        });
        project = store.approveDesign(projectId, project.designs.at(-1)!.id);
        const plan = plans.create({
          schemaVersion: 1,
          requestId: randomUUID(),
          projectId,
          requirementId: project.requirements.at(-1)!.id,
          designId: project.designs.at(-1)!.id,
          profile: 'web',
        });
        if (!plan.run) fail('CORE_LIVE_PLAN');
        const request = {
          schemaVersion: 1 as const,
          requestId: randomUUID(),
          projectId,
          planRunId: plan.run.id,
          sourceRevision: 0,
          mode: 'generate' as const,
        };
        requestId = request.requestId;
        record('workflow-request.json', request);
        paidAllowed = true;
        let state: WorkflowState;
        try {
          state = await workflows.run(request);
        } finally {
          paidAllowed = false;
        }
        const snapshot = sources.get(projectId);
        result = {
          ...result,
          status: state.run?.status === 'ready' && state.current ? 'candidate_ready' : 'stopped',
          projectId,
          requestId: request.requestId,
          workflow: workflowSummary(state),
          source: {
            revision: snapshot.revision,
            sha256: sourceHash(JSON.stringify(snapshot)),
            files: snapshot.files.map(({ path, sha256, content }) => ({
              path,
              sha256,
              bytes: Buffer.byteLength(content, 'utf8'),
            })),
          },
          businessVerification: 'NOT_RUN',
        };
        if (result.status !== 'candidate_ready')
          failure = new AppError('CORE_LIVE_NO_CANDIDATE', '有限执行已停止，尚无就绪候选。');
      } else {
        const generated = readRecord<{ status: string; projectId: string; requestId: string }>(
          'generate-result.json',
        );
        if (generated.status !== 'candidate_ready') fail('CORE_LIVE_NO_CANDIDATE');
        projectId = generated.projectId;
        requestId = generated.requestId;
        baseline = readRecord<ProjectTree[]>('existing-projects-before.json');
        const reopenedTrees = projectTrees(
          store.rootPath,
          store
            .list()
            .map((p) => p.id)
            .filter((id) => id !== projectId),
        );
        if (!isDeepStrictEqual(baseline, reopenedTrees)) fail('CORE_LIVE_PROJECT_CHANGED');
        const state = workflows.state({ projectId, requestId: generated.requestId });
        if (!state.current || state.run?.status !== 'ready' || !state.run.buildId)
          fail('CORE_LIVE_STALE_CANDIDATE');
        const report = await desktop.runtime.openApplication(projectId, state.run.buildId);
        if (report.status !== 'observed') fail('CORE_LIVE_APPLICATION_START');
        const window = previews.applicationWindow(projectId);
        if (!window) fail('CORE_LIVE_APPLICATION_START');
        const structure: unknown = await window.webContents.executeJavaScript(`(() => ({
          headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,12).map(n => (n.textContent || '').trim().slice(0,160)),
          controls: Array.from(document.querySelectorAll('button,input,textarea,select,label')).slice(0,80).map(n => ({
            tag:n.tagName.toLowerCase(), id:(n.id || '').slice(0,80), type:(n.getAttribute('type') || '').slice(0,32),
            name:(n.getAttribute('name') || '').slice(0,80), label:(n.getAttribute('aria-label') || '').slice(0,160),
            text:['BUTTON','LABEL'].includes(n.tagName) ? (n.textContent || '').trim().slice(0,160) : ''
          }))
        }))()`);
        models.assertExportSafe([JSON.stringify(structure)]);
        record('application-structure.json', structure);
        writeFileSync(
          join(output, 'application-reopen.png'),
          (await window.webContents.capturePage()).toPNG(),
          { flag: 'wx', mode: 0o600 },
        );
        const data = desktop.appData.inspect(projectId);
        result = {
          ...result,
          status: 'opened',
          projectId,
          requestId: generated.requestId,
          workflow: workflowSummary(state),
          runtimeReportId: report.id,
          data: data
            ? { storeId: data.storeId, revision: data.snapshot.revision, sha256: data.sha256 }
            : null,
          businessVerification: 'NOT_RUN',
          note: 'Only structure and startup inspected. CRUD selectors and assertions require review of this synthetic page.',
        };
      }
    }
  } catch (error) {
    failure = error;
    result = {
      ...result,
      status: 'failed',
      code: safeCode(error),
      projectId: projectId ?? null,
      requestId: requestId ?? null,
    };
  } finally {
    paidAllowed = false;
    models.cancel();
    workflows.cancel();
    const after = models.usage(),
      afterSettings = models.settings();
    let existingProjectsUnchanged: boolean | null = null;
    if (baseline) {
      try {
        const ids = store
          .list()
          .map((p) => p.id)
          .filter((id) => id !== projectId);
        existingProjectsUnchanged = isDeepStrictEqual(baseline, projectTrees(store.rootPath, ids));
      } catch {
        existingProjectsUnchanged = false;
      }
    }
    const configurationUnchanged = isDeepStrictEqual(
      configuration(settings),
      configuration(afterSettings),
    );
    const paidBoundaryHeld =
      phase === 'generate'
        ? after.calls - before.calls <= callLimit && fetches <= callLimit
        : isDeepStrictEqual(before, after) &&
          settings.budgetTokens === afterSettings.budgetTokens &&
          fetches === 0;
    if (existingProjectsUnchanged === false || !configurationUnchanged || !paidBoundaryHeld) {
      failure = new AppError('CORE_LIVE_PROTECTION_FAILED', '停止并保留现场。');
      result = { ...result, status: 'failed', code: 'CORE_LIVE_PROTECTION_FAILED' };
    }
    result = {
      ...result,
      finishedAt: new Date().toISOString(),
      toolTurns,
      fetches,
      usageBefore: before,
      usageAfter: after,
      usageDelta: delta(before, after),
      budgetTokensBefore: settings.budgetTokens,
      budgetTokensAfter: afterSettings.budgetTokens,
      budgetTokensDelta: afterSettings.budgetTokens - settings.budgetTokens,
      configurationUnchanged,
      existingProjectsUnchanged,
      paidBoundaryHeld,
      callLimit,
      noAutomaticPaidRetry: true,
    };
    record(`${phase}-result.json`, result);
    await previews.stopAll();
    if (failure) app.exit(1);
    else app.quit();
  }
  if (failure) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  // Failure before a normal summary remains separately visible; never overwrite prior evidence.
  try {
    if (evidenceReady)
      record(`${phase}-failure-${randomUUID()}.json`, {
        runId,
        phase,
        at: new Date().toISOString(),
        code: safeCode(error),
      });
  } catch {
    /* The phase intent still prevents a paid retry when evidence storage is unavailable. */
  }
  app.exit(1);
});
