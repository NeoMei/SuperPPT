import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildReviewModel, reviewReply } from '../src/planning/review-model.js';
import { submissionNote } from '../src/generation/image-intent.js';
import { readTask, readTaskJson } from '../src/project/task-store.js';
import { selectStyleVariant } from '../src/styles/catalog.js';
import { compileSlidePrompt } from '../src/styles/prompt-compiler.js';
import { decideTask } from '../src/workflow/decide.js';
import { publishPlan } from '../src/workflow/planning.js';
import { fixturePlan, fixtureTask } from './helpers/fast-task.js';

const revision = '00000000-0000-4000-8000-000000000041';
const decisionId = '00000000-0000-4000-8000-000000000042';

test('review model projects the published slide order and custom style prompts without catalog substitution', async () => {
  const plan = await fixturePlan();
  const firstId = plan.outline.slides[0]!.id;
  const secondId = plan.outline.slides[1]!.id;
  plan.context = {
    schemaVersion: 1,
    narrativeSummary: '先解释问题，再给出试点决定',
    answers: [{ key: 'goal', value: '批准试点', kind: 'preference' }],
    assumptions: ['按十分钟口头汇报组织'],
  };
  plan.slides.find(slide => slide.slideId === firstId)!.requiredText = ['首页标题', '不得截断的完整长文'];
  plan.slides.find(slide => slide.slideId === secondId)!.requiredText = ['第二页完整文案'];
  plan.outline.slides.reverse();
  plan.styles = [{
    id: 'customer-style', name: '客户自定义风格',
    tiers: [
      { level: 1, promptTemplate: '一档 {{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' },
      { level: 3, promptTemplate: '三档 {{PALETTE}}\n{{CONTENT_RELATIONSHIPS}}\n{{SLIDE_COPY}}' },
    ],
    palettes: [
      { id: 'mid', name: '基准中线', prompt: '中性灰蓝' },
      { id: 'warm', name: '暖色版', prompt: '暖色棕红' },
    ],
    previews: [],
  }];

  const model = buildReviewModel(plan, revision, decisionId);

  assert.equal(model.revision, revision);
  assert.equal(model.decisionId, decisionId);
  assert.equal(model.narrativeSummary, '先解释问题，再给出试点决定');
  assert.deepEqual(model.answers, plan.context.answers);
  assert.deepEqual(model.assumptions, plan.context.assumptions);
  assert.deepEqual(model.slides.map(slide => [slide.number, slide.id]), [
    [1, firstId],
    [2, secondId],
    [3, plan.outline.slides.find(slide => slide.order === 2)!.id],
  ]);
  assert.deepEqual(model.slides[0]!.requiredText, ['首页标题', '不得截断的完整长文']);
  assert.deepEqual(model.slides.map(slide => slide.isSample), [true, false, false]);
  assert.deepEqual(Object.keys(model.variants), [
    'customer-style/1/mid',
    'customer-style/1/warm',
    'customer-style/3/mid',
    'customer-style/3/warm',
  ]);
  assert.match(model.variants['customer-style/3/warm']!.choice, /客户自定义风格.*3 档.*暖色版/);
  assert.match(model.variants['customer-style/3/warm']!.choice, /customer-style\/3\/warm/);
  assert.doesNotMatch(JSON.stringify(model.variants), /立体|glass/);

  for (const [key, variant] of Object.entries(model.variants)) {
    const [, levelText, paletteId] = key.split('/');
    const style = selectStyleVariant(plan.styles[0]!, {
      level: Number(levelText) as 1 | 2 | 3,
      paletteId,
    });
    const expected = compileSlidePrompt({ spec: plan.slides[0]!, style }).text
      + '\n\n' + submissionNote(plan.brief);
    assert.equal(variant.prompt, expected);
  }
  assert.deepEqual(model.references, plan.references.map(({ path, role }) => ({ path, role })));
  assert.equal(model.callBudget, 1);
  assert.equal(model.output, 'generation');
});

test('review model represents missing planning context without inventing a confirmed conclusion', async () => {
  const plan = await fixturePlan();
  const model = buildReviewModel(plan, revision, decisionId);
  assert.equal(model.narrativeSummary, '未提供叙事摘要');
  assert.deepEqual(model.answers, []);
  assert.deepEqual(model.assumptions, []);
});

