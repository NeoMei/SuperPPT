import { z } from 'zod';
import { missing, readTaskJson, writeTaskJson } from '../project/task-store.js';

export type PlanningContext = {
  schemaVersion: 1;
  narrativeSummary: string;
  answers: Array<{ key: string; value: string; kind: 'fact' | 'preference' }>;
  assumptions: string[];
};

export const PlanningContextSchema: z.ZodType<PlanningContext> = z.object({
  schemaVersion: z.literal(1),
  narrativeSummary: z.string(),
  answers: z.array(z.object({
    key: z.string().min(1),
    value: z.string(),
    kind: z.enum(['fact', 'preference']),
  }).strict()),
  assumptions: z.array(z.string()),
}).strict().superRefine((context, issues) => {
  if (new Set(context.answers.map(answer => answer.key)).size !== context.answers.length) {
    issues.addIssue({ code: 'custom', message: 'Planning context answer keys must be unique', path: ['answers'] });
  }
});

const emptyPlanningContext = (): PlanningContext => ({
  schemaVersion: 1,
  narrativeSummary: '',
  answers: [],
  assumptions: [],
});

export function planningContextPath(revision: string): string {
  return `planning/${revision}/context.json`;
}

export async function readPlanningContext(root: string, revision: string): Promise<PlanningContext> {
  try {
    return PlanningContextSchema.parse(await readTaskJson(root, planningContextPath(revision)));
  } catch (error) {
    if (missing(error)) return emptyPlanningContext();
    throw error;
  }
}

export async function ensurePlanningContext(root: string, revision: string, previousPlanPath?: string): Promise<string> {
  const path = planningContextPath(revision);
  try {
    PlanningContextSchema.parse(await readTaskJson(root, path));
    return path;
  } catch (error) {
    if (!missing(error)) throw error;
  }

  let context = emptyPlanningContext();
  if (previousPlanPath) {
    const previous = z.object({ context: PlanningContextSchema.optional() }).passthrough().parse(await readTaskJson(root, previousPlanPath));
    context = previous.context ?? context;
  }
  await writeTaskJson(root, path, context);
  return path;
}
