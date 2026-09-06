import { randomUUID } from 'node:crypto';
import { PlanBundleSchema, type PlanBundle, type WorkflowReply } from './contracts.js';
import { readTask, readTaskJson, writeTaskJson, updateTask, withTaskLock, hash, json } from '../project/task-store.js';
import { compileSlidePrompt } from '../styles/prompt-compiler.js';
import { builtInStyleAssetsRoot, selectStyleVariant } from '../styles/catalog.js';
import type { ResolvedStyle } from '../styles/schemas.js';
import { submissionNote } from '../generation/image-intent.js';

export const variantKey = (style: Pick<ResolvedStyle, 'id' | 'level' | 'paletteId'>) => `${style.id}/${style.level}/${style.paletteId}`;
export const samplePrompts = (plan: PlanBundle) => Object.fromEntries(plan.styles.flatMap(style =>
  style.tiers.flatMap(({ level }) => style.palettes.map(palette => {
    const selected = selectStyleVariant(style, { level, paletteId: palette.id });
    return [variantKey(selected), compileSlidePrompt({ spec: plan.slides.find(s => s.slideId === plan.representativeSlideId)!, style: selected }).text];
  }))));
export const planDetails = (plan: PlanBundle, revision: string) => ({
  planPath: `planning/${revision}/plan.json`,
  samplePromptsPath: `planning/${revision}/sample-prompts.json`,
  submissionNote: submissionNote(plan.brief),
  selectionOrder: ['styleId', 'level', 'paletteId'],
  previewBase: builtInStyleAssetsRoot(),
  styles: plan.styles.map(({id,name,tiers,palettes,previews}) => ({
    id, name, tiers: tiers.map(({level}) => ({level})),
    palettes: palettes.map(({id,name}) => ({id,name})), previews,
  })),
  samplePromptKey: 'styleId/level/paletteId',
  representativeSlideId: plan.representativeSlideId, references: plan.references,
  callBudget: 1, executor: 'ai-image-to-ppt', output: 'generation',
});
export function renderPlanReview(plan: PlanBundle): string {
  return [`${plan.brief.title} · ${plan.brief.targetSlides} 页`, `受众：${plan.brief.audience}；目标：${plan.brief.purpose}`,
    ...plan.outline.slides.map(s => { const detail = plan.slides.find(p => p.slideId === s.id)!; return `${s.order + 1}. ${s.title}：${detail.coreMessage}\n   内容关系：${detail.relationships.join('；')}\n   文字：${detail.requiredText.join('；')}`; }),
    `风格单选：${plan.styles.map(s => s.name).join(' / ')}`,
    '选款顺序：风格 → 档位 → 配色；查看已有预览，确认这一组选项并生成样页（一次外部生图调用）。',
  ].join('\n');
}
export async function publishPlan(root: string, raw: unknown): Promise<WorkflowReply> {
  return withTaskLock(root, async () => {
    const plan = PlanBundleSchema.parse(raw), s = await readTask(root);
    plan.outline.slides.sort((a, b) => a.order - b.order);
    if (s.stage !== 'planning' && s.stage !== 'plan-review') throw new Error('Plan cannot be changed at this stage; request a revision first');
    const path = `planning/${s.contentRevision}/plan.json`;
    if (s.planPath) {
      const old = await readTaskJson(root, s.planPath);
      if (hash(json(old)) !== hash(json(plan))) throw new Error('Published plan changed; request a revision');
    }
    await writeTaskJson(root, path, plan);
    await writeTaskJson(root, `planning/${s.contentRevision}/sample-prompts.json`, samplePrompts(plan));
    const next = await updateTask(root, state => ({ ...state, planPath: path, stage: 'plan-review', work: null, pendingDecision: state.pendingDecision ?? { id: randomUUID(), kind: 'plan-review' } }));
    return { kind: 'decision', id: next.pendingDecision!.id, stage: 'plan-review', view: renderPlanReview(plan), details: planDetails(plan, s.contentRevision) };
  });
}
