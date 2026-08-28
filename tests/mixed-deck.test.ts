import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import {
  assembleDeck,
  assembleProjectCandidate,
  readProjectAcceptance,
  replaceSlide,
  validateQuarantinedOutput,
  type FinalRender,
} from "../src/deck/assemble.js";
import * as deckAssembly from "../src/deck/assemble.js";
import { buildMontage } from "../src/deck/montage.js";
import { exportPdf } from "../src/deck/pdf.js";
import { convertProjectPage } from "../src/editable/adapter.js";
import { resolveSkillDependencies } from "../src/dependencies/resolve.js";
import type { ResolvedDependencies } from "../src/dependencies/schemas.js";
import { configureGenerationAuthorizationTrustForTests } from "../src/generation/trusted-authorization.js";
import { applyProjectEditPlan, promoteProjectEditableTarget } from "../src/editable/operations.js";
import { confirmEditablePreview, renderEditablePage, renderProjectEditablePreview } from "../src/editable/render.js";
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

async function mixedOutputs(
  renders: FinalRender[],
  paths: { pptx: string; pdf: string; montage: string },
): Promise<void> {
  await assembleDeck(renders, paths.pptx);
  await exportPdf(renders, paths.pdf);
  await buildMontage(renders, paths.montage);
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
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.1.0",
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  })}\n`);
  await writeFile(join(root, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  return root;
}

async function resolvedDependencies(
  t: TestContext,
  editableRoot: string,
): Promise<ResolvedDependencies> {
  const aiRoot = join(await temporary(t, "superppt-mixed-ai-skill-"), "ai-image-to-ppt");
  await mkdir(join(aiRoot, "scripts"), { recursive: true });
  await writeFile(join(aiRoot, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  for (const script of [
    "generation_result.py",
    "host_routing_policy.py",
    "import_host_image.py",
    "prepare_editable_input.py",
  ]) {
    await writeFile(join(aiRoot, "scripts", script), `# fixture ${script}\n`);
  }
  return resolveSkillDependencies({ aiSkillRoot: aiRoot, editableSkillRoot: editableRoot });
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

