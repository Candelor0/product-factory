import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectStore } from '../src/main/project-store';
import { PlanStore } from '../src/main/plan-store';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { sourceHash } from '../src/main/source-protocol';
import type {
  SourceToolContext,
  SourceToolRequest,
  SourceToolResponse,
} from '../src/shared/source-contracts';

const data = process.env.FACTORY_SOURCE_DATA!;
const output = process.env.FACTORY_SOURCE_OUTPUT!;
const phase = process.env.FACTORY_SOURCE_PHASE!;
const projects = new ProjectStore(data);
const plans = new PlanStore(projects);
const checks: string[] = [];
const check = (description: string, value: unknown) => {
  assert.ok(value, description);
  checks.push(description);
};
const success = (result: SourceToolResponse) => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
};
const denied = (result: SourceToolResponse, code: string) => {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error();
  assert.equal(result.error.code, code);
  return result;
};
const stateFile = join(output, 'fixture.json');
const requirement = {
  summary: '合成博客源码事务测试',
  audience: '合成作者',
  features: ['读取文章标题'],
  pages: ['文章列表'],
  data: ['文章'],
  outOfScope: ['公网发布'],
  questions: ['封面待明确'],
  acceptance: ['标题保留'],
};
const design = {
  direction: '浅色',
  palette: ['#ffffff'],
  pages: [{ name: '文章列表', sections: ['标题'] }],
  notes: ['仅合成工具协议测试'],
};
interface Fixture {
  context: SourceToolContext;
  beforeRequest: SourceToolRequest;
  afterRequest: SourceToolRequest;
  manifestHash: string;
  seedHash: string;
}
const workspace = (id: string) => join(data, 'projects', id, 'source', 'workspace.json');
const list = (): SourceToolRequest => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  tool: 'list_files',
  arguments: {},
});

