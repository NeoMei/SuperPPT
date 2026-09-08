import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PlanningContextSchema,
  ensurePlanningContext,
  planningContextPath,
  readPlanningContext,
} from '../src/planning/context.js';
import { readTask, readTaskJson, writeTaskJson } from '../src/project/task-store.js';
import { PlanBundleSchema } from '../src/workflow/contracts.js';
import { continueTask } from '../src/workflow/continue.js';
import { decideTask } from '../src/workflow/decide.js';
import { publishPlan } from '../src/workflow/planning.js';
import { fixturePlan, fixtureTask } from './helpers/fast-task.js';

const revision = '00000000-0000-4000-8000-000000000099';
const context = {
  schemaVersion: 1 as const,
  narrativeSummary: '问题、试点、投入与决策',
  answers: [{ key: 'goal', value: '批准试点', kind: 'preference' as const }],
  assumptions: ['按十分钟口头汇报组织'],
};

test('planning context accepts current facts and preferences but rejects ambiguous answer records', () => {
  assert.deepEqual(PlanningContextSchema.parse(context), context);
  assert.equal(PlanningContextSchema.safeParse({
    ...context,
    answers: [...context.answers, ...context.answers],
  }).success, false);
  assert.equal(PlanningContextSchema.safeParse({
    ...context,
    answers: [{ key: 'revenue', value: '100', kind: 'guess' }],
  }).success, false);
});

test('context path is revision-scoped and a missing draft reads as an empty current context', async () => {
  const { root } = await fixtureTask();
  assert.equal(planningContextPath(revision), `planning/${revision}/context.json`);
  assert.deepEqual(await readPlanningContext(root, revision), {
    schemaVersion: 1,
    narrativeSummary: '',
    answers: [],
    assumptions: [],
  });
});

test('ensuring a context creates one draft and preserves later Agent updates', async () => {
  const { root } = await fixtureTask();
  const path = await ensurePlanningContext(root, revision);
  assert.equal(path, planningContextPath(revision));
  assert.deepEqual(await readPlanningContext(root, revision), {
    schemaVersion: 1,
    narrativeSummary: '',
    answers: [],
    assumptions: [],
  });

  await writeTaskJson(root, path, context);
  assert.equal(await ensurePlanningContext(root, revision), path);
  assert.deepEqual(await readPlanningContext(root, revision), context);
});

test('malformed JSON and invalid saved answers propagate instead of becoming empty context', async () => {
  const { root } = await fixtureTask();
  const path = planningContextPath(revision);
  await ensurePlanningContext(root, revision);
  await writeFile(join(root, path), '{broken json');
  await assert.rejects(() => readPlanningContext(root, revision), SyntaxError);

  await writeTaskJson(root, path, {
    ...context,
    answers: [...context.answers, ...context.answers],
  });
  await assert.rejects(() => readPlanningContext(root, revision));
});

test('legacy plans remain context-optional without adding a hash-changing default field', async () => {
  const legacy = await fixturePlan();
  const parsed = PlanBundleSchema.parse(legacy);
  assert.equal(Object.hasOwn(parsed, 'context'), false);
});

test('planning work exposes one durable context path and preserves Agent updates on resume', async () => {
  const { root } = await fixtureTask();
  let reply = await continueTask(root);
  assert.equal(reply.kind, 'work');
  if (reply.kind !== 'work') throw new Error('planning work expected');
  const request = await readTaskJson(root, reply.work.inputPath) as Record<string, unknown>;
  const state = await readTask(root);
  assert.equal(request.planningContextPath, planningContextPath(state.contentRevision));
  assert.deepEqual(await readPlanningContext(root, state.contentRevision), {
    schemaVersion: 1,
    narrativeSummary: '',
    answers: [],
    assumptions: [],
  });

  await writeTaskJson(root, request.planningContextPath as string, context);
  reply = await continueTask(root);
  assert.equal(reply.kind, 'work');
  assert.deepEqual(await readPlanningContext(root, state.contentRevision), context);
});

test('publication freezes the valid submitted or drafted context and replays against the published snapshot', async () => {
  const { root } = await fixtureTask();
  const state = await readTask(root);
  await writeTaskJson(root, planningContextPath(state.contentRevision), context);
  const candidate = await fixturePlan();
  await publishPlan(root, candidate);
  const published = PlanBundleSchema.parse(await readTaskJson(root, `planning/${state.contentRevision}/plan.json`));
  assert.deepEqual(published.context, context);

  const changedDraft = { ...context, narrativeSummary: '后来变化的草稿' };
  await writeTaskJson(root, planningContextPath(state.contentRevision), changedDraft);
  await publishPlan(root, candidate);
  assert.deepEqual(
    PlanBundleSchema.parse(await readTaskJson(root, `planning/${state.contentRevision}/plan.json`)).context,
    context,
  );

  await assert.rejects(
    () => publishPlan(root, { ...candidate, context: changedDraft }),
    /Published plan changed/,
  );
});

test('explicit context is validated and a revised content revision inherits the published context', async () => {
  const { root } = await fixtureTask();
  const candidate = await fixturePlan();
  const review = await publishPlan(root, { ...candidate, context });
  assert.equal(review.kind, 'decision');
  if (review.kind !== 'decision') throw new Error('plan review expected');
  const next = await decideTask(root, {
    decisionId: review.id,
    action: 'revise-plan',
    instruction: '调整第 2 页措辞',
  });
  assert.equal(next.kind, 'work');
  const revised = await readTask(root);
  assert.deepEqual(await readPlanningContext(root, revised.contentRevision), context);
  const request = await readTaskJson(root, next.kind === 'work' ? next.work.inputPath : '') as Record<string, unknown>;
  assert.equal(request.planningContextPath, planningContextPath(revised.contentRevision));

  await assert.rejects(() => publishPlan(root, {
    ...candidate,
    context: { ...context, answers: [{ key: 'revenue', value: '100', kind: 'guess' }] },
  }));
});
