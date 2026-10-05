import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  GAP_EVIDENCE_LIMITS,
  GapEvidenceStore,
  parseGapBinding,
  parseGapEvidenceRequest,
} from '../src/main/gap-evidence-store';
import { ProjectStore } from '../src/main/project-store';
import { AppError } from '../src/main/validation';
import type { GapEvidence, GapEvidenceRequest } from '../src/shared/gap-contracts';

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const request = (projectId: string = randomUUID()): GapEvidenceRequest => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  projectId,
  binding: {
    planRunId: randomUUID(),
    planInputHash: 'a'.repeat(64),
    planArtifactHash: 'b'.repeat(64),
    sourceRevision: 3,
    sourceHash: 'c'.repeat(64),
    buildId: randomUUID(),
    artifactHash: 'd'.repeat(64),
  },
  taskId: 'F001',
  verdict: 'passed',
  filePaths: ['src/app.tsx'],
  steps: '打开通用测试应用\n填写并保存一个条目',
  expected: '条目应保留',
  actual: '重开后仍可见',
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-gap-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '通用差距证据', idea: '全部为独立合成记录' });
  const store = new GapEvidenceStore(projects);
  const file = join(root, 'projects', project.id, 'runs', 'gap-evidence.json');
  const reopen = () => new GapEvidenceStore(new ProjectStore(root));
  const input = request(project.id);
  return { root, projects, id: project.id, store, file, reopen, input };
}
const disk = (projectId: string, evidence: GapEvidence[]) =>
  JSON.stringify({ schemaVersion: 1, projectId, evidence }) + '\n';
function copies(entry: GapEvidence, count: number): GapEvidence[] {
  return Array.from({ length: count }, () => ({
    ...entry,
    id: randomUUID(),
    request: { ...entry.request, requestId: randomUUID() },
  }));
}

test('request parser trims bounded text, preserves file order and supports nullable paired build binding', () => {
  const original = request();
  original.steps = '  依次打开\n保存 😀  ';
  original.filePaths = ['src/style.css', 'src/app.tsx'];
  const parsed = parseGapEvidenceRequest(original);
  assert.equal(parsed.steps, '依次打开\n保存 😀');
  assert.deepEqual(parsed.filePaths, original.filePaths);
  parsed.filePaths.push('src/other.ts');
  assert.equal(original.filePaths.length, 2);
  assert.deepEqual(parseGapBinding({ ...original.binding, buildId: null, artifactHash: null }), {
    ...original.binding,
    buildId: null,
    artifactHash: null,
  });
  for (const taskId of ['P001', 'D050', 'F099', 'A999'])
    assert.equal(parseGapEvidenceRequest({ ...original, taskId }).taskId, taskId);
  assert.equal(
    parseGapEvidenceRequest({ ...original, verdict: 'missing', filePaths: [] }).verdict,
    'missing',
  );
  assert.equal(
    parseGapEvidenceRequest({ ...original, expected: '字'.repeat(2000) }).expected.length,
    2000,
  );
});

test('strict request and binding fields reject unknown/missing fields, accessors, prototypes and noncanonical IDs/hashes', () => {
  const valid = request();
  const { actual: _actual, ...missingActual } = valid;
  let reads = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'actual', {
    enumerable: true,
    get() {
      reads++;
      return 'unsafe';
    },
  });
  for (const value of [
    missingActual,
    { ...valid, extra: true },
    { ...valid, [Symbol('extra')]: true },
    accessor,
    Object.assign(Object.create({ inherited: true }), valid),
    { ...valid, origin: 'model' },
    { ...valid, schemaVersion: 2 },
    { ...valid, requestId: valid.requestId.toUpperCase() },
    { ...valid, projectId: '../outside' },
  ])
    assert.throws(() => parseGapEvidenceRequest(value), code('INVALID_INPUT'));
  assert.equal(reads, 0);
  for (const binding of [
    { ...valid.binding, extra: true },
    { ...valid.binding, buildId: null },
    { ...valid.binding, artifactHash: null },
    { ...valid.binding, sourceRevision: -1 },
    { ...valid.binding, sourceRevision: 1.5 },
    { ...valid.binding, sourceHash: 'E'.repeat(64) },
    { ...valid.binding, planRunId: '../bad' },
  ])
    assert.throws(() => parseGapBinding(binding), code('INVALID_INPUT'));
  const hidden = { ...valid };
  Object.defineProperty(hidden, 'actual', { value: 'hidden', enumerable: false });
  assert.throws(() => parseGapEvidenceRequest(hidden), code('INVALID_INPUT'));
});

