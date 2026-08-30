import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import { activateEditableSlideInDeck } from "../src/deck-revisions/activate-slide.js";
import { bootstrapInitialDeckRevision, createDeckCandidate } from "../src/deck-revisions/store.js";
import { inspectLocalPptx } from "../src/deck-revisions/inspect.js";
import { scanOoxmlRanges } from "../src/deck-revisions/ooxml.js";
import { finalizeSlideTopology } from "../src/deck-revisions/topology.js";
import { assembleProjectCandidate, type FinalRender } from "../src/deck/assemble.js";
import { buildMontage } from "../src/deck/montage.js";
import { exportPdf } from "../src/deck/pdf.js";
import { ConversionRecordSchema, RunLedgerV2Schema } from "../src/editable/schemas.js";
import { configureGenerationAuthorizationTrustForTests } from "../src/generation/trusted-authorization.js";
import { approveGate } from "../src/planning/confirm.js";
import { publishPlanViews } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { applyDeckReviewAction, publishDeckReview } from "../src/project/promotion.js";
import { readProject, updateProject } from "../src/project/store.js";
import { finalizeDelegatedStyleSampleForTest } from "./helpers/delegated-style-sample.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const IMAGE_REL = `${R}/image`;
const LAYOUT_REL = `${R}/slideLayout`;

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

async function png(width: number, height: number, alpha = false): Promise<Buffer> {
  return sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 31, g: 85, b: 102, alpha: 0.25 } : "#f7f3e9" } }).png().toBuffer();
}

async function temporaryProject(t: TestContext): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "superppt-full-deck-activation-")));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await initializeProject({ root, title: "Full-deck activation" });
  return root;
}

