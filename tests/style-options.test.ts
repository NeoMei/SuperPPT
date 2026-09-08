import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolvedStyleSchema, StyleRecipeSchema } from '../src/styles/schemas.js';
import * as catalog from '../src/styles/catalog.js';
import { compileSlidePrompt } from '../src/styles/prompt-compiler.js';
import { SlideSpecSchema } from '../src/planning/schemas.js';

const definition = {
  id: 'test-glass', name: '玻璃',
  tiers: [1, 2, 3].map(level => ({ level, promptTemplate: `LEVEL ${level}\n{{PALETTE}}\n关系：{{CONTENT_RELATIONSHIPS}}\n全文：{{SLIDE_COPY}}` })),
  palettes: [{ id: 'cool', name: '偏冷', prompt: 'BLACK BLUE #0B1E2B' }, { id: 'warm', name: '偏暖', prompt: 'APRICOT' }],
  previews: [{ level: 2, paletteId: 'cool', path: 'previews/test-glass-2-cool.jpg' }],
};
const spec = { schemaVersion: 1 as const, slideId: '00000000-0000-4000-8000-000000000001', title: '标题',
  role: 'process' as const, coreMessage: '从反馈推动改进', requiredText: ['标题', ...Array.from({ length: 20 }, (_, i) => `保留原文第${i}行`)],
  relationships: ['收集 → 验证 → 回访 → 收集'], forbidden: [], sourceRefs: ['source/original.md'] };

