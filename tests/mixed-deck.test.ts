import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import {
  assembleProjectCandidate,
  type FinalRender,
} from "../src/deck/assemble.js";
import { convertProjectPage } from "../src/editable/adapter.js";
import { resolveSkillDependencies } from "../src/dependencies/resolve.js";
import { attestWorkflowDependencies } from "../src/dependencies/preflight.js";
import type { ResolvedDependencies } from "../src/dependencies/schemas.js";
import { configureGenerationAuthorizationTrustForTests } from "../src/generation/trusted-authorization.js";
import { applyProjectEditPlan, promoteProjectEditableTarget } from "../src/editable/operations.js";
import { approveGate } from "../src/planning/confirm.js";
import { publishPlanViews } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { applyDeckReviewAction, publishDeckReview } from "../src/project/promotion.js";
import { readProject, sha256, updateProject } from "../src/project/store.js";
import { finalizeDelegatedStyleSampleForTest } from "./helpers/delegated-style-sample.js";

const fixtureRoot = resolve("tests/fixtures/editable");
const slideIds = [
  "00000000-0000-4000-8000-000000000921",
  "00000000-0000-4000-8000-000000000922",
  "00000000-0000-4000-8000-000000000923",
] as const;

async function temporary(t: TestContext, prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeInitialOutputs(
  renders: FinalRender[],
  paths: { pptx: string },
): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [index, render] of renders.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld><p:pic><p:cNvPr name=\"page-${render.id}\"/><a:blip r:embed=\"rIdImage\"/></p:pic></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships><Relationship Id=\"rIdImage\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/image${index + 1}.png\"/></Relationships>`);
    zip.file(`ppt/media/image${index + 1}.png`, render.bytes);
  }
  await writeFile(paths.pptx, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
}

async function outputDirectorySnapshot(path: string): Promise<{
  nodes: Record<string, {
    type: "directory" | "file" | "symlink" | "other";
    dev: number;
    ino: number;
    bytes?: string;
    target?: string;
  }>;
}> {
  const nodes: Record<string, {
    type: "directory" | "file" | "symlink" | "other";
    dev: number;
    ino: number;
    bytes?: string;
    target?: string;
  }> = {};
  const walk = async (current: string, relativePath: string): Promise<void> => {
    const info = await lstat(current);
    const type = info.isDirectory() ? "directory"
      : info.isFile() ? "file"
        : info.isSymbolicLink() ? "symlink"
          : "other";
    nodes[relativePath || "."] = {
      type,
      dev: info.dev,
      ino: info.ino,
      ...(type === "file" ? { bytes: (await readFile(current)).toString("base64") } : {}),
      ...(type === "symlink" ? { target: await readlink(current) } : {}),
    };
    if (type === "directory") {
      for (const entry of (await readdir(current)).sort()) {
        await walk(join(current, entry), relativePath ? `${relativePath}/${entry}` : entry);
      }
    }
  };
  await walk(path, "");
  return { nodes };
}

