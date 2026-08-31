import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import JSZip from "jszip";
import { z } from "zod";

import { type EditableManifestV2, EditableManifestV2Schema } from "../editable/schemas.js";
import { EditOperationSchema, UnsupportedEditableTargetError, type EditOperation } from "../editable/operations.js";
import { withGenerationLease } from "../generation/lease.js";
import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withProjectLease } from "../project/lock.js";
import { readProject } from "../project/store.js";
import { readRegularFileNoFollow } from "../project/safe-file.js";
import { inspectLocalPptx } from "./inspect.js";
import sharp from "sharp";

import { extractElementRange, scanOoxmlRanges, type OoxmlElementRange } from "./ooxml.js";
import { readCurrentDeckPointer, readDeckEditSession, readLocalDeckRevision } from "./store.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const UuidSchema = z.string().uuid();

const EditActualSlideObjectsOptionsSchema = z.object({
  root: z.string().min(1),
  currentRevisionId: UuidSchema,
  sessionId: UuidSchema,
  candidatePath: z.string().min(1),
  slideId: UuidSchema,
  manifest: EditableManifestV2Schema,
  operations: z.array(EditOperationSchema).min(1),
}).strict();

export type EditedDeckResult = {
  absolutePath: string;
  currentRevisionId: string;
  candidateRevisionId: string;
  slideId: string;
  slideIndex: number;
  slidePart: string;
  sha256: string;
  objectNames: string[];
  operationsApplied: number;
};

export type RegeneratedDeckResult = Omit<EditedDeckResult, "objectNames" | "operationsApplied"> & {
  normalizedImageSha256: string;
};

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function attribute(element: OoxmlElementRange, namespaceUri: string, localName: string): string | null {
  const matches = element.attributes.filter((item) => item.namespaceUri === namespaceUri && item.localName === localName);
  if (matches.length > 1) throw new Error(`duplicate OOXML ${localName} attribute`);
  return matches[0]?.value ?? null;
}

function replaceRanges(source: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  let result = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unescapeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function officialObjectName(element: EditableManifestV2["elements"][number]): string {
  if (element.kind === "text") return `text-${element.id}`;
  if (element.kind === "shape") return `shape-${element.id}-${element.label}`;
  return `asset-${element.id}`;
}

type CurrentObject = {
  name: string;
  owner: OoxmlElementRange;
  elements: OoxmlElementRange[];
};

function currentObject(xml: string, manifest: EditableManifestV2, operation: EditOperation): CurrentObject {
  const manifestElement = manifest.elements.find((candidate) => candidate.id === operation.elementId);
  if (!manifestElement) throw new UnsupportedEditableTargetError(`target is absent from the authenticated editable manifest: ${operation.elementId}`);
  const expectedKind = operation.kind === "replace-text" || operation.kind === "set-text-style"
    ? "text"
    : operation.kind === "move-shape" || operation.kind === "set-shape-style"
      ? "shape"
      : "asset";
  if (manifestElement.kind !== expectedKind) {
    throw new UnsupportedEditableTargetError(`${operation.kind} requires a current ${expectedKind} object`);
  }
  const name = officialObjectName(manifestElement);
  const elements = scanOoxmlRanges(xml).elements;
  const byStart = new Map(elements.map((element) => [element.start, element] as const));
  const named = elements.filter((element) =>
    element.namespaceUri === P && element.localName === "cNvPr" && attribute(element, "", "name") === name);
  if (named.length !== 1) throw new UnsupportedEditableTargetError(`current slide does not contain exactly one official object named ${name}`);
  const nonVisual = named[0]!.parentStart === null ? undefined : byStart.get(named[0]!.parentStart);
  const owner = nonVisual?.parentStart === null || nonVisual?.parentStart === undefined
    ? undefined
    : byStart.get(nonVisual.parentStart);
  const requiredOwner = expectedKind === "asset" ? "pic" : "sp";
  if (!owner || owner.namespaceUri !== P || owner.localName !== requiredOwner) {
    throw new UnsupportedEditableTargetError(`current object ${name} is not the expected ${requiredOwner} OOXML type`);
  }
  const descendants = elements.filter((element) => element.start >= owner.start && element.end <= owner.end);
  if (expectedKind === "text" && !descendants.some((element) => element.namespaceUri === P && element.localName === "txBody")) {
    throw new UnsupportedEditableTargetError(`current object ${name} is not a text shape`);
  }
  return { name, owner, elements: descendants };
}

function replaceText(xml: string, object: CurrentObject, text: string): string {
  const nodes = object.elements.filter((element) => element.namespaceUri === A && element.localName === "t");
  if (nodes.length === 0) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no DrawingML text nodes`);
  if (nodes.some((node) => node.selfClosing)) throw new UnsupportedEditableTargetError(`current text object ${object.name} has a self-closing text node`);
  let remaining = text;
  const replacements = nodes.map((node, index) => {
    const currentLength = unescapeXmlText(xml.slice(node.openEnd, node.closeStart)).length;
    const next = index === nodes.length - 1 ? remaining : remaining.slice(0, currentLength);
    remaining = remaining.slice(next.length);
    return { start: node.openEnd, end: node.closeStart, value: escapeXmlText(next) };
  });
  return replaceRanges(xml, replacements);
}

function replaceAttributeValue(
  xml: string,
  elements: OoxmlElementRange[],
  namespaceUri: string,
  localName: string,
  attributeName: string,
  value: string,
  label: string,
): string {
  const matches = elements.filter((element) => element.namespaceUri === namespaceUri && element.localName === localName);
  if (matches.length !== 1) throw new UnsupportedEditableTargetError(`${label} is missing or ambiguous on the current object`);
  const attributes = matches[0]!.attributes.filter((item) => item.namespaceUri === "" && item.localName === attributeName);
  if (attributes.length !== 1) throw new UnsupportedEditableTargetError(`${label} attribute is missing or ambiguous on the current object`);
  return replaceRanges(xml, [{ start: attributes[0]!.valueStart, end: attributes[0]!.valueEnd, value }]);
}

function shapePropertyElements(object: CurrentObject): OoxmlElementRange[] {
  const shapeProperties = object.elements.filter((element) => element.namespaceUri === P && element.localName === "spPr" && element.parentStart === object.owner.start);
  if (shapeProperties.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has ambiguous shape properties`);
  return object.elements.filter((element) => element.start >= shapeProperties[0]!.start && element.end <= shapeProperties[0]!.end);
}

