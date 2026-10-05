import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildExportKit(options = {}) {
  const output = options.output ?? join(projectRoot, 'dist/export-kit');
  const outerManifest = options.manifest ?? join(projectRoot, 'dist/export-kit.manifest.json');
  const runtime = options.runtime ?? join(projectRoot, 'dist/toolchain/runtime.js');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, 'scripts'), { recursive: true });
  mkdirSync(join(output, 'licenses'), { recursive: true });
  for (const file of [
    'README.md',
    'LICENSES.md',
    'scripts/files.mjs',
    'scripts/verify.mjs',
    'scripts/build.mjs',
  ])
    copyFileSync(join(projectRoot, 'templates/export', file), join(output, file));
  const sourceLock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'));
  const dependencies = Object.fromEntries(
    ['acorn', 'esbuild'].map((name) => [name, sourceLock.packages[`node_modules/${name}`].version]),
  );
  const packageJson = {
    name: 'product-factory-exported-source',
    version: '1.0.0',
    private: true,
    type: 'module',
    description: '产品工厂源码维护与受控前端重建包',
    engines: { node: '>=22' },
    scripts: { verify: 'node scripts/verify.mjs', build: 'node scripts/build.mjs' },
    devDependencies: dependencies,
  };
  const packages = {
    '': {
      name: packageJson.name,
      version: packageJson.version,
      devDependencies: dependencies,
      engines: packageJson.engines,
    },
  };
  const names = [
    'acorn',
    'esbuild',
    ...Object.keys(sourceLock.packages['node_modules/esbuild'].optionalDependencies),
  ];
  for (const name of names.sort()) {
    const path = `node_modules/${name}`;
    const record = sourceLock.packages[path];
    if (
      !record ||
      !record.integrity ||
      !record.resolved ||
      !/^https:\/\/registry\.npmjs\.org\//u.test(record.resolved)
    )
      throw new Error('Export kit dependency lock is incomplete');
    packages[path] = record;
  }
  writeFileSync(join(output, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(
    join(output, 'package-lock.json'),
    `${JSON.stringify({ name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true, packages }, null, 2)}\n`,
  );
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents:
        "export {compileSource} from './src/main/source-compiler.ts'; export {SOURCE_LIMITS,parseSourcePath,parseSourceContent,sourceHash} from './src/main/source-protocol.ts';",
      resolveDir: projectRoot,
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: join(output, 'scripts/compiler.mjs'),
    external: ['esbuild', 'acorn'],
    sourcemap: false,
  });
  const sdk = await build({
    absWorkingDir: projectRoot,
    entryPoints: [join(projectRoot, 'src/main/app-data-sdk.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const { APP_DATA_SDK_SOURCE } = await import(
    `data:text/javascript;base64,${Buffer.from(sdk.outputFiles[0].contents).toString('base64')}`
  );
  writeFileSync(join(output, 'data.js'), APP_DATA_SDK_SOURCE);
  const aiSdk = await build({
    absWorkingDir: projectRoot,
    entryPoints: [join(projectRoot, 'src/main/app-ai-sdk.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const { APP_AI_SDK_SOURCE } = await import(
    `data:text/javascript;base64,${Buffer.from(aiSdk.outputFiles[0].contents).toString('base64')}`
  );
  writeFileSync(join(output, 'ai.js'), APP_AI_SDK_SOURCE);
  copyFileSync(runtime, join(output, 'runtime.js'));
  const versions = [];
  for (const name of ['react', 'react-dom', 'scheduler', 'esbuild', 'acorn']) {
    const metadata = JSON.parse(
      readFileSync(join(projectRoot, 'node_modules', name, 'package.json'), 'utf8'),
    );
    const licenseName = name === 'esbuild' ? 'LICENSE.md' : 'LICENSE';
    copyFileSync(
      join(projectRoot, 'node_modules', name, licenseName),
      join(output, 'licenses', `${name}.txt`),
    );
    versions.push(`| ${name} | ${metadata.version} | MIT |`);
  }
  const notices = readFileSync(join(output, 'LICENSES.md'), 'utf8');
  writeFileSync(
    join(output, 'LICENSES.md'),
    `${notices}\n| 软件 | 版本 | 许可 |\n| --- | --- | --- |\n${versions.join('\n')}\n`,
  );
  const files = [];
  const visit = (relative = '') => {
    for (const entry of readdirSync(join(output, relative), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else {
        const bytes = readFileSync(join(output, path));
        files.push({
          path,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  };
  visit();
  mkdirSync(dirname(outerManifest), { recursive: true });
  writeFileSync(outerManifest, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
  return { output, manifest: outerManifest, files };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildExportKit();
  console.log(`Export kit built: ${result.files.length} fixed files`);
}
