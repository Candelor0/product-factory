import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import { decodeDataBackup, encodeDataBackup } from '../src/main/data-backup-protocol';
import type { ApiResult, Project } from '../src/shared/contracts';
import type { BuildResult } from '../src/shared/build-contracts';
import type {
  DataBackupState,
  DataRestorePreviewResult,
  DataRestoreResult,
} from '../src/shared/data-backup-contracts';
import type { AppDataSnapshot } from '../src/shared/app-data-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const destinations = process.env.FACTORY_TEST_DESTINATIONS!;
const checks: string[] = [];
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks.push(name);
};
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const syntheticKey = 'data-backup-synthetic-key-no-account';
const originalTitle = '备份中的个人文章-合成内容-Ω';
const originalValues = {
  posts: [{ title: originalTitle }],
  removed_on_edit: { text: '旧数据内容-只应留在备份' },
  same: { visible: true },
};
const editedTitle = '备份之后保存的新文章-合成内容';
const source = `import {useEffect,useState} from 'react';
import {appData} from '@factory/data';
export default function App(){const [snapshot,setSnapshot]=useState(null),[title,setTitle]=useState(''),[notice,setNotice]=useState('');
useEffect(()=>{appData.read().then(setSnapshot).catch(e=>setNotice(e.message))},[]);
async function save(e){e.preventDefault();try{await appData.apply({requestId:crypto.randomUUID(),expectedRevision:snapshot.revision,changes:[{operation:'put',key:'posts',value:[{title}]},{operation:'put',key:'draft_metadata',value:{saved:true}},...(Object.hasOwn(snapshot.values,'removed_on_edit')?[{operation:'remove',key:'removed_on_edit'}]:[])]});setSnapshot(await appData.read());setNotice('已保存');}catch(e){setNotice(e.message)}}
return <main style={{maxWidth:680,margin:'60px auto',fontFamily:'system-ui'}}><h1>本地文章</h1><p data-testid="loaded">{snapshot?'已读取':'正在读取'}</p><form onSubmit={save}><label>新标题<input data-testid="title" value={title} onChange={e=>setTitle(e.target.value)}/></label><button data-testid="save" disabled={!snapshot||!title}>保存修改</button></form><p data-testid="save-notice">{notice}</p><p data-testid="revision">{snapshot?.revision}</p><ul>{(snapshot?.values.posts||[]).map((post,i)=><li key={i}>{post.title}</li>)}</ul></main>}`;
const requirement = {
  summary: '本地保存文章并主动备份和恢复',
  audience: '自己',
  features: ['文章编辑'],
  pages: ['编辑文章'],
  data: ['文章'],
  outOfScope: ['公网'],
  questions: [],
  acceptance: ['备份可核对恢复'],
};
const design = {
  direction: '浅色文章',
  palette: ['#ffffff', '#24372f'],
  pages: [{ name: '文章', sections: ['标题', '表单'] }],
  notes: [],
};
type Saved = {
  projectId: string;
  emptyId: string;
  planlessId: string;
  buildId: string;
  backupPath: string;
  revision: number;
  previewId: string;
  protected: Record<string, string>;
  dataHash: string;
};

