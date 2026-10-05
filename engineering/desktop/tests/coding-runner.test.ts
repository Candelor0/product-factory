import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProjectStore } from '../src/main/project-store';
import { PlanStore } from '../src/main/plan-store';
import { SourceStore } from '../src/main/source-store';
import { SourceToolExecutor } from '../src/main/source-tools';
import { CodingStore } from '../src/main/coding-store';
import { CodingRunner } from '../src/main/coding-runner';
import { ModelService } from '../src/main/model-service';
import { AppError } from '../src/main/validation';
import type { CodingRequest } from '../src/shared/coding-contracts';
import type { ModelToolTurn } from '../src/shared/model-tool-contracts';

const requirements = {
  summary: '合成笔记',
  audience: '自己',
  features: ['阅读笔记'],
  pages: ['笔记列表'],
  data: ['笔记'],
  outOfScope: ['联网'],
  questions: [],
  acceptance: ['可阅读笔记'],
};
const design = {
  direction: '简洁浅色',
  palette: ['#ffffff'],
  pages: [{ name: '笔记列表', sections: ['列表'] }],
  notes: [],
};
const stop = (): ModelToolTurn => ({
  finishReason: 'stop',
  message: { role: 'assistant', content: '本次草稿结束。' },
});
function calls(name: string, args: object, id: string = randomUUID()): ModelToolTurn {
  return {
    finishReason: 'tool_calls',
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
  };
}
const write = (revision = 0, path = 'src/app.tsx') =>
  calls('apply_changes', {
    expectedRevision: revision,
    changes: [
      {
        operation: 'write',
        path,
        expectedHash: null,
        content: 'export default function App() { return <h1>合成笔记</h1>; }',
      },
    ],
  });
