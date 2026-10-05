import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { CodingRunner } from '../src/main/coding-runner';
import { CodingStore } from '../src/main/coding-store';
import { ModelService } from '../src/main/model-service';
import { PlanStore } from '../src/main/plan-store';
import { ProjectStore } from '../src/main/project-store';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { sourceHash } from '../src/main/source-protocol';
import type { ModificationCodingRequest } from '../src/shared/coding-contracts';
import type { ModelToolCall, ModelToolTurn } from '../src/shared/model-tool-contracts';

const key = 'SYNTHETIC-MODIFICATION-KEY-NOT-REAL';
const original = 'export default function App(){return <button>原按钮</button>}';
const modified = 'export default function App(){return <button>修改后的按钮</button>}';
const hash = (value: unknown) => sourceHash(JSON.stringify(value));
const requirements = {
  summary: '通用本地清单',
  audience: '自己',
  features: ['阅读清单'],
  pages: ['清单'],
  data: ['清单项目'],
  outOfScope: ['联网'],
  questions: [],
  acceptance: ['页面可以阅读'],
};
const design = {
  direction: '浅色简洁',
  palette: ['#ffffff'],
  pages: [{ name: '清单', sections: ['列表'] }],
  notes: [],
};
const call = (name: string, args: object = {}, id: string = randomUUID()): ModelToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: ModelToolCall[]): ModelToolTurn => ({
  finishReason: 'tool_calls',
  message: { role: 'assistant', content: null, tool_calls: calls },
});
const stop = (): ModelToolTurn => ({
  finishReason: 'stop',
  message: { role: 'assistant', content: '全部修改已通过业务验收。' },
});
type Reply = ModelToolTurn | (() => ModelToolTurn | Promise<ModelToolTurn>);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext, afterSourceRename?: () => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-modification-coding-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const sources = new SourceStore(projects, { afterRename: afterSourceRename });
  const tools = new SourceToolExecutor(projects, plans, sources);
  let project = projects.create({ name: '合成修改', idea: '验证用户指令绑定旧源码' });
  project = projects.saveRequirements(project.id, requirements);
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, design);
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const planRequest = {
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)!.id,
    designId: project.designs.at(-1)!.id,
    profile: 'web',
  };
  const plan = plans.create(planRequest).run!;
  const context = { projectId: project.id, planRunId: plan.id };
  const records = new CodingStore(projects);
  const replies: Reply[] = [];
  const bodies: { messages: { role: string; content: string | null }[] }[] = [];
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
    async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      assert.equal(records.list(project.id).at(-1)?.status, 'running');
      const next = replies.shift();
      assert.ok(next, 'No unexpected provider request and no network fallback.');
      const reply = typeof next === 'function' ? await next() : next;
      return Response.json({
        choices: [{ finish_reason: reply.finishReason, message: reply.message }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    },
  );
  models.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: key,
    maxCalls: 30,
  });
  const runner = () =>
    new CodingRunner(records, sources, tools, models, {
      assertModificationSafe: (text) => models.assertExportSafe([text]),
    });
  const writeCall = (content: string, path = 'src/app.tsx', id?: string) => {
    const source = sources.get(project.id);
    return call(
      'apply_changes',
      {
        expectedRevision: source.revision,
        changes: [
          {
            operation: 'write',
            path,
            content,
            expectedHash: source.files.find((file) => file.path === path)?.sha256 ?? null,
          },
        ],
      },
      id,
    );
  };
  const write = (content: string, path?: string) => {
    const input = writeCall(content, path);
    const result = tools.execute(context, {
      schemaVersion: 1,
      requestId: randomUUID(),
      tool: 'apply_changes',
      arguments: JSON.parse(input.function.arguments),
    });
    assert.ok(result.ok);
  };
  write(original);
  const request = (
    instruction = '将按钮文案改成“修改后的按钮”，保留其余内容。',
  ): ModificationCodingRequest => ({
    schemaVersion: 2,
    requestId: randomUUID(),
    ...context,
    sourceRevision: sources.get(project.id).revision,
    sourceHash: hash(sources.get(project.id)),
    instruction,
  });
  return {
    root,
    projects,
    plans,
    sources,
    tools,
    project,
    plan,
    planRequest,
    context,
    records,
    models,
    replies,
    bodies,
    runner,
    writeCall,
    write,
    request,
  };
}
const read = (path = 'src/app.tsx') => call('read_file', { path });

