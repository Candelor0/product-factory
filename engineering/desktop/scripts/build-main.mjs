import { build } from 'esbuild';
import { mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildExportKit } from './build-export-kit.mjs';
const require = createRequire(import.meta.url);
mkdirSync('dist/toolchain', { recursive: true });
await build({
  entryPoints: ['templates/preview/runtime.js'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome144',
  outfile: 'dist/toolchain/runtime.js',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
const toolName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
const packageName = `@esbuild/${process.platform}-${process.arch}`;
const binary = require.resolve(
  `${packageName}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`,
);
copyFileSync(binary, `dist/toolchain/${toolName}`);
chmodSync(`dist/toolchain/${toolName}`, 0o755);
writeFileSync(
  'dist/toolchain/manifest.json',
  JSON.stringify({
    compiler: 'esbuild-0.28.2',
    templateVersion: 'react-preview-v1',
    files: Object.fromEntries(
      [toolName, 'runtime.js'].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(`dist/toolchain/${file}`))
          .digest('hex'),
      ]),
    ),
  }),
);
await buildExportKit();
mkdirSync('dist/blog', { recursive: true });
await build({
  entryPoints: ['templates/blog/main.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  outfile: 'dist/blog/app.js',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
copyFileSync('templates/blog/index.html', 'dist/blog/index.html');
copyFileSync('templates/blog/styles.css', 'dist/blog/styles.css');
await build({
  entryPoints: ['src/main/index.ts', 'src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: 'dist/main',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: false,
});