test('task, verdict, text, Unicode and portable path bounds reject invalid input without quoting it', () => {
  const valid = request();
  for (const taskId of ['F01', 'F1000', ' F001', 'f001', 'X001', 'F001\n'])
    assert.throws(() => parseGapEvidenceRequest({ ...valid, taskId }), code('INVALID_INPUT'));
  for (const verdict of ['success', 'pending', '', null])
    assert.throws(() => parseGapEvidenceRequest({ ...valid, verdict }), code('INVALID_INPUT'));
  for (const field of ['steps', 'expected', 'actual'])
    for (const value of [
      '',
      '   ',
      'x'.repeat(2001),
      '\u0000private',
      '\u0085private',
      '\ud800',
      '\udfff',
    ])
      assert.throws(
        () => parseGapEvidenceRequest({ ...valid, [field]: value }),
        (error) => code('INVALID_INPUT')(error) && !(error as Error).message.includes('private'),
      );
  for (const path of [
    '/tmp/private.ts',
    '../private.ts',
    'src/../private.ts',
    'src\\app.ts',
    'src/CON.ts',
    'src/App.tsx',
    'src/config/private.ts',
    'src/app.sh',
  ])
    assert.throws(
      () => parseGapEvidenceRequest({ ...valid, filePaths: [path] }),
      code('SOURCE_PATH_DENIED'),
    );
  assert.equal(
    parseGapEvidenceRequest({
      ...valid,
      filePaths: Array.from({ length: 32 }, (_, i) => `src/f${i}.ts`),
    }).filePaths.length,
    32,
  );
  for (const filePaths of [
    Array.from({ length: 33 }, (_, i) => `src/f${i}.ts`),
    ['src/app.tsx', 'src/app.tsx'],
    new Array(1),
  ])
    assert.throws(() => parseGapEvidenceRequest({ ...valid, filePaths }), code('INVALID_INPUT'));
});

test('shared secret scanning rejects raw and escaped generic credentials with a fixed safe error', () => {
  const valid = request();
  for (const secret of [
    'sk-syntheticabcdefghijklmnop',
    'Bearer abcdefghijklmnop',
    'password="synthetic-private-password"',
    '-----BEGIN PRIVATE KEY-----',
    '\\u0073\\u006b-syntheticabcdefghijklmnop',
  ]) {
    for (const field of ['steps', 'expected', 'actual'])
      assert.throws(
        () => parseGapEvidenceRequest({ ...valid, [field]: secret }),
        (error) =>
          code('GAP_EVIDENCE_SENSITIVE')(error) && !(error as Error).message.includes(secret),
      );
  }
});

test('fresh listing/replay do not create files; append generates user origin, UUID and ISO timestamp and survives reopening', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.list(f.id), []);
  assert.equal(f.store.replay(f.input), null);
  assert.equal(existsSync(f.file), false);
  const before = Date.now();
  const entry = f.store.append(f.input);
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(entry.origin, 'user');
  assert.ok(Date.parse(entry.createdAt) >= before && Date.parse(entry.createdAt) <= Date.now());
  assert.deepEqual(f.reopen().list(f.id), [entry]);
  const onDisk = readFileSync(f.file);
  assert.deepEqual(f.reopen().append(f.input), entry);
  assert.deepEqual(readFileSync(f.file), onDisk);
  const listed = f.store.list(f.id);
  listed[0]!.request.actual = 'mutated returned record';
  assert.equal(f.store.list(f.id)[0]!.request.actual, f.input.actual);
  if (process.platform !== 'win32') assert.equal(statSync(f.file).mode & 0o777, 0o600);
});

