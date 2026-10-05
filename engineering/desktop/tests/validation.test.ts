import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  AppError,
  parseDesign,
  parseIdea,
  parseProjectId,
  parseProjectName,
  parseRequirements,
} from '../src/main/validation.js';

const validRequirements = () => ({
  summary: '我的博客',
  audience: '我和朋友',
  features: ['写文章'],
  pages: ['首页'],
  data: ['文章'],
  outOfScope: ['公网发布'],
  questions: ['是否需要标签？'],
  acceptance: ['重开后文章仍存在'],
});

test('requirements parser preserves open questions and copies caller-owned collections', () => {
  const input = validRequirements();
  const parsed = parseRequirements(input);
  input.features.push('事后改动');
  assert.deepEqual(parsed.features, ['写文章']);
  assert.deepEqual(parsed.questions, ['是否需要标签？']);
});

test('requirements reject missing, unknown, oversized and malformed fields', () => {
  for (const input of [
    null,
    [],
    'text',
    { ...validRequirements(), secret: 'extra' },
    { ...validRequirements(), summary: ' ' },
    { ...validRequirements(), features: [''] },
    { ...validRequirements(), questions: undefined },
    { ...validRequirements(), data: [42] },
    { ...validRequirements(), acceptance: Array(51).fill('too many') },
    { ...validRequirements(), features: Array(2) },
    { ...validRequirements(), summary: 'x'.repeat(8_001) },
  ])
    assert.throws(
      () => parseRequirements(input),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT',
    );
});

test('design validates nested page schemas and returns independent content', () => {
  const input = {
    direction: '安静、适合阅读',
    palette: ['#f9f7f2'],
    pages: [{ name: '首页', sections: ['文章列表'] }],
    notes: [],
  };
  const output = parseDesign(input);
  input.pages[0]!.sections.push('extra');
  assert.deepEqual(output.pages[0]!.sections, ['文章列表']);
  assert.throws(() => parseDesign({ ...input, pages: [] }), AppError);
  assert.throws(() => parseDesign({ ...input, pages: Array(1) }), AppError);
  assert.throws(
    () => parseDesign({ ...input, pages: [{ ...input.pages[0], unsafe: true }] }),
    AppError,
  );
  assert.throws(() => parseDesign({ ...input, palette: Array(13).fill('#fff') }), AppError);
  assert.throws(() => parseDesign({ ...input, notes: [null] }), AppError);
});

test('identifiers are canonical UUIDs and cannot carry filesystem paths', () => {
  const id = randomUUID();
  assert.equal(parseProjectId(id), id);
  for (const value of [
    '../project',
    '/etc/passwd',
    '..\\other',
    `${id}/../other`,
    id.toUpperCase(),
    '',
    null,
  ]) {
    assert.throws(() => parseProjectId(value), AppError);
  }
});

test('design palette only accepts explicit six-digit hex colors', () => {
  const input = {
    direction: '简洁阅读',
    palette: ['#012aEF'],
    pages: [{ name: '首页', sections: ['正文'] }],
    notes: [],
  };
  assert.deepEqual(parseDesign(input).palette, ['#012aEF']);
  for (const palette of [
    [],
    ['#fff'],
    ['red'],
    ['var(--accent)'],
    ['url(https://example.com/image)'],
    ['rgb(0,0,0)'],
    ['#000000; color: red'],
    ['#abcdef00'],
    ['#aabbgg'],
  ]) {
    assert.throws(
      () => parseDesign({ ...input, palette }),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT',
    );
  }
});

test('human text supports Unicode and spaces, enforces limits and blocks control characters', () => {
  assert.equal(parseProjectName('  中文 项目 🌱  '), '中文 项目 🌱');
  assert.equal(parseIdea('第一行\n第二行'), '第一行\n第二行');
  assert.throws(() => parseProjectName('x'.repeat(81)), AppError);
  assert.throws(() => parseIdea('foo\u0000bar'), AppError);
  assert.throws(() => parseIdea('  '), AppError);
});
