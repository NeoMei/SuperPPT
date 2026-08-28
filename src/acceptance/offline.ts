import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import JSZip from "jszip";
import sharp from "sharp";

import type { LegacyResolvedDependencies } from "../dependencies/schemas.js";
import { assembleProject, replaceSlide, type FinalRender } from "../deck/assemble.js";
import { prepareEditableSlide } from "../deck/editable-slide.js";
import { buildMontage } from "../deck/montage.js";
import { exportPdf } from "../deck/pdf.js";
import { convertProjectPage } from "../editable/adapter.js";
import { applyProjectEditPlan } from "../editable/operations.js";
import { confirmEditablePreview, renderProjectEditablePreview } from "../editable/render.js";
import { generateProject } from "../generation/batch.js";
import { generateProjectStyleSample } from "../generation/style-sample.js";
import { approveGate } from "../planning/confirm.js";
import { normalizeInput } from "../planning/intake.js";
import { loadValidatedOutline, loadValidatedPlan } from "../planning/load.js";
import { BriefSchema, OutlineSchema, SlideSpecSchema } from "../planning/schemas.js";
import { publishOutlineViews, publishPlanViews, publishStyleSample } from "../planning/views.js";
import { initializeProject } from "../project/initialize.js";
import { readProject, sha256 } from "../project/store.js";

type AcceptanceSnapshot = {
  slideCount: number;
  slideOrder: string[];
  editableSlideIds: string[];
  renderHashes: Record<string, string>;
  acceptance: string;
  exports: { pptx: string; pdf: string; montage: string };
};

export type OfflineAcceptanceResult = {
  root: string;
  changedSlideId: string;
  before: AcceptanceSnapshot;
  after: AcceptanceSnapshot;
  editOperation: { kind: "replace-text"; elementId: string; before: string; after: string };
  providerCalls: { total: number; perSlide: number[] };
  logs: string[];
};

type OfflineAcceptanceOptions = {
  root: string;
  fixtures: string;
  provider: string;
  reviewer: string;
  editable: string;
};

type ProjectGenerationResult = Awaited<ReturnType<typeof generateProject>>;

const RUNNER = join(process.cwd(), "scripts", "run_ai_image_provider.py");
const EDITABLE_SLIDE_ID = "00000000-0000-4000-8000-000000000702";

function portable(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value.startsWith("..") || isAbsolute(value)) throw new Error("offline artifact escaped its project root");
  return value.split(sep).join("/");
}

function resolveFixture(path: string): string {
  return resolve(process.cwd(), path);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function offlineBuildOutputs(
  renders: FinalRender[],
  paths: { pptx: string; pdf: string; montage: string },
): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [index, render] of renders.entries()) {
    const slideNumber = index + 1;
    const slidePath = `ppt/slides/slide${slideNumber}.xml`;
    const relationshipsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const relationships: string[] = [];
    const objects: string[] = [];
    if (render.mode === "editable") {
      const prepared = await prepareEditableSlide(render);
      const backgroundId = "rIdBackground";
      const backgroundMedia = `ppt/media/slide${slideNumber}-background.png`;
      relationships.push(`<Relationship Id="${backgroundId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${backgroundMedia.split("/").at(-1)}"/>`);
      zip.file(backgroundMedia, prepared.cleanBackground);
      objects.push(`<p:pic><p:nvPicPr><p:cNvPr name="background-${xml(render.id)}"/></p:nvPicPr><p:blipFill><a:blip r:embed="${backgroundId}"/></p:blipFill></p:pic>`);
      for (const [elementIndex, element] of prepared.elements.entries()) {
        if (element.kind === "text") {
          objects.push(`<p:sp><p:nvSpPr><p:cNvPr name="text-${xml(element.id)}"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${xml(element.text)}</a:t></a:r></a:p></p:txBody></p:sp>`);
        } else {
          const relationshipId = `rIdAsset${elementIndex}`;
          const media = `ppt/media/slide${slideNumber}-asset${elementIndex}.png`;
          relationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${media.split("/").at(-1)}"/>`);
          zip.file(media, element.bytes);
          objects.push(`<p:pic><p:nvPicPr><p:cNvPr name="asset-${xml(element.id)}"/></p:nvPicPr><p:blipFill><a:blip r:embed="${relationshipId}"/></p:blipFill></p:pic>`);
        }
      }
    } else {
      const relationshipId = "rIdImage";
      const extension = render.contentType === "image/png" ? "png" : "jpg";
      const media = `ppt/media/slide${slideNumber}.${extension}`;
      relationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${media.split("/").at(-1)}"/>`);
      zip.file(media, render.bytes);
      objects.push(`<p:pic><p:nvPicPr><p:cNvPr name="page-${xml(render.id)}"/></p:nvPicPr><p:blipFill><a:blip r:embed="${relationshipId}"/></p:blipFill></p:pic>`);
    }
    zip.file(slidePath, `<p:sld>${objects.join("")}</p:sld>`);
    zip.file(relationshipsPath, `<Relationships>${relationships.join("")}</Relationships>`);
  }
  await writeFile(paths.pptx, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
  await exportPdf(renders, paths.pdf);
  await buildMontage(renders, paths.montage);
}

