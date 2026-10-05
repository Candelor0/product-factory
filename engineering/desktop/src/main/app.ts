import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { ProjectStore } from './project-store';
import { DataBackupService } from './data-backup-service';
import { DataMigrationService } from './data-migration-service';
import { GapService } from './gap-service';
import { GapEvidenceStore } from './gap-evidence-store';
import { WorkflowRunner } from './workflow-runner';
import { WorkflowStore } from './workflow-store';
import { AppError } from './validation';
import { ModelService } from './model-service';
import { BlogRuntimeManager } from './blog-runtime';
import { PlanStore } from './plan-store';
import { SourceStore } from './source-store';
import { SourceToolExecutor } from './source-tools';
import { CodingStore } from './coding-store';
import { CodingRunner } from './coding-runner';
import { BuildStore } from './build-store';
import { BuildService } from './build-service';
import { RepairStore } from './repair-store';
import { RepairRunner } from './repair-runner';
import { GeneratedPreview } from './generated-preview';
import { loadToolchain } from './toolchain';
import { RecoveryService } from './recovery-service';
import { RuntimeStore } from './runtime-store';
import { RuntimeService } from './runtime-service';
import { AppDataStore } from './app-data-store';
import { AppDataService } from './app-data-service';
import { AppAiStore } from './app-ai-store';
import { AppAiService } from './app-ai-service';
import { sourceHash } from './source-protocol';
import { ExportService } from './export-service';
import { loadExportKit } from './export-kit';
import { version as productVersion } from '../../package.json';
import type { AppSnapshot, FactoryApi, ProviderInput } from '../shared/contracts';

function payload(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new AppError('INVALID_INPUT', '操作参数不正确，请重新操作。');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 8000): string {
  if (typeof value !== 'string' || value.length > max)
    throw new AppError('INVALID_INPUT', '输入内容格式或长度不正确。');
  return value;
}
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : {
        code: 'INTERNAL_ERROR',
        message: '操作未完成，已保留现有文件。请重试；若持续出现，请检查数据目录权限与剩余空间。',
      };
}

