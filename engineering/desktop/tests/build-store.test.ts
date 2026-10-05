import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
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
import type { BuildArtifact } from '../src/shared/build-contracts';
import { BuildStore, buildArtifactHash } from '../src/main/build-store';
import { ProjectStore } from '../src/main/project-store';
import { sourceHash } from '../src/main/source-protocol';
import { AppError } from '../src/main/validation';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

function artifact(projectId: string, overrides: Partial<BuildArtifact> = {}): BuildArtifact {
  const value: BuildArtifact = {
    schemaVersion: 1,
    id: randomUUID(),
    projectId,
    createdAt: '2026-10-03T00:00:00.000Z',
    sourceRevision: 1,
    sourceHash: sourceHash('synthetic source snapshot'),
    planRunId: randomUUID(),
    planInputHash: sourceHash('synthetic plan input'),
    planArtifactHash: sourceHash('synthetic plan artifact'),
    templateVersion: 'react-preview-v1',
    compilerVersion: '0.28.2',
    javascript: 'console.log("synthetic build");',
    css: 'body { color: #24272b; }',
    artifactHash: '',
    warnings: [{ path: 'src/main.tsx', line: 2, message: '合成编译警告' }],
    ...overrides,
  };
  if (!('artifactHash' in overrides)) value.artifactHash = buildArtifactHash(value);
  return value;
}

function fixture(t: TestContext) {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'factory-build-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, '中文 构建 🌱');
  const projects = new ProjectStore(root);
  const project = projects.create({ name: '候选构建', idea: '合成产物，不调用模型或执行代码' });
  const store = new BuildStore(projects);
  const directory = join(root, 'projects', project.id, 'runs');
  const file = join(directory, 'builds.json');
  return { root, projects, project, store, directory, file };
}

test('empty reads do not create records; outputs reopen unchanged without touching the project manifest', (t) => {
  const { root, project, store, file, directory } = fixture(t);
  const manifest = join(root, 'projects', project.id, 'project.json');
  const before = readFileSync(manifest);
  assert.deepEqual(store.list(project.id), []);
  assert.equal(existsSync(file), false);
  assert.throws(() => store.get(project.id, randomUUID()), hasCode('BUILD_NOT_FOUND'));
  const first = artifact(project.id);
  store.save(project.id, first);
  const reopened = new BuildStore(new ProjectStore(root));
  assert.deepEqual(reopened.list(project.id), [first]);
  assert.deepEqual(reopened.get(project.id, first.id), first);
  assert.deepEqual(readFileSync(manifest), before);
  assert.deepEqual(readdirSync(directory), ['builds.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const detached = reopened.get(project.id, first.id);
  detached.warnings[0].message = 'mutated in caller';
  detached.javascript = 'modified';
  assert.deepEqual(reopened.get(project.id, first.id), first);
});

test('append preserves history and an identical retry does not rewrite the file', (t) => {
  const { project, store, file } = fixture(t);
  const first = artifact(project.id);
  const second = artifact(project.id, { sourceRevision: 2 });
  store.save(project.id, first);
  store.save(project.id, second);
  const before = readFileSync(file);
  const modified = statSync(file).mtimeMs;
  store.save(project.id, structuredClone(first));
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).mtimeMs, modified);
  assert.deepEqual(store.list(project.id), [first, second]);
});

test('a build identity cannot be reused for different source, plan, compiler, output or diagnostics', (t) => {
  const { project, store, file } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const before = readFileSync(file);
  const changes: Partial<BuildArtifact>[] = [
    { createdAt: '2026-10-03T00:00:01.000Z' },
    { sourceRevision: 2 },
    { sourceHash: sourceHash('other source') },
    { planRunId: randomUUID() },
    { planInputHash: sourceHash('other input') },
    { planArtifactHash: sourceHash('other artifact') },
    { compilerVersion: '0.28.3' },
    { javascript: 'console.log("different");' },
    { css: 'body { color: red; }' },
    { warnings: [] },
  ];
  for (const change of changes) {
    const changed = { ...first, ...change };
    changed.artifactHash = buildArtifactHash(changed);
    assert.throws(() => store.save(project.id, changed), hasCode('BUILD_CONFLICT'));
    assert.deepEqual(readFileSync(file), before);
  }
});

