import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { fixtureTask, fixturePlan } from './helpers/fast-task.js';
import { submitWork, generateFixture, readyDeck } from './helpers/fast-flow.js';
import { readTask, hash } from '../src/project/task-store.js';
import { continueTask } from '../src/workflow/continue.js';
import { decideTask } from '../src/workflow/decide.js';
import { readBatchJob, readBatchCheckpoint, beginRequest, finishRequest } from '../src/generation/task-batch.js';
import { reuseCompletedPages } from '../src/workflow/reuse.js';

for (const n of [3, 12]) test(`${n} pages: approved sample stays at its original position without a second request`, async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan(n);
  const index = n === 3 ? 1 : n - 1;
  plan.representativeSlideId = plan.slides[index].slideId;
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  await beginRequest(root, sample.jobId, plan.representativeSlideId);
  // Distinct pixels prove the sample, not another fixture page, occupies this slot.
  const bytes = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#275f9c' } }).png().toBuffer();
  await mkdir(join(root, sample.pages[0].target, '..'), { recursive: true });
  await writeFile(join(root, sample.pages[0].target), bytes);
  const pageResult = { slideId: plan.representativeSlideId, status: 'success' as const, artifact: { path: sample.pages[0].target, sha256: hash(bytes) }, raw: null, provider: 'fixture', channel: 'api' as const, referencesUsed: [] };
  await finishRequest(root, sample.jobId, pageResult);
  reply = await submitWork(root, reply, { jobId: sample.jobId, requestCount: 1, outcome: 'success', pages: [pageResult], routeSummary: ['fixture only'] });
  const ref = (await readBatchCheckpoint(root, sample.jobId)).completed[plan.representativeSlideId];
  const original = await readFile(join(root, ref.path));
  assert.equal(reply.kind, 'decision');
  if (reply.kind !== 'decision') throw new Error('Expected sample review');
  const details = reply.details as any;
  assert.equal(details.generationPageCount, n - 1);
  assert.equal(details.callBudget, n - 1);
  assert.deepEqual(details.reusedSlideIds, [plan.representativeSlideId]);
  assert.match(details.submissionNote, /实际用途：解释任务/);
  if (n === 3) {
    const candidate = { ...sample, kind: 'deck' as const, styleLock: { ...sample.styleLock, approvalState: 'approved' as const, approvedSample: ref } };
    for (const change of ['prompt', 'style', 'tier', 'palette', 'purpose', 'audience', 'references', 'regeneration']) {
      const changed = structuredClone(candidate);
      if (change === 'prompt') changed.pages[0].prompt += '\nRequested change: 修改文案';
      if (change === 'style') changed.styleLock.recipe.id += '-other';
      if (change === 'tier') changed.styleLock.recipe.level = 3;
      if (change === 'palette') changed.styleLock.recipe.paletteId = 'warm';
      if (change === 'purpose') changed.generationIntent.purpose += '新用途';
      if (change === 'audience') changed.generationIntent.audience += '新受众';
      if (change === 'references') changed.styleLock.references = [{ path: 'new-reference.png', role: 'art-direction' }] as any;
      const job = await reuseCompletedPages(root, plan, { ...changed, kind: change === 'regeneration' ? 'page-regeneration' : 'deck' });
      assert.equal(job.pages[0].cached, null, `${change} must not reuse the old sample`);
    }
  }
  reply = await decideTask(root, { decisionId: reply.id, action: 'approve-sample-and-generate-deck', callBudget: n - 1 });
  const deck = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(deck.pages[index].cached, ref);
  await assert.rejects(() => beginRequest(root, deck.jobId, plan.representativeSlideId), /must not be generated again/);
  reply = await generateFixture(root, reply);
  const cp = await readBatchCheckpoint(root, deck.jobId);
  assert.equal(cp.requestCount + (await readBatchCheckpoint(root, sample.jobId)).requestCount, n);
  reply = await submitWork(root, reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: cp.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture only' })) });
  const current = (await readTask(root)).currentDeck!;
  const zip = await JSZip.loadAsync(await readFile(join(root, current.relativePath)));
  const xml = await zip.file(`ppt/slides/slide${index + 1}.xml`)!.async('string');
  const rid = /r:embed="([^"]+)"/.exec(xml)![1];
  const rels = await zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`)!.async('string');
  const rel = rels.match(/<Relationship\b[^>]*>/g)!.find(r => r.includes(`Id="${rid}"`))!;
  const target = /Target="([^"]+)"/.exec(rel)![1].replace('../', 'ppt/');
  const image = await zip.file(target)!.async('nodebuffer');
  assert.deepEqual(await sharp(image).raw().toBuffer(), await sharp(original).resize(1920, 1080).removeAlpha().raw().toBuffer());
  assert.deepEqual(await readFile(join(root, ref.path)), original);
});

test('an unchanged revision discloses and executes a zero-call fully cached deck', async () => {
  const { root, plan } = await readyDeck();
  let reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '保留已确认内容与设计' });
  reply = await submitWork(root, reply, plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  reply = await generateFixture(root, reply);
  assert.equal((reply as any).details.callBudget, 0);
  assert.equal((reply as any).details.generationPageCount, 0);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 0 });
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.ok(job.pages.every(p => p.cached));
  await generateFixture(root, reply);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 0);
});

test('a sample rejected during whole-deck QA must be generated anew on revision', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  plan.representativeSlideId = plan.slides[1].slideId;
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  reply = await generateFixture(root, reply);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 2 });
  reply = await generateFixture(root, reply);
  const cp = await readBatchCheckpoint(root, (await readTask(root)).activeJobId!);
  reply = await submitWork(root, reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: cp.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: p.slideId !== plan.representativeSlideId }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'Representative image omitted the title; spec is correct' })) });
  assert.equal((await readTask(root)).pendingDecision!.kind, 'quality-review');
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '规格无误，重新生成缺少标题的样页' });
  reply = await submitWork(root, reply, plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.equal(sample.pages[0].cached, null);
  reply = await generateFixture(root, reply);
  assert.equal((await readBatchCheckpoint(root, sample.jobId)).requestCount, 1);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: (reply as any).details.callBudget });
  const deck = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.equal(deck.pages[1].cached!.path, sample.pages[0].target);
});
