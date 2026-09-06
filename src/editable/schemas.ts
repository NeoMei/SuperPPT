import { z } from "zod";
import { isAbsolute } from "node:path";
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const EditableBBoxSchema = z.object({
  x: z.number().finite().min(0).max(1280),
  y: z.number().finite().min(0).max(720),
  width: z.number().finite().positive().max(1280),
  height: z.number().finite().positive().max(720),
}).strict().superRefine((box, context) => {
  if (box.x + box.width > 1280 || box.y + box.height > 720) {
    context.addIssue({ code: "custom", message: "bbox must remain inside 1280x720" });
  }
});

export const EditableProjectPathSchema = z.string().min(1).refine(
  (value) => !isAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "asset path must remain project-relative",
);

const TextElementSchema = z.object({
  kind: z.literal("text"),
  id: z.string().min(1),
  text: z.string(),
  bbox: EditableBBoxSchema,
  rotation: z.number().finite(),
  color: z.string(),
  fontSizePx: z.number().finite().positive(),
  charSpacingPx: z.number().finite().min(0).max(36).optional(),
  bold: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]),
  zIndex: z.number().int(),
}).strict();

const ShapeElementSchema = z.object({
  kind: z.literal("shape"),
  id: z.string().min(1),
  label: z.string(),
  shape: z.enum(["rect", "roundRect", "ellipse", "line"]),
  bbox: EditableBBoxSchema,
  fillColor: z.string(),
  strokeColor: z.string(),
  strokeWidthPx: z.number().finite().nonnegative(),
  cornerRadiusPx: z.number().finite().nonnegative(),
  zIndex: z.number().int(),
}).strict();

const SceneRoleSchema = z.enum([
  "background",
  "text",
  "text-backing",
  "foreground-object",
  "connector",
  "compound-group",
  "decoration",
]);

const SceneRelationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["belongs-to", "connected-to", "carries-text", "occludes", "in-front-of", "behind"]),
  from: z.string().min(1),
  to: z.string().min(1),
  confidence: z.number().finite().min(0).max(1),
}).strict();

const AssetProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("source-visible"),
    sourceCropSha256: Sha256Schema,
    visibleMaskSha256: Sha256Schema,
    assetSha256: Sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal("generated-hidden"),
    sourceCropSha256: Sha256Schema,
    generatedMaskSha256: Sha256Schema,
    assetSha256: Sha256Schema,
    modelId: z.string().min(1),
    taskIdSha256: Sha256Schema,
    sanitizedProviderMetadata: z.json().optional(),
  }).strict(),
  z.object({
    kind: z.literal("composite"),
    sourceCropSha256: Sha256Schema,
    visibleMaskSha256: Sha256Schema,
    generatedMaskSha256: Sha256Schema,
    assetSha256: Sha256Schema,
    modelId: z.string().min(1),
    taskIdSha256: Sha256Schema,
    sanitizedProviderMetadata: z.json().optional(),
  }).strict(),
]);

const AssetElementFields = {
  kind: z.literal("asset"),
  id: z.string().min(1),
  label: z.string(),
  bbox: EditableBBoxSchema,
  extraction: z.literal("transparent", { error: "editable assets must be transparent" }),
  assetPath: EditableProjectPathSchema.refine(
    (value) => value.startsWith("assets/"),
    "editable asset must be stored under assets/",
  ),
  zIndex: z.number().int(),
  fallbackReason: z.string().optional(),
};


const AssetElementV2Schema = z.object({
  ...AssetElementFields,
  role: SceneRoleSchema,
  groupId: z.string().min(1).nullable(),
  provenance: AssetProvenanceSchema,
  relations: z.array(SceneRelationSchema),
  reviewRequired: z.boolean(),
}).strict().superRefine((asset, context) => {
  if (asset.provenance.kind !== "source-visible" && !asset.reviewRequired) {
    context.addIssue({ code: "custom", path: ["reviewRequired"], message: "assets containing generated hidden pixels require review" });
  }
});

export const EditableManifestV2Schema = z.object({
  manifestVersion: z.literal(2),
  canvas: z.object({ width: z.literal(1280), height: z.literal(720) }).strict(),
  elements: z.array(z.discriminatedUnion("kind", [
    TextElementSchema,
    ShapeElementSchema,
    AssetElementV2Schema,
  ])),
  warnings: z.array(z.string()),
}).strict().superRefine((manifest, context) => {
  const seen = new Set<string>();
  for (const [index, element] of manifest.elements.entries()) {
    if (seen.has(element.id)) {
      context.addIssue({ code: "custom", path: ["elements", index, "id"], message: "editable element IDs must be unique" });
    }
    seen.add(element.id);
  }
});


export type EditableManifestV2 = z.infer<typeof EditableManifestV2Schema>;
