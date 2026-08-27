import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import sharp, { type OverlayOptions } from "sharp";

import { readRegularFileNoFollow } from "../project/safe-file.js";
import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withProjectLease } from "../project/lock.js";
import { type EditableRevisionBinding, type ProjectManifest } from "../project/schemas.js";
import { readProject, updateProject } from "../project/store.js";
import { validateModifiedRevision } from "./operations.js";
import {
  assertCompleteEditablePreview,
  EDITABLE_PREVIEW_HEIGHT,
  EDITABLE_PREVIEW_WIDTH,
} from "./preview-image.js";
import { EditableManifestSchema, type EditableManifest } from "./schemas.js";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function color(value: string): string {
  return value.startsWith("#") ? value : `#${value}`;
}

function textSvg(element: Extract<EditableManifest["elements"][number], { kind: "text" }>): Buffer {
  const anchor = element.align === "left" ? "start" : element.align === "center" ? "middle" : "end";
  const x = element.align === "left" ? 0 : element.align === "center" ? element.bbox.width / 2 : element.bbox.width;
  const lineHeight = element.fontSizePx * 1.15;
  const tspans = element.text.split("\n").map((line, index) =>
    `<tspan x="${x}" y="${element.fontSizePx + index * lineHeight}">${xml(line)}</tspan>`
  ).join("");
  const rotation = element.rotation === 0
    ? ""
    : ` transform="rotate(${element.rotation} ${element.bbox.width / 2} ${element.bbox.height / 2})"`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${element.bbox.width}" height="${element.bbox.height}">`
    + `<text x="${x}" y="${element.fontSizePx}" text-anchor="${anchor}" fill="${xml(color(element.color))}" `
    + `font-family="Microsoft YaHei,Noto Sans CJK SC,sans-serif" font-size="${element.fontSizePx}" `
    + `font-weight="${element.bold ? 700 : 400}" letter-spacing="${element.charSpacingPx ?? 0}"${rotation}>${tspans}</text></svg>`,
  );
}

async function canonicalRoot(path: string): Promise<string> {
  const lexical = resolve(path);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(lexical) !== lexical) {
    throw new Error("editable root must be a canonical regular directory");
  }
  return lexical;
}

async function ownedFile(root: string, projectPath: string): Promise<Buffer> {
  const path = resolve(root, ...projectPath.split("/"));
  const difference = relative(root, path);
  if (!difference || difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("editable artifact escaped its revision root");
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("editable artifact must be a regular file");
  const canonical = await realpath(path);
  const canonicalDifference = relative(root, canonical);
  if (canonicalDifference.startsWith("..") || isAbsolute(canonicalDifference)) {
    throw new Error("editable artifact escaped its revision root");
  }
  return readRegularFileNoFollow(path);
}

export async function renderEditablePage(options: {
  root: string;
  manifest: unknown;
  output: string;
}): Promise<void> {
  const root = await canonicalRoot(options.root);
  const manifest = EditableManifestSchema.parse(options.manifest);
  const layers: OverlayOptions[] = [];
  for (const element of [...manifest.elements].sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))) {
    if (element.kind === "asset") {
      const bytes = await ownedFile(root, element.assetPath);
      const metadata = await sharp(bytes, { failOn: "error" }).metadata();
      if (metadata.format !== "png" || !metadata.hasAlpha) {
        throw new Error(`editable asset is not a transparent PNG: ${element.id}`);
      }
      layers.push({
        input: await sharp(bytes).resize(Math.round(element.bbox.width), Math.round(element.bbox.height), { fit: "fill" }).png().toBuffer(),
        left: Math.round(element.bbox.x),
        top: Math.round(element.bbox.y),
      });
    } else {
      layers.push({ input: textSvg(element), left: Math.round(element.bbox.x), top: Math.round(element.bbox.y) });
    }
  }
  const background = await ownedFile(root, "clean-background.png");
  const composed = await sharp(background, { failOn: "error" })
    .resize(1280, 720, { fit: "fill" })
    .composite(layers)
    .png()
    .toBuffer();
  await mkdir(dirname(resolve(options.output)), { recursive: true, mode: 0o700 });
  await sharp(composed).resize(EDITABLE_PREVIEW_WIDTH, EDITABLE_PREVIEW_HEIGHT, { fit: "fill", kernel: "lanczos3" }).png().toFile(resolve(options.output));
}

