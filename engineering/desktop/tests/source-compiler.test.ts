import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'acorn';
import { compileSource, CompileFailure } from '../src/main/source-compiler';
import { sourceHash } from '../src/main/source-protocol';
import type { SourceSnapshot } from '../src/shared/source-contracts';

const snapshot = (files: Record<string, string>, revision = 1): SourceSnapshot => ({
  revision,
  files: Object.entries(files).map(([path, content]) => ({
    path,
    content,
    sha256: sourceHash(content),
  })),
});
const app = (extra = '') =>
  `export default function App() { return <main>合成页面</main>; }\n${extra}`;
const fails = (error: unknown) =>
  error instanceof CompileFailure && error.code === 'BUILD_FAILED' && error.diagnostics.length > 0;
const cancelled = (error: unknown) =>
  error instanceof CompileFailure && error.code === 'BUILD_CANCELLED';

test('valid optional data schema compiles while invalid unreferenced declarations block with fixed diagnostics', async () => {
  const valid = {
    schemaVersion: 1,
    version: 1,
    keys: { posts: { type: 'array', items: { type: 'string' } } },
  };
  await compileSource(
    snapshot({ 'src/app.tsx': app(), 'src/data-schema.json': JSON.stringify(valid) }),
  );
  for (const content of [
    '{private source sentinel',
    JSON.stringify({ ...valid, execute: 'private source sentinel' }),
    JSON.stringify({ ...valid, migration: { fromVersion: 1, steps: [] } }),
    ' '.repeat(64 * 1024 + 1),
  ])
    await assert.rejects(
      compileSource(snapshot({ 'src/app.tsx': app(), 'src/data-schema.json': content })),
      (error) =>
        error instanceof CompileFailure &&
        error.code === 'BUILD_FAILED' &&
        error.diagnostics[0]?.path === 'src/data-schema.json' &&
        error.diagnostics[0]?.message.includes('数据结构声明') &&
        !JSON.stringify(error.diagnostics).includes('private source sentinel'),
    );
});

test('a real React TypeScript app compiles in memory with the fixed runtime and CSS bundle', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx': `import React, {useState} from 'react'; import './style.css'; import {Button} from './components/button'; export default function App() { const [count, setCount] = useState<number>(0); return <main><h1>{count}</h1><Button onClick={() => setCount(count + 1)}/></main>; }`,
      'src/components/button.tsx':
        'export function Button({onClick}:{onClick:()=>void}) { return <button onClick={onClick}>增加</button>; }',
      'src/style.css': 'body { background: white; color: #24272b; }',
    }),
  );
  assert.match(result.javascript, /\.\/runtime\.js/u);
  assert.match(result.javascript, /createRoot/u);
  assert.match(result.javascript, /useState/u);
  assert.match(result.css, /#24272b/u);
  assert.equal(result.javascript.includes('sourceMappingURL'), false);
  assert.equal(result.css.includes('sourceMappingURL'), false);
  assert.deepEqual(result.warnings, []);
  assert.doesNotThrow(() =>
    parse(result.javascript, { ecmaVersion: 'latest', sourceType: 'module' }),
  );
});

test('all supported runtime module specifiers map to the single trusted runtime', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx': `import React, {useState} from 'react'; import {jsx} from 'react/jsx-runtime'; import {jsxDEV} from 'react/jsx-dev-runtime'; import {createRoot} from 'react-dom/client'; export default function App(){ return jsx('main', {children: String(!!React && !!useState && !!jsxDEV && !!createRoot)}) }`,
    }),
  );
  assert.equal(/from ["']react/u.test(result.javascript), false);
  assert.match(result.javascript, /from "\.\/runtime\.js"/u);
});

test('the exact app-data SDK import compiles to the trusted external module', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx':
        "import {appData} from '@factory/data'; export default function App(){return <button onClick={() => appData.read()}>读取内容</button>}",
    }),
  );
  assert.match(result.javascript, /from "\.\/data\.js"/u);
  assert.equal(result.javascript.includes('@factory/data'), false);
  assert.match(result.javascript, /appData\.read\(\)/u);
});

test('the exact app-ai SDK and named text API compile to the fixed external module', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx':
        "import {appAi,generateText} from '@factory/ai'; import {caption} from './ai'; export default function App(){return <button onClick={()=>appAi.generateText({requestId:crypto.randomUUID(),text:caption}).then(()=>generateText({requestId:crypto.randomUUID(),text:caption}))}>{caption}</button>}",
      'src/ai.ts': "export const caption='文本输入';",
    }),
  );
  assert.match(result.javascript, /from "\.\/ai\.js"/u);
  assert.equal(result.javascript.includes('@factory/ai'), false);
  assert.match(result.javascript, /文本输入/u);
});

