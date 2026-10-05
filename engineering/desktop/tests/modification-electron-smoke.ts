import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import { AppError } from '../src/main/validation';
import type { ApiResult, Project } from '../src/shared/contracts';
import type { WorkflowRequest, WorkflowState } from '../src/shared/workflow-contracts';
import type { SourceToolResponse } from '../src/shared/source-contracts';
import type { BuildResult } from '../src/shared/build-contracts';
import type { GapReport } from '../src/shared/gap-contracts';
import { MODIFICATION_LIMITS } from '../src/shared/modification';

const output = process.env.FACTORY_TEST_OUTPUT!,
  phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks.push(name);
};
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const syntheticKey = 'modification-synthetic-key-no-account';
const businessSecret = '个人内容合成哨兵-不应发给修改模型';
const secondBusiness = '另一项个人合成内容';
const instruction =
  '把页面标题改为“我的待办”，新增按钮放到输入框前面，保存后清空输入；保留原有数据读写。浅色底改为淡绿色，标题抽为 labels.ts，并删除未使用的 obsolete.ts。';
const noopInstruction = '核对现有布局；如果已经符合要求，请不要修改源码。';
const cancelInstruction = '把新增按钮文字改成“记录”，保持其他功能。';
const requirement = {
  summary: '在本机保存个人待办清单',
  audience: '自己',
  features: ['新增并保存待办'],
  pages: ['待办清单'],
  data: ['待办条目'],
  outOfScope: ['公网', '账号'],
  questions: [],
  acceptance: ['保存后重开可以读取'],
};
const design = {
  direction: '浅色简单清单',
  palette: ['#ffffff', '#24372f'],
  pages: [{ name: '待办清单', sections: ['标题', '输入表单', '待办列表'] }],
  notes: [],
};
const originalSource = `import {useEffect,useState} from 'react';
import {appData} from '@factory/data';
import './style.css';
export default function App(){
 const [snapshot,setSnapshot]=useState(null),[title,setTitle]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{appData.read().then(setSnapshot).catch(e=>setNotice(e.message));},[]);
 async function save(event){event.preventDefault();if(!snapshot||!title)return;try{await appData.apply({requestId:crypto.randomUUID(),expectedRevision:snapshot.revision,changes:[{operation:'put',key:'items',value:[...(snapshot.values.items||[]),title]}]});setSnapshot(await appData.read());setNotice('已保存');}catch(e){setNotice(e.message)}}
 return <main><h1>个人清单</h1><p data-testid="loaded">{snapshot?'已读取':'正在读取'}</p><form onSubmit={save}><label>事项<input data-testid="title" value={title} onChange={e=>setTitle(e.target.value)} /></label><button data-testid="save" disabled={!snapshot||!title}>新增事项</button></form><p data-testid="notice">{notice}</p><ul data-testid="items">{(snapshot?.values.items||[]).map((item,i)=><li key={i}>{item}</li>)}</ul></main>
}`;
const originalStyle =
  'body { background: #ffffff; color:#24372f; font-family:system-ui; } main { max-width:680px; margin:60px auto; } form { display:flex; gap:12px; }';
const editedStyle = originalStyle.replace('#ffffff', '#f1f7ef');
const editedSource = originalSource
  .replace("import './style.css';", "import './style.css';\nimport { heading } from './labels';")
  .replace('<h1>个人清单</h1>', '<h1>{heading}</h1>')
  .replace("setNotice('已保存');", "setTitle('');setNotice('已保存');")
  .replace(
    '<label>事项<input data-testid="title" value={title} onChange={e=>setTitle(e.target.value)} /></label><button data-testid="save" disabled={!snapshot||!title}>新增事项</button>',
    '<button data-testid="save" disabled={!snapshot||!title}>新增事项</button><label>事项<input data-testid="title" value={title} onChange={e=>setTitle(e.target.value)} /></label>',
  );