test('review reply authorizes only a valid complete variant and binds its revision, decision and budget', async () => {
  const model = buildReviewModel(await fixturePlan(), revision, decisionId);
  const variantKey = Object.keys(model.variants)[0]!;

  assert.equal(reviewReply(model, null, []), '');
  assert.equal(reviewReply(model, 'missing/2/mid', []), '');

  const revisionRequest = reviewReply(model, variantKey, [
    { label: '整体方案', text: '  收紧结论  ' },
    { label: '第 2 页', text: '   ' },
  ]);
  assert.equal(revisionRequest,
    `请修改方案，暂不生成样页。\n方案版本：${revision}\n决定编号：${decisionId}\n整体方案：收紧结论`);
  assert.doesNotMatch(revisionRequest, /确认当前内容方案|授权新增生图调用/);

  assert.equal(reviewReply(model, variantKey, []),
    `确认当前内容方案并生成样页。\n方案版本：${revision}\n决定编号：${decisionId}\n${model.variants[variantKey]!.choice}\n授权新增生图调用：1 次。`);
});

test('published review details and compact fallback share the current decision identity and planning context', async () => {
  const { root } = await fixtureTask();
  const plan = await fixturePlan();
  plan.context = {
    schemaVersion: 1,
    narrativeSummary: '从问题到试点决策',
    answers: [{ key: 'audience', value: '管理层', kind: 'fact' }],
    assumptions: ['不展开技术细节'],
  };

  const reply = await publishPlan(root, plan);
  assert.equal(reply.kind, 'decision');
  if (reply.kind !== 'decision') throw new Error('plan review expected');
  const state = await readTask(root);
  const details = reply.details as any;
  assert.equal(reply.id, state.pendingDecision?.id);
  assert.equal(details.contentRevision, state.contentRevision);
  assert.equal(details.reviewModelPath, `planning/${state.contentRevision}/review-model.json`);
  const publishedModel = await readTaskJson(root, details.reviewModelPath) as any;
  assert.equal(publishedModel.decisionId, reply.id);
  assert.equal(publishedModel.revision, state.contentRevision);
  assert.deepEqual(details.planningContext, {
    narrativeSummary: plan.context.narrativeSummary,
    answers: plan.context.answers,
    assumptions: plan.context.assumptions,
  });
  assert.match(reply.view, /完整方案/);
  assert.match(reply.view, /图片可能需要联网加载/);
  assert.match(reply.view, /普通选款不等于授权生成/);
  assert.match(reply.view, /不得截断| 文字：/);
});

