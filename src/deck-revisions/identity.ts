import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withProjectLease } from "../project/lock.js";
import { isSameOrAncestor } from "../project/paths.js";
import { inspectLocalPptx } from "./inspect.js";
import { readBoundedPptxArchiveFile } from "./archive.js";
import { scanOoxmlRanges, type OoxmlElementRange } from "./ooxml.js";
import { type SlideTopology } from "./schemas.js";
import { finalizeSlideTopology } from "./topology.js";

const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";
const POWERPOINT_2010 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const CREATION_ID_EXTENSION = "{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}";

export type InitialSlideIdentity = { stableSlideId: string; position: number };

function attribute(element: OoxmlElementRange, namespaceUri: string, localName: string): string | null {
  return element.attributes.find((item) =>
    item.namespaceUri === namespaceUri && item.localName === localName)?.value ?? null;
}

function containing(
  elements: OoxmlElementRange[],
  parent: OoxmlElementRange,
  namespaceUri: string,
  localName: string,
): OoxmlElementRange[] {
  return elements.filter((element) =>
    element.namespaceUri === namespaceUri
    && element.localName === localName
    && element.parentStart === parent.start);
}

function expandSelfClosing(xml: string, element: OoxmlElementRange): string {
  if (!element.selfClosing) return xml;
  const raw = xml.slice(element.start, element.end);
  const slash = raw.lastIndexOf("/");
  if (slash < 0 || !/^\/\s*>$/.test(raw.slice(slash))) throw new Error("self-closing OOXML range is invalid");
  const paired = `${raw.slice(0, slash)}></${element.qualifiedName}>`;
  return `${xml.slice(0, element.start)}${paired}${xml.slice(element.end)}`;
}

function namespacePrefix(xml: string): { xml: string; prefix: string } {
  const root = scanOoxmlRanges(xml).elements[0];
  if (!root) throw new Error("slide XML has no root element");
  const existing = root.attributes.find((item) => item.namespaceUri === XMLNS && item.value === POWERPOINT_2010);
  if (existing) return { xml, prefix: existing.localName };
  const occupied = new Set(root.attributes
    .filter((item) => item.namespaceUri === XMLNS)
    .map((item) => item.localName));
  let prefix = "p14";
  let suffix = 1;
  while (occupied.has(prefix)) prefix = `p14sp${suffix++}`;
  const insertion = root.openEnd - (xml.slice(root.start, root.openEnd).endsWith("/>") ? 2 : 1);
  return {
    xml: `${xml.slice(0, insertion)} xmlns:${prefix}="${POWERPOINT_2010}"${xml.slice(insertion)}`,
    prefix,
  };
}

function injectCreationId(source: string, creationId: number): string {
  const namespaced = namespacePrefix(source);
  const index = scanOoxmlRanges(namespaced.xml);
  const commonSlides = index.elements.filter((element) =>
    element.namespaceUri === PRESENTATION && element.localName === "cSld");
  if (commonSlides.length !== 1) throw new Error("slide XML must contain exactly one common slide data element");
  const commonSlide = commonSlides[0]!;
  const existingCreation = containing(index.elements, commonSlide, POWERPOINT_2010, "creationId");
  if (existingCreation.length > 0) throw new Error("identity injection cannot replace an existing creation ID");
  const extensionLists = containing(index.elements, commonSlide, PRESENTATION, "extLst");
  if (extensionLists.length > 1) throw new Error("slide XML has ambiguous extension lists");
  const value = `<${namespaced.prefix}:creationId val="${creationId}"/>`;
  if (extensionLists.length === 1) {
    const extensionList = extensionLists[0]!;
    if (extensionList.selfClosing) return injectCreationId(expandSelfClosing(namespaced.xml, extensionList), creationId);
    const official = containing(index.elements, extensionList, PRESENTATION, "ext").filter((element) =>
      attribute(element, "", "uri") === CREATION_ID_EXTENSION);
    if (official.length > 1) throw new Error("slide XML has ambiguous creation ID extensions");
    if (official.length === 1) {
      if (official[0]!.selfClosing) return injectCreationId(expandSelfClosing(namespaced.xml, official[0]!), creationId);
      const insertion = official[0]!.closeStart;
      return `${namespaced.xml.slice(0, insertion)}${value}${namespaced.xml.slice(insertion)}`;
    }
    const presentationPrefix = extensionList.qualifiedName.includes(":")
      ? extensionList.qualifiedName.split(":", 1)[0]!
      : "";
    const qualified = (local: string) => presentationPrefix ? `${presentationPrefix}:${local}` : local;
    const insertion = extensionList.closeStart;
    const extension = `<${qualified("ext")} uri="${CREATION_ID_EXTENSION}">${value}</${qualified("ext")}>`;
    return `${namespaced.xml.slice(0, insertion)}${extension}${namespaced.xml.slice(insertion)}`;
  }
  const presentationPrefix = commonSlide.qualifiedName.includes(":")
    ? commonSlide.qualifiedName.split(":", 1)[0]!
    : "";
  const qualified = (local: string) => presentationPrefix ? `${presentationPrefix}:${local}` : local;
  const extensionList = `<${qualified("extLst")}><${qualified("ext")} uri="${CREATION_ID_EXTENSION}">${value}</${qualified("ext")}></${qualified("extLst")}>`;
  return `${namespaced.xml.slice(0, commonSlide.closeStart)}${extensionList}${namespaced.xml.slice(commonSlide.closeStart)}`;
}

