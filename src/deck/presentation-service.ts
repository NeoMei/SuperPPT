import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";

import { promoteExclusive } from "../project/exclusive.js";
import {
  pxToInchX,
  pxToInchY,
  pxToPt,
  SLIDE_HEIGHT_IN,
  SLIDE_WIDTH_IN,
} from "./geometry.js";
import type { PptxPage } from "./pptx.js";

const dataUri = (bytes: Buffer, contentType: "image/png" | "image/jpeg"): string =>
  `data:${contentType};base64,${bytes.toString("base64")}`;

const color = (value: string): string => value.startsWith("#") ? value.slice(1) : value;

function box(bbox: { x: number; y: number; width: number; height: number }) {
  const tenthInch = (value: number): number => Math.round(value * 10) / 10;
  return {
    x: tenthInch(pxToInchX(bbox.x)),
    y: tenthInch(pxToInchY(bbox.y)),
    w: tenthInch(pxToInchX(bbox.width)),
    h: tenthInch(pxToInchY(bbox.height)),
  };
}

function serializeDefaultLanguage(source: string): string {
  return source.replace(/<a:defRPr\b([^>]*)>/g, (tag, attributes: string) => {
    if (/\slang="[^"]+"/.test(attributes)) {
      return tag.replace(/\slang="[^"]+"/, ' lang="zh-CN"');
    }
    return `<a:defRPr lang="zh-CN"${attributes}>`;
  });
}

async function normalizeOwnedOoxml(path: string): Promise<void> {
  const archive = await JSZip.loadAsync(await readFile(path));
  const slidePaths = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  for (const slidePath of slidePaths) {
    const slide = archive.file(slidePath);
    if (!slide) continue;
    const source = await slide.async("string");
    archive.file(slidePath, source.replace(/<a:rPr\b([^>]*)>/g, (tag, attributes: string) => {
      const bold = attributes.match(/\sb="[^"]+"/)?.[0];
      const size = attributes.match(/\ssz="[^"]+"/)?.[0];
      if (!bold || !size) return tag;
      return `<a:rPr${bold}${size}${attributes.replace(bold, "").replace(size, "")}>`;
    }));
  }
  const defaultLanguagePaths = Object.keys(archive.files).filter((name) =>
    name === "ppt/presentation.xml"
      || /^ppt\/(?:slideMasters|notesMasters)\/[^/]+\.xml$/.test(name));
  for (const languagePath of defaultLanguagePaths) {
    const part = archive.file(languagePath);
    if (!part) continue;
    archive.file(languagePath, serializeDefaultLanguage(await part.async("string")));
  }
  const core = archive.file("docProps/core.xml");
  if (core) {
    const source = await core.async("string");
    archive.file("docProps/core.xml", /<dc:language>[^<]*<\/dc:language>/.test(source)
      ? source.replace(/<dc:language>[^<]*<\/dc:language>/, "<dc:language>zh-CN</dc:language>")
      : source.replace("</cp:coreProperties>", "<dc:language>zh-CN</dc:language></cp:coreProperties>"));
  }
  await writeFile(path, await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export async function writePresentation(
  pages: PptxPage[],
  output: string,
  trustedRoot?: string,
): Promise<void> {
  if (!isAbsolute(output) || !output.endsWith(".pptx")) {
    throw new Error("PPTX output must be an absolute .pptx path");
  }
  const parent = dirname(output);
  const canonicalParent = await realpath(parent);
  if (trustedRoot) {
    const canonicalRoot = await realpath(trustedRoot);
    const difference = relative(canonicalRoot, canonicalParent);
    if (difference.startsWith("..") || isAbsolute(difference)) {
      throw new Error("PPTX output escaped the trusted root");
    }
  }
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("PPTX output parent must be a regular directory");
  }

  const temporary = await mkdtemp(join(canonicalParent, ".superppt-presentation-service-"));
  const staged = join(temporary, "deck.pptx");
  try {
    const Presentation = PptxGenJS as unknown as (typeof import("pptxgenjs"))["default"];
    const presentation = new Presentation();
    presentation.layout = "LAYOUT_WIDE";
    presentation.author = "SuperWagie PresentationService";
    presentation.company = "SuperWagie";
    presentation.subject = "SuperPPT owned presentation adapter";
    presentation.title = "SuperPPT Deck";
    presentation.theme = {
      headFontFace: "Microsoft YaHei",
      bodyFontFace: "Microsoft YaHei",
    };

    for (const [index, page] of pages.entries()) {
      const slide = presentation.addSlide();
      slide.background = { color: "FFFFFF" };
      if (page.mode !== "editable") {
        slide.addImage({
          data: dataUri(page.bytes, page.contentType),
          x: 0,
          y: 0,
          w: SLIDE_WIDTH_IN,
          h: SLIDE_HEIGHT_IN,
          objectName: `page-${page.id}`,
          altText: `SuperPPT page ${index + 1}`,
        });
        continue;
      }

      slide.addImage({
        data: dataUri(page.editable.cleanBackground, "image/png"),
        x: 0,
        y: 0,
        w: SLIDE_WIDTH_IN,
        h: SLIDE_HEIGHT_IN,
        objectName: `background-${page.id}`,
        altText: `Clean background for SuperPPT page ${index + 1}`,
      });
      for (const element of page.editable.elements) {
        if (element.kind === "text") {
          slide.addText(element.text, {
            ...box(element.bbox),
            rotate: element.rotation,
            fontFace: "Microsoft YaHei",
            fontSize: pxToPt(element.fontSizePx),
            charSpacing: element.charSpacingPx ?? 0,
            color: color(element.color),
            bold: element.bold ?? false,
            align: element.align,
            margin: 0,
            breakLine: false,
            fit: "shrink",
            lang: "zh-CN",
            objectName: `text-${element.id}`,
          });
        } else {
          slide.addImage({
            data: dataUri(element.bytes, "image/png"),
            ...box(element.bbox),
            objectName: `asset-${element.id}`,
            altText: element.label,
          });
        }
      }
    }

    await presentation.writeFile({ fileName: staged, compression: true });
    await normalizeOwnedOoxml(staged);
    await promoteExclusive(staged, output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
