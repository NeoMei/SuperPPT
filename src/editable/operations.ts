import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import sharp from "sharp";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { validateProjectRoot } from "../project/paths.js";
import { promoteExclusive } from "../project/promotion.js";
import { readOwnedRegularFile, readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { validateEditableConversionOutput } from "./adapter.js";
import {
  ConversionRecordSchema,
  EditPlanSchema,
  EditableManifestSchema,
  EditableRevisionMarkerSchema,
  EditableSlideMarkerSchema,
  ModifiedManifestSchema,
  type EditPlan,
  type EditableManifest,
} from "./schemas.js";

export class UnsupportedEditableTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEditableTargetError";
  }
}

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const MAX_REPLACEMENT_ASSET_BYTES = 64 * 1024 * 1024;

async function requireDirectory(path: string, message: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(message);
}

async function ensureOwnedRevision(revisionRoot: string): Promise<void> {
  await requireDirectory(revisionRoot, "replacement destination must be an owned editable revision");
  let raw: Buffer;
  try {
    raw = await readRegularFileNoFollow(join(revisionRoot, ".superppt-editable-revision.json"));
    EditableRevisionMarkerSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("replacement destination must be an owned editable revision", { cause: error });
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
  await ensureOwnedRevision(revisionRoot);
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
  for (const operation of plan.operations) {
    const element = manifest.elements.find((candidate) => candidate.id === operation.elementId);
    if (!element) {
      throw new UnsupportedEditableTargetError(`target is not an editable manifest element: ${operation.elementId}`);
    }
    if (operation.kind === "replace-text") {
      if (element.kind !== "text") throw new UnsupportedEditableTargetError("replace-text requires a text element");
      element.text = operation.text;
    } else if (operation.kind === "set-text-style") {
      if (element.kind !== "text") throw new UnsupportedEditableTargetError("set-text-style requires a text element");
      if (operation.color !== undefined) element.color = operation.color;
      if (operation.fontSizePx !== undefined) element.fontSizePx = operation.fontSizePx;
      if (operation.bold !== undefined) element.bold = operation.bold;
      if (operation.align !== undefined) element.align = operation.align;
    } else if (operation.kind === "move-asset") {
      if (element.kind !== "asset" || element.extraction !== "transparent") {
        throw new UnsupportedEditableTargetError("move-asset requires a transparent asset");
      }
      element.bbox = operation.bbox;
    } else {
      if (element.kind !== "asset" || element.extraction !== "transparent") {
        throw new UnsupportedEditableTargetError("replace-asset requires a transparent asset");
      }
      element.assetPath = operation.assetPath;
    }
  }
  return EditableManifestSchema.parse(manifest);
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

async function copyAuthenticatedFile(source: string, target: string): Promise<void> {
  const bytes = await readRegularFileNoFollow(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeDurableExclusive(target, bytes);
  const copied = await readRegularFileNoFollow(target);
  if (sha256(copied) !== sha256(bytes)) throw new Error("editable revision copy hash mismatch");
}

export type AppliedEditRevision = {
  revisionId: string;
  revisionRoot: string;
  modifiedManifestPath: string;
  manifest: EditableManifest;
};

export async function applyProjectEditPlan(options: {
  root: string;
  slideId: string;
  sourceRevisionId: string;
  rawPlan: unknown;
  idFactory?: () => string;
}): Promise<AppliedEditRevision> {
  const plan = EditPlanSchema.parse(options.rawPlan);
  if (plan.route === "regenerate") throw new UnsupportedEditableTargetError(plan.reason);
  const project = await readProject(options.root);
  const root = await validateProjectRoot(options.root);
  const slide = project.slides.find((candidate) => candidate.id === options.slideId);
  if (!slide) throw new Error("editable apply slide ID is not in the current project");
  EditableRevisionMarkerSchema.shape.revisionId.parse(options.sourceRevisionId);
  const slideRoot = join(root, "editable", slide.id);
  await requireDirectory(slideRoot, "editable slide path is unsafe or unowned");
  const slideMarker = await parsedRegularFile(
    join(slideRoot, ".superppt-editable-slide.json"),
    "editable slide marker",
    (value) => EditableSlideMarkerSchema.parse(value),
  );
  if (slideMarker.value.projectId !== project.projectId || slideMarker.value.slideId !== slide.id) {
    throw new Error("editable slide marker identity mismatch");
  }

  const sourceRoot = join(slideRoot, options.sourceRevisionId);
  await requireDirectory(sourceRoot, "source editable revision is unsafe or unowned");
  const sourceMarker = await parsedRegularFile(
    join(sourceRoot, ".superppt-editable-revision.json"),
    "source editable revision marker",
    (value) => EditableRevisionMarkerSchema.parse(value),
  );
  if (
    sourceMarker.value.projectId !== project.projectId
    || sourceMarker.value.slideId !== slide.id
    || sourceMarker.value.revisionId !== options.sourceRevisionId
    || sourceMarker.value.revisionKind !== "conversion"
  ) throw new Error("apply-edit requires an authenticated converter revision");
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
  const currentRender = slide.finalRender
    ? await readOwnedRegularFile(root, slide.finalRender.path).catch(() => null)
    : null;
  if (
    conversionRecord.value.projectRevisionId !== project.currentRevision.id
    || !slide.finalRender
    || slide.status !== "ready"
    || conversionRecord.value.finalRender.path !== slide.finalRender.path
    || conversionRecord.value.finalRender.sha256 !== slide.finalRender.sha256
    || slide.finalRender.revisionId !== project.currentRevision.id
    || !currentRender
    || sha256(currentRender) !== conversionRecord.value.finalRender.sha256
  ) throw new Error("source project revision or final render is stale");
  const source = await validateEditableConversionOutput({
    sourcePng: join(sourceRoot, "source-1280x720.png"),
    outDir: sourceRoot,
  });
  if (JSON.stringify(conversionRecord.value.artifacts) !== JSON.stringify(source.artifactHashes)) {
    throw new Error("editable conversion record no longer authenticates converter output");
  }

  const revisionId = options.idFactory?.() ?? randomUUID();
  EditableRevisionMarkerSchema.shape.revisionId.parse(revisionId);
  const revisionRoot = join(slideRoot, revisionId);
  try {
    await lstat(revisionRoot);
    throw new Error("editable revision target already exists");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = join(slideRoot, `.staging-${revisionId}-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  await writeDurableExclusive(join(staging, ".superppt-editable-revision.json"), `${JSON.stringify(EditableRevisionMarkerSchema.parse({
    markerVersion: 1,
    appId: "superppt",
    artifactKind: "editable-slide-revision",
    projectId: project.projectId,
    slideId: slide.id,
    revisionId,
    revisionKind: "modified",
    parentRevisionId: options.sourceRevisionId,
  }), null, 2)}\n`);
  await mkdir(join(staging, "assets"), { mode: 0o700 });
  await copyAuthenticatedFile(source.cleanBackground, join(staging, "clean-background.png"));
  for (const assetPath of Object.keys(source.artifactHashes.assets)) {
    await copyAuthenticatedFile(
      join(sourceRoot, ...assetPath.split("/")),
      join(staging, ...assetPath.split("/")),
    );
  }
  const prepared = await prepareReplacementAssets(plan, staging);
  const modified = applyEditPlan(source.manifest, prepared);
  const modifiedManifestPath = join(staging, "modified-manifest.json");
  await writeDurableExclusive(modifiedManifestPath, `${JSON.stringify(ModifiedManifestSchema.parse({
    modifiedManifestVersion: 1,
    sourceRevisionId: options.sourceRevisionId,
    sourceManifestSha256: source.artifactHashes.manifest,
    manifest: modified,
  }), null, 2)}\n`);
  await syncDirectory(join(staging, "assets"));
  await syncDirectory(staging);
  await syncDirectory(slideRoot);
  await promoteExclusive(staging, revisionRoot);
  await syncDirectory(slideRoot);
  return {
    revisionId,
    revisionRoot,
    modifiedManifestPath: join(revisionRoot, "modified-manifest.json"),
    manifest: modified,
  };
}
