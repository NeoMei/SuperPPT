import { z } from "zod";

import { ArtifactSchema, Sha256Schema } from "../project/schemas.js";

export const FileEvidenceSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
}).strict();

export const CandidateAcceptanceBindingSchema = z.object({
  candidateId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  projectBindingSha256: Sha256Schema,
}).strict();

export const DeckReviewActionSchema = z.enum([
  "edit-page",
  "return-upstream",
  "confirm-delivery",
]);

export const CompleteDeckReviewBindingSchema = z.object({
  revisionId: z.string().uuid(),
  absolutePath: z.string().min(1),
  sha256: Sha256Schema,
}).strict();

const CompleteDeckReviewActionRequestBaseSchema = z.object({
  revisionId: z.string().uuid(),
  deckSha256: Sha256Schema,
});

export const CompleteDeckReviewActionRequestSchema = z.discriminatedUnion("action", [
  CompleteDeckReviewActionRequestBaseSchema.extend({
    action: z.literal("edit-page"),
    slideId: z.string().uuid(),
  }).strict(),
  CompleteDeckReviewActionRequestBaseSchema.extend({ action: z.literal("return-upstream") }).strict(),
  CompleteDeckReviewActionRequestBaseSchema.extend({ action: z.literal("confirm-delivery") }).strict(),
]);

const CompleteDeckReviewActionEvidenceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("complete-deck-review-action"),
  actionId: z.string().uuid(),
  revisionId: z.string().uuid(),
  absolutePath: z.string().min(1),
  deckSha256: Sha256Schema,
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  actedAt: z.string().datetime(),
  actionEvidenceSha256: Sha256Schema,
});

export const CompleteDeckReviewActionEvidenceSchema = z.discriminatedUnion("action", [
  CompleteDeckReviewActionEvidenceBaseSchema.extend({
    action: z.literal("edit-page"),
    slideId: z.string().uuid(),
  }).strict(),
  CompleteDeckReviewActionEvidenceBaseSchema.extend({ action: z.literal("return-upstream") }).strict(),
  CompleteDeckReviewActionEvidenceBaseSchema.extend({ action: z.literal("confirm-delivery") }).strict(),
]);

const DeckReviewActionRequestBaseSchema = z.object({
  candidateId: z.string().uuid(),
  descriptorSha256: Sha256Schema,
});

export const DeckReviewActionRequestSchema = z.discriminatedUnion("action", [
  DeckReviewActionRequestBaseSchema.extend({
    action: z.literal("edit-page"),
    slideId: z.string().uuid(),
  }).strict(),
  DeckReviewActionRequestBaseSchema.extend({ action: z.literal("return-upstream") }).strict(),
  DeckReviewActionRequestBaseSchema.extend({ action: z.literal("confirm-delivery") }).strict(),
]);

const DeckReviewActionEvidenceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("deck-review-action"),
  actionId: z.string().uuid(),
  candidateId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  reviewDescriptorSha256: Sha256Schema,
  presentedPptxSha256: Sha256Schema,
  actedAt: z.string().datetime(),
  actionEvidenceSha256: Sha256Schema,
});

export const DeckReviewActionEvidenceSchema = z.discriminatedUnion("action", [
  DeckReviewActionEvidenceBaseSchema.extend({
    action: z.literal("edit-page"),
    slideId: z.string().uuid(),
  }).strict(),
  DeckReviewActionEvidenceBaseSchema.extend({ action: z.literal("return-upstream") }).strict(),
  DeckReviewActionEvidenceBaseSchema.extend({ action: z.literal("confirm-delivery") }).strict(),
]);

export const DeckReviewDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("deck-review"),
  candidateId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  deckRevision: z.number().int().positive(),
  candidatePath: z.string().regex(/^output\/candidates\/[0-9a-f-]{36}$/),
  candidateMarkerSha256: Sha256Schema,
  projectBindingSha256: Sha256Schema,
  generationAuthorization: z.object({
    approvalId: z.string().uuid(),
    snapshotPath: z.string().startsWith("revisions/"),
    snapshotManifestSha256: Sha256Schema,
  }).strict(),
  artifacts: z.object({
    pptx: FileEvidenceSchema,
    acceptance: FileEvidenceSchema,
  }).strict(),
  actions: z.tuple([
    z.literal("edit-page"),
    z.literal("return-upstream"),
    z.literal("confirm-delivery"),
  ]),
  createdAt: z.string().datetime(),
  descriptorSha256: Sha256Schema,
}).strict();

