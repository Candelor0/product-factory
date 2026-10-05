import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSource } from '../src/main/source-compiler';
import { sourceHash } from '../src/main/source-protocol';

type FileRecord = { path: string; bytes: number; sha256: string };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'factory-export-kit-')));
const rootKit = join(scratch, 'kit');
const outerManifest = join(scratch, 'kit.manifest.json');
const projectRoot = resolve('.');
const source =
  "import {appData} from '@factory/data'; import {appAi} from '@factory/ai'; import './style.css'; throw new Error('must never execute during build'); export default function App(){return <button onClick={()=>appData.read().then(()=>appAi.generateText({requestId:crypto.randomUUID(),text:JSON.stringify({title:1})}))}>合成页面</button>}";
let fixed: FileRecord[];
let sequence = 0;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
before(async () => {
  const builder = await import(pathToFileURL(resolve('scripts/build-export-kit.mjs')).href);
  await builder.buildExportKit({ output: rootKit, manifest: outerManifest });
  fixed = JSON.parse(readFileSync(outerManifest, 'utf8')).files;
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function fixture() {
  const root = join(scratch, `中文 空格导出 ${sequence++}`);
  cpSync(rootKit, root, { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.tsx'), source);
  writeFileSync(join(root, 'src/style.css'), 'body { color: #123456; }');
  const records = ['src/app.tsx', 'src/style.css'].map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, bytes: bytes.length, sha256: sha(bytes) };
  });
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { name: 'synthetic' },
      files: [...fixed, ...records],
    }),
  );
  return root;
}
function node(root: string, script: string) {
  return spawnSync(process.execPath, [`scripts/${script}.mjs`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}
function localDependencies(root: string) {
  for (const name of ['esbuild', 'acorn', `@esbuild/${process.platform}-${process.arch}`]) {
    const destination = join(root, 'node_modules', name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(projectRoot, 'node_modules', name), destination, {
      recursive: true,
      dereference: true,
    });
  }
}
function manifest(
  root: string,
  change: (value: { schemaVersion: number; files: FileRecord[] }) => void,
) {
  const file = join(root, 'manifest.json');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  change(value);
  writeFileSync(file, JSON.stringify(value));
}

test('kit is deterministic and preserves real locked compiler metadata and all platform optional packages', async () => {
  const builder = await import(pathToFileURL(resolve('scripts/build-export-kit.mjs')).href);
  const second = await builder.buildExportKit({
    output: join(scratch, 'repeat'),
    manifest: join(scratch, 'repeat.manifest.json'),
  });
  assert.deepEqual(second.files, fixed);
  const packageJson = JSON.parse(readFileSync(join(rootKit, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), ['build', 'verify']);
  assert.equal(existsSync(join(rootKit, 'index.html')), false);
  assert.equal(existsSync(join(rootKit, 'node_modules')), false);
  const original = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const exported = JSON.parse(readFileSync(join(rootKit, 'package-lock.json'), 'utf8'));
  assert.deepEqual(exported.packages[''].devDependencies, packageJson.devDependencies);
  for (const name of Object.keys(original.packages['node_modules/esbuild'].optionalDependencies))
    assert.deepEqual(
      exported.packages[`node_modules/${name}`],
      original.packages[`node_modules/${name}`],
    );
  assert.equal(
    Object.keys(exported.packages).length,
    Object.keys(original.packages['node_modules/esbuild'].optionalDependencies).length + 3,
  );
  assert.deepEqual(
    readFileSync(join(rootKit, 'runtime.js')),
    readFileSync('dist/toolchain/runtime.js'),
  );
  assert.equal(readdirSync(join(rootKit, 'licenses')).length, 5);
});

test('original package verifies using only Node builtins without installed dependencies or source execution', () => {
  const root = fixture();
  const result = node(root, 'verify');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /未执行源码/u);
  assert.equal(existsSync(join(root, 'dist')), false);
});

test('verify rejects edited source, extra source and unlisted payload directories', () => {
  for (const change of [
    (root: string) => writeFileSync(join(root, 'src/app.tsx'), `${source}\n// edited`),
    (root: string) => writeFileSync(join(root, 'src/extra.ts'), 'export const x=1;'),
    (root: string) => mkdirSync(join(root, 'unlisted')),
  ]) {
    const root = fixture();
    change(root);
    assert.equal(node(root, 'verify').status, 1);
  }
});

test('manifest traversal, case aliases, self listing and unsupported schema are rejected', () => {
  for (const change of [
    (value: { schemaVersion: number; files: FileRecord[] }) => {
      value.files[0].path = '../outside';
    },
    (value: { schemaVersion: number; files: FileRecord[] }) => {
      value.files.push({ ...value.files[0], path: value.files[0].path.toLowerCase() });
    },
    (value: { schemaVersion: number; files: FileRecord[] }) => {
      value.files[0].path = 'manifest.json';
    },
    (value: { schemaVersion: number; files: FileRecord[] }) => {
      value.schemaVersion = 2;
    },
  ]) {
    const root = fixture();
    manifest(root, change);
    assert.equal(node(root, 'verify').status, 1);
  }
});

test('verify rejects symbolic links, hard links and source directories linked outside the export', () => {
  for (const hard of [false, true]) {
    const root = fixture();
    const file = join(root, 'src/app.tsx');
    const outside = join(scratch, `outside-${sequence}.tsx`);
    writeFileSync(outside, source);
    rmSync(file);
    if (hard) linkSync(outside, file);
    else symlinkSync(outside, file);
    assert.equal(node(root, 'verify').status, 1);
  }
  const root = fixture();
  rmSync(join(root, 'src'), { recursive: true });
  symlinkSync(scratch, join(root, 'src'));
  assert.equal(node(root, 'verify').status, 1);
});

test('build gives a fixed actionable dependency message rather than resolving packages from ancestor directories', () => {
  const root = fixture();
  const result = node(root, 'build');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm ci --ignore-scripts/u);
  assert.doesNotMatch(result.stderr, /Error:|node:internal|factory-export-kit-/u);
  assert.equal(existsSync(join(root, 'dist')), false);
});

test('copied installed dependencies rebuild exactly the real compiler output offline without executing source', async () => {
  const root = fixture();
  localDependencies(root);
  const result = node(root, 'build');
  assert.equal(result.status, 0, result.stderr);
  const expected = await compileSource({
    revision: 0,
    files: ['src/app.tsx', 'src/style.css'].map((path) => {
      const content = readFileSync(join(root, path), 'utf8');
      return { path, content, sha256: sourceHash(content) };
    }),
  });
  assert.equal(readFileSync(join(root, 'dist/app.js'), 'utf8'), expected.javascript);
  assert.equal(readFileSync(join(root, 'dist/app.css'), 'utf8'), expected.css);
  assert.deepEqual(readdirSync(join(root, 'dist')).sort(), [
    'ai.js',
    'app.css',
    'app.js',
    'data.js',
    'runtime.js',
  ]);
  assert.deepEqual(
    readFileSync(join(root, 'dist/runtime.js')),
    readFileSync(join(root, 'runtime.js')),
  );
  assert.deepEqual(readFileSync(join(root, 'dist/data.js')), readFileSync(join(root, 'data.js')));
  assert.deepEqual(readFileSync(join(root, 'dist/ai.js')), readFileSync(join(root, 'ai.js')));
  assert.equal(
    node(root, 'verify').status,
    1,
    'full verification deliberately rejects generated/install directories',
  );
});

test('build discovers legitimate edited and added source without rewriting original manifest', () => {
  const root = fixture();
  localDependencies(root);
  const before = readFileSync(join(root, 'manifest.json'));
  writeFileSync(
    join(root, 'src/app.tsx'),
    "import {message} from './message'; export default function App(){return <h1>{message}</h1>}",
  );
  writeFileSync(join(root, 'src/message.ts'), "export const message='edited-and-rebuilt';");
  rmSync(join(root, 'src/style.css'));
  const result = node(root, 'build');
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(root, 'dist/app.js'), 'utf8'), /edited-and-rebuilt/u);
  assert.deepEqual(readFileSync(join(root, 'manifest.json')), before);
});

