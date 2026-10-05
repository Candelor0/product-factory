import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import type {
  ApiResult,
  AppSnapshot,
  DesignContent,
  Project,
  RequirementContent,
} from '../src/shared/contracts';
import type { CodingState } from '../src/shared/coding-contracts';
import type { PlanState } from '../src/shared/plan-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (description: string, condition: unknown) => {
  assert.ok(condition, description);
  checks.push(description);
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const syntheticKey = 'coding-electron-synthetic-key-no-account';
const appSource = `export default function App() { return '<img src=x onerror="window.__codingExecuted=true">'; }\n(window as any).__codingExecuted = true;\n`;
const styleSource = 'body { color: #24272b; background: #ffffff; }\n';
const requirement: RequirementContent = {
  summary: '合成博客：阅读笔记在本地保存。',
  audience: '我与朋友',
  features: ['创建和编辑文章'],
  pages: ['文章列表'],
  data: ['文章标题与正文'],
  outOfScope: ['公网发布'],
  questions: [],
  acceptance: ['保存后重开仍能查看文章'],
};
const design: DesignContent = {
  direction: '浅色阅读界面，清晰的文字层级。',
  palette: ['#24272B', '#FFFFFF'],
  pages: [{ name: '文章列表', sections: ['标题', '文章列表'] }],
  notes: ['合成测试，未调用在线模型。'],
};
const toolResponse = (id: string, name: string, args: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );
const stopResponse = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: 'assistant', content: '源码草稿已保存；尚未构建或运行。' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );

