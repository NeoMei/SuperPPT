import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import { promoteExclusive } from "../project/exclusive.js";
import type { PreparedEditableSlide } from "./editable-slide.js";
import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from "./geometry.js";

const execFileAsync = promisify(execFile);

type ArtifactRuntime = {
  node: string;
  nodeModules: string;
  binDir: string;
};

function requiredRuntimePath(name: "RUNTIME_NODE" | "RUNTIME_NODE_MODULES" | "RUNTIME_BIN_DIR"): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} is required and must be absolute`);
  return value;
}

function artifactRuntime(): ArtifactRuntime {
  return {
    node: requiredRuntimePath("RUNTIME_NODE"),
    nodeModules: requiredRuntimePath("RUNTIME_NODE_MODULES"),
    binDir: requiredRuntimePath("RUNTIME_BIN_DIR"),
  };
}

const BUILDER = `
import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const [specPath, outputPath] = process.argv.slice(2);
const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const presentation = Presentation.create({ slideSize: { width: ${SLIDE_WIDTH_PX}, height: ${SLIDE_HEIGHT_PX} } });
for (const page of spec.pages) {
  const slide = presentation.slides.add();
  if (page.mode === "editable") {
    const backgroundBytes = await fs.readFile(page.cleanBackground);
    const background = slide.images.add({
      name: page.backgroundObjectName,
      blob: backgroundBytes.buffer.slice(backgroundBytes.byteOffset, backgroundBytes.byteOffset + backgroundBytes.byteLength),
      contentType: "image/png",
      alt: page.backgroundAlt,
      fit: "cover",
      position: { left: 0, top: 0, width: ${SLIDE_WIDTH_PX}, height: ${SLIDE_HEIGHT_PX} },
    });
    background.name = page.backgroundObjectName;
    for (const element of page.elements) {
      if (element.kind === "text") {
        const shape = slide.shapes.add({
          geometry: "textbox",
          name: element.objectName,
          position: { ...element.bbox, rotation: element.rotation },
          fill: "none",
          line: { style: "solid", fill: "none", width: 0 },
        });
        shape.name = element.objectName;
        shape.text = element.text;
        shape.text.style = {
          fontFamily: "Microsoft YaHei",
          fontSize: element.fontSizePx,
          color: element.color,
          bold: element.bold,
          alignment: element.align,
          characterSpacing: element.charSpacingPx,
        };
      } else {
        const bytes = await fs.readFile(element.path);
        const image = slide.images.add({
          name: element.objectName,
          blob: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          contentType: "image/png",
          alt: element.alt,
          fit: "cover",
          position: element.bbox,
        });
        image.name = element.objectName;
      }
    }
  } else {
    const bytes = await fs.readFile(page.path);
    const image = slide.images.add({
      name: page.objectName,
      blob: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      contentType: page.contentType,
      alt: page.alt,
      fit: "cover",
      position: { left: 0, top: 0, width: ${SLIDE_WIDTH_PX}, height: ${SLIDE_HEIGHT_PX} },
    });
    image.name = page.objectName;
  }
}
const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(outputPath);
`;

type PptxPageBase = {
  id: string;
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
};

export type PptxImagePage = PptxPageBase & { mode?: "image" };

export type PptxEditablePage = PptxPageBase & {
  mode: "editable";
  editable: PreparedEditableSlide;
};

export type PptxPage = PptxImagePage | PptxEditablePage;

export async function createPresentation(
  pages: PptxPage[],
  output: string,
  trustedRoot?: string,
): Promise<void> {
  const runtime = artifactRuntime();
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
  const temporary = await mkdtemp(join(canonicalParent, ".superppt-artifact-tool-"));
  try {
    await symlink(runtime.nodeModules, join(temporary, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const inputs = join(temporary, "inputs");
    await mkdir(inputs, { mode: 0o700 });
    const specs = [];
    for (const [index, page] of pages.entries()) {
      if (page.mode === "editable") {
        const cleanBackground = join(inputs, `page-${String(index + 1).padStart(4, "0")}-background.png`);
        await writeFile(cleanBackground, page.editable.cleanBackground, { mode: 0o600 });
        const elements = [];
        for (const [elementIndex, element] of page.editable.elements.entries()) {
          if (element.kind === "text") {
            elements.push({
              kind: "text",
              objectName: `text-${element.id}`,
              text: element.text,
              bbox: { left: element.bbox.x, top: element.bbox.y, width: element.bbox.width, height: element.bbox.height },
              rotation: element.rotation,
              color: element.color.startsWith("#") ? element.color : `#${element.color}`,
              fontSizePx: element.fontSizePx,
              charSpacingPx: element.charSpacingPx ?? 0,
              bold: element.bold ?? false,
              align: element.align,
            });
          } else {
            const path = join(inputs, `page-${String(index + 1).padStart(4, "0")}-asset-${String(elementIndex).padStart(4, "0")}.png`);
            await writeFile(path, element.bytes, { mode: 0o600 });
            elements.push({
              kind: "asset",
              path,
              objectName: `asset-${element.id}`,
              alt: element.label,
              bbox: { left: element.bbox.x, top: element.bbox.y, width: element.bbox.width, height: element.bbox.height },
            });
          }
        }
        specs.push({
          mode: "editable",
          cleanBackground,
          backgroundObjectName: `background-${page.id}`,
          backgroundAlt: `Clean background for SuperPPT page ${index + 1}`,
          elements,
        });
      } else {
        const path = join(inputs, `page-${String(index + 1).padStart(4, "0")}.${page.contentType === "image/png" ? "png" : "jpg"}`);
        await writeFile(path, page.bytes, { mode: 0o600 });
        specs.push({
          mode: "image",
          path,
          contentType: page.contentType,
          objectName: `page-${page.id}`,
          alt: `SuperPPT page ${index + 1}`,
        });
      }
    }
    const builder = join(temporary, "build.mjs");
    const spec = join(temporary, "deck-spec.json");
    const staged = join(temporary, "deck.pptx");
    await writeFile(builder, BUILDER, { mode: 0o600 });
    await writeFile(spec, `${JSON.stringify({ pages: specs })}\n`, { mode: 0o600 });
    await execFileAsync(runtime.node, [builder, spec, staged], {
      env: {
        ...process.env,
        RUNTIME_NODE: runtime.node,
        RUNTIME_NODE_MODULES: runtime.nodeModules,
        RUNTIME_BIN_DIR: runtime.binDir,
        PATH: [runtime.binDir, process.env.PATH].filter(Boolean).join(delimiter),
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    await readFile(staged);
    await promoteExclusive(staged, output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
