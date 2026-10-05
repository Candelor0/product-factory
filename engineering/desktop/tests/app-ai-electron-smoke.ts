import { app, type BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import type { ApiResult, Project } from '../src/shared/contracts';
import type { BuildResult } from '../src/shared/build-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (name: string, value: unknown) => {
  assert.ok(value, name);
  checks.push(name);
};
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const key = 'synthetic-app-ai-key-no-account';
const privateText = '仅存储的私人内容-不应进入AI请求';
const inputText = '用户主动提交的合成待摘要文字';
const answer = '合成摘要结果-没有调用真实供应商';
const source = `import {useState} from 'react';
import {appAi} from '@factory/ai';
export default function App(){
const [text,setText]=useState(''),[id,setId]=useState(crypto.randomUUID()),[result,setResult]=useState(''),[pending,setPending]=useState(false);
async function send(e){e.preventDefault();setPending(true);setResult('等待结果');try{setResult(await appAi.generateText({requestId:id,text}));}catch(error){setResult(error.code);}finally{setPending(false);}}
return <main style={{maxWidth:680,margin:'60px auto',fontFamily:'system-ui'}}><h1>文章摘要</h1><p>仅在点击后发送输入文字</p><form onSubmit={send}><label>文字<textarea data-testid="ai-input" value={text} onChange={e=>setText(e.target.value)}/></label><label>请求编号<input data-testid="ai-id" value={id} onChange={e=>setId(e.target.value)}/></label><button data-testid="ai-send" disabled={pending||!text}>生成摘要</button></form><p data-testid="ai-result">{result}</p></main>;
}`;
const requirement = {
  summary: '本地文章摘要，用户主动提交文字后返回纯文本',
  audience: '自己',
  features: ['手动生成摘要'],
  pages: ['摘要表单'],
  data: ['输入文字'],
  outOfScope: ['公网', '后台自动处理'],
  questions: [],
  acceptance: ['未授权不调用模型'],
};
const design = {
  direction: '浅色简洁',
  palette: ['#ffffff', '#24372f'],
  pages: [{ name: '摘要', sections: ['文字', '按钮', '结果'] }],
  notes: [],
};
type Saved = {
  projectId: string;
  buildId: string;
  requestId: string;
  calls: number;
  budgetTokens: number;
  developmentCalls: number;
};

