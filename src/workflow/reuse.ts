import { readTask, readTaskJson, missing, json } from '../project/task-store.js';
import { readBatchJob, readBatchCheckpoint, validateImage, BatchResultSchema, jobPath, type BatchJob } from '../generation/task-batch.js';
import { PlanBundleSchema, type PlanBundle } from './contracts.js';
import { z } from 'zod';
import { generationReferences } from '../generation/style-reference.js';

const HistoricalQaSchema = z.object({ pages: z.array(z.object({
  slideId: z.string(), sha256: z.string(),
  requiredText: z.array(z.object({ text: z.string(), present: z.boolean() })),
  styleConsistent: z.boolean(), hierarchyClear: z.boolean(), forbiddenContentAbsent: z.boolean(),
})) });

export class SampleReferenceEvidenceError extends Error {
  constructor() { super('样页参考图使用证据不足，请使用 revise-plan 重新生成样页并重新确认。'); }
}

// Cached results may point through several revisions. Authenticate the job
// that actually wrote the image, including its recorded reference usage.
async function sourceVerified(root: string, job: BatchJob, slideId: string, ref: { path: string; sha256: string }, prompt: string): Promise<boolean> {
  const match = /^generation\/jobs\/([0-9a-f-]{36})\/images\/([0-9a-f-]{36})\.png$/i.exec(ref.path);
  if (!match || match[2] !== slideId) return false;
  try {
    const source = await readBatchJob(root, match[1]!);
    const sourceCheckpoint = await readBatchCheckpoint(root, source.jobId);
    const sourceResult = BatchResultSchema.parse(await readTaskJson(root, `${jobPath(source.jobId)}/result.json`));
    const sourcePage = source.pages.find(page => page.slideId === slideId);
    const recorded = sourceCheckpoint.pages[slideId];
    const results = sourceResult.pages.filter(page => page.slideId === slideId);
    if (source.jobId !== match[1] || sourceCheckpoint.jobId !== source.jobId || sourceResult.jobId !== source.jobId
      || sourcePage?.target !== ref.path || sourcePage.prompt !== prompt || sourcePage.cached
      || json(sourceCheckpoint.completed[slideId]) !== json(ref) || recorded?.status !== 'success'
      || json(recorded.artifact) !== json(ref) || results.length !== 1 || results[0]!.status !== 'success'
      || json(results[0]!.artifact) !== json(ref) || json(results[0]!.referencesUsed) !== json(recorded.referencesUsed)
      || json(source.styleLock.recipe) !== json(job.styleLock.recipe)
      || json(source.generationIntent) !== json(job.generationIntent)
      || json(source.styleLock.references) !== json(job.styleLock.references)
      || (source.kind !== 'style-sample' && json(source.styleLock.approvedSample) !== json(job.styleLock.approvedSample))
      || source.styleLock.referencePolicy !== job.styleLock.referencePolicy
      || json(source.styleLock.catalogReference ?? null) !== json(job.styleLock.catalogReference ?? null)) return false;
    return generationReferences(source).every(reference => recorded.referencesUsed.includes(reference.sha256));
  } catch (e) {
    if (missing(e) || e instanceof SyntaxError || e instanceof z.ZodError) return false;
    throw e;
  }
}

