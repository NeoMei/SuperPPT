import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import { assembleDeck, assembleProject, readProjectAcceptance, replaceSlide, type FinalRender } from "../src/deck/assemble.js";
import { buildMontage } from "../src/deck/montage.js";
import { exportPdf } from "../src/deck/pdf.js";
import { convertProjectPage } from "../src/editable/adapter.js";
import { applyProjectEditPlan } from "../src/editable/operations.js";
import { confirmEditablePreview, renderEditablePage, renderProjectEditablePreview } from "../src/editable/render.js";
import { approveGate } from "../src/planning/confirm.js";
import { publishPlanViews, publishStyleSample } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject, sha256, updateProject } from "../src/project/store.js";

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
  paths: { pptx: string; pdf: string; montage: string },
): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [index, render] of renders.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld><p:pic><p:cNvPr name=\"page-${render.id}\"/><a:blip r:embed=\"rIdImage\"/></p:pic></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships><Relationship Id=\"rIdImage\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/image${index + 1}.png\"/></Relationships>`);
    zip.file(`ppt/media/image${index + 1}.png`, render.bytes);
  }
  await writeFile(paths.pptx, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
  await exportPdf(renders, paths.pdf);
  await buildMontage(renders, paths.montage);
}

async function readyProject(t: TestContext): Promise<string> {
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
  await writeFile(join(root, "style", "sample", "prompt.txt"), "private style prompt\n", { mode: 0o600 });
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#102030" } }).png()
    .toFile(join(root, "style", "sample", "sample.png"));
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await publishStyleSample(root);
  await approveGate(root, "style-sample");

  const manifest = await readProject(root);
  const images = await Promise.all(slideIds.map(async (id, order) => {
    const attempt = join(root, "images", id, "attempt-1");
    await mkdir(attempt, { recursive: true });
    const bytes = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: order === 0 ? "#a02916" : "#1645a0" } }).png().toBuffer();
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
  await assembleProject({ root, operations: { buildOutputs: fakeInitialOutputs } });
  return root;
}

async function converterRoot(t: TestContext): Promise<string> {
  const root = join(await temporary(t, "superppt-mixed-converter-"), "plugin");
  await mkdir(join(root, "skills", "image-to-editable-pptx"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.1.0",
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  })}\n`);
  await writeFile(join(root, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  return root;
}

async function transparentPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

async function writeFakeConverterOutput(outDir: string, sourcePng: string): Promise<void> {
  await mkdir(join(outDir, "assets"), { recursive: true });
  const files = {
    "ocr.json": Buffer.from('{"lines":[]}\n'),
    "vision.json": Buffer.from('{"elements":[]}\n'),
    "analysis-ledger.json": Buffer.from('{"analysis":"fixture"}\n'),
    "manifest.json": await readFile(join(fixtureRoot, "manifest.json")),
    "removal-mask.png": await transparentPng(1280, 720),
    "clean-background.png": await readFile(join(fixtureRoot, "clean-background.png")),
    "assets/icon.png": await readFile(join(fixtureRoot, "assets", "icon.png")),
    "fixture-editable.pptx": Buffer.from("fixture-pptx"),
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
      pptx: digest(files["fixture-editable.pptx"]),
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
  }, null, 2)}\n`);
  await writeFile(join(outDir, ".image-to-editable-pptx-output.json"), `${JSON.stringify({ markerVersion: 1, appId: "image-to-editable-pptx", artifactKind: "published-output" })}\n`);
}

