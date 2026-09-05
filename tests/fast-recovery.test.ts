import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readyDeck, submitWork, generateFixture } from './helpers/fast-flow.js';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { readTask, updateTask, taskTransaction, readTaskJson } from '../src/project/task-store.js';
import { continueTask } from '../src/workflow/continue.js';
import { decideTask } from '../src/workflow/decide.js';
import { readBatchJob, readBatchCheckpoint, beginRequest, finishRequest } from '../src/generation/task-batch.js';

test('failed command never commits partial state or consumes a decision receipt', async () => {
  const { root } = await fixtureTask(), before = await readFile(join(root, 'superppt.json'));
  await assert.rejects(() => taskTransaction(root, async () => {
    await updateTask(root, s => ({ ...s, stage: 'plan-review' }));
    throw new Error('interrupted before manifest commit');
  }));
  assert.deepEqual(await readFile(join(root, 'superppt.json')), before);
});

test('content revision reuses the sample and two unchanged pages; changed page alone consumes a call', async () => {
  const { root, plan } = await readyDeck();
  let reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: 'Change page 3 composition' });
  const changed = structuredClone(plan); changed.slides[2].composition = '上图下文';
  reply = await submitWork(root, reply, changed);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, callBudget: 1 });
  let job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.ok(job.pages[0].cached);
  reply = await generateFixture(root, reply);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 0);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 1 });
  job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(job.pages.map(p => !!p.cached), [true, true, false]);
  await generateFixture(root, reply);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 1);
});

test('two completed pages survive interrupted third request and a separately authorized retry budget', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, callBudget: 1 });
  reply = await generateFixture(root, reply);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 3 });
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!), pages = [];
  for (const p of job.pages.slice(0, 2)) {
    await beginRequest(root, job.jobId, p.slideId);
    const result = { slideId: p.slideId, status: 'success' as const, artifact: await fixtureImage(root, p.target), raw: null, provider: 'fixture', channel: 'api' as const, referencesUsed: [] };
    await finishRequest(root, job.jobId, result); pages.push(result);
  }
  const completed = (await readBatchCheckpoint(root, job.jobId)).completed;
  await beginRequest(root, job.jobId, job.pages[2].slideId);
  assert.equal((await continueTask(root)).kind, 'attention');
  await assert.rejects(() => beginRequest(root, job.jobId, job.pages[2].slideId), /unknown/);
  await assert.rejects(() => beginRequest(root, job.jobId, job.pages[0].slideId), /unknown/);
  const failed = { slideId: job.pages[2].slideId, status: 'failed' as const, artifact: null, raw: null, provider: 'fixture', channel: 'api' as const, referencesUsed: [] };
  await finishRequest(root, job.jobId, failed);
  reply = await submitWork(root, reply, { jobId: job.jobId, outcome: 'partial', requestCount: 3, pages: [...pages, failed], routeSummary: [] });
  assert.equal(reply.kind, 'decision');
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'retry-generation', callBudget: 1 });
  const retry = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(retry.pages.slice(0, 2).map(p => p.cached), job.pages.slice(0, 2).map(p => completed[p.slideId]));
  await generateFixture(root, reply);
  assert.equal((await readBatchCheckpoint(root, retry.jobId)).requestCount, 1);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 3);
});

test('QA failure exposes a correction decision and cannot deliver an unchecked deck', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, callBudget: 1 });
  reply = await generateFixture(root, reply);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 3 });
  reply = await generateFixture(root, reply);
  const cp = await readBatchCheckpoint(root, (await readTask(root)).activeJobId!);
  reply = await submitWork(root, reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: cp.completed[p.slideId].sha256, requiredText: [{text: '标题', present: false}], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'Missing title' })) });
  assert.equal(reply.kind, 'decision');
  assert.equal((await readTask(root)).pendingDecision!.kind, 'quality-review');
  await assert.rejects(async () => decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'confirm-delivery' }), /review required/);
  assert.equal((await readTask(root)).currentDeck, null);
  const next = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: 'Repair missing text' });
  assert.equal(next.kind, 'work');
});
