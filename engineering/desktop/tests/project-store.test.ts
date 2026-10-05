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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../src/main/project-store.js';
import { AppError } from '../src/main/validation.js';
import type { DesignContent, RequirementContent } from '../src/shared/contracts.js';

const requirements = (summary = '我想写个人博客'): RequirementContent => ({
  summary,
  audience: '自己和朋友',
  features: ['创建与编辑文章'],
  pages: ['文章列表', '文章详情'],
  data: ['文章标题与正文'],
  outOfScope: ['公网发布'],
  questions: ['是否需要封面图？'],
  acceptance: ['重启后文章仍可打开'],
});
const design = (): DesignContent => ({
  direction: '温暖简洁，专注文字',
  palette: ['#F8F6F2', '#202020'],
  pages: [{ name: '文章列表', sections: ['标题', '文章卡片'] }],
  notes: ['封面图片仍待确认'],
});

function fixture(t: { after: (callback: () => void) => void }): {
  root: string;
  store: ProjectStore;
} {
  // macOS exposes /var as a symlink; use its canonical spelling for storage-path tests.
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'factory-store-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, '中文 空格 🌱', '产品资料');
  return { root, store: new ProjectStore(root) };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

test('projects persist through reopen in Unicode paths and preserve separate directories', (t) => {
  const { root, store } = fixture(t);
  const first = store.create({ name: '个人博客', idea: '记录读书和生活' });
  const second = store.create({ name: '第二个项目', idea: '独立的内容' });
  store.saveRequirements(first.id, requirements());
  store.saveRequirements(second.id, requirements('第二份需求'));
  store.rename(first.id, '读书笔记');
  store.archive(first.id, true);
  const reopened = new ProjectStore(root);
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.get(first.id).name, '读书笔记');
  assert.equal(reopened.get(first.id).archived, true);
  assert.equal(reopened.get(first.id).requirements[0]!.content.summary, '我想写个人博客');
  assert.equal(reopened.get(second.id).requirements[0]!.content.summary, '第二份需求');
  assert.equal(reopened.archive(first.id, false).archived, false);
  assert.deepEqual(readdirSync(join(root, 'projects', first.id)).sort(), [
    'checkpoints',
    'data',
    'documents',
    'project.json',
    'runs',
    'source',
  ]);
  assert.equal(existsSync(join(root, 'project.json')), false);
});

test('confirmations bind current revisions and requirement changes invalidate readiness without deleting history', (t) => {
  const { root, store } = fixture(t);
  let project = store.create({ name: '博客', idea: '记录生活' });
  assert.equal(project.stage, 'idea');
  assert.throws(() => store.saveDesign(project.id, design()), hasCode('REQUIREMENTS_NOT_APPROVED'));
  project = store.saveRequirements(project.id, requirements());
  const firstRequirements = structuredClone(project.requirements[0]!);
  assert.equal(project.stage, 'requirements');
  project = store.approveRequirements(project.id, firstRequirements.id);
  assert.equal(project.stage, 'design');
  project = store.saveDesign(project.id, design());
  const firstDesign = structuredClone(project.designs[0]!);
  assert.equal(firstDesign.basedOn, firstRequirements.id);
  project = store.approveDesign(project.id, firstDesign.id);
  assert.equal(project.stage, 'ready');
  const approvedAt = project.designs[0]!.approvedAt;
  assert.ok(approvedAt);
  project = store.approveDesign(project.id, firstDesign.id);
  assert.equal(project.designs[0]!.approvedAt, approvedAt, 'repeat confirmation is idempotent');
  project = store.saveRequirements(project.id, requirements('新的需求版本'));
  assert.equal(project.stage, 'requirements');
  assert.equal(
    project.designs[0]!.approvedAt,
    approvedAt,
    'historical confirmation evidence is retained',
  );
  assert.deepEqual(project.requirements[0]!.content, firstRequirements.content);
  assert.equal(project.requirements[0]!.hash, firstRequirements.hash);
  assert.throws(
    () => store.approveRequirements(project.id, firstRequirements.id),
    hasCode('STALE_REVISION'),
  );
  assert.throws(() => store.approveDesign(project.id, firstDesign.id), hasCode('STALE_REVISION'));
  project = store.approveRequirements(project.id, project.requirements[1]!.id);
  assert.equal(project.stage, 'design');
  assert.throws(() => store.approveDesign(project.id, firstDesign.id), hasCode('STALE_REVISION'));
  project = store.saveDesign(project.id, design());
  assert.equal(project.designs[1]!.basedOn, project.requirements[1]!.id);
  assert.throws(() => store.approveDesign(project.id, firstDesign.id), hasCode('STALE_REVISION'));
  project = store.approveDesign(project.id, project.designs[1]!.id);
  assert.equal(new ProjectStore(root).get(project.id).stage, 'ready');
});

