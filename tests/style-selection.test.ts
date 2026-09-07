import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBuiltInStyleCatalog, builtInStyleAssetsRoot } from '../src/styles/catalog.js';
import type { StyleRecipe } from '../src/styles/schemas.js';

test('selection groups all ten styles into 34 available variants and discloses the three missing previews', async () => {
  const module = await import('../src/styles/selection.js').catch(() => ({} as Record<string, unknown>));
  assert.equal(typeof module.styleSelection, 'function');
  const selection = (module.styleSelection as (styles: StyleRecipe[]) => any)((await loadBuiltInStyleCatalog()).styles);
  assert.equal(selection.styles.length, 10);
  const variants = selection.styles.flatMap((style: any) => style.groups.flatMap((group: any) => group.variants));
  assert.equal(variants.length, 34);
  assert.deepEqual(
    variants.filter((variant: any) => variant.previewStatus === 'missing').map((variant: any) => `${variant.styleId}/${variant.level}/${variant.paletteId}`),
    ['tactile/1/mid', 'glass/1/cool', 'glass/2/cool'],
  );
  for (const style of selection.styles.slice(3)) {
    assert.deepEqual(style.groups.map((group: any) => group.level), [3]);
    assert.deepEqual(style.groups[0].variants.map((variant: any) => variant.paletteId), ['mid']);
  }
});

test('custom styles without showcases use a labelled variant reference or an honest empty image state', async () => {
  const module = await import('../src/styles/selection.js').catch(() => ({} as Record<string, unknown>));
  assert.equal(typeof module.styleSelection, 'function');
  const template = '{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}';
  const selection = (module.styleSelection as (styles: StyleRecipe[]) => any)([
    { id: 'referenced', name: '有参考', tiers: [{ level: 3, promptTemplate: template }], palettes: [{ id: 'mid', name: '中线', prompt: '中性' }], previews: [{ level: 3, paletteId: 'mid', path: 'previews/reference.jpg' }] },
    { id: 'empty', name: '无参考', tiers: [{ level: 1, promptTemplate: template }], palettes: [{ id: 'cool', name: '偏冷', prompt: '冷色' }], previews: [] },
  ] as StyleRecipe[]);
  assert.deepEqual(selection.styles.map((style: any) => ({ kind: style.card.imageKind, path: style.card.imagePath })), [
    { kind: 'variant-reference', path: 'previews/reference.jpg' },
    { kind: 'missing', path: null },
  ]);
  assert.equal(selection.styles[1].groups[0].variants[0].previewStatus, 'missing');
});

test('selection HTML embeds local images, escapes labels, and keeps missing variants selectable', async () => {
  const selectionModule = await import('../src/styles/selection.js').catch(() => ({} as Record<string, unknown>));
  const viewModule = await import('../src/styles/selection-view.js').catch(() => ({} as Record<string, unknown>));
  assert.equal(typeof selectionModule.styleSelection, 'function');
  assert.equal(typeof viewModule.writeStyleSelectionView, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'superppt-selection-'));
  try {
    const catalog = await loadBuiltInStyleCatalog();
    catalog.styles[0]!.name = '</script><img src=x onerror=alert(1)>';
    catalog.styles[0]!.palettes[0]!.name = '<svg/onload=alert(2)>';
    const relativePath = await (viewModule.writeStyleSelectionView as (...args: any[]) => Promise<string>)(directory, 'planning/revision/style-selection.html', {
      title: '<unsafe title>', purpose: '供管理层评审', audience: '产品团队',
      selection: (selectionModule.styleSelection as (styles: StyleRecipe[]) => any)(catalog.styles),
    }, builtInStyleAssetsRoot());
    assert.equal(relativePath, 'planning/revision/style-selection.html');
    const html = await readFile(join(directory, relativePath), 'utf8');
    assert.match(html, /data:image\/jpeg;base64,/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<img src="(?:previews|showcases)\//);
    assert.doesNotMatch(html, /<\/script><img/);
    assert.doesNotMatch(html, /<svg\/onload/);
    assert.match(html, /返回风格列表/);
    assert.match(html, /id="style-tactile-level-1"/);
    assert.match(html, /选择创意拼贴，3 档，基准中线/);
    assert.match(html, /缺少该组合的精确预览/);
    assert.match(html, /data-selectable="true"/);
    assert.match(html, /选择本身不会发送请求/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
