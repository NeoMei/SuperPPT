import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const RevisionSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  createdAt: z.string().datetime(),
  parentId: z.string().uuid().nullable(),
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
  artifactHashes: z.record(z.string(), Sha256Schema),
  confirmedAt: z.string().datetime(),
}).strict();

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
