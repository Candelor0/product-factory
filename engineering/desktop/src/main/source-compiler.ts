import { parse } from 'acorn';
import { basename, posix } from 'node:path';
import type { BuildContext, Loader, Message, Plugin } from 'esbuild';
import type { BuildDiagnostic, CompiledSource } from '../shared/build-contracts';
import type { SourceSnapshot } from '../shared/source-contracts';
import { parseSourceContent, parseSourcePath, SOURCE_LIMITS, sourceHash } from './source-protocol';
import { assertFields, assertRecord } from './validation';
import { readSourceDataSchema } from './data-schema-protocol';

const NAMESPACE = 'factory-source';
const ENTRY = '__factory_entry__.tsx';
const ENTRY_SOURCE =
  "import App from './src/app.tsx'; import {createRoot} from 'react-dom/client'; const report=(error:unknown)=>{ (globalThis as any).__factoryRuntimeError?.(error); }; createRoot(document.getElementById('root')!, {onUncaughtError:report,onCaughtError:report,onRecoverableError:report}).render(<App/>);";
const RUNTIME_IMPORTS = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom/client',
]);
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const diagnostics = {
  invalid: '源码快照无效，无法构建。',
  schema: 'src/data-schema.json 数据结构声明无效或超过限制，请检查声明与相邻版本迁移步骤。',
  entry: '缺少 src/app.tsx 入口文件，请提供默认导出的 App 组件。',
  import: '依赖不在允许范围内；请使用源码树中的相对路径或受支持的 React 模块。',
  missing: '相对引用的源码文件不存在，请核对文件路径。',
  dynamic: '不支持动态模块路径，请使用明确的字符串导入。',
  require: '当前模板只支持 ES 模块，请将 require 改为 import。',
  asset: '当前模板不支持 CSS 资源 URL，请使用纯 CSS 样式。',
  syntax: '源码语法无法编译，请检查此处。',
  exports: '模块导出不匹配，请检查默认导出和引用的名称。',
  css: 'CSS 内容存在编译问题，请检查此处。',
  warning: '编译器报告了警告，请检查此处。',
  unavailable: '编译工具未能完成，请保留源码后重试。',
  output: '编译产物超过大小限制，本次产物未交付。',
  cancelled: '构建已取消，本次产物未交付。',
};
export class CompileFailure extends Error {
  readonly name = 'CompileFailure';
  constructor(
    public readonly diagnostics: BuildDiagnostic[],
    public readonly code: 'BUILD_FAILED' | 'BUILD_CANCELLED' = 'BUILD_FAILED',
  ) {
    super(code === 'BUILD_CANCELLED' ? diagnosticsMessage('cancelled') : '源码构建未完成。');
  }
}
const diagnosticsMessage = (kind: keyof typeof diagnostics) => diagnostics[kind];
const failure = (
  kind: keyof typeof diagnostics,
  path: string | null = null,
  line: number | null = null,
) => new CompileFailure([{ path, line, message: diagnosticsMessage(kind) }]);
const cancelled = () =>
  new CompileFailure(
    [{ path: null, line: null, message: diagnostics.cancelled }],
    'BUILD_CANCELLED',
  );
const loaderFor = (path: string): Loader => posix.extname(path).slice(1) as Loader;

function validatedFiles(snapshot: SourceSnapshot): Map<string, string> {
  try {
    assertRecord(snapshot);
    assertFields(snapshot, ['revision', 'files']);
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      !Array.isArray(snapshot.files) ||
      snapshot.files.length > SOURCE_LIMITS.fileCount
    )
      throw new Error();
    let bytes = 0;
    const files = new Map<string, string>();
    for (const raw of snapshot.files) {
      assertRecord(raw);
      assertFields(raw, ['path', 'content', 'sha256']);
      const path = parseSourcePath(raw.path);
      const content = parseSourceContent(raw.content);
      if (files.has(path) || sourceHash(content) !== raw.sha256) throw new Error();
      files.set(path, content);
      bytes += Buffer.byteLength(content);
    }
    if (bytes > SOURCE_LIMITS.workspaceBytes) throw new Error();
    return files;
  } catch {
    throw failure('invalid');
  }
}

