import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, sep } from "node:path";

import JSZip from "jszip";

import { validateProjectRoot } from "../project/paths.js";
import { readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { scanOoxmlRanges, type OoxmlElementRange } from "./ooxml.js";

const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DOCUMENT_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const POWERPOINT_2010 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const CREATION_ID_EXTENSION = "{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}";
const SLIDE_RELATIONSHIP_TYPE = `${DOCUMENT_RELATIONSHIPS}/slide`;

export type InspectedSlidePart = {
  position: number;
  slidePart: string;
  presentationSlideId: number;
  relationshipId: string;
  relationshipTarget: string;
  creationId: number | null;
  xmlSha256: string;
  relationshipsSha256: string | null;
};

export type InspectedLocalPptx = {
  absolutePath: string;
  projectRoot: string;
  sha256: string;
  byteLength: number;
  slideCount: number;
  orderedSlideParts: string[];
  slideParts: InspectedSlidePart[];
  slides: InspectedSlidePart[];
};

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function attribute(element: OoxmlElementRange, namespaceUri: string, localName: string): string | null {
  const matches = element.attributes.filter((item) =>
    item.namespaceUri === namespaceUri && item.localName === localName);
  if (matches.length > 1) throw new Error(`duplicate ${localName} attribute`);
  return matches[0]?.value ?? null;
}

function unsignedInt(value: string | null, label: string, minimum: number): number {
  if (!value || !/^[0-9]+$/.test(value)) throw new Error(`${label} is invalid`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > 4294967295) {
    throw new Error(`${label} is invalid`);
  }
  return number;
}

function projectRootForDeck(path: string): string {
  let root = path;
  for (let index = 0; index < 4; index += 1) root = dirname(root);
  return root;
}

async function stableDeckRead(path: string): Promise<Buffer> {
  const firstStat = await lstat(path, { bigint: true });
  const first = await readRegularFileNoFollow(path);
  const middleStat = await lstat(path, { bigint: true });
  const second = await readRegularFileNoFollow(path);
  const secondStat = await lstat(path, { bigint: true });
  const stable = [firstStat, middleStat, secondStat].every((info) =>
    info.isFile()
    && !info.isSymbolicLink()
    && info.size === firstStat.size
    && info.mtimeNs === firstStat.mtimeNs);
  if (!stable || digest(first) !== digest(second)) throw new Error("PPTX changed during stable read");
  return second;
}

function safeSlideTarget(target: string): string {
  if (
    !target
    || target.includes("\\")
    || target.split("/").some((part, index) => (part === "" && index !== 0) || part === "." || part === "..")
  ) throw new Error(`PPTX slide target contains traversal or an unsafe path: ${target}`);
  const resolved = target.startsWith("/")
    ? target.slice(1)
    : posix.normalize(posix.join("ppt", target));
  if (!/^ppt\/slides\/slide[0-9]+\.xml$/.test(resolved)) throw new Error("PPTX slide target is unsafe");
  return resolved;
}

function officialCreationId(xml: string): number | null {
  const elements = scanOoxmlRanges(xml).elements;
  const commonSlides = elements.filter((element) =>
    element.namespaceUri === PRESENTATION && element.localName === "cSld");
  if (commonSlides.length !== 1) throw new Error("PPTX slide has ambiguous common slide data");
  const extensionLists = elements.filter((element) =>
    element.namespaceUri === PRESENTATION
    && element.localName === "extLst"
    && element.parentStart === commonSlides[0]!.start);
  const extensions = elements.filter((element) =>
    element.namespaceUri === PRESENTATION
    && element.localName === "ext"
    && extensionLists.some((extensionList) => element.parentStart === extensionList.start)
    && attribute(element, "", "uri") === CREATION_ID_EXTENSION);
  const candidates = elements.filter((element) =>
    element.namespaceUri === POWERPOINT_2010
    && element.localName === "creationId"
    && extensions.some((extension) => element.parentStart === extension.start));
  const allCreationIds = elements.filter((element) =>
    element.namespaceUri === POWERPOINT_2010 && element.localName === "creationId");
  if (allCreationIds.length !== candidates.length) {
    throw new Error("PPTX slide has creation identity outside the official extension");
  }
  if (candidates.length > 1) throw new Error("PPTX slide has ambiguous creation identity");
  if (candidates.length === 0) return null;
  return unsignedInt(attribute(candidates[0]!, "", "val"), "slide creation ID", 1);
}

export async function inspectLocalPptx(path: string): Promise<InspectedLocalPptx> {
  if (!isAbsolute(path)) throw new Error("PPTX inspection requires an absolute project path");
  const projectRoot = await validateProjectRoot(projectRootForDeck(path));
  await readProject(projectRoot);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error("PPTX path must be canonical and non-symlinked");
  const projectRelative = relative(projectRoot, canonical).split(sep).join("/");
  if (!/^output\/(?:deck-revisions\/[0-9a-f-]{36}|candidates\/\.?[0-9a-f-]+(?:\.staging)?)\/(?:deck\.pptx|\.deck-identity-[0-9a-f-]{36}\.staging\.pptx)$/.test(projectRelative)) {
    throw new Error("PPTX inspection path must be an owned complete-deck artifact");
  }
  const bytes = await stableDeckRead(canonical);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error: unknown) {
    throw new Error("PPTX package is invalid", { cause: error });
  }
  for (const required of ["[Content_Types].xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"]) {
    if (!zip.file(required)) throw new Error(`PPTX package is missing ${required}`);
  }
  const packageSlideParts = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name));
  if (packageSlideParts.length === 0) throw new Error("PPTX package has no slides");

  const presentationXml = await zip.file("ppt/presentation.xml")!.async("string");
  const relationshipsXml = await zip.file("ppt/_rels/presentation.xml.rels")!.async("string");
  const presentationElements = scanOoxmlRanges(presentationXml).elements;
  const relationshipElements = scanOoxmlRanges(relationshipsXml).elements.filter((element) =>
    element.namespaceUri === PACKAGE_RELATIONSHIPS && element.localName === "Relationship");
  const relationships = new Map<string, { target: string; type: string; external: boolean }>();
  for (const element of relationshipElements) {
    const id = attribute(element, "", "Id");
    const target = attribute(element, "", "Target");
    const type = attribute(element, "", "Type");
    if (!id || !target || !type) throw new Error("PPTX relationship is incomplete");
    if (relationships.has(id)) throw new Error("PPTX has duplicate slide relationship IDs");
    relationships.set(id, { target, type, external: attribute(element, "", "TargetMode") === "External" });
  }

  const sldIds = presentationElements.filter((element) =>
    element.namespaceUri === PRESENTATION && element.localName === "sldId");
  if (sldIds.length === 0) throw new Error("PPTX presentation has no ordered slides");
  const presentationIds = new Set<number>();
  const relationshipIds = new Set<string>();
  const targets = new Set<string>();
  const creationIds = new Set<number>();
  const slides: InspectedSlidePart[] = [];
  for (const [position, element] of sldIds.entries()) {
    const presentationSlideId = unsignedInt(attribute(element, "", "id"), "presentation slide ID", 256);
    const relationshipId = attribute(element, DOCUMENT_RELATIONSHIPS, "id");
    if (!relationshipId) throw new Error("PPTX slide relationship identity is missing");
    if (presentationIds.has(presentationSlideId) || relationshipIds.has(relationshipId)) {
      throw new Error("PPTX has duplicate persistent slide identities");
    }
    presentationIds.add(presentationSlideId);
    relationshipIds.add(relationshipId);
    const relationship = relationships.get(relationshipId);
    if (!relationship || relationship.type !== SLIDE_RELATIONSHIP_TYPE) {
      throw new Error("PPTX slide relationship target is missing or ambiguous");
    }
    if (relationship.external) throw new Error("PPTX has an external slide target");
    const slidePart = safeSlideTarget(relationship.target);
    if (targets.has(slidePart)) throw new Error("PPTX maps multiple identities to one slide target");
    targets.add(slidePart);
    const slideFile = zip.file(slidePart);
    if (!slideFile) throw new Error("PPTX internal slide target is missing");
    const xml = await slideFile.async("string");
    const creationId = officialCreationId(xml);
    if (creationId !== null) {
      if (creationIds.has(creationId)) throw new Error("PPTX has duplicate persistent creation IDs");
      creationIds.add(creationId);
    }
    const relationshipPart = `ppt/slides/_rels/${posix.basename(slidePart)}.rels`;
    const relationshipFile = zip.file(relationshipPart);
    const relationshipBytes = relationshipFile ? await relationshipFile.async("nodebuffer") : null;
    slides.push({
      position,
      slidePart,
      presentationSlideId,
      relationshipId,
      relationshipTarget: relationship.target,
      creationId,
      xmlSha256: digest(Buffer.from(xml, "utf8")),
      relationshipsSha256: relationshipBytes ? digest(relationshipBytes) : null,
    });
  }
  return {
    absolutePath: canonical,
    projectRoot,
    sha256: digest(bytes),
    byteLength: bytes.length,
    slideCount: slides.length,
    orderedSlideParts: slides.map((slide) => slide.slidePart),
    slideParts: slides,
    slides,
  };
}
