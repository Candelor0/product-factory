import { AppError } from './validation';

const sensitive = () =>
  new AppError('EXPORT_SENSITIVE', '源码或文档中发现疑似凭据，请移除后再导出。未生成导出包。');
/** A conservative guard, not a claim to recognize every possible secret or arbitrary encoding. */
export function assertExportContentsSafe(
  contents: readonly string[],
  secrets: readonly string[] = [],
): void {
  const needles = secrets
    .filter(Boolean)
    .flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
    ]);
  for (const content of contents) {
    let decoded = content;
    for (let depth = 0; depth < 5; depth++) {
      if (
        needles.some((secret) => decoded.includes(secret)) ||
        /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u.test(decoded) ||
        /\b(?:sk|sk-proj|sk-ant)-[a-zA-Z0-9_-]{16,}\b/u.test(decoded) ||
        /\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_=-]{12,}/iu.test(decoded) ||
        /["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/iu.test(
          decoded,
        )
      )
        throw sensitive();
      const next = decoded
        .replace(/\\+u([0-9a-f]{4})/giu, (_match, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        )
        .replace(/\\+(["\\/])/gu, '$1');
      if (next === decoded) break;
      decoded = next;
    }
  }
}