test('output hashes bind both named strings including their boundary and property order', (t) => {
  const { project, store, file } = fixture(t);
  const first = artifact(project.id, { javascript: 'ab', css: 'c', warnings: [] });
  const other = artifact(project.id, { javascript: 'a', css: 'bc', warnings: [] });
  assert.notEqual(first.artifactHash, other.artifactHash);
  assert.equal(first.artifactHash, sourceHash(JSON.stringify({ javascript: 'ab', css: 'c' })));
  assert.equal(buildArtifactHash({ css: 'c', javascript: 'ab' }), first.artifactHash);
  store.save(project.id, first);
  const before = readFileSync(file);
  assert.throws(
    () => store.save(project.id, { ...other, artifactHash: first.artifactHash }),
    hasCode('INVALID_INPUT'),
  );
  assert.deepEqual(readFileSync(file), before);
});

test('strict artifact schema rejects missing fields, extra messages, invalid identities, versions and counters', (t) => {
  const { project, store, file } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const before = readFileSync(file);
  const invalid: unknown[] = [
    null,
    [],
    'artifact',
    { ...first, message: 'MODEL_OUTPUT' },
    { ...first, arguments: { apiKey: 'SYNTHETIC' } },
    { ...first, schemaVersion: 2 },
    { ...first, id: '../outside' },
    { ...first, projectId: randomUUID() },
    { ...first, planRunId: first.planRunId.toUpperCase() },
    { ...first, createdAt: '2026-10-03T00:00:00Z' },
    { ...first, createdAt: 'yesterday' },
    { ...first, sourceRevision: -1 },
    { ...first, sourceRevision: 1.5 },
    { ...first, sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...first, sourceHash: 'invalid' },
    { ...first, planInputHash: 'A'.repeat(64) },
    { ...first, planArtifactHash: 'invalid' },
    { ...first, artifactHash: sourceHash('different') },
    { ...first, templateVersion: 'custom-shell' },
    { ...first, compilerVersion: '' },
    { ...first, compilerVersion: 'x'.repeat(81) },
    { ...first, compilerVersion: 'version\nprivate' },
    { ...first, javascript: null },
    { ...first, css: 1 },
    { ...first, warnings: null },
    { ...first, warnings: new Array(1) },
    { ...first, warnings: Array(21).fill(first.warnings[0]) },
  ];
  for (const key of Object.keys(first)) {
    const incomplete = { ...first } as Record<string, unknown>;
    delete incomplete[key];
    invalid.push(incomplete);
  }
  for (const value of invalid) {
    assert.throws(() => store.save(project.id, value as BuildArtifact), hasCode('INVALID_INPUT'));
    assert.deepEqual(readFileSync(file), before);
  }
});

test('diagnostics permit bounded portable source locations and reject extras, control text and host paths', (t) => {
  const { project, store, file } = fixture(t);
  const first = artifact(project.id, {
    warnings: [
      { path: null, line: null, message: 'No location' },
      { path: 'src/components/card.tsx', line: 1, message: '文'.repeat(300) },
    ],
  });
  store.save(project.id, first);
  const before = readFileSync(file);
  const invalid: unknown[] = [
    null,
    {},
    { path: null, line: null, message: '' },
    { path: null, line: null, message: 'x'.repeat(301) },
    { path: null, line: null, message: 'line\nsecond' },
    { path: null, line: null, message: 'tab\ttext' },
    { path: null, line: null, message: '\u0000' },
    { path: null, line: null, message: '\u007f' },
    { path: null, line: null, message: '\u0085' },
    { path: null, line: null, message: '\ud800' },
    { path: null, line: 0, message: 'bad line' },
    { path: null, line: 1.1, message: 'bad line' },
    { path: null, line: Number.MAX_SAFE_INTEGER + 1, message: 'bad line' },
    { path: null, line: null, message: 'valid', severity: 'warning' },
    { path: null, line: null, message: 'valid', arguments: {} },
  ];
  for (const warning of invalid)
    assert.throws(
      () => store.save(project.id, { ...first, warnings: [warning] } as BuildArtifact),
      hasCode('INVALID_INPUT'),
    );
  for (const path of ['/Users/private/file.ts', '../outside.ts', 'src/../key.ts', 'package.json'])
    assert.throws(
      () =>
        store.save(
          project.id,
          artifact(project.id, { warnings: [{ path, line: 1, message: 'x' }] }),
        ),
      hasCode('SOURCE_PATH_DENIED'),
    );
  assert.deepEqual(readFileSync(file), before);
});

test('the twentieth artifact is retained and retryable; no prior output is evicted at capacity', (t) => {
  const { project, store, file } = fixture(t);
  const history = Array.from({ length: 20 }, () => artifact(project.id));
  for (const item of history) store.save(project.id, item);
  const before = readFileSync(file);
  assert.throws(() => store.save(project.id, artifact(project.id)), hasCode('BUILD_LIMIT'));
  store.save(project.id, history[19]);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.list(project.id), history);
});

