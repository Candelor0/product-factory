import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './validation';

/** Trusted app resource paths only; never take them from IPC or generated content. */
export function loadToolchain(directory: string, binaryDirectory = directory) {
  try {
    const filename = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    if (manifest.compiler !== 'esbuild-0.28.2' || manifest.templateVersion !== 'react-preview-v1')
      throw new Error();
    const files = [
      { name: filename, path: join(binaryDirectory, filename), max: 32 * 1024 * 1024 },
      { name: 'runtime.js', path: join(directory, 'runtime.js'), max: 2 * 1024 * 1024 },
    ];
    for (const file of files) {
      const stat = lstatSync(file.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > file.max) throw new Error();
      const hash = createHash('sha256').update(readFileSync(file.path)).digest('hex');
      if (hash !== manifest.files[file.name]) throw new Error();
    }
    // esbuild is loaded lazily after this trusted path has been set.
    process.env.ESBUILD_BINARY_PATH = join(binaryDirectory, filename);
    return { runtime: readFileSync(join(directory, 'runtime.js'), 'utf8') };
  } catch {
    throw new AppError('TOOLCHAIN_UNAVAILABLE', '随包构建工具缺失或校验失败，请使用完整应用包。');
  }
}
