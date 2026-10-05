import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectStore } from '../src/main/project-store';
import { PlanStore } from '../src/main/plan-store';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { CodingStore } from '../src/main/coding-store';
import { CodingRunner } from '../src/main/coding-runner';
import { RepairStore } from '../src/main/repair-store';
import { RepairRunner } from '../src/main/repair-runner';
import { BuildStore } from '../src/main/build-store';
import { BuildService } from '../src/main/build-service';
import { compileSource } from '../src/main/source-compiler';
import { ModelService } from '../src/main/model-service';
import { RecoveryService } from '../src/main/recovery-service';
import { sourceHash } from '../src/main/source-protocol';
import { loadToolchain } from '../src/main/toolchain';

loadToolchain(process.env.FACTORY_RECOVERY_TOOLCHAIN!);
const root = process.env.FACTORY_RECOVERY_DATA!;
const output = process.env.FACTORY_RECOVERY_OUTPUT!;
const phase = process.env.FACTORY_RECOVERY_PHASE!;
const boundary = process.env.FACTORY_RECOVERY_BOUNDARY!;
const fixtureFile = join(output, `${boundary}-fixture.json`);
const checks: string[] = [];
const check = (label: string, condition: unknown) => {
  assert.ok(condition, label);
  checks.push(label);
};
const kill = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not terminate');
};
const projects = new ProjectStore(root);
const plans = new PlanStore(projects);
let armed = false;
const sources = new SourceStore(projects, {
  beforeRename: () => {
    if (armed && boundary.endsWith('source-before')) kill();
  },
  afterRename: () => {
    if (armed && boundary.endsWith('source-after')) kill();
  },
});
const tools = new SourceToolExecutor(projects, plans, sources);
const records = new CodingStore(projects);
const artifacts = new BuildStore(projects);
const realSave = artifacts.save.bind(artifacts);
artifacts.save = (id, value) => {
  realSave(id, value);
  if (armed && boundary === 'build-after-artifact') kill();
};
let compiles = 0;
const builds = new BuildService(projects, sources, tools, artifacts, async (source, options) => {
  compiles++;
  const compiled = await compileSource(source, options);
  if (armed && boundary === 'build-before-artifact') kill();
  return compiled;
});
let requests = 0;
const response = (stop: boolean, revision: number) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: stop ? 'stop' : 'tool_calls',
          message: stop
            ? { role: 'assistant', content: '已保存' }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'synthetic_write',
                    type: 'function',
                    function: {
                      name: 'apply_changes',
                      arguments: JSON.stringify({
                        expectedRevision: revision,
                        changes: [
                          {
                            operation: 'write',
                            path: 'src/app.tsx',
                            expectedHash: sourceHash(source),
                            content: changed,
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );
const source = 'export default function App() { return <h1>检查点 原始版本</h1>; }';
const changed = 'export default function App() { return <h1>检查点 修改版本</h1>; }';
const models = new ModelService(
  join(root, 'credentials'),
  {
    available: () => false,
    encrypt: () => {
      throw new Error();
    },
    decrypt: () => {
      throw new Error();
    },
  },
  async () => {
    requests++;
    if (phase === 'recover') throw new Error('recovery must never invoke transport');
    if (boundary === 'model-partial')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"choices":['));
            setTimeout(kill, 25);
          },
        }),
      );
    return response(boundary === 'stage-saved' || requests > 1, 1);
  },
);
const coding = new CodingRunner(records, sources, tools, models);
const repairs = new RepairRunner(new RepairStore(projects), sources, tools, models, builds);
const recovery = new RecoveryService(
  projects,
  plans,
  sources,
  tools,
  coding,
  repairs,
  builds,
  artifacts,
);
const realCodingSave = records.save.bind(records);
records.save = (id, value) => {
  realCodingSave(id, value);
  if (armed && boundary === 'stage-saved' && value.status !== 'running') kill();
};

async function run() {
  if (phase === 'seed') {
    let project = projects.create({
      name: `恢复边界 ${boundary}`,
      idea: '合成故障注入，不使用在线供应商',
    });
    project = projects.saveRequirements(project.id, {
      summary: '本地页面',
      audience: '自己',
      features: ['显示文字'],
      pages: ['首页'],
      data: ['文章'],
      outOfScope: ['联网'],
      questions: [],
      acceptance: ['显示文字'],
    });
    project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = projects.saveDesign(project.id, {
      direction: '浅色',
      palette: ['#ffffff'],
      pages: [{ name: '首页', sections: ['文字'] }],
      notes: [],
    });
    project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
    const plan = plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      requirementId: project.requirements.at(-1)!.id,
      designId: project.designs.at(-1)!.id,
      profile: 'web',
    }).run!;
    const context = { projectId: project.id, planRunId: plan.id };
    const binding = tools.prepare(context).binding;
    sources.apply(project.id, {
      requestId: randomUUID(),
      binding,
      expectedRevision: 0,
      changes: [{ operation: 'write', path: 'src/app.tsx', expectedHash: null, content: source }],
    });
    if (boundary.startsWith('restore'))
      sources.apply(project.id, {
        requestId: randomUUID(),
        binding,
        expectedRevision: 1,
        changes: [
          {
            operation: 'write',
            path: 'src/app.tsx',
            expectedHash: sourceHash(source),
            content: changed,
          },
        ],
      });
    const dataFile = join(root, 'projects', project.id, 'data', 'retained.json');
    writeFileSync(dataFile, '{"newBusinessData":"新文章必须保留"}\n');
    const request = { schemaVersion: 1, requestId: randomUUID(), ...context };
    writeFileSync(
      fixtureFile,
      JSON.stringify({
        context,
        binding,
        request,
        dataFile,
        manifest: sourceHash(
          readFileSync(join(root, 'projects', project.id, 'project.json'), 'utf8'),
        ),
        plan: sourceHash(
          readFileSync(
            join(root, 'projects', project.id, 'runs', 'development-plans.json'),
            'utf8',
          ),
        ),
      }),
    );
    check(
      'seed saved separate business data, confirmed plan and source checkpoints',
      sources.history(project.id).length >= 2,
    );
  } else {
    const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
    const { context, binding, request, dataFile } = fixture;
    const buildRequest = { ...request, sourceRevision: 1 };
    const restoreRequest = { ...request, sourceRevision: 2, targetRevision: 1 };
    if (phase === 'crash') {
      models.save({
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        apiKey: 'SYNTHETIC-NO-ACCOUNT',
        maxCalls: 8,
      });
      armed = true;
      if (boundary.startsWith('restore')) recovery.restore(restoreRequest);
      else if (boundary.startsWith('build')) await builds.build(buildRequest);
      else await coding.generate(request);
      throw new Error('Expected injected SIGKILL was not reached');
    }
    const beforeUsage = models.usage();
    const state = recovery.state(context.projectId);
    check('reconciliation itself issues no model request', requests === 0);
    check(
      'business data retained byte for byte',
      readFileSync(dataFile, 'utf8') === '{"newBusinessData":"新文章必须保留"}\n',
    );
    check(
      'confirmed project unchanged',
      sourceHash(
        readFileSync(join(root, 'projects', context.projectId, 'project.json'), 'utf8'),
      ) === fixture.manifest,
    );
    check(
      'development plan and not_run task checks unchanged',
      sourceHash(
        readFileSync(
          join(root, 'projects', context.projectId, 'runs', 'development-plans.json'),
          'utf8',
        ),
      ) === fixture.plan,
    );
    if (boundary.startsWith('restore')) {
      check(
        'restore commit boundary has complete old or new tree',
        state.revision === (boundary.endsWith('after') ? 3 : 2),
      );
      const result = recovery.restore(restoreRequest);
      check(
        'same restore request reconciles or commits exactly once',
        result.revision === 3 && result.replayed === boundary.endsWith('after'),
      );
      check(
        'restored source equals selected checkpoint',
        sources.get(context.projectId).files[0].content === source,
      );
      check(
        'second restore replay preserves revision',
        recovery.restore(restoreRequest).replayed && sources.get(context.projectId).revision === 3,
      );
      check(
        'restore preserves later code checkpoint for undo',
        sources.at(context.projectId, 2).files[0].content === changed,
      );
    } else if (boundary.startsWith('build')) {
      const expected = boundary === 'build-after-artifact' ? 'succeeded' : 'interrupted';
      check(
        'build status reconciles actual artifact',
        state.runs.find((item) => item.kind === 'build')?.status === expected,
      );
      if (expected === 'interrupted')
        await assert.rejects(builds.build(buildRequest), { code: 'BUILD_INTERRUPTED' });
      else
        check(
          'same build returns its committed result',
          (await builds.build(buildRequest)).status === 'succeeded',
        );
      check('same build request never recompiles', compiles === 0);
      if (expected === 'interrupted')
        check(
          'explicit new local build succeeds',
          (await builds.build({ ...buildRequest, requestId: randomUUID() })).status === 'succeeded',
        );
    } else {
      const run = state.runs.find((item) => item.kind === 'coding')!;
      check(
        'interrupted model run is not promoted to completion',
        run.status === (boundary === 'stage-saved' ? 'no_changes' : 'interrupted'),
      );
      check(
        'source commit reflects exact rename boundary',
        state.revision === (boundary === 'source-after' ? 2 : 1),
      );
      check(
        'source receipt reconciles committed tool',
        run.committedRevisions.length === (boundary === 'source-after' ? 1 : 0),
      );
      check(
        'replaying same paid run does not rerun',
        (await coding.generate(request)).run?.id === request.requestId && requests === 0,
      );
      check('persisted model count survives process kill', beforeUsage.calls === 1);
      check(
        'partial provider response remains unknown usage',
        beforeUsage.unknownUsageCalls === (boundary === 'model-partial' ? 1 : 0),
      );
    }
    check(
      'recovery does not reset or add model usage',
      JSON.stringify(models.usage()) === JSON.stringify(beforeUsage),
    );
    check('no model request during any recovery step', requests === 0);
    check(
      'business data still unchanged after all recovery actions',
      readFileSync(dataFile, 'utf8') === '{"newBusinessData":"新文章必须保留"}\n',
    );
  }
  writeFileSync(
    join(output, `${boundary}-${phase}.json`),
    JSON.stringify(
      { boundary, phase, passed: checks.length, checks, mockRequests: requests, compiles },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ boundary, phase, passed: checks.length, mockRequests: requests, compiles }),
  );
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
