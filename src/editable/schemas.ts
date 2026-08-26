import { isAbsolute } from "node:path";
import { z } from "zod";

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

const AssetElementSchema = z.object({
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
}).strict();

export const EditableManifestSchema = z.object({
  manifestVersion: z.literal(1),
  canvas: z.object({ width: z.literal(1280), height: z.literal(720) }).strict(),
  elements: z.array(z.discriminatedUnion("kind", [
    TextElementSchema,
    AssetElementSchema,
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

const CandidateDecisionSchema = z.object({
  candidateId: z.string().min(1),
  kind: z.enum(["text", "icon"]),
  decision: z.enum(["accepted", "kept_in_background"]),
  bbox: EditableBBoxSchema,
  sourceElementIndexes: z.array(z.number().int().nonnegative()),
  repairMethod: z.enum(["local_nearest_surface", "none"]),
  extraction: z.enum(["transparent", "none"]),
  reason: z.enum([
    "edge_colors_inconsistent",
    "filled_pixels_too_different",
    "local_repair_failed",
    "mask_empty",
    "opaque_border_ratio_above_2_percent",
    "ocr_text_overlap_above_1_percent",
    "outside_mask_changed",
    "recomposition_mismatch",
    "surface_samples_insufficient",
    "surface_variance_too_high",
    "transparent_extraction_failed",
    "transparent_pixel_ratio_above_92_percent",
    "transparent_pixel_ratio_below_5_percent",
  ]).optional(),
  repairMetrics: z.object({
    maskedPixels: z.number().int().nonnegative(),
    outsideMaskChangedPixels: z.number().int().nonnegative(),
    ringSamples: z.number().int().nonnegative(),
    ringChannelMad: z.number().finite().nonnegative(),
    filledPixelDistanceP95: z.number().finite().nonnegative(),
  }).strict().optional(),
  recompositionMetrics: z.object({
    comparedPixels: z.number().int().nonnegative(),
    meanAbsoluteError: z.number().finite().nonnegative(),
    p95ChannelDelta: z.number().finite().nonnegative(),
    changedPixelRatio: z.number().finite().min(0).max(1),
  }).strict().optional(),
  output: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("editable_layer"),
      manifestElementId: z.string().min(1),
      assetPath: EditableProjectPathSchema.optional(),
    }).strict(),
    z.object({ state: z.literal("kept_in_background") }).strict(),
  ]),
}).strict();

export const RunLedgerV2Schema = z.object({
  ledgerVersion: z.literal(2),
  mode: z.enum(["live", "replay"]),
  recorded: z.boolean(),
  models: z.object({
    ocr: z.string().min(1),
    vision: z.string().min(1),
    edit: z.string().min(1).optional(),
  }).strict(),
  durationsMs: z.object({
    ocr: z.number().finite().nonnegative(),
    vision: z.number().finite().nonnegative(),
    analyze: z.number().finite().nonnegative(),
    plan: z.number().finite().nonnegative(),
    repair: z.number().finite().nonnegative(),
    export: z.number().finite().nonnegative(),
    total: z.number().finite().nonnegative(),
  }).strict(),
  taskIds: z.object({ wanx: z.string().min(1).optional() }).strict(),
  warnings: z.array(z.string()),
  decisions: z.array(CandidateDecisionSchema),
  hashes: z.object({
    sourceImage: Sha256Schema,
    ocr: Sha256Schema,
    vision: Sha256Schema,
    analysisLedger: Sha256Schema,
    manifest: Sha256Schema,
    removalMask: Sha256Schema,
    cleanBackground: Sha256Schema,
    assets: z.record(EditableProjectPathSchema, Sha256Schema),
    pptx: Sha256Schema,
  }).strict(),
  outputs: z.object({
    directory: z.string().min(1),
    ocr: z.string().min(1),
    vision: z.string().min(1),
    analysisLedger: z.string().min(1),
    manifest: z.string().min(1),
    removalMask: z.string().min(1),
    cleanBackground: z.string().min(1),
    assets: z.string().min(1),
    pptx: z.string().min(1),
  }).strict(),
}).strict();

export const ConverterOwnershipMarkerSchema = z.object({
  markerVersion: z.literal(1),
  appId: z.literal("image-to-editable-pptx"),
  artifactKind: z.literal("published-output"),
}).strict();

export const EditableRevisionMarkerSchema = z.object({
  markerVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("editable-slide-revision"),
  projectId: z.string().uuid(),
  slideId: z.string().uuid(),
  revisionId: z.string().uuid(),
  revisionKind: z.enum(["conversion", "modified"]),
  parentRevisionId: z.string().uuid().optional(),
  modifiedRevisionRecordSha256: Sha256Schema.optional(),
}).strict().superRefine((marker, context) => {
  if (marker.revisionKind === "modified") {
    if (!marker.parentRevisionId) context.addIssue({ code: "custom", path: ["parentRevisionId"], message: "modified revision requires parent" });
    if (!marker.modifiedRevisionRecordSha256) context.addIssue({ code: "custom", path: ["modifiedRevisionRecordSha256"], message: "modified revision requires record hash" });
  } else if (marker.parentRevisionId || marker.modifiedRevisionRecordSha256) {
    context.addIssue({ code: "custom", message: "conversion revision cannot carry modified revision fields" });
  }
});

export const EditableStagingMarkerSchema = z.object({
  stagingMarkerVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("editable-slide-staging"),
  projectId: z.string().uuid(),
  slideId: z.string().uuid(),
  revisionId: z.string().uuid(),
  parentRevisionId: z.string().uuid(),
  stagingName: z.string().regex(/^\.staging-[0-9a-f-]{36}-[0-9a-f-]{36}$/),
}).strict().superRefine((marker, context) => {
  if (!marker.stagingName.startsWith(`.staging-${marker.revisionId}-`)) {
    context.addIssue({ code: "custom", path: ["stagingName"], message: "staging name must bind revision ID" });
  }
});

export const EditableSlideMarkerSchema = z.object({
  markerVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("editable-slide"),
  projectId: z.string().uuid(),
  slideId: z.string().uuid(),
}).strict();

export const ConversionRecordSchema = z.object({
  conversionRecordVersion: z.literal(1),
  projectId: z.string().uuid(),
  slideId: z.string().uuid(),
  revisionId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  finalRender: z.object({
    path: EditableProjectPathSchema,
    sha256: Sha256Schema,
  }).strict(),
  converterVersion: z.string().min(1),
  artifacts: z.object({
    sourceImage: Sha256Schema,
    manifest: Sha256Schema,
    runLedger: Sha256Schema,
    cleanBackground: Sha256Schema,
    assets: z.record(EditableProjectPathSchema, Sha256Schema),
    outputs: z.record(z.string().min(1), Sha256Schema),
  }).strict(),
}).strict();

export const EditPlanSchema = z.discriminatedUnion("route", [
  z.object({ route: z.literal("regenerate"), reason: z.string().min(1) }).strict(),
  z.object({
    route: z.literal("editable"),
    operations: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("replace-text"), elementId: z.string().min(1), text: z.string() }).strict(),
      z.object({
        kind: z.literal("set-text-style"),
        elementId: z.string().min(1),
        color: z.string().optional(),
        fontSizePx: z.number().finite().positive().optional(),
        bold: z.boolean().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
      }).strict().refine(
        (operation) => operation.color !== undefined || operation.fontSizePx !== undefined || operation.bold !== undefined || operation.align !== undefined,
        "set-text-style requires at least one style value",
      ),
      z.object({ kind: z.literal("move-asset"), elementId: z.string().min(1), bbox: EditableBBoxSchema }).strict(),
      z.object({ kind: z.literal("replace-asset"), elementId: z.string().min(1), assetPath: z.string().min(1) }).strict(),
    ])).min(1),
  }).strict(),
]);

