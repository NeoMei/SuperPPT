import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const RevisionSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  createdAt: z.string().datetime(),
  parentId: z.string().uuid().nullable(),
  parentSnapshotDescriptorSha256: Sha256Schema.optional(),
  rollbackTransactionDescriptorSha256: Sha256Schema.optional(),
}).strict();

export const RollbackTransactionMarkerSchema = z.object({
  transactionId: z.string().uuid(),
  baseRevisionId: z.string().uuid(),
  targetRevisionId: z.string().uuid(),
  rollbackRevisionId: z.string().uuid(),
  descriptorSha256: Sha256Schema,
}).strict();

export const ArtifactSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  revisionId: z.string().uuid(),
}).strict();

export const ClientSmokeCopyAnchorSchema = z.object({
  anchorVersion: z.literal(1),
  anchorId: z.string().uuid(),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  deckRevision: z.number().int().positive(),
  source: ArtifactSchema,
  descriptor: ArtifactSchema,
  initialCopy: ArtifactSchema,
  createdAt: z.string().datetime(),
  state: z.enum(["pending", "ready", "completed"]),
  observation: ArtifactSchema.nullable(),
  reopenedCopySha256: Sha256Schema.nullable(),
  acceptanceRecord: ArtifactSchema.nullable(),
  completedAt: z.string().datetime().nullable(),
}).strict().superRefine((anchor, context) => {
  const completed = anchor.state === "completed";
  const evidenceFields = [anchor.observation, anchor.reopenedCopySha256, anchor.acceptanceRecord, anchor.completedAt];
  if (completed ? evidenceFields.some((value) => value === null) : evidenceFields.some((value) => value !== null)) {
    context.addIssue({ code: "custom", message: "completed smoke copy anchors require exact discard/reopen observation and acceptance-record evidence" });
  }
  if (completed && anchor.reopenedCopySha256 !== anchor.initialCopy.sha256) {
    context.addIssue({
      code: "custom",
      path: ["reopenedCopySha256"],
      message: "completed smoke copy anchors require the reopened copy to match the initial hash",
    });
  }
});

export const ClientAcceptanceTransactionSchema = z.object({
  transactionVersion: z.literal(1),
  transactionId: z.string().uuid(),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  deckRevision: z.number().int().positive(),
  anchorId: z.string().uuid(),
  descriptor: ArtifactSchema,
  source: ArtifactSchema,
  initialCopy: ArtifactSchema,
  observation: ArtifactSchema,
  reopenedCopySha256: Sha256Schema,
  acceptanceRecord: ArtifactSchema,
  confirmedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
}).strict().superRefine((transaction, context) => {
  for (const field of ["descriptor", "source", "initialCopy", "observation", "acceptanceRecord"] as const) {
    if (transaction[field].revisionId !== transaction.revisionId) {
      context.addIssue({
        code: "custom",
        path: [field, "revisionId"],
        message: "client acceptance transaction artifacts must bind the current revision",
      });
    }
  }
  if (transaction.reopenedCopySha256 !== transaction.initialCopy.sha256) {
    context.addIssue({
      code: "custom",
      path: ["reopenedCopySha256"],
      message: "client acceptance transaction must commit an unchanged reopened copy",
    });
  }
});

export const EditableRevisionBindingSchema = z.object({
  projectId: z.string().uuid(),
  slideId: z.string().uuid(),
  modifiedRevisionId: z.string().uuid(),
  sourceRevisionId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  expectedModifiedRevisionRecordSha256: Sha256Schema,
  modifiedRevisionRecordPath: z.string().startsWith("editable/"),
  sourceFinalRender: ArtifactSchema,
  conversionFinalRender: ArtifactSchema,
  preview: ArtifactSchema,
  modifiedManifest: ArtifactSchema,
}).strict().superRefine((binding, context) => {
  const base = `editable/${binding.slideId}/${binding.modifiedRevisionId}`;
  if (binding.modifiedRevisionRecordPath !== `${base}/modified-revision-record.json`) {
    context.addIssue({ code: "custom", path: ["modifiedRevisionRecordPath"], message: "editable record path must match the bound slide and revision" });
  }
  if (binding.modifiedManifest.path !== `${base}/modified-manifest.json`) {
    context.addIssue({ code: "custom", path: ["modifiedManifest", "path"], message: "editable manifest path must match the bound slide and revision" });
  }
  if (binding.preview.path !== `previews/editable/${binding.slideId}/${binding.modifiedRevisionId}.png`) {
    context.addIssue({ code: "custom", path: ["preview", "path"], message: "editable preview path must match the bound slide and revision" });
  }
  for (const [name, artifact] of Object.entries({
    sourceFinalRender: binding.sourceFinalRender,
    conversionFinalRender: binding.conversionFinalRender,
    preview: binding.preview,
    modifiedManifest: binding.modifiedManifest,
  })) {
    if (artifact.revisionId !== binding.projectRevisionId) {
      context.addIssue({ code: "custom", path: [name, "revisionId"], message: "editable artifact must bind the project revision" });
    }
  }
});