function targetSlideXml(position: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<deck:sld xmlns:deck="${P}" xmlns:draw="${A}" xmlns:rel="${R}" xmlns:office14="${P14}" xmlns:mystery="urn:superppt:test:unknown" mystery:keep="root-${position}"><deck:cSld><deck:spTree><deck:nvGrpSpPr><deck:cNvPr id="1" name="target-page-${position}"/></deck:nvGrpSpPr><deck:grpSpPr/></deck:spTree><mystery:payload keep="slide-${position}"/><deck:extLst><deck:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><office14:creationId val="${9000 + position}"/></deck:ext><deck:ext uri="{UNKNOWN-${position}}"><mystery:data exact="yes-${position}"/></deck:ext></deck:extLst></deck:cSld><deck:transition advClick="1"/><deck:timing><deck:tnLst/></deck:timing></deck:sld>`;
}

async function targetDeckBytes(slideCount = 3): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/></Types>`);
  const slideIds = Array.from({ length: slideCount }, (_, index) => `<deck:sldId id="${256 + index}" rel:id="rId${index + 1}"/>`).join("");
  const slideRelationships = Array.from({ length: slideCount }, (_, index) => `<pkg:Relationship Id="rId${index + 1}" Type="${R}/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  zip.file("ppt/presentation.xml", `<deck:presentation xmlns:deck="${P}" xmlns:rel="${R}"><deck:sldIdLst>${slideIds}</deck:sldIdLst><deck:sldSz cx="12192000" cy="6858000"/></deck:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<pkg:Relationships xmlns:pkg="${REL}">${slideRelationships}</pkg:Relationships>`);
  for (let index = 1; index <= slideCount; index += 1) {
    zip.file(`ppt/slides/slide${index}.xml`, targetSlideXml(index));
    zip.file(`ppt/slides/_rels/slide${index}.xml.rels`, `<pkg:Relationships xmlns:pkg="${REL}" xmlns:mystery="urn:target-rel-ext" mystery:keep="rels-${index}"><pkg:Relationship Id="rId1" Type="${LAYOUT_REL}" Target="../slideLayouts/slideLayout1.xml"/>${index === 2 ? `<pkg:Relationship Id="rId7" Type="${R}/notesSlide" Target="../notesSlides/notesSlide2.xml"/><pkg:Relationship Id="rId8" Type="${R}/comments" Target="../comments/comment2.xml"/>` : ""}</pkg:Relationships>`);
  }
  zip.file("ppt/slideLayouts/slideLayout1.xml", `<deck:sldLayout xmlns:deck="${P}"/>`);
  zip.file("ppt/notesSlides/notesSlide2.xml", `<deck:notes xmlns:deck="${P}">NOTES-BYTES-MUST-STAY</deck:notes>`);
  zip.file("ppt/comments/comment2.xml", `<deck:cmLst xmlns:deck="${P}">COMMENTS-BYTES-MUST-STAY</deck:cmLst>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function donorSlideXml(options: { linked?: boolean; duplicateName?: boolean; duplicateId?: boolean; wrongName?: boolean; localRedeclaration?: boolean; defaultNamespace?: boolean } = {}): string {
  const iconName = options.duplicateName ? "text-title" : options.wrongName ? "asset-wrong" : "asset-icon";
  const iconId = options.duplicateId ? "4" : "5";
  const link = options.linked ? ` rel:link="rId3"` : "";
  const localRedeclaration = options.localRedeclaration ? ` xmlns:unused="urn:local-override"` : "";
  const p = options.defaultNamespace ? "" : "slide:";
  const presentationDeclaration = options.defaultNamespace ? `xmlns="${P}"` : `xmlns:slide="${P}"`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}sld ${presentationDeclaration} xmlns:art="${A}" xmlns:rel="${R}" xmlns:unused="urn:root"><${p}cSld><${p}spTree${localRedeclaration}><${p}nvGrpSpPr><${p}cNvPr id="1" name="Group 1"/><${p}cNvGrpSpPr/><${p}nvPr/></${p}nvGrpSpPr><${p}grpSpPr/><${p}pic><${p}nvPicPr><${p}cNvPr id="2" name="asset-background"/></${p}nvPicPr><${p}blipFill><art:blip rel:embed="rId2"/></${p}blipFill></${p}pic><${p}sp><${p}nvSpPr><${p}cNvPr id="3" name="shape-panel-Panel"/></${p}nvSpPr><${p}spPr><art:solidFill><art:srgbClr val="E6E1D6"/></art:solidFill></${p}spPr></${p}sp><${p}sp><${p}nvSpPr><${p}cNvPr id="4" name="text-title"/></${p}nvSpPr><${p}txBody><art:p><art:r><art:t>Editable title</art:t></art:r></art:p></${p}txBody></${p}sp><${p}pic><${p}nvPicPr><${p}cNvPr id="${iconId}" name="${iconName}"/></${p}nvPicPr><${p}blipFill><art:blip rel:embed="rId3"${link}/></${p}blipFill></${p}pic></${p}spTree></${p}cSld></${p}sld>`;
}

async function donorPptx(options: { relType?: string; external?: boolean; linked?: boolean; duplicateName?: boolean; duplicateId?: boolean; wrongName?: boolean; localRedeclaration?: boolean; defaultNamespace?: boolean; wrongBackground?: boolean; wrongAsset?: boolean; invalidPng?: boolean; extraImageRelationship?: boolean; presentationRelType?: string; duplicatePresentationRelId?: boolean; extraPackageRelationship?: "external" | "unsupported"; pageSize?: [number, number]; extraEntry?: { path: string; bytes?: Buffer | string }; extraSlide?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const [cx, cy] = options.pageSize ?? [12192000, 6858000];
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/></Types>`);
  zip.file("ppt/presentation.xml", `<slide:presentation xmlns:slide="${P}" xmlns:rel="${R}"><slide:sldIdLst><slide:sldId id="256" rel:id="rId1"/></slide:sldIdLst><slide:sldSz cx="${cx}" cy="${cy}"/></slide:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<pkg:Relationships xmlns:pkg="${REL}"><pkg:Relationship Id="rId1" Type="${options.presentationRelType ?? `${R}/slide`}" Target="slides/slide1.xml"/>${options.duplicatePresentationRelId ? `<pkg:Relationship Id="rId1" Type="${R}/slideLayout" Target="slideLayouts/slideLayout1.xml"/>` : ""}</pkg:Relationships>`);
  zip.file("ppt/slides/slide1.xml", donorSlideXml(options));
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<pkg:Relationships xmlns:pkg="${REL}"><pkg:Relationship Id="rId1" Type="${LAYOUT_REL}" Target="../slideLayouts/slideLayout1.xml"/><pkg:Relationship Id="rId2" Type="${IMAGE_REL}" Target="../media/image1.png"/><pkg:Relationship Id="rId3" Type="${options.relType ?? IMAGE_REL}" Target="${options.external ? "https://example.invalid/icon.png" : "../media/image2.png"}"${options.external ? ` TargetMode="External"` : ""}/>${options.extraImageRelationship ? `<pkg:Relationship Id="rId4" Type="${IMAGE_REL}" Target="../media/image3.png"/>` : ""}</pkg:Relationships>`);
  zip.file("ppt/slideLayouts/slideLayout1.xml", `<slide:sldLayout xmlns:slide="${P}"/>`);
  if (options.extraPackageRelationship) zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", `<pkg:Relationships xmlns:pkg="${REL}"><pkg:Relationship Id="rId1" Type="${options.extraPackageRelationship === "external" ? `${R}/image` : `${R}/hyperlink`}" Target="${options.extraPackageRelationship === "external" ? "https://example.invalid/layout.png" : "../../media/image1.png"}"${options.extraPackageRelationship === "external" ? ` TargetMode="External"` : ""}/></pkg:Relationships>`);
  zip.file("ppt/media/image1.png", options.invalidPng ? Buffer.from("not-png") : await png(1280, 720, options.wrongBackground));
  zip.file("ppt/media/image2.png", await png(options.wrongAsset ? 49 : 48, 48, true));
  if (options.extraImageRelationship) zip.file("ppt/media/image3.png", await png(12, 12, true));
  if (options.extraEntry) zip.file(options.extraEntry.path, options.extraEntry.bytes ?? "unsafe-active-content");
  if (options.extraSlide) zip.file("ppt/slides/slide2.xml", donorSlideXml());
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function writeConversionEvidence(options: { root: string; slideId: string; projectId: string; projectRevisionId: string; finalRender: { path: string; sha256: string }; selection: { candidateId: string; reviewDescriptorSha256: string; actionEvidenceSha256: string } }) {
  const revisionId = randomUUID();
  const conversionRoot = join(options.root, "editable", options.slideId, revisionId);
  const outputRoot = join(conversionRoot, "converter-output");
  await mkdir(join(outputRoot, "assets"), { recursive: true });
  const sourcePng = join(conversionRoot, "source-1280x720.png");
  await writeFile(sourcePng, await png(1280, 720));
  const icon = await png(48, 48, true);
  const iconHash = digest(icon);
  const manifest = {
    manifestVersion: 2,
    canvas: { width: 1280, height: 720 },
    elements: [
      { kind: "shape", id: "panel", label: "Panel", shape: "rect", bbox: { x: 80, y: 80, width: 1120, height: 560 }, fillColor: "E6E1D6", strokeColor: "776655", strokeWidthPx: 2, cornerRadiusPx: 0, zIndex: 1 },
      { kind: "asset", id: "icon", label: "Review icon", bbox: { x: 920, y: 260, width: 120, height: 120 }, extraction: "transparent", assetPath: "assets/icon.png", zIndex: 2, role: "foreground-object", groupId: "hero", provenance: { kind: "source-visible", sourceCropSha256: iconHash, visibleMaskSha256: "1".repeat(64), assetSha256: iconHash }, relations: [{ id: "icon-behind-title", kind: "behind", from: "icon", to: "title", confidence: 0.95 }], reviewRequired: true },
      { kind: "text", id: "title", text: "Editable title", bbox: { x: 120, y: 88, width: 680, height: 92 }, rotation: 0, color: "223344", fontSizePx: 44, bold: true, align: "left", zIndex: 3 },
    ], warnings: [],
  };
  const files: Record<string, Buffer> = {
    "ocr.json": Buffer.from('{"lines":[]}\n'), "scene-graph.json": Buffer.from('{"graphVersion":1}\n'), "analysis-ledger.json": Buffer.from('{"analysisVersion":2}\n'),
    "manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), "removal-mask.png": await png(1280, 720, true), "clean-background.png": await png(1280, 720),
    "assets/icon.png": icon, "slide-editable.pptx": await donorPptx(),
    "recomposition-preview.png": await png(1280, 720), "layer-review.png": await png(1280, 720), "exploded-preview.png": await png(1280, 720),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(outputRoot, ...name.split("/")), bytes);
  const output = (name: string) => join(outputRoot, name);
  const ledger = RunLedgerV2Schema.parse({
    ledgerVersion: 2, mode: "replay", recorded: false, models: { ocr: "qwen3.5-ocr", vision: "qwen3-vl-plus" }, durationsMs: { ocr: 0, vision: 0, analyze: 0, plan: 0, repair: 0, export: 0, total: 0 }, taskIds: {}, warnings: [],
    decisions: [
      { candidateId: "icon", kind: "foreground-object", decision: "accepted", bbox: manifest.elements[1]!.bbox, sourceElementIndexes: [1], repairMethod: "local_nearest_surface", extraction: "transparent", output: { state: "editable_layer", manifestElementId: "icon", assetPath: "assets/icon.png" } },
      { candidateId: "title", kind: "text", decision: "accepted", bbox: manifest.elements[2]!.bbox, sourceElementIndexes: [2], repairMethod: "none", extraction: "none", output: { state: "editable_layer", manifestElementId: "title" } },
    ],
    hashes: { sourceImage: digest(await readFile(sourcePng)), ocr: digest(files["ocr.json"]!), vision: digest(files["scene-graph.json"]!), analysisLedger: digest(files["analysis-ledger.json"]!), manifest: digest(files["manifest.json"]!), removalMask: digest(files["removal-mask.png"]!), cleanBackground: digest(files["clean-background.png"]!), assets: { "assets/icon.png": iconHash }, pptx: digest(files["slide-editable.pptx"]!), qaPreviews: { recomposition: digest(files["recomposition-preview.png"]!), layerReview: digest(files["layer-review.png"]!), exploded: digest(files["exploded-preview.png"]!) }, sceneGraph: digest(files["scene-graph.json"]!) },
    outputs: { directory: outputRoot, ocr: output("ocr.json"), vision: output("scene-graph.json"), analysisLedger: output("analysis-ledger.json"), manifest: output("manifest.json"), removalMask: output("removal-mask.png"), cleanBackground: output("clean-background.png"), assets: output("assets"), pptx: output("slide-editable.pptx"), qaPreviews: { recomposition: output("recomposition-preview.png"), layerReview: output("layer-review.png"), exploded: output("exploded-preview.png") }, sceneGraph: output("scene-graph.json") },
  });
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(join(outputRoot, "run-ledger.json"), ledgerBytes);
  await writeFile(join(outputRoot, ".image-to-editable-pptx-output.json"), `${JSON.stringify({ markerVersion: 1, appId: "image-to-editable-pptx", artifactKind: "published-output" }, null, 2)}\n`);
  const recordPath = join(conversionRoot, "conversion-record.json");
  const record = ConversionRecordSchema.parse({
    conversionRecordVersion: 1, projectId: options.projectId, slideId: options.slideId, revisionId, projectRevisionId: options.projectRevisionId,
    finalRender: options.finalRender,
    prepareEditableInput: { scriptPath: "/installed/ai-image-to-ppt/scripts/prepare_editable_input.py", scriptSha256: "3".repeat(64), sourceMaster: { ...options.finalRender, revisionId: options.projectRevisionId }, output1280x720: { path: `editable/${options.slideId}/${revisionId}/source-1280x720.png`, sha256: digest(await readFile(sourcePng)), revisionId: options.projectRevisionId } },
    deckReviewSelection: options.selection, converterVersion: "0.2.0",
    artifacts: { sourceImage: digest(await readFile(sourcePng)), manifest: digest(files["manifest.json"]!), runLedger: digest(ledgerBytes), cleanBackground: digest(files["clean-background.png"]!), donorPptx: digest(files["slide-editable.pptx"]!), assets: { "assets/icon.png": iconHash }, outputs: { "ocr.json": digest(files["ocr.json"]!), "scene-graph.json": digest(files["scene-graph.json"]!), "analysis-ledger.json": digest(files["analysis-ledger.json"]!), "manifest.json": digest(files["manifest.json"]!), "removal-mask.png": digest(files["removal-mask.png"]!), "clean-background.png": digest(files["clean-background.png"]!), "slide-editable.pptx": digest(files["slide-editable.pptx"]!), "recomposition-preview.png": digest(files["recomposition-preview.png"]!), "layer-review.png": digest(files["layer-review.png"]!), "exploded-preview.png": digest(files["exploded-preview.png"]!) } },
  });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(conversionRoot, ".superppt-editable-revision.json"), `${JSON.stringify({ markerVersion: 1, appId: "superppt", artifactKind: "editable-slide-revision", projectId: options.projectId, slideId: options.slideId, revisionId, revisionKind: "conversion" }, null, 2)}\n`);
  return { conversionRoot, outputRoot, sourcePng, recordPath };
}

