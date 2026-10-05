import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createExportZip, writeExportArchive } from '../src/main/export-archive';
import { AppError } from '../src/main/validation';

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const zip = () => createExportZip([{ path: 'src/app.tsx', content: 'export default "合成源码";' }]);
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-export-'));
  const directory = join(root, '中文 空格目录');
  mkdirSync(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, destination: join(directory, '项目 源码.zip') };
}
function temporary(directory: string): string {
  const files = readdirSync(directory).filter((name) => name.startsWith('.factory-export-'));
  assert.equal(files.length, 1);
  return join(directory, files[0]);
}

test('ZIP store encodes portable UTF-8 names, binary contents, CRC and matching central entries deterministically', () => {
  const files = [
    { path: '说明 文档.md', content: '说明\n中文内容' },
    { path: 'src/check.txt', content: '123456789' },
    { path: 'assets/binary.bin', content: Buffer.from([0, 255, 10, 128]) },
    { path: 'empty.txt', content: '' },
  ];
  const output = createExportZip(files);
  assert.deepEqual(output, createExportZip(files));
  const end = output.length - 22;
  assert.equal(output.readUInt32LE(end), 0x06054b50);
  assert.equal(output.readUInt16LE(end + 8), files.length);
  assert.equal(output.readUInt16LE(end + 10), files.length);
  let central = output.readUInt32LE(end + 16);
  assert.equal(central + output.readUInt32LE(end + 12), end);
  let local = 0;
  for (const [index, file] of files.entries()) {
    assert.equal(output.readUInt32LE(local), 0x04034b50);
    assert.equal(output.readUInt16LE(local + 6), 0x800);
    assert.equal(output.readUInt16LE(local + 8), 0);
    assert.equal(output.readUInt16LE(local + 12), 0x21);
    const length = output.readUInt32LE(local + 18);
    assert.equal(length, output.readUInt32LE(local + 22));
    const nameLength = output.readUInt16LE(local + 26);
    const name = output.subarray(local + 30, local + 30 + nameLength);
    assert.equal(name.toString('utf8'), file.path);
    assert.deepEqual(
      output.subarray(local + 30 + nameLength, local + 30 + nameLength + length),
      Buffer.from(file.content),
    );
    if (index === 1) assert.equal(output.readUInt32LE(local + 14), 0xcbf43926);
    if (index === 3) assert.equal(output.readUInt32LE(local + 14), 0);
    assert.equal(output.readUInt32LE(central), 0x02014b50);
    assert.equal(output.readUInt16LE(central + 8), 0x800);
    assert.equal(output.readUInt16LE(central + 10), 0);
    assert.equal(output.readUInt32LE(central + 16), output.readUInt32LE(local + 14));
    assert.equal(output.readUInt32LE(central + 20), length);
    assert.equal(output.readUInt32LE(central + 42), local);
    assert.equal(output.readUInt32LE(central + 38) >>> 16, 0o100644);
    assert.deepEqual(output.subarray(central + 46, central + 46 + nameLength), name);
    central += 46 + nameLength;
    local += 30 + nameLength + length;
  }
  assert.equal(central, end);
  assert.equal(createExportZip([]).length, 22);
});

