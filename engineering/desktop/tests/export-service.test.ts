import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProjectStore } from '../src/main/project-store';
import { SourceStore } from '../src/main/source-store';
import { PlanStore } from '../src/main/plan-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { ExportService } from '../src/main/export-service';
import { assertExportContentsSafe } from '../src/main/export-security';
import { AppError } from '../src/main/validation';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(join(root, 'private'));
  const sources = new SourceStore(projects),
    plans = new PlanStore(projects);
  const tools = new SourceToolExecutor(projects, plans, sources);
  let project = projects.create({ name: '中文 空格项目', idea: '保存自己的文章' });
  project = projects.saveRequirements(project.id, {
    summary: '自己的文章',
    audience: '自己',
    features: ['阅读文章'],
    pages: ['首页'],
    data: ['文章'],
    outOfScope: ['公网'],
    questions: [],
    acceptance: ['标题可见'],
  });
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, {
    direction: '浅色',
    palette: ['#ffffff'],
    pages: [{ name: '首页', sections: ['标题'] }],
    notes: [],
  });
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const planRunId = plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)!.id,
    designId: project.designs.at(-1)!.id,
    profile: 'web',
  }).run!.id;
  const context = { projectId: project.id, planRunId };
  const write = (content = 'export default function App(){return <p>文章</p>}') => {
    const current = sources.get(project.id);
    const result = tools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: {
        expectedRevision: current.revision,
        changes: [
          {
            operation: 'write',
            path: 'src/app.tsx',
            expectedHash: current.files[0]?.sha256 ?? null,
            content,
          },
        ],
      },
    });
    assert.ok(result.ok);
  };
  write();
  const request = { schemaVersion: 1 as const, ...context, sourceRevision: 1 };
  const output = join(root, '中文 空格源码.zip');
  let chooseCalls = 0;
  let choose: () => Promise<string | null> = async () => output;
  const service = new ExportService(projects, sources, tools, {
    version: 'test',
    kit: () => [{ path: 'README.md', content: '合成固定工具，单独验证包构造' }],
    assertSafe: assertExportContentsSafe,
    protectedDirectories: [projects.rootPath],
    chooseDestination: async () => {
      chooseCalls++;
      return choose();
    },
  });
  return {
    root,
    projects,
    sources,
    plans,
    tools,
    project,
    context,
    request,
    output,
    service,
    write,
    setChooser: (callback: () => Promise<string | null>) => {
      choose = callback;
    },
    chosen: () => chooseCalls,
  };
}
test('export contains one exact current source and confirmed documents without reading private business or run files', async (t) => {
  const f = fixture(t);
  const projectPath = join(f.projects.rootPath, 'projects', f.project.id);
  const privateText = 'private-business-and-log-value';
  writeFileSync(join(projectPath, 'data', 'sentinel.json'), privateText);
  writeFileSync(join(projectPath, 'runs', 'unrelated-log.txt'), privateText);
  const before = readFileSync(join(projectPath, 'source', 'workspace.json'));
  const result = await f.service.export(f.request);
  assert.equal(result.status, 'exported');
  const zip = readFileSync(f.output);
  assert.ok(zip.includes(Buffer.from('src/app.tsx')));
  assert.ok(zip.includes(Buffer.from('documents/requirements.json')));
  assert.ok(zip.includes(Buffer.from('manifest.json')));
  assert.ok(!zip.includes(Buffer.from(privateText)));
  assert.deepEqual(readFileSync(join(projectPath, 'source', 'workspace.json')), before);
  assert.equal(f.chosen(), 1);
  if (result.status === 'exported') {
    assert.equal(result.filePath, f.output);
    assert.equal(result.fileCount, 6);
    assert.equal(result.sourceRevision, 1);
  }
});
test('save dialog cancellation and explicit cancellation create no archive', async (t) => {
  const f = fixture(t);
  f.setChooser(async () => null);
  assert.deepEqual(await f.service.export(f.request), { status: 'cancelled' });
  f.setChooser(async () => {
    f.service.cancel();
    return f.output;
  });
  assert.deepEqual(await f.service.export(f.request), { status: 'cancelled' });
  assert.equal(existsSync(f.output), false);
});
test('source changes during the native dialog prevent any stale export', async (t) => {
  const f = fixture(t);
  f.setChooser(async () => {
    f.write('export default function App(){return <p>changed</p>}');
    return f.output;
  });
  await assert.rejects(f.service.export(f.request), hasCode('STALE_SOURCE'));
  assert.equal(existsSync(f.output), false);
});
test('confirmation changes and archive while choosing a destination fail closed', async (t) => {
  const f = fixture(t);
  f.setChooser(async () => {
    f.projects.archive(f.project.id, true);
    return f.output;
  });
  await assert.rejects(f.service.export(f.request), hasCode('ARCHIVED'));
  assert.equal(existsSync(f.output), false);
  f.projects.archive(f.project.id, false);
  f.setChooser(async () => {
    f.projects.saveRequirements(f.project.id, {
      ...f.project.requirements.at(-1)!.content,
      summary: '新方向',
    });
    return f.output;
  });
  await assert.rejects(f.service.export(f.request), hasCode('CONFIRMATION_REQUIRED'));
  assert.equal(existsSync(f.output), false);
});
test('renaming a project during the dialog refuses a mixed snapshot', async (t) => {
  const f = fixture(t);
  f.setChooser(async () => {
    f.projects.rename(f.project.id, '新名称');
    return f.output;
  });
  await assert.rejects(f.service.export(f.request), hasCode('EXPORT_STALE'));
  assert.equal(existsSync(f.output), false);
});
test('renderer cannot supply destination fields and protected application data cannot receive exports', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.service.export({ ...f.request, destination: f.output }),
    hasCode('INVALID_INPUT'),
  );
  assert.equal(f.chosen(), 0);
  f.setChooser(async () => join(f.projects.rootPath, 'export.zip'));
  await assert.rejects(f.service.export(f.request), hasCode('EXPORT_PROTECTED_PATH'));
  assert.equal(existsSync(join(f.projects.rootPath, 'export.zip')), false);
});
test('overlapping native dialogs cannot issue duplicate exports', async (t) => {
  const f = fixture(t);
  let done!: (value: string | null) => void;
  f.setChooser(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const pending = f.service.export(f.request);
  await assert.rejects(f.service.export(f.request), hasCode('BUSY'));
  done(null);
  await pending;
  assert.equal(f.chosen(), 1);
});
test('sensitive source blocks before showing a dialog without modifying source', async (t) => {
  const f = fixture(t);
  f.write(
    'export const apiKey="synthetic-private-token-value";export default function App(){return null}',
  );
  const request = { ...f.request, sourceRevision: 2 };
  await assert.rejects(f.service.export(request), hasCode('EXPORT_SENSITIVE'));
  assert.equal(f.chosen(), 0);
  assert.equal(f.sources.get(f.project.id).revision, 2);
  assert.equal(existsSync(f.output), false);
});

test('dot-prefixed names inside protected data directories remain protected', async (t) => {
  const f = fixture(t);
  const nested = join(f.projects.rootPath, '..exports');
  mkdirSync(nested);
  for (const destination of [
    join(f.projects.rootPath, '..source.zip'),
    join(nested, 'source.zip'),
  ]) {
    f.setChooser(async () => destination);
    await assert.rejects(f.service.export(f.request), hasCode('EXPORT_PROTECTED_PATH'));
    assert.equal(existsSync(destination), false);
  }
});

test('packaged app root protection includes unpacked toolchain directories outside app.asar', async (t) => {
  const f = fixture(t);
  const application = join(f.root, '产品工厂.app');
  const toolchain = join(
    application,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'dist',
    'toolchain',
  );
  mkdirSync(toolchain, { recursive: true });
  const destination = join(toolchain, 'new.zip');
  const service = new ExportService(f.projects, f.sources, f.tools, {
    version: 'test',
    kit: () => [{ path: 'README.md', content: '合成固定导出资源' }],
    assertSafe: assertExportContentsSafe,
    protectedDirectories: [application],
    chooseDestination: async () => destination,
  });
  await assert.rejects(service.export(f.request), hasCode('EXPORT_PROTECTED_PATH'));
  assert.equal(existsSync(destination), false);
});

test('an export records the original code binding separately from a newer confirmed plan', async (t) => {
  const f = fixture(t);
  let project = f.projects.saveRequirements(f.project.id, {
    ...f.project.requirements.at(-1)!.content,
    summary: '新需求方向',
  });
  project = f.projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = f.projects.saveDesign(project.id, {
    direction: '新浅色方向',
    palette: ['#ffffff'],
    pages: [{ name: '首页', sections: ['新标题'] }],
    notes: [],
  });
  project = f.projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const plan = f.plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)!.id,
    designId: project.designs.at(-1)!.id,
    profile: 'web',
  }).run!;
  await f.service.export({ ...f.request, planRunId: plan.id });
  const manifest = JSON.parse(
    execFileSync('/usr/bin/unzip', ['-p', f.output, 'manifest.json'], { encoding: 'utf8' }),
  );
  assert.equal(manifest.binding.planRunId, plan.id);
  assert.equal(manifest.source.binding.planRunId, f.request.planRunId);
  assert.equal(manifest.source.alignedWithCurrentPlan, false);
  assert.equal(manifest.verification.business, 'not_run');
  assert.equal(f.sources.get(project.id).revision, 1);
});
