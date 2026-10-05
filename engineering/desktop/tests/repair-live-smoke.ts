/** Explicit live opt-in: one synthetic project, at most four paid requests, existing budget. */
import { app } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startDesktop } from '../src/main/app';
import { loadToolchain } from '../src/main/toolchain';

async function main() {
  if (process.env.FACTORY_LIVE_REPAIR !== '1')
    throw new Error('Explicit live-test opt-in required');
  const output = resolve('../../docs/evidence/2026-10-03/S3-02/bounded-repair/live');
  mkdirSync(output, { recursive: true });
  const desktop = await startDesktop({
    show: false,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    blogPath: resolve('dist/blog'),
    toolchainPath: resolve('dist/toolchain'),
  });
  const { models, store, plans, sources, sourceTools, repairs, builds, previews } = desktop;
  const settings = models.settings();
  const before = models.usage();
  if (
    !settings.hasKey ||
    settings.provider !== 'deepseek' ||
    settings.baseUrl !== 'https://api.deepseek.com' ||
    settings.maxCalls - before.calls < 4
  ) {
    writeFileSync(
      join(output, 'result.json'),
      JSON.stringify({
        status: 'skipped',
        reason:
          'Existing official DeepSeek key and four remaining calls required; settings unchanged',
      }),
    );
    app.quit();
    return;
  }
  const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const originals: { path: string; hash: string }[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) originals.push({ path, hash: digest(path) });
    }
  };
  for (const project of store.list()) collect(join(store.rootPath, 'projects', project.id));
  let project = store.create({
    name: '修复实测 · 计数器',
    idea: '独立构建修复测试：已有计数器缺失一个本地模块，修复后仍能加一、减一和归零。无网络、持久化或账号。',
  });
  project = store.saveRequirements(project.id, {
    summary: '单页计数器，初始为0，支持加一、减一、归零。',
    audience: '开发验证人员',
    features: ['加一', '减一', '归零'],
    pages: ['计数器'],
    data: [],
    outOfScope: ['网络', '持久化', '账号'],
    questions: [],
    acceptance: ['初始显示0', '加一、减一改变数字', '归零恢复0'],
  });
  project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = store.saveDesign(project.id, {
    direction: '浅色居中计数器，保留三个文字按钮和现有交互。',
    palette: ['#ffffff', '#24272b'],
    pages: [{ name: '计数器', sections: ['数字', '加一、减一、归零按钮'] }],
    notes: ['测试夹具确认，仅验证缺失模块的最小修复。'],
  });
  project = store.approveDesign(project.id, project.designs.at(-1)!.id);
  const plan = plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)!.id,
    designId: project.designs.at(-1)!.id,
    profile: 'web',
  });
  const context = { projectId: project.id, planRunId: plan.run!.id };
  const source = `import { useState } from 'react';
import { initialCount } from './initial';
export default function App() {
  const [count, setCount] = useState(initialCount);
  return <main style={{fontFamily:'system-ui',textAlign:'center',paddingTop:'20vh'}}>
    <h1>计数器</h1><output data-testid="counter-value" style={{display:'block',fontSize:72,margin:'40px'}}>{count}</output>
    <button onClick={() => setCount(count - 1)}>减一</button>{' '}
    <button onClick={() => setCount(count + 1)}>加一</button>{' '}
    <button onClick={() => setCount(initialCount)}>归零</button>
  </main>;
}`;
  assert.equal(
    sourceTools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: 0,
        changes: [
          { operation: 'write', path: 'src/app.tsx', expectedHash: null, content: source },
          {
            operation: 'write',
            path: 'src/initial.ts',
            expectedHash: null,
            content: 'export const initialCount = 0;',
          },
        ],
      },
    }).ok,
    true,
  );
  const { runtime } = loadToolchain(resolve('dist/toolchain'));
  const baseline = await builds.build({
    schemaVersion: 1,
    requestId: randomUUID(),
    ...context,
    sourceRevision: 1,
  });
  assert.equal(baseline.status, 'succeeded');
  const priorBuild = baseline.state.artifact!.id;
  const initial = sources.get(project.id).files.find((file) => file.path === 'src/initial.ts')!;
  assert.equal(
    sourceTools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: 1,
        changes: [{ operation: 'delete', path: initial.path, expectedHash: initial.sha256 }],
      },
    }).ok,
    true,
  );
  let interaction: string[] = [];
  let previewError: string | null = null;
  try {
    console.log('Live repair started: at most four model requests, no raw responses logged.');
    const state = await repairs.repair({
      schemaVersion: 1,
      requestId: randomUUID(),
      ...context,
      sourceRevision: 2,
    });
    if (state.run?.status === 'succeeded') {
      try {
        const artifact = builds.artifact(project.id, state.run.buildId!);
        await previews.open(artifact, runtime);
        const window = previews.previewWindow(project.id)!;
        const value = () =>
          window.webContents.executeJavaScript(
            "document.querySelector('output')?.textContent?.trim()",
          );
        for (let i = 0; i < 50 && (await value()) !== '0'; i++) await delay(100);
        interaction.push(await value());
        for (const label of ['加一', '减一', '加一', '加一', '归零']) {
          await window.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.trim()===${JSON.stringify(label)})?.click()`,
          );
          await delay(50);
          interaction.push(await value());
        }
        assert.deepEqual(interaction, ['0', '1', '0', '1', '2', '0']);
        writeFileSync(
          join(output, 'repaired-counter.png'),
          (await window.webContents.capturePage()).toPNG(),
        );
      } catch {
        previewError = 'INTERACTION_CHECK_FAILED';
      }
    }
    const after = models.usage();
    const result = {
      at: new Date().toISOString(),
      provider: settings.provider,
      model: settings.model,
      projectId: project.id,
      run: state.run,
      revision: sources.get(project.id).revision,
      calls: after.calls - before.calls,
      inputTokens: after.inputTokens - before.inputTokens,
      outputTokens: after.outputTokens - before.outputTokens,
      unknownUsageCalls: after.unknownUsageCalls - before.unknownUsageCalls,
      interaction,
      previewError,
      originalFilesCount: originals.length,
      existingProjectsUnchanged: originals.every((item) => digest(item.path) === item.hash),
      configuredBudgetUnchanged: models.settings().maxCalls === settings.maxCalls,
      previousSuccessfulBuildRetained: builds.artifact(project.id, priorBuild).id === priorBuild,
      tasksStillUnrun: plans
        .get(project.id)
        .run!.plan.tasks.every(
          (t) => t.implementation === 'pending' && t.verification === 'not_run',
        ),
    };
    writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await previews.stopAll();
    app.quit();
  }
}
main().catch((error: unknown) => {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'LIVE_REPAIR_FAILED';
  console.error(/^[A-Z_]+$/.test(code) ? code : 'LIVE_REPAIR_FAILED');
  app.exit(1);
});