async function run() {
  let calls = 0;
  let held = false;
  let holdNext = false;
  let release: (() => void) | undefined;
  const modelRequest: typeof fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options?.body));
    const serial = JSON.stringify(body);
    check(
      `synthetic request ${calls} contains no stored business content or credential`,
      !serial.includes(privateText) && !serial.includes(key),
    );
    const application = !body.response_format && !body.tools;
    if (application) {
      const input = JSON.parse(body.messages[1].content);
      check(
        `application request ${calls} only receives the granted purpose and submitted text`,
        Object.keys(input).sort().join(',') === 'purpose,text' && input.text === inputText,
      );
      check(
        `application request ${calls} has no tools or project documents`,
        body.messages.length === 2 && !serial.includes(requirement.summary),
      );
    }
    if (holdNext) {
      holdNext = false;
      held = true;
      await new Promise<void>((done) => {
        release = done;
      });
      held = false;
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', content: application ? answer : '{"ok":true}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 21, completion_tokens: 9 },
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
  const { window, store, plans, sources, sourceTools, models, previews, appData, appAi } = desktop;
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
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    );
    await delay(60);
  };
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
    await until('authorization panel', () =>
      exec('!!document.querySelector("[data-testid=app-ai-state]:not([data-status=loading])")'),
    );
  };
  const openSettings = async () => {
    await exec(
      'Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==="模型与设置").click();true',
    );
    await until('settings', () =>
      exec('!!document.querySelector("[data-testid=development-token-toggle]")'),
    );
  };
  const panelStatus = async (status: string) =>
    until(`authorization ${status}`, () =>
      exec(
        `document.querySelector('[data-testid=app-ai-state]')?.dataset.status===${JSON.stringify(status)}`,
      ),
    );
  const grant = async (maxCalls: number) => {
    await exec('document.querySelector("[data-testid=app-ai-details]").open=true;true');
    await fill('[data-testid=app-ai-purpose]', '按用户提供文字生成摘要');
    await fill('[data-testid=app-ai-call-limit]', String(maxCalls));
    await fill('[data-testid=app-ai-token-limit]', '100000');
    await until('grant enabled', () =>
      exec('!document.querySelector("[data-testid=grant-app-ai]").disabled'),
    );
    await click('[data-testid=grant-app-ai]');
    await panelStatus('authorized');
  };
  const open = async (id: string, buildId: string) => {
    await invoke('openApplication', { projectId: id, buildId });
    await until(
      'application form',
      async () =>
        !!previews.applicationWindow(id) &&
        (await previews
          .applicationWindow(id)!
          .webContents.executeJavaScript('!!document.querySelector("[data-testid=ai-send]")')),
    );
    return previews.applicationWindow(id)!;
  };
  const send = async (target: BrowserWindow, requestId: string, expected?: string) => {
    await fill('[data-testid=ai-input]', inputText, target);
    await fill('[data-testid=ai-id]', requestId, target);
    await click('[data-testid=ai-send]', target);
    if (expected)
      await until(`application result ${expected}`, () =>
        target.webContents.executeJavaScript(
          `document.querySelector('[data-testid=ai-result]').textContent===${JSON.stringify(expected)}`,
        ),
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
  let saved: Saved;
  if (phase === 'create') {
    let project = store.create({ name: '项目文本 AI 验证', idea: requirement.summary });
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
    check('AI SDK fixture saved through real source transactions', written.ok);
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: key,
      maxCalls: 10,
    });
    appData.apply(id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: [{ operation: 'put', key: 'private', value: privateText }],
    });
    const built = await invoke<BuildResult>('buildSource', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      planRunId,
      sourceRevision: sources.get(id).revision,
    });
    check('real compiler accepts the bundled AI SDK', built.status === 'succeeded');
    const buildId = built.state.artifact!.id;
    await openPlan(project);
    check(
      'authorization is collapsed and new limits are empty',
      await exec(
        '!document.querySelector("[data-testid=app-ai-details]").open && document.querySelector("[data-testid=app-ai-call-limit]").value==="" && document.querySelector("[data-testid=app-ai-token-limit]").value===""',
      ),
    );
    await panelStatus('unauthorized');
    await invoke('openPreview', { projectId: id, buildId });
    const temporary = previews.previewWindow(id)!;
    await send(temporary, randomUUID(), 'APP_AI_DISABLED');
    check(
      'temporary preview denies AI without any supplier request',
      calls === 0 && appAi.state(id).usage.calls === 0,
    );
    const live = await open(id, buildId);
    await send(live, randomUUID(), 'APP_AI_UNAUTHORIZED');
    check('persistent application requires explicit authorization', calls === 0);
    check(
      'generated application has no privileged authorization bridge',
      await live.webContents.executeJavaScript(
        'typeof window.factory==="undefined" && typeof require==="undefined"',
      ),
    );
    await grant(1);
    check('granting authorization does not call a model', calls === 0);
    await fill('[data-testid=app-ai-purpose]', '尚未保存的用途');
    await delay(2300);
    check(
      'background refresh preserves the edited authorization draft',
      await exec('document.querySelector("[data-testid=app-ai-purpose]").value==="尚未保存的用途"'),
    );
    await fill('[data-testid=app-ai-purpose]', '按用户提供文字生成摘要');
    const requestId = randomUUID();
    await send(live, requestId, answer);
    check('user action calls the real ModelService adapter once', calls === 1);
    check(
      'application usage settles separately from development usage',
      appAi.state(id).usage.calls === 1 &&
        appAi.state(id).budgetTokens === 30 &&
        models.usage().calls === 0,
    );
    await panelStatus('limited');
    await send(live, requestId, 'APP_AI_REQUEST_RECORDED');
    check('same request ID is never charged again', calls === 1);
    await send(live, randomUUID(), 'APP_AI_LIMIT');
    check('exhausted project budget prevents dispatch', calls === 1);
    await grant(5);
    check(
      'raising project limits retains cumulative usage',
      appAi.state(id).usage.calls === 1 && appAi.state(id).budgetTokens === 30,
    );
    await send(temporary, randomUUID(), 'APP_AI_DISABLED');
    check('authorization never promotes an existing temporary session', calls === 1);
    const ledger = readFileSync(join(store.rootPath, 'projects', id, 'runs/app-ai.json'), 'utf8');
    check(
      'AI ledger contains no input, answer, private business text or credential',
      ![inputText, answer, privateText, key].some((value) => ledger.includes(value)),
    );
    await capture('app-ai-1440.png', 1440, 1000, '[data-testid=app-ai-state]');
    await capture('app-ai-1024.png', 1024, 720, '[data-testid=grant-app-ai]');
    await openSettings();
    check(
      'development token budget is opt in',
      await exec('!document.querySelector("[data-testid=development-token-toggle]").checked'),
    );
    await click('[data-testid=development-token-toggle]');
    await fill('[data-testid=development-token-limit]', '1');
    await click('[data-testid=save-model-settings]');
    await until('token limit saved', () => models.settings().maxTokens === 1);
    await until('connection check ready', () =>
      exec('!document.querySelector("[data-testid=test-model-connection]").disabled'),
    );
    await click('[data-testid=test-model-connection]');
    await until('token limit message', () =>
      exec(
        'document.body.innerText.includes("token") && !document.querySelector("[data-testid=test-model-connection]").disabled',
      ),
    );
    check(
      'development token limit blocks a request before dispatch',
      calls === 1 && models.usage().calls === 0,
    );
    const limited = await raw('checkProvider');
    check(
      'IPC returns a token budget error without silently treating it as a model failure',
      !limited.ok && limited.error.code === 'TOKEN_BUDGET_EXCEEDED',
    );
    await capture(
      'development-budget-1024.png',
      1024,
      720,
      '[data-testid=development-token-limit]',
    );
    await fill('[data-testid=development-token-limit]', '100000');
    await click('[data-testid=save-model-settings]');
    await until('development budget raised', () => models.settings().maxTokens === 100000);
    await click('[aria-label="关闭窗口"]');
    await panelStatus('authorized');
    check(
      'only budget changes keep the existing application grant valid',
      appAi.state(id).status === 'authorized',
    );
    holdNext = true;
    await send(live, randomUUID());
    await until('held application request', () => held);
    await click('[data-testid=revoke-app-ai]');
    await panelStatus('revoked');
    await until('application cancellation shown', () =>
      live.webContents.executeJavaScript(
        'document.querySelector("[data-testid=ai-result]").textContent!=="等待结果"',
      ),
    );
    release!();
    await delay(100);
    check(
      'revocation rejects a late response and retains reserved usage',
      appAi.state(id).usage.calls === 2 &&
        appAi.state(id).usage.unknownUsageCalls === 1 &&
        appAi.state(id).budgetTokens > 30 &&
        (await live.webContents.executeJavaScript(
          `document.querySelector('[data-testid=ai-result]').textContent!==${JSON.stringify(answer)}`,
        )),
    );
    await send(live, randomUUID(), 'APP_AI_REVOKED');
    check('revoked window cannot make a new request', calls === 2);
    await grant(5);
    await openSettings();
    await until('development check ready', () =>
      exec('!document.querySelector("[data-testid=test-model-connection]").disabled'),
    );
    holdNext = true;
    await click('[data-testid=test-model-connection]');
    await until('held development request', () => held);
    await click('[aria-label="关闭窗口"]');
    check(
      'revocation remains enabled in the UI during global development busy state',
      await exec('!document.querySelector("[data-testid=revoke-app-ai]").disabled'),
    );
    await click('[data-testid=revoke-app-ai]');
    await panelStatus('revoked');
    check(
      'revocation remains available while another development operation holds the IPC gate',
      appAi.state(id).status === 'revoked',
    );
    release!();
    await until(
      'unrelated development check settled',
      () => models.usage().unknownUsageCalls === 0,
    );
    check('unrelated development check completes normally', models.usage().calls === 1);
    await grant(5);
    const oldConnection = appAi.state(id).grant!.connection.id;
    await invoke('saveProvider', {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash-new',
      maxCalls: 10,
      maxTokens: 100000,
    });
    await panelStatus('stale');
    check(
      'connection changes invalidate authorization without transferring it',
      appAi.state(id).grant!.connection.id === oldConnection &&
        appAi.state(id).connection.id !== oldConnection,
    );
    await send(live, randomUUID(), 'APP_AI_STALE');
    check('stale authorization blocks application dispatch', calls === 3);
    check(
      'current and granted connection labels distinguish the stale model',
      await exec(
        'document.querySelector("[data-testid=app-ai-current-connection]").textContent.includes("deepseek-flash-new") && !document.querySelector("[data-testid=app-ai-granted-connection]").textContent.includes("deepseek-flash-new")',
      ),
    );
    await grant(5);
    check(
      'regrant uses the current connection and preserves all reservations',
      appAi.state(id).grant!.connection.id === appAi.state(id).connection.id &&
        appAi.state(id).usage.calls === 2,
    );
    const secondRequest = randomUUID();
    await send(live, secondRequest, answer);
    check(
      'explicit regrant allows the current application to make one new call',
      calls === 4 && appAi.state(id).usage.calls === 3,
    );
    check(
      'private business data is unchanged throughout AI operations',
      appData.get(id).values.private === privateText,
    );
    saved = {
      projectId: id,
      buildId,
      requestId: secondRequest,
      calls: appAi.state(id).usage.calls,
      budgetTokens: appAi.state(id).budgetTokens,
      developmentCalls: models.usage().calls,
    };
    writeFileSync(join(output, 'saved.json'), JSON.stringify(saved, null, 2));
  } else if (phase === 'reopen') {
    saved = JSON.parse(readFileSync(join(output, 'saved.json'), 'utf8'));
    const state = appAi.state(saved.projectId);
    check(
      'restart does not open an application or call a model',
      calls === 0 && previews.applicationState(saved.projectId).status === 'stopped',
    );
    check(
      'project grant, settled usage and unknown reservations survive restart',
      state.status === 'authorized' &&
        state.usage.calls === saved.calls &&
        state.budgetTokens === saved.budgetTokens &&
        state.usage.unknownUsageCalls === 1,
    );
    check(
      'development token budget and usage survive restart independently',
      models.settings().maxTokens === 100000 && models.usage().calls === saved.developmentCalls,
    );
    await openPlan(store.get(saved.projectId));
    await panelStatus('authorized');
    check(
      'authorization panel renders once after fresh process startup',
      await exec('document.querySelectorAll("[data-testid=app-ai-state]").length===1'),
    );
    const live = await open(saved.projectId, saved.buildId);
    await send(live, saved.requestId, 'APP_AI_REQUEST_RECORDED');
    check(
      'restart never recharges a previously recorded request',
      calls === 0 && appAi.state(saved.projectId).usage.calls === saved.calls,
    );
    await invoke('closeApplication', { projectId: saved.projectId });
    check(
      'closing local application retains authorization and usage',
      appAi.state(saved.projectId).status === 'authorized' &&
        appAi.state(saved.projectId).usage.calls === saved.calls,
    );
    await exec('document.querySelector("[data-testid=app-ai-details]").open=true;true');
    await capture('app-ai-reopen-1440.png', 1440, 1000, '[data-testid=app-ai-state]');
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('home', () => exec('!!document.querySelector(".idea-composer")'));
    await capture('homepage-1440.png', 1440, 960);
    check(
      'new authorization controls preserve the single-input homepage',
      await exec('document.querySelectorAll(".idea-composer textarea").length===1'),
    );
  } else {
    check(
      'legacy unknown usage is migrated without resetting it',
      models.settings().legacyUnknownUsageCalls === 2 && models.usage().calls === 3,
    );
    await until('initial home', () => exec('!!document.querySelector(".idea-composer")'));
    await openSettings();
    check(
      'legacy unknown usage disables the token limit toggle and explains why',
      await exec(
        'document.querySelector("[data-testid=development-token-toggle]").disabled && !!document.querySelector("[data-testid=legacy-token-warning]")',
      ),
    );
    check(
      'legacy unknown usage leaves the call limit editable',
      await exec('!document.querySelector("[data-testid=development-call-limit]").disabled'),
    );
    await capture('legacy-unknown-1024.png', 1024, 720, '[data-testid=legacy-token-warning]');
    check('viewing legacy settings makes no model request', calls === 0);
  }
  await previews.stopAll();
  writeFileSync(
    join(output, `app-ai-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        syntheticRequests: calls,
        realProviderRequests: 0,
        versions: process.versions,
        limitations: [
          'Synthetic fetch through real ModelService; no paid provider request.',
          'macOS arm64 Electron only; protocol attack cases have separate evidence.',
          'The generated form is a synthetic fixture, not full blog acceptance.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`App AI ${phase}: ${checks.length} checks passed`);
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
