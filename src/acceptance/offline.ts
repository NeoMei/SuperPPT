import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import JSZip from "jszip";
import sharp from "sharp";

import { applyEditableReplacement, assembleProjectCandidate, type FinalRender } from "../deck/assemble.js";
import { prepareEditableSlide } from "../deck/editable-slide.js";
import { buildMontage } from "../deck/montage.js";
import { exportPdf } from "../deck/pdf.js";
import { convertProjectPage } from "../editable/adapter.js";
import { applyProjectEditPlan } from "../editable/operations.js";
import { confirmEditablePreview, renderProjectEditablePreview } from "../editable/render.js";
import { prepareDeckJob } from "../generation/batch.js";
import {
  admitDelegatedGenerationCall,
  publishGenerationAuthorizationPlan,
  publishStyleSampleGenerationPlan,
  readCallLedger,
} from "../generation/authorization.js";
import { recordDelegatedResult } from "../generation/delegation-result.js";
import { finalizeStyleSample, prepareStyleSampleJob } from "../generation/style-sample.js";
import { configureGenerationAuthorizationTrustForTests } from "../generation/trusted-authorization.js";
import { approveExecutionGate, approveGate } from "../planning/confirm.js";
import { normalizeInput } from "../planning/intake.js";
import { loadValidatedOutline, loadValidatedPlan } from "../planning/load.js";
import { BriefSchema, OutlineSchema, SlideSpecSchema } from "../planning/schemas.js";
import { publishOutlineViews, publishPlanViews, publishStyleSample } from "../planning/views.js";
import { initializeProject } from "../project/initialize.js";
import { applyDeckReviewAction, publishDeckReview } from "../project/promotion.js";
import { readProject, sha256 } from "../project/store.js";
import { resolveAiImageSkillDependency } from "../dependencies/resolve.js";
import type { ResolvedDependencies } from "../dependencies/schemas.js";
import { approveStyleLock, createProvisionalStyleLock } from "../styles/style-lock.js";

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
  deckReview: { action: "confirm-delivery"; promotedRevision: number };
};

type OfflineAcceptanceOptions = {
  root: string;
  fixtures: string;
  editable: string;
};

type ProjectGenerationResult = {
  jobId: string;
  providerId: "api-openai";
  pageCount: number;
  callCount: number;
  pages: Array<{ id: string; status: "ready" }>;
};
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