export async function startDesktop(
  options: {
    dataPath?: string;
    rendererPath?: string;
    preloadPath?: string;
    blogPath?: string;
    toolchainPath?: string;
    toolchainBinaryPath?: string;
    show?: boolean;
    modelRequest?: typeof fetch;
    confirmBlogClose?: (window: BrowserWindow) => boolean;
    chooseExportDestination?: (suggestedName: string) => Promise<string | null>;
    chooseDataExportDestination?: (suggestedName: string) => Promise<string | null>;
    chooseDataRestoreFile?: () => Promise<string | null>;
    exportKitPath?: string;
  } = {},
) {
  app.setName('产品工厂');
  if (options.dataPath) app.setPath('userData', resolve(options.dataPath));
  else app.setPath('userData', join(app.getPath('appData'), 'ProductFactory'));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    throw new AppError('ALREADY_RUNNING', '工作台已打开。');
  }
  await app.whenReady();
  const dataPath = app.getPath('userData');
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  const store = new ProjectStore(dataPath);
  const plans = new PlanStore(store);
  const runtimes = new BlogRuntimeManager(
    store,
    options.blogPath ?? join(__dirname, '../blog'),
    options.show !== false,
    options.confirmBlogClose,
  );
  const cipher = {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value: string) => safeStorage.encryptString(value),
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
  const models = new ModelService(join(dataPath, 'credentials'), cipher, options.modelRequest);
  const sources = new SourceStore(store);
  const sourceTools = new SourceToolExecutor(store, plans, sources);
  const assertModificationSafe = (instruction: string) => {
    try {
      models.assertExportSafe([instruction]);
    } catch (error) {
      if (error instanceof AppError && error.code === 'EXPORT_SENSITIVE')
        throw new AppError(
          'SENSITIVE_INPUT',
          '修改要求中发现疑似凭据，请移除后再提交。未保存或发送本次要求。',
        );
      throw error;
    }
  };
  const coding = new CodingRunner(new CodingStore(store), sources, sourceTools, models, {
    assertModificationSafe,
  });
  const artifacts = new BuildStore(store);
  const builds = new BuildService(store, sources, sourceTools, artifacts);
  const appData = new AppDataStore(store);
  const appDataService = new AppDataService(appData, sourceTools, sources);
  const appAi = new AppAiService(store, sourceTools, models, new AppAiStore(store));
  const previews = new GeneratedPreview(
    options.show !== false,
    (artifact, mode) => appDataService.create(artifact, mode),
    (artifact, mode) => appAi.create(artifact, mode),
  );
  const toolchainPath = options.toolchainPath ?? join(__dirname, '../toolchain');
  const binaryPath =
    options.toolchainBinaryPath ??
    (app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked/dist/toolchain')
      : toolchainPath);
  const runtime = new RuntimeService(store, sources, sourceTools, builds, new RuntimeStore(store), {
    check: (artifact, signal) =>
      previews.check(artifact, loadToolchain(toolchainPath, binaryPath).runtime, signal),
    open: (artifact, onIssue, signal) =>
      previews.open(artifact, loadToolchain(toolchainPath, binaryPath).runtime, onIssue, signal),
    openApplication: (artifact, onIssue, signal) =>
      previews.openApplication(
        artifact,
        loadToolchain(toolchainPath, binaryPath).runtime,
        onIssue,
        signal,
      ),
  });
  const gaps = new GapService(
    store,
    plans,
    sources,
    builds,
    runtime,
    new GapEvidenceStore(store),
    (contents) => models.assertExportSafe(contents),
  );
  const repairs = new RepairRunner(new RepairStore(store), sources, sourceTools, models, builds, {
    runtime,
    assertModificationSafe,
  });
  const recovery = new RecoveryService(
    store,
    plans,
    sources,
    sourceTools,
    coding,
    repairs,
    builds,
    artifacts,
    runtime,
  );
  const workflows = new WorkflowRunner(
    store,
    sources,
    sourceTools,
    coding,
    builds,
    runtime,
    repairs,
    new WorkflowStore(store),
    {
      assertModificationSafe,
      beforeRun: (projectId) => {
        recovery.state(projectId);
        loadToolchain(toolchainPath, binaryPath);
      },
    },
  );
  const buildState = (projectId: string) => ({
    ...builds.state(projectId),
    ...previews.status(projectId),
  });
  const devUrl =
    !app.isPackaged && process.env.FACTORY_DEV_URL === 'http://127.0.0.1:5173'
      ? process.env.FACTORY_DEV_URL
      : null;
  const rendererPath = options.rendererPath ?? join(__dirname, '../renderer/index.html');
  const allowedUrl = devUrl ?? pathToFileURL(rendererPath).href;
  const trusted = (url: string) =>
    devUrl ? new URL(url).origin === devUrl : url.split('#')[0] === allowedUrl;
  const workbenchSession = session.fromPartition('persist:factory-workbench');
  workbenchSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  workbenchSession.setPermissionCheckHandler(() => false);
  workbenchSession.on('will-download', (event) => event.preventDefault());
  workbenchSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      callback({
        cancel:
          !devUrl ||
          !['http://127.0.0.1:5173', 'ws://127.0.0.1:5173'].includes(new URL(details.url).origin),
      });
    },
  );
  workbenchSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src " +
            (devUrl ? 'http://127.0.0.1:5173 ws://127.0.0.1:5173' : "'none'") +
            "; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
        ],
      },
    });
  });
  let window!: BrowserWindow;
  let quitInProgress = false;
  let quitApproved = false;
  let mutating = false;
  const protectedDirectories = [
    dataPath,
    app.getAppPath(),
    ...(app.isPackaged
      ? [
          process.resourcesPath,
          process.platform === 'darwin'
            ? resolve(dirname(process.execPath), '../..')
            : dirname(process.execPath),
        ]
      : []),
  ];
  const dataMigrations = new DataMigrationService(store, appData, sources, {
    closeApplication: (id) => previews.stopApplication(id),
  });
  const dataBackups = new DataBackupService(store, appData, sources, {
    version: productVersion,
    assertSafe: (contents) => models.assertExportSafe(contents),
    protectedDirectories,
    closeApplication: (id) => previews.stopApplication(id),
    chooseDestination:
      options.chooseDataExportDestination ??
      (async (suggestedName) => {
        const result = await dialog.showSaveDialog(window, {
          title: '导出应用数据备份',
          buttonLabel: '导出数据',
          defaultPath: join(app.getPath('downloads'), suggestedName),
          filters: [{ name: '应用数据备份', extensions: ['json'] }],
          properties: ['createDirectory', 'dontAddToRecent'],
          message: '备份包含本项目生成应用的个人业务内容。请选择新文件名，已有文件不会被覆盖。',
        });
        return result.canceled ? null : (result.filePath ?? null);
      }),
    chooseBackup:
      options.chooseDataRestoreFile ??
      (async () => {
        const result = await dialog.showOpenDialog(window, {
          title: '选择应用数据备份',
          buttonLabel: '查看恢复影响',
          filters: [{ name: '应用数据备份', extensions: ['json'] }],
          properties: ['openFile', 'dontAddToRecent'],
          message: '先核对备份和恢复影响，确认后才会替换本项目应用数据。',
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }),
  });
  const exports = new ExportService(store, sources, sourceTools, {
    version: productVersion,
    kit: () => loadExportKit(options.exportKitPath ?? join(__dirname, '../export-kit')),
    assertSafe: (contents) => models.assertExportSafe(contents),
    protectedDirectories,
    chooseDestination:
      options.chooseExportDestination ??
      (async (suggestedName) => {
        const result = await dialog.showSaveDialog(window, {
          title: '导出源码包',
          buttonLabel: '导出',
          defaultPath: join(app.getPath('downloads'), suggestedName),
          filters: [{ name: '源码压缩包', extensions: ['zip'] }],
          properties: ['createDirectory', 'dontAddToRecent'],
          message: '请选择新文件名。已有文件不会被覆盖；导出不包含个人业务数据和模型凭据。',
        });
        return result.canceled ? null : (result.filePath ?? null);
      }),
  });
  const reconcileBeforeWork = (input: unknown) => {
    const p = payload(input, [
      'schemaVersion',
      'requestId',
      'projectId',
      'planRunId',
      'sourceRevision',
      'runtimeReportId',
    ]);
    recovery.state(text(p.projectId));
  };
  const api: Record<keyof FactoryApi, (input?: unknown) => unknown> = {
    workflowState: (input) => workflows.state(input),
    runWorkflow: (input) => workflows.run(input),
    gapReport: (input) => gaps.state(input),
    recordGapEvidence: (input) => gaps.record(input),
    dataMigrationState: (input) => dataMigrations.state(input),
    previewDataMigration: (input) => dataMigrations.preview(input),
    confirmDataMigration: (input) => dataMigrations.confirm(input),
    discardDataMigration: (input) => dataMigrations.discard(input),
    dataBackupState: (input) => dataBackups.state(input),
    exportAppData: (input) => dataBackups.export(input),
    previewDataRestore: (input) => dataBackups.preview(input),
    confirmDataRestore: (input) => dataBackups.confirm(input),
    discardDataRestore: (input) => dataBackups.discard(input),
    appAiState: (input) => {
      const p = payload(input, ['projectId']);
      return appAi.state(text(p.projectId));
    },
    grantAppAi: (input) => appAi.grant(input),
    revokeAppAi: (input) => {
      const p = payload(input, ['projectId']);
      return appAi.revoke(text(p.projectId));
    },
    exportSource: (input) => exports.export(input),
    applicationState: (input) => {
      const p = payload(input, ['projectId']);
      const id = text(p.projectId);
      store.get(id);
      return previews.applicationState(id);
    },
    openApplication: async (input) => {
      const p = payload(input, ['projectId', 'buildId']);
      const id = text(p.projectId);
      recovery.state(id);
      const artifact = builds.artifact(id, text(p.buildId));
      const source = sources.get(id);
      if (
        source.revision !== artifact.sourceRevision ||
        sourceHash(JSON.stringify(source)) !== artifact.sourceHash
      )
        throw new AppError('STALE_SOURCE', '源码已变化，请先构建当前版本，再打开本地应用。');
      dataMigrations.assertCompatible(id);
      const existing = previews.applicationWindow(id);
      if (existing && previews.applicationState(id).buildId === artifact.id) {
        if (options.show !== false) {
          existing.show();
          existing.focus();
        }
      } else {
        const report = await runtime.openApplication(id, artifact.id);
        if (report.status !== 'observed')
          throw new AppError(
            report.status === 'cancelled' ? 'RUNTIME_CANCELLED' : 'RUNTIME_ISSUES',
            report.status === 'cancelled'
              ? '应用启动已取消。已保存的内容保留。'
              : '应用启动时发现问题，旧窗口和已保存内容保留。请查看运行检查记录。',
          );
      }
      return previews.applicationState(id);
    },
    closeApplication: async (input) => {
      const p = payload(input, ['projectId']);
      const id = text(p.projectId);
      store.get(id);
      await previews.stopApplication(id);
      return previews.applicationState(id);
    },
    runtimeState: (input) => {
      const p = payload(input, ['projectId']);
      return runtime.state(text(p.projectId));
    },
    checkRuntime: (input) => {
      const p = payload(input, ['schemaVersion', 'requestId', 'projectId', 'buildId']);
      recovery.state(text(p.projectId));
      return runtime.check(input);
    },
    recoveryState: (input) => {
      const p = payload(input, ['projectId']);
      return recovery.state(text(p.projectId));
    },
    restoreCheckpoint: (input) => recovery.restore(input),
    repairState: (input) => {
      const p = payload(input, ['projectId']);
      return repairs.state(text(p.projectId));
    },
    repairSource: async (input) => {
      const p = payload(input, [
        'schemaVersion',
        'requestId',
        'projectId',
        'planRunId',
        'sourceRevision',
        'runtimeReportId',
      ]);
      if (p.schemaVersion !== 1)
        throw new AppError('INVALID_INPUT', '此入口仅支持独立修复，请使用修改并检查。');
      reconcileBeforeWork(input);
      loadToolchain(toolchainPath, binaryPath);
      return repairs.repair(input);
    },
    buildState: (input) => {
      const p = payload(input, ['projectId']);
      return buildState(text(p.projectId));
    },
    buildSource: async (input) => {
      reconcileBeforeWork(input);
      loadToolchain(toolchainPath, binaryPath);
      const result = await builds.build(input);
      return { ...result, state: buildState(result.state.projectId) };
    },
    openPreview: async (input) => {
      const p = payload(input, ['projectId', 'buildId']);
      const artifact = builds.artifact(text(p.projectId), text(p.buildId));
      const existing = previews.previewWindow(artifact.projectId);
      if (existing && previews.status(artifact.projectId).previewBuildId === artifact.id) {
        // Reopening the same window must preserve its interaction state, not fabricate a new observation.
        if (options.show !== false) {
          existing.show();
          existing.focus();
        }
      } else {
        const report = await runtime.open(artifact.projectId, artifact.id);
        if (report.status !== 'observed')
          throw new AppError(
            report.status === 'cancelled' ? 'RUNTIME_CANCELLED' : 'RUNTIME_ISSUES',
            report.status === 'cancelled'
              ? '启动检查已取消，原预览已保留。'
              : '页面启动时发现运行问题，原预览已保留。请查看启动检查记录。',
          );
      }
      return buildState(artifact.projectId);
    },
    closePreview: async (input) => {
      const p = payload(input, ['projectId']);
      const id = text(p.projectId);
      store.get(id);
      await previews.stop(id);
      return buildState(id);
    },
    codingState: (input) => {
      const p = payload(input, ['projectId']);
      return coding.state(text(p.projectId));
    },
    codingFile: (input) => {
      const p = payload(input, ['projectId', 'path']);
      return coding.file(text(p.projectId), p.path);
    },
    generateSource: (input) => {
      const p = payload(input, ['schemaVersion', 'requestId', 'projectId', 'planRunId']);
      if (p.schemaVersion !== 1)
        throw new AppError('INVALID_INPUT', '此入口仅支持源码生成，请使用修改并检查。');
      reconcileBeforeWork(input);
      return coding.generate(input);
    },
    planState: (input) => {
      const p = payload(input, ['projectId']);
      return plans.get(text(p.projectId));
    },
    createPlan: (input) => {
      const result = plans.create(input);
      if (result.run) appAi.cancelProject(result.run.request.projectId);
      return result;
    },
    blogStatus: (input) => {
      const p = payload(input, ['projectId']);
      return runtimes.status(text(p.projectId));
    },
    startBlog: (input) => {
      const p = payload(input, ['projectId']);
      return runtimes.start(text(p.projectId));
    },
    stopBlog: (input) => {
      const p = payload(input, ['projectId']);
      return runtimes.stop(text(p.projectId));
    },
    snapshot: (): AppSnapshot => ({
      projects: store.list(),
      settings: models.settings(),
      usage: models.usage(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        version: app.getVersion(),
        dataPath,
        secureStorage: cipher.available(),
        mode: 'desktop',
      },
    }),
    createProject: (input) => {
      const p = payload(input, ['name', 'idea']);
      return store.create({ name: text(p.name, 80), idea: text(p.idea) });
    },
    renameProject: (input) => {
      const p = payload(input, ['projectId', 'name']);
      return store.rename(text(p.projectId), text(p.name, 80));
    },
    archiveProject: async (input) => {
      const p = payload(input, ['projectId', 'archived']);
      if (typeof p.archived !== 'boolean')
        throw new AppError('INVALID_INPUT', '归档状态必须为布尔值。');
      if (p.archived && (await runtimes.stop(text(p.projectId))).status === 'running')
        throw new AppError('CANCELLED', '已取消归档，博客仍在运行。请先保存正在编辑的文章。');
      if (p.archived) {
        await previews.stop(text(p.projectId));
        await previews.stopApplication(text(p.projectId));
      }
      return store.archive(text(p.projectId), p.archived);
    },
    saveRequirements: (input) => {
      const p = payload(input, ['projectId', 'content']);
      const result = store.saveRequirements(text(p.projectId), p.content as never);
      appAi.cancelProject(result.id);
      return result;
    },
    approveRequirements: (input) => {
      const p = payload(input, ['projectId', 'revisionId']);
      const result = store.approveRequirements(text(p.projectId), text(p.revisionId));
      appAi.cancelProject(result.id);
      return result;
    },
    generateRequirements: async (input) => {
      const p = payload(input, ['projectId', 'instruction']);
      const id = text(p.projectId);
      const current = store.get(id);
      if (current.archived) throw new AppError('ARCHIVED', '请先恢复已归档的项目。');
      const result = await models.requirements(current, text(p.instruction));
      const saved = store.saveRequirements(id, result);
      appAi.cancelProject(id);
      return saved;
    },
    generateDesign: async (input) => {
      const p = payload(input, ['projectId', 'instruction']);
      const id = text(p.projectId);
      const current = store.get(id);
      if (current.archived) throw new AppError('ARCHIVED', '请先恢复已归档的项目。');
      const result = await models.design(current, text(p.instruction));
      const saved = store.saveDesign(id, result);
      appAi.cancelProject(id);
      return saved;
    },
    approveDesign: (input) => {
      const p = payload(input, ['projectId', 'revisionId']);
      const result = store.approveDesign(text(p.projectId), text(p.revisionId));
      appAi.cancelProject(result.id);
      return result;
    },
    saveProvider: (input) => models.save(input as ProviderInput),
    checkProvider: () => models.check(),
    deleteProviderKey: () => models.deleteKey(),
    cancelGeneration: () => {
      workflows.cancel();
      dataBackups.cancel();
      dataMigrations.cancel();
      appAi.cancelAll();
      exports.cancel();
      runtime.cancel();
      repairs.cancel();
      builds.cancel();
      coding.cancel();
      models.cancel();
    },
    openDataFolder: async () => {
      const result = await shell.openPath(dataPath);
      if (result) throw new AppError('OPEN_FAILED', '暂时无法打开数据目录，请稍后重试。');
    },
  };
  const nonmutating = new Set<keyof FactoryApi>([
    'workflowState',
    'gapReport',
    'dataMigrationState',
    'discardDataMigration',
    'dataBackupState',
    'discardDataRestore',
    'appAiState',
    'revokeAppAi',
    'recoveryState',
    'snapshot',
    'planState',
    'codingState',
    'codingFile',
    'buildState',
    'repairState',
    'runtimeState',
    'applicationState',
    'blogStatus',
    'cancelGeneration',
    'openDataFolder',
  ]);
  for (const [name, handler] of Object.entries(api)) {
    ipcMain.handle(`factory:${name}`, async (event, input) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !trusted(event.senderFrame.url)
      )
        return { ok: false, error: { code: 'FORBIDDEN', message: '请求来源不受信任。' } };
      const mutation = !nonmutating.has(name as keyof FactoryApi);
      if (mutation && mutating)
        return {
          ok: false,
          error: { code: 'BUSY', message: '正在处理当前请求，请等待完成或取消。' },
        };
      if (mutation) mutating = true;
      try {
        return { ok: true, value: await handler(input) };
      } catch (error) {
        return { ok: false, error: publicError(error) };
      } finally {
        if (mutation) mutating = false;
      }
    });
  }
  const createWindow = async () => {
    window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1024,
      minHeight: 720,
      title: '产品工厂',
      backgroundColor: '#f6f7f4',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: options.preloadPath ?? join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        session: workbenchSession,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!trusted(url)) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (!quitApproved) {
        event.preventDefault();
        app.quit();
      }
    });
    if (devUrl) await window.loadURL(devUrl);
    else await window.loadFile(rendererPath);
    if (options.show !== false) window.show();
    return window;
  };
  await createWindow();
  app.on('second-instance', () => {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
  app.on('before-quit', (event) => {
    workflows.cancel();
    dataBackups.cancel();
    dataMigrations.cancel();
    exports.cancel();
    runtime.cancel();
    repairs.cancel();
    builds.cancel();
    coding.cancel();
    models.cancel();
    if (quitApproved) return;
    event.preventDefault();
    if (quitInProgress) return;
    quitInProgress = true;
    void runtimes
      .stopAll()
      .then(async (closed) => {
        quitInProgress = false;
        if (closed) {
          await previews.stopAll();
          quitApproved = true;
          app.quit();
        }
      })
      .catch(() => {
        quitInProgress = false;
      });
  });
  app.on('window-all-closed', () => app.quit());
  return {
    window,
    store,
    models,
    appAi,
    runtimes,
    plans,
    sources,
    sourceTools,
    coding,
    builds,
    repairs,
    previews,
    recovery,
    runtime,
    appData,
    appDataService,
    dataBackups,
    dataMigrations,
    gaps,
    workflows,
    exports,
    dataPath,
  };
}
