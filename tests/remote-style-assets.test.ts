import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStyleCatalog } from '../src/styles/catalog.js';
import { styleSelection } from '../src/styles/selection.js';
import { writeStyleSelectionView } from '../src/styles/selection-view.js';

const fixture = {
  catalogVersion: 2, selectionMode: 'single', styles: [{
    id: 'example', name: '示例',
    tiers: [{ level: 3, promptTemplate: '{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' }],
    palettes: [{ id: 'mid', name: '中性', prompt: 'neutral' }],
    previews: [{ level: 3, paletteId: 'mid', path: 'previews/example-3-mid.jpg' }],
    showcase: { level: 3, paletteId: 'mid', path: 'showcases/example.jpg' },
  }],
};
const entry = { url: 'https://assets.example.test/example.png?size=large&format=png',
  sha256: 'a'.repeat(64), bytes: 1200, width: 1664, height: 936 };
const registry = (url = entry.url) => ({ version: 1, assets: {
  'previews/example-3-mid.jpg': { ...entry, url },
  'showcases/example.jpg': { ...entry, url },
} });

// Missing packaged images must not prevent planning when the remote index covers them.
test('remote-only catalog loads offline and renders HTTPS previews without embedding image bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-remote-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'catalog.json'), JSON.stringify(fixture));
  await writeFile(join(root, 'remote-assets.json'), JSON.stringify(registry()));
  const catalog = await loadStyleCatalog(join(root, 'catalog.json'));
  const page = await writeStyleSelectionView(root, 'selection.html', {
    title: '用户内容', purpose: '本地规划', audience: '团队', selection: styleSelection(catalog.styles),
  }, root);
  const result = await readFile(join(root, page), 'utf8');
  assert.equal((result.match(/src="https:\/\/assets\.example\.test\/example\.png\?size=large&amp;format=png"/g) ?? []).length, 2);
  assert.doesNotMatch(result, /data:image/);
  assert.match(result, /referrerpolicy="no-referrer"/);
  assert.match(result, /图片加载失败/);
  assert.match(result, /从图床加载公开的风格图片/);
  assert.doesNotMatch(result, /选择本身不会发送请求/);
  assert.match(result, /data-selectable="true"/);
  assert.ok(result.length < 25_000);
});

// A partial index must not silently label an unavailable file as a usable image.
test('remote index cannot conceal an uncovered missing showcase', async t => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-remote-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'catalog.json'), JSON.stringify(fixture));
  await writeFile(join(root, 'remote-assets.json'), JSON.stringify({ version: 1, assets: {
    'previews/example-3-mid.jpg': entry,
  } }));
  await assert.rejects(() => loadStyleCatalog(join(root, 'catalog.json')), /ENOENT/);
});

// A remote index is not permission to emit scripts, credentials or plaintext URLs.
test('remote image registry rejects unsafe URLs and malformed integrity metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-remote-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'catalog.json'), JSON.stringify(fixture));
  for (const bad of [
    registry('javascript:alert(1)'), registry('http://assets.example.test/image.png'),
    registry('https://user:password@assets.example.test/image.png'),
    { version: 1, assets: { 'showcases/example.jpg': { ...entry, sha256: 'invalid' } } },
  ]) {
    await writeFile(join(root, 'remote-assets.json'), JSON.stringify(bad));
    await assert.rejects(() => loadStyleCatalog(join(root, 'catalog.json')), error =>
      (error as NodeJS.ErrnoException).code !== 'ENOENT');
  }
});