function hexColor(value: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new UnsupportedEditableTargetError("OOXML direct color edits require a six-digit RGB color");
  return match[1]!.toUpperCase();
}

function setShapeStyle(xml: string, object: CurrentObject, operation: Extract<EditOperation, { kind: "set-shape-style" }>): string {
  let result = xml;
  const patchColor = (input: string, line: boolean, value: string): string => {
    const refreshed = scanOoxmlRanges(input).elements;
    const owner = refreshed.find((element) => element.start === object.owner.start);
    if (!owner) throw new Error("current object range changed unexpectedly");
    const descendants = refreshed.filter((element) => element.start >= owner.start && element.end <= owner.end);
    const spPr = descendants.filter((element) => element.namespaceUri === P && element.localName === "spPr" && element.parentStart === owner.start);
    if (spPr.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has ambiguous shape properties`);
    const scopeRoot = line
      ? descendants.find((element) => element.namespaceUri === A && element.localName === "ln" && element.parentStart === spPr[0]!.start)
      : spPr[0];
    if (!scopeRoot) throw new UnsupportedEditableTargetError(`current object ${object.name} has no supported ${line ? "stroke" : "fill"}`);
    const scope = descendants.filter((element) => element.start >= scopeRoot.start && element.end <= scopeRoot.end);
    const fills = scope.filter((element) => element.namespaceUri === A && element.localName === "solidFill" && element.parentStart === scopeRoot.start);
    if (fills.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has no single solid ${line ? "stroke" : "fill"}`);
    const colors = scope.filter((element) => element.namespaceUri === A && element.localName === "srgbClr" && element.parentStart === fills[0]!.start);
    if (colors.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has no single RGB ${line ? "stroke" : "fill"}`);
    const attr = colors[0]!.attributes.filter((item) => item.namespaceUri === "" && item.localName === "val");
    if (attr.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} RGB value is ambiguous`);
    return replaceRanges(input, [{ start: attr[0]!.valueStart, end: attr[0]!.valueEnd, value: hexColor(value) }]);
  };
  if (operation.fillColor !== undefined) result = patchColor(result, false, operation.fillColor);
  if (operation.strokeColor !== undefined) result = patchColor(result, true, operation.strokeColor);
  if (operation.strokeWidthPx !== undefined) {
    const refreshedObject = currentObjectByName(result, object.name, "sp");
    const properties = shapePropertyElements(refreshedObject);
    result = replaceAttributeValue(result, properties, A, "ln", "w", String(Math.round(operation.strokeWidthPx * 9525)), "shape stroke width");
  }
  return result;
}