test('syntax failure preserves existing outputs and never executes generated host imports or configuration', () => {
  const root = fixture();
  localDependencies(root);
  assert.equal(node(root, 'build').status, 0);
  const before = readFileSync(join(root, 'dist/app.js'));
  for (const invalid of [
    'export default function App(){return <div>;}',
    "import 'node:fs'; export default function App(){return <div/>}",
  ]) {
    writeFileSync(join(root, 'src/app.tsx'), invalid);
    assert.equal(node(root, 'build').status, 1);
    assert.deepEqual(readFileSync(join(root, 'dist/app.js')), before);
  }
});

test('build rejects source links, generated config, extra top-level code and linked output without overwriting targets', () => {
  const target = join(scratch, 'protected');
  mkdirSync(target);
  writeFileSync(join(target, 'app.js'), 'preserve');
  for (const change of [
    (root: string) => {
      rmSync(join(root, 'src/app.tsx'));
      symlinkSync(join(rootKit, 'runtime.js'), join(root, 'src/app.tsx'));
    },
    (root: string) => writeFileSync(join(root, 'src/package.json'), '{}'),
    (root: string) => writeFileSync(join(root, 'generated.config.js'), 'throw new Error()'),
    (root: string) => symlinkSync(target, join(root, 'dist')),
    (root: string) => writeFileSync(join(root, 'data.js'), 'malicious replacement'),
  ]) {
    const root = fixture();
    localDependencies(root);
    change(root);
    assert.equal(node(root, 'build').status, 1);
    assert.equal(readFileSync(join(target, 'app.js'), 'utf8'), 'preserve');
  }
});

test('real npm ci --offline --ignore-scripts installs the genuine pruned lock and rebuilds using cached package integrity', (t) => {
  const root = fixture();
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const cache = join(scratch, 'offline-npm-cache');
  for (const name of ['esbuild', 'acorn', `@esbuild/${process.platform}-${process.arch}`]) {
    const integrity = lock.packages[`node_modules/${name}`].integrity as string;
    assert.ok(integrity.startsWith('sha512-'));
    const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
    const relative = join(
      '_cacache/content-v2/sha512',
      hex.slice(0, 2),
      hex.slice(2, 4),
      hex.slice(4),
    );
    const cached = join(homedir(), '.npm', relative);
    if (!existsSync(cached)) {
      t.skip(
        'Exact installed-version npm archive is not cached; network installation is intentionally not attempted.',
      );
      return;
    }
    const destination = join(cache, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(cached, destination);
  }
  const beforeLock = readFileSync(join(root, 'package-lock.json'));
  const installed = spawnSync(
    'npm',
    ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: '', npm_config_update_notifier: 'false' },
    },
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(readFileSync(join(root, 'package-lock.json')), beforeLock);
  assert.equal(
    existsSync(join(root, 'node_modules/esbuild/lib/downloaded-@esbuild-darwin-arm64-esbuild')),
    false,
  );
  const rebuilt = node(root, 'build');
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.match(readFileSync(join(root, 'dist/app.js'), 'utf8'), /must never execute during build/u);
});
