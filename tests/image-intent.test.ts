import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTask, fixturePlan } from './helpers/fast-task.js';
import { generateFixture, readyDeck, submitWork } from './helpers/fast-flow.js';
import { publishPlan } from '../src/workflow/planning.js';
import { decideTask } from '../src/workflow/decide.js';
import { readTask, readTaskJson } from '../src/project/task-store.js';
import { beginRequest, finishRequest, readBatchJob, readBatchCheckpoint } from '../src/generation/task-batch.js';

for (const intent of [
  { purpose: '向家长解释脐疝如何形成', audience: '普通家长' },
  { purpose: '向投资人解释收入增长', audience: '投资人' },
]) test(`submission adds actual purpose without changing content or style: ${intent.purpose}`, async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  Object.assign(plan.brief, intent);
  plan.slides[0].requiredText = ['独立标题', '完整原文 $& {{SLIDE_COPY}}，不删改。'];
  const review = await publishPlan(root, plan);
  if (review.kind !== 'decision') throw Error('decision expected');
  const work = await decideTask(root, { decisionId: review.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'cool', callBudget: 1 });
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  const saved = structuredClone(job);
  const prompts = await readTaskJson(root, `planning/${job.contentRevision}/sample-prompts.json`) as Record<string, string>;
  assert.equal(job.pages[0].prompt, prompts[`${plan.styles[0].id}/2/cool`]);
  const outgoing = await beginRequest(root, job.jobId, job.pages[0].slideId);
  assert.equal(typeof outgoing, 'string');
  assert.ok(outgoing.startsWith(job.pages[0].prompt + '\n\n'));
  const note = outgoing.slice(job.pages[0].prompt.length + 2);
  assert.ok(note.includes(intent.purpose));
  assert.ok(note.includes(intent.audience));
  assert.match(note, /非画面文字/);
  assert.match(note, /风格、创意档位、配色及全部可见文案不变/);
  assert.doesNotMatch(note, /教育|科普|医学|写实|血腥|审核豁免/);
  assert.equal((review.details as any).submissionNote, note);
  assert.deepEqual(await readBatchJob(root, job.jobId), saved);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 1);
  await finishRequest(root, job.jobId, { slideId: job.pages[0].slideId, status: 'failed', artifact: null, provider: 'fixture', channel: 'host' });
  const recovery = await submitWork(root, work, { jobId: job.jobId, outcome: 'failed', requestCount: 1, pages: [{ slideId: job.pages[0].slideId, status: 'failed', artifact: null, provider: 'fixture', channel: 'host' }] });
  if (recovery.kind !== 'decision') throw Error('decision expected');
  const retryWork = await decideTask(root, { decisionId: recovery.id, action: 'retry-generation', callBudget: 1 });
  const retry = await readBatchJob(root, (await readTask(root)).activeJobId!);
  // Same outgoing prompt after separately authorized retry, never append the note twice.
  assert.equal(await beginRequest(root, retry.jobId, retry.pages[0].slideId), outgoing);
  await finishRequest(root, retry.jobId, { slideId: retry.pages[0].slideId, status: 'failed', artifact: null, provider: 'fixture', channel: 'host' });
  assert.equal(retryWork.kind, 'work');
});

test('deck and page regeneration submit the same intent while preserving requested page changes', async () => {
  const { root, plan } = await readyDeck();
  const deck = await readBatchJob(root, (await readTask(root)).activeJobId!);
  const work = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'regenerate-page', pageNumber: 2, instruction: '图形再简化一点', callBudget: 1 });
  const page = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(page.styleLock.recipe, deck.styleLock.recipe);
  assert.equal(page.pages[0].prompt, deck.pages[1].prompt + '\nRequested change: 图形再简化一点');
  const outgoing = await beginRequest(root, page.jobId, page.pages[0].slideId);
  assert.equal(typeof outgoing, 'string');
  assert.ok(outgoing.startsWith(page.pages[0].prompt + '\n\n'));
  assert.ok(outgoing.includes(plan.brief.purpose));
  assert.ok(outgoing.includes(plan.brief.audience));
  assert.equal(work.kind, 'work');
});

test('changing only the purpose or audience invalidates image reuse, not content prompts', async () => {
  for (const change of [{ purpose: '面向公众的知识分享' }, { audience: '新员工' }]) {
    const { root, plan } = await readyDeck();
    let work = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '调整用途或受众，保留原文与风格' });
    const revised = structuredClone(plan); Object.assign(revised.brief, change);
    work = await submitWork(root, work, revised);
    work = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
    const sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
    assert.equal(sample.pages[0].cached, null);
    const review = await generateFixture(root, work);
    if (review.kind !== 'decision') throw Error('decision expected');
    work = await decideTask(root, { decisionId: review.id, action: 'approve-sample-and-generate-deck', callBudget: 3 });
    const deck = await readBatchJob(root, (await readTask(root)).activeJobId!);
    assert.deepEqual(deck.pages.map(p => !!p.cached), [true, false, false]);
    assert.equal(deck.pages[0].cached!.path, sample.pages[0].target);
    const outgoing = await beginRequest(root, deck.jobId, deck.pages[1].slideId);
    assert.equal(outgoing, deck.pages[1].prompt + '\n\n' + (review.details as any).submissionNote);
    assert.ok(outgoing.includes(revised.brief.purpose));
    assert.ok(outgoing.includes(revised.brief.audience));
  }
});
