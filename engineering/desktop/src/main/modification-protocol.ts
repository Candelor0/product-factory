import { MODIFICATION_LIMITS } from '../shared/modification';
import { AppError } from './validation';

export function parseModificationInstruction(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MODIFICATION_LIMITS.characters ||
    Buffer.byteLength(value, 'utf8') > MODIFICATION_LIMITS.bytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  )
    throw new AppError('INVALID_INPUT', '请填写不超过2000字的修改要求，不要包含凭据或无效字符。');
  return value.trim();
}
