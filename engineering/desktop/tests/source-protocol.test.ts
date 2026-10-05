import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AppError } from '../src/main/validation';
import {
  parseSourceToolRequest,
  parseSourcePath,
  parseSourceContent,
  parseSourceChanges,
  SOURCE_LIMITS,
  sourceHash,
} from '../src/main/source-protocol';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const base = () => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  tool: 'list_files',
  arguments: {},
});

test('source requests reject unknown tools, extra authority, malformed types, and sparse changes', () => {
  for (const input of [
    null,
    [],
    'list_files',
    { ...base(), schemaVersion: 2 },
    { ...base(), requestId: '/private/key' },
    { ...base(), projectId: randomUUID() },
    { ...base(), arguments: { root: '/' } },
    { ...base(), arguments: [] },
  ]) {
    assert.throws(() => parseSourceToolRequest(input), hasCode('INVALID_INPUT'));
  }
  for (const tool of ['shell', 'exec', 'build', 'readFile', {}, null])
    assert.throws(() => parseSourceToolRequest({ ...base(), tool }), hasCode('UNKNOWN_TOOL'));
  assert.throws(() => parseSourceChanges(new Array(1)), hasCode('INVALID_INPUT'));
  assert.deepEqual(parseSourceToolRequest(base()).arguments, {});
});

test('virtual paths reject traversal, aliases, protected toolchain inputs and file/directory ambiguity', () => {
  for (const path of [
    '../secret',
    '/src/a.ts',
    'C:/src/a.ts',
    'src\\a.ts',
    'src/../a.ts',
    'src//a.ts',
    'src/./a.ts',
    'src/%2e%2e/a.ts',
    'src/a.ts ',
    'src/a.ts.',
    'src/.env',
    'src/.config/a.ts',
    'src/A.ts',
    'src/a.TS',
    'src/a:stream.ts',
    'src/a\u0000.ts',
    'src/con.ts',
    'src/lpt1.css',
    'src/aux/a.ts',
    'src/node_modules/a.ts',
    'src/tests/a.ts',
    'src/a.test.ts',
    'src/a.spec.tsx',
    'src/vite.config.ts',
    'src/tsconfig.app.json',
    'src/package.json',
    'src/package-lock.json',
    'src/config/a.ts',
    'src/a.ts/b.ts',
    'src/app.exe',
    'src/image.png',
    'src/脚本.ts',
    'src/a/b/c/d/e/f/g/h.ts',
  ])
    assert.throws(() => parseSourcePath(path), hasCode('SOURCE_PATH_DENIED'), path);
  for (const path of [
    'src/app.tsx',
    'src/components/article-card.tsx',
    'src/styles/base.css',
    'src/data.json',
    'src/lib/v2.ts',
  ])
    assert.equal(parseSourcePath(path), path);
});

test('changes preserve exact text, require optimistic preconditions and reject duplicates or oversize data', () => {
  const text = '  你好\n\t';
  assert.equal(parseSourceContent(text), text);
  assert.equal(parseSourceContent(''), '');
  assert.equal(parseSourceContent('😀'), '😀');
  for (const bad of ['\u0000', '\ud800', '中'.repeat(SOURCE_LIMITS.fileBytes / 3 + 1), 123])
    assert.throws(() => parseSourceContent(bad), hasCode('SOURCE_LIMIT'));
  const valid = { operation: 'write', path: 'src/a.ts', expectedHash: null, content: text };
  assert.deepEqual(parseSourceChanges([valid]), [valid]);
  for (const bad of [
    [{ ...valid, expectedHash: undefined }],
    [{ ...valid, expectedHash: 'x' }],
    [{ ...valid, apiKey: 'blocked' }],
    [{ ...valid, operation: 'rename' }],
    [valid, valid],
    [{ operation: 'delete', path: 'src/a.ts', expectedHash: null }],
  ])
    assert.throws(() => parseSourceChanges(bad), hasCode('INVALID_INPUT'));
  for (const expectedRevision of [-1, 0.1, '1', Number.MAX_SAFE_INTEGER + 1, null])
    assert.throws(
      () =>
        parseSourceToolRequest({
          ...base(),
          tool: 'apply_changes',
          arguments: { expectedRevision, changes: [valid] },
        }),
      hasCode('INVALID_INPUT'),
    );
  assert.deepEqual(
    parseSourceChanges([{ operation: 'delete', path: 'src/a.ts', expectedHash: sourceHash(text) }]),
    [{ operation: 'delete', path: 'src/a.ts', expectedHash: sourceHash(text) }],
  );
  assert.throws(() => parseSourceChanges([]), hasCode('SOURCE_LIMIT'));
  assert.throws(() => parseSourceChanges(Array(33).fill(valid)), hasCode('SOURCE_LIMIT'));
  const big = Array.from({ length: 17 }, (_, i) => ({
    ...valid,
    path: `src/f${i}.ts`,
    content: 'x'.repeat(SOURCE_LIMITS.fileBytes),
  }));
  assert.throws(
    () =>
      parseSourceToolRequest({
        ...base(),
        tool: 'apply_changes',
        arguments: { expectedRevision: 0, changes: big },
      }),
    hasCode('SOURCE_LIMIT'),
  );
});
