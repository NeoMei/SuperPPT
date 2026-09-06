import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixtureTask, fixturePlan, fixtureImage } from './fast-task.js';
import { readTask, writeTaskJson, hash } from '../../src/project/task-store.js';
import { continueTask } from '../../src/workflow/continue.js';
import { decideTask } from '../../src/workflow/decide.js';
import { readBatchJob, beginRequest, finishRequest, readBatchCheckpoint, type BatchResult } from '../../src/generation/task-batch.js';
import { editTask, readTaskSession } from '../../src/deck-revisions/task-deck.js';
import { inspectLocalPptx } from '../../src/deck-revisions/task-inspect.js';
import type { WorkflowReply } from '../../src/workflow/contracts.js';

export async function submitWork(root: string, reply: WorkflowReply, payload: unknown) {
  assert.equal(reply.kind, 'work'); if (reply.kind !== 'work') throw new Error('Work expected');
  const path = reply.work.resultPath;
  await writeTaskJson(root, path, { workId: reply.work.id, contentRevision: (await readTask(root)).contentRevision, payload });
  return continueTask(root, join(root, path));
}
export async function generateFixture(root: string, reply: WorkflowReply) {
  assert.equal(reply.kind, 'work');
  const s = await readTask(root), job = await readBatchJob(root, s.activeJobId!);
  const pages: BatchResult['pages'] = [];
  for (const page of job.pages) {
    if (page.cached) {
      pages.push({ slideId: page.slideId, status: 'cached', artifact: page.cached, raw: null, provider: null, channel: null, referencesUsed: [] });
      continue;
    }
    await beginRequest(root, job.jobId, page.slideId);
    const artifact = await fixtureImage(root, page.target);
    const result: BatchResult['pages'][number] = { slideId: page.slideId, status: 'success', artifact, raw: null, provider: 'fixture', channel: 'api', referencesUsed: [] };
    await finishRequest(root, job.jobId, result); pages.push(result);
  }
  return submitWork(root, reply, { jobId: job.jobId, requestCount: (await readBatchCheckpoint(root, job.jobId)).requestCount, outcome: 'success', pages, routeSummary: ['fixture only'] });
}

export async function readyDeck(n = 3) {
  const { root } = await fixtureTask(), plan = await fixturePlan(n);
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  reply = await generateFixture(root, reply);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: n - 1 });
  reply = await generateFixture(root, reply);
  const cp = await readBatchCheckpoint(root, (await readTask(root)).activeJobId!);
  reply = await submitWork(root, reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: cp.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture' })) });
  return { root, plan, reply };
}
