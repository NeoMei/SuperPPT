import { generationReferences } from '../src/generation/style-reference.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { submitWork, generateFixture, readyDeck } from './helpers/fast-flow.js';
import { readTask, hash, writeTaskJson, readTaskJson } from '../src/project/task-store.js';
import { continueTask } from '../src/workflow/continue.js';
import { decideTask } from '../src/workflow/decide.js';
import { readBatchJob, readBatchCheckpoint, beginRequest, finishRequest } from '../src/generation/task-batch.js';
import { reuseCompletedPages } from '../src/workflow/reuse.js';

test('a sample job created before a compiler update keeps its approved prompt and is reused', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  sample.pages[0].prompt = '历史已披露样页提示词';
  await writeTaskJson(root, `generation/jobs/${sample.jobId}/job.json`, sample);
  reply = await generateFixture(root, reply);
  assert.equal((reply as any).details.callBudget, 2);
  assert.deepEqual((reply as any).details.reusedSlideIds, [plan.representativeSlideId]);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 2 });
  const deck = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.equal(deck.pages.find(page => page.slideId === plan.representativeSlideId)!.prompt, sample.pages[0].prompt);
  assert.ok(deck.pages.find(page => page.slideId === plan.representativeSlideId)!.cached);
});

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
  const pageResult = { slideId: plan.representativeSlideId, status: 'success' as const, artifact: { path: sample.pages[0].target, sha256: hash(bytes) }, raw: null, provider: 'fixture', channel: 'api' as const, referencesUsed: generationReferences(sample).map(r => r.sha256) };
  await finishRequest(root, sample.jobId, pageResult);
  reply = await submitWork(root, reply, { jobId: sample.jobId, requestCount: 1, outcome: 'success', pages: [pageResult], routeSummary: ['fixture only'] });
  const sampleSpec = plan.slides.find(page => page.slideId === plan.representativeSlideId)!;
  reply = await submitWork(root, reply, { pages: [{ slideId: plan.representativeSlideId, sha256: pageResult.artifact.sha256, requiredText: sampleSpec.requiredText.map(text => ({ text, present: true })), styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture only' }] });
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
  reply = await generateFixture(root, reply);
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 0);
  const checkpoint = await readBatchCheckpoint(root, job.jobId);
  reply = await submitWork(root, reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: checkpoint.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture' })) });
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '再次保留内容与设计' });
  reply = await submitWork(root, reply, plan);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const secondSample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(secondSample.pages[0].cached, job.styleLock.approvedSample);
});

test('a revised plan does not reuse an approved sample generated with an older prompt', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  sample.pages[0].prompt = '旧版本生图时实际使用的提示词';
  await writeTaskJson(root, `generation/jobs/${sample.jobId}/job.json`, sample);
  reply = await generateFixture(root, reply);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 2 });
  reply = await generateFixture(root, reply);
  const checkpoint = await readBatchCheckpoint(root, (await readTask(root)).activeJobId!);
  reply = await submitWork(root, reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: checkpoint.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture' })) });
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '保留内容并应用新的提示词' });
  reply = await submitWork(root, reply, plan);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const revised = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.notEqual(revised.pages[0].prompt, sample.pages[0].prompt);
  assert.equal(revised.pages[0].cached, null);
});

test('an approved sample is not reused when its image is not the prior representative page', async () => {
  const { root, plan } = await readyDeck();
  const prior = await readBatchJob(root, (await readTask(root)).activeJobId!);
  const checkpoint = await readBatchCheckpoint(root, prior.jobId);
  checkpoint.completed[plan.representativeSlideId] = checkpoint.completed[plan.slides[1].slideId];
  await writeTaskJson(root, `generation/jobs/${prior.jobId}/checkpoint.json`, checkpoint);
  let reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '保留内容与设计' });
  reply = await submitWork(root, reply, plan);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const revised = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.equal(revised.pages[0].cached, null);
});

test('an unbound historical QA record cannot authorize sample or deck page reuse', async () => {
  const { root, plan } = await readyDeck();
  const prior = await readBatchJob(root, (await readTask(root)).activeJobId!);
  const path = `generation/jobs/${prior.jobId}/qa.json`;
  const qa = await readTaskJson(root, path) as { pages: Array<{ slideId: string; sha256: string; requiredText: Array<{ text: string; present: boolean }> }> };
  qa.pages[1].sha256 = '0'.repeat(64);
  qa.pages[2].requiredText[0].text = '其他内容';
  await writeTaskJson(root, path, qa);
  let reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '保留内容与设计' });
  reply = await submitWork(root, reply, plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  let sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.ok(sample.pages[0].cached, 'the independently verified representative may be reused');
  reply = await generateFixture(root, reply);
  assert.equal((reply as any).details.callBudget, 2);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 2 });
  const deck = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(deck.pages.map(p => !!p.cached), [true, false, false]);

  // A legacy QA row bound to the wrong image must not authorize the sample either.
  const second = await readyDeck();
  const secondPrior = await readBatchJob(second.root, (await readTask(second.root)).activeJobId!);
  const secondPath = `generation/jobs/${secondPrior.jobId}/qa.json`;
  const secondQa = await readTaskJson(second.root, secondPath) as typeof qa;
  secondQa.pages[0].sha256 = '0'.repeat(64);
  await writeTaskJson(second.root, secondPath, secondQa);
  let secondReply = await decideTask(second.root, { decisionId: (await readTask(second.root)).pendingDecision!.id, action: 'revise-plan', instruction: '保留内容与设计' });
  secondReply = await submitWork(second.root, secondReply, second.plan);
  await decideTask(second.root, { decisionId: (await readTask(second.root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: second.plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  sample = await readBatchJob(second.root, (await readTask(second.root)).activeJobId!);
  assert.equal(sample.pages[0].cached, null);
});

test('a missing historical QA record cannot authorize sample reuse', async () => {
  const { root, plan } = await readyDeck();
  const prior = await readBatchJob(root, (await readTask(root)).activeJobId!);
  await unlink(join(root, `generation/jobs/${prior.jobId}/qa.json`));
  let reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '保留内容与设计' });
  reply = await submitWork(root, reply, plan);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.equal(sample.pages[0].cached, null);
});

