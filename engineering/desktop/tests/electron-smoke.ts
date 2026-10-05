import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startDesktop } from '../src/main/app';
import type { AppSnapshot, ApiResult, Project, RequirementContent } from '../src/shared/contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const projectIdea = '验证项目 · 个人博客，记录阅读与生活。文章保存在本机。';
const check = (description: string, condition: unknown) => {
  assert.ok(condition, description);
  checks.push(description);
};
const requirement: RequirementContent = {
  summary: '个人博客：记录阅读与生活，内容保存在本机。',
  audience: '博客作者本人',
  features: ['创建和编辑文章', '草稿与本地发布状态', '按标签浏览文章'],
  pages: ['博客首页', '文章详情', '文章管理'],
  data: ['文章标题、正文、标签和发布状态'],
  outOfScope: ['公网发布', '评论与登录'],
  questions: ['封面图片是否需要裁剪？'],
  acceptance: ['创建文章、保存草稿、重新打开后仍能读取'],
};

async function run() {
  const { window, store } = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    show: false,
  });
  window.webContents.setBackgroundThrottling(false);
  const exec = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const invoke = async <T>(method: string, payload?: unknown): Promise<T> => {
    const result = await exec<ApiResult<T>>(
      `window.factory[${JSON.stringify(method)}](${JSON.stringify(payload)})`,
    );
    if (!result.ok) throw new Error(`${method}: ${result.error.code} ${result.error.message}`);
    return result.value;
  };
  check(
    'renderer cannot access Node require/process',
    await exec("typeof require === 'undefined' && typeof process === 'undefined'"),
  );
  check(
    'renderer exposes a narrow bridge without ipcRenderer',
    await exec(
      "typeof window.factory.snapshot === 'function' && !window.factory.ipcRenderer && !window.factory.send",
    ),
  );
  const metric = app
    .getAppMetrics()
    .find((metric) => metric.pid === window.webContents.getOSProcessId());
  check(
    'OS renderer sandbox reported enabled by Electron process metrics',
    metric?.sandboxed === true,
  );
  check(
    'preload globals isolated from main JavaScript world',
    await exec('typeof ipcRenderer === "undefined" && typeof contextBridge === "undefined"'),
  );
  let snapshot = await invoke<AppSnapshot>('snapshot');
  check('real Electron desktop mode', snapshot.environment.mode === 'desktop');
  check('no model credentials present in test workspace', !snapshot.settings.hasKey);
  if (phase === 'create') {
    check('clean initial project list', snapshot.projects.length === 0);
    const missing = await exec<ApiResult<unknown>>('window.factory.checkProvider()');
    check(
      'missing API Key has an actionable typed error',
      !missing.ok && missing.error.code === 'KEY_REQUIRED',
    );
    await exec("document.querySelector('.new-project-button').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 40));
    check(
      'new project focuses the central idea composer without opening a modal',
      await exec(
        '!document.querySelector("[role=dialog]") && document.activeElement === document.querySelector(".idea-composer textarea")',
      ),
    );
    await exec(`(() => {
      const area=document.querySelector('.idea-composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,${JSON.stringify(projectIdea)});area.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await exec('document.querySelector(".idea-composer [aria-label=创建项目]").click(); true');
    for (let attempt = 0; attempt < 100 && store.list().length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const project = store.list()[0];
    check(
      'central idea composer saves the full idea and derives a short project name',
      project?.name === Array.from(projectIdea).slice(0, 18).join('') &&
        project.idea === projectIdea,
    );
    check(
      'creating from an idea keeps model work pending',
      project.stage === 'idea' &&
        project.requirements.length === 0 &&
        (await invoke<AppSnapshot>('snapshot')).usage.calls === 0,
    );
    await invoke('saveRequirements', { projectId: project.id, content: requirement });
    const updated = store.get(project.id);
    await invoke('approveRequirements', {
      projectId: project.id,
      revisionId: updated.requirements[0].id,
    });
    const designed = store.saveDesign(project.id, {
      direction: '温暖纸感、安静的阅读体验，以墨绿强调内容。',
      palette: ['#284E43', '#F6F4EE', '#C6AB7B'],
      pages: [
        { name: '博客首页', sections: ['个人介绍', '精选文章', '标签导航'] },
        { name: '文章详情', sections: ['文章标题', '正文阅读区', '标签与日期'] },
      ],
      notes: ['这是用于桌面集成检查的固定测试数据，未调用在线模型。'],
    });
    const ready = await invoke<Project>('approveDesign', {
      projectId: project.id,
      revisionId: designed.designs[0].id,
    });
    check('IPC confirmations reach ready only for the current revisions', ready.stage === 'ready');
    const traversal = await exec<ApiResult<unknown>>(
      'window.factory.renameProject({projectId:"../escape",name:"bad"})',
    );
    check('IPC path traversal rejected', !traversal.ok && traversal.error.code === 'INVALID_INPUT');
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: resolve('dist/main/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await foreign.loadFile(resolve('dist/renderer/index.html'));
    const blocked = (await foreign.webContents.executeJavaScript(
      'window.factory.snapshot()',
    )) as ApiResult<unknown>;
    check(
      'another window using identical preload cannot invoke privileged handlers',
      !blocked.ok && blocked.error.code === 'FORBIDDEN',
    );
    foreign.destroy();
    check(
      'renderer external fetch blocked',
      await exec("fetch('https://example.com').then(()=>false,()=>true)"),
    );
    const count = BrowserWindow.getAllWindows().length;
    await exec("window.open('https://example.com'); true");
    check('untrusted new windows denied', BrowserWindow.getAllWindows().length === count);
    const url = window.webContents.getURL();
    await exec(
      "(() => { const a=document.createElement('a');a.href='https://example.com';document.body.append(a);a.click();a.remove();return true; })()",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    check('external navigation denied', window.webContents.getURL() === url);
  } else {
    check(
      'project and approved versions survived full process exit',
      snapshot.projects.length === 1 &&
        snapshot.projects[0].stage === 'ready' &&
        snapshot.projects[0].requirements[0].content.summary === requirement.summary,
    );
    const project = snapshot.projects[0];
    const changed = await invoke<Project>('saveRequirements', {
      projectId: project.id,
      content: { ...requirement, summary: `${requirement.summary} 新增书摘。` },
    });
    check(
      'new requirement invalidates previously approved design',
      changed.stage === 'requirements' &&
        changed.requirements.length === 2 &&
        changed.designs.length === 1,
    );
    const stale = await exec<ApiResult<unknown>>(
      `window.factory.approveDesign(${JSON.stringify({ projectId: project.id, revisionId: project.designs[0].id })})`,
    );
    check(
      'stale design cannot be confirmed after requirements changed',
      !stale.ok && stale.error.code === 'STALE_REVISION',
    );
    await invoke('archiveProject', { projectId: project.id, archived: true });
    check(
      'archived projects preserved',
      (await invoke<AppSnapshot>('snapshot')).projects[0].archived,
    );
    await invoke('archiveProject', { projectId: project.id, archived: false });
  }
  await window.loadFile(resolve('dist/renderer/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  check(
    'React renders saved project',
    (await exec<string>('document.body.innerText')).includes('验证项目'),
  );
  check(
    'reloaded home stays a single idea composer with existing projects only in the sidebar',
    await exec(
      '!!document.querySelector("[data-testid=idea-home]") && document.querySelectorAll(".idea-composer textarea").length === 1 && document.querySelectorAll(".sidebar .project-item").length === 1 && !document.querySelector("main .project-item, main .project-card, main [data-testid=project-index]")',
    ),
  );
  for (const width of [1440, 1024]) {
    window.setContentSize(width, 850);
    await new Promise((resolve) => setTimeout(resolve, 200));
    check(
      `no horizontal page overflow at ${width}px`,
      await exec('document.documentElement.scrollWidth <= window.innerWidth'),
    );
    writeFileSync(
      join(output, `desktop-${phase}-${width}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  window.setContentSize(1440, 900);
  await exec("document.querySelector('.project-item').click(); true");
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    'additional requirement fields are initially collapsed',
    await exec('document.querySelector(".requirements-details")?.open === false'),
  );
  await exec('document.querySelector("[data-testid=requirements-details-toggle]").click(); true');
  check(
    'expanding additional requirements exposes all eight editable fields',
    await exec(
      'document.querySelector(".requirements-details")?.open === true && Array.from(document.querySelectorAll(".requirements-form textarea")).filter(field => field.checkVisibility() && !field.disabled).length === 8',
    ),
  );
  writeFileSync(
    join(output, `requirements-${phase}.png`),
    (await window.webContents.capturePage()).toPNG(),
  );
  await exec(
    "Array.from(document.querySelectorAll('[role=tab]')).find(button=>button.textContent.includes('页面方向')).click(); true",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    phase === 'create'
      ? 'confirmed design points to explicit planning and automatic development'
      : 'design view blocks changed unapproved requirements',
    await exec(
      phase === 'create'
        ? "document.body.innerText.includes('方向已确认') && document.body.innerText.includes('先整理开发计划，再点击「自动开发」') && !!document.querySelector('[data-testid=design-plan-next]')"
        : "document.body.innerText.includes('请先确认当前需求版本')",
    ),
  );
  writeFileSync(
    join(output, `design-${phase}.png`),
    (await window.webContents.capturePage()).toPNG(),
  );
  snapshot = await invoke<AppSnapshot>('snapshot');
  check('smoke makes zero provider calls', snapshot.usage.calls === 0);
  writeFileSync(
    join(output, `desktop-${phase}.json`),
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
        modelCalls: snapshot.usage.calls,
        limitations: [
          'No clean-OS install test',
          'No real model call',
          'No Windows test',
          'No generated-code execution',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Desktop ${phase}: ${checks.length} checks passed`);
  app.exit(0);
}
mkdirSync(output, { recursive: true });
run().catch((error) => {
  console.error(String(error));
  writeFileSync(
    join(output, `desktop-${phase}-failure.txt`),
    `${String(error)}\nCompleted: ${checks.join('; ')}`,
  );
  app.exit(1);
});
