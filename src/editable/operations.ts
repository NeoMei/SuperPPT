import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import sharp from "sharp";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { validateProjectRoot } from "../project/paths.js";
import { promoteExclusive } from "../project/exclusive.js";
import { readOwnedRegularFile, readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { validateEditableConversionOutput } from "./adapter.js";
import {
  ConversionRecordSchema,
  EditPlanSchema,
  EditableManifestSchema,
  EditableRevisionMarkerSchema,
  EditableSlideMarkerSchema,
  EditableStagingMarkerSchema,
  ModifiedManifestSchema,
  ModifiedRevisionRecordSchema,
  PromoteEditableIntentSchema,
  type EditPlan,
  type EditableManifest,
  type EditableStagingMarker,
  type ModifiedRevisionRecord,
  type PromoteEditableIntent,
} from "./schemas.js";

export class UnsupportedEditableTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEditableTargetError";
  }
}

export class AlreadyEditableSlideError extends Error {
  constructor() {
    super("page is already editable; use an explicit non-empty edit plan");
    this.name = "AlreadyEditableSlideError";
  }
}

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const MAX_REPLACEMENT_ASSET_BYTES = 64 * 1024 * 1024;

type EditableLayoutIdentity = {
  root: string;
  editableRoot: string;
  slideRoot: string;
  sourceRoot: string;
  slideId: string;
  sourceRevisionId: string;
};

async function requireDirectory(path: string, message: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(message);
}

async function assertEditableSlideIdentity(identity: EditableLayoutIdentity): Promise<void> {
  const expectedEditableRoot = join(identity.root, "editable");
  const expectedSlideRoot = join(expectedEditableRoot, identity.slideId);
  if (
    identity.editableRoot !== expectedEditableRoot
    || identity.slideRoot !== expectedSlideRoot
    || dirname(identity.editableRoot) !== identity.root
    || dirname(identity.slideRoot) !== identity.editableRoot
    || basename(identity.slideRoot) !== identity.slideId
  ) throw new Error("editable slide layout is not an exact project child path");
  for (const path of [identity.root, identity.editableRoot, identity.slideRoot]) {
    await requireDirectory(path, "editable layout is unsafe or contains a symlink");
    if (await realpath(path) !== path) throw new Error("editable layout canonical identity mismatch");
  }
}

async function assertEditableLayoutIdentity(identity: EditableLayoutIdentity): Promise<void> {
  await assertEditableSlideIdentity(identity);
  const expectedSourceRoot = join(identity.slideRoot, identity.sourceRevisionId);
  if (
    identity.sourceRoot !== expectedSourceRoot
    || dirname(identity.sourceRoot) !== identity.slideRoot
    || basename(identity.sourceRoot) !== identity.sourceRevisionId
  ) throw new Error("editable source layout is not an exact slide child path");
  await requireDirectory(identity.sourceRoot, "editable source layout is unsafe or contains a symlink");
  if (await realpath(identity.sourceRoot) !== identity.sourceRoot) {
    throw new Error("editable source layout canonical identity mismatch");
  }
}

async function ownedStaging(revisionRoot: string): Promise<EditableStagingMarker> {
  const lexical = resolve(revisionRoot);
  try {
    await requireDirectory(lexical, "replacement destination must be an owned editable staging directory");
    if (await realpath(lexical) !== lexical) throw new Error("staging canonical path mismatch");
    const raw = await readRegularFileNoFollow(join(lexical, ".superppt-editable-staging.json"));
    const marker = EditableStagingMarkerSchema.parse(JSON.parse(raw.toString("utf8")));
    if (
      basename(lexical) !== marker.stagingName
      || basename(dirname(lexical)) !== marker.slideId
    ) throw new Error("staging path identity mismatch");
    return marker;
  } catch (error: unknown) {
    throw new Error("replacement destination must be an owned editable staging directory with canonical identity", { cause: error });
  }
}

