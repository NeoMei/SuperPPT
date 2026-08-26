import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import { promoteExclusive } from "../project/promotion.js";
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
  const bytes = await fs.readFile(page.path);
  const slide = presentation.slides.add();
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
const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(outputPath);
`;

export type PptxPage = {
  id: string;
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
};

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
      const path = join(inputs, `page-${String(index + 1).padStart(4, "0")}.${page.contentType === "image/png" ? "png" : "jpg"}`);
      await writeFile(path, page.bytes, { mode: 0o600 });
      specs.push({
        path,
        contentType: page.contentType,
        objectName: `page-${page.id}`,
        alt: `SuperPPT page ${index + 1}`,
      });
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
        PATH: `${runtime.binDir}:${process.env.PATH ?? ""}`,
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    await readFile(staged);
    await promoteExclusive(staged, output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
