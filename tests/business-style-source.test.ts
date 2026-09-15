import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const run = promisify(execFile);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const businessIds = ['deep-sea', 'celadon', 'dashboard'];

// Run the real builder in an isolated repository: never normalize the working catalog or assets.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'superppt-business-source-'));
  const assets = join(root, 'skills/superppt/assets/styles');
  const business = join(root, 'business');
  const accepted = join(root, 'accepted');
  await mkdir(assets, { recursive: true });
  await mkdir(join(root, 'scripts'));
  await cp('scripts/build-style-catalog.mjs', join(root, 'scripts/build-style-catalog.mjs'));
  await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
  const original = JSON.parse(await readFile('skills/superppt/assets/styles/catalog.json', 'utf8'));
  const provenance = JSON.parse(await readFile('skills/superppt/assets/styles/provenance.json', 'utf8'));
  const legacy = original.styles.filter((style: any) => !businessIds.includes(style.id));
  provenance.previews = provenance.previews.filter((asset: any) => !businessIds.includes(asset.styleId));
  provenance.showcases = provenance.showcases.filter((asset: any) => !businessIds.includes(asset.styleId));
  const styles = businessIds.map((id, index) => ({
    id, name: ['深海智汇', '商务青瓷', '数据看板'][index],
    tiers: [1, 2, 3].map(level => ({ level, promptTemplate: `文字为主；不编造数据；只有输入提供数据时才画图表；正文无流光。${level}\n{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}` })),
    palettes: ['cool', 'mid', 'warm'].map((id, index) => ({ id, name: ['偏冷', '基准中线', '偏暖'][index], prompt: `palette ${id}` })),
    previews: [1, 2, 3].flatMap(level => ['cool', 'mid', 'warm'].map(paletteId => ({ level, paletteId, path: `previews/${id}-${level}-${paletteId}.jpg` }))),
    showcase: { level: 3, paletteId: 'mid', path: `showcases/${id}.jpg` },
  }));
  const catalog = { ...original, styles: [...styles, ...legacy] };
  const png = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  await mkdir(join(business, 'images'), { recursive: true });
  await mkdir(join(business, 'prompts'));
  const variants = [];
  for (const style of styles) for (const preview of style.previews) {
    const key = `${style.id}-${preview.level}-${preview.paletteId}`;
    const prompt = `Source prompt for ${key}\n`;
    const variant = { styleId: style.id, level: preview.level, paletteId: preview.paletteId, image: `images/${key}.png`, sha256: digest(png), prompt: `prompts/${key}.txt`, promptSha256: digest(prompt) };
    variants.push(variant);
    await writeFile(join(business, variant.image), png);
    await writeFile(join(business, variant.prompt), prompt);
    const source = { ...preview, styleId: style.id, acceptedSourceId: 'business-layout-v1', sourceImage: variant.image, sourceImageSha256: variant.sha256, sourcePrompt: variant.prompt, sourcePromptSha256: variant.promptSha256 };
    provenance.previews.push(source);
    if (preview.level === 3 && preview.paletteId === 'mid') provenance.showcases.push({ ...source, path: style.showcase.path });
  }
  const manifest = { id: 'business-layout-v1', variants };
  const manifestText = JSON.stringify(manifest);
  await writeFile(join(business, 'manifest.json'), manifestText);
  provenance.businessSource = { id: 'business-layout-v1', manifest: 'manifest.json', manifestSha256: digest(manifestText) };
  provenance.businessRecipes = {
    tiers: styles.flatMap(style => style.tiers.map(tier => ({ styleId: style.id, level: tier.level, promptTemplateSha256: digest(tier.promptTemplate) }))),
    palettes: styles.flatMap(style => style.palettes.map(palette => ({ styleId: style.id, paletteId: palette.id, palettePromptSha256: digest(palette.prompt) }))),
  };
  // Preserve the ten-style manifest mapping; synthesize portable images and source prompts.
  // The seven prompts reverse the documented extraction to exercise the real extractor.
  await cp('tests/fixtures/accepted-style-source', accepted, { recursive: true });
  const acceptedManifest = JSON.parse(await readFile(join(accepted, 'manifest.json'), 'utf8'));
  await mkdir(join(accepted, 'images'), { recursive: true });
  for (const style of acceptedManifest.styles) {
    await writeFile(join(accepted, style.image), png);
    style.sha256 = digest(png);
  }
  for (let index = 0; index < acceptedManifest.styles.length; index += 1) {
    const manifestStyle = acceptedManifest.styles[index];
    const style = legacy[index];
    const recipe = provenance.recipes.find((candidate: any) => candidate.styleId === style.id);
    const prompt = recipe
      ? style.tiers[0].promptTemplate.trimEnd()
        .replace('中文 PPT 页面', '中文 PPT 广告展示页')
        .replace('的标题和副标题区', '的 SuperPPT 标题和副标题区')
        .replace('{{PALETTE}}', style.palettes[0].prompt)
        .replace('{{CONTENT_RELATIONSHIPS}}', 'fixture relationships')
        .replace('{{SLIDE_COPY}}', 'SuperPPT\n10 大精选模板') + '\n\n用途说明：fixture\n'
      : `Accepted source fixture: ${style.id}\n`;
    await writeFile(join(accepted, manifestStyle.prompt), prompt);
    for (const source of [...provenance.previews, ...provenance.showcases]) {
      if (source.acceptedSourceId === provenance.acceptedSource.id && source.styleId === style.id && source.sourcePrompt) source.sourcePromptSha256 = digest(prompt);
    }
    if (recipe) recipe.sourcePromptSha256 = digest(prompt);
  }
  const acceptedManifestText = JSON.stringify(acceptedManifest);
  await writeFile(join(accepted, 'manifest.json'), acceptedManifestText);
  provenance.acceptedSource.manifestSha256 = digest(acceptedManifestText);
  for (const source of [...provenance.previews, ...provenance.showcases]) {
    if (source.acceptedSourceId === provenance.acceptedSource.id) source.sourceImageSha256 = digest(png);
  }
  const remote = { version: 1, assets: Object.fromEntries(catalog.styles.flatMap((style: any) => [...style.previews, style.showcase]).map((asset: any) => [asset.path, { url: 'https://example.com/fixture.png', sha256: digest(png), width: 160, height: 90, bytes: png.length }])) };
  async function save() {
    await writeFile(join(assets, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    await writeFile(join(assets, 'provenance.json'), JSON.stringify(provenance));
    await writeFile(join(assets, 'remote-assets.json'), JSON.stringify(remote));
  }
  await save();
  async function build(args: string[] = []) {
    try {
      const result = await run(process.execPath, ['scripts/build-style-catalog.mjs', ...args], { cwd: root });
      return { code: 0, ...result };
    } catch (error: any) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string };
    }
  }
  return { root, assets, business, accepted, catalog, provenance, manifest, save, build };
}

