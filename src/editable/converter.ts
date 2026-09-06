import { join } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { readRegularFileNoFollow } from '../project/safe-file.js';
import { hash, taskPath } from '../project/task-store.js';
import { readBoundedPptxArchiveFile } from '../deck-revisions/archive.js';
import { scanOoxmlRanges } from '../deck-revisions/ooxml.js';
import { EditableManifestV2Schema } from './schemas.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const Ledger = z.object({ ledgerVersion: z.literal(2), hashes: z.object({ sourceImage: z.string(), manifest: z.string(), pptx: z.string() }) });

// The independent converter owns generation. This adapter checks only the
// output we actually consume: current input, manifest and one editable donor.
export async function validateEditableConversionOutput(options: { sourcePng: string; outDir: string; converterVersion: string }) {
  const source = await readRegularFileNoFollow(options.sourcePng);
  const meta = await sharp(source).metadata();
  if (meta.width !== 1280 || meta.height !== 720) throw new Error('Converter input must be 1280x720');
  const manifestBytes = await readRegularFileNoFollow(join(options.outDir, 'manifest.json'), { maxBytes: 16 * 1024 * 1024 });
  const manifest = EditableManifestV2Schema.parse(JSON.parse(manifestBytes.toString()));
  const ledger = Ledger.parse(JSON.parse((await readRegularFileNoFollow(join(options.outDir, 'run-ledger.json'), { maxBytes: 16 * 1024 * 1024 })).toString()));
  const donorPptx = join(options.outDir, 'slide-editable.pptx');
  const donorBytes = await readRegularFileNoFollow(donorPptx);
  if (ledger.hashes.sourceImage !== hash(source) || ledger.hashes.manifest !== hash(manifestBytes) || ledger.hashes.pptx !== hash(donorBytes)) throw new Error('Converter result does not match the current input and output files');
  const zip = await readBoundedPptxArchiveFile(donorPptx);
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (slides.length !== 1) throw new Error('Converter must return one donor slide');
  const elements = scanOoxmlRanges(await zip.file(slides[0])!.async('string')).elements;
  const names = elements.filter(e => e.namespaceUri === P && e.localName === 'cNvPr').map(e => e.attributes.find(a => a.localName === 'name')?.value);
  for (const element of manifest.elements) {
    const name = element.kind === 'shape' ? `shape-${element.id}-${element.label}` : `${element.kind}-${element.id}`;
    if (names.filter(n => n === name).length !== 1) throw new Error('Donor is missing editable object: ' + name);
    if (element.kind === 'asset') {
      const asset = await readRegularFileNoFollow(await taskPath(options.outDir, element.assetPath));
      await sharp(asset).raw().toBuffer();
    }
  }
  if (manifest.elements.some(e => e.kind === 'text') && !elements.some(e => e.namespaceUri === A && e.localName === 't')) throw new Error('Donor text is not editable');
  return { manifest, donorPptx, outputRoot: options.outDir };
}
