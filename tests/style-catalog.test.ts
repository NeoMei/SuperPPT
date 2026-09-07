import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StyleRecipeSchema } from '../src/styles/schemas.js';
import { builtInStyleAssetsRoot, loadBuiltInStyleCatalog, loadStyleCatalog, selectStyleVariant } from '../src/styles/catalog.js';
import { compileSlidePrompt } from '../src/styles/prompt-compiler.js';

const expectedIds = ['tactile', 'glass', 'ink', 'hand-drawn', 'textbook', 'collage', 'cinematic-tech', 'luxury-photo', 'blueprint', 'fantasy'];
const acceptedSourceFixture = join(process.cwd(), 'tests/fixtures/accepted-style-source');
const legacyStyleHashes = {
  tactile: '2a1cf9e593e1c3c834177666fc125f463787113848bf82730bd5635772222512',
  glass: '16b2b8f252c96951b5fbd3284e5044e51b945e7d55bcd5803932aef209fb5401',
  ink: 'ce5c14dc31f3f689fa05ce4200c657959d7717405c802609749c0b42c68eff64',
} as const;
const unrelatedSpec = {
  schemaVersion: 1 as const,
  slideId: '00000000-0000-4000-8000-000000000010',
  title: '季度交付计划',
  role: 'process' as const,
  coreMessage: '验证后再扩展',
  requiredText: ['季度交付计划', '先完成迁移', '再验证服务', '最后逐步扩展'],
  relationships: ['迁移 → 验证 → 扩展'],
  forbidden: [],
  sourceRefs: ['source/original.md'],
};

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('bundled catalog exposes the accepted ten styles in order while preserving the original three definitions', async () => {
  const catalog = await loadBuiltInStyleCatalog();
  assert.deepEqual(catalog.styles.map(style => style.id), expectedIds);
  for (const style of catalog.styles.slice(0, 3)) {
    const { showcase: _showcase, ...legacyDefinition } = style;
    assert.equal(hash(legacyDefinition), legacyStyleHashes[style.id as keyof typeof legacyStyleHashes]);
  }
});

test('new styles expose only the accepted level-three midpoint variant and reject unsupported choices', async () => {
  const catalog = await loadBuiltInStyleCatalog();
  const newStyles = catalog.styles.slice(3);
  assert.equal(newStyles.length, 7);
  for (const style of newStyles) {
    assert.deepEqual(style.tiers.map(tier => tier.level), [3], style.id);
    assert.deepEqual(style.palettes.map(palette => palette.id), ['mid'], style.id);
    assert.deepEqual(style.previews, [{ level: 3, paletteId: 'mid', path: `previews/${style.id}-3-mid.jpg` }]);
    assert.deepEqual(style.showcase, { level: 3, paletteId: 'mid', path: `showcases/${style.id}.jpg` });
    assert.throws(() => selectStyleVariant(style, { level: 1, paletteId: 'mid' }), /tier/);
    assert.throws(() => selectStyleVariant(style, { level: 3, paletteId: 'cool' }), /palette/);
  }
});

test('accepted recipes compile unrelated copy without leaking showcase advertising fixtures', async () => {
  const catalog = await loadBuiltInStyleCatalog();
  const newStyles = catalog.styles.slice(3);
  assert.equal(newStyles.length, 7);
  for (const recipe of newStyles) {
    const style = selectStyleVariant(recipe, { level: 3, paletteId: 'mid' });
    const text = compileSlidePrompt({ spec: unrelatedSpec, style }).text;
    assert.ok(text.includes(unrelatedSpec.requiredText.join('\n')), recipe.id);
    assert.ok(text.includes(unrelatedSpec.relationships.join('\n')), recipe.id);
    assert.doesNotMatch(text, /SuperPPT|10 大精选模板|让内容，自带设计感|用途说明|广告展示页/, recipe.id);

    const brandedSpec = {
      ...unrelatedSpec,
      title: 'SuperPPT 产品路线',
      requiredText: ['SuperPPT 产品路线', '先完成迁移', '再验证服务'],
    };
    const brandedText = compileSlidePrompt({ spec: brandedSpec, style }).text;
    assert.equal((brandedText.match(/SuperPPT/g) ?? []).length, 1, recipe.id);
    assert.ok(brandedText.includes(brandedSpec.requiredText.join('\n')), recipe.id);
  }
});

test('showcases must reference selectable options and use portable contained paths', () => {
  const base = {
    id: 'example', name: '示例',
    tiers: [{ level: 3, promptTemplate: '{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' }],
    palettes: [{ id: 'mid', name: '基准中线', prompt: 'neutral' }],
    previews: [{ level: 3, paletteId: 'mid', path: 'previews/example-3-mid.jpg' }],
    showcase: { level: 3, paletteId: 'mid', path: 'showcases/example.jpg' },
  };
  assert.equal(StyleRecipeSchema.safeParse(base).success, true);
  assert.equal(StyleRecipeSchema.safeParse({ ...base, showcase: { ...base.showcase, level: 2 } }).success, false);
  for (const path of ['/tmp/example.jpg', '../example.jpg', 'showcases/../../example.jpg']) {
    assert.equal(StyleRecipeSchema.safeParse({ ...base, showcase: { ...base.showcase, path } }).success, false, path);
  }
});

test('catalog loading checks the showcase file as well as preview files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'superppt-style-catalog-'));
  try {
    const catalog = {
      catalogVersion: 2, selectionMode: 'single', styles: [{
        id: 'example', name: '示例',
        tiers: [{ level: 3, promptTemplate: '{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' }],
        palettes: [{ id: 'mid', name: '基准中线', prompt: 'neutral' }],
        previews: [],
        showcase: { level: 3, paletteId: 'mid', path: 'showcases/example.jpg' },
      }],
    };
    const path = join(directory, 'catalog.json');
    await writeFile(path, JSON.stringify(catalog));
    await assert.rejects(() => loadStyleCatalog(path), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every bundled preview and showcase is a bounded 1280x720 JPEG', async () => {
  const catalog = await loadBuiltInStyleCatalog();
  const root = builtInStyleAssetsRoot();
  for (const style of catalog.styles) {
    for (const asset of [...style.previews, ...(style.showcase ? [style.showcase] : [])]) {
      const path = join(root, asset.path);
      const metadata = await sharp(await readFile(path)).metadata();
      assert.equal(metadata.format, 'jpeg', asset.path);
      assert.equal(metadata.width, 1280, asset.path);
      assert.equal(metadata.height, 720, asset.path);
      assert.ok((await stat(path)).size <= 500_000, asset.path);
    }
  }
});

test('accepted-source normalization rejects prompt drift from a portable accepted-source fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'superppt-accepted-source-'));
  try {
    await cp(acceptedSourceFixture, directory, { recursive: true });
    const driftedPrompt = 'prompts/tactile.txt';
    await writeFile(join(directory, driftedPrompt), await readFile(join(directory, driftedPrompt), 'utf8') + '\nDRIFT');
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/build-style-catalog.mjs', '--normalize-previews', '--accepted-source-dir', directory], { cwd: process.cwd() });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => resolve({ code, stderr }));
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Accepted prompt changed: prompts\/tactile\.txt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
