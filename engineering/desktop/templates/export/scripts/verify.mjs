import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KitError, inspect, manifestFiles, rootDirectory } from './files.mjs';

try {
  if (process.argv.length !== 2)
    throw new KitError('校验不接受额外参数；请直接运行 node scripts/verify.mjs。');
  const root = rootDirectory(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const files = manifestFiles(root);
  inspect(root, files);
  console.log(`导出完整性校验通过：${files.size} 个文件；未执行源码。`);
} catch (error) {
  console.error(
    error instanceof KitError ? error.message : '导出校验失败，请检查文件、路径与权限。',
  );
  process.exitCode = 1;
}