async function parseFixture<T>(path: string, parse: (value: unknown) => T): Promise<{ value: T; bytes: Buffer }> {
  const bytes = await readFile(path);
  return { value: parse(JSON.parse(bytes.toString("utf8"))), bytes };
}

async function copyPlanningFixtures(projectRoot: string, fixtures: string): Promise<void> {
  const brief = await parseFixture(join(fixtures, "brief.json"), (value) => BriefSchema.parse(value));
  const outline = await parseFixture(join(fixtures, "outline.json"), (value) => OutlineSchema.parse(value));
  await writeFile(join(projectRoot, "brief.json"), brief.bytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(projectRoot, "outline.json"), outline.bytes, { flag: "wx", mode: 0o600 });
  await publishOutlineViews(projectRoot);
  await approveGate(projectRoot, "outline");

  for (const slide of outline.value.slides) {
    const fixture = join(fixtures, "slides", slide.id, "spec.json");
    const parsed = await parseFixture(fixture, (value) => SlideSpecSchema.parse(value));
    if (parsed.value.slideId !== slide.id) throw new Error("offline fixture spec does not match its outline slide");
    const directory = join(projectRoot, "slides", slide.id);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "spec.json"), parsed.bytes, { flag: "wx", mode: 0o600 });
  }
  await loadValidatedOutline(projectRoot);
  await loadValidatedPlan(projectRoot);
  await publishPlanViews(projectRoot);
  await approveGate(projectRoot, "slide-specs");
}

