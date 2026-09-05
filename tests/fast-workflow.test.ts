import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { readTask, writeTaskJson, hash } from '../src/project/task-store.js';
import { continueTask } from '../src/workflow/continue.js';
import { decideTask } from '../src/workflow/decide.js';
import { readBatchJob, beginRequest, finishRequest, readBatchCheckpoint, type BatchResult } from '../src/generation/task-batch.js';
import { editTask, readTaskSession } from '../src/deck-revisions/task-deck.js';
import { inspectLocalPptx } from '../src/deck-revisions/task-inspect.js';
import type { WorkflowReply } from '../src/workflow/contracts.js';

import { submitWork, generateFixture } from './helpers/fast-flow.js';

for (const n of [3, 12]) test(`${n} pages: three decisions, one whole-deck handoff, real PPTX and unchanged delivery bytes`, async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan(n);
  let reply = await continueTask(root), decisions = 0, generationHandoffs = 0;
  assert.deepEqual(await continueTask(root), reply);
  reply = await submitWork(root, reply, plan); decisions++;
  assert.equal(reply.kind, 'decision');
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, callBudget: 1 }); generationHandoffs++;
  reply = await generateFixture(root, reply); decisions++;
  assert.equal(reply.kind, 'decision');
  assert.ok(JSON.stringify(reply).length < 12000, 'sample review should link to deck prompts, not repeat every full prompt in command output');
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: n }); generationHandoffs++;
  reply = await generateFixture(root, reply);
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!), cp = await readBatchCheckpoint(root, job.jobId);
  reply = await submitWork(root, reply, { pages: job.pages.map(p => ({ slideId: p.slideId, sha256: cp.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture structural scenario' })) }); decisions++;
  assert.equal(reply.kind, 'decision'); assert.equal(decisions, 3); assert.equal(generationHandoffs, 2);
  const current = (await readTask(root)).currentDeck!;
  assert.equal((await inspectLocalPptx(join(root, current.relativePath))).slideCount, n);
  await continueTask(root); assert.deepEqual((await readTask(root)).currentDeck, current);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'confirm-delivery' });
  assert.equal(reply.kind, 'done'); if (reply.kind !== 'done') throw new Error('Delivery expected');
  assert.equal(hash(await readFile(join(root, reply.deck.relativePath))), current.sha256);
  // Manual adoption and pointer rollback after complete-deck review.
  await editTask(root, { pageNumber: 1, mode: 'manual', instruction: '', route: 'direct-edit' });
  const session = await readTaskSession(root), saved = await readFile(join(root, session.candidatePath));
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'saved-and-closed' });
  assert.deepEqual(await readFile(join(root, (await readTask(root)).currentDeck!.relativePath)), saved);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'rollback-deck' });
  assert.equal((await readTask(root)).currentDeck!.revisionId, current.revisionId);
});