export const ModifiedManifestSchema = z.object({
  modifiedManifestVersion: z.literal(1),
  sourceRevisionId: z.string().uuid(),
  sourceManifestSha256: Sha256Schema,
  manifest: EditableManifestSchema,
}).strict();

export const ModifiedRevisionRecordSchema = z.object({
  modifiedRevisionRecordVersion: z.literal(1),
  projectId: z.string().uuid(),
  slideId: z.string().uuid(),
  revisionId: z.string().uuid(),
  parentRevisionId: z.string().uuid(),
  sourceRevisionId: z.string().uuid(),
  sourceConversionRecordSha256: Sha256Schema,
  projectRevisionId: z.string().uuid(),
  finalRender: z.object({
    path: EditableProjectPathSchema,
    sha256: Sha256Schema,
  }).strict(),
  sourceManifestSha256: Sha256Schema,
  artifacts: z.object({
    modifiedManifest: Sha256Schema,
    cleanBackground: Sha256Schema,
    assets: z.record(EditableProjectPathSchema, Sha256Schema),
  }).strict(),
}).strict().superRefine((record, context) => {
  if (record.parentRevisionId !== record.sourceRevisionId) {
    context.addIssue({ code: "custom", path: ["sourceRevisionId"], message: "source revision must equal parent revision" });
  }
});

export type EditableManifest = z.infer<typeof EditableManifestSchema>;
export type RunLedgerV2 = z.infer<typeof RunLedgerV2Schema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;
export type EditableRevisionMarker = z.infer<typeof EditableRevisionMarkerSchema>;
export type EditableStagingMarker = z.infer<typeof EditableStagingMarkerSchema>;
export type ModifiedManifest = z.infer<typeof ModifiedManifestSchema>;
export type ModifiedRevisionRecord = z.infer<typeof ModifiedRevisionRecordSchema>;
