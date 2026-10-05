import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AppDataService } from '../src/main/app-data-service';
import { AppError } from '../src/main/validation';
import type { BuildArtifact } from '../src/shared/build-contracts';
import type { SourceToolExecutor } from '../src/main/source-tools';
import type { AppDataStore } from '../src/main/app-data-store';

const artifact: BuildArtifact = {
  schemaVersion: 1,
  id: randomUUID(),
  projectId: randomUUID(),
  createdAt: new Date().toISOString(),
  sourceRevision: 1,
  sourceHash: 'a'.repeat(64),
  planRunId: randomUUID(),
  planInputHash: 'b'.repeat(64),
  planArtifactHash: 'c'.repeat(64),
  templateVersion: 'react-preview-v1',
  compilerVersion: 'esbuild-0.28.2',
  artifactHash: 'd'.repeat(64),
  javascript: '',
  css: '',
  warnings: [],
};
const apply = (expectedRevision = 0) => ({
  schemaVersion: 1,
  operation: 'apply',
  requestId: randomUUID(),
  expectedRevision,
  changes: [{ operation: 'put', key: 'posts', value: [{ title: '保存文章' }] }],
});
const read = { schemaVersion: 1, operation: 'read' };
function fixture() {
  const calls: string[] = [];
  let denied = false;
  let changed = false;
  let fail = false;
  const records: Pick<AppDataStore, 'get' | 'apply'> = {
    get(id) {
      calls.push(`get:${id}`);
      if (fail) throw new Error('/host/credentials/SECRET');
      return { revision: 8, values: { private: 'business data' } };
    },
    apply(id) {
      calls.push(`apply:${id}`);
      return { revision: 9, appliedRevision: 9, replayed: false };
    },
  };
  const tools: Pick<SourceToolExecutor, 'prepare'> = {
    prepare: () => {
      calls.push('prepare');
      if (denied) throw new AppError('ARCHIVED', 'raw must not leak');
      return {
        binding: {
          planRunId: artifact.planRunId,
          planInputHash: changed ? 'e'.repeat(64) : artifact.planInputHash,
          planArtifactHash: artifact.planArtifactHash,
        },
      } as ReturnType<SourceToolExecutor['prepare']>;
    },
  };
  return {
    service: new AppDataService(records, tools),
    calls,
    deny: () => {
      denied = true;
    },
    change: () => {
      changed = true;
    },
    fail: () => {
      fail = true;
    },
  };
}
test('temporary windows never read project storage or validation data and reset independently', () => {
  const f = fixture();
  f.deny();
  const first = f.service.create(artifact, 'temporary');
  const second = f.service.create(artifact, 'temporary');
  assert.deepEqual(first.execute(read), { ok: true, value: { revision: 0, values: {} } });
  assert.equal(first.execute(apply()).ok, true);
  assert.deepEqual(second.execute(read), { ok: true, value: { revision: 0, values: {} } });
  assert.deepEqual(f.calls, []);
});
test('temporary updates deduplicate exactly and never blind overwrite stale state', () => {
  const s = fixture().service.create(artifact, 'temporary');
  const request = apply();
  assert.deepEqual(s.execute(request), {
    ok: true,
    value: { revision: 1, appliedRevision: 1, replayed: false },
  });
  assert.deepEqual(s.execute(request), {
    ok: true,
    value: { revision: 1, appliedRevision: 1, replayed: true },
  });
  assert.equal(
    s.execute({ ...request, changes: [{ operation: 'remove', key: 'posts' }] }).ok,
    false,
  );
  assert.equal(s.execute(apply()).ok, false);
  assert.deepEqual(s.execute(read), {
    ok: true,
    value: { revision: 1, values: { posts: [{ title: '保存文章' }] } },
  });
});
test('persistent session binds the trusted project and revalidates permissions for every operation', () => {
  const f = fixture();
  const s = f.service.create(artifact, 'persistent');
  assert.equal(s.execute(read).ok, true);
  assert.equal(s.execute(apply()).ok, true);
  assert.deepEqual(f.calls, [
    'prepare',
    `get:${artifact.projectId}`,
    'prepare',
    `apply:${artifact.projectId}`,
  ]);
  const before = f.calls.length;
  f.deny();
  const result = s.execute(apply());
  assert.equal(result.ok, false);
  assert.equal(f.calls.length, before + 1);
  assert.ok(!JSON.stringify(result).includes('raw'));
});
test('changed confirmation blocks old app access and malformed payload cannot select another project', () => {
  const f = fixture();
  const s = f.service.create(artifact, 'persistent');
  assert.equal(s.execute({ ...read, projectId: randomUUID() }).ok, false);
  assert.equal(s.execute({ ...apply(), path: '/credentials' }).ok, false);
  f.change();
  assert.equal(s.execute(read).ok, false);
  assert.ok(f.calls.every((call) => call === 'prepare'));
});
test('revocation is permanent and native data errors are never exposed', () => {
  const f = fixture();
  const s = f.service.create(artifact, 'persistent');
  f.fail();
  const error = s.execute(read);
  assert.equal(error.ok, false);
  assert.ok(!JSON.stringify(error).includes('SECRET'));
  s.revoke();
  f.calls.length = 0;
  assert.equal(s.execute(read).ok, false);
  assert.equal(s.execute(apply()).ok, false);
  assert.deepEqual(f.calls, []);
});