async function fixtureCandidateOutputs(renders: FinalRender[], paths: { pptx: string; pdf: string; montage: string }): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [index, render] of renders.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld><p:pic><p:cNvPr name="page-${render.id}"/><a:blip r:embed="rIdImage"/></p:pic></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships><Relationship Id="rIdImage" Type="${R}/image" Target="../media/image${index + 1}.png"/></Relationships>`);
    zip.file(`ppt/media/image${index + 1}.png`, render.bytes);
  }
  await writeFile(paths.pptx, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
  await exportPdf(renders, paths.pdf);
  await buildMontage(renders, paths.montage);
}

async function prepareReviewedSelection(root: string, slideIds: string[]): Promise<{ finalRender: { path: string; sha256: string }; selection: { candidateId: string; reviewDescriptorSha256: string; actionEvidenceSha256: string } }> {
  await configureGenerationAuthorizationTrustForTests(root, { root: join(dirname(root), "authorization-trust"), deterministicKeySeed: `activation:${root}` });
  await writeFile(join(root, "brief.json"), `${JSON.stringify({ schemaVersion: 1, title: "Full-deck activation", purpose: "Test", audience: "Testers", language: "zh-CN", targetSlides: 3, mustCover: ["Page 1", "Page 2", "Page 3"], constraints: ["16:9"] })}\n`);
  const outlineSlides = slideIds.map((id, order) => ({ id, order, title: `Page ${order + 1}`, role: order === 0 ? "cover" : order === 2 ? "summary" : "content", purpose: "Test", sourceRefs: [`L${order + 1}`] }));
  await writeFile(join(root, "outline.json"), `${JSON.stringify({ schemaVersion: 1, slides: outlineSlides })}\n`);
  for (const slide of outlineSlides) {
    await mkdir(join(root, "slides", slide.id));
    await writeFile(join(root, "slides", slide.id, "spec.json"), `${JSON.stringify({ schemaVersion: 1, slideId: slide.id, title: slide.title, role: slide.role, coreMessage: "Test", requiredText: [slide.title], visualSubject: "subject", composition: "full", relationships: [], forbidden: ["watermark"], sourceRefs: slide.sourceRefs })}\n`);
  }
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({ schemaVersion: 1, styleId: "cinematic-tech", representativeSlideId: slideIds[0] })}\n`);
  await publishPlanViews(root); await approveGate(root, "outline"); await approveGate(root, "slide-specs"); await finalizeDelegatedStyleSampleForTest(root);
  const manifest = await readProject(root);
  const generated = await Promise.all(outlineSlides.map(async (slide, order) => {
    const attempt = join(root, "images", slide.id, "attempt-1"); await mkdir(attempt, { recursive: true });
    const render = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: order === 1 ? "#23384d" : "#3d4d23" } }).png().toBuffer();
    await writeFile(join(attempt, "slide.png"), render);
    const renderDigest = digest(render);
    await writeFile(join(attempt, "ledger.json"), `${JSON.stringify({ ledgerVersion: 1, slideId: slide.id, revisionId: manifest.currentRevision.id, attempt: 1, providerId: "fixture", promptSha256: "a".repeat(64), promptPurged: true, output: `images/${slide.id}/attempt-1/slide.png`, outputSha256: renderDigest, outputBytes: render.length, durationMs: 1, quality: { ok: true, issueCount: 0, issueHashes: [], issueCodes: [], requiredText: [{ textSha256: digest(Buffer.from(slide.title)), present: true, exact: true }], styleConsistent: true, hierarchyClear: true, richDetail: true, noForbiddenContent: true }, outcome: "accepted", errorCode: null }, null, 2)}\n`);
    return { render, digest: renderDigest };
  }));
  await updateProject(root, (current) => ({ ...current, stage: "generating", slides: outlineSlides.map((slide, order) => ({ id: slide.id, order, title: slide.title, role: slide.role as "cover" | "content" | "summary", specRevisionId: current.currentRevision.id, promptRevisionId: current.currentRevision.id, styleRevisionId: current.currentRevision.id, status: "ready" as const, image: { path: `images/${slide.id}/attempt-1/slide.png`, sha256: generated[order]!.digest, revisionId: current.currentRevision.id }, editable: null, finalRender: null, staleReasons: [] })) }));
  await mkdir(join(root, "generation"), { recursive: true });
  await writeFile(join(root, "generation", "authorization-plan.json"), `${JSON.stringify({ styleLockSha256: "a".repeat(64), pageIds: slideIds, callBudget: 3, outboundDisclosure: { sendsText: true, references: [] }, dependency: { kind: "ai-image-to-ppt", sha256: "b".repeat(64) }, revisionId: manifest.currentRevision.id })}\n`);
  await approveGate(root, "generation-authorization");
  const candidate = await assembleProjectCandidate(root, { buildOutputs: fixtureCandidateOutputs });
  const review = await publishDeckReview(root, candidate.candidateId);
  await applyDeckReviewAction(root, { action: "edit-page", slideId: slideIds[1]!, candidateId: candidate.candidateId, descriptorSha256: review.descriptorSha256 });
  const action = JSON.parse(await readFile(join(root, "output", "candidates", "current", "action.json"), "utf8"));
  return { finalRender: { path: `images/${slideIds[1]}/attempt-1/slide.png`, sha256: generated[1]!.digest }, selection: { candidateId: candidate.candidateId, reviewDescriptorSha256: review.descriptorSha256, actionEvidenceSha256: action.actionEvidenceSha256 } };
}

