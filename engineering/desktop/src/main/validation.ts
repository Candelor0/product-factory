import type { DesignContent, RequirementContent } from '../shared/contracts.js';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function assertRecord(
  value: unknown,
  label = '输入',
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_INPUT', `${label}必须是对象。`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AppError('INVALID_INPUT', `${label}格式不受支持。`);
  }
}

export function assertFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label = '输入',
): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new AppError('INVALID_INPUT', `${label}包含不支持的字段。`);
  }
}

export function parseText(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new AppError(
      'INVALID_INPUT',
      `${label}必须为不超过 ${maxLength} 字的文本，且不能包含控制字符。`,
    );
  }
  const text = value.trim();
  if (!allowEmpty && text.length === 0) throw new AppError('INVALID_INPUT', `${label}不能为空。`);
  return text;
}

export function parseProjectName(value: unknown): string {
  return parseText(value, '项目名称', 80);
}
export function parseIdea(value: unknown): string {
  return parseText(value, '项目想法', 8_000);
}

function parseId(value: unknown, label: string): string {
  // Canonical lowercase UUIDs avoid filesystem case aliases on macOS and Windows.
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new AppError('INVALID_INPUT', `${label}无效。`);
  }
  return value;
}

export function parseProjectId(value: unknown): string {
  return parseId(value, '项目标识');
}
export function parseRevisionId(value: unknown): string {
  return parseId(value, '版本标识');
}

function textList(value: unknown, label: string, maxItems = 50): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new AppError('INVALID_INPUT', `${label}必须是最多 ${maxItems} 项的列表。`);
  }
  // Array.from visits sparse slots; map would preserve holes that become null on disk.
  return Array.from(value, (item) => parseText(item, label, 1_000));
}

export function parseRequirements(value: unknown): RequirementContent {
  assertRecord(value, '需求');
  assertFields(
    value,
    ['summary', 'audience', 'features', 'pages', 'data', 'outOfScope', 'questions', 'acceptance'],
    '需求',
  );
  return {
    summary: parseText(value.summary, '需求摘要', 8_000),
    audience: parseText(value.audience, '目标用户', 2_000),
    features: textList(value.features, '功能'),
    pages: textList(value.pages, '页面'),
    data: textList(value.data, '数据'),
    outOfScope: textList(value.outOfScope, '范围之外'),
    questions: textList(value.questions, '待确认问题'),
    acceptance: textList(value.acceptance, '验收目标'),
  };
}

export function parseDesign(value: unknown): DesignContent {
  assertRecord(value, '页面方案');
  assertFields(value, ['direction', 'palette', 'pages', 'notes'], '页面方案');
  if (!Array.isArray(value.pages) || value.pages.length === 0 || value.pages.length > 30) {
    throw new AppError('INVALID_INPUT', '页面方案须包含 1 至 30 个页面。');
  }
  const palette = textList(value.palette, '配色', 12);
  if (palette.length === 0 || palette.some((color) => !/^#[0-9a-fA-F]{6}$/u.test(color))) {
    throw new AppError('INVALID_INPUT', '配色须为 1 至 12 个 #RRGGBB 格式的颜色。');
  }
  return {
    direction: parseText(value.direction, '设计方向', 8_000),
    palette,
    pages: Array.from(value.pages, (page: unknown) => {
      assertRecord(page, '方案页面');
      assertFields(page, ['name', 'sections'], '方案页面');
      return {
        name: parseText(page.name, '页面名称', 120),
        sections: textList(page.sections, '页面区块'),
      };
    }),
    notes: textList(value.notes, '方案说明'),
  };
}