test('system unzip verifies all CRCs and extracts exact UTF-8 and binary content', (t) => {
  const f = fixture(t);
  const binary = Buffer.from([1, 0, 255, 128]);
  const bytes = createExportZip([
    { path: '中文 空格/说明.md', content: '原始中文内容\n' },
    { path: 'src/data.bin', content: binary },
  ]);
  writeExportArchive(f.destination, bytes);
  const check = spawnSync('unzip', ['-t', f.destination], { encoding: 'utf8' });
  if ((check.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    t.skip('System unzip is unavailable; ZIP headers and contents are checked by the parser test.');
    return;
  }
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const destination = join(f.root, '解压');
  const extract = spawnSync('unzip', ['-q', f.destination, '-d', destination], {
    encoding: 'utf8',
  });
  assert.equal(extract.status, 0, extract.stdout + extract.stderr);
  assert.equal(readFileSync(join(destination, '中文 空格', '说明.md'), 'utf8'), '原始中文内容\n');
  assert.deepEqual(readFileSync(join(destination, 'src', 'data.bin')), binary);
});

test('ZIP rejects traversal, platform aliases, reserved names and file/directory collisions', () => {
  const invalidPaths = [
    '',
    '/absolute',
    '../parent',
    './relative',
    'a/../b',
    'a//b',
    'a/',
    'C:/host',
    'C:host',
    '\\server\\share',
    'a\\b',
    'a\0b',
    'a\nb',
    'a\tb',
    'a\u007fb',
    'a\u0085b',
    'a?b',
    'a*b',
    'a:b',
    'a<b',
    'a>b',
    'a|b',
    'a"b',
    'a.',
    'a ',
    ' a',
    'CON',
    'con.txt',
    'aux/file',
    'COM1.md',
    'lpt9',
    'COM¹.txt',
    'CONIN$.txt',
    'nul .json',
    'e\u0301.txt',
    '\ud800.txt',
    `${'中'.repeat(86)}.txt`,
  ];
  for (const path of invalidPaths)
    assert.throws(() => createExportZip([{ path, content: '' }]), code('EXPORT_INVALID'), path);
  for (const paths of [
    ['a', 'a'],
    ['src/App.tsx', 'src/app.tsx'],
    ['src/a', 'SRC/b'],
    ['a', 'a/b'],
    ['a/b', 'a'],
  ])
    assert.throws(
      () => createExportZip(paths.map((path) => ({ path, content: '' }))),
      code('EXPORT_INVALID'),
    );
  assert.throws(() => createExportZip(new Array(1)), code('EXPORT_INVALID'));
  assert.throws(
    () => createExportZip([{ path: 'ok', content: 123 as unknown as string }]),
    code('EXPORT_INVALID'),
  );
});

test('ZIP enforces entry and final archive byte limits including headers', () => {
  const thousand = Array.from({ length: 1000 }, (_, index) => ({
    path: `file${index}`,
    content: '',
  }));
  assert.ok(createExportZip(thousand).length > 0);
  assert.throws(
    () => createExportZip([...thousand, { path: 'extra', content: '' }]),
    code('EXPORT_LIMIT'),
  );
  const maximum = 32 * 1024 * 1024;
  const overhead = 22 + 30 + 46 + 2; // One byte path repeated in local and central headers.
  const exact = createExportZip([{ path: 'a', content: Buffer.alloc(maximum - overhead) }]);
  assert.equal(exact.length, maximum);
  assert.throws(
    () => createExportZip([{ path: 'a', content: Buffer.alloc(maximum - overhead + 1) }]),
    code('EXPORT_LIMIT'),
  );
});

test('archive publication preserves exact bytes, returns SHA-256 and leaves only the user target', (t) => {
  const f = fixture(t);
  const bytes = zip();
  const before = Buffer.from(bytes);
  const result = writeExportArchive(f.destination, bytes);
  assert.deepEqual(result, {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
  assert.deepEqual(readFileSync(f.destination), before);
  assert.deepEqual(bytes, before);
  assert.deepEqual(readdirSync(f.directory), ['项目 源码.zip']);
  assert.equal(lstatSync(f.destination).nlink, 1);
  if (process.platform !== 'win32') assert.equal(lstatSync(f.destination).mode & 0o777, 0o600);
});

test('existing files, directories, symlinks and hardlinks are never overwritten or followed', (t) => {
  const f = fixture(t);
  const original = join(f.root, 'original');
  writeFileSync(original, 'must remain');
  for (const kind of ['file', 'directory', 'symlink', 'dangling', 'hardlink']) {
    if (kind === 'file') writeFileSync(f.destination, 'existing');
    if (kind === 'directory') mkdirSync(f.destination);
    if (kind === 'symlink') symlinkSync(original, f.destination);
    if (kind === 'dangling') symlinkSync(join(f.root, 'absent'), f.destination);
    if (kind === 'hardlink') linkSync(original, f.destination);
    const identity = lstatSync(f.destination);
    assert.throws(() => writeExportArchive(f.destination, zip()), code('EXPORT_EXISTS'));
    assert.equal(lstatSync(f.destination).ino, identity.ino);
    assert.equal(readFileSync(original, 'utf8'), 'must remain');
    if (kind === 'file') assert.equal(readFileSync(f.destination, 'utf8'), 'existing');
    assert.deepEqual(readdirSync(f.directory), ['项目 源码.zip']);
    rmSync(f.destination, { recursive: true });
  }
});

test('destination must be a canonical absolute ZIP path with no symlink ancestors', (t) => {
  const f = fixture(t);
  for (const destination of [
    'relative.zip',
    join(f.directory, 'file.txt'),
    `${f.directory}/../file.zip`,
    `${f.directory}/bad\n.zip`,
  ])
    assert.throws(() => writeExportArchive(destination, zip()), code('EXPORT_INVALID'));
  const alias = join(f.root, 'alias');
  symlinkSync(f.directory, alias, 'dir');
  assert.throws(
    () => writeExportArchive(join(alias, 'new.zip'), zip()),
    code('EXPORT_UNSAFE_PATH'),
  );
  assert.deepEqual(readdirSync(f.directory), []);
  assert.throws(
    () => writeExportArchive(f.destination, Buffer.alloc(32 * 1024 * 1024 + 1)),
    code('EXPORT_LIMIT'),
  );
});

test('partial write failure cleans only its temporary file and returns a fixed error', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      writeExportArchive(f.destination, zip(), {
        afterPartialWrite: () => {
          assert.ok(readFileSync(temporary(f.directory)).length > 0);
          assert.ok(readFileSync(temporary(f.directory)).length < zip().length);
          throw new Error('synthetic private failure text');
        },
      }),
    (error: unknown) => code('EXPORT_IO')(error) && !(error as Error).message.includes('private'),
  );
  assert.equal(existsSync(f.destination), false);
  assert.deepEqual(readdirSync(f.directory), []);
  assert.throws(
    () =>
      writeExportArchive(f.destination, zip(), {
        afterPartialWrite: () => {
          throw new AppError('EXPORT_LIMIT', 'synthetic private AppError text');
        },
      }),
    (error: unknown) =>
      code('EXPORT_LIMIT')(error) && !(error as Error).message.includes('private'),
  );
  assert.deepEqual(readdirSync(f.directory), []);
});

test('pre-publication rechecks prevent changed bytes, added hardlinks and newly existing targets', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      writeExportArchive(f.destination, zip(), {
        beforePublish: () => writeFileSync(temporary(f.directory), 'tampered bytes'),
      }),
    code('EXPORT_UNSAFE_PATH'),
  );
  assert.deepEqual(readdirSync(f.directory), []);
  const linked = join(f.root, 'linked');
  assert.throws(
    () =>
      writeExportArchive(f.destination, zip(), {
        beforePublish: () => linkSync(temporary(f.directory), linked),
      }),
    code('EXPORT_UNSAFE_PATH'),
  );
  assert.deepEqual(readFileSync(linked), zip());
  assert.deepEqual(readdirSync(f.directory), []);
  assert.throws(
    () =>
      writeExportArchive(f.destination, zip(), {
        beforePublish: () => writeFileSync(f.destination, 'other writer won'),
      }),
    code('EXPORT_EXISTS'),
  );
  assert.equal(readFileSync(f.destination, 'utf8'), 'other writer won');
  assert.deepEqual(readdirSync(f.directory), ['项目 源码.zip']);
});

