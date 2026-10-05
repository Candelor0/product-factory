import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_FILES = 512;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export class KitError extends Error {}
export const fail = (message) => {
  throw new KitError(message);
};
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const required = [
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
];

export function safePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 240 ||
    path.normalize('NFC') !== path ||
    /[\\:\u0000-\u0020\u007f%?#]/u.test(path)
  )
    fail('清单包含不安全的文件路径。');
  const parts = path.split('/');
  if (
    parts.length > 12 ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part),
    )
  )
    fail('清单包含不安全的文件路径。');
  if (['node_modules', 'dist', '.git'].includes(parts[0]) || parts[0].startsWith('.factory-build-'))
    fail('导出清单不得包含依赖目录、构建结果或临时目录。');
  return path;
}

export function rootDirectory(path) {
  const root = resolve(path);
  if (
    !lstatSync(root).isDirectory() ||
    lstatSync(root).isSymbolicLink() ||
    realpathSync(root) !== root
  )
    fail('导出根目录必须是真实目录，不能经过符号链接。');
  return root;
}

export function readRegular(root, relative, maxBytes = MAX_FILE_BYTES) {
  const parts = relative.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = lstatSync(current);
    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1
        ? !info.isDirectory()
        : !info.isFile() || info.nlink !== 1 || info.size > maxBytes)
    )
      fail('文件路径、链接或大小校验失败。');
  }
  const descriptor = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes)
      fail('文件路径、链接或大小校验失败。');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.length > maxBytes ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      fail('读取期间文件发生变化，请停止修改后重试。');
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function manifestFiles(root) {
  let manifest;
  try {
    manifest = JSON.parse(readRegular(root, 'manifest.json', 1024 * 1024).toString('utf8'));
  } catch (error) {
    if (error instanceof KitError) throw error;
    fail('manifest.json 缺失或不是有效清单。');
  }
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > MAX_FILES
  )
    fail('导出清单版本或文件数量无效。');
  const files = new Map();
  const names = new Set();
  let total = 0;
  for (const item of manifest.files) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['path', 'bytes', 'sha256'].includes(key))
    )
      fail('导出文件记录无效。');
    const path = safePath(item.path);
    if (
      path === 'manifest.json' ||
      names.has(path.toLowerCase()) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > MAX_FILE_BYTES ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.sha256)
    )
      fail('导出文件记录无效、重复或超限。');
    names.add(path.toLowerCase());
    files.set(path, item);
    total += item.bytes;
  }
  if (total > MAX_TOTAL_BYTES || required.some((path) => !files.has(path)))
    fail('导出工具不完整或总容量超限。');
  for (const path of files.keys()) {
    let parent = path;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      if (names.has(parent.toLowerCase())) fail('导出清单存在文件与目录冲突。');
    }
  }
  return files;
}

export function inspect(root, files, buildMode = false) {
  const actual = [];
  const names = new Set();
  const directories = new Set();
  for (const path of files.keys()) {
    let parent = path;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      directories.add(parent);
    }
  }
  const visit = (relative = '') => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const info = lstatSync(join(root, path));
      if (info.isSymbolicLink()) fail('导出内容含符号链接，已拒绝。');
      if (buildMode && ['node_modules', 'dist'].includes(path)) {
        if (!info.isDirectory()) fail('依赖或构建目录不是普通目录。');
        continue;
      }
      if (path === 'manifest.json') {
        if (!info.isFile() || info.nlink !== 1) fail('导出清单不是普通文件。');
        continue;
      }
      safePath(path);
      if (names.has(path.toLowerCase())) fail('导出目录含大小写冲突。');
      names.add(path.toLowerCase());
      if (info.isDirectory()) {
        if (!directories.has(path) && !(buildMode && path.startsWith('src/')))
          fail('导出包含清单之外的目录。');
        visit(path);
      } else {
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES)
          fail('导出内容含硬链接、特殊文件或超限文件。');
        if (!files.has(path) && !(buildMode && path.startsWith('src/')))
          fail('导出包含清单之外的文件。');
        actual.push(path);
        if (actual.length > MAX_FILES) fail('导出文件数量超限。');
      }
    }
  };
  visit();
  for (const [path, item] of files) {
    if (buildMode && path.startsWith('src/')) continue;
    if (!actual.includes(path)) fail('清单中的文件缺失。');
    const bytes = readRegular(root, path);
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256)
      fail('导出文件大小或 SHA-256 与原清单不符。');
  }
  return actual;
}