async function tamperEditableBackground(pptx: string, slideNumber = 2): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(pptx));
  const relationships = await zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)!.async("text");
  const image = [...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].find((match) => /\/image(["'])/.test(match[1]!));
  assert.ok(image, "editable slide must have an image relationship");
  const target = /\bTarget=(["'])(.*?)\1/.exec(image[1]!)?.[2];
  assert.ok(target);
  const mediaPath = target.startsWith("/")
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join("ppt/slides", target));
  zip.file(mediaPath, Buffer.from("tampered editable background"));
  await writeFile(pptx, await zip.generateAsync({ type: "nodebuffer" }));
}

async function splitEscapedEditableTextRuns(pptx: string, slideNumber = 2): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(pptx));
  const path = `ppt/slides/slide${slideNumber}.xml`;
  const xml = await zip.file(path)!.async("text");
  const escaped = "A &amp; B &lt;示例&gt;";
  const split = 'A &amp; </a:t></a:r><a:r><a:rPr lang="zh-CN"/><a:t>B &lt;示例&gt;';
  const rewritten = xml.replace(escaped, split);
  assert.notEqual(rewritten, xml, "editable text must be split across XML runs");
  zip.file(path, rewritten);
  await writeFile(pptx, await zip.generateAsync({ type: "nodebuffer" }));
}

async function reviewedProject(
  t: TestContext,
  action: "confirm-delivery" | "edit-page",
): Promise<{ root: string; candidateId: string; reviewDescriptorSha256: string }> {
  const root = join(await temporary(t, "superppt-mixed-project-"), "project");
  await initializeProject({ root, title: "Mixed deck" });
  await writeFile(join(root, "brief.json"), `${JSON.stringify({
    schemaVersion: 1,
    title: "Mixed deck",
    purpose: "Verify editable replacement",
    audience: "Testers",
    language: "zh-CN",
    targetSlides: 3,
    mustCover: ["第一页", "第二页", "第三页"],
    constraints: ["16:9"],
  })}\n`);
  const outline = {
    schemaVersion: 1,
    slides: slideIds.map((id, order) => ({
      id,
      order,
      title: order === 0 ? "第一页" : order === 1 ? "第二页" : "第三页",
      role: order === 0 ? "cover" : order === 2 ? "summary" : "content",
      purpose: order === 0 ? "开场" : order === 2 ? "总结" : "说明",
      sourceRefs: [`L${order + 1}`],
    })),
  };
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline)}\n`);
  for (const slide of outline.slides) {
    const directory = join(root, "slides", slide.id);
    await mkdir(directory);
    await writeFile(join(directory, "spec.json"), `${JSON.stringify({
      schemaVersion: 1,
      slideId: slide.id,
      title: slide.title,
      role: slide.role,
      coreMessage: slide.purpose,
      requiredText: [slide.title],
      visualSubject: "中心主体",
      composition: "全幅",
      relationships: [],
      forbidden: ["watermark"],
      sourceRefs: slide.sourceRefs,
    })}\n`);
  }
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
    schemaVersion: 1,
    styleId: "cinematic-tech",
    representativeSlideId: slideIds[1],
  })}\n`);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await finalizeDelegatedStyleSampleForTest(root);

  const manifest = await readProject(root);
  const images = await Promise.all(slideIds.map(async (id, order) => {
    const attempt = join(root, "images", id, "attempt-1");
    await mkdir(attempt, { recursive: true });
    const bytes = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: order === 0 ? "#a02916" : "#1645a0" } }).png().toBuffer();
    await writeFile(join(attempt, "raw.png"), Buffer.concat([bytes, Buffer.from(`raw-${order}`)]));
    await writeFile(join(attempt, "master.png"), Buffer.concat([bytes, Buffer.from(`master-${order}`)]));
    await writeFile(join(attempt, "normalized.png"), bytes);
    await writeFile(join(attempt, "slide.png"), bytes);
    const digest = sha256(bytes);
    await writeFile(join(attempt, "ledger.json"), `${JSON.stringify({
      ledgerVersion: 1,
      slideId: id,
      revisionId: manifest.currentRevision.id,
      attempt: 1,
      providerId: "mixed-provider",
      promptSha256: "a".repeat(64),
      promptPurged: true,
      output: `images/${id}/attempt-1/slide.png`,
      outputSha256: digest,
      outputBytes: bytes.length,
      durationMs: 1,
      quality: {
        ok: true,
        issueCount: 0,
        issueHashes: [],
        issueCodes: [],
        requiredText: [{ textSha256: sha256(Buffer.from(outline.slides[order]!.title)), present: true, exact: true }],
        styleConsistent: true,
        hierarchyClear: true,
        richDetail: true,
        noForbiddenContent: true,
      },
      outcome: "accepted",
      errorCode: null,
    }, null, 2)}\n`);
    return digest;
  }));
  await updateProject(root, (current) => ({
    ...current,
    stage: "generating",
    slides: slideIds.map((id, order) => ({
      id,
      order,
      title: outline.slides[order]!.title,
      role: outline.slides[order]!.role as "cover" | "content" | "summary",
      specRevisionId: current.currentRevision.id,
      promptRevisionId: current.currentRevision.id,
      styleRevisionId: current.currentRevision.id,
      status: "ready" as const,
      image: { path: `images/${id}/attempt-1/slide.png`, sha256: images[order]!, revisionId: current.currentRevision.id },
      editable: null,
      finalRender: null,
      staleReasons: [],
    })),
  }));
  await configureGenerationAuthorizationTrustForTests(root, {
    root: join(root, "..", "authorization-trust"),
    deterministicKeySeed: `superppt-mixed-test:${root}`,
  });
  await mkdir(join(root, "generation"), { recursive: true });
  await writeFile(join(root, "generation", "authorization-plan.json"), `${JSON.stringify({
    styleLockSha256: "a".repeat(64),
    pageIds: slideIds,
    callBudget: slideIds.length,
    outboundDisclosure: { sendsText: true, references: [] },
    dependency: { kind: "ai-image-to-ppt", sha256: "b".repeat(64) },
    revisionId: (await readProject(root)).currentRevision.id,
  }, null, 2)}\n`);
  await approveGate(root, "generation-authorization");
  let candidate = await assembleProjectCandidate(root, { buildOutputs: fakeInitialOutputs });
  let review = await publishDeckReview(root, candidate.candidateId);
  if (action === "edit-page") {
    await applyDeckReviewAction(root, { action: "confirm-delivery", candidateId: candidate.candidateId, descriptorSha256: review.descriptorSha256 });
    candidate = await assembleProjectCandidate(root, { buildOutputs: fakeInitialOutputs });
    review = await publishDeckReview(root, candidate.candidateId);
  }
  const request = action === "edit-page"
    ? { action, slideId: slideIds[1], candidateId: candidate.candidateId, descriptorSha256: review.descriptorSha256 }
    : { action, candidateId: candidate.candidateId, descriptorSha256: review.descriptorSha256 };
  await applyDeckReviewAction(root, request);
  return {
    root,
    candidateId: candidate.candidateId,
    reviewDescriptorSha256: review.descriptorSha256,
  };
}

