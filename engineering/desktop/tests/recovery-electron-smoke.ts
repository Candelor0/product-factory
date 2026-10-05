import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import { BuildRunStore } from '../src/main/build-run-store';
import type {
  ApiResult,
  AppSnapshot,
  DesignContent,
  Project,
  RequirementContent,
} from '../src/shared/contracts';
import type { RecoveryState } from '../src/shared/recovery-contracts';

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
const baseline = (initial: number) => `import { useState } from 'react';
import './style.css';
export default function App() {
 const [count, setCount] = useState(${initial});
 return <main><p>合成检查点测试</p><h1>可恢复的计数器</h1><output data-testid="counter">{count}</output>
 <button data-testid="plus" onClick={()=>setCount(count+1)}>加一</button></main>;
}`;
const styles =
  ':root{font-family:system-ui;color:#28352e;background:#faf9f5}main{max-width:520px;margin:12vh auto;text-align:center;padding:30px}p{color:#70776f}h1{font-size:32px}output{display:block;font-size:104px;margin:36px}button{padding:12px 25px;background:white;color:#284e43;border:1px solid #ccd2cc;border-radius:8px;font-size:16px}';
const requirement: RequirementContent = {
  summary: '单页本地计数器，可在源码改动后恢复。',
  audience: '本地体验者',
  features: ['加一'],
  pages: ['计数器'],
  data: ['当前窗口临时数字'],
  outOfScope: ['外网', '登录', '持久化'],
  questions: [],
  acceptance: ['按钮正确更新数字'],
};
const design: DesignContent = {
  direction: '浅色中央数字与按钮',
  palette: ['#284E43', '#FAF9F5'],
  pages: [{ name: '计数器', sections: ['标题', '数字', '按钮'] }],
  notes: ['真实编译和交互，零模型调用。'],
};
interface SavedReport {
  projectId: string;
  hashes: Record<string, string>;
  latestBuildId: string;
  interruptedBuildId: string;
  missingProjectId: string;
  calls: number;
}
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
  const desktop = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    toolchainPath: resolve('dist/toolchain'),
    show: false,
    modelRequest: async () => {
      fetches++;
      throw new Error('Recovery must not dispatch model requests');
    },
  });
  const { window, store, models, plans, sources, sourceTools, previews, builds } = desktop;
  window.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(code: string) =>
    window.webContents.executeJavaScript(code) as Promise<T>;
  const invoke = async <T>(method: string, input?: unknown): Promise<T> => {
    const result = await exec<ApiResult<T>>(
      `window.factory[${JSON.stringify(method)}](${JSON.stringify(input)})`,
    );
    if (!result.ok) throw new Error(`${method}: ${result.error.code}`);
    return result.value;
  };
  const snapshot = await invoke<AppSnapshot>('snapshot');
  check(
    'recovery renderer exposes narrow IPC without host Node',
    await exec(
      "typeof window.factory.recoveryState==='function' && typeof window.factory.restoreCheckpoint==='function' && typeof require==='undefined' && typeof process==='undefined'",
    ),
  );
  check('test Electron PATH excludes developer Node/npm', process.env.PATH === '/usr/bin:/bin');
  const pathFor = (id: string, relative: string) => join(store.rootPath, 'projects', id, relative);
  const state = (id: string) => invoke<RecoveryState>('recoveryState', { projectId: id });
  const capture = async (name: string, target = window) => {
    await delay(180);
    writeFileSync(join(output, name), (await target.webContents.capturePage()).toPNG());
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
    await waitFor('checkpoint history', () =>
      exec('!!document.querySelector("[data-testid=checkpoint-0]")'),
    );
  };
  const previewReady = async (project: Project, initial: string) => {
    await waitFor('compiled counter render', async () => {
      const preview = previews.previewWindow(project.id);
      return (
        !!preview &&
        (await preview.webContents.executeJavaScript(
          `document.querySelector('[data-testid=counter]')?.textContent === '${initial}'`,
        ))
      );
    });
    const preview = previews.previewWindow(project.id)!;
    preview.webContents.setBackgroundThrottling(false);
    return preview;
  };
  const clickBuild = async (project: Project, initial: string) => {
    await waitFor('enabled build button', () =>
      exec(
        '!!document.querySelector("[data-testid=build-source]") && !document.querySelector("[data-testid=build-source]").disabled',
      ),
    );
    await exec('document.querySelector("[data-testid=build-source]").click();true');
    await waitFor(
      'current compiled artifact',
      async () => builds.state(project.id).status === 'current',
    );
    return previewReady(project, initial);
  };
  const selectCheckpoint = async (target: number) => {
    await exec('document.querySelector("[data-testid=checkpoint-history]").open=true;true');
    await waitFor('enabled checkpoint action', () =>
      exec(
        `!!document.querySelector('[data-testid=checkpoint-${target}] button') && !document.querySelector('[data-testid=checkpoint-${target}] button').disabled`,
      ),
    );
    await exec(`document.querySelector('[data-testid=checkpoint-${target}] button').click();true`);
    await waitFor('restore impact', () =>
      exec('!!document.querySelector("[data-testid=restore-impact]")'),
    );
  };
  const confirmRestore = async (project: Project, target: number, revision: number) => {
    await exec('document.querySelector("[data-testid=restore-checkpoint]").click();true');
    await waitFor('restored revision', async () => (await state(project.id)).revision === revision);
    await waitFor('restore success feedback', () =>
      exec(
        `document.querySelector('[data-testid=restore-success]')?.textContent.includes('版本 ${target} 的源码保存为版本 ${revision}')===true`,
      ),
    );
  };
  let project: Project;
  let latestBuildId = '';
  let interruptedBuildId = '';
  let missingProjectId = '';
  const missingBackup = join(process.env.FACTORY_TEST_DATA!, 'preserved-missing-workspace.json');
  if (phase === 'create') {
    check(
      'synthetic profile begins empty without a key or model usage',
      snapshot.projects.length === 0 && !snapshot.settings.hasKey && snapshot.usage.calls === 0,
    );
    await waitFor('central home input', () => exec("!!document.querySelector('.idea-composer')"));
    check(
      'home remains light with central idea input and sidebar',
      await exec(
        "!!document.querySelector('.idea-composer') && !!document.querySelector('.sidebar') && !document.querySelector('.project-table')",
      ),
    );
    project = store.create({ name: '检查点恢复 · 两个版本', idea: requirement.summary });
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
    const context = { projectId: project.id, planRunId: plans.get(project.id).run!.id };
    for (const initial of [0, 100]) {
      const current = sources.get(project.id);
      const response = sourceTools.execute(context, {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'apply_changes',
        arguments: {
          expectedRevision: current.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash:
                current.files.find((item) => item.path === 'src/app.tsx')?.sha256 ?? null,
              content: baseline(initial),
            },
            ...(current.revision === 0
              ? [{ operation: 'write', path: 'src/style.css', expectedHash: null, content: styles }]
              : []),
          ],
        },
      });
      assert.ok(response.ok);
    }
    const firstSnapshot = sources.at(project.id, 1);
    const secondSnapshot = sources.at(project.id, 2);
    const businessPath = pathFor(project.id, 'data/retained-articles.json');
    writeFileSync(
      businessPath,
      JSON.stringify({
        articles: [{ title: '源码版本2之后新增的文章', body: '恢复代码不得删除' }],
      }),
    );
    const businessBefore = readFileSync(businessPath);
    const projectBefore = readFileSync(pathFor(project.id, 'project.json'));
    const planBefore = readFileSync(pathFor(project.id, 'runs/development-plans.json'));
    await openPlan(project);
    const oldPreview = await clickBuild(project, '100');
    const oldBuildId = builds.state(project.id).artifact!.id;
    await selectCheckpoint(1);
    check(
      'restore impact receives keyboard focus',
      await exec(
        "document.activeElement===document.querySelector('[data-testid=restore-impact] h4')",
      ),
    );
    await exec(
      "Array.from(document.querySelectorAll('[data-testid=restore-impact] button')).find(button=>button.textContent==='取消').click();true",
    );
    await waitFor('cancelled restore focus', () =>
      exec(
        "!document.querySelector('[data-testid=restore-impact]') && document.activeElement===document.querySelector('[data-testid=checkpoint-1] button')",
      ),
    );
    check(
      'cancelling impact returns focus and leaves revision unchanged',
      sources.get(project.id).revision === 2,
    );
    await selectCheckpoint(1);
    check(
      'impact is explicit and only lists source changes',
      await exec(
        "document.querySelector('[data-testid=restore-impact]').textContent.includes('不改变业务数据') && document.querySelector('[data-testid=restore-impact]').textContent.includes('src/app.tsx')",
      ),
    );
    check('viewing restore impact does not mutate source', sources.get(project.id).revision === 2);
    for (const width of [1440, 1024]) {
      window.setContentSize(width, 900);
      await exec(
        'document.querySelector("[data-testid=restore-impact]").scrollIntoView({block:"center"});true',
      );
      await capture(`restore-impact-${width}.png`);
      check(
        `checkpoint impact has no horizontal overflow at ${width}px`,
        await exec('document.documentElement.scrollWidth <= innerWidth'),
      );
    }
    await confirmRestore(project, 1, 3);
    check(
      'successful restore receives keyboard focus',
      await exec(
        "document.activeElement===document.querySelector('[data-testid=restore-success]')",
      ),
    );
    await waitFor('source panel revision refreshed', () =>
      exec(
        "document.querySelector('[data-testid=source-files]')?.textContent.includes('版本 3')===true",
      ),
    );
    check('source panel refreshes to the new revision before rebuilding', true);
    check(
      'restored version one becomes revision three with both prior snapshots intact',
      JSON.stringify(sources.get(project.id).files) === JSON.stringify(firstSnapshot.files) &&
        JSON.stringify(sources.at(project.id, 2)) === JSON.stringify(secondSnapshot),
    );
    check(
      'restore preserves the existing preview and original successful artifact',
      previews.previewWindow(project.id) === oldPreview &&
        !oldPreview.isDestroyed() &&
        builds.state(project.id).artifact!.id === oldBuildId &&
        builds.state(project.id).status === 'stale',
    );
    const firstPreview = await clickBuild(project, '0');
    check(
      'explicit rebuild replaces preview with restored source',
      oldPreview.isDestroyed() && builds.state(project.id).artifact!.sourceRevision === 3,
    );
    await firstPreview.webContents.executeJavaScript(
      "document.querySelector('[data-testid=plus]').click();true",
    );
    await waitFor('restored counter interaction', () =>
      firstPreview.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent==='1'",
      ),
    );
    check('restored compiled counter still responds to interaction', true);
    await capture('restored-version-one-preview.png', firstPreview);
    await selectCheckpoint(0);
    await confirmRestore(project, 0, 4);
    await waitFor('empty source removes build action', () =>
      exec('!document.querySelector("[data-testid=build-source]")'),
    );
    check(
      'revision zero restoration empties source without removing prior history or closing preview',
      sources.get(project.id).files.length === 0 &&
        sources.history(project.id).length === 5 &&
        previews.previewWindow(project.id) === firstPreview,
    );
    await selectCheckpoint(2);
    await confirmRestore(project, 2, 5);
    check(
      'recovery can restore the pre-rollback version without losing any intervening snapshot',
      JSON.stringify(sources.get(project.id).files) === JSON.stringify(secondSnapshot.files) &&
        sources.history(project.id).length === 6 &&
        sources.at(project.id, 4).files.length === 0,
    );
    const finalPreview = await clickBuild(project, '100');
    await finalPreview.webContents.executeJavaScript(
      "document.querySelector('[data-testid=plus]').click();true",
    );
    await waitFor('restored second counter interaction', () =>
      finalPreview.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent==='101'",
      ),
    );
    check(
      'rebuilding the recovered pre-rollback source renders its exact counter behavior',
      firstPreview.isDestroyed() && builds.state(project.id).artifact!.sourceRevision === 5,
    );
    latestBuildId = builds.state(project.id).artifact!.id;
    for (const width of [1440, 1024]) {
      window.setContentSize(width, 900);
      await exec(
        'document.querySelector("[data-testid=recovery-state]").scrollIntoView({block:"start"});true',
      );
      await capture(`restored-history-${width}.png`);
      check(
        `restored history has no horizontal overflow at ${width}px`,
        await exec('document.documentElement.scrollWidth <= innerWidth'),
      );
    }
    check(
      'all restore and build operations preserve business data and confirmed project/plan bytes',
      readFileSync(businessPath).equals(businessBefore) &&
        readFileSync(pathFor(project.id, 'project.json')).equals(projectBefore) &&
        readFileSync(pathFor(project.id, 'runs/development-plans.json')).equals(planBefore),
    );
    let missingProject = store.create({ name: '缺失源码 · 安全停止', idea: requirement.summary });
    missingProject = store.saveRequirements(missingProject.id, requirement);
    missingProject = store.approveRequirements(
      missingProject.id,
      missingProject.requirements.at(-1)!.id,
    );
    missingProject = store.saveDesign(missingProject.id, design);
    missingProject = store.approveDesign(missingProject.id, missingProject.designs.at(-1)!.id);
    plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: missingProject.id,
      requirementId: missingProject.requirements.at(-1)!.id,
      designId: missingProject.designs.at(-1)!.id,
      profile: 'web',
    });
    missingProjectId = missingProject.id;
    const missingContext = {
      projectId: missingProjectId,
      planRunId: plans.get(missingProjectId).run!.id,
    };
    const savedSource = sourceTools.execute(missingContext, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: 0,
        changes: [
          { operation: 'write', path: 'src/app.tsx', expectedHash: null, content: baseline(7) },
          { operation: 'write', path: 'src/style.css', expectedHash: null, content: styles },
        ],
      },
    });
    assert.ok(savedSource.ok);
    await invoke('buildSource', {
      schemaVersion: 1,
      requestId: randomUUID(),
      ...missingContext,
      sourceRevision: 1,
    });
    check(
      'missing-source fixture has a real successful compiled artifact before source removal',
      builds.state(missingProjectId).status === 'current',
    );
    renameSync(pathFor(missingProjectId, 'source/workspace.json'), missingBackup);
    check(
      'missing-source fixture preserves its original source in the isolated test data backup',
      existsSync(missingBackup) && !existsSync(pathFor(missingProjectId, 'source/workspace.json')),
    );
    const now = new Date().toISOString();
    interruptedBuildId = randomUUID();
    new BuildRunStore(store).save(project.id, {
      id: interruptedBuildId,
      ...sourceTools.prepare(context).binding,
      sourceRevision: 5,
      sourceHash: hash(JSON.stringify(sources.get(project.id))),
      createdAt: now,
      updatedAt: now,
      status: 'running',
      diagnostics: [],
      errorCode: null,
    });
    check(
      'synthetic unfinished build intent is explicitly seeded for next-process reconciliation',
      JSON.parse(readFileSync(pathFor(project.id, 'runs/build-attempts.json'), 'utf8')).attempts.at(
        -1,
      ).status === 'running',
    );
  } else {
    const prior = JSON.parse(
      readFileSync(join(output, 'recovery-create.json'), 'utf8'),
    ) as SavedReport;
    project = store.get(prior.projectId);
    latestBuildId = prior.latestBuildId;
    interruptedBuildId = prior.interruptedBuildId;
    missingProjectId = prior.missingProjectId;
    check(
      'project and zero usage survive a separate process launch',
      snapshot.projects.length === 2 && snapshot.usage.calls === prior.calls,
    );
    for (const [relative, expected] of Object.entries(prior.hashes))
      check(
        `${relative} bytes survive process restart`,
        hash(readFileSync(join(store.rootPath, relative))) === expected,
      );
    const missingWorkspace = pathFor(missingProjectId, 'source/workspace.json');
    check(
      'fresh process sees missing source alongside durable build evidence',
      !existsSync(missingWorkspace) && existsSync(pathFor(missingProjectId, 'runs/builds.json')),
    );
    const backupHash = hash(readFileSync(missingBackup));
    for (const method of ['generateSource', 'buildSource', 'repairSource']) {
      const request = {
        schemaVersion: 1,
        requestId: randomUUID(),
        projectId: missingProjectId,
        planRunId: plans.get(missingProjectId).run!.id,
        ...(method === 'generateSource' ? {} : { sourceRevision: 0 }),
      };
      const rejected = await exec<ApiResult<unknown>>(
        `window.factory[${JSON.stringify(method)}](${JSON.stringify(request)})`,
      );
      check(
        `${method} fails closed before fresh work when source is missing`,
        !rejected.ok && rejected.error.code === 'RECOVERY_INCONSISTENT',
      );
      check(
        `${method} does not recreate missing source or dispatch models`,
        !existsSync(missingWorkspace) && fetches === 0 && models.usage().calls === 0,
      );
    }
    check(
      'rejected fresh work preserves the backed-up source bytes',
      hash(readFileSync(missingBackup)) === backupHash,
    );
    check(
      'no preview automatically opens after restart',
      previews.status(project.id).preview === 'closed',
    );
    const recovered = await state(project.id);
    check(
      'all checkpoints and restore metadata survive restart',
      recovered.revision === 5 &&
        recovered.checkpoints.length === 6 &&
        recovered.checkpoints[3].restoredFrom === 1 &&
        recovered.checkpoints[4].restoredFrom === 0 &&
        recovered.checkpoints[5].restoredFrom === 2,
    );
    check(
      'unfinished build intent becomes interrupted without inventing an artifact',
      recovered.runs.some(
        (item) =>
          item.id === interruptedBuildId && item.status === 'interrupted' && item.buildId === null,
      ) && builds.state(project.id).artifact!.id === latestBuildId,
    );
    await openPlan(project);
    await waitFor('interrupted recovery notice', () =>
      exec('!!document.querySelector("[data-testid=interrupted-runs]")'),
    );
    check(
      'interrupted UI explains that requests do not automatically replay',
      await exec(
        "document.querySelector('[data-testid=interrupted-runs]').textContent.includes('不会自动重发')",
      ),
    );
    await exec(
      'document.querySelector("[data-testid=checkpoint-history]").open=true; document.querySelector("[data-testid=interrupted-runs]").scrollIntoView({block:"start"});true',
    );
    await capture('reopened-interrupted-build.png');
    await waitFor('manual preview action', () =>
      exec(
        "Array.from(document.querySelectorAll('[data-testid=build-state] .build-actions button')).some(button=>button.textContent.includes('打开预览'))",
      ),
    );
    await exec(
      "Array.from(document.querySelectorAll('[data-testid=build-state] .build-actions button')).find(button=>button.textContent.includes('打开预览')).click();true",
    );
    const preview = await previewReady(project, '100');
    check(
      'manual preview opens the exact saved recovered artifact',
      previews.status(project.id).previewBuildId === latestBuildId,
    );
    await preview.webContents.executeJavaScript(
      "document.querySelector('[data-testid=plus]').click();true",
    );
    await waitFor('reopened restored counter', () =>
      preview.webContents.executeJavaScript(
        "document.querySelector('[data-testid=counter]').textContent==='101'",
      ),
    );
    check('restored source artifact remains interactive after process restart', true);
    await capture('reopened-restored-preview.png', preview);
  }
  check(
    'checking, restoring, compiling and reopening dispatch no model requests',
    fetches === 0 && models.usage().calls === 0 && models.usage().unknownUsageCalls === 0,
  );
  check(
    'restoration does not mark business acceptance complete',
    plans
      .get(project.id)
      .run!.plan.tasks.every(
        (item) => item.implementation === 'pending' && item.verification === 'not_run',
      ) && store.get(project.id).stage === 'ready',
  );
  const hashes: Record<string, string> = {};
  for (const relative of [
    'project.json',
    'source/workspace.json',
    'runs/development-plans.json',
    'runs/builds.json',
    'data/retained-articles.json',
  ])
    hashes[`projects/${project.id}/${relative}`] = hash(
      readFileSync(pathFor(project.id, relative)),
    );
  for (const relative of [
    'project.json',
    'runs/development-plans.json',
    'runs/builds.json',
    'runs/build-attempts.json',
  ])
    hashes[`projects/${missingProjectId}/${relative}`] = hash(
      readFileSync(pathFor(missingProjectId, relative)),
    );
  await previews.stopAll();
  writeFileSync(
    join(output, `recovery-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        projectId: project.id,
        hashes,
        latestBuildId,
        interruptedBuildId,
        missingProjectId,
        calls: models.usage().calls,
        mockedProviderRequests: fetches,
        realProviderRequests: 0,
        versions: process.versions,
        systemPath: process.env.PATH,
        limitations: [
          'Real Electron renderer, IPC, native compiler, preview interaction and separate process launch.',
          'Unfinished build journal is seeded as a synthetic fixture; actual process-boundary fault injection is tested separately.',
          'Business-data assertion covers independent unchanged bytes, not schema migration or database rollback.',
          'No real provider calls, Windows, clean OS or arbitrary backend execution.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Recovery ${phase}: ${checks.length} checks passed`);
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
    join(output, `recovery-${phase}-failure.json`),
    JSON.stringify({ error: String(error), checks, messages, windows }, null, 2),
  );
  app.exit(1);
});
