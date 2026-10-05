import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import { AppError } from '../src/main/validation';
import type { ApiResult, Project } from '../src/shared/contracts';
import type { GapReport, GapEvidenceRequest } from '../src/shared/gap-contracts';
import type { BuildResult } from '../src/shared/build-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks.push(name);
};
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const syntheticKey = 'gap-report-synthetic-key-no-account';
const privateSentinel = '私有业务值不应出现在报告-合成哨兵';
const requirement = {
  summary: '个人任务清单',
  audience: '自己',
  features: ['新增任务', '删除任务'],
  pages: ['任务列表'],
  data: ['任务'],
  outOfScope: ['公网'],
  questions: [],
  acceptance: ['新增后可见', '关闭重开后保留'],
};
const design = {
  direction: '浅色清单',
  palette: ['#ffffff', '#24372f'],
  pages: [{ name: '任务列表', sections: ['标题', '任务表单'] }],
  notes: [],
};
const source = `import {useState} from 'react';
export default function App(){const [title,setTitle]=useState(''),[tasks,setTasks]=useState([]);return <main style={{maxWidth:680,margin:'60px auto',fontFamily:'system-ui'}}><h1>任务清单</h1><form onSubmit={e=>{e.preventDefault();setTasks([...tasks,title]);setTitle('')}}><label>任务<input data-testid="task-title" value={title} onChange={e=>setTitle(e.target.value)}/></label><button data-testid="add-task" disabled={!title}>新增任务</button></form><ul data-testid="task-list">{tasks.map((item,i)=><li key={i}>{item}</li>)}</ul></main>}`;
const observation = {
  steps: '打开清单，输入一项测试任务并点击新增。',
  expected: '列表应新增一项任务。',
  actual: '列表中出现一项新任务。',
};
type Saved = {
  projectId: string;
  otherId: string;
  emptyId: string;
  planRunId: string;
  buildId: string;
  historyCount: number;
  evidenceHash: string;
  protected: Record<string, string>;
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
      throw new Error('Gap report smoke must never call a model');
    },
  });
  const { window, store, plans, sources, sourceTools, models, appData, gaps, previews } = desktop;
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
    const deadline = Date.now() + 15000;
    do {
      if (await predicate()) return;
      await delay(40);
    } while (Date.now() < deadline);
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
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    );
    await delay(40);
  };
  const select = async (selector: string, value: string) => {
    await exec(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
    );
    await delay(40);
  };
  const report = (id: string) => invoke<GapReport>('gapReport', { projectId: id });
  const row = (id: string) => `[data-testid=gap-row][data-task-id="${id}"]`;
  const ready = () =>
    until('gap report ready', () =>
      exec(
        '!!document.querySelector("[data-testid=gap-report]") && document.querySelector("[data-testid=gap-report]").getAttribute("aria-busy")==="false"',
      ),
    );
  const selectProject = async (project: Project) => {
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
    await ready();
  };
  const openPlan = async (project: Project) => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await selectProject(project);
  };
  const refresh = async () => {
    await ready();
    await click('[data-testid=refresh-gap-report]');
    await ready();
  };
  const openForm = async (taskId: string) => {
    await click(`${row(taskId)} [data-testid=open-gap-evidence]`);
    await until('row form', () =>
      exec(
        `!!document.querySelector(${JSON.stringify(row(taskId) + ' [data-testid=gap-evidence-form]')})`,
      ),
    );
  };
  const fillForm = async (verdict: string, data = observation) => {
    await select('[data-testid=gap-verdict]', verdict);
    await fill('[data-testid=gap-steps]', data.steps);
    await fill('[data-testid=gap-expected]', data.expected);
    await fill('[data-testid=gap-actual]', data.actual);
  };
  const saveForm = async () => {
    await click('[data-testid=save-gap-evidence]');
    await until('saved record notice', () =>
      exec(
        '!!document.querySelector("[data-testid=gap-notice]") && !document.querySelector("[data-testid=gap-evidence-form]")',
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
    await delay(120);
    check(
      `${file} has no horizontal overflow`,
      await exec('document.documentElement.scrollWidth<=innerWidth'),
    );
    writeFileSync(join(output, file), (await window.webContents.capturePage()).toPNG());
  };
  const createProject = (name: string) => {
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
  const setSource = (
    id: string,
    planRunId: string,
    suffix = '',
    mapping: 'valid' | 'invalid' | 'absent' = 'valid',
  ) => {
    const snapshot = sources.get(id),
      old = snapshot.files.find((file) => file.path === 'src/requirements.json');
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
              expectedHash:
                snapshot.files.find((file) => file.path === 'src/app.tsx')?.sha256 ?? null,
              content: source + suffix,
            },
            ...(mapping === 'absent'
              ? old
                ? [{ operation: 'delete' as const, path: old.path, expectedHash: old.sha256 }]
                : []
              : [
                  {
                    operation: 'write' as const,
                    path: 'src/requirements.json',
                    expectedHash: old?.sha256 ?? null,
                    content:
                      mapping === 'invalid'
                        ? '{"schemaVersion":1,"untrusted":"invalid-map"}'
                        : JSON.stringify({
                            schemaVersion: 1,
                            planRunId,
                            requirements: [
                              { taskId: 'F001', files: ['src/app.tsx'] },
                              { taskId: 'F002', files: ['src/not-implemented.tsx'] },
                            ],
                          }),
                  },
                ]),
          ],
        },
      },
    );
    assert.ok(result.ok, 'source fixture uses real constrained transactions');
  };
  const build = async (id: string, planRunId: string) => {
    const result = await invoke<BuildResult>('buildSource', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: id,
      planRunId,
      sourceRevision: sources.get(id).revision,
    });
    assert.equal(result.status, 'succeeded');
    return result.state.artifact!.id;
  };
  const evidenceFile = (id: string) =>
    join(store.rootPath, 'projects', id, 'runs/gap-evidence.json');
  const protectedHashes = (id: string) =>
    Object.fromEntries(
      [
        join(store.rootPath, 'projects', id, 'source/workspace.json'),
        join(store.rootPath, 'projects', id, 'data/generated/state.json'),
        join(store.rootPath, 'credentials/provider.json'),
      ].map((file) => [file, hash(readFileSync(file))]),
    );
  const makeRequest = (
    current: GapReport,
    taskId: string,
    verdict: GapEvidenceRequest['verdict'] = 'failed',
  ): GapEvidenceRequest => ({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: current.projectId,
    binding: current.binding!,
    taskId,
    verdict,
    filePaths: [],
    ...observation,
  });
  let saved: Saved;
  if (phase === 'create') {
    const empty = store.create({ name: '尚无计划的报告', idea: '只读差距状态' });
    await openPlan(empty);
    check(
      'planless project shows an empty report without creating evidence storage',
      (await report(empty.id)).status === 'empty' &&
        !existsSync(evidenceFile(empty.id)) &&
        (await exec(
          'document.querySelector("[data-testid=gap-report]").textContent.includes("整理开发计划后")',
        )),
    );
    const other = createProject('旧绑定验证项目');
    const otherRunId = plans.get(other.id).run!.id;
    setSource(other.id, otherRunId, '', 'absent');
    const project = createProject('逐项差距报告验证');
    const id = project.id,
      planRunId = plans.get(id).run!.id;
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: syntheticKey,
      maxCalls: 10,
      maxTokens: 100000,
    });
    appData.apply(id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: [{ operation: 'put', key: 'private', value: privateSentinel }],
    });
    await openPlan(project);
    const initial = await report(id);
    check(
      'report includes every confirmed plan row in the original order with no auto-verdict',
      initial.rows.length === plans.get(id).run!.plan.tasks.length &&
        initial.rows.every(
          (item) => item.verification === 'not_run' && item.implementation === 'unlinked',
        ) &&
        initial.build === null,
    );
    await openForm('F001');
    await fillForm('passed');
    check(
      'passed verdict needs a current build and at least one source file',
      await exec('document.querySelector("[data-testid=save-gap-evidence]").disabled'),
    );
    await click(`${row('F001')} [data-testid=open-gap-evidence]`);
    setSource(id, planRunId);
    await openPlan(project);
    check(
      'all four plan categories are shown without completion percentage',
      await exec(
        'document.querySelectorAll(".gap-group").length===4&&document.querySelectorAll("[data-testid=gap-row]").length===6&&!document.querySelector("[data-testid=gap-report]").textContent.includes("%")',
      ),
    );
    const mapped = await report(id);
    check(
      'existing paths and missing declared paths remain clues without declaring business completion',
      mapped.mapping === 'valid' &&
        mapped.rows.find((item) => item.id === 'F001')!.files[0]!.path === 'src/app.tsx' &&
        mapped.rows
          .find((item) => item.id === 'F002')!
          .missingPaths.includes('src/not-implemented.tsx') &&
        mapped.rows.every(
          (item) => item.verification === 'not_run' && item.implementation !== 'missing',
        ),
    );
    check(
      'UI explicitly calls absent paths clues and does not display implementation source indexes',
      await exec(
        `document.querySelector(${JSON.stringify(row('F002'))}).textContent.includes('声明中未找到的路径（线索）')&&!document.querySelector('[data-testid=gap-report]').textContent.includes('requirements.features[0]')`,
      ),
    );
    await until('build button enabled', () =>
      exec('!document.querySelector("[data-testid=build-source]").disabled'),
    );
    await click('[data-testid=build-source]');
    await until('build automatically refreshes report', () =>
      exec(
        'document.querySelector("[data-testid=gap-technical]").textContent.includes("已编译") && !document.querySelector("[data-testid=refresh-gap-report]").disabled',
      ),
    );
    const built = await report(id);
    const buildId = built.build!.id;
    check(
      'actual UI build updates independent evidence without passing any requirement',
      !!built.build && built.rows.every((item) => item.verification === 'not_run'),
    );
    await until('runtime check button enabled after build preview', () =>
      exec('!document.querySelector("[data-testid=check-runtime]").disabled'),
    );
    await click('[data-testid=check-runtime]');
    await until('startup automatically refreshes report', () =>
      exec(
        'document.querySelector("[data-testid=gap-technical]").textContent.includes("启动观察期未发现错误") && !document.querySelector("[data-testid=refresh-gap-report]").disabled',
      ),
    );
    check(
      'actual startup observation never becomes automatic business success',
      (await report(id)).rows.every((item) => item.verification === 'not_run') &&
        (await exec(
          'document.querySelector("[data-testid=gap-technical]").textContent.includes("不会自动将任何需求标记为通过")',
        )),
    );
    await invoke('openPreview', { projectId: id, buildId });
    const live = previews.previewWindow(id)!;
    await fill('[data-testid=task-title]', '合成测试任务', live);
    await click('[data-testid=add-task]', live);
    check(
      'test actually operates generated UI before recording a passed observation',
      await live.webContents.executeJavaScript(
        'document.querySelector("[data-testid=task-list]").children.length===1',
      ),
    );
    check(
      'generated UI has no factory evidence bridge or Node access',
      await live.webContents.executeJavaScript(
        'typeof window.factory==="undefined"&&typeof require==="undefined"',
      ),
    );
    const protectedBefore = protectedHashes(id);
    await openForm('F001');
    check(
      'expanded review form receives keyboard focus and starts with required fields',
      await exec(
        'document.activeElement===document.querySelector("[data-testid=gap-evidence-form] h6")&&document.querySelector("[data-testid=save-gap-evidence]").disabled',
      ),
    );
    await fillForm('passed');
    await click('[data-testid=gap-file][value="src/app.tsx"]');
    check(
      'even compiled source cannot be marked passed without an associated file',
      await exec('document.querySelector("[data-testid=save-gap-evidence]").disabled'),
    );
    await click('[data-testid=gap-file][value="src/app.tsx"]');
    check(
      'recording UI warns against API keys and private business values',
      await exec(
        'document.querySelector("[data-testid=gap-evidence-form]").textContent.includes("不要填写 API Key、凭据或个人业务内容")',
      ),
    );
    await capture('gap-review-1440.png', 1440, 1000, '[data-testid=gap-evidence-form]');
    await capture('gap-review-1024.png', 1024, 720, '[data-testid=save-gap-evidence]');
    await saveForm();
    const pass = await report(id);
    check(
      'explicit user submission marks only the selected requirement passed',
      pass.historyCount === 1 &&
        pass.rows.find((item) => item.id === 'F001')!.verification === 'passed' &&
        pass.rows.filter((item) => item.verification === 'passed').length === 1 &&
        pass.rows.find((item) => item.id === 'F001')!.record!.origin === 'user',
    );
    check(
      'saved user record is announced and keyboard focused',
      await exec(
        'document.activeElement===document.querySelector("[data-testid=gap-notice]")&&document.querySelector("[data-testid=gap-notice]").textContent.includes("用户核验")',
      ),
    );
    await openForm('F002');
    await fillForm('missing', {
      steps: '查看任务列表可用操作。',
      expected: '任务旁应有删除入口。',
      actual: '没有找到删除入口，确认尚缺实现。',
    });
    await saveForm();
    check(
      'user can record confirmed missing implementation without a fabricated file',
      (await report(id)).rows.find((item) => item.id === 'F002')!.implementation === 'missing',
    );
    await new Promise<void>((done) => {
      live.webContents.once('did-finish-load', () => done());
      live.webContents.reload();
    });
    await until('actual preview reloaded', () =>
      live.webContents.executeJavaScript('!!document.querySelector("[data-testid=task-list]")'),
    );
    check(
      'test observes a real failing persistence interaction instead of inventing success',
      await live.webContents.executeJavaScript(
        'document.querySelector("[data-testid=task-list]").children.length===0',
      ),
    );
    await openForm('A002');
    await fillForm('failed', {
      steps: '新增一项测试任务，然后重新打开页面。',
      expected: '任务应保留。',
      actual: '重新打开页面后任务列表为空。',
    });
    await saveForm();
    check(
      'failed user observation remains separate from current successful startup evidence',
      (await report(id)).rows.find((item) => item.id === 'A002')!.verification === 'failed' &&
        (await report(id)).runtime?.status === 'observed',
    );
    await select('[data-testid=gap-filter]', 'passed');
    check(
      'status filter shows only current user-passed rows',
      await exec(
        'document.querySelectorAll("[data-testid=gap-row]").length===1&&document.querySelector("[data-testid=gap-row]").dataset.taskId==="F001"',
      ),
    );
    await select('[data-testid=gap-filter]', 'missing');
    check(
      'missing filter shows only user-confirmed missing row',
      await exec(
        'document.querySelectorAll("[data-testid=gap-row]").length===1&&document.querySelector("[data-testid=gap-row]").dataset.taskId==="F002"',
      ),
    );
    await select('[data-testid=gap-filter]', 'all');
    await capture('gap-report-1440.png', 1440, 1000, '[data-testid=gap-technical]');
    check(
      'user evidence does not mutate source business data or model credential ledgers',
      JSON.stringify(protectedHashes(id)) === JSON.stringify(protectedBefore),
    );
    check(
      'workbench report contains neither private business content nor synthetic credentials',
      await exec(
        `!${JSON.stringify([privateSentinel, syntheticKey])}.some(value=>document.querySelector('[data-testid=gap-report]').textContent.includes(value))`,
      ),
    );
    const secret = await raw('recordGapEvidence', {
      ...makeRequest(await report(id), 'D001'),
      actual: syntheticKey,
    });
    check(
      'credential-shaped user evidence is rejected without echoing its value',
      !secret.ok &&
        secret.error.code === 'GAP_EVIDENCE_SENSITIVE' &&
        !secret.error.message.includes(syntheticKey) &&
        (await report(id)).historyCount === 3,
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
    await stranger.loadURL('data:text/html,<p>untrusted renderer</p>');
    for (const method of ['gapReport', 'recordGapEvidence']) {
      const result = (await stranger.webContents.executeJavaScript(
        `window.factory[${JSON.stringify(method)}](${JSON.stringify({ projectId: id })})`,
      )) as ApiResult<unknown>;
      check(
        `untrusted renderer cannot call ${method}`,
        !result.ok && result.error.code === 'FORBIDDEN',
      );
    }
    stranger.destroy();
    const injected = await raw('recordGapEvidence', {
      ...makeRequest(await report(id), 'D001'),
      path: '/tmp/forged-evidence.json',
    });
    check(
      'renderer cannot supply an evidence storage path',
      !injected.ok && injected.error.code === 'INVALID_INPUT',
    );
    const originalRecord = gaps.record.bind(gaps);
    const proxy = gaps as unknown as { record: (input: unknown) => unknown };
    const submitted: GapEvidenceRequest[] = [];
    proxy.record = (value) => {
      submitted.push(structuredClone(value as GapEvidenceRequest));
      const result = originalRecord(value);
      if (submitted.length === 1)
        throw new AppError(
          'GAP_EVIDENCE_COMMIT_UNCERTAIN',
          '用户核验回执尚未确认，请保留原请求核对。',
        );
      return result;
    };
    await openForm('F001');
    await fillForm('passed', { ...observation, actual: '再次操作后，列表新增一项。' });
    await click('[data-testid=save-gap-evidence]');
    await until('uncertain receipt', () =>
      exec(
        'document.querySelector("[data-testid=gap-save-error]")?.textContent.includes("回执尚未确认")',
      ),
    );
    check(
      'post-commit error retains original payload and does not automatically resubmit',
      submitted.length === 1 &&
        (await report(id)).historyCount === 4 &&
        (await exec(
          'document.querySelector("[data-testid=save-gap-evidence]").textContent==="核对原请求"',
        )),
    );
    const uncertainId = submitted[0]!.requestId;
    setSource(id, planRunId, '\n// 源码已经改变，旧核验必须过期');
    await refresh();
    check(
      'source edit expires old user verdicts while preserving all records',
      (await report(id)).rows
        .filter((item) => item.record)
        .every((item) => item.verification === 'stale') && (await report(id)).historyCount === 4,
    );
    check(
      'immutable original-request reconciliation remains available after source binding changes',
      await exec(
        '!document.querySelector("[data-testid=save-gap-evidence]").disabled&&document.querySelector("[data-testid=gap-pending-request]").textContent.includes("不把旧核验当作当前结论")',
      ),
    );
    await selectProject(other);
    await selectProject(project);
    await openForm('F001');
    check(
      'uncertain request survives project navigation without an automatic write',
      submitted.length === 1 &&
        (await exec(
          'document.querySelector("[data-testid=gap-actual]").value==="再次操作后，列表新增一项。"&&document.querySelector("[data-testid=save-gap-evidence]").textContent==="核对原请求"',
        )),
    );
    await saveForm();
    check(
      'manual replay uses identical request identity and payload without appending a record',
      submitted.length === 2 &&
        (await exec(
          'document.querySelector("[data-testid=gap-notice]").textContent.includes("记录属于旧版本")',
        )) &&
        submitted[1]!.requestId === uncertainId &&
        JSON.stringify(submitted[0]) === JSON.stringify(submitted[1]) &&
        (await report(id)).historyCount === 4 &&
        (await report(id)).rows.find((item) => item.id === 'F001')!.verification === 'stale',
    );
    proxy.record = originalRecord;
    await select('[data-testid=gap-filter]', 'stale');
    check(
      'expired filter keeps old observations visible without current passed badges',
      await exec(
        'document.querySelectorAll("[data-testid=gap-row]").length===3&&!document.querySelector("[data-testid=gap-row][data-verification=passed]")',
      ),
    );
    await select('[data-testid=gap-filter]', 'all');
    await capture('gap-stale-1024.png', 1024, 720, row('F001'));
    await openForm('F001');
    await fillForm('passed');
    const finalBuildId = await build(id, planRunId);
    await refresh();
    check(
      'new build does not silently rebind an already-open evidence draft',
      await exec(
        'document.querySelector("[data-testid=rebind-gap-evidence]")!==null&&document.querySelector("[data-testid=save-gap-evidence]").disabled',
      ),
    );
    await click('[data-testid=rebind-gap-evidence]');
    check(
      'explicit recheck on current binding resets the verdict',
      await exec('document.querySelector("[data-testid=gap-verdict]").value===""'),
    );
    await select('[data-testid=gap-verdict]', 'passed');
    await saveForm();
    check(
      'fresh user check on new source and build appends a distinct current record',
      (await report(id)).historyCount === 5 &&
        (await report(id)).rows.find((item) => item.id === 'F001')!.verification === 'passed' &&
        (await report(id)).rows.find((item) => item.id === 'F001')!.record!.request.requestId !==
          uncertainId,
    );
    let release!: () => void,
      waiting = false;
    proxy.record = async (value) => {
      const result = originalRecord(value);
      waiting = true;
      await new Promise<void>((done) => {
        release = done;
      });
      return result;
    };
    await openForm('D001');
    await fillForm('failed', {
      steps: '检查任务的保存方式。',
      expected: '任务应写入本地持久数据。',
      actual: '当前清单仅保留在页面状态中。',
    });
    await click('[data-testid=save-gap-evidence]');
    await until('record response held', () => waiting);
    check(
      'saving evidence excludes parallel source generation locally',
      await exec('document.querySelector("[data-testid=generate-source]").disabled'),
    );
    const busy = await raw('archiveProject', { projectId: id, archived: true });
    check('trusted IPC also excludes a concurrent archive', !busy.ok && busy.error.code === 'BUSY');
    await selectProject(other);
    release();
    await delay(150);
    check(
      'late save result from another project never replaces the selected report or notice',
      (await exec(
        '!document.querySelector("[data-testid=gap-notice]")&&document.querySelectorAll("[data-testid=gap-record]").length===0',
      )) && (await report(other.id)).historyCount === 0,
    );
    proxy.record = originalRecord;
    check(
      'late committed record remains durably associated with its original project',
      (await report(id)).historyCount === 6,
    );
    const oldOther = await report(other.id),
      oldRequest = makeRequest(oldOther, 'F001');
    let changed = store.saveRequirements(other.id, {
      ...requirement,
      features: [...requirement.features, '搜索任务'],
    });
    await openPlan(changed);
    check(
      'changed confirmation makes report stale and prevents a fresh user save',
      (await report(other.id)).status === 'stale' &&
        !(await report(other.id)).writable &&
        (await exec('!!document.querySelector("[data-testid=gap-stale]")')),
    );
    await openForm('F001');
    await fillForm('failed');
    check(
      'stale report disables new evidence submissions',
      await exec('document.querySelector("[data-testid=save-gap-evidence]").disabled'),
    );
    const rejected = await raw('recordGapEvidence', oldRequest);
    check(
      'backend rejects an old uncommitted request without fabricating evidence',
      !rejected.ok &&
        rejected.error.code === 'GAP_STALE' &&
        (await report(other.id)).historyCount === 0,
    );
    changed = store.approveRequirements(other.id, changed.requirements.at(-1)!.id);
    changed = store.saveDesign(other.id, design);
    changed = store.approveDesign(other.id, changed.designs.at(-1)!.id);
    plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: other.id,
      requirementId: changed.requirements.at(-1)!.id,
      designId: changed.designs.at(-1)!.id,
      profile: 'web',
    });
    check(
      'new plan still refuses source bound to a former confirmed plan',
      (await report(other.id)).status === 'stale' && !(await report(other.id)).writable,
    );
    const newOtherRun = plans.get(other.id).run!.id;
    setSource(other.id, newOtherRun, '', 'invalid');
    await openPlan(changed);
    check(
      'invalid optional mapping does not hide plan rows or block manual evidence',
      (await report(other.id)).mapping === 'invalid' &&
        (await report(other.id)).rows.length === 7 &&
        (await report(other.id)).writable &&
        (await exec(
          'document.querySelector("[data-testid=gap-mapping]").textContent.includes("不能据此认定功能缺失")',
        )),
    );
    const archived = await invoke<Project>('archiveProject', { projectId: id, archived: true });
    await openPlan(archived);
    await openForm('F001');
    await fillForm('failed');
    check(
      'archived records remain readable while new submissions are disabled',
      (await exec('document.querySelector("[data-testid=save-gap-evidence]").disabled')) &&
        (await report(id)).historyCount === 6,
    );
    const archivedResult = await raw('recordGapEvidence', makeRequest(await report(id), 'F001'));
    check(
      'trusted backend also denies newly created evidence for an archived project',
      !archivedResult.ok && archivedResult.error.code === 'ARCHIVED',
    );
    await invoke('archiveProject', { projectId: id, archived: false });
    saved = {
      projectId: id,
      otherId: other.id,
      emptyId: empty.id,
      planRunId,
      buildId: finalBuildId,
      historyCount: 6,
      evidenceHash: hash(readFileSync(evidenceFile(id))),
      protected: protectedHashes(id),
    };
    writeFileSync(join(output, 'saved.json'), JSON.stringify(saved, null, 2));
    await window.loadFile(resolve('dist/renderer/index.html'));
    await until('home', () => exec('!!document.querySelector("[data-testid=idea-home]")'));
    await capture('homepage-1440.png', 1440, 960);
    await capture('homepage-1024.png', 1024, 720);
    check(
      'light homepage retains one central input and project sidebar without gap report clutter',
      await exec(
        'document.querySelectorAll("#idea-input").length===1&&document.querySelectorAll(".project-item").length===3&&!document.querySelector("[data-testid=gap-report]")',
      ),
    );
  } else {
    saved = JSON.parse(readFileSync(join(output, 'saved.json'), 'utf8'));
    const current = await report(saved.projectId);
    check(
      'fresh process retains immutable evidence bytes and all user records',
      current.historyCount === saved.historyCount &&
        hash(readFileSync(evidenceFile(saved.projectId))) === saved.evidenceHash,
    );
    check(
      'current user verdict and older expired verdicts survive restart',
      current.rows.find((item) => item.id === 'F001')!.verification === 'passed' &&
        current.rows.find((item) => item.id === 'F002')!.verification === 'stale' &&
        current.rows.find((item) => item.id === 'D001')!.verification === 'failed',
    );
    check(
      'restart preserves source business data and model credentials byte for byte',
      JSON.stringify(protectedHashes(saved.projectId)) === JSON.stringify(saved.protected),
    );
    check(
      'startup does not generate evidence, reopen an application or call a model',
      modelCalls === 0 &&
        previews.applicationState(saved.projectId).status === 'stopped' &&
        current.historyCount === 6,
    );
    check(
      'other project invalid mapping remains independent and has no transplanted user records',
      (await report(saved.otherId)).mapping === 'invalid' &&
        (await report(saved.otherId)).historyCount === 0,
    );
    check(
      'empty project report still does not create storage after restart',
      (await report(saved.emptyId)).status === 'empty' && !existsSync(evidenceFile(saved.emptyId)),
    );
    await openPlan(store.get(saved.projectId));
    check(
      'reopened UI labels saved checks as user evidence and expired records as old',
      await exec(
        `document.querySelector(${JSON.stringify(row('F001'))}).textContent.includes('用户核验通过')&&document.querySelector(${JSON.stringify(row('F002'))}).textContent.includes('旧核验已过期')`,
      ),
    );
    await capture('gap-reopened-1440.png', 1440, 1000, row('F001'));
    await capture('gap-reopened-1024.png', 1024, 720, row('F001'));
    const first = current.rows.find((item) => item.id === 'F001')!.record!.request;
    const replay = await invoke<GapReport>('recordGapEvidence', first);
    check(
      'repeating a persisted identical request in a fresh process does not append evidence',
      replay.historyCount === 6 &&
        hash(readFileSync(evidenceFile(saved.projectId))) === saved.evidenceHash,
    );
    const conflicts = await raw('recordGapEvidence', {
      ...first,
      actual: '同一标识不能用于不同结果。',
    });
    check(
      'same identifier with changed observation is rejected across process restart',
      !conflicts.ok &&
        conflicts.error.code === 'REQUEST_CONFLICT' &&
        (await report(saved.projectId)).historyCount === 6,
    );
  }
  check('gap report and user evidence never dispatch a model request', modelCalls === 0);
  await previews.stopAll();
  writeFileSync(
    join(output, `gap-report-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        modelRequests: modelCalls,
        versions: process.versions,
        limitations: [
          'Real Electron IPC/workbench, constrained source transactions, bundled compiler and generated application interaction; all data and credentials are synthetic.',
          'A trusted post-commit error and delayed result are deliberately injected to test immutable request replay and late project response handling.',
          'The UI records user observations; these checks do not claim automatic business acceptance, Windows verification or installed-package UI validation.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Gap report ${phase}: ${checks.length} checks passed`);
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
