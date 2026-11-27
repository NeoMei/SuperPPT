import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixturePlan, fixtureTask } from './helpers/fast-task.js';
import { repositorySourcePath } from './repository-source.js';

test('chat plan review remains selectable when installed remote asset metadata is malformed', async t => {
  const runtime = process.env.SUPERPPT_TEST_ROOT ?? await repositorySourcePath('.');
  const compiled = !process.env.SUPERPPT_TEST_ROOT && import.meta.url.includes('/dist/');
  const temporary = await mkdtemp(join(runtime, '.chat-plan-review-assets-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourceDirectory = join(runtime, compiled ? 'dist/src' : 'src');
  const copiedSource = join(temporary, compiled ? 'dist/src' : 'src');
  await cp(sourceDirectory, copiedSource, { recursive: true });
  const assets = join(temporary, 'skills/superppt/assets/styles');
  await mkdir(assets, { recursive: true });
  await cp(join(runtime, 'skills/superppt/assets/styles/catalog.json'), join(assets, 'catalog.json'));
  await writeFile(join(assets, 'remote-assets.json'), '{ malformed');

  const load = (module: string) => import(pathToFileURL(join(copiedSource, `${module}.${compiled ? 'js' : 'ts'}`)).href);
  const { buildReviewModel } = await load('planning/review-model');
  const { planReviewReply, reviewModelPath } = await load('workflow/planning');
  const { writeTaskJson } = await load('project/task-store');
  const { root } = await fixtureTask();
  const plan = await fixturePlan();
  const revision = '00000000-0000-4000-8000-000000000041';
  const decisionId = '00000000-0000-4000-8000-000000000042';
  await writeTaskJson(root, reviewModelPath(revision), buildReviewModel(plan, revision, decisionId));

  process.env.SUPERPPT_CHAT_INTERACTIONS = '1';
  try {
    const reply = await planReviewReply(root, plan, revision, decisionId);
    assert.equal(reply.kind, 'decision');
    if (reply.kind !== 'decision') throw new Error('plan review expected');
    assert.match(reply.view, /ImageChoice\("选择风格"/);
    assert.match(reply.view, /glass/);
    assert.doesNotMatch(reply.view, /https:\/\/g\.imgtg\.com/);
  } finally {
    delete process.env.SUPERPPT_CHAT_INTERACTIONS;
  }
});
