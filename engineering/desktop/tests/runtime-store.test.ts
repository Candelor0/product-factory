import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProjectStore } from '../src/main/project-store';
import { RuntimeStore } from '../src/main/runtime-store';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';
import type { RuntimeReport } from '../src/shared/runtime-contracts';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const report = (): RuntimeReport => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    buildId: randomUUID(),
    artifactHash: sourceHash('artifact'),
    planRunId: randomUUID(),
    planInputHash: sourceHash('input'),
    planArtifactHash: sourceHash('plan'),
    sourceRevision: 1,
    sourceHash: sourceHash('source'),
    mode: 'preview',
    createdAt: now,
    updatedAt: now,
    status: 'observing',
    observedMs: 0,
    issues: [],
  };
};
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-runtime-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '运行观察合成测试', idea: '不调用模型' });
  const records = new RuntimeStore(projects);
  const directory = join(root, 'projects', project.id, 'runs');
  return {
    root,
    projects,
    project,
    records,
    directory,
    file: join(directory, 'runtime-reports.json'),
  };
}
test('runtime report intent and fixed issue updates survive rebuilding stores without touching source or business data', (t) => {
  const { root, projects, project, records, file } = fixture(t);
  const business = join(root, 'projects', project.id, 'data', 'articles.json');
  writeFileSync(business, 'independent user content');
  const beforeProject = readFileSync(join(root, 'projects', project.id, 'project.json'));
  assert.deepEqual(records.list(project.id), []);
  assert.equal(existsSync(file), false);
  const intent = report();
  records.save(project.id, intent);
  const observed: RuntimeReport = { ...intent, status: 'observed', observedMs: 1200 };
  records.save(project.id, observed);
  const issue: RuntimeReport = { ...observed, status: 'issues', issues: ['TYPE_ERROR'] };
  records.save(project.id, issue);
  assert.deepEqual(new RuntimeStore(new ProjectStore(root)).list(project.id), [issue]);
  const bytes = readFileSync(file);
  records.save(project.id, structuredClone(issue));
  assert.deepEqual(readFileSync(file), bytes);
  const retrieved = records.list(project.id);
  retrieved[0].issues.push('SCRIPT_ERROR');
  assert.deepEqual(records.list(project.id), [issue]);
  assert.deepEqual(readFileSync(join(root, 'projects', project.id, 'project.json')), beforeProject);
  assert.equal(readFileSync(business, 'utf8'), 'independent user content');
  assert.deepEqual(readdirSync(join(root, 'projects', project.id, 'source')), []);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  projects.archive(project.id, true);
  records.save(project.id, { ...issue, issues: ['TYPE_ERROR', 'SCRIPT_ERROR'] });
  assert.throws(() => records.save(project.id, report()), hasCode('ARCHIVED'));
});
test('immutable bindings, terminal states and append-only preview issues cannot be rewritten', (t) => {
  const { project, records, file } = fixture(t);
  const intent = report();
  records.save(project.id, intent);
  for (const mutation of [
    { buildId: randomUUID() },
    { artifactHash: sourceHash('other') },
    { planRunId: randomUUID() },
    { planInputHash: sourceHash('other') },
    { planArtifactHash: sourceHash('other') },
    { sourceRevision: 2 },
    { sourceHash: sourceHash('other') },
    { mode: 'check' },
    { createdAt: '2026-01-01T00:00:00.000Z' },
  ])
    assert.throws(
      () => records.save(project.id, { ...intent, ...mutation } as RuntimeReport),
      hasCode('RUNTIME_RECORD_CONFLICT'),
    );
  const issue: RuntimeReport = {
    ...intent,
    status: 'issues',
    observedMs: 1200,
    issues: ['TYPE_ERROR'],
  };
  records.save(project.id, issue);
  const before = readFileSync(file);
  for (const mutation of [
    { status: 'observed', issues: [] },
    { status: 'cancelled', issues: [] },
    { status: 'observing', observedMs: 0, issues: [] },
    { issues: ['SCRIPT_ERROR'] },
    { observedMs: 1199 },
  ])
    assert.throws(
      () => records.save(project.id, { ...issue, ...mutation } as RuntimeReport),
      hasCode('RUNTIME_RECORD_CONFLICT'),
    );
  assert.deepEqual(readFileSync(file), before);
  const checking = { ...report(), mode: 'check' as const };
  records.save(project.id, checking);
  records.save(project.id, { ...checking, status: 'observed', observedMs: 1200 });
  assert.throws(
    () =>
      records.save(project.id, {
        ...checking,
        status: 'issues',
        observedMs: 1200,
        issues: ['SCRIPT_ERROR'],
      }),
    hasCode('RUNTIME_RECORD_CONFLICT'),
  );
});
test('runtime records accept only fixed issue categories and bounded coherent metadata', (t) => {
  const { project, records, file } = fixture(t);
  const intent = report();
  for (const invalid of [
    { ...intent, rawMessage: 'synthetic-api-key' },
    { ...intent, issues: ['synthetic-api-key'], status: 'issues' },
    { ...intent, issues: ['TYPE_ERROR', 'TYPE_ERROR'], status: 'issues' },
    { ...intent, status: 'issues' },
    { ...intent, status: 'observing', observedMs: 1 },
    { ...intent, observedMs: -1 },
    { ...intent, observedMs: 60_001 },
    { ...intent, observedMs: 0.1 },
    { ...intent, createdAt: 'yesterday' },
    { ...intent, updatedAt: '2020-01-01T00:00:00.000Z' },
    { ...intent, mode: 'arbitrary-code' },
    { ...intent, artifactHash: 'invalid' },
    { ...intent, sourceRevision: -1 },
    { ...intent, status: 'cancelled', issues: ['TYPE_ERROR'] },
    { ...intent, status: 'observed' },
  ])
    assert.throws(
      () => records.save(project.id, invalid as RuntimeReport),
      hasCode('INVALID_INPUT'),
    );
  assert.equal(existsSync(file), false);
});
test('malformed, cross-project, duplicated and future runtime records stay untouched and block writes', (t) => {
  const { project, records, file } = fixture(t);
  records.save(project.id, report());
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  for (const mutate of [
    (raw: any) => {
      raw.unexpected = true;
    },
    (raw: any) => {
      raw.projectId = randomUUID();
    },
    (raw: any) => {
      raw.reports = [];
    },
    (raw: any) => {
      raw.reports.push(raw.reports[0]);
    },
    (raw: any) => {
      raw.reports[0].issues = ['private-error'];
    },
    (raw: any) => {
      raw.reports[0].message = 'private-error';
    },
  ]) {
    const raw = structuredClone(baseline);
    mutate(raw);
    const bytes = JSON.stringify(raw);
    writeFileSync(file, bytes);
    assert.throws(() => records.list(project.id), hasCode('CORRUPT_RUNTIME_RECORD'));
    assert.throws(() => records.save(project.id, report()), hasCode('CORRUPT_RUNTIME_RECORD'));
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
  writeFileSync(file, JSON.stringify({ ...baseline, schemaVersion: 3 }));
  const before = readFileSync(file);
  assert.throws(() => records.list(project.id), hasCode('UNSUPPORTED_RUNTIME_RECORD'));
  assert.throws(() => records.save(project.id, report()), hasCode('UNSUPPORTED_RUNTIME_RECORD'));
  assert.deepEqual(readFileSync(file), before);
});
test('pre-rename failure is atomic; post-rename failure reports uncertainty and retains the exact result', (t) => {
  const { project, projects, records, directory, file } = fixture(t);
  const intent = report();
  records.save(project.id, intent);
  const before = readFileSync(file);
  const finished: RuntimeReport = { ...intent, status: 'observed', observedMs: 1200 };
  const pre = new RuntimeStore(projects, {
    beforeRename: () => {
      throw new Error('sensitive path');
    },
  });
  assert.throws(() => pre.save(project.id, finished), hasCode('RUNTIME_RECORD_IO'));
  assert.deepEqual(readFileSync(file), before);
  const post = new RuntimeStore(projects, {
    afterRename: () => {
      throw new Error('sensitive path');
    },
  });
  assert.throws(() => post.save(project.id, finished), hasCode('RUNTIME_RECORD_COMMIT_UNCERTAIN'));
  assert.deepEqual(records.list(project.id), [finished]);
  assert.deepEqual(readdirSync(directory), ['runtime-reports.json']);
});
test('concurrent writes and archiving at rename cannot overwrite newer runtime records', (t) => {
  const { project, projects, records, file } = fixture(t);
  const first = report();
  const winner = report();
  records.save(project.id, first);
  const competing = new RuntimeStore(projects, {
    beforeRename: () => records.save(project.id, winner),
  });
  assert.throws(() => competing.save(project.id, report()), hasCode('RUNTIME_RECORD_CONFLICT'));
  assert.deepEqual(records.list(project.id), [first, winner]);
  const before = readFileSync(file);
  const archive = new RuntimeStore(projects, {
    beforeRename: () => projects.archive(project.id, true),
  });
  assert.throws(() => archive.save(project.id, report()), hasCode('ARCHIVED'));
  assert.deepEqual(readFileSync(file), before);
});
test('observed disappearance and symbolic or hard links fail closed', (t) => {
  const { root, project, records, file } = fixture(t);
  records.save(project.id, report());
  const moved = join(root, 'preserved-runtime.json');
  renameSync(file, moved);
  assert.throws(() => records.list(project.id), hasCode('MISSING_RUNTIME_RECORD'));
  assert.throws(() => records.save(project.id, report()), hasCode('MISSING_RUNTIME_RECORD'));
  symlinkSync(moved, file);
  assert.throws(() => records.list(project.id), hasCode('UNSAFE_PATH'));
  rmSync(file);
  renameSync(moved, file);
  linkSync(file, moved);
  assert.throws(() => records.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => records.save(project.id, report()), hasCode('UNSAFE_PATH'));
});
test('record count and byte limits retain the last reports and prevent unbounded growth', (t) => {
  const { project, records, file } = fixture(t);
  let final = report();
  for (let index = 0; index < 100; index++) {
    final = report();
    records.save(project.id, final);
  }
  const before = readFileSync(file);
  assert.throws(() => records.save(project.id, report()), hasCode('RUNTIME_RECORD_LIMIT'));
  records.save(project.id, final);
  assert.deepEqual(readFileSync(file), before);
  truncateSync(file, 1024 * 1024 + 1);
  assert.throws(() => records.list(project.id), hasCode('RUNTIME_RECORD_LIMIT'));
  assert.throws(() => records.save(project.id, report()), hasCode('RUNTIME_RECORD_LIMIT'));
});
