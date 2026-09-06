import { readTask, readTaskJson, missing, json } from '../project/task-store.js';
import { readBatchJob, readBatchCheckpoint, validateImage, type BatchJob } from '../generation/task-batch.js';
import { PlanBundleSchema, type PlanBundle } from './contracts.js';
import { samplePrompts, variantKey } from './planning.js';

export async function reuseCompletedPages(root: string, plan: PlanBundle, job: BatchJob): Promise<BatchJob> {
  const s = await readTask(root);
  const previous = await readTaskJson(root, `planning/${s.contentRevision}/previous.json`).catch(e => { if (!missing(e)) throw e; return null; }) as { planPath: string; jobId: string } | null;
  if (!previous?.jobId || !previous.planPath) return job;
  const prior = await readBatchJob(root, previous.jobId), oldPlan = PlanBundleSchema.parse(await readTaskJson(root, previous.planPath));
  if (json(prior.styleLock.recipe) !== json(job.styleLock.recipe)) return job;
  if (json(prior.generationIntent) !== json(job.generationIntent)) return job;
  if (json(prior.styleLock.references) !== json(job.styleLock.references)) return job;
  if (job.kind === 'style-sample') {
    const ref = prior.styleLock.approvedSample;
    if (ref && oldPlan.representativeSlideId === plan.representativeSlideId && samplePrompts(oldPlan)[variantKey(job.styleLock.recipe)] === job.pages[0].prompt) {
      await validateImage(root, ref); job.pages[0].cached = ref;
    }
  } else if (job.kind === 'deck' && prior.kind === 'deck' && prior.styleLock.approvedSample?.sha256 === job.styleLock.approvedSample?.sha256) {
    const checkpoint = await readBatchCheckpoint(root, prior.jobId);
    const qa = await readTaskJson(root, `generation/jobs/${prior.jobId}/qa.json`).catch(e => { if (!missing(e)) throw e; return null; }) as { pages: Array<{ slideId: string; styleConsistent: boolean; hierarchyClear: boolean; forbiddenContentAbsent: boolean; requiredText: Array<{ present: boolean }> }> } | null;
    const rejected = new Set(qa?.pages.filter(p => !p.styleConsistent || !p.hierarchyClear || !p.forbiddenContentAbsent || p.requiredText.some(t => !t.present)).map(p => p.slideId));
    for (const page of job.pages) {
      const old = prior.pages.find(p => p.slideId === page.slideId);
      const ref = checkpoint.completed[page.slideId];
      if (old?.prompt === page.prompt && ref && !rejected.has(page.slideId)) { await validateImage(root, ref); page.cached = ref; }
    }
  }
  return job;
}