async function readyProject(t: TestContext): Promise<string> {
  return (await reviewedProject(t, "confirm-delivery")).root;
}

async function converterRoot(t: TestContext): Promise<string> {
  const root = join(await temporary(t, "superppt-mixed-converter-"), "plugin");
  await mkdir(join(root, "skills", "image-to-editable-pptx"), { recursive: true });
  await mkdir(join(root, "src", "export"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.2.0",
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  })}\n`);
  await writeFile(join(root, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  await writeFile(join(root, "src", "contracts.ts"), 'import { z } from "zod";\nexport const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) }).strict();\n');
  await writeFile(join(root, "src", "pipeline.ts"), 'function outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return `${imagePath}-editable.pptx`; }\nexport function buildSlide(imagePath?: string): string { return outputName(imagePath); }\n');
  await writeFile(join(root, "src", "export", "pptx.ts"), 'export async function exportPptx(element: any, pptx: any, slide: any): Promise<void> { slide.addImage({ objectName: "asset-background" }); slide.addText("", { objectName: `text-${element.id}` }); slide.addShape("", { objectName: `shape-${element.id}-${element.label}` }); slide.addImage({ objectName: `asset-${element.id}` }); await pptx.writeFile({ fileName: "out.pptx" }); }\n');
  return root;
}

async function resolvedDependencies(
  t: TestContext,
  editableRoot: string,
): Promise<ResolvedDependencies> {
  const aiRoot = join(await temporary(t, "superppt-mixed-ai-skill-"), "ai-image-to-ppt");
  await mkdir(join(aiRoot, "scripts"), { recursive: true });
  await mkdir(join(aiRoot, "references"), { recursive: true });
  await writeFile(join(aiRoot, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  for (const script of [
    "generation_result.py",
    "host_routing_policy.py",
    "import_host_image.py",
    "prepare_editable_input.py",
    "gen_slide.py",
    "export_images.py",
  ]) {
    await writeFile(join(aiRoot, "scripts", script), `# fixture ${script}\n`);
  }
  await writeFile(join(aiRoot, "references", "capabilities.json"), `${JSON.stringify({
    schemaVersion: 1, skill: "ai-image-to-ppt",
    contracts: { generationResult: 1, serialStickyRouterReport: 1, hostImageImport: 1, editableInput: 1 },
    routingOrder: [
      { provider: "openai", channel: "host", modelSelection: "host-owned" },
      { provider: "openai", channel: "api", defaultModel: "gpt-image-2" },
      { provider: "gemini", channel: "host", modelSelection: "host-owned" },
      { provider: "gemini", channel: "api", defaultModel: "gemini-3.1-flash-image" },
      { provider: "doubao", channel: "host", modelSelection: "host-owned" },
      { provider: "doubao", channel: "api", defaultModel: "doubao-seedream-5-0-260128" },
    ],
    outputs: { normalizedSlide: { format: "image", width: 1920, height: 1080 }, editableInput: { format: "png", width: 1280, height: 720 } },
    scripts: { generationResult: "scripts/generation_result.py", hostRoutingPolicy: "scripts/host_routing_policy.py", importHostImage: "scripts/import_host_image.py", prepareEditableInput: "scripts/prepare_editable_input.py", apiGenerator: "scripts/gen_slide.py", normalizedExport: "scripts/export_images.py" },
  }, null, 2)}\n`);
  return resolvedDependenciesFromRoots(aiRoot, editableRoot);
}

