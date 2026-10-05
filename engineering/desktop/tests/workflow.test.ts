import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelService, type Cipher } from '../src/main/model-service.js';
import { ProjectStore } from '../src/main/project-store.js';
import { AppError } from '../src/main/validation.js';
import type { DesignContent, RequirementContent } from '../src/shared/contracts.js';

// These are integration tests with synthetic responses, not real provider validation.
// Every ModelService instance receives an injected request function. No network or real Key is used.
const fakeKey = 'workflow-test-only-not-a-real-api-key';
const sessionCipher: Cipher = {
  available: () => false,
  encrypt: () => {
    throw new Error('Session-only fixture must not encrypt.');
  },
  decrypt: () => {
    throw new Error('Session-only fixture must not decrypt.');
  },
};
const requirements = (summary = '记录阅读和生活的个人博客'): RequirementContent => ({
  summary,
  audience: '自己和朋友',
  features: ['创建和编辑文章', '草稿与本地发布'],
  pages: ['文章列表', '文章详情', '文章管理'],
  data: ['文章标题、正文、状态'],
  outOfScope: ['公网发布'],
  questions: ['封面图片是否进入首版？'],
  acceptance: ['创建文章后重开仍可读取', '草稿不显示在文章列表'],
});
const design = (): DesignContent => ({
  direction: '浅色阅读界面，以清晰文字和留白为主',
  palette: ['#F8F6F2', '#202020', '#6A8064'],
  pages: [{ name: '文章列表', sections: ['博客标题', '文章卡片'] }],
  notes: ['封面图片仍待明确，不加入方案'],
});

interface SimulatedReply {
  content: unknown;
  // A present object represents synthetic provider-reported usage, never measured real usage.
  usage?: { prompt_tokens: number; completion_tokens: number };
}
interface CapturedRequest {
  url: string;
  options: RequestInit;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    response_format: unknown;
    thinking: unknown;
    stream: boolean;
    max_tokens: number;
  };
}

function fixture(t: { after: (callback: () => void) => void }, replies: SimulatedReply[]) {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'factory-workflow-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, '中文 工作流');
  const store = new ProjectStore(root);
  const credentials = join(root, 'credentials');
  const requests: CapturedRequest[] = [];
  const request: typeof fetch = async (url, options) => {
    assert.ok(options);
    assert.equal(typeof options.body, 'string');
    const reply = replies[requests.length];
    assert.ok(reply, 'Unexpected request: no network fallback is permitted.');
    requests.push({ url: String(url), options, body: JSON.parse(options.body as string) });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(reply.content) }, finish_reason: 'stop' }],
        ...(reply.usage ? { usage: reply.usage } : {}),
      }),
      { status: 200 },
    );
  };
  const models = new ModelService(credentials, sessionCipher, request);
  models.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: fakeKey,
    maxCalls: 10,
  });
  return { root, store, models, credentials, requests, request };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

// Mirrors the main-process sequence: only validated model content reaches the store.
async function generateRequirements(
  store: ProjectStore,
  models: ModelService,
  projectId: string,
  instruction: string,
) {
  const content = await models.requirements(store.get(projectId), instruction);
  return store.saveRequirements(projectId, content);
}
async function generateDesign(
  store: ProjectStore,
  models: ModelService,
  projectId: string,
  instruction: string,
) {
  const content = await models.design(store.get(projectId), instruction);
  return store.saveDesign(projectId, content);
}