test('four real model-service rounds receive the exact user change and preserve confirmed plan and metadata-only coding records', async (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.root, 'projects', f.project.id, 'project.json'));
  f.replies.push(turn(call('list_files')), turn(read()), () => turn(f.writeCall(modified)), stop());
  const input = f.request('  将按钮文案改成“修改后的按钮”，保留其余内容。\n');
  const result = await f.runner().generate(input);
  assert.equal(result.run?.status, 'draft_saved');
  assert.equal(result.revision, 2);
  assert.equal(result.run?.rounds, 4);
  assert.equal(result.run?.toolCalls, 3);
  assert.equal(result.run?.requestHash, hash({ ...input, instruction: input.instruction.trim() }));
  const prepared = JSON.parse(f.bodies[0].messages[1].content!);
  assert.deepEqual(prepared.requirements.content, requirements);
  assert.deepEqual(prepared.design.content, design);
  assert.equal(prepared.binding.planRunId, f.plan.id);
  assert.deepEqual(JSON.parse(f.bodies[0].messages[2].content!), {
    type: 'user_modification',
    sourceRevision: 1,
    sourceHash: input.sourceHash,
    instruction: input.instruction.trim(),
  });
  assert.equal(f.sources.at(f.project.id, 1).files[0].content, original);
  assert.equal(f.sources.get(f.project.id).files[0].content, modified);
  assert.deepEqual(readFileSync(join(f.root, 'projects', f.project.id, 'project.json')), before);
  assert.ok(
    f.plans.get(f.project.id).run!.plan.tasks.every((task) => task.verification === 'not_run'),
  );
  const journal = readFileSync(
    join(f.root, 'projects', f.project.id, 'runs', 'coding.json'),
    'utf8',
  );
  for (const excluded of [
    key,
    input.instruction.trim(),
    original,
    modified,
    '全部修改已通过业务验收',
  ])
    assert.equal(journal.includes(excluded), false);
});

test('unread existing writes return fixed feedback and perform no source commit', async (t) => {
  const f = fixture(t);
  f.replies.push(() => turn(f.writeCall(modified)), stop());
  const result = await f.runner().generate(f.request());
  assert.equal(result.run?.status, 'no_changes');
  assert.equal(result.revision, 1);
  const feedback = JSON.parse(f.bodies[1].messages.at(-1)!.content!);
  assert.equal(feedback.error.code, 'SOURCE_READ_REQUIRED');
  assert.equal(feedback.ok, false);
  assert.equal(feedback.error.retryable, false);
  assert.equal(f.sources.get(f.project.id).files[0].content, original);
});

test('one unread deletion rejects the whole batch including an otherwise authorized write and a new file', async (t) => {
  const f = fixture(t);
  f.write('button { color: blue; }', 'src/style.css');
  const before = f.sources.get(f.project.id);
  f.replies.push(
    turn(read()),
    () =>
      turn(
        call('apply_changes', {
          expectedRevision: before.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash: before.files[0].sha256,
              content: modified,
            },
            { operation: 'delete', path: 'src/style.css', expectedHash: before.files[1].sha256 },
            {
              operation: 'write',
              path: 'src/new.ts',
              expectedHash: null,
              content: 'export const created=true;',
            },
          ],
        }),
      ),
    stop(),
  );
  assert.equal((await f.runner().generate(f.request())).run?.status, 'no_changes');
  assert.deepEqual(f.sources.get(f.project.id), before);
  assert.equal(
    JSON.parse(f.bodies[2].messages.at(-1)!.content!).error.code,
    'SOURCE_READ_REQUIRED',
  );
});

test('a prior read hash expires after an owned write; a second write needs a fresh read', async (t) => {
  const f = fixture(t);
  f.replies.push(
    turn(read()),
    () => turn(f.writeCall(modified)),
    () => turn(f.writeCall(`${modified}\n// unapproved unread second edit`)),
    stop(),
  );
  const result = await f.runner().generate(f.request());
  assert.equal(result.run?.status, 'draft_saved');
  assert.equal(result.revision, 2);
  assert.equal(f.sources.get(f.project.id).files[0].content, modified);
  assert.equal(
    JSON.parse(f.bodies[3].messages.at(-1)!.content!).error.code,
    'SOURCE_READ_REQUIRED',
  );
});

test('a new file can be added without inventing a prior read receipt', async (t) => {
  const f = fixture(t);
  f.replies.push(() => turn(f.writeCall('button { color: blue; }', 'src/style.css')), stop());
  const result = await f.runner().generate(f.request('补充按钮样式文件。'));
  assert.equal(result.run?.status, 'draft_saved');
  assert.equal(result.revision, 2);
  assert.equal(f.sources.get(f.project.id).files.length, 2);
  assert.equal(f.sources.get(f.project.id).files[0].content, original);
});

test('rewriting identical content advances the checkpoint but reports no net modification', async (t) => {
  const f = fixture(t);
  f.replies.push(turn(read()), () => turn(f.writeCall(original)), stop());
  const result = await f.runner().generate(f.request());
  assert.equal(result.revision, 2);
  assert.equal(result.run?.status, 'no_changes');
  assert.deepEqual(f.sources.at(f.project.id, 1).files, f.sources.at(f.project.id, 2).files);
});

