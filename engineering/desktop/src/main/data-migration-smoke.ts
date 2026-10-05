import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { startDesktop } from './app';
import { AppError } from './validation';
import type { ApiResult, Project } from '../shared/contracts';
import type { BuildResult } from '../shared/build-contracts';
import type {
  DataMigrationState,
  DataMigrationResult,
  DataMigrationPreview,
} from '../shared/data-migration-contracts';
import type { DataSchemaDeclaration } from '../shared/data-schema-contracts';
import type { AppDataResponse } from '../shared/app-data-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks.push(name);
};
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const syntheticKey = 'schema-migration-synthetic-key-no-account';
const originalTitle = '迁移之前的私人文章-合成内容-Ω';
const staleTitle = '预览之后的新私人文章-合成内容';
const finalTitle = '迁移后由应用保存的新文章-合成内容';
const declaration: DataSchemaDeclaration = {
  schemaVersion: 1,
  version: 1,
  keys: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, published: { type: 'boolean' } },
        required: ['title', 'published'],
      },
    },
  },
  migration: {
    fromVersion: 0,
    steps: [
      { operation: 'renameKey', from: 'articles', to: 'posts' },
      { operation: 'addField', key: 'posts', field: 'published', value: false },
    ],
  },
};
const source = (modern: boolean) => `import {useEffect,useState} from 'react';
import {appData} from '@factory/data';
export default function App(){const [snapshot,setSnapshot]=useState(null),[title,setTitle]=useState(''),[notice,setNotice]=useState('');
useEffect(()=>{appData.read().then(setSnapshot).catch(e=>setNotice(e.message))},[]);
async function save(e){e.preventDefault();try{await appData.apply({requestId:crypto.randomUUID(),expectedRevision:snapshot.revision,changes:[{operation:'put',key:'${modern ? 'posts' : 'articles'}',value:[{title${modern ? ',published:false' : ''}}]}]});setSnapshot(await appData.read());setNotice('已保存');}catch(e){setNotice(e.message)}}
return <main style={{maxWidth:680,margin:'60px auto',fontFamily:'system-ui'}}><h1>${modern ? '新版文章' : '原版文章'}</h1><p data-testid="loaded">{snapshot?'已读取':'正在读取'}</p><form onSubmit={save}><label>新标题<input data-testid="title" value={title} onChange={e=>setTitle(e.target.value)}/></label><button data-testid="save" disabled={!snapshot||!title}>保存文章</button></form><p data-testid="save-notice">{notice}</p><p data-testid="revision">{snapshot?.revision}</p><ul>{(snapshot?.values.${modern ? 'posts' : 'articles'}||[]).map((post,i)=><li key={i}>{post.title}${modern ? ' · {post.published?"已发布":"未发布"}' : ''}</li>)}</ul></main>}`;
const requirement = {
  summary: '本地文章应用显式数据结构迁移',
  audience: '自己',
  features: ['保存文章'],
  pages: ['文章'],
  data: ['文章'],
  outOfScope: ['公网'],
  questions: [],
  acceptance: ['主动确认迁移后保留已有内容'],
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
  otherId: string;
  planRunId: string;
  buildId: string;
  previewId: string;
  revision: number;
  sourceRevision: number;
  protected: Record<string, string>;
  dataHash: string;
};

