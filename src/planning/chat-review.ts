import type { ReviewModel } from './review-model.js';
import { reviewReply } from './review-model.js';
import type { StyleSelection } from '../styles/selection.js';
import type { RemoteStyleAssets } from '../styles/remote-assets.js';

export const chatInteractionEnabled = (environment: NodeJS.ProcessEnv): boolean => environment.SUPERPPT_CHAT_INTERACTIONS === '1';

const quoted = JSON.stringify;
const block = (definitions: string[]): string => ['```openui-lang', ...definitions, '```'].join('\n');
const identity = (model: ReviewModel): string => `方案版本：${model.revision}\n决定编号：${model.decisionId}`;
const button = (label: string, decision: string): string => `Button(${quoted(label)}, "primary", ${quoted(decision)})`;
export function chatPlanReview(model: ReviewModel, selection: StyleSelection, remote: RemoteStyleAssets, htmlLink?: string): string {
  const overall = block([
    'root = Stack([overall])',
    `overall = Card(${quoted('整体调整')}, [${button('填写整体修改意见', 'overall')}])`,
  ]);
  const slides = model.slides.map(slide => `Button(${quoted(`第 ${slide.number} 页「${slide.title}」`)}, "secondary", ${quoted(`review-slide:${slide.number}`)})`);
  const slideChoice = block([
    'root = Stack([slides])',
    `slides = Card(${quoted('需要修改哪一页？')}, [${slides.join(', ')}, ${button('内容无须修改', 'content-ready')}])`,
  ]);
  const options = selection.styles.map(style => {
    const path = style.card.imagePath;
    const image = path && Object.hasOwn(remote, path) ? remote[path]!.url : undefined;
    return `  {label: ${quoted(`选择${style.name}（${style.id}）`)}, caption: ${quoted(style.name)}${image ? `, image: ${quoted(image)}` : ''}}`;
  });
  const styles = block([
    'root = Stack([styles])',
    'styles = ImageChoice("选择风格", [',
    options.join(',\n'),
    `], ${quoted('点击图片选择风格；下一步选择档位和配色')})`,
  ]);
  const answers = model.answers.length
    ? model.answers.map(answer => `${answer.key}（${answer.kind}）：${answer.value}`).join('\n') : '无额外回答';
  const assumptions = model.assumptions.length ? model.assumptions.join('\n') : '无额外假设';
  const references = model.references.length
    ? model.references.map(reference => `${reference.path}（${reference.role}）`).join('\n') : '无额外参考文件';
  const planningContext = [
    `事实与偏好\n${answers}`,
    `可见假设\n${assumptions}`,
    `参考文件\n${references}`,
    `输出位置：${model.output}；预算：${model.callBudget} 次生图调用。`,
  ].join('\n\n');
  return [
    `${model.narrativeSummary}\n\n需要修改内容，或先选择风格。缺图时回复卡片所附的风格 ID。`,
    htmlLink ?? '',
    block([
      'root = Stack([identity, context, review])',
      `identity = KeyValue([{label: "方案版本", value: ${quoted(model.revision)}}, {label: "决定编号", value: ${quoted(model.decisionId)}}])`,
      `context = Details("查看规划上下文与生成边界", [Text(${quoted(planningContext)})])`,
      `review = Details("查看完整内容方案", [Text(${quoted(model.slides.map(slide => `### ${slide.number}. ${slide.title}\n${slide.coreMessage}\n\n完整文字\n${slide.requiredText.join('\n\n')}\n\n内容关系\n${slide.relationships.join('；')}\n\n来源\n${slide.sourceRefs.join('；')}`).join('\n\n'))})])`,
    ]),
    overall,
    slideChoice,
    styles,
  ].join('\n\n');
}