test('simulated workflow requires explicit confirmations, scopes requests, and invalidates old design after new requirements', async (t) => {
  const firstRequirements = requirements();
  const revisedRequirements = {
    ...requirements('在个人博客中增加文章标签'),
    features: ['创建和编辑文章', '草稿与本地发布', '文章标签'],
  };
  const { root, store, models, credentials, requests, request } = fixture(t, [
    { content: firstRequirements, usage: { prompt_tokens: 11, completion_tokens: 5 } },
    { content: design() }, // Missing provider usage must remain unknown, not be represented as measured zero.
    { content: revisedRequirements, usage: { prompt_tokens: 17, completion_tokens: 9 } },
  ]);
  let project = store.create({ name: '阅读博客', idea: '记录读书笔记，仅在本机使用' });
  const other = store.create({
    name: 'OTHER_PROJECT_NAME_PRIVATE_SENTINEL',
    idea: 'OTHER_PROJECT_IDEA_PRIVATE_SENTINEL',
  });
  store.saveRequirements(other.id, requirements('OTHER_PROJECT_REQUIREMENTS_PRIVATE_SENTINEL'));
  const otherPath = join(root, 'projects', other.id, 'project.json');
  const otherBefore = readFileSync(otherPath, 'utf8');

  project = await generateRequirements(store, models, project.id, '先整理需求，把未知功能列为问题');
  const requirementRevision = structuredClone(project.requirements.at(-1)!);
  assert.equal(project.stage, 'requirements');
  assert.equal(requirementRevision.approvedAt, null);
  assert.deepEqual(requirementRevision.content.questions, firstRequirements.questions);
  await assert.rejects(
    generateDesign(store, models, project.id, '生成页面方向'),
    hasCode('CONFIRMATION_REQUIRED'),
  );
  assert.equal(
    requests.length,
    1,
    'Rejected unconfirmed design must not dispatch or consume a model call.',
  );

  project = store.approveRequirements(project.id, requirementRevision.id);
  assert.equal(project.stage, 'design');
  assert.ok(project.requirements.at(-1)!.approvedAt);
  project = await generateDesign(store, models, project.id, '使用浅色阅读风格');
  const designRevision = structuredClone(project.designs.at(-1)!);
  assert.equal(designRevision.basedOn, requirementRevision.id);
  assert.equal(designRevision.approvedAt, null);
  assert.equal(project.stage, 'design', 'Generation alone must not confirm the design.');
  project = store.approveDesign(project.id, designRevision.id);
  assert.equal(project.stage, 'ready');
  const approvedDesign = structuredClone(project.designs.at(-1)!);
  assert.ok(approvedDesign.approvedAt);

  project = await generateRequirements(store, models, project.id, '增加文章标签');
  const latestRequirements = project.requirements.at(-1)!;
  assert.equal(project.requirements.length, 2);
  assert.equal(latestRequirements.approvedAt, null);
  assert.equal(project.stage, 'requirements');
  assert.deepEqual(project.requirements[0]!.content, firstRequirements);
  assert.deepEqual(
    project.designs[0],
    approvedDesign,
    'Old confirmation evidence is retained as history.',
  );
  assert.throws(
    () => store.approveDesign(project.id, designRevision.id),
    hasCode('STALE_REVISION'),
  );
  project = store.approveRequirements(project.id, latestRequirements.id);
  assert.equal(project.stage, 'design');
  assert.throws(
    () => store.approveDesign(project.id, designRevision.id),
    hasCode('STALE_REVISION'),
  );
  assert.deepEqual(new ProjectStore(root).get(project.id), project);
  assert.equal(readFileSync(otherPath, 'utf8'), otherBefore, 'The unrelated project is unchanged.');

  assert.equal(requests.length, 3);
  for (const { url, options, body } of requests) {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.stream, false);
    assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0);
    assert.deepEqual(
      body.messages.map((message) => message.role),
      ['system', 'user'],
    );
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('OTHER_PROJECT_'), false);
    assert.equal(serialized.includes(other.id), false);
    assert.equal(serialized.includes(fakeKey), false, 'Credential must not become prompt content.');
  }
  const designInput = JSON.parse(requests[1]!.body.messages[1]!.content);
  assert.deepEqual(designInput.requirements, firstRequirements);
  const revisionInput = JSON.parse(requests[2]!.body.messages[1]!.content);
  assert.deepEqual(revisionInput.previous, firstRequirements);
  assert.equal(revisionInput.instruction, '增加文章标签');

  // These numbers come only from our response fixtures. They prove accounting behavior, not model quality or real cost.
  const expectedUsage = { calls: 3, inputTokens: 28, outputTokens: 14, unknownUsageCalls: 1 };
  assert.deepEqual(models.usage(), expectedUsage);
  const reopenedModels = new ModelService(credentials, sessionCipher, request);
  assert.deepEqual(reopenedModels.usage(), expectedUsage);
  assert.equal(
    reopenedModels.settings().hasKey,
    false,
    'A session fixture key is never restored from disk.',
  );
  assert.equal(readFileSync(join(credentials, 'provider.json'), 'utf8').includes(fakeKey), false);
  assert.equal(
    readFileSync(join(root, 'projects', project.id, 'project.json'), 'utf8').includes(fakeKey),
    false,
  );
});

test('simulated schema errors leave confirmed requirement and design revisions byte-for-byte unchanged', async (t) => {
  const { root, store, models, requests } = fixture(t, [
    { content: { summary: '缺少需求必填字段' }, usage: { prompt_tokens: 7, completion_tokens: 3 } },
    { content: { ...design(), pages: [] } },
  ]);
  let project = store.create({ name: '已有博客', idea: '保留已有方案' });
  project = store.saveRequirements(project.id, requirements());
  project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = store.saveDesign(project.id, design());
  project = store.approveDesign(project.id, project.designs.at(-1)!.id);
  const manifest = join(root, 'projects', project.id, 'project.json');
  const before = readFileSync(manifest, 'utf8');

  await assert.rejects(
    generateRequirements(store, models, project.id, '修改需求'),
    hasCode('INVALID_RESPONSE'),
  );
  assert.equal(readFileSync(manifest, 'utf8'), before);
  assert.deepEqual(new ProjectStore(root).get(project.id), project);
  await assert.rejects(
    generateDesign(store, models, project.id, '修改设计'),
    hasCode('INVALID_RESPONSE'),
  );
  assert.equal(readFileSync(manifest, 'utf8'), before);
  assert.deepEqual(new ProjectStore(root).get(project.id), project);
  assert.equal(requests.length, 2);
  assert.equal(models.isBusy(), false);
  assert.deepEqual(
    models.usage(),
    { calls: 2, inputTokens: 7, outputTokens: 3, unknownUsageCalls: 1 },
    'Invalid content still counts dispatched calls and distinguishes known synthetic tokens from missing usage.',
  );
});