async function activationFixture(t: TestContext) {
  const root = await temporaryProject(t);
  const slideIds = [randomUUID(), randomUUID(), randomUUID()];
  const reviewed = await prepareReviewedSelection(root, slideIds);
  const project = await readProject(root);
  const candidateBytes = await targetDeckBytes();
  const source = join(root, "output", "deck-revisions", randomUUID(), "deck.pptx"); await mkdir(dirname(source), { recursive: true }); await writeFile(source, candidateBytes);
  const inspection = await inspectLocalPptx(source);
  const topology = finalizeSlideTopology(inspection.slides.map((slide, position) => ({ stableSlideId: slideIds[position]!, slidePart: slide.slidePart, position, management: "managed" as const, presentationSlideId: slide.presentationSlideId, creationId: slide.creationId! })), []);
  const parentRevisionId = randomUUID();
  await bootstrapInitialDeckRevision(root, { revisionId: parentRevisionId, projectRevisionId: project.currentRevision.id, sourceAbsolutePath: source, slideTopology: topology, changedSlideIds: slideIds });
  const session = await createDeckCandidate(root, { sourceRevisionId: parentRevisionId, reason: "agent-edit", changedSlideIds: [slideIds[1]!], editableSlideIds: [], targetSlideId: slideIds[1]!, mode: "agent" });
  const conversion = await writeConversionEvidence({ root, slideId: slideIds[1]!, projectId: project.projectId, projectRevisionId: project.currentRevision.id, ...reviewed });
  return { root, slideIds, candidatePath: session.absolutePath, sessionId: session.sessionId, ...conversion };
}

