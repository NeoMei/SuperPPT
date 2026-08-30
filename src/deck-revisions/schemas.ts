import { createHash } from "node:crypto";

import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const RevisionDeckPathSchema = z.string().regex(/^output\/deck-revisions\/[0-9a-f-]{36}\/deck\.pptx$/);

export const SlideTopologyEntrySchema = z.object({
  stableSlideId: z.string().uuid(),
  slidePart: z.string().regex(/^ppt\/slides\/slide[0-9]+\.xml$/),
  position: z.number().int().nonnegative(),
  management: z.enum(["managed", "unmanaged"]),
  presentationSlideId: z.number().int().min(256).max(4294967295),
  creationId: z.number().int().positive().max(4294967295),
}).strict();

export const SlideTopologySchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(SlideTopologyEntrySchema),
  deletedStableSlideIds: z.array(z.string().uuid()),
  sha256: Sha256Schema,
}).strict().superRefine((topology, context) => {
  for (const [field, values] of [
    ["stableSlideId", topology.entries.map((entry) => entry.stableSlideId)],
    ["position", topology.entries.map((entry) => entry.position)],
    ["presentationSlideId", topology.entries.map((entry) => entry.presentationSlideId)],
    ["creationId", topology.entries.map((entry) => entry.creationId)],
  ] as const) {
    if (new Set<unknown>(values).size !== values.length) {
      context.addIssue({ code: "custom", path: ["entries"], message: `slide topology ${field} values must be unique` });
    }
  }
  if (topology.deletedStableSlideIds.some((id) => topology.entries.some((entry) => entry.stableSlideId === id))) {
    context.addIssue({ code: "custom", path: ["deletedStableSlideIds"], message: "active slide identities cannot also be deleted" });
  }
  const expected = createHash("sha256").update(JSON.stringify({
    schemaVersion: topology.schemaVersion,
    entries: topology.entries,
    deletedStableSlideIds: topology.deletedStableSlideIds,
  })).digest("hex");
  if (topology.sha256 !== expected) {
    context.addIssue({ code: "custom", path: ["sha256"], message: "slide topology hash does not match its exact content" });
  }
});

export const LocalDeckRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().uuid(),
  parentRevisionId: z.string().uuid().nullable(),
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  reason: z.enum(["initial", "manual-edit", "agent-edit", "slide-regeneration"]),
  relativePath: RevisionDeckPathSchema,
  sha256: Sha256Schema,
  slideTopology: SlideTopologySchema,
  editableSlideIds: z.array(z.string().uuid()),
  changedSlideIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
}).strict();

export const DeckEditSessionSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  candidateRevisionId: z.string().uuid(),
  parentRevisionId: z.string().uuid(),
  mode: z.enum(["manual", "agent"]),
  targetSlideId: z.string().uuid(),
  state: z.enum(["prepared", "external-editing", "awaiting-confirmation", "adopting", "adopted", "rejected"]),
  candidateRelativePath: RevisionDeckPathSchema,
  preparedSha256: Sha256Schema,
  presentedSha256: Sha256Schema.nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export const CurrentDeckPointerSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().uuid(),
  relativePath: RevisionDeckPathSchema,
  sha256: Sha256Schema,
  updatedAt: z.string().datetime(),
}).strict();

export const DeckAdoptionEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  adoptionId: z.string().uuid(),
  mode: z.enum(["manual", "agent"]),
  candidateRevisionId: z.string().uuid(),
  previousRevisionId: z.string().uuid().nullable(),
  adoptedSha256: Sha256Schema,
  slideTopologySha256: Sha256Schema,
  userSignal: z.literal("saved-and-closed").nullable(),
  confirmedSha256: Sha256Schema.nullable(),
  adoptedAt: z.string().datetime(),
}).strict().superRefine((evidence, context) => {
  if (
    evidence.mode === "manual"
    && (evidence.userSignal !== "saved-and-closed" || evidence.confirmedSha256 !== null)
  ) {
    context.addIssue({ code: "custom", message: "manual adoption requires the saved-and-closed signal" });
  }
  if (
    evidence.mode === "agent"
    && (evidence.userSignal !== null || evidence.confirmedSha256 !== evidence.adoptedSha256)
  ) {
    context.addIssue({ code: "custom", message: "agent adoption requires exact candidate confirmation" });
  }
});

export type SlideTopology = z.infer<typeof SlideTopologySchema>;
export type SlideTopologyEntry = z.infer<typeof SlideTopologyEntrySchema>;
export type LocalDeckRevision = z.infer<typeof LocalDeckRevisionSchema>;
export type DeckEditSession = z.infer<typeof DeckEditSessionSchema>;
export type CurrentDeckPointer = z.infer<typeof CurrentDeckPointerSchema>;
export type DeckAdoptionEvidence = z.infer<typeof DeckAdoptionEvidenceSchema>;
export type ResolvedLocalDeckRevision = LocalDeckRevision & { absolutePath: string };
export type ResolvedDeckEditSession = DeckEditSession & { absolutePath: string };
export type ResolvedCurrentDeckPointer = CurrentDeckPointer & { absolutePath: string };