async function stagedAiDependency(parent: string): Promise<string> {
  const root = join(parent, "offline-ai-image-to-ppt");
  await mkdir(join(root, "scripts"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n", { flag: "wx", mode: 0o600 });
  for (const script of ["generation_result.py", "host_routing_policy.py", "import_host_image.py", "prepare_editable_input.py"]) {
    await writeFile(join(root, "scripts", script), "raise SystemExit('not executed by offline delegated sample')\n", { flag: "wx", mode: 0o600 });
  }
  return realpath(root);
}

async function stagedConverter(parent: string): Promise<string> {
  const root = join(parent, "offline-image-to-editable-pptx");
  await mkdir(join(root, "skills", "image-to-editable-pptx"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.2.0",
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n", { flag: "wx", mode: 0o600 });
  return realpath(root);
}

async function transparentPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const DOCUMENT_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";

async function offlineOfficialDonor(background: Buffer, icon: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/></Types>`);
  zip.file("_rels/.rels", `<pkg:Relationships xmlns:pkg="${PACKAGE_RELATIONSHIPS}"><pkg:Relationship Id="rId1" Type="${DOCUMENT_RELATIONSHIPS}/officeDocument" Target="ppt/presentation.xml"/></pkg:Relationships>`);
  zip.file("ppt/presentation.xml", `<slide:presentation xmlns:slide="${PRESENTATION}" xmlns:rel="${DOCUMENT_RELATIONSHIPS}"><slide:sldIdLst><slide:sldId id="256" rel:id="rId1"/></slide:sldIdLst><slide:sldSz cx="12192000" cy="6858000"/></slide:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<pkg:Relationships xmlns:pkg="${PACKAGE_RELATIONSHIPS}"><pkg:Relationship Id="rId1" Type="${DOCUMENT_RELATIONSHIPS}/slide" Target="slides/slide1.xml"/></pkg:Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<slide:sld xmlns:slide="${PRESENTATION}" xmlns:art="${DRAWING}" xmlns:rel="${DOCUMENT_RELATIONSHIPS}"><slide:cSld><slide:spTree><slide:nvGrpSpPr><slide:cNvPr id="1" name="Group 1"/></slide:nvGrpSpPr><slide:grpSpPr/><slide:pic><slide:nvPicPr><slide:cNvPr id="2" name="asset-background"/></slide:nvPicPr><slide:blipFill><art:blip rel:embed="rId2"/></slide:blipFill></slide:pic><slide:sp><slide:nvSpPr><slide:cNvPr id="3" name="text-ocr-title"/></slide:nvSpPr><slide:txBody><art:p><art:r><art:t>Original title</art:t></art:r></art:p></slide:txBody></slide:sp><slide:pic><slide:nvPicPr><slide:cNvPr id="4" name="asset-icon-1"/></slide:nvPicPr><slide:blipFill><art:blip rel:embed="rId3"/></slide:blipFill></slide:pic></slide:spTree></slide:cSld></slide:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<pkg:Relationships xmlns:pkg="${PACKAGE_RELATIONSHIPS}"><pkg:Relationship Id="rId1" Type="${DOCUMENT_RELATIONSHIPS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><pkg:Relationship Id="rId2" Type="${DOCUMENT_RELATIONSHIPS}/image" Target="../media/background.png"/><pkg:Relationship Id="rId3" Type="${DOCUMENT_RELATIONSHIPS}/image" Target="../media/icon.png"/></pkg:Relationships>`);
  zip.file("ppt/slideLayouts/slideLayout1.xml", `<slide:sldLayout xmlns:slide="${PRESENTATION}"/>`);
  zip.file("ppt/media/background.png", background);
  zip.file("ppt/media/icon.png", icon);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function offlineDependencies(aiRoot: string, editableRoot: string): Promise<ResolvedDependencies> {
  const ai = await resolveAiImageSkillDependency(aiRoot);
  const packageFile = join(editableRoot, "package.json");
  const skillFile = join(editableRoot, "skills", "image-to-editable-pptx", "SKILL.md");
  const packageSha256 = sha256(await readFile(packageFile));
  const skillSha256 = sha256(await readFile(skillFile));
  return {
    ai,
    editable: {
      kind: "image-to-editable-pptx",
      root: editableRoot,
      packageFile,
      packageSha256,
      skillFile,
      skillSha256,
      version: "0.2.0",
    },
    integrity: {
      aiSkillSha256: ai.skillSha256,
      aiScripts: ai.scriptSha256,
      editablePackageSha256: packageSha256,
      editableSkillSha256: skillSha256,
    },
  };
}

async function writeConverterFixture(outDir: string, sourcePng: string, fixture: string): Promise<void> {
  await mkdir(join(outDir, "assets"), { recursive: true, mode: 0o700 });
  const legacyManifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const icon = await readFile(join(fixture, "assets", "icon.png"));
  const iconSha256 = sha256(icon);
  const manifest = {
    ...legacyManifest,
    manifestVersion: 2,
    elements: legacyManifest.elements.map((element: Record<string, unknown>) => element.kind === "asset" ? {
      ...element,
      role: "foreground-object",
      groupId: "offline-icon",
      provenance: {
        kind: "source-visible",
        sourceCropSha256: iconSha256,
        visibleMaskSha256: "1".repeat(64),
        assetSha256: iconSha256,
      },
      relations: [{ id: "icon-behind-title", kind: "behind", from: "icon-1", to: "ocr-title", confidence: 0.99 }],
      reviewRequired: true,
    } : element),
  };
  const files: Record<string, Buffer> = {
    "ocr.json": Buffer.from('{"lines":[]}\n'),
    "vision.json": Buffer.from('{"elements":[]}\n'),
    "analysis-ledger.json": Buffer.from('{"analysis":"offline-fixture"}\n'),
    "manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    "removal-mask.png": await transparentPng(1280, 720),
    "clean-background.png": await readFile(join(fixture, "clean-background.png")),
    "recomposition-preview.png": await readFile(join(fixture, "clean-background.png")),
    "layer-review.png": await readFile(join(fixture, "clean-background.png")),
    "exploded-preview.png": await readFile(join(fixture, "clean-background.png")),
    "assets/icon.png": icon,
    "slide-editable.pptx": await offlineOfficialDonor(await readFile(join(fixture, "clean-background.png")), icon),
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
      pptx: digest(files["slide-editable.pptx"]!),
      qaPreviews: { recomposition: digest(files["recomposition-preview.png"]!), layerReview: digest(files["layer-review.png"]!), exploded: digest(files["exploded-preview.png"]!) },
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
      pptx: output("slide-editable.pptx"),
      qaPreviews: { recomposition: output("recomposition-preview.png"), layerReview: output("layer-review.png"), exploded: output("exploded-preview.png") },
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

async function delegatedCalls(root: string, generation: ProjectGenerationResult): Promise<{ total: number; perSlide: number[] }> {
  const ledger = await readCallLedger(root);
  const admissions = ledger.filter((entry) => entry.entryKind === "admission" && entry.jobId === generation.jobId);
  const perSlide = generation.pages.map(({ id }) => admissions.filter((entry) => entry.slideId === id).length);
  return { total: generation.callCount + 1, perSlide };
}

async function normalizedSha256(path: string): Promise<string> {
  return sha256(await sharp(await readFile(path), { failOn: "error" })
    .resize(1920, 1080, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer());
}

async function materializeDelegatedPage(
  root: string,
  job: Awaited<ReturnType<typeof prepareDeckJob>>,
  pageIndex: number,
  styleSample: boolean,
): Promise<void> {
  const page = job.pages[pageIndex]!;
  const output = join(root, ...page.target.split("/"));
  await sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 3,
      background: pageIndex % 2 === 0 ? "#142536" : "#2b4058",
    },
  }).png().toFile(output);
  const requestOrdinal = pageIndex + 1;
  const admission = await admitDelegatedGenerationCall(root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal,
  });
  const routingPages = job.pages.slice(0, pageIndex + 1).map((_candidate, index) => ({
    page: index + 1,
    outcome: "success" as const,
    candidate: "api-openai" as const,
    summary: "",
  }));
  await recordDelegatedResult(root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal,
    admissionToken: admission.admissionToken,
    dependency: { status: "success", provider: "openai", channel: "api", output_path: output, safe_message: "" },
    batchReport: {
      batch_mode: "serial-sticky-monotonic",
      stopped: false,
      search_candidate: "api-openai",
      sticky_candidate: "api-openai",
      pages: routingPages,
      switches: [],
    },
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: [],
    presentationQa: styleSample ? null : {
      approvedSampleSha256: job.styleLock.approvedSample!.sha256,
      normalizedImageSha256: await normalizedSha256(output),
      slideSpecSha256: page.specSnapshot.sha256,
      pageRole: page.spec.role,
      decision: {
        ok: true,
        issues: [],
        requiredText: page.spec.requiredText.map((text) => ({ text, present: true, exact: true })),
        styleConsistent: true,
        hierarchyClear: true,
        richDetail: true,
        noForbiddenContent: true,
      },
    },
  });
}

export async function runOfflineAcceptance(options: OfflineAcceptanceOptions): Promise<OfflineAcceptanceResult> {
  const fixtureRoot = await realpath(resolveFixture(options.fixtures));
  const editableFixture = await realpath(resolveFixture(options.editable));
  const requestedRoot = resolve(options.root);
  await mkdir(dirname(requestedRoot), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(requestedRoot));
  const projectRoot = join(parent, basename(requestedRoot));
  await initializeProject({ root: projectRoot, title: "AI Agent 协作系统" });
  const root = await realpath(projectRoot);
  await normalizeInput(root, { kind: "markdown", path: join(fixtureRoot, "source.md") });
  await copyPlanningFixtures(root, fixtureRoot);

  const aiRoot = await stagedAiDependency(parent);
  const converterRoot = await stagedConverter(parent);
  const dependencies = await offlineDependencies(aiRoot, converterRoot);
  const aiDependency = dependencies.ai;
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
    schemaVersion: 1,
    styleId: "cinematic-tech",
    representativeSlideId: EDITABLE_SLIDE_ID,
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  let generation: ProjectGenerationResult;
  await createProvisionalStyleLock(root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [],
  });
  await configureGenerationAuthorizationTrustForTests(root, {
    root: join(parent, "authorization-trust"),
    deterministicKeySeed: `superppt-offline-acceptance:${root}`,
  });
  await publishStyleSampleGenerationPlan(root, { aiDependency, callBudget: 1 });
  await approveExecutionGate(root, "style-sample-generation", "style/sample/generation-plan.json");
  const sampleJob = await prepareStyleSampleJob(root, aiDependency);
  await materializeDelegatedPage(root, sampleJob, 0, true);
  await finalizeStyleSample(root, sampleJob.jobId);
  await publishStyleSample(root);
  await approveGate(root, "style-sample");
  await approveStyleLock(root);
  await publishGenerationAuthorizationPlan(root, {
    aiDependency,
    callBudget: 3,
  });
  await approveGate(root, "generation-authorization");
  const deckJob = await prepareDeckJob(root, aiDependency);
  for (let index = 0; index < deckJob.pages.length; index += 1) {
    await materializeDelegatedPage(root, deckJob, index, false);
  }
  generation = {
    jobId: deckJob.jobId,
    providerId: "api-openai",
    pageCount: deckJob.pages.length,
    callCount: deckJob.pages.length,
    pages: deckJob.pages.map(({ slideId }) => ({ id: slideId, status: "ready" })),
  };

  const candidate = await assembleProjectCandidate(root, { buildOutputs: offlineBuildOutputs });
  const review = await publishDeckReview(root, candidate.candidateId);
  const deckReviewAction = await applyDeckReviewAction(root, {
    action: "confirm-delivery",
    candidateId: candidate.candidateId,
    descriptorSha256: review.descriptorSha256,
  });
  if (deckReviewAction.action !== "confirm-delivery" || !deckReviewAction.delivery) {
    throw new Error("offline acceptance deck review did not promote the confirmed candidate");
  }
  const before = await snapshot(root);
  const editableCandidate = await assembleProjectCandidate(root, { buildOutputs: offlineBuildOutputs });
  const editableReview = await publishDeckReview(root, editableCandidate.candidateId);
  await applyDeckReviewAction(root, {
    action: "edit-page",
    slideId: EDITABLE_SLIDE_ID,
    candidateId: editableCandidate.candidateId,
    descriptorSha256: editableReview.descriptorSha256,
  });
  const conversion = await convertProjectPage({
    root,
    slideId: EDITABLE_SLIDE_ID,
    converterRoot,
    dependencies,
    prepareExecute: async (_command, args) => {
      const source = args[1];
      const target = args[2];
      if (!source || !target) throw new Error("offline preparation invocation is missing canonical paths");
      await sharp(await readFile(source)).resize(1280, 720).png().toFile(target);
      return { stdout: `  OK: ${target} (1280x720 PNG, editable-converter input)\n`, stderr: "" };
    },
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
  await applyEditableReplacement({
    root,
    slideId: EDITABLE_SLIDE_ID,
    modifiedRevisionId: edit.revisionId,
    expectedModifiedRevisionRecordSha256: recordSha256,
  });
  const replacementCandidate = await assembleProjectCandidate(root, { buildOutputs: offlineBuildOutputs });
  const replacementReview = await publishDeckReview(root, replacementCandidate.candidateId);
  const replacementAction = await applyDeckReviewAction(root, {
    action: "confirm-delivery",
    candidateId: replacementCandidate.candidateId,
    descriptorSha256: replacementReview.descriptorSha256,
  });
  if (replacementAction.action !== "confirm-delivery" || !replacementAction.delivery) {
    throw new Error("offline editable replacement was not confirmed for delivery");
  }
  const after = await snapshot(root);
  const calls = await delegatedCalls(root, generation);
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
    deckReview: {
      action: replacementAction.action,
      promotedRevision: replacementAction.delivery.revisionNumber,
    },
  };
}