test('SDK subpaths, similar packages, URL aliases and CSS imports cannot expand the allowlist', async () => {
  for (const specifier of [
    '@factory/data/private',
    '@factory/ai/private',
    '@factory/ai.js',
    '@factory/ai?raw',
    '@factory/ai#fragment',
    './ai.js',
    '@factory/data.js',
    '@factory/data?raw',
    '@factory/data#fragment',
    '@factory/credentials',
    './data.js',
  ]) {
    await assert.rejects(
      compileSource(snapshot({ 'src/app.tsx': app(`import ${JSON.stringify(specifier)};`) })),
      fails,
    );
  }
  for (const sdk of ['@factory/data', '@factory/ai'])
    await assert.rejects(
      compileSource(
        snapshot({
          'src/app.tsx': app("import './style.css';"),
          'src/style.css': `@import "${sdk}";`,
        }),
      ),
      fails,
    );
});

test('local data filenames remain snapshot modules and cannot shadow the trusted SDK', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx':
        "import {appData} from '@factory/data'; import {caption} from './data'; export default function App(){return <button onClick={() => appData.read()}>{caption}</button>}",
      'src/data.ts': "export const caption = '本地文件';",
    }),
  );
  assert.match(result.javascript, /from "\.\/data\.js"/u);
  assert.match(result.javascript, /本地文件/u);
});

test('relative extensionless, index and TypeScript JS-extension aliases resolve only inside the snapshot', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx': `import {caption} from './content'; import {value} from './value.js'; import data from './data.json'; export default function App(){return <div>{caption}{value}{data.title}</div>}`,
      'src/content/index.ts': `export {caption} from '../title';`,
      'src/title.ts': `export const caption = '只读快照';`,
      'src/value.ts': 'export const value:number = 7;',
      'src/data.json': '{"title":"JSON标题"}',
    }),
  );
  assert.match(result.javascript, /只读快照/u);
  assert.match(result.javascript, /JSON标题/u);
  assert.equal(result.css, '');
});