type Fixture = Awaited<ReturnType<typeof activationFixture>>;

async function refreshConversionEvidence(fixture: Fixture): Promise<void> {
  const ledgerPath = join(fixture.outputRoot, "run-ledger.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  for (const [field, name] of [["manifest", "manifest.json"], ["cleanBackground", "clean-background.png"], ["pptx", "slide-editable.pptx"]] as const) ledger.hashes[field] = digest(await readFile(join(fixture.outputRoot, name)));
  ledger.hashes.assets = { "assets/icon.png": digest(await readFile(join(fixture.outputRoot, "assets", "icon.png"))) };
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(ledgerPath, ledgerBytes);
  const record = JSON.parse(await readFile(fixture.recordPath, "utf8"));
  record.artifacts.sourceImage = digest(await readFile(fixture.sourcePng)); record.artifacts.manifest = ledger.hashes.manifest; record.artifacts.runLedger = digest(ledgerBytes); record.artifacts.cleanBackground = ledger.hashes.cleanBackground; record.artifacts.donorPptx = ledger.hashes.pptx; record.artifacts.assets = ledger.hashes.assets;
  record.artifacts.outputs["clean-background.png"] = ledger.hashes.cleanBackground; record.artifacts.outputs["slide-editable.pptx"] = ledger.hashes.pptx;
  await writeFile(fixture.recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function replaceCandidateFixture(fixture: Fixture, mutate: (zip: JSZip) => Promise<void> | void): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(fixture.candidatePath));
  await mutate(zip);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(fixture.candidatePath, bytes);
  const sessionPath = join(fixture.root, "output", "deck-edit-sessions", fixture.sessionId, "session.json");
  const session = JSON.parse(await readFile(sessionPath, "utf8")); session.preparedSha256 = digest(bytes);
  await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
}

async function zipMemberHashes(path: string): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await readFile(path));
  return new Map(await Promise.all(Object.keys(zip.files).filter((name) => !zip.files[name]!.dir).map(async (name) => [name, digest(await zip.file(name)!.async("nodebuffer"))] as const)));
}

function outsideShapeTree(xml: string): string {
  const shapeTree = scanOoxmlRanges(xml).elements.filter((element) => element.namespaceUri === P && element.localName === "spTree");
  assert.equal(shapeTree.length, 1);
  return `${xml.slice(0, shapeTree[0]!.start)}<SHAPE-TREE/>${xml.slice(shapeTree[0]!.end)}`;
}

test("activates only the selected slide and returns the complete deck candidate", async (t) => {
  const fixture = await activationFixture(t);
  const before = await inspectLocalPptx(fixture.candidatePath);
  const beforeMembers = await zipMemberHashes(fixture.candidatePath);
  const beforeZip = await JSZip.loadAsync(await readFile(fixture.candidatePath));
  const targetBefore = await beforeZip.file("ppt/slides/slide2.xml")!.async("string");
  const result = await activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot });
  const after = await inspectLocalPptx(fixture.candidatePath);
  const afterMembers = await zipMemberHashes(fixture.candidatePath);
  const afterZip = await JSZip.loadAsync(await readFile(fixture.candidatePath));
  const targetAfter = await afterZip.file("ppt/slides/slide2.xml")!.async("string");
  assert.equal(after.slideCount, 3); assert.equal(result.absolutePath, fixture.candidatePath); assert.deepEqual(result.editableSlideIds, [fixture.slideIds[1]!]);
  assert.equal(after.slideParts[0]!.xmlSha256, before.slideParts[0]!.xmlSha256); assert.equal(after.slideParts[2]!.xmlSha256, before.slideParts[2]!.xmlSha256); assert.notEqual(after.slideParts[1]!.xmlSha256, before.slideParts[1]!.xmlSha256);
  assert.ok(result.targetInspection.editableTextCount > 0); assert.ok(result.targetInspection.editableShapeCount > 0); assert.ok(result.targetInspection.editableAssetCount > 0);
  assert.deepEqual(result.reviewRequiredObjects, [{ elementId: "icon", label: "Review icon", role: "foreground-object" }]); assert.equal("singleSlidePath" in result, false);
  assert.deepEqual(result.targetInspection.objectNames.sort(), ["asset-background", "asset-icon", "shape-panel-Panel", "text-title"].sort());
  assert.equal(outsideShapeTree(targetAfter), outsideShapeTree(targetBefore)); assert.match(targetAfter, /mystery:data exact="yes-2"/); assert.match(targetAfter, /deck:transition advClick="1"/); assert.match(targetAfter, /deck:timing/);
  assert.match(await afterZip.file("ppt/slides/_rels/slide2.xml.rels")!.async("string"), /Type="[^"]+\/slideLayout"/);
  assert.deepEqual(result.authenticatedConversion.manifest.elements[1], JSON.parse(await readFile(join(fixture.outputRoot, "manifest.json"), "utf8")).elements[1]);
  for (const [name, hash] of beforeMembers) { if (name === "ppt/slides/slide2.xml" || name === "ppt/slides/_rels/slide2.xml.rels") continue; if (/^ppt\/(?:slides|notesSlides|comments)\//.test(name)) assert.equal(afterMembers.get(name), hash, name); }
  const session = JSON.parse(await readFile(join(fixture.root, "output", "deck-edit-sessions", fixture.sessionId, "session.json"), "utf8"));
  const journal = JSON.parse(await readFile(join(fixture.root, "output", "deck-edit-sessions", fixture.sessionId, "journal.json"), "utf8"));
  assert.equal(session.preparedSha256, after.sha256); assert.deepEqual(journal.editableSlideIds, [fixture.slideIds[1]]);
});