export function chatSlideComment(model: ReviewModel, pageNumber: number | number[] | 'overall'): string {
  const pages = pageNumber === 'overall' ? [] : Array.isArray(pageNumber) ? pageNumber : [pageNumber];
  const selected = pages.map(number => {
    const slide = model.slides.find(item => item.number === number);
    if (!slide) throw new Error('Unknown slide');
    return slide;
  });
  if (pageNumber === 'overall') selected.push({
    id: '', number: 0, title: '整体方案', coreMessage: model.narrativeSummary, requiredText: [], relationships: [], sourceRefs: [], isSample: false,
  });
  const fields = selected.map(slide => {
    const label = slide.number === 0 ? '整体方案修改意见' : `第 ${slide.number} 页「${slide.title}」修改意见`;
    const field = `请修改方案，暂不生成样页。\n${identity(model)}\n${label}`;
    return `Input(${quoted(field)}, ${quoted(field)}, ${quoted('写下需要修改的内容')}, true)`;
  });
  const content = selected.map(slide => slide.number === 0
    ? `整体方案\n${slide.coreMessage}`
    : `${slide.number}. ${slide.title}\n${slide.coreMessage}\n完整文字：${slide.requiredText.join('\n')}\n内容关系：${slide.relationships.join('；')}\n来源：${slide.sourceRefs.join('；')}`).join('\n\n');
  return [
    content,
    block([
      'root = Stack([comment])',
      `comment = Card(${quoted(selected.length === 1 && selected[0]!.number > 0 ? `第 ${selected[0]!.number} 页修改意见` : '填写修改意见')}, [${fields.join(', ')}, ${button(selected.length === 1 && selected[0]!.number > 0 ? '提交本页意见' : '提交修改意见', 'slide-comment')}])`,
    ]),
  ].join('\n\n');
}

export function chatStyleVariants(model: ReviewModel, selection: StyleSelection, styleId: string, remote: RemoteStyleAssets, selectedKey?: string): string {
  const style = selection.styles.find(item => item.id === styleId);
  if (!style) throw new Error('Unknown style');
  if (selectedKey !== undefined) {
    const available = style.groups.some(group => group.variants.some(variant =>
      `${variant.styleId}/${variant.level}/${variant.paletteId}` === selectedKey));
    const variant = Object.hasOwn(model.variants, selectedKey) ? model.variants[selectedKey] : undefined;
    if (!available || !variant) throw new Error('Unknown variant');
    const referencePurpose = variant.catalogReference || model.references.some(reference => reference.role === 'art-direction')
      ? '参考图用途：画风参考图仅用于视觉风格，保持材质、平面或立体表现、光影、配色比例与字体质感。'
      : '参考图用途：无额外参考图。';
    return [
      reviewReply(model, selectedKey, []),
      `样页内容 prompt（${selectedKey}）\n\n${variant.prompt}`,
      referencePurpose,
      `输出位置：${model.output}；预算：${model.callBudget} 次生图调用。`,
    ].join('\n\n');
  }
  const options = style.groups.flatMap(group => group.variants.map(variant => {
    const key = `${variant.styleId}/${variant.level}/${variant.paletteId}`;
    const answer = reviewReply(model, key, []);
    const image = variant.previewPath && Object.hasOwn(remote, variant.previewPath) ? remote[variant.previewPath]!.url : undefined;
    const caption = `${variant.level} 档 · ${variant.paletteName}${image ? '' : ' · 缺少精确预览'}`;
    return `  {label: ${quoted(`${answer}\n授权新增生图调用：1 次。`)}, caption: ${quoted(caption)}${image ? `, image: ${quoted(image)}` : ''}}`;
  }));
  const optionsText = style.groups.flatMap(group => group.variants.map(variant => `${variant.styleId}/${variant.level}/${variant.paletteId}`)).join('；');
  const content = [
    `已选择${style.name}。确认某个档位与配色组合即授权 1 次样页生图。`,
    '选择后展示该组合的完整提示词、参考图用途和输出位置，再按本次授权生成样页。',
    `缺图时使用文字回复精确元组：${optionsText}。`,
    block([
      'root = Stack([variants])',
      'variants = ImageChoice("确认风格组合", [',
      options.join(',\n'),
      `], ${quoted('点击组合即确认风格并授权 1 次样页生图')})`,
    ]),
  ].join('\n\n');
  return content;
}
