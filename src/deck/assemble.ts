import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";

import JSZip from "jszip";
import sharp from "sharp";
import { z } from "zod";

import { buildAcceptance } from "../acceptance/build.js";
import { validateAcceptanceManifestBinding } from "../acceptance/current.js";
import {
  AcceptanceSchema,
  type Acceptance,
} from "../acceptance/schema.js";
import {
  validateRecordedClientSmokeCopy,
} from "../acceptance/smoke-copy.js";
import { AttemptLedgerSchema } from "../generation/schemas.js";
import { withGenerationLease } from "../generation/lease.js";
import { readAndReauthenticateDelegatedResult } from "../generation/delegation-result.js";
import { assertGateCurrent } from "../planning/confirm.js";
import { sha256Evidence } from "../project/evidence.js";
import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withPlanningLock, withProjectLease } from "../project/lock.js";
import { promoteExclusive } from "../project/exclusive.js";
import { readOwnedRegularFile, readRegularFileNoFollow, type SafeReadOperations } from "../project/safe-file.js";
import { ArtifactSchema, type Artifact, type ProjectManifest } from "../project/schemas.js";
import { assertProjectMutationNotFrozen, readProject, recordClientAcceptance, updateProject } from "../project/store.js";
import { prepareEditableSlide, type EditablePage } from "./editable-slide.js";
import { SOURCE_HEIGHT_PX, SOURCE_WIDTH_PX } from "./geometry.js";
import { createPresentation } from "./pptx.js";
import { publishInitialSlideIdentities } from "../deck-revisions/identity.js";
import { bootstrapInitialDeckRevision } from "../deck-revisions/store.js";

export type ImagePage = {
  id: string;
  order: number;
  mode: "image";
  render: string;
  expectedSha256?: string;
};

export type DeckPage = ImagePage | EditablePage;

export type FinalRender = DeckPage & {
  bytes: Buffer;
  sha256: string;
  contentType: "image/png" | "image/jpeg";
};

export type AssembleDeckOperations = {
  afterRenderOpened?: (path: string) => Promise<void> | void;
  trustedRoot?: string;
};

function orderPages(pages: DeckPage[]): DeckPage[] {
  if (pages.length === 0) throw new Error("deck requires at least one page");
  const orders = new Set<number>();
  const ids = new Set<string>();
  for (const page of pages) {
    if (!Number.isInteger(page.order) || page.order < 0) throw new Error("deck page order must be a non-negative integer");
    if (orders.has(page.order)) throw new Error("deck page order must be unique");
    orders.add(page.order);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(page.id) || ids.has(page.id)) {
      throw new Error("deck page id must be unique and safe");
    }
    ids.add(page.id);
  }
  const ordered = [...pages].sort((left, right) => left.order - right.order);
  if (ordered.some((page, index) => page.order !== index)) {
    throw new Error("deck page order must be contiguous from zero");
  }
  return ordered;
}