test('historical pages without content-reference use evidence cannot be reused', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  const content = await fixtureImage(root, 'source/content-reference.png');
  plan.references = [{ ...content, role: 'content-reference' }];
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const originalSample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  reply = await generateFixture(root, reply);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 2 });
  const originalDeck = await readBatchJob(root, (await readTask(root)).activeJobId!);
  reply = await generateFixture(root, reply);
  const deckCheckpoint = await readBatchCheckpoint(root, originalDeck.jobId);
  reply = await submitWork(root, reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: deckCheckpoint.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture' })) });
  // The second page lacks proof of the content reference, while the sample and third page retain it.
  deckCheckpoint.pages[plan.slides[1].slideId].referencesUsed = [];
  const deckResult = await readTaskJson(root, `generation/jobs/${originalDeck.jobId}/result.json`) as { pages: Array<{ slideId: string; referencesUsed: string[] }> };
  deckResult.pages.find(p => p.slideId === plan.slides[1].slideId)!.referencesUsed = [];
  await writeTaskJson(root, `generation/jobs/${originalDeck.jobId}/checkpoint.json`, deckCheckpoint);
  await writeTaskJson(root, `generation/jobs/${originalDeck.jobId}/result.json`, deckResult);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '保留内容与设计' });
  reply = await submitWork(root, reply, plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.ok(sample.pages[0].cached);
  reply = await generateFixture(root, reply);
  assert.equal((reply as any).details.callBudget, 1);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 1 });
  const revised = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(revised.pages.map(p => !!p.cached), [true, false, true]);

  // A reused sample must also trace its actual source, not merely the cached deck row.
  const sampleCheckpoint = await readBatchCheckpoint(root, originalSample.jobId);
  sampleCheckpoint.pages[plan.representativeSlideId].referencesUsed = [];
  const sampleResult = await readTaskJson(root, `generation/jobs/${originalSample.jobId}/result.json`) as { pages: Array<{ referencesUsed: string[] }> };
  sampleResult.pages[0].referencesUsed = [];
  await writeTaskJson(root, `generation/jobs/${originalSample.jobId}/checkpoint.json`, sampleCheckpoint);
  await writeTaskJson(root, `generation/jobs/${originalSample.jobId}/result.json`, sampleResult);
  const priorDeck = await readBatchJob(root, originalDeck.jobId);
  const candidate = { ...sample, pages: sample.pages.map(p => ({ ...p, cached: null })) };
  // previous.json still addresses the original deck while this revision is in progress.
  const checked = await reuseCompletedPages(root, plan, candidate);
  assert.equal(priorDeck.styleLock.approvedSample?.path, originalSample.pages[0].target);
  assert.equal(checked.pages[0].cached, null);
});

for (const cached of [false, true]) test(`same-revision sample ${cached ? 'cached from earlier revision' : 'newly generated'} requires reference evidence before deck approval`, async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  const content = await fixtureImage(root, 'source/reference.png');
  plan.references = [{ ...content, role: 'content-reference' }];
  let reply = await submitWork(root, await continueTask(root), plan);
  reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const originalSample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  reply = await generateFixture(root, reply);
  if (cached) {
    reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 2 });
    reply = await generateFixture(root, reply);
    const checkpoint = await readBatchCheckpoint(root, (await readTask(root)).activeJobId!);
    reply = await submitWork(root, reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: checkpoint.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture' })) });
    reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'revise-plan', instruction: '保留内容与设计' });
    reply = await submitWork(root, reply, plan);
    reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
    assert.ok((await readBatchJob(root, (await readTask(root)).activeJobId!)).pages[0].cached);
    reply = await generateFixture(root, reply);
  }
  const path = `generation/jobs/${originalSample.jobId}`;
  const checkpoint = await readBatchCheckpoint(root, originalSample.jobId);
  const result = await readTaskJson(root, `${path}/result.json`) as { pages: Array<{ referencesUsed: string[] }> };
  checkpoint.pages[plan.representativeSlideId].referencesUsed = [];
  result.pages[0].referencesUsed = [];
  await writeTaskJson(root, `${path}/checkpoint.json`, checkpoint);
  await writeTaskJson(root, `${path}/result.json`, result);
  const current = await readTask(root);
  const resumed = await continueTask(root);
  assert.equal(resumed.kind, 'attention');
  if (resumed.kind !== 'attention') throw new Error('Expected recovery instructions');
  assert.match(resumed.reason, /参考图.*重新生成|重新生成.*参考图/);
  await assert.rejects(() => decideTask(root, { decisionId: current.pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 0 }), /参考图/);
  assert.equal((await readTask(root)).activeJobId, current.activeJobId);
  let recovered = await decideTask(root, { decisionId: current.pendingDecision!.id, action: 'revise-plan', instruction: '重新生成样页并确保参考图已使用' });
  recovered = await submitWork(root, recovered, plan);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  const nextSample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.equal(nextSample.pages[0].cached, null);
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