type Tool = { id: string; name: string; args: unknown };
const response = (tools: Tool[] = []) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: tools.length
            ? {
                role: 'assistant',
                content: null,
                tool_calls: tools.map((tool) => ({
                  id: tool.id,
                  type: 'function',
                  function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                })),
              }
            : { role: 'assistant', content: '已完成本轮源码核对，结果以实际构建和启动观察为准。' },
          finish_reason: tools.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 8 },
    }),
    { status: 200 },
  );
type Saved = {
  projectId: string;
  buildId: string;
  modified: WorkflowRequest;
  noop: WorkflowRequest;
  cancelled: WorkflowRequest;
  uncertain: WorkflowRequest;
  sourceHash: string;
  dataHash: string;
  providerHash: string;
  planHash: string;
  projectHash: string;
  calls: number;
};

async function run() {
  assert.ok(['create', 'reopen'].includes(phase));
  let calls = 0,
    scenario: 'edit' | 'noop' | 'pending' = 'edit',
    expectedInstruction = instruction;
  let resolvePending: ((value: Response) => void) | undefined;
  const modelRequest: typeof fetch = async (_url, options) => {
    calls++;
    if (phase === 'reopen') throw new Error('Reopen must not dispatch models');
    const body = JSON.parse(String(options?.body)) as {
      tools: unknown[];
      messages: { role: string; content: string; tool_call_id?: string }[];
    };
    const modification = body.messages
      .filter((message) => message.role === 'user')
      .map((message) => JSON.parse(message.content))
      .find((message) => message.type === 'user_modification');
    check(
      `model attempt ${calls} receives the exact instruction and bound source identity`,
      !!modification &&
        modification.instruction === expectedInstruction &&
        Number.isInteger(modification.sourceRevision) &&
        /^[a-f0-9]{64}$/.test(modification.sourceHash),
    );
    check(
      `model attempt ${calls} excludes personal app values and provider credential`,
      ![businessSecret, secondBusiness, syntheticKey].some((value) =>
        JSON.stringify(body).includes(value),
      ),
    );
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      `Bearer ${syntheticKey}`,
    );
    if (scenario === 'pending')
      return new Promise<Response>((done) => {
        resolvePending = done;
      });
    const messages = body.messages.filter((message) => message.role === 'tool');
    if (!messages.length) return response([{ id: 'list', name: 'list_files', args: {} }]);
    if (!messages.some((message) => message.tool_call_id === 'read_app')) {
      const listed = JSON.parse(
        messages.find((message) => message.tool_call_id === 'list')!.content,
      ) as SourceToolResponse;
      assert.ok(listed.ok && listed.data.tool === 'list_files');
      const reads = [
        { id: 'read_app', name: 'read_file', args: { path: 'src/app.tsx' } },
        { id: 'read_style', name: 'read_file', args: { path: 'src/style.css' } },
        ...(listed.data.files.some((file) => file.path === 'src/obsolete.ts')
          ? [{ id: 'read_obsolete', name: 'read_file', args: { path: 'src/obsolete.ts' } }]
          : []),
      ];
      return response(reads);
    }
    if (scenario === 'noop' || messages.some((message) => message.tool_call_id === 'apply'))
      return response();
    const read = (id: string) => {
      const result = JSON.parse(
        messages.find((message) => message.tool_call_id === id)!.content,
      ) as SourceToolResponse;
      assert.ok(result.ok && result.data.tool === 'read_file');
      return result.data;
    };
    const current = read('read_app');
    check(
      'modification reads original file content before changing it',
      current.file.content === originalSource,
    );
    return response([
      {
        id: 'apply',
        name: 'apply_changes',
        args: {
          expectedRevision: current.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash: current.file.sha256,
              content: editedSource,
            },
            {
              operation: 'write',
              path: 'src/style.css',
              expectedHash: read('read_style').file.sha256,
              content: editedStyle,
            },
            {
              operation: 'write',
              path: 'src/labels.ts',
              expectedHash: null,
              content: "export const heading = '我的待办';\n",
            },
            {
              operation: 'delete',
              path: 'src/obsolete.ts',
              expectedHash: read('read_obsolete').file.sha256,
            },
          ],
        },
      },
    ]);
  };
  const desktop = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    toolchainPath: resolve('dist/toolchain'),
    show: false,
    modelRequest,
  });
  const { window, store, models, plans, sources, sourceTools, workflows, previews, gaps } = desktop;
  window.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(code: string) =>
    window.webContents.executeJavaScript(code) as Promise<T>;
  const raw = <T>(method: string, input?: unknown) =>
    exec<ApiResult<T>>(`window.factory[${JSON.stringify(method)}](${JSON.stringify(input)})`);
  const invoke = async <T>(method: string, input?: unknown): Promise<T> => {
    const result = await raw<T>(method, input);
    if (!result.ok) throw new Error(`${method}: ${result.error.code}`);
    return result.value;
  };
  const state = (projectId: string, requestId?: string) =>
    invoke<WorkflowState>('workflowState', { projectId, ...(requestId ? { requestId } : {}) });
  const until = async (name: string, predicate: () => boolean | Promise<boolean>, ms = 30000) => {
    const deadline = Date.now() + ms;
    do {
      if (await predicate()) return;
      await delay(40);
    } while (Date.now() < deadline);
    writeFileSync(
      join(output, `timeout-${phase}.json`),
      JSON.stringify({ name, body: await exec('document.body.innerText') }, null, 2),
    );
    writeFileSync(
      join(output, `timeout-${phase}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
    throw new Error(`Timed out: ${name}`);
  };
  const enabled = (selector: string) =>
    until(`enabled ${selector}`, () =>
      exec(
        `!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`,
      ),
    );
  const click = async (selector: string, target = window) => {
    if (
      target === window &&
      ['[data-testid=modify-workflow]', '[data-testid=check-workflow]'].includes(selector)
    )
      await enabled(selector);
    await target.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).click();true`,
    );
    await delay(40);
  };
  const fill = async (selector: string, value: string, target = window) => {
    await target.webContents.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    );
    await delay(40);
  };
  const ready = () =>
    until('workflow ready', () =>
      exec(
        '!!document.querySelector("[data-testid=workflow-state]")&&!document.querySelector("[data-testid=refresh-workflow]").disabled',
      ),
    );
  const openPlan = async (project: Project) => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('sidebar project', () =>
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
    await ready();
  };
  const capture = async (file: string, width: number, height: number, selector: string) => {
    window.setSize(width, height);
    await delay(150);
    await exec(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});true`,
    );
    await delay(100);
    check(
      `${file} has no horizontal overflow`,
      await exec('document.documentElement.scrollWidth<=innerWidth'),
    );
    writeFileSync(join(output, file), (await window.webContents.capturePage()).toPNG());
  };
  const create = (name: string) => {
    let project = store.create({ name, idea: requirement.summary });
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
    return project;
  };
  const write = (project: Project, files: { path: string; content: string }[]) => {
    const before = sources.get(project.id);
    const result = sourceTools.execute(
      { projectId: project.id, planRunId: plans.get(project.id).run!.id },
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'apply_changes',
        arguments: {
          expectedRevision: before.revision,
          changes: files.map((file) => ({
            operation: 'write',
            ...file,
            expectedHash:
              before.files.find((previous) => previous.path === file.path)?.sha256 ?? null,
          })),
        },
      },
    );
    assert.ok(result.ok);
  };
  const build = async (project: Project) => {
    const result = await invoke<BuildResult>('buildSource', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      planRunId: plans.get(project.id).run!.id,
      sourceRevision: sources.get(project.id).revision,
    });
    assert.equal(result.status, 'succeeded');
    await previews.stopAll();
    return result.state.artifact!.id;
  };
  const application = async (id: string, buildId: string) => {
    await invoke('openApplication', { projectId: id, buildId });
    await until(
      'persistent data loaded',
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
  const finished = async (project: Project, status: string, id?: string) => {
    await until(
      `workflow ${status}`,
      async () => {
        const current = await state(project.id);
        return current.run?.status === status && (!id || current.run.id !== id);
      },
      60000,
    );
    await until(`UI ${status}`, () =>
      exec(
        `document.querySelector('[data-testid=workflow-state]').dataset.status===${JSON.stringify(status)}&&document.querySelector('[data-testid=workflow-state]').getAttribute('aria-busy')==='false'`,
      ),
    );
    return state(project.id);
  };
  const modify = async (project: Project, text: string) => {
    await openPlan(project);
    await fill('[data-testid=modification-instruction]', text);
    const previous = (await state(project.id)).run?.id;
    await click('[data-testid=modify-workflow]');
    return finished(project, 'ready', previous);
  };
  const projectPath = (id: string, relative: string) =>
    join(store.rootPath, 'projects', id, relative);
  const providerPath = join(store.rootPath, 'credentials/provider.json');
  let saved: Saved;
  if (phase === 'create') {
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: syntheticKey,
      maxCalls: 100,
    });
    const project = create('自然语言修改 · 本机待办');
    await openPlan(project);
    await fill('[data-testid=modification-instruction]', instruction);
    check(
      'modification requires existing source without charging on entry',
      (await exec('document.querySelector("[data-testid=modify-workflow]").disabled')) &&
        calls === 0,
    );
    write(project, [
      { path: 'src/app.tsx', content: originalSource },
      { path: 'src/style.css', content: originalStyle },
      { path: 'src/obsolete.ts', content: 'export const unused = true;' },
      { path: 'src/untouched.ts', content: 'export const independent = "keep-me";' },
      {
        path: 'src/requirements.json',
        content: JSON.stringify({
          schemaVersion: 1,
          planRunId: plans.get(project.id).run!.id,
          requirements: [{ taskId: 'F001', files: ['src/app.tsx'] }],
        }),
      },
    ]);
    const protectedState = () =>
      hash(
        JSON.stringify({
          source: sources.get(project.id),
          journal: [
            'runs/workflows.json',
            'runs/workflows.initialized.json',
            'runs/coding.json',
            'runs/repairs.json',
          ].map((relative) => {
            const file = projectPath(project.id, relative);
            return existsSync(file) ? hash(readFileSync(file)) : null;
          }),
          provider: hash(readFileSync(providerPath)),
          usage: models.usage().calls,
          modelRequests: calls,
        }),
      );
    const beforeDenied = protectedState();
    const directModification = await raw('generateSource', {
      schemaVersion: 2,
      requestId: randomUUID(),
      projectId: project.id,
      planRunId: plans.get(project.id).run!.id,
      sourceRevision: sources.get(project.id).revision,
      sourceHash: hash(JSON.stringify(sources.get(project.id))),
      instruction,
    });
    check(
      'standalone generateSource IPC rejects modification schema without source journal or model writes',
      !directModification.ok &&
        directModification.error.code === 'INVALID_INPUT' &&
        protectedState() === beforeDenied,
    );
    const directModificationRepair = await raw('repairSource', {
      schemaVersion: 2,
      requestId: randomUUID(),
      projectId: project.id,
      planRunId: plans.get(project.id).run!.id,
      sourceRevision: sources.get(project.id).revision,
      modification: {
        workflowId: randomUUID(),
        sourceRevision: sources.get(project.id).revision,
        sourceHash: hash(JSON.stringify(sources.get(project.id))),
        instruction,
      },
    });
    check(
      'standalone repairSource IPC rejects internal modification context without journal or model writes',
      !directModificationRepair.ok &&
        directModificationRepair.error.code === 'INVALID_INPUT' &&
        protectedState() === beforeDenied,
    );
    const sensitiveModification = await raw('runWorkflow', {
      schemaVersion: 2,
      requestId: randomUUID(),
      projectId: project.id,
      planRunId: plans.get(project.id).run!.id,
      sourceRevision: sources.get(project.id).revision,
      mode: 'modify',
      instruction: `Change the heading; credential value: ${syntheticKey}`,
    });
    check(
      'modify IPC rejects configured credential text without storing or exposing it or consuming calls',
      !sensitiveModification.ok &&
        sensitiveModification.error.code === 'SENSITIVE_INPUT' &&
        !JSON.stringify(sensitiveModification).includes(syntheticKey) &&
        protectedState() === beforeDenied,
    );
    const oldBuild = await build(project);
    let live = await application(project.id, oldBuild);
    await fill('[data-testid=title]', businessSecret, live);
    await click('[data-testid=save]', live);
    await until('original app writes actual saved item', () =>
      live.webContents.executeJavaScript(
        `document.querySelector('[data-testid=items]').textContent.includes(${JSON.stringify(businessSecret)})`,
      ),
    );
    check(
      'baseline app has the behavior the user requests to change',
      await live.webContents.executeJavaScript(
        `document.querySelector('[data-testid=title]').value===${JSON.stringify(businessSecret)}`,
      ),
    );
    const report = await invoke<GapReport>('gapReport', { projectId: project.id });
    await invoke('recordGapEvidence', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      binding: report.binding!,
      taskId: 'F001',
      verdict: 'passed',
      filePaths: ['src/app.tsx'],
      steps: '输入一项合成待办并保存。',
      expected: '列表出现新增条目。',
      actual: '保存后列表出现条目。',
    });
    const beforeData = hash(readFileSync(projectPath(project.id, 'data/generated/state.json'))),
      beforePlan = hash(readFileSync(projectPath(project.id, 'runs/development-plans.json'))),
      beforeProject = hash(readFileSync(projectPath(project.id, 'project.json'))),
      untouched = sources
        .get(project.id)
        .files.find((file) => file.path === 'src/untouched.ts')!.sha256;
    await openPlan(project);
    await fill(
      '[data-testid=modification-instruction]',
      'x'.repeat(MODIFICATION_LIMITS.characters + 1),
    );
    check(
      'UI enforces the shared instruction length limit',
      await exec(
        'document.querySelector("[data-testid=modify-workflow]").disabled&&document.querySelector("[data-testid=modification-instruction]").maxLength===2000',
      ),
    );
    await fill('[data-testid=modification-instruction]', instruction);
    check(
      'UI explains instruction storage, model disclosure and scope reconfirmation',
      await exec(
        'document.querySelector("[data-testid=modification-form]").textContent.includes("发送给模型")&&document.querySelector("[data-testid=modification-form]").textContent.includes("重新确认需求和页面方向")',
      ),
    );
    await capture('modification-input-1440.png', 1440, 1000, '[data-testid=modification-form]');
    await capture('modification-input-1024.png', 1024, 800, '[data-testid=modification-form]');
    const oldWindow = live.id;
    await click('[data-testid=modify-workflow]');
    const modified = await finished(project, 'ready');
    check(
      'UI submits durable v2 modify request with the exact instruction',
      modified.run!.request.schemaVersion === 2 &&
        modified.run!.request.mode === 'modify' &&
        modified.run!.request.instruction === instruction,
    );
    check(
      'real model tool source update is compiled and startup checked',
      modified.run!.stages.map((stage) => `${stage.kind}:${stage.status}`).join(',') ===
        'generation:succeeded,build:succeeded,startup:succeeded' && modified.rounds === 4,
    );
    check(
      'real file summary distinguishes additions edits and deletion',
      modified.changes?.status === 'available' &&
        JSON.stringify(
          modified.changes.files.slice().sort((a, b) => a.path.localeCompare(b.path)),
        ) ===
          JSON.stringify([
            { path: 'src/app.tsx', kind: 'modified' },
            { path: 'src/labels.ts', kind: 'added' },
            { path: 'src/obsolete.ts', kind: 'deleted' },
            { path: 'src/style.css', kind: 'modified' },
          ]),
    );
    check(
      'unrelated source file is preserved',
      sources.get(project.id).files.find((file) => file.path === 'src/untouched.ts')!.sha256 ===
        untouched,
    );
    check(
      'modification leaves persistent data and original confirmations unchanged',
      hash(readFileSync(projectPath(project.id, 'data/generated/state.json'))) === beforeData &&
        hash(readFileSync(projectPath(project.id, 'runs/development-plans.json'))) === beforePlan &&
        hash(readFileSync(projectPath(project.id, 'project.json'))) === beforeProject,
    );
    check(
      'modification does not automatically replace the persistent application window',
      previews.applicationWindow(project.id)?.id === oldWindow,
    );
    check(
      'prior user business evidence becomes stale without being relabelled passed',
      gaps.state({ projectId: project.id }).rows.find((row) => row.id === 'F001')?.verification ===
        'stale',
    );
    await until('UI refreshes gap evidence after modification', () =>
      exec(
        'document.querySelector("[data-testid=gap-row][data-task-id=F001]").textContent.includes("旧核验已过期")',
      ),
    );
    await capture('modification-result-1440.png', 1440, 1000, '[data-testid=workflow-instruction]');
    await capture('modification-result-1024.png', 1024, 800, '[data-testid=workflow-changes]');
    live = await application(project.id, modified.run!.buildId!);
    check(
      'explicitly opened revised application keeps previously saved values and changes appearance',
      await live.webContents.executeJavaScript(
        `document.querySelector('h1').textContent==='我的待办'&&document.querySelector('[data-testid=items]').textContent.includes(${JSON.stringify(businessSecret)})&&getComputedStyle(document.body).backgroundColor==='rgb(241, 247, 239)'&&document.querySelector('form').firstElementChild.dataset.testid==='save'`,
      ),
    );
    await fill('[data-testid=title]', secondBusiness, live);
    await click('[data-testid=save]', live);
    await until('modified save behavior clears input', () =>
      live.webContents.executeJavaScript(
        `document.querySelector('[data-testid=title]').value===''&&document.querySelector('[data-testid=items]').textContent.includes(${JSON.stringify(secondBusiness)})`,
      ),
    );
    check('real user interaction implements the requested behavior and saves both items', true);
    await invoke('closeApplication', { projectId: project.id });
    scenario = 'noop';
    expectedInstruction = noopInstruction;
    const noop = await modify(project, noopInstruction);
    check(
      'no-op retains source revision and reports an available empty diff',
      noop.run!.latestRevision === modified.run!.latestRevision &&
        noop.changes?.status === 'available' &&
        noop.changes.files.length === 0,
    );
    check(
      'no-op UI explicitly reports no source difference',
      await exec(
        'document.querySelector("[data-testid=workflow-changes]").textContent.includes("本次未产生源码差异")',
      ),
    );
    const historyCalls = calls;
    await click('[data-testid=workflow-history] summary');
    const historySelector = `[data-testid=view-workflow-history][data-request-id="${modified.run!.id}"]`;
    await enabled(historySelector);
    await click(historySelector);
    await until('historical instruction is selected', () =>
      exec(
        `document.querySelector('[data-testid=workflow-instruction]').textContent.includes(${JSON.stringify(instruction)})`,
      ),
    );
    check(
      'history selection reads the original instruction without new model calls',
      calls === historyCalls && (await state(project.id)).run!.id === noop.run!.id,
    );
    await capture('modification-history-1024.png', 1024, 800, '[data-testid=workflow-history]');
    const stale: WorkflowRequest = {
      schemaVersion: 2,
      requestId: randomUUID(),
      projectId: project.id,
      planRunId: plans.get(project.id).run!.id,
      sourceRevision: sources.get(project.id).revision,
      mode: 'modify',
      instruction: '将按钮文字调整为新增。',
    };
    write(project, [
      {
        path: 'src/untouched.ts',
        content: 'export const independent = "keep-me";\n// explicit later edit',
      },
    ]);
    const staleCalls = calls;
    const rejected = await raw('runWorkflow', stale);
    check(
      'stale captured revision is rejected before model dispatch',
      !rejected.ok &&
        rejected.error.code === 'STALE_SOURCE' &&
        calls === staleCalls &&
        (await state(project.id, stale.requestId)).run === null,
    );
    await openPlan(project);
    scenario = 'pending';
    expectedInstruction = cancelInstruction;
    await fill('[data-testid=modification-instruction]', cancelInstruction);
    await click('[data-testid=modify-workflow]');
    await until('pending modification reached provider', () => !!resolvePending);
    check(
      'active modification prevents switching history records',
      await exec(
        'Array.from(document.querySelectorAll("[data-testid=view-workflow-history]")).every(button=>button.disabled)',
      ),
    );
    const cancelSource = hash(JSON.stringify(sources.get(project.id)));
    await click('.activity-bar button');
    const cancelled = await finished(project, 'cancelled');
    resolvePending!(response());
    resolvePending = undefined;
    await delay(80);
    check(
      'cancelled modification saves instruction but late result cannot mutate source',
      cancelled.run!.request.mode === 'modify' &&
        cancelled.run!.request.instruction === cancelInstruction &&
        hash(JSON.stringify(sources.get(project.id))) === cancelSource,
    );
    scenario = 'noop';
    expectedInstruction = '只核对，不改变任何文件。';
    const originalRun = workflows.run.bind(workflows);
    let uncertainRequest: WorkflowRequest | undefined;
    workflows.run = async (input) => {
      uncertainRequest = input as WorkflowRequest;
      await originalRun(input);
      throw new AppError('WORKFLOW_IO', '合成响应丢失。');
    };
    await openPlan(project);
    await fill('[data-testid=modification-instruction]', expectedInstruction);
    await click('[data-testid=modify-workflow]');
    await until('uncertain modification request retained', () =>
      exec(
        '!!document.querySelector("[data-testid=workflow-pending]")&&!document.querySelector("[data-testid=reconcile-workflow]").disabled',
      ),
    );
    workflows.run = originalRun;
    await fill('[data-testid=modification-instruction]', '另一条尚未提交的修改');
    const beforeReconcile = calls;
    await click('[data-testid=reconcile-workflow]');
    await until('original modification reconciled', () =>
      exec('!document.querySelector("[data-testid=workflow-pending]")'),
    );
    check(
      'original request reconciliation keeps a newly edited draft and never recharges',
      calls === beforeReconcile &&
        (await exec(
          'document.querySelector("[data-testid=modification-instruction]").value==="另一条尚未提交的修改"',
        )),
    );
    const uncertain = (await state(project.id, uncertainRequest!.requestId)).run!;
    check(
      'original modification instruction remains immutable when a new draft is edited',
      uncertain.request.mode === 'modify' && uncertain.request.instruction === expectedInstruction,
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
    await stranger.loadURL('data:text/html,<p>untrusted</p>');
    const forbidden = (await stranger.webContents.executeJavaScript(
      `window.factory.runWorkflow(${JSON.stringify({ ...stale, sourceRevision: sources.get(project.id).revision, requestId: randomUUID() })})`,
    )) as ApiResult<unknown>;
    check(
      'untrusted renderer cannot start a paid modification',
      !forbidden.ok && forbidden.error.code === 'FORBIDDEN',
    );
    stranger.destroy();
    const originalState = workflows.state.bind(workflows);
    workflows.state = (input) => {
      const value = originalState(input);
      return {
        ...value,
        changes: value.changes ? { ...value.changes, status: 'unavailable', files: [] } : null,
      };
    };
    await click('[data-testid=refresh-workflow]');
    await until('unavailable diff rendered', () =>
      exec(
        'document.querySelector("[data-testid=workflow-changes]").dataset.status==="unavailable"',
      ),
    );
    check(
      'unavailable comparison is never presented as no modification',
      await exec(
        'document.querySelector("[data-testid=workflow-changes]").textContent.includes("不能据此判断没有修改")&&!document.querySelector("[data-testid=workflow-changes]").textContent.includes("本次未产生源码差异")',
      ),
    );
    workflows.state = originalState;
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('homepage', () => exec('!!document.querySelector("[data-testid=idea-home]")'));
    await capture('homepage-1440.png', 1440, 1000, '[data-testid=idea-home]');
    await capture('homepage-1024.png', 1024, 720, '[data-testid=idea-home]');
    saved = {
      projectId: project.id,
      buildId: uncertain.buildId!,
      modified: modified.run!.request,
      noop: noop.run!.request,
      cancelled: cancelled.run!.request,
      uncertain: uncertain.request,
      sourceHash: hash(JSON.stringify(sources.get(project.id))),
      dataHash: hash(readFileSync(projectPath(project.id, 'data/generated/state.json'))),
      providerHash: hash(readFileSync(providerPath)),
      planHash: beforePlan,
      projectHash: beforeProject,
      calls: models.usage().calls,
    };
    writeFileSync(join(output, 'fixture.json'), JSON.stringify(saved, null, 2));
  } else {
    saved = JSON.parse(readFileSync(join(output, 'fixture.json'), 'utf8')) as Saved;
    const current = await state(saved.projectId);
    check(
      'fresh process recovers modification history without model dispatch',
      calls === 0 && current.history.length === 4 && models.usage().calls === saved.calls,
    );
    for (const request of [saved.modified, saved.noop, saved.cancelled, saved.uncertain]) {
      const found = await state(saved.projectId, request.requestId);
      check(
        `saved modification ${request.requestId} keeps the exact request after restart`,
        JSON.stringify(found.run!.request) === JSON.stringify(request),
      );
      const replay = await invoke<WorkflowState>('runWorkflow', request);
      check(
        `same modification ${request.requestId} only reconciles after restart`,
        replay.run!.id === request.requestId && calls === 0,
      );
    }
    await openPlan(store.get(saved.projectId));
    await click('[data-testid=workflow-history] summary');
    const selector = `[data-testid=view-workflow-history][data-request-id="${saved.modified.requestId}"]`;
    await enabled(selector);
    await click(selector);
    await until('reopened original modification', () =>
      exec(
        `document.querySelector('[data-testid=workflow-instruction]').textContent.includes(${JSON.stringify(instruction)})`,
      ),
    );
    check(
      'reopened historical source changes remain readable and explicitly stale',
      await exec(
        '!!document.querySelector("[data-testid=workflow-stale]")&&document.querySelector("[data-testid=workflow-changes]").textContent.includes("src/labels.ts")',
      ),
    );
    await capture(
      'modification-reopened-1440.png',
      1440,
      1000,
      '[data-testid=workflow-instruction]',
    );
    await capture('modification-reopened-1024.png', 1024, 800, '[data-testid=workflow-changes]');
    const live = await application(saved.projectId, saved.buildId);
    check(
      'new process opens revised app and retains both saved business items',
      await live.webContents.executeJavaScript(
        `document.querySelector('h1').textContent==='我的待办'&&document.querySelector('[data-testid=items]').textContent.includes(${JSON.stringify(businessSecret)})&&document.querySelector('[data-testid=items]').textContent.includes(${JSON.stringify(secondBusiness)})`,
      ),
    );
    check(
      'data source confirmations and provider settings are unchanged by restart/history',
      hash(JSON.stringify(sources.get(saved.projectId))) === saved.sourceHash &&
        hash(readFileSync(projectPath(saved.projectId, 'data/generated/state.json'))) ===
          saved.dataHash &&
        hash(readFileSync(projectPath(saved.projectId, 'runs/development-plans.json'))) ===
          saved.planHash &&
        hash(readFileSync(projectPath(saved.projectId, 'project.json'))) === saved.projectHash &&
        hash(readFileSync(providerPath)) === saved.providerHash,
    );
    check(
      'reopen and explicit app launch incur no modification model calls',
      calls === 0 && models.usage().calls === saved.calls,
    );
  }
  await previews.stopAll();
  writeFileSync(
    join(output, `modification-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        syntheticModelRequests: calls,
        versions: process.versions,
        limitations: [
          'Real Electron UI/IPC, source transactions, bundled compilation, runtime observations and saved-app interactions. All model responses and business data/credentials are synthetic.',
          'The unavailable-diff UI branch is exercised using an injected trusted state response; actual store/history failures are tested separately.',
          'Two independent Electron processes verify durable modification instructions/history and data retention, not real provider quality or full business acceptance.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Modification ${phase}: ${checks.length} checks passed`);
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
