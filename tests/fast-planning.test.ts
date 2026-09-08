import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTask, fixturePlan } from './helpers/fast-task.js';
import { publishPlan, samplePrompts, selectionPath } from '../src/workflow/planning.js';
import { readTask, readTaskJson, updateTask, writeTaskJson } from '../src/project/task-store.js';
import { taskReply, continueTask } from '../src/workflow/continue.js';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeStyleSelectionView } from '../src/styles/selection-view.js';
import { styleSelection } from '../src/styles/selection.js';

test('combined planning has one decision and preserves page content and art direction', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  const callerPlan = structuredClone(plan);
  const first = await publishPlan(root, plan), second = await publishPlan(root, plan);
  assert.deepEqual(first, second);
  assert.deepEqual(plan, callerPlan);
  assert.equal(first.kind, 'decision');
  for (const prompt of Object.values(samplePrompts(plan))) { assert.match(prompt, /标题/); assert.doesNotMatch(prompt, /canonical JSON/); }
});
test('published and resumed plan replies expose one usable selector without mutating task state', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  const published = await publishPlan(root, plan);
  assert.equal(published.kind, 'decision');
  if (published.kind !== 'decision') throw new Error('decision expected');
  const details = published.details as any;
  assert.equal(details.selection.styles.length, 10);
  assert.equal(details.selectionPath, `planning/${(await readTask(root)).contentRevision}/style-selection.html`);
  const selectorAbsolutePath = await realpath(join(root, details.selectionPath));
  assert.ok(published.view.includes(`<${selectorAbsolutePath}>`));
  assert.match(await readFile(join(root, details.selectionPath), 'utf8'), /选择创意拼贴，3 档，基准中线/);
  const before = await readTask(root);
  const resumed = await taskReply(root);
  assert.deepEqual(resumed, published);
  assert.deepEqual(await readTask(root), before);
  assert.equal(before.activeJobId, null);
  assert.equal((await readTask(root)).pendingDecision?.id, before.pendingDecision?.id);
});
test('default planning work explicitly requires the complete built-in catalog', async () => {
  const { root } = await fixtureTask();
  const work = await continueTask(root);
  assert.equal(work.kind, 'work');
  if (work.kind !== 'work') throw new Error('work expected');
  const request = await readTaskJson(root, work.work.inputPath) as { instructions: string };
  assert.match(request.instructions, /every built-in style/i);
  assert.match(request.instructions, /full catalog/i);
});
test('a custom style with an unavailable relative image still publishes with an explicit missing-reference card', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  plan.styles = [{
    id: 'custom', name: '自定义风格',
    tiers: [{ level: 3, promptTemplate: '{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' }],
    palettes: [{ id: 'mid', name: '基准中线', prompt: '自定义中线' }],
    previews: [{ level: 3, paletteId: 'mid', path: 'previews/custom-not-installed.jpg' }],
  }];
  const reply = await publishPlan(root, plan);
  assert.equal(reply.kind, 'decision');
  if (reply.kind !== 'decision') throw new Error('decision expected');
  const selectionPath = (reply.details as any).selectionPath;
  const html = await readFile(join(root, selectionPath), 'utf8');
  assert.match(html, /参考图路径缺失/);
  assert.match(html, /缺少该组合的精确预览 · 仍可选择/);
  assert.equal((reply.details as any).selection.styles[0].card.imageKind, 'variant-reference');
});
test('selector publication failure leaves the authoritative planning state unchanged', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  const before = await readTask(root);
  await mkdir(join(root, selectionPath(before.contentRevision)), { recursive: true });
  await assert.rejects(publishPlan(root, plan));
  assert.deepEqual(await readTask(root), before);
});
test('plan recovery validates the saved selector without rebuilding it after source assets change', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  plan.styles = [{
    id: 'custom', name: '固定选择器',
    tiers: [{ level: 3, promptTemplate: '{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' }],
    palettes: [{ id: 'mid', name: '基准中线', prompt: '固定' }],
    previews: [{ level: 3, paletteId: 'mid', path: 'previews/custom.jpg' }],
  }];
  const state = await readTask(root), planPath = `planning/${state.contentRevision}/plan.json`, htmlPath = selectionPath(state.contentRevision);
  const assetsRoot = join(root, 'source-assets');
  await mkdir(join(assetsRoot, 'previews'), { recursive: true });
  await writeFile(join(assetsRoot, 'previews/custom.jpg'), Buffer.from('first accepted asset'));
  await writeTaskJson(root, planPath, plan);
  await writeStyleSelectionView(root, htmlPath, { title: plan.brief.title, purpose: plan.brief.purpose, audience: plan.brief.audience, selection: styleSelection(plan.styles) }, assetsRoot);
  await updateTask(root, old => ({ ...old, stage: 'plan-review', planPath, work: null, pendingDecision: { id: '00000000-0000-4000-8000-000000000099', kind: 'plan-review' } }));
  const publishedHtml = await readFile(join(root, htmlPath));
  await writeFile(join(assetsRoot, 'previews/custom.jpg'), Buffer.from('changed asset after publication'));
  const before = await readTask(root);
  const reply = await taskReply(root);
  assert.equal(reply.kind, 'decision');
  assert.deepEqual(await readFile(join(root, htmlPath)), publishedHtml);
  assert.deepEqual(await readTask(root), before);
});
test('historical plan review without a selector remains read-only and uses text and native-image fallback', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  const state = await readTask(root), planPath = `planning/${state.contentRevision}/plan.json`;
  await writeTaskJson(root, planPath, plan);
  await updateTask(root, old => ({ ...old, stage: 'plan-review', planPath, work: null, pendingDecision: { id: '00000000-0000-4000-8000-000000000098', kind: 'plan-review' } }));
  const before = await readTask(root);
  const reply = await taskReply(root);
  assert.equal(reply.kind, 'decision');
  if (reply.kind !== 'decision') throw new Error('decision expected');
  assert.match(reply.view, /立体 \/ 玻璃 \/ 水墨 \/ 经典手绘/);
  assert.doesNotMatch(reply.view, /打开本地 HTML/);
  assert.equal('selectionPath' in (reply.details as object), false);
  assert.equal((reply.details as any).previewBase.endsWith(join('skills', 'superppt', 'assets', 'styles')), true);
  assert.deepEqual(await readTask(root), before);
});
test('a valid custom selector larger than 16 MiB remains recoverable after plan-review is committed', async () => {
  const { root } = await fixtureTask(), plan = await fixturePlan();
  const palettes = Array.from({ length: 40 }, (_, index) => ({ id: `tone-${index}`, name: `色板 ${index}`, prompt: `色板 ${index}` }));
  plan.styles = [{
    id: 'large-custom', name: '大型自定义选择器',
    tiers: [{ level: 3, promptTemplate: '{{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' }], palettes,
    previews: palettes.map(palette => ({ level: 3 as const, paletteId: palette.id, path: 'previews/large-custom.jpg' })),
  }];
  const state = await readTask(root), planPath = `planning/${state.contentRevision}/plan.json`, htmlPath = selectionPath(state.contentRevision);
  const assetsRoot = join(root, 'large-assets');
  await mkdir(join(assetsRoot, 'previews'), { recursive: true });
  await writeFile(join(assetsRoot, 'previews/large-custom.jpg'), Buffer.alloc(499_000, 65));
  await writeTaskJson(root, planPath, plan);
  await writeStyleSelectionView(root, htmlPath, { title: plan.brief.title, purpose: plan.brief.purpose, audience: plan.brief.audience, selection: styleSelection(plan.styles) }, assetsRoot);
  assert.ok((await stat(join(root, htmlPath))).size > 16 * 1024 * 1024);
  await updateTask(root, old => ({ ...old, stage: 'plan-review', planPath, work: null, pendingDecision: { id: '00000000-0000-4000-8000-000000000097', kind: 'plan-review' } }));
  const before = await readTask(root);
  const reply = await taskReply(root);
  assert.equal(reply.kind, 'decision');
  if (reply.kind !== 'decision') throw new Error('decision expected');
  assert.equal((reply.details as any).selectionPath, htmlPath);
  assert.deepEqual(await readTask(root), before);
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
