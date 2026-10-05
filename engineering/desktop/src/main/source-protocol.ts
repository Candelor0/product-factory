import { createHash } from 'node:crypto';
import type {
  SourceApplyInput,
  SourceBinding,
  SourceChange,
  SourceToolRequest,
} from '../shared/source-contracts';
import { AppError, assertFields, assertRecord, parseRevisionId } from './validation';

export const SOURCE_LIMITS = Object.freeze({
  fileBytes: 128 * 1024,
  workspaceBytes: 2 * 1024 * 1024,
  fileCount: 128,
  changeCount: 32,
  commits: 40,
  recordBytes: 16 * 1024 * 1024,
  requestBytes: 2 * 1024 * 1024,
});
export const sourceHash = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
export const sourceRequestHash = (value: SourceApplyInput) => sourceHash(JSON.stringify(value));

export function parseSourceHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new AppError('INVALID_INPUT', '源码校验值无效。');
  return value;
}
export function parseSourceRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new AppError('INVALID_INPUT', '源码版本无效。');
  return value as number;
}

/** Portable, deliberately narrow virtual paths; never use these as host file paths. */
export function parseSourcePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 180 || !value.startsWith('src/'))
    throw new AppError('SOURCE_PATH_DENIED', '只能访问 src 内允许的源码文件。');
  const parts = value.split('/');
  const forbidden = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu;
  if (
    parts.length < 2 ||
    parts.length > 8 ||
    parts.some(
      (part) => !/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/u.test(part) || forbidden.test(part),
    ) ||
    parts
      .slice(1, -1)
      .some(
        (part) =>
          part.includes('.') ||
          [
            'node_modules',
            'credentials',
            'tests',
            'test',
            'scripts',
            'dist',
            'build',
            'config',
          ].includes(part),
      ) ||
    !/\.(?:tsx?|jsx?|css|json)$/u.test(parts.at(-1)!) ||
    /(?:^|\.)(?:test|spec)\.[a-z]+$/u.test(parts.at(-1)!) ||
    /(?:^|\.)config\./u.test(parts.at(-1)!) ||
    /^(?:tsconfig|jsconfig|package)(?:\.|-)/u.test(parts.at(-1)!) ||
    /^(?:yarn|pnpm|bun|npm)(?:\.|-).*lock/u.test(parts.at(-1)!)
  )
    throw new AppError('SOURCE_PATH_DENIED', '源码路径不在允许范围内。');
  return value;
}
export function parseSourceContent(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > SOURCE_LIMITS.fileBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    /[\ud800-\udfff]/u.test(value)
  )
    throw new AppError('SOURCE_LIMIT', '源码须为大小受限的有效文本。');
  return value;
}
export function parseSourceBinding(value: unknown): SourceBinding {
  assertRecord(value);
  assertFields(value, ['planRunId', 'planInputHash', 'planArtifactHash']);
  return {
    planRunId: parseRevisionId(value.planRunId),
    planInputHash: parseSourceHash(value.planInputHash),
    planArtifactHash: parseSourceHash(value.planArtifactHash),
  };
}
export function parseSourceChanges(value: unknown): SourceChange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SOURCE_LIMITS.changeCount)
    throw new AppError('SOURCE_LIMIT', '一次修改须包含1至32个文件。');
  const paths = new Set<string>();
  return Array.from(value, (raw) => {
    assertRecord(raw);
    if (raw.operation !== 'write' && raw.operation !== 'delete')
      throw new AppError('INVALID_INPUT', '源码修改操作无效。');
    assertFields(
      raw,
      raw.operation === 'write'
        ? ['operation', 'path', 'expectedHash', 'content']
        : ['operation', 'path', 'expectedHash'],
    );
    const path = parseSourcePath(raw.path);
    if (paths.has(path)) throw new AppError('INVALID_INPUT', '同一批修改不能重复指定文件。');
    paths.add(path);
    if (raw.operation === 'delete')
      return { operation: 'delete', path, expectedHash: parseSourceHash(raw.expectedHash) };
    return {
      operation: 'write',
      path,
      expectedHash: raw.expectedHash === null ? null : parseSourceHash(raw.expectedHash),
      content: parseSourceContent(raw.content),
    };
  });
}
export function parseSourceApplyInput(value: unknown): SourceApplyInput {
  assertRecord(value);
  assertFields(value, ['requestId', 'binding', 'expectedRevision', 'changes']);
  return {
    requestId: parseRevisionId(value.requestId),
    binding: parseSourceBinding(value.binding),
    expectedRevision: parseSourceRevision(value.expectedRevision),
    changes: parseSourceChanges(value.changes),
  };
}

export function parseSourceToolRequest(value: unknown): SourceToolRequest {
  assertRecord(value);
  assertFields(value, ['schemaVersion', 'requestId', 'tool', 'arguments']);
  if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '源码工具协议版本无效。');
  const requestId = parseRevisionId(value.requestId);
  assertRecord(value.arguments);
  if (value.tool === 'list_files') {
    assertFields(value.arguments, []);
    return { schemaVersion: 1, requestId, tool: value.tool, arguments: {} };
  }
  if (value.tool === 'read_file') {
    assertFields(value.arguments, ['path']);
    return {
      schemaVersion: 1,
      requestId,
      tool: value.tool,
      arguments: { path: parseSourcePath(value.arguments.path) },
    };
  }
  if (value.tool === 'apply_changes') {
    assertFields(value.arguments, ['expectedRevision', 'changes']);
    const changes = parseSourceChanges(value.arguments.changes);
    const parsed: SourceToolRequest = {
      schemaVersion: 1,
      requestId,
      tool: value.tool,
      arguments: {
        expectedRevision: parseSourceRevision(value.arguments.expectedRevision),
        changes,
      },
    };
    if (Buffer.byteLength(JSON.stringify(parsed)) > SOURCE_LIMITS.requestBytes)
      throw new AppError('SOURCE_LIMIT', '源码工具请求过大。');
    return parsed;
  }
  throw new AppError('UNKNOWN_TOOL', '不支持此工具。');
}