async function stagedAiDependency(parent: string, provider: string, reviewer: string): Promise<LegacyResolvedDependencies["ai"]> {
  const root = join(parent, "offline-ai-image-to-ppt");
  await mkdir(join(root, "scripts"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "references"), { mode: 0o700 });
  await writeFile(join(root, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n", { flag: "wx", mode: 0o600 });
  await copyFile(provider, join(root, "scripts", "provider.py"));
  await copyFile(reviewer, join(root, "scripts", "reviewer.py"));
  const capabilities = {
    contractVersion: 1 as const,
    defaultProvider: "offline-fixture-provider",
    providers: [{
      id: "offline-fixture-provider",
      module: "scripts/provider.py",
      callable: "gen" as const,
      outputFormats: ["png" as const],
      supportsReferenceImages: false,
    }],
    reviewer: { module: "scripts/reviewer.py", callable: "check" as const },
  };
  await writeFile(join(root, "references", "capabilities.json"), `${JSON.stringify(capabilities, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { ...capabilities, root: await realpath(root), source: "manifest" };
}

async function stagedConverter(parent: string): Promise<string> {
  const root = join(parent, "offline-image-to-editable-pptx");
  await mkdir(join(root, "skills", "image-to-editable-pptx"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.1.0",
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n", { flag: "wx", mode: 0o600 });
  return realpath(root);
}

async function transparentPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

async function writeConverterFixture(outDir: string, sourcePng: string, fixture: string): Promise<void> {
  await mkdir(join(outDir, "assets"), { recursive: true, mode: 0o700 });
  const files: Record<string, Buffer> = {
    "ocr.json": Buffer.from('{"lines":[]}\n'),
    "vision.json": Buffer.from('{"elements":[]}\n'),
    "analysis-ledger.json": Buffer.from('{"analysis":"offline-fixture"}\n'),
    "manifest.json": await readFile(join(fixture, "manifest.json")),
    "removal-mask.png": await transparentPng(1280, 720),
    "clean-background.png": await readFile(join(fixture, "clean-background.png")),
    "assets/icon.png": await readFile(join(fixture, "assets", "icon.png")),
    "fixture-editable.pptx": Buffer.from("offline fixture pptx"),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(outDir, name)), { recursive: true, mode: 0o700 });
    await writeFile(join(outDir, name), bytes, { flag: "wx", mode: 0o600 });
  }
  const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  const output = (name: string): string => join(outDir, name);
  const ledger = {
    ledgerVersion: 2,
    mode: "replay",
    recorded: false,
    models: { ocr: "offline-fixture-ocr", vision: "offline-fixture-vision" },
    durationsMs: { ocr: 0, vision: 0, analyze: 0, plan: 0, repair: 0, export: 0, total: 0 },
    taskIds: {},
    warnings: [],
    decisions: [
      { candidateId: "title", kind: "text", decision: "accepted", bbox: { x: 120, y: 88, width: 680, height: 92 }, sourceElementIndexes: [0], repairMethod: "local_nearest_surface", extraction: "none", output: { state: "editable_layer", manifestElementId: "ocr-title" } },
      { candidateId: "icon", kind: "icon", decision: "accepted", bbox: { x: 920, y: 260, width: 120, height: 120 }, sourceElementIndexes: [1], repairMethod: "local_nearest_surface", extraction: "transparent", output: { state: "editable_layer", manifestElementId: "icon-1", assetPath: "assets/icon.png" } },
    ],
    hashes: {
      sourceImage: digest(await readFile(sourcePng)),
      ocr: digest(files["ocr.json"]!),
      vision: digest(files["vision.json"]!),
      analysisLedger: digest(files["analysis-ledger.json"]!),
      manifest: digest(files["manifest.json"]!),
      removalMask: digest(files["removal-mask.png"]!),
      cleanBackground: digest(files["clean-background.png"]!),
      assets: { "assets/icon.png": digest(files["assets/icon.png"]!) },
      pptx: digest(files["fixture-editable.pptx"]!),
    },
    outputs: {
      directory: outDir,
      ocr: output("ocr.json"),
      vision: output("vision.json"),
      analysisLedger: output("analysis-ledger.json"),
      manifest: output("manifest.json"),
      removalMask: output("removal-mask.png"),
      cleanBackground: output("clean-background.png"),
      assets: output("assets"),
      pptx: output("fixture-editable.pptx"),
    },
  };
  await writeFile(join(outDir, "run-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(join(outDir, ".image-to-editable-pptx-output.json"), `${JSON.stringify({ markerVersion: 1, appId: "image-to-editable-pptx", artifactKind: "published-output" }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function snapshot(root: string): Promise<AcceptanceSnapshot> {
  const manifest = await readProject(root);
  const slides = [...manifest.slides].sort((left, right) => left.order - right.order);
  if (!manifest.exports.pptx || !manifest.exports.pdf || !manifest.exports.montage || !manifest.exports.acceptance) {
    throw new Error("offline acceptance requires all four output artifacts");
  }
  const absolute = (path: string): string => join(root, ...path.split("/"));
  return {
    slideCount: slides.length,
    slideOrder: slides.map(({ id }) => id),
    editableSlideIds: slides.filter(({ status }) => status === "editable").map(({ id }) => id),
    renderHashes: Object.fromEntries(slides.map((slide) => {
      if (!slide.finalRender) throw new Error("offline acceptance slide has no final render");
      return [slide.id, slide.finalRender.sha256];
    })),
    acceptance: absolute(manifest.exports.acceptance.path),
    exports: {
      pptx: absolute(manifest.exports.pptx.path),
      pdf: absolute(manifest.exports.pdf.path),
      montage: absolute(manifest.exports.montage.path),
    },
  };
}

async function providerCalls(root: string, generation: ProjectGenerationResult, counter: string): Promise<{ total: number; perSlide: number[] }> {
  const total = (await readFile(counter, "utf8")).trim().split("\n").filter(Boolean).length;
  const perSlide = await Promise.all(generation.pages.map(async ({ id }) => {
    const entries = await readdir(join(root, "images", id));
    return entries.filter((name) => /^attempt-[1-3]$/.test(name)).length;
  }));
  return { total, perSlide };
}

export async function runOfflineAcceptance(options: OfflineAcceptanceOptions): Promise<OfflineAcceptanceResult> {
  const fixtureRoot = await realpath(resolveFixture(options.fixtures));
  const editableFixture = await realpath(resolveFixture(options.editable));
  const provider = await realpath(resolveFixture(options.provider));
  const reviewer = await realpath(resolveFixture(options.reviewer));
  const requestedRoot = resolve(options.root);
  await mkdir(dirname(requestedRoot), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(requestedRoot));
  const projectRoot = join(parent, basename(requestedRoot));
  await initializeProject({ root: projectRoot, title: "AI Agent 协作系统" });
  const root = await realpath(projectRoot);
  await normalizeInput(root, { kind: "markdown", path: join(fixtureRoot, "source.md") });
  await copyPlanningFixtures(root, fixtureRoot);

  const ai = await stagedAiDependency(parent, provider, reviewer);
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
    schemaVersion: 1,
    styleId: "cinematic-tech",
    representativeSlideId: EDITABLE_SLIDE_ID,
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const counter = join(parent, "offline-provider-calls.log");
  await writeFile(counter, "", { flag: "wx", mode: 0o600 });
  const previousCounter = process.env.SUPERPPT_TEST_CALL_COUNTER;
  process.env.SUPERPPT_TEST_CALL_COUNTER = counter;
  let generation: ProjectGenerationResult;
  try {
    await generateProjectStyleSample({ root, ai, runner: RUNNER });
    await publishStyleSample(root);
    await approveGate(root, "style-sample");
    generation = await generateProject({ root, ai, runner: RUNNER, concurrency: 2 });
  } finally {
    if (previousCounter === undefined) delete process.env.SUPERPPT_TEST_CALL_COUNTER;
    else process.env.SUPERPPT_TEST_CALL_COUNTER = previousCounter;
  }
  if (generation.pages.some(({ status }) => status !== "ready")) throw new Error("offline fixture generation did not pass QA");

  await assembleProject({ root, operations: { buildOutputs: offlineBuildOutputs } });
  const before = await snapshot(root);
  const converterRoot = await stagedConverter(parent);
  const conversion = await convertProjectPage({
    root,
    slideId: EDITABLE_SLIDE_ID,
    converterRoot,
    execute: async (_command, args) => {
      const source = args[args.indexOf("--image") + 1];
      const outDir = args[args.indexOf("--out") + 1];
      if (!source || !outDir) throw new Error("offline converter invocation is missing canonical paths");
      await writeConverterFixture(outDir, source, editableFixture);
      return { stdout: "", stderr: "" };
    },
  });
  const sourceElement = conversion.manifest.elements.find((element) => element.id === "ocr-title");
  if (!sourceElement || sourceElement.kind !== "text") throw new Error("offline editable fixture has no text target");
  const changedText = "闭环协作，持续交付";
  const edit = await applyProjectEditPlan({
    root,
    slideId: EDITABLE_SLIDE_ID,
    sourceRevisionId: conversion.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: sourceElement.id, text: changedText }] },
  });
  const recordSha256 = sha256(await readFile(join(edit.revisionRoot, "modified-revision-record.json")));
  const preview = await renderProjectEditablePreview({
    root,
    slideId: EDITABLE_SLIDE_ID,
    modifiedRevisionId: edit.revisionId,
    expectedModifiedRevisionRecordSha256: recordSha256,
  });
  await confirmEditablePreview({
    root,
    slideId: EDITABLE_SLIDE_ID,
    modifiedRevisionId: edit.revisionId,
    expectedModifiedRevisionRecordSha256: recordSha256,
    preview: join(root, ...preview.preview.path.split("/")),
  });
  await replaceSlide({
    root,
    slideId: EDITABLE_SLIDE_ID,
    modifiedRevisionId: edit.revisionId,
    expectedModifiedRevisionRecordSha256: recordSha256,
    warnings: ["offline acceptance only; live provider and client acceptance remain pending"],
    operations: { buildOutputs: offlineBuildOutputs },
  });
  const after = await snapshot(root);
  const calls = await providerCalls(root, generation, counter);
  const logs = [
    `provider=${generation.providerId}`,
    `generated-pages=${generation.pageCount}`,
    `provider-calls=${calls.total}`,
    `project=${portable(parent, root)}`,
  ];
  return {
    root,
    changedSlideId: EDITABLE_SLIDE_ID,
    before,
    after,
    editOperation: { kind: "replace-text", elementId: sourceElement.id, before: sourceElement.text, after: changedText },
    providerCalls: calls,
    logs,
  };
}
