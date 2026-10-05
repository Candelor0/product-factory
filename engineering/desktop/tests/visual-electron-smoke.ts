import { app } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import type { ApiResult, AppSnapshot, RequirementContent } from '../src/shared/contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const checks: string[] = [];
const check = (description: string, condition: unknown) => {
  assert.ok(condition, description);
  checks.push(description);
};
const requirement: RequirementContent = {
  summary: '用一个安静的个人博客整理阅读与旅行记录。',
  audience: '记录生活的博客作者',
  features: ['创建和编辑文章', '保存草稿并在本地发布', '按标签浏览'],
  pages: ['博客首页', '文章详情', '文章管理'],
  data: ['文章标题、正文、标签和发布状态'],
  outOfScope: ['公网发布与评论'],
  questions: ['是否需要文章封面？'],
  acceptance: ['保存文章后重开仍能读取'],
};

async function run() {
  const { window, store } = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    show: false,
  });
  window.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(code: string) =>
    window.webContents.executeJavaScript(code) as Promise<T>;
  const invoke = async <T>(method: string, payload?: unknown): Promise<T> => {
    const result = await exec<ApiResult<T>>(
      `window.factory[${JSON.stringify(method)}](${JSON.stringify(payload)})`,
    );
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
  const waitSelector = (selector: string) =>
    waitFor(selector, () => exec(`!!document.querySelector(${JSON.stringify(selector)})`));
  const click = async (selector: string) => {
    await waitSelector(selector);
    await exec(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  };
  const capture = async (name: string, width = 1440, height = 900) => {
    window.setContentSize(width, height);
    await exec('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await new Promise((done) => setTimeout(done, 120));
    check(
      `${name}: no horizontal page overflow`,
      await exec('document.documentElement.scrollWidth <= window.innerWidth'),
    );
    if (await exec('!!document.querySelector("[data-testid=idea-home]")')) {
      check(
        `${name}: complete idea composer and create button fit the viewport`,
        await exec(
          'Array.from(document.querySelectorAll(".idea-composer, .idea-composer [aria-label=创建项目]")).every(element => { const rect=element.getBoundingClientRect();return element.checkVisibility() && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;})',
        ),
      );
    }
    writeFileSync(join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const fieldVisible = 'field => field.checkVisibility()';
  const snapshot = await invoke<AppSnapshot>('snapshot');
  check(
    'isolated empty workspace has no credentials or provider calls',
    snapshot.projects.length === 0 && !snapshot.settings.hasKey && snapshot.usage.calls === 0,
  );
  const setIdea = async (value: string) => {
    await exec(
      `(() => {const field=document.querySelector('.idea-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    );
    await new Promise((done) => setTimeout(done, 40));
  };
  const ideaKey = async (shift: boolean) => {
    window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'Return',
      modifiers: shift ? ['shift'] : [],
    });
    if (shift)
      window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'Return',
      modifiers: shift ? ['shift'] : [],
    });
    await new Promise((done) => setTimeout(done, 60));
  };
  await waitSelector('[data-testid=idea-home]');
  check(
    'empty home has one central idea input with an accessible label',
    await exec(
      'document.querySelectorAll("main textarea").length === 1 && document.querySelector(".idea-composer textarea").getAttribute("aria-label") === "描述你的应用想法"',
    ),
  );
  check(
    'blank idea disables creation',
    await exec('document.querySelector(".idea-composer [aria-label=创建项目]").disabled'),
  );
  await capture('home-empty-1440');
  await capture('home-empty-1024', 1024, 768);
  await click('.new-project-button');
  check(
    'new project focuses the central input without a modal',
    await exec(
      '!document.querySelector("[role=dialog]") && document.activeElement === document.querySelector(".idea-composer textarea")',
    ),
  );
  await setIdea('   \n  ');
  check(
    'whitespace-only idea also disables creation',
    await exec('document.querySelector(".idea-composer [aria-label=创建项目]").disabled'),
  );
  await ideaKey(false);
  check('Enter on whitespace does not create a project', store.list().length === 0);
  const firstIdea = '阅读与远行：用个人博客记录读书和旅行，文章保存在本机。';
  await setIdea(firstIdea);
  await exec(
    'document.querySelector(".idea-composer textarea").focus(); document.querySelector(".idea-composer textarea").setSelectionRange(document.querySelector(".idea-composer textarea").value.length, document.querySelector(".idea-composer textarea").value.length); true',
  );
  await ideaKey(true);
  check(
    'real Shift+Enter inserts a newline without creating a project',
    store.list().length === 0 &&
      (await exec(
        `document.querySelector('.idea-composer textarea').value === ${JSON.stringify(firstIdea + '\n')}`,
      )),
  );
  await setIdea(firstIdea);
  const compositionEvidence = await exec<{
    syntheticEvents: boolean;
    isComposing: boolean;
    legacyKeyCode: number;
  }>(`(() => {
    const field=document.querySelector('.idea-composer textarea');
    const composing=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true});
    field.dispatchEvent(composing);
    const legacy=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,keyCode:229});
    field.dispatchEvent(legacy);
    return {syntheticEvents:true,isComposing:composing.isComposing,legacyKeyCode:legacy.keyCode};
  })()`);
  await new Promise((done) => setTimeout(done, 80));
  writeFileSync(
    join(output, 'composition-guard.json'),
    JSON.stringify(compositionEvidence, null, 2),
  );
  check(
    'synthetic IME composition and keyCode 229 Enter events do not submit',
    compositionEvidence.isComposing &&
      compositionEvidence.legacyKeyCode === 229 &&
      store.list().length === 0,
  );
  await ideaKey(false);
  await waitFor('Enter creates the first local project', async () => store.list().length > 0);
  await waitSelector('[role=tabpanel]');
  let project = store.list()[0];
  check(
    'real Enter creates exactly one local project with the complete idea',
    store.list().length === 1 &&
      project.idea === firstIdea &&
      project.name === Array.from(firstIdea).slice(0, 18).join(''),
  );
  check(
    'creation opens requirements while automatic model work stays pending',
    project.stage === 'idea' &&
      project.requirements.length === 0 &&
      (await invoke<AppSnapshot>('snapshot')).usage.calls === 0,
  );
  await click('.new-project-button');
  await waitSelector('[data-testid=idea-home]');
  check(
    'returning to new project focuses an empty input after successful creation',
    await exec(
      'document.activeElement === document.querySelector(".idea-composer textarea") && document.querySelector(".idea-composer textarea").value === ""',
    ),
  );
  const secondIdea = '下一本想读的书，整理阅读清单。';
  await setIdea(secondIdea);
  await exec(
    'document.querySelector(".idea-composer").requestSubmit(); document.querySelector(".idea-composer").requestSubmit(); true',
  );
  await waitFor('second local project persists', async () => store.list().length >= 2);
  await waitSelector('[role=tabpanel]');
  await new Promise((done) => setTimeout(done, 100));
  check(
    'two immediate submissions create only one additional project',
    store.list().length === 2 &&
      store.list().filter((item) => item.idea === secondIdea).length === 1,
  );
  project = store.saveRequirements(project.id, requirement);
  await window.loadFile(resolve('dist/renderer/index.html'));
  await waitSelector('[data-testid=idea-home]');
  check(
    'reopened home keeps one idea input even when saved projects exist',
    await exec(
      'document.querySelectorAll("main textarea").length === 1 && document.querySelectorAll(".idea-composer").length === 1',
    ),
  );
  check(
    'all saved projects appear only in the sidebar',
    await exec(
      'document.querySelectorAll(".sidebar .project-item").length === 2 && !document.querySelector("main .project-item, main .project-card, main [data-testid=project-index], main [data-testid=project-row]")',
    ),
  );
  check(
    'central home contains no duplicate project history',
    await exec(
      "!document.querySelector('main').innerText.includes('阅读与远行') && !document.querySelector('main').innerText.includes('下一本想读的书')",
    ),
  );
  await capture('home-with-projects-1440');
  await capture('home-with-projects-1024', 1024, 768);
  const secondProject = store.list().find((item) => item.idea === secondIdea)!;
  await invoke('archiveProject', { projectId: secondProject.id, archived: true });
  await window.loadFile(resolve('dist/renderer/index.html'));
  await waitSelector('[data-testid=idea-home]');
  await exec(
    "Array.from(document.querySelectorAll('.project-list-heading button')).find(button=>button.textContent.includes('归档')).click(); true",
  );
  await waitFor('archived history in sidebar', () =>
    exec(
      'document.querySelectorAll(".sidebar .project-item").length === 1 && document.querySelector(".sidebar .project-item").textContent.includes("下一本想读的书")',
    ),
  );
  check(
    'archived history is selected in the sidebar while the center remains an idea input',
    await exec(
      '!!document.querySelector("[data-testid=idea-home]") && document.querySelectorAll("main textarea").length === 1 && !document.querySelector("main .project-card, main .project-item")',
    ),
  );
  await capture('home-archived-sidebar-1024', 1024, 768);
  await invoke('archiveProject', { projectId: secondProject.id, archived: false });
  await window.loadFile(resolve('dist/renderer/index.html'));
  await waitFor('restored projects in sidebar', () =>
    exec('document.querySelectorAll(".sidebar .project-item").length === 2'),
  );
  const draftIdea = '还没提交的想法：整理我的旅行照片。';
  await setIdea(draftIdea);
  await exec(
    "Array.from(document.querySelectorAll('.project-item')).find(row=>row.textContent.includes('阅读与远行')).click(); true",
  );
  await waitSelector('.requirements-form');
  await click('.new-project-button');
  await waitSelector('[data-testid=idea-home]');
  check(
    'new project returns from a saved project and preserves the unsent idea draft',
    await exec(
      `document.activeElement === document.querySelector('.idea-composer textarea') && document.querySelector('.idea-composer textarea').value === ${JSON.stringify(draftIdea)}`,
    ),
  );
  await exec(
    "Array.from(document.querySelectorAll('.project-item')).find(row=>row.textContent.includes('下一本想读的书')).click(); true",
  );
  await waitSelector('[role=tabpanel]');
  await click('.new-project-button');
  await waitSelector('[data-testid=idea-home]');
  check(
    'switching through another project keeps the same unsent draft without creating data',
    store.list().length === 2 &&
      (await exec(
        `document.querySelector('.idea-composer textarea').value === ${JSON.stringify(draftIdea)}`,
      )),
  );
  await capture('home-preserved-draft-1024', 1024, 768);
  await exec(
    "Array.from(document.querySelectorAll('.project-item')).find(row=>row.textContent.includes('阅读与远行')).click(); true",
  );
  await waitSelector('.requirements-form');
  check(
    'opening a sidebar project displays its saved requirements',
    await exec(
      `document.querySelector('.requirements-form textarea').value === ${JSON.stringify(requirement.summary)}`,
    ),
  );
  check(
    'secondary requirements are initially collapsed',
    await exec('document.querySelector(".requirements-details")?.open === false'),
  );
  writeFileSync(
    join(output, 'requirement-visibility.json'),
    JSON.stringify(
      await exec(
        'Array.from(document.querySelectorAll(".requirements-form textarea")).map(field => ({clientRectCount:field.getClientRects().length, checkVisibility:field.checkVisibility(), closedDetails:!!field.closest("details:not([open])")}))',
      ),
      null,
      2,
    ),
  );
  check(
    'only four core requirement fields are visible initially',
    await exec(
      `Array.from(document.querySelectorAll('.requirements-form textarea')).filter(${fieldVisible}).length === 4`,
    ),
  );
  check(
    'collapsed fields retain their saved values',
    await exec(
      `Array.from(document.querySelectorAll('.requirements-form textarea')).some(field => field.value === ${JSON.stringify(requirement.data.join('\n'))})`,
    ),
  );
  await capture('requirements-collapsed-1440');
  await capture('requirements-collapsed-1024', 1024, 768);
  await click('[data-testid=requirements-details-toggle]');
  check(
    'real disclosure click reveals all eight editable fields',
    await exec(
      `document.querySelector('.requirements-details').open && Array.from(document.querySelectorAll('.requirements-form textarea')).filter(${fieldVisible}).length === 8`,
    ),
  );
  await exec(
    'document.querySelector("[data-testid=requirements-details-toggle]").scrollIntoView({block:"start"}); true',
  );
  await capture('requirements-expanded-1024', 1024, 768);
  const newData = [...requirement.data, '文章最后编辑时间'];
  await exec(`(() => {
    const field = Array.from(document.querySelectorAll('.requirements-form textarea')).find(field => field.value === ${JSON.stringify(requirement.data.join('\n'))});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field, ${JSON.stringify(newData.join('\n'))});
    field.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  await waitFor('edited hidden field updates save action', () =>
    exec(
      "Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '保存修改' && !button.disabled)",
    ),
  );
  await click('[data-testid=requirements-details-toggle]');
  check(
    'secondary fields can be collapsed after editing',
    await exec('document.querySelector(".requirements-details").open === false'),
  );
  await exec(
    "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '保存修改').click(); true",
  );
  await waitFor(
    'collapsed-field edit persists',
    async () => store.get(project.id).requirements.length === 2,
  );
  project = store.get(project.id);
  check(
    'saving while collapsed preserves edited data and all other requirement fields',
    JSON.stringify(project.requirements.at(-1)!.content) ===
      JSON.stringify({ ...requirement, data: newData }),
  );
  await waitFor('new revision is rendered', () => exec("document.body.innerText.includes('v2')"));
  check(
    'saving changes leaves confirmation pending',
    project.stage === 'requirements' && !project.requirements.at(-1)!.approvedAt,
  );

  await exec('document.querySelector(".toast [aria-label=关闭提示]")?.click(); true');
  await click('[data-testid=settings-button]');
  await waitSelector('[data-testid=settings-usage]');
  check(
    'usage has moved into the accessible settings dialog',
    await exec('!!document.querySelector("[role=dialog] [data-testid=settings-usage]")'),
  );
  check(
    'usage details start collapsed while the call count remains visible',
    await exec(
      'document.querySelector("[data-testid=settings-usage]").open === false && document.querySelector("[data-testid=settings-usage] summary").innerText.includes("0")',
    ),
  );
  await exec('document.querySelector("[role=dialog] [aria-label=关闭窗口]").focus(); true');
  const focusTrace: string[] = [];
  let reachedUsage = false;
  for (let step = 0; step < 16; step++) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await new Promise((done) => setTimeout(done, 35));
    focusTrace.push(
      await exec<string>(
        'document.activeElement?.tagName + ":" + (document.activeElement?.getAttribute("aria-label") || document.activeElement?.getAttribute("type") || document.activeElement?.textContent?.trim().slice(0,40) || "")',
      ),
    );
    if (
      await exec(
        'document.activeElement === document.querySelector("[data-testid=settings-usage] summary")',
      )
    ) {
      reachedUsage = true;
      break;
    }
  }
  writeFileSync(
    join(output, 'keyboard-focus.json'),
    JSON.stringify({ focusTrace, reachedUsage }, null, 2),
  );
  check('real Tab key input reaches the settings usage disclosure', reachedUsage);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor('keyboard opens usage details', () =>
    exec('document.querySelector("[data-testid=settings-usage]").open === true'),
  );
  check(
    'real Space key opens the focused usage disclosure',
    await exec('document.querySelector("[data-testid=settings-usage]").open === true'),
  );

  check(
    'settings show zero calls, known token count and unknown cost',
    await exec(
      "(() => { const text=document.querySelector('[data-testid=settings-usage]').innerText;return text.includes('0') && /token/i.test(text) && text.includes('未知');})()",
    ),
  );
  check(
    'opening settings does not populate the API Key field',
    await exec('document.querySelector("[role=dialog] input[type=password]").value === ""'),
  );
  check(
    'connection test stays disabled without a key',
    await exec(
      "Array.from(document.querySelectorAll('[role=dialog] button')).find(button => button.textContent.includes('检测连接')).disabled",
    ),
  );
  await exec(
    'document.querySelector("[data-testid=settings-usage]").scrollIntoView({block:"center"}); true',
  );
  await capture('settings-usage-1440');
  await capture('settings-usage-1024', 1024, 768);
  await exec(`(() => {
    const field = document.querySelector('[role=dialog] input[type=number]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field, '12');
    field.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  await waitFor('budget edit enables save', () =>
    exec(
      "!Array.from(document.querySelectorAll('[role=dialog] button')).find(button=>button.textContent.includes('保存设置')).disabled",
    ),
  );
  await exec(
    "Array.from(document.querySelectorAll('[role=dialog] button')).find(button=>button.textContent.includes('保存设置')).click(); true",
  );
  await waitFor(
    'saved call budget',
    async () => (await invoke<AppSnapshot>('snapshot')).settings.maxCalls === 12,
  );
  check(
    'saving budget does not invoke a model or create credentials',
    (await invoke<AppSnapshot>('snapshot')).usage.calls === 0 &&
      !(await invoke<AppSnapshot>('snapshot')).settings.hasKey,
  );
  await click('[role=dialog] [aria-label="关闭窗口"]');
  await click('[data-testid=settings-button]');
  await waitSelector('[data-testid=settings-usage]');
  check(
    'settings reopen with the persisted budget',
    await exec('document.querySelector("[role=dialog] input[type=number]").value === "12"'),
  );
  check(
    'settings dialog itself fits the 1024px viewport',
    await exec(
      '(() => {const box=document.querySelector("[role=dialog]").getBoundingClientRect();return box.left >= 0 && box.right <= window.innerWidth;})()',
    ),
  );
  await capture('settings-reopened-1024', 1024, 768);
  await click('[role=dialog] [aria-label="关闭窗口"]');
  project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = store.saveDesign(project.id, {
    direction: '白色底与清晰的文字层级，优先展示文章内容。',
    palette: ['#FFFFFF', '#25282A', '#BA492D'],
    pages: requirement.pages.map((name) => ({ name, sections: ['主要内容', '相关操作'] })),
    notes: ['只读历史中的方案说明，用于键盘焦点回归。'],
  });
  project = store.approveDesign(project.id, project.designs.at(-1)!.id);
  await window.loadFile(resolve('dist/renderer/index.html'));
  await waitSelector('.project-item');
  await exec(
    "Array.from(document.querySelectorAll('.project-item')).find(button=>button.textContent.includes('阅读与远行')).click(); true",
  );
  await waitSelector('[role=tab]');
  await exec(
    "Array.from(document.querySelectorAll('[role=tab]')).find(button=>button.textContent.includes('版本记录')).click(); true",
  );
  await waitFor('design history row', () =>
    exec(
      "Array.from(document.querySelectorAll('.history-item')).some(button=>button.textContent.includes('页面方向'))",
    ),
  );
  await exec(
    "Array.from(document.querySelectorAll('.history-item')).find(button=>button.textContent.includes('页面方向')).focus(); Array.from(document.querySelectorAll('.history-item')).find(button=>button.textContent.includes('页面方向')).click(); true",
  );
  const key = async (keyCode: string) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await new Promise((done) => setTimeout(done, 40));
  };
  await waitSelector('[role=dialog] .history-preview');
  check(
    'history design regression fixture has one button and two disclosure summaries',
    await exec(
      'document.querySelectorAll("[role=dialog] button").length === 1 && document.querySelectorAll("[role=dialog] summary").length === 2',
    ),
  );
  const historyFocusTrace: { key: string; focus: string }[] = [];
  const recordHistoryFocus = async (key: string) => {
    historyFocusTrace.push({
      key,
      focus: await exec<string>(
        'document.activeElement?.tagName + ":" + (document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim().slice(0,40) || "")',
      ),
    });
    writeFileSync(
      join(output, 'history-keyboard-focus.json'),
      JSON.stringify({ historyFocusTrace }, null, 2),
    );
  };
  await recordHistoryFocus('Focused row click opens history');
  check(
    'history modal starts with focus on its close button',
    await exec(
      'document.activeElement === document.querySelector("[role=dialog] [aria-label=关闭窗口]")',
    ),
  );
  await key('Tab');
  await recordHistoryFocus('Tab');
  check(
    'Tab from the only button reaches the color disclosure instead of looping',
    await exec(
      'document.activeElement === document.querySelector("[role=dialog] .palette-details summary")',
    ),
  );
  await key('Tab');
  await recordHistoryFocus('Tab');
  check(
    'next Tab reaches the design notes disclosure',
    await exec(
      'document.activeElement === document.querySelector("[role=dialog] .design-notes summary")',
    ),
  );
  await key('Tab');
  await recordHistoryFocus('Tab');
  check(
    'Tab at the last disclosure wraps focus back to close',
    await exec(
      'document.activeElement === document.querySelector("[role=dialog] [aria-label=关闭窗口]")',
    ),
  );
  await capture('history-design-keyboard-1024', 1024, 768);
  await key('Escape');
  await waitFor('Escape closes read-only history modal', () =>
    exec('!document.querySelector("[role=dialog]")'),
  );
  await recordHistoryFocus('Escape');
  check(
    'Escape restores focus to the triggering design history row',
    await exec(
      'document.activeElement?.classList.contains("history-item") && document.activeElement.textContent.includes("页面方向")',
    ),
  );
  const finalSnapshot = await invoke<AppSnapshot>('snapshot');
  check('entire visual workflow makes zero provider calls', finalSnapshot.usage.calls === 0);
  writeFileSync(
    join(output, 'visual-result.json'),
    JSON.stringify(
      {
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
        limitations: [
          'Synthetic project data only',
          'No actual model calls or user credentials',
          'IME guard uses synthetic composition events, not an OS input-method session',
          'No generated application acceptance',
          'No Windows or clean installation test',
          'Screenshots and functional checks do not constitute user visual approval',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Visual UI: ${checks.length} checks passed`);
  app.exit(0);
}
mkdirSync(output, { recursive: true });
run().catch((error) => {
  console.error(String(error));
  writeFileSync(
    join(output, 'visual-failure.txt'),
    `${String(error)}\nCompleted: ${checks.join('; ')}`,
  );
  app.exit(1);
});