export async function reuseCompletedPages(root: string, plan: PlanBundle, job: BatchJob): Promise<BatchJob> {
  const s = await readTask(root);
  if (job.kind === 'deck' && s.activeJobId && job.styleLock.approvalState === 'approved') {
    const sample = await readBatchJob(root, s.activeJobId);
    if (sample.kind === 'style-sample' && sample.contentRevision === job.contentRevision
      && json(sample.styleLock.recipe) === json(job.styleLock.recipe)
      && json(sample.generationIntent) === json(job.generationIntent)
      && json(sample.styleLock.references) === json(job.styleLock.references)) {
      const result = BatchResultSchema.parse(await readTaskJson(root, `${jobPath(sample.jobId)}/result.json`));
      const source = sample.pages[0], ref = result.pages.find(p => p.slideId === source.slideId)?.artifact;
      const page = job.pages.find(p => p.slideId === source.slideId && p.prompt === source.prompt);
      if (result.outcome === 'success' && page && ref && json(ref) === json(job.styleLock.approvedSample)) {
        const cp = await readBatchCheckpoint(root, sample.jobId).catch(error => {
          if (missing(error) || error instanceof SyntaxError || error instanceof z.ZodError) throw new SampleReferenceEvidenceError();
          throw error;
        });
        const rows = result.pages.filter(p => p.slideId === source.slideId);
        if (result.jobId !== sample.jobId || cp.jobId !== sample.jobId || rows.length !== 1
          || (rows[0]!.status !== 'success' && rows[0]!.status !== 'cached')
          || json(cp.completed[source.slideId]) !== json(ref)
          || (rows[0]!.status === 'cached' && json(source.cached) !== json(ref))
          || !(await sourceVerified(root, job, source.slideId, ref, source.prompt))) {
          throw new SampleReferenceEvidenceError();
        }
        await validateImage(root, ref); page.cached = ref;
      }
    }
  }
  const previous = await readTaskJson(root, `planning/${s.contentRevision}/previous.json`).catch(e => { if (!missing(e)) throw e; return null; }) as { planPath: string; jobId: string } | null;
  if (!previous?.jobId || !previous.planPath) return job;
  const prior = await readBatchJob(root, previous.jobId), oldPlan = PlanBundleSchema.parse(await readTaskJson(root, previous.planPath));
  if (json(prior.styleLock.recipe) !== json(job.styleLock.recipe)) return job;
  if (json(prior.generationIntent) !== json(job.generationIntent)) return job;
  if (json(prior.styleLock.references) !== json(job.styleLock.references)) return job;
  if (prior.styleLock.referencePolicy !== job.styleLock.referencePolicy || json(prior.styleLock.catalogReference ?? null) !== json(job.styleLock.catalogReference ?? null)) return job;
  const historicalArtifact = async (path: string) => readTaskJson(root, path).catch(e => {
    if (missing(e) || e instanceof SyntaxError) return null;
    throw e;
  });
  const [qaValue, resultValue, checkpoint] = await Promise.all([
    historicalArtifact(`${jobPath(prior.jobId)}/qa.json`),
    historicalArtifact(`${jobPath(prior.jobId)}/result.json`),
    readBatchCheckpoint(root, prior.jobId).catch(e => { if (!missing(e)) throw e; return null; }),
  ]);
  const qa = HistoricalQaSchema.safeParse(qaValue), result = BatchResultSchema.safeParse(resultValue);
  if (!qa.success || !result.success || !checkpoint || result.data.jobId !== prior.jobId || checkpoint.jobId !== prior.jobId) return job;
  const verified = (slideId: string) => {
    const rows = qa.data.pages.filter(page => page.slideId === slideId);
    const results = result.data.pages.filter(page => page.slideId === slideId);
    const spec = oldPlan.slides.find(page => page.slideId === slideId);
    const image = checkpoint.completed[slideId];
    if (rows.length !== 1 || results.length !== 1 || !spec || !image) return false;
    const row = rows[0]!, page = results[0]!;
    return (page.status === 'success' || page.status === 'cached') && json(page.artifact) === json(image)
      && row.sha256 === image.sha256 && row.requiredText.length === spec.requiredText.length
      && spec.requiredText.every((text, index) => row.requiredText[index]?.text === text && row.requiredText[index]?.present)
      && row.styleConsistent && row.hierarchyClear && row.forbiddenContentAbsent;
  };
  if (job.kind === 'style-sample') {
    const ref = prior.styleLock.approvedSample;
    const representative = prior.pages.find(page => page.slideId === plan.representativeSlideId);
    if (ref && verified(plan.representativeSlideId)
      && oldPlan.representativeSlideId === plan.representativeSlideId
      && representative?.prompt === job.pages[0].prompt
      && json(checkpoint.completed[plan.representativeSlideId]) === json(ref)
      && await sourceVerified(root, job, plan.representativeSlideId, ref, representative.prompt)) {
      await validateImage(root, ref); job.pages[0].cached = ref;
    }
  } else if (job.kind === 'deck' && prior.kind === 'deck' && prior.styleLock.approvedSample?.sha256 === job.styleLock.approvedSample?.sha256) {
    for (const page of job.pages) {
      const old = prior.pages.find(p => p.slideId === page.slideId);
      const ref = checkpoint.completed[page.slideId];
      if (!page.cached && old?.prompt === page.prompt && ref && verified(page.slideId) && await sourceVerified(root, job, page.slideId, ref, old.prompt)) { await validateImage(root, ref); page.cached = ref; }
    }
  }
  return job;
}