test('changed design requires a fresh confirmation even with unchanged requirements', (t) => {
  const { store } = fixture(t);
  let project = store.create({ name: '博客', idea: '记录生活' });
  project = store.saveRequirements(project.id, requirements());
  store.approveRequirements(project.id, project.requirements[0]!.id);
  project = store.saveDesign(project.id, design());
  store.approveDesign(project.id, project.designs[0]!.id);
  project = store.saveDesign(project.id, { ...design(), direction: '深色阅读风格' });
  assert.equal(project.stage, 'design');
  assert.equal(project.designs[1]!.approvedAt, null);
});

test('incomplete requirements can be saved as drafts but cannot be confirmed', (t) => {
  const { root, store } = fixture(t);
  let project = store.create({ name: '博客', idea: '记录生活' });
  for (const field of ['features', 'pages', 'acceptance'] as const) {
    project = store.saveRequirements(project.id, { ...requirements(), [field]: [] });
    const file = join(root, 'projects', project.id, 'project.json');
    const before = readFileSync(file, 'utf8');
    assert.throws(
      () => store.approveRequirements(project.id, project.requirements.at(-1)!.id),
      hasCode('INCOMPLETE_REQUIREMENTS'),
    );
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(new ProjectStore(root).get(project.id).stage, 'requirements');
  }
  project = store.saveRequirements(project.id, requirements());
  const pendingQuestions = [...project.requirements.at(-1)!.content.questions];
  project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
  assert.equal(project.stage, 'design');
  assert.deepEqual(
    project.requirements.at(-1)!.content.questions,
    pendingQuestions,
    'explicit confirmation does not fabricate answers',
  );
  assert.match(project.activity.at(-1)!.message, /保留 1 项待明确问题/u);
});

test('archived projects cannot be changed or approved until they are restored', (t) => {
  const { root, store } = fixture(t);
  let project = store.create({ name: '博客', idea: '记录生活' });
  project = store.saveRequirements(project.id, requirements());
  const requirementId = project.requirements[0]!.id;
  store.approveRequirements(project.id, requirementId);
  project = store.saveDesign(project.id, design());
  const designId = project.designs[0]!.id;
  store.archive(project.id, true);
  const file = join(root, 'projects', project.id, 'project.json');
  const before = readFileSync(file, 'utf8');
  for (const mutate of [
    () => store.rename(project.id, '新名称'),
    () => store.saveRequirements(project.id, requirements('新需求')),
    () => store.approveRequirements(project.id, requirementId),
    () => store.saveDesign(project.id, design()),
    () => store.approveDesign(project.id, designId),
  ]) {
    assert.throws(mutate, hasCode('ARCHIVED'));
    assert.equal(
      readFileSync(file, 'utf8'),
      before,
      'rejected archive edits leave committed history untouched',
    );
  }
  store.archive(project.id, false);
  assert.equal(store.approveDesign(project.id, designId).stage, 'ready');
  assert.equal(store.rename(project.id, '恢复后的博客').name, '恢复后的博客');
});

test('malformed and tampered manifests are reported and never overwritten by mutations', (t) => {
  const { root, store } = fixture(t);
  let project = store.create({ name: '博客', idea: '记录生活' });
  project = store.saveRequirements(project.id, requirements());
  const file = join(root, 'projects', project.id, 'project.json');
  const valid = readFileSync(file, 'utf8');
  for (const invalid of [
    '{"incomplete":',
    JSON.stringify({ ...JSON.parse(valid), id: randomUUID() }),
    JSON.stringify({
      ...JSON.parse(valid),
      requirements: [{ ...project.requirements[0], content: requirements('被篡改内容') }],
    }),
    JSON.stringify({ ...JSON.parse(valid), stage: 'ready' }),
    JSON.stringify({ ...JSON.parse(valid), apiKey: 'unknown-field' }),
  ]) {
    writeFileSync(file, invalid);
    assert.throws(() => store.list(), hasCode('CORRUPT_PROJECT'));
    assert.throws(() => store.rename(project.id, '不能覆盖'), hasCode('CORRUPT_PROJECT'));
    assert.equal(readFileSync(file, 'utf8'), invalid);
  }
});

