import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import type {
  ApiResult,
  AppSnapshot,
  DesignContent,
  Project,
  RequirementContent,
} from '../src/shared/contracts';
import type { BuildRequest, BuildState } from '../src/shared/build-contracts';
import type { RepairState, RepairStatus } from '../src/shared/repair-contracts';
import type { SourceToolResponse } from '../src/shared/source-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const messages: string[] = [];
const check = (label: string, value: unknown) => {
  assert.ok(value, label);
  checks.push(label);
};
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const syntheticKey = 'repair-smoke-synthetic-key-no-account';
const baseline = `import { useState } from 'react';
import './style.css';
const initialCount = 0;
export default function App() {
 const [count, setCount] = useState(initialCount);
 return <main><p>合成修复测试</p><h1>修复后的计数器</h1><output data-testid="counter">{count}</output>
 <div><button data-testid="minus" onClick={()=>setCount(count-1)}>减一</button>
 <button data-testid="reset" onClick={()=>setCount(0)}>归零</button>
 <button data-testid="plus" onClick={()=>setCount(count+1)}>加一</button></div>
 <small>构建通过后，仍需检查页面功能。</small></main>;
}`;
const missingImport = baseline.replace(
  'const initialCount = 0;',
  "import { initialCount } from './initial-count';",
);
const malformed = 'export default function App() { return <main>broken; }';
const styles =
  ':root{font-family:system-ui;color:#28352e;background:#faf9f5}main{max-width:520px;margin:12vh auto;text-align:center;padding:30px}p,small{color:#70776f}h1{font-size:32px}output{display:block;font-size:104px;margin:36px}button{padding:12px 25px;margin:6px;background:white;color:#284e43;border:1px solid #ccd2cc;border-radius:8px;font-size:16px}small{display:block;margin-top:28px}';
const requirement: RequirementContent = {
  summary: '制作加一、减一、归零的单页计数器。',
  audience: '本地体验者',
  features: ['改变数字', '一键归零'],
  pages: ['计数器'],
  data: ['当前窗口临时数字'],
  outOfScope: ['外网', '登录', '持久化'],
  questions: [],
  acceptance: ['三个按钮正确更新数字'],
};
const design: DesignContent = {
  direction: '浅色，中央数字和三个按钮。',
  palette: ['#284E43', '#FAF9F5'],
  pages: [{ name: '计数器', sections: ['标题', '数字', '操作按钮'] }],
  notes: ['模拟供应商，真实编译与交互。'],
};
type Scenario = 'fix' | 'limited' | 'pending';
type Tool = { id: string; name: string; args: unknown };
type Fixture = {
  projectId: string;
  name: string;
  expectedStatus: RepairStatus;
  request?: BuildRequest;
};
type SavedReport = {
  fixtures: Fixture[];
  hashes: Record<string, string>;
  calls: number;
  unknownUsageCalls: number;
  successfulBuildId: string;
  checks: string[];
};
const response = (calls: Tool[]) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    }),
    { status: 200 },
  );
async function waitFor(label: string, condition: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  do {
    if (await condition()) return;
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event) => {
    if (event.level === 'error') messages.push(event.message);
  });
});

