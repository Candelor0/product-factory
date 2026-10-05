/** Trusted browser ESM served beside each generated bundle; it has no host bridge or project selector. */
export const APP_DATA_SDK_SOURCE = `
const endpoint = new URL('/app-data', import.meta.url);
const fail = (code, message) => Object.assign(new Error(message), { code });
const revision = value => Number.isSafeInteger(value) && value >= 0;
async function request(operation, input) {
  let body;
  try {
    body = JSON.stringify(operation === 'read'
      ? { schemaVersion: 1, operation: 'read' }
      : { schemaVersion: 1, operation: 'apply', requestId: input.requestId,
          expectedRevision: input.expectedRevision, changes: input.changes }, (_key, value) => {
      if (value === undefined || ['function', 'symbol', 'bigint'].includes(typeof value) ||
          (typeof value === 'number' && !Number.isFinite(value))) throw new Error();
      return value;
    });
  } catch {
    throw fail('APP_DATA_INVALID_INPUT', '保存内容无效，请保留编辑并检查输入。');
  }
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' }, body,
    });
  } catch {
    throw fail('APP_DATA_NETWORK', '数据操作结果尚未确认。请保留编辑；保存操作重试时沿用同一请求。');
  }
  let result;
  try { result = await response.json(); } catch {
    throw fail('APP_DATA_RESPONSE', '数据操作结果尚未确认，请保留编辑后核对重试。');
  }
  if (result && result.ok === false && result.error &&
      typeof result.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.error.code) &&
      typeof result.error.message === 'string' && result.error.message.length > 0 && result.error.message.length <= 240)
    throw fail(result.error.code, result.error.message);
  const value = result && result.value;
  if (!response.ok || !result || result.ok !== true || !value || !revision(value.revision) ||
      (operation === 'read'
        ? !value.values || typeof value.values !== 'object' || Array.isArray(value.values)
        : !revision(value.appliedRevision) || value.appliedRevision < 1 || value.appliedRevision > value.revision || typeof value.replayed !== 'boolean'))
    throw fail('APP_DATA_RESPONSE', '数据操作结果尚未确认，请保留编辑后核对重试。');
  return value;
}
export const appData = Object.freeze({
  read: () => request('read'),
  apply: input => request('apply', input),
});
`;
