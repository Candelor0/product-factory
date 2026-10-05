import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, {
  appendFileSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readDataBackupFile } from '../src/main/data-backup-file';
import { AppError } from '../src/main/validation';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'factory-data-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '中文 空格');
  mkdirSync(directory);
  const file = join(directory, '个人 内容.json');
  writeFileSync(file, '{"合成":"业务内容"}\n');
  return { root, directory, file };
}
const rejects = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, expected);
  assert.doesNotMatch(error.message, /factory-data-backup-|个人 内容|ENOENT|EACCES|合成|业务内容/u);
  return true;
};

test('reads exact bounded bytes from a native-selected Chinese path without changing the file', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.file);
  const stat = lstatSync(f.file);
  const bytes = readDataBackupFile(f.file, before.length);
  assert.deepEqual(bytes, before);
  bytes.fill(0);
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(lstatSync(f.file).mtimeMs, stat.mtimeMs);
});

test('file reader preserves empty, BOM and malformed UTF-8 bytes for the strict caller parser', (t) => {
  const f = fixture(t);
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    Buffer.from([0xc3, 0x28]),
  ]) {
    writeFileSync(f.file, bytes);
    assert.deepEqual(readDataBackupFile(f.file, bytes.length), bytes);
  }
});

test('rejects relative, non-normalized and control-character paths before any read', (t) => {
  const f = fixture(t);
  for (const path of [
    '',
    'backup.json',
    '../backup.json',
    `${f.directory}/../中文 空格/个人 内容.json`,
    `${f.file}/`,
    `${f.file}\0`,
    `${f.file}\n`,
    null as never,
  ])
    assert.throws(() => readDataBackupFile(path, 1024), rejects('DATA_BACKUP_UNSAFE_PATH'));
});

test('rejects oversized files and invalid byte limits without modifying source bytes', (t) => {
  const f = fixture(t);
  const original = readFileSync(f.file);
  assert.throws(
    () => readDataBackupFile(f.file, original.length - 1),
    rejects('DATA_BACKUP_LIMIT'),
  );
  for (const maximum of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => readDataBackupFile(f.file, maximum), rejects('DATA_BACKUP_LIMIT'));
  assert.deepEqual(readFileSync(f.file), original);
});

test('missing files return fixed IO errors and directories are rejected', (t) => {
  const f = fixture(t);
  assert.throws(
    () => readDataBackupFile(join(f.directory, 'missing.json'), 1024),
    rejects('DATA_BACKUP_IO'),
  );
  assert.throws(() => readDataBackupFile(f.directory, 1024), rejects('DATA_BACKUP_UNSAFE_PATH'));
});

test('rejects a real final symlink and a symlink in any selected ancestor', (t) => {
  const f = fixture(t);
  const leaf = join(f.root, 'linked.json');
  symlinkSync(f.file, leaf);
  assert.throws(() => readDataBackupFile(leaf, 1024), rejects('DATA_BACKUP_UNSAFE_PATH'));
  const directory = join(f.root, 'linked-directory');
  symlinkSync(f.directory, directory, 'dir');
  assert.throws(
    () => readDataBackupFile(join(directory, '个人 内容.json'), 1024),
    rejects('DATA_BACKUP_UNSAFE_PATH'),
  );
});

test('rejects either name of a real hard-linked backup', (t) => {
  const f = fixture(t);
  const linked = join(f.root, 'hardlink.json');
  linkSync(f.file, linked);
  for (const path of [f.file, linked])
    assert.throws(() => readDataBackupFile(path, 1024), rejects('DATA_BACKUP_UNSAFE_PATH'));
});

test('rejects an actual FIFO before attempting a potentially blocking read', (t) => {
  if (process.platform === 'win32') {
    t.skip('FIFO creation is Unix-specific');
    return;
  }
  const f = fixture(t);
  const fifo = join(f.directory, 'pipe.json');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5000 });
  if ((created.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    t.skip('mkfifo unavailable');
    return;
  }
  assert.equal(created.status, 0);
  assert.throws(() => readDataBackupFile(fifo, 1024), rejects('DATA_BACKUP_UNSAFE_PATH'));
});

/** Change the real selected file after one real read, without adding a production test-hook API. */
function afterRead(path: string, mutate: () => void, operation: () => void) {
  const expected = lstatSync(path);
  const original = fs.readSync;
  let armed = true;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const result = (original as (...values: unknown[]) => number)(...args);
    if (armed) {
      const actual = fstatSync(args[0]);
      if (actual.dev === expected.dev && actual.ino === expected.ino) {
        armed = false;
        mutate();
      }
    }
    return result;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    operation();
    assert.equal(armed, false, 'the real read hook must execute');
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
  }
}

test('rejects real same-size content changes during the read', (t) => {
  const f = fixture(t);
  writeFileSync(f.file, Buffer.alloc(100_000, 'a'));
  afterRead(
    f.file,
    () => writeFileSync(f.file, Buffer.alloc(100_000, 'b')),
    () =>
      assert.throws(() => readDataBackupFile(f.file, 100_000), rejects('DATA_BACKUP_UNSAFE_PATH')),
  );
  assert.deepEqual(readFileSync(f.file), Buffer.alloc(100_000, 'b'));
});

test('streamed growth is bounded even after an initially valid stat', (t) => {
  const f = fixture(t);
  writeFileSync(f.file, Buffer.alloc(100_000, 'a'));
  afterRead(
    f.file,
    () => appendFileSync(f.file, Buffer.alloc(100_000, 'b')),
    () => assert.throws(() => readDataBackupFile(f.file, 100_000), rejects('DATA_BACKUP_LIMIT')),
  );
  assert.equal(lstatSync(f.file).size, 200_000);
});

test('replacement of the selected pathname during reading cannot authorize the old descriptor', (t) => {
  const f = fixture(t);
  const previous = readFileSync(f.file);
  afterRead(
    f.file,
    () => {
      renameSync(f.file, join(f.directory, 'previous.json'));
      writeFileSync(f.file, previous);
    },
    () => assert.throws(() => readDataBackupFile(f.file, 1024), rejects('DATA_BACKUP_UNSAFE_PATH')),
  );
  assert.deepEqual(readFileSync(f.file), previous);
});
