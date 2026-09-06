import { z } from 'zod';

export const DeckRefSchema = z.object({ revisionId: z.string().uuid(), relativePath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type DeckRef = z.infer<typeof DeckRefSchema>;
export const WorkSchema = z.object({ id: z.string().uuid(), kind: z.enum(['plan', 'generate-batch', 'review-images', 'edit-deck', 'convert-page']), inputPath: z.string(), resultPath: z.string() });
export type WorkRequest = z.infer<typeof WorkSchema>;
export const TaskStateSchema = z.object({
  schemaVersion: z.literal('superppt-task-vnext'), projectId: z.string().uuid(), title: z.string().min(1),
  contentRevision: z.string().uuid(), stage: z.enum(['planning', 'plan-review', 'sample-generation', 'sample-review', 'deck-generation', 'deck-qa', 'deck-review', 'delivered']),
  sourcePath: z.string(), planPath: z.string().nullable(), styleLockPath: z.string().nullable(),
  activeJobId: z.string().uuid().nullable(), currentDeck: DeckRefSchema.nullable(),
  pendingDecision: z.object({ id: z.string().uuid(), kind: z.string() }).nullable(),
  editSessionPath: z.string().nullable(), delivery: DeckRefSchema.extend({ confirmedAt: z.string() }).nullable(),
  work: WorkSchema.nullable(), lastResult: z.object({ id: z.string(), sha256: z.string() }).nullable(),
  lastDecision: z.object({ id: z.string(), sha256: z.string() }).nullable(),
  dependenciesPath: z.string().nullable(),
}).strict();
export type TaskState = z.infer<typeof TaskStateSchema>;
