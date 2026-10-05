import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KitError,
  fail,
  hash,
  inspect,
  manifestFiles,
  readRegular,
  rootDirectory,
} from './files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let staging;
let backup;
try {
  if (process.argv.length !== 2) fail('构建不接受额外参数；请直接运行 npm run build。');
  rootDirectory(root);
  const files = manifestFiles(root);
  const actual = inspect(root, files, true);
  const metadata = JSON.parse(readRegular(root, 'package.json').toString('utf8'));
  const nativeName = `@esbuild/${process.platform}-${process.arch}`;
  for (const name of ['esbuild', 'acorn', nativeName]) {
    let installed;
    try {
      installed = JSON.parse(
        readRegular(root, `node_modules/${name}/package.json`, 256 * 1024).toString('utf8'),
      );
    } catch {
      fail(
        '构建依赖或当前平台的 esbuild 原生包缺失。请使用 Node 22+ 执行 npm ci --ignore-scripts，并保留 optional 依赖。',
      );
    }
    const expected = metadata.devDependencies[name === nativeName ? 'esbuild' : name];
    if (installed.version !== expected)
      fail('构建依赖版本与导出锁文件不符，请重新执行 npm ci --ignore-scripts。');
  }
  const binaryPath = `node_modules/${nativeName}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`;
  readRegular(root, binaryPath);
  process.env.ESBUILD_BINARY_PATH = join(root, binaryPath);
  let compiler;
  try {
    compiler = await import('./compiler.mjs');
  } catch {
    fail('无法加载固定编译工具。请确认 Node 22+、依赖版本和 npm ci --ignore-scripts 已完成。');
  }
  const { compileSource, SOURCE_LIMITS, parseSourcePath, parseSourceContent, sourceHash } =
    compiler;
  const sourceFiles = [];
  let totalBytes = 0;
  for (const path of actual.filter((path) => path.startsWith('src/')).sort()) {
    parseSourcePath(path);
    const bytes = readRegular(root, path, SOURCE_LIMITS.fileBytes);
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    parseSourceContent(content);
    totalBytes += bytes.length;
    sourceFiles.push({ path, content, sha256: sourceHash(content) });
  }
  if (sourceFiles.length > SOURCE_LIMITS.fileCount || totalBytes > SOURCE_LIMITS.workspaceBytes)
    fail('源码数量或总容量超过当前模板限制。');
  const output = join(root, 'dist');
  const outputNames = ['app.js', 'app.css', 'runtime.js', 'data.js', 'ai.js'];
  if (existsSync(output)) {
    if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink())
      fail('dist 必须是普通目录。');
    for (const name of readdirSync(output)) {
      if (!outputNames.includes(name)) fail('dist 含不属于本构建的文件，已停止覆盖。');
      readRegular(root, `dist/${name}`);
    }
  }
  // compileSource parses and transforms the virtual snapshot. It never imports or evaluates it in Node.
  const compiled = await compileSource({ revision: 0, files: sourceFiles });
  staging = join(root, `.factory-build-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  writeFileSync(join(staging, 'app.js'), compiled.javascript, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(staging, 'app.css'), compiled.css, { flag: 'wx', mode: 0o600 });
  for (const name of ['runtime.js', 'data.js', 'ai.js'])
    copyFileSync(join(root, name), join(staging, name), constants.COPYFILE_EXCL);
  if (existsSync(output)) {
    backup = join(root, `.factory-build-${randomUUID()}`);
    renameSync(output, backup);
  }
  try {
    renameSync(staging, output);
    staging = undefined;
  } catch (error) {
    if (backup) {
      renameSync(backup, output);
      backup = undefined;
    }
    throw error;
  }
  if (backup) {
    rmSync(backup, { recursive: true });
    backup = undefined;
  }
  const inputHash = hash(JSON.stringify(sourceFiles.map(({ path, sha256 }) => ({ path, sha256 }))));
  console.log(`构建完成：${sourceFiles.length} 个源码文件，输入 SHA-256 ${inputHash}。`);
  console.log(
    'dist 仅包含协议宿主使用的受限前端资源；没有启动服务器、执行生成源码或连接业务数据。',
  );
  for (const warning of compiled.warnings)
    console.log(
      `${warning.path ?? '构建'}${warning.line ? `:${warning.line}` : ''}：${warning.message}`,
    );
} catch (error) {
  if (error instanceof KitError) console.error(error.message);
  else if (error?.name === 'CompileFailure' && Array.isArray(error.diagnostics)) {
    console.error('源码构建失败，已有 dist 保持不变。');
    for (const item of error.diagnostics)
      console.error(`${item.path ?? '构建'}${item.line ? `:${item.line}` : ''}：${item.message}`);
  } else
    console.error(
      '构建未完成。请核对 src 路径、源码格式、容量和文件权限；本工具不执行生成配置或脚本。',
    );
  process.exitCode = 1;
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
}
