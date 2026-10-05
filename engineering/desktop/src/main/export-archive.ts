import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { AppError } from './validation';

const MAX_ENTRIES = 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const invalid = () => new AppError('EXPORT_INVALID', '导出内容或目标格式无效。');
const limit = () => new AppError('EXPORT_LIMIT', '导出文件超过数量或大小上限。');
const unsafe = () => new AppError('EXPORT_UNSAFE_PATH', '导出路径校验失败，请选择其他位置。');
const exists = () => new AppError('EXPORT_EXISTS', '目标文件已存在，请选择新文件名。');
const uncertain = () =>
  new AppError('EXPORT_COMMIT_UNCERTAIN', '导出可能已完成，请保留目标文件并核对后再操作。');
const io = () => new AppError('EXPORT_IO', '导出未完成，请检查目标位置后重试。');
const fixedErrors: Record<string, () => AppError> = {
  EXPORT_INVALID: invalid,
  EXPORT_LIMIT: limit,
  EXPORT_UNSAFE_PATH: unsafe,
  EXPORT_EXISTS: exists,
  EXPORT_IO: io,
  EXPORT_COMMIT_UNCERTAIN: uncertain,
};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const identity = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function portablePath(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !path ||
    path !== path.normalize('NFC') ||
    Buffer.from(path, 'utf8').toString('utf8') !== path ||
    Buffer.byteLength(path) > 1024 ||
    /[\\<>:"|?*\u0000-\u001f\u007f-\u009f]/u.test(path)
  )
    throw invalid();
  for (const part of path.split('/')) {
    const stem = part.split('.')[0].replace(/[ .]+$/u, '');
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      part !== part.trim() ||
      part.endsWith('.') ||
      Buffer.byteLength(part) > 255 ||
      /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(stem)
    )
      throw invalid();
  }
  return path;
}

/** Deterministic ZIP32 with stored entries; no generated code, compression tools or dependencies. */
export function createExportZip(files: { path: string; content: string | Buffer }[]): Buffer {
  if (!Array.isArray(files)) throw invalid();
  if (files.length > MAX_ENTRIES) throw limit();
  const paths = new Map<string, { path: string; directory: boolean }>();
  let size = 22;
  const entries = Array.from(files, (file) => {
    if (!file || typeof file !== 'object') throw invalid();
    const path = portablePath(file.path);
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1).join('/');
      const key = prefix.toLowerCase();
      const directory = index !== parts.length - 1;
      const previous = paths.get(key);
      if (previous && (previous.path !== prefix || !directory || !previous.directory))
        throw invalid();
      paths.set(key, { path: prefix, directory });
    }
    if (typeof file.content !== 'string' && !Buffer.isBuffer(file.content)) throw invalid();
    const name = Buffer.from(path, 'utf8');
    const length = Buffer.byteLength(file.content);
    size += 30 + 46 + name.length * 2 + length;
    if (size > MAX_BYTES) throw limit();
    const content = Buffer.from(file.content);
    return { name, content, crc: crc32(content) };
  });
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names.
    header.writeUInt16LE(0x0021, 12); // 1980-01-01; deterministic, no source timestamp disclosure.
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.content.length, 18);
    header.writeUInt32LE(entry.content.length, 22);
    header.writeUInt16LE(entry.name.length, 26);
    local.push(header, entry.name, entry.content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4); // Unix creator, ZIP version 2.0.
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(entry.crc, 16);
    directory.writeUInt32LE(entry.content.length, 20);
    directory.writeUInt32LE(entry.content.length, 24);
    directory.writeUInt16LE(entry.name.length, 28);
    directory.writeUInt32LE(0o100644 * 0x10000, 38); // Ordinary file, never a ZIP symlink.
    directory.writeUInt32LE(offset, 42);
    central.push(directory, entry.name);
    offset += header.length + entry.name.length + entry.content.length;
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end], size);
}

