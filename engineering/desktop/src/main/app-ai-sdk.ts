/** Fixed browser ESM: text is sent only through the current project's authorized host session. */
export const APP_AI_SDK_SOURCE = `
const endpoint = new URL('/app-ai', import.meta.url);
const fail = (code, message) => Object.assign(new Error(message), { code });
export async function generateText(input) {
  let body;
  try {
    if (!input || typeof input.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.requestId) ||
        typeof input.text !== 'string' || !input.text.trim()) throw new Error();
    body = JSON.stringify({schemaVersion:1, requestId:input.requestId, text:input.text});
    if (new TextEncoder().encode(body).byteLength > 32 * 1024) throw new Error();
  } catch { throw fail('APP_AI_INVALID_INPUT', 'AI 输入无效或过长，请检查后重试。'); }
  let response;
  try {
    response = await fetch(endpoint, {method:'POST', credentials:'omit', headers:{'Content-Type':'application/json'}, body});
  } catch { throw fail('APP_AI_NETWORK', 'AI 请求结果尚未确认；请保留输入与请求编号，勿自动重试。'); }
  let result;
  try { result = await response.json(); } catch { throw fail('APP_AI_RESPONSE', 'AI 请求结果尚未确认，请返回工作台核对。'); }
  if (result && result.ok === false && result.error &&
      typeof result.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.error.code) &&
      typeof result.error.message === 'string' && result.error.message.length > 0 && result.error.message.length <= 240)
    throw fail(result.error.code, result.error.message);
  if (!response.ok || !result || result.ok !== true || !result.value || typeof result.value.text !== 'string')
    throw fail('APP_AI_RESPONSE', 'AI 请求结果尚未确认，请返回工作台核对。');
  return result.value.text;
}
export const appAi = Object.freeze({generateText});
`;
