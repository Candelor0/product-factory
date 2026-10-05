import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AppAiService } from '../src/main/app-ai-service';
import { AppAiStore, appAiUsage } from '../src/main/app-ai-store';
import { ModelService, type Cipher } from '../src/main/model-service';
import { ProjectStore } from '../src/main/project-store';
import { PlanStore } from '../src/main/plan-store';
import { SourceStore } from '../src/main/source-store';
import { AppError } from '../src/main/validation';
import { SourceToolExecutor } from '../src/main/source-tools';
import type { BuildArtifact } from '../src/shared/build-contracts';
import type { AppAiResponse } from '../src/shared/app-ai-contracts';

const cipher: Cipher = {
  available: () => true,
  encrypt: (s) => Buffer.from(s),
  decrypt: (b) => b.toString(),
};
const syntheticKey = 'synthetic-local-ai-key-fixture';
const code = (expected: string) => (e: unknown) => e instanceof AppError && e.code === expected;
const errorCode = (r: AppAiResponse) => (r.ok ? 'ok' : r.error.code);
const reply = (usage: unknown = { prompt_tokens: 7, completion_tokens: 3 }, text = '合成摘要') =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
      ...(usage === null ? {} : { usage }),
    }),
    { status: 200 },
  );
function fixture(t: TestContext, hooks: ConstructorParameters<typeof AppAiStore>[1] = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-app-ai-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(join(root, 'workbench'));
  let project = projects.create({ name: 'AI测试', idea: '文本摘要' });
  project = projects.saveRequirements(project.id, {
    summary: '摘要',
    audience: '自己',
    features: ['摘要文本'],
    pages: ['首页'],
    data: [],
    outOfScope: [],
    questions: [],
    acceptance: ['显示摘要'],
  });
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, {
    direction: '浅色',
    palette: ['#ffffff'],
    pages: [{ name: '首页', sections: ['输入'] }],
    notes: [],
  });
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const plans = new PlanStore(projects);
  const actualTools = new SourceToolExecutor(projects, plans, new SourceStore(projects));
  const planRunId = plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)!.id,
    designId: project.designs.at(-1)!.id,
    profile: 'web',
  }).run!.id;
  const binding = actualTools.prepare({ projectId: project.id, planRunId }).binding;
  let stale = false;
  const tools: Pick<SourceToolExecutor, 'prepare'> = {
    prepare: (ctx) => {
      if (projects.get(ctx.projectId).archived || stale || ctx.planRunId !== binding.planRunId)
        throw new AppError('STALE_PLAN', 'fixture');
      return actualTools.prepare(ctx);
    },
  };
  let fetches = 0;
  let request: typeof fetch = async () => reply();
  const models = new ModelService(join(root, 'credentials'), cipher, (...args) => {
    fetches++;
    return request(...args);
  });
  models.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: syntheticKey,
    maxCalls: 30,
    maxTokens: null,
  });
  const records = new AppAiStore(projects, hooks);
  const service = new AppAiService(projects, tools, models, records);
  const artifact: BuildArtifact = {
    schemaVersion: 1,
    id: randomUUID(),
    projectId: project.id,
    createdAt: new Date().toISOString(),
    sourceRevision: 1,
    sourceHash: 'c'.repeat(64),
    ...binding,
    templateVersion: 'react-preview-v1',
    compilerVersion: 'test',
    artifactHash: 'd'.repeat(64),
    javascript: '',
    css: '',
    warnings: [],
  };
  const grant = (patch: Record<string, unknown> = {}) =>
    service.grant({
      schemaVersion: 1,
      projectId: project.id,
      planRunId: binding.planRunId,
      expectedRevision: records.get(project.id).revision,
      connectionId: models.settings().connectionId,
      purpose: '概括用户提交的文本',
      maxCalls: 10,
      maxTokens: 100000,
      ...patch,
    });
  const input = (text = '待概括的合成资料') => ({
    schemaVersion: 1,
    requestId: randomUUID(),
    text,
  });
  const file = join(projects.rootPath, 'projects', project.id, 'runs', 'app-ai.json');
  return {
    root,
    projects,
    project,
    tools,
    models,
    records,
    service,
    artifact,
    grant,
    input,
    file,
    fetches: () => fetches,
    setRequest: (next: typeof fetch) => {
      request = next;
    },
    stale: () => {
      stale = true;
    },
  };
}