test("rejects unauthenticated converter versions, manifests, owned paths, hashes, and missing evidence", async (t) => {
  const scenarios: Array<[string, (fixture: Fixture) => Promise<void>, RegExp]> = [
    ["manifest v1", async (fixture) => { const path = join(fixture.outputRoot, "manifest.json"); const manifest = JSON.parse(await readFile(path, "utf8")); manifest.manifestVersion = 1; await writeFile(path, `${JSON.stringify(manifest)}\n`); await refreshConversionEvidence(fixture); }, /manifest|version/i],
    ["converter 0.1", async (fixture) => { const record = JSON.parse(await readFile(fixture.recordPath, "utf8")); record.converterVersion = "0.1.9"; await writeFile(fixture.recordPath, `${JSON.stringify(record)}\n`); }, /0\.2|converter version|conversion record/i],
    ["converter 0.3", async (fixture) => { const record = JSON.parse(await readFile(fixture.recordPath, "utf8")); record.converterVersion = "0.3.0"; await writeFile(fixture.recordPath, `${JSON.stringify(record)}\n`); }, /0\.2|converter version|conversion record/i],
    ["missing donor", async (fixture) => unlink(join(fixture.outputRoot, "slide-editable.pptx")), /donor|PPTX|regular/i],
    ["donor hash", async (fixture) => writeFile(join(fixture.outputRoot, "slide-editable.pptx"), "tampered"), /hash|PPTX/i],
    ["missing clean background", async (fixture) => unlink(join(fixture.outputRoot, "clean-background.png")), /clean background|clean-background|regular/i],
    ["manifest hash", async (fixture) => writeFile(join(fixture.outputRoot, "manifest.json"), "{}"), /manifest|hash/i],
    ["absolute output escape", async (fixture) => { const ledgerPath = join(fixture.outputRoot, "run-ledger.json"); const ledger = JSON.parse(await readFile(ledgerPath, "utf8")); ledger.outputs.pptx = "/tmp/slide-editable.pptx"; const bytes = Buffer.from(`${JSON.stringify(ledger)}\n`); await writeFile(ledgerPath, bytes); const record = JSON.parse(await readFile(fixture.recordPath, "utf8")); record.artifacts.runLedger = digest(bytes); await writeFile(fixture.recordPath, `${JSON.stringify(record)}\n`); }, /output path|owned|outside/i],
  ];
  for (const [name, mutate, pattern] of scenarios) await t.test(name, async (subtest) => { const fixture = await activationFixture(subtest); await mutate(fixture); await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), pattern); });
});

test("rejects unsafe donor packages, relationships, object names, page sizes, and slide counts", async (t) => {
  const scenarios: Array<[string, Parameters<typeof donorPptx>[0], RegExp]> = [
    ["external", { external: true }, /external/i], ["r:link", { linked: true }, /link/i], ["unsupported relationship", { relType: `${R}/hyperlink` }, /relationship|image/i],
    ["macro", { extraEntry: { path: "ppt/vbaProject.bin" } }, /macro|active content/i], ["OLE", { extraEntry: { path: "ppt/embeddings/oleObject1.bin" } }, /OLE|active content/i], ["media", { extraEntry: { path: "ppt/media/audio1.mp3" } }, /media|audio|video|active content/i], ["ActiveX", { extraEntry: { path: "ppt/activeX/activeX1.xml" } }, /ActiveX|active content/i], ["chart", { extraEntry: { path: "ppt/charts/chart1.xml" } }, /chart|active content/i], ["diagram", { extraEntry: { path: "ppt/diagrams/data1.xml" } }, /diagram|active content/i],
    ["duplicate object name", { duplicateName: true }, /duplicate object name/i], ["duplicate object id", { duplicateId: true }, /duplicate object id|numeric object/i], ["object mismatch", { wrongName: true }, /object name|manifest/i], ["wrong page size", { pageSize: [9144000, 6858000] }, /16:9|page size/i], ["extra slide", { extraSlide: true }, /exactly one slide/i],
    ["wrong background bytes", { wrongBackground: true }, /media|artifact bytes|background/i], ["wrong asset bytes", { wrongAsset: true }, /media|artifact bytes|asset/i], ["invalid PNG", { invalidPng: true }, /PNG|decodable/i], ["extra image relationship", { extraImageRelationship: true }, /extra visual image|unbound media/i],
    ["forged presentation slide relationship type", { presentationRelType: `${R}/slideLayout` }, /presentation|slide relationship|unsupported relationship/i],
    ["duplicate presentation relationship ID", { duplicatePresentationRelId: true }, /presentation|duplicate.*relationship/i],
    ["extra package external relationship", { extraPackageRelationship: "external" }, /external relationship/i],
    ["extra package unsupported relationship", { extraPackageRelationship: "unsupported" }, /unsupported relationship/i],
  ];
  for (const [name, donorOptions, pattern] of scenarios) await t.test(name, async (subtest) => { const fixture = await activationFixture(subtest); await writeFile(join(fixture.outputRoot, "slide-editable.pptx"), await donorPptx(donorOptions)); await refreshConversionEvidence(fixture); await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), pattern); });
});

