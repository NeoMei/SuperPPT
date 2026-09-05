import { z } from 'zod';
import { BriefSchema, OutlineSchema, SlideSpecSchema } from '../planning/schemas.js';
import { StyleRecipeSchema } from '../styles/schemas.js';
import type { DeckRef, WorkRequest } from '../project/task-schema.js';

export const PlanBundleSchema = z.object({
  brief: BriefSchema, outline: OutlineSchema, slides: z.array(SlideSpecSchema),
  styles: z.array(StyleRecipeSchema).min(1).max(3), representativeSlideId: z.string().uuid(),
  references: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), role: z.enum(['art-direction', 'content-reference']) })).default([]),
}).strict().superRefine((p, ctx) => {
  const ids = p.outline.slides.map(s => s.id), slides = p.slides.map(s => s.slideId);
  if (slides.length !== ids.length || new Set(slides).size !== ids.length || ids.some(id => !slides.includes(id))) ctx.addIssue({ code: 'custom', message: 'Plan must describe every outline slide exactly once' });
  if (!ids.includes(p.representativeSlideId)) ctx.addIssue({ code: 'custom', message: 'Representative slide missing' });
  if (p.brief.targetSlides !== ids.length) ctx.addIssue({ code: 'custom', message: 'Page count differs from brief' });
  if (new Set(p.styles.map(s => s.id)).size !== p.styles.length) ctx.addIssue({ code: 'custom', message: 'Duplicate style choices' });
});
export type PlanBundle = z.infer<typeof PlanBundleSchema>;
export type WorkflowReply =
  | { kind: 'work'; work: WorkRequest }
  | { kind: 'decision'; id: string; stage: string; view: string; details?: unknown }
  | { kind: 'attention'; reason: string }
  | { kind: 'done'; deck: DeckRef; link: string };

export const DecisionInputSchema = z.object({
  decisionId: z.string().uuid(),
  action: z.enum(['select-style-and-generate-sample', 'approve-sample-and-generate-deck', 'revise-plan', 'regenerate-page', 'retry-generation', 'confirm-delivery', 'confirm-agent-edit', 'saved-and-closed', 'reject-edit', 'rollback-deck']),
  styleId: z.string().optional(), callBudget: z.number().int().nonnegative().optional(),
  revisionId: z.string().uuid().optional(), confirmedSha256: z.string().optional(),
  instruction: z.string().optional(), pageNumber: z.number().int().positive().optional(),
}).strict();
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export const EditRequestSchema = z.object({ pageNumber: z.number().int().positive(), mode: z.enum(['manual', 'agent']), instruction: z.string().default(''), route: z.enum(['direct-edit', 'activate-editable', 'regenerate-slide']).default('direct-edit') }).strict();
export type EditRequest = z.infer<typeof EditRequestSchema>;
