import { randomUUID } from 'node:crypto';
import { PlanBundleSchema, type PlanBundle, type WorkflowReply } from './contracts.js';
import { readArtifact, readTask, readTaskJson, writeTaskJson, updateTask, withTaskLock, hash, json } from '../project/task-store.js';
import { compileSlidePrompt } from '../styles/prompt-compiler.js';
import { builtInStyleAssetsRoot, selectStyleVariant } from '../styles/catalog.js';
import type { ResolvedStyle } from '../styles/schemas.js';
import { submissionNote } from '../generation/image-intent.js';
import { styleSelection } from '../styles/selection.js';
import { writeStyleSelectionView } from '../styles/selection-view.js';
import { taskPath } from '../project/task-store.js';

export const variantKey = (style: Pick<ResolvedStyle, 'id' | 'level' | 'paletteId'>) => `${style.id}/${style.level}/${style.paletteId}`;
export const samplePrompts = (plan: PlanBundle) => Object.fromEntries(plan.styles.flatMap(style =>
  style.tiers.flatMap(({ level }) => style.palettes.map(palette => {
    const selected = selectStyleVariant(style, { level, paletteId: palette.id });
    return [variantKey(selected), compileSlidePrompt({ spec: plan.slides.find(s => s.slideId === plan.representativeSlideId)!, style: selected }).text];
  }))));
export const selectionPath = (revision: string) => `planning/${revision}/style-selection.html`;
export const planDetails = (plan: PlanBundle, revision: string, publishedSelectionPath?: string) => ({
  planPath: `planning/${revision}/plan.json`,
  samplePromptsPath: `planning/${revision}/sample-prompts.json`,
  submissionNote: submissionNote(plan.brief),
  selectionOrder: ['styleId', 'level', 'paletteId'],
  previewBase: builtInStyleAssetsRoot(),
  styles: plan.styles.map(({id,name,tiers,palettes,previews}) => ({
    id, name, tiers: tiers.map(({level}) => ({level})),
    palettes: palettes.map(({id,name}) => ({id,name})), previews,
  })),
  selection: styleSelection(plan.styles),
  ...(publishedSelectionPath ? { selectionPath: publishedSelectionPath } : {}),
  samplePromptKey: 'styleId/level/paletteId',
  representativeSlideId: plan.representativeSlideId, references: plan.references,
  callBudget: 1, executor: 'ai-image-to-ppt', output: 'generation',
});
export function renderPlanReview(plan: PlanBundle, selectionAbsolutePath?: string): string {
  return [`${plan.brief.title} · ${plan.brief.targetSlides} 页`, `受众：${plan.brief.audience}；目标：${plan.brief.purpose}`,
    ...plan.outline.slides.map(s => { const detail = plan.slides.find(p => p.slideId === s.id)!; return `${s.order + 1}. ${s.title}：${detail.coreMessage}\n   内容关系：${detail.relationships.join('；')}\n   文字：${detail.requiredText.join('；')}`; }),
    `风格单选：${plan.styles.map(s => s.name).join(' / ')}`,
    selectionAbsolutePath ? `两轮选款页：[打开本地 HTML](<${selectionAbsolutePath}>)` : '',
    '选款顺序：风格 → 档位 → 配色；选择页面本身不会发送请求。回复明确元组后，在现有 plan-review 边界披露确切样页 prompt、预算 1 和输出位置，并确认生成样页。',
  ].join('\n');
}
export async function planReviewReply(root: string, plan: PlanBundle, revision: string, decisionId: string): Promise<WorkflowReply> {
  const path = selectionPath(revision);
  let absolutePath: string | undefined;
  try {
    await readArtifact(root, path, 16 * 1024 * 1024);
    absolutePath = await taskPath(root, path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { kind: 'decision', id: decisionId, stage: 'plan-review', view: renderPlanReview(plan, absolutePath), details: planDetails(plan, revision, absolutePath ? path : undefined) };
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
      if (!s.pendingDecision || s.pendingDecision.kind !== 'plan-review') throw new Error('Published plan review decision is missing');
      return planReviewReply(root, plan, s.contentRevision, s.pendingDecision.id);
    }
    await writeTaskJson(root, path, plan);
    await writeTaskJson(root, `planning/${s.contentRevision}/sample-prompts.json`, samplePrompts(plan));
    await writeStyleSelectionView(root, selectionPath(s.contentRevision), { title: plan.brief.title, purpose: plan.brief.purpose, audience: plan.brief.audience, selection: styleSelection(plan.styles) }, builtInStyleAssetsRoot());
    const next = await updateTask(root, state => ({ ...state, planPath: path, stage: 'plan-review', work: null, pendingDecision: state.pendingDecision ?? { id: randomUUID(), kind: 'plan-review' } }));
    return planReviewReply(root, plan, s.contentRevision, next.pendingDecision!.id);
  });
}