test('published review HTML keeps complete ordered content and safely labels every local note field', async () => {
  const { root } = await fixtureTask();
  const plan = await fixturePlan();
  const ordered = [...plan.outline.slides].sort((a, b) => a.order - b.order);
  const longCopy = `不得截断的完整长文案 ${'内容'.repeat(180)}`;
  ordered[0]!.title = '首页 <img id="forged-title">';
  ordered[1]!.title = '第二页 </textarea><script id="forged-note">';
  plan.slides.find(slide => slide.slideId === ordered[0]!.id)!.requiredText = [longCopy];
  plan.slides.find(slide => slide.slideId === ordered[1]!.id)!.requiredText = ['</script><script id="forged-copy">'];
  plan.context = {
    schemaVersion: 1,
    narrativeSummary: '先核对事实，再确认试点',
    answers: [
      { key: '受众', value: '管理层', kind: 'fact' },
      { key: '语气', value: '克制', kind: 'preference' },
    ],
    assumptions: ['十分钟内完成'],
  };
  plan.references = [
    { path: 'references/art.png', sha256: 'a'.repeat(64), role: 'art-direction' },
    { path: 'source/original.md', sha256: 'b'.repeat(64), role: 'content-reference' },
  ];

  const reply = await publishPlan(root, plan);
  assert.equal(reply.kind, 'decision');
  if (reply.kind !== 'decision') throw new Error('plan review expected');
  const relativePath = (reply.details as any).selectionPath as string;
  const rendered = await readFile(join(root, relativePath), 'utf8');

  assert.match(rendered, /整体方案/);
  assert.match(rendered, /已确认事实/);
  assert.match(rendered, /用户偏好/);
  assert.match(rendered, /关键假设/);
  assert.match(rendered, /样页/);
  assert.match(rendered, /> 3 页<\/span>/);
  assert.match(rendered, /<dt>画风参考<\/dt>/);
  assert.match(rendered, /<dt>内容参考<\/dt>/);
  assert.match(rendered, new RegExp(longCopy));
  assert.ok(rendered.indexOf('<h1>效率测试</h1>') < rendered.indexOf('id="review-title"'));
  assert.ok(rendered.indexOf('id="review-title"') < rendered.indexOf('id="styles-view"'));
  assert.ok(rendered.indexOf('id="styles-view"') < rendered.indexOf('id="confirmation-title"'));
  assert.match(rendered, /新增生图预算：1 次/);
  assert.match(rendered, /输出位置：generation/);
  assert.match(rendered, /复制后发送给 Agent 才会执行/);
  assert.ok(rendered.indexOf('首页 &lt;img') < rendered.indexOf('第二页 &lt;/textarea'));
  assert.equal((rendered.match(/<textarea[^>]+data-review-note/g) ?? []).length, 4);
  assert.equal((rendered.match(/<button[^>]+data-action="choose"/g) ?? []).length, 34);
  assert.equal((rendered.match(/data-variant-key=/g) ?? []).length, 34);
  assert.equal((rendered.match(/缺少该组合的精确预览 · 仍可选择/g) ?? []).length, 3);
  assert.doesNotMatch(rendered, /<img id="forged-title">/);
  assert.doesNotMatch(rendered, /<script id="forged-(?:note|copy)">/);
  assert.match(rendered, /\\u003c\/script>/);
});

type FakeListener = (event: { target: FakeElement }) => void | Promise<void>;

class FakeElement {
  readonly listeners = new Map<string, FakeListener[]>();
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  textContent = '';
  value = '';
  selected = false;
  focused = false;
  readOnly = false;
  childButton: FakeElement | null = null;

  constructor(readonly tagName = 'DIV') {}
  addEventListener(type: string, listener: FakeListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) await listener({ target: this });
  }
  closest(selector: string) { return selector.startsWith('button') && this.tagName === 'BUTTON' ? this : null; }
  querySelector(selector: string) { return selector === 'button' ? this.childButton : null; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  remove() {}
}

class FakeDocument {
  readonly listeners = new Map<string, FakeListener[]>();
  readonly ids = new Map<string, FakeElement>();
  notes: FakeElement[] = [];
  panels: FakeElement[] = [];
  variants: FakeElement[] = [];
  legacyCopyResult = false;
  body = { append: (_element: FakeElement) => {} };

