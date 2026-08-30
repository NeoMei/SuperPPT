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

const AssetElementSchema = z.object(AssetElementFields).strict();

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

const CandidateDecisionSchema = z.object({
  candidateId: z.string().min(1),
  kind: z.enum(["text", "icon", "foreground-object", "text-backing", "compound-group"]),
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
    "ambiguous_substantial_overlap",
    "cycle_in_layer_order",
    "dangling_ocr_association",
    "decoration_candidate",
    "uncertain_candidate",
    "backing_mask_invalid",
    "glyph_residue",
    "repair_seam",
    "surface_unstable",
    "semantic_mask_unavailable",
    "text_mask_unavailable",
    "occlusion_completion_unavailable",
    "completion_provenance_invalid",
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
    qaPreviews: z.object({
      recomposition: Sha256Schema,
      layerReview: Sha256Schema,
      exploded: Sha256Schema,
    }).strict().optional(),
    sceneGraph: Sha256Schema.optional(),
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
    qaPreviews: z.object({
      recomposition: z.string().min(1),
      layerReview: z.string().min(1),
      exploded: z.string().min(1),
    }).strict().optional(),
    sceneGraph: z.string().min(1).optional(),
  }).strict(),
}).strict();

export const AuthenticatedEditableConversionSchema = z.object({
  converterVersion: z.string().regex(/^0\.2\.[0-9]+(?:[-+].*)?$/),
  manifestVersion: z.literal(2),
  sourceImagePath: EditableProjectPathSchema,
  sourceImageSha256: Sha256Schema,
  manifestPath: EditableProjectPathSchema,
  manifestSha256: Sha256Schema,
  ledgerPath: EditableProjectPathSchema,
  ledgerSha256: Sha256Schema,
  cleanBackgroundPath: EditableProjectPathSchema,
  cleanBackgroundSha256: Sha256Schema,
  donorPptxPath: EditableProjectPathSchema.refine((path) => path.endsWith("/slide-editable.pptx")),
  donorPptxSha256: Sha256Schema,
  assets: z.record(EditableProjectPathSchema, Sha256Schema),
  reviewRequiredObjects: z.array(z.object({
    elementId: z.string().min(1),
    label: z.string().min(1),
    role: z.string().min(1),
  }).strict()),
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

export const EditableConversionStagingMarkerSchema = z.object({
  stagingMarkerVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("editable-conversion-staging"),
  projectId: z.string().uuid(),
  slideId: z.string().uuid(),
  revisionId: z.string().uuid(),
}).strict();

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
  prepareEditableInput: z.object({
    scriptPath: z.string().min(1),
    scriptSha256: Sha256Schema,
    sourceMaster: z.object({
      path: EditableProjectPathSchema,
      sha256: Sha256Schema,
      revisionId: z.string().uuid(),
    }).strict(),
    output1280x720: z.object({
      path: EditableProjectPathSchema,
      sha256: Sha256Schema,
      revisionId: z.string().uuid(),
    }).strict(),
  }).strict(),
  deckReviewSelection: z.object({
    candidateId: z.string().uuid(),
    reviewDescriptorSha256: Sha256Schema,
    actionEvidenceSha256: Sha256Schema,
  }).strict(),
  converterVersion: z.string().regex(/^0\.2\.[0-9]+(?:[-+].*)?$/),
  artifacts: z.object({
    sourceImage: Sha256Schema,
    manifest: Sha256Schema,
    runLedger: Sha256Schema,
    cleanBackground: Sha256Schema,
    donorPptx: Sha256Schema,
    assets: z.record(EditableProjectPathSchema, Sha256Schema),
    outputs: z.record(z.string().min(1), Sha256Schema),
  }).strict(),
}).strict().superRefine((record, context) => {
  const expectedOutput = `editable/${record.slideId}/${record.revisionId}/source-1280x720.png`;
  if (
    record.prepareEditableInput.output1280x720.path !== expectedOutput
    || record.prepareEditableInput.output1280x720.revisionId !== record.projectRevisionId
    || record.prepareEditableInput.output1280x720.sha256 !== record.artifacts.sourceImage
  ) context.addIssue({ code: "custom", path: ["prepareEditableInput", "output1280x720"], message: "prepared editable input must bind the conversion source artifact" });
  if (
    record.prepareEditableInput.sourceMaster.path !== record.finalRender.path
    || record.prepareEditableInput.sourceMaster.sha256 !== record.finalRender.sha256
    || record.prepareEditableInput.sourceMaster.revisionId !== record.projectRevisionId
  ) context.addIssue({ code: "custom", path: ["prepareEditableInput", "sourceMaster"], message: "prepared editable input must bind the selected source master" });
});

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

export const PromoteEditableIntentSchema = z.object({
  kind: z.literal("promote-editable"),
  elementId: z.string().min(1),
  elementKind: z.enum(["text", "asset"]),
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
  intent: PromoteEditableIntentSchema.optional(),
  artifacts: z.object({
    modifiedManifest: Sha256Schema,
    cleanBackground: Sha256Schema,
    assets: z.record(EditableProjectPathSchema, Sha256Schema),
  }).strict(),
}).strict();

export type EditableManifest = z.infer<typeof EditableManifestSchema>;
export type EditableManifestV2 = z.infer<typeof EditableManifestV2Schema>;
export type RunLedgerV2 = z.infer<typeof RunLedgerV2Schema>;
export type AuthenticatedEditableConversion = z.infer<typeof AuthenticatedEditableConversionSchema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;
export type EditableRevisionMarker = z.infer<typeof EditableRevisionMarkerSchema>;
export type EditableStagingMarker = z.infer<typeof EditableStagingMarkerSchema>;
export type EditableConversionStagingMarker = z.infer<typeof EditableConversionStagingMarkerSchema>;
export type ModifiedManifest = z.infer<typeof ModifiedManifestSchema>;
export type ModifiedRevisionRecord = z.infer<typeof ModifiedRevisionRecordSchema>;
export type PromoteEditableIntent = z.infer<typeof PromoteEditableIntentSchema>;