function safeMessages(
  messages: readonly Message[],
  files: Map<string, string>,
  originalLines: boolean,
  warning = false,
): BuildDiagnostic[] {
  return messages.slice(0, 20).map((message) => {
    const name = message.location?.file;
    const candidate =
      typeof name === 'string' && name.startsWith(`${NAMESPACE}:`)
        ? name.slice(NAMESPACE.length + 1)
        : name;
    const path = candidate && files.has(candidate) ? candidate : null;
    const candidateLine = message.location?.line;
    const line =
      originalLines &&
      path &&
      Number.isSafeInteger(candidateLine) &&
      candidateLine! > 0 &&
      candidateLine! <= files.get(path)!.split('\n').length + 1
        ? candidateLine!
        : null;
    // Never copy esbuild's text, notes, lineText, detail, or stack: each may quote source or host paths.
    const internal = /^PF_(import|missing|asset)$/u.exec(message.text)?.[1] as
      'import' | 'missing' | 'asset' | undefined;
    const kind =
      internal ??
      (/No matching export|No matching import/u.test(message.text)
        ? 'exports'
        : path?.endsWith('.css')
          ? 'css'
          : warning
            ? 'warning'
            : 'syntax');
    return { path, line, message: diagnostics[kind] };
  });
}

/** Parse the transformed module before bundling: esbuild glob imports must never reach its filesystem resolver. */
function checkModule(source: string, path: string): void {
  let root: unknown;
  try {
    root = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    throw failure('syntax', path);
  }
  const pending: { value: unknown; parent?: Record<string, unknown>; key?: string }[] = [
    { value: root },
  ];
  while (pending.length) {
    const { value, parent, key } = pending.pop()!;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, parent, key });
      continue;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'ImportExpression') {
      const source = node.source as Record<string, unknown> | undefined;
      if (source?.type !== 'Literal' || typeof source.value !== 'string')
        throw failure('dynamic', path);
    }
    if (node.type === 'Identifier' && node.name === 'require') {
      const propertyName =
        parent &&
        ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
          ((parent.type === 'Property' ||
            parent.type === 'MethodDefinition' ||
            parent.type === 'PropertyDefinition') &&
            key === 'key' &&
            !parent.computed &&
            !parent.shorthand));
      if (!propertyName) throw failure('require', path);
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (childKey !== 'start' && childKey !== 'end' && childKey !== 'loc')
        pending.push({ value: child, parent: node, key: childKey });
    }
  }
}