test("renders a deterministic 1920x1080 editable preview and authors real editable objects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "superppt-mixed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const editableRoot = join(process.cwd(), "tests/fixtures/editable");
  const manifest = JSON.parse(await readFile(join(editableRoot, "manifest.json"), "utf8"));
  manifest.elements.find((element: { id: string }) => element.id === "ocr-title").text = "新的标题";
  const preview = join(root, "editable-preview.png");

  await renderEditablePage({ root: editableRoot, manifest, output: preview });
  const metadata = await sharp(preview).metadata();
  assert.deepEqual([metadata.width, metadata.height], [1920, 1080]);
  const repeated = join(root, "editable-preview-repeat.png");
  await renderEditablePage({ root: editableRoot, manifest, output: repeated });
  assert.equal(sha256(await readFile(repeated)), sha256(await readFile(preview)));

  const image = join(root, "image.png");
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#123456" } }).png().toFile(image);
  const pptx = join(root, "mixed.pptx");
  await assembleDeck([
    { id: "image", order: 0, mode: "image", render: image },
    { id: "editable", order: 1, mode: "editable", render: preview, editableRoot, manifest },
  ], pptx);

  const zip = await JSZip.loadAsync(await readFile(pptx));
  const imageSlide = await zip.file("ppt/slides/slide1.xml")!.async("text");
  const editableSlide = await zip.file("ppt/slides/slide2.xml")!.async("text");
  assert.equal([...imageSlide.matchAll(/<p:pic\b/g)].length, 1);
  assert.match(imageSlide, /name="page-image"/);
  assert.match(editableSlide, /新的标题/);
  assert.match(editableSlide, /name="text-ocr-title"/);
  assert.match(editableSlide, /name="asset-icon-1"/);
  assert.ok([...editableSlide.matchAll(/<p:pic\b/g)].length >= 2);
});