async function resolvedDependenciesFromRoots(
  aiRoot: string,
  editableRoot: string,
): Promise<ResolvedDependencies> {
  return attestWorkflowDependencies(
    await resolveSkillDependencies({ aiSkillRoot: aiRoot, editableSkillRoot: editableRoot }),
    { source: "agent-host", localFilesystem: true, localFileLinks: true },
  );
}

async function transparentPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const DOCUMENT_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";

async function officialDonorPptx(background: Buffer, icon: Buffer): Promise<Buffer> {
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

async function writeFakeConverterOutput(outDir: string, sourcePng: string): Promise<void> {
  await mkdir(join(outDir, "assets"), { recursive: true });
  const legacyManifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
  const icon = await readFile(join(fixtureRoot, "assets", "icon.png"));
  const iconSha256 = sha256(icon);
  const manifest = {
    ...legacyManifest,
    manifestVersion: 2,
    elements: legacyManifest.elements.map((element: Record<string, unknown>) => element.kind === "asset" ? {
      ...element,
      role: "foreground-object",
      groupId: "fixture-icon",
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
  const files = {
    "ocr.json": Buffer.from('{"lines":[]}\n'),
    "vision.json": Buffer.from('{"elements":[]}\n'),
    "analysis-ledger.json": Buffer.from('{"analysis":"fixture"}\n'),
    "manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    "removal-mask.png": await transparentPng(1280, 720),
    "clean-background.png": await readFile(join(fixtureRoot, "clean-background.png")),
    "recomposition-preview.png": await readFile(join(fixtureRoot, "clean-background.png")),
    "layer-review.png": await readFile(join(fixtureRoot, "clean-background.png")),
    "exploded-preview.png": await readFile(join(fixtureRoot, "clean-background.png")),
    "assets/icon.png": icon,
    "slide-editable.pptx": await officialDonorPptx(await readFile(join(fixtureRoot, "clean-background.png")), icon),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(outDir, name), bytes);
  const digest = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
  const output = (name: string): string => join(outDir, name);
  await writeFile(join(outDir, "run-ledger.json"), `${JSON.stringify({
    ledgerVersion: 2,
    mode: "replay",
    recorded: false,
    models: { ocr: "fixture-ocr", vision: "fixture-vision" },
    durationsMs: { ocr: 0, vision: 0, analyze: 0, plan: 0, repair: 0, export: 0, total: 0 },
    taskIds: {},
    warnings: [],
    decisions: [
      { candidateId: "title", kind: "text", decision: "accepted", bbox: { x: 120, y: 88, width: 680, height: 92 }, sourceElementIndexes: [0], repairMethod: "local_nearest_surface", extraction: "none", output: { state: "editable_layer", manifestElementId: "ocr-title" } },
      { candidateId: "icon", kind: "icon", decision: "accepted", bbox: { x: 920, y: 260, width: 120, height: 120 }, sourceElementIndexes: [1], repairMethod: "local_nearest_surface", extraction: "transparent", output: { state: "editable_layer", manifestElementId: "icon-1", assetPath: "assets/icon.png" } },
    ],
    hashes: {
      sourceImage: digest(await readFile(sourcePng)),
      ocr: digest(files["ocr.json"]),
      vision: digest(files["vision.json"]),
      analysisLedger: digest(files["analysis-ledger.json"]),
      manifest: digest(files["manifest.json"]),
      removalMask: digest(files["removal-mask.png"]),
      cleanBackground: digest(files["clean-background.png"]),
      assets: { "assets/icon.png": digest(files["assets/icon.png"]) },
      pptx: digest(files["slide-editable.pptx"]),
      qaPreviews: { recomposition: digest(files["recomposition-preview.png"]), layerReview: digest(files["layer-review.png"]), exploded: digest(files["exploded-preview.png"]) },
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
  }, null, 2)}\n`);
  await writeFile(join(outDir, ".image-to-editable-pptx-output.json"), `${JSON.stringify({ markerVersion: 1, appId: "image-to-editable-pptx", artifactKind: "published-output" })}\n`);
}

test("prepare editable input and selected page replacement invalidate only the reviewed candidate", async (t) => {
  const reviewed = await reviewedProject(t, "edit-page");
  const { root } = reviewed;
  const before = await readProject(root);
  const styleArtifact = structuredClone(before.style);
  const styleLockBytes = await readFile(join(root, "style/lock.json"));
  const initialGates = before.gates
    .filter((gate) => ["outline", "slide-specs", "style-sample", "generation-authorization"].includes(gate.gate))
    .map((gate) => ({ gate: gate.gate, approvalId: gate.approvalId, snapshotPath: gate.snapshotPath }));
  const historicalDeckReviewGates = before.gates.filter((gate) => gate.gate === "deck-review").map((gate) => structuredClone(gate));
  const candidateMarker = JSON.parse(await readFile(
    join(root, "output", "candidates", reviewed.candidateId, ".superppt-candidate.json"),
    "utf8",
  ));
  const selectedMaster = candidateMarker.slides.find((slide: { id: string }) => slide.id === slideIds[1]);
  assert.ok(selectedMaster);
  const selectedMasterBytes = await readFile(join(root, ...selectedMaster.path.split("/")));
  const selectedSourcePaths = ["raw.png", "master.png", "normalized.png"].map((name) =>
    join(root, "images", slideIds[1], "attempt-1", name));
  const selectedSourceBytes = await Promise.all(selectedSourcePaths.map((path) => readFile(path)));
  const candidateDirectory = join(root, "output", "candidates", reviewed.candidateId);
  const candidateArtifactsBefore = await outputDirectorySnapshot(candidateDirectory);
  const formalRevisionDirectory = join(root, "output", "revisions", "1");
  const formalArtifactsBefore = await outputDirectorySnapshot(formalRevisionDirectory);
  const assertImmutableArtifactBytes = async (): Promise<void> => {
    for (const [index, path] of selectedSourcePaths.entries()) {
      assert.deepEqual(await readFile(path), selectedSourceBytes[index]);
    }
    assert.deepEqual(await outputDirectorySnapshot(candidateDirectory), candidateArtifactsBefore);
    assert.deepEqual(await outputDirectorySnapshot(formalRevisionDirectory), formalArtifactsBefore);
  };
  const candidateMarkerBytes = await readFile(
    join(root, "output", "candidates", reviewed.candidateId, ".superppt-candidate.json"),
  );

  const plugin = await converterRoot(t);
  const editableDecoy = join(plugin, "scripts", "prepare_editable_input.py");
  await mkdir(join(plugin, "scripts"));
  await writeFile(editableDecoy, "# image-to-editable-pptx must not substitute for the resolved ai-image-to-ppt script\n");
  const dependencies = await resolvedDependencies(t, plugin);
  const conversionRevisionId = "00000000-0000-4000-8000-000000000935";
  let prepareCalls = 0;
  const converted = await convertProjectPage({
    root,
    slideId: slideIds[1],
    converterRoot: plugin,
    dependencies,
    prepareExecute: async (command: string, args: string[]) => {
      prepareCalls += 1;
      assert.equal(command, "python3");
      assert.equal(args[0], dependencies.ai.scripts.prepareEditableInput);
      assert.notEqual(args[0], editableDecoy);
      assert.equal(args[1], join(root, ...selectedMaster.path.split("/")));
      assert.equal(args[2], join(root, "editable", slideIds[1], conversionRevisionId, "source-1280x720.png"));
      await sharp(await readFile(args[1]!)).resize(1280, 720).png().toFile(args[2]!);
      return {
        stdout: `  OK: ${args[2]} (1280x720 PNG, editable-converter input)\n`,
        stderr: "",
      };
    },
    idFactory: () => conversionRevisionId,
    execute: async (_command, args) => {
      const source = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, source);
      return { stdout: "", stderr: "" };
    },
  } as Parameters<typeof convertProjectPage>[0]);
  assert.equal(prepareCalls, 1);
  assert.equal(converted.sourcePng, join(converted.revisionRoot, "source-1280x720.png"));
  assert.equal(converted.outputRoot, join(converted.revisionRoot, "converter-output"));
  assert.notEqual(converted.sourcePng, join(root, ...selectedMaster.path.split("/")));
  assert.deepEqual(
    [(await sharp(converted.sourcePng).metadata()).width, (await sharp(converted.sourcePng).metadata()).height],
    [1280, 720],
  );
  const conversionRecord = JSON.parse(await readFile(converted.conversionRecord, "utf8"));
  assert.equal(conversionRecord.prepareEditableInput.scriptPath, dependencies.ai.scripts.prepareEditableInput);
  assert.equal(conversionRecord.prepareEditableInput.scriptSha256, dependencies.ai.scriptSha256.prepareEditableInput);
  assert.deepEqual(conversionRecord.prepareEditableInput.sourceMaster, {
    path: selectedMaster.path,
    sha256: selectedMaster.sha256,
    revisionId: before.currentRevision.id,
  });
  assert.equal(conversionRecord.prepareEditableInput.output1280x720.path, `editable/${slideIds[1]}/${converted.revisionId}/source-1280x720.png`);
  assert.deepEqual(await readFile(join(root, ...selectedMaster.path.split("/"))), selectedMasterBytes);
  assert.deepEqual(
    await readFile(join(root, "output", "candidates", reviewed.candidateId, ".superppt-candidate.json")),
    candidateMarkerBytes,
  );
  await assertImmutableArtifactBytes();

  const modified = await promoteProjectEditableTarget({
    root,
    slideId: slideIds[1],
    sourceRevisionId: converted.revisionId,
    elementId: "ocr-title",
    expectedKind: "text",
  });
  const recordSha256 = sha256(await readFile(join(modified.revisionRoot, "modified-revision-record.json")));
  assert.equal(recordSha256.length, 64);
  await assert.rejects(lstat(join(modified.revisionRoot, "preview-1920x1080.png")), { code: "ENOENT" });
  await assertImmutableArtifactBytes();

  const after = await readProject(root);
  assert.equal(after.stage, "revising");
  assert.equal(after.slides[1]!.status, "ready");
  assert.equal(after.slides[1]!.editableRevision ?? null, null);
  assert.deepEqual(after.slides, before.slides);
  assert.deepEqual(after.style, styleArtifact);
  assert.deepEqual(await readFile(join(root, "style/lock.json")), styleLockBytes);
  assert.deepEqual(after.gates
    .filter((gate) => ["outline", "slide-specs", "style-sample", "generation-authorization"].includes(gate.gate))
    .map((gate) => ({ gate: gate.gate, approvalId: gate.approvalId, snapshotPath: gate.snapshotPath })), initialGates);
  assert.deepEqual(after.gates.filter((gate) => gate.gate === "deck-review"), historicalDeckReviewGates);
  for (const name of ["action.json", "review.json"]) {
    await lstat(join(root, "output/candidates/current", name));
  }
});
test("one authenticated edit-page action cannot authorize another page", async (t) => {
  const reviewed = await reviewedProject(t, "edit-page");
  const plugin = await converterRoot(t);
  const dependencies = await resolvedDependencies(t, plugin);
  const immutablePaths = ["raw.png", "master.png", "normalized.png"].map((name) =>
    join(reviewed.root, "images", slideIds[1], "attempt-1", name));
  const immutableBytes = await Promise.all(immutablePaths.map((path) => readFile(path)));
  const candidateBefore = await outputDirectorySnapshot(join(reviewed.root, "output", "candidates", reviewed.candidateId));
  const formalBefore = await outputDirectorySnapshot(join(reviewed.root, "output", "revisions", "1"));
  let prepareCalls = 0;
  let converterCalls = 0;
  await assert.rejects(convertProjectPage({
    root: reviewed.root,
    slideId: slideIds[0],
    converterRoot: plugin,
    dependencies,
    prepareExecute: async () => {
      prepareCalls += 1;
      throw new Error("wrong page preparation must not execute");
    },
    execute: async () => {
      converterCalls += 1;
      throw new Error("wrong page conversion must not execute");
    },
  }), /authenticated edit-page selection/);
  assert.equal(prepareCalls, 0);
  assert.equal(converterCalls, 0);
  for (const [index, path] of immutablePaths.entries()) assert.deepEqual(await readFile(path), immutableBytes[index]);
  assert.deepEqual(await outputDirectorySnapshot(join(reviewed.root, "output", "candidates", reviewed.candidateId)), candidateBefore);
  assert.deepEqual(await outputDirectorySnapshot(join(reviewed.root, "output", "revisions", "1")), formalBefore);
});

test("prepare editable input rejects dependency drift, extra output, wrong dimensions, and linked output", async (t) => {
  const reviewed = await reviewedProject(t, "edit-page");
  const plugin = await converterRoot(t);
  const dependencies = await resolvedDependencies(t, plugin);
  const immutablePaths = ["raw.png", "master.png", "normalized.png"].map((name) =>
    join(reviewed.root, "images", slideIds[1], "attempt-1", name));
  const immutableBytes = await Promise.all(immutablePaths.map((path) => readFile(path)));
  const candidateBefore = await outputDirectorySnapshot(join(reviewed.root, "output", "candidates", reviewed.candidateId));
  const formalBefore = await outputDirectorySnapshot(join(reviewed.root, "output", "revisions", "1"));
  let converterCalls = 0;
  const execute = async (): Promise<{ stdout: string; stderr: string }> => {
    converterCalls += 1;
    return { stdout: "", stderr: "" };
  };
  const attempt = async (
    revisionId: string,
    prepareExecute: NonNullable<Parameters<typeof convertProjectPage>[0]["prepareExecute"]>,
  ): Promise<void> => {
    await convertProjectPage({
      root: reviewed.root,
      slideId: slideIds[1],
      converterRoot: plugin,
      dependencies,
      idFactory: () => revisionId,
      prepareExecute,
      execute,
    });
  };
  const assertCleaned = async (revisionId: string): Promise<void> => {
    await assert.rejects(lstat(join(reviewed.root, "editable", slideIds[1], revisionId)), { code: "ENOENT" });
    for (const [index, path] of immutablePaths.entries()) assert.deepEqual(await readFile(path), immutableBytes[index]);
    assert.deepEqual(await outputDirectorySnapshot(join(reviewed.root, "output", "candidates", reviewed.candidateId)), candidateBefore);
    assert.deepEqual(await outputDirectorySnapshot(join(reviewed.root, "output", "revisions", "1")), formalBefore);
  };

  await assert.rejects(attempt("00000000-0000-4000-8000-000000000930", async (_command, args) => {
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#21354b" } }).png().toFile(args[2]!);
    return { stdout: `  OK: ${args[2]} (1280x720 PNG, editable-converter input)\nextra\n`, stderr: "" };
  }), /malformed or extra output/);
  await assertCleaned("00000000-0000-4000-8000-000000000930");

  await assert.rejects(attempt("00000000-0000-4000-8000-000000000931", async (_command, args) => {
    await sharp({ create: { width: 1279, height: 720, channels: 3, background: "#21354b" } }).png().toFile(args[2]!);
    return { stdout: `  OK: ${args[2]} (1280x720 PNG, editable-converter input)\n`, stderr: "" };
  }), /exact 1280x720 PNG/);
  await assertCleaned("00000000-0000-4000-8000-000000000931");

  const outside = join(await temporary(t, "superppt-prepared-outside-"), "outside.png");
  await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#21354b" } }).png().toFile(outside);
  await assert.rejects(attempt("00000000-0000-4000-8000-000000000932", async (_command, args) => {
    await symlink(outside, args[2]!);
    return { stdout: `  OK: ${args[2]} (1280x720 PNG, editable-converter input)\n`, stderr: "" };
  }), /regular non-symlink file/);
  await assertCleaned("00000000-0000-4000-8000-000000000932");

  const editablePackage = await readFile(dependencies.editable.packageFile);
  await assert.rejects(attempt("00000000-0000-4000-8000-000000000933", async (_command, args) => {
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#21354b" } }).png().toFile(args[2]!);
    await writeFile(dependencies.editable.packageFile, `${editablePackage.toString("utf8")} `);
    return { stdout: `  OK: ${args[2]} (1280x720 PNG, editable-converter input)\n`, stderr: "" };
  }), /dependency changed after input preparation/);
  await assertCleaned("00000000-0000-4000-8000-000000000933");
  await writeFile(dependencies.editable.packageFile, editablePackage);

  await writeFile(dependencies.ai.scripts.prepareEditableInput, "# drifted script\n");
  await assert.rejects(attempt("00000000-0000-4000-8000-000000000934", async () => {
    throw new Error("drifted preparation script must never execute");
  }), /preflight failed|identity changed/);
  await assertCleaned("00000000-0000-4000-8000-000000000934");
  assert.equal(converterCalls, 0);

  await writeFile(dependencies.ai.scripts.prepareEditableInput, "# fixture prepare_editable_input.py\n");
  const refreshedDependencies = await resolvedDependenciesFromRoots(
    dependencies.ai.root,
    dependencies.editable.root,
  );
  const identityRevision = "00000000-0000-4000-8000-000000000936";
  await assert.rejects(convertProjectPage({
    root: reviewed.root,
    slideId: slideIds[1],
    converterRoot: plugin,
    dependencies: refreshedDependencies,
    idFactory: () => identityRevision,
    prepareExecute: async (_command, args) => {
      await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#21354b" } }).png().toFile(args[2]!);
      return { stdout: `  OK: ${args[2]} (1280x720 PNG, editable-converter input)\n`, stderr: "" };
    },
    execute: async (_command, args) => {
      const source = args[args.indexOf("--image") + 1]!;
      const bytes = await readFile(source);
      await rm(source);
      await writeFile(source, bytes);
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, source);
      return { stdout: "", stderr: "" };
    },
  }), /changed identity during conversion/);
  await assertCleaned(identityRevision);
});
