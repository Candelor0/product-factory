import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { AppError } from './validation';

const unsafe = () =>
  new AppError('DATA_BACKUP_UNSAFE_PATH', '备份文件路径或文件类型不安全，请重新选择普通文件。');
const limit = () => new AppError('DATA_BACKUP_LIMIT', '备份文件超过允许大小，未读取或恢复数据。');
const io = () => new AppError('DATA_BACKUP_IO', '备份文件无法安全读取，请保留原文件并重新选择。');
const identity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) =>
  identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Native chooser path only. Returns bounded bytes; the caller validates UTF-8 and the backup schema. */
export function readDataBackupFile(path: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(path)
    )
      throw unsafe();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes === Number.MAX_SAFE_INTEGER)
      throw limit();
    const parent = dirname(path);
    const root = parse(parent).root;
    let ancestor = root;
    const directories: { path: string; stat: Stats }[] = [];
    for (const part of ['', ...parent.slice(root.length).split(sep).filter(Boolean)]) {
      if (part) ancestor = join(ancestor, part);
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
      directories.push({ path: ancestor, stat });
    }
    const regular = (stat: Stats) => {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) throw limit();
    };
    const before = lstatSync(path);
    regular(before); // Reject pipes/devices before open, which could otherwise block.
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(fd);
    regular(opened);
    if (!unchanged(before, opened)) throw unsafe();
    const read = () => {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const count = readSync(fd!, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), total);
        if (!count) break;
        total += count;
        if (total > maxBytes) throw limit();
        chunks.push(Buffer.from(chunk.subarray(0, count)));
      }
      const current = fstatSync(fd!);
      regular(current);
      if (total !== opened.size || !unchanged(current, opened)) throw unsafe();
      return Buffer.concat(chunks, total);
    };
    const bytes = read();
    // A second bounded pass also catches same-size content changes during the first pass.
    if (!bytes.equals(read())) throw unsafe();
    const final = lstatSync(path);
    regular(final);
    if (!unchanged(final, opened)) throw unsafe();
    for (const directory of directories) {
      const current = lstatSync(directory.path);
      if (!current.isDirectory() || current.isSymbolicLink() || !identity(current, directory.stat))
        throw unsafe();
    }
    return bytes;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw io();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        throw io();
      }
    }
  }
}
