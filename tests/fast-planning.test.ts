import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTask, fixturePlan } from './helpers/fast-task.js';
import { publishPlan, samplePrompts } from '../src/workflow/planning.js';
import { readTask, readTaskJson } from '../src/project/task-store.js';

test('combined planning has one decision and preserves page content and art direction', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  const first = await publishPlan(root, plan), second = await publishPlan(root, plan);
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'decision');
  for (const prompt of Object.values(samplePrompts(plan))) { assert.match(prompt, /标题/); assert.doesNotMatch(prompt, /canonical JSON/); }
});
test('planning publishes slides in declared order even when input array is shuffled', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  plan.outline.slides.reverse();
  await publishPlan(root, plan);
  const saved = await readTaskJson(root, (await readTask(root)).planPath!) as typeof plan;
  assert.deepEqual(saved.outline.slides.map(s => s.order), [0, 1, 2]);
});
test('missing page, duplicate page, or unknown representative cannot be published', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  await assert.rejects(publishPlan(root, { ...plan, slides: plan.slides.slice(1) }));
  await assert.rejects(publishPlan(root, { ...plan, slides: [plan.slides[0], plan.slides[0], plan.slides[2]] }));
  await assert.rejects(publishPlan(root, { ...plan, representativeSlideId: '00000000-0000-4000-8000-000000000000' }));
});
