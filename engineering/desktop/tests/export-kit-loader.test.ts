import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadExportKit } from '../src/main/export-kit';
import { AppError } from '../src/main/validation';

const required = [
  'README.md',
  'LICENSES.md',
  'package.json',
  'package-lock.json',
  'runtime.js',
  'data.js',
  'ai.js',
  'scripts/files.mjs',
  'scripts/verify.mjs',
  'scripts/build.mjs',
  'scripts/compiler.mjs',
  'licenses/react.txt',
  'licenses/react-dom.txt',
  'licenses/scheduler.txt',
  'licenses/esbuild.txt',
  'licenses/acorn.txt',
];
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-export-kit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'kit');
  const manifestPath = `${directory}.manifest.json`;
  const files = required.map((path, index) => {
    const content = Buffer.from(`synthetic fixed resource ${index}\n中文说明\n`);
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return {
      path,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  const manifest = { schemaVersion: 1, files };
  const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  saveManifest();
  return { root, directory, manifestPath, manifest, saveManifest };
}
const unavailable = (error: unknown) =>
  error instanceof AppError &&
  error.code === 'EXPORT_KIT_UNAVAILABLE' &&
  !error.message.includes('synthetic') &&
  !error.message.includes('factory-export-kit-');

test('export kit loader returns only a complete hash-verified tree as independent buffers', (t) => {
  const f = fixture(t);
  const result = loadExportKit(f.directory);
  assert.deepEqual(
    result.map((file) => file.path),
    [...required].sort(),
  );
  for (const file of result) {
    assert.ok(Buffer.isBuffer(file.content));
    assert.deepEqual(file.content, readFileSync(join(f.directory, file.path)));
  }
  const first = result[0].content as Buffer;
  first.fill(0);
  assert.notDeepEqual(first, loadExportKit(f.directory)[0].content);
});

test('missing manifest, missing tree and missing listed file fail closed', (t) => {
  for (const scenario of ['manifest', 'tree', 'entry']) {
    const f = fixture(t);
    const target =
      scenario === 'manifest'
        ? f.manifestPath
        : scenario === 'tree'
          ? f.directory
          : join(f.directory, 'data.js');
    rmSync(target, { recursive: true });
    assert.throws(() => loadExportKit(f.directory), unavailable, scenario);
  }
});

test('manifest must be a regular file and kit root must remain a directory', (t) => {
  const manifestDirectory = fixture(t);
  rmSync(manifestDirectory.manifestPath);
  mkdirSync(manifestDirectory.manifestPath);
  assert.throws(() => loadExportKit(manifestDirectory.directory), unavailable);
  const fileRoot = fixture(t);
  rmSync(fileRoot.directory, { recursive: true });
  writeFileSync(fileRoot.directory, 'synthetic root file');
  assert.throws(() => loadExportKit(fileRoot.directory), unavailable);
});

test('oversized manifest is refused before parsing even when its JSON and files are otherwise valid', (t) => {
  const f = fixture(t);
  const valid = JSON.stringify(f.manifest);
  writeFileSync(f.manifestPath, valid.padEnd(256 * 1024 + 1, ' '));
  assert.throws(() => loadExportKit(f.directory), unavailable);
});

test('tampered file content, size or hash is refused without leaking resource contents', (t) => {
  for (const scenario of ['content', 'size', 'hash']) {
    const f = fixture(t);
    if (scenario === 'content')
      writeFileSync(join(f.directory, 'data.js'), 'synthetic tampered SDK');
    if (scenario === 'size') f.manifest.files[0].bytes++;
    if (scenario === 'hash') f.manifest.files[0].sha256 = '0'.repeat(64);
    f.saveManifest();
    assert.throws(() => loadExportKit(f.directory), unavailable, scenario);
  }
});

test('required file omitted from both tree and manifest is still refused', (t) => {
  const f = fixture(t);
  unlinkSync(join(f.directory, 'scripts', 'compiler.mjs'));
  f.manifest.files = f.manifest.files.filter((file) => file.path !== 'scripts/compiler.mjs');
  f.saveManifest();
  assert.throws(() => loadExportKit(f.directory), unavailable);
});

test('fixed AI SDK, shared verification helper and every license remain mandatory when missing from both tree and manifest', (t) => {
  for (const path of [
    'ai.js',
    'scripts/files.mjs',
    'LICENSES.md',
    'licenses/react.txt',
    'licenses/react-dom.txt',
    'licenses/scheduler.txt',
    'licenses/esbuild.txt',
    'licenses/acorn.txt',
  ]) {
    const f = fixture(t);
    unlinkSync(join(f.directory, path));
    f.manifest.files = f.manifest.files.filter((file) => file.path !== path);
    f.saveManifest();
    assert.throws(() => loadExportKit(f.directory), unavailable, path);
  }
});

test('unlisted files, duplicate manifest paths and unknown schema are refused', (t) => {
  for (const scenario of ['extra', 'duplicate', 'schema', 'json']) {
    const f = fixture(t);
    if (scenario === 'extra')
      writeFileSync(join(f.directory, 'unlisted.js'), 'unexpected resource');
    if (scenario === 'duplicate') f.manifest.files[1] = { ...f.manifest.files[0] };
    if (scenario === 'schema') f.manifest.schemaVersion = 2;
    f.saveManifest();
    if (scenario === 'json') writeFileSync(f.manifestPath, '{ synthetic broken JSON');
    assert.throws(() => loadExportKit(f.directory), unavailable, scenario);
  }
});

test('manifest and root directory symlinks are refused even when linked bytes match', (t) => {
  for (const scenario of ['manifest', 'tree']) {
    const f = fixture(t);
    const original = scenario === 'manifest' ? f.manifestPath : f.directory;
    const moved = `${original}.actual`;
    renameSync(original, moved);
    symlinkSync(moved, original, scenario === 'tree' ? 'dir' : 'file');
    assert.throws(() => loadExportKit(f.directory), unavailable, scenario);
  }
});

test('nested directory and file symlinks are refused without traversing outside the kit', (t) => {
  for (const scenario of ['directory', 'file', 'dangling']) {
    const f = fixture(t);
    const original = join(f.directory, scenario === 'directory' ? 'scripts' : 'data.js');
    const moved = join(f.root, 'outside');
    renameSync(original, moved);
    symlinkSync(
      scenario === 'dangling' ? join(f.root, 'missing') : moved,
      original,
      scenario === 'directory' ? 'dir' : 'file',
    );
    assert.throws(() => loadExportKit(f.directory), unavailable, scenario);
    if (scenario !== 'directory')
      assert.match(readFileSync(moved, 'utf8'), /synthetic fixed resource/u);
  }
});

test('hardlinked manifest and resource files are refused while original bytes remain intact', (t) => {
  for (const scenario of ['manifest', 'file']) {
    const f = fixture(t);
    const original = scenario === 'manifest' ? f.manifestPath : join(f.directory, 'runtime.js');
    const before = readFileSync(original);
    const linked = join(f.root, 'hardlink');
    linkSync(original, linked);
    assert.throws(() => loadExportKit(f.directory), unavailable, scenario);
    assert.deepEqual(readFileSync(linked), before);
    assert.deepEqual(readFileSync(original), before);
  }
});

test('per-file size and manifest entry limits reject oversized kits', (t) => {
  const f = fixture(t);
  const content = Buffer.alloc(4 * 1024 * 1024 + 1);
  const entry = f.manifest.files.find((file) => file.path === 'runtime.js')!;
  writeFileSync(join(f.directory, entry.path), content);
  entry.bytes = content.length;
  entry.sha256 = createHash('sha256').update(content).digest('hex');
  f.saveManifest();
  assert.throws(() => loadExportKit(f.directory), unavailable);
  const other = fixture(t);
  other.manifest.files = Array.from({ length: 101 }, () => ({ ...other.manifest.files[0] }));
  other.saveManifest();
  assert.throws(() => loadExportKit(other.directory), unavailable);
});
