import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTask, fixturePlan } from './helpers/fast-task.js';
import { generateFixture } from './helpers/fast-flow.js';
import { publishPlan } from '../src/workflow/planning.js';
import { decideTask } from '../src/workflow/decide.js';
import { readTask, readTaskJson } from '../src/project/task-store.js';
import { readBatchJob } from '../src/generation/task-batch.js';
import { loadBuiltInStyleCatalog } from '../src/styles/catalog.js';

function plan() {
  const ids = [1, 2, 3].map(i => '00000000-0000-4000-8000-00000000000' + i);
  return {
    brief: { schemaVersion: 1, title: '闭环', purpose: '反馈推动改进', audience: '产品团队', language: 'zh-CN', targetSlides: 3, mustCover: ['反馈'], constraints: [] },
    outline: { schemaVersion: 1, slides: ids.map((id, order) => ({ id, order, title: '标题', role: 'content', purpose: '解释', sourceRefs: ['source/original.md'] })) },
    slides: ids.map((slideId, i) => ({ schemaVersion: 1, slideId, title: '标题', role: 'content', coreMessage: '反馈推动改进', requiredText: ['标题', '完整内容' + i], relationships: ['收集到回访' + i], forbidden: [], sourceRefs: ['source/original.md'] })),
    representativeSlideId: ids[0], styles: [{
      id: 'glass', name: '玻璃',
      tiers: [1, 2, 3].map(level => ({ level, promptTemplate: '档' + level + '\n{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' })),
      palettes: [{ id: 'cool', name: '偏冷', prompt: '黑蓝 #0B1E2B' }, { id: 'warm', name: '偏暖', prompt: '杏橙' }],
      previews: [{ level: 3, paletteId: 'cool', path: 'previews/glass-3-cool.jpg' }],
    }],
  };
}
test('one plan decision exposes style then tier then palette and locks the chosen variant through sample and deck', async () => {
  const { root } = await fixtureTask();
  const review = await publishPlan(root, plan());
  assert.equal(review.kind, 'decision');
  if (review.kind !== 'decision') throw Error('decision expected');
  const details = review.details as any;
  assert.deepEqual(details.selectionOrder, ['styleId', 'level', 'paletteId']);
  assert.equal(details.styles[0].tiers[1].level, 2);
  const sampleWork = await decideTask(root, { decisionId: review.id, action: 'select-style-and-generate-sample', styleId: 'glass', level: 2, paletteId: 'cool', callBudget: 1 });
  const sample = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.equal(sample.styleLock.recipe.level, 2);
  assert.equal(sample.styleLock.recipe.paletteId, 'cool');
  assert.equal(sample.pages[0].prompt, '档2\n黑蓝 #0B1E2B\n收集到回访0\n标题\n完整内容0');
  const approved = await generateFixture(root, sampleWork);
  assert.equal(approved.kind, 'decision');
  const prompts = await readTaskJson(root, 'planning/' + sample.contentRevision + '/deck-prompts.json') as Record<string, string>;
  assert.equal(prompts[plan().slides[2].slideId], '档2\n黑蓝 #0B1E2B\n收集到回访2\n标题\n完整内容2');
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'approve-sample-and-generate-deck', callBudget: 3 });
  const deck = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual(deck.styleLock.recipe, sample.styleLock.recipe);
  assert.equal(deck.pages[0].prompt, sample.pages[0].prompt);
});
test('missing and invalid choices leave the current decision and generation state untouched', async () => {
  const { root } = await fixtureTask();
  const review = await publishPlan(root, plan());
  if (review.kind !== 'decision') throw Error('decision expected');
  const before = await readTask(root);
  for (const choice of [{}, { level: 4, paletteId: 'cool' }, { level: 1, paletteId: 'purple' }]) {
    await assert.rejects(decideTask(root, { decisionId: review.id, action: 'select-style-and-generate-sample', styleId: 'glass', callBudget: 1, ...choice }));
    assert.deepEqual(await readTask(root), before);
  }
});
test('collage 3/mid creates one immutable sample job while collage 1/cool leaves plan review untouched', async () => {
  const { root } = await fixtureTask();
  const candidate = await fixturePlan();
  candidate.styles = (await loadBuiltInStyleCatalog()).styles;
  candidate.slides[0]!.relationships = ['月球仓储与咖啡口味彼此独立'];
  candidate.slides[0]!.requiredText = ['标题', '无关内容仍须完整保留'];
  const review = await publishPlan(root, candidate);
  if (review.kind !== 'decision') throw new Error('decision expected');
  const before = await readTask(root);
  await assert.rejects(decideTask(root, { decisionId: review.id, action: 'select-style-and-generate-sample', styleId: 'collage', level: 1, paletteId: 'cool', callBudget: 1 }), /Unavailable creativity tier/);
  assert.deepEqual(await readTask(root), before);
  const work = await decideTask(root, { decisionId: review.id, action: 'select-style-and-generate-sample', styleId: 'collage', level: 3, paletteId: 'mid', callBudget: 1 });
  assert.equal(work.kind, 'work');
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.deepEqual({ id: job.styleLock.recipe.id, name: job.styleLock.recipe.name, level: job.styleLock.recipe.level, paletteId: job.styleLock.recipe.paletteId },
    { id: 'collage', name: '创意拼贴', level: 3, paletteId: 'mid' });
  assert.equal(job.callBudget, 1);
  assert.equal(job.pages.length, 1);
  assert.match(job.pages[0]!.prompt, /月球仓储与咖啡口味彼此独立/);
  assert.match(job.pages[0]!.prompt, /无关内容仍须完整保留/);
});