test("rejects target identity, index, output-path, and staging races without replacing the candidate", async (t) => {
  const fixture = await activationFixture(t);
  const before = await readFile(fixture.candidatePath);
  await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 3, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /slide index|range/i);
  await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 0, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /slide index|topology|position/i);
  await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[0]!, conversionRoot: fixture.conversionRoot }), /slide identity|target/i);
  const outside = join(dirname(dirname(dirname(fixture.candidatePath))), "outside.pptx"); await writeFile(outside, before);
  await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: outside, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /deck-revisions|owned|candidate path/i);
  assert.deepEqual(await readFile(fixture.candidatePath), before);
  await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot, operations: { beforeAtomicReplace: async () => writeFile(fixture.candidatePath, await targetDeckBytes(4)) } }), /changed during staging|race/i);
});

test("requires a sealed current conversion before mutating candidate bytes", async (t) => {
  await t.test("missing sealed marker", async (subtest) => {
    const fixture = await activationFixture(subtest);
    const before = await readFile(fixture.candidatePath);
    await unlink(join(fixture.conversionRoot, ".superppt-editable-revision.json"));
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /sealed|revision marker|ownership/i);
    assert.deepEqual(await readFile(fixture.candidatePath), before);
  });
  await t.test("staging marker", async (subtest) => {
    const fixture = await activationFixture(subtest);
    await writeFile(join(fixture.conversionRoot, ".superppt-editable-conversion-staging.json"), "{}\n");
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /staging|sealed/i);
  });
  await t.test("stale project revision", async (subtest) => {
    const fixture = await activationFixture(subtest);
    const record = JSON.parse(await readFile(fixture.recordPath, "utf8")); record.projectRevisionId = randomUUID();
    record.prepareEditableInput.sourceMaster.revisionId = record.projectRevisionId; record.prepareEditableInput.output1280x720.revisionId = record.projectRevisionId;
    await writeFile(fixture.recordPath, `${JSON.stringify(record, null, 2)}\n`);
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /stale|project page|revision/i);
  });
  await t.test("stale reviewed candidate selection", async (subtest) => {
    const fixture = await activationFixture(subtest);
    const record = JSON.parse(await readFile(fixture.recordPath, "utf8")); record.deckReviewSelection.candidateId = randomUUID();
    await writeFile(fixture.recordPath, `${JSON.stringify(record, null, 2)}\n`);
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /stale|candidate selection/i);
  });
});

test("recovers idempotently after every activation persistence checkpoint", async (t) => {
  for (const phase of ["candidate-replaced", "session-updated", "journal-updated"] as const) await t.test(phase, async (subtest) => {
    const fixture = await activationFixture(subtest);
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot, operations: { checkpoint: async (actual) => { if (actual === phase) throw new Error("simulated crash"); } } }), /simulated crash/);
    const recovered = await activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot });
    assert.deepEqual(recovered.editableSlideIds, [fixture.slideIds[1]!]);
  });
});

test("fails closed when durable activation residue no longer matches its intent", async (t) => {
  const fixture = await activationFixture(t);
  await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot, operations: { checkpoint: (phase) => { if (phase === "candidate-replaced") throw new Error("simulated crash"); } } }), /simulated crash/);
  const intentPath = join(fixture.root, "output", "deck-edit-sessions", fixture.sessionId, "activation.json");
  const intent = JSON.parse(await readFile(intentPath, "utf8")); intent.newCandidateSha256 = "0".repeat(64); await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
  await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /residue|durable|hash/i);
});

test("serializes authoritative project mutation through final candidate publication", async (t) => {
  const fixture = await activationFixture(t);
  const events: string[] = [];
  let reachedStaging!: () => void;
  let releasePublication!: () => void;
  const staging = new Promise<void>((resolve) => { reachedStaging = resolve; });
  const release = new Promise<void>((resolve) => { releasePublication = resolve; });
  const activation = activateEditableSlideInDeck({
    projectRoot: fixture.root,
    candidatePath: fixture.candidatePath,
    slideIndex: 1,
    slideId: fixture.slideIds[1]!,
    conversionRoot: fixture.conversionRoot,
    operations: { beforeAtomicReplace: async () => { reachedStaging(); await release; } },
  }).then((result) => { events.push("activation-published"); return result; });
  await staging;
  const authorityMutation = updateProject(fixture.root, (project) => ({ ...project, stage: "generation-authorization" }))
    .then(() => { events.push("authority-changed"); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  releasePublication();
  await Promise.all([activation, authorityMutation]);
  assert.deepEqual(events, ["activation-published", "authority-changed"]);
});

test("merges only namespaces used by the donor shape tree and accepts a local override", async (t) => {
  const fixture = await activationFixture(t);
  await writeFile(join(fixture.outputRoot, "slide-editable.pptx"), await donorPptx({ localRedeclaration: true }));
  await refreshConversionEvidence(fixture);
  await activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot });
  const zip = await JSZip.loadAsync(await readFile(fixture.candidatePath));
  const xml = await zip.file("ppt/slides/slide2.xml")!.async("string");
  assert.equal((xml.match(/xmlns:unused=/g) ?? []).length, 1);
  assert.match(xml, /xmlns:unused="urn:local-override"/);
});