async function run() {
  let modelCalls = 0;
  let exportChoice: string | null = null;
  let restoreChoice: string | null = null;
  let holdExport = false;
  let chooserWaiting = false;
  let releaseChooser: (() => void) | undefined;
  let saveDialogs = 0;
  let openDialogs = 0;
  const desktop = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    toolchainPath: resolve('dist/toolchain'),
    show: false,
    modelRequest: async () => {
      modelCalls++;
      throw new Error('Backup smoke must never dispatch a model request');
    },
    chooseDataExportDestination: async () => {
      saveDialogs++;
      if (holdExport) {
        chooserWaiting = true;
        await new Promise<void>((done) => {
          releaseChooser = done;
        });
        chooserWaiting = false;
        holdExport = false;
      }
      return exportChoice;
    },
    chooseDataRestoreFile: async () => {
      openDialogs++;
      return restoreChoice;
    },
  });
  const { window, store, plans, sources, sourceTools, models, appAi, appData, previews } = desktop;
  window.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(script: string) =>
    window.webContents.executeJavaScript(script) as Promise<T>;
  const raw = <T>(method: string, input?: unknown) =>
    exec<ApiResult<T>>(`window.factory[${JSON.stringify(method)}](${JSON.stringify(input)})`);
  const invoke = async <T>(method: string, input?: unknown): Promise<T> => {
    const result = await raw<T>(method, input);
    if (!result.ok) throw new Error(`${method}: ${result.error.code}`);
    return result.value;
  };
  const until = async (name: string, predicate: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 15000;
    do {
      if (await predicate()) return;
      await delay(40);
    } while (Date.now() < end);
    throw new Error(`Timed out: ${name}`);
  };
  const click = async (selector: string, target = window) => {
    await target.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).click();true`,
    );
    await delay(60);
  };
  const fill = async (selector: string, value: string, target = window) => {
    await target.webContents.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    );
    await delay(60);
  };
  const dataRequest = (id: string) => ({ schemaVersion: 1 as const, projectId: id });
  const state = (id: string) => invoke<DataBackupState>('dataBackupState', dataRequest(id));
  const notice = (text: string) =>
    until(`notice ${text}`, () =>
      exec(
        `document.querySelector('[data-testid=data-backup-notice]')?.textContent.includes(${JSON.stringify(text)})`,
      ),
    );
  const openPlan = async (project: Project) => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('sidebar', () => exec('!!document.querySelector(".sidebar")'));
    if (project.archived)
      await exec(
        'Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==="归档").click();true',
      );
    await until('project', () =>
      exec(
        `Array.from(document.querySelectorAll('.project-item')).some(e=>e.textContent.includes(${JSON.stringify(project.name)}))`,
      ),
    );
    await exec(
      `Array.from(document.querySelectorAll('.project-item')).find(e=>e.textContent.includes(${JSON.stringify(project.name)})).click();true`,
    );
    await until('plan tab', () =>
      exec(
        'Array.from(document.querySelectorAll("[role=tab]")).some(e=>e.textContent.includes("开发计划"))',
      ),
    );
    await exec(
      'Array.from(document.querySelectorAll("[role=tab]")).find(e=>e.textContent.includes("开发计划")).click();true',
    );
    await until('backup panel ready', () =>
      exec(
        '!!document.querySelector("[data-testid=data-backup-state]:not([data-status=loading])")',
      ),
    );
    await click('[data-testid=data-backup-details] > summary');
  };
  const choosePreview = async () => {
    await until('choose enabled', () =>
      exec('!document.querySelector("[data-testid=preview-data-restore]").disabled'),
    );
    await click('[data-testid=preview-data-restore]');
    await until('preview ready', () =>
      exec(
        '!!document.querySelector("[data-testid=data-restore-impact]") && document.querySelector("[data-testid=data-backup-state]").dataset.status==="preview"',
      ),
    );
    return exec<string>(
      'document.querySelector("[data-testid=data-restore-impact]").dataset.previewId',
    );
  };
  const capture = async (file: string, width: number, height: number, selector?: string) => {
    window.setSize(width, height);
    await delay(180);
    if (selector)
      await exec(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});true`,
      );
    await delay(160);
    check(
      `${file} has no horizontal overflow`,
      await exec('document.documentElement.scrollWidth<=innerWidth'),
    );
    writeFileSync(join(output, file), (await window.webContents.capturePage()).toPNG());
  };
  const openApplication = async (id: string, buildId: string) => {
    await invoke('openApplication', { projectId: id, buildId });
    await until(
      'application loaded',
      async () =>
        !!previews.applicationWindow(id) &&
        (await previews
          .applicationWindow(id)!
          .webContents.executeJavaScript(
            'document.querySelector("[data-testid=loaded]")?.textContent==="已读取"',
          )),
    );
    return previews.applicationWindow(id)!;
  };
  const edit = async (live: BrowserWindow, title: string, revision: number) => {
    await fill('[data-testid=title]', title, live);
    await click('[data-testid=save]', live);
    await until('actual form saved', () =>
      live.webContents.executeJavaScript(
        `document.querySelector('[data-testid=revision]').textContent===${JSON.stringify(String(revision))}`,
      ),
    );
  };
  const protectedHashes = (id: string) =>
    Object.fromEntries(
      [
        join(store.rootPath, 'projects', id, 'source/workspace.json'),
        join(store.rootPath, 'projects', id, 'runs/app-ai.json'),
        join(store.rootPath, 'credentials/provider.json'),
      ].map((file) => [file, hash(readFileSync(file))]),
    );
  const dataFile = (id: string) =>
    join(store.rootPath, 'projects', id, 'data/generated/state.json');
  const sameValues = (id: string) =>
    JSON.stringify(appData.get(id).values) === JSON.stringify(originalValues);
  let saved: Saved;
  if (phase === 'create') {
    const empty = store.create({ name: '尚无应用数据', idea: '只看状态不初始化存储' });
    await openPlan(empty);
    const emptyState = await state(empty.id);
    check(
      'opening backup UI without a plan does not initialize data',
      !emptyState.initialized &&
        emptyState.revision === null &&
        emptyState.bytes === 0 &&
        !existsSync(join(store.rootPath, 'projects', empty.id, 'data/generated')),
    );
    check(
      'uninitialized project cannot export or restore',
      await exec(
        'document.querySelector("[data-testid=export-app-data]").disabled && document.querySelector("[data-testid=preview-data-restore]").disabled',
      ),
    );
    const planless = store.create({ name: '无计划已有数据', idea: '存储状态可独立查看' });
    appData.apply(planless.id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: [{ operation: 'put', key: 'existing', value: '合成已存内容' }],
    });
    await openPlan(planless);
    check(
      'saved data remains visible when no development plan exists',
      (await state(planless.id)).revision === 1 &&
        (await exec(
          '!document.querySelector("[data-testid=export-app-data]").disabled && document.querySelector("[data-testid=data-backup-summary]").textContent.includes("1 个数据项")',
        )),
    );
    let project = store.create({ name: '应用数据备份验证', idea: requirement.summary });
    project = store.saveRequirements(project.id, requirement);
    project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = store.saveDesign(project.id, design);
    project = store.approveDesign(project.id, project.designs.at(-1)!.id);
    plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      requirementId: project.requirements.at(-1)!.id,
      designId: project.designs.at(-1)!.id,
      profile: 'web',
    });
    const id = project.id;
    const planRunId = plans.get(id).run!.id;
    const written = sourceTools.execute(
      { projectId: id, planRunId },
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'apply_changes',
        arguments: {
          expectedRevision: 0,
          changes: [
            { operation: 'write', path: 'src/app.tsx', expectedHash: null, content: source },
          ],
        },
      },
    );
    check('fixture uses a real constrained source transaction', written.ok);
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: syntheticKey,
      maxCalls: 10,
      maxTokens: 100000,
    });
    const authorization = appAi.state(id);
    appAi.grant({
      schemaVersion: 1,
      projectId: id,
      planRunId,
      expectedRevision: authorization.revision,
      connectionId: authorization.connection.id,
      purpose: '合成测试用途-不应出现在数据备份',
      maxCalls: 5,
      maxTokens: 100000,
    });
    appData.apply(id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: Object.entries(originalValues).map(([key, value]) => ({
        operation: 'put' as const,
        key,
        value,
      })),
    });
    const built = await invoke<BuildResult>('buildSource', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      planRunId,
      sourceRevision: 1,
    });
    check(
      'data-enabled fixture compiles through the real bundled toolchain',
      built.status === 'succeeded',
    );
    const buildId = built.state.artifact!.id;
    const protectedBefore = protectedHashes(id);
    const dataBefore = hash(readFileSync(dataFile(id)));
    await openPlan(project);
    check(
      'backup panel appears once beside existing optional panels',
      await exec(
        '["data-backup-state","app-ai-state","export-state","recovery-state"].every(id=>document.querySelectorAll("[data-testid="+id+"]").length===1)',
      ),
    );
    const backupPath = join(destinations, '文章 旧备份.json');
    exportChoice = backupPath;
    await click('[data-testid=export-app-data]');
    await notice('已导出');
    check(
      'UI exports an actual JSON file through trusted native chooser injection',
      existsSync(backupPath) && saveDialogs === 1,
    );
    const bytes = readFileSync(backupPath);
    const backup = decodeDataBackup(bytes);
    check(
      'backup preserves exact snapshot and original project/store/source binding',
      backup.project.id === id &&
        backup.snapshot.revision === 1 &&
        JSON.stringify(backup.snapshot.values) === JSON.stringify(originalValues) &&
        backup.sourceContentHash === hash(JSON.stringify(sources.get(id).files)),
    );
    check(
      'explicit data backup includes personal contents and excludes privileged state',
      bytes.includes(Buffer.from(originalTitle)) &&
        ![
          syntheticKey,
          source,
          '合成测试用途-不应出现在数据备份',
          'encryptedKey',
          'receipts',
          'maxTokens',
        ].some((value) => bytes.includes(Buffer.from(value))),
    );
    check('export does not mutate the data file', hash(readFileSync(dataFile(id))) === dataBefore);
    check(
      'workbench warns data backup contains personal content',
      await exec(
        'document.querySelector("[data-testid=data-backup-state]").textContent.includes("备份包含个人内容")',
      ),
    );
    const beforeCancel = readdirSync(destinations).length;
    exportChoice = null;
    await click('[data-testid=export-app-data]');
    await notice('已取消导出');
    check(
      'cancelled save chooser creates no file and leaves data unchanged',
      readdirSync(destinations).length === beforeCancel &&
        hash(readFileSync(dataFile(id))) === dataBefore,
    );
    for (const [method, input] of [
      ['exportAppData', { ...dataRequest(id), expectedRevision: 1, filePath: backupPath }],
      ['previewDataRestore', { ...dataRequest(id), path: backupPath }],
    ] as const) {
      const rejected = await raw(method, input);
      check(
        `${method} rejects renderer supplied file paths`,
        !rejected.ok && rejected.error.code === 'INVALID_INPUT',
      );
    }
    const live = await openApplication(id, buildId);
    await edit(live, editedTitle, 2);
    check(
      'actual persistent application modifies data after export',
      appData.get(id).revision === 2 &&
        JSON.stringify(appData.get(id).values).includes(editedTitle),
    );
    check(
      'generated application has no backup IPC bridge',
      await live.webContents.executeJavaScript(
        'typeof window.factory==="undefined" && typeof require==="undefined"',
      ),
    );
    restoreChoice = null;
    await click('[data-testid=preview-data-restore]');
    await notice('已取消选择备份');
    check(
      'cancelled open chooser does not close or modify the application',
      previews.applicationState(id).status === 'running' && appData.get(id).revision === 2,
    );
    restoreChoice = backupPath;
    const cancelledToken = await choosePreview();
    check(
      'preview explicitly requires a new confirmation checkbox',
      await exec(
        '!document.querySelector("[data-testid=acknowledge-data-restore]").checked && document.querySelector("[data-testid=confirm-data-restore]").disabled',
      ),
    );
    check(
      'preview focuses its review heading',
      await exec(
        'document.activeElement===document.querySelector("[data-testid=data-restore-impact] h4")',
      ),
    );
    check(
      'preview displays key changes without personal values or credentials',
      await exec(
        `(()=>{const text=document.querySelector('[data-testid=data-restore-impact]').textContent;return ['removed_on_edit','draft_metadata','posts'].every(k=>text.includes(k)) && !${JSON.stringify([originalTitle, editedTitle, originalValues.removed_on_edit.text, syntheticKey])}.some(v=>text.includes(v));})()`,
      ),
    );
    check(
      'preview warns about whole replacement, lost unsaved edits and bounded history',
      await exec(
        '(()=>{const text=document.querySelector("[data-testid=data-backup-state]").textContent;return ["整体替换","未保存的编辑会丢失","不会自动重新打开","最近 5 份"].every(s=>text.includes(s))})()',
      ),
    );
    await click('[data-testid=discard-data-restore]');
    await notice('已取消恢复');
    const discarded = await raw('confirmDataRestore', {
      ...dataRequest(id),
      previewId: cancelledToken,
    });
    check(
      'cancel clears the preview capability and does not change data',
      !discarded.ok &&
        discarded.error.code === 'DATA_RESTORE_CANCELLED' &&
        appData.get(id).revision === 2 &&
        previews.applicationState(id).status === 'running',
    );
    const staleToken = await choosePreview();
    await edit(live, `${editedTitle}-第二次`, 3);
    await until('stale preview warning', () =>
      exec(
        'document.querySelector("[data-testid=data-restore-impact]").textContent.includes("当前数据已有变化")',
      ),
    );
    await click('[data-testid=acknowledge-data-restore]');
    check(
      'changed data disables confirmation of old preview',
      await exec('document.querySelector("[data-testid=confirm-data-restore]").disabled'),
    );
    const staleResult = await raw('confirmDataRestore', {
      ...dataRequest(id),
      previewId: staleToken,
    });
    check(
      'backend rejects a stale preview without closing the running app',
      !staleResult.ok &&
        staleResult.error.code === 'DATA_RESTORE_STALE' &&
        appData.get(id).revision === 3 &&
        previews.applicationState(id).status === 'running',
    );
    await click('[data-testid=discard-data-restore]');
    await notice('已取消恢复');
    exportChoice = join(destinations, '不应创建-陈旧导出.json');
    holdExport = true;
    await click('[data-testid=export-app-data]');
    await until('native chooser held', () => chooserWaiting);
    check(
      'local backup operation disables simultaneous generation',
      await exec('document.querySelector("[data-testid=generate-source]").disabled'),
    );
    for (const [method, input] of [
      ['exportAppData', { ...dataRequest(id), expectedRevision: 3 }],
      ['archiveProject', { projectId: id, archived: true }],
      ['generateSource', { schemaVersion: 1, requestId: randomUUID(), projectId: id, planRunId }],
    ] as const) {
      const rejected = await raw(method, input);
      check(
        `held native chooser excludes ${method}`,
        !rejected.ok && rejected.error.code === 'BUSY',
      );
    }
    await edit(live, `${editedTitle}-第三次`, 4);
    releaseChooser!();
    await until('stale export result', () =>
      exec(
        'document.querySelector("[data-testid=data-backup-state]").textContent.includes("状态已变化")',
      ),
    );
    check(
      'data changing during native save chooser prevents obsolete export',
      !existsSync(exportChoice) && appData.get(id).revision === 4,
    );
    const wrongSourcePath = join(destinations, '源码不匹配.json');
    writeFileSync(
      wrongSourcePath,
      encodeDataBackup({ ...backup, sourceContentHash: 'a'.repeat(64) }),
    );
    restoreChoice = wrongSourcePath;
    const wrongSource = await raw('previewDataRestore', dataRequest(id));
    check(
      'backup source mismatch is refused before any write',
      !wrongSource.ok &&
        wrongSource.error.code === 'DATA_BACKUP_SOURCE' &&
        appData.get(id).revision === 4,
    );
    restoreChoice = backupPath;
    const wrongProject = await raw('previewDataRestore', dataRequest(planless.id));
    check(
      'backup cannot be restored to another project or storage identity',
      !wrongProject.ok && wrongProject.error.code === 'DATA_BACKUP_IDENTITY',
    );
    const stranger = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: resolve('dist/main/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await stranger.loadURL('data:text/html,<p>untrusted renderer</p>');
    for (const method of [
      'dataBackupState',
      'exportAppData',
      'previewDataRestore',
      'confirmDataRestore',
      'discardDataRestore',
    ]) {
      const result = (await stranger.webContents.executeJavaScript(
        `window.factory[${JSON.stringify(method)}](${JSON.stringify(dataRequest(id))})`,
      )) as ApiResult<unknown>;
      check(
        `untrusted renderer cannot invoke ${method}`,
        !result.ok && result.error.code === 'FORBIDDEN',
      );
    }
    stranger.destroy();
    const token = await choosePreview();
    check(
      'new preview requires confirmation again after stale/cancelled previews',
      await exec('!document.querySelector("[data-testid=acknowledge-data-restore]").checked'),
    );
    await capture('data-restore-1440.png', 1440, 1000, '[data-testid=data-restore-impact]');
    await capture('data-restore-1024.png', 1024, 720, '[data-testid=confirm-data-restore]');
    const injectedValues = await raw('confirmDataRestore', {
      ...dataRequest(id),
      previewId: token,
      values: { posts: [] },
    });
    check(
      'confirmation refuses renderer supplied replacement values',
      !injectedValues.ok && injectedValues.error.code === 'INVALID_INPUT',
    );
    await fill('[data-testid=title]', '未保存的编辑-应随恢复关窗', live);
    await click('[data-testid=acknowledge-data-restore]');
    await click('[data-testid=confirm-data-restore]');
    await notice('已恢复备份');
    check(
      'explicit UI confirmation restores the exact backup as a new version',
      appData.get(id).revision === 5 && sameValues(id),
    );
    check(
      'successful restore closes the persistent application without reopening it',
      live.isDestroyed() && previews.applicationState(id).status === 'stopped',
    );
    check(
      'successful restore is announced and focused',
      await exec(
        'document.activeElement===document.querySelector("[data-testid=data-backup-notice]")',
      ),
    );
    const repeated = await invoke<DataRestoreResult>('confirmDataRestore', {
      ...dataRequest(id),
      previewId: token,
    });
    check(
      'same preview confirmation replays its receipt without adding a version',
      repeated.replayed &&
        repeated.appliedRevision === 5 &&
        repeated.revision === 5 &&
        appData.get(id).revision === 5,
    );
    check(
      'all source, credential and AI ledger bytes remain unchanged by data restore',
      JSON.stringify(protectedHashes(id)) === JSON.stringify(protectedBefore),
    );
    check(
      'data restore leaves AI authorization and budgets intact',
      appAi.state(id).status === 'authorized' &&
        appAi.state(id).usage.calls === 0 &&
        models.usage().calls === 0 &&
        models.settings().maxTokens === 100000,
    );
    check(
      'main workbench never receives the restored personal JSON body',
      !(await exec<string>('document.body.innerText')).includes(originalTitle),
    );
    await capture('data-restored-1440.png', 1440, 1000, '[data-testid=data-backup-state]');
    const archived = await invoke<Project>('archiveProject', { projectId: id, archived: true });
    await openPlan(archived);
    check(
      'archived project can export but cannot begin a data restore',
      await exec(
        '!document.querySelector("[data-testid=export-app-data]").disabled && document.querySelector("[data-testid=preview-data-restore]").disabled',
      ),
    );
    exportChoice = join(destinations, '归档项目备份.json');
    await click('[data-testid=export-app-data]');
    await notice('已导出');
    check(
      'archived export writes the actual retained data',
      decodeDataBackup(readFileSync(exportChoice)).snapshot.revision === 5,
    );
    const archivedRestore = await raw('previewDataRestore', dataRequest(id));
    check(
      'backend also rejects archived restore',
      !archivedRestore.ok && archivedRestore.error.code === 'ARCHIVED',
    );
    await invoke('archiveProject', { projectId: id, archived: false });
    saved = {
      projectId: id,
      emptyId: empty.id,
      planlessId: planless.id,
      buildId,
      backupPath,
      revision: 5,
      previewId: token,
      protected: protectedHashes(id),
      dataHash: hash(readFileSync(dataFile(id))),
    };
    writeFileSync(join(output, 'saved.json'), JSON.stringify(saved, null, 2));
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('homepage', () => exec('!!document.querySelector("[data-testid=idea-home]")'));
    await capture('homepage-1440.png', 1440, 960);
    await capture('homepage-1024.png', 1024, 720);
    check(
      'central single input and project sidebar are retained',
      await exec(
        'document.querySelectorAll("#idea-input").length===1 && document.querySelectorAll(".project-item").length===3 && !document.querySelector("[data-testid=data-backup-state]")',
      ),
    );
  } else {
    saved = JSON.parse(readFileSync(join(output, 'saved.json'), 'utf8'));
    check(
      'fresh process retains exact restored data and its new revision',
      appData.get(saved.projectId).revision === saved.revision &&
        sameValues(saved.projectId) &&
        hash(readFileSync(dataFile(saved.projectId))) === saved.dataHash,
    );
    check(
      'restart retains source, credentials and AI ledger bytes',
      JSON.stringify(protectedHashes(saved.projectId)) === JSON.stringify(saved.protected),
    );
    check(
      'startup never automatically reopens the restored application or invokes models',
      previews.applicationState(saved.projectId).status === 'stopped' && modelCalls === 0,
    );
    check(
      'observing an empty project still does not initialize it after restart',
      !(await state(saved.emptyId)).initialized &&
        !existsSync(join(store.rootPath, 'projects', saved.emptyId, 'data/generated')),
    );
    const oldPreview = await raw('confirmDataRestore', {
      ...dataRequest(saved.projectId),
      previewId: saved.previewId,
    });
    check(
      'expired previous-process preview never automatically replays a restore',
      !oldPreview.ok &&
        oldPreview.error.code === 'DATA_RESTORE_CANCELLED' &&
        appData.get(saved.projectId).revision === saved.revision,
    );
    const live = await openApplication(saved.projectId, saved.buildId);
    check(
      'actual reopened application reads the restored personal content',
      await live.webContents.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(originalTitle)}) && !document.body.innerText.includes(${JSON.stringify(editedTitle)})`,
      ),
    );
    check(
      'opening application does not silently rewrite restored data',
      hash(readFileSync(dataFile(saved.projectId))) === saved.dataHash,
    );
    await openPlan(store.get(saved.projectId));
    restoreChoice = saved.backupPath;
    const previewId = await choosePreview();
    check(
      'fresh process previews the selected backup without returning its content',
      await exec(
        'document.querySelector("[data-testid=data-restore-impact]").textContent.includes("另有 3 项内容相同")',
      ),
    );
    await click('[data-testid=acknowledge-data-restore]');
    await click('[data-testid=confirm-data-restore]');
    await notice('已恢复备份');
    check(
      'fresh explicit restore works in a new process and closes the app',
      appData.get(saved.projectId).revision === saved.revision + 1 &&
        sameValues(saved.projectId) &&
        live.isDestroyed(),
    );
    const receipt = await invoke<DataRestoreResult>('confirmDataRestore', {
      ...dataRequest(saved.projectId),
      previewId,
    });
    check(
      'new-process restore also deduplicates confirmation',
      receipt.replayed && receipt.revision === saved.revision + 1,
    );
    check(
      'independent project data stays isolated',
      appData.get(saved.planlessId).revision === 1 &&
        appData.get(saved.planlessId).values.existing === '合成已存内容',
    );
    check(
      'source and privileged ledgers remain unchanged after new-process restore',
      JSON.stringify(protectedHashes(saved.projectId)) === JSON.stringify(saved.protected),
    );
    await capture('data-restored-reopen-1024.png', 1024, 720, '[data-testid=data-backup-state]');
  }
  check('backup and restore never make a model request', modelCalls === 0);
  await previews.stopAll();
  writeFileSync(
    join(output, `data-backup-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        modelRequests: modelCalls,
        saveDialogs,
        openDialogs,
        versions: process.versions,
        limitations: [
          'Trusted chooser callbacks replace manual OS dialog interaction; actual files, IPC, compiler, stores and Electron are used.',
          'All personal contents and credentials are synthetic; macOS arm64 only.',
          'Restoration requires intact same-project storage and matching source contents; no business schema migration.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Data backup ${phase}: ${checks.length} checks passed`);
  app.exit(0);
}
mkdirSync(output, { recursive: true });
run().catch((error) => {
  console.error(String(error));
  writeFileSync(
    join(output, `failure-${phase}.json`),
    JSON.stringify({ error: String(error), checks }, null, 2),
  );
  app.exit(1);
});