async function run() {
  if (!['create', 'reopen'].includes(phase)) throw new Error('Invalid coding test phase');
  let fetches = 0;
  let mode: 'complete' | 'pending' = 'complete';
  let resolvePending: ((value: Response) => void) | undefined;
  const modelRequest: typeof fetch = async (_url, options) => {
    fetches++;
    if (phase === 'reopen') throw new Error('Reopening must not dispatch model calls');
    const payload = JSON.parse(String(options?.body));
    check(
      `model turn ${fetches} uses tools without JSON response_format`,
      payload.stream === false &&
        payload.max_tokens === 4096 &&
        !Object.hasOwn(payload, 'response_format') &&
        payload.thinking?.type === 'disabled' &&
        payload.tools?.length === 3,
    );
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      `Bearer ${syntheticKey}`,
    );
    assert.equal(JSON.stringify(payload).includes(syntheticKey), false);
    if (mode === 'pending')
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    if (fetches === 1) return toolResponse('coding_list', 'list_files', {});
    if (fetches === 2) {
      const result = payload.messages.at(-1);
      check(
        'actual second model turn receives list_files result with original call ID',
        result.role === 'tool' &&
          result.tool_call_id === 'coding_list' &&
          JSON.parse(result.content).data.revision === 0,
      );
      return toolResponse('coding_apply', 'apply_changes', {
        expectedRevision: 0,
        changes: [
          { operation: 'write', path: 'src/app.tsx', expectedHash: null, content: appSource },
          { operation: 'write', path: 'src/style.css', expectedHash: null, content: styleSource },
        ],
      });
    }
    if (fetches === 3) {
      const result = payload.messages.at(-1);
      check(
        'actual third model turn receives the atomic apply receipt',
        result.role === 'tool' &&
          result.tool_call_id === 'coding_apply' &&
          JSON.parse(result.content).data.revision === 1,
      );
      return stopResponse();
    }
    throw new Error('Unexpected mock model turn');
  };
  const { window, store, models, sources } = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    show: false,
    modelRequest,
  });
  window.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(code: string) =>
    window.webContents.executeJavaScript(code) as Promise<T>;
  const raw = <T>(method: string, value?: unknown) =>
    exec<ApiResult<T>>(`window.factory[${JSON.stringify(method)}](${JSON.stringify(value)})`);
  const invoke = async <T>(method: string, value?: unknown): Promise<T> => {
    const result = await raw<T>(method, value);
    if (!result.ok) throw new Error(`${method}: ${result.error.code}`);
    return result.value;
  };
  const waitFor = async (label: string, condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    do {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
  };
  const capture = async (name: string) => {
    await exec('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 120));
    writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  const select = async (name: string) => {
    await exec(
      `Array.from(document.querySelectorAll('.project-item')).find(button=>button.textContent.includes(${JSON.stringify(name)})).click(); true`,
    );
    await waitFor('selected project', () =>
      exec(
        `document.querySelector('.project-item.selected')?.textContent.includes(${JSON.stringify(name)}) === true`,
      ),
    );
  };
  const openPlan = async () => {
    await exec(
      "Array.from(document.querySelectorAll('[role=tab]')).find(button=>button.textContent.includes('开发计划')).click(); true",
    );
    await waitFor('coding panel', () =>
      exec('!!document.querySelector("[data-testid=coding-state]")'),
    );
  };
  const selectSource = async () => {
    await exec('document.querySelector("[data-testid=source-files]").open = true; true');
    await exec(
      "Array.from(document.querySelectorAll('.coding-browser nav button')).find(button=>button.textContent==='src/app.tsx').click(); true",
    );
    await waitFor('source text viewer', () =>
      exec('!!document.querySelector("[data-testid=source-content]")'),
    );
  };
  const snapshot = await invoke<AppSnapshot>('snapshot');
  await waitFor('single input home', () =>
    exec('!!document.querySelector("[data-testid=idea-home]")'),
  );
  check(
    'homepage remains one idea input without coding controls or project cards',
    await exec(
      'document.querySelectorAll("[data-testid=idea-home] textarea").length === 1 && !document.querySelector("[data-testid=generate-source]") && !document.querySelector(".project-card")',
    ),
  );
  check(
    'renderer has narrow coding API and no host require/process',
    await exec(
      'typeof window.factory.generateSource === "function" && typeof window.factory.codingFile === "function" && typeof require === "undefined" && typeof process === "undefined"',
    ),
  );
  let project: Project;
  let other: Project;
  if (phase === 'create') {
    check(
      'test starts with no projects, credentials, or model usage',
      snapshot.projects.length === 0 && !snapshot.settings.hasKey && snapshot.usage.calls === 0,
    );
    project = store.create({ name: '源码生成实测 · 博客', idea: requirement.summary });
    project = store.saveRequirements(project.id, requirement);
    project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = store.saveDesign(project.id, design);
    project = store.approveDesign(project.id, project.designs.at(-1)!.id);
    other = store.create({ name: '切换目标 · 未生成', idea: '验证切换不会覆盖源码记录' });
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: syntheticKey,
      maxCalls: 10,
    });
    await window.loadFile(resolve('dist/renderer/index.html'));
    await waitFor('sidebar projects', () =>
      exec('document.querySelectorAll(".project-item").length === 2'),
    );
    await capture('coding-home-1440.png');
    await select(project.name);
    await openPlan();
    check(
      'source generation is disabled before a current plan exists',
      await exec('document.querySelector("[data-testid=generate-source]").disabled'),
    );
    await waitFor('create plan enabled', () =>
      exec('!document.querySelector("[data-testid=create-plan]").disabled'),
    );
    await exec('document.querySelector("[data-testid=create-plan]").click(); true');
    await waitFor('confirmed plan enables source generation', () =>
      exec('!document.querySelector("[data-testid=generate-source]").disabled'),
    );
    const plan = await invoke<PlanState>('planState', { projectId: project.id });
    check(
      'real plan button binds the confirmed requirement and page revisions',
      plan.status === 'current' &&
        plan.run?.request.requirementId === project.requirements[0].id &&
        plan.run.request.designId === project.designs[0].id,
    );
    await exec('document.querySelector("[data-testid=generate-source]").click(); true');
    await waitFor(
      'three-turn draft saved',
      async () =>
        (await invoke<CodingState>('codingState', { projectId: project.id })).run?.status ===
        'draft_saved',
    );
    await waitFor('saved source files render', () =>
      exec(
        '!!document.querySelector("[data-testid=source-files]") && !document.querySelector(".activity-bar")',
      ),
    );
    const state = await invoke<CodingState>('codingState', { projectId: project.id });
    check(
      'real ModelService completes list/apply/stop in three requests',
      fetches === 3 &&
        state.run?.rounds === 3 &&
        state.run.toolCalls === 2 &&
        state.revision === 1 &&
        state.files.length === 2,
    );
    check(
      'saved source matches both mock-generated text files atomically',
      sources.get(project.id).files[0].content === appSource &&
        sources.get(project.id).files[1].content === styleSource,
    );
    check(
      'source generation preserves confirmation stage and pending acceptance',
      store.get(project.id).stage === 'ready' &&
        plan.run!.plan.tasks.every(
          (task) => task.implementation === 'pending' && task.verification === 'not_run',
        ) &&
        state.execution === 'disabled',
    );
    const snap = await invoke<AppSnapshot>('snapshot');
    check(
      'model accounting persists known tokens without exposing the synthetic key to renderer',
      snap.usage.calls === 3 &&
        snap.usage.inputTokens === 30 &&
        snap.usage.outputTokens === 15 &&
        !JSON.stringify(snap).includes(syntheticKey),
    );
    await selectSource();
    check(
      'source viewer renders exact code as text without evaluating script or HTML',
      await exec(
        `document.querySelector('[data-testid=source-content]').textContent === ${JSON.stringify(appSource)} && !document.querySelector('[data-testid=source-content] img') && typeof window.__codingExecuted === 'undefined'`,
      ),
    );
    for (const width of [1440, 1024]) {
      window.setContentSize(width, 900);
      await capture(`coding-draft-${width}.png`);
      check(
        `source panel has no horizontal overflow at ${width}px`,
        await exec('document.documentElement.scrollWidth <= window.innerWidth'),
      );
    }
    const denied = await raw('codingFile', {
      projectId: project.id,
      path: '../../credentials/provider.json',
    });
    check(
      'coding file IPC rejects host path traversal',
      !denied.ok && denied.error.code === 'SOURCE_PATH_DENIED',
    );
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: resolve('dist/main/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    try {
      await foreign.loadFile(resolve('dist/renderer/index.html'));
      const result = (await foreign.webContents.executeJavaScript(
        `window.factory.codingState(${JSON.stringify({ projectId: project.id })})`,
      )) as ApiResult<unknown>;
      check(
        'foreign renderer cannot read the privileged coding state',
        !result.ok && result.error.code === 'FORBIDDEN',
      );
    } finally {
      foreign.destroy();
    }
    const beforeSource = readFileSync(
      join(store.rootPath, 'projects', project.id, 'source', 'workspace.json'),
    );
    mode = 'pending';
    await exec('document.querySelector("[data-testid=generate-source]").click(); true');
    await waitFor('pending model request', async () => !!resolvePending);
    for (const [method, value] of [
      ['renameProject', { projectId: project.id, name: 'must not rename' }],
      ['saveRequirements', { projectId: project.id, content: requirement }],
      ['archiveProject', { projectId: project.id, archived: true }],
      ['createProject', { name: 'must not create', idea: 'busy test' }],
      [
        'saveProvider',
        {
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          maxCalls: 10,
        },
      ],
    ] as const) {
      const result = await raw(method, value);
      check(
        `${method} is blocked by global mutation guard during a model request`,
        !result.ok && result.error.code === 'BUSY',
      );
    }
    await select(other.name);
    check(
      'project switching keeps a global stop control visible',
      await exec(
        '!!document.querySelector(".activity-bar button") && !document.querySelector("[data-testid=coding-state]")',
      ),
    );
    await exec('document.querySelector(".activity-bar button").click(); true');
    await waitFor(
      'cancelled source run',
      async () =>
        (await invoke<CodingState>('codingState', { projectId: project.id })).run?.status ===
        'cancelled',
    );
    await waitFor('global request cleared', () => exec('!document.querySelector(".activity-bar")'));
    resolvePending!(
      toolResponse('late_apply', 'apply_changes', {
        expectedRevision: 1,
        changes: [
          { operation: 'write', path: 'src/late.ts', expectedHash: null, content: 'must not save' },
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    check(
      'a late provider response after cancellation cannot mutate saved source or another project',
      beforeSource.equals(
        readFileSync(join(store.rootPath, 'projects', project.id, 'source', 'workspace.json')),
      ) &&
        sources.get(other.id).revision === 0 &&
        fetches === 4,
    );
    check(
      'cancelled request remains counted with unknown usage',
      models.usage().calls === 4 && models.usage().unknownUsageCalls === 1,
    );
    await select(project.name);
    await openPlan();
    await waitFor('cancelled status visible', () =>
      exec('document.querySelector("[data-testid=coding-state]").dataset.status === "cancelled"'),
    );
    check(
      'returning to the original project shows cancellation and retained source files',
      await exec(
        'document.querySelector("[data-testid=coding-state]").textContent.includes("已停止") && !!document.querySelector("[data-testid=source-files]")',
      ),
    );
    await selectSource();
    await capture('coding-cancelled-1024.png');
  } else {
    const prior = JSON.parse(readFileSync(join(output, 'coding-create.json'), 'utf8')) as {
      projectId: string;
      otherProjectId: string;
      hashes: Record<string, string>;
    };
    project = store.get(prior.projectId);
    other = store.get(prior.otherProjectId);
    check(
      'independent Electron process restores both projects and model usage',
      snapshot.projects.length === 2 &&
        snapshot.usage.calls === 4 &&
        snapshot.usage.unknownUsageCalls === 1,
    );
    for (const [relative, expected] of Object.entries(prior.hashes))
      check(
        `${relative} is byte-identical after process exit`,
        sha256(readFileSync(join(store.rootPath, 'projects', project.id, relative))) === expected,
      );
    await select(project.name);
    await openPlan();
    await waitFor('restored cancelled record', () =>
      exec('document.querySelector("[data-testid=coding-state]").dataset.status === "cancelled"'),
    );
    const state = await invoke<CodingState>('codingState', { projectId: project.id });
    check(
      'restored source revision and cancelled run do not masquerade as execution',
      state.revision === 1 &&
        state.files.length === 2 &&
        state.run?.status === 'cancelled' &&
        state.execution === 'disabled',
    );
    await selectSource();
    check(
      'restored source is exact text and still unexecuted',
      await exec(
        `document.querySelector('[data-testid=source-content]').textContent === ${JSON.stringify(appSource)} && typeof window.__codingExecuted === 'undefined'`,
      ),
    );
    const plan = await invoke<PlanState>('planState', { projectId: project.id });
    check(
      'restored plan checks remain explicitly unrun',
      plan.run!.plan.checks.every((item) => item.status === 'not_run') &&
        plan.run!.plan.tasks.every((item) => item.implementation === 'pending'),
    );
    for (const width of [1440, 1024]) {
      window.setContentSize(width, 900);
      await capture(`coding-reopen-${width}.png`);
      check(
        `reopened source layout has no horizontal overflow at ${width}px`,
        await exec('document.documentElement.scrollWidth <= window.innerWidth'),
      );
    }
    check(
      'reopening and file viewing never replays model requests',
      fetches === 0 && models.usage().calls === 4,
    );
  }
  const hashes = Object.fromEntries(
    [
      'project.json',
      'runs/development-plans.json',
      'runs/coding.json',
      'source/workspace.json',
    ].map((relative) => [
      relative,
      sha256(readFileSync(join(store.rootPath, 'projects', project.id, relative))),
    ]),
  );
  check(
    'source and run journal contain no synthetic API credential',
    ['runs/coding.json', 'source/workspace.json'].every(
      (relative) =>
        !readFileSync(join(store.rootPath, 'projects', project.id, relative), 'utf8').includes(
          syntheticKey,
        ),
    ),
  );
  const finalState = await invoke<CodingState>('codingState', { projectId: project.id });
  writeFileSync(
    join(output, `coding-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        projectId: project.id,
        otherProjectId: other.id,
        hashes,
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        mockFetches: fetches,
        realModelCalls: 0,
        usage: models.usage(),
        state: finalState,
        limitations: [
          'Mock fetch with synthetic key; no real provider call',
          'Generated source remains text; no build or execution',
          'No clean-OS, Windows or signed-package validation',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Coding ${phase}: ${checks.length} checks passed`);
  app.exit(0);
}
mkdirSync(output, { recursive: true });
run().catch((error) => {
  console.error(String(error));
  writeFileSync(
    join(output, `coding-${phase}-failure.txt`),
    `${String(error)}\nCompleted: ${checks.join('; ')}`,
  );
  app.exit(1);
});