export const SlideSchema = z.object({
  id: z.string().uuid(),
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  role: z.enum([
    "cover",
    "section",
    "content",
    "process",
    "comparison",
    "data",
    "summary",
  ]),
  specRevisionId: z.string().uuid(),
  promptRevisionId: z.string().uuid().nullable(),
  styleRevisionId: z.string().uuid().nullable(),
  status: z.enum([
    "draft",
    "approved",
    "stale",
    "generating",
    "ready",
    "failed",
    "editable",
  ]),
  image: ArtifactSchema.nullable(),
  generationHistory: z.array(z.object({
    jobId: z.string().uuid(),
    authorizationSequence: z.number().int().positive(),
    attempt: z.number().int().positive(),
    image: ArtifactSchema,
    finalRender: ArtifactSchema,
  }).strict()).optional(),
  editable: ArtifactSchema.nullable(),
  editableRevision: EditableRevisionBindingSchema.nullable().optional(),
  finalRender: ArtifactSchema.nullable(),
  staleReasons: z.array(z.string()),
}).strict();

export const GateSchema = z.object({
  gate: z.enum([
    "outline",
    "slide-specs",
    "style-sample",
    "style-sample-generation",
    "generation-authorization",
    "deck-review",
    "revision-impact",
    "slide-preview",
  ]),
  revisionId: z.string().uuid(),
  approvalId: z.string().uuid().optional(),
  artifactHashes: z.record(z.string(), Sha256Schema),
  snapshotPath: z.string().min(1).optional(),
  snapshotManifestSha256: Sha256Schema.optional(),
  presentation: z.object({
    kind: z.enum(["planning-views", "style-sample", "generation-plan", "deck-review"]),
    publicationPath: z.union([
      z.string().startsWith("revisions/"),
      z.literal("generation/authorization-plan.json"),
      z.literal("output/candidates/current/review.json"),
    ]),
    descriptorSha256: Sha256Schema,
  }).strict().optional(),
  slidePreview: EditableRevisionBindingSchema.optional(),
  confirmedAt: z.string().datetime(),
}).strict().superRefine((gate, context) => {
  if (gate.gate === "slide-preview") {
    if (!gate.slidePreview) {
      context.addIssue({ code: "custom", path: ["slidePreview"], message: "slide-preview gate requires an external editable revision binding" });
      return;
    }
    const expected = [gate.slidePreview.modifiedRevisionRecordPath, gate.slidePreview.preview.path].sort();
    if (JSON.stringify(Object.keys(gate.artifactHashes).sort()) !== JSON.stringify(expected)) {
      context.addIssue({ code: "custom", path: ["artifactHashes"], message: "slide-preview gate must bind the record and preview artifacts" });
    }
    if (
      gate.revisionId !== gate.slidePreview.projectRevisionId
      || gate.artifactHashes[gate.slidePreview.modifiedRevisionRecordPath] !== gate.slidePreview.expectedModifiedRevisionRecordSha256
      || gate.artifactHashes[gate.slidePreview.preview.path] !== gate.slidePreview.preview.sha256
    ) context.addIssue({ code: "custom", message: "slide-preview gate identity is inconsistent" });
    if (gate.approvalId || gate.snapshotPath || gate.snapshotManifestSha256 || gate.presentation) {
      context.addIssue({ code: "custom", message: "slide-preview gate accepts only direct conditional evidence" });
    }
    return;
  }
  if (gate.slidePreview) {
    context.addIssue({ code: "custom", path: ["slidePreview"], message: "only slide-preview gates accept editable revision bindings" });
  }
  if (gate.gate === "style-sample-generation") {
    if (
      JSON.stringify(Object.keys(gate.artifactHashes).sort()) !== JSON.stringify(["style/sample/generation-plan.json"])
      || !gate.approvalId
      || gate.snapshotPath !== `revisions/${gate.revisionId}/execution-gates/style-sample-generation-${gate.approvalId}`
      || !gate.snapshotManifestSha256
      || gate.presentation
    ) context.addIssue({ code: "custom", message: "style-sample-generation requires immutable execution authorization evidence" });
    return;
  }
  if (gate.gate !== "revision-impact") return;
  const keys = Object.keys(gate.artifactHashes);
  if (keys.length !== 1 || keys[0] !== "revisions/pending-impact.json") {
    context.addIssue({
      code: "custom",
      path: ["artifactHashes"],
      message: "revision-impact gate must bind the fixed pending impact evidence",
    });
  }
  if (!gate.approvalId) {
    context.addIssue({ code: "custom", path: ["approvalId"], message: "revision-impact gate requires an approval identity" });
  }
  const expectedPath = gate.approvalId
    ? `revisions/${gate.revisionId}/impact-approvals/${gate.approvalId}`
    : "";
  if (gate.snapshotPath !== expectedPath) {
    context.addIssue({ code: "custom", path: ["snapshotPath"], message: "revision-impact gate requires its fixed approval evidence path" });
  }
  if (!gate.snapshotManifestSha256) {
    context.addIssue({ code: "custom", path: ["snapshotManifestSha256"], message: "revision-impact gate requires an exact base identity" });
  }
  if (gate.presentation) {
    context.addIssue({ code: "custom", path: ["presentation"], message: "revision-impact gate does not accept presentation evidence" });
  }
});

