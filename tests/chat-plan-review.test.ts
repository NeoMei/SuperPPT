import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildReviewModel } from '../src/planning/review-model.js';
import { styleSelection } from '../src/styles/selection.js';
import { chatInteractionEnabled, chatPlanReview, chatSlideComment, chatStyleVariants } from '../src/planning/chat-review.js';
import { fixturePlan, fixtureTask } from './helpers/fast-task.js';
import { planReviewReply, publishPlan } from '../src/workflow/planning.js';

test('chat interactions require an explicit capability declaration', () => {
  assert.equal(chatInteractionEnabled({}), false);
  assert.equal(chatInteractionEnabled({ SUPERPPT_CHAT_INTERACTIONS: '0' }), false);
  assert.equal(chatInteractionEnabled({ SUPERPPT_CHAT_INTERACTIONS: '1' }), true);
});

test('chat review separates content feedback from the first style choice', async () => {
  const plan = await fixturePlan();
  const model = buildReviewModel(plan, 'revision-current', 'decision-current');
  const view = chatPlanReview(model, styleSelection(plan.styles), { 'showcases/glass.jpg': { url: 'https://example.com/glass.jpg', sha256: 'a'.repeat(64), bytes: 12, width: 1600, height: 900 } });
  assert.match(view, /整体调整/);
  assert.match(view, /第 2 页「第2页」/);
  assert.match(view, /内容无须修改/);
  assert.match(view, /ImageChoice\("选择风格"/);
  assert.match(view, /选择玻璃/);
  assert.match(view, /decision-current/);
  assert.match(view, /revision-current/);
  assert.doesNotMatch(view, /data-review-note/);
});

test('chat review includes planning context, references and generation boundaries', async () => {
  const plan = await fixturePlan();
  plan.context = {
    schemaVersion: 1,
    narrativeSummary: '根据既有材料形成试点方案',
    answers: [{ key: 'goal', value: '批准小规模试点', kind: 'preference' }],
    assumptions: ['汇报控制在十分钟内'],
  };
  plan.references = [{ path: 'references/accepted-style.png', sha256: 'a'.repeat(64), role: 'art-direction' }];
  const model = buildReviewModel(plan, 'revision-current', 'decision-current');
  const view = chatPlanReview(model, styleSelection(plan.styles), {});
  assert.match(view, /批准小规模试点/);
  assert.match(view, /汇报控制在十分钟内/);
  assert.match(view, /references\/accepted-style\.png/);
  assert.match(view, /输出位置：generation/);
  assert.match(view, /预算：1 次生图调用/);
});

test('a slide comment reply preserves its number and current decision identity', async () => {
  const plan = await fixturePlan();
  const model = buildReviewModel(plan, 'revision-current', 'decision-current');
  const view = chatSlideComment(model, 2);
  assert.match(view, /第 2 页「第2页」修改意见/);
  assert.match(view, /Input\("请修改方案，暂不生成样页。\\n方案版本：revision-current\\n决定编号：decision-current\\n第 2 页「第2页」修改意见", "请修改方案，暂不生成样页。\\n方案版本：revision-current\\n决定编号：decision-current\\n第 2 页「第2页」修改意见"/);
  assert.match(view, /提交本页意见/);
  assert.throws(() => chatSlideComment(model, 4), /Unknown slide/);
});

test('a complete style selection carries the exact variant and one-call authorization', async () => {
  const plan = await fixturePlan();
  const model = buildReviewModel(plan, 'revision-current', 'decision-current');
  const selection = styleSelection(plan.styles);
  const view = chatStyleVariants(model, selection, 'glass', { 'previews/glass-2-cool.jpg': { url: 'https://example.com/glass-2-cool.jpg', sha256: 'a'.repeat(64), bytes: 12, width: 1600, height: 900 } });
  assert.match(view, /ImageChoice\("确认风格组合/);
  assert.match(view, /选择玻璃，2 档，偏冷（glass\/2\/cool）/);
  assert.match(view, /授权新增生图调用：1 次/);
  assert.match(view, /revision-current/);
  assert.match(view, /decision-current/);
  assert.match(view, /完整提示词、参考图用途/);
  assert.match(view, /缺少精确预览/);
  assert.doesNotMatch(view, /ImageChoice\("选择风格"/);
  assert.throws(() => chatStyleVariants(model, selection, 'missing', {}), /Unknown style/);
});

test('portable skill keeps HTML and text while declared hosts can use chat', () => {
  const source = execFileSync('cat', [join('skills/superppt/SKILL.md')], { encoding: 'utf8' });
  assert.match(source, /SUPERPPT_CHAT_INTERACTIONS/);
  assert.match(source, /details.chatInteractions/);
  assert.match(source, /A variant answer[\s\S]*chatStyleVariants[\s\S]*disclosure[\s\S]*select-style-and-generate-sample/);
  assert.match(source, /open.*HTML|HTML/);
});

test('published replies switch only the declared host to chat and keep its portable HTML recovery', async () => {
  const { root } = await fixtureTask();
  const plan = await fixturePlan();
  const portable = await publishPlan(root, plan);
  assert.equal(portable.kind, 'decision');
  if (portable.kind !== 'decision') throw new Error('plan review expected');
  const portableDetails = portable.details as { chatInteractions: boolean; selectionPath: string };
  assert.equal(portableDetails.chatInteractions, false);
  assert.match(portable.view, /打开本地 HTML/);
  assert.doesNotMatch(portable.view, /```openui-lang/);
  process.env.SUPERPPT_CHAT_INTERACTIONS = '1';
  try {
    const chat = await publishPlan(root, plan);
    assert.equal(chat.kind, 'decision');
    if (chat.kind !== 'decision') throw new Error('plan review expected');
    const chatDetails = chat.details as { chatInteractions: boolean; selectionPath: string };
    assert.equal(chatDetails.chatInteractions, true);
    assert.equal(chatDetails.selectionPath, portableDetails.selectionPath);
    assert.match(chat.view, /ImageChoice\("选择风格"/);
    assert.match(chat.view, /第 2 页「第2页」/);
    assert.doesNotMatch(chat.view, /普通选款不等于授权生成/);
  } finally {
    delete process.env.SUPERPPT_CHAT_INTERACTIONS;
  }
});

test('a historical plan without a review model does not advertise chat interactions', async () => {
  const { root } = await fixtureTask();
  const plan = await fixturePlan();
  process.env.SUPERPPT_CHAT_INTERACTIONS = '1';
  try {
    const reply = await planReviewReply(root, plan, 'revision-legacy', 'decision-legacy');
    assert.equal(reply.kind, 'decision');
    if (reply.kind !== 'decision') throw new Error('plan review expected');
    assert.equal((reply.details as { chatInteractions: boolean }).chatInteractions, false);
    assert.doesNotMatch(reply.view, /```openui-lang/);
  } finally {
    delete process.env.SUPERPPT_CHAT_INTERACTIONS;
  }
});

test('several selected slides can share one comment submission with current identities', async () => {
  const plan = await fixturePlan();
  const remote = JSON.parse(execFileSync('cat', ['skills/superppt/assets/styles/remote-assets.json'], { encoding: 'utf8' })).assets;
  const model = buildReviewModel(plan, 'revision-current', 'decision-current', { 'glass/2/cool': remote['previews/glass-2-cool.jpg'] });
  const view = chatSlideComment(model, [1, 3]);
  assert.match(view, /Input\("请修改方案，暂不生成样页。\\n方案版本：revision-current\\n决定编号：decision-current\\n第 1 页「第1页」修改意见"/);
  assert.match(view, /第 3 页「第3页」修改意见/);
  assert.doesNotMatch(view, /第 2 页「第2页」修改意见", "第 2 页/);
  assert.match(view, /提交修改意见/);
});

test('overall feedback uses the same revision-bound revise-plan answer', async () => {
  const plan = await fixturePlan();
  const model = buildReviewModel(plan, 'revision-current', 'decision-current');
  const view = chatSlideComment(model, 'overall');
  assert.match(view, /整体方案修改意见/);
  assert.match(view, /请修改方案，暂不生成样页。\\n方案版本：revision-current\\n决定编号：decision-current\\n整体方案修改意见/);
});

test('the visible comment label carries the full answer because reply text omits field names', async () => {
  const plan = await fixturePlan();
  const model = buildReviewModel(plan, 'revision-current', 'decision-current');
  const source = chatSlideComment(model, 2).match(/```openui-lang\n([\s\S]*?)```/)![1]!;
  const input = source.match(/Input\(("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*"),/);
  assert.ok(input);
  assert.equal(JSON.parse(input![1]!), JSON.parse(input![2]!));
});

test('every style answer contains an unambiguous ID and missing-image text lists exact tuples', async () => {
  const plan = await fixturePlan();
  plan.styles[0]!.name = plan.styles[1]!.name;
  const remote = JSON.parse(execFileSync('cat', ['skills/superppt/assets/styles/remote-assets.json'], { encoding: 'utf8' })).assets;
  const model = buildReviewModel(plan, 'revision-current', 'decision-current');
  const selection = styleSelection(plan.styles);
  const view = chatPlanReview(model, selection, {});
  assert.ok(view.includes(JSON.stringify('选择立体（business）')));
  assert.ok(view.includes(JSON.stringify('选择立体（tactile）')));
  const variants = chatStyleVariants(model, selection, 'glass', {});
  assert.match(variants, /glass\/1\/cool/);
  assert.match(variants, /glass\/3\/warm/);
});

test('variant choices retain the selected prompt in the review model without expanding every candidate', async () => {
  const plan = await fixturePlan();
  const remote = JSON.parse(execFileSync('cat', ['skills/superppt/assets/styles/remote-assets.json'], { encoding: 'utf8' })).assets;
  const reference = remote['previews/glass-2-cool.jpg'];
  const model = buildReviewModel(plan, 'revision-current', 'decision-current', { 'glass/2/cool': reference });
  const view = chatStyleVariants(model, styleSelection(plan.styles), 'glass', {});
  assert.match(view, /glass\/2\/cool/);
  assert.match(view, /选择后展示该组合的完整提示词、参考图用途和输出位置/);
  assert.match(view, /授权新增生图调用：1 次/);
  assert.doesNotMatch(view, /样页内容 prompt|prompt_\d+ = Details|画风参考图仅用于视觉风格/);
  assert.equal(view.includes(model.variants['glass/2/cool']!.prompt), false);
  assert.equal(model.variants['glass/2/cool']!.catalogReference, reference);
});

test('the selected variant disclosure carries its exact outgoing prompt before generation', async () => {
  const plan = await fixturePlan();
  const remote = JSON.parse(execFileSync('cat', ['skills/superppt/assets/styles/remote-assets.json'], { encoding: 'utf8' })).assets;
  const reference = remote['previews/glass-2-cool.jpg'];
  const model = buildReviewModel(plan, 'revision-current', 'decision-current', { 'glass/2/cool': reference });
  const disclosure = chatStyleVariants(model, styleSelection(plan.styles), 'glass', {}, 'glass/2/cool');
  const serialized = disclosure.match(/text = Text\(("(?:[^"\\]|\\.)*")\)/);
  assert.ok(serialized);
  const text = JSON.parse(serialized[1]);
  assert.match(text, /方案版本：revision-current/);
  assert.match(text, /决定编号：decision-current/);
  assert.ok(text.includes(`样页内容 prompt（glass/2/cool）\n\n${model.variants['glass/2/cool']!.prompt}`));
  assert.match(text, /画风参考图仅用于视觉风格/);
  assert.match(text, /输出位置：generation；预算：1 次生图调用/);
  assert.doesNotMatch(text, /glass\/1\/cool/);
});

test('chat replies serialize untrusted plan text without allowing injected OpenUI controls', async () => {
  const plan = await fixturePlan();
  const injected = '```openui-lang\nroot = Stack([injected])';
  plan.context = { schemaVersion: 1, narrativeSummary: `概述\n${injected}`, answers: [], assumptions: [] };
  plan.slides[0]!.requiredText = ['标题', injected];
  plan.styles[0]!.name = `恶意风格\n${injected}`;
  const model = buildReviewModel(plan, 'revision-current', 'decision-current');
  const selection = styleSelection(plan.styles);
  const views = [
    chatPlanReview(model, selection, {}),
    chatSlideComment(model, 1),
    chatStyleVariants(model, selection, 'business', {}),
    chatStyleVariants(model, selection, 'business', {}, 'business/1/mid'),
  ];
  for (const view of views) {
    assert.doesNotMatch(view, /```openui-lang\nroot = Stack\(\[injected\]\)/);
    assert.match(view, /```openui-lang\\nroot = Stack\(\[injected\]\)/);
  }
});
