import { app } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import type { ApiResult } from '../src/shared/contracts';
import type { BuildResult, BuildState } from '../src/shared/build-contracts';
import type { RepairRequest, RepairState } from '../src/shared/repair-contracts';
import type { RuntimeReport, RuntimeState } from '../src/shared/runtime-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (name: string, value: unknown) => {
  assert.ok(value, name);
  checks.push(name);
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const good = `import { useState } from 'react';
export default function App(){const [n,s]=useState(0);return <main style={{fontFamily:'system-ui',textAlign:'center',padding:80,color:'#284e43'}}><h1>运行修复计数器</h1><output data-testid="counter" style={{fontSize:72,display:'block'}}>{n}</output><button data-testid="plus" onClick={()=>s(n+1)}>加一</button></main>}`;
const broken = good.replace('useState(0)', 'useState(missingInitialValue)');
const key = 'runtime-feedback-synthetic-key-no-account';
const req = {
  summary: '本地单页计数器',
  audience: '自己',
  features: ['点击加一'],
  pages: ['计数器'],
  data: ['窗口数字'],
  outOfScope: ['联网'],
  questions: [],
  acceptance: ['点击加一正确'],
};
const design = {
  direction: '浅色中央数字和按钮',
  palette: ['#ffffff'],
  pages: [{ name: '计数器', sections: ['标题', '数字', '按钮'] }],
  notes: [],
};
type Saved = {
  projectId: string;
  repair: RepairRequest;
  expectedStatus: string;
  checked: { schemaVersion: 1; requestId: string; projectId: string; buildId: string };
  hashes: Record<string, string>;
};

