import { app } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import type { ApiResult, Project } from '../src/shared/contracts';
import type { BuildRequest, BuildResult } from '../src/shared/build-contracts';
import type { ApplicationState } from '../src/shared/app-data-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (name: string, value: unknown) => {
  assert.ok(value, name);
  checks.push(name);
};
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const key = 'app-data-synthetic-key-no-account';
const businessSecret = '独立业务内容-不会发给模型-Ω-2026';
const source = `import {useEffect,useState} from 'react';
import {appData} from '@factory/data';
export default function App(){
 const [snapshot,setSnapshot]=useState(null),[title,setTitle]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{appData.read().then(setSnapshot).catch(e=>setMessage(e.message));},[]);
 async function save(event){event.preventDefault(); if(!snapshot)return;try{await appData.apply({requestId:crypto.randomUUID(),expectedRevision:snapshot.revision,changes:[{operation:'put',key:'posts',value:[...(snapshot.values.posts||[]),{id:crypto.randomUUID(),title,status:'draft',tags:['日记']}]}]});setSnapshot(await appData.read());setTitle('');setMessage('已保存');}catch(e){setMessage(e.message);}}
 return <main style={{maxWidth:680,margin:'60px auto',fontFamily:'system-ui',color:'#24372f'}}><h1>我的本地博客</h1><p>文章保存在本项目中</p><form onSubmit={save}><label>文章标题<input data-testid="title" value={title} onChange={e=>setTitle(e.target.value)} /></label><button data-testid="save" disabled={!snapshot||!title}>保存草稿</button></form><p data-testid="status">{message}</p><p data-testid="loaded">{snapshot?'已读取':'正在读取'}</p><ul>{(snapshot?.values.posts||[]).map(post=><li key={post.id}>{post.title} · {post.status} · {post.tags.join(',')}</li>)}</ul></main>;
}`;
const requirement = {
  summary: '本地个人博客，保存文章草稿并重开阅读',
  audience: '自己',
  features: ['文章新建及草稿保存'],
  pages: ['文章列表', '编辑表单'],
  data: ['文章标题和状态、标签'],
  outOfScope: ['公网', '评论', '登录'],
  questions: [],
  acceptance: ['保存文章后重开仍存在', '改样式或回退源码后内容不丢失'],
};
const design = {
  direction: '浅色简洁博客',
  palette: ['#ffffff', '#24372f'],
  pages: [{ name: '文章', sections: ['标题', '表单', '文章列表'] }],
  notes: [],
};
type Saved = {
  projectId: string;
  otherId: string;
  buildId: string;
  hashes: Record<string, string>;
};

