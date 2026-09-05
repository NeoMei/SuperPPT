import { randomUUID } from 'node:crypto';
import { PlanBundleSchema, type PlanBundle, type WorkflowReply } from './contracts.js';
import { readTask, readTaskJson, writeTaskJson, updateTask, withTaskLock, hash, json } from '../project/task-store.js';
import { compileSlidePrompt } from '../styles/prompt-compiler.js';

export const samplePrompts = (plan: PlanBundle) => Object.fromEntries(plan.styles.map(style => [style.id, compileSlidePrompt({ spec: plan.slides.find(s => s.slideId === plan.representativeSlideId)!, style }).text + '\nUse only the selected art direction; do not append the dependency default style.']));
export const planDetails = (plan: PlanBundle, revision: string) => ({
  planPath: `planning/${revision}/plan.json`,
  samplePromptsPath: `planning/${revision}/sample-prompts.json`,
  styles: plan.styles.map(({id,name,preview,palette,materials,lighting,medium}) => ({id,name,preview,palette,materials,lighting,medium})),
  representativeSlideId: plan.representativeSlideId, references: plan.references,
  callBudget: 1, executor: 'ai-image-to-ppt', output: 'generation',
});
export function renderPlanReview(plan: PlanBundle): string {
  return [`${plan.brief.title} · ${plan.brief.targetSlides} 页`, `受众：${plan.brief.audience}；目标：${plan.brief.purpose}`,
    ...plan.outline.slides.map(s => { const detail = plan.slides.find(p => p.slideId === s.id)!; return `${s.order + 1}. ${s.title}：${detail.coreMessage}\n   画面：${detail.composition}\n   文字：${detail.requiredText.join('；')}`; }),
    `风格单选：${plan.styles.map(s => s.name).join(' / ')}`, '选择风格并生成样页（一次外部生图调用）。',
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
