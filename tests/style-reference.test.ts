import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { submitWork, generateFixture } from './helpers/fast-flow.js';
import { continueTask } from '../src/workflow/continue.js';
import { decideTask } from '../src/workflow/decide.js';
import { readTask } from '../src/project/task-store.js';
import { readBatchJob, beginRequest, finishRequest } from '../src/generation/task-batch.js';
import { generationReferences } from '../src/generation/style-reference.js';

test('selected preview is locked for sample; approved sample replaces it for the deck', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  await submitWork(root, await continueTask(root), plan);
  let reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: 'tactile', level: 3, paletteId: 'mid', callBudget: 1 });
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  const refs = generationReferences(job);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, 'art-direction');
  assert.match(refs[0].url!, /^https:\/\/g\.imgtg\.com\//);
  assert.equal(job.styleLock.catalogReference?.path, 'previews/tactile-3-mid.jpg');
  reply = await generateFixture(root, reply);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 2 });
  const deck = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(generationReferences(deck).map(r => r.sha256), [deck.styleLock.approvedSample!.sha256]);
});

test('successful result cannot silently omit the selected style reference', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  await submitWork(root, await continueTask(root), plan);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: 'tactile', level: 3, paletteId: 'mid', callBudget: 1 });
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!), page = job.pages[0];
  const prompt = await beginRequest(root, job.jobId, page.slideId);
  assert.ok(prompt.startsWith(page.prompt));
  assert.match(prompt, /材质/);
  const artifact = await fixtureImage(root, page.target);
  await assert.rejects(finishRequest(root, job.jobId, { slideId: page.slideId, status: 'success', artifact, provider: 'doubao', channel: 'api', referencesUsed: [] }), /reference/i);
});

test('reference download verifies registered bytes, caches locally, and rejects corruption before a request', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  await submitWork(root, await continueTask(root), plan);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'select-style-and-generate-sample', styleId: 'tactile', level: 3, paletteId: 'mid', callBudget: 1 });
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  const file = await fixtureImage(root, 'fixture.png');
  const { readArtifact, hash } = await import('../src/project/task-store.js');
  const { prepareGenerationReferences } = await import('../src/generation/style-reference.js');
  const bytes = await readArtifact(root, file.path);
  job.styleLock.catalogReference = { ...job.styleLock.catalogReference!, sha256: hash(bytes), bytes: bytes.length, width: 160, height: 90 };
  let calls = 0;
  const fetchImage = (async () => { calls++; return new Response(new Uint8Array(bytes)); }) as typeof fetch;
  const refs = await prepareGenerationReferences(root, job, fetchImage);
  assert.equal(refs.length, 1);
  assert.deepEqual(await readArtifact(root, refs[0].path), bytes);
  await prepareGenerationReferences(root, job, fetchImage);
  assert.equal(calls, 1);
  const bad = structuredClone(job); bad.styleLock.catalogReference!.sha256 = 'a'.repeat(64);
  await assert.rejects(prepareGenerationReferences(root, bad, fetchImage), /digest/);
  bad.styleLock.catalogReference!.bytes = 1;
  await assert.rejects(prepareGenerationReferences(root, bad, fetchImage), /size/);
  const { readBatchCheckpoint } = await import('../src/generation/task-batch.js');
  assert.equal((await readBatchCheckpoint(root, job.jobId)).requestCount, 0);
});

test('custom recipe never inherits a built-in reference by reusing its id', async () => {
  const { selectedCatalogReference } = await import('../src/generation/style-reference.js');
  const plan = await fixturePlan(), style = plan.styles.find(s => s.id === 'tactile')!;
  style.tiers[0].promptTemplate += '\nCustom visual direction';
  assert.equal(await selectedCatalogReference(style, { level: 3, paletteId: 'mid' }), undefined);
});