async function run() {
  let modelCalls = 0;
  const desktop = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    toolchainPath: resolve('dist/toolchain'),
    show: false,
    modelRequest: async () => {
      modelCalls++;
      throw new Error('Migration smoke must never dispatch a model request');
    },
  });
  const {
    window,
    store,
    plans,
    sources,
    sourceTools,
    models,
    appAi,
    appData,
    appDataService,
    dataMigrations,
    previews,
    builds,
  } = desktop;
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
  const request = (id: string) => ({ schemaVersion: 1 as const, projectId: id });
  const state = (id: string) => invoke<DataMigrationState>('dataMigrationState', request(id));
  const notice = (text: string) =>
    until(`notice ${text}`, () =>
      exec(
        `document.querySelector('[data-testid=data-migration-notice]')?.textContent.includes(${JSON.stringify(text)})`,
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
    await until('migration panel', () =>
      exec(
        '!!document.querySelector("[data-testid=data-migration-state]:not([data-status=loading])")',
      ),
    );
    await click('[data-testid=data-migration-details] > summary');
  };
  const choosePreview = async (operation: 'migrate' | 'rollback' = 'migrate') => {
    const button = operation === 'migrate' ? 'preview-data-migration' : 'preview-data-rollback';
    await until('preview enabled', () =>
      exec(`!document.querySelector('[data-testid=${button}]').disabled`),
    );
    await click(`[data-testid=${button}]`);
    await until('preview ready', () =>
      exec(
        '!!document.querySelector("[data-testid=data-migration-impact]") && document.querySelector("[data-testid=data-migration-state]").dataset.status==="preview"',
      ),
    );
    return exec<string>(
      'document.querySelector("[data-testid=data-migration-impact]").dataset.previewId',
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
      'application read',
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
    await until('application saved', () =>
      live.webContents.executeJavaScript(
        `document.querySelector('[data-testid=revision]').textContent===${JSON.stringify(String(revision))}`,
      ),
    );
  };
  const setSource = (id: string, planRunId: string, modern: boolean, suffix = '') => {
    const snapshot = sources.get(id),
      schema = snapshot.files.find((f) => f.path === 'src/data-schema.json');
    const result = sourceTools.execute(
      { projectId: id, planRunId },
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'apply_changes',
        arguments: {
          expectedRevision: snapshot.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              content: source(modern) + suffix,
              expectedHash: snapshot.files.find((f) => f.path === 'src/app.tsx')?.sha256 ?? null,
            },
            ...(modern
              ? [
                  {
                    operation: 'write' as const,
                    path: 'src/data-schema.json',
                    expectedHash: schema?.sha256 ?? null,
                    content: JSON.stringify(declaration),
                  },
                ]
              : schema
                ? [
                    {
                      operation: 'delete' as const,
                      path: 'src/data-schema.json',
                      expectedHash: schema.sha256,
                    },
                  ]
                : []),
          ],
        },
      },
    );
    assert.ok(result.ok, 'real source transaction must succeed');
    return sources.get(id).revision;
  };
  const build = async (id: string, planRunId: string) => {
    const result = await invoke<BuildResult>('buildSource', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      planRunId,
      sourceRevision: sources.get(id).revision,
    });
    assert.equal(result.status, 'succeeded', 'real compiler must build fixture');
    return result.state.artifact!.id;
  };
  const restoreSource = async (id: string, planRunId: string, targetRevision: number) => {
    await invoke('restoreCheckpoint', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      planRunId,
      sourceRevision: sources.get(id).revision,
      targetRevision,
    });
  };
  const dataFile = (id: string) =>
    join(store.rootPath, 'projects', id, 'data/generated/state.json');
  const protectedHashes = (id: string) =>
    Object.fromEntries(
      [
        join(store.rootPath, 'projects', id, 'source/workspace.json'),
        join(store.rootPath, 'projects', id, 'runs/app-ai.json'),
        join(store.rootPath, 'credentials/provider.json'),
      ].map((file) => [file, hash(readFileSync(file))]),
    );
  const applicationRead = async (target: BrowserWindow) =>
    target.webContents.executeJavaScript(
      `fetch(new URL('/app-data',location.href),{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,operation:'read'})}).then(r=>r.json())`,
    ) as Promise<AppDataResponse>;
  let saved: Saved;
  if (phase === 'create') {
    const empty = store.create({ name: '未初始化结构项目', idea: '查看状态不能初始化或迁移' });
    await openPlan(empty);
    check(
      'viewing a planless uninitialized project does not create application data',
      !(await state(empty.id)).initialized &&
        !existsSync(join(store.rootPath, 'projects', empty.id, 'data/generated')),
    );
    check(
      'uninitialized project has no migration or rollback action',
      await exec(
        'document.querySelector("[data-testid=preview-data-migration]").disabled && document.querySelector("[data-testid=preview-data-rollback]").disabled',
      ),
    );
    const other = store.create({ name: '独立数据项目', idea: '迁移边界隔离' });
    appData.apply(other.id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: [
        { operation: 'put', key: 'articles', value: [{ title: '其他项目的合成私有内容' }] },
      ],
    });
    const otherHash = hash(readFileSync(dataFile(other.id)));
    let project = store.create({ name: '应用数据结构迁移', idea: requirement.summary });
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
    const id = project.id,
      planRunId = plans.get(id).run!.id;
    const legacySourceRevision = setSource(id, planRunId, false);
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
      purpose: '合成迁移验证不消费模型',
      maxCalls: 5,
      maxTokens: 100000,
    });
    appData.apply(id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: [{ operation: 'put', key: 'articles', value: [{ title: originalTitle }] }],
    });
    const legacyBuildId = await build(id, planRunId);
    const legacyArtifact = builds.artifact(id, legacyBuildId);
    const legacySession = appDataService.create(legacyArtifact, 'persistent');
    const live = await openApplication(id, legacyBuildId);
    check(
      'real legacy application opens with its original saved personal content',
      await live.webContents.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(originalTitle)})`,
      ),
    );
    check(
      'generated application has neither workbench migration APIs nor Node access',
      await live.webContents.executeJavaScript(
        'typeof window.factory==="undefined" && typeof require==="undefined"',
      ),
    );
    const modernSourceRevision = setSource(id, planRunId, true);
    const modernBuildId = await build(id, planRunId);
    const before = hash(readFileSync(dataFile(id)));
    const modernState = await state(id);
    check(
      'source declaration exposes a required adjacent migration without modifying data',
      !modernState.compatible &&
        modernState.currentVersion === 0 &&
        modernState.targetVersion === 1 &&
        modernState.canMigrate &&
        !modernState.canRollback &&
        hash(readFileSync(dataFile(id))) === before,
    );
    const blockedOpen = await raw('openApplication', { projectId: id, buildId: modernBuildId });
    check(
      'incompatible new application is refused while retaining the old window and data',
      !blockedOpen.ok &&
        blockedOpen.error.code === 'APP_DATA_SCHEMA_MISMATCH' &&
        !live.isDestroyed() &&
        hash(readFileSync(dataFile(id))) === before,
    );
    await invoke('openPreview', { projectId: id, buildId: modernBuildId });
    const temporary = previews.previewWindow(id)!;
    await until('temporary preview read', () =>
      temporary.webContents.executeJavaScript(
        'document.querySelector("[data-testid=loaded]")?.textContent==="已读取"',
      ),
    );
    check(
      'new schema temporary preview starts empty and cannot read personal contents',
      await temporary.webContents.executeJavaScript(
        `document.querySelector('[data-testid=revision]').textContent==='0' && !document.body.innerText.includes(${JSON.stringify(originalTitle)})`,
      ),
    );
    await edit(temporary, '临时内容不会迁入持久存储', 1);
    check(
      'temporary schema writes stay isolated from existing persistent data',
      hash(readFileSync(dataFile(id))) === before,
    );
    await invoke('closePreview', { projectId: id });
    await openPlan(project);
    check(
      'migration panel appears once beside existing backup and authorization sections',
      await exec(
        '["data-migration-state","data-backup-state","app-ai-state"].every(id=>document.querySelectorAll("[data-testid="+id+"]").length===1)',
      ),
    );
    const cancelled = await choosePreview();
    check(
      'preview starts with unchecked explicit consent and disabled confirmation',
      await exec(
        '!document.querySelector("[data-testid=acknowledge-data-migration]").checked && document.querySelector("[data-testid=confirm-data-migration]").disabled',
      ),
    );
    check(
      'migration review heading receives keyboard focus',
      await exec(
        'document.activeElement===document.querySelector("[data-testid=data-migration-impact] h4")',
      ),
    );
    check(
      'migration preview displays keys and steps but no personal values or credentials',
      await exec(
        `(()=>{const t=document.querySelector('[data-testid=data-migration-impact]').textContent;return t.includes('articles')&&t.includes('posts')&&t.includes('2 步')&&!${JSON.stringify([originalTitle, syntheticKey])}.some(v=>t.includes(v))})()`,
      ),
    );
    check(
      'review explains closing unsaved app edits, preserving prior values, backup recommendation and no automatic reopen',
      await exec(
        '(()=>{const t=document.querySelector("[data-testid=data-migration-state]").textContent;return ["未保存的编辑会丢失","不会自动重新打开","先单独备份","迁移前的值会保留","目前支持重命名和补默认值"].every(s=>t.includes(s))})()',
      ),
    );
    await click('[data-testid=discard-data-migration]');
    await notice('已取消');
    const cancelledResult = await raw('confirmDataMigration', {
      ...request(id),
      previewId: cancelled,
    });
    check(
      'discarded preview cannot commit and leaves live application unchanged',
      !cancelledResult.ok &&
        cancelledResult.error.code === 'DATA_MIGRATION_CANCELLED' &&
        !live.isDestroyed() &&
        hash(readFileSync(dataFile(id))) === before,
    );
    const dataStale = await choosePreview();
    await edit(live, staleTitle, 2);
    await until('data stale warning', () =>
      exec(
        'document.querySelector("[data-testid=data-migration-impact]").textContent.includes("当前数据或源码所需版本已有变化")',
      ),
    );
    await click('[data-testid=acknowledge-data-migration]');
    check(
      'new data after preview disables old confirmation',
      await exec('document.querySelector("[data-testid=confirm-data-migration]").disabled'),
    );
    const staleResult = await raw('confirmDataMigration', { ...request(id), previewId: dataStale });
    check(
      'trusted coordinator also refuses stale data before closing the app',
      !staleResult.ok &&
        staleResult.error.code === 'DATA_MIGRATION_STALE' &&
        !live.isDestroyed() &&
        appData.inspect(id)!.snapshot.revision === 2,
    );
    await click('[data-testid=discard-data-migration]');
    await notice('已取消');
    const sourceStale = await choosePreview();
    setSource(id, planRunId, true, '\n// 合成源码变化');
    const staleSourceResult = await raw('confirmDataMigration', {
      ...request(id),
      previewId: sourceStale,
    });
    check(
      'source changes invalidate a preview even when schema version is unchanged',
      !staleSourceResult.ok &&
        staleSourceResult.error.code === 'DATA_MIGRATION_STALE' &&
        !live.isDestroyed() &&
        appData.inspect(id)!.snapshot.revision === 2,
    );
    await click('[data-testid=discard-data-migration]');
    await notice('已取消');
    await restoreSource(id, planRunId, modernSourceRevision);
    const currentBuildId = await build(id, planRunId);
    const guardedHashes = protectedHashes(id);
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
      'dataMigrationState',
      'previewDataMigration',
      'confirmDataMigration',
      'discardDataMigration',
    ]) {
      const result = (await stranger.webContents.executeJavaScript(
        `window.factory[${JSON.stringify(method)}](${JSON.stringify(request(id))})`,
      )) as ApiResult<unknown>;
      check(
        `untrusted renderer cannot invoke ${method}`,
        !result.ok && result.error.code === 'FORBIDDEN',
      );
    }
    stranger.destroy();
    const token = await choosePreview();
    const injected = await raw('confirmDataMigration', {
      ...request(id),
      previewId: token,
      values: { posts: [] },
    });
    check(
      'confirmation rejects renderer supplied private replacement contents',
      !injected.ok && injected.error.code === 'INVALID_INPUT',
    );
    const script = await raw('previewDataMigration', {
      ...request(id),
      operation: 'migrate',
      script: 'arbitrary()',
    });
    check(
      'preview rejects arbitrary script or operation payloads',
      !script.ok && script.error.code === 'INVALID_INPUT',
    );
    await capture('data-migration-1440.png', 1440, 1000, '[data-testid=data-migration-impact]');
    await capture('data-migration-1024.png', 1024, 720, '[data-testid=confirm-data-migration]');
    const originalConfirm = dataMigrations.confirm.bind(dataMigrations);
    let confirmStarted = false,
      releaseConfirm!: () => void,
      confirmCalls = 0;
    dataMigrations.confirm = async (value) => {
      confirmCalls++;
      if (confirmCalls === 1) {
        confirmStarted = true;
        await new Promise<void>((done) => {
          releaseConfirm = done;
        });
        const result = await originalConfirm(value);
        assert.equal(result.replayed, false);
        throw new AppError('APP_DATA_COMMIT_UNCERTAIN', '提交回执尚未确认，请保留原请求再核对。');
      }
      return originalConfirm(value);
    };
    await fill('[data-testid=title]', '尚未保存的编辑-迁移关窗丢弃', live);
    await click('[data-testid=acknowledge-data-migration]');
    await click('[data-testid=confirm-data-migration]');
    await until('confirmation held', () => confirmStarted);
    check(
      'local migration confirmation disables simultaneous source generation',
      await exec('document.querySelector("[data-testid=generate-source]").disabled'),
    );
    for (const [method, input] of [
      ['archiveProject', { projectId: id, archived: true }],
      ['generateSource', { schemaVersion: 1, requestId: randomUUID(), projectId: id, planRunId }],
      ['confirmDataMigration', { ...request(id), previewId: token }],
    ] as const) {
      const result = await raw(method, input);
      check(`pending migration excludes ${method}`, !result.ok && result.error.code === 'BUSY');
    }
    releaseConfirm();
    await until('uncertain commit visible', () =>
      exec(
        'document.querySelector("[data-testid=data-migration-state]").textContent.includes("提交回执尚未确认")',
      ),
    );
    check(
      'explicit confirmation commits exact declarative migration and closes the application',
      appData.inspect(id)!.snapshot.revision === 3 &&
        isDeepStrictEqual(appData.inspect(id)!.snapshot.values, {
          posts: [{ title: staleTitle, published: false }],
        }) &&
        live.isDestroyed() &&
        previews.applicationState(id).status === 'stopped',
    );
    check(
      'migration retains exact pre-migration values for bounded rollback',
      JSON.stringify(appData.inspect(id)!.migration!.beforeSnapshot.values) ===
        JSON.stringify({ articles: [{ title: staleTitle }] }),
    );
    check(
      'uncertain UI keeps original preview token and never automatically repeats the operation',
      (await exec(
        `document.querySelector('[data-testid=data-migration-impact]').dataset.previewId===${JSON.stringify(token)} && document.querySelector('[data-testid=confirm-data-migration]').textContent==='重试同一次请求'`,
      )) && confirmCalls === 1,
    );
    const oldAccess = legacySession.execute({ schemaVersion: 1, operation: 'read' });
    check(
      'old artifact-bound data capability cannot read the migrated schema',
      !oldAccess.ok && oldAccess.error.code === 'APP_DATA_SCHEMA_MISMATCH',
    );
    const oldWrite = legacySession.execute({
      schemaVersion: 1,
      operation: 'apply',
      requestId: randomUUID(),
      expectedRevision: 3,
      changes: [{ operation: 'put', key: 'articles', value: [] }],
    });
    check(
      'old artifact-bound capability cannot overwrite the new schema',
      !oldWrite.ok &&
        oldWrite.error.code === 'APP_DATA_SCHEMA_MISMATCH' &&
        appData.inspect(id)!.snapshot.revision === 3,
    );
    const modernLive = await openApplication(id, currentBuildId);
    check(
      'new application opens after migration and reads preserved content with new field',
      await modernLive.webContents.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(staleTitle)})&&document.body.innerText.includes('未发布')`,
      ),
    );
    await exec(
      'Array.from(document.querySelectorAll("[role=tab]")).find(e=>e.textContent.includes("需求")).click();true',
    );
    await until('migration panel unmounted', () =>
      exec('!document.querySelector("[data-testid=data-migration-state]")'),
    );
    await exec(
      'Array.from(document.querySelectorAll("[role=tab]")).find(e=>e.textContent.includes("开发计划")).click();true',
    );
    await until('uncertain preview restored after tab navigation', () =>
      exec(
        '!!document.querySelector("[data-testid=data-migration-impact]") && document.querySelector("[data-testid=data-migration-state]").dataset.status === "preview"',
      ),
    );
    check(
      'tab navigation preserves the uncertain token, resets consent and performs no automatic retry',
      (await exec(
        `document.querySelector('[data-testid=data-migration-impact]').dataset.previewId===${JSON.stringify(token)} && !document.querySelector('[data-testid=acknowledge-data-migration]').checked`,
      )) && confirmCalls === 1,
    );
    await click('[data-testid=acknowledge-data-migration]');
    await click('[data-testid=confirm-data-migration]');
    await notice('已核对这次迁移');
    check(
      'manual retry reuses receipt without a new data revision or closing a newly opened app',
      confirmCalls === 2 &&
        appData.inspect(id)!.snapshot.revision === 3 &&
        !modernLive.isDestroyed() &&
        (await exec('!document.querySelector("[data-testid=data-migration-impact]")')),
    );
    check(
      'confirmed result receives keyboard focus',
      await exec(
        'document.activeElement===document.querySelector("[data-testid=data-migration-notice]")',
      ),
    );
    dataMigrations.confirm = originalConfirm;
    check(
      'migration leaves source, credentials and AI ledger bytes unchanged',
      JSON.stringify(protectedHashes(id)) === JSON.stringify(guardedHashes),
    );
    check(
      'migration spends no app or development AI budget and preserves authorization',
      appAi.state(id).status === 'authorized' &&
        appAi.state(id).usage.calls === 0 &&
        models.usage().calls === 0,
    );
    await restoreSource(id, planRunId, legacySourceRevision);
    const rollbackState = await state(id);
    check(
      'returning source to its former structure enables only the latest unwritten migration rollback',
      !rollbackState.compatible &&
        rollbackState.currentVersion === 1 &&
        rollbackState.targetVersion === 0 &&
        rollbackState.canRollback &&
        !rollbackState.canMigrate,
    );
    const rollbackProtected = protectedHashes(id);
    await openPlan(project);
    await choosePreview('rollback');
    await capture('data-rollback-1440.png', 1440, 1000, '[data-testid=data-migration-impact]');
    await capture('data-rollback-1024.png', 1024, 720, '[data-testid=confirm-data-migration]');
    await click('[data-testid=acknowledge-data-migration]');
    await click('[data-testid=confirm-data-migration]');
    await notice('已完成回退');
    check(
      'explicit rollback restores pre-migration values as a new revision and closes the app',
      appData.inspect(id)!.snapshot.revision === 4 &&
        JSON.stringify(appData.inspect(id)!.snapshot.values) ===
          JSON.stringify({ articles: [{ title: staleTitle }] }) &&
        modernLive.isDestroyed() &&
        (await state(id)).compatible,
    );
    check(
      'data rollback does not alter source, credentials or AI ledgers',
      JSON.stringify(protectedHashes(id)) === JSON.stringify(rollbackProtected),
    );
    const restoredBuildId = await build(id, planRunId);
    const restoredLive = await openApplication(id, restoredBuildId);
    check(
      'rebuilt original application reads rollback content',
      await restoredLive.webContents.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(staleTitle)})`,
      ),
    );
    await restoreSource(id, planRunId, modernSourceRevision);
    const finalBuildId = await build(id, planRunId);
    await openPlan(project);
    const finalToken = await choosePreview();
    await click('[data-testid=acknowledge-data-migration]');
    await click('[data-testid=confirm-data-migration]');
    await notice('已完成迁移');
    check(
      'a fresh explicitly confirmed migration after rollback creates one new version',
      appData.inspect(id)!.snapshot.revision === 5 && restoredLive.isDestroyed(),
    );
    const finalLive = await openApplication(id, finalBuildId);
    await edit(finalLive, finalTitle, 6);
    check(
      'new application can save schema-valid personal content after migration',
      appData.inspect(id)!.snapshot.revision === 6 &&
        isDeepStrictEqual(appData.inspect(id)!.snapshot.values, {
          posts: [{ title: finalTitle, published: false }],
        }),
    );
    await restoreSource(id, planRunId, legacySourceRevision);
    await openPlan(project);
    check(
      'data written after migration disables rollback even after source is restored',
      !(await state(id)).canRollback &&
        (await exec('document.querySelector("[data-testid=preview-data-rollback]").disabled')),
    );
    const deniedRollback = await raw('previewDataMigration', {
      ...request(id),
      operation: 'rollback',
    });
    check(
      'backend also denies rollback that could lose a post-migration write',
      !deniedRollback.ok &&
        deniedRollback.error.code === 'DATA_MIGRATION_UNAVAILABLE' &&
        appData.inspect(id)!.snapshot.revision === 6,
    );
    await restoreSource(id, planRunId, modernSourceRevision);
    const reopenedBuildId = await build(id, planRunId);
    await invoke('closeApplication', { projectId: id });
    await openPlan(project);
    check(
      'workbench displays no personal data values after complete migration flow',
      await exec(
        `!${JSON.stringify([originalTitle, staleTitle, finalTitle, syntheticKey])}.some(v=>document.body.innerText.includes(v))`,
      ),
    );
    check(
      'independent project storage is byte-identical after all migration operations',
      hash(readFileSync(dataFile(other.id))) === otherHash,
    );
    const archived = await invoke<Project>('archiveProject', { projectId: id, archived: true });
    await openPlan(archived);
    check(
      'archived project exposes no migration or rollback action',
      await exec(
        'document.querySelector("[data-testid=preview-data-migration]").disabled&&document.querySelector("[data-testid=preview-data-rollback]").disabled',
      ),
    );
    await invoke('archiveProject', { projectId: id, archived: false });
    saved = {
      projectId: id,
      emptyId: empty.id,
      otherId: other.id,
      planRunId,
      buildId: reopenedBuildId,
      previewId: finalToken,
      revision: 6,
      sourceRevision: sources.get(id).revision,
      protected: protectedHashes(id),
      dataHash: hash(readFileSync(dataFile(id))),
    };
    writeFileSync(join(output, 'saved.json'), JSON.stringify(saved, null, 2));
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('homepage', () => exec('!!document.querySelector("[data-testid=idea-home]")'));
    await capture('homepage-1440.png', 1440, 960);
    await capture('homepage-1024.png', 1024, 720);
    check(
      'light central single input and project sidebar remain unchanged',
      await exec(
        'document.querySelectorAll("#idea-input").length===1&&document.querySelectorAll(".project-item").length===3&&!document.querySelector("[data-testid=data-migration-state]")',
      ),
    );
  } else {
    saved = JSON.parse(readFileSync(join(output, 'saved.json'), 'utf8'));
    const current = await state(saved.projectId);
    check(
      'fresh process retains schema identity, exact migrated data and latest user write',
      current.compatible &&
        current.currentVersion === 1 &&
        current.targetVersion === 1 &&
        current.revision === saved.revision &&
        hash(readFileSync(dataFile(saved.projectId))) === saved.dataHash &&
        isDeepStrictEqual(appData.inspect(saved.projectId)!.snapshot.values, {
          posts: [{ title: finalTitle, published: false }],
        }),
    );
    check(
      'fresh process preserves source credentials and AI ledger bytes',
      JSON.stringify(protectedHashes(saved.projectId)) === JSON.stringify(saved.protected),
    );
    check(
      'restart retains latest pre-migration snapshot but denies destructive rollback after later write',
      !appData.inspect(saved.projectId)!.migration!.canRollback &&
        JSON.stringify(appData.inspect(saved.projectId)!.migration!.beforeSnapshot.values) ===
          JSON.stringify({ articles: [{ title: staleTitle }] }),
    );
    check(
      'startup does not automatically open apps, migrate data or call models',
      previews.applicationState(saved.projectId).status === 'stopped' && modelCalls === 0,
    );
    const expired = await raw('confirmDataMigration', {
      ...request(saved.projectId),
      previewId: saved.previewId,
    });
    check(
      'previous-process preview token cannot confirm after restart',
      !expired.ok &&
        expired.error.code === 'DATA_MIGRATION_CANCELLED' &&
        appData.inspect(saved.projectId)!.snapshot.revision === saved.revision,
    );
    check(
      'uninitialized project remains untouched across restart',
      !(await state(saved.emptyId)).initialized &&
        !existsSync(join(store.rootPath, 'projects', saved.emptyId, 'data/generated')),
    );
    const live = await openApplication(saved.projectId, saved.buildId);
    check(
      'actual reopened application reads the latest migrated personal content',
      await live.webContents.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(finalTitle)})&&document.body.innerText.includes('未发布')`,
      ),
    );
    check(
      'opening compatible application never silently rewrites saved data',
      hash(readFileSync(dataFile(saved.projectId))) === saved.dataHash,
    );
    const read = await applicationRead(live);
    check(
      'schema-bound SDK returns the current revision in the fresh process',
      read.ok && read.value.revision === saved.revision,
    );
    await openPlan(store.get(saved.projectId));
    check(
      'new process UI shows compatible structure and offers no unnecessary migration',
      await exec(
        'document.querySelector("[data-testid=data-migration-versions]").textContent.includes("当前版本 1")&&document.querySelector("[data-testid=preview-data-migration]").disabled&&document.querySelector("[data-testid=preview-data-rollback]").disabled',
      ),
    );
    await capture(
      'data-migrated-reopen-1440.png',
      1440,
      1000,
      '[data-testid=data-migration-state]',
    );
    await capture('data-migrated-reopen-1024.png', 1024, 720, '[data-testid=data-migration-state]');
    check(
      'independent project content remains isolated after restart',
      appData.inspect(saved.otherId)!.snapshot.revision === 1 &&
        JSON.stringify(appData.inspect(saved.otherId)!.snapshot.values).includes(
          '其他项目的合成私有内容',
        ),
    );
  }
  check('migration flow never dispatches any model request', modelCalls === 0);
  await previews.stopAll();
  writeFileSync(
    join(output, `data-migration-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        modelRequests: modelCalls,
        versions: process.versions,
        limitations: [
          'Real Electron workbench, native windows, IPC, bundled compiler and persistent stores; all data and credentials are synthetic.',
          'A post-commit error and pending confirmation are deliberately injected into the real coordinator to exercise uncertain UI receipt retry and IPC mutual exclusion.',
          'macOS arm64 only; limited declarative schema migration and latest unwritten migration rollback; no arbitrary migration scripts, cross-project or image migration.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Data migration ${phase}: ${checks.length} checks passed`);
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
