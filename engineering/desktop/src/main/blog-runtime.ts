import { BrowserWindow, dialog, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createBlogServer, PREVIEW_HEADER } from './blog-server';
import type { BlogRuntimeStatus } from '../shared/contracts';
import type { ProjectStore } from './project-store';
import { AppError } from './validation';

type Instance = {
  window: BrowserWindow;
  origin: string;
  startedAt: string;
  close: () => Promise<void>;
  requestClose: () => Promise<boolean>;
};

export class BlogRuntimeManager {
  private running = new Map<string, Instance>();
  constructor(
    private store: ProjectStore,
    private assetsDirectory: string,
    private show = true,
    private confirmDiscard: (window: BrowserWindow) => boolean = (window) =>
      dialog.showMessageBoxSync(window, {
        type: 'warning',
        title: '还有文字没有保存',
        message: '这篇文章还有未保存的更改。',
        detail: '关闭博客样例会丢失未保存的文字，已经保存的文章不会受影响。',
        buttons: ['继续编辑', '放弃未保存内容并关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }) === 1,
  ) {}

  status(projectId: string): BlogRuntimeStatus {
    this.store.get(projectId);
    const instance = this.running.get(projectId);
    return {
      projectId,
      status: instance ? 'running' : 'stopped',
      startedAt: instance?.startedAt ?? null,
      templateId: 'blog-sample-v1',
    };
  }

  // Exposed only to main-process integration checks; never included in IPC results.
  previewWindow(projectId: string) {
    return this.running.get(projectId)?.window;
  }

  async start(projectId: string): Promise<BlogRuntimeStatus> {
    const project = this.store.get(projectId);
    if (project.archived) throw new AppError('ARCHIVED', '请先恢复项目，再启动博客样例。');
    const existing = this.running.get(projectId);
    if (existing) {
      if (this.show) {
        existing.window.show();
        existing.window.focus();
      }
      return this.status(projectId);
    }
    const service = await createBlogServer({
      projectDirectory: join(this.store.rootPath, 'projects', project.id),
      assetsDirectory: this.assetsDirectory,
      assertWritable: () => {
        if (this.store.get(projectId).archived)
          throw new AppError('ARCHIVED', '项目已归档，文章未写入。');
      },
    });
    let preview: BrowserWindow | undefined;
    try {
      const isolated = session.fromPartition(`blog-${project.id}-${randomUUID()}`, {
        cache: false,
      });
      isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.on('will-download', (event) => event.preventDefault());
      const ownUrl = (url: string) => {
        try {
          return new URL(url).origin === service.origin;
        } catch {
          return false;
        }
      };
      isolated.webRequest.onBeforeRequest((details, callback) => {
        callback({
          cancel:
            !preview ||
            preview.isDestroyed() ||
            details.webContentsId !== preview.webContents.id ||
            !ownUrl(details.url),
        });
      });
      isolated.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        for (const name of Object.keys(headers))
          if (name.toLowerCase() === PREVIEW_HEADER) delete headers[name];
        if (
          preview &&
          !preview.isDestroyed() &&
          details.webContentsId === preview.webContents.id &&
          ownUrl(details.url)
        )
          headers[PREVIEW_HEADER] = service.token;
        callback({ requestHeaders: headers });
      });
      preview = new BrowserWindow({
        width: 1200,
        height: 840,
        minWidth: 760,
        minHeight: 600,
        show: false,
        title: `${project.name} · 博客运行样例`,
        backgroundColor: '#fbf9f4',
        autoHideMenuBar: true,
        webPreferences: {
          session: isolated,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          webviewTag: false,
          navigateOnDragDrop: false,
          spellcheck: false,
        },
      });
      preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      preview.webContents.on('will-navigate', (event) => event.preventDefault());
      preview.webContents.on('will-frame-navigate', (event) => event.preventDefault());
      preview.webContents.on('will-redirect', (event) => event.preventDefault());
      preview.webContents.on('will-attach-webview', (event) => event.preventDefault());
      preview.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      const previewWindow = preview;
      let closePending: Promise<boolean> | undefined;
      let finishClose: ((closed: boolean) => void) | undefined;
      const finishRequest = (closed: boolean) => {
        const resolveClose = finishClose;
        finishClose = undefined;
        closePending = undefined;
        resolveClose?.(closed);
      };
      const requestClose = (): Promise<boolean> => {
        if (previewWindow.isDestroyed()) return Promise.resolve(true);
        if (closePending) return closePending;
        const pending = new Promise<boolean>((resolve) => {
          finishClose = resolve;
        });
        closePending = pending;
        // Use the native close lifecycle so a dirty editor can keep both window and service alive.
        previewWindow.close();
        return pending;
      };
      previewWindow.webContents.on('will-prevent-unload', (event) => {
        let discard = false;
        try {
          discard = this.confirmDiscard(previewWindow);
        } catch {
          /* Keep the editor if confirmation fails. */
        }
        if (discard) event.preventDefault();
        else finishRequest(false);
      });
      const instance: Instance = {
        window: preview,
        origin: service.origin,
        startedAt: new Date().toISOString(),
        close: service.close,
        requestClose,
      };
      this.running.set(projectId, instance);
      const closed = () => {
        if (this.running.get(projectId) === instance) this.running.delete(projectId);
        finishRequest(true);
        void service.close();
      };
      preview.on('closed', closed);
      preview.webContents.on('render-process-gone', () => {
        if (!preview?.isDestroyed()) preview?.destroy();
      });
      await preview.loadURL(service.origin);
      if (this.show) preview.show();
      return this.status(projectId);
    } catch {
      this.running.delete(projectId);
      if (preview && !preview.isDestroyed()) preview.destroy();
      await service.close();
      throw new AppError('START_FAILED', '博客样例启动失败，已停止服务并保留文章数据。');
    }
  }

  async stop(projectId: string): Promise<BlogRuntimeStatus> {
    const instance = this.running.get(projectId);
    if (instance) {
      if (!(await instance.requestClose())) return this.status(projectId);
      await instance.close();
    }
    return this.status(projectId);
  }

  async stopAll(): Promise<boolean> {
    for (const projectId of [...this.running.keys()]) {
      if ((await this.stop(projectId)).status === 'running') return false;
    }
    return true;
  }
}