function portable(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value.startsWith("..") || isAbsolute(value)) throw new Error("editable preview escaped the project root");
  return value.split(sep).join("/");
}

async function ensureOwnedDirectory(root: string, projectPath: string): Promise<string> {
  let cursor = root;
  for (const part of projectPath.split("/")) {
    cursor = join(cursor, part);
    try { await mkdir(cursor, { mode: 0o700 }); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(cursor) !== cursor) {
      throw new Error("editable preview directory is unsafe");
    }
  }
  return cursor;
}

function currentSlide(manifest: ProjectManifest, slideId: string): ProjectManifest["slides"][number] {
  const slide = manifest.slides.find((candidate) => candidate.id === slideId);
  if (!slide) throw new Error("editable preview slide ID is not in the current project");
  if ((slide.status !== "ready" && slide.status !== "editable") || !slide.finalRender) {
    throw new Error("editable preview requires a current final render");
  }
  if (slide.finalRender.revisionId !== manifest.currentRevision.id) {
    throw new Error("editable preview source final render is stale");
  }
  return slide;
}

async function authenticatedBinding(options: {
  root: string;
  manifest: ProjectManifest;
  slideId: string;
  modifiedRevisionId: string;
  expectedModifiedRevisionRecordSha256: string;
  preview: string;
}): Promise<EditableRevisionBinding> {
  const slide = currentSlide(options.manifest, options.slideId);
  const revisionRoot = join(options.root, "editable", slide.id, options.modifiedRevisionId);
  if (await realpath(revisionRoot) !== revisionRoot) throw new Error("modified revision path is not canonical");
  const validated = await validateModifiedRevision(revisionRoot, options.expectedModifiedRevisionRecordSha256);
  const record = validated.record;
  const currentEditable = slide.status === "editable" ? slide.editableRevision : null;
  if (
    record.projectId !== options.manifest.projectId
    || record.slideId !== slide.id
    || record.revisionId !== options.modifiedRevisionId
    || record.projectRevisionId !== options.manifest.currentRevision.id
    || (!currentEditable && (
      record.finalRender.path !== slide.finalRender!.path
      || record.finalRender.sha256 !== slide.finalRender!.sha256
    ))
    || (currentEditable && (
      record.parentRevisionId !== currentEditable.modifiedRevisionId
      || record.sourceRevisionId !== currentEditable.sourceRevisionId
      || record.finalRender.path !== currentEditable.conversionFinalRender.path
      || record.finalRender.sha256 !== currentEditable.conversionFinalRender.sha256
    ))
  ) throw new Error("modified revision does not bind the current project/slide/final render identity");
  const sourceFinalRender = slide.finalRender!;
  const currentRender = await readRegularFileNoFollow(join(options.root, ...sourceFinalRender.path.split("/")));
  if (sha256(currentRender) !== sourceFinalRender.sha256) throw new Error("source final render hash changed");

  const previewLexical = resolve(options.preview);
  const previewInfo = await lstat(previewLexical);
  if (previewInfo.isSymbolicLink() || !previewInfo.isFile()) throw new Error("editable preview must be a regular project-owned file");
  const previewCanonical = await realpath(previewLexical);
  const previewPath = portable(options.root, previewCanonical);
  if (previewCanonical !== previewLexical || !previewPath.startsWith(`previews/editable/${slide.id}/`)) {
    throw new Error("editable preview must use its immutable project-owned path");
  }
  const previewBytes = await readRegularFileNoFollow(previewCanonical);
  await assertCompleteEditablePreview(previewBytes);
  const modifiedManifestPath = `editable/${slide.id}/${options.modifiedRevisionId}/modified-manifest.json`;
  const modifiedManifestBytes = await readRegularFileNoFollow(join(options.root, ...modifiedManifestPath.split("/")));
  if (sha256(modifiedManifestBytes) !== record.artifacts.modifiedManifest) {
    throw new Error("modified manifest does not match the authenticated revision record");
  }
  return {
    projectId: options.manifest.projectId,
    slideId: slide.id,
    modifiedRevisionId: options.modifiedRevisionId,
    sourceRevisionId: record.sourceRevisionId,
    projectRevisionId: options.manifest.currentRevision.id,
    expectedModifiedRevisionRecordSha256: options.expectedModifiedRevisionRecordSha256,
    modifiedRevisionRecordPath: `editable/${slide.id}/${options.modifiedRevisionId}/modified-revision-record.json`,
    sourceFinalRender,
    conversionFinalRender: {
      path: record.finalRender.path,
      sha256: record.finalRender.sha256,
      revisionId: options.manifest.currentRevision.id,
    },
    preview: { path: previewPath, sha256: sha256(previewBytes), revisionId: options.manifest.currentRevision.id },
    modifiedManifest: { path: modifiedManifestPath, sha256: sha256(modifiedManifestBytes), revisionId: options.manifest.currentRevision.id },
  };
}