  getElementById(id: string) { return this.ids.get(id) ?? null; }
  querySelectorAll(selector: string) {
    if (selector === '[data-review-note]') return this.notes;
    if (selector === '[data-style-panel]') return this.panels;
    if (selector === '[data-action="choose"]') return this.variants;
    return [];
  }
  addEventListener(type: string, listener: FakeListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async click(target: FakeElement) {
    await target.dispatch('click');
    for (const listener of this.listeners.get('click') ?? []) await listener({ target });
  }
  createElement(tagName: string) { return new FakeElement(tagName.toUpperCase()); }
  execCommand(command: string) { return command === 'copy' && this.legacyCopyResult; }
}

function reviewDom(variantKeys: string[]) {
  const document = new FakeDocument();
  for (const id of ['styles-view', 'choice', 'copy-confirm', 'copy-revision', 'action-status', 'manual-reply', 'selected-prompt', 'selected-prompt-text']) {
    document.ids.set(id, new FakeElement(id.startsWith('copy-') ? 'BUTTON' : id === 'manual-reply' ? 'TEXTAREA' : 'DIV'));
  }
  document.ids.get('manual-reply')!.hidden = true;
  document.ids.get('selected-prompt')!.hidden = true;
  const note = new FakeElement('TEXTAREA');
  note.dataset.noteLabel = '第 2 页「</script>&」';
  document.notes = [note];
  const firstPanelButton = new FakeElement('BUTTON');
  const panel = new FakeElement();
  panel.dataset.stylePanel = 'tactile';
  panel.hidden = true;
  panel.childButton = firstPanelButton;
  document.panels = [panel];
  document.ids.set('style-tactile', panel);
  const variants = variantKeys.map(key => {
    const variant = new FakeElement('BUTTON');
    variant.dataset.action = 'choose';
    variant.dataset.variantKey = key;
    return variant;
  });
  document.variants = variants;
  return { document, note, variants };
}

test('generated review script gates mutually exclusive replies and exposes the complete reply after clipboard failure', async () => {
  const { root } = await fixtureTask();
  const plan = await fixturePlan();
  const reply = await publishPlan(root, plan);
  assert.equal(reply.kind, 'decision');
  if (reply.kind !== 'decision') throw new Error('plan review expected');
  const details = reply.details as any;
  const rendered = await readFile(join(root, details.selectionPath), 'utf8');
  const source = rendered.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(source, 'generated HTML must contain an executable interaction script');
  const model = await readTaskJson(root, details.reviewModelPath) as ReturnType<typeof buildReviewModel>;
  const keys = Object.keys(model.variants);
  const { document, note, variants } = reviewDom(keys.slice(0, 2));
  const copied: string[] = [];
  const clipboardWrites: string[] = [];
  let clipboardMode: 'success' | 'fail' | 'defer' | 'defer-fail' = 'success';
  let resolveClipboard: (() => void) | undefined;
  const navigator = { clipboard: { writeText: async (text: string) => {
    clipboardWrites.push(text);
    if (clipboardMode === 'fail') throw new Error('clipboard denied');
    if (clipboardMode === 'defer' || clipboardMode === 'defer-fail') await new Promise<void>(resolve => { resolveClipboard = resolve; });
    if (clipboardMode === 'defer-fail') throw new Error('clipboard denied');
    copied.push(text);
  } } };
  vm.runInNewContext(source, { document, navigator, console });

  const confirm = document.getElementById('copy-confirm')!;
  const revise = document.getElementById('copy-revision')!;
  assert.equal(confirm.disabled, true);
  assert.equal(revise.disabled, true);

  const rawStyle = new FakeElement('BUTTON');
  rawStyle.dataset.action = 'open-style';
  rawStyle.dataset.styleId = 'tactile';
  await document.click(rawStyle);
  assert.equal(confirm.disabled, true);
  assert.deepEqual(copied, []);

  const firstVariant = variants[0]!;
  firstVariant.dataset.choice = 'forged display choice';
  await document.click(firstVariant);
  assert.equal(confirm.disabled, false);
  assert.equal(revise.disabled, true);
  await document.click(revise);
  assert.deepEqual(copied, []);
  assert.equal(document.getElementById('choice')!.textContent, model.variants[keys[0]!]!.choice);
  assert.equal(document.getElementById('selected-prompt-text')!.textContent, model.variants[keys[0]!]!.prompt);

  const secondVariant = variants[1]!;
  await document.click(secondVariant);
  assert.equal(document.getElementById('selected-prompt-text')!.textContent, model.variants[keys[1]!]!.prompt);

  note.value = '  收紧 <结论> & 保留数字  ';
  await note.dispatch('input');
  assert.equal(confirm.disabled, true);
  assert.equal(revise.disabled, false);
  await document.click(confirm);
  assert.deepEqual(copied, []);
  await document.click(revise);
  assert.equal(copied.length, 1);
  assert.equal(copied[0], reviewReply(model, keys[1]!, [{ label: note.dataset.noteLabel!, text: note.value }]));
  assert.doesNotMatch(copied[0]!, /授权新增生图调用/);

  note.value = '';
  await note.dispatch('input');
  assert.equal(confirm.disabled, false);
  assert.equal(revise.disabled, true);
  clipboardMode = 'defer-fail';
  resolveClipboard = undefined;
  const failedCopy = document.click(confirm);
  await Promise.resolve();
  assert.equal(note.readOnly, true);
  assert.equal(firstVariant.disabled, true);
  assert.equal(secondVariant.disabled, true);
  assert.equal(confirm.disabled, true);
  assert.equal(revise.disabled, true);
  assert.match(document.getElementById('action-status')!.textContent, /正在复制/);
  const finishFailedClipboard = resolveClipboard;
  assert.ok(finishFailedClipboard);
  (finishFailedClipboard as () => void)();
  await failedCopy;
  const manual = document.getElementById('manual-reply')!;
  const expected = reviewReply(model, keys[1]!, []);
  assert.equal(manual.hidden, false);
  assert.equal(manual.value, expected);
  assert.equal(manual.selected, true);
  assert.match(manual.value, new RegExp(model.revision));
  assert.match(manual.value, new RegExp(model.decisionId));
  assert.match(manual.value, /授权新增生图调用：1 次/);
  assert.equal(note.readOnly, false);
  assert.equal(firstVariant.disabled, false);
  assert.equal(secondVariant.disabled, false);
  assert.equal(confirm.disabled, false);

  note.value = '新的修改意见';
  await note.dispatch('input');
  assert.equal(manual.hidden, true);
  assert.equal(manual.value, '');
  assert.equal(confirm.disabled, true);
  await document.click(confirm);
  assert.equal(manual.hidden, true);

  note.value = '';
  await note.dispatch('input');
  clipboardMode = 'defer';
  resolveClipboard = undefined;
  const frozenReply = reviewReply(model, keys[1]!, []);
  const writesBefore = clipboardWrites.length;
  const pendingCopy = document.click(confirm);
  await Promise.resolve();
  assert.equal(note.readOnly, true);
  assert.equal(firstVariant.disabled, true);
  assert.equal(secondVariant.disabled, true);
  assert.equal(confirm.disabled, true);
  assert.equal(revise.disabled, true);
  await document.click(firstVariant);
  await document.click(confirm);
  await document.click(revise);
  assert.equal(clipboardWrites.length, writesBefore + 1);
  assert.equal(document.getElementById('choice')!.textContent, model.variants[keys[1]!]!.choice);
  const finishClipboard = resolveClipboard;
  assert.ok(finishClipboard);
  (finishClipboard as () => void)();
  await pendingCopy;
  assert.equal(copied.at(-1), frozenReply);
  assert.equal(note.readOnly, false);
  assert.equal(firstVariant.disabled, false);
  assert.equal(secondVariant.disabled, false);
  assert.equal(confirm.disabled, false);
  assert.equal(revise.disabled, true);
  assert.equal(manual.hidden, true);
  assert.equal(manual.value, '');
  assert.match(document.getElementById('action-status')!.textContent, /已复制/);
});

test('a decision copied from an older plan review cannot authorize the revised plan', async () => {
  const { root } = await fixtureTask();
  const planA = await fixturePlan();
  const reviewA = await publishPlan(root, planA);
  assert.equal(reviewA.kind, 'decision');
  if (reviewA.kind !== 'decision') throw new Error('first plan review expected');

  await decideTask(root, {
    decisionId: reviewA.id,
    action: 'revise-plan',
    instruction: '收紧第 2 页结论',
  });
  const planB = structuredClone(planA);
  planB.brief.title = '效率测试 B';
  const reviewB = await publishPlan(root, planB);
  assert.equal(reviewB.kind, 'decision');
  if (reviewB.kind !== 'decision') throw new Error('second plan review expected');
  assert.notEqual(reviewB.id, reviewA.id);

  const reviewAModel = await readTaskJson(root, (reviewA.details as any).reviewModelPath) as any;
  const variantKey = Object.keys(reviewAModel.variants)[0]!;
  const [styleId, level, paletteId] = variantKey.split('/');
  await assert.rejects(() => decideTask(root, {
    decisionId: reviewA.id,
    action: 'select-style-and-generate-sample',
    styleId,
    level: Number(level),
    paletteId,
    callBudget: 1,
  }), /Decision (?:is not current|already used for another action)/);
  assert.equal((await readTask(root)).activeJobId, null);
  assert.equal((await readTask(root)).pendingDecision?.id, reviewB.id);
});