test('a literal local dynamic import is bundled without a dynamic filesystem glob', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx': app("void import('./lazy').then(module => console.log(module.caption));"),
      'src/lazy.ts': "export const caption = '本地懒加载';",
    }),
  );
  assert.match(result.javascript, /本地懒加载/u);
  assert.equal(/import\(["']\.\/lazy/u.test(result.javascript), false);
});

test('syntax diagnostics retain only a virtual path, original line, and fixed safe message', async () => {
  const privateText = 'private-source-token-do-not-echo';
  const value = snapshot({
    'src/app.tsx': `// ${privateText}\nexport default function App() {\n return <div>;\n}`,
  });
  await assert.rejects(compileSource(value), (error) => {
    assert.ok(fails(error));
    const diagnostics = (error as CompileFailure).diagnostics;
    assert.ok(
      diagnostics.some((item) => item.path === 'src/app.tsx' && Number.isInteger(item.line)),
    );
    assert.equal(JSON.stringify(error).includes(privateText), false);
    assert.equal(String(error).includes(process.cwd()), false);
    assert.ok(diagnostics.every((item) => item.message.length <= 120));
    return true;
  });
});

test('missing entry, missing default export and missing relative module fail without an artifact', async () => {
  for (const files of [
    { 'src/other.tsx': app() },
    { 'src/app.tsx': 'export function App() { return <div/>; }' },
    { 'src/app.tsx': app("import './absent';") },
  ] as Record<string, string>[])
    await assert.rejects(compileSource(snapshot(files)), fails);
});

test('bare packages, host paths, external schemes and relative escapes are denied', async () => {
  for (const imported of [
    'node:fs',
    'fs',
    'lodash',
    'react-dom',
    'react/server',
    'https://example.invalid/x.js',
    'http://example.invalid/x.js',
    'data:text/javascript,export default 1',
    'file:///private/source.ts',
    '/private/source.ts',
    'C:\\private\\source.ts',
    '../../outside.ts',
    '../credentials/provider.json',
    './%2e%2e/private.ts',
    './style.css?url',
    './style.css#fragment',
  ]) {
    await assert.rejects(
      compileSource(
        snapshot({
          'src/app.tsx': `import value from ${JSON.stringify(imported)}; export default function App(){return <div>{String(value)}</div>}`,
        }),
      ),
      (error) => {
        assert.ok(fails(error));
        assert.equal(
          JSON.stringify((error as CompileFailure).diagnostics).includes(imported),
          false,
        );
        return true;
      },
    );
  }
});

test('reexports and literal external dynamic imports use the same dependency gate', async () => {
  for (const source of [
    app("export * from 'node:fs';"),
    app("void import('https://example.invalid/module.js');"),
    app("export {default as hidden} from '../../outside.ts';"),
  ])
    await assert.rejects(compileSource(snapshot({ 'src/app.tsx': source })), fails);
});

test('nonliteral import expressions, glob templates and concatenated module paths fail before bundling', async () => {
  for (const source of [
    'void import(prompt());',
    'const name=prompt(); void import(`./${name}.ts`);',
    "const name=prompt(); void import('./' + name + '.ts');",
    "const name='./other'; void import(name);",
    'const name=prompt(); void import(`${name}`);',
  ])
    await assert.rejects(compileSource(snapshot({ 'src/app.tsx': app(source) })), (error) => {
      assert.ok(fails(error));
      assert.ok(
        (error as CompileFailure).diagnostics.some((item) => item.message.includes('动态模块路径')),
      );
      return true;
    });
});

test('CommonJS require calls, aliases, optional calls and resolve are rejected', async () => {
  for (const source of [
    "require('react');",
    'require(prompt());',
    'const r=require; r(prompt());',
    "require.resolve('./value');",
    "require?.('./value');",
    'const {resolve}=require; resolve(prompt());',
  ])
    await assert.rejects(compileSource(snapshot({ 'src/app.tsx': app(source) })), fails);
});

test('string literals, comments, regexes and ordinary object properties are not mistaken for module loading', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx': app(`// import(variable); require(variable);
const example = 'import(variable) require(variable)';
const pattern = /require\\(.*\\)/;
const object = {require: '标签', import: '标签'};
console.log(example, pattern, object.require);`),
    }),
  );
  assert.match(result.javascript, /import\(variable\)/u);
  assert.match(result.javascript, /object\.require/u);
});

test('local CSS imports are compiled from memory', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx': app("import './style.css';"),
      'src/style.css': '@import "./components/base.css"; main { color: #223344; }',
      'src/components/base.css': ':root { --spacing: 12px; }',
    }),
  );
  assert.match(result.css, /--spacing: 12px/u);
  assert.match(result.css, /#234|#223344/u);
  assert.equal(result.css.includes('@import'), false);
});

test('CSS network imports, local and remote resource URLs, data and fragment assets are rejected', async () => {
  for (const css of [
    '@import "https://example.invalid/style.css";',
    '@import url("//example.invalid/style.css");',
    '@import "../../../outside.css";',
    'body { background: url("https://example.invalid/a.png"); }',
    'body { background: url("./image.png"); }',
    'body { background: url("data:image/svg+xml,test"); }',
    'body { filter: url(#filter); }',
    'body { src: url("file:///private/secret"); }',
  ])
    await assert.rejects(
      compileSource(
        snapshot({ 'src/app.tsx': app("import './style.css';"), 'src/style.css': css }),
      ),
      fails,
    );
});

test('CSS asset-looking strings and comments do not cause false positives', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx': app("import './style.css';"),
      'src/style.css':
        '/* url(https://example.invalid/image) */ main::after { content: "url(example)"; }',
    }),
  );
  assert.match(result.css, /url\(example\)/u);
});

test('snapshot paths, hashes, capacity and duplicate files are validated independently', async () => {
  const valid = snapshot({ 'src/app.tsx': app() });
  for (const value of [
    null,
    { ...valid, revision: -1 },
    { ...valid, extra: 'unsupported' },
    { ...valid, files: [...valid.files, valid.files[0]] },
    { ...valid, files: [{ ...valid.files[0], sha256: '0'.repeat(64) }] },
    snapshot({ '../escape.tsx': app() }),
    snapshot({ 'src/app.tsx': app(), 'src/vite.config.ts': 'throw new Error("must not run");' }),
    snapshot({ 'src/app.tsx': 'a'.repeat(128 * 1024 + 1) }),
  ])
    await assert.rejects(compileSource(value as SourceSnapshot), fails);
});

test('generated top-level code is compiled but never evaluated by the trusted process', async () => {
  const globals = globalThis as typeof globalThis & { factoryCompilerExecuted?: boolean };
  delete globals.factoryCompilerExecuted;
  const result = await compileSource(
    snapshot({
      'src/app.tsx': app(
        '(globalThis as any).factoryCompilerExecuted = true; throw new Error("must not execute");',
      ),
    }),
  );
  assert.match(result.javascript, /factoryCompilerExecuted/u);
  assert.equal(globals.factoryCompilerExecuted, undefined);
});

test('host tsconfig, package scripts, plugins and matching host modules cannot influence the build', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-compiler-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  const marker = join(root, 'must-not-exist');
  writeFileSync(join(root, 'tsconfig.json'), '{ malformed and must be ignored');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { postinstall: 'must-not-run', build: 'must-not-run' } }),
  );
  writeFileSync(
    join(root, 'plugin.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
  );
  writeFileSync(join(root, 'src', 'host.ts'), 'export const marker = "host-only-source";');
  const original = process.cwd();
  process.chdir(root);
  try {
    const result = await compileSource(snapshot({ 'src/app.tsx': app() }));
    assert.match(result.javascript, /合成页面/u);
    await assert.rejects(
      compileSource(snapshot({ 'src/app.tsx': app("import './host';") })),
      fails,
    );
    assert.equal(
      readFileSync(join(root, 'tsconfig.json'), 'utf8'),
      '{ malformed and must be ignored',
    );
    assert.throws(() => readFileSync(marker));
  } finally {
    process.chdir(original);
  }
});

test('long hostile imports and source paths cannot be reflected into compiler diagnostics', async () => {
  const hostile = `/private/credentials/${'private-key-fragment-'.repeat(2000)}`;
  await assert.rejects(
    compileSource(snapshot({ 'src/app.tsx': `import ${JSON.stringify(hostile)}; ${app()}` })),
    (error) => {
      assert.ok(fails(error));
      const serialized = JSON.stringify((error as CompileFailure).diagnostics);
      assert.equal(serialized.includes('/private'), false);
      assert.equal(serialized.includes('private-key-fragment'), false);
      assert.ok(serialized.length < 5000);
      return true;
    },
  );
});

test('pre-cancelled compilation never returns an artifact', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    compileSource(snapshot({ 'src/app.tsx': app() }), { signal: controller.signal }),
    cancelled,
  );
});

test('cancellation during real compiler work discards output and allows a subsequent build', async () => {
  const files: Record<string, string> = { 'src/app.tsx': app() };
  for (let index = 0; index < 40; index++)
    files[`src/module${index}.ts`] = Array.from(
      { length: 600 },
      (_, i) => `export const v${i} = ${i};`,
    ).join('\n');
  const controller = new AbortController();
  const pending = compileSource(snapshot(files), { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, cancelled);
  const next = await compileSource(snapshot({ 'src/app.tsx': app() }));
  assert.match(next.javascript, /合成页面/u);
});

test('deterministic snapshots produce the same JavaScript and CSS without mutating source', async () => {
  const value = snapshot({
    'src/app.tsx': app("import './style.css';"),
    'src/style.css': 'body { margin: 0; }',
  });
  const before = structuredClone(value);
  const first = await compileSource(value);
  const second = await compileSource(value);
  assert.deepEqual(first, second);
  assert.deepEqual(value, before);
});

test('the actual 8 MiB output limit rejects expanded compiled code while retaining its source', async () => {
  const files: Record<string, string> = {};
  let entry = '';
  for (let module = 0; module < 15; module++) {
    files[`src/large${module}.ts`] = Array.from(
      { length: 3000 },
      (_, index) => `export enum Item${index}{a,b,c,d,e}`,
    ).join('\n');
    entry += `import './large${module}';\n`;
  }
  files['src/app.tsx'] = entry + app();
  const value = snapshot(files);
  const before = JSON.stringify(value);
  await assert.rejects(compileSource(value), (error) => {
    assert.ok(fails(error));
    assert.ok(
      (error as CompileFailure).diagnostics.some((item) =>
        item.message.includes('产物超过大小限制'),
      ),
    );
    return true;
  });
  assert.equal(JSON.stringify(value), before);
});

test('source-map comments cannot add a host source map or leak host paths into the artifact', async () => {
  const result = await compileSource(
    snapshot({
      'src/app.tsx': app() + '\n//# sourceMappingURL=file:///private/credentials/map.json',
    }),
  );
  assert.equal(result.javascript.includes('/private/credentials'), false);
  assert.equal(result.javascript.includes('sourceMappingURL'), false);
});