async function ensureChildDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await requireDirectory(path, "editable revision asset directory is unsafe");
  return path;
}

async function transparentPng(bytes: Buffer): Promise<boolean> {
  try {
    const metadata = await sharp(bytes).metadata();
    if (metadata.format !== "png" || !metadata.hasAlpha) return false;
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = info.channels - 1;
    for (let index = alpha; index < data.length; index += info.channels) {
      if (data[index]! < 255) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function prepareReplacementAssets(
  rawPlan: unknown,
  revisionRoot: string,
): Promise<EditPlan> {
  const plan = EditPlanSchema.parse(structuredClone(rawPlan));
  if (plan.route === "regenerate") return plan;
  if (!plan.operations.some((operation) => operation.kind === "replace-asset")) return plan;
  await ownedStaging(revisionRoot);
  const assets = await ensureChildDirectory(revisionRoot, "assets");
  const replacements = await ensureChildDirectory(assets, "replacements");

  for (const operation of plan.operations) {
    if (operation.kind !== "replace-asset") continue;
    if (extname(operation.assetPath).toLowerCase() !== ".png") {
      throw new Error("replacement asset must be a regular non-symlink transparent PNG");
    }
    let info;
    try {
      info = await lstat(operation.assetPath);
    } catch (error: unknown) {
      throw new Error("replacement asset must be a regular non-symlink transparent PNG", { cause: error });
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("replacement asset must be a regular non-symlink transparent PNG");
    }
    if (info.size <= 0 || info.size > MAX_REPLACEMENT_ASSET_BYTES) {
      throw new Error("replacement asset size limit requires 1 byte through 64 MiB");
    }
    let bytes: Buffer;
    try {
      bytes = await readRegularFileNoFollow(operation.assetPath);
    } catch (error: unknown) {
      throw new Error("replacement asset must be a regular non-symlink transparent PNG", { cause: error });
    }
    if (bytes.length <= 0 || bytes.length > MAX_REPLACEMENT_ASSET_BYTES) {
      throw new Error("replacement asset size limit requires 1 byte through 64 MiB");
    }
    if (!await transparentPng(bytes)) {
      throw new Error("replacement asset must be a regular non-symlink transparent PNG");
    }
    const name = `${randomUUID()}.png`;
    const target = join(replacements, name);
    await writeDurableExclusive(target, bytes);
    const copied = await readRegularFileNoFollow(target);
    if (sha256(copied) !== sha256(bytes) || !await transparentPng(copied)) {
      throw new Error("replacement asset copy failed validation");
    }
    await syncDirectory(replacements);
    operation.assetPath = `assets/replacements/${name}`;
  }
  return plan;
}

export function applyEditPlan(input: unknown, rawPlan: unknown): EditableManifest {
  const manifest = structuredClone(EditableManifestSchema.parse(input));
  const plan = EditPlanSchema.parse(rawPlan);
  if (plan.route === "regenerate") throw new UnsupportedEditableTargetError(plan.reason);
  validateEditTargets(manifest, plan);
  for (const operation of plan.operations) {
    const element = manifest.elements.find((candidate) => candidate.id === operation.elementId)!;
    if (operation.kind === "replace-text") {
      if (element.kind !== "text") throw new Error("prevalidated text target changed");
      element.text = operation.text;
    } else if (operation.kind === "set-text-style") {
      if (element.kind !== "text") throw new Error("prevalidated text target changed");
      if (operation.color !== undefined) element.color = operation.color;
      if (operation.fontSizePx !== undefined) element.fontSizePx = operation.fontSizePx;
      if (operation.bold !== undefined) element.bold = operation.bold;
      if (operation.align !== undefined) element.align = operation.align;
    } else if (operation.kind === "move-asset") {
      if (element.kind !== "asset") throw new Error("prevalidated asset target changed");
      element.bbox = operation.bbox;
    } else {
      if (element.kind !== "asset") throw new Error("prevalidated asset target changed");
      element.assetPath = operation.assetPath;
    }
  }
  return EditableManifestSchema.parse(manifest);
}

function validateEditTargets(manifest: EditableManifest, plan: Extract<EditPlan, { route: "editable" }>): void {
  for (const operation of plan.operations) {
    const element = manifest.elements.find((candidate) => candidate.id === operation.elementId);
    if (!element) throw new UnsupportedEditableTargetError(`target is not an editable manifest element: ${operation.elementId}`);
    if ((operation.kind === "replace-text" || operation.kind === "set-text-style") && element.kind !== "text") {
      throw new UnsupportedEditableTargetError(`${operation.kind} requires a text element`);
    }
    if ((operation.kind === "move-asset" || operation.kind === "replace-asset") && element.kind !== "asset") {
      throw new UnsupportedEditableTargetError(`${operation.kind} requires a transparent asset`);
    }
  }
}

async function parsedRegularFile<T>(path: string, label: string, parse: (value: unknown) => T): Promise<{ value: T; bytes: Buffer }> {
  let bytes: Buffer;
  try {
    bytes = await readRegularFileNoFollow(path);
    return { value: parse(JSON.parse(bytes.toString("utf8"))), bytes };
  } catch (error: unknown) {
    throw new Error(`${label} is unsafe or invalid`, { cause: error });
  }
}

async function copyExpectedFile(source: string, target: string, expected: string): Promise<void> {
  const bytes = await readRegularFileNoFollow(source);
  if (sha256(bytes) !== expected) throw new Error("source editable artifact hash changed before copy");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeDurableExclusive(target, bytes);
  const copied = await readRegularFileNoFollow(target);
  if (sha256(copied) !== expected) throw new Error("editable revision copy hash mismatch");
}

async function assetHashes(root: string): Promise<Record<string, string>> {
  const assetsRoot = join(root, "assets");
  if (await realpath(assetsRoot) !== assetsRoot) throw new Error("modified revision asset directory is unsafe");
  const result: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const projectPath = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("modified revision assets cannot contain symlinks");
      if (entry.isDirectory()) await walk(path, projectPath);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".png") {
        result[projectPath] = sha256(await readRegularFileNoFollow(path));
      } else throw new Error("modified revision assets must contain only PNG files and directories");
    }
  }
  await walk(assetsRoot, "assets");
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

async function cleanupOwnedStaging(
  staging: string,
  expected: EditableStagingMarker,
  layout: EditableLayoutIdentity,
): Promise<void> {
  let stagingInfo;
  try {
    stagingInfo = await lstat(staging);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("owned editable staging cleanup failed", { cause: error });
  }
  try {
    await assertEditableSlideIdentity(layout);
    if (dirname(staging) !== layout.slideRoot) throw new Error("staging is not an exact editable slide child");
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) {
      throw new Error("staging directory changed before cleanup");
    }
    if (await realpath(staging) !== resolve(staging) || basename(staging) !== expected.stagingName) {
      throw new Error("staging canonical identity changed before cleanup");
    }
    let identityMatches = false;
    try {
      const actual = await ownedStaging(staging);
      identityMatches = JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      const sealed = await parsedRegularFile(
        join(staging, ".superppt-editable-revision.json"),
        "sealed staging revision marker",
        (value) => EditableRevisionMarkerSchema.parse(value),
      );
      identityMatches = sealed.value.projectId === expected.projectId
        && sealed.value.slideId === expected.slideId
        && sealed.value.revisionId === expected.revisionId
        && sealed.value.parentRevisionId === expected.parentRevisionId
        && sealed.value.revisionKind === "modified";
    }
    if (!identityMatches) throw new Error("staging marker changed before cleanup");
    await rm(staging, { recursive: true, force: false });
    await syncDirectory(dirname(staging));
  } catch (error: unknown) {
    throw new Error("owned editable staging cleanup failed", { cause: error });
  }
}

