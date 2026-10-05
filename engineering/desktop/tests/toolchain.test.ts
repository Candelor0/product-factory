import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadToolchain } from '../src/main/toolchain';

test('trusted runtime and binary must both match the pinned resource manifest', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-toolchain-'));
  const prior = process.env.ESBUILD_BINARY_PATH;
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    if (prior === undefined) delete process.env.ESBUILD_BINARY_PATH;
    else process.env.ESBUILD_BINARY_PATH = prior;
  });
  const name = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  writeFileSync(join(directory, name), 'synthetic binary; never executed');
  writeFileSync(join(directory, 'runtime.js'), 'export const synthetic = true;');
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      compiler: 'esbuild-0.28.2',
      templateVersion: 'react-preview-v1',
      files: Object.fromEntries(
        [name, 'runtime.js'].map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(join(directory, file)))
            .digest('hex'),
        ]),
      ),
    }),
  );
  assert.equal(loadToolchain(directory).runtime, 'export const synthetic = true;');
  assert.equal(process.env.ESBUILD_BINARY_PATH, join(directory, name));
  writeFileSync(join(directory, 'runtime.js'), 'replaced runtime');
  assert.throws(() => loadToolchain(directory), { code: 'TOOLCHAIN_UNAVAILABLE' });
  writeFileSync(join(directory, 'runtime.js'), 'export const synthetic = true;');
  writeFileSync(join(directory, name), 'replaced compiler');
  assert.throws(() => loadToolchain(directory), { code: 'TOOLCHAIN_UNAVAILABLE' });
});

test('missing and linked executables fail closed before selecting a new binary', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-toolchain-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => loadToolchain(directory), { code: 'TOOLCHAIN_UNAVAILABLE' });
  const name = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  writeFileSync(join(directory, 'target'), 'synthetic');
  symlinkSync(join(directory, 'target'), join(directory, name));
  writeFileSync(join(directory, 'runtime.js'), '');
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      compiler: 'esbuild-0.28.2',
      templateVersion: 'react-preview-v1',
      files: {
        [name]: createHash('sha256').update('synthetic').digest('hex'),
        'runtime.js': createHash('sha256').update('').digest('hex'),
      },
    }),
  );
  const before = process.env.ESBUILD_BINARY_PATH;
  assert.throws(() => loadToolchain(directory), { code: 'TOOLCHAIN_UNAVAILABLE' });
  assert.equal(process.env.ESBUILD_BINARY_PATH, before);
  unlinkSync(join(directory, name));
});
