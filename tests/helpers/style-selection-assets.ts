import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StyleRecipe } from '../../src/styles/schemas.js';
import { loadRemoteStyleAssets } from '../../src/styles/remote-assets.js';

// Compare the rendered image sources to the catalog assets, including local business JPEGs.
// Hash the URLs to keep failures from dumping megabytes of base64 into test output.
export async function assertSelectionAssets(html: string, styles: StyleRecipe[], root: string) {
  const remote = await loadRemoteStyleAssets(root);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const expected = [];
  for (const style of styles) for (const asset of [...style.previews, ...(style.showcase ? [style.showcase] : [])]) {
    const entry = remote[asset.path];
    if (entry) expected.push(digest(entry.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')));
    else {
      assert.ok(['deep-sea', 'celadon', 'dashboard'].includes(style.id), 'Legacy assets must remain remote');
      const bytes = await readFile(join(root, asset.path));
      assert.ok(bytes.length <= 500_000, asset.path);
      expected.push(digest(`data:image/jpeg;base64,${bytes.toString('base64')}`));
    }
  }
  const actual = [...html.matchAll(/<img src="([^"]+)"/g)].map(match => digest(match[1]!));
  assert.deepEqual(actual.sort(), expected.sort(), 'Every preview and showcase must use its exact catalog asset');
}
