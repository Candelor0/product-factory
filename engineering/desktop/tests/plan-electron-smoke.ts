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
import type { PlanState } from '../src/shared/plan-contracts';
import type { WorkflowState } from '../src/shared/workflow-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (description: string, condition: unknown) => {
  assert.ok(condition, description);
  checks.push(description);
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const requirement: RequirementContent = {
  summary: '合成博客测试：整理阅读笔记，文章保存在本机。',
  audience: '博客作者本人',
  features: ['创建和编辑文章', '保存草稿并在本地发布', '按标签浏览文章'],
  pages: ['博客首页', '文章详情', '文章管理'],
  data: ['文章标题、正文、标签与发布状态'],
  outOfScope: ['公网发布', '登录与评论'],
  questions: ['是否需要文章封面？'],
  acceptance: ['保存草稿后重新打开仍能读取', '本地发布后能在首页看到文章'],
};
const design: DesignContent = {
  direction: '温暖纸感与墨绿色，留出舒适的阅读空间。',
  palette: ['#284E43', '#F6F4EE', '#C6AB7B'],
  pages: [
    { name: '博客首页', sections: ['作者介绍', '已发布文章', '标签导航'] },
    { name: '文章详情', sections: ['标题', '正文', '标签'] },
    { name: '文章管理', sections: ['文章列表', '草稿状态', '创建编辑入口'] },
  ],
  notes: ['合成数据，只用于开发计划集成验证，未调用在线模型。'],
};
const revised: RequirementContent = {
  ...requirement,
  summary: `${requirement.summary} 增加阅读摘录。`,
  features: [...requirement.features, '在文章中保存阅读摘录'],
  questions: ['摘录是否需要记录书名？'],
};

