import { selectStyleVariant } from '../src/styles/catalog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { readTask, updateTask } from '../src/project/task-store.js';
import { publishBatchJob, beginRequest, finishRequest, acceptBatchResult, readBatchCheckpoint, remainingCalls, type BatchJob, type BatchResult } from '../src/generation/task-batch.js';

test('batch budget is consumed before requests, completed pages are never regenerated', async () => {
  const { root, ai } = await fixtureTask(), plan = await fixturePlan(), s = await readTask(root), id = randomUUID();
  const job: BatchJob = { jobId: id, contentRevision: s.contentRevision, kind: 'style-sample', createdAt: new Date().toISOString(), generationIntent: { purpose: plan.brief.purpose, audience: plan.brief.audience }, callBudget: 1,
    styleLock: { recipe: selectStyleVariant(plan.styles[0], { level: 2, paletteId: 'mid' }), representativeSlideId: plan.representativeSlideId, approvalState: 'provisional', approvedSample: null, references: [], applyDependencyDefaultStyle: false },
    pages: [{ slideId: plan.representativeSlideId, prompt: '内容', target: `generation/jobs/${id}/images/${plan.representativeSlideId}.png`, cached: null }] };
  await publishBatchJob(root, job); await updateTask(root, s => ({ ...s, activeJobId: id }));
  const preflight = await readFile(join(root, 'generation/jobs/' + id + '/preflight.json'));
  await writeFile(join(ai, 'scripts/gen_slide.py'), 'changed after job preflight');
  await publishBatchJob(root, job);
  assert.deepEqual(await readFile(join(root, 'generation/jobs/' + id + '/preflight.json')), preflight);
  await beginRequest(root, id, plan.representativeSlideId);
  assert.equal(remainingCalls(1, await readBatchCheckpoint(root, id)), 0);
  await assert.rejects(beginRequest(root, id, plan.representativeSlideId), /unknown/);
  const artifact = await fixtureImage(root, job.pages[0].target);
  const page: BatchResult['pages'][number] = { slideId: plan.representativeSlideId, status: 'success', artifact, raw: null, provider: 'fixture', channel: 'api', referencesUsed: [] };
  await finishRequest(root, id, page);
  await assert.rejects(beginRequest(root, id, page.slideId), /must not/);
  const result: BatchResult = { jobId: id, requestCount: 1, outcome: 'success', pages: [page], routeSummary: [] };
  assert.deepEqual(await acceptBatchResult(root, result), await acceptBatchResult(root, result));
  await assert.rejects(acceptBatchResult(root, { ...result, requestCount: 2 }), /call count/);
});