test('stale revision, hash and another confirmed plan fail before intent or paid dispatch', async (t) => {
  const f = fixture(t);
  const input = f.request();
  await assert.rejects(f.runner().generate({ ...input, sourceRevision: 0 }), {
    code: 'STALE_SOURCE',
  });
  await assert.rejects(f.runner().generate({ ...input, sourceHash: '0'.repeat(64) }), {
    code: 'STALE_SOURCE',
  });
  const next = f.plans.create({ ...f.planRequest, requestId: randomUUID() }).run!;
  await assert.rejects(f.runner().generate({ ...input, planRunId: next.id }), {
    code: 'STALE_PLAN',
  });
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
});

test('a same-plan external commit while awaiting the model stops before the returned tool can write', async (t) => {
  const f = fixture(t);
  const foreign = 'export default function App(){return <p>outside owner</p>}';
  f.replies.push(turn(read()), () => {
    f.write(foreign);
    return turn(f.writeCall(modified));
  });
  const result = await f.runner().generate(f.request());
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run?.errorCode, 'STALE_SOURCE');
  assert.equal(result.run?.toolCalls, 1);
  assert.equal(f.sources.get(f.project.id).revision, 2);
  assert.equal(f.sources.get(f.project.id).files[0].content, foreign);
});

test('external source changes after a read are detected before granting read authorization or executing the next batched tool', async (t) => {
  const f = fixture(t);
  const foreign = `${original}\n// outside owner`;
  const execute = f.tools.execute.bind(f.tools);
  f.tools.execute = (context, input) => {
    const response = execute(context, input);
    if (response.ok && response.data.tool === 'read_file') f.write(foreign);
    return response;
  };
  f.replies.push(() => turn(read(), f.writeCall(modified)));
  const result = await f.runner().generate(f.request());
  assert.equal(result.run?.errorCode, 'STALE_SOURCE');
  assert.equal(result.run?.toolCalls, 1);
  assert.equal(f.sources.get(f.project.id).files[0].content, foreign);
});

test('an uncertain owned source commit is reconciled once using the same receipt and then safely adopted', async (t) => {
  let armed = false;
  const f = fixture(t, () => {
    if (armed) throw new Error('SYNTHETIC_PRIVATE_ERROR');
  });
  armed = true;
  f.replies.push(turn(read()), () => turn(f.writeCall(modified)), stop());
  const result = await f.runner().generate(f.request());
  assert.equal(result.run?.status, 'draft_saved');
  assert.equal(result.revision, 2);
  assert.equal(result.run?.toolCalls, 2);
  const checkpoint = f.sources.history(f.project.id).at(-1)!;
  assert.ok(result.run!.toolRequests.some((receipt) => receipt.requestId === checkpoint.requestId));
  assert.equal(f.models.usage().calls, 3);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_ERROR'), false);
});

test('same modification request replays after a fresh runner without repeating a paid request; changed instructions conflict', async (t) => {
  const f = fixture(t);
  f.replies.push(turn(read()), () => turn(f.writeCall(modified)), stop());
  const input = f.request();
  const first = await f.runner().generate(input);
  const restarted = new CodingRunner(new CodingStore(f.projects), f.sources, f.tools, f.models);
  assert.deepEqual(await restarted.generate(input), first);
  await assert.rejects(restarted.generate({ ...input, instruction: '另一项明确要求' }), {
    code: 'CODING_CONFLICT',
  });
  assert.equal(f.models.usage().calls, 3);
  assert.equal(f.sources.get(f.project.id).revision, 2);
});

test('a persisted running modification intent never restarts the model', async (t) => {
  const f = fixture(t);
  const input = f.request();
  const now = new Date().toISOString();
  f.records.save(f.project.id, {
    id: input.requestId,
    requestHash: hash(input),
    planRunId: input.planRunId,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    initialRevision: 1,
    rounds: 1,
    toolCalls: 0,
    toolRequests: [],
    errorCode: null,
  });
  const result = await f.runner().generate(input);
  assert.equal(result.run?.status, 'interrupted');
  assert.equal(f.models.usage().calls, 0);
  assert.equal(f.sources.get(f.project.id).revision, 1);
});

test('cancelled late provider tools cannot modify the preserved source', async (t) => {
  const f = fixture(t);
  const entered = deferred<void>();
  const late = deferred<ModelToolTurn>();
  f.replies.push(turn(read()), () => {
    entered.resolve();
    return late.promise;
  });
  const runner = f.runner();
  const operation = runner.generate(f.request());
  await entered.promise;
  runner.cancel();
  assert.equal((await operation).run?.status, 'cancelled');
  late.resolve(turn(f.writeCall(modified)));
  await setImmediate();
  await setImmediate();
  assert.equal(f.sources.get(f.project.id).revision, 1);
  assert.equal(f.models.usage().calls, 2);
  assert.equal(f.models.usage().unknownUsageCalls, 1);
});