test('business source validation checks independent manifests, prompt/image bytes and recipe coverage without writing images', async t => {
  const f = await fixture();
  try {
    const catalogPath = join(f.assets, 'catalog.json');
    const compactCatalog = JSON.stringify(f.catalog);
    await writeFile(catalogPath, compactCatalog);
    const clean = await f.build(['--business-source-dir', f.business]);
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(await readFile(catalogPath, 'utf8'), compactCatalog, 'Standalone source validation must preserve catalog bytes');
    assert.match(clean.stdout, /13 styles/);
    await assert.rejects(readFile(join(f.assets, 'previews/deep-sea-1-cool.jpg')), /ENOENT/);
    for (const [path, message] of [['manifest.json', /Business manifest changed/], ['prompts/deep-sea-1-cool.txt', /Business prompt changed/], ['images/deep-sea-1-cool.png', /Business image changed/]] as const) {
      await t.test(`rejects drift in ${path}`, async () => {
        const file = join(f.business, path), before = await readFile(file);
        await writeFile(file, Buffer.concat([before, Buffer.from('DRIFT')]));
        const result = await f.build(['--business-source-dir', f.business]);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, message);
        await writeFile(file, before);
      });
    }
    for (const [name, mutate, message] of [
      ['missing business recipe', () => f.provenance.businessRecipes.tiers.pop(), /Business tier recipe coverage/],
      ['duplicate business palette recipe', () => { f.provenance.businessRecipes.palettes[8] = f.provenance.businessRecipes.palettes[0]; }, /Business palette recipe coverage/],
      ['template drift', () => { f.catalog.styles[0].tiers[0].promptTemplate += '\nDRIFT'; }, /Business prompt template changed/],
      ['palette drift', () => { f.catalog.styles[0].palettes[0].prompt += ' DRIFT'; }, /Business palette prompt changed/],
      ['wrong business source', () => { f.provenance.previews.find((s: any) => s.styleId === 'deep-sea').acceptedSourceId = 'ten-style-showcase-v1'; }, /Business source id/],
      ['unknown business revision', () => { f.provenance.businessSource.id = 'business-layout-unverified'; }, /Unknown business source id/],
      ['wrong source variant', () => { f.provenance.previews.find((s: any) => s.styleId === 'deep-sea').sourceImage = 'images/deep-sea-2-cool.png'; }, /Business source image/],
      ['missing source prompt hash', () => { delete f.provenance.previews.find((s: any) => s.styleId === 'deep-sea').sourcePromptSha256; }, /Business source prompt hash/],
      ['altered seven-recipe contract', () => { f.provenance.recipes.pop(); }, /AssertionError/],
    ] as const) {
      await t.test(name, async () => {
        const before = JSON.stringify({ catalog: f.catalog, provenance: f.provenance });
        mutate(); await f.save();
        const result = await f.build();
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, message);
        const restored = JSON.parse(before);
        Object.assign(f.catalog, restored.catalog); Object.assign(f.provenance, restored.provenance);
        await f.save();
      });
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('business tier revision v2 retains manifest and source identity checks', async () => {
  const f = await fixture();
  try {
    f.manifest.id = 'business-layout-v2';
    const bytes = JSON.stringify(f.manifest);
    await writeFile(join(f.business, 'manifest.json'), bytes);
    f.provenance.businessSource = { id: f.manifest.id, manifest: 'manifest.json', manifestSha256: digest(bytes) };
    for (const source of [...f.provenance.previews, ...f.provenance.showcases]) {
      if (businessIds.includes(source.styleId)) source.acceptedSourceId = f.manifest.id;
    }
    await f.save();
    const valid = await f.build(['--business-source-dir', f.business]);
    assert.equal(valid.code, 0, valid.stderr);
    f.provenance.showcases.find((source: any) => source.styleId === 'celadon').acceptedSourceId = 'business-layout-v1';
    await f.save();
    const stale = await f.build(['--business-source-dir', f.business]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Business source id/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('accepted-source normalization processes only the original ten and retains seven-recipe extraction checks', async () => {
  const f = await fixture();
  try {
    const result = await f.build(['--normalize-previews', '--accepted-source-dir', f.accepted]);
    assert.equal(result.code, 0, result.stderr);
    for (const style of f.catalog.styles.slice(3)) {
      assert.equal((await sharp(join(f.assets, style.showcase.path)).metadata()).format, 'jpeg');
    }
    for (const style of f.catalog.styles.slice(0, 3)) {
      for (const asset of [...style.previews, style.showcase]) await assert.rejects(readFile(join(f.assets, asset.path)), /ENOENT/);
    }
    const recipe = f.provenance.recipes[0];
    recipe.sourcePrompt = 'prompts/tactile.txt';
    await f.save();
    const drift = await f.build(['--normalize-previews', '--accepted-source-dir', f.accepted]);
    assert.notEqual(drift.code, 0);
    assert.match(drift.stderr, /Recipe prompt mapping changed/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