function currentObjectByName(xml: string, name: string, requiredOwner: "sp" | "pic"): CurrentObject {
  const elements = scanOoxmlRanges(xml).elements;
  const byStart = new Map(elements.map((element) => [element.start, element] as const));
  const named = elements.filter((element) => element.namespaceUri === P && element.localName === "cNvPr" && attribute(element, "", "name") === name);
  if (named.length !== 1) throw new UnsupportedEditableTargetError(`current slide does not contain exactly one official object named ${name}`);
  const nonVisual = named[0]!.parentStart === null ? undefined : byStart.get(named[0]!.parentStart);
  const owner = nonVisual?.parentStart === null || nonVisual?.parentStart === undefined ? undefined : byStart.get(nonVisual.parentStart);
  if (!owner || owner.namespaceUri !== P || owner.localName !== requiredOwner) throw new UnsupportedEditableTargetError(`current object ${name} changed type`);
  return { name, owner, elements: elements.filter((element) => element.start >= owner.start && element.end <= owner.end) };
}

function moveObject(xml: string, object: CurrentObject, bbox: { x: number; y: number; width: number; height: number }): string {
  const properties = shapePropertyElements(object);
  const transforms = properties.filter((element) => element.namespaceUri === A && element.localName === "xfrm");
  if (transforms.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has no single transform`);
  const scope = properties.filter((element) => element.start >= transforms[0]!.start && element.end <= transforms[0]!.end);
  const off = scope.filter((element) => element.namespaceUri === A && element.localName === "off" && element.parentStart === transforms[0]!.start);
  const ext = scope.filter((element) => element.namespaceUri === A && element.localName === "ext" && element.parentStart === transforms[0]!.start);
  if (off.length !== 1 || ext.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has an ambiguous transform`);
  const values = new Map([["x", bbox.x], ["y", bbox.y], ["cx", bbox.width], ["cy", bbox.height]] as const);
  const replacements = [
    ...off[0]!.attributes.filter((item) => values.has(item.localName as "x" | "y" | "cx" | "cy")),
    ...ext[0]!.attributes.filter((item) => values.has(item.localName as "x" | "y" | "cx" | "cy")),
  ].map((item) => ({
    start: item.valueStart,
    end: item.valueEnd,
    value: String(Math.round(values.get(item.localName as "x" | "y" | "cx" | "cy")! * 9525)),
  }));
  if (replacements.length !== 4) throw new UnsupportedEditableTargetError(`current object ${object.name} transform attributes are incomplete`);
  return replaceRanges(xml, replacements);
}