test('authorization is explicit; temporary sessions never read the ledger or contact a provider', async (t) => {
  const f = fixture(t);
  assert.equal(f.service.state(f.project.id).status, 'unauthorized');
  assert.equal(
    errorCode(await f.service.create(f.artifact, 'persistent').execute(f.input())),
    'APP_AI_UNAUTHORIZED',
  );
  f.grant();
  writeFileSync(f.file, 'damaged');
  assert.equal(
    errorCode(await f.service.create(f.artifact, 'temporary').execute(f.input())),
    'APP_AI_DISABLED',
  );
  assert.equal(f.fetches(), 0);
});
test('real ModelService text dispatch settles only the project account and never persists prompt answer or key', async (t) => {
  const f = fixture(t);
  f.grant();
  const providerBefore = readFileSync(join(f.root, 'credentials/provider.json'));
  const result = await f.service
    .create(f.artifact, 'persistent')
    .execute(f.input('private-synthetic-input'));
  assert.deepEqual(result, { ok: true, value: { text: '合成摘要' } });
  assert.equal(f.fetches(), 1);
  assert.deepEqual(f.service.state(f.project.id).usage, {
    calls: 1,
    inputTokens: 7,
    outputTokens: 3,
    unknownUsageCalls: 0,
  });
  assert.equal(f.service.state(f.project.id).budgetTokens, 10);
  assert.deepEqual(readFileSync(join(f.root, 'credentials/provider.json')), providerBefore);
  const saved = readFileSync(f.file, 'utf8');
  for (const text of ['private-synthetic-input', '合成摘要', syntheticKey])
    assert.ok(!saved.includes(text));
});
test('same ID is never resent across windows or a reopened service and different content conflicts', async (t) => {
  const f = fixture(t);
  f.grant();
  const input = f.input();
  assert.equal(errorCode(await f.service.create(f.artifact, 'persistent').execute(input)), 'ok');
  const reopened = new AppAiService(f.projects, f.tools, f.models, new AppAiStore(f.projects));
  const session = reopened.create(f.artifact, 'persistent');
  assert.equal(errorCode(await session.execute(input)), 'APP_AI_REQUEST_RECORDED');
  assert.equal(
    errorCode(await session.execute({ ...input, text: 'changed' })),
    'APP_AI_REQUEST_CONFLICT',
  );
  assert.equal(f.fetches(), 1);
});
test('unknown usage retains reserved tokens after restart and increased quotas never erase usage', async (t) => {
  const f = fixture(t);
  f.grant();
  f.setRequest(async () => reply(null));
  const session = f.service.create(f.artifact, 'persistent');
  assert.equal(errorCode(await session.execute(f.input())), 'ok');
  const used = f.service.state(f.project.id);
  assert.equal(used.usage.unknownUsageCalls, 1);
  assert.ok(used.budgetTokens > 1024);
  const reopened = new AppAiService(f.projects, f.tools, f.models, new AppAiStore(f.projects));
  assert.equal(reopened.state(f.project.id).budgetTokens, used.budgetTokens);
  f.grant({ maxCalls: 20, maxTokens: used.budgetTokens });
  assert.equal(errorCode(await session.execute(f.input())), 'APP_AI_LIMIT');
  assert.equal(f.fetches(), 1);
  assert.equal(f.service.state(f.project.id).usage.calls, 1);
});
test('call limit and preflight token reservation prevent sending, including the last slot race', async (t) => {
  const f = fixture(t);
  f.grant({ maxTokens: 1 });
  const session = f.service.create(f.artifact, 'persistent');
  assert.equal(errorCode(await session.execute(f.input())), 'APP_AI_LIMIT');
  assert.equal(f.fetches(), 0);
  f.grant({ maxCalls: 1 });
  let resolve!: (r: Response) => void;
  f.setRequest(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const first = session.execute(f.input());
  const second = await session.execute(f.input());
  assert.equal(errorCode(second), 'BUSY');
  assert.equal(f.fetches(), 1);
  resolve(reply());
  assert.equal(errorCode(await first), 'ok');
  assert.equal(errorCode(await session.execute(f.input())), 'APP_AI_LIMIT');
  assert.equal(f.fetches(), 1);
});
test('revoke aborts its active request and late responses never refund unknown reservation', async (t) => {
  const f = fixture(t);
  f.grant();
  let resolve!: (r: Response) => void;
  f.setRequest(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const session = f.service.create(f.artifact, 'persistent');
  const pending = session.execute(f.input());
  f.service.revoke(f.project.id);
  assert.equal(errorCode(await pending), 'CANCELLED');
  const state = f.service.state(f.project.id);
  assert.equal(state.status, 'revoked');
  assert.equal(state.usage.unknownUsageCalls, 1);
  resolve(reply());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.service.state(f.project.id).budgetTokens, state.budgetTokens);
  assert.equal(errorCode(await session.execute(f.input())), 'APP_AI_REVOKED');
});
test('session close cannot cancel an unrelated developer request', async (t) => {
  const f = fixture(t);
  f.grant();
  let resolve!: (r: Response) => void;
  f.setRequest(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const development = f.models.check();
  const session = f.service.create(f.artifact, 'persistent');
  assert.equal(errorCode(await session.execute(f.input())), 'BUSY');
  session.revoke();
  assert.equal(f.models.isBusy(), true);
  resolve(reply({ prompt_tokens: 2, completion_tokens: 1 }, '{"ok":true}'));
  await development;
  assert.equal(f.models.usage().calls, 1);
  assert.equal(f.service.state(f.project.id).usage.calls, 0);
});
test('closing a session cancels only its own request and reauthorization does not reset receipts', async (t) => {
  const f = fixture(t);
  f.grant();
  f.setRequest(() => new Promise(() => {}));
  const session = f.service.create(f.artifact, 'persistent'),
    input = f.input();
  const pending = session.execute(input);
  session.revoke();
  assert.equal(errorCode(await pending), 'CANCELLED');
  f.service.revoke(f.project.id);
  f.grant();
  assert.equal(
    errorCode(await f.service.create(f.artifact, 'persistent').execute(input)),
    'APP_AI_REQUEST_RECORDED',
  );
  assert.equal(f.service.state(f.project.id).usage.calls, 1);
});
test('changed connection or plan, archived project, and cross-project artifact never inherit a grant', async (t) => {
  const f = fixture(t);
  f.grant();
  const session = f.service.create(f.artifact, 'persistent');
  f.models.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'different-model',
    maxCalls: 30,
  });
  assert.equal(f.service.state(f.project.id).status, 'stale');
  assert.equal(errorCode(await session.execute(f.input())), 'APP_AI_STALE');
  f.grant();
  const other = f.projects.create({ name: '另一个项目', idea: '合成' });
  assert.equal(
    errorCode(
      await f.service
        .create({ ...f.artifact, projectId: other.id }, 'persistent')
        .execute(f.input()),
    ),
    'APP_AI_UNAUTHORIZED',
  );
  f.projects.archive(f.project.id, true);
  assert.equal(errorCode(await session.execute(f.input())), 'APP_AI_STALE');
  f.projects.archive(f.project.id, false);
  f.stale();
  assert.equal(errorCode(await session.execute(f.input())), 'APP_AI_STALE');
  assert.equal(f.fetches(), 0);
});
test('strict input refuses renderer-selected project model tools and credential text without fees', async (t) => {
  const f = fixture(t);
  f.grant();
  const session = f.service.create(f.artifact, 'persistent');
  for (const extra of [
    { projectId: randomUUID() },
    { model: 'other' },
    { tools: [] },
    { baseUrl: 'https://other.example' },
  ])
    assert.equal(errorCode(await session.execute({ ...f.input(), ...extra })), 'INVALID_INPUT');
  assert.equal(errorCode(await session.execute(f.input('x'.repeat(16001)))), 'INVALID_INPUT');
  assert.equal(errorCode(await session.execute(f.input(syntheticKey))), 'EXPORT_SENSITIVE');
  assert.equal(f.fetches(), 0);
});
test('provider credential echo is rejected while known usage remains correctly charged', async (t) => {
  const f = fixture(t);
  f.grant();
  f.setRequest(async () => reply(undefined, syntheticKey));
  const result = await f.service.create(f.artifact, 'persistent').execute(f.input());
  assert.equal(errorCode(result), 'SENSITIVE_RESPONSE');
  assert.ok(!JSON.stringify(result).includes(syntheticKey));
  assert.equal(f.service.state(f.project.id).budgetTokens, 10);
});
test('missing initialized ledger, marker deletion, links, corruption and unsupported versions never reset accounts', async (t) => {
  for (const scenario of ['missing', 'marker', 'symlink', 'hardlink', 'json', 'version']) {
    const f = fixture(t);
    f.grant();
    const bytes = readFileSync(f.file);
    if (scenario === 'missing') unlinkSync(f.file);
    if (scenario === 'marker') unlinkSync(f.file.replace('app-ai.json', 'app-ai.initialized.json'));
    if (scenario === 'symlink' || scenario === 'hardlink') {
      const target = join(f.root, 'external');
      writeFileSync(target, bytes);
      unlinkSync(f.file);
      if (scenario === 'symlink') symlinkSync(target, f.file);
      else linkSync(target, f.file);
    }
    if (scenario === 'json') writeFileSync(f.file, '{');
    if (scenario === 'version')
      writeFileSync(f.file, JSON.stringify({ ...JSON.parse(bytes.toString()), schemaVersion: 2 }));
    const reopened = new AppAiStore(f.projects);
    assert.throws(() => reopened.get(f.project.id));
    assert.equal(
      errorCode(await f.service.create(f.artifact, 'persistent').execute(f.input())) === 'ok',
      false,
    );
    assert.equal(f.fetches(), 0);
  }
});
test('failed intent write sends nothing; committed but unacknowledged intent is never retried', async (t) => {
  for (const after of [false, true]) {
    let armed = false;
    const f = fixture(t, {
      [after ? 'afterRename' : 'beforeRename']: () => {
        if (armed) throw new Error('synthetic disk fault');
      },
    });
    f.grant();
    armed = true;
    const input = f.input();
    const result = await f.service.create(f.artifact, 'persistent').execute(input);
    assert.equal(errorCode(result), after ? 'APP_AI_COMMIT_UNCERTAIN' : 'APP_AI_STORAGE');
    assert.equal(f.fetches(), 0);
    armed = false;
    assert.equal(f.service.state(f.project.id).usage.calls, after ? 1 : 0);
    if (after)
      assert.equal(
        errorCode(await f.service.create(f.artifact, 'persistent').execute(input)),
        'APP_AI_REQUEST_RECORDED',
      );
  }
});
test('failed settlement keeps conservative unknown occupation and never returns an unaccounted answer', async (t) => {
  let armed = false;
  const f = fixture(t, {
    beforeRename: () => {
      if (armed) throw new Error('synthetic settle IO');
    },
  });
  f.grant();
  f.setRequest(async () => {
    armed = true;
    return reply();
  });
  assert.equal(
    errorCode(await f.service.create(f.artifact, 'persistent').execute(f.input())),
    'APP_AI_STORAGE',
  );
  const state = f.service.state(f.project.id);
  assert.equal(state.usage.unknownUsageCalls, 1);
  assert.ok(state.budgetTokens > 1024);
});
test('grant CAS and connection snapshot mismatches refuse silently changing permission', (t) => {
  const f = fixture(t);
  f.grant();
  assert.throws(() => f.grant({ expectedRevision: 0 }), code('APP_AI_CONFLICT'));
  assert.throws(() => f.grant({ connectionId: randomUUID() }), code('APP_AI_STALE'));
  assert.equal(f.service.state(f.project.id).grant!.purpose, '概括用户提交的文本');
});
test('receipt capacity preserves deduplication history and refuses new paid calls', async (t) => {
  const f = fixture(t);
  f.grant({ maxCalls: 1000 });
  const r = f.records.get(f.project.id);
  r.revision = 1000;
  r.receipts = Array.from({ length: 1000 }, () => ({
    requestId: randomUUID(),
    requestHash: 'e'.repeat(64),
    reservedTokens: 1,
    inputTokens: 0,
    outputTokens: 0,
  }));
  writeFileSync(f.file, JSON.stringify(r));
  assert.equal(
    errorCode(await f.service.create(f.artifact, 'persistent').execute(f.input())),
    'APP_AI_LIMIT',
  );
  assert.equal(f.fetches(), 0);
  assert.equal(appAiUsage(f.records.get(f.project.id)).usage.calls, 1000);
});

test('unrepresentable provider totals saturate durable project budget instead of leaving a small spendable reservation', async (t) => {
  const f = fixture(t);
  f.grant();
  const session = f.service.create(f.artifact, 'persistent');
  assert.equal(errorCode(await session.execute(f.input())), 'ok');
  f.setRequest(async () => reply({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0 }));
  assert.equal(errorCode(await session.execute(f.input())), 'ok');
  const state = f.service.state(f.project.id);
  assert.equal(state.budgetTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(state.usage.unknownUsageCalls, 1);
  assert.equal(state.usage.inputTokens, 7);
  assert.equal(
    new AppAiService(f.projects, f.tools, f.models, new AppAiStore(f.projects)).state(f.project.id)
      .status,
    'limited',
  );
  assert.equal(errorCode(await session.execute(f.input())), 'APP_AI_LIMIT');
  assert.equal(f.fetches(), 2);
});
