import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { submitWork } from './helpers/fast-flow.js';
import { continueTask } from '../src/workflow/continue.js';
import { decideTask } from '../src/workflow/decide.js';
import { readTask, readTaskJson } from '../src/project/task-store.js';
import { beginRequest, finishRequest, readBatchJob, readBatchCheckpoint, generationReferences } from '../src/generation/task-batch.js';

async function sampleReady() {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  const page = job.pages[0];
  await beginRequest(root, job.jobId, page.slideId);
  const artifact = await fixtureImage(root, page.target);
  const result = { slideId: page.slideId, status: 'success' as const, artifact, raw: null, provider: 'fixture', channel: 'api' as const, referencesUsed: generationReferences(job).map(r => r.sha256) };
  await finishRequest(root, job.jobId, result);
  reply = await submitWork(root, reply, { jobId: job.jobId, requestCount: 1, outcome: 'success', pages: [result], routeSummary: [] });
  const spec = plan.slides.find(p => p.slideId === page.slideId)!;
  const qa = { pages: [{ slideId: page.slideId, sha256: artifact.sha256, requiredText: spec.requiredText.map(text => ({ text, present: true })), styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: '标题、正文与语义图形对应，焦点清晰' }] };
  return { root, reply, job, artifact, qa };
}

test('sample receives a SHA-bound visual check before sample approval or deck requests', async () => {
  const { root, reply, job, artifact, qa } = await sampleReady();
  assert.equal(reply.kind, 'work'); if (reply.kind !== 'work') throw Error('expected sample QA');
  assert.equal(reply.work.kind, 'review-images');
  const request = await readTaskJson(root, reply.work.inputPath) as { instructions: string };
  assert.match(request.instructions, /coreMessage/);
  assert.match(request.instructions, /relationships/);
  assert.match(request.instructions, /底|backing/i);
  assert.equal((await readTask(root)).pendingDecision, null);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 1);
  const wrong = structuredClone(qa); wrong.pages[0].sha256 = '0'.repeat(64);
  await assert.rejects(submitWork(root, reply, wrong), /QA does not match/);
  const unobserved = structuredClone(qa); unobserved.pages[0].notes = '  ';
  await assert.rejects(submitWork(root, reply, unobserved), /observation/);
  const result = await submitWork(root, reply, qa);
  assert.equal(result.kind, 'decision'); if (result.kind !== 'decision') throw Error('sample review expected');
  assert.equal(result.stage, 'sample-review');
  assert.equal((result.details as any).sample.sha256, artifact.sha256);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 1);
});

test('failed sample quality blocks approval and returns a revision decision without generation', async () => {
  const { root, reply, job, qa } = await sampleReady();
  qa.pages[0].hierarchyClear = false; qa.pages[0].notes = '大幅图形抢焦点，正文不清楚';
  const result = await submitWork(root, reply, qa);
  assert.equal(result.kind, 'decision'); if (result.kind !== 'decision') throw Error('quality review expected');
  assert.equal(result.stage, 'quality-review');
  assert.ok(result.view.includes(join(root, job.pages[0].target)));
  assert.equal((result.details as any).pages[0].notes, qa.pages[0].notes);
  await assert.rejects(decideTask(root, { decisionId: result.id, action: 'approve-sample-and-generate-deck', callBudget: 2 }), /sample/i);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 1);
  const revised = await decideTask(root, { decisionId: result.id, action: 'revise-plan', instruction: '缩小图形，扩大带托底的正文' });
  assert.equal(revised.kind, 'work');
});


test('sample QA refuses a changed image even if the supplied SHA matches the original', async () => {
  const { root, reply, artifact, qa } = await sampleReady();
  await writeFile(join(root, artifact.path), 'changed image');
  qa.pages[0].hierarchyClear = false;
  await assert.rejects(submitWork(root, reply, qa), /digest mismatch/i);
});