function setTextStyle(xml: string, object: CurrentObject, operation: Extract<EditOperation, { kind: "set-text-style" }>): string {
  let result = xml;
  const refresh = () => currentObjectByName(result, object.name, "sp");
  if (operation.align !== undefined) {
    const current = refresh();
    const paragraphs = current.elements.filter((element) => element.namespaceUri === A && element.localName === "p");
    if (paragraphs.length === 0) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no paragraphs`);
    const replacements = paragraphs.map((paragraph) => {
      const properties = current.elements.filter((element) => element.namespaceUri === A && element.localName === "pPr" && element.parentStart === paragraph.start);
      if (properties.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit paragraph alignment`);
      const alignment = properties[0]!.attributes.filter((item) => item.namespaceUri === "" && item.localName === "algn");
      if (alignment.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit paragraph alignment`);
      return {
        start: alignment[0]!.valueStart,
        end: alignment[0]!.valueEnd,
        value: { left: "l", center: "ctr", right: "r" }[operation.align!],
      };
    });
    result = replaceRanges(result, replacements);
  }
  if (operation.bold !== undefined || operation.fontSizePx !== undefined) {
    const current = refresh();
    const runProperties = current.elements.filter((element) => element.namespaceUri === A && element.localName === "rPr");
    if (runProperties.length === 0) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no explicit run formatting`);
    const replacements = runProperties.flatMap((properties) => {
      const values: Array<{ name: string; value: string }> = [];
      if (operation.bold !== undefined) values.push({ name: "b", value: operation.bold ? "1" : "0" });
      if (operation.fontSizePx !== undefined) values.push({ name: "sz", value: String(Math.round(operation.fontSizePx * 75)) });
      return values.map(({ name, value }) => {
        const matches = properties.attributes.filter((item) => item.namespaceUri === "" && item.localName === name);
        if (matches.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit ${name} run property`);
        return { start: matches[0]!.valueStart, end: matches[0]!.valueEnd, value };
      });
    });
    result = replaceRanges(result, replacements);
  }
  if (operation.color !== undefined) {
    const current = refresh();
    const runProperties = current.elements.filter((element) => element.namespaceUri === A && element.localName === "rPr");
    const replacements = runProperties.map((properties) => {
      const fills = current.elements.filter((element) => element.namespaceUri === A && element.localName === "solidFill" && element.parentStart === properties.start);
      if (fills.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit solid run fill`);
      const colors = current.elements.filter((element) => element.namespaceUri === A && element.localName === "srgbClr" && element.parentStart === fills[0]!.start);
      if (colors.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit RGB run fill`);
      const value = colors[0]!.attributes.filter((item) => item.namespaceUri === "" && item.localName === "val");
      if (value.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has an ambiguous run color`);
      return { start: value[0]!.valueStart, end: value[0]!.valueEnd, value: hexColor(operation.color!) };
    });
    if (replacements.length === 0) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no explicit run colors`);
    result = replaceRanges(result, replacements);
  }
  return result;
}

function applyOperation(xml: string, manifest: EditableManifestV2, operation: EditOperation): string {
  const object = currentObject(xml, manifest, operation);
  if (operation.kind === "replace-text") return replaceText(xml, object, operation.text);
  if (operation.kind === "set-text-style") return setTextStyle(xml, object, operation);
  if (operation.kind === "set-shape-style") return setShapeStyle(xml, object, operation);
  if (operation.kind === "move-shape" || operation.kind === "move-asset") return moveObject(xml, object, operation.bbox);
  throw new UnsupportedEditableTargetError(`${operation.kind} is not safely supported against current OOXML yet`);
}

async function memberHashes(zip: JSZip): Promise<Map<string, string>> {
  const names = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
  return new Map(await Promise.all(names.map(async (name) => [name, digest(await zip.file(name)!.async("nodebuffer"))] as const)));
}

function appendRelationship(xml: string, id: string, target: string): string {
  const root = extractElementRange(xml, REL, "Relationships");
  const child = `<Relationship xmlns="${REL}" Id="${id}" Type="${R}/image" Target="${target}"/>`;
  if (root.selfClosing) {
    const opening = xml.slice(root.start, root.openEnd).replace(/\/\s*>$/, ">");
    return `${xml.slice(0, root.start)}${opening}${child}</${root.qualifiedName}>${xml.slice(root.end)}`;
  }
  return `${xml.slice(0, root.closeStart)}${child}${xml.slice(root.closeStart)}`;
}

function ensurePngContentType(xml: string): string {
  const index = scanOoxmlRanges(xml);
  const pngDefaults = index.elements.filter((element) =>
    element.namespaceUri === CONTENT_TYPES
    && element.localName === "Default"
    && attribute(element, "", "Extension")?.toLowerCase() === "png");
  if (pngDefaults.length > 0) {
    if (pngDefaults.length !== 1 || attribute(pngDefaults[0]!, "", "ContentType") !== "image/png") {
      throw new Error("complete deck has an ambiguous PNG content-type declaration");
    }
    return xml;
  }
  const root = extractElementRange(xml, CONTENT_TYPES, "Types");
  const child = `<Default xmlns="${CONTENT_TYPES}" Extension="png" ContentType="image/png"/>`;
  if (root.selfClosing) {
    const opening = xml.slice(root.start, root.openEnd).replace(/\/\s*>$/, ">");
    return `${xml.slice(0, root.start)}${opening}${child}</${root.qualifiedName}>${xml.slice(root.end)}`;
  }
  return `${xml.slice(0, root.closeStart)}${child}${xml.slice(root.closeStart)}`;
}

function regeneratedShapeTree(slideId: string, relationshipId: string): string {
  return `<p:spTree xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:nvGrpSpPr><p:cNvPr id="1" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="asset-regenerated-${slideId}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree>`;
}

export async function replaceRegeneratedSlideShapeTree(options: {
  root: string;
  currentRevisionId: string;
  sessionId: string;
  candidatePath: string;
  slideId: string;
  normalizedImage: Buffer;
  normalizedImageSha256: string;
  operations?: {
    beforeAtomicReplace?: (stagingPath: string) => Promise<void> | void;
  };
}): Promise<RegeneratedDeckResult> {
  const valid = z.object({
    root: z.string().min(1),
    currentRevisionId: UuidSchema,
    sessionId: UuidSchema,
    candidatePath: z.string().min(1),
    slideId: UuidSchema,
    normalizedImage: z.instanceof(Buffer),
    normalizedImageSha256: z.string().regex(/^[a-f0-9]{64}$/),
    operations: z.object({
      beforeAtomicReplace: z.custom<(stagingPath: string) => Promise<void> | void>((value) => typeof value === "function").optional(),
    }).strict().optional(),
  }).strict().parse(options);
  if (digest(valid.normalizedImage) !== valid.normalizedImageSha256) throw new Error("regenerated normalized image hash does not match authenticated bytes");
  const metadata = await sharp(valid.normalizedImage, { failOn: "error" }).metadata();
  if (metadata.format !== "png" || metadata.width !== 1920 || metadata.height !== 1080) {
    throw new Error("regenerated normalized image must be an exact 1920x1080 PNG");
  }
  return withGenerationLease(valid.root, (generationRoot) => withProjectLease(generationRoot, "deck-revisions", async (root) => {
    const [project, current, session] = await Promise.all([
      readProject(root),
      readCurrentDeckPointer(root),
      readDeckEditSession(root, valid.sessionId),
    ]);
    if (project.activeDeckEditSessionId !== session.sessionId || session.mode !== "agent" || session.state !== "prepared") {
      throw new Error("slide regeneration requires its exact active prepared Agent candidate");
    }
    if (current.revisionId !== valid.currentRevisionId || session.parentRevisionId !== valid.currentRevisionId) {
      throw new Error("slide regeneration is stale for the current deck revision");
    }
    const candidatePath = resolve(valid.candidatePath);
    if (candidatePath !== session.absolutePath || await realpath(candidatePath) !== candidatePath) {
      throw new Error("slide regeneration candidate path does not bind the active complete deck session");
    }
    const before = await inspectLocalPptx(candidatePath);
    if (before.sha256 !== session.preparedSha256) throw new Error("slide regeneration candidate bytes changed outside the authorized boundary");
    const parent = await readLocalDeckRevision(root, valid.currentRevisionId);
    const target = parent.slideTopology.entries.find((entry) => entry.stableSlideId === valid.slideId);
    const actual = target ? before.slides[target.position] : undefined;
    if (!target || !actual || actual.slidePart !== target.slidePart
      || actual.presentationSlideId !== target.presentationSlideId || actual.creationId !== target.creationId) {
      throw new Error("slide regeneration target does not bind the current reconciled topology");
    }
    const bytes = await readRegularFileNoFollow(candidatePath);
    if (digest(bytes) !== before.sha256) throw new Error("slide regeneration candidate changed during stable read");
    const zip = await JSZip.loadAsync(bytes);
    const beforeMembers = await memberHashes(zip);
    const slideFile = zip.file(target.slidePart);
    if (!slideFile) throw new Error("slide regeneration target part is missing");
    const slideXml = await slideFile.async("string");
    const shapeTree = extractElementRange(slideXml, P, "spTree");
    const relationshipsPart = `ppt/slides/_rels/${basename(target.slidePart)}.rels`;
    const relationshipsXml = zip.file(relationshipsPart)
      ? await zip.file(relationshipsPart)!.async("string")
      : `<Relationships xmlns="${REL}"/>`;
    const relationshipElements = scanOoxmlRanges(relationshipsXml).elements.filter((element) =>
      element.namespaceUri === REL && element.localName === "Relationship");
    const usedIds = new Set(relationshipElements.map((element) => attribute(element, "", "Id")).filter((id): id is string => Boolean(id)));
    if (usedIds.size !== relationshipElements.length) throw new Error("target slide relationships have duplicate or missing IDs");
    let number = 1;
    while (usedIds.has(`rId${number}`)) number += 1;
    const relationshipId = `rId${number}`;
    const mediaName = `superppt-regenerated-${randomUUID()}.png`;
    const mediaPart = `ppt/media/${mediaName}`;
    if (zip.file(mediaPart)) throw new Error("regenerated media path collides with an existing package part");
    const contentTypesFile = zip.file("[Content_Types].xml");
    if (!contentTypesFile) throw new Error("complete deck content types are missing");
    zip.file(target.slidePart, `${slideXml.slice(0, shapeTree.start)}${regeneratedShapeTree(valid.slideId, relationshipId)}${slideXml.slice(shapeTree.end)}`);
    zip.file(relationshipsPart, appendRelationship(relationshipsXml, relationshipId, `../media/${mediaName}`));
    zip.file(mediaPart, valid.normalizedImage);
    zip.file("[Content_Types].xml", ensurePngContentType(await contentTypesFile.async("string")));
    const stagingPath = join(dirname(candidatePath), `.deck-identity-${randomUUID()}.staging.pptx`);
    try {
      await writeDurableExclusive(stagingPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
      await syncDirectory(dirname(candidatePath));
      await valid.operations?.beforeAtomicReplace?.(stagingPath);
      const after = await inspectLocalPptx(stagingPath);
      assertStableTopology(before, after);
      for (const [index, previous] of before.slides.entries()) {
        if (index === target.position) continue;
        const next = after.slides[index]!;
        if (next.xmlSha256 !== previous.xmlSha256 || next.relationshipsSha256 !== previous.relationshipsSha256) {
          throw new Error("slide regeneration changed an untouched slide part");
        }
      }
      const stagedZip = await JSZip.loadAsync(await readRegularFileNoFollow(stagingPath));
      const afterMembers = await memberHashes(stagedZip);
      const allowedChanges = new Set([target.slidePart, relationshipsPart, "[Content_Types].xml"]);
      for (const [name, hash] of beforeMembers) {
        if (!allowedChanges.has(name) && afterMembers.get(name) !== hash) {
          throw new Error(`slide regeneration changed a pre-existing package member: ${name}`);
        }
      }
      if (digest(await stagedZip.file(mediaPart)!.async("nodebuffer")) !== valid.normalizedImageSha256) {
        throw new Error("slide regeneration staged media does not match authenticated normalized bytes");
      }
      const currentInfo = await lstat(candidatePath);
      if (currentInfo.isSymbolicLink() || !currentInfo.isFile() || digest(await readRegularFileNoFollow(candidatePath)) !== before.sha256) {
        throw new Error("slide regeneration candidate changed during publication race check");
      }
      await rename(stagingPath, candidatePath);
      await syncDirectory(dirname(candidatePath));
      const published = await inspectLocalPptx(candidatePath);
      if (published.sha256 !== after.sha256) throw new Error("slide regeneration atomic publication changed staged bytes");
      return {
        absolutePath: candidatePath,
        currentRevisionId: current.revisionId,
        candidateRevisionId: session.candidateRevisionId,
        slideId: valid.slideId,
        slideIndex: target.position,
        slidePart: target.slidePart,
        sha256: published.sha256,
        normalizedImageSha256: valid.normalizedImageSha256,
      };
    } catch (error: unknown) {
      try {
        const info = await lstat(stagingPath);
        if (info.isFile() && !info.isSymbolicLink()) {
          const { unlink } = await import("node:fs/promises");
          await unlink(stagingPath);
        }
      } catch (cleanupError: unknown) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AggregateError([error, cleanupError], "slide regeneration failed and staging cleanup failed");
        }
      }
      throw error;
    }
  }));
}

function assertStableTopology(
  before: Awaited<ReturnType<typeof inspectLocalPptx>>,
  after: Awaited<ReturnType<typeof inspectLocalPptx>>,
): void {
  if (before.slideCount !== after.slideCount || before.slides.some((slide, index) => {
    const next = after.slides[index];
    return !next
      || slide.slidePart !== next.slidePart
      || slide.presentationSlideId !== next.presentationSlideId
      || slide.creationId !== next.creationId
      || slide.relationshipId !== next.relationshipId;
  })) throw new Error("direct edit changed stable complete-deck topology");
}

export async function editActualSlideObjects(options: {
  root: string;
  currentRevisionId: string;
  sessionId: string;
  candidatePath: string;
  slideId: string;
  manifest: EditableManifestV2;
  operations: EditOperation[];
}): Promise<EditedDeckResult> {
  const valid = EditActualSlideObjectsOptionsSchema.parse(options);
  return withGenerationLease(valid.root, (generationRoot) => withProjectLease(generationRoot, "deck-revisions", async (root) => {
    const [project, current, session] = await Promise.all([
      readProject(root),
      readCurrentDeckPointer(root),
      readDeckEditSession(root, valid.sessionId),
    ]);
    if (project.activeDeckEditSessionId !== session.sessionId || session.mode !== "agent" || session.state !== "prepared") {
      throw new Error("direct edits require their exact active prepared Agent candidate");
    }
    if (current.revisionId !== valid.currentRevisionId || session.parentRevisionId !== valid.currentRevisionId) {
      throw new Error("direct edit route is stale for the current deck revision");
    }
    const candidatePath = resolve(valid.candidatePath);
    if (candidatePath !== session.absolutePath || await realpath(candidatePath) !== candidatePath) {
      throw new Error("direct edit candidate path does not bind the active complete deck session");
    }
    const before = await inspectLocalPptx(candidatePath);
    if (before.sha256 !== session.preparedSha256) throw new Error("direct edit candidate bytes changed outside the authorized boundary");
    const parent = await readLocalDeckRevision(root, valid.currentRevisionId);
    const target = parent.slideTopology.entries.find((entry) => entry.stableSlideId === valid.slideId);
    const actual = target ? before.slides[target.position] : undefined;
    if (!target || !actual
      || actual.slidePart !== target.slidePart
      || actual.presentationSlideId !== target.presentationSlideId
      || actual.creationId !== target.creationId) {
      throw new Error("direct edit target does not bind the current reconciled slide topology");
    }
    const candidateBytes = await readRegularFileNoFollow(candidatePath);
    if (digest(candidateBytes) !== before.sha256) throw new Error("direct edit candidate changed during stable read");
    const zip = await JSZip.loadAsync(candidateBytes);
    const targetFile = zip.file(target.slidePart);
    if (!targetFile) throw new Error("direct edit target slide part is missing");
    const beforeMembers = await memberHashes(zip);
    let xml = await targetFile.async("string");
    const objectNames: string[] = [];
    for (const operation of valid.operations) {
      const manifestElement = valid.manifest.elements.find((element) => element.id === operation.elementId);
      if (manifestElement) objectNames.push(officialObjectName(manifestElement));
      xml = applyOperation(xml, valid.manifest, operation);
    }
    zip.file(target.slidePart, xml);
    const stagingPath = join(dirname(candidatePath), `.deck-identity-${randomUUID()}.staging.pptx`);
    try {
      await writeDurableExclusive(stagingPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
      await syncDirectory(dirname(candidatePath));
      const stagedInfo = await lstat(stagingPath);
      if (stagedInfo.isSymbolicLink() || !stagedInfo.isFile()) throw new Error("direct edit staging is unsafe");
      const after = await inspectLocalPptx(stagingPath);
      assertStableTopology(before, after);
      const stagedZip = await JSZip.loadAsync(await readRegularFileNoFollow(stagingPath));
      const afterMembers = await memberHashes(stagedZip);
      for (const [name, hash] of beforeMembers) {
        if (name !== target.slidePart && afterMembers.get(name) !== hash) {
          throw new Error(`direct edit changed a non-target package part: ${name}`);
        }
      }
      const currentInfo = await lstat(candidatePath);
      if (currentInfo.isSymbolicLink() || !currentInfo.isFile() || digest(await readRegularFileNoFollow(candidatePath)) !== before.sha256) {
        throw new Error("direct edit candidate changed during publication race check");
      }
      await rename(stagingPath, candidatePath);
      await syncDirectory(dirname(candidatePath));
      const published = await inspectLocalPptx(candidatePath);
      if (published.sha256 !== after.sha256) throw new Error("direct edit atomic publication changed staged bytes");
      return {
        absolutePath: candidatePath,
        currentRevisionId: current.revisionId,
        candidateRevisionId: session.candidateRevisionId,
        slideId: valid.slideId,
        slideIndex: target.position,
        slidePart: target.slidePart,
        sha256: published.sha256,
        objectNames: [...new Set(objectNames)],
        operationsApplied: valid.operations.length,
      };
    } catch (error: unknown) {
      try {
        const info = await lstat(stagingPath);
        if (info.isFile() && !info.isSymbolicLink()) {
          const { unlink } = await import("node:fs/promises");
          await unlink(stagingPath);
        }
      } catch (cleanupError: unknown) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AggregateError([error, cleanupError], "direct edit failed and staging cleanup failed");
        }
      }
      throw error;
    }
  }));
}
