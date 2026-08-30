import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, rename } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import JSZip from "jszip";
import sharp from "sharp";
import { z } from "zod";

import {
  authenticateProjectEditableConversion,
  inspectOfficialEditableDonor,
  type AuthenticatedEditableConversionResult,
} from "../editable/adapter.js";
import { withGenerationLease } from "../generation/lease.js";
import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withProjectLease } from "../project/lock.js";
import { readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { inspectLocalPptx, type InspectedLocalPptx } from "./inspect.js";
import { extractElementRange, scanOoxmlRanges, type OoxmlElementRange } from "./ooxml.js";
import { DeckEditSessionSchema } from "./schemas.js";
import { readLocalDeckRevision } from "./store.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
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
const ActivationIntentSchema = z.object({
  schemaVersion: z.literal(1),
  activationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  candidateRevisionId: z.string().uuid(),
  parentRevisionId: z.string().uuid(),
  slideId: z.string().uuid(),
  slideIndex: z.number().int().nonnegative(),
  targetSlidePart: z.string().regex(/^ppt\/slides\/slide[0-9]+\.xml$/),
  conversionRevisionId: z.string().uuid(),
  conversionDonorSha256: Sha256Schema,
  oldCandidateSha256: Sha256Schema,
  newCandidateSha256: Sha256Schema,
  stagedRelativePath: z.string().regex(/^output\/deck-revisions\/[0-9a-f-]{36}\/\.deck-identity-[0-9a-f-]{36}\.staging\.pptx$/),
  editableSlideIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
  phases: z.array(z.enum(["intent-written", "candidate-replaced", "session-updated", "journal-updated", "complete"])),
}).strict();
type ActivationIntent = z.infer<typeof ActivationIntentSchema>;
export type EditableActivationCheckpoint = "candidate-replaced" | "session-updated" | "journal-updated";

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

type NamespaceDeclaration = { raw: string; uri: string };

function namespaceDeclarations(opening: string): Map<string, NamespaceDeclaration> {
  const declarations = new Map<string, NamespaceDeclaration>();
  for (const match of opening.matchAll(/\s+xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const prefix = match[1] ?? "";
    if (declarations.has(prefix)) throw new Error(`duplicate namespace declaration for prefix ${prefix || "<default>"}`);
    declarations.set(prefix, { raw: match[0]!.trim(), uri: match[2] ?? match[3] ?? "" });
  }
  return declarations;
}

function transplantedShapeTree(
  donorXml: string,
  relationshipIds: Map<string, string>,
): string {
  const range = extractElementRange(donorXml, P, "spTree");
  const donorElements = scanOoxmlRanges(donorXml).elements;
  const descendants = donorElements.filter((element) =>
    element.start >= range.start && element.end <= range.end);
  const replacements = descendants.flatMap((element) => element.attributes.flatMap((attribute) => {
    if (attribute.namespaceUri !== R || attribute.localName !== "embed") return [];
    const next = relationshipIds.get(attribute.value);
    if (!next) throw new Error(`donor shape tree has unauthenticated image relationship ${attribute.value}`);
    return [{ start: attribute.valueStart - range.start, end: attribute.valueEnd - range.start, value: next }];
  }));
  let shapeTree = replaceRanges(donorXml.slice(range.start, range.end), replacements);
  const byStart = new Map(donorElements.map((element) => [element.start, element] as const));
  const declarationAt = (element: OoxmlElementRange, prefix: string) =>
    namespaceDeclarations(donorXml.slice(element.start, element.openEnd)).get(prefix);
  const localDeclaration = (element: OoxmlElementRange, prefix: string): NamespaceDeclaration | undefined => {
    let current: OoxmlElementRange | undefined = element;
    while (current && current.start >= range.start) {
      const declaration = declarationAt(current, prefix);
      if (declaration) return declaration;
      current = current.parentStart === null ? undefined : byStart.get(current.parentStart);
    }
    return undefined;
  };
  const inheritedDeclaration = (prefix: string): NamespaceDeclaration | undefined => {
    let current = range.parentStart === null ? undefined : byStart.get(range.parentStart);
    while (current) {
      const declaration = declarationAt(current, prefix);
      if (declaration) return declaration;
      current = current.parentStart === null ? undefined : byStart.get(current.parentStart);
    }
    return undefined;
  };
  const requiredDeclarations = new Map<string, NamespaceDeclaration>();
  const requireNamespace = (element: OoxmlElementRange, prefix: string, uri: string): void => {
    if (prefix === "xml" && uri === XML_NAMESPACE) return;
    const local = localDeclaration(element, prefix);
    if (local) {
      if (local.uri !== uri) throw new Error(`donor shape tree namespace binding disagrees for prefix ${prefix || "<default>"}`);
      return;
    }
    const inherited = inheritedDeclaration(prefix);
    if (!inherited || inherited.uri !== uri) throw new Error(`donor shape tree uses undeclared namespace prefix ${prefix}`);
    const previous = requiredDeclarations.get(prefix);
    if (previous && previous.uri !== inherited.uri) throw new Error(`donor shape tree has ambiguous namespace prefix ${prefix || "<default>"}`);
    requiredDeclarations.set(prefix, inherited);
  };
  for (const element of descendants) {
    if (element.namespaceUri) {
      const separator = element.qualifiedName.indexOf(":");
      requireNamespace(element, separator < 0 ? "" : element.qualifiedName.slice(0, separator), element.namespaceUri);
    }
    for (const attribute of element.attributes) {
      const separator = attribute.qualifiedName.indexOf(":");
      if (separator > 0 && attribute.qualifiedName.slice(0, separator) !== "xmlns" && attribute.namespaceUri) {
        requireNamespace(element, attribute.qualifiedName.slice(0, separator), attribute.namespaceUri);
      }
    }
  }
  const declarations = [...requiredDeclarations.values()].map((declaration) => declaration.raw);
  if (declarations.length > 0) {
    const openEnd = shapeTree.indexOf(">");
    if (openEnd < 0) throw new Error("donor shape tree opening tag is invalid");
    const insertion = shapeTree[openEnd - 1] === "/" ? openEnd - 1 : openEnd;
    shapeTree = `${shapeTree.slice(0, insertion)} ${declarations.join(" ")}${shapeTree.slice(insertion)}`;
  }
  return shapeTree;
}

function stagedRelationshipElements(xml: string): OoxmlElementRange[] {
  const elements = scanOoxmlRanges(xml).elements;
  const documentRoots = elements.filter((element) => element.parentStart === null);
  const root = documentRoots[0];
  if (documentRoots.length !== 1 || !root || root.namespaceUri !== REL || root.localName !== "Relationships") {
    throw new Error("staged relationship document must have one strict package Relationships root");
  }
  const relationships = elements.filter((element) => element.parentStart === root.start);
  if (
    relationships.some((element) => element.namespaceUri !== REL || element.localName !== "Relationship")
    || elements.length !== relationships.length + 1
  ) throw new Error("staged relationship document contains a foreign or nested child");
  const prefix = xml.slice(0, root.start).replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>/, "");
  if (prefix.trim() || xml.slice(root.end).trim()) throw new Error("staged relationship document has ambiguous text outside its root");
  let cursor = root.openEnd;
  for (const relationship of [...relationships].sort((left, right) => left.start - right.start)) {
    if (xml.slice(cursor, relationship.start).trim()) throw new Error("staged relationship document has ambiguous root content");
    if (!relationship.selfClosing && xml.slice(relationship.openEnd, relationship.closeStart).trim()) {
      throw new Error("staged relationship document has ambiguous relationship content");
    }
    cursor = relationship.end;
  }
  if (!root.selfClosing && xml.slice(cursor, root.closeStart).trim()) throw new Error("staged relationship document has ambiguous root content");
  return relationships;
}

export function rewriteInternalImageRelationships(
  relationshipsXml: string,
  additions: Array<{ id: string; target: string }>,
): string {
  stagedRelationshipElements(relationshipsXml);
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

async function optionalIntent(path: string): Promise<ActivationIntent | null> {
  try {
    return ActivationIntentSchema.parse(await readJson(path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).cause && ((error as Error).cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function appendIntentPhase(path: string, intent: ActivationIntent, phase: ActivationIntent["phases"][number]): Promise<ActivationIntent> {
  if (intent.phases.includes(phase)) return intent;
  const next = ActivationIntentSchema.parse({ ...intent, phases: [...intent.phases, phase] });
  await replaceJson(path, next);
  return next;
}

function candidateRevisionId(projectRoot: string, candidatePath: string): string {
  const local = relative(projectRoot, candidatePath).split(sep).join("/");
  const match = /^output\/deck-revisions\/([0-9a-f-]{36})\/deck\.pptx$/.exec(local);
  if (!match) throw new Error("candidate path must be an owned output/deck-revisions/<revisionId>/deck.pptx");
  return z.string().uuid().parse(match[1]);
}

async function readCandidateMetadata(root: string, candidatePath: string, slideId: string, slideIndex: number, inspected: InspectedLocalPptx) {
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
  const parent = await readLocalDeckRevision(root, session.parentRevisionId);
  if (project.currentDeck?.revisionId !== parent.revisionId) throw new Error("active candidate parent is not the authoritative current deck revision");
  const topology = parent.slideTopology.entries.find((entry) => entry.stableSlideId === slideId);
  const actual = inspected.slides[slideIndex];
  if (
    !topology
    || topology.position !== slideIndex
    || !actual
    || topology.slidePart !== actual.slidePart
    || topology.presentationSlideId !== actual.presentationSlideId
    || topology.creationId !== actual.creationId
  ) throw new Error("slide identity and supplied index do not match authoritative deck topology");
  return { sessionRoot, session, journal, parent, targetTopology: topology };
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

function resolveRelationshipPart(sourcePart: string, target: string): string {
  if (!target || target.includes("\\") || target.includes("\0") || target.includes("?") || target.includes("#")) {
    throw new Error("candidate target relationship has an unsafe target");
  }
  const source = sourcePart.startsWith("/") ? sourcePart.slice(1) : sourcePart;
  const segments = target.startsWith("/") ? [] : dirname(source).split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (!segment) continue;
    if (segment === ".") throw new Error("candidate target relationship has an unsafe target");
    if (segment === "..") {
      if (segments.length === 0) throw new Error("candidate target relationship escapes the package through above-root traversal");
      segments.pop();
      continue;
    }
    if (segment.includes(":")) throw new Error("candidate target relationship has an unsafe target");
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error("candidate target relationship escapes the package");
  return segments.join("/");
}

async function validateStagedTargetPackage(
  zip: JSZip,
  targetSlidePart: string,
  relationshipsPart: string,
  additions: Array<{ id: string; target: string; mediaPart: string; sha256: string }>,
): Promise<void> {
  const relationshipsFile = zip.file(relationshipsPart);
  if (!relationshipsFile) throw new Error("staged target slide relationships are missing");
  const xml = await relationshipsFile.async("string");
  const relationships = stagedRelationshipElements(xml);
  const ids = new Set<string>();
  for (const relationship of relationships) {
    const id = xmlAttribute(relationship, "", "Id");
    const type = xmlAttribute(relationship, "", "Type");
    const target = xmlAttribute(relationship, "", "Target");
    if (!id || !target || ids.has(id)) throw new Error("staged target relationships contain duplicate or missing IDs");
    if (!type?.trim()) throw new Error("staged target relationship is missing required Type");
    if (xmlAttribute(relationship, "", "TargetMode") === "External") throw new Error("staged target relationships contain an external target");
    ids.add(id);
    const resolved = resolveRelationshipPart(targetSlidePart, target);
    if (!zip.file(resolved)) throw new Error(`staged relationship target is missing: ${resolved}`);
  }
  for (const addition of additions) {
    const matches = relationships.filter((relationship) => xmlAttribute(relationship, "", "Id") === addition.id && xmlAttribute(relationship, "", "Target") === addition.target);
    if (matches.length !== 1 || resolveRelationshipPart(targetSlidePart, addition.target) !== addition.mediaPart) {
      throw new Error("staged image relationship does not resolve to its authenticated media");
    }
    const bytes = await zip.file(addition.mediaPart)?.async("nodebuffer");
    if (!bytes || digest(bytes) !== addition.sha256) throw new Error("staged image media hash mismatch");
    try { const metadata = await sharp(bytes).metadata(); await sharp(bytes).raw().toBuffer(); if (metadata.format !== "png") throw new Error("not PNG"); }
    catch (error: unknown) { throw new Error("staged image media is not a decodable PNG", { cause: error }); }
  }
  const typesXml = await zip.file("[Content_Types].xml")?.async("string");
  if (!typesXml) throw new Error("staged package content types are missing");
  const typeElements = scanOoxmlRanges(typesXml).elements;
  const pngDefault = typeElements.some((element) => element.namespaceUri === CONTENT_TYPES && element.localName === "Default"
    && xmlAttribute(element, "", "Extension")?.toLowerCase() === "png" && xmlAttribute(element, "", "ContentType") === "image/png");
  const overrides = new Set(typeElements.filter((element) => element.namespaceUri === CONTENT_TYPES && element.localName === "Override"
    && xmlAttribute(element, "", "ContentType") === "image/png").map((element) => xmlAttribute(element, "", "PartName")));
  if (!pngDefault && additions.some((addition) => !overrides.has(`/${addition.mediaPart}`))) {
    throw new Error("staged package does not declare PNG media content types");
  }
  const slideXml = await zip.file(targetSlidePart)!.async("string");
  const objectIds = scanOoxmlRanges(slideXml).elements.filter((element) => element.namespaceUri === P && element.localName === "cNvPr")
    .map((element) => xmlAttribute(element, "", "id"));
  if (objectIds.some((id) => !id || !/^[1-9][0-9]*$/.test(id)) || new Set(objectIds).size !== objectIds.length) {
    throw new Error("staged slide has duplicate or invalid numeric object IDs");
  }
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
  operations?: {
    beforeAtomicReplace?: (stagedPath: string) => Promise<void> | void;
    checkpoint?: (phase: EditableActivationCheckpoint) => Promise<void> | void;
    mediaNameFactory?: () => string;
  };
}): Promise<ActivatedDeckResult> {
  if (!Number.isInteger(options.slideIndex) || options.slideIndex < 0) throw new Error("slide index is outside the candidate range");
  z.string().uuid().parse(options.slideId);
  return withGenerationLease(options.projectRoot, (generationRoot) => withProjectLease(generationRoot, "deck-revisions", async (root) => {
    const candidatePath = resolve(options.candidatePath);
    if (await realpath(candidatePath) !== candidatePath) throw new Error("candidate path must be canonical and non-symlinked");
    const before = await inspectLocalPptx(candidatePath);
    if (options.slideIndex >= before.slideCount) throw new Error("slide index is outside the candidate range");
    const metadata = await readCandidateMetadata(root, candidatePath, options.slideId, options.slideIndex, before);
    const authenticated = await authenticateProjectEditableConversion({
      projectRoot: root,
      conversionRoot: options.conversionRoot,
      slideId: options.slideId,
    });
    const donorBytes = await readRegularFileNoFollow(join(root, ...authenticated.donorPptxPath.split("/")));
    if (digest(donorBytes) !== authenticated.donorPptxSha256) throw new Error("official donor hash changed after authentication");
    const target = before.slides[options.slideIndex]!;
    const donor = await inspectOfficialEditableDonor(donorBytes, authenticated.manifest, {
      cleanBackgroundSha256: authenticated.cleanBackgroundSha256,
      assets: Object.fromEntries(authenticated.manifest.elements.flatMap((element) => element.kind === "asset"
        ? [[element.assetPath, authenticated.assets[Object.keys(authenticated.assets).find((path) => path.endsWith(`/converter-output/${element.assetPath}`)) ?? ""]!]]
        : [])),
    });
    const intentPath = join(metadata.sessionRoot, "activation.json");
    let intent = await optionalIntent(intentPath);
    let stagedPath: string;
    let staged: InspectedLocalPptx;
    let targetInspection: ActivatedDeckResult["targetInspection"];
    const editableSlideIds = [...new Set([...metadata.journal.editableSlideIds, options.slideId])];
    if (intent) {
      const expectedStaged = join(root, ...intent.stagedRelativePath.split("/"));
      if (
        intent.sessionId !== metadata.session.sessionId
        || intent.candidateRevisionId !== metadata.session.candidateRevisionId
        || intent.parentRevisionId !== metadata.session.parentRevisionId
        || intent.slideId !== options.slideId
        || intent.slideIndex !== options.slideIndex
        || intent.targetSlidePart !== metadata.targetTopology.slidePart
        || intent.conversionRevisionId !== basename(resolve(options.conversionRoot))
        || intent.conversionDonorSha256 !== authenticated.donorPptxSha256
        || JSON.stringify(intent.editableSlideIds) !== JSON.stringify(editableSlideIds)
      ) throw new Error("activation retry does not match durable activation intent");
      stagedPath = expectedStaged;
      if (![intent.oldCandidateSha256, intent.newCandidateSha256].includes(before.sha256)
        || ![intent.oldCandidateSha256, intent.newCandidateSha256].includes(metadata.session.preparedSha256)) {
        throw new Error("activation residue does not match durable candidate hashes");
      }
      const journalApplied = JSON.stringify(metadata.journal.editableSlideIds) === JSON.stringify(intent.editableSlideIds);
      const journalOld = JSON.stringify(metadata.journal.editableSlideIds) === JSON.stringify(intent.editableSlideIds.filter((id) => id !== options.slideId));
      if (!journalApplied && !journalOld) throw new Error("activation journal residue does not match durable intent");
      if (before.sha256 === intent.oldCandidateSha256 && (metadata.session.preparedSha256 !== intent.oldCandidateSha256 || journalApplied)) {
        throw new Error("activation metadata advanced ahead of candidate replacement");
      }
      if (metadata.session.preparedSha256 === intent.oldCandidateSha256 && journalApplied) {
        throw new Error("activation journal advanced ahead of session metadata");
      }
      staged = before.sha256 === intent.newCandidateSha256 ? before : await inspectLocalPptx(stagedPath);
      if (staged.sha256 !== intent.newCandidateSha256) throw new Error("activation staged residue hash does not match durable intent");
      const recoveryZip = await JSZip.loadAsync(await readRegularFileNoFollow(before.sha256 === intent.newCandidateSha256 ? candidatePath : stagedPath));
      targetInspection = targetObjectInspection(await recoveryZip.file(intent.targetSlidePart)!.async("string"), authenticated);
    } else {
      if (metadata.session.preparedSha256 !== before.sha256) throw new Error("candidate prepared hash does not match current complete deck bytes");
      const candidateBytes = await readRegularFileNoFollow(candidatePath);
      if (digest(candidateBytes) !== before.sha256) throw new Error("candidate changed before editable staging");
      const candidateZip = await JSZip.loadAsync(candidateBytes);
      const targetSlide = candidateZip.file(target.slidePart);
      if (!targetSlide) throw new Error("candidate target slide part is missing");
      const targetXml = await targetSlide.async("string");
      const targetShapeTree = extractElementRange(targetXml, P, "spTree");
      const targetRelationshipsPart = `ppt/slides/_rels/${basename(target.slidePart)}.rels`;
      const targetRelationshipsFile = candidateZip.file(targetRelationshipsPart);
      const targetRelationshipsXml = targetRelationshipsFile ? await targetRelationshipsFile.async("string") : `<Relationships xmlns="${REL}"/>`;
      const targetRelationshipElements = scanOoxmlRanges(targetRelationshipsXml).elements.filter((element) => element.namespaceUri === REL && element.localName === "Relationship");
      const usedRelationshipIds = new Set(targetRelationshipElements.map((element) => xmlAttribute(element, "", "Id")).filter((id): id is string => Boolean(id)));
      if (usedRelationshipIds.size !== targetRelationshipElements.length) throw new Error("candidate target relationships contain duplicate or missing IDs");
      const rewrittenIds = new Map<string, string>();
      const relationshipAdditions: Array<{ id: string; target: string; mediaPart: string; sha256: string }> = [];
      for (const image of donor.imageRelationships) {
        let idNumber = 1;
        while (usedRelationshipIds.has(`rId${idNumber}`)) idNumber += 1;
        const id = `rId${idNumber}`;
        usedRelationshipIds.add(id);
        rewrittenIds.set(image.id, id);
        const mediaName = options.operations?.mediaNameFactory?.() ?? `superppt-${randomUUID()}.png`;
        if (!/^superppt-[A-Za-z0-9._-]+\.png$/.test(mediaName)) throw new Error("generated media name is invalid");
        const mediaPart = `ppt/media/${mediaName}`;
        if (candidateZip.file(mediaPart)) throw new Error("generated media path collides with existing package media");
        const mediaBytes = await donor.zip.file(image.targetPart)!.async("nodebuffer");
        candidateZip.file(mediaPart, mediaBytes);
        relationshipAdditions.push({ id, target: `../media/${mediaName}`, mediaPart, sha256: image.sha256 });
      }
      const shapeTree = transplantedShapeTree(donor.slideXml, rewrittenIds);
      candidateZip.file(target.slidePart, `${targetXml.slice(0, targetShapeTree.start)}${shapeTree}${targetXml.slice(targetShapeTree.end)}`);
      candidateZip.file(targetRelationshipsPart, rewriteInternalImageRelationships(targetRelationshipsXml, relationshipAdditions));
      const beforeProtected = await memberHashes(candidateZip, /^ppt\/(?:notesSlides|comments)\//);
      const activationId = randomUUID();
      stagedPath = join(dirname(candidatePath), `.deck-identity-${activationId}.staging.pptx`);
      await writeDurableExclusive(stagedPath, await candidateZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
      await syncDirectory(dirname(candidatePath));
      staged = await inspectLocalPptx(stagedPath);
      assertStableTopology(before, staged);
      for (const [index, previous] of before.slides.entries()) {
        if (index === options.slideIndex) continue;
        const current = staged.slides[index]!;
        if (current.xmlSha256 !== previous.xmlSha256 || current.relationshipsSha256 !== previous.relationshipsSha256) {
          throw new Error("editable activation changed an untouched slide part");
        }
      }
      const stagedZip = await JSZip.loadAsync(await readRegularFileNoFollow(stagedPath));
      await validateStagedTargetPackage(stagedZip, target.slidePart, targetRelationshipsPart, relationshipAdditions);
      const afterProtected = await memberHashes(stagedZip, /^ppt\/(?:notesSlides|comments)\//);
      if (JSON.stringify([...afterProtected]) !== JSON.stringify([...beforeProtected])) {
        throw new Error("editable activation changed notes or comments bytes");
      }
      const stagedTargetXml = await stagedZip.file(target.slidePart)!.async("string");
      targetInspection = targetObjectInspection(stagedTargetXml, authenticated);
      intent = ActivationIntentSchema.parse({
        schemaVersion: 1, activationId, sessionId: metadata.session.sessionId,
        candidateRevisionId: metadata.session.candidateRevisionId, parentRevisionId: metadata.session.parentRevisionId,
        slideId: options.slideId, slideIndex: options.slideIndex, targetSlidePart: target.slidePart,
        conversionRevisionId: basename(resolve(options.conversionRoot)), conversionDonorSha256: authenticated.donorPptxSha256,
        oldCandidateSha256: before.sha256, newCandidateSha256: staged.sha256,
        stagedRelativePath: relative(root, stagedPath).split(sep).join("/"), editableSlideIds,
        createdAt: new Date().toISOString(), phases: ["intent-written"],
      });
      await writeDurableExclusive(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
      await syncDirectory(metadata.sessionRoot);
    }
    if (before.sha256 === intent.oldCandidateSha256) {
      await options.operations?.beforeAtomicReplace?.(stagedPath);
      const candidateInfo = await lstat(candidatePath);
      if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile() || digest(await readRegularFileNoFollow(candidatePath)) !== intent.oldCandidateSha256) {
        throw new Error("candidate changed during staging race check");
      }
      await rename(stagedPath, candidatePath);
      await syncDirectory(dirname(candidatePath));
      if ((await inspectLocalPptx(candidatePath)).sha256 !== intent.newCandidateSha256) throw new Error("atomic candidate replacement did not publish staged bytes");
      await options.operations?.checkpoint?.("candidate-replaced");
    }
    intent = await appendIntentPhase(intentPath, intent, "candidate-replaced");
    if (metadata.session.preparedSha256 === intent.oldCandidateSha256) {
      const session = DeckEditSessionSchema.parse({ ...metadata.session, preparedSha256: intent.newCandidateSha256 });
      await replaceJson(join(metadata.sessionRoot, "session.json"), session);
      await options.operations?.checkpoint?.("session-updated");
    }
    intent = await appendIntentPhase(intentPath, intent, "session-updated");
    if (JSON.stringify(metadata.journal.editableSlideIds) !== JSON.stringify(editableSlideIds)) {
      const journal = ActivationJournalSchema.parse({
        ...metadata.journal,
        editableSlideIds,
        entries: [...metadata.journal.entries, { phase: "editable-slide-activated", at: new Date().toISOString() }],
      });
      await replaceJson(join(metadata.sessionRoot, "journal.json"), journal);
      await options.operations?.checkpoint?.("journal-updated");
    }
    intent = await appendIntentPhase(intentPath, intent, "journal-updated");
    await appendIntentPhase(intentPath, intent, "complete");
    return { absolutePath: candidatePath, editableSlideIds, targetInspection, reviewRequiredObjects: authenticated.reviewRequiredObjects, authenticatedConversion: authenticated };
  }));
}