async function run() {
  let calls = 0;
  const modelRequest: typeof fetch = async (_url, options) => {
    assert.equal(phase, 'create');
    calls++;
    const payload = JSON.parse(String(options?.body));
    check(
      `model call ${calls} cannot see private data or credentials`,
      !JSON.stringify(payload).includes(businessSecret) && !JSON.stringify(payload).includes(key),
    );
    check(
      `model call ${calls} contains the constrained persistent data API`,
      payload.messages[0].content.includes('@factory/data'),
    );
    if (calls === 3)
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: '源码已保存，等待构建' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        { status: 200 },
      );
    const tool =
      calls === 1
        ? { id: 'list', name: 'list_files', args: {} }
        : {
            id: 'write',
            name: 'apply_changes',
            args: {
              expectedRevision: 0,
              changes: [
                { operation: 'write', path: 'src/app.tsx', expectedHash: null, content: source },
              ],
            },
          };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: tool.id,
                  type: 'function',
                  function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
      { status: 200 },
    );
  };
  const desktop = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    toolchainPath: resolve('dist/toolchain'),
    show: false,
    modelRequest,
  });
  const { window, store, plans, sources, sourceTools, models, previews, appData } = desktop;
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
  const waitFor = async (name: string, predicate: () => Promise<boolean>) => {
    const end = Date.now() + 20000;
    do {
      if (await predicate()) return;
      await delay(40);
    } while (Date.now() < end);
    throw new Error(`Timed out: ${name}`);
  };
  const create = (name: string) => {
    let p = store.create({ name, idea: requirement.summary });
    p = store.saveRequirements(p.id, requirement);
    p = store.approveRequirements(p.id, p.requirements.at(-1)!.id);
    p = store.saveDesign(p.id, design);
    p = store.approveDesign(p.id, p.designs.at(-1)!.id);
    plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: p.id,
      requirementId: p.requirements.at(-1)!.id,
      designId: p.designs.at(-1)!.id,
      profile: 'web',
    });
    return p;
  };
  const request = (id: string): BuildRequest => ({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: id,
    planRunId: plans.get(id).run!.id,
    sourceRevision: sources.get(id).revision,
  });
  const write = (id: string, content: string) => {
    const snapshot = sources.get(id);
    const result = sourceTools.execute(
      { projectId: id, planRunId: plans.get(id).run!.id },
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
              expectedHash: snapshot.files[0]?.sha256 ?? null,
              content,
            },
          ],
        },
      },
    );
    assert.ok(result.ok);
  };
  const dataFile = (id: string) =>
    join(store.rootPath, 'projects', id, 'data/generated/state.json');
  const ready = async (id: string) => {
    await waitFor('application data loaded', async () => {
      const live = previews.applicationWindow(id);
      return (
        !!live &&
        (await live.webContents.executeJavaScript(
          'document.querySelector("[data-testid=loaded]")?.textContent==="已读取"',
        ))
      );
    });
    return previews.applicationWindow(id)!;
  };
  const open = async (id: string, buildId: string) => {
    await invoke('openApplication', { projectId: id, buildId });
    return ready(id);
  };
  const openPlan = async (project: Project) => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await waitFor('sidebar', () =>
      exec(
        `Array.from(document.querySelectorAll('.project-item')).some(e=>e.textContent.includes(${JSON.stringify(project.name)}))`,
      ),
    );
    await exec(
      `Array.from(document.querySelectorAll('.project-item')).find(e=>e.textContent.includes(${JSON.stringify(project.name)})).click();true`,
    );
    await waitFor('plan tab', () =>
      exec(
        'Array.from(document.querySelectorAll("[role=tab]")).some(e=>e.textContent.includes("开发计划"))',
      ),
    );
    await exec(
      'Array.from(document.querySelectorAll("[role=tab]")).find(e=>e.textContent.includes("开发计划")).click();true',
    );
    await waitFor('app button', () =>
      exec(
        '!!document.querySelector("[data-testid=open-application]") && !document.querySelector("[data-testid=open-application]").disabled',
      ),
    );
  };
  let saved: Saved;
  if (phase === 'create') {
    const project = create('持久博客验证');
    const id = project.id;
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: key,
      maxCalls: 10,
    });
    await invoke('generateSource', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      planRunId: plans.get(id).run!.id,
    });
    check(
      'model tool loop saved actual data-enabled frontend',
      calls === 3 && sources.get(id).files[0].content === source,
    );
    const built = await invoke<BuildResult>('buildSource', request(id));
    check('data SDK import compiles using the bundled compiler', built.status === 'succeeded');
    await invoke('openPreview', { projectId: id, buildId: built.state.artifact!.id });
    check(
      'temporary preview does not even initialize persistent data',
      !existsSync(join(store.rootPath, 'projects', id, 'data/generated')),
    );
    const temp = previews.previewWindow(id)!;
    await temp.webContents.executeJavaScript(
      `const input=document.querySelector('[data-testid=title]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'只在预览里');input.dispatchEvent(new Event('input',{bubbles:true}));true`,
    );
    await delay(80);
    await temp.webContents.executeJavaScript(
      'document.querySelector("[data-testid=save]").click();true',
    );
    await delay(200);
    writeFileSync(
      join(output, 'temporary-form-diagnostic.json'),
      JSON.stringify(
        await temp.webContents.executeJavaScript(
          '({status:document.querySelector("[data-testid=status]").textContent,loaded:document.querySelector("[data-testid=loaded]").textContent,disabled:document.querySelector("[data-testid=save]").disabled,uuid:typeof crypto.randomUUID,secure:isSecureContext})',
        ),
        null,
        2,
      ),
    );
    await waitFor('temporary save', async () =>
      temp.webContents.executeJavaScript(
        'document.querySelector("[data-testid=status]").textContent==="已保存"',
      ),
    );
    check(
      'temporary save does not create project business files',
      !existsSync(join(store.rootPath, 'projects', id, 'data/generated')),
    );
    await openPlan(project);
    await exec('document.querySelector("[data-testid=open-application]").click();true');
    const live = await ready(id);
    check(
      'visible application starts with its own empty persisted data',
      appData.get(id).revision === 0 &&
        !(await live.webContents.executeJavaScript(
          'document.body.innerText.includes("只在预览里")',
        )),
    );
    await live.webContents.executeJavaScript(
      `const input=document.querySelector('[data-testid=title]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(businessSecret)});input.dispatchEvent(new Event('input',{bubbles:true}));true`,
    );
    await delay(80);
    await live.webContents.executeJavaScript(
      'document.querySelector("[data-testid=save]").click();true',
    );
    await waitFor('persistent save', async () => appData.get(id).revision === 1);
    check(
      'actual React form saved title status and tags',
      JSON.stringify(appData.get(id).values.posts).includes(businessSecret) &&
        JSON.stringify(appData.get(id).values.posts).includes('draft'),
    );
    const initialData = hash(readFileSync(dataFile(id)));
    writeFileSync(
      join(output, 'persistent-blog.png'),
      (await live.webContents.capturePage()).toPNG(),
    );
    await invoke('openApplication', { projectId: id, buildId: built.state.artifact!.id });
    check('same app reopen preserves its renderer', previews.applicationWindow(id) === live);
    await invoke('closeApplication', { projectId: id });
    const reopened = await open(id, built.state.artifact!.id);
    check(
      'stop and restart retain article exactly',
      hash(readFileSync(dataFile(id))) === initialData &&
        (await reopened.webContents.executeJavaScript(
          `document.body.innerText.includes(${JSON.stringify(businessSecret)})`,
        )),
    );
    await invoke('checkRuntime', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      buildId: built.state.artifact!.id,
    });
    check(
      'startup checking never touches persistent data',
      hash(readFileSync(dataFile(id))) === initialData,
    );
    const failing = `import {useEffect} from 'react';import {appData} from '@factory/data';export default function App(){useEffect(()=>{appData.read().then(s=>appData.apply({requestId:crypto.randomUUID(),expectedRevision:s.revision,changes:[{operation:'remove',key:'posts'}]})).then(()=>{throw new ReferenceError('synthetic probe failure')});},[]);return <p>候选检查</p>}`;
    write(id, failing);
    const stale = await raw('openApplication', {
      projectId: id,
      buildId: built.state.artifact!.id,
    });
    check(
      'stale build cannot reopen or replace the running application',
      !stale.ok &&
        stale.error.code === 'STALE_SOURCE' &&
        previews.applicationWindow(id) === reopened &&
        hash(readFileSync(dataFile(id))) === initialData,
    );
    const bad = await invoke<BuildResult>('buildSource', request(id));
    const failed = await raw('openApplication', { projectId: id, buildId: bad.state.artifact!.id });
    check(
      'failed temporary probe cannot delete actual saved posts',
      !failed.ok &&
        hash(readFileSync(dataFile(id))) === initialData &&
        previews.applicationWindow(id) === reopened,
    );
    write(id, source.replace('我的本地博客', '改版后的本地博客'));
    const changed = await invoke<BuildResult>('buildSource', request(id));
    const revised = await open(id, changed.state.artifact!.id);
    check(
      'source iteration keeps business bytes unchanged',
      hash(readFileSync(dataFile(id))) === initialData &&
        (await revised.webContents.executeJavaScript(
          'document.querySelector("h1").textContent==="改版后的本地博客"',
        )),
    );
    await invoke('restoreCheckpoint', { ...request(id), targetRevision: 1 });
    const restored = await invoke<BuildResult>('buildSource', request(id));
    await open(id, restored.state.artifact!.id);
    check(
      'source checkpoint restore leaves user data untouched',
      hash(readFileSync(dataFile(id))) === initialData,
    );
    const other = create('另一个持久项目');
    write(other.id, source);
    const otherBuild = await invoke<BuildResult>('buildSource', request(other.id));
    const otherLive = await open(other.id, otherBuild.state.artifact!.id);
    check(
      'separate project has isolated empty data',
      appData.get(other.id).revision === 0 &&
        !(await otherLive.webContents.executeJavaScript(
          `document.body.innerText.includes(${JSON.stringify(businessSecret)})`,
        )),
    );
    await invoke('archiveProject', { projectId: id, archived: true });
    check(
      'archive closes both app and temporary preview',
      previews.applicationState(id).status === 'stopped' &&
        previews.status(id).preview === 'closed',
    );
    await invoke('archiveProject', { projectId: id, archived: false });
    await open(id, restored.state.artifact!.id);
    check('unarchive reopens unchanged data', hash(readFileSync(dataFile(id))) === initialData);
    await openPlan(store.get(id));
    await exec(
      'document.querySelector("[data-testid=open-application]").scrollIntoView({block:"center"});true',
    );
    await delay(400);
    writeFileSync(
      join(output, 'workbench-application.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    window.setSize(1024, 768);
    await delay(300);
    await exec(
      'document.querySelector("[data-testid=open-application]").scrollIntoView({block:"center"});true',
    );
    await delay(200);
    check(
      '1024 layout has no horizontal overflow',
      await exec('document.documentElement.scrollWidth <= innerWidth'),
    );
    writeFileSync(
      join(output, 'workbench-application-1024.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    check(
      'real provider calls remain zero and no model request follows business writes',
      calls === 3,
    );
    check(
      'business validation does not promote plan acceptance',
      plans.get(id).run!.plan.tasks.every((task) => task.verification === 'not_run'),
    );
    saved = { projectId: id, otherId: other.id, buildId: restored.state.artifact!.id, hashes: {} };
    for (const name of [
      'data/generated/state.json',
      'source/workspace.json',
      'project.json',
      'runs/development-plans.json',
    ]) {
      const bytes = readFileSync(join(store.rootPath, 'projects', id, name));
      check(`${name} contains no synthetic API key`, !bytes.includes(Buffer.from(key)));
      saved.hashes[name] = hash(bytes);
    }
    writeFileSync(join(output, 'fixtures.json'), JSON.stringify(saved, null, 2));
  } else {
    saved = JSON.parse(readFileSync(join(output, 'fixtures.json'), 'utf8'));
    check(
      'reopening workbench does not automatically execute applications',
      previews.applicationState(saved.projectId).status === 'stopped',
    );
    const live = await open(saved.projectId, saved.buildId);
    check(
      'new process retains exact article text status tags',
      await live.webContents.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(businessSecret)}) && document.body.innerText.includes('draft') && document.body.innerText.includes('日记')`,
      ),
    );
    for (const [name, digest] of Object.entries(saved.hashes))
      check(
        `${name} is unchanged after new-process app open`,
        hash(readFileSync(join(store.rootPath, 'projects', saved.projectId, name))) === digest,
      );
    check(
      'other project remains isolated after restart',
      appData.get(saved.otherId).revision === 0,
    );
    check('restart does not invoke any model', calls === 0);
  }
  await previews.stopAll();
  check(
    'stopAll clears temporary and application windows',
    previews.applicationState(saved.projectId).status === 'stopped' &&
      previews.status(saved.projectId).preview === 'closed',
  );
  writeFileSync(
    join(output, `app-data-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        syntheticRequests: calls,
        realProviderRequests: 0,
        versions: process.versions,
        limitations: [
          'JSON data; no SQL/schema migration or uploaded images',
          'Startup probes use empty temporary data; no complete business acceptance',
          'Synthetic model, real compiler/Electron/disk; macOS arm64 only',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`App data ${phase}: ${checks.length} checks passed`);
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