test('invalid, decorated and sensitive instructions are rejected before persistence and provider dispatch', async (t) => {
  const f = fixture(t);
  for (const instruction of ['', '  ', 'x'.repeat(2001), '\u0000', '\ud800'])
    await assert.rejects(f.runner().generate(f.request(instruction)), { code: 'INVALID_INPUT' });
  const decorated = f.request();
  Object.defineProperty(decorated, 'hidden', { value: true });
  await assert.rejects(f.runner().generate(decorated), { code: 'INVALID_INPUT' });
  let invoked = false;
  const accessor = f.request();
  Object.defineProperty(accessor, 'schemaVersion', {
    get: () => {
      invoked = true;
      return 2;
    },
  });
  await assert.rejects(f.runner().generate(accessor), { code: 'INVALID_INPUT' });
  assert.equal(invoked, false);
  await assert.rejects(f.runner().generate(f.request(`请在页面使用 ${key}`)), {
    code: 'MODIFICATION_SENSITIVE',
  });
  await assert.rejects(f.runner().generate(f.request('password="synthetic-secret-text"')), {
    code: 'MODIFICATION_SENSITIVE',
  });
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
});

test('legacy v1 generation keeps its original request hash and does not acquire modification read restrictions', async (t) => {
  const f = fixture(t);
  const input = { schemaVersion: 1 as const, requestId: randomUUID(), ...f.context };
  f.replies.push(() => turn(f.writeCall(modified)), stop());
  const result = await f.runner().generate(input);
  assert.equal(result.run?.requestHash, hash(input));
  assert.equal(result.run?.status, 'draft_saved');
  assert.equal(f.bodies[0].messages.length, 2);
  assert.equal(f.sources.get(f.project.id).files[0].content, modified);
});

test('modification of an empty restored source cannot fall through to an unrelated fresh generation', async (t) => {
  const f = fixture(t);
  f.sources.restore(f.project.id, {
    requestId: randomUUID(),
    binding: f.tools.prepare(f.context).binding,
    expectedRevision: 1,
    targetRevision: 0,
  });
  await assert.rejects(f.runner().generate(f.request()), { code: 'STALE_SOURCE' });
  assert.equal(f.records.list(f.project.id).length, 0);
  assert.equal(f.models.usage().calls, 0);
  assert.deepEqual(f.sources.get(f.project.id), { revision: 2, files: [] });
});

test('fixed unread-file feedback lets the same bounded run recover by reading before a new apply request', async (t) => {
  const f = fixture(t);
  f.replies.push(
    () => turn(f.writeCall(modified)),
    turn(read()),
    () => turn(f.writeCall(modified)),
    stop(),
  );
  const result = await f.runner().generate(f.request());
  assert.equal(result.run?.status, 'draft_saved');
  assert.equal(result.run?.rounds, 4);
  assert.equal(result.run?.toolCalls, 3);
  assert.equal(result.revision, 2);
  assert.equal(
    JSON.parse(f.bodies[1].messages.at(-1)!.content!).error.code,
    'SOURCE_READ_REQUIRED',
  );
  assert.equal(f.sources.get(f.project.id).files[0].content, modified);
});

test('the model cannot select a future revision to attach its write to an anticipated external commit', async (t) => {
  const f = fixture(t);
  const execute = f.tools.execute.bind(f.tools);
  let dispatchedWrites = 0;
  f.tools.execute = (context, input) => {
    if ((input as { tool: string }).tool === 'apply_changes') {
      dispatchedWrites++;
      if (dispatchedWrites === 1) f.write('export const unrelated=true;', 'src/other.ts');
    }
    return execute(context, input);
  };
  f.replies.push(
    turn(read()),
    () => {
      const apply = f.writeCall(modified);
      const args = JSON.parse(apply.function.arguments);
      args.expectedRevision++;
      return turn(call('apply_changes', args));
    },
    stop(),
  );
  const result = await f.runner().generate(f.request());
  assert.equal(result.run?.status, 'no_changes');
  assert.equal(dispatchedWrites, 0, 'Rejected before the dispatcher can adopt another revision.');
  assert.equal(f.sources.get(f.project.id).revision, 1);
  assert.equal(f.sources.get(f.project.id).files[0].content, original);
  assert.equal(JSON.parse(f.bodies[2].messages.at(-1)!.content!).error.code, 'SOURCE_CONFLICT');
});
