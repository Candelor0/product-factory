import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertExportContentsSafe } from '../src/main/export-security';
import { ModelService } from '../src/main/model-service';
import { AppError } from '../src/main/validation';

test('known credentials are refused in direct, escaped, URL and base64 forms without echoing values', () => {
  const secret = 'synthetic-key-with/+symbols-12345';
  for (const text of [
    secret,
    JSON.stringify(secret).replace(/s/gu, '\\u0073'),
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
  ]) {
    assert.throws(
      () => assertExportContentsSafe([text], [secret]),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'EXPORT_SENSITIVE' &&
        !error.message.includes(secret),
    );
  }
});
test('credential patterns are refused, ordinary documentation and typed input fields remain exportable', () => {
  for (const text of [
    'const apiKey="synthetic-value-long"',
    '{"access_token":"synthetic-value-long"}',
    'Authorization: Bearer synthetic-token-12345',
    '-----BEGIN PRIVATE KEY-----',
    'sk-abcdefghijklmnopqrstuv',
  ])
    assert.throws(
      () => assertExportContentsSafe([text]),
      (error: unknown) => error instanceof AppError && error.code === 'EXPORT_SENSITIVE',
    );
  assert.doesNotThrow(() =>
    assertExportContentsSafe([
      '请在工作台输入 API Key。',
      'type Options = {apiKey: string}; const password = input.value;',
      '<input type="password" />',
    ]),
  );
});
test('model service export inspection stays local and leaves usage and settings untouched', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-export-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const service = new ModelService(
    root,
    {
      available: () => false,
      encrypt: () => {
        throw new Error();
      },
      decrypt: () => {
        throw new Error();
      },
    },
    async () => {
      calls++;
      throw new Error('must not request');
    },
  );
  service.assertExportSafe(['no saved key']);
  const secret = 'synthetic-export-only-provider-secret';
  service.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: secret,
    maxCalls: 10,
  });
  const before = { settings: service.settings(), usage: service.usage() };
  assert.throws(
    () => service.assertExportSafe([secret]),
    (error: unknown) => error instanceof AppError && error.code === 'EXPORT_SENSITIVE',
  );
  service.assertExportSafe(['普通源码']);
  assert.deepEqual({ settings: service.settings(), usage: service.usage() }, before);
  assert.equal(calls, 0);
});

test('a locked saved key prevents an unverified credential scan without exposing decrypted data', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-export-locked-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let available = true;
  const secret = 'synthetic-key-locked-export';
  const service = new ModelService(root, {
    available: () => available,
    encrypt: () => Buffer.from('synthetic-ciphertext'),
    decrypt: () => secret,
  });
  service.save({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: secret,
    maxCalls: 10,
  });
  service.assertExportSafe(['ordinary source']);
  assert.throws(
    () => service.assertExportSafe([secret]),
    (error: unknown) => error instanceof AppError && error.code === 'EXPORT_SENSITIVE',
  );
  available = false;
  assert.throws(
    () => service.assertExportSafe(['ordinary source']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'CREDENTIAL_UNAVAILABLE' &&
      !error.message.includes(secret),
  );
  assert.equal(service.usage().calls, 0);
});