function allocateCreationId(used: Set<number>): number {
  while (true) {
    const value = randomBytes(4).readUInt32BE(0);
    if (value !== 0 && !used.has(value)) {
      used.add(value);
      return value;
    }
  }
}

export async function publishInitialSlideIdentities(
  pptxPath: string,
  slides: InitialSlideIdentity[],
): Promise<SlideTopology> {
  let projectRoot = pptxPath;
  for (let index = 0; index < 4; index += 1) projectRoot = dirname(projectRoot);
  return withProjectLease(projectRoot, "deck-identity", async (root) => {
    const canonical = await realpath(pptxPath);
    if (!isSameOrAncestor(root, canonical)) throw new Error("identity publication path escaped its owned project");
    if (canonical !== pptxPath) throw new Error("identity publication requires a canonical PPTX path");
    const info = await lstat(canonical);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("identity publication requires a regular PPTX file");
    const before = await inspectLocalPptx(canonical);
    const ordered = [...slides].sort((left, right) => left.position - right.position);
    if (
      ordered.length !== before.slideCount
      || ordered.some((slide, position) => slide.position !== position)
      || new Set(ordered.map((slide) => slide.stableSlideId)).size !== ordered.length
    ) throw new Error("initial slide identity list does not match the complete deck");
    const used = new Set(before.slides.flatMap((slide) => slide.creationId === null ? [] : [slide.creationId]));
    const assigned = before.slides.map((slide) => slide.creationId ?? allocateCreationId(used));
    if (before.slides.some((slide) => slide.creationId === null)) {
      const zip = await readBoundedPptxArchiveFile(canonical);
      for (const [position, slide] of before.slides.entries()) {
        if (slide.creationId !== null) continue;
        const file = zip.file(slide.slidePart);
        if (!file) throw new Error("identity publication lost a slide part");
        zip.file(slide.slidePart, injectCreationId(await file.async("string"), assigned[position]!));
      }
      const staged = join(dirname(canonical), `.deck-identity-${randomUUID()}.staging.pptx`);
      await writeDurableExclusive(staged, await zip.generateAsync({ type: "nodebuffer" }));
      try {
        await inspectLocalPptx(staged);
        await rename(staged, canonical);
      } catch (error: unknown) {
        await unlink(staged).catch(() => undefined);
        throw error;
      }
      await syncDirectory(dirname(canonical));
    }
    const inspected = await inspectLocalPptx(canonical);
    if (inspected.slides.some((slide, position) => slide.creationId !== assigned[position])) {
      throw new Error("published slide identities did not survive PPTX validation");
    }
    return finalizeSlideTopology(inspected.slides.map((slide, position) => ({
      stableSlideId: ordered[position]!.stableSlideId,
      slidePart: slide.slidePart,
      position,
      management: "managed",
      presentationSlideId: slide.presentationSlideId,
      creationId: slide.creationId!,
    })), []);
  });
}