async function validateImage(
  page: DeckPage,
  operations: SafeReadOperations,
): Promise<FinalRender> {
  const bytes = await readRegularFileNoFollow(page.render, operations);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (page.expectedSha256 && page.expectedSha256 !== sha256) {
    throw new Error(`render hash does not match for page ${page.id}`);
  }
  let decodedInfo: { width: number; height: number };
  try {
    const decoded = await sharp(bytes, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    decodedInfo = decoded.info;
  } catch (error: unknown) {
    throw new Error(`render is not a complete image for page ${page.id}`, { cause: error });
  }
  if (decodedInfo.width !== SOURCE_WIDTH_PX || decodedInfo.height !== SOURCE_HEIGHT_PX) {
    throw new Error(`render must decode to 1920x1080 for page ${page.id}`);
  }
  const original = await sharp(bytes, { failOn: "error" }).metadata();
  if (original.format !== "png" && original.format !== "jpeg") {
    throw new Error(`render format must be PNG or JPEG for page ${page.id}`);
  }
  return {
    ...page,
    bytes,
    sha256,
    contentType: original.format === "png" ? "image/png" : "image/jpeg",
  };
}

export async function validateFinalRenders(
  pages: DeckPage[],
  operations: AssembleDeckOperations = {},
): Promise<FinalRender[]> {
  return Promise.all(orderPages(pages).map((page) => validateImage(page, {
    afterOpen: operations.afterRenderOpened,
  })));
}

export async function assembleDeck(
  pages: DeckPage[],
  output: string,
  operations: AssembleDeckOperations = {},
): Promise<FinalRender[]> {
  const ordered = await validateFinalRenders(pages, operations);
  await createPresentation(await Promise.all(ordered.map(async (page) => page.mode === "editable"
    ? { ...page, editable: await prepareEditableSlide(page) }
    : page)), output, operations.trustedRoot);
  return ordered;
}

const OutputMarkerSchema = z.object({
  markerVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("image-deck"),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  candidateId: z.string().uuid().optional(),
  providerId: z.string().min(1),
  projectBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
  slides: z.array(z.object({
    id: z.string().uuid(),
    order: z.number().int().nonnegative(),
    mode: z.enum(["image", "editable"]),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1),
  artifacts: z.object({
    pptx: ArtifactSchema,
    acceptance: ArtifactSchema,
  }).strict(),
}).strict();

type OutputMarker = z.infer<typeof OutputMarkerSchema>;
export type OutputArtifacts = OutputMarker["artifacts"];
const DeckCandidateMarkerSchema = z.object({
  markerVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("deck-candidate"),
  candidateId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  providerId: z.string().min(1),
  projectBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generationAuthorization: z.object({
    approvalId: z.string().uuid(),
    snapshotPath: z.string().startsWith("revisions/"),
    snapshotManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  slides: OutputMarkerSchema.shape.slides,
  artifacts: OutputMarkerSchema.shape.artifacts,
  createdAt: z.string().datetime(),
}).strict();
type DeckCandidateMarker = z.infer<typeof DeckCandidateMarkerSchema>;

export type AssembleProjectCandidateResult = {
  candidateId: string;
  destination: string;
  artifacts: OutputArtifacts;
};
export type CandidatePromotionCheckpoint = "output-promoted" | "manifest-updated";
export type CandidatePromotionOperations = {
  checkpoint?: (step: CandidatePromotionCheckpoint) => Promise<void> | void;
};
export type AssembleProjectCheckpoint = "outputs-built";
export type AssembleProjectOperations = {
  buildOutputs?: (
    renders: FinalRender[],
    paths: { pptx: string },
  ) => Promise<void>;
  checkpoint?: (step: AssembleProjectCheckpoint) => Promise<void> | void;
  beforePromote?: () => Promise<void> | void;
  afterRenderOpened?: (path: string) => Promise<void> | void;
};

export type AssembleProjectResult = {
  projectId: string;
  revisionId: string;
  revisionNumber: number;
  destination: string;
  recovered: boolean;
  artifacts: OutputArtifacts;
};

function portable(root: string, absolute: string): string {
  const value = relative(root, absolute);
  if (!value || value.startsWith("..") || isAbsolute(value)) throw new Error("deck artifact escaped the project root");
  return value.split(sep).join("/");
}

function canonicalArtifactRefs(revisionNumber: number): Record<keyof OutputArtifacts, string> {
  const base = `output/revisions/${revisionNumber}`;
  return {
    pptx: `${base}/deck.pptx`,
    acceptance: `${base}/acceptance.json`,
  };
}

async function ensureOwnedDirectory(root: string, projectPath: string): Promise<string> {
  let cursor = await realpath(root);
  for (const part of projectPath.split("/")) {
    cursor = join(cursor, part);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("deck output directory is unsafe");
  }
  return cursor;
}

async function gatesForRevision(root: string, manifest: ProjectManifest): Promise<{
  current: boolean;
  revisions: { outline: string; slideSpecs: string; styleSample: string };
}> {
  const kinds = ["outline", "slide-specs", "style-sample"] as const;
  const records = kinds.map((kind) => [...manifest.gates].reverse().find((gate) => gate.gate === kind));
  const current = records.every(Boolean)
    && (await Promise.all(kinds.map((kind) => assertGateCurrent(root, kind)))).every(Boolean);
  return {
    current,
    revisions: {
      outline: records[0]?.revisionId ?? manifest.currentRevision.id,
      slideSpecs: records[1]?.revisionId ?? manifest.currentRevision.id,
      styleSample: records[2]?.revisionId ?? manifest.currentRevision.id,
    },
  };
}

function currentSlideMode(slide: ProjectManifest["slides"][number]): "image" | "editable" {
  return slide.status === "editable" ? "editable" : "image";
}

async function projectPages(root: string, manifest: ProjectManifest): Promise<{
  pages: DeckPage[];
  records: Array<{ id: string; order: number; mode: "image" | "editable"; status: string; path: string; sha256: string }>;
  providerId: string;
}> {
  if (manifest.slides.length === 0) throw new Error("deck requires at least one page");
  const records = manifest.slides.map((slide) => {
    if (slide.status !== "ready" && slide.status !== "editable") throw new Error("all pages must be ready before assembly");
    const artifact = slide.finalRender ?? (slide.status === "ready" ? slide.image : null);
    if (!artifact || artifact.revisionId !== manifest.currentRevision.id) {
      throw new Error("all final renders must bind the current revision");
    }
    return {
      id: slide.id,
      order: slide.order,
      mode: currentSlideMode(slide),
      status: slide.status,
      path: artifact.path,
      sha256: artifact.sha256,
    };
  });
  const pages: DeckPage[] = [];
  const providers = new Set<string>();
  const delegatedResults = new Map<string, Awaited<ReturnType<typeof readAndReauthenticateDelegatedResult>>>();
  for (const record of records) {
    await readOwnedRegularFile(root, record.path);
    const absolute = await realpath(join(root, record.path.split("/").join(sep)));
    if (portable(root, absolute) !== record.path) throw new Error("final render path is not owned by the project");
    const slide = manifest.slides.find((candidate) => candidate.id === record.id)!;
    pages.push({ id: record.id, order: record.order, mode: "image", render: absolute, expectedSha256: record.sha256 });
    const imageArtifact = slide.image;
    if (!imageArtifact || imageArtifact.revisionId !== manifest.currentRevision.id) {
      throw new Error("every page must bind an accepted generation attempt");
    }
    const escapedSlideId = record.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const legacyMatch = new RegExp(`^images/${escapedSlideId}/attempt-[1-3]/slide\\.(?:png|jpg|jpeg)$`).exec(imageArtifact.path);
    if (legacyMatch) {
      const ledgerPath = posix.join(posix.dirname(imageArtifact.path), "ledger.json");
      const ledger = AttemptLedgerSchema.parse(JSON.parse((await readOwnedRegularFile(root, ledgerPath)).toString("utf8")));
      if (
        ledger.slideId !== record.id
        || ledger.revisionId !== manifest.currentRevision.id
        || ledger.outcome !== "accepted"
        || ledger.output !== imageArtifact.path
        || ledger.outputSha256 !== imageArtifact.sha256
      ) throw new Error("accepted attempt ledger does not bind the current page");
      providers.add(ledger.providerId);
      continue;
    }
    const delegatedMatch = new RegExp(`^generation/jobs/([0-9a-f-]{36})/normalized/${escapedSlideId}\\.png$`).exec(imageArtifact.path);
    if (!delegatedMatch) throw new Error("accepted generation artifact path is invalid");
    const jobId = delegatedMatch[1]!;
    const authenticated = delegatedResults.get(jobId)
      ?? await readAndReauthenticateDelegatedResult(root, jobId);
    delegatedResults.set(jobId, authenticated);
    const resultPage = authenticated.result.pages.find((page) => page.slideId === record.id);
    if (
      authenticated.job.projectRevisionId !== manifest.currentRevision.id
      || !resultPage
      || (resultPage.status !== "success" && resultPage.status !== "cached")
      || resultPage.styleConsistency !== "accepted"
      || !resultPage.artifacts
      || resultPage.artifacts.normalized.path !== imageArtifact.path
      || resultPage.artifacts.normalized.sha256 !== imageArtifact.sha256
      || resultPage.artifacts.normalized.revisionId !== manifest.currentRevision.id
      || resultPage.dependency.status !== "success"
    ) throw new Error("authenticated delegated result does not bind the current page");
    providers.add(`${resultPage.dependency.channel}-${resultPage.dependency.provider}`);
  }
  if (providers.size !== 1) throw new Error("all pages must use one accepted provider identity");
  return { pages, records, providerId: [...providers][0]! };
}

function projectBinding(manifest: ProjectManifest): string {
  return createHash("sha256").update(JSON.stringify({
    revisionId: manifest.currentRevision.id,
    revisionNumber: manifest.currentRevision.number,
    deckRevision: manifest.deckRevision ?? manifest.currentRevision.number,
    slides: [...manifest.slides].sort((left, right) => left.order - right.order).map((slide) => ({
      id: slide.id,
      order: slide.order,
      status: slide.status,
      specRevisionId: slide.specRevisionId,
      promptRevisionId: slide.promptRevisionId,
      styleRevisionId: slide.styleRevisionId,
      image: slide.image,
      editable: slide.editable,
      editableRevision: slide.editableRevision ?? null,
      chosenFinalRender: slide.finalRender ?? slide.image,
      staleReasons: slide.staleReasons,
    })),
  })).digest("hex");
}

function deckRevisionNumber(manifest: ProjectManifest): number {
  return manifest.deckRevision ?? manifest.currentRevision.number;
}

function decodeXml(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[named!.toLowerCase()]!;
  });
}

function xmlAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}=(["'])(.*?)\\1`).exec(attributes);
  return match?.[2] === undefined ? null : decodeXml(match[2]);
}

function objectName(block: string): string | null {
  const attributes = /<p:cNvPr\b([^>]*)>/.exec(block)?.[1];
  return attributes ? xmlAttribute(attributes, "name") : null;
}

function indexedObjects(xml: string, tag: "pic" | "sp"): Map<string, string> {
  const objects = new Map<string, string>();
  const pattern = new RegExp(`<p:${tag}\\b[\\s\\S]*?<\\/p:${tag}>`, "g");
  for (const match of xml.matchAll(pattern)) {
    const block = match[0];
    const name = objectName(block);
    if (!name || objects.has(name)) throw new Error("PPTX editable object names must be present and unique");
    objects.set(name, block);
  }
  return objects;
}

function relationshipTargets(xml: string, slidePath: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const attributes = match[1]!;
    const id = xmlAttribute(attributes, "Id");
    const type = xmlAttribute(attributes, "Type");
    const target = xmlAttribute(attributes, "Target");
    if (!id || !type?.endsWith("/image") || !target) continue;
    const mediaPath = target.startsWith("/")
      ? posix.normalize(target.slice(1))
      : posix.normalize(posix.join(posix.dirname(slidePath), target));
    if (!mediaPath.startsWith("ppt/media/") || targets.has(id)) {
      throw new Error("PPTX media relationship escaped the media package or is duplicated");
    }
    targets.set(id, mediaPath);
  }
  return targets;
}

function decodedText(block: string): string {
  const paragraphs = [...block.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((match) => match[1]!);
  const source = paragraphs.length > 0 ? paragraphs : [block];
  return source.map((paragraph) => {
    const parts: string[] = [];
    const pattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?\s*>/g;
    for (const match of paragraph.matchAll(pattern)) parts.push(match[1] === undefined ? "\n" : decodeXml(match[1]));
    return parts.join("");
  }).join("\n");
}

async function mediaForObject(options: {
  zip: JSZip;
  pictures: Map<string, string>;
  targets: Map<string, string>;
  objectName: string;
}): Promise<Buffer> {
  const picture = options.pictures.get(options.objectName);
  if (!picture) throw new Error(`editable PPTX object is missing: ${options.objectName}`);
  const relationshipId = /<a:blip\b[^>]*\br:embed=(["'])(.*?)\1/.exec(picture)?.[2];
  if (!relationshipId) throw new Error(`editable PPTX object has no media relationship: ${options.objectName}`);
  const target = options.targets.get(relationshipId);
  if (!target) throw new Error(`editable PPTX media relationship is missing: ${options.objectName}`);
  const media = await options.zip.file(target)?.async("nodebuffer");
  if (!media) throw new Error(`editable PPTX media target is missing: ${options.objectName}`);
  return media;
}

async function verifyOutputs(
  renders: FinalRender[],
  paths: { pptx: string },
): Promise<void> {
  const zip = await JSZip.loadAsync(await readRegularFileNoFollow(paths.pptx));
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (slides.length !== renders.length) throw new Error("PPTX slide count does not match final renders");
  for (const [index, render] of renders.entries()) {
    const slidePath = `ppt/slides/slide${index + 1}.xml`;
    const xml = await zip.file(slidePath)?.async("string");
    const expectedName = render.mode === "editable" ? `background-${render.id}` : `page-${render.id}`;
    if (!xml?.includes(`name=\"${expectedName}\"`)) throw new Error("PPTX stable page object order does not match final renders");
    if (render.mode === "image" && [...xml.matchAll(/<p:pic\b/g)].length !== 1) {
      throw new Error("image PPTX pages must contain exactly one image shape");
    }
    if (render.mode === "editable") {
      const relationships = await zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`)?.async("string");
      if (!relationships) throw new Error("editable PPTX slide media relationships are missing");
      const pictures = indexedObjects(xml, "pic");
      const shapes = indexedObjects(xml, "sp");
      const targets = relationshipTargets(relationships, slidePath);
      const prepared = await prepareEditableSlide(render);
      const expectedPictureNames = new Set([`background-${render.id}`]);
      const background = await mediaForObject({
        zip,
        pictures,
        targets,
        objectName: `background-${render.id}`,
      });
      if (createHash("sha256").update(background).digest("hex") !== createHash("sha256").update(prepared.cleanBackground).digest("hex")) {
        throw new Error("editable background media hash mismatch");
      }
      for (const element of prepared.elements) {
        const name = `${element.kind === "text" ? "text" : "asset"}-${element.id}`;
        if (element.kind === "text") {
          const shape = shapes.get(name);
          if (!shape) throw new Error(`editable PPTX object is missing: ${name}`);
          if (decodedText(shape) !== element.text) throw new Error(`editable PPTX decoded text mismatch: ${name}`);
        } else {
          expectedPictureNames.add(name);
          const media = await mediaForObject({ zip, pictures, targets, objectName: name });
          if (createHash("sha256").update(media).digest("hex") !== createHash("sha256").update(element.bytes).digest("hex")) {
            throw new Error(`editable asset media hash mismatch: ${name}`);
          }
        }
      }
      if (
        pictures.size !== expectedPictureNames.size
        || [...pictures.keys()].some((name) => !expectedPictureNames.has(name))
      ) {
        throw new Error("editable PPTX contains unexpected picture objects");
      }
      continue;
    }
    const relationships = await zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`)?.async("string");
    if (!relationships) throw new Error("PPTX slide media relationships are missing");
    const imageRelationships = [...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].flatMap((match) => {
      const attributes = match[1]!;
      const id = /\bId=(["'])(.*?)\1/.exec(attributes)?.[2];
      const type = /\bType=(["'])(.*?)\1/.exec(attributes)?.[2];
      const target = /\bTarget=(["'])(.*?)\1/.exec(attributes)?.[2];
      return id && type?.endsWith("/image") && target ? [[id, target] as const] : [];
    });
    if (imageRelationships.length !== 1) throw new Error("PPTX must bind exactly one media relationship per slide");
    const [relationshipId, target] = imageRelationships[0]!;
    if (!xml.includes(`r:embed="${relationshipId}"`)) throw new Error("PPTX slide does not bind its media relationship");
    const mediaPath = target!.startsWith("/")
      ? posix.normalize(target!.slice(1))
      : posix.normalize(posix.join(posix.dirname(slidePath), target!));
    if (!mediaPath.startsWith("ppt/media/")) throw new Error("PPTX media relationship escaped the media package");
    const media = await zip.file(mediaPath)?.async("nodebuffer");
    if (!media || createHash("sha256").update(media).digest("hex") !== render.sha256) {
      throw new Error("PPTX media bytes do not match final renders");
    }
  }
}

async function buildOutputArtifacts(
  root: string,
  marker: Omit<OutputMarker, "artifacts">,
  staging: string,
  warnings: string[],
  options: {
    refs?: Record<keyof OutputArtifacts, string>;
    candidateReview?: {
      candidateId: string;
      projectRevisionId: string;
      projectBindingSha256: string;
    };
  } = {},
): Promise<OutputMarker> {
  const refs = options.refs ?? canonicalArtifactRefs(marker.revisionNumber);
  const evidence = async (name: keyof typeof refs): Promise<Artifact> => ({
    path: refs[name],
    sha256: createHash("sha256").update(await readRegularFileNoFollow(join(staging, refs[name].split("/").at(-1)!))).digest("hex"),
    revisionId: marker.revisionId,
  });
  const manifest = await readProject(root);
  const gates = await gatesForRevision(root, manifest);
  const acceptance = await buildAcceptance({
    projectId: marker.projectId,
    revisionId: marker.revisionId,
    providerId: marker.providerId,
    gatesCurrent: gates.current,
    gateRevisionIds: gates.revisions,
    pages: marker.slides.map((slide) => ({
      id: slide.id,
      order: slide.order,
      mode: slide.mode,
      status: slide.mode === "editable" ? "editable" : "ready",
      finalRender: join(root, slide.path.split("/").join(sep)),
      finalRenderSha256: slide.sha256,
    })),
    exports: {
      pptx: join(staging, "deck.pptx"),
    },
    exportRefs: { pptx: refs.pptx },
    candidateReview: options.candidateReview,
    warnings,
  });
  await writeDurableExclusive(join(staging, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  const artifacts = {
    pptx: await evidence("pptx"),
    acceptance: await evidence("acceptance"),
  };
  return OutputMarkerSchema.parse({ ...marker, artifacts });
}

async function defaultBuildOutputs(
  renders: FinalRender[],
  paths: { pptx: string },
): Promise<void> {
  await createPresentation(await Promise.all(renders.map(async (page) => page.mode === "editable"
    ? { ...page, editable: await prepareEditableSlide(page) }
    : page)), paths.pptx, dirname(paths.pptx));
}

async function readOutputMarker(destination: string): Promise<OutputMarker> {
  const info = await lstat(destination);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("deck output destination is unsafe");
  try {
    return OutputMarkerSchema.parse(JSON.parse((await readRegularFileNoFollow(join(destination, ".superppt-output.json"))).toString("utf8")));
  } catch (error: unknown) {
    throw new Error("deck output destination is not owned by SuperPPT", { cause: error });
  }
}

async function validateOwnedOutput(
  root: string,
  destination: string,
  expected: Omit<OutputMarker, "artifacts">,
  expectedManifest?: ProjectManifest,
): Promise<OutputMarker> {
  const marker = await readOutputMarker(destination);
  if (
    marker.projectId !== expected.projectId
    || (expected.candidateId !== undefined && marker.candidateId !== expected.candidateId)
    || marker.revisionId !== expected.revisionId
    || marker.revisionNumber !== expected.revisionNumber
    || marker.providerId !== expected.providerId
    || marker.projectBindingSha256 !== expected.projectBindingSha256
    || JSON.stringify(marker.slides) !== JSON.stringify(expected.slides)
  ) throw new Error("owned output evidence is invalid for the current revision");
  const canonicalRefs = canonicalArtifactRefs(expected.revisionNumber);
  for (const kind of Object.keys(canonicalRefs) as Array<keyof OutputArtifacts>) {
    if (marker.artifacts[kind].path !== canonicalRefs[kind]) throw new Error("canonical artifact paths are required");
  }
  try {
    for (const artifact of Object.values(marker.artifacts)) {
      const bytes = await readOwnedRegularFile(root, artifact.path);
      if (artifact.revisionId !== expected.revisionId || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
        throw new Error("artifact hash mismatch");
      }
    }
    const current = expectedManifest ?? await readProject(root);
    if (projectBinding(current) !== expected.projectBindingSha256) {
      throw new Error("slide binding changed during assembly");
    }
    const prepared = await projectPages(root, current);
    if (JSON.stringify(prepared.records.map(({ id, order, mode, path, sha256 }) => ({ id, order, mode, path, sha256 }))) !== JSON.stringify(expected.slides)) {
      throw new Error("owned output slide binding does not match the current project");
    }
    const renders = await validateFinalRenders(prepared.pages);
    await verifyOutputs(renders, {
      pptx: join(root, marker.artifacts.pptx.path.split("/").join(sep)),
    });
    const acceptance = AcceptanceSchema.parse(JSON.parse((await readOwnedRegularFile(root, marker.artifacts.acceptance.path)).toString("utf8")));
    if (
      acceptance.projectId !== marker.projectId
      || acceptance.revisionId !== marker.revisionId
      || JSON.stringify(acceptance.slides) !== JSON.stringify(marker.slides.map(({ id, order, mode, sha256 }) => ({
        id,
        order,
        mode,
        finalRenderSha256: sha256,
      })))
      || JSON.stringify(acceptance.exports) !== JSON.stringify({
        pptx: { path: marker.artifacts.pptx.path, sha256: marker.artifacts.pptx.sha256 },
      })
    ) throw new Error("acceptance record does not match owned output evidence");
  } catch (error: unknown) {
    if ((error as Error).message === "slide binding changed during assembly") throw error;
    throw new Error("owned output evidence is invalid", { cause: error });
  }
  return marker;
}

async function publishOutputManifest(root: string, revisionId: string, marker: OutputMarker): Promise<void> {
  await updateProject(root, (manifest) => {
    if (manifest.currentRevision.id !== revisionId) throw new Error("project revision changed during assembly");
    if (projectBinding(manifest) !== marker.projectBindingSha256) throw new Error("slide binding changed during assembly");
    const renderById = new Map(marker.slides.map((slide) => [slide.id, slide]));
    return {
      ...manifest,
      stage: "assembling",
      slides: manifest.slides.map((slide) => {
        const render = renderById.get(slide.id);
        if (!render) throw new Error("deck output is missing a current slide");
        return {
          ...slide,
          finalRender: { path: render.path, sha256: render.sha256, revisionId },
        };
      }),
      exports: marker.artifacts,
    };
  });
}

function candidateArtifactRefs(candidateId: string): Record<keyof OutputArtifacts, string> {
  const base = `output/candidates/${candidateId}`;
  return {
    pptx: `${base}/deck.pptx`,
    acceptance: `${base}/acceptance.json`,
  };
}

function currentGenerationAuthorization(manifest: ProjectManifest): DeckCandidateMarker["generationAuthorization"] {
  const gate = [...manifest.gates].reverse().find((item) => item.gate === "generation-authorization");
  if (!gate?.approvalId || !gate.snapshotPath || !gate.snapshotManifestSha256) {
    throw new Error("current generation-authorization gate is required before candidate assembly");
  }
  return {
    approvalId: gate.approvalId,
    snapshotPath: gate.snapshotPath,
    snapshotManifestSha256: gate.snapshotManifestSha256,
  };
}

function sameGenerationAuthorization(
  left: DeckCandidateMarker["generationAuthorization"],
  right: DeckCandidateMarker["generationAuthorization"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readDeckCandidate(
  root: string,
  candidateId: string,
  manifest: ProjectManifest,
): Promise<{ marker: DeckCandidateMarker; markerBytes: Buffer; acceptance: Acceptance }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId)) {
    throw new Error("candidate identity is invalid");
  }
  const candidatePath = `output/candidates/${candidateId}`;
  const candidateRoot = join(root, ...candidatePath.split("/"));
  await requireExactRegularFiles(candidateRoot, [
    ".superppt-candidate.json",
    "acceptance.json",
    "deck.pptx",
  ], "deck candidate");
  const markerBytes = await readOwnedRegularFile(root, `${candidatePath}/.superppt-candidate.json`);
  let marker: DeckCandidateMarker;
  try {
    marker = DeckCandidateMarkerSchema.parse(JSON.parse(markerBytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("candidate marker is invalid", { cause: error });
  }
  if (
    marker.candidateId !== candidateId
    || marker.projectId !== manifest.projectId
    || marker.projectRevisionId !== manifest.currentRevision.id
    || marker.revisionNumber !== deckRevisionNumber(manifest)
    || marker.projectBindingSha256 !== projectBinding(manifest)
    || !sameGenerationAuthorization(marker.generationAuthorization, currentGenerationAuthorization(manifest))
  ) throw new Error("candidate is stale or does not match the current project revision");
  const refs = candidateArtifactRefs(candidateId);
  for (const kind of Object.keys(refs) as Array<keyof OutputArtifacts>) {
    const artifact = marker.artifacts[kind];
    if (artifact.path !== refs[kind] || artifact.revisionId !== marker.projectRevisionId) {
      throw new Error("candidate artifact identity is invalid");
    }
    const bytes = await readOwnedRegularFile(root, artifact.path);
    if (sha256Evidence(bytes) !== artifact.sha256) throw new Error("candidate artifact hash mismatch");
  }
  const prepared = await projectPages(root, manifest);
  if (
    prepared.providerId !== marker.providerId
    || JSON.stringify(prepared.records.map(({ id, order, mode, path, sha256 }) => ({ id, order, mode, path, sha256 })))
      !== JSON.stringify(marker.slides)
  ) throw new Error("candidate slide binding is invalid");
  const renders = await validateFinalRenders(prepared.pages);
  await verifyOutputs(renders, {
    pptx: join(root, ...marker.artifacts.pptx.path.split("/")),
  });
  const acceptance = AcceptanceSchema.parse(JSON.parse(
    (await readOwnedRegularFile(root, marker.artifacts.acceptance.path)).toString("utf8"),
  ));
  if (
    acceptance.projectId !== marker.projectId
    || acceptance.revisionId !== marker.projectRevisionId
    || JSON.stringify(acceptance.candidateReview) !== JSON.stringify({
      candidateId,
      projectRevisionId: marker.projectRevisionId,
      projectBindingSha256: marker.projectBindingSha256,
    })
    || JSON.stringify(acceptance.exports) !== JSON.stringify({
      pptx: { path: refs.pptx, sha256: marker.artifacts.pptx.sha256 },
    })
  ) throw new Error("candidate acceptance evidence is invalid");
  return { marker, markerBytes, acceptance };
}

/** Internal deck-domain validation/materialization support for project promotion. */
export const candidatePromotionSupport = {
  OutputMarkerSchema,
  canonicalArtifactRefs,
  ensureOwnedDirectory,
  publishOutputManifest,
  readDeckCandidate,
  sameGenerationAuthorization,
  validateOwnedOutput,
} as const;

export async function assembleProjectCandidate(
  projectRoot: string,
  operations: AssembleProjectOperations = {},
): Promise<AssembleProjectCandidateResult> {
  return withGenerationLease(projectRoot, async (generationRoot) => {
    await assertProjectMutationNotFrozen(generationRoot);
    return withProjectLease(generationRoot, "assembly", async (root) => {
    const manifest = await readProject(root);
    if (!await assertGateCurrent(root, "generation-authorization")) {
      throw new Error("current generation-authorization gate is required before candidate assembly");
    }
    const authorization = currentGenerationAuthorization(manifest);
    const gates = await gatesForRevision(root, manifest);
    if (!gates.current) throw new Error("all three planning gates must be current");
    const prepared = await projectPages(root, manifest);
    const ordered = await validateFinalRenders(prepared.pages, { afterRenderOpened: operations.afterRenderOpened });
    const candidateId = randomUUID();
    const candidatePath = `output/candidates/${candidateId}`;
    const refs = candidateArtifactRefs(candidateId);
    const candidatesRoot = await ensureOwnedDirectory(root, "output/candidates");
    const staging = join(candidatesRoot, `.${candidateId}.staging`);
    await mkdir(staging, { mode: 0o700 });
    const paths = {
      pptx: join(staging, "deck.pptx"),
    };
    await (operations.buildOutputs ?? defaultBuildOutputs)(ordered, paths);
    const initialTopology = operations.buildOutputs
      ? null
      : await publishInitialSlideIdentities(paths.pptx, ordered.map((page, position) => ({
        stableSlideId: page.id,
        position,
      })));
    await verifyOutputs(ordered, paths);
    const markerBase = {
      markerVersion: 1 as const,
      appId: "superppt" as const,
      artifactKind: "image-deck" as const,
      projectId: manifest.projectId,
      revisionId: manifest.currentRevision.id,
      revisionNumber: deckRevisionNumber(manifest),
      providerId: prepared.providerId,
      projectBindingSha256: projectBinding(manifest),
      slides: prepared.records.sort((left, right) => left.order - right.order).map(({ id, order, mode, path, sha256 }) => ({
        id, order, mode, path, sha256,
      })),
    };
    const built = await buildOutputArtifacts(root, markerBase, staging, [], {
      refs,
      candidateReview: {
        candidateId,
        projectRevisionId: manifest.currentRevision.id,
        projectBindingSha256: markerBase.projectBindingSha256,
      },
    });
    const candidateMarker = DeckCandidateMarkerSchema.parse({
      markerVersion: 1,
      appId: "superppt",
      artifactKind: "deck-candidate",
      candidateId,
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      revisionNumber: markerBase.revisionNumber,
      providerId: markerBase.providerId,
      projectBindingSha256: markerBase.projectBindingSha256,
      generationAuthorization: authorization,
      slides: markerBase.slides,
      artifacts: built.artifacts,
      createdAt: new Date().toISOString(),
    });
    await writeDurableExclusive(join(staging, ".superppt-candidate.json"), `${JSON.stringify(candidateMarker, null, 2)}\n`);
    await syncDirectory(staging);
    await syncDirectory(candidatesRoot);
    await operations.checkpoint?.("outputs-built");
    await operations.beforePromote?.();
    const current = await readProject(root);
    if (
      JSON.stringify(current) !== JSON.stringify(manifest)
      || !await assertGateCurrent(root, "generation-authorization")
    ) throw new Error("project revision or generation authorization changed during candidate assembly");
    const destination = join(root, ...candidatePath.split("/"));
    await promoteExclusive(staging, destination);
    await syncDirectory(candidatesRoot);
    if (initialTopology) {
      await bootstrapInitialDeckRevision(root, {
        revisionId: candidateId,
        projectRevisionId: manifest.currentRevision.id,
        sourceAbsolutePath: join(destination, "deck.pptx"),
        slideTopology: initialTopology,
        changedSlideIds: markerBase.slides.map((slide) => slide.id),
      });
    }
    return { candidateId, destination, artifacts: built.artifacts };
    });
  });
}

async function requireExactRegularFiles(directory: string, expected: readonly string[], label: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) throw new Error(`${label} has unexpected entries`);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (!entry.isFile() || info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${label} must contain only exact regular files`);
    }
  }
}

async function validateAcceptanceCurrent(root: string, manifest: ProjectManifest, acceptance: Acceptance): Promise<void> {
  await validateAcceptanceManifestBinding(root, manifest, acceptance);
  if (acceptance.deliveryComplete) {
    await validateRecordedClientSmokeCopy(root, manifest, acceptance.clientAcceptance);
  }
}

function acceptanceRecordPaths(root: string, revisionNumber: number): {
  directory: string;
  record: string;
  recordRef: string;
} {
  const directory = join(root, "output", "revisions", String(revisionNumber));
  return {
    directory,
    record: join(directory, "acceptance-record.json"),
    recordRef: `output/revisions/${revisionNumber}/acceptance-record.json`,
  };
}

export async function readProjectAcceptance(root: string): Promise<Acceptance> {
  const manifest = await readProject(root);
  const artifact = manifest.exports.acceptance;
  if (!artifact || artifact.revisionId !== manifest.currentRevision.id) throw new Error("acceptance evidence is not current");
  const expectedPath = manifest.stage === "delivered"
    ? acceptanceRecordPaths(root, deckRevisionNumber(manifest)).recordRef
    : canonicalArtifactRefs(deckRevisionNumber(manifest)).acceptance;
  if (artifact.path !== expectedPath) throw new Error("acceptance evidence must use the canonical artifact path");
  const bytes = await readOwnedRegularFile(root, artifact.path);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("acceptance evidence is not current");
  const acceptance = AcceptanceSchema.parse(JSON.parse(bytes.toString("utf8")));
  await validateAcceptanceCurrent(root, manifest, acceptance);
  return acceptance;
}

export { recordClientAcceptance };