export const ClientSmokeCopyDescriptorSchema = z.object({
  descriptorVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("client-smoke-copy"),
  anchorId: z.string().uuid(),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  source: FileEvidenceSchema,
  copy: z.object({
    path: z.string().min(1),
    initialSha256: Sha256Schema,
  }).strict(),
  createdAt: z.string().datetime(),
}).strict();

export const ClientAcceptanceInputSchema = z.object({
  application: z.enum(["WPS", "PowerPoint"]),
  smokeCopyDescriptorPath: z.string().min(1),
  selectedObject: z.string().trim().min(1).max(500),
  temporaryEditObserved: z.literal(true),
  undoObserved: z.literal(true),
  saveDecision: z.literal("discarded"),
  reopenObserved: z.literal(true),
  reopenedCopySha256: Sha256Schema,
  observedResult: z.string().min(1).max(1000),
  confirmedAt: z.string().datetime(),
}).strict();

export const ClientAcceptanceObservationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("client-acceptance-observation"),
  anchorId: z.string().uuid(),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  deckRevision: z.number().int().positive(),
  application: z.enum(["WPS", "PowerPoint"]),
  selectedObject: z.string().trim().min(1).max(500),
  descriptor: ArtifactSchema,
  source: ArtifactSchema,
  initialCopy: ArtifactSchema,
  temporaryEditObserved: z.literal(true),
  undoObserved: z.literal(true),
  saveDecision: z.literal("discarded"),
  reopenObserved: z.literal(true),
  reopenedCopySha256: Sha256Schema,
  observedResult: z.string().min(1).max(1000),
  confirmedAt: z.string().datetime(),
}).strict().superRefine((observation, context) => {
  if (observation.reopenedCopySha256 !== observation.initialCopy.sha256) {
    context.addIssue({
      code: "custom",
      path: ["reopenedCopySha256"],
      message: "reopened smoke copy must match its initial hash after discard",
    });
  }
  for (const field of ["descriptor", "source", "initialCopy"] as const) {
    if (observation[field].revisionId !== observation.revisionId) {
      context.addIssue({
        code: "custom",
        path: [field, "revisionId"],
        message: "client observation artifacts must bind the current revision",
      });
    }
  }
});

export const ClientAcceptanceSchema = z.object({
  application: z.enum(["WPS", "PowerPoint"]).nullable(),
  observation: ArtifactSchema.nullable(),
  smokeCopy: z.object({
    descriptorPath: z.string().min(1),
    descriptorSha256: Sha256Schema,
    path: z.string().min(1),
    initialSha256: Sha256Schema,
    reopenedSha256: Sha256Schema,
  }).strict().nullable(),
  selectedObject: z.string().trim().min(1).max(500).nullable(),
  temporaryEditObserved: z.boolean(),
  undoObserved: z.boolean(),
  saveDecision: z.literal("discarded").nullable(),
  reopenObserved: z.boolean(),
  observedResult: z.string().min(1).max(1000).nullable(),
  confirmedAt: z.string().datetime().nullable(),
}).strict().superRefine((client, context) => {
  const evidence = [
    client.application,
    client.observation,
    client.smokeCopy,
    client.selectedObject,
    client.saveDecision,
    client.observedResult,
    client.confirmedAt,
  ];
  const complete = evidence.every((value) => value !== null)
    && client.temporaryEditObserved
    && client.undoObserved
    && client.reopenObserved;
  const empty = evidence.every((value) => value === null)
    && !client.temporaryEditObserved
    && !client.undoObserved
    && !client.reopenObserved;
  if (!complete && !empty) {
    context.addIssue({ code: "custom", message: "client discard/reopen evidence must be all complete or all empty" });
  }
  if (client.smokeCopy && client.smokeCopy.reopenedSha256 !== client.smokeCopy.initialSha256) {
    context.addIssue({
      code: "custom",
      path: ["smokeCopy", "reopenedSha256"],
      message: "reopened smoke copy must match its initial hash after discard",
    });
  }
});

