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

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks.push(name);
};
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const syntheticKey = 'workflow-synthetic-key-no-account';
const privateSentinel = '自动开发不应读取的业务正文-合成哨兵';
const requirement = {
  summary: '本机任务清单',
  audience: '自己',
  features: ['新增任务'],
  pages: ['清单页面'],
  data: ['任务'],
  outOfScope: ['公网'],
  questions: [],
  acceptance: ['新增后清单中可见'],
};
const design = {
  direction: '浅色文字与简单表单',
  palette: ['#ffffff', '#263a30'],
  pages: [{ name: '清单页面', sections: ['标题', '任务表单'] }],
  notes: [],
};
const validSource = `import {useState} from 'react';export default function App(){const [n,setN]=useState(0);return <main style={{padding:40,fontFamily:'system-ui'}}><h1>本机任务清单</h1><button data-testid="add-item" onClick={()=>setN(n+1)}>新增任务</button><p data-testid="task-count">{n}</p></main>}`;
const compileFailure = `export default function App(){return <main>待完成`;
const startupFailure = `throw new Error('SYNTHETIC_RUNTIME_PRIVATE_MESSAGE');\n${validSource}`;
const response = (tool?: { id: string; name: string; args: unknown }) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: tool
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: tool.id,
                    type: 'function',
                    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                  },
                ],
              }
            : { role: 'assistant', content: '源码草稿已保存，最终状态以真实检查为准。' },
          finish_reason: tool ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    }),
    { status: 200 },
  );
type Fixture = { projectId: string; request: WorkflowRequest; status: string };
type Saved = {
  fixtures: Fixture[];
  readyId: string;
  interruptedId: string;
  interruptedRequest: WorkflowRequest;
  businessHash: string;
  providerHash: string;
  usageCalls: number;
};