test('deduplication returns original evidence at capacity or after archive and conflicting payloads never rewrite it', (t) => {
  const f = fixture(t);
  const entry = f.store.append(f.input);
  assert.deepEqual(f.store.replay({ ...f.input, steps: `  ${f.input.steps}  ` }), entry);
  const before = readFileSync(f.file);
  for (const changed of [
    { ...f.input, actual: 'different' },
    { ...f.input, verdict: 'failed' as const },
    { ...f.input, binding: { ...f.input.binding, sourceRevision: 4 } },
    { ...f.input, filePaths: [] },
  ]) {
    assert.throws(() => f.store.replay(changed), code('REQUEST_CONFLICT'));
    assert.throws(() => f.store.append(changed), code('REQUEST_CONFLICT'));
  }
  f.projects.archive(f.id, true);
  assert.deepEqual(f.store.append(f.input), entry);
  assert.deepEqual(f.store.list(f.id), [entry]);
  assert.throws(() => f.store.append({ ...f.input, requestId: randomUUID() }), code('ARCHIVED'));
  assert.deepEqual(readFileSync(f.file), before);
});

test('record parsing rejects corrupted headers, foreign requests, duplicated IDs, invalid dates and non-user origins', (t) => {
  const f = fixture(t);
  f.store.append(f.input);
  f.store.append({ ...f.input, requestId: randomUUID(), verdict: 'failed' });
  const baseline = JSON.parse(readFileSync(f.file, 'utf8'));
  const mutations: ((raw: any) => void)[] = [
    (raw) => {
      raw.extra = true;
    },
    (raw) => {
      raw.projectId = randomUUID();
    },
    (raw) => {
      raw.evidence[0].request.projectId = randomUUID();
    },
    (raw) => {
      raw.evidence[1].id = raw.evidence[0].id;
    },
    (raw) => {
      raw.evidence[1].request.requestId = raw.evidence[0].request.requestId;
    },
    (raw) => {
      raw.evidence[0].createdAt = '2026-10-05';
    },
    (raw) => {
      raw.evidence[0].origin = 'model';
    },
    (raw) => {
      raw.evidence[0].request.binding.extra = 'untrusted';
    },
    (raw) => {
      raw.evidence[0].request.actual = 'Bearer syntheticprivatekey';
    },
    (raw) => {
      delete raw.evidence[0].request.expected;
    },
  ];
  for (const mutate of mutations) {
    const raw = structuredClone(baseline);
    mutate(raw);
    const bytes = JSON.stringify(raw);
    writeFileSync(f.file, bytes);
    assert.throws(() => f.reopen().list(f.id), code('CORRUPT_GAP_EVIDENCE'));
    assert.throws(
      () => f.store.append({ ...f.input, requestId: randomUUID() }),
      code('CORRUPT_GAP_EVIDENCE'),
    );
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
  }
  for (const bytes of [Buffer.from('{"partial":'), Buffer.from([0xff, 0xfe])]) {
    writeFileSync(f.file, bytes);
    assert.throws(() => f.reopen().list(f.id), code('CORRUPT_GAP_EVIDENCE'));
    assert.deepEqual(readFileSync(f.file), bytes);
  }
  writeFileSync(f.file, JSON.stringify({ ...baseline, schemaVersion: 2 }));
  assert.throws(() => f.reopen().list(f.id), code('UNSUPPORTED_GAP_EVIDENCE'));
});

test('removed observed files fail closed within the process, including previously corrupt evidence', (t) => {
  const f = fixture(t);
  f.store.append(f.input);
  const saved = join(f.root, 'preserved-record');
  renameSync(f.file, saved);
  assert.throws(() => f.store.list(f.id), code('MISSING_GAP_EVIDENCE'));
  assert.throws(
    () => f.store.append({ ...f.input, requestId: randomUUID() }),
    code('MISSING_GAP_EVIDENCE'),
  );
  assert.equal(existsSync(f.file), false);
  renameSync(saved, f.file);
  writeFileSync(f.file, '{broken');
  const fresh = f.reopen();
  assert.throws(() => fresh.list(f.id), code('CORRUPT_GAP_EVIDENCE'));
  rmSync(f.file);
  assert.throws(() => fresh.list(f.id), code('MISSING_GAP_EVIDENCE'));
});

