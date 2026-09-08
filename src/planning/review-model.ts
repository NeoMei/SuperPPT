import type { PlanningContext } from './context.js';
import { submissionNote } from '../generation/image-intent.js';
import { selectStyleVariant } from '../styles/catalog.js';
import { compileSlidePrompt } from '../styles/prompt-compiler.js';
import type { PlanBundle } from '../workflow/contracts.js';

export type ReviewModel = {
  revision: string;
  decisionId: string;
  narrativeSummary: string;
  answers: PlanningContext['answers'];
  assumptions: string[];
  slides: Array<{
    id: string;
    number: number;
    title: string;
    coreMessage: string;
    requiredText: string[];
    relationships: string[];
    sourceRefs: string[];
    isSample: boolean;
  }>;
  variants: Record<string, { choice: string; prompt: string }>;
  references: Array<{ path: string; role: string }>;
  callBudget: 1;
  output: string;
};

export type ReviewNote = { label: string; text: string };

export function buildReviewModel(plan: PlanBundle, revision: string, decisionId: string): ReviewModel {
  const representative = plan.slides.find(slide => slide.slideId === plan.representativeSlideId)!;
  const note = submissionNote(plan.brief);
  const variants = Object.fromEntries(plan.styles.flatMap(style => style.tiers.flatMap(({ level }) =>
    style.palettes.map(palette => {
      const selected = selectStyleVariant(style, { level, paletteId: palette.id });
      const key = `${style.id}/${level}/${palette.id}`;
      return [
        key,
        {
          choice: `选择${style.name}，${level} 档，${palette.name}（${key}）`,
          prompt: `${compileSlidePrompt({ spec: representative, style: selected }).text}\n\n${note}`,
        },
      ];
    }))));
  const context = plan.context;

  return {
    revision,
    decisionId,
    narrativeSummary: context?.narrativeSummary.trim() || '未提供叙事摘要',
    answers: context?.answers.map(answer => ({ ...answer })) ?? [],
    assumptions: [...(context?.assumptions ?? [])],
    slides: [...plan.outline.slides].sort((a, b) => a.order - b.order).map(outlineSlide => {
      const slide = plan.slides.find(candidate => candidate.slideId === outlineSlide.id)!;
      return {
        id: outlineSlide.id,
        number: outlineSlide.order + 1,
        title: outlineSlide.title,
        coreMessage: slide.coreMessage,
        requiredText: [...slide.requiredText],
        relationships: [...slide.relationships],
        sourceRefs: [...slide.sourceRefs],
        isSample: outlineSlide.id === plan.representativeSlideId,
      };
    }),
    variants,
    references: plan.references.map(({ path, role }) => ({ path, role })),
    callBudget: 1,
    output: 'generation',
  };
}

export function reviewReply(model: ReviewModel, variantKey: string | null, notes: ReviewNote[]): string {
  const notesText = notes.filter(note => note.text.trim())
    .map(note => `${note.label}：${note.text.trim()}`).join('\n');
  const identity = `方案版本：${model.revision}\n决定编号：${model.decisionId}`;
  if (notesText) return `请修改方案，暂不生成样页。\n${identity}\n${notesText}`;
  if (!variantKey || !Object.hasOwn(model.variants, variantKey)) return '';
  return `确认当前内容方案并生成样页。\n${identity}\n${model.variants[variantKey]!.choice}\n授权新增生图调用：1 次。`;
}