test("replaces only after a bound preview confirmation, rebuilds every output, and re-edits without conversion", async (t) => {
  const root = await readyProject(t);
  const original = await readProject(root);
  const untouchedBefore = original.slides[0]!.finalRender!;
  const initialExports = original.exports;
  const plugin = await converterRoot(t);
  let conversionCalls = 0;
  const converted = await convertProjectPage({
    root,
    slideId: slideIds[1],
    converterRoot: plugin,
    execute: async (_command, args) => {
      conversionCalls += 1;
      const source = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, source);
      return { stdout: "", stderr: "" };
    },
  });
  const firstEdit = await applyProjectEditPlan({
    root,
    slideId: slideIds[1],
    sourceRevisionId: converted.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "新的标题" }] },
  });
  const firstRecordPath = join(firstEdit.revisionRoot, "modified-revision-record.json");
  const firstRecordSha256 = sha256(await readFile(firstRecordPath));
  const previewDirectory = join(root, "previews", "editable", slideIds[1]);
  const forgedPreviewPath = join(previewDirectory, `${firstEdit.revisionId}.png`);
  await mkdir(previewDirectory, { recursive: true });
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#ffffff" } }).png().toFile(forgedPreviewPath);
  await assert.rejects(renderProjectEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
  }), /existing editable preview does not match the deterministic render/);
  await rm(forgedPreviewPath);
  const firstPreview = await renderProjectEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
  });
  assert.deepEqual([(await sharp(join(root, firstPreview.preview.path)).metadata()).width, (await sharp(join(root, firstPreview.preview.path)).metadata()).height], [1920, 1080]);

  const beforeRejection = await readProject(root);
  const forgedBinding = { ...firstPreview, expectedModifiedRevisionRecordSha256: "0".repeat(64) };
  await assert.rejects(updateProject(root, (current) => ({
    ...current,
    gates: [...current.gates, {
      gate: "slide-preview" as const,
      revisionId: current.currentRevision.id,
      artifactHashes: {
        [forgedBinding.modifiedRevisionRecordPath]: forgedBinding.expectedModifiedRevisionRecordSha256,
        [forgedBinding.preview.path]: forgedBinding.preview.sha256,
      },
      slidePreview: forgedBinding,
      confirmedAt: new Date().toISOString(),
    }],
  })), /slide preview gate evidence is invalid/);
  assert.deepEqual(await readProject(root), beforeRejection);
  assert.equal(await confirmEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
    preview: join(root, firstPreview.preview.path),
    approved: false,
  }), null);
  assert.deepEqual(await readProject(root), beforeRejection);
  await assert.rejects(replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
  }), /confirmed slide preview is required/);
  assert.deepEqual(await readProject(root), beforeRejection);

  await confirmEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
    preview: join(root, firstPreview.preview.path),
  });
  const manifestBytes = await readFile(firstEdit.modifiedManifestPath);
  const recordBytes = await readFile(firstRecordPath);
  const markerPath = join(firstEdit.revisionRoot, ".superppt-editable-revision.json");
  const markerBytes = await readFile(markerPath);
  const forgedManifest = Buffer.from(`${JSON.stringify({ ...JSON.parse(manifestBytes.toString("utf8")), forged: true })}\n`);
  const forgedRecord = JSON.parse(recordBytes.toString("utf8"));
  forgedRecord.artifacts.modifiedManifest = sha256(forgedManifest);
  const forgedRecordBytes = Buffer.from(`${JSON.stringify(forgedRecord, null, 2)}\n`);
  const forgedMarker = JSON.parse(markerBytes.toString("utf8"));
  forgedMarker.modifiedRevisionRecordSha256 = sha256(forgedRecordBytes);
  await writeFile(firstEdit.modifiedManifestPath, forgedManifest);
  await writeFile(firstRecordPath, forgedRecordBytes);
  await writeFile(markerPath, `${JSON.stringify(forgedMarker, null, 2)}\n`);
  await assert.rejects(replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
  }), /external project-state anchor|record.*hash mismatch/i);
  await writeFile(firstEdit.modifiedManifestPath, manifestBytes);
  await writeFile(firstRecordPath, recordBytes);
  await writeFile(markerPath, markerBytes);

  const firstReplacement = await replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
  });
  const afterFirst = await readProject(root);
  assert.equal(firstReplacement.revisionNumber, 2);
  assert.equal(afterFirst.deckRevision, 2);
  assert.equal(afterFirst.slides[1]!.status, "editable");
  assert.deepEqual(afterFirst.slides[0]!.finalRender, untouchedBefore);
  assert.equal(afterFirst.outputRevisions?.length, 1);
  assert.deepEqual(afterFirst.outputRevisions?.[0]?.exports, initialExports);
  assert.ok(Object.values(afterFirst.exports).every((artifact) => artifact?.path.startsWith("output/revisions/2/")));
  const firstAcceptance = await readProjectAcceptance(root);
  assert.deepEqual(firstAcceptance.editablePageIds, [slideIds[1]]);
  assert.equal(firstAcceptance.slides[0]!.finalRenderSha256, untouchedBefore.sha256);
  assert.equal(firstAcceptance.slides[1]!.finalRenderSha256, firstPreview.preview.sha256);
  const firstDeck = await JSZip.loadAsync(await readFile(join(root, afterFirst.exports.pptx!.path)));
  const firstEditableXml = await firstDeck.file("ppt/slides/slide2.xml")!.async("text");
  assert.match(firstEditableXml, /新的标题/);
  assert.match(firstEditableXml, /name="text-ocr-title"/);
  assert.match(firstEditableXml, new RegExp(`name="background-${slideIds[1]}"`));
  const replacementRetry = await replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
  });
  assert.equal(replacementRetry.recovered, true);
  assert.deepEqual(await readProject(root), afterFirst);

  const secondEdit = await applyProjectEditPlan({
    root,
    slideId: slideIds[1],
    sourceRevisionId: firstEdit.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "再次修改" }] },
  });
  assert.equal(conversionCalls, 1);
  const secondRecordSha256 = sha256(await readFile(join(secondEdit.revisionRoot, "modified-revision-record.json")));
  const secondPreview = await renderProjectEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: secondEdit.revisionId,
    expectedModifiedRevisionRecordSha256: secondRecordSha256,
  });
  await confirmEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: secondEdit.revisionId,
    expectedModifiedRevisionRecordSha256: secondRecordSha256,
    preview: join(root, secondPreview.preview.path),
  });
  await replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: secondEdit.revisionId,
    expectedModifiedRevisionRecordSha256: secondRecordSha256,
  });
  const afterSecond = await readProject(root);
  assert.equal(afterSecond.deckRevision, 3);
  assert.equal(afterSecond.outputRevisions?.length, 2);
  assert.deepEqual(afterSecond.slides[0]!.finalRender, untouchedBefore);
  assert.equal(conversionCalls, 1);
  const secondDeck = await JSZip.loadAsync(await readFile(join(root, afterSecond.exports.pptx!.path)));
  assert.match(await secondDeck.file("ppt/slides/slide2.xml")!.async("text"), /再次修改/);
});