test('style options accept independent tiers and style-specific palettes without eight-style padding', () => {
  assert.equal(StyleRecipeSchema.safeParse(definition).success, true);
});
test('content planning preserves more than twelve lines without requiring a predesigned picture', () => {
  assert.equal(SlideSpecSchema.safeParse(spec).success, true);
});
test('selected tier and palette compile once, preserving literal copy and relationships', () => {
  assert.equal(typeof catalog.selectStyleVariant, 'function');
  const style = catalog.selectStyleVariant(definition, { level: 2, paletteId: 'cool' });
  const text = compileSlidePrompt({ spec, style }).text;
  assert.equal(text, 'LEVEL 2\nBLACK BLUE #0B1E2B\n关系：收集 → 验证 → 回访 → 收集\n全文：' + spec.requiredText.join('\n'));
  assert.doesNotMatch(text, /APRICOT|canonical JSON|foreground|midground/);
});
test('slot-like and dollar text remains literal instead of being interpreted by replacements', () => {
  assert.equal(typeof catalog.selectStyleVariant, 'function');
  const style = catalog.selectStyleVariant(definition, { level: 3, paletteId: 'warm' });
  const text = compileSlidePrompt({ spec: { ...spec, requiredText: ["$& {{PALETTE}} $'"], relationships: ['{{SLIDE_COPY}}'] }, style }).text;
  assert.equal(text, "LEVEL 3\nAPRICOT\n关系：{{SLIDE_COPY}}\n全文：$& {{PALETTE}} $'");
});
test('unsupported palette or tier cannot silently fall back to another selection', () => {
  assert.equal(typeof catalog.selectStyleVariant, 'function');
  assert.throws(() => catalog.selectStyleVariant(definition, { level: 2, paletteId: 'purple' }), /palette/);
  assert.throws(() => catalog.selectStyleVariant(definition, { level: 4, paletteId: 'cool' }));
});
test('duplicate choices and incomplete prompt slots cannot publish ambiguous variants', () => {
  assert.equal(StyleRecipeSchema.safeParse({ ...definition, tiers: [definition.tiers[0], definition.tiers[0]] }).success, false);
  assert.equal(StyleRecipeSchema.safeParse({ ...definition, palettes: [definition.palettes[0], definition.palettes[0]] }).success, false);
  assert.equal(StyleRecipeSchema.safeParse({ ...definition, tiers: [{ level: 1, promptTemplate: '{{SLIDE_COPY}}' }] }).success, false);
});
test('custom prompt templates reject unsupported and malformed double-brace tokens while allowing ordinary braces', () => {
  const validTemplate = definition.tiers[0]!.promptTemplate + '\nObject example: {title: body}';
  const tiersWith = (promptTemplate: string) => definition.tiers.map((tier, index) => index === 0 ? { ...tier, promptTemplate } : tier);
  assert.equal(StyleRecipeSchema.safeParse({ ...definition, tiers: tiersWith(validTemplate) }).success, true);
  for (const token of ['{{UNSUPPORTED}}', '{{SLIDE_COPY}', 'SLIDE_COPY}}', '{{ SLIDE_COPY }}', '{{{SLIDE_COPY}}}', '{{SLIDE_COPY}}}']) {
    assert.equal(StyleRecipeSchema.safeParse({
      ...definition,
      tiers: tiersWith(validTemplate + '\n' + token),
    }).success, false, token);
  }
  for (const malformedTemplate of [
    validTemplate.replace('{{SLIDE_COPY}}', '{{{SLIDE_COPY}}}'),
    validTemplate.replace('{{SLIDE_COPY}}', '{{SLIDE_COPY}}}'),
  ]) {
    assert.equal(StyleRecipeSchema.safeParse({ ...definition, tiers: tiersWith(malformedTemplate) }).success, false, malformedTemplate);
  }
});
test('palette prompts cannot inject a template slot into compiled slide copy', () => {
  assert.equal(StyleRecipeSchema.safeParse({
    ...definition,
    palettes: definition.palettes.map((palette, index) => index === 0
      ? { ...palette, prompt: 'INK {{SLIDE_COPY}} ACCENT' }
      : palette),
  }).success, false);
});
test('selected variants satisfy the resolved two-slot template contract', () => {
  const style = catalog.selectStyleVariant(definition, { level: 2, paletteId: 'cool' });
  assert.equal(ResolvedStyleSchema.safeParse(style).success, true);
  assert.doesNotMatch(style.promptTemplate, /{{PALETTE}}/);
  assert.equal(style.promptTemplate.split('{{CONTENT_RELATIONSHIPS}}').length, 2);
  assert.equal(style.promptTemplate.split('{{SLIDE_COPY}}').length, 2);
});
test('resolved styles and direct compilation reject residual, duplicate, or unknown template tokens', () => {
  const style = catalog.selectStyleVariant(definition, { level: 2, paletteId: 'cool' });
  const invalidTemplates = [
    style.promptTemplate + '\n{{PALETTE}}',
    style.promptTemplate.replace('{{SLIDE_COPY}}', '{{SLIDE_COPY}}\n{{SLIDE_COPY}}'),
    style.promptTemplate + '\n{{UNSUPPORTED}}',
  ];
  for (const promptTemplate of invalidTemplates) {
    const invalidStyle = { ...style, promptTemplate };
    assert.equal(ResolvedStyleSchema.safeParse(invalidStyle).success, false, promptTemplate);
    assert.throws(() => compileSlidePrompt({ spec, style: invalidStyle }), promptTemplate);
  }
});

test('bundled options resolve in the installed layout and produce ready-to-send prompts with the selected palette', async () => {
  const bundled = await catalog.loadBuiltInStyleCatalog();
  for (const style of bundled.styles) {
    for (const tier of style.tiers) for (const palette of style.palettes) {
      const selected = catalog.selectStyleVariant(style, { level: tier.level, paletteId: palette.id });
      const prompt = compileSlidePrompt({ spec, style: selected }).text;
      assert.ok(prompt.includes(palette.prompt), style.id + '/' + tier.level + '/' + palette.id);
      assert.ok(prompt.includes(spec.requiredText.join('\n')));
      assert.ok(prompt.includes(spec.relationships[0]));
      assert.doesNotMatch(prompt, /{{PALETTE}}|{{CONTENT_RELATIONSHIPS}}|{{SLIDE_COPY}}/);
      assert.doesNotMatch(prompt, /这些数字是示例安排而非成效数据/, 'a style cannot reinterpret real data as example data');
    }

  }
});