async function run() {
  let calls = 0;
  let repairedRevision = 0;
  const modelRequest: typeof fetch = async (_url, options) => {
    assert.equal(phase, 'create');
    calls++;
    const payload = JSON.parse(String(options?.body));
    check(
      `synthetic call ${calls} omits credentials and host paths`,
      !JSON.stringify(payload).includes(key) &&
        !JSON.stringify(payload).includes(process.env.FACTORY_TEST_DATA!),
    );
    if (calls === 1) {
      const feedback = payload.messages.find((m: { content: string }) =>
        m.content?.includes('observed_runtime_issues'),
      );
      check(
        'model receives fixed runtime feedback after actual Electron failure',
        !!feedback && feedback.content.includes('REFERENCE_ERROR'),
      );
      check(
        'runtime feedback has no raw exception message or stack',
        !feedback.content.includes('missingInitialValue') && !feedback.content.includes('stack'),
      );
    }
    const read =
      calls === 2
        ? JSON.parse(
            payload.messages.find((m: { tool_call_id: string }) => m.tool_call_id === 'read')
              .content,
          )
        : null;
    if (read) repairedRevision = read.data.revision + 1;
    const tool =
      calls === 1
        ? { id: 'read', name: 'read_file', args: { path: 'src/app.tsx' } }
        : {
            id: 'fix',
            name: 'apply_changes',
            args: {
              expectedRevision: read.data.revision,
              changes: [
                {
                  operation: 'write',
                  path: 'src/app.tsx',
                  expectedHash: read.data.file.sha256,
                  content: good,
                },
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
  const { window, store, plans, sources, sourceTools, models, previews, runtime, repairs } =
    desktop;
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
    const end = Date.now() + 18000;
    do {
      if (await predicate()) return;
      await delay(40);
    } while (Date.now() < end);
    throw new Error(`Timed out: ${name}`);
  };
  check(
    'runtime APIs are exposed without host Node access',
    await exec(
      "typeof window.factory.runtimeState==='function' && typeof window.factory.checkRuntime==='function' && typeof require==='undefined'",
    ),
  );
  check(
    'developer Node and npm are absent from the test PATH',
    process.env.PATH === '/usr/bin:/bin',
  );
  let saved: Saved;
  const recordPath = (id: string, name: string) => join(store.rootPath, 'projects', id, name);
  if (phase === 'create') {
    await delay(300);
    writeFileSync(join(output, 'home.png'), (await window.webContents.capturePage()).toPNG());
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: key,
      maxCalls: 10,
    });
    let project = store.create({ name: '运行错误反馈验证', idea: req.summary });
    project = store.saveRequirements(project.id, req);
    project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = store.saveDesign(project.id, design);
    project = store.approveDesign(project.id, project.designs.at(-1)!.id);
    const plan = plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      requirementId: project.requirements.at(-1)!.id,
      designId: project.designs.at(-1)!.id,
      profile: 'web',
    }).run!;
    const request = () => ({
      schemaVersion: 1 as const,
      requestId: randomUUID(),
      projectId: project.id,
      planRunId: plan.id,
      sourceRevision: sources.get(project.id).revision,
    });
    const write = (content: string) => {
      const prior = sources.get(project.id);
      const result = sourceTools.execute(
        { projectId: project.id, planRunId: plan.id },
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
                expectedHash: prior.files[0]?.sha256 ?? null,
                content,
              },
            ],
          },
        },
      );
      assert.ok(result.ok);
    };
    write(good);
    const first = await invoke<BuildResult>('buildSource', request());
    await invoke('openPreview', { projectId: project.id, buildId: first.state.artifact!.id });
    const old = previews.previewWindow(project.id)!;
    await old.webContents.executeJavaScript(
      'document.querySelector("[data-testid=plus]").click();true',
    );
    await delay(80);
    check(
      'baseline preview interaction works',
      await old.webContents.executeJavaScript(
        'document.querySelector("[data-testid=counter]").textContent==="1"',
      ),
    );
    const firstReport = runtime.state(project.id).report!.id;
    await invoke('openPreview', { projectId: project.id, buildId: first.state.artifact!.id });
    check(
      'reopening the same window preserves state without manufacturing evidence',
      previews.previewWindow(project.id) === old &&
        runtime.state(project.id).report!.id === firstReport,
    );
    write(broken);
    const failed = await invoke<BuildResult>('buildSource', request());
    check('undefined runtime reference passes actual compiler', failed.status === 'succeeded');
    const attempted = await raw('openPreview', {
      projectId: project.id,
      buildId: failed.state.artifact!.id,
    });
    check(
      'startup failure is returned through narrow IPC',
      !attempted.ok && attempted.error.code === 'RUNTIME_ISSUES',
    );
    check(
      'failed candidate preserves the old preview and its count',
      previews.previewWindow(project.id) === old &&
        (await old.webContents.executeJavaScript(
          'document.querySelector("[data-testid=counter]").textContent==="1"',
        )),
    );
    const issue = await invoke<RuntimeState>('runtimeState', { projectId: project.id });
    check(
      'runtime report binds actual artifact and current source',
      issue.current &&
        issue.report?.status === 'issues' &&
        issue.report.buildId === failed.state.artifact!.id &&
        issue.report.issues.includes('REFERENCE_ERROR'),
    );
    check('no model is called by preview errors', calls === 0);
    const repair: RepairRequest = { ...request(), runtimeReportId: issue.report!.id };
    await window.loadFile(resolve('dist/renderer/index.html'));
    await waitFor('project sidebar', () => exec('!!document.querySelector(".project-item")'));
    await exec('document.querySelector(".project-item").click();true');
    await waitFor('plan tab', () =>
      exec(
        'Array.from(document.querySelectorAll("[role=tab]")).some(e=>e.textContent.includes("开发计划"))',
      ),
    );
    await exec(
      'Array.from(document.querySelectorAll("[role=tab]")).find(e=>e.textContent.includes("开发计划")).click();true',
    );
    await waitFor('runtime repair button', () =>
      exec(
        '!!document.querySelector("[data-testid=repair-runtime]") && !document.querySelector("[data-testid=repair-runtime]").disabled',
      ),
    );
    await exec(
      'document.querySelector("[data-testid=runtime-state]").scrollIntoView({block:"center"});true',
    );
    await delay(400);
    writeFileSync(
      join(output, 'runtime-issues.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    window.setSize(1024, 768);
    await delay(250);
    await exec(
      'document.querySelector("[data-testid=runtime-state]").scrollIntoView({block:"center"});true',
    );
    await delay(400);
    check(
      'runtime panel fits the minimum workbench width',
      await exec(
        'document.documentElement.scrollWidth<=innerWidth && document.querySelector("[data-testid=runtime-state]").getBoundingClientRect().right<=innerWidth',
      ),
    );
    writeFileSync(
      join(output, 'runtime-issues-1024.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    window.setSize(1440, 920);
    await exec('document.querySelector("[data-testid=repair-runtime]").click();true');
    await waitFor(
      'runtime repair terminal record',
      async () => repairs.state(project.id).run?.status === 'succeeded',
    );
    const run = repairs.state(project.id).run!;
    repair.requestId = run.id;
    check(
      'UI runtime repair uses two synthetic calls and two actual builds',
      calls === 2 &&
        run.rounds === 2 &&
        run.builds === 2 &&
        run.latestRevision === repairedRevision,
    );
    check(
      'runtime repair stores an independently observed check',
      runtime.get(project.id, run.runtimeResultId!)?.status === 'observed',
    );
    check(
      'hidden runtime repair preserves prior visible preview',
      previews.previewWindow(project.id) === old && !old.isDestroyed(),
    );
    await waitFor('runtime UI success', () =>
      exec(
        'document.querySelector("[data-testid=runtime-state]")?.textContent.includes("启动观察期未发现错误")===true',
      ),
    );
    await exec(
      'document.querySelector("[data-testid=runtime-state]").scrollIntoView({block:"center"});true',
    );
    await delay(400);
    writeFileSync(
      join(output, 'runtime-repaired.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    await invoke<BuildState>('openPreview', { projectId: project.id, buildId: run.buildId! });
    check(
      'explicit successful preview replaces the original window',
      old.isDestroyed() && previews.previewWindow(project.id) !== old,
    );
    const current = previews.previewWindow(project.id)!;
    await current.webContents.executeJavaScript(
      'document.querySelector("[data-testid=plus]").click();true',
    );
    await delay(80);
    check(
      'repaired generated application interacts correctly',
      await current.webContents.executeJavaScript(
        'document.querySelector("[data-testid=counter]").textContent==="1"',
      ),
    );
    writeFileSync(
      join(output, 'preview-repaired.png'),
      (await current.webContents.capturePage()).toPNG(),
    );
    await invoke<RuntimeReport>('checkRuntime', {
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      buildId: run.buildId!,
    });
    await current.webContents.executeJavaScript(
      `document.querySelector('[data-testid=plus]').addEventListener('click',()=>{throw new ReferenceError('synthetic-interaction-only')});document.querySelector('[data-testid=plus]').click();true`,
    );
    await waitFor(
      'post-check late interaction error',
      async () => runtime.state(project.id).report?.status === 'issues',
    );
    const late = runtime.state(project.id).report!;
    check(
      'late visible error remains visible after a newer hidden startup check',
      late.mode === 'preview' && late.issues.includes('REFERENCE_ERROR'),
    );
    const beforeRepro = hash(readFileSync(recordPath(project.id, 'source/workspace.json')));
    const nonReproduced: RepairRequest = { ...request(), runtimeReportId: late.id };
    await waitFor('late issue repair enabled', () =>
      exec(
        '!!document.querySelector("[data-testid=repair-runtime]") && !document.querySelector("[data-testid=repair-runtime]").disabled',
      ),
    );
    await exec('document.querySelector("[data-testid=repair-runtime]").click();true');
    await waitFor(
      'unreproduced result',
      async () => repairs.state(project.id).run?.errorCode === 'RUNTIME_NOT_REPRODUCED',
    );
    const nonRepro = repairs.state(project.id);
    nonReproduced.requestId = nonRepro.run!.id;
    check(
      'interaction-only failure is not falsely reported repaired by a clean startup',
      nonRepro.run?.status === 'no_progress' &&
        nonRepro.run.errorCode === 'RUNTIME_NOT_REPRODUCED' &&
        nonRepro.run.rounds === 0,
    );
    check(
      'nonreproducing fault retains source and spends no additional model requests',
      calls === 2 &&
        hash(readFileSync(recordPath(project.id, 'source/workspace.json'))) === beforeRepro,
    );
    await waitFor('explicit unreproduced UI', () =>
      exec(
        'document.querySelector("[data-testid=repair-state]")?.textContent.includes("尚未验证原交互错误")===true',
      ),
    );
    const checked = {
      schemaVersion: 1 as const,
      requestId: randomUUID(),
      projectId: project.id,
      buildId: nonRepro.run!.buildId!,
    };
    const inspecting = raw<RuntimeReport>('checkRuntime', checked);
    await waitFor(
      'check intent persisted',
      async () => runtime.state(project.id).report?.status === 'observing',
    );
    const busy = await raw('checkRuntime', { ...checked, requestId: randomUUID() });
    check(
      'startup inspection uses the global mutation lock',
      !busy.ok && busy.error.code === 'BUSY',
    );
    await invoke('cancelGeneration');
    const cancelled = await inspecting;
    check(
      'cancellation is recorded without success or preview replacement',
      cancelled.ok &&
        cancelled.value.status === 'cancelled' &&
        previews.previewWindow(project.id) === current,
    );
    check(
      'business plan tasks remain unaccepted',
      plans
        .get(project.id)
        .run!.plan.tasks.every(
          (task) => task.implementation === 'pending' && task.verification === 'not_run',
        ),
    );
    saved = {
      projectId: project.id,
      repair: nonReproduced,
      expectedStatus: 'no_progress',
      checked,
      hashes: {},
    };
    for (const name of [
      'project.json',
      'source/workspace.json',
      'runs/development-plans.json',
      'runs/repairs.json',
      'runs/builds.json',
      'runs/runtime-reports.json',
    ]) {
      const bytes = readFileSync(recordPath(project.id, name));
      check(
        `${name} has no credential or raw exception text`,
        !bytes.includes(Buffer.from(key)) &&
          (name !== 'runs/runtime-reports.json' ||
            !bytes.includes(Buffer.from('missingInitialValue'))),
      );
      saved.hashes[name] = hash(bytes);
    }
    writeFileSync(join(output, 'fixtures.json'), JSON.stringify(saved, null, 2));
  } else {
    saved = JSON.parse(readFileSync(join(output, 'fixtures.json'), 'utf8'));
    const repaired = await invoke<RepairState>('repairSource', saved.repair);
    check(
      'restarted repair is idempotent with zero paid replay',
      repaired.run?.status === saved.expectedStatus && calls === 0,
    );
    const replay = await invoke<RuntimeReport>('checkRuntime', saved.checked);
    check(
      'cancelled check replays its receipt instead of rerunning',
      replay.status === 'cancelled',
    );
    check(
      'restart does not open preview windows',
      previews.status(saved.projectId).preview === 'closed',
    );
    for (const [name, digest] of Object.entries(saved.hashes))
      check(
        `${name} unchanged after replay`,
        hash(readFileSync(recordPath(saved.projectId, name))) === digest,
      );
    await invoke('recoveryState', { projectId: saved.projectId });
    check('recovery validates runtime repair receipts', true);
  }
  await previews.stopAll();
  writeFileSync(
    join(output, `runtime-feedback-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        syntheticRequests: calls,
        realProviderRequests: 0,
        versions: process.versions,
        limitations: [
          'Synthetic model transport; actual native compilation and Electron startup',
          'Finite startup observation is not business acceptance; later interactions may fail',
          'macOS arm64 only',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Runtime feedback ${phase}: ${checks.length} checks passed`);
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