export const ProjectManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  title: z.string().min(1),
  stage: z.enum([
    "intake",
    "outline",
    "slide-specs",
    "style",
    "style-sample",
    "generation-authorization",
    "deck-review",
    "generating",
    "assembling",
    "revising",
    "delivered",
  ]),
  currentRevision: RevisionSchema,
  revisions: z.array(RevisionSchema).min(1),
  rollbackTransaction: RollbackTransactionMarkerSchema.optional(),
  gates: z.array(GateSchema),
  brief: ArtifactSchema.nullable(),
  outline: ArtifactSchema.nullable(),
  style: ArtifactSchema.nullable(),
  slides: z.array(SlideSchema),
  currentDeck: z.object({
    schemaVersion: z.literal(1),
    revisionId: z.string().uuid(),
    relativePath: z.string().regex(/^output\/deck-revisions\/[0-9a-f-]{36}\/deck\.pptx$/),
    sha256: Sha256Schema,
    updatedAt: z.string().datetime(),
  }).strict().nullable().default(null),
  activeDeckEditSessionId: z.string().uuid().nullable().default(null),
  deckRevision: z.number().int().positive().optional(),
  clientSmokeCopyAnchor: ClientSmokeCopyAnchorSchema.optional(),
  clientAcceptanceTransaction: ClientAcceptanceTransactionSchema.optional(),
  outputRevisions: z.array(z.object({
    number: z.number().int().positive(),
    projectRevisionId: z.string().uuid(),
    createdAt: z.string().datetime(),
    slides: z.array(z.object({
      id: z.string().uuid(),
      order: z.number().int().nonnegative(),
      mode: z.enum(["image", "editable"]),
      finalRender: ArtifactSchema,
      editable: ArtifactSchema.nullable(),
    }).strict()),
    exports: z.object({
      pptx: ArtifactSchema,
      pdf: ArtifactSchema,
      montage: ArtifactSchema,
      acceptance: ArtifactSchema,
    }).strict(),
  }).strict()).optional(),
  exports: z.object({
    pptx: ArtifactSchema.nullable(),
    pdf: ArtifactSchema.nullable(),
    montage: ArtifactSchema.nullable(),
    acceptance: ArtifactSchema.nullable(),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const transaction = manifest.clientAcceptanceTransaction;
  if (!transaction) return;
  const anchor = manifest.clientSmokeCopyAnchor;
  const deckRevision = manifest.deckRevision ?? manifest.currentRevision.number;
  if (
    manifest.stage === "delivered"
    || !anchor
    || anchor.state !== "ready"
    || transaction.projectId !== manifest.projectId
    || transaction.revisionId !== manifest.currentRevision.id
    || transaction.deckRevision !== deckRevision
    || transaction.anchorId !== anchor.anchorId
    || JSON.stringify(transaction.descriptor) !== JSON.stringify(anchor.descriptor)
    || JSON.stringify(transaction.source) !== JSON.stringify(anchor.source)
    || JSON.stringify(transaction.initialCopy) !== JSON.stringify(anchor.initialCopy)
    || transaction.observation.path !== `output/revisions/${deckRevision}/acceptance-observation.json`
    || transaction.acceptanceRecord.path !== `output/revisions/${deckRevision}/acceptance-record.json`
  ) {
    context.addIssue({
      code: "custom",
      path: ["clientAcceptanceTransaction"],
      message: "client acceptance transaction must bind the current ready smoke anchor and revision",
    });
  }
});

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
export type SlideRecord = z.infer<typeof SlideSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ClientSmokeCopyAnchor = z.infer<typeof ClientSmokeCopyAnchorSchema>;
export type ClientAcceptanceTransaction = z.infer<typeof ClientAcceptanceTransactionSchema>;
export type EditableRevisionBinding = z.infer<typeof EditableRevisionBindingSchema>;
