/** Explicit opt-in only. Uses the existing desktop credential vault and cumulative budget.
 * Creates one synthetic project; never prints credentials or raw provider messages.
 */
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';

async function main() {
  if (process.env.FACTORY_LIVE_CODING !== '1')
    throw new Error('Explicit live-test opt-in required');
  const output = resolve('../../docs/evidence/2026-10-03/S3-02/model-coding/live');
  mkdirSync(output, { recursive: true });
  const { models, store, plans, coding } = await startDesktop({
    show: false,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    blogPath: resolve('dist/blog'),
  });
  const settings = models.settings();
  const before = models.usage();
  if (
    !settings.hasKey ||
    settings.provider !== 'deepseek' ||
    settings.baseUrl !== 'https://api.deepseek.com' ||
    settings.maxCalls - before.calls < 1
  ) {
    writeFileSync(
      join(output, 'result.json'),
      JSON.stringify(
        {
          status: 'skipped',
          reason:
            'Existing official DeepSeek credential and remaining budget required; settings unchanged',
        },
        null,
        2,
      ),
    );
    app.quit();
    return;
  }
  const originals = store.list().map((project) => ({
    id: project.id,
    hash: createHash('sha256')
      .update(readFileSync(join(store.rootPath, 'projects', project.id, 'project.json')))
      .digest('hex'),
  }));
  let project = store.create({
    name: '工具实测 · 计数器',
    idea: '模型工具回合的小型实测：浅色单页计数器，可加一、减一、归零，无网络和持久化需求。',
  });
  project = store.saveRequirements(project.id, {
    summary: '简单单页计数器，初始为零，提供加一、减一、归零。',
    audience: '用于开发验证的测试人员',
    features: ['加一', '减一', '归零'],
    pages: ['计数器'],
    data: [],
    outOfScope: ['网络', '持久化', '账号'],
    questions: [],
    acceptance: ['初始显示0', '加一减一更新数字', '归零恢复0'],
  });
  project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = store.saveDesign(project.id, {
    direction: '浅色留白，中间大数字，下方三个文字按钮，不添加多余说明。',
    palette: ['#ffffff', '#24272b', '#b7472d'],
    pages: [{ name: '计数器', sections: ['计数数字', '减一、加一、归零按钮'] }],
    notes: ['合成测试项目，确认由测试程序完成。'],
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
  const timeout = setTimeout(() => coding.cancel(), 220_000);
  try {
    console.log('Live tool test started; at most four model requests, no raw responses logged.');
    const state = await coding.generate({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      planRunId: plan.run!.id,
    });
    const after = models.usage();
    const unchanged = originals.every(
      (item) =>
        item.hash ===
        createHash('sha256')
          .update(readFileSync(join(store.rootPath, 'projects', item.id, 'project.json')))
          .digest('hex'),
    );
    const result = {
      at: new Date().toISOString(),
      provider: settings.provider,
      model: settings.model,
      projectId: project.id,
      run: state.run,
      files: state.files,
      revision: state.revision,
      calls: after.calls - before.calls,
      inputTokens: after.inputTokens - before.inputTokens,
      outputTokens: after.outputTokens - before.outputTokens,
      unknownUsageCalls: after.unknownUsageCalls - before.unknownUsageCalls,
      existingProjectsUnchanged: unchanged,
      configuredBudgetUnchanged: models.settings().maxCalls === settings.maxCalls,
      execution: state.execution,
      tasksStillUnrun: plans
        .get(project.id)
        .run!.plan.tasks.every(
          (task) => task.implementation === 'pending' && task.verification === 'not_run',
        ),
    };
    writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    clearTimeout(timeout);
    app.quit();
  }
}
main().catch((error: unknown) => {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : 'LIVE_TEST_FAILED';
  console.error(`Live test stopped: ${/^[A-Z_]+$/.test(code) ? code : 'LIVE_TEST_FAILED'}`);
  app.exit(1);
});