test('symbolic links, hardlinks and redirected runs directories never expose or overwrite their targets', (t) => {
  const f = fixture(t);
  f.store.append(f.input);
  const saved = join(f.root, 'preserved-record');
  renameSync(f.file, saved);
  symlinkSync(saved, f.file);
  const bytes = readFileSync(saved);
  assert.throws(() => f.store.list(f.id), code('UNSAFE_PATH'));
  assert.throws(() => f.store.append({ ...f.input, requestId: randomUUID() }), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(saved), bytes);
  rmSync(f.file);
  renameSync(saved, f.file);
  linkSync(f.file, saved);
  assert.throws(() => f.reopen().list(f.id), code('UNSAFE_PATH'));
  rmSync(saved);
  const relocated = join(f.root, 'preserved-runs');
  renameSync(dirname(f.file), relocated);
  symlinkSync(relocated, dirname(f.file), 'dir');
  assert.throws(() => f.reopen().list(f.id), code('UNSAFE_PATH'));
});

test('500 record and 4 MiB limits retain existing evidence and still permit known-request replay', (t) => {
  const f = fixture(t);
  const entry = f.store.append(f.input);
  const records = [entry, ...copies(entry, GAP_EVIDENCE_LIMITS.records - 1)];
  writeFileSync(f.file, disk(f.id, records));
  const before = readFileSync(f.file);
  assert.equal(f.reopen().list(f.id).length, 500);
  assert.deepEqual(f.reopen().append(f.input), entry);
  assert.throws(
    () => f.reopen().append({ ...f.input, requestId: randomUUID() }),
    code('GAP_EVIDENCE_LIMIT'),
  );
  assert.deepEqual(readFileSync(f.file), before);
  writeFileSync(f.file, disk(f.id, [...records, ...copies(entry, 1)]));
  assert.throws(() => f.reopen().list(f.id), code('GAP_EVIDENCE_LIMIT'));
  const largeEntry = {
    ...entry,
    request: {
      ...entry.request,
      steps: '字'.repeat(2000),
      expected: '字'.repeat(2000),
      actual: '字'.repeat(2000),
    },
  };
  const count = Math.floor(
    (GAP_EVIDENCE_LIMITS.bytes - Buffer.byteLength(disk(f.id, []))) /
      (Buffer.byteLength(JSON.stringify(largeEntry)) + 1),
  );
  const full = copies(largeEntry, count);
  const bytes = disk(f.id, full);
  assert.ok(Buffer.byteLength(bytes) <= GAP_EVIDENCE_LIMITS.bytes);
  assert.ok(full.length < 500);
  writeFileSync(f.file, bytes);
  assert.throws(
    () => f.reopen().append({ ...largeEntry.request, requestId: randomUUID() }),
    code('GAP_EVIDENCE_LIMIT'),
  );
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
  writeFileSync(f.file, ' '.repeat(GAP_EVIDENCE_LIMITS.bytes + 1));
  assert.throws(() => f.reopen().list(f.id), code('GAP_EVIDENCE_LIMIT'));
});