async function validateModifiedRevisionAt(
  revisionRoot: string,
  expectedRevisionId: string,
  expectedStagingMarker?: EditableStagingMarker,
  externallyExpectedRecordSha256?: string,
): Promise<{
  record: ModifiedRevisionRecord;
  manifest: EditableManifest;
}> {
  const lexical = resolve(revisionRoot);
  await requireDirectory(lexical, "modified revision is unsafe or invalid");
  if (await realpath(lexical) !== lexical) throw new Error("modified revision canonical path mismatch");
  const marker = await parsedRegularFile(
    join(lexical, ".superppt-editable-revision.json"),
    "modified revision marker",
    (value) => EditableRevisionMarkerSchema.parse(value),
  );
  if (
    marker.value.revisionKind !== "modified"
    || marker.value.revisionId !== expectedRevisionId
    || !marker.value.parentRevisionId
    || !marker.value.modifiedRevisionRecordSha256
  ) throw new Error("modified revision marker identity is invalid");
  const stagingMarkerPath = join(lexical, ".superppt-editable-staging.json");
  if (expectedStagingMarker) {
    const stagingMarker = await parsedRegularFile(
      stagingMarkerPath,
      "modified revision staging marker",
      (value) => EditableStagingMarkerSchema.parse(value),
    );
    if (JSON.stringify(stagingMarker.value) !== JSON.stringify(expectedStagingMarker)) {
      throw new Error("modified revision staging marker identity mismatch");
    }
  } else {
    try {
      await lstat(stagingMarkerPath);
      throw new Error("modified revision still contains a staging marker");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const record = await parsedRegularFile(
    join(lexical, "modified-revision-record.json"),
    "modified revision record",
    (value) => ModifiedRevisionRecordSchema.parse(value),
  );
  if (externallyExpectedRecordSha256 && sha256(record.bytes) !== externallyExpectedRecordSha256) {
    throw new Error("modified revision record does not match the external project-state anchor");
  }
  if (sha256(record.bytes) !== marker.value.modifiedRevisionRecordSha256) throw new Error("modified revision record hash mismatch");
  if (
    record.value.projectId !== marker.value.projectId
    || record.value.slideId !== marker.value.slideId
    || record.value.revisionId !== marker.value.revisionId
    || record.value.parentRevisionId !== marker.value.parentRevisionId
  ) throw new Error("modified revision record identity mismatch");
  const sourceRoot = join(dirname(lexical), record.value.sourceRevisionId);
  const sourceRecord = await parsedRegularFile(
    join(sourceRoot, "conversion-record.json"),
    "source conversion record",
    (value) => ConversionRecordSchema.parse(value),
  );
  if (
    sha256(sourceRecord.bytes) !== record.value.sourceConversionRecordSha256
    || sourceRecord.value.projectId !== record.value.projectId
    || sourceRecord.value.slideId !== record.value.slideId
    || sourceRecord.value.revisionId !== record.value.sourceRevisionId
    || sourceRecord.value.projectRevisionId !== record.value.projectRevisionId
    || JSON.stringify(sourceRecord.value.finalRender) !== JSON.stringify(record.value.finalRender)
    || sourceRecord.value.artifacts.manifest !== record.value.sourceManifestSha256
  ) throw new Error("modified revision source identity mismatch");
  const authenticatedSource = await validateEditableConversionOutput({
    sourcePng: join(sourceRoot, "source-1280x720.png"),
    outDir: sourceRoot,
  });
  if (JSON.stringify(authenticatedSource.artifactHashes) !== JSON.stringify(sourceRecord.value.artifacts)) {
    throw new Error("modified revision source artifacts are no longer authentic");
  }
  const manifest = await parsedRegularFile(
    join(lexical, "modified-manifest.json"),
    "modified manifest",
    (value) => ModifiedManifestSchema.parse(value),
  );
  if (
    sha256(manifest.bytes) !== record.value.artifacts.modifiedManifest
    || manifest.value.sourceRevisionId !== record.value.parentRevisionId
    || manifest.value.sourceManifestSha256 !== record.value.sourceManifestSha256
  ) throw new Error("modified manifest hash mismatch");
  if (record.value.intent) {
    if (record.value.parentRevisionId !== record.value.sourceRevisionId) {
      throw new Error("promote-editable must derive directly from its authenticated conversion revision");
    }
    validatePromotionTarget(authenticatedSource.manifest, record.value.intent);
    if (JSON.stringify(manifest.value.manifest) !== JSON.stringify(authenticatedSource.manifest)) {
      throw new Error("promote-editable modified content instead of preserving the conversion manifest");
    }
  }
  const background = await readRegularFileNoFollow(join(lexical, "clean-background.png"));
  if (sha256(background) !== record.value.artifacts.cleanBackground) throw new Error("modified clean background hash mismatch");
  const actualAssets = await assetHashes(lexical);
  if (JSON.stringify(actualAssets) !== JSON.stringify(record.value.artifacts.assets)) throw new Error("modified revision asset hash mismatch");
  const referenced = manifest.value.manifest.elements.flatMap((element) => element.kind === "asset" ? [element.assetPath] : []).sort();
  if (referenced.some((path) => !actualAssets[path])) throw new Error("modified manifest references an unauthenticated asset");
  return { record: record.value, manifest: manifest.value.manifest };
}

export async function validateModifiedRevision(revisionRoot: string, externallyExpectedRecordSha256?: string): Promise<{
  record: ModifiedRevisionRecord;
  manifest: EditableManifest;
}> {
  return validateModifiedRevisionAt(
    revisionRoot,
    basename(resolve(revisionRoot)),
    undefined,
    externallyExpectedRecordSha256,
  );
}

export type AppliedEditRevision = {
  revisionId: string;
  revisionRoot: string;
  modifiedManifestPath: string;
  manifest: EditableManifest;
};

type ProjectModifiedRevisionOptions = {
  root: string;
  slideId: string;
  sourceRevisionId: string;
  idFactory?: () => string;
  operations?: {
    afterSourceValidation?: () => Promise<void> | void;
    beforeSealValidation?: (staging: string) => Promise<void> | void;
    duringRevisionMarkerWrite?: () => Promise<void> | void;
    afterRevisionMarkerWrite?: (staging: string, markerPath: string) => Promise<void> | void;
  };
};

type ModifiedRevisionRequest =
  | { kind: "edit-plan"; plan: Extract<EditPlan, { route: "editable" }> }
  | { kind: "promote-editable"; intent: PromoteEditableIntent };

function validatePromotionTarget(manifest: EditableManifest, intent: PromoteEditableIntent): void {
  const element = manifest.elements.find((candidate) => candidate.id === intent.elementId);
  if (!element) {
    throw new UnsupportedEditableTargetError(
      `target was not extracted as an editable element; route regenerate: ${intent.elementId}`,
    );
  }
  if (element.kind !== intent.elementKind) {
    throw new UnsupportedEditableTargetError(
      `target kind is ${element.kind}, not ${intent.elementKind}; route regenerate`,
    );
  }
}

async function createProjectModifiedRevision(
  options: ProjectModifiedRevisionOptions,
  request: ModifiedRevisionRequest,
): Promise<AppliedEditRevision> {
  const project = await readProject(options.root);
  const root = await validateProjectRoot(options.root);
  const slide = project.slides.find((candidate) => candidate.id === options.slideId);
  if (!slide) throw new Error("editable apply slide ID is not in the current project");
  EditableRevisionMarkerSchema.shape.revisionId.parse(options.sourceRevisionId);
  const currentEditable = slide.status === "editable" ? slide.editableRevision : null;
  if (slide.status === "editable" && !currentEditable) {
    throw new Error("editable re-edit requires the current project-state modified revision anchor");
  }
  if (currentEditable && currentEditable.modifiedRevisionId !== options.sourceRevisionId) {
    throw new Error("editable re-edit must use the current modified revision");
  }
  const layout: EditableLayoutIdentity = {
    root,
    editableRoot: join(root, "editable"),
    slideRoot: join(root, "editable", slide.id),
    sourceRoot: join(root, "editable", slide.id, options.sourceRevisionId),
    slideId: slide.id,
    sourceRevisionId: options.sourceRevisionId,
  };
  await assertEditableLayoutIdentity(layout);
  const { slideRoot, sourceRoot } = layout;
  const slideMarker = await parsedRegularFile(
    join(slideRoot, ".superppt-editable-slide.json"),
    "editable slide marker",
    (value) => EditableSlideMarkerSchema.parse(value),
  );
  if (slideMarker.value.projectId !== project.projectId || slideMarker.value.slideId !== slide.id) {
    throw new Error("editable slide marker identity mismatch");
  }

  const sourceMarker = await parsedRegularFile(
    join(sourceRoot, ".superppt-editable-revision.json"),
    "source editable revision marker",
    (value) => EditableRevisionMarkerSchema.parse(value),
  );
  if (
    sourceMarker.value.projectId !== project.projectId
    || sourceMarker.value.slideId !== slide.id
    || sourceMarker.value.revisionId !== options.sourceRevisionId
    || (!currentEditable && sourceMarker.value.revisionKind !== "conversion")
    || (currentEditable && sourceMarker.value.revisionKind !== "modified")
  ) throw new Error("apply-edit requires the authenticated current editable revision");
  let sourceManifest: EditableManifest;
  let sourceConversionRecordSha256: string;
  let sourceProjectRevisionId: string;
  let sourceFinalRender: { path: string; sha256: string };
  let sourceBackgroundSha256: string;
  let sourceAssetHashes: Record<string, string>;
  let originalSourceManifestSha256: string;
  let deckReviewSelection: {
    candidateId: string;
    reviewDescriptorSha256: string;
    actionEvidenceSha256: string;
  } | null = null;
  if (currentEditable) {
    const modified = await validateModifiedRevision(sourceRoot, currentEditable.expectedModifiedRevisionRecordSha256);
    sourceManifest = modified.manifest;
    originalSourceManifestSha256 = modified.record.sourceManifestSha256;
    sourceConversionRecordSha256 = modified.record.sourceConversionRecordSha256;
    sourceProjectRevisionId = modified.record.projectRevisionId;
    sourceFinalRender = modified.record.finalRender;
    sourceBackgroundSha256 = modified.record.artifacts.cleanBackground;
    sourceAssetHashes = modified.record.artifacts.assets;
  } else {
    const conversionRecord = await parsedRegularFile(
      join(sourceRoot, "conversion-record.json"),
      "editable conversion record",
      (value) => ConversionRecordSchema.parse(value),
    );
    if (
      conversionRecord.value.projectId !== project.projectId
      || conversionRecord.value.slideId !== slide.id
      || conversionRecord.value.revisionId !== options.sourceRevisionId
    ) throw new Error("editable conversion record identity mismatch");
    const source = await validateEditableConversionOutput({
      sourcePng: join(sourceRoot, "source-1280x720.png"),
      outDir: sourceRoot,
    });
    if (JSON.stringify(conversionRecord.value.artifacts) !== JSON.stringify(source.artifactHashes)) {
      throw new Error("editable conversion record no longer authenticates converter output");
    }
    sourceManifest = source.manifest;
    originalSourceManifestSha256 = source.artifactHashes.manifest;
    sourceConversionRecordSha256 = sha256(conversionRecord.bytes);
    sourceProjectRevisionId = conversionRecord.value.projectRevisionId;
    sourceFinalRender = conversionRecord.value.finalRender;
    sourceBackgroundSha256 = source.artifactHashes.cleanBackground;
    sourceAssetHashes = source.artifactHashes.assets;
    deckReviewSelection = conversionRecord.value.deckReviewSelection;
  }
  let currentFinalRender = slide.finalRender;
  if (!currentEditable && !currentFinalRender && deckReviewSelection) {
    const selected = await (await import("../project/promotion.js")).authenticateCurrentDeckEditSelection(root, slide.id);
    if (
      selected.candidateId !== deckReviewSelection.candidateId
      || selected.reviewDescriptorSha256 !== deckReviewSelection.reviewDescriptorSha256
      || selected.actionEvidenceSha256 !== deckReviewSelection.actionEvidenceSha256
    ) throw new Error("source reviewed deck selection is stale");
    currentFinalRender = selected.sourceMaster;
  }
  const currentRender = currentFinalRender
    ? await readOwnedRegularFile(root, currentFinalRender.path).catch(() => null)
    : null;
  if (
    sourceProjectRevisionId !== project.currentRevision.id
    || !currentFinalRender
    || (slide.status !== "ready" && slide.status !== "editable")
    || currentFinalRender.revisionId !== project.currentRevision.id
    || !currentRender
    || sha256(currentRender) !== currentFinalRender.sha256
    || (!currentEditable && (
      sourceFinalRender.path !== currentFinalRender.path
      || sourceFinalRender.sha256 !== currentFinalRender.sha256
    ))
    || (currentEditable && (
      currentEditable.projectRevisionId !== project.currentRevision.id
      || JSON.stringify(currentEditable.preview) !== JSON.stringify(slide.finalRender)
      || JSON.stringify(currentEditable.conversionFinalRender) !== JSON.stringify({
        path: sourceFinalRender.path,
        sha256: sourceFinalRender.sha256,
        revisionId: project.currentRevision.id,
      })
    ))
  ) throw new Error("source project revision or final render is stale");
  if (request.kind === "edit-plan") {
    validateEditTargets(sourceManifest, request.plan);
  } else {
    validatePromotionTarget(sourceManifest, request.intent);
    if (currentEditable) throw new AlreadyEditableSlideError();
  }
  await options.operations?.afterSourceValidation?.();
  await assertEditableLayoutIdentity(layout);

  const revisionId = options.idFactory?.() ?? randomUUID();
  EditableRevisionMarkerSchema.shape.revisionId.parse(revisionId);
  const revisionRoot = join(slideRoot, revisionId);
  try {
    await lstat(revisionRoot);
    throw new Error("editable revision target already exists");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagingName = `.staging-${revisionId}-${randomUUID()}`;
  const staging = join(slideRoot, stagingName);
  const stagingMarker = EditableStagingMarkerSchema.parse({
    stagingMarkerVersion: 1,
    appId: "superppt",
    artifactKind: "editable-slide-staging",
    projectId: project.projectId,
    slideId: slide.id,
    revisionId,
    parentRevisionId: options.sourceRevisionId,
    stagingName,
  });
  await mkdir(staging, { mode: 0o700 });
  await writeDurableExclusive(join(staging, ".superppt-editable-staging.json"), `${JSON.stringify(stagingMarker, null, 2)}\n`);
  try {
    await assertEditableLayoutIdentity(layout);
    await ownedStaging(staging);
    await mkdir(join(staging, "assets"), { mode: 0o700 });
    await assertEditableLayoutIdentity(layout);
    await copyExpectedFile(
      join(sourceRoot, "clean-background.png"),
      join(staging, "clean-background.png"),
      sourceBackgroundSha256,
    );
    for (const [assetPath, expected] of Object.entries(sourceAssetHashes)) {
      await assertEditableLayoutIdentity(layout);
      await copyExpectedFile(
        join(sourceRoot, ...assetPath.split("/")),
        join(staging, ...assetPath.split("/")),
        expected,
      );
    }
    await assertEditableLayoutIdentity(layout);
    const modified = request.kind === "edit-plan"
      ? applyEditPlan(sourceManifest, await prepareReplacementAssets(request.plan, staging))
      : EditableManifestSchema.parse(structuredClone(sourceManifest));
    const modifiedManifestPath = join(staging, "modified-manifest.json");
    const modifiedManifestBytes = Buffer.from(`${JSON.stringify(ModifiedManifestSchema.parse({
      modifiedManifestVersion: 1,
      sourceRevisionId: options.sourceRevisionId,
      sourceManifestSha256: originalSourceManifestSha256,
      manifest: modified,
    }), null, 2)}\n`);
    await writeDurableExclusive(modifiedManifestPath, modifiedManifestBytes);
    const background = await readRegularFileNoFollow(join(staging, "clean-background.png"));
    const record = ModifiedRevisionRecordSchema.parse({
      modifiedRevisionRecordVersion: 1,
      projectId: project.projectId,
      slideId: slide.id,
      revisionId,
      parentRevisionId: options.sourceRevisionId,
      sourceRevisionId: currentEditable?.sourceRevisionId ?? options.sourceRevisionId,
      sourceConversionRecordSha256,
      projectRevisionId: sourceProjectRevisionId,
      finalRender: sourceFinalRender,
      sourceManifestSha256: originalSourceManifestSha256,
      ...(request.kind === "promote-editable" ? { intent: request.intent } : {}),
      artifacts: {
        modifiedManifest: sha256(modifiedManifestBytes),
        cleanBackground: sha256(background),
        assets: await assetHashes(staging),
      },
    });
    const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    await writeDurableExclusive(join(staging, "modified-revision-record.json"), recordBytes);
    const revisionMarkerPath = join(staging, ".superppt-editable-revision.json");
    await writeDurableExclusive(revisionMarkerPath, `${JSON.stringify(EditableRevisionMarkerSchema.parse({
      markerVersion: 1,
      appId: "superppt",
      artifactKind: "editable-slide-revision",
      projectId: project.projectId,
      slideId: slide.id,
      revisionId,
      revisionKind: "modified",
      parentRevisionId: options.sourceRevisionId,
      modifiedRevisionRecordSha256: sha256(recordBytes),
    }), null, 2)}\n`, options.operations?.duringRevisionMarkerWrite);
    await options.operations?.afterRevisionMarkerWrite?.(staging, revisionMarkerPath);
    await syncDirectory(join(staging, "assets"));
    await syncDirectory(staging);
    await options.operations?.beforeSealValidation?.(staging);
    await validateModifiedRevisionAt(staging, revisionId, stagingMarker);
    await unlink(join(staging, ".superppt-editable-staging.json"));
    await syncDirectory(staging);
    await validateModifiedRevisionAt(staging, revisionId);
    await assertEditableLayoutIdentity(layout);
    await syncDirectory(slideRoot);
    await promoteExclusive(staging, revisionRoot);
    await syncDirectory(slideRoot);
    return {
      revisionId,
      revisionRoot,
      modifiedManifestPath: join(revisionRoot, "modified-manifest.json"),
      manifest: modified,
    };
  } catch (error: unknown) {
    try {
      await cleanupOwnedStaging(staging, stagingMarker, layout);
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], "editable apply failed and owned staging cleanup failed");
    }
    throw error;
  }
}

export async function applyProjectEditPlan(options: ProjectModifiedRevisionOptions & {
  rawPlan: unknown;
}): Promise<AppliedEditRevision> {
  const plan = EditPlanSchema.parse(options.rawPlan);
  if (plan.route === "regenerate") throw new UnsupportedEditableTargetError(plan.reason);
  return createProjectModifiedRevision(options, { kind: "edit-plan", plan });
}

export async function promoteProjectEditableTarget(options: ProjectModifiedRevisionOptions & {
  elementId: string;
  expectedKind: "text" | "asset";
}): Promise<AppliedEditRevision> {
  const intent = PromoteEditableIntentSchema.parse({
    kind: "promote-editable",
    elementId: options.elementId,
    elementKind: options.expectedKind,
  });
  return createProjectModifiedRevision(options, { kind: "promote-editable", intent });
}