export const AcceptanceSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  slides: z.array(z.object({
    id: z.string().uuid(),
    order: z.number().int().nonnegative(),
    mode: z.enum(["image", "editable"]),
    finalRenderSha256: Sha256Schema,
  }).strict()).min(1),
  exports: z.object({
    pptx: FileEvidenceSchema,
  }).strict(),
  gates: z.object({
    outline: z.string().uuid(),
    slideSpecs: z.string().uuid(),
    styleSample: z.string().uuid(),
  }).strict(),
  providerId: z.string().min(1),
  editablePageIds: z.array(z.string().uuid()),
  warnings: z.array(z.string().min(1)),
  candidateReview: CandidateAcceptanceBindingSchema.nullable().optional(),
  completeDeckReview: CompleteDeckReviewBindingSchema.optional(),
  deckReviewConfirmation: z.object({
    actionId: z.string().uuid(),
    action: z.literal("confirm-delivery"),
    candidateId: z.string().uuid(),
    actionEvidenceSha256: Sha256Schema,
  }).strict().optional(),
  completeDeckReviewConfirmation: z.object({
    actionId: z.string().uuid(),
    action: z.literal("confirm-delivery"),
    revisionId: z.string().uuid(),
    deckSha256: Sha256Schema,
    actionEvidenceSha256: Sha256Schema,
  }).strict().optional(),
  deliveryComplete: z.boolean(),
  clientAcceptance: ClientAcceptanceSchema,
}).strict().superRefine((value, context) => {
  const editablePageIds = value.slides
    .filter((slide) => slide.mode === "editable")
    .map((slide) => slide.id);
  if (JSON.stringify(value.editablePageIds) !== JSON.stringify(editablePageIds)) {
    context.addIssue({
      code: "custom",
      path: ["editablePageIds"],
      message: "editablePageIds must exactly match editable slides",
    });
  }
  const complete = value.clientAcceptance.application !== null
    && value.clientAcceptance.observation !== null
    && value.clientAcceptance.smokeCopy !== null
    && value.clientAcceptance.selectedObject !== null
    && value.clientAcceptance.temporaryEditObserved
    && value.clientAcceptance.undoObserved
    && value.clientAcceptance.saveDecision === "discarded"
    && value.clientAcceptance.reopenObserved
    && value.clientAcceptance.observedResult !== null
    && value.clientAcceptance.confirmedAt !== null;
  if (value.deliveryComplete !== complete) {
    context.addIssue({
      code: "custom",
      path: ["deliveryComplete"],
      message: "deliveryComplete must exactly match explicit client acceptance",
    });
  }
  if (
    value.clientAcceptance.observation
    && value.clientAcceptance.observation.revisionId !== value.revisionId
  ) {
    context.addIssue({
      code: "custom",
      path: ["clientAcceptance", "observation", "revisionId"],
      message: "client observation must bind the acceptance revision",
    });
  }
});

export type Acceptance = z.infer<typeof AcceptanceSchema>;
export type ClientAcceptance = z.infer<typeof ClientAcceptanceSchema>;
export type ClientAcceptanceObservation = z.infer<typeof ClientAcceptanceObservationSchema>;
export type DeckReviewDescriptor = z.infer<typeof DeckReviewDescriptorSchema>;
export type DeckReviewAction = z.infer<typeof DeckReviewActionSchema>;
export type DeckReviewActionRequest = z.infer<typeof DeckReviewActionRequestSchema>;
export type DeckReviewActionEvidence = z.infer<typeof DeckReviewActionEvidenceSchema>;
export type CompleteDeckReviewBinding = z.infer<typeof CompleteDeckReviewBindingSchema>;
export type CompleteDeckReviewActionRequest = z.infer<typeof CompleteDeckReviewActionRequestSchema>;
export type CompleteDeckReviewActionEvidence = z.infer<typeof CompleteDeckReviewActionEvidenceSchema>;
