import { z } from "zod";
import { ArtifactSchema, Sha256Schema } from "../project/schemas.js";

const Strings = z.array(z.string().min(1)).min(1);
const PageRoleSchema = z.enum(["cover", "section", "content", "process", "comparison", "data", "summary"]);

export const StyleRecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  preview: z.string().min(1).optional(),
  palette: Strings,
  materials: Strings,
  lighting: Strings,
  medium: Strings,
  typography: Strings,
  detailLanguage: Strings,
  compositionRules: Strings,
  forbidden: Strings,
  pageVariants: z.record(PageRoleSchema, z.string().min(1)),
}).strict();

export const StyleCatalogSchema = z.object({
  catalogVersion: z.literal(1),
  selectionMode: z.literal("single"),
  styles: z.array(StyleRecipeSchema.extend({ preview: z.string().min(1) })).min(8).max(12),
}).strict().superRefine((value, context) => {
  const ids = value.styles.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "style IDs must be unique", path: ["styles"] });
  }
  value.styles.forEach((style, index) => {
    if (style.preview !== `previews/${style.id}.jpg`) {
      context.addIssue({
        code: "custom",
        message: "style preview must match its style ID",
        path: ["styles", index, "preview"],
      });
    }
  });
});

export const VisualDirectorSchema = z.object({
  foreground: Strings,
  midground: Strings,
  background: Strings,
  microDetails: Strings,
  readingOrder: Strings,
  textSafeArea: z.string().min(1),
}).strict();

export const StyleSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), styleId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal("custom"),
    name: z.string().min(1),
    description: z.string().min(1),
    recipe: StyleRecipeSchema,
  }).strict(),
]);

export const StyleSampleSelectionSchema = z.union([
  z.object({
    schemaVersion: z.literal(2),
    projectRevisionId: z.string().uuid(),
    representativeSlideId: z.string().uuid(),
    selection: StyleSelectionSchema,
    styleLockSha256: Sha256Schema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    representativeSlideId: z.string().uuid(),
    selection: StyleSelectionSchema,
  }).strict(),
  z.object({
    // Kept solely to read pre-lock project fixtures. New selections must be
    // discriminated so catalog and custom recipes share one lock lifecycle.
    schemaVersion: z.literal(1),
    styleId: z.string().regex(/^[a-z0-9-]+$/),
    representativeSlideId: z.string().uuid(),
  }).strict(),
]);

export const StyleReferenceSchema = z.object({
  path: z.string().startsWith("style/references/"),
  sha256: Sha256Schema,
  role: z.enum(["art-direction", "content-reference"]),
}).strict();

export const StyleLockSchema = z.object({
  contractVersion: z.literal(1),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  approvalState: z.enum(["provisional", "approved"]),
  recipe: StyleRecipeSchema,
  styleRecipeSha256: Sha256Schema,
  approvedSample: ArtifactSchema.nullable(),
  referenceArtifacts: z.array(StyleReferenceSchema),
  applyDependencyDefaultStyle: z.literal(false),
  createdAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.approvalState === "provisional" && value.approvedSample !== null) {
    context.addIssue({ code: "custom", path: ["approvedSample"], message: "provisional style locks cannot bind an approved sample" });
  }
  if (value.approvalState === "approved" && value.approvedSample === null) {
    context.addIssue({ code: "custom", path: ["approvedSample"], message: "approved style locks require an authenticated sample" });
  }
});

export type StyleRecipe = z.infer<typeof StyleRecipeSchema>;
export type VisualDirector = z.infer<typeof VisualDirectorSchema>;
export type StyleSelection = z.infer<typeof StyleSelectionSchema>;
export type StyleSampleSelection = z.infer<typeof StyleSampleSelectionSchema>;
export type StyleReference = z.infer<typeof StyleReferenceSchema>;
export type StyleLock = z.infer<typeof StyleLockSchema>;
