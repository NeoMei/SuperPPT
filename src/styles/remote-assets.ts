import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const AssetKey = z.string().regex(/^(previews|showcases)\/[a-z0-9-]+\.(jpg|jpeg|png)$/);
const ImageUrl = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, 'Remote images require HTTPS URLs without credentials or fragments');
const RemoteAsset = z.object({
  url: ImageUrl,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict().refine(asset => asset.width * 9 === asset.height * 16, 'Style images must be 16:9');
const Registry = z.object({ version: z.literal(1), assets: z.record(AssetKey, RemoteAsset) }).strict();
export type RemoteStyleAssets = z.infer<typeof Registry>['assets'];

// Planning remains local: this reads only metadata and never fetches image URLs.
export async function loadRemoteStyleAssets(root: string): Promise<RemoteStyleAssets> {
  let text: string;
  try {
    text = await readFile(join(root, 'remote-assets.json'), 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return Registry.parse(JSON.parse(text)).assets;
}