test('before-rename failures and modified staged bytes preserve the previous evidence and safe error messages', (t) => {
  const f = fixture(t);
  f.store.append(f.input);
  const before = readFileSync(f.file);
  const next = { ...f.input, requestId: randomUUID() };
  const failed = new GapEvidenceStore(f.projects, {
    beforeRename() {
      throw new Error('private-path-and-content');
    },
  });
  assert.throws(
    () => failed.append(next),
    (error) => code('GAP_EVIDENCE_IO')(error) && !(error as Error).message.includes('private'),
  );
  assert.deepEqual(readFileSync(f.file), before);
  const changed = new GapEvidenceStore(f.projects, {
    beforeRename() {
      const temp = readdirSync(dirname(f.file)).find((name) => name.startsWith('.gap-evidence-'))!;
      writeFileSync(join(dirname(f.file), temp), 'changed temporary bytes');
    },
  });
  assert.throws(() => changed.append(next), code('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(readdirSync(dirname(f.file)), ['gap-evidence.json']);
});

test('write rechecks competing updates, archived state and disappeared files before publication', (t) => {
  const f = fixture(t);
  f.store.append(f.input);
  const competitor = { ...f.input, requestId: randomUUID(), actual: 'concurrent winner' };
  const race = new GapEvidenceStore(f.projects, {
    beforeRename: () => {
      f.store.append(competitor);
    },
  });
  assert.throws(
    () => race.append({ ...f.input, requestId: randomUUID() }),
    code('GAP_EVIDENCE_CONFLICT'),
  );
  assert.equal(f.store.list(f.id).length, 2);
  const before = readFileSync(f.file);
  const archive = new GapEvidenceStore(f.projects, {
    beforeRename: () => {
      f.projects.archive(f.id, true);
    },
  });
  assert.throws(() => archive.append({ ...f.input, requestId: randomUUID() }), code('ARCHIVED'));
  assert.deepEqual(readFileSync(f.file), before);
  f.projects.archive(f.id, false);
  const missing = new GapEvidenceStore(f.projects, {
    beforeRename: () => {
      rmSync(f.file);
    },
  });
  assert.throws(
    () => missing.append({ ...f.input, requestId: randomUUID() }),
    code('MISSING_GAP_EVIDENCE'),
  );
  assert.equal(existsSync(f.file), false);
});

test('after-rename acknowledgement loss returns only exact readable commit and uncertain corruption is preserved', (t) => {
  const f = fixture(t);
  f.store.append(f.input);
  const next = { ...f.input, requestId: randomUUID() };
  const lost = new GapEvidenceStore(f.projects, {
    afterRename() {
      throw new Error('lost acknowledgement');
    },
  });
  const result = lost.append(next);
  assert.deepEqual(f.reopen().replay(next), result);
  assert.equal(f.reopen().list(f.id).length, 2);
  const bad = new GapEvidenceStore(f.projects, {
    afterRename() {
      writeFileSync(f.file, '{broken');
      throw new Error('uncertain');
    },
  });
  assert.throws(
    () => bad.append({ ...f.input, requestId: randomUUID() }),
    code('GAP_EVIDENCE_COMMIT_UNCERTAIN'),
  );
  assert.equal(readFileSync(f.file, 'utf8'), '{broken');
});

for (const boundary of ['beforeRename', 'afterRename'] as const) {
  test(`real SIGKILL at ${boundary} preserves a complete evidence journal and request replay in a new process`, (t) => {
    const f = fixture(t);
    f.store.append(f.input);
    const before = readFileSync(f.file),
      next = { ...f.input, requestId: randomUUID() };
    const imports = `import {ProjectStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/project-store.ts')).href)}; import {GapEvidenceStore} from ${JSON.stringify(pathToFileURL(resolve('src/main/gap-evidence-store.ts')).href)}; const projects=new ProjectStore(${JSON.stringify(f.root)}); const input=${JSON.stringify(next)};`;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} new GapEvidenceStore(projects,{${boundary}(){process.kill(process.pid,'SIGKILL');}}).append(input);`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    if (boundary === 'beforeRename') assert.deepEqual(readFileSync(f.file), before);
    const fresh = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `${imports} const store=new GapEvidenceStore(projects); const prior=store.replay(input); const result=store.append(input); const replay=store.append(input); console.log(JSON.stringify({prior,result,replay,count:store.list(input.projectId).length}));`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    const result = JSON.parse(fresh.stdout);
    assert.equal(result.count, 2);
    assert.deepEqual(result.result, result.replay);
    if (boundary === 'afterRename') assert.deepEqual(result.prior, result.result);
    else assert.equal(result.prior, null);
    assert.deepEqual(result.result.request, next);
  });
}