function fixture(t: TestContext, transport?: typeof fetch, maxCalls = 20) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), '源码回合-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const plans = new PlanStore(projects);
  const sources = new SourceStore(projects);
  const tools = new SourceToolExecutor(projects, plans, sources);
  const records = new CodingStore(projects);
  let project = projects.create({ name: '合成笔记', idea: '只验证模型工具和文本草稿' });
  project = projects.saveRequirements(project.id, requirements);
  project = projects.approveRequirements(project.id, project.requirements.at(-1)!.id);
  project = projects.saveDesign(project.id, design);
  project = projects.approveDesign(project.id, project.designs.at(-1)!.id);
  const plan = plans.create({
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    requirementId: project.requirements.at(-1)!.id,
    designId: project.designs.at(-1)!.id,
    profile: 'web',
  });
  const request: CodingRequest = {
    schemaVersion: 1,
    requestId: randomUUID(),
    projectId: project.id,
    planRunId: plan.run!.id,
  };
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
    transport,
  );
  models.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'SYNTHETIC-CODING-KEY',
    maxCalls,
  });
  return {
    root,
    projects,
    plans,
    sources,
    tools,
    records,
    models,
    request,
    runner: new CodingRunner(records, sources, tools, models),
  };
}
function transport(
  turns: ModelToolTurn[],
  inspect?: (body: any, index: number) => void,
): typeof fetch {
  let index = 0;
  return (async (_url, init) => {
    inspect?.(JSON.parse(init!.body as string), index);
    const turn = turns[index++];
    assert.ok(turn, 'no unexpected paid retry');
    return Response.json({
      choices: [{ finish_reason: turn.finishReason, message: turn.message }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
  }) as typeof fetch;
}

test('real transport loop preserves call IDs and complete confirmed inputs, saves inert source, and never marks tasks implemented', async (t) => {
  const bodies: any[] = [];
  const f = fixture(
    t,
    transport([calls('list_files', {}, 'list_1'), write(), stop()], (body) => bodies.push(body)),
  );
  const manifest = readFileSync(join(f.root, 'projects', f.request.projectId, 'project.json'));
  const state = await f.runner.generate(f.request);
  assert.equal(state.run?.status, 'draft_saved');
  assert.equal(state.run?.rounds, 3);
  assert.equal(state.run?.toolCalls, 2);
  assert.equal(state.revision, 1);
  assert.equal(state.execution, 'disabled');
  assert.equal(f.models.usage().calls, 3);
  const prepared = JSON.parse(bodies[0].messages[1].content);
  assert.deepEqual(prepared.requirements.content, requirements);
  assert.deepEqual(prepared.design.content, design);
  assert.equal(bodies[1].messages[2].tool_calls[0].id, 'list_1');
  assert.equal(bodies[1].messages[3].tool_call_id, 'list_1');
  assert.equal(JSON.parse(bodies[1].messages[3].content).data.revision, 0);
  assert.equal(bodies[0].thinking.type, 'disabled');
  assert.equal(bodies[0].response_format, undefined);
  const journal = readFileSync(
    join(f.root, 'projects', f.request.projectId, 'runs', 'coding.json'),
    'utf8',
  );
  assert.equal(journal.includes('SYNTHETIC-CODING-KEY'), false);
  assert.equal(journal.includes('export default'), false);
  assert.equal(existsSync(join(f.root, 'projects', f.request.projectId, 'source', 'src')), false);
  assert.deepEqual(
    readFileSync(join(f.root, 'projects', f.request.projectId, 'project.json')),
    manifest,
  );
  assert.ok(
    f.plans
      .get(f.request.projectId)
      .run!.plan.tasks.every(
        (task) => task.implementation === 'pending' && task.verification === 'not_run',
      ),
  );
  const reopened = new CodingRunner(
    new CodingStore(f.projects),
    new SourceStore(f.projects),
    f.tools,
    f.models,
  );
  assert.deepEqual(await reopened.generate(f.request), state);
  assert.equal(f.models.usage().calls, 3);
  assert.match(reopened.file(f.request.projectId, 'src/app.tsx').content, /合成笔记/);
});

test('same run ID with changed input is rejected before any new model request', async (t) => {
  const f = fixture(t, transport([stop()]));
  await f.runner.generate(f.request);
  await assert.rejects(f.runner.generate({ ...f.request, planRunId: randomUUID() }), {
    code: 'CODING_CONFLICT',
  });
  assert.equal(f.models.usage().calls, 1);
});

test('natural completion without committed changes is not labeled saved', async (t) => {
  const f = fixture(t, transport([stop()]));
  assert.equal((await f.runner.generate(f.request)).run?.status, 'no_changes');
  assert.equal(f.sources.get(f.request.projectId).revision, 0);
});

test('four model rounds is a hard stop even when the model keeps asking for tools', async (t) => {
  const f = fixture(t, transport(Array.from({ length: 4 }, () => calls('list_files', {}))));
  const state = await f.runner.generate(f.request);
  assert.equal(state.run?.status, 'limited');
  assert.equal(state.run?.rounds, 4);
  assert.equal(f.models.usage().calls, 4);
});

test('tool budget rejects the entire exceeding round before executing any of it', async (t) => {
  const batch = () => ({
    ...calls('list_files', {}),
    message: {
      role: 'assistant' as const,
      content: null,
      tool_calls: Array.from({ length: 4 }, () => calls('list_files', {}).message.tool_calls![0]),
    },
  });
  const f = fixture(t, transport([batch(), batch(), batch(), write()]));
  const state = await f.runner.generate(f.request);
  assert.equal(state.run?.status, 'limited');
  assert.equal(state.run?.toolCalls, 12);
  assert.equal(state.revision, 0);
});

test('persisted global budget stops further network requests while retaining committed source', async (t) => {
  const f = fixture(t, transport([calls('list_files', {}), write()]), 2);
  const state = await f.runner.generate(f.request);
  assert.equal(state.run?.status, 'failed');
  assert.equal(state.run?.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(state.revision, 1);
  assert.equal(f.models.usage().calls, 2);
});

test('network errors are sanitized and not automatically retried', async (t) => {
  let attempts = 0;
  const f = fixture(t, (async () => {
    attempts++;
    throw new Error('/private/SECRET');
  }) as typeof fetch);
  const state = await f.runner.generate(f.request);
  assert.equal(attempts, 1);
  assert.equal(state.run?.errorCode, 'NETWORK_ERROR');
  assert.equal(JSON.stringify(state).includes('SECRET'), false);
  assert.equal(state.revision, 0);
});

test('cancel ignores a delayed transport result and prevents new source writes', async (t) => {
  let reply!: (value: Response) => void;
  const f = fixture(
    t,
    (() =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      })) as typeof fetch,
  );
  const pending = f.runner.generate(f.request);
  assert.equal(f.runner.state(f.request.projectId).run?.status, 'running');
  await assert.rejects(f.runner.generate({ ...f.request, requestId: randomUUID() }), {
    code: 'BUSY',
  });
  f.runner.cancel();
  const state = await pending;
  assert.equal(state.run?.status, 'cancelled');
  const turn = write();
  reply(Response.json({ choices: [{ finish_reason: turn.finishReason, message: turn.message }] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sources.get(f.request.projectId).revision, 0);
});

test('cancel between tools preserves the first atomic commit and blocks the next', async (t) => {
  const f = fixture(t);
  const runner = new CodingRunner(f.records, f.sources, f.tools, {
    toolTurn: async () => ({
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          ...write().message.tool_calls!,
          ...write(1, 'src/second.tsx').message.tool_calls!,
        ],
      },
    }),
  });
  const execute = f.tools.execute.bind(f.tools);
  f.tools.execute = (context, input) => {
    const response = execute(context, input);
    runner.cancel();
    return response;
  };
  const state = await runner.generate(f.request);
  assert.equal(state.run?.status, 'cancelled');
  assert.equal(state.revision, 1);
  assert.deepEqual(
    state.files.map((file) => file.path),
    ['src/app.tsx'],
  );
});

test('confirmation changes while awaiting the model stop tools before any write', async (t) => {
  const f = fixture(t);
  const runner = new CodingRunner(f.records, f.sources, f.tools, {
    toolTurn: async () => {
      f.projects.saveRequirements(f.request.projectId, { ...requirements, audience: '新的用户' });
      return write();
    },
  });
  const state = await runner.generate(f.request);
  assert.equal(state.run?.errorCode, 'CONFIRMATION_REQUIRED');
  assert.equal(state.revision, 0);
});

test('invalid path tool result reaches the next model round without exposing native paths', async (t) => {
  let response: any;
  const f = fixture(
    t,
    transport([write(0, '../credentials/provider.json'), stop()], (body, i) => {
      if (i === 1) response = JSON.parse(body.messages.at(-1).content);
    }),
  );
  const state = await f.runner.generate(f.request);
  assert.equal(response.error.code, 'SOURCE_PATH_DENIED');
  assert.equal(JSON.stringify(response).includes('credentials'), false);
  assert.equal(state.revision, 0);
});

test('post-rename uncertainty is reconciled once with same transaction ID before another model request', async (t) => {
  const f = fixture(t, transport([write(), stop()]));
  const faulted = new SourceStore(f.projects, {
    afterRename() {
      throw new Error('PRIVATE');
    },
  });
  const runner = new CodingRunner(
    f.records,
    faulted,
    new SourceToolExecutor(f.projects, f.plans, faulted),
    f.models,
  );
  const state = await runner.generate(f.request);
  assert.equal(state.run?.status, 'draft_saved');
  assert.equal(state.revision, 1);
  assert.equal(state.run?.toolCalls, 1);
  assert.equal(f.models.usage().calls, 2);
});

test('persisted running record is shown as interrupted and never automatically reissued', async (t) => {
  const f = fixture(t, transport([]));
  const now = new Date().toISOString();
  f.records.save(f.request.projectId, {
    id: f.request.requestId,
    requestHash: createHash('sha256').update(JSON.stringify(f.request)).digest('hex'),
    planRunId: f.request.planRunId,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    initialRevision: 0,
    rounds: 1,
    toolCalls: 0,
    toolRequests: [],
    errorCode: null,
  });
  assert.equal(f.runner.state(f.request.projectId).run?.status, 'interrupted');
  assert.equal((await f.runner.generate(f.request)).run?.status, 'interrupted');
  assert.equal(f.models.usage().calls, 0);
});

test('failure to durably record intent prevents a paid request', async (t) => {
  const f = fixture(t, transport([]));
  f.records.save = () => {
    throw new AppError('CODING_IO', 'synthetic disk failure');
  };
  await assert.rejects(f.runner.generate(f.request), { code: 'CODING_IO' });
  assert.equal(f.models.usage().calls, 0);
});

test('unconfirmed, archived and forged requests cannot begin generation', async (t) => {
  const f = fixture(t, transport([]));
  await assert.rejects(f.runner.generate({ ...f.request, command: 'arbitrary' }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(f.runner.generate({ ...f.request, planRunId: randomUUID() }), {
    code: 'STALE_PLAN',
  });
  f.projects.archive(f.request.projectId, true);
  await assert.rejects(f.runner.generate(f.request), { code: 'ARCHIVED' });
  f.projects.archive(f.request.projectId, false);
  f.projects.saveRequirements(f.request.projectId, requirements);
  await assert.rejects(f.runner.generate(f.request), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(f.models.usage().calls, 0);
});

test('missing key is actionable and no network request is made', async (t) => {
  const f = fixture(t, transport([]));
  f.models.deleteKey();
  assert.equal((await f.runner.generate(f.request)).run?.errorCode, 'KEY_REQUIRED');
  assert.equal(f.models.usage().calls, 0);
});

test('transport timeout and direct model cancellation preserve their actual error codes', async (t) => {
  for (const code of ['TIMEOUT', 'CANCELLED']) {
    const f = fixture(t);
    const runner = new CodingRunner(f.records, f.sources, f.tools, {
      toolTurn: async () => {
        throw new AppError(code, 'hidden');
      },
    });
    const state = await runner.generate(f.request);
    assert.equal(state.run?.errorCode, code);
    assert.equal(state.run?.status, code === 'CANCELLED' ? 'cancelled' : 'failed');
  }
});

test('committed source transaction IDs can be linked back to persisted run metadata', async (t) => {
  const f = fixture(t, transport([write(), stop()]));
  const state = await f.runner.generate(f.request);
  const source = JSON.parse(
    readFileSync(join(f.root, 'projects', f.request.projectId, 'source', 'workspace.json'), 'utf8'),
  );
  assert.equal(source.commits[0].request.requestId, state.run!.toolRequests[0].requestId);
  assert.match(state.run!.toolRequests[0].callHash, /^[0-9a-f]{64}$/);
});

test('post-rename coding terminal uncertainty confirms exact saved outcome without overwriting', async (t) => {
  const f = fixture(t);
  const save = f.records.save.bind(f.records);
  let terminalWrites = 0;
  let calls = 0;
  f.records.save = (projectId, run) => {
    save(projectId, run);
    if (run.status !== 'running') {
      terminalWrites++;
      throw new AppError('CODING_COMMIT_UNCERTAIN', 'synthetic post-rename failure');
    }
  };
  f.models.toolTurn = async () => {
    calls++;
    return stop();
  };
  const result = await f.runner.generate(f.request);
  assert.equal(result.run?.status, 'no_changes');
  assert.equal(terminalWrites, 1);
  assert.equal(calls, 1);
  assert.deepEqual(await f.runner.generate(f.request), result);
  assert.equal(calls, 1);
});

test('unconfirmed coding intent does not call model or guess a failed terminal write', async (t) => {
  const f = fixture(t);
  const save = f.records.save.bind(f.records);
  let calls = 0;
  let writesAfterFault = 0;
  let faulted = false;
  f.records.save = (projectId, run) => {
    if (faulted) writesAfterFault++;
    if (run.rounds === 1) {
      faulted = true;
      throw new AppError('CODING_COMMIT_UNCERTAIN', 'synthetic mismatch');
    }
    save(projectId, run);
  };
  f.models.toolTurn = async () => {
    calls++;
    return stop();
  };
  await assert.rejects(f.runner.generate(f.request), { code: 'CODING_COMMIT_UNCERTAIN' });
  assert.equal(calls, 0);
  assert.equal(writesAfterFault, 0);
  assert.equal(f.runner.state(f.request.projectId).run?.status, 'interrupted');
  assert.equal((await f.runner.generate(f.request)).run?.status, 'interrupted');
});

test('unreadable coding terminal uncertainty preserves committed result and original error', async (t) => {
  const f = fixture(t);
  const save = f.records.save.bind(f.records);
  const list = f.records.list.bind(f.records);
  let unreadable = false;
  let terminalWrites = 0;
  f.records.list = (projectId) => {
    if (unreadable) throw new AppError('CORRUPT_CODING', 'synthetic unreadable');
    return list(projectId);
  };
  f.records.save = (projectId, run) => {
    save(projectId, run);
    if (run.status !== 'running') {
      terminalWrites++;
      unreadable = true;
      throw new AppError('CODING_COMMIT_UNCERTAIN', 'synthetic post-rename fault');
    }
  };
  f.models.toolTurn = async () => stop();
  await assert.rejects(f.runner.generate(f.request), { code: 'CODING_COMMIT_UNCERTAIN' });
  assert.equal(terminalWrites, 1);
  unreadable = false;
  assert.equal(list(f.request.projectId).at(-1)?.status, 'no_changes');
});
