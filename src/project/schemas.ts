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
  editable: ArtifactSchema.nullable(),
  finalRender: ArtifactSchema.nullable(),
  staleReasons: z.array(z.string()),
}).strict();

export const GateSchema = z.object({
  gate: z.enum([
    "outline",
    "slide-specs",
    "style-sample",
    "revision-impact",
    "slide-preview",
  ]),
  revisionId: z.string().uuid(),
  approvalId: z.string().uuid().optional(),
  artifactHashes: z.record(z.string(), Sha256Schema),
  snapshotPath: z.string().min(1).optional(),
  snapshotManifestSha256: Sha256Schema.optional(),
  presentation: z.object({
    kind: z.enum(["planning-views", "style-sample"]),
    publicationPath: z.string().startsWith("revisions/"),
    descriptorSha256: Sha256Schema,
  }).strict().optional(),
  confirmedAt: z.string().datetime(),
}).strict().superRefine((gate, context) => {
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
  exports: z.object({
    pptx: ArtifactSchema.nullable(),
    pdf: ArtifactSchema.nullable(),
    montage: ArtifactSchema.nullable(),
    acceptance: ArtifactSchema.nullable(),
  }).strict(),
}).strict();

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
export type SlideRecord = z.infer<typeof SlideSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