export interface ExportArchiveWriteOptions {
  /** Trusted caller selects the fixed extension. Never accept this from renderer payloads. */
  format?: 'zip' | 'data-backup-json';
  /** Trusted test hooks only. Never accept these from renderer payloads. */
  afterPartialWrite?: () => void;
  beforePublish?: () => void;
  afterPublish?: () => void;
}
function ancestorState(parent: string): { path: string; stat: Stats }[] {
  const root = parse(parent).root;
  let path = root;
  const result: { path: string; stat: Stats }[] = [];
  for (const part of ['', ...parent.slice(root.length).split(sep).filter(Boolean)]) {
    if (part) path = join(path, part);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
    result.push({ path, stat });
  }
  return result;
}
function recheckAncestors(expected: ReturnType<typeof ancestorState>): void {
  for (const entry of expected) {
    const stat = lstatSync(entry.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !identity(stat, entry.stat)) throw unsafe();
  }
}
function targetAbsent(destination: string): void {
  try {
    lstatSync(destination);
  } catch (error) {
    if (errno(error, 'ENOENT')) return;
    throw error;
  }
  throw exists();
}
function checkedRead(
  path: string,
  expected: Stats,
  bytes: Buffer,
  hash: string,
  links: number,
): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !identity(stat, expected) || stat.nlink !== links)
    throw unsafe();
  if (stat.size !== bytes.length) throw unsafe();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      !identity(opened, stat) ||
      opened.nlink !== links ||
      opened.size !== bytes.length
    )
      throw unsafe();
    // Bound reads even if an external writer grows the file between stat and read.
    const chunk = Buffer.alloc(Math.min(64 * 1024, bytes.length + 1));
    const actualHash = createHash('sha256');
    let total = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, bytes.length + 1 - total), null);
      if (!count) break;
      total += count;
      if (total > bytes.length) throw unsafe();
      actualHash.update(chunk.subarray(0, count));
    }
    if (total !== bytes.length || actualHash.digest('hex') !== hash) throw unsafe();
    const current = lstatSync(path);
    if (
      !identity(current, opened) ||
      current.isSymbolicLink() ||
      current.nlink !== links ||
      current.size !== bytes.length
    )
      throw unsafe();
  } finally {
    closeSync(fd);
  }
}

/** No-overwrite publication for a trusted save-dialog destination. Not an OS-wide sandbox. */
export function writeExportArchive(
  destination: string,
  input: Buffer,
  options: ExportArchiveWriteOptions = {},
): { sha256: string; bytes: number } {
  const format = options.format ?? 'zip';
  if (
    (format !== 'zip' && format !== 'data-backup-json') ||
    typeof destination !== 'string' ||
    !isAbsolute(destination) ||
    resolve(destination) !== destination ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(destination) ||
    !(format === 'zip' ? /\.zip$/iu : /\.json$/iu).test(basename(destination)) ||
    !Buffer.isBuffer(input) ||
    input.length < 22
  )
    throw invalid();
  if (input.length > (format === 'zip' ? MAX_BYTES : 1024 * 1024 + 128 * 1024)) throw limit();
  const bytes = Buffer.from(input);
  const sha256 = digest(bytes);
  const result = { sha256, bytes: bytes.length };
  const parent = dirname(destination);
  const temporary = join(parent, `.factory-export-${randomUUID()}.tmp`);
  let directoryFd: number | undefined;
  let fileFd: number | undefined;
  let fileIdentity: Stats | undefined;
  let ancestors: ReturnType<typeof ancestorState> | undefined;
  let published = false;
  const cleanup = () => {
    if (!fileIdentity) return;
    try {
      // Do not unlink an externally replaced path, even if it has our temporary name.
      const current = lstatSync(temporary);
      if (current.isFile() && !current.isSymbolicLink() && identity(current, fileIdentity))
        unlinkSync(temporary);
    } catch (error) {
      if (!errno(error, 'ENOENT')) throw error;
    }
  };
  const verifyPublished = () => {
    recheckAncestors(ancestors!);
    checkedRead(destination, fileIdentity!, bytes, sha256, 1);
    recheckAncestors(ancestors!);
  };
  try {
    ancestors = ancestorState(parent);
    targetAbsent(destination);
    directoryFd = openSync(
      parent,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    if (!identity(fstatSync(directoryFd), ancestors.at(-1)!.stat)) throw unsafe();
    fileFd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fileIdentity = fstatSync(fileFd);
    recheckAncestors(ancestors);
    const writeRange = (start: number, end: number) => {
      while (start < end) {
        const count = writeSync(fileFd!, bytes, start, end - start);
        if (!count) throw io();
        start += count;
      }
    };
    const middle = Math.ceil(bytes.length / 2);
    writeRange(0, middle);
    options.afterPartialWrite?.();
    writeRange(middle, bytes.length);
    fsyncSync(fileFd);
    closeSync(fileFd);
    fileFd = undefined;
    options.beforePublish?.();
    recheckAncestors(ancestors);
    targetAbsent(destination);
    checkedRead(temporary, fileIdentity, bytes, sha256, 1);
    linkSync(temporary, destination); // Atomic exclusive publication: EEXIST never overwrites.
    published = true;
    options.afterPublish?.();
    cleanup();
    if (process.platform !== 'win32') fsyncSync(directoryFd);
    verifyPublished();
    return result;
  } catch (error) {
    if (published) {
      try {
        cleanup();
        verifyPublished();
        return result;
      } catch {
        throw uncertain();
      }
    }
    if (error instanceof AppError && Object.hasOwn(fixedErrors, error.code))
      throw fixedErrors[error.code]();
    if (errno(error, 'EEXIST')) throw exists();
    throw io();
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    try {
      cleanup();
    } catch {
      // Retain unremovable temporary files; never remove or replace the user destination.
    }
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}