async function run() {
  assert.ok(['create', 'reopen'].includes(phase));
  let fetches = 0;
  let scenario: 'compile' | 'startup' | 'post-compile-startup' | 'pending' = 'compile';
  let resolvePending: ((response: Response) => void) | undefined;
  const modelRequest: typeof fetch = async (_url, options) => {
    fetches++;
    if (phase === 'reopen') throw new Error('Restart must never contact a model');
    const body = JSON.parse(String(options?.body)) as {
      tools: unknown[];
      stream: boolean;
      messages: { role: string; content: string; tool_call_id?: string }[];
    };
    check(
      `synthetic model call ${fetches} uses actual bounded tool protocol`,
      body.tools.length === 3 && body.stream === false,
    );
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      `Bearer ${syntheticKey}`,
    );
    check(
      `model call ${fetches} excludes saved business text and credentials`,
      ![privateSentinel, syntheticKey].some((value) => JSON.stringify(body).includes(value)),
    );
    if (scenario === 'pending')
      return new Promise<Response>((done) => {
        resolvePending = done;
      });
    const repairing = body.messages[0]!.content.includes('本轮是已有');
    const toolMessages = body.messages.filter((item) => item.role === 'tool');
    if (repairing) {
      if (!toolMessages.length)
        return response({ id: 'repair_read', name: 'read_file', args: { path: 'src/app.tsx' } });
      const read = JSON.parse(toolMessages.at(-1)!.content) as SourceToolResponse;
      assert.ok(read.ok && read.data.tool === 'read_file');
      return response({
        id: 'repair_apply',
        name: 'apply_changes',
        args: {
          expectedRevision: read.data.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash: read.data.file.sha256,
              content: scenario === 'post-compile-startup' ? startupFailure : validSource,
            },
          ],
        },
      });
    }
    if (!toolMessages.length)
      return response({ id: 'generation_list', name: 'list_files', args: {} });
    if (toolMessages.length === 1) {
      const listed = JSON.parse(toolMessages[0]!.content) as SourceToolResponse;
      assert.ok(listed.ok && listed.data.tool === 'list_files');
      return response({
        id: 'generation_apply',
        name: 'apply_changes',
        args: {
          expectedRevision: listed.data.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash:
                listed.data.files.find((file) => file.path === 'src/app.tsx')?.sha256 ?? null,
              content: scenario === 'startup' ? startupFailure : compileFailure,
            },
          ],
        },
      });
    }
    return response();
  };
  const desktop = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    toolchainPath: resolve('dist/toolchain'),
    show: false,
    modelRequest,
  });
  const {
    window,
    store,
    models,
    plans,
    sources,
    sourceTools,
    workflows,
    appData,
    previews,
    runtime,
    gaps,
  } = desktop;
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
  const until = async (
    name: string,
    predicate: () => boolean | Promise<boolean>,
    timeout = 30000,
  ) => {
    const deadline = Date.now() + timeout;
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
  const click = async (selector: string) => {
    if (selector === '[data-testid=start-workflow]' || selector === '[data-testid=check-workflow]')
      await until(`action ready ${selector}`, () =>
        exec(
          `!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`,
        ),
      );
    await exec(`document.querySelector(${JSON.stringify(selector)}).click();true`);
    await delay(40);
  };
  const enabled = (selector: string) =>
    until(`enabled ${selector}`, () =>
      exec(
        `!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`,
      ),
    );
  const ready = () =>
    until('workflow panel ready', () =>
      exec(
        '!!document.querySelector("[data-testid=workflow-state]")&&!document.querySelector("[data-testid=refresh-workflow]").disabled',
      ),
    );
  const openPlan = async (project: Project) => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('project sidebar', () =>
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
  const capture = async (
    file: string,
    width: number,
    height: number,
    selector = '[data-testid=workflow-state]',
  ) => {
    window.setSize(width, height);
    await delay(180);
    await exec(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'});true`,
    );
    await delay(120);
    check(
      `${file} has no horizontal overflow`,
      await exec('document.documentElement.scrollWidth<=innerWidth'),
    );
    writeFileSync(join(output, file), (await window.webContents.capturePage()).toPNG());
  };
  const configure = (maxCalls: number) =>
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: syntheticKey,
      maxCalls,
    });
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
  const request = (project: Project, mode: 'generate' | 'check' = 'generate'): WorkflowRequest => ({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    planRunId: plans.get(project.id).run!.id,
    sourceRevision: sources.get(project.id).revision,
    mode,
  });
  const writeSource = (project: Project, content: string) => {
    const before = sources.get(project.id);
    const result = sourceTools.execute(
      { projectId: project.id, planRunId: plans.get(project.id).run!.id },
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'apply_changes',
        arguments: {
          expectedRevision: before.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash: before.files.find((f) => f.path === 'src/app.tsx')?.sha256 ?? null,
              content,
            },
          ],
        },
      },
    );
    assert.ok(result.ok);
  };
  const finished = async (project: Project, status: string) => {
    await until(
      `workflow ${status}`,
      async () => (await state(project.id)).run?.status === status,
      60000,
    );
    await until(`rendered ${status}`, () =>
      exec(
        `document.querySelector('[data-testid=workflow-state]').dataset.status===${JSON.stringify(status)}&&document.querySelector('[data-testid=workflow-state]').getAttribute('aria-busy')==='false'`,
      ),
    );
    return state(project.id);
  };
  const start = async (project: Project, mode: 'generate' | 'check', status: string) => {
    await openPlan(project);
    const selector =
      mode === 'generate' ? '[data-testid=start-workflow]' : '[data-testid=check-workflow]';
    await enabled(selector);
    await click(selector);
    return finished(project, status);
  };
  const businessPath = (id: string) =>
    join(store.rootPath, 'projects', id, 'data/generated/state.json');
  const providerPath = join(store.rootPath, 'credentials/provider.json');
  let saved: Saved;
  if (phase === 'create') {
    configure(100);
    const empty = store.create({ name: '确认前不启动', idea: '尚未确认' });
    await openPlan(empty);
    check(
      'unconfirmed plan cannot start either workflow action',
      await exec(
        'document.querySelector("[data-testid=start-workflow]").disabled&&document.querySelector("[data-testid=check-workflow]").disabled',
      ),
    );
    check('opening unconfirmed project never dispatches a model', fetches === 0);
    const compiled = create('自动开发 · 编译修复');
    appData.apply(compiled.id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: [{ operation: 'put', key: 'private', value: privateSentinel }],
    });
    const businessHash = hash(readFileSync(businessPath(compiled.id)));
    await openPlan(compiled);
    check(
      'automatic workflow is above source controls and preserves manual actions',
      await exec(
        '!!document.querySelector("[data-testid=generate-source]")&&!!(document.querySelector("[data-testid=workflow-state]").compareDocumentPosition(document.querySelector("[data-testid=coding-state]"))&Node.DOCUMENT_POSITION_FOLLOWING)',
      ),
    );
    check(
      'source-free project permits generate and disables check',
      await exec(
        '!document.querySelector("[data-testid=start-workflow]").disabled&&document.querySelector("[data-testid=check-workflow]").disabled',
      ),
    );
    check(
      'workflow states payment bounds and the limit of startup evidence',
      await exec(
        'document.querySelector("[data-testid=workflow-state]").textContent.includes("可能产生模型费用")&&document.querySelector("[data-testid=workflow-state]").textContent.includes("不等于业务验收")',
      ),
    );
    await click('[data-testid=start-workflow]');
    const first = await finished(compiled, 'ready');
    check(
      'real compiler failure is repaired once before startup readiness',
      first.run!.stages.map((stage) => `${stage.kind}:${stage.status}`).join(',') ===
        'generation:succeeded,build:failed,repair:succeeded,startup:succeeded',
    );
    check(
      'model-generated source and real repair source are distinct committed revisions',
      sources.get(compiled.id).revision === 2 &&
        sources.get(compiled.id).files.find((file) => file.path === 'src/app.tsx')?.content ===
          validSource,
    );
    check(
      'real source/model/tool/build counts remain within workflow bounds',
      first.rounds === 5 && first.toolCalls === 4 && first.builds <= 6 && first.builds >= 2,
    );
    check(
      'actual check report is observed without claiming business validation',
      runtime.state(compiled.id).report?.status === 'observed' &&
        gaps.state({ projectId: compiled.id }).rows.every((row) => row.verification === 'not_run'),
    );
    check(
      'automatic checks preserve personal application data',
      hash(readFileSync(businessPath(compiled.id))) === businessHash,
    );
    check(
      'automatic flow leaves no preview or persistent application window open',
      BrowserWindow.getAllWindows().length === 1,
    );
    await until('coding and gap report refresh on workflow completion', () =>
      exec(
        'document.querySelector("[data-testid=source-files]").textContent.includes("2")&&document.querySelector("[data-testid=gap-report]").textContent.includes("当前源码 v2 已编译")',
      ),
    );
    check('workflow completion refreshes source and technical gap evidence', true);
    await capture('workflow-ready-1440.png', 1440, 1000);
    await capture('workflow-ready-1024.png', 1024, 800);
    const fixtures: Fixture[] = [
      { projectId: compiled.id, request: first.run!.request, status: 'ready' },
    ];
    const beforeReplay = fetches;
    const replay = await invoke<WorkflowState>('runWorkflow', first.run!.request);
    check(
      'same persisted workflow request never repeats generation or repair',
      replay.run!.id === first.run!.id && fetches === beforeReplay,
    );
    writeSource(compiled, `${validSource}\n// explicit later source revision`);
    await click('[data-testid=refresh-workflow]');
    await ready();
    check(
      'changed source retains old readiness with an explicit stale label',
      !(await state(compiled.id)).current &&
        (await exec('!!document.querySelector("[data-testid=workflow-stale]")')),
    );
    const checked = await start(compiled, 'check', 'ready');
    check(
      'explicit check reuses saved source without paid generation when healthy',
      checked.run!.request.mode === 'check' &&
        checked.run!.stages.map((stage) => stage.kind).join(',') === 'build,startup' &&
        fetches === beforeReplay,
    );
    fixtures.push({ projectId: compiled.id, request: checked.run!.request, status: 'ready' });
    const startup = create('自动开发 · 启动修复');
    scenario = 'startup';
    const second = await start(startup, 'generate', 'ready');
    check(
      'actual startup error produces a runtime repair and observed candidate',
      second.run!.stages.map((stage) => `${stage.kind}:${stage.status}`).join(',') ===
        'generation:succeeded,build:succeeded,startup:failed,repair:succeeded' &&
        runtime.state(startup.id).report?.status === 'observed',
    );
    fixtures.push({ projectId: startup.id, request: second.run!.request, status: 'ready' });
    const stop = create('编译修复后的启动错误');
    scenario = 'post-compile-startup';
    const stopBefore = fetches;
    const stopped = await start(stop, 'generate', 'stopped');
    check(
      'a startup error after compiler repair stops instead of beginning another paid repair',
      stopped.run!.errorCode === 'RUNTIME_ISSUES' &&
        stopped.run!.stages.filter((stage) => stage.kind === 'repair').length === 1 &&
        fetches - stopBefore === 5,
    );
    fixtures.push({ projectId: stop.id, request: stopped.run!.request, status: 'stopped' });
    const budget = create('自动开发 · 额度耗尽');
    configure(models.usage().calls);
    const budgetCalls = fetches;
    const limited = await start(budget, 'generate', 'limited');
    check(
      'saved exhausted budget stops before any provider dispatch or source write',
      limited.run!.errorCode === 'BUDGET_EXCEEDED' &&
        fetches === budgetCalls &&
        sources.get(budget.id).revision === 0,
    );
    fixtures.push({ projectId: budget.id, request: limited.run!.request, status: 'limited' });
    configure(100);
    const cancelled = create('自动开发 · 手动停止');
    scenario = 'pending';
    await openPlan(cancelled);
    const cancelBefore = fetches;
    await click('[data-testid=start-workflow]');
    await until('pending model dispatch', () => fetches === cancelBefore + 1 && !!resolvePending);
    check(
      'active workflow disables manual generation and exposes global stop',
      await exec(
        'document.querySelector("[data-testid=generate-source]").disabled&&!!document.querySelector(".activity-bar button")',
      ),
    );
    const busy = await raw('archiveProject', { projectId: cancelled.id, archived: true });
    check(
      'main-process mutation guard rejects archive during workflow',
      !busy.ok && busy.error.code === 'BUSY',
    );
    await openPlan(cancelled);
    check(
      'reloading the workbench during a running workflow exposes the same cancellation channel',
      await exec(
        '!!document.querySelector("[data-testid=stop-workflow]")&&!document.querySelector("[data-testid=stop-workflow]").disabled',
      ),
    );
    await click('[data-testid=stop-workflow]');
    const cancelState = await finished(cancelled, 'cancelled');
    resolvePending!(
      response({
        id: 'late_apply',
        name: 'apply_changes',
        args: {
          expectedRevision: 0,
          changes: [
            { operation: 'write', path: 'src/app.tsx', expectedHash: null, content: validSource },
          ],
        },
      }),
    );
    resolvePending = undefined;
    await delay(100);
    check(
      'late provider response after cancellation cannot save or build',
      sources.get(cancelled.id).revision === 0 && cancelState.run!.stages.length === 1,
    );
    fixtures.push({
      projectId: cancelled.id,
      request: cancelState.run!.request,
      status: 'cancelled',
    });
    const uncertain = create('原请求 · 已提交结果丢失');
    writeSource(uncertain, validSource);
    const originalRun = workflows.run.bind(workflows);
    workflows.run = async (input) => {
      await originalRun(input);
      throw new AppError('WORKFLOW_IO', '合成响应丢失；保留真实结果。');
    };
    await openPlan(uncertain);
    const uncertainCalls = fetches;
    await click('[data-testid=check-workflow]');
    await until('uncertain original request retained', () =>
      exec(
        '!!document.querySelector("[data-testid=workflow-pending]")&&!document.querySelector("[data-testid=reconcile-workflow]").disabled',
      ),
    );
    workflows.run = originalRun;
    await click('[data-testid=reconcile-workflow]');
    await until('original checked request clears pending', () =>
      exec('!document.querySelector("[data-testid=workflow-pending]")'),
    );
    check(
      'lost committed result is reconciled by read-only original ID without model calls',
      fetches === uncertainCalls && (await state(uncertain.id)).run?.status === 'ready',
    );
    const unsent = create('原请求 · 未到主进程');
    workflows.run = async () => {
      throw new AppError('WORKFLOW_IO', '合成未收到请求。');
    };
    await openPlan(unsent);
    await click('[data-testid=start-workflow]');
    await until('unsent request retained', () =>
      exec(
        '!!document.querySelector("[data-testid=workflow-pending]")&&!document.querySelector("[data-testid=reconcile-workflow]").disabled',
      ),
    );
    workflows.run = originalRun;
    const unsentCalls = fetches;
    await click('[data-testid=reconcile-workflow]');
    await until('missing original record shown', () =>
      exec(
        'document.querySelector("[data-testid=workflow-action-error]")?.textContent.includes("尚未找到原请求记录")',
      ),
    );
    check(
      'read-only reconciliation of an unreceived request creates no journal or paid call',
      (await state(unsent.id)).run === null && fetches === unsentCalls,
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
    for (const method of ['workflowState', 'runWorkflow']) {
      const result = (await stranger.webContents.executeJavaScript(
        `window.factory[${JSON.stringify(method)}](${JSON.stringify({ projectId: compiled.id })})`,
      )) as ApiResult<unknown>;
      check(
        `untrusted renderer cannot invoke ${method}`,
        !result.ok && result.error.code === 'FORBIDDEN',
      );
    }
    stranger.destroy();
    const injected = await raw('runWorkflow', {
      ...request(compiled, 'check'),
      path: '/tmp/arbitrary-source',
    });
    check(
      'renderer cannot inject workflow storage paths',
      !injected.ok && injected.error.code === 'INVALID_INPUT',
    );
    const missing = await state(compiled.id, randomUUID());
    check(
      'explicit unknown workflow lookup is nonmutating and returns no run',
      missing.run === null && fetches === unsentCalls,
    );
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('homepage', () => exec('!!document.querySelector("[data-testid=idea-home]")'));
    await capture('homepage-1440.png', 1440, 1000, '[data-testid=idea-home]');
    await capture('homepage-1024.png', 1024, 720, '[data-testid=idea-home]');
    const interrupted = create('重开不自动续跑');
    writeSource(interrupted, validSource);
    scenario = 'pending';
    await openPlan(interrupted);
    await click('[data-testid=start-workflow]');
    await until(
      'final process has a real running parent and model call',
      async () => !!resolvePending && (await state(interrupted.id)).run?.status === 'running',
    );
    const interruptedRequest = (await state(interrupted.id)).run!.request;
    check(
      'durable parent and child stage are written before unfinished model response',
      (await state(interrupted.id)).run!.stages[0]?.status === 'running',
    );
    saved = {
      fixtures,
      readyId: compiled.id,
      interruptedId: interrupted.id,
      interruptedRequest,
      businessHash,
      providerHash: hash(readFileSync(providerPath)),
      usageCalls: models.usage().calls,
    };
    writeFileSync(join(output, 'fixture.json'), JSON.stringify(saved, null, 2));
  } else {
    saved = JSON.parse(readFileSync(join(output, 'fixture.json'), 'utf8')) as Saved;
    check(
      'fresh Electron process has no automatic paid requests',
      fetches === 0 && models.usage().calls === saved.usageCalls,
    );
    for (const fixture of saved.fixtures) {
      const result = await state(fixture.projectId, fixture.request.requestId);
      check(
        `saved ${fixture.status} workflow ${fixture.request.requestId} is readable without resuming`,
        result.run?.status === fixture.status,
      );
      const replay = await invoke<WorkflowState>('runWorkflow', fixture.request);
      check(
        `saved ${fixture.status} request replay stays read-only after restart`,
        replay.run?.status === fixture.status && fetches === 0,
      );
    }
    const interrupted = await state(saved.interruptedId);
    check(
      'unfinished real workflow becomes interrupted on process reopen',
      interrupted.run?.status === 'interrupted' &&
        interrupted.run.stages.at(-1)?.status === 'interrupted',
    );
    await openPlan(store.get(saved.interruptedId));
    check(
      'interrupted UI explicitly explains no automatic continuation and offers existing source check',
      await exec(
        'document.querySelector("[data-testid=workflow-state]").textContent.includes("重开没有自动续跑")&&!document.querySelector("[data-testid=check-workflow]").disabled',
      ),
    );
    await capture('workflow-interrupted-1440.png', 1440, 1000);
    await capture('workflow-interrupted-1024.png', 1024, 800);
    const original = await invoke<WorkflowState>('runWorkflow', saved.interruptedRequest);
    check(
      'interrupted original request only reconciles and never starts another model turn',
      original.run?.status === 'interrupted' && fetches === 0,
    );
    const before = models.usage().calls;
    const resumed = await start(store.get(saved.interruptedId), 'check', 'ready');
    check(
      'explicit fresh check after restart validates existing source without model call',
      resumed.run!.request.requestId !== saved.interruptedRequest.requestId &&
        resumed.run!.status === 'ready' &&
        models.usage().calls === before &&
        fetches === 0,
    );
    check(
      'reopen and all checks preserve business data and provider settings',
      hash(readFileSync(businessPath(saved.readyId))) === saved.businessHash &&
        hash(readFileSync(providerPath)) === saved.providerHash,
    );
    check(
      'restart preserves the charged uncertain-call ledger without additional calls',
      models.usage().calls === saved.usageCalls,
    );
  }
  writeFileSync(
    join(output, `workflow-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        syntheticModelRequests: fetches,
        versions: process.versions,
        limitations: [
          'Real Electron UI/IPC, actual controlled compiler and isolated runtime observations; model responses and all data/credentials are synthetic.',
          'Create phase exits the real process with an unfinished model response and durable workflow intent; reopen is a separate process with zero model requests.',
          'Test injects pre-dispatch and post-commit response failures for read-only original-request reconciliation; no real paid provider, business acceptance, Windows or installed-package UI validation.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Workflow ${phase}: ${checks.length} checks passed`);
  if (phase === 'reopen') await previews.stopAll();
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