test("transplants an unprefixed shape tree that inherits the default PresentationML namespace", async (t) => {
  const fixture = await activationFixture(t);
  await writeFile(join(fixture.outputRoot, "slide-editable.pptx"), await donorPptx({ defaultNamespace: true }));
  await refreshConversionEvidence(fixture);
  const result = await activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot });
  const zip = await JSZip.loadAsync(await readFile(fixture.candidatePath));
  const xml = await zip.file("ppt/slides/slide2.xml")!.async("string");
  assert.match(xml, new RegExp(`xmlns="${P}"`));
  assert.equal(result.targetInspection.editableTextCount, 1);
});

test("authenticates all official QA previews and scene-graph pair evidence", async (t) => {
  await t.test("tampered QA preview", async (subtest) => {
    const fixture = await activationFixture(subtest); await writeFile(join(fixture.outputRoot, "layer-review.png"), await png(1280, 720, true));
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /QA preview|hash mismatch/i);
  });
  await t.test("scene graph output without hash", async (subtest) => {
    const fixture = await activationFixture(subtest); const ledgerPath = join(fixture.outputRoot, "run-ledger.json"); const ledger = JSON.parse(await readFile(ledgerPath, "utf8")); delete ledger.hashes.sceneGraph;
    const bytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`); await writeFile(ledgerPath, bytes); const record = JSON.parse(await readFile(fixture.recordPath, "utf8")); record.artifacts.runLedger = digest(bytes); await writeFile(fixture.recordPath, `${JSON.stringify(record, null, 2)}\n`);
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /scene graph|run ledger/i);
  });
});

test("validates staged target relationships, media paths, and PNG content types", async (t) => {
  await t.test("duplicate existing relationship ID", async (subtest) => {
    const fixture = await activationFixture(subtest); await replaceCandidateFixture(fixture, async (zip) => { const part = "ppt/slides/_rels/slide2.xml.rels"; const xml = await zip.file(part)!.async("string"); zip.file(part, xml.replace('Id="rId7"', 'Id="rId1"')); });
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /duplicate or missing IDs/i);
  });
  await t.test("missing relationship target", async (subtest) => {
    const fixture = await activationFixture(subtest); await replaceCandidateFixture(fixture, async (zip) => { const part = "ppt/slides/_rels/slide2.xml.rels"; const xml = await zip.file(part)!.async("string"); zip.file(part, xml.replace(' Target="../comments/comment2.xml"', "")); });
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /duplicate or missing IDs/i);
  });
  await t.test("missing existing relationship target", async (subtest) => {
    const fixture = await activationFixture(subtest); await replaceCandidateFixture(fixture, (zip) => { zip.remove("ppt/slideLayouts/slideLayout1.xml"); });
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /relationship target is missing/i);
  });
  await t.test("above-root relationship target", async (subtest) => {
    const fixture = await activationFixture(subtest); await replaceCandidateFixture(fixture, async (zip) => { const part = "ppt/slides/_rels/slide2.xml.rels"; const xml = await zip.file(part)!.async("string"); zip.file(part, xml.replace("../comments/comment2.xml", "../../../evil.xml")); zip.file("evil.xml", "<evil/>"); });
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /escape|traversal|unsafe target/i);
  });
  for (const [name, replacement] of [["missing relationship Type", ""], ["empty relationship Type", ' Type=""']] as const) await t.test(name, async (subtest) => {
    const fixture = await activationFixture(subtest); await replaceCandidateFixture(fixture, async (zip) => { const part = "ppt/slides/_rels/slide2.xml.rels"; const xml = await zip.file(part)!.async("string"); zip.file(part, xml.replace(/ Type="[^"]+"/, replacement)); });
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /missing.*Type|relationship.*Type|required fields/i);
  });
  await t.test("distinct relationship IDs may share one internal target", async (subtest) => {
    const fixture = await activationFixture(subtest); await replaceCandidateFixture(fixture, async (zip) => { const part = "ppt/slides/_rels/slide2.xml.rels"; const xml = await zip.file(part)!.async("string"); zip.file(part, xml.replace("</pkg:Relationships>", `<pkg:Relationship Id="rId20" Type="${IMAGE_REL}" Target="../media/shared.png"/><pkg:Relationship Id="rId21" Type="${IMAGE_REL}" Target="../media/shared.png"/></pkg:Relationships>`)); zip.file("ppt/media/shared.png", await png(12, 12, true)); });
    await activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot });
  });
  await t.test("missing PNG content type", async (subtest) => {
    const fixture = await activationFixture(subtest); await replaceCandidateFixture(fixture, async (zip) => { const xml = await zip.file("[Content_Types].xml")!.async("string"); zip.file("[Content_Types].xml", xml.replace(/<Default Extension="png"[^>]*\/>/, "")); });
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot }), /PNG media content types/i);
  });
  await t.test("generated media collision", async (subtest) => {
    const fixture = await activationFixture(subtest);
    await assert.rejects(activateEditableSlideInDeck({ projectRoot: fixture.root, candidatePath: fixture.candidatePath, slideIndex: 1, slideId: fixture.slideIds[1]!, conversionRoot: fixture.conversionRoot, operations: { mediaNameFactory: () => "superppt-collision.png" } }), /media path collides/i);
  });
});
