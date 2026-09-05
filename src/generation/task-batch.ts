import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { readTask, readTaskJson, writeTaskJson, readArtifact, withTaskLock, hash, json, missing } from '../project/task-store.js';
import { preflightJob } from '../dependencies/task-dependencies.js';
import { StyleRecipeSchema } from '../styles/schemas.js';

export const FileRef = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const TaskStyleSchema = z.object({ recipe: StyleRecipeSchema, representativeSlideId: z.string().uuid(), approvalState: z.enum(['provisional', 'approved']), approvedSample: FileRef.nullable(), references: z.array(FileRef.extend({ role: z.enum(['art-direction', 'content-reference']) })).default([]), applyDependencyDefaultStyle: z.literal(false) });
export const BatchJobSchema = z.object({
  jobId: z.string().uuid(), contentRevision: z.string().uuid(), kind: z.enum(['style-sample', 'deck', 'page-regeneration']),
  styleLock: TaskStyleSchema, callBudget: z.number().int().nonnegative(),
  pages: z.array(z.object({ slideId: z.string().uuid(), prompt: z.string(), target: z.string(), cached: FileRef.nullable() })).min(1),
  createdAt: z.string(),
}).strict();
export type BatchJob = z.infer<typeof BatchJobSchema>;
export const PageResultSchema = z.object({ slideId: z.string().uuid(), status: z.enum(['success', 'cached', 'failed', 'paused']), artifact: FileRef.nullable(), raw: FileRef.nullable().default(null), provider: z.string().nullable(), channel: z.enum(['host', 'api']).nullable(), referencesUsed: z.array(z.string()).default([]) });
export const BatchResultSchema = z.object({ jobId: z.string().uuid(), outcome: z.enum(['success', 'partial', 'failed', 'attention']), requestCount: z.number().int().nonnegative(), pages: z.array(PageResultSchema), routeSummary: z.array(z.string()).default([]) }).strict();
export type BatchResult = z.infer<typeof BatchResultSchema>;
export const CheckpointSchema = z.object({ jobId: z.string().uuid(), requestCount: z.number().int().nonnegative(), inFlightSlideId: z.string().uuid().nullable(), completed: z.record(z.string(), FileRef), pages: z.record(z.string(), PageResultSchema).default({}) });
export type BatchCheckpoint = z.infer<typeof CheckpointSchema>;
export const jobPath = (id: string) => `generation/jobs/${z.string().uuid().parse(id)}`;
export async function readBatchJob(root: string, id: string): Promise<BatchJob> { return BatchJobSchema.parse(await readTaskJson(root, `${jobPath(id)}/job.json`)); }
export async function readBatchCheckpoint(root: string, id: string): Promise<BatchCheckpoint> { return CheckpointSchema.parse(await readTaskJson(root, `${jobPath(id)}/checkpoint.json`)); }
export const remainingCalls = (budget: number, cp: Pick<BatchCheckpoint, 'requestCount'>) => Math.max(0, budget - cp.requestCount);
export async function publishBatchJob(root: string, raw: BatchJob): Promise<string> {
  const job = BatchJobSchema.parse(raw), state = await readTask(root);
  if (state.contentRevision !== job.contentRevision) throw new Error('Job revision is stale');
  if (new Set(job.pages.map(p => p.slideId)).size !== job.pages.length) throw new Error('Duplicate page IDs');
  if (job.kind !== 'style-sample' && (job.styleLock.approvalState !== 'approved' || !job.styleLock.approvedSample)) throw new Error('Approved sample required');
  if (job.kind === 'style-sample' && (job.pages.length !== 1 || job.callBudget !== 1 || job.styleLock.approvalState !== 'provisional')) throw new Error('Sample authorizes exactly one call');
  if (job.callBudget < job.pages.filter(p => !p.cached).length) throw new Error('Budget is smaller than pending page count');
  for (const p of job.pages) if (p.target !== `${jobPath(job.jobId)}/images/${p.slideId}.png`) throw new Error('Job output path is invalid');
  const path = `${jobPath(job.jobId)}/job.json`;
  try { const old = await readTaskJson(root, path); if (hash(json(old)) !== hash(json(job))) throw new Error('Published job cannot change'); return path; }
  catch (e) { if (!missing(e)) throw e; }
  await preflightJob(root, job.jobId);
  for (const ref of job.styleLock.references) {
    const bytes = await readArtifact(root, ref.path, 50 * 1024 * 1024);
    if (hash(bytes) !== ref.sha256) throw new Error('Reference image changed');
    await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
  }
  for (const page of job.pages) if (page.cached) await validateImage(root, page.cached);
  await writeTaskJson(root, `${jobPath(job.jobId)}/checkpoint.json`, { jobId: job.jobId, requestCount: 0, inFlightSlideId: null, completed: Object.fromEntries(job.pages.filter(p => p.cached).map(p => [p.slideId, p.cached])), pages: {} });
  await writeTaskJson(root, path, job);
  return path;
}
export async function validateImage(root: string, ref: z.infer<typeof FileRef>): Promise<void> {
  const bytes = await readArtifact(root, ref.path, 50 * 1024 * 1024);
  if (hash(bytes) !== ref.sha256) throw new Error('Image digest mismatch');
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: 64 * 1024 * 1024 });
  const meta = await image.metadata();
  if (!meta.width || !meta.height || meta.width * 9 !== meta.height * 16) throw new Error('Image must be strict 16:9');
  await image.raw().toBuffer();
}
// Ordinary progress bookkeeping. Called inside the Agent's batch, not as public CLI routes.
export async function beginRequest(root: string, jobId: string, slideId: string): Promise<void> {
  await withTaskLock(root, async () => {
    const job = await readBatchJob(root, jobId), cp = await readBatchCheckpoint(root, jobId), s = await readTask(root);
    if (s.activeJobId !== jobId || s.contentRevision !== job.contentRevision) throw new Error('Job is not active');
    if (cp.inFlightSlideId) throw new Error('Previous request result is unknown; resolve it before another paid request');
    if (cp.completed[slideId]) throw new Error('Successful page must not be generated again');
    if (job.pages.find(p => !cp.completed[p.slideId])?.slideId !== slideId) throw new Error('Generate pages in job order');
    if (!remainingCalls(job.callBudget, cp)) throw new Error('Call budget exhausted');
    cp.requestCount++; cp.inFlightSlideId = slideId;
    await writeTaskJson(root, `${jobPath(jobId)}/checkpoint.json`, cp);
  });
}
export async function finishRequest(root: string, jobId: string, raw: z.input<typeof PageResultSchema>): Promise<void> {
  await withTaskLock(root, async () => {
    const page = PageResultSchema.parse(raw), job = await readBatchJob(root, jobId), cp = await readBatchCheckpoint(root, jobId);
    const target = job.pages.find(p => p.slideId === page.slideId);
    if (!target || cp.inFlightSlideId !== page.slideId) throw new Error('No matching in-flight request');
    if (page.status === 'success') {
      if (!page.artifact || page.artifact.path !== target.target) throw new Error('Wrong output for page');
      await validateImage(root, page.artifact); cp.completed[page.slideId] = page.artifact;
    } else if (page.status === 'cached') throw new Error('A paid request cannot be cached');
    cp.pages[page.slideId] = page; cp.inFlightSlideId = null;
    await writeTaskJson(root, `${jobPath(jobId)}/checkpoint.json`, cp);
  });
}
export async function acceptBatchResult(root: string, raw: unknown): Promise<BatchResult> {
  return withTaskLock(root, async () => {
    const result = BatchResultSchema.parse(raw), s = await readTask(root), job = await readBatchJob(root, result.jobId);
    if (s.activeJobId !== job.jobId || s.contentRevision !== job.contentRevision) throw new Error('Result belongs to an inactive job');
    const cp = await readBatchCheckpoint(root, job.jobId);
    if (cp.inFlightSlideId) throw new Error('Request result unknown; complete its checkpoint first');
    if (result.requestCount !== cp.requestCount || result.requestCount > job.callBudget) throw new Error('Incorrect call count or exceeded budget');
    if (result.pages.length !== job.pages.length || new Set(result.pages.map(p => p.slideId)).size !== job.pages.length) throw new Error('Result must include every page exactly once');
    for (const page of result.pages) {
      const expected = job.pages.find(p => p.slideId === page.slideId);
      if (!expected) throw new Error('Unknown result page');
      if (page.status === 'success' || page.status === 'cached') {
        const file = cp.completed[page.slideId];
        if (!page.artifact || !file || json(file) !== json(page.artifact)) throw new Error('Result changed a completed page');
        if (page.status === 'cached' && !expected.cached && !cp.pages[page.slideId]) throw new Error('No saved result for cached page');
        if (cp.pages[page.slideId] && (page.channel !== cp.pages[page.slideId].channel || page.provider !== cp.pages[page.slideId].provider || json(page.raw) !== json(cp.pages[page.slideId].raw))) throw new Error('Result routing differs from its checkpoint');
        await validateImage(root, file);
        if (page.channel === 'host') { if (!page.raw) throw new Error('Host raw image missing'); const bytes = await readArtifact(root, page.raw.path); if (hash(bytes) !== page.raw.sha256) throw new Error('Raw image digest mismatch'); }
        if (!expected.cached) for (const reference of job.styleLock.references.filter(r => r.role === 'art-direction')) if (!page.referencesUsed.includes(reference.sha256)) throw new Error('Required art-direction reference was not used');
      } else if (cp.completed[page.slideId]) throw new Error('Completed page cannot become failed');
    }
    if (result.outcome === 'success' && result.pages.some(p => p.status !== 'success' && p.status !== 'cached')) throw new Error('Incomplete successful batch');
    await writeTaskJson(root, `${jobPath(job.jobId)}/result.json`, result);
    return result;
  });
}
export function newJobId(): string { return randomUUID(); }
