import { packager } from '@electron/packager';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
if (process.platform !== 'darwin')
  throw new Error(
    'Run this Mac packaging step on macOS. Windows packaging requires separate validation.',
  );
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const electronZipDir = process.env.PRODUCT_FACTORY_ELECTRON_ZIP_DIR;
if (electronZipDir) {
  const filename = `electron-v44.5.1-darwin-${process.arch}.zip`;
  const checksums = JSON.parse(readFileSync('node_modules/electron/checksums.json', 'utf8'));
  const actual = createHash('sha256')
    .update(readFileSync(join(electronZipDir, filename)))
    .digest('hex');
  if (actual !== checksums[filename]) throw new Error('Cached Electron ZIP checksum mismatch');
}
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const staging = resolve('../../artifacts/package-input', runId);
mkdirSync(staging, { recursive: true });
cpSync('dist/main', join(staging, 'dist/main'), { recursive: true });
cpSync('dist/renderer', join(staging, 'dist/renderer'), { recursive: true });
cpSync('dist/blog', join(staging, 'dist/blog'), { recursive: true });
cpSync('dist/toolchain', join(staging, 'dist/toolchain'), { recursive: true });
cpSync('dist/export-kit', join(staging, 'dist/export-kit'), { recursive: true });
cpSync('dist/export-kit.manifest.json', join(staging, 'dist/export-kit.manifest.json'));
const notices = [
  'Bundled application dependencies. Agent Blueprint deterministic rules and selected knowledge metadata are adapted in TypeScript; its complete analysis pipeline and Python runtime are not bundled. The starter-kit remains a reference and is not bundled.',
  readFileSync('licenses/agent-blueprint.txt', 'utf8'),
];
for (const dependency of ['react', 'react-dom', 'lucide-react', 'esbuild', 'acorn']) {
  const metadata = JSON.parse(readFileSync(`node_modules/${dependency}/package.json`, 'utf8'));
  const license = dependency === 'esbuild' ? 'LICENSE.md' : 'LICENSE';
  notices.push(
    `\n${dependency} ${metadata.version}\n\n${readFileSync(`node_modules/${dependency}/${license}`, 'utf8')}`,
  );
}
writeFileSync(join(staging, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
writeFileSync(
  join(staging, 'package.json'),
  JSON.stringify(
    {
      name: 'product-factory',
      version,
      main: 'dist/main/index.cjs',
      description: '产品工厂',
    },
    null,
    2,
  ),
);
const result = await packager({
  dir: staging,
  name: '产品工厂',
  executableName: 'ProductFactory',
  appBundleId: 'local.productfactory.desktop',
  appVersion: version,
  platform: 'darwin',
  arch: process.arch,
  electronVersion: '44.5.1',
  electronZipDir,
  asar: { unpack: '**/dist/toolchain/esbuild' },
  out: resolve('../../artifacts/desktop', runId),
  overwrite: false,
  prune: false,
  // Staging contains only explicitly copied resources. Default filters drop the export kit's lock.
  ignore: () => false,
  appCategoryType: 'public.app-category.developer-tools',
  extendInfo: {
    NSHumanReadableCopyright: '产品工厂',
    CFBundleDisplayName: '产品工厂',
  },
});
for (const path of result) {
  const archive = join(path, '产品工厂.app/Contents/Resources/app.asar');
  const manifestBytes = readFileSync('dist/export-kit.manifest.json');
  if (!extractFile(archive, 'dist/export-kit.manifest.json').equals(manifestBytes))
    throw new Error('Packaged export kit manifest mismatch');
  for (const entry of JSON.parse(manifestBytes.toString('utf8')).files) {
    const bytes = extractFile(archive, `dist/export-kit/${entry.path}`);
    if (
      bytes.length !== entry.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new Error('Packaged export kit resource mismatch');
  }
  console.log(path);
}
console.log(
  'Package created. Distribution signing/notarization, Windows and clean-OS acceptance remain unverified.',
);
