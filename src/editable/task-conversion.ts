import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { readTask, readTaskJson, writeTaskJson, taskPath, atomicWrite, updateTask } from '../project/task-store.js';
import { TaskDependenciesSchema } from '../dependencies/task-dependencies.js';
import { readTaskSession, readTaskRevision, presentTaskEdit } from '../deck-revisions/task-deck.js';
import { readBoundedPptxArchiveFile } from '../deck-revisions/archive.js';
import { scanOoxmlRanges } from '../deck-revisions/ooxml.js';
import { spliceTaskSlide } from '../deck-revisions/task-splice.js';
import { validateEditableConversionOutput } from './converter.js';

export async function prepareTaskConversion(root: string): Promise<void> {
  const s = await readTask(root), session = await readTaskSession(root), parent = await readTaskRevision(root, session.parent.revisionId);
  const target = parent.topology.entries.find(e => e.stableSlideId === session.targetSlideId)!;
  const zip = await readBoundedPptxArchiveFile(await taskPath(root, session.candidatePath));
  const xml = await zip.file(target.slidePart)!.async('string');
  const elements = scanOoxmlRanges(xml).elements;
  const blips = elements.filter(e => e.localName === 'blip' && e.namespaceUri === 'http://schemas.openxmlformats.org/drawingml/2006/main');
  if (blips.length !== 1) throw new Error('Page is not a single image; edit its existing objects instead');
  const embed = blips[0].attributes.find(a => a.localName === 'embed')!.value;
  const rels = await zip.file(`ppt/slides/_rels/${posix.basename(target.slidePart)}.rels`)!.async('string');
  const relationship = scanOoxmlRanges(rels).elements.find(e => e.attributes.some(a => a.localName === 'Id' && a.value === embed));
  const targetName = relationship?.attributes.find(a => a.localName === 'Target')?.value;
  if (!targetName || relationship?.attributes.some(a => a.localName === 'TargetMode' && a.value === 'External')) throw new Error('Page image is not embedded');
  const image = await zip.file(posix.normalize(posix.join('ppt/slides', targetName)))?.async('nodebuffer');
  if (!image) throw new Error('Page image missing');
  const sourcePng = `editing/${session.id}/input.png`, outDir = `editing/${session.id}/converter-output`;
  await atomicWrite(await taskPath(root, sourcePng), await sharp(image).resize(1280, 720).png().toBuffer());
  const deps = TaskDependenciesSchema.parse(await readTaskJson(root, s.dependenciesPath!));
  const inputPath = `editing/${session.id}/conversion-request.json`;
  await writeTaskJson(root, inputPath, { sourcePng, outDir, converterRoot: deps.editable.root, converterSkill: deps.editable.skill, instructions: 'Invoke image-to-editable-pptx for this one page; return outDir. Preserve master and current PPTX.' });
  await updateTask(root, old => ({ ...old, work: { id: session.id, kind: 'convert-page', inputPath, resultPath: `editing/${session.id}/conversion-result.json` } }));
}
export async function finishTaskConversion(root: string, raw: unknown): Promise<void> {
  const payload = z.object({ outDir: z.string() }).strict().parse(raw);
  const s = await readTask(root), session = await readTaskSession(root);
  const expected = `editing/${session.id}/converter-output`;
  if (payload.outDir !== expected) throw new Error('Unexpected converter output');
  const deps = TaskDependenciesSchema.parse(await readTaskJson(root, s.dependenciesPath!));
  const converted = await validateEditableConversionOutput({ sourcePng: await taskPath(root, `editing/${session.id}/input.png`), outDir: await taskPath(root, expected), converterVersion: deps.editable.version! });
  const parent = await readTaskRevision(root, session.parent.revisionId), entry = parent.topology.entries.find(e => e.stableSlideId === session.targetSlideId)!;
  // Retrying an interrupted import always starts from its unchanged parent.
  await copyFile(await taskPath(root, session.parent.relativePath), await taskPath(root, session.candidatePath));
  await spliceTaskSlide(await taskPath(root, session.candidatePath), entry.slidePart, converted.donorPptx);
  await writeTaskJson(root, s.editSessionPath!, { ...session, editableSlideIds: [...new Set([...session.editableSlideIds, session.targetSlideId])], reviewRequiredObjects: converted.manifest.elements.filter(e => e.kind === 'asset' && e.reviewRequired).map(e => e.id) });
  if (session.mode === 'manual') await presentTaskEdit(root);
  else await updateTask(root, old => ({ ...old, work: { id: randomUUID(), kind: 'edit-deck', inputPath: s.editSessionPath!, resultPath: `editing/${session.id}/edited-result.json` } }));
}