test('changed parent inode is refused and cleanup does not remove a replacement file', (t) => {
  const f = fixture(t);
  const retired = join(f.root, 'retired');
  let replacement = '';
  assert.throws(
    () =>
      writeExportArchive(f.destination, zip(), {
        beforePublish: () => {
          replacement = temporary(f.directory);
          renameSync(f.directory, retired);
          mkdirSync(f.directory);
          writeFileSync(replacement, 'external replacement');
        },
      }),
    code('EXPORT_UNSAFE_PATH'),
  );
  assert.equal(existsSync(f.destination), false);
  assert.equal(readFileSync(replacement, 'utf8'), 'external replacement');
  assert.deepEqual(readFileSync(temporary(retired)), zip());
});

test('lost acknowledgement after publication is confirmed only by exact identity and hash readback', (t) => {
  const f = fixture(t);
  const result = writeExportArchive(f.destination, zip(), {
    afterPublish: () => {
      throw new Error('lost receipt');
    },
  });
  assert.equal(result.sha256, createHash('sha256').update(zip()).digest('hex'));
  assert.deepEqual(readFileSync(f.destination), zip());
  assert.equal(lstatSync(f.destination).nlink, 1);
  assert.deepEqual(readdirSync(f.directory), ['项目 源码.zip']);
});

test('corruption after publication returns uncertain and preserves the target for review', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      writeExportArchive(f.destination, zip(), {
        afterPublish: () => {
          writeFileSync(f.destination, 'changed after publication');
          throw new Error('lost receipt');
        },
      }),
    code('EXPORT_COMMIT_UNCERTAIN'),
  );
  assert.equal(readFileSync(f.destination, 'utf8'), 'changed after publication');
  assert.deepEqual(readdirSync(f.directory), ['项目 源码.zip']);
});

test('a replaced published target with even identical contents is uncertain and never deleted', (t) => {
  const f = fixture(t);
  let replacementInode = 0;
  assert.throws(
    () =>
      writeExportArchive(f.destination, zip(), {
        afterPublish: () => {
          unlinkSync(f.destination);
          writeFileSync(f.destination, zip());
          replacementInode = lstatSync(f.destination).ino;
        },
      }),
    code('EXPORT_COMMIT_UNCERTAIN'),
  );
  assert.equal(lstatSync(f.destination).ino, replacementInode);
  assert.deepEqual(readFileSync(f.destination), zip());
  assert.deepEqual(readdirSync(f.directory), ['项目 源码.zip']);
});
