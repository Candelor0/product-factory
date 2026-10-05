import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { AppAiStore, appAiUsage } from '../src/main/app-ai-store';
import { ProjectStore } from '../src/main/project-store';
import { sourceHash } from '../src/main/source-protocol';
import type { AppAiGrant } from '../src/shared/app-ai-contracts';

for (const boundary of ['beforeRename', 'afterRename'] as const) {
  test(`real SIGKILL at application AI intent ${boundary} preserves grant, previous receipt and unknown reservation`, (t) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-app-ai-process-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const projects = new ProjectStore(root);
    const project = projects.create({ name: '中断记账合成项目', idea: '不调用供应商' });
    const store = new AppAiStore(projects);
    const grant: AppAiGrant = {
      enabled: true,
      purpose: '概括用户明确提交的文本',
      binding: {
        planRunId: randomUUID(),
        planInputHash: 'a'.repeat(64),
        planArtifactHash: 'b'.repeat(64),
      },
      connection: {
        id: randomUUID(),
        provider: 'custom',
        baseUrl: 'https://synthetic.invalid',
        model: 'synthetic-model',
      },
      maxCalls: 10,
      maxTokens: 100000,
      updatedAt: new Date().toISOString(),
    };
    store.update(project.id, (record) => {
      record.grant = grant;
    });
    const originalInput = {
      schemaVersion: 1,
      requestId: randomUUID(),
      text: 'private synthetic original input',
    };
    const pendingInput = {
      schemaVersion: 1,
      requestId: randomUUID(),
      text: 'private synthetic pending input',
    };
    const requestHash = (text: string) =>
      sourceHash(
        JSON.stringify({
          text,
          purpose: grant.purpose,
          binding: grant.binding,
          connection: grant.connection.id,
        }),
      );
    const originalReceipt = {
      requestId: originalInput.requestId,
      requestHash: requestHash(originalInput.text),
      reservedTokens: 2000,
      inputTokens: 5,
      outputTokens: 2,
    };
    store.update(project.id, (record) => {
      record.receipts.push(originalReceipt);
    });
    const file = join(root, 'projects', project.id, 'runs', 'app-ai.json');
    const originalBytes = readFileSync(file);
    const pendingReceipt = {
      requestId: pendingInput.requestId,
      requestHash: requestHash(pendingInput.text),
      reservedTokens: 2000,
      inputTokens: null,
      outputTokens: null,
    };
    const projectModule = pathToFileURL(resolve('src/main/project-store.ts')).href;
    const storeModule = pathToFileURL(resolve('src/main/app-ai-store.ts')).href;
    const serviceModule = pathToFileURL(resolve('src/main/app-ai-service.ts')).href;
    const imports = `import { ProjectStore } from ${JSON.stringify(projectModule)};
      import { AppAiStore, appAiUsage } from ${JSON.stringify(storeModule)};
      const root = ${JSON.stringify(root)};
      const projectId = ${JSON.stringify(project.id)};
      const projects = new ProjectStore(root);`;
    const killed = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports}
       const store = new AppAiStore(projects, { ${boundary}() { process.kill(process.pid, 'SIGKILL'); } });
       store.update(projectId, record => record.receipts.push(${JSON.stringify(pendingReceipt)}));
       throw new Error('SIGKILL hook did not stop the child');`,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const committed = boundary === 'afterRename';
    const reopened = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports}
       import { AppAiService } from ${JSON.stringify(serviceModule)};
       const store = new AppAiStore(projects);
       const record = store.get(projectId);
       let modelCalls = 0;
       const models = {
         settings: () => ({ ...record.grant.connection, connectionId:record.grant.connection.id, hasKey:true }),
         assertExportSafe: () => {},
         applicationText: async () => { modelCalls++; throw new Error('No provider is available in this test'); }
       };
       const tools = { prepare: () => ({ binding:record.grant.binding }) };
       const service = new AppAiService(projects, tools, models, store);
       const artifact = { projectId, ...record.grant.binding };
       const session = service.create(artifact, 'persistent');
       const previous = await session.execute(${JSON.stringify(originalInput)});
       const pending = ${committed ? `await session.execute(${JSON.stringify(pendingInput)})` : 'null'};
       console.log(JSON.stringify({ record, accounting:appAiUsage(record), previous, pending, modelCalls }));`,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(reopened.status, 0, reopened.stderr);
    const result = JSON.parse(reopened.stdout);
    assert.equal(result.record.revision, committed ? 3 : 2);
    assert.deepEqual(result.record.grant, grant);
    assert.deepEqual(result.record.receipts[0], originalReceipt);
    assert.deepEqual(
      result.record.receipts,
      committed ? [originalReceipt, pendingReceipt] : [originalReceipt],
    );
    assert.deepEqual(result.accounting, {
      usage: {
        calls: committed ? 2 : 1,
        inputTokens: 5,
        outputTokens: 2,
        unknownUsageCalls: committed ? 1 : 0,
      },
      budgetTokens: committed ? 2007 : 7,
    });
    assert.equal(result.previous.ok, false);
    assert.equal(result.previous.error.code, 'APP_AI_REQUEST_RECORDED');
    if (committed) {
      assert.equal(result.pending.ok, false);
      assert.equal(result.pending.error.code, 'APP_AI_REQUEST_RECORDED');
    } else {
      assert.equal(result.pending, null);
      assert.deepEqual(readFileSync(file), originalBytes);
    }
    assert.equal(result.modelCalls, 0);
    assert.deepEqual(
      appAiUsage(new AppAiStore(new ProjectStore(root)).get(project.id)),
      result.accounting,
    );
    const persisted = readFileSync(file, 'utf8');
    assert.ok(!persisted.includes(originalInput.text));
    assert.ok(!persisted.includes(pendingInput.text));
  });
}