if (phase === 'seed') {
  check(
    'isolated workspace starts without projects or credentials',
    projects.list().length === 0 && !existsSync(join(data, 'credentials')),
  );
  let project = projects.create({ name: '源码事务 · 合成博客', idea: requirement.summary });
  project = projects.saveRequirements(project.id, requirement);
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, design);
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const run = plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)!.id,
    designId: project.designs.at(-1)!.id,
    profile: 'web',
  }).run!;
  const context = { projectId: project.id, planRunId: run.id };
  const tools = new SourceToolExecutor(projects, plans, new SourceStore(projects));
  const packet = tools.prepare(context);
  check(
    'coding input preserves audience, exclusions, unknowns and visual directions',
    JSON.stringify(packet.requirements.content) === JSON.stringify(requirement) &&
      JSON.stringify(packet.design.content) === JSON.stringify(design),
  );
  check(
    'prepared context keeps execution disabled and acceptance not run',
    packet.execution === 'disabled' &&
      packet.plan.tasks.every((task) => task.verification === 'not_run'),
  );
  success(tools.execute(context, list()));
  const text = 'export const title = "合成文章";\n';
  const result = success(
    tools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: 0,
        changes: [
          { operation: 'write', path: 'src/app.tsx', expectedHash: null, content: text },
          {
            operation: 'write',
            path: 'src/style.css',
            expectedHash: null,
            content: 'body { color: #24272b; }\n',
          },
        ],
      },
    }),
  );
  check(
    'two synthetic source files commit as revision one',
    result.tool === 'apply_changes' && result.revision === 1,
  );
  check(
    'virtual source text is not materialized or executed',
    !existsSync(join(data, 'projects', project.id, 'source', 'src')),
  );
  const fixture: Fixture = {
    context,
    beforeRequest: {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: 1,
        changes: [
          {
            operation: 'write',
            path: 'src/app.tsx',
            expectedHash: sourceHash(text),
            content: 'export const title = "更新文章";\n',
          },
        ],
      },
    },
    afterRequest: {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: 2,
        changes: [
          {
            operation: 'write',
            path: 'src/metadata.json',
            expectedHash: null,
            content: '{"fixture":true}\n',
          },
        ],
      },
    },
    manifestHash: sourceHash(
      readFileSync(join(data, 'projects', project.id, 'project.json'), 'utf8'),
    ),
    seedHash: sourceHash(readFileSync(workspace(project.id), 'utf8')),
  };
  writeFileSync(stateFile, JSON.stringify(fixture, null, 2) + '\n');
} else {
  const fixture: Fixture = JSON.parse(readFileSync(stateFile, 'utf8'));
  const { context } = fixture;
  const sources = new SourceStore(projects, {
    beforeRename: phase === 'crash-before' ? () => process.exit(71) : undefined,
    afterRename: phase === 'crash-after' ? () => process.exit(72) : undefined,
  });
  const tools = new SourceToolExecutor(projects, plans, sources);
  if (phase === 'crash-before' || phase === 'crash-after') {
    tools.execute(context, phase === 'crash-before' ? fixture.beforeRequest : fixture.afterRequest);
    throw new Error('Expected owned test process to exit at commit boundary');
  }
  if (phase === 'recover-before') {
    check(
      'new process retains original committed bytes after exit before rename',
      sourceHash(readFileSync(workspace(context.projectId), 'utf8')) === fixture.seedHash,
    );
    check(
      'new process ignores preserved incomplete temporary file',
      readdirSync(join(data, 'projects', context.projectId, 'source')).some((name) =>
        name.startsWith('.source-'),
      ) && sources.get(context.projectId).revision === 1,
    );
    const result = success(tools.execute(context, fixture.beforeRequest));
    check(
      'retry after precommit exit commits revision two once',
      result.tool === 'apply_changes' && result.revision === 2 && !result.replayed,
    );
    const read = success(
      tools.execute(context, {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'read_file',
        arguments: { path: 'src/app.tsx' },
      }),
    );
    check(
      'updated source bytes can be read through the tool',
      read.tool === 'read_file' && read.file.content.includes('更新文章'),
    );
  } else if (phase === 'recover-after') {
    check(
      'new process sees revision three after exit following rename',
      sources.get(context.projectId).revision === 3,
    );
    const before = readFileSync(workspace(context.projectId), 'utf8');
    const result = success(tools.execute(context, fixture.afterRequest));
    check(
      'same request returns its original receipt without an extra revision',
      result.tool === 'apply_changes' && result.replayed && result.revision === 3,
    );
    check(
      'receipt replay does not rewrite committed bytes',
      readFileSync(workspace(context.projectId), 'utf8') === before,
    );
    denied(
      tools.execute(context, {
        ...list(),
        tool: 'read_file',
        arguments: { path: '../credentials/provider.json' },
      }),
      'SOURCE_PATH_DENIED',
    );
    denied(
      tools.execute(context, { ...list(), tool: 'shell', arguments: { command: 'unavailable' } }),
      'UNKNOWN_TOOL',
    );
    check(
      'invalid path and command leave source bytes unchanged',
      readFileSync(workspace(context.projectId), 'utf8') === before,
    );
    const existingPlan = plans.get(context.projectId).run!;
    check(
      'source changes never mark product tasks implemented or verified',
      existingPlan.plan.tasks.every(
        (task) => task.implementation === 'pending' && task.verification === 'not_run',
      ),
    );
    check(
      'source tools preserve project manifest and separate business data',
      sourceHash(
        readFileSync(join(data, 'projects', context.projectId, 'project.json'), 'utf8'),
      ) === fixture.manifestHash &&
        readdirSync(join(data, 'projects', context.projectId, 'data')).length === 0,
    );
    projects.saveRequirements(context.projectId, { ...requirement, summary: '新的未确认需求' });
    denied(tools.execute(context, fixture.afterRequest), 'CONFIRMATION_REQUIRED');
    check(
      'changed confirmations prevent even an old successful request replay',
      readFileSync(workspace(context.projectId), 'utf8') === before,
    );
    check(
      'no credentials or model usage files were created',
      !existsSync(join(data, 'credentials')),
    );
  } else throw new Error('Unknown phase');
}
writeFileSync(
  join(output, `${phase}.json`),
  JSON.stringify(
    {
      phase,
      passed: checks.length,
      checks,
      modelCalls: 0,
      runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    },
    null,
    2,
  ) + '\n',
);
console.log(`${phase}: ${checks.length} checks passed`);
