import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, readFile, lstat, unlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { createPresentation } from '../deck/pptx.js';
import { readTask, updateTask, readTaskJson, writeTaskJson, taskPath, readArtifact, hash, missing, withTaskLock, atomicWrite, taskTransaction } from '../project/task-store.js';
import { DeckRefSchema, type DeckRef } from '../project/task-schema.js';
import { readBatchJob, BatchResultSchema, jobPath } from '../generation/task-batch.js';
import { PlanBundleSchema, type EditRequest, type WorkflowReply } from '../workflow/contracts.js';
import { inspectLocalPptx } from './task-inspect.js';
import { publishInitialSlideIdentities } from './task-identity.js';
import { reconcileSlideTopology } from './topology.js';
import { SlideTopologySchema } from './schemas.js';
import { spliceTaskSlide } from './task-splice.js';
import { readBoundedPptxArchiveFile } from './archive.js';

const RevisionSchema = DeckRefSchema.extend({ parent: DeckRefSchema.nullable(), topology: SlideTopologySchema, editableSlideIds: z.array(z.string()) });
const SessionSchema = z.object({ id: z.string().uuid(), revisionId: z.string().uuid(), parent: DeckRefSchema, candidatePath: z.string(), targetSlideId: z.string(), mode: z.enum(['manual', 'agent']), route: z.string(), instruction: z.string(), presentedSha256: z.string().nullable(), editableSlideIds: z.array(z.string()), reviewRequiredObjects: z.array(z.string()).default([]) });
export type TaskEditSession = z.infer<typeof SessionSchema>;
export async function readTaskRevision(root: string, revisionId: string) { return RevisionSchema.parse(await readTaskJson(root, `output/deck-revisions/${z.string().uuid().parse(revisionId)}/revision.json`)); }
export const deckLink = (root: string, deck: DeckRef) => `[${basename(deck.relativePath)}](<${join(root, deck.relativePath)}>)`;
async function publishRevision(root: string, id: string, parent: DeckRef | null, topology: z.infer<typeof SlideTopologySchema>, editableSlideIds: string[]): Promise<DeckRef> {
  const relativePath = `output/deck-revisions/${id}/deck.pptx`, bytes = await readArtifact(root, relativePath, 256 * 1024 * 1024);
  const ref = { revisionId: id, relativePath, sha256: hash(bytes) };
  await writeTaskJson(root, `output/deck-revisions/${id}/revision.json`, { ...ref, parent, topology, editableSlideIds });
  return ref;
}
export async function assembleTaskDeck(root: string): Promise<DeckRef> {
  const state = await readTask(root), job = await readBatchJob(root, state.activeJobId!);
  const result = BatchResultSchema.parse(await readTaskJson(root, `${jobPath(job.jobId)}/result.json`));
  if (result.outcome !== 'success') throw new Error('Cannot assemble an incomplete batch');
  const id = job.jobId, relativePath = `output/deck-revisions/${id}/deck.pptx`, path = await taskPath(root, relativePath);
  const plan = PlanBundleSchema.parse(await readTaskJson(root, state.planPath!));
  await mkdir(dirname(path), { recursive: true });
  {
    if (job.kind === 'page-regeneration') {
      if (!state.currentDeck) throw new Error('Current complete deck missing');
      await copyFile(await taskPath(root, state.currentDeck.relativePath), path);
      const parent = await readTaskRevision(root, state.currentDeck.revisionId);
      const entry = parent.topology.entries.find(e => e.stableSlideId === job.pages[0].slideId);
      if (!entry) throw new Error('Regeneration target is no longer present');
      const donor = join(dirname(path), `donor-${randomUUID()}.pptx`);
      const image = await readArtifact(root, result.pages[0].artifact!.path);
      await createPresentation([{ id: entry.stableSlideId, bytes: await sharp(image).png().toBuffer(), contentType: 'image/png' }], donor, root);
      await spliceTaskSlide(path, entry.slidePart, donor);
      await unlink(donor);
    } else {
      const pages = await Promise.all(plan.outline.slides.map(async slide => {
        const image = result.pages.find(p => p.slideId === slide.id)?.artifact;
        if (!image) throw new Error('Missing completed page');
        return { id: slide.id, bytes: await sharp(await readArtifact(root, image.path)).resize(1920, 1080).png().toBuffer(), contentType: 'image/png' as const };
      }));
      const staged = join(dirname(path), `assembled-${randomUUID()}.pptx`);
      await createPresentation(pages, staged, root);
      await atomicWrite(path, await readFile(staged));
      await unlink(staged);
    }
  }
  let topology;
  if (job.kind === 'page-regeneration') {
    const old = await readTaskRevision(root, state.currentDeck!.revisionId), next = reconcileSlideTopology(old.topology, await inspectLocalPptx(path));
    if (next.conflicts.length) throw new Error(next.conflicts.join('; ')); topology = next.topology;
  } else topology = await publishInitialSlideIdentities(path, plan.outline.slides.map(p => ({ stableSlideId: p.id, position: p.order })));
  const editableSlideIds = job.kind === 'page-regeneration' ? (await readTaskRevision(root, state.currentDeck!.revisionId)).editableSlideIds.filter(slideId => slideId !== job.pages[0].slideId) : [];
  const ref = await publishRevision(root, id, state.currentDeck, topology, editableSlideIds);
  if (job.kind === 'page-regeneration') {
    const sessionPath = `editing/${id}.json`;
    await writeTaskJson(root, sessionPath, { id, revisionId: id, parent: state.currentDeck, candidatePath: relativePath, targetSlideId: job.pages[0].slideId, mode: 'agent', route: 'regenerate-slide', instruction: '', presentedSha256: ref.sha256, editableSlideIds, reviewRequiredObjects: [] });
    await updateTask(root, s => ({ ...s, editSessionPath: sessionPath, stage: 'deck-review', work: null, pendingDecision: { id: randomUUID(), kind: 'edit-review' } }));
  } else await updateTask(root, s => ({ ...s, currentDeck: ref, stage: 'deck-review', work: null, delivery: null, pendingDecision: { id: randomUUID(), kind: 'deck-review' } }));
  return ref;
}
export async function readTaskSession(root: string): Promise<TaskEditSession> {
  const s = await readTask(root); if (!s.editSessionPath) throw new Error('No edit session');
  return SessionSchema.parse(await readTaskJson(root, s.editSessionPath));
}
export async function editTask(root: string, request: EditRequest): Promise<WorkflowReply> {
  return taskTransaction(root, async () => {
    const s = await readTask(root);
    if (!s.currentDeck || !['deck-review', 'delivered'].includes(s.stage)) throw new Error('Open the complete deck before editing');
    if (s.editSessionPath) throw new Error('Finish or reject the current edit before starting another');
    if (request.route === 'regenerate-slide') throw new Error('Regeneration needs a disclosed call budget: use decide with regenerate-page at deck review');
    const parent = await readTaskRevision(root, s.currentDeck.revisionId), entry = parent.topology.entries[request.pageNumber - 1];
    if (!entry) throw new Error('Page number is outside the current deck');
    const actual = await inspectLocalPptx(await taskPath(root, s.currentDeck.relativePath));
    if (actual.sha256 !== s.currentDeck.sha256) throw new Error('Current file changed; use the prepared editing copy');
    const id = randomUUID(), candidatePath = `output/deck-revisions/${id}/deck.pptx`;
    await mkdir(dirname(await taskPath(root, candidatePath)), { recursive: true });
    await copyFile(await taskPath(root, s.currentDeck.relativePath), await taskPath(root, candidatePath));
    const session: TaskEditSession = { id, revisionId: id, parent: s.currentDeck, candidatePath, targetSlideId: entry.stableSlideId, mode: request.mode, route: request.route, instruction: request.instruction, presentedSha256: request.mode === 'manual' ? actual.sha256 : null, editableSlideIds: parent.editableSlideIds, reviewRequiredObjects: [] };
    const sessionPath = `editing/${id}.json`;
    await writeTaskJson(root, sessionPath, session);
    const kind = request.route === 'activate-editable' ? 'convert-page' : 'edit-deck';
    const work = request.mode === 'agent' || request.route === 'activate-editable' ? { id, kind: kind as 'convert-page' | 'edit-deck', inputPath: sessionPath, resultPath: `editing/${id}-result.json` } : null;
    const next = await updateTask(root, old => ({ ...old, stage: 'deck-review', editSessionPath: sessionPath, work, delivery: null, pendingDecision: work ? null : { id: randomUUID(), kind: 'edit-review' } }));
    if (work?.kind === 'convert-page') {
      const { prepareTaskConversion } = await import('../editable/task-conversion.js');
      await prepareTaskConversion(root);
      return { kind: 'work', work: (await readTask(root)).work! };
    }
    return work ? { kind: 'work', work } : { kind: 'decision', id: next.pendingDecision!.id, stage: 'edit-review', view: `${deckLink(root, { ...s.currentDeck, relativePath: candidatePath })}\n在 WPS/PowerPoint 编辑，保存并关闭后回复“已保存并关闭”。` };
  });
}
export async function presentTaskEdit(root: string): Promise<void> {
  const s = await readTask(root), session = await readTaskSession(root), info = await inspectLocalPptx(await taskPath(root, session.candidatePath));
  const parent = await readTaskRevision(root, session.parent.revisionId);
  if (session.mode === 'agent') {
    const prior = await inspectLocalPptx(await taskPath(root, session.parent.relativePath));
    if (info.slideCount !== prior.slideCount) throw new Error('Agent edit changed page count');
    for (const [i, slide] of prior.slides.entries()) {
      if (parent.topology.entries[i].stableSlideId !== session.targetSlideId && (slide.xmlSha256 !== info.slides[i].xmlSha256 || slide.relationshipsSha256 !== info.slides[i].relationshipsSha256)) throw new Error('Agent edit changed an unrelated slide');
    }
    const beforeZip = await readBoundedPptxArchiveFile(prior.absolutePath), afterZip = await readBoundedPptxArchiveFile(info.absolutePath);
    // Existing shared assets must stay unchanged; target replacements use new media.
    for (const name of Object.keys(beforeZip.files).filter(n => n.startsWith('ppt/media/') && !beforeZip.files[n].dir)) {
      const after = await afterZip.file(name)?.async('nodebuffer');
      if (!after || hash(after) !== hash(await beforeZip.file(name)!.async('nodebuffer'))) throw new Error('Agent edit changed existing shared media; add target-specific media instead');
    }
  }
  await writeTaskJson(root, s.editSessionPath!, { ...session, presentedSha256: info.sha256 });
  await updateTask(root, old => ({ ...old, work: null, pendingDecision: { id: randomUUID(), kind: 'edit-review' } }));
}
export async function adoptTaskDeck(root: string, signal: 'saved-and-closed' | { confirmedSha256: string }): Promise<DeckRef> {
  return withTaskLock(root, async () => {
    const s = await readTask(root), session = await readTaskSession(root);
    if (s.currentDeck?.revisionId !== session.parent.revisionId) throw new Error('Edit parent is stale');
    if (session.mode === 'manual' ? signal !== 'saved-and-closed' : typeof signal !== 'object' || signal.confirmedSha256 !== session.presentedSha256) throw new Error('The edit has not been confirmed');
    const info = await inspectLocalPptx(await taskPath(root, session.candidatePath));
    if (session.mode === 'agent' && info.sha256 !== session.presentedSha256) throw new Error('Candidate changed after presentation');
    const parent = await readTaskRevision(root, session.parent.revisionId), next = reconcileSlideTopology(parent.topology, info);
    if (next.conflicts.length) throw new Error(next.conflicts.join('; '));
    const ref = await publishRevision(root, session.revisionId, session.parent, next.topology, session.editableSlideIds.filter(id => next.topology.entries.some(e => e.stableSlideId === id)));
    await updateTask(root, old => ({ ...old, currentDeck: ref, editSessionPath: null, work: null, delivery: null, stage: 'deck-review', pendingDecision: { id: randomUUID(), kind: 'deck-review' } }));
    return ref;
  });
}
export async function deliverTaskDeck(root: string): Promise<DeckRef> {
  const s = await readTask(root);
  if (!s.currentDeck || s.editSessionPath || s.stage !== 'deck-review') throw new Error('Complete deck review required');
  const bytes = await readArtifact(root, s.currentDeck.relativePath, 256 * 1024 * 1024);
  if (hash(bytes) !== s.currentDeck.sha256) throw new Error('Current PPTX changed');
  const title = s.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || '演示文稿';
  let path = `交付/${title}.pptx`;
  await mkdir(await taskPath(root, '交付'), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const old = await readArtifact(root, path); if (hash(old) === s.currentDeck.sha256) break; if (attempt) throw new Error('Delivery name already belongs to another file'); path = `交付/${title}-${s.currentDeck.sha256.slice(0, 12)}.pptx`; }
    catch (e) { if (!missing(e)) throw e; await atomicWrite(await taskPath(root, path), bytes); break; }
  }
  const ref = { ...s.currentDeck, relativePath: path };
  await updateTask(root, old => ({ ...old, stage: 'delivered', pendingDecision: null, delivery: { ...ref, confirmedAt: new Date().toISOString() } }));
  return ref;
}
