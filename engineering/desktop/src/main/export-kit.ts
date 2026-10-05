import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './validation';

export interface ExportFile {
  path: string;
  content: string | Buffer;
}
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
/** These resources belong to the trusted application, never a project or an IPC-supplied directory. */
export function loadExportKit(directory: string): ExportFile[] {
  try {
    const manifestPath = `${directory}.manifest.json`;
    const rootStat = lstatSync(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    const manifestStat = lstatSync(manifestPath);
    const manifestLimit = 256 * 1024;
    if (
      !manifestStat.isFile() ||
      manifestStat.isSymbolicLink() ||
      manifestStat.nlink !== 1 ||
      manifestStat.size > manifestLimit
    )
      throw new Error();
    const manifestBytes = readFileSync(manifestPath);
    if (manifestBytes.byteLength > manifestLimit) throw new Error();
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (
      manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > 100
    )
      throw new Error();
    const found: string[] = [];
    const walk = (prefix: string) => {
      for (const name of readdirSync(join(directory, prefix))) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name)) throw new Error();
        const path = prefix ? `${prefix}/${name}` : name;
        const stat = lstatSync(join(directory, path));
        if (stat.isSymbolicLink()) throw new Error();
        if (stat.isDirectory()) walk(path);
        else if (stat.isFile() && stat.nlink === 1) found.push(path);
        else throw new Error();
      }
    };
    walk('');
    if (
      found.length !== manifest.files.length ||
      new Set(manifest.files.map((f: { path: string }) => f.path)).size !== found.length
    )
      throw new Error();
    let bytes = 0;
    const files = found.sort().map((path) => {
      const entry = manifest.files.find((f: { path: string }) => f.path === path);
      const stat = lstatSync(join(directory, path));
      if (!entry || stat.size > 4 * 1024 * 1024 || (bytes += stat.size) > 16 * 1024 * 1024)
        throw new Error();
      const content = readFileSync(join(directory, path));
      if (entry.bytes !== content.length || entry.sha256 !== hash(content)) throw new Error();
      return { path, content };
    });
    for (const required of [
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
    ])
      if (!found.includes(required)) throw new Error();
    return files;
  } catch {
    throw new AppError('EXPORT_KIT_UNAVAILABLE', '随包导出工具缺失或校验失败，请使用完整应用包。');
  }
}
