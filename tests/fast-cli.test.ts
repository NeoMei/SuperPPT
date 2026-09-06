import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { repositorySourcePath } from './repository-source.js';

const run = promisify(execFile);
for (const n of [3, 12]) test(`public CLI ${n} pages: 8 commands, 3 decisions, one complete batch and byte-identical delivery`, async () => {
  const runtime = process.env.SUPERPPT_TEST_ROOT ?? await repositorySourcePath('.');
  const compiled = !process.env.SUPERPPT_TEST_ROOT && import.meta.url.includes('/dist/');
  const cli = join(runtime, compiled ? 'dist/src/cli.js' : 'src/cli.ts');
  const batch = await import(pathToFileURL(join(runtime, compiled ? 'dist/src/generation/task-batch.js' : 'src/generation/task-batch.ts')).href);
  const fixture = await fixtureTask(), root = join(dirname(fixture.root), 'public-task'), plan = await fixturePlan(n);
  const source = join(dirname(root), 'source.json'), deps = join(dirname(root), 'roots.json');
  await writeFile(source, JSON.stringify({ title: 'CLI完整汇报', text: '测试原文' }));
  await writeFile(deps, JSON.stringify({ aiSkillRoot: fixture.ai, editableSkillRoot: fixture.editable }));
  let commands = 0, decisions = 0, batches = 0, requests = 0;
  async function command(action: string, flags: string[] = []) {
    commands++;
    return JSON.parse((await run(process.execPath, [...(compiled ? [] : ['--import', 'tsx']), cli, action, '--project', root, ...flags], { cwd: runtime })).stdout);
  }
  const state = async () => JSON.parse(await readFile(join(root, 'superppt.json'), 'utf8'));
  async function submit(reply: any, payload: unknown) {
    const path = join(root, reply.work.resultPath);
    await writeFile(path, JSON.stringify({ workId: reply.work.id, contentRevision: (await state()).contentRevision, payload }));
    return command('continue', ['--result', path]);
  }
  async function decide(reply: any, action: string, fields = {}) {
    assert.equal(reply.kind, 'decision'); decisions++;
    const path = join(dirname(root), 'decision.json');
    await writeFile(path, JSON.stringify({ decisionId: reply.id, action, ...fields }));
    return command('decide', ['--input', path]);
  }
  async function generate(reply: any) {
    assert.equal(reply.work.kind, 'generate-batch');
    const job = await batch.readBatchJob(root, (await state()).activeJobId);
    if (job.kind === 'deck') batches++;
    const pages = [];
    for (const page of job.pages) {
      if (page.cached) {
        pages.push({ slideId: page.slideId, status: 'cached', artifact: page.cached, raw: null, provider: null, channel: null, referencesUsed: [] });
        continue;
      }
      const outgoing = await batch.beginRequest(root, job.jobId, page.slideId);
      requests++;
      assert.ok(outgoing.startsWith(page.prompt + '\n\n'));
      assert.ok(outgoing.includes('实际用途：解释任务'));
      assert.ok(outgoing.includes('面向受众：用户'));
      const result = { slideId: page.slideId, status: 'success', artifact: await fixtureImage(root, page.target), raw: null, provider: 'fixture', channel: 'api', referencesUsed: [] };
      await batch.finishRequest(root, job.jobId, result); pages.push(result);
    }
    return submit(reply, { jobId: job.jobId, outcome: 'success', requestCount: (await batch.readBatchCheckpoint(root, job.jobId)).requestCount, pages, routeSummary: ['fixture: no model calls'] });
  }
  let reply = await command('start', ['--input', source, '--dependencies', deps]);
  reply = await submit(reply, plan);
  reply = await decide(reply, 'select-style-and-generate-sample', { styleId: plan.styles[0].id, level: 2, paletteId: 'mid', callBudget: 1 });
  reply = await generate(reply);
  assert.equal(reply.details.callBudget, n - 1);
  reply = await decide(reply, 'approve-sample-and-generate-deck', { callBudget: reply.details.callBudget });
  reply = await generate(reply);
  const s = await state(), cp = await batch.readBatchCheckpoint(root, s.activeJobId);
  reply = await submit(reply, { pages: plan.slides.map(p => ({ slideId: p.slideId, sha256: cp.completed[p.slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture only' })) });
  const current = (await state()).currentDeck;
  reply = await decide(reply, 'confirm-delivery');
  assert.equal(reply.kind, 'done'); assert.equal(commands, 8); assert.equal(decisions, 3); assert.equal(batches, 1);
  assert.deepEqual(await readFile(join(root, reply.deck.relativePath)), await readFile(join(root, current.relativePath)));
  const checkpoints = await batch.readBatchCheckpoint(root, s.activeJobId);
  assert.equal(checkpoints.requestCount, n - 1);
  assert.equal(requests, n);
  for (const old of ['approve', 'preflight', 'admit-image-call']) {
    await assert.rejects(() => command(old));
  }
  const before = await readFile(join(root, 'superppt.json'));
  await assert.rejects(() => command('continue', ['--unknown', '1']));
  assert.deepEqual(await readFile(join(root, 'superppt.json')), before);
});