async function run() {
  assert.ok(['create', 'reopen'].includes(phase));
  let fetches = 0;
  let scenario: Scenario = 'fix';
  let scenarioTurn = 0;
  let pending: ((value: Response) => void) | undefined;
  const modelRequest: typeof fetch = async (_url, options) => {
    fetches++;
    if (phase === 'reopen') throw new Error('Reopen must not invoke a model');
    scenarioTurn++;
    const payload = JSON.parse(String(options?.body)) as {
      stream: boolean;
      thinking?: { type: string };
      tools: unknown[];
      messages: { role: string; content: string; tool_call_id?: string }[];
    };
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      `Bearer ${syntheticKey}`,
    );
    check(
      `mock repair call ${fetches} uses bounded nonthinking tool transport`,
      payload.stream === false &&
        payload.thinking?.type === 'disabled' &&
        payload.tools.length === 3,
    );
    check(
      `mock repair call ${fetches} receives no key or host data path`,
      !JSON.stringify(payload).includes(syntheticKey) &&
        !JSON.stringify(payload).includes(process.env.FACTORY_TEST_DATA!),
    );
    if (scenario === 'pending')
      return new Promise<Response>((done) => {
        pending = done;
      });
    if (scenario === 'limited')
      return response(
        [0, 1, 2].map((index) => ({
          id: `limited_${scenarioTurn}_${index}`,
          name: index === 0 ? 'list_files' : 'read_file',
          args: index === 0 ? {} : { path: 'src/app.tsx' },
        })),
      );
    if (scenarioTurn === 1) {
      check(
        'first repair request includes an actual compiler diagnostic',
        payload.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content.includes('diagnostics') &&
            message.content.includes('src/app.tsx'),
        ),
      );
      return response([{ id: 'repair_read', name: 'read_file', args: { path: 'src/app.tsx' } }]);
    }
    assert.equal(scenarioTurn, 2);
    const readMessage = payload.messages.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'repair_read',
    );
    const readResult = JSON.parse(readMessage!.content) as SourceToolResponse;
    assert.ok(readResult.ok && readResult.data.tool === 'read_file');
    check(
      'second repair request receives the real failed source and source revision',
      readResult.data.file.content === missingImport && readResult.data.revision > 0,
    );
    return response([
      {
        id: 'repair_apply',
        name: 'apply_changes',
        args: {
          expectedRevision: readResult.data.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/initial-count.ts',
              expectedHash: null,
              content: 'export const initialCount = 0;\n',
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
  const { window, store, models, plans, sources, sourceTools, previews, builds } = desktop;
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
  const snapshot = await invoke<AppSnapshot>('snapshot');
  check(
    'repair renderer exposes only narrow IPC without host Node',
    await exec(
      "typeof window.factory.repairSource==='function' && typeof window.factory.repairState==='function' && typeof require==='undefined' && typeof process==='undefined'",
    ),
  );
  check('test Electron PATH excludes developer Node/npm', process.env.PATH === '/usr/bin:/bin');
  const configure = (maxCalls: number) =>
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: syntheticKey,
      maxCalls,
    });
  const pathFor = (projectId: string, relative: string) =>
    join(store.rootPath, 'projects', projectId, relative);
  const sourceBytes = (projectId: string) =>
    readFileSync(pathFor(projectId, 'source/workspace.json'));
  const buildBytes = (projectId: string) => readFileSync(pathFor(projectId, 'runs/builds.json'));
  const request = (project: Project): BuildRequest => ({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    planRunId: plans.get(project.id).run!.id,
    sourceRevision: sources.get(project.id).revision,
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
  const inject = (project: Project, content: string, initial = false) => {
    const prior = sources.get(project.id);
    const result = sourceTools.execute(
      { projectId: project.id, planRunId: plans.get(project.id).run!.id },
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'apply_changes',
        arguments: {
          expectedRevision: prior.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash: prior.files.find((file) => file.path === 'src/app.tsx')?.sha256 ?? null,
              content,
            },
            ...(initial
              ? [{ operation: 'write', path: 'src/style.css', expectedHash: null, content: styles }]
              : []),
          ],
        },
      },
    );
    assert.ok(result.ok);
  };
  const openPlan = async (project: Project) => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await waitFor('project navigation', () =>
      exec(
        `Array.from(document.querySelectorAll('.project-item')).some(item=>item.textContent.includes(${JSON.stringify(project.name)}))`,
      ),
    );
    await exec(
      `Array.from(document.querySelectorAll('.project-item')).find(item=>item.textContent.includes(${JSON.stringify(project.name)})).click();true`,
    );
    await waitFor('plan tab', () =>
      exec(
        "Array.from(document.querySelectorAll('[role=tab]')).some(item=>item.textContent.includes('开发计划'))",
      ),
    );
    await exec(
      "Array.from(document.querySelectorAll('[role=tab]')).find(item=>item.textContent.includes('开发计划')).click();true",
    );
    await waitFor('build state', () =>
      exec(
        '!!document.querySelector("[data-testid=build-state]") && document.querySelector("[data-testid=build-state]").dataset.status !== "loading"',
      ),
    );
  };
  const clickBuild = async (project: Project) => {
    await openPlan(project);
    await waitFor('enabled build button', () =>
      exec('!document.querySelector("[data-testid=build-source]").disabled'),
    );
    await exec('document.querySelector("[data-testid=build-source]").click();true');
  };
  const failBuild = async (project: Project) => {
    await clickBuild(project);
    await waitFor('actual failed build diagnostic', () =>
      exec('!!document.querySelector("[data-testid=build-diagnostics]")'),
    );
    await waitFor('enabled repair button', () =>
      exec(
        '!!document.querySelector("[data-testid=repair-source]") && !document.querySelector("[data-testid=repair-source]").disabled',
      ),
    );
  };
  const previewReady = async (project: Project) => {
    await waitFor('counter React render', async () => {
      const preview = previews.previewWindow(project.id);
      return (
        !!preview &&
        (await preview.webContents.executeJavaScript(
          '!!document.querySelector("[data-testid=counter]")',
        ))
      );
    });
    const preview = previews.previewWindow(project.id)!;
    preview.webContents.setBackgroundThrottling(false);
    return preview;
  };
  const repairState = (project: Project) =>
    invoke<RepairState>('repairState', { projectId: project.id });
  const waitRepair = async (project: Project, status: RepairStatus) => {
    await waitFor(
      `repair ${status}`,
      async () => (await repairState(project)).run?.status === status,
    );
    await waitFor('global repair activity cleared', () =>
      exec('!document.querySelector(".activity-bar")'),
    );
    return repairState(project);
  };
  const capture = async (name: string, target = window) => {
    await delay(180);
    writeFileSync(join(output, name), (await target.webContents.capturePage()).toPNG());
  };
  const fixtures: Fixture[] = [];
  let successfulBuildId = '';
  if (phase === 'create') {
    check(
      'synthetic test begins with no user projects or key',
      snapshot.projects.length === 0 && !snapshot.settings.hasKey && snapshot.usage.calls === 0,
    );
    configure(20);
    const success = create('修复成功 · 缺少模块');
    fixtures.push({ projectId: success.id, name: success.name, expectedStatus: 'succeeded' });
    inject(success, baseline, true);
    await clickBuild(success);
    const oldWindow = await previewReady(success);
    await oldWindow.webContents.executeJavaScript(
      "document.querySelector('[data-testid=plus]').click();true",
    );
    await waitFor('original preview counter', () =>
      oldWindow.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent==='1'",
      ),
    );
    const oldBuild = builds.state(success.id).artifact!.id;
    inject(success, missingImport);
    await failBuild(success);
    await exec('document.querySelector("[data-testid=repair-source]").click();true');
    const fixed = (await waitRepair(success, 'succeeded')).run!;
    check(
      'read/apply model tools repair a real missing import and native compilation succeeds',
      fetches === 2 &&
        fixed.rounds === 2 &&
        fixed.toolCalls === 2 &&
        fixed.builds >= 2 &&
        !!fixed.buildId &&
        fixed.buildId !== oldBuild &&
        sources.get(success.id).files.some((file) => file.path === 'src/initial-count.ts'),
    );
    successfulBuildId = fixed.buildId!;
    check(
      'successful repair preserves existing preview until user explicitly opens it',
      previews.previewWindow(success.id) === oldWindow &&
        !oldWindow.isDestroyed() &&
        (await oldWindow.webContents.executeJavaScript(
          "document.querySelector('[data-testid=counter]').textContent==='1'",
        )),
    );
    await waitFor('parent source revision refreshed after repair', () =>
      exec(
        `document.querySelector('[data-testid=source-files]')?.textContent.includes('版本 ${fixed.latestRevision}')===true`,
      ),
    );
    check(
      'successful repair labels rounds and offers the latest preview while the old one remains open',
      await exec(
        "document.querySelector('[data-testid=repair-state]')?.textContent.includes('修复轮次 2/4') && Array.from(document.querySelectorAll('[data-testid=build-state] .build-actions button')).some(button=>button.textContent.includes('打开最新预览'))",
      ),
    );
    for (const width of [1440, 1024]) {
      window.setContentSize(width, 900);
      await exec(
        'document.querySelector("[data-testid=repair-state]").scrollIntoView({block:"center"});true',
      );
      await capture(`repair-success-${width}.png`);
      check(
        `repair status has no horizontal overflow at ${width}px`,
        await exec('document.documentElement.scrollWidth <= innerWidth'),
      );
    }
    await exec(
      "Array.from(document.querySelectorAll('[data-testid=build-state] .build-actions button')).find(button=>button.textContent.includes('预览')&&!button.textContent.includes('关闭')).click();true",
    );
    await waitFor(
      'manual open replaces previous preview',
      async () =>
        previews.previewWindow(success.id) !== oldWindow && !!previews.previewWindow(success.id),
    );
    const repairedWindow = await previewReady(success);
    check(
      'manual preview opens the exact repaired artifact',
      oldWindow.isDestroyed() && previews.status(success.id).previewBuildId === fixed.buildId,
    );
    for (const [button, value] of [
      ['plus', '1'],
      ['plus', '2'],
      ['minus', '1'],
      ['reset', '0'],
    ]) {
      await repairedWindow.webContents.executeJavaScript(
        `document.querySelector('[data-testid=${button}]').click();true`,
      );
      await waitFor(`repaired counter ${button}`, () =>
        repairedWindow.webContents.executeJavaScript(
          `document.querySelector('[data-testid=counter]').textContent==='${value}'`,
        ),
      );
      check(`repaired compiled counter ${button} displays ${value}`, true);
    }
    await capture('repaired-counter.png', repairedWindow);
    const sameRequest: BuildRequest = {
      schemaVersion: 1,
      requestId: fixed.id,
      projectId: success.id,
      planRunId: fixed.planRunId,
      sourceRevision: fixed.initialRevision,
    };
    const replay = await invoke<RepairState>('repairSource', sameRequest);
    check(
      'identical repair request returns persisted result without another model call',
      replay.run?.id === fixed.id && replay.run.status === 'succeeded' && fetches === 2,
    );

    const limited = create('修复上限 · 保留旧成果');
    fixtures.push({ projectId: limited.id, name: limited.name, expectedStatus: 'limited' });
    inject(limited, baseline, true);
    await clickBuild(limited);
    const retainedWindow = await previewReady(limited);
    const retainedBuildBytes = buildBytes(limited.id);
    inject(limited, malformed);
    const unrepairedSource = sourceBytes(limited.id);
    await failBuild(limited);
    scenario = 'limited';
    scenarioTurn = 0;
    await exec('document.querySelector("[data-testid=repair-source]").click();true');
    const stopped = (await waitRepair(limited, 'limited')).run!;
    check(
      'unrepaired syntax error stops at four model rounds and twelve tools',
      scenarioTurn === 4 &&
        stopped.rounds === 4 &&
        stopped.toolCalls === 12 &&
        !!stopped.errorCode &&
        stopped.diagnostics.length > 0,
    );
    check(
      'repair limit preserves exact old build and failed source bytes and live preview',
      buildBytes(limited.id).equals(retainedBuildBytes) &&
        sourceBytes(limited.id).equals(unrepairedSource) &&
        previews.previewWindow(limited.id) === retainedWindow &&
        !retainedWindow.isDestroyed(),
    );
    await retainedWindow.webContents.executeJavaScript(
      "document.querySelector('[data-testid=plus]').click();true",
    );
    await waitFor('retained preview still interactive after limit', () =>
      retainedWindow.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent==='1'",
      ),
    );
    check('old successful preview remains interactive after failed repair', true);
    await exec(
      'document.querySelector("[data-testid=repair-state]").scrollIntoView({block:"center"});true',
    );
    await capture('repair-limited.png');

    const cancelled = create('修复取消 · 迟到响应');
    fixtures.push({ projectId: cancelled.id, name: cancelled.name, expectedStatus: 'cancelled' });
    inject(cancelled, malformed, true);
    await failBuild(cancelled);
    scenario = 'pending';
    scenarioTurn = 0;
    pending = undefined;
    const beforeCancel = sourceBytes(cancelled.id);
    await exec('document.querySelector("[data-testid=repair-source]").click();true');
    await waitFor('pending mock repair request', async () => !!pending);
    for (const [method, input] of [
      ['renameProject', { projectId: cancelled.id, name: 'must not rename' }],
      ['archiveProject', { projectId: cancelled.id, archived: true }],
      ['buildSource', request(success)],
      ['repairSource', request(success)],
      [
        'generateSource',
        {
          schemaVersion: 1,
          requestId: randomUUID(),
          projectId: success.id,
          planRunId: plans.get(success.id).run!.id,
        },
      ],
    ] as const) {
      const denied = await raw(method, input);
      check(
        `${method} is blocked by global mutation guard during repair`,
        !denied.ok && denied.error.code === 'BUSY',
      );
    }
    await exec(
      `Array.from(document.querySelectorAll('.project-item')).find(button=>button.textContent.includes(${JSON.stringify(success.name)})).click();true`,
    );
    await waitFor('global stop after project switch', () =>
      exec('!!document.querySelector(".activity-bar button")'),
    );
    await exec('document.querySelector(".activity-bar button").click();true');
    await waitRepair(cancelled, 'cancelled');
    const callsAfterCancel = fetches;
    pending!(
      response([
        {
          id: 'late_apply',
          name: 'apply_changes',
          args: {
            expectedRevision: sources.get(cancelled.id).revision,
            changes: [
              {
                operation: 'write',
                path: 'src/late.ts',
                expectedHash: null,
                content: 'export const late = true;',
              },
            ],
          },
        },
      ]),
    );
    await delay(120);
    check(
      'late model response after UI cancellation cannot write source or create a build',
      sourceBytes(cancelled.id).equals(beforeCancel) &&
        builds.state(cancelled.id).artifact === null &&
        fetches === callsAfterCancel,
    );
    check(
      'cancelled mock request remains counted with unknown usage',
      models.usage().calls === fetches && models.usage().unknownUsageCalls === 1,
    );

    const budget = create('预算上限 · 不发送请求');
    fixtures.push({ projectId: budget.id, name: budget.name, expectedStatus: 'limited' });
    inject(budget, malformed, true);
    await failBuild(budget);
    configure(models.usage().calls);
    const beforeBudget = fetches;
    await exec('document.querySelector("[data-testid=repair-source]").click();true');
    const budgetRun = (await waitRepair(budget, 'limited')).run!;
    check(
      'exhausted saved budget stops repair before provider dispatch',
      budgetRun.errorCode === 'BUDGET_EXCEEDED' &&
        fetches === beforeBudget &&
        sources.get(budget.id).revision === 1 &&
        (await exec(
          "document.querySelector('[data-testid=repair-state]')?.textContent.includes('修复轮次 1/4') && !document.querySelector('[data-testid=repair-state]').textContent.includes('模型请求')",
        )),
    );
    await exec(
      'document.querySelector("[data-testid=repair-state]").scrollIntoView({block:"center"});true',
    );
    await capture('repair-budget-blocked.png');
    configure(20);

    const interrupted = create('中断恢复 · 不自动付费');
    fixtures.push({
      projectId: interrupted.id,
      name: interrupted.name,
      expectedStatus: 'interrupted',
    });
    inject(interrupted, malformed, true);
    await failBuild(interrupted);
    scenario = 'pending';
    scenarioTurn = 0;
    pending = undefined;
    await exec('document.querySelector("[data-testid=repair-source]").click();true');
    await waitFor(
      'durable running request before process exit',
      async () => !!pending && (await repairState(interrupted)).run?.status === 'running',
    );
    const active = (await repairState(interrupted)).run!;
    fixtures.at(-1)!.request = {
      schemaVersion: 1,
      requestId: active.id,
      projectId: interrupted.id,
      planRunId: active.planRunId,
      sourceRevision: active.initialRevision,
    };
    check(
      'repair intent is persisted before deliberately exiting with a pending model request',
      JSON.parse(readFileSync(pathFor(interrupted.id, 'runs/repairs.json'), 'utf8')).runs.at(-1)
        .status === 'running',
    );
  } else {
    const prior = JSON.parse(
      readFileSync(join(output, 'repair-create.json'), 'utf8'),
    ) as SavedReport;
    fixtures.push(...prior.fixtures);
    successfulBuildId = prior.successfulBuildId;
    check(
      'all repair fixture projects and usage survive separate process launch',
      snapshot.projects.length === fixtures.length &&
        snapshot.usage.calls === prior.calls &&
        snapshot.usage.unknownUsageCalls === prior.unknownUsageCalls,
    );
    for (const [relative, expected] of Object.entries(prior.hashes))
      check(
        `${relative} bytes preserved across process exit`,
        hash(readFileSync(join(store.rootPath, relative))) === expected,
      );
    for (const fixture of fixtures) {
      const project = store.get(fixture.projectId);
      const state = await repairState(project);
      check(
        `${fixture.name} restores ${fixture.expectedStatus} without automatic dispatch`,
        state.run?.status === fixture.expectedStatus && fetches === 0,
      );
      await openPlan(project);
      await waitFor('restored repair UI', () =>
        exec('!!document.querySelector("[data-testid=repair-state]")'),
      );
      check(
        `${fixture.name} has no automatically reopened preview`,
        previews.status(project.id).preview === 'closed',
      );
      if (fixture.request) {
        const repeated = await invoke<RepairState>('repairSource', fixture.request);
        check(
          'same interrupted request does not resume or issue a new paid request',
          repeated.run?.status === 'interrupted' &&
            fetches === 0 &&
            models.usage().calls === prior.calls,
        );
        await exec(
          'document.querySelector("[data-testid=repair-state]").scrollIntoView({block:"center"});true',
        );
        await capture('repair-reopen-interrupted.png');
      }
    }
    const success = store.get(
      fixtures.find((item) => item.expectedStatus === 'succeeded')!.projectId,
    );
    await openPlan(success);
    await exec(
      "Array.from(document.querySelectorAll('[data-testid=build-state] .build-actions button')).find(button=>button.textContent.includes('打开预览')).click();true",
    );
    const restoredPreview = await previewReady(success);
    check(
      'manually reopened repaired artifact retains the exact build identity',
      previews.status(success.id).previewBuildId === successfulBuildId,
    );
    await restoredPreview.webContents.executeJavaScript(
      "document.querySelector('[data-testid=plus]').click();true",
    );
    await waitFor('reopened repaired counter interaction', () =>
      restoredPreview.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent==='1'",
      ),
    );
    check('repaired artifact remains interactive after full process restart', true);
    await capture('repair-reopen-preview.png', restoredPreview);
    check(
      'reopen and replay keep provider calls at zero and persisted usage unchanged',
      fetches === 0 && models.usage().calls === prior.calls,
    );
  }
  const hashes: Record<string, string> = {};
  for (const fixture of fixtures) {
    const plan = plans.get(fixture.projectId).run!;
    check(
      `${fixture.name} does not falsely mark business acceptance complete`,
      plan.plan.tasks.every(
        (item) => item.implementation === 'pending' && item.verification === 'not_run',
      ) && store.get(fixture.projectId).stage === 'ready',
    );
    for (const relative of [
      'project.json',
      'source/workspace.json',
      'runs/development-plans.json',
      'runs/builds.json',
      'runs/repairs.json',
    ]) {
      const file = pathFor(fixture.projectId, relative);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      check(
        `${fixture.name}/${relative} contains no synthetic API Key`,
        !bytes.includes(Buffer.from(syntheticKey)),
      );
      hashes[`projects/${fixture.projectId}/${relative}`] = hash(bytes);
    }
  }
  await previews.stopAll();
  const report = {
    phase,
    passed: checks.length,
    checks,
    fixtures,
    hashes,
    successfulBuildId,
    calls: models.usage().calls,
    unknownUsageCalls: models.usage().unknownUsageCalls,
    mockedProviderRequests: fetches,
    realProviderRequests: 0,
    versions: process.versions,
    systemPath: process.env.PATH,
    limitations: [
      'Synthetic scripted provider replies through real ModelService; not real DeepSeek',
      'Actual native compiler and Electron UI/counter interaction',
      'The deliberately uncorrected error uses read-only model replies to exercise round/tool ceilings',
      'Final create phase deliberately exits with a pending mocked request; reopen does not auto-resume',
      'No Windows, clean-OS, arbitrary business application or full task recovery acceptance',
    ],
  };
  writeFileSync(join(output, `repair-${phase}.json`), JSON.stringify(report, null, 2));
  console.log(`Repair ${phase}: ${checks.length} checks passed`);
  app.exit(0);
}
mkdirSync(output, { recursive: true });
run().catch(async (error) => {
  console.error(String(error));
  const windows = await Promise.all(
    BrowserWindow.getAllWindows().map(async (window) => ({
      title: window.getTitle(),
      body: await window.webContents
        .executeJavaScript('document.body.innerText')
        .catch(() => 'unavailable'),
    })),
  );
  writeFileSync(
    join(output, `repair-${phase}-failure.json`),
    JSON.stringify({ error: String(error), checks, messages, windows }, null, 2),
  );
  app.exit(1);
});
