import { randomUUID } from 'node:crypto';
import { readTask, readTaskJson, writeTaskJson, updateTask, taskTransaction, hash, json, missing } from '../project/task-store.js';
import { PlanBundleSchema, DecisionInputSchema, type WorkflowReply } from './contracts.js';
import { publishBatchJob, BatchResultSchema, TaskStyleSchema, readBatchJob, readBatchCheckpoint, jobPath, type BatchJob } from '../generation/task-batch.js';
import { samplePrompts } from './planning.js';
import { reuseCompletedPages } from './reuse.js';
import { continueTask, taskReply } from './continue.js';
import { deliverTaskDeck, adoptTaskDeck, readTaskRevision } from '../deck-revisions/task-deck.js';

export async function decideTask(root: string, raw: unknown): Promise<WorkflowReply> {
  return taskTransaction(root, async () => {
    const input = DecisionInputSchema.parse(raw), s = await readTask(root), decisionHash = hash(json(input));
    if (s.lastDecision?.id === input.decisionId) {
      if (s.lastDecision.sha256 !== decisionHash) throw new Error('Decision already used for another action');
      return continueTask(root);
    }
    if (s.pendingDecision?.id !== input.decisionId) throw new Error('Decision is not current');
    if (input.action === 'confirm-delivery') await deliverTaskDeck(root);
    else if (input.action === 'saved-and-closed' || input.action === 'confirm-agent-edit') await adoptTaskDeck(root, input.action === 'saved-and-closed' ? 'saved-and-closed' : { confirmedSha256: input.confirmedSha256 ?? '' });
    else if (input.action === 'reject-edit') {
      if (!s.editSessionPath) throw new Error('No edit to reject');
      await updateTask(root, old => ({ ...old, editSessionPath: null, work: null, pendingDecision: { id: randomUUID(), kind: 'deck-review' } }));
    } else if (input.action === 'rollback-deck') {
      if (!s.currentDeck || s.editSessionPath) throw new Error('Finish the current edit first');
      const prior = await readTaskRevision(root, s.currentDeck.revisionId);
      if (!prior.parent) throw new Error('No previous deck');
      const target = await readTaskRevision(root, prior.parent.revisionId);
      await updateTask(root, old => ({ ...old, currentDeck: { revisionId: target.revisionId, relativePath: target.relativePath, sha256: target.sha256 }, delivery: null, stage: 'deck-review', pendingDecision: { id: randomUUID(), kind: 'deck-review' } }));
    } else if (input.action === 'revise-plan') {
      if (!input.instruction?.trim() || s.editSessionPath) throw new Error('Provide the requested change and finish pending edits');
      const revision = randomUUID();
      await writeTaskJson(root, `planning/${revision}/previous.json`, { planPath: s.planPath, styleLockPath: s.styleLockPath, jobId: s.activeJobId, instruction: input.instruction });
      await updateTask(root, old => ({ ...old, contentRevision: revision, stage: 'planning', planPath: null, styleLockPath: null, activeJobId: null, pendingDecision: null, work: null, delivery: null }));
    } else {
      const plan = PlanBundleSchema.parse(await readTaskJson(root, s.planPath!));
      const id = input.decisionId; // A replay after interruption addresses the same immutable job.
      const createdAt = (await readBatchJob(root, id).catch(e => { if (!missing(e)) throw e; return null; }))?.createdAt ?? new Date().toISOString();
      let job: BatchJob;
      if (input.action === 'retry-generation') {
        if (s.pendingDecision.kind !== 'generation-recovery' || input.callBudget === undefined) throw new Error('Only an incomplete batch can be retried with a new budget');
        const prior = await readBatchJob(root, s.activeJobId!), cp = await readBatchCheckpoint(root, prior.jobId);
        if (cp.inFlightSlideId) throw new Error('Resolve the unknown request before authorizing another');
        job = { ...prior, jobId: id, createdAt, callBudget: input.callBudget, pages: prior.pages.map(p => ({ ...p, target: `${jobPath(id)}/images/${p.slideId}.png`, cached: cp.completed[p.slideId] ?? null })) };
      } else if (input.action === 'select-style-and-generate-sample') {
        if (s.stage !== 'plan-review' || input.callBudget !== 1) throw new Error('Sample requires plan review and one call');
        const style = plan.styles.find(p => p.id === input.styleId);
        if (!style) throw new Error('Select one of the disclosed styles');
        job = { jobId: id, contentRevision: s.contentRevision, kind: 'style-sample', createdAt, callBudget: 1, styleLock: { recipe: style, representativeSlideId: plan.representativeSlideId, approvalState: 'provisional', approvedSample: null, references: plan.references, applyDependencyDefaultStyle: false }, pages: [{ slideId: plan.representativeSlideId, prompt: samplePrompts(plan)[style.id], target: `${jobPath(id)}/images/${plan.representativeSlideId}.png`, cached: null }] };
      } else {
        if (input.action !== 'approve-sample-and-generate-deck' && input.action !== 'regenerate-page') throw new Error('Action unavailable');
        if (input.action === 'approve-sample-and-generate-deck' && s.stage !== 'sample-review') throw new Error('Review the sample first');
        if (input.action === 'regenerate-page' && (s.stage !== 'deck-review' || !input.instruction || s.editSessionPath)) throw new Error('Specify a page change at deck review');
        const prior = await readBatchJob(root, s.activeJobId!), result = BatchResultSchema.parse(await readTaskJson(root, `${jobPath(prior.jobId)}/result.json`));
        const styleLock = TaskStyleSchema.parse({ ...prior.styleLock, approvalState: 'approved', approvedSample: prior.styleLock.approvedSample ?? result.pages[0].artifact });
        const prompts = await readTaskJson(root, `planning/${s.contentRevision}/deck-prompts.json`) as Record<string, string>;
        let pages = plan.outline.slides;
        if (input.action === 'regenerate-page') {
          const current = await readTaskRevision(root, s.currentDeck!.revisionId), entry = current.topology.entries[(input.pageNumber ?? 0) - 1];
          if (!entry) throw new Error('Page number is outside current deck');
          pages = pages.filter(p => p.id === entry.stableSlideId);
          if (!pages.length) throw new Error('This manually inserted page has no generation spec; use manual editing');
        }
        if (input.callBudget === undefined) throw new Error('Approve a call budget');
        job = { jobId: id, contentRevision: s.contentRevision, kind: input.action === 'regenerate-page' ? 'page-regeneration' : 'deck', createdAt, callBudget: input.callBudget, styleLock, pages: pages.map(p => ({ slideId: p.id, prompt: prompts[p.id] + (input.instruction ? `\nRequested change: ${input.instruction}` : ''), target: `${jobPath(id)}/images/${p.id}.png`, cached: null })) };
      }
      job.createdAt = createdAt;
      job = await reuseCompletedPages(root, plan, job);
      await publishBatchJob(root, job);
      const stylePath = `planning/${s.contentRevision}/style-lock.json`;
      await writeTaskJson(root, stylePath, job.styleLock);
      await updateTask(root, old => ({ ...old, styleLockPath: stylePath, activeJobId: id, stage: job.kind === 'style-sample' ? 'sample-generation' : 'deck-generation', pendingDecision: null, work: null }));
    }
    await updateTask(root, old => ({ ...old, lastDecision: { id: input.decisionId, sha256: decisionHash } }));
    return continueTask(root);
  });
}
