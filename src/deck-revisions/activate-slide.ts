import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import JSZip from "jszip";
import { z } from "zod";

import {
  authenticateProjectEditableConversion,
  inspectOfficialEditableDonor,
  type AuthenticatedEditableConversionResult,
} from "../editable/adapter.js";
import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withProjectLease } from "../project/lock.js";
import { readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { inspectLocalPptx, type InspectedLocalPptx } from "./inspect.js";
import { extractElementRange, scanOoxmlRanges, type OoxmlElementRange } from "./ooxml.js";
import { DeckEditSessionSchema } from "./schemas.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ActivationJournalSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  reason: z.enum(["manual-edit", "agent-edit", "slide-regeneration"]),
  changedSlideIds: z.array(z.string().uuid()),
  editableSlideIds: z.array(z.string().uuid()),
  adoption: z.unknown().nullable(),
  entries: z.array(z.object({ phase: z.string().min(1), at: z.string().datetime() }).strict()),
}).strict();

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function xmlAttribute(element: OoxmlElementRange, namespaceUri: string, localName: string): string | null {
  const matches = element.attributes.filter((attribute) =>
    attribute.namespaceUri === namespaceUri && attribute.localName === localName);
  if (matches.length > 1) throw new Error(`duplicate OOXML ${localName} attribute`);
  return matches[0]?.value ?? null;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function replaceRanges(source: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  let result = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function namespaceDeclarations(xml: string): string[] {
  const root = scanOoxmlRanges(xml).elements.find((element) => element.parentStart === null);
  if (!root) throw new Error("donor slide root is missing");
  const opening = xml.slice(root.start, root.openEnd);
  return [...opening.matchAll(/\s+xmlns(?::[A-Za-z_][\w.-]*)?\s*=\s*(?:"[^"]*"|'[^']*')/g)].map((match) => match[0]!.trim());
}

function transplantedShapeTree(
  donorXml: string,
  relationshipIds: Map<string, string>,
): string {
  const range = extractElementRange(donorXml, P, "spTree");
  const descendants = scanOoxmlRanges(donorXml).elements.filter((element) =>
    element.start >= range.start && element.end <= range.end);
  const replacements = descendants.flatMap((element) => element.attributes.flatMap((attribute) => {
    if (attribute.namespaceUri !== R || attribute.localName !== "embed") return [];
    const next = relationshipIds.get(attribute.value);
    if (!next) throw new Error(`donor shape tree has unauthenticated image relationship ${attribute.value}`);
    return [{ start: attribute.valueStart - range.start, end: attribute.valueEnd - range.start, value: next }];
  }));
  let shapeTree = replaceRanges(donorXml.slice(range.start, range.end), replacements);
  const declarations = namespaceDeclarations(donorXml).filter((declaration) => !shapeTree.slice(0, shapeTree.indexOf(">") + 1).includes(declaration));
  if (declarations.length > 0) {
    const openEnd = shapeTree.indexOf(">");
    if (openEnd < 0) throw new Error("donor shape tree opening tag is invalid");
    const insertion = shapeTree[openEnd - 1] === "/" ? openEnd - 1 : openEnd;
    shapeTree = `${shapeTree.slice(0, insertion)} ${declarations.join(" ")}${shapeTree.slice(insertion)}`;
  }
  return shapeTree;
}

export function rewriteInternalImageRelationships(
  relationshipsXml: string,
  additions: Array<{ id: string; target: string }>,
): string {
  const root = extractElementRange(relationshipsXml, REL, "Relationships");
  const children = additions.map(({ id, target }) =>
    `<Relationship xmlns="${REL}" Id="${escapeAttribute(id)}" Type="${R}/image" Target="${escapeAttribute(target)}"/>`).join("");
  if (root.selfClosing) {
    const opening = relationshipsXml.slice(root.start, root.openEnd);
    const paired = `${opening.replace(/\/\s*>$/, ">")}${children}</${root.qualifiedName}>`;
    return `${relationshipsXml.slice(0, root.start)}${paired}${relationshipsXml.slice(root.end)}`;
  }
  return `${relationshipsXml.slice(0, root.closeStart)}${children}${relationshipsXml.slice(root.closeStart)}`;
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const staging = join(dirname(path), `.${randomUUID()}.staging.json`);
  await writeDurableExclusive(staging, `${JSON.stringify(value, null, 2)}\n`);
  await rename(staging, path);
  await syncDirectory(dirname(path));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse((await readRegularFileNoFollow(path)).toString("utf8"));
}

function candidateRevisionId(projectRoot: string, candidatePath: string): string {
  const local = relative(projectRoot, candidatePath).split(sep).join("/");
  const match = /^output\/deck-revisions\/([0-9a-f-]{36})\/deck\.pptx$/.exec(local);
  if (!match) throw new Error("candidate path must be an owned output/deck-revisions/<revisionId>/deck.pptx");
  return z.string().uuid().parse(match[1]);
}

async function readCandidateMetadata(root: string, candidatePath: string, slideId: string) {
  const project = await readProject(root);
  if (!project.activeDeckEditSessionId) throw new Error("editable activation requires an active deck edit session");
  const sessionRoot = join(root, "output", "deck-edit-sessions", project.activeDeckEditSessionId);
  const session = DeckEditSessionSchema.parse(await readJson(join(sessionRoot, "session.json")));
  const journal = ActivationJournalSchema.parse(await readJson(join(sessionRoot, "journal.json")));
  const revisionId = candidateRevisionId(root, candidatePath);
  if (
    session.sessionId !== project.activeDeckEditSessionId
    || journal.sessionId !== session.sessionId
    || session.candidateRevisionId !== revisionId
    || session.candidateRelativePath !== `output/deck-revisions/${revisionId}/deck.pptx`
  ) throw new Error("candidate metadata does not bind the owned complete deck path");
  if (session.targetSlideId !== slideId) throw new Error("requested slide identity does not match the active candidate target");
  if (session.state !== "prepared") throw new Error("editable activation requires a prepared candidate");
  return { sessionRoot, session, journal };
}

function assertStableTopology(before: InspectedLocalPptx, after: InspectedLocalPptx): void {
  if (after.slideCount !== before.slideCount) throw new Error("candidate slide count changed during editable activation");
  for (const [index, previous] of before.slides.entries()) {
    const current = after.slides[index];
    if (
      !current
      || current.slidePart !== previous.slidePart
      || current.presentationSlideId !== previous.presentationSlideId
      || current.creationId !== previous.creationId
      || current.relationshipId !== previous.relationshipId
    ) throw new Error("candidate stable slide topology changed during editable activation");
  }
}

function targetObjectInspection(xml: string, authenticated: AuthenticatedEditableConversionResult) {
  const names = scanOoxmlRanges(xml).elements
    .filter((element) => element.namespaceUri === P && element.localName === "cNvPr")
    .map((element) => xmlAttribute(element, "", "name"))
    .filter((name): name is string => Boolean(name));
  const expected = ["asset-background", ...authenticated.manifest.elements.map((element) => {
    if (element.kind === "text") return `text-${element.id}`;
    if (element.kind === "shape") return `shape-${element.id}-${element.label}`;
    return `asset-${element.id}`;
  })];
  for (const name of expected) {
    if (names.filter((candidate) => candidate === name).length !== 1) {
      throw new Error(`staged target slide is missing official object name ${name}`);
    }
  }
  return {
    editableTextCount: authenticated.manifest.elements.filter((element) => element.kind === "text").length,
    editableShapeCount: authenticated.manifest.elements.filter((element) => element.kind === "shape").length,
    editableAssetCount: authenticated.manifest.elements.filter((element) => element.kind === "asset").length,
    objectNames: expected,
  };
}

async function memberHashes(zip: JSZip, pattern: RegExp): Promise<Map<string, string>> {
  const names = Object.keys(zip.files).filter((name) => pattern.test(name) && !zip.files[name]!.dir);
  return new Map(await Promise.all(names.map(async (name) => [name, digest(await zip.file(name)!.async("nodebuffer"))] as const)));
}

export type ActivatedDeckResult = {
  absolutePath: string;
  editableSlideIds: string[];
  targetInspection: {
    editableTextCount: number;
    editableShapeCount: number;
    editableAssetCount: number;
    objectNames: string[];
  };
  reviewRequiredObjects: AuthenticatedEditableConversionResult["reviewRequiredObjects"];
  authenticatedConversion: AuthenticatedEditableConversionResult;
};

export async function activateEditableSlideInDeck(options: {
  projectRoot: string;
  candidatePath: string;
  slideIndex: number;
  slideId: string;
  conversionRoot: string;
  operations?: { beforeAtomicReplace?: (stagedPath: string) => Promise<void> | void };
}): Promise<ActivatedDeckResult> {
  if (!Number.isInteger(options.slideIndex) || options.slideIndex < 0) throw new Error("slide index is outside the candidate range");
  z.string().uuid().parse(options.slideId);
  return withProjectLease(options.projectRoot, "deck-revisions", async (root) => {
    const candidatePath = resolve(options.candidatePath);
    if (await realpath(candidatePath) !== candidatePath) throw new Error("candidate path must be canonical and non-symlinked");
    const metadata = await readCandidateMetadata(root, candidatePath, options.slideId);
    const before = await inspectLocalPptx(candidatePath);
    if (options.slideIndex >= before.slideCount) throw new Error("slide index is outside the candidate range");
    if (metadata.session.preparedSha256 !== before.sha256) throw new Error("candidate prepared hash does not match current complete deck bytes");
    const authenticated = await authenticateProjectEditableConversion({
      projectRoot: root,
      conversionRoot: options.conversionRoot,
      slideId: options.slideId,
    });
    const donorBytes = await readRegularFileNoFollow(join(root, ...authenticated.donorPptxPath.split("/")));
    if (digest(donorBytes) !== authenticated.donorPptxSha256) throw new Error("official donor hash changed after authentication");
    const donor = await inspectOfficialEditableDonor(donorBytes, authenticated.manifest);
    const candidateBytes = await readRegularFileNoFollow(candidatePath);
    if (digest(candidateBytes) !== before.sha256) throw new Error("candidate changed before editable staging");
    const candidateZip = await JSZip.loadAsync(candidateBytes);
    const target = before.slides[options.slideIndex]!;
    const targetSlide = candidateZip.file(target.slidePart);
    if (!targetSlide) throw new Error("candidate target slide part is missing");
    const targetXml = await targetSlide.async("string");
    const targetShapeTree = extractElementRange(targetXml, P, "spTree");
    const targetRelationshipsPart = `ppt/slides/_rels/${basename(target.slidePart)}.rels`;
    const targetRelationshipsFile = candidateZip.file(targetRelationshipsPart);
    const targetRelationshipsXml = targetRelationshipsFile
      ? await targetRelationshipsFile.async("string")
      : `<Relationships xmlns="${REL}"/>`;
    const targetRelationshipElements = scanOoxmlRanges(targetRelationshipsXml).elements.filter((element) =>
      element.namespaceUri === REL && element.localName === "Relationship");
    const usedRelationshipIds = new Set(targetRelationshipElements.map((element) => xmlAttribute(element, "", "Id")).filter((id): id is string => Boolean(id)));
    const rewrittenIds = new Map<string, string>();
    const relationshipAdditions: Array<{ id: string; target: string }> = [];
    for (const image of donor.imageRelationships) {
      let idNumber = 1;
      while (usedRelationshipIds.has(`rId${idNumber}`)) idNumber += 1;
      const id = `rId${idNumber}`;
      usedRelationshipIds.add(id);
      rewrittenIds.set(image.id, id);
      const mediaName = `superppt-${randomUUID()}.png`;
      const mediaPart = `ppt/media/${mediaName}`;
      const mediaBytes = await donor.zip.file(image.targetPart)!.async("nodebuffer");
      candidateZip.file(mediaPart, mediaBytes);
      relationshipAdditions.push({ id, target: `../media/${mediaName}` });
    }
    const shapeTree = transplantedShapeTree(donor.slideXml, rewrittenIds);
    const rewrittenSlide = `${targetXml.slice(0, targetShapeTree.start)}${shapeTree}${targetXml.slice(targetShapeTree.end)}`;
    candidateZip.file(target.slidePart, rewrittenSlide);
    candidateZip.file(targetRelationshipsPart, rewriteInternalImageRelationships(targetRelationshipsXml, relationshipAdditions));
    const beforeProtected = await memberHashes(candidateZip, /^ppt\/(?:notesSlides|comments)\//);
    const stagedPath = join(dirname(candidatePath), `.deck-identity-${randomUUID()}.staging.pptx`);
    try {
      await writeDurableExclusive(stagedPath, await candidateZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
      await syncDirectory(dirname(candidatePath));
      const staged = await inspectLocalPptx(stagedPath);
      assertStableTopology(before, staged);
      for (const [index, previous] of before.slides.entries()) {
        if (index === options.slideIndex) continue;
        const current = staged.slides[index]!;
        if (current.xmlSha256 !== previous.xmlSha256 || current.relationshipsSha256 !== previous.relationshipsSha256) {
          throw new Error("editable activation changed an untouched slide part");
        }
      }
      const stagedZip = await JSZip.loadAsync(await readRegularFileNoFollow(stagedPath));
      const afterProtected = await memberHashes(stagedZip, /^ppt\/(?:notesSlides|comments)\//);
      if (JSON.stringify([...afterProtected]) !== JSON.stringify([...beforeProtected])) {
        throw new Error("editable activation changed notes or comments bytes");
      }
      const stagedTargetXml = await stagedZip.file(target.slidePart)!.async("string");
      const targetInspection = targetObjectInspection(stagedTargetXml, authenticated);
      await options.operations?.beforeAtomicReplace?.(stagedPath);
      const candidateInfo = await lstat(candidatePath);
      if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile() || digest(await readRegularFileNoFollow(candidatePath)) !== before.sha256) {
        throw new Error("candidate changed during staging race check");
      }
      await rename(stagedPath, candidatePath);
      await syncDirectory(dirname(candidatePath));
      const committed = await inspectLocalPptx(candidatePath);
      if (committed.sha256 !== staged.sha256) throw new Error("atomic candidate replacement did not publish staged bytes");
      const session = DeckEditSessionSchema.parse({ ...metadata.session, preparedSha256: committed.sha256 });
      const editableSlideIds = [...new Set([...metadata.journal.editableSlideIds, options.slideId])];
      const journal = ActivationJournalSchema.parse({
        ...metadata.journal,
        editableSlideIds,
        entries: [...metadata.journal.entries, { phase: "editable-slide-activated", at: new Date().toISOString() }],
      });
      await replaceJson(join(metadata.sessionRoot, "session.json"), session);
      await replaceJson(join(metadata.sessionRoot, "journal.json"), journal);
      return {
        absolutePath: candidatePath,
        editableSlideIds,
        targetInspection,
        reviewRequiredObjects: authenticated.reviewRequiredObjects,
        authenticatedConversion: authenticated,
      };
    } catch (error: unknown) {
      await unlink(stagedPath).catch((cleanupError: unknown) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      });
      throw error;
    }
  });
}