test('combined output byte limit counts multibyte text and both javascript and css', (t) => {
  const { project, store, file } = fixture(t);
  const first = artifact(project.id, { javascript: 'a'.repeat(8 * 1024 * 1024 - 3), css: '字' });
  store.save(project.id, first);
  const before = readFileSync(file);
  assert.throws(
    () =>
      store.save(project.id, artifact(project.id, { javascript: first.javascript, css: '字a' })),
    hasCode('BUILD_LIMIT'),
  );
  assert.deepEqual(readFileSync(file), before);
});

test('journal byte capacity rejects another valid output while preserving all earlier artifacts', (t) => {
  const { project, store, file, directory } = fixture(t);
  const output = 'a'.repeat(8 * 1024 * 1024);
  const history = Array.from({ length: 3 }, () =>
    artifact(project.id, { javascript: output, css: '' }),
  );
  for (const item of history) store.save(project.id, item);
  const before = sourceHash(readFileSync(file, 'utf8'));
  assert.throws(
    () => store.save(project.id, artifact(project.id, { javascript: output, css: '' })),
    hasCode('BUILD_LIMIT'),
  );
  assert.equal(sourceHash(readFileSync(file, 'utf8')), before);
  assert.deepEqual(
    store.list(project.id).map((item) => item.id),
    history.map((item) => item.id),
  );
  assert.deepEqual(readdirSync(directory), ['builds.json']);
});

test('corrupt JSON, duplicate ids, altered hashes and cross-project artifacts fail closed', (t) => {
  const { root, projects, project, store, file } = fixture(t);
  store.save(project.id, artifact(project.id));
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  const original = baseline.artifacts[0];
  const invalid = [
    '{"partial":',
    'null',
    '[]',
    JSON.stringify({ ...baseline, projectId: randomUUID() }),
    JSON.stringify({ ...baseline, extra: true }),
    JSON.stringify({ ...baseline, artifacts: [] }),
    JSON.stringify({ ...baseline, artifacts: [original, original] }),
    JSON.stringify({ ...baseline, artifacts: Array(21).fill(original) }),
    JSON.stringify({ ...baseline, artifacts: [{ ...original, projectId: randomUUID() }] }),
    JSON.stringify({ ...baseline, artifacts: [{ ...original, javascript: 'tampered' }] }),
    JSON.stringify({ ...baseline, artifacts: [{ ...original, css: 'tampered' }] }),
    JSON.stringify({ ...baseline, artifacts: [{ ...original, schemaVersion: 2 }] }),
    JSON.stringify({ ...baseline, artifacts: [{ ...original, modelMessage: 'must not persist' }] }),
  ];
  for (const bytes of invalid) {
    writeFileSync(file, bytes);
    assert.throws(() => store.list(project.id), hasCode('CORRUPT_BUILD'));
    assert.throws(() => store.get(project.id, original.id), hasCode('CORRUPT_BUILD'));
    assert.throws(() => store.save(project.id, artifact(project.id)), hasCode('CORRUPT_BUILD'));
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
  const other = projects.create({ name: '其他项目', idea: '项目命名空间合成检查' });
  const copied = join(root, 'projects', other.id, 'runs', 'builds.json');
  writeFileSync(copied, JSON.stringify(baseline));
  assert.throws(() => store.list(other.id), hasCode('CORRUPT_BUILD'));
});

test('future journals and oversized files are retained without reinitialization', (t) => {
  const { project, store, file } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...baseline, schemaVersion: 2 }));
  const future = readFileSync(file);
  assert.throws(() => store.list(project.id), hasCode('UNSUPPORTED_BUILD'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSUPPORTED_BUILD'));
  assert.deepEqual(readFileSync(file), future);
  truncateSync(file, 32 * 1024 * 1024 + 1);
  assert.throws(() => store.list(project.id), hasCode('BUILD_LIMIT'));
  assert.throws(() => store.save(project.id, first), hasCode('BUILD_LIMIT'));
  assert.equal(statSync(file).size, 32 * 1024 * 1024 + 1);
});

test('observed missing files cannot be silently recreated, and restoration recovers reading', (t) => {
  const { root, projects, project, store, file } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const reopened = new BuildStore(projects);
  reopened.list(project.id);
  const moved = join(root, 'moved-builds.json');
  renameSync(file, moved);
  for (const instance of [store, reopened]) {
    assert.throws(() => instance.list(project.id), hasCode('MISSING_BUILD'));
    assert.throws(() => instance.get(project.id, first.id), hasCode('MISSING_BUILD'));
    assert.throws(() => instance.save(project.id, first), hasCode('MISSING_BUILD'));
  }
  assert.equal(existsSync(file), false);
  renameSync(moved, file);
  assert.deepEqual(store.get(project.id, first.id), first);
});