export async function renderProjectEditablePreview(options: {
  root: string;
  slideId: string;
  modifiedRevisionId: string;
  expectedModifiedRevisionRecordSha256: string;
}): Promise<EditableRevisionBinding> {
  const root = await realpath(options.root);
  const manifest = await readProject(root);
  const slide = currentSlide(manifest, options.slideId);
  const revisionRoot = join(root, "editable", slide.id, options.modifiedRevisionId);
  const validated = await validateModifiedRevision(revisionRoot, options.expectedModifiedRevisionRecordSha256);
  const currentEditable = slide.status === "editable" ? slide.editableRevision : null;
  if (
    validated.record.projectId !== manifest.projectId
    || validated.record.slideId !== slide.id
    || validated.record.projectRevisionId !== manifest.currentRevision.id
    || (!currentEditable && JSON.stringify(validated.record.finalRender) !== JSON.stringify({ path: slide.finalRender!.path, sha256: slide.finalRender!.sha256 }))
    || (currentEditable && (
      validated.record.parentRevisionId !== currentEditable.modifiedRevisionId
      || validated.record.sourceRevisionId !== currentEditable.sourceRevisionId
      || JSON.stringify(validated.record.finalRender) !== JSON.stringify({
        path: currentEditable.conversionFinalRender.path,
        sha256: currentEditable.conversionFinalRender.sha256,
      })
    ))
  ) throw new Error("modified revision does not bind the current project state");
  const directory = await ensureOwnedDirectory(root, `previews/editable/${slide.id}`);
  const output = join(directory, `${options.modifiedRevisionId}.png`);
  const staging = join(directory, `.${options.modifiedRevisionId}-${randomUUID()}.staging.png`);
  try {
    await renderEditablePage({ root: revisionRoot, manifest: validated.manifest, output: staging });
    const rendered = await readRegularFileNoFollow(staging);
    try {
      const existing = await lstat(output);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("editable preview destination is unsafe");
      if (!(await readRegularFileNoFollow(output)).equals(rendered)) {
        throw new Error("existing editable preview does not match the deterministic render");
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeDurableExclusive(output, rendered);
      await syncDirectory(directory);
    }
  } finally {
    await unlink(staging).catch(() => undefined);
  }
  return authenticatedBinding({ ...options, root, manifest, preview: output });
}

export async function confirmEditablePreview(options: {
  root: string;
  slideId: string;
  modifiedRevisionId: string;
  expectedModifiedRevisionRecordSha256: string;
  preview: string;
  approved?: boolean;
}): Promise<EditableRevisionBinding | null> {
  if (options.approved === false) return null;
  return withProjectLease(options.root, "slide-preview", async (root) => {
    const manifest = await readProject(root);
    const binding = await authenticatedBinding({ ...options, root, manifest });
    await updateProject(root, async (current) => {
      if (
        current.currentRevision.id !== manifest.currentRevision.id
        || JSON.stringify(currentSlide(current, options.slideId).finalRender) !== JSON.stringify(binding.sourceFinalRender)
      ) throw new Error("project or slide changed during preview confirmation");
      return {
        ...current,
        gates: [...current.gates, {
          gate: "slide-preview" as const,
          revisionId: current.currentRevision.id,
          artifactHashes: {
            [binding.modifiedRevisionRecordPath]: binding.expectedModifiedRevisionRecordSha256,
            [binding.preview.path]: binding.preview.sha256,
          },
          slidePreview: binding,
          confirmedAt: new Date().toISOString(),
        }],
      };
    });
    return binding;
  });
}

export async function validateConfirmedEditablePreview(
  root: string,
  manifest: ProjectManifest,
  slideId: string,
  modifiedRevisionId?: string,
  expectedRecordSha256?: string,
): Promise<EditableRevisionBinding> {
  const gate = [...manifest.gates].reverse().find((candidate) =>
    candidate.gate === "slide-preview"
    && candidate.slidePreview?.slideId === slideId
    && (!modifiedRevisionId || candidate.slidePreview.modifiedRevisionId === modifiedRevisionId)
  );
  if (!gate?.slidePreview) throw new Error("a current confirmed slide preview is required");
  const binding = gate.slidePreview;
  if (expectedRecordSha256 && binding.expectedModifiedRevisionRecordSha256 !== expectedRecordSha256) {
    throw new Error("confirmed preview record digest does not match the external expectation");
  }
  const current = currentSlide(manifest, slideId);
  if (
    binding.projectId !== manifest.projectId
    || binding.projectRevisionId !== manifest.currentRevision.id
    || gate.revisionId !== manifest.currentRevision.id
    || JSON.stringify(binding.sourceFinalRender) !== JSON.stringify(current.finalRender)
  ) throw new Error("confirmed slide preview is stale");
  const validated = await authenticatedBinding({
    root,
    manifest,
    slideId,
    modifiedRevisionId: binding.modifiedRevisionId,
    expectedModifiedRevisionRecordSha256: binding.expectedModifiedRevisionRecordSha256,
    preview: join(root, ...binding.preview.path.split("/")),
  });
  if (JSON.stringify(validated) !== JSON.stringify(binding)) throw new Error("confirmed slide preview artifacts changed");
  return binding;
}

export async function validateAppliedEditableBinding(
  root: string,
  manifest: ProjectManifest,
  slideId: string,
): Promise<{ binding: EditableRevisionBinding; manifest: EditableManifest; editableRoot: string }> {
  const slide = currentSlide(manifest, slideId);
  const binding = slide.editableRevision;
  if (!binding || slide.status !== "editable" || !slide.editable) {
    throw new Error("editable slide is missing its project-state revision anchor");
  }
  if (
    binding.projectId !== manifest.projectId
    || binding.slideId !== slide.id
    || binding.projectRevisionId !== manifest.currentRevision.id
    || JSON.stringify(slide.finalRender) !== JSON.stringify(binding.preview)
    || JSON.stringify(slide.editable) !== JSON.stringify(binding.modifiedManifest)
  ) throw new Error("editable slide project-state anchor is stale");
  const editableRoot = join(root, "editable", slide.id, binding.modifiedRevisionId);
  const validated = await validateModifiedRevision(editableRoot, binding.expectedModifiedRevisionRecordSha256);
  if (
    validated.record.projectId !== manifest.projectId
    || validated.record.slideId !== slide.id
    || validated.record.revisionId !== binding.modifiedRevisionId
    || validated.record.sourceRevisionId !== binding.sourceRevisionId
    || validated.record.projectRevisionId !== manifest.currentRevision.id
    || JSON.stringify(validated.record.finalRender) !== JSON.stringify({
      path: binding.conversionFinalRender.path,
      sha256: binding.conversionFinalRender.sha256,
    })
  ) throw new Error("editable slide modified revision is not bound to project state");
  const preview = await readRegularFileNoFollow(join(root, ...binding.preview.path.split("/")));
  await assertCompleteEditablePreview(preview);
  if (sha256(preview) !== binding.preview.sha256) throw new Error("editable slide preview hash changed");
  const modifiedManifest = await readRegularFileNoFollow(join(root, ...binding.modifiedManifest.path.split("/")));
  if (sha256(modifiedManifest) !== binding.modifiedManifest.sha256) throw new Error("editable slide manifest hash changed");
  return { binding, manifest: validated.manifest, editableRoot };
}
