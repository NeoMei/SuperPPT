import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { readTask, updateTask, writeTaskJson } from '../src/project/task-store.js';
import { selectStyleVariant } from '../src/styles/catalog.js';
import * as batch from '../src/generation/task-batch.js';
import { publishBatchJob, beginRequest, finishRequest, readBatchCheckpoint, type BatchJob } from '../src/generation/task-batch.js';

test('completed deck pages are individually available before the batch result and keep progress read-only', async () => {
  assert.equal(typeof (batch as any).readPageProgress, 'function');
  const readPageProgress = (batch as any).readPageProgress;
  const { root } = await fixtureTask();
  const plan = await fixturePlan(4);
  const state = await readTask(root);
  const jobId = randomUUID();
  const cached = await fixtureImage(root, 'samples/approved.png');
  const job: BatchJob = {
    jobId, contentRevision: state.contentRevision, kind: 'deck', createdAt: new Date().toISOString(),
    generationIntent: { purpose: plan.brief.purpose, audience: plan.brief.audience }, callBudget: 3,
    styleLock: { recipe: selectStyleVariant(plan.styles[0], { level: 2, paletteId: 'mid' }), representativeSlideId: plan.representativeSlideId, approvalState: 'approved', approvedSample: cached, references: [], applyDependencyDefaultStyle: false },
    pages: plan.outline.slides.map((slide, i) => ({ slideId: slide.id, prompt: '内容', target: `generation/jobs/${jobId}/images/${slide.id}.png`, cached: i === 0 ? cached : null })),
  };
  await writeTaskJson(root, 'planning/progress-plan.json', plan);
  await publishBatchJob(root, job);
  await updateTask(root, s => ({ ...s, activeJobId: jobId, planPath: 'planning/progress-plan.json', stage: 'deck-generation' }));
  const cachedProgress = await readPageProgress(root, jobId, job.pages[0].slideId);
  assert.deepEqual(cachedProgress && { page: cachedProgress.pageNumber, total: cachedProgress.totalPages, complete: cachedProgress.completedPages, source: cachedProgress.source, qa: cachedProgress.qa }, { page: 1, total: 4, complete: 1, source: 'cached', qa: 'pending' });
  assert.equal(await readPageProgress(root, jobId, job.pages[1].slideId), null);
  await beginRequest(root, jobId, job.pages[1].slideId);
  const artifact = await fixtureImage(root, job.pages[1].target);
  await finishRequest(root, jobId, { slideId: job.pages[1].slideId, status: 'success', artifact, raw: null, provider: 'fixture', channel: 'api', referencesUsed: [] });
  const first = await readPageProgress(root, jobId, job.pages[1].slideId);
  assert.ok(first && isAbsolute(first.absolutePath));
  assert.deepEqual({ page: first!.pageNumber, total: first!.totalPages, complete: first!.completedPages, source: first!.source, qa: first!.qa, sha256: first!.sha256 }, { page: 2, total: 4, complete: 2, source: 'generated', qa: 'pending', sha256: artifact.sha256 });
  assert.equal(await readPageProgress(root, jobId, job.pages[2].slideId), null);
  const before = await readBatchCheckpoint(root, jobId);
  assert.deepEqual(await readPageProgress(root, jobId, job.pages[1].slideId), first);
  assert.deepEqual(await readBatchCheckpoint(root, jobId), before);
  await beginRequest(root, jobId, job.pages[2].slideId);
  const secondArtifact = await fixtureImage(root, job.pages[2].target);
  await finishRequest(root, jobId, { slideId: job.pages[2].slideId, status: 'success', artifact: secondArtifact, raw: null, provider: 'fixture', channel: 'api', referencesUsed: [] });
  const second = await readPageProgress(root, jobId, job.pages[2].slideId);
  assert.deepEqual({ page: second!.pageNumber, total: second!.totalPages, complete: second!.completedPages, qa: second!.qa }, { page: 3, total: 4, complete: 3, qa: 'pending' });
  await beginRequest(root, jobId, job.pages[3].slideId);
  await finishRequest(root, jobId, { slideId: job.pages[3].slideId, status: 'failed', artifact: null, raw: null, provider: 'fixture', channel: 'api', referencesUsed: [] });
  assert.equal(await readPageProgress(root, jobId, job.pages[3].slideId), null);
  assert.equal((await readBatchCheckpoint(root, jobId)).requestCount, 3);
  await writeFile(join(root, artifact.path), Buffer.from('tampered'));
  await assert.rejects(readPageProgress(root, jobId, job.pages[1].slideId), /digest/);
  await updateTask(root, s => ({ ...s, stage: 'deck-qa' }));
  await assert.rejects(readPageProgress(root, jobId, job.pages[1].slideId), /active deck job/);
});