test('symlinked files and parent directories cannot redirect build storage', (t) => {
  const { root, project, store, file, directory } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const moved = join(root, 'moved-builds.json');
  renameSync(file, moved);
  const before = readFileSync(moved);
  symlinkSync(moved, file, 'file');
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(moved), before);
  rmSync(file);
  renameSync(moved, file);
  const movedDirectory = join(root, 'moved-runs');
  renameSync(directory, movedDirectory);
  symlinkSync(movedDirectory, directory, 'dir');
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(join(movedDirectory, 'builds.json')), before);
});

test('hardlinks and non-file entries are rejected without replacing the referenced output', (t) => {
  const { root, project, store, file } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const linked = join(root, 'linked-builds.json');
  linkSync(file, linked);
  const before = readFileSync(linked);
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
  assert.deepEqual(readFileSync(linked), before);
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => store.list(project.id), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.save(project.id, first), hasCode('UNSAFE_PATH'));
});

test('failure before rename retains prior bytes and cleans only the writer temporary file', (t) => {
  const { projects, project, store, file, directory } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const before = readFileSync(file);
  const unrelated = join(directory, 'coding.json');
  writeFileSync(unrelated, 'unrelated synthetic artifact');
  const get = projects.get.bind(projects);
  projects.get = (id) => {
    if (readdirSync(directory).some((name) => name.startsWith('.build-')))
      throw new Error('SYNTHETIC_SECRET /private/host');
    return get(id);
  };
  assert.throws(
    () => store.save(project.id, artifact(project.id)),
    (error: unknown) =>
      hasCode('BUILD_IO')(error) && !(error as Error).message.includes('SYNTHETIC_SECRET'),
  );
  projects.get = get;
  assert.deepEqual(readFileSync(file), before);
  assert.equal(readFileSync(unrelated, 'utf8'), 'unrelated synthetic artifact');
  assert.deepEqual(readdirSync(directory).sort(), ['builds.json', 'coding.json']);
  const second = artifact(project.id);
  store.save(project.id, second);
  assert.deepEqual(store.list(project.id), [first, second]);
});

test('a concurrent journal change is retained and not overwritten by the prepared candidate', (t) => {
  const { projects, project, store, file, directory } = fixture(t);
  const first = artifact(project.id);
  const concurrent = artifact(project.id);
  store.save(project.id, first);
  const get = projects.get.bind(projects);
  let injected = false;
  projects.get = (id) => {
    if (!injected && readdirSync(directory).some((name) => name.startsWith('.build-'))) {
      injected = true;
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          projectId: project.id,
          artifacts: [first, concurrent],
        }) + '\n',
      );
    }
    return get(id);
  };
  assert.throws(() => store.save(project.id, artifact(project.id)), hasCode('BUILD_CONFLICT'));
  projects.get = get;
  assert.deepEqual(store.list(project.id), [first, concurrent]);
  assert.deepEqual(readdirSync(directory), ['builds.json']);
});

test('archived projects remain readable but reject new outputs and identical retries', (t) => {
  const { projects, project, store, file } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const before = readFileSync(file);
  projects.archive(project.id, true);
  assert.deepEqual(store.list(project.id), [first]);
  assert.deepEqual(store.get(project.id, first.id), first);
  assert.throws(() => store.save(project.id, first), hasCode('ARCHIVED'));
  assert.throws(() => store.save(project.id, artifact(project.id)), hasCode('ARCHIVED'));
  assert.deepEqual(readFileSync(file), before);
});

test('project and build identifiers are validated and cannot read another project output', (t) => {
  const { projects, project, store } = fixture(t);
  const first = artifact(project.id);
  store.save(project.id, first);
  const other = projects.create({ name: '另一个项目', idea: '跨项目读取边界' });
  assert.throws(() => store.get(other.id, first.id), hasCode('BUILD_NOT_FOUND'));
  for (const id of ['../outside', '/etc/passwd', project.id.toUpperCase()]) {
    assert.throws(() => store.list(id), hasCode('INVALID_INPUT'));
    assert.throws(() => store.save(id, artifact(id)), hasCode('INVALID_INPUT'));
    assert.throws(() => store.get(project.id, id), hasCode('INVALID_INPUT'));
  }
});