test('version 1 is explicit and unsupported manifest versions are never migrated or overwritten', (t) => {
  const { root, store } = fixture(t);
  const project = store.create({ name: '博客', idea: '记录生活' });
  const file = join(root, 'projects', project.id, 'project.json');
  assert.equal(project.schemaVersion, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1);
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  for (const schemaVersion of [2, 0, '1', undefined]) {
    const unsupported = JSON.stringify({ ...baseline, schemaVersion });
    writeFileSync(file, unsupported);
    const reopened = new ProjectStore(root);
    assert.throws(() => reopened.get(project.id), hasCode('UNSUPPORTED_SCHEMA'));
    assert.throws(() => reopened.rename(project.id, '不能覆盖'), hasCode('UNSUPPORTED_SCHEMA'));
    assert.equal(readFileSync(file, 'utf8'), unsupported);
  }
});

test('leftover temporary files do not replace a committed manifest', (t) => {
  const { root, store } = fixture(t);
  const project = store.create({ name: '已保存的项目', idea: '记录生活' });
  const directory = join(root, 'projects', project.id);
  const leftover = join(directory, `.project-${randomUUID()}.tmp`);
  writeFileSync(leftover, '{"partial":');
  const reopened = new ProjectStore(root);
  assert.equal(reopened.get(project.id).name, '已保存的项目');
  reopened.rename(project.id, '完整的新名称');
  assert.equal(reopened.get(project.id).name, '完整的新名称');
  assert.equal(readFileSync(leftover, 'utf8'), '{"partial":');
  assert.equal(readdirSync(directory).filter((name) => name.endsWith('.tmp')).length, 1);
});

test('foreign revisions and path traversal cannot cross project boundaries', (t) => {
  const { store } = fixture(t);
  let first = store.create({ name: '项目一', idea: '第一份内容' });
  let second = store.create({ name: '项目二', idea: '第二份内容' });
  first = store.saveRequirements(first.id, requirements());
  second = store.saveRequirements(second.id, requirements('另一份需求'));
  assert.throws(
    () => store.approveRequirements(second.id, first.requirements[0]!.id),
    hasCode('STALE_REVISION'),
  );
  assert.equal(store.get(second.id).requirements[0]!.approvedAt, null);
  for (const unsafe of [
    '../credentials',
    `${first.id}/../../credentials`,
    '/etc/passwd',
    '..\\credentials',
  ]) {
    assert.throws(() => store.get(unsafe), hasCode('INVALID_INPUT'));
    assert.throws(() => store.rename(unsafe, '越界'), hasCode('INVALID_INPUT'));
  }
  assert.throws(() => store.get(randomUUID()), hasCode('PROJECT_NOT_FOUND'));
});

test('symlink storage roots, project directories, manifests and content directories are rejected', (t) => {
  const { root, store } = fixture(t);
  const rootLink = `${root}-link`;
  symlinkSync(root, rootLink, 'dir');
  assert.throws(() => new ProjectStore(rootLink), hasCode('UNSAFE_PATH'));
  const project = store.create({ name: '博客', idea: '记录生活' });
  const directory = join(root, 'projects', project.id);
  const displaced = join(root, `moved-${project.id}`);
  renameSync(directory, displaced);
  symlinkSync(displaced, directory, 'dir');
  assert.throws(() => store.list(), hasCode('UNSAFE_PATH'));
  assert.throws(() => store.get(project.id), hasCode('UNSAFE_PATH'));
  rmSync(directory);
  renameSync(displaced, directory);
  const file = join(directory, 'project.json');
  const backup = join(root, 'manifest-backup.json');
  renameSync(file, backup);
  symlinkSync(backup, file, 'file');
  assert.throws(() => store.rename(project.id, '越界'), hasCode('UNSAFE_PATH'));
  rmSync(file);
  renameSync(backup, file);
  const data = join(directory, 'data');
  rmSync(data, { recursive: true });
  symlinkSync(root, data, 'dir');
  assert.throws(() => store.get(project.id), hasCode('UNSAFE_PATH'));
});

test('hardlinked manifests are refused rather than silently modifying another file', (t) => {
  const { root, store } = fixture(t);
  const project = store.create({ name: '博客', idea: '记录生活' });
  const file = join(root, 'projects', project.id, 'project.json');
  const copy = join(root, 'linked-manifest.json');
  linkSync(file, copy);
  const before = readFileSync(copy, 'utf8');
  assert.throws(() => store.rename(project.id, '拒绝修改'), hasCode('UNSAFE_PATH'));
  assert.equal(readFileSync(copy, 'utf8'), before);
});

test('a partial project folder is not silently treated as an empty project collection', (t) => {
  const { root, store } = fixture(t);
  const id = randomUUID();
  const directory = join(root, 'projects', id);
  mkdirSync(directory);
  for (const child of ['documents', 'source', 'data', 'checkpoints', 'runs'])
    mkdirSync(join(directory, child));
  assert.throws(() => store.list(), hasCode('CORRUPT_PROJECT'));
  assert.equal(existsSync(join(directory, 'project.json')), false);
});