test("prepare editable input and selected page replacement invalidate only the reviewed candidate", async (t) => {
  const reviewed = await reviewedProject(t, "edit-page");
  const { root } = reviewed;
  const before = await readProject(root);
  const untouched = before.slides
    .filter((slide) => slide.id !== slideIds[1])
    .map((slide) => structuredClone(slide));
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
  const preview = await renderProjectEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: modified.revisionId,
    expectedModifiedRevisionRecordSha256: recordSha256,
  });
  await confirmEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: modified.revisionId,
    expectedModifiedRevisionRecordSha256: recordSha256,
    preview: join(root, preview.preview.path),
  });

  const applyEditableReplacement = (deckAssembly as unknown as {
    applyEditableReplacement?: (options: {
      root: string;
      slideId: string;
      modifiedRevisionId: string;
      expectedModifiedRevisionRecordSha256: string;
    }) => Promise<unknown>;
  }).applyEditableReplacement;
  assert.equal(typeof applyEditableReplacement, "function", "candidate-first editable replacement API must exist");
  await applyEditableReplacement!({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: modified.revisionId,
    expectedModifiedRevisionRecordSha256: recordSha256,
  });
  await assertImmutableArtifactBytes();

  const after = await readProject(root);
  assert.equal(after.stage, "revising");
  assert.equal(after.slides[1]!.status, "editable");
  assert.equal(after.slides[1]!.editableRevision?.modifiedRevisionId, modified.revisionId);
  assert.deepEqual(after.slides.filter((slide) => slide.id !== slideIds[1]), untouched);
  assert.deepEqual(after.style, styleArtifact);
  assert.deepEqual(await readFile(join(root, "style/lock.json")), styleLockBytes);
  assert.deepEqual(after.gates
    .filter((gate) => ["outline", "slide-specs", "style-sample", "generation-authorization"].includes(gate.gate))
    .map((gate) => ({ gate: gate.gate, approvalId: gate.approvalId, snapshotPath: gate.snapshotPath })), initialGates);
  assert.deepEqual(after.gates.filter((gate) => gate.gate === "deck-review"), historicalDeckReviewGates);
  assert.equal(after.gates.some((gate) => gate.gate === "slide-preview"), true);
  for (const name of ["action.json", "review.json", "montage.jpg"]) {
    await assert.rejects(lstat(join(root, "output/candidates/current", name)), { code: "ENOENT" });
  }
  await assert.rejects(publishDeckReview(root, reviewed.candidateId), /stale|current project revision|candidate/);

  const rebuilt = await assembleProjectCandidate(root, { buildOutputs: mixedOutputs });
  assert.notEqual(rebuilt.candidateId, reviewed.candidateId);
  const rebuiltReview = await publishDeckReview(root, rebuilt.candidateId);
  assert.equal(rebuiltReview.candidateId, rebuilt.candidateId);
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
  const refreshedDependencies = await resolveSkillDependencies({
    aiSkillRoot: dependencies.ai.root,
    editableSkillRoot: dependencies.editable.root,
  });
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
  const { root } = await reviewedProject(t, "edit-page");
  const original = await readProject(root);
  const initialAction = JSON.parse(await readFile(join(root, "output/candidates/current/action.json"), "utf8"));
  assert.equal(initialAction.action, "edit-page");
  assert.equal(initialAction.slideId, slideIds[1]);
  assert.equal(initialAction.candidateId, JSON.parse(await readFile(join(root, "output/candidates/current/review.json"), "utf8")).candidateId);
  const untouchedBefore = original.slides[0]!.finalRender!;
  const initialExports = original.exports;
  const plugin = await converterRoot(t);
  const dependencies = await resolvedDependencies(t, plugin);
  let conversionCalls = 0;
  const converted = await convertProjectPage({
    root,
    slideId: slideIds[1],
    converterRoot: plugin,
    dependencies,
    prepareExecute: async (_command, args) => {
      await sharp(await readFile(args[1]!)).resize(1280, 720).png().toFile(args[2]!);
      return { stdout: `  OK: ${args[2]} (1280x720 PNG, editable-converter input)\n`, stderr: "" };
    },
    execute: async (_command, args) => {
      conversionCalls += 1;
      const source = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, source);
      return { stdout: "", stderr: "" };
    },
  });
  const firstEdit = await promoteProjectEditableTarget({
    root,
    slideId: slideIds[1],
    sourceRevisionId: converted.revisionId,
    elementId: "ocr-title",
    expectedKind: "text",
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

  const completePreviewBytes = await readFile(join(root, firstPreview.preview.path));
  const truncatedPreviewBytes = completePreviewBytes.subarray(0, 256);
  assert.deepEqual([
    (await sharp(truncatedPreviewBytes).metadata()).width,
    (await sharp(truncatedPreviewBytes).metadata()).height,
  ], [1920, 1080]);
  await writeFile(join(root, firstPreview.preview.path), truncatedPreviewBytes);
  const beforeTruncatedPreview = await readProject(root);
  await assert.rejects(confirmEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
    preview: join(root, firstPreview.preview.path),
  }), /complete 1920x1080 PNG/);
  assert.deepEqual(await readProject(root), beforeTruncatedPreview);
  const truncatedBinding = {
    ...firstPreview,
    preview: { ...firstPreview.preview, sha256: sha256(truncatedPreviewBytes) },
  };
  await assert.rejects(updateProject(root, (current) => ({
    ...current,
    gates: [...current.gates, {
      gate: "slide-preview" as const,
      revisionId: current.currentRevision.id,
      artifactHashes: {
        [truncatedBinding.modifiedRevisionRecordPath]: truncatedBinding.expectedModifiedRevisionRecordSha256,
        [truncatedBinding.preview.path]: truncatedBinding.preview.sha256,
      },
      slidePreview: truncatedBinding,
      confirmedAt: new Date().toISOString(),
    }],
  })), /slide preview gate evidence is invalid/);
  assert.deepEqual(await readProject(root), beforeTruncatedPreview);
  await writeFile(join(root, firstPreview.preview.path), completePreviewBytes);

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

  const alternateEdit = await applyProjectEditPlan({
    root,
    slideId: slideIds[1],
    sourceRevisionId: converted.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "并发候选 B" }] },
  });
  const alternateRecordSha256 = sha256(await readFile(join(alternateEdit.revisionRoot, "modified-revision-record.json")));
  const alternatePreview = await renderProjectEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: alternateEdit.revisionId,
    expectedModifiedRevisionRecordSha256: alternateRecordSha256,
  });
  await confirmEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: alternateEdit.revisionId,
    expectedModifiedRevisionRecordSha256: alternateRecordSha256,
    preview: join(root, alternatePreview.preview.path),
  });
  const beforeAtomicReplacement = await readProject(root);
  await assert.rejects(replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
    operations: { buildOutputs: async () => { throw new Error("replacement build failure probe"); } },
  }), /replacement build failure probe/);
  assert.deepEqual(await readProject(root), beforeAtomicReplacement);
  await assert.rejects(replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
    operations: {
      buildOutputs: async (renders, paths) => {
        await mixedOutputs(renders, paths);
        await tamperEditableBackground(paths.pptx);
      },
    },
  }), /editable background media hash mismatch/);
  assert.deepEqual(await readProject(root), beforeAtomicReplacement);

  let releaseBuild!: () => void;
  let markBuildStarted!: () => void;
  const buildStarted = new Promise<void>((resolveStarted) => { markBuildStarted = resolveStarted; });
  const buildRelease = new Promise<void>((resolveRelease) => { releaseBuild = resolveRelease; });
  const firstReplacementPromise = replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: firstEdit.revisionId,
    expectedModifiedRevisionRecordSha256: firstRecordSha256,
    operations: {
      buildOutputs: async (renders, paths) => {
        markBuildStarted();
        await buildRelease;
        await mixedOutputs(renders, paths);
      },
    },
  });
  await buildStarted;
  assert.deepEqual(await readProject(root), beforeAtomicReplacement);
  const alternateReplacementOutcome = replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: alternateEdit.revisionId,
    expectedModifiedRevisionRecordSha256: alternateRecordSha256,
    operations: { buildOutputs: mixedOutputs },
  }).then(
    (value) => ({ value, error: null as Error | null }),
    (error: Error) => ({ value: null, error }),
  );
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(await readProject(root), beforeAtomicReplacement);
  releaseBuild();
  const firstReplacement = await firstReplacementPromise;
  const alternateOutcome = await alternateReplacementOutcome;
  assert.equal(alternateOutcome.value, null);
  assert.match(alternateOutcome.error?.message ?? "", /confirmed slide preview is stale|slide-replacement lease timed out/);
  assert.equal(firstReplacement.artifacts.pptx.path, "output/revisions/2/deck.pptx");
  const afterFirst = await readProject(root);
  assert.equal(firstReplacement.revisionNumber, 2);
  assert.equal(afterFirst.deckRevision, 2);
  assert.equal(afterFirst.slides[1]!.editableRevision?.modifiedRevisionId, firstEdit.revisionId);
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
  assert.match(firstEditableXml, /原始标题/);
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
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "A & B <示例>\n第二行" }] },
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
    operations: {
      buildOutputs: async (renders, paths) => {
        await mixedOutputs(renders, paths);
        await splitEscapedEditableTextRuns(paths.pptx);
      },
    },
  });
  const afterSecond = await readProject(root);
  assert.equal(afterSecond.deckRevision, 3);
  assert.equal(afterSecond.outputRevisions?.length, 2);
  assert.deepEqual(afterSecond.slides[0]!.finalRender, untouchedBefore);
  assert.equal(conversionCalls, 1);
  const secondDeck = await JSZip.loadAsync(await readFile(join(root, afterSecond.exports.pptx!.path)));
  const secondEditableXml = await secondDeck.file("ppt/slides/slide2.xml")!.async("text");
  assert.doesNotMatch(secondEditableXml, /A &amp; B &lt;示例&gt;/);
  assert.match(secondEditableXml, /A &amp; <\/a:t>[\s\S]*B &lt;示例&gt;/);
  assert.match(secondEditableXml, /第二行/);

  const orphanEdit = await applyProjectEditPlan({
    root,
    slideId: slideIds[1],
    sourceRevisionId: secondEdit.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "孤儿候选 A" }] },
  });
  const orphanRecordSha256 = sha256(await readFile(join(orphanEdit.revisionRoot, "modified-revision-record.json")));
  const orphanPreview = await renderProjectEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: orphanEdit.revisionId,
    expectedModifiedRevisionRecordSha256: orphanRecordSha256,
  });
  await confirmEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: orphanEdit.revisionId,
    expectedModifiedRevisionRecordSha256: orphanRecordSha256,
    preview: join(root, orphanPreview.preview.path),
  });
  const selectedEdit = await applyProjectEditPlan({
    root,
    slideId: slideIds[1],
    sourceRevisionId: secondEdit.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "最终候选 B" }] },
  });
  const selectedRecordSha256 = sha256(await readFile(join(selectedEdit.revisionRoot, "modified-revision-record.json")));
  const selectedPreview = await renderProjectEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: selectedEdit.revisionId,
    expectedModifiedRevisionRecordSha256: selectedRecordSha256,
  });
  await confirmEditablePreview({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: selectedEdit.revisionId,
    expectedModifiedRevisionRecordSha256: selectedRecordSha256,
    preview: join(root, selectedPreview.preview.path),
  });
  const beforeOrphanCrash = await readProject(root);
  await assert.rejects(replaceSlide({
    root,
    slideId: slideIds[1],
    modifiedRevisionId: orphanEdit.revisionId,
    expectedModifiedRevisionRecordSha256: orphanRecordSha256,
    operations: {
      buildOutputs: mixedOutputs,
      checkpoint: (step) => {
        if (step === "output-promoted") throw new Error("replacement promotion crash probe");
      },
    },
  }), /replacement promotion crash probe/);
  assert.deepEqual(await readProject(root), beforeOrphanCrash);
  const orphanDestination = join(root, "output/revisions/4");
  const orphanMarkerPath = join(orphanDestination, ".superppt-output.json");
  const projectManifestPath = join(root, "superppt.json");
  const orphanMarkerBytes = await readFile(orphanMarkerPath);
  const orphanMarker = JSON.parse(orphanMarkerBytes.toString("utf8"));
  assert.equal(orphanMarker.slides[1].sha256, orphanPreview.preview.sha256);

  const selectedReplacementOptions = {
    root,
    slideId: slideIds[1],
    modifiedRevisionId: selectedEdit.revisionId,
    expectedModifiedRevisionRecordSha256: selectedRecordSha256,
    operations: { buildOutputs: mixedOutputs },
  };
  const assertConflictPreserved = async (
    options: Parameters<typeof replaceSlide>[0] = selectedReplacementOptions,
    expectedError = /deck output destination is not owned|owned output evidence is invalid|conflicting replacement output|replacement orphan candidate/,
  ): Promise<void> => {
    const beforeConflict = await outputDirectorySnapshot(orphanDestination);
    const revisionsRoot = join(root, "output/revisions");
    const revisionsBefore = (await readdir(revisionsRoot)).sort();
    await assert.rejects(
      replaceSlide(options),
      expectedError,
    );
    assert.deepEqual(await outputDirectorySnapshot(orphanDestination), beforeConflict);
    assert.deepEqual((await readdir(revisionsRoot)).sort(), revisionsBefore);
  };

  const extraPath = join(orphanDestination, "arbitrary-extra.bin");
  await writeFile(extraPath, "extra candidate bytes");
  await assertConflictPreserved();
  await rm(extraPath);

  const orphanMontagePath = join(orphanDestination, "montage.jpg");
  const orphanMontageBytes = await readFile(orphanMontagePath);
  const linkTarget = join(await temporary(t, "superppt-orphan-link-target-"), "montage.jpg");
  await writeFile(linkTarget, orphanMontageBytes);
  await rm(orphanMontagePath);
  await symlink(linkTarget, orphanMontagePath);
  await assertConflictPreserved();
  await rm(orphanMontagePath);
  await writeFile(orphanMontagePath, orphanMontageBytes);

  const orphanAcceptancePath = join(orphanDestination, "acceptance.json");
  const orphanAcceptanceBytes = await readFile(orphanAcceptancePath);
  await rm(orphanAcceptancePath);
  await mkdir(orphanAcceptancePath);
  await writeFile(join(orphanAcceptancePath, "nested.bin"), "nested bytes");
  await assertConflictPreserved();
  await rm(orphanAcceptancePath, { recursive: true });
  await writeFile(orphanAcceptancePath, orphanAcceptanceBytes);

  const preexistingDescriptor = join(orphanDestination, ".superppt-quarantine.json");
  await writeFile(preexistingDescriptor, "preexisting descriptor bytes");
  await assertConflictPreserved();
  await rm(preexistingDescriptor);

  for (const checkpoint of [
    "descriptor-staged",
    "output-quarantined",
    "descriptor-promoted",
    "descriptor-validated",
  ] as const) {
    await assertConflictPreserved({
      ...selectedReplacementOptions,
      operations: {
        buildOutputs: mixedOutputs,
        quarantineCheckpoint: (step) => {
          if (step === checkpoint) throw new Error(`quarantine ${checkpoint} probe`);
        },
      },
    }, new RegExp(`quarantine ${checkpoint} probe`));
  }

  const descriptorCollisionBytes = Buffer.from("preexisting collision descriptor");
  const revisionsBeforeCollision = (await readdir(join(root, "output/revisions"))).sort();
  let collisionSnapshot: Awaited<ReturnType<typeof outputDirectorySnapshot>> | null = null;
  await assert.rejects(replaceSlide({
    ...selectedReplacementOptions,
    operations: {
      buildOutputs: mixedOutputs,
      quarantineCheckpoint: async (step, paths) => {
        if (step === "output-quarantined") {
          await writeFile(join(paths.quarantine, ".superppt-quarantine.json"), descriptorCollisionBytes, { flag: "wx" });
          collisionSnapshot = await outputDirectorySnapshot(paths.quarantine);
        }
      },
    },
  }), /already exists|EEXIST|descriptor|unexpected entries/i);
  assert.ok(collisionSnapshot);
  assert.deepEqual(await outputDirectorySnapshot(orphanDestination), collisionSnapshot);
  assert.deepEqual((await readdir(join(root, "output/revisions"))).sort(), revisionsBeforeCollision);
  assert.deepEqual(await readFile(preexistingDescriptor), descriptorCollisionBytes);
  await rm(preexistingDescriptor);

  await writeFile(orphanMarkerPath, "{}\n");
  await assertConflictPreserved();
  await writeFile(orphanMarkerPath, orphanMarkerBytes);

  const tamperedMarker = structuredClone(orphanMarker);
  tamperedMarker.artifacts.pptx.sha256 = "0".repeat(64);
  await writeFile(orphanMarkerPath, `${JSON.stringify(tamperedMarker, null, 2)}\n`);
  await assertConflictPreserved();
  await writeFile(orphanMarkerPath, orphanMarkerBytes);

  const orphanPptxPath = join(orphanDestination, "deck.pptx");
  const orphanPptxBytes = await readFile(orphanPptxPath);
  await writeFile(orphanPptxPath, Buffer.concat([orphanPptxBytes, Buffer.from("tampered")]));
  await assertConflictPreserved();
  await writeFile(orphanPptxPath, orphanPptxBytes);

  for (const markerIdentity of [
    { projectId: "00000000-0000-4000-8000-000000000999" },
    { revisionId: "00000000-0000-4000-8000-000000000998" },
    { revisionNumber: 5 },
  ]) {
    await writeFile(orphanMarkerPath, `${JSON.stringify({ ...orphanMarker, ...markerIdentity }, null, 2)}\n`);
    await assertConflictPreserved();
  }
  await writeFile(orphanMarkerPath, orphanMarkerBytes);

  const projectManifestBytes = await readFile(projectManifestPath);
  const referencedByCurrent = JSON.parse(projectManifestBytes.toString("utf8"));
  referencedByCurrent.exports.pptx = orphanMarker.artifacts.pptx;
  await writeFile(projectManifestPath, `${JSON.stringify(referencedByCurrent, null, 2)}\n`);
  await assertConflictPreserved();
  await writeFile(projectManifestPath, projectManifestBytes);

  const referencedByHistory = JSON.parse(projectManifestBytes.toString("utf8"));
  referencedByHistory.outputRevisions.push({
    number: 4,
    projectRevisionId: referencedByHistory.currentRevision.id,
    createdAt: new Date().toISOString(),
    slides: orphanMarker.slides.map((slide: { id: string; order: number; mode: "image" | "editable"; path: string; sha256: string }) => ({
      id: slide.id,
      order: slide.order,
      mode: slide.mode,
      finalRender: { path: slide.path, sha256: slide.sha256, revisionId: referencedByHistory.currentRevision.id },
      editable: slide.mode === "editable" ? orphanPreview.modifiedManifest : null,
    })),
    exports: orphanMarker.artifacts,
  });
  await writeFile(projectManifestPath, `${JSON.stringify(referencedByHistory, null, 2)}\n`);
  await assertConflictPreserved();
  await writeFile(projectManifestPath, projectManifestBytes);

  const selectedReplacement = await replaceSlide(selectedReplacementOptions);
  assert.equal(selectedReplacement.revisionNumber, 4);
  const afterSelected = await readProject(root);
  assert.equal(afterSelected.slides[1]!.editableRevision?.modifiedRevisionId, selectedEdit.revisionId);
  const quarantines = (await readdir(join(root, "output/revisions"))).filter((name) => /^\.failed-4-[0-9a-f-]+$/.test(name));
  assert.equal(quarantines.length, 1);
  const quarantine = await validateQuarantinedOutput(root, `output/revisions/${quarantines[0]!}`);
  assert.equal(quarantine.projectId, afterSelected.projectId);
  assert.equal(quarantine.revisionId, afterSelected.currentRevision.id);
  assert.equal(quarantine.revisionNumber, 4);
  assert.equal(quarantine.originalPath, "output/revisions/4");
  assert.equal(quarantine.quarantinePath, `output/revisions/${quarantines[0]!}`);
  assert.equal(quarantine.reason, "superseded-editable-replacement-candidate");
  assert.equal(Number.isFinite(Date.parse(quarantine.quarantinedAt)), true);
  assert.equal(quarantine.candidateMarkerSha256, sha256(orphanMarkerBytes));
  assert.deepEqual(Object.values(quarantine.artifacts).map((artifact) => artifact.quarantineRelativePath).sort(), [
    "acceptance.json",
    "deck.pdf",
    "deck.pptx",
    "montage.jpg",
  ]);
  const selectedMarker = JSON.parse(await readFile(join(root, "output/revisions/4/.superppt-output.json"), "utf8"));
  assert.equal(selectedMarker.slides[1].sha256, selectedPreview.preview.sha256);
});
