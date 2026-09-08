import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fixtureTask, fixturePlan, fixtureImage } from './helpers/fast-task.js';
import { repositorySourcePath } from './repository-source.js';

const run = promisify(execFile);
// The 12-page fixture is 180,083 bytes after adding 34 text-only prompt variants.
// A 220 KB ceiling retains 39,917 bytes (22%) of headroom while still catching
// accidental bitmap/data-URL packaging or unbounded duplication.
const MAX_TEXT_ONLY_REVIEW_HTML_BYTES = 220_000;
for (const n of [3, 12]) test(`public CLI ${n} pages: 8 commands, 3 decisions, one complete batch and byte-identical delivery`, async () => {
  const runtime = process.env.SUPERPPT_TEST_ROOT ?? await repositorySourcePath('.');
  const compiled = !process.env.SUPERPPT_TEST_ROOT && import.meta.url.includes('/dist/');
  const cli = join(runtime, compiled ? 'dist/src/cli.js' : 'src/cli.ts');
  const batch = await import(pathToFileURL(join(runtime, compiled ? 'dist/src/generation/task-batch.js' : 'src/generation/task-batch.ts')).href);
  const catalogModule = await import(pathToFileURL(join(runtime, compiled ? 'dist/src/styles/catalog.js' : 'src/styles/catalog.ts')).href);
  const fixture = await fixtureTask(), root = join(dirname(fixture.root), 'public-task'), plan = await fixturePlan(n);
  const catalog = await catalogModule.loadBuiltInStyleCatalog();
  assert.deepEqual(catalog.styles.map((style: any) => style.id), ['tactile', 'glass', 'ink', 'hand-drawn', 'textbook', 'collage', 'cinematic-tech', 'luxury-photo', 'blueprint', 'fantasy']);
  assert.equal(catalog.styles.filter((style: any) => style.showcase).length, 10);
  assert.doesNotMatch(JSON.stringify(catalog), /(?:\/Users\/|design-system-round|visualizations|design-session)/);
  const remoteModule = await import(pathToFileURL(join(runtime, compiled ? 'dist/src/styles/remote-assets.js' : 'src/styles/remote-assets.ts')).href);
  const remote = await remoteModule.loadRemoteStyleAssets(catalogModule.builtInStyleAssetsRoot());
  for (const style of catalog.styles) {
    assert.match(remote[style.showcase.path].url, /^https:\/\//);
  }
  plan.styles = catalog.styles;
  const source = join(dirname(root), 'source.json'), deps = join(dirname(root), 'roots.json');
  await writeFile(source, JSON.stringify({ title: 'CLI完整汇报', text: '测试原文' }));
  await writeFile(deps, JSON.stringify({ aiSkillRoot: fixture.ai, editableSkillRoot: fixture.editable }));
  let commands = 0, decisions = 0, batches = 0, requests = 0;
  async function command(action: string, flags: string[] = []) {
    commands++;
    // Match the declared minimum Node runtime: do not rely on newer syntax detection.
    return JSON.parse((await run(process.execPath, [...(compiled ? ['--no-experimental-detect-module'] : ['--import', 'tsx']), cli, action, '--project', root, ...flags], { cwd: runtime })).stdout);
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
  assert.equal(reply.kind, 'work');
  const planningRequest = JSON.parse(await readFile(join(root, reply.work.inputPath), 'utf8'));
  assert.equal(planningRequest.planningContextPath, `planning/${(await state()).contentRevision}/context.json`);
  const persistedContext = {
    schemaVersion: 1,
    narrativeSummary: `${n} 页方案围绕问题、方法与结论展开`,
    answers: [
      { key: 'audience', value: '产品评审组', kind: 'fact' },
      { key: 'goal', value: '批准试点', kind: 'preference' },
    ],
    assumptions: ['按十分钟汇报组织'],
  };
  await writeFile(join(root, planningRequest.planningContextPath), JSON.stringify(persistedContext));
  reply = await submit(reply, plan);
  assert.equal(reply.kind, 'decision');
  assert.equal(reply.details.contentRevision, (await state()).contentRevision);
  assert.equal(reply.details.planningContext.narrativeSummary, persistedContext.narrativeSummary);
  assert.deepEqual(reply.details.planningContext.answers, persistedContext.answers);
  assert.equal(reply.details.reviewModelPath, `planning/${reply.details.contentRevision}/review-model.json`);
  assert.equal(Object.hasOwn(reply.details, 'variants'), false, 'long prompts stay in the local review model/HTML, not CLI details');
  assert.equal(reply.details.selection.styles.length, 10);
  const reviewModel = JSON.parse(await readFile(join(root, reply.details.reviewModelPath), 'utf8'));
  assert.equal(reviewModel.revision, reply.details.contentRevision);
  assert.equal(reviewModel.decisionId, reply.id);
  assert.deepEqual(reviewModel.answers, persistedContext.answers);
  assert.equal(reviewModel.slides.length, n);
  assert.equal(reviewModel.slides.at(-1).number, n);
  const selector = await readFile(join(root, reply.details.selectionPath), 'utf8');
  assert.match(selector, /class="review-content"/);
  assert.equal((selector.match(/<article class="review-slide/g) ?? []).length, n);
  assert.match(selector, new RegExp(`方案版本：${reply.details.contentRevision}`));
  assert.match(selector, new RegExp(`决定编号：${reply.id}`));
  assert.equal((selector.match(/data-action="open-style"/g) ?? []).length, 10);
  assert.equal((selector.match(/class="style-button"[\s\S]*?<span class="media"><img src="https:\/\//g) ?? []).length, 10);
  assert.doesNotMatch(selector, /(?:src|href)="(?:previews|showcases)\//);
  assert.doesNotMatch(selector, /data:image/);
  assert.ok(Buffer.byteLength(selector) < MAX_TEXT_ONLY_REVIEW_HTML_BYTES, `selector is ${Buffer.byteLength(selector)} bytes`);
  const selected = n === 3 ? { styleId: 'collage', level: 3, paletteId: 'mid' } : { styleId: 'tactile', level: 2, paletteId: 'mid' };
  const persistedVariantPrompt = reviewModel.variants[`${selected.styleId}/${selected.level}/${selected.paletteId}`].prompt;
  reply = await decide(reply, 'select-style-and-generate-sample', { ...selected, callBudget: 1 });
  const sampleJob = await batch.readBatchJob(root, (await state()).activeJobId);
  assert.deepEqual({ styleId: sampleJob.styleLock.recipe.id, level: sampleJob.styleLock.recipe.level, paletteId: sampleJob.styleLock.recipe.paletteId }, selected);
  const firstSampleRequest = reply;
  assert.equal(firstSampleRequest.work.kind, 'generate-batch');
  const sampleJobBeforeRequest = await batch.readBatchJob(root, (await state()).activeJobId);
  const outgoingSample = await batch.beginRequest(root, sampleJobBeforeRequest.jobId, sampleJobBeforeRequest.pages[0].slideId);
  requests++;
  assert.equal(outgoingSample, persistedVariantPrompt);
  const samplePage = sampleJobBeforeRequest.pages[0];
  const sampleResultForSubmit = { slideId: samplePage.slideId, status: 'success', artifact: await fixtureImage(root, samplePage.target), raw: null, provider: 'fixture', channel: 'api', referencesUsed: [] };
  await batch.finishRequest(root, sampleJobBeforeRequest.jobId, sampleResultForSubmit);
  reply = await submit(firstSampleRequest, { jobId: sampleJobBeforeRequest.jobId, outcome: 'success', requestCount: (await batch.readBatchCheckpoint(root, sampleJobBeforeRequest.jobId)).requestCount, pages: [sampleResultForSubmit], routeSummary: ['fixture: no model calls'] });
  assert.equal(reply.details.callBudget, n - 1);
  const sampleResult = await batch.readBatchCheckpoint(root, sampleJob.jobId);
  reply = await decide(reply, 'approve-sample-and-generate-deck', { callBudget: reply.details.callBudget });
  const deckJob = await batch.readBatchJob(root, (await state()).activeJobId);
  assert.deepEqual(deckJob.styleLock.recipe, sampleJob.styleLock.recipe);
  assert.deepEqual(deckJob.styleLock.approvedSample, sampleResult.completed[plan.representativeSlideId]);
  assert.deepEqual(deckJob.pages.find((page: any) => page.slideId === plan.representativeSlideId)?.cached, sampleResult.completed[plan.representativeSlideId]);
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

test('public CLI preserves planning answers across resume and rejects an old plan authorization before one replay-safe current sample job', async () => {
  const runtime = process.env.SUPERPPT_TEST_ROOT ?? await repositorySourcePath('.');
  const compiled = !process.env.SUPERPPT_TEST_ROOT && import.meta.url.includes('/dist/');
  const cli = join(runtime, compiled ? 'dist/src/cli.js' : 'src/cli.ts');
  const batch = await import(pathToFileURL(join(runtime, compiled ? 'dist/src/generation/task-batch.js' : 'src/generation/task-batch.ts')).href);
  const fixture = await fixtureTask(), root = join(dirname(fixture.root), 'revision-public-task');
  const source = join(dirname(root), 'revision-source.json'), deps = join(dirname(root), 'revision-roots.json');
  await writeFile(source, JSON.stringify({ title: '修订恢复汇报', text: '保留问题、试点和结论。' }));
  await writeFile(deps, JSON.stringify({ aiSkillRoot: fixture.ai, editableSkillRoot: fixture.editable }));
  const command = async (action: string, flags: string[] = []) => JSON.parse((await run(process.execPath, [
    ...(compiled ? ['--no-experimental-detect-module'] : ['--import', 'tsx']), cli, action, '--project', root, ...flags,
  ], { cwd: runtime })).stdout);
  const state = async () => JSON.parse(await readFile(join(root, 'superppt.json'), 'utf8'));
  const submit = async (reply: any, payload: unknown) => {
    const resultPath = join(root, reply.work.resultPath);
    await writeFile(resultPath, JSON.stringify({ workId: reply.work.id, contentRevision: (await state()).contentRevision, payload }));
    return command('continue', ['--result', resultPath]);
  };
  const decide = async (decisionId: string, action: string, fields = {}) => {
    const input = join(dirname(root), 'revision-decision.json');
    await writeFile(input, JSON.stringify({ decisionId, action, ...fields }));
    return command('decide', ['--input', input]);
  };

  let planning = await command('start', ['--input', source, '--dependencies', deps]);
  const firstWorkId = planning.work.id;
  const requestA = JSON.parse(await readFile(join(root, planning.work.inputPath), 'utf8'));
  const savedContext = {
    schemaVersion: 1,
    narrativeSummary: '面向管理层说明问题、试点与投入决策',
    answers: [
      { key: 'audience', value: '管理层', kind: 'fact' },
      { key: 'goal', value: '批准试点', kind: 'preference' },
    ],
    assumptions: ['十分钟内完成'],
  };
  await writeFile(join(root, requestA.planningContextPath), JSON.stringify(savedContext));
  planning = await command('start', ['--input', source, '--dependencies', deps]);
  assert.equal(planning.work.id, firstWorkId);
  assert.deepEqual(JSON.parse(await readFile(join(root, requestA.planningContextPath), 'utf8')), savedContext);

  const planA = await fixturePlan(12);
  const reviewA = await submit(planning, planA);
  assert.deepEqual(reviewA.details.planningContext.answers, savedContext.answers);
  const decisionA = reviewA.id;
  const revisionA = reviewA.details.contentRevision;
  const idsA = planA.slides.map(slide => slide.slideId);
  planning = await decide(decisionA, 'revise-plan', { instruction: '只修改第 2 页结论，其他页面保持不变' });
  assert.equal(planning.kind, 'work');
  const requestB = JSON.parse(await readFile(join(root, planning.work.inputPath), 'utf8'));
  assert.notEqual((await state()).contentRevision, revisionA);
  assert.deepEqual(JSON.parse(await readFile(join(root, requestB.planningContextPath), 'utf8')), savedContext);
  const planB = structuredClone(planA);
  planB.slides[1].coreMessage = '第 2 页改为先给试点结论';
  planB.slides[1].requiredText = ['标题', '先批准小范围试点'];
  const reviewB = await submit(planning, planB);
  const idsB = planB.slides.map(slide => slide.slideId);
  assert.deepEqual(idsB, idsA);
  assert.equal(reviewB.details.planningContext.narrativeSummary, savedContext.narrativeSummary);
  const modelB = JSON.parse(await readFile(join(root, reviewB.details.reviewModelPath), 'utf8'));
  assert.equal(modelB.slides[1].coreMessage, '第 2 页改为先给试点结论');
  assert.deepEqual(modelB.slides.filter((_: unknown, index: number) => index !== 1).map((slide: any) => slide.id), idsA.filter((_, index) => index !== 1));

  const beforeOldAuthorization = await readFile(join(root, 'superppt.json'));
  await assert.rejects(
    () => decide(decisionA, 'select-style-and-generate-sample', { styleId: 'glass', level: 3, paletteId: 'cool', callBudget: 1 }),
    /Decision (?:already used for another action|is not current)/,
  );
  assert.deepEqual(await readFile(join(root, 'superppt.json')), beforeOldAuthorization);
  assert.equal((await state()).activeJobId, null);

  const currentApproval = { styleId: 'glass', level: 3, paletteId: 'cool', callBudget: 1 };
  const sampleWork = await decide(reviewB.id, 'select-style-and-generate-sample', currentApproval);
  assert.equal(sampleWork.work.kind, 'generate-batch');
  assert.equal((await state()).activeJobId, reviewB.id);
  const jobsRoot = join(root, 'generation/jobs');
  const generationEntries = (await readdir(jobsRoot)).filter(name => name !== '.DS_Store');
  assert.deepEqual(generationEntries, [reviewB.id]);
  const replay = await decide(reviewB.id, 'select-style-and-generate-sample', currentApproval);
  assert.equal(replay.work.id, sampleWork.work.id);
  assert.equal((await state()).activeJobId, reviewB.id);
  assert.deepEqual((await readdir(jobsRoot)).filter(name => name !== '.DS_Store'), [reviewB.id]);
  const sampleJob = await batch.readBatchJob(root, reviewB.id);
  const outgoing = await batch.beginRequest(root, sampleJob.jobId, sampleJob.pages[0].slideId);
  assert.equal(outgoing, modelB.variants['glass/3/cool'].prompt);
  assert.equal((await batch.readBatchCheckpoint(root, sampleJob.jobId)).requestCount, 1);
  const continued = await command('continue');
  assert.equal(continued.kind, 'attention');
  assert.match(continued.reason, /结果不明/);
  const approvalDuringFlight = await decide(reviewB.id, 'select-style-and-generate-sample', currentApproval);
  assert.equal(approvalDuringFlight.kind, 'attention');
  assert.equal((await batch.readBatchCheckpoint(root, sampleJob.jobId)).requestCount, 1);
});