async function run() {
  if (!['create', 'reopen'].includes(phase)) throw new Error('Invalid test phase');
  let syntheticModelRequests = 0;
  const { window, store } = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    show: false,
    modelRequest: async (_url, options) => {
      syntheticModelRequests++;
      assert.equal(phase, 'create', 'reopening must not dispatch model requests');
      assert.equal(
        syntheticModelRequests,
        1,
        'only an explicit page-generation click calls the model',
      );
      const input = JSON.parse(String(options?.body));
      assert.ok(input.messages[0].content.includes('页面方案助手'));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: JSON.stringify(design) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
        { status: 200 },
      );
    },
  });
  window.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(code: string) =>
    window.webContents.executeJavaScript(code) as Promise<T>;
  const raw = <T>(method: string, payload?: unknown) =>
    exec<ApiResult<T>>(`window.factory[${JSON.stringify(method)}](${JSON.stringify(payload)})`);
  const invoke = async <T>(method: string, payload?: unknown): Promise<T> => {
    const result = await raw<T>(method, payload);
    if (!result.ok) throw new Error(`${method}: ${result.error.code} ${result.error.message}`);
    return result.value;
  };
  const waitFor = async (label: string, condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 8_000;
    do {
      if (await condition()) return;
      await new Promise((done) => setTimeout(done, 40));
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
  };
  const openTab = async (title: string) => {
    await exec(
      `Array.from(document.querySelectorAll('[role=tab]')).find(button=>button.textContent.includes(${JSON.stringify(title)})).click(); true`,
    );
  };
  const click = async (selector: string) => {
    await waitFor(`enabled ${selector}`, () =>
      exec(
        `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
      ),
    );
    await exec(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  };
  const openPlan = async () => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await waitFor('project navigation', () => exec('!!document.querySelector(".project-item")'));
    await exec('document.querySelector(".project-item").click(); true');
    await waitFor('plan tab', () =>
      exec(
        "Array.from(document.querySelectorAll('[role=tab]')).some(button=>button.textContent.includes('开发计划'))",
      ),
    );
    await exec(
      "Array.from(document.querySelectorAll('[role=tab]')).find(button=>button.textContent.includes('开发计划')).click(); true",
    );
    await waitFor('plan panel', () =>
      exec(
        '!!document.querySelector("[data-testid=plan-state]") && document.querySelector("[data-testid=plan-state]").dataset.status !== "loading"',
      ),
    );
  };
  const capture = async (name: string) => {
    await exec('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await new Promise((done) => setTimeout(done, 120));
    writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  const snapshot = await invoke<AppSnapshot>('snapshot');
  check(
    'real desktop renderer exposes only the narrow plan API',
    await exec(
      "typeof window.factory.createPlan === 'function' && typeof window.factory.planState === 'function' && typeof require === 'undefined' && typeof process === 'undefined'",
    ),
  );
  check(
    'isolated workspace has only the expected synthetic connection',
    snapshot.settings.hasKey === (phase === 'reopen'),
  );
  check(
    'entry never initiates model calls',
    snapshot.usage.calls === (phase === 'create' ? 0 : 1) && syntheticModelRequests === 0,
  );
  let project: Project;
  let state: PlanState;
  if (phase === 'create') {
    check('clean project list in isolated data directory', snapshot.projects.length === 0);
    project = store.create({ name: '开发计划实测 · 个人博客', idea: requirement.summary });
    project = store.saveRequirements(project.id, requirement);
    await invoke('saveProvider', {
      provider: 'custom',
      baseUrl: 'https://synthetic.invalid/v1',
      model: 'synthetic-design',
      apiKey: 'plan-smoke-synthetic-key-no-account',
      maxCalls: 10,
    });
    await openPlan();
    check(
      'unconfirmed requirements disable both planning and automatic development',
      await exec(
        'document.querySelector("[data-testid=create-plan]").disabled && document.querySelector("[data-testid=start-workflow]").disabled',
      ),
    );
    await openTab('需求');
    await click('[data-testid=approve-requirements]');
    await waitFor('requirement confirmation returns to explicit next step', () =>
      exec(
        '!!document.querySelector("[data-testid=requirements-design-next]") && !document.querySelector(".activity-bar")',
      ),
    );
    check(
      'confirming requirements does not generate a page or call the model',
      store.get(project.id).requirements[0].approvedAt &&
        store.get(project.id).designs.length === 0 &&
        syntheticModelRequests === 0,
    );
    await click('[data-testid=requirements-design-next]');
    await waitFor('explicit design generation button', () =>
      exec(
        '!!Array.from(document.querySelectorAll(".generation-composer button")).find(button=>button.textContent.includes("生成页面方向"))',
      ),
    );
    await exec(
      'Array.from(document.querySelectorAll(".generation-composer button")).find(button=>button.textContent.includes("生成页面方向")).click(); true',
    );
    await waitFor('synthetic page draft from actual UI and IPC', () =>
      exec(
        '!!document.querySelector("[data-testid=approve-design]") && !document.querySelector(".activity-bar")',
      ),
    );
    check(
      'explicit page generation saves an unconfirmed draft using one synthetic model request',
      syntheticModelRequests === 1 &&
        store.get(project.id).designs.length === 1 &&
        !store.get(project.id).designs[0].approvedAt,
    );
    await openTab('开发计划');
    await waitFor('unconfirmed design planning state', () =>
      exec(
        'document.querySelector("[data-testid=plan-state]")?.dataset.status !== "loading" && !!document.querySelector("[data-testid=start-workflow]")',
      ),
    );
    check(
      'a page draft still cannot start planning or development before approval',
      await exec(
        'document.querySelector("[data-testid=create-plan]").disabled && document.querySelector("[data-testid=start-workflow]").disabled',
      ),
    );
    await openTab('页面方向');
    await click('[data-testid=approve-design]');
    await waitFor('approved design next step', () =>
      exec(
        '!!document.querySelector("[data-testid=design-plan-next]") && !document.querySelector(".activity-bar")',
      ),
    );
    project = store.get(project.id);
    check(
      'actual UI approvals confirm the synthetic requirements and page direction',
      project.stage === 'ready',
    );
    check(
      'confirmation notice points to current automatic development without obsolete engine claims',
      await exec(
        'document.querySelector(".toast.success")?.textContent.includes("前往开发计划") && !document.body.innerText.includes("引擎仍在建设中") && document.querySelectorAll("[data-testid=design-plan-next]").length === 1',
      ),
    );
    check(
      'confirmation itself does not start development or dispatch another model request',
      syntheticModelRequests === 1 &&
        (await invoke<WorkflowState>('workflowState', { projectId: project.id })).run === null,
    );
    for (const width of [1440, 1024]) {
      window.setContentSize(width, 900);
      await exec('document.querySelector(".ready-state").scrollIntoView({block:"center"}); true');
      await capture(`confirmed-next-${width}.png`);
      check(
        `confirmed direction next step fits at ${width}px`,
        await exec(
          'document.documentElement.scrollWidth <= window.innerWidth && document.querySelector("[data-testid=design-plan-next]").checkVisibility()',
        ),
      );
    }
    state = await invoke<PlanState>('planState', { projectId: project.id });
    check(
      'new confirmed project initially has no plan',
      state.status === 'empty' && state.run === null && state.history.length === 0,
    );
    await click('[data-testid=design-plan-next]');
    await waitFor('enabled create-plan button', () =>
      exec(
        '!!document.querySelector("[data-testid=create-plan]") && !document.querySelector("[data-testid=create-plan]").disabled',
      ),
    );
    check(
      'default profile is ordinary Web',
      await exec('document.querySelector("[data-testid=plan-profile]").value === "web"'),
    );
    check(
      'opening the plan alone leaves automatic development disabled until tasks are arranged',
      (await exec('document.querySelector("[data-testid=start-workflow]").disabled')) &&
        syntheticModelRequests === 1,
    );
    await exec('document.querySelector("[data-testid=create-plan]").click(); true');
    await waitFor('first plan persisted through actual React button and IPC', async () => {
      state = await invoke<PlanState>('planState', { projectId: project.id });
      return state.status === 'current' && state.history.length === 1;
    });
    state = await invoke<PlanState>('planState', { projectId: project.id });
    check(
      'React button creates one current revision-bound plan',
      state.status === 'current' &&
        state.run?.request.requirementId === project.requirements[0].id &&
        state.run?.request.designId === project.designs[0].id,
    );
    await waitFor('automatic development available after explicit planning', () =>
      exec('!document.querySelector("[data-testid=start-workflow]").disabled'),
    );
    check(
      'plan completion exposes automatic development without automatically running it',
      syntheticModelRequests === 1 &&
        (await invoke<WorkflowState>('workflowState', { projectId: project.id })).run === null &&
        (await invoke<AppSnapshot>('snapshot')).usage.calls === 1,
    );
    const first = state.run!;
    check(
      'all requirement tasks remain pending and unverified',
      first.plan.tasks.length === 9 &&
        first.plan.tasks.every(
          (task) => task.implementation === 'pending' && task.verification === 'not_run',
        ),
    );
    check(
      'ordinary Web marks every Agent component not applicable',
      first.plan.profile === 'web' &&
        first.plan.components.length === 17 &&
        first.plan.components.every((component) => component.decision === '不适用'),
    );
    check(
      'complete page mapping does not manufacture missing-page review notes',
      first.plan.reviewNotes.length === 0,
    );
    check(
      'three ordered completion events describe binding, rules and tasks',
      JSON.stringify(first.events.map((event) => [event.sequence, event.type, event.stage])) ===
        JSON.stringify([
          [1, 'stage.completed', 'binding'],
          [2, 'stage.completed', 'rules'],
          [3, 'stage.completed', 'tasks'],
        ]),
    );
    await waitFor('plan task content in React', () =>
      exec(
        `document.querySelector('[data-testid=plan-tasks]')?.textContent.includes(${JSON.stringify(requirement.features[0])}) === true`,
      ),
    );
    check(
      'unresolved question remains visible',
      await exec(
        `document.querySelector('[data-testid=plan-questions]')?.textContent.includes(${JSON.stringify(requirement.questions[0])}) === true`,
      ),
    );
    await exec(
      'document.querySelector("[data-testid=plan-profile]").closest("details").open = true; true',
    );
    check(
      'UI renders three stage events',
      await exec('document.querySelectorAll("[data-testid=plan-events] li").length === 3'),
    );
    await waitFor('gap rows loaded for current plan', () =>
      exec("document.querySelectorAll('[data-testid=gap-row]').length === 9"),
    );
    check(
      'UI distinguishes not applicable components and unverified requirement rows',
      await exec(
        "document.body.innerText.includes('不适用') && Array.from(document.querySelectorAll('[data-testid=gap-row]')).every(row => row.dataset.verification === 'not_run') && document.querySelector('[data-testid=gap-report]').textContent.includes('不能代替业务核验')",
      ),
    );
    await capture('plan-create-initial.png');
    const planPath = join(store.rootPath, 'projects', project.id, 'runs', 'development-plans.json');
    const firstBytes = readFileSync(planPath);
    const repeated = await invoke<PlanState>('createPlan', first.request);
    check(
      'repeated request returns the same run without duplicate history',
      repeated.run?.id === first.id && repeated.history.length === 1,
    );
    check(
      'duplicate request does not rewrite persisted plan bytes',
      firstBytes.equals(readFileSync(planPath)),
    );
    const unknown = await raw<unknown>('createPlan', {
      ...first.request,
      requestId: randomUUID(),
      command: 'unexpected',
    });
    check(
      'unknown createPlan fields are rejected at IPC',
      !unknown.ok && unknown.error.code === 'INVALID_INPUT',
    );
    const invalidRead = await raw<unknown>('planState', { projectId: project.id, extra: true });
    check(
      'unknown planState fields are rejected at IPC',
      !invalidRead.ok && invalidRead.error.code === 'INVALID_INPUT',
    );
    const conflict = await raw<unknown>('createPlan', { ...first.request, profile: 'agent' });
    check(
      'reusing a request id with different profile is rejected',
      !conflict.ok && conflict.error.code === 'REQUEST_CONFLICT',
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
      const blocked = (await foreign.webContents.executeJavaScript(
        `window.factory.createPlan(${JSON.stringify({ ...first.request, requestId: randomUUID() })})`,
      )) as ApiResult<unknown>;
      check(
        'foreign renderer with identical preload cannot create a plan',
        !blocked.ok && blocked.error.code === 'FORBIDDEN',
      );
      const deniedRead = (await foreign.webContents.executeJavaScript(
        `window.factory.planState(${JSON.stringify({ projectId: project.id })})`,
      )) as ApiResult<unknown>;
      check(
        'foreign renderer cannot read privileged plan state',
        !deniedRead.ok && deniedRead.error.code === 'FORBIDDEN',
      );
    } finally {
      foreign.destroy();
    }
    check(
      'rejected requests leave plan bytes unchanged',
      firstBytes.equals(readFileSync(planPath)),
    );
    project = await invoke<Project>('saveRequirements', {
      projectId: project.id,
      content: revised,
    });
    state = await invoke<PlanState>('planState', { projectId: project.id });
    check(
      'editing requirements makes the previous plan stale and preserves history',
      state.status === 'stale' && state.run?.id === first.id && state.history.length === 1,
    );
    const blockedUnapproved = await raw<unknown>('createPlan', {
      ...first.request,
      requestId: randomUUID(),
      requirementId: project.requirements.at(-1)!.id,
    });
    check(
      'unconfirmed changed requirements cannot create a new plan',
      !blockedUnapproved.ok && blockedUnapproved.error.code === 'CONFIRMATION_REQUIRED',
    );
    await openPlan();
    check(
      'stale plan is explicitly identified in UI',
      await exec('document.querySelector("[data-testid=plan-state]").dataset.status === "stale"'),
    );
    check(
      'stale plan UI requires confirmation before another run',
      await exec('document.querySelector("[data-testid=create-plan]").disabled'),
    );
    await capture('plan-create-stale.png');
    project = await invoke<Project>('approveRequirements', {
      projectId: project.id,
      revisionId: project.requirements.at(-1)!.id,
    });
    project = store.saveDesign(project.id, design);
    project = await invoke<Project>('approveDesign', {
      projectId: project.id,
      revisionId: project.designs.at(-1)!.id,
    });
    await openPlan();
    await waitFor('confirmed current versions enable button', () =>
      exec('!document.querySelector("[data-testid=create-plan]").disabled'),
    );
    await exec('document.querySelector("[data-testid=create-plan]").click(); true');
    await waitFor('second version plan', async () => {
      state = await invoke<PlanState>('planState', { projectId: project.id });
      return state.status === 'current' && state.history.length === 2;
    });
    state = await invoke<PlanState>('planState', { projectId: project.id });
    check(
      'confirmed changed versions produce a new plan preserving both runs',
      state.run?.request.requirementId === project.requirements.at(-1)!.id &&
        state.run?.request.designId === project.designs.at(-1)!.id &&
        state.run?.id !== first.id &&
        state.history.length === 2,
    );
    check(
      'new plan uses the updated feature and question',
      state.run?.plan.tasks.some((task) => task.title === revised.features.at(-1)) &&
        state.run.plan.openQuestions[0] === revised.questions[0],
    );
    const oldAgain = await invoke<PlanState>('createPlan', first.request);
    check(
      'replaying an old request reports its stale run without promotion',
      oldAgain.status === 'stale' &&
        oldAgain.run?.id === first.id &&
        (await invoke<PlanState>('planState', { projectId: project.id })).run?.id === state.run?.id,
    );
  } else {
    check(
      'project revisions survive a separate Electron process launch',
      snapshot.projects.length === 1 &&
        snapshot.projects[0].stage === 'ready' &&
        snapshot.projects[0].requirements.length === 2 &&
        snapshot.projects[0].designs.length === 2,
    );
    project = snapshot.projects[0];
    const prior = JSON.parse(readFileSync(join(output, 'plan-create.json'), 'utf8')) as {
      planSha256: string;
      projectSha256: string;
      latestRunId: string;
    };
    const planPath = join(store.rootPath, 'projects', project.id, 'runs', 'development-plans.json');
    check(
      'plan bytes survive full process exit unchanged',
      sha256(readFileSync(planPath)) === prior.planSha256,
    );
    check(
      'confirmed project manifest bytes survive process exit unchanged',
      sha256(readFileSync(join(store.rootPath, 'projects', project.id, 'project.json'))) ===
        prior.projectSha256,
    );
    state = await invoke<PlanState>('planState', { projectId: project.id });
    check(
      'restored plan is current with both historical runs',
      state.status === 'current' &&
        state.history.length === 2 &&
        state.run?.id === prior.latestRunId,
    );
    check(
      'restored tasks still have no implementation or verification claims',
      state.run?.plan.tasks.length === 10 &&
        state.run.plan.tasks.every(
          (task) => task.implementation === 'pending' && task.verification === 'not_run',
        ) &&
        state.run.plan.checks.every((item) => item.status === 'not_run'),
    );
    await openPlan();
    await waitFor('restored updated tasks render', () =>
      exec(
        `document.querySelector('[data-testid=plan-tasks]')?.textContent.includes(${JSON.stringify(revised.features.at(-1))}) === true`,
      ),
    );
    check(
      'restored question is visible in React',
      await exec(
        `document.querySelector('[data-testid=plan-questions]')?.textContent.includes(${JSON.stringify(revised.questions[0])}) === true`,
      ),
    );
    const repeated = await invoke<PlanState>('createPlan', state.run!.request);
    check(
      'repeated request after process restart is still idempotent',
      repeated.run?.id === prior.latestRunId &&
        repeated.history.length === 2 &&
        sha256(readFileSync(planPath)) === prior.planSha256,
    );
  }
  await waitFor('final plan content', () =>
    exec(
      `document.querySelector('[data-testid=plan-tasks]')?.textContent.includes(${JSON.stringify(revised.features.at(-1))}) === true`,
    ),
  );
  for (const width of [1440, 1024]) {
    window.setContentSize(width, 900);
    await capture(`plan-${phase}-${width}.png`);
    check(
      `plan layout has no horizontal overflow at ${width}px`,
      await exec('document.documentElement.scrollWidth <= window.innerWidth'),
    );
  }
  state = await invoke<PlanState>('planState', { projectId: project.id });
  const finalSnapshot = await invoke<AppSnapshot>('snapshot');
  check(
    'confirming navigating planning and reopening make no additional model calls',
    finalSnapshot.usage.calls === 1 && syntheticModelRequests === (phase === 'create' ? 1 : 0),
  );
  check(
    'planning does not claim generated code or advance the project stage',
    store.get(project.id).stage === 'ready',
  );
  writeFileSync(
    join(output, `plan-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        systemPath: process.env.PATH,
        modelCalls: finalSnapshot.usage.calls,
        syntheticModelRequests,
        planSha256: sha256(
          readFileSync(
            join(store.rootPath, 'projects', project.id, 'runs', 'development-plans.json'),
          ),
        ),
        projectSha256: sha256(
          readFileSync(join(store.rootPath, 'projects', project.id, 'project.json')),
        ),
        latestRunId: state.run!.id,
        limitations: [
          'Synthetic saved requirements; page draft generated through real ModelService with injected synthetic fetch. Requirements and initial page are confirmed using real UI buttons.',
          'No real model call',
          'No generated-code execution',
          'No worker or tool-protocol test',
          'No clean-OS installation or Windows test',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Plan ${phase}: ${checks.length} checks passed`);
  app.exit(0);
}
mkdirSync(output, { recursive: true });
run().catch((error) => {
  console.error(String(error));
  writeFileSync(
    join(output, `plan-${phase}-failure.txt`),
    `${String(error)}\nCompleted: ${checks.join('; ')}`,
  );
  app.exit(1);
});
