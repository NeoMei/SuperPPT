import { z } from 'zod';
import sharp from 'sharp';
import { builtInStyleAssetsRoot, loadBuiltInStyleCatalog } from '../styles/catalog.js';
import { loadRemoteStyleAssets } from '../styles/remote-assets.js';
import type { StyleRecipe, VariantSelection } from '../styles/schemas.js';
import type { BatchJob } from './task-batch.js';
import { atomicWrite, hash, readArtifact, taskPath } from '../project/task-store.js';

export const CatalogReferenceSchema = z.object({
  path: z.string().regex(/^previews\/[a-z0-9-]+\.(jpg|jpeg|png)$/),
  url: z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(10 * 1024 * 1024),
  width: z.number().int().positive(), height: z.number().int().positive(),
}).strict();
export type GenerationReference = { path: string; sha256: string; role: 'art-direction' | 'content-reference'; url?: string; bytes?: number; width?: number; height?: number };
export const referenceDirection = '画风参考图仅用于视觉风格：保持所选风格的材质、平面或立体表现、光影、配色比例与字体质感。不要复制画风参考图中的文字、标志、对象数量或布局；本页全部文字和内容关系以本页提示词为准。';

// Only exact built-in recipes may inherit the public catalogue reference.
export async function selectedCatalogReference(style: StyleRecipe, selection: VariantSelection) {
  const builtIn = (await loadBuiltInStyleCatalog()).styles.find(s => s.id === style.id);
  if (!builtIn || JSON.stringify(builtIn) !== JSON.stringify(style)) return undefined;
  const preview = style.previews.find(p => p.level === selection.level && p.paletteId === selection.paletteId);
  if (!preview) return undefined;
  const asset = (await loadRemoteStyleAssets(builtInStyleAssetsRoot()))[preview.path];
  return asset ? CatalogReferenceSchema.parse({ path: preview.path, ...asset }) : undefined;
}
export function generationReferences(job: BatchJob): GenerationReference[] {
  const lock = job.styleLock;
  const anchor: GenerationReference[] = lock.referencePolicy === 'required'
    ? lock.approvedSample ? [{ ...lock.approvedSample, role: 'art-direction' }]
      : lock.catalogReference ? [{ ...lock.catalogReference, role: 'art-direction' }] : []
    : [];
  const refs = [...anchor, ...lock.references];
  return refs.filter((r, i) => refs.findIndex(other => other.sha256 === r.sha256 && other.role === r.role) === i);
}
export function assertReferencesUsed(job: BatchJob, used: string[]) {
  for (const ref of generationReferences(job).filter(r => r.role === 'art-direction'))
    if (!used.includes(ref.sha256)) throw new Error('Required art-direction reference was not used');
}

// Run before beginRequest: failed downloads/validation must not spend generation budget.
// Remote catalogue files become immutable verified task-local inputs; the selection UI still uses HTTPS.
export async function prepareGenerationReferences(root: string, job: BatchJob, fetchImage: typeof fetch = fetch) {
  const prepared: Array<GenerationReference & { absolutePath: string }> = [];
  const references = generationReferences(job);
  if (references.length > 10) throw new Error('Too many reference images');
  let totalBytes = 0;
  for (const ref of references) {
    const path = ref.url ? `generation/references/${ref.sha256}.${ref.path.split('.').pop()}` : ref.path;
    let bytes: Buffer;
    try { bytes = await readArtifact(root, path, 10 * 1024 * 1024); }
    catch (error) {
      if (!ref.url || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const response = await fetchImage(ref.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new Error('Style reference download failed');
      const chunks: Uint8Array[] = []; let count = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          count += value.length;
          if (count > ref.bytes!) throw new Error('Style reference exceeds registered size');
          chunks.push(value);
        }
      } catch (error) { await reader.cancel(); throw error; }
      finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks);
    }
    if (hash(bytes) !== ref.sha256 || (ref.bytes !== undefined && bytes.length !== ref.bytes)) throw new Error('Reference image digest mismatch');
    totalBytes += bytes.length;
    if (totalBytes > 30 * 1024 * 1024) throw new Error('Reference images exceed total byte limit');
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 36_000_000 });
    const meta = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height || Math.min(meta.width, meta.height) < 15 || (meta.pages ?? 1) !== 1 || meta.width / meta.height < 1 / 16 || meta.width / meta.height > 16) throw new Error('Unsupported reference image');
    if (ref.width && (meta.width !== ref.width || meta.height !== ref.height)) throw new Error('Style reference dimensions changed');
    await image.raw().toBuffer();
    const absolutePath = await taskPath(root, path);
    if (ref.url) await atomicWrite(absolutePath, bytes);
    prepared.push({ ...ref, path, absolutePath });
  }
  return prepared;
}