function resolveRelative(
  imported: string,
  importer: string,
  files: Map<string, string>,
  css: boolean,
): string | null {
  if (
    (!imported.startsWith('./') && !imported.startsWith('../')) ||
    /[\\:%?#\u0000-\u0020\u007f]/u.test(imported)
  )
    return null;
  const resolved = posix.normalize(
    posix.join(importer === ENTRY ? '' : posix.dirname(importer), imported),
  );
  if (!resolved.startsWith('src/')) return null;
  const extension = posix.extname(resolved);
  const candidates = [resolved];
  if (!extension)
    candidates.push(
      ...(css ? ['.css'] : ['.tsx', '.ts', '.jsx', '.js', '.json', '.css']).map(
        (suffix) => resolved + suffix,
      ),
      ...['index.tsx', 'index.ts', 'index.jsx', 'index.js', 'index.json'].map(
        (name) => `${resolved}/${name}`,
      ),
    );
  else if (!css && (extension === '.js' || extension === '.jsx'))
    candidates.push(
      resolved.slice(0, -extension.length) + '.ts',
      resolved.slice(0, -extension.length) + '.tsx',
    );
  return (
    candidates.find((candidate) => files.has(candidate) && (!css || candidate.endsWith('.css'))) ??
    null
  );
}

/** Fixed compiler, in-memory source and trusted runtime only. No user config, plugin, installation, or generated code is executed. */
export async function compileSource(
  snapshot: SourceSnapshot,
  options: { signal?: AbortSignal } = {},
): Promise<CompiledSource> {
  const signal = options.signal;
  const checkCancellation = () => {
    if (signal?.aborted) throw cancelled();
  };
  checkCancellation();
  const files = validatedFiles(snapshot);
  try {
    readSourceDataSchema(snapshot.files);
  } catch {
    throw failure('schema', 'src/data-schema.json');
  }
  if (!files.has('src/app.tsx')) throw failure('entry');
  let context: BuildContext | undefined;
  let result: CompiledSource | undefined;
  let error: CompileFailure | undefined;
  const onAbort = () => {
    void context?.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // Runtime bootstrap sets the bundled binary path before this module is initialized.
    const esbuild = await import('esbuild');
    checkCancellation();
    const modules = new Map<string, string>();
    const warnings: BuildDiagnostic[] = [];
    for (const [path, content] of files) {
      checkCancellation();
      if (path.endsWith('.css') || path.endsWith('.json')) {
        modules.set(path, content);
        continue;
      }
      let transformed;
      try {
        transformed = await esbuild.transform(content, {
          loader: loaderFor(path),
          sourcefile: path,
          target: 'chrome144',
          format: 'esm',
          jsx: 'automatic',
          jsxImportSource: 'react',
          jsxDev: false,
          tsconfigRaw: {},
          sourcemap: false,
          legalComments: 'none',
          logLevel: 'silent',
          charset: 'utf8',
          treeShaking: false,
          ignoreAnnotations: true,
        });
      } catch (cause) {
        const messages = (cause as { errors?: Message[] })?.errors;
        throw messages?.length
          ? new CompileFailure(safeMessages(messages, files, true))
          : failure('unavailable');
      }
      checkCancellation();
      checkModule(transformed.code, path);
      modules.set(path, transformed.code);
      warnings.push(...safeMessages(transformed.warnings, files, true, true));
    }
    const plugin: Plugin = {
      name: 'factory-virtual-source',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point')
            return args.path === ENTRY
              ? { path: ENTRY, namespace: NAMESPACE }
              : { errors: [{ text: 'PF_import' }] };
          if (args.namespace !== NAMESPACE) return { errors: [{ text: 'PF_import' }] };
          if (args.kind === 'url-token') return { errors: [{ text: 'PF_asset' }] };
          if (
            args.kind !== 'import-statement' &&
            args.kind !== 'dynamic-import' &&
            args.kind !== 'import-rule'
          )
            return { errors: [{ text: 'PF_import' }] };
          if (args.kind !== 'import-rule' && RUNTIME_IMPORTS.has(args.path))
            return { path: './runtime.js', external: true };
          if (args.kind !== 'import-rule' && args.path === '@factory/data')
            return { path: './data.js', external: true };
          if (args.kind !== 'import-rule' && args.path === '@factory/ai')
            return { path: './ai.js', external: true };
          const path = resolveRelative(
            args.path,
            args.importer,
            modules,
            args.kind === 'import-rule',
          );
          if (!path)
            return {
              errors: [
                {
                  text:
                    args.path.startsWith('./') || args.path.startsWith('../')
                      ? 'PF_missing'
                      : 'PF_import',
                },
              ],
            };
          return { path, namespace: NAMESPACE };
        });
        build.onLoad({ filter: /.*/ }, (args) => {
          if (args.namespace !== NAMESPACE) return { errors: [{ text: 'PF_import' }] };
          if (args.path === ENTRY) return { contents: ENTRY_SOURCE, loader: 'tsx' };
          const contents = modules.get(args.path);
          if (contents === undefined) return { errors: [{ text: 'PF_missing' }] };
          return {
            contents,
            loader: args.path.endsWith('.css')
              ? 'css'
              : args.path.endsWith('.json')
                ? 'json'
                : 'js',
          };
        });
      },
    };
    context = await esbuild.context({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      outfile: 'bundle.js',
      platform: 'browser',
      format: 'esm',
      target: 'chrome144',
      jsx: 'automatic',
      jsxImportSource: 'react',
      tsconfigRaw: {},
      sourcemap: false,
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'silent',
      treeShaking: false,
      ignoreAnnotations: true,
      metafile: true,
      plugins: [plugin],
      logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' },
    });
    if (signal?.aborted) {
      await context.cancel();
      throw cancelled();
    }
    const built = await context.rebuild();
    checkCancellation();
    // Defense in depth: no generated import may cause a host file to enter the result.
    if (
      Object.keys(built.metafile!.inputs).some(
        (path) =>
          !path.startsWith(`${NAMESPACE}:`) ||
          (path !== `${NAMESPACE}:${ENTRY}` && !modules.has(path.slice(NAMESPACE.length + 1))),
      ) ||
      Object.values(built.metafile!.outputs).some((output) =>
        output.imports.some(
          (item) => !['./runtime.js', './data.js', './ai.js'].includes(item.path) || !item.external,
        ),
      )
    )
      throw failure('import');
    const outputFiles = built.outputFiles!;
    if (
      outputFiles.some((file) => !['bundle.js', 'bundle.css'].includes(basename(file.path))) ||
      outputFiles.reduce((bytes, file) => bytes + file.contents.byteLength, 0) > OUTPUT_LIMIT
    )
      throw failure('output');
    const javascript = outputFiles.find((file) => basename(file.path) === 'bundle.js')?.text;
    if (!javascript) throw failure('unavailable');
    const css = outputFiles.find((file) => basename(file.path) === 'bundle.css')?.text ?? '';
    warnings.push(...safeMessages(built.warnings, files, false, true));
    result = { javascript, css, warnings: warnings.slice(0, 20) };
  } catch (cause) {
    const messages = (cause as { errors?: Message[] })?.errors;
    error = signal?.aborted
      ? cancelled()
      : cause instanceof CompileFailure
        ? cause
        : messages?.length
          ? new CompileFailure(safeMessages(messages, files, false))
          : failure('unavailable');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await context?.dispose();
    } catch {
      error ??= failure('unavailable');
    }
  }
  checkCancellation();
  if (error) throw error;
  return result!;
}
