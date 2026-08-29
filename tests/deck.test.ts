import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { buildAcceptance } from "../src/acceptance/build.js";
import { createClientSmokeCopy } from "../src/acceptance/smoke-copy.js";
import { AcceptanceSchema } from "../src/acceptance/schema.js";
import { configureGenerationAuthorizationTrustForTests } from "../src/generation/trusted-authorization.js";
import {
  assembleDeck,
  assembleProjectCandidate,
  readProjectAcceptance,
  recordClientAcceptance,
  type AssembleProjectOperations,
  type FinalRender,
} from "../src/deck/assemble.js";
import { exportPdf } from "../src/deck/pdf.js";
import { buildMontage } from "../src/deck/montage.js";
import { approveGate, assertGateCurrent } from "../src/planning/confirm.js";
import { publishPlanViews } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import {
  applyDeckReviewAction,
  authenticateCurrentDeckEditSelection,
  promoteApprovedCandidate,
  publishDeckReview,
} from "../src/project/promotion.js";
import { ClientSmokeCopyAnchorSchema } from "../src/project/schemas.js";
import { readProject, updateProject } from "../src/project/store.js";
import * as projectStore from "../src/project/store.js";
import { applyRevision, approveImpact, publishImpactPlan } from "../src/revisions/apply.js";
import { finalizeDelegatedStyleSampleForTest } from "./helpers/delegated-style-sample.js";

const execFileAsync = promisify(execFile);

async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "superppt-deck-")));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function image(path: string, color: string): Promise<{ path: string; sha256: string }> {
  await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: color },
  }).png().toFile(path);
  const bytes = await readFile(path);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const PROJECT_SLIDES = [
  "00000000-0000-4000-8000-000000000821",
  "00000000-0000-4000-8000-000000000822",
  "00000000-0000-4000-8000-000000000823",
] as const;

async function readyProject(t: TestContext): Promise<{ root: string; revisionId: string }> {
  const parent = await directory(t);
  const root = join(parent, "project");
  await initializeProject({ root, title: "Deck Demo" });
  await writeFile(join(root, "brief.json"), `${JSON.stringify({
    schemaVersion: 1,
    title: "Deck Demo",
    purpose: "Delivery test",
    audience: "Testers",
    language: "en",
    targetSlides: 3,
    mustCover: ["Opening", "Middle", "Closing"],
    constraints: ["16:9"],
  })}\n`);
  const outline = {
    schemaVersion: 1,
    slides: PROJECT_SLIDES.map((id, order) => ({
      id,
      order,
      title: order === 0 ? "Opening" : order === 1 ? "Middle" : "Closing",
      role: order === 0 ? "cover" : order === 1 ? "content" : "summary",
      purpose: order === 0 ? "Open" : order === 1 ? "Develop" : "Close",
      sourceRefs: [`L${order + 1}`],
    })),
  };
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline)}\n`);
  for (const slide of outline.slides) {
    const slideRoot = join(root, "slides", slide.id);
    await mkdir(slideRoot);
    await writeFile(join(slideRoot, "spec.json"), `${JSON.stringify({
      schemaVersion: 1,
      slideId: slide.id,
      title: slide.title,
      role: slide.role,
      coreMessage: slide.purpose,
      requiredText: [slide.title],
      visualSubject: "One central subject",
      composition: "Full bleed",
      relationships: [],
      forbidden: ["watermark"],
      sourceRefs: slide.sourceRefs,
    })}\n`);
  }
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
    schemaVersion: 1,
    styleId: "cinematic-tech",
    representativeSlideId: PROJECT_SLIDES[0],
  })}\n`);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await finalizeDelegatedStyleSampleForTest(root);

  const manifest = await readProject(root);
  const artifacts = await Promise.all(PROJECT_SLIDES.map(async (id, order) => {
    const attempt = join(root, "images", id, "attempt-1");
    await mkdir(attempt, { recursive: true });
    const generated = await image(join(attempt, "slide.png"), order === 0 ? "#aa2211" : "#1144aa");
    await writeFile(join(attempt, "ledger.json"), `${JSON.stringify({
      ledgerVersion: 1,
      slideId: id,
      revisionId: manifest.currentRevision.id,
      attempt: 1,
      providerId: "ledger-provider",
      promptSha256: "a".repeat(64),
      promptPurged: true,
      output: `images/${id}/attempt-1/slide.png`,
      outputSha256: generated.sha256,
      outputBytes: (await readFile(generated.path)).length,
      durationMs: 1,
      quality: {
        ok: true,
        issueCount: 0,
        issueHashes: [],
        issueCodes: [],
        requiredText: [{
          textSha256: createHash("sha256").update(outline.slides[order]!.title).digest("hex"),
          present: true,
          exact: true,
        }],
        styleConsistent: true,
        hierarchyClear: true,
        richDetail: true,
        noForbiddenContent: true,
      },
      outcome: "accepted",
      errorCode: null,
    }, null, 2)}\n`);
    return generated;
  }));
  await updateProject(root, (current) => ({
    ...current,
    stage: "generating",
    slides: PROJECT_SLIDES.map((id, order) => ({
      id,
      order,
      title: outline.slides[order]!.title,
      role: outline.slides[order]!.role as "cover" | "content" | "summary",
      specRevisionId: manifest.currentRevision.id,
      promptRevisionId: manifest.currentRevision.id,
      styleRevisionId: manifest.currentRevision.id,
      status: "ready" as const,
      image: {
        path: `images/${id}/attempt-1/slide.png`,
        sha256: artifacts[order]!.sha256,
        revisionId: manifest.currentRevision.id,
      },
      editable: null,
      finalRender: null,
      staleReasons: [],
    })),
  }));
  return { root, revisionId: manifest.currentRevision.id };
}

async function fakeOutputs(renders: FinalRender[], paths: { pptx: string; pdf: string; montage: string }): Promise<void> {
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

async function authorizeDeckGeneration(root: string): Promise<void> {
  await configureGenerationAuthorizationTrustForTests(root, {
    root: join(root, "..", "authorization-trust"),
    deterministicKeySeed: `superppt-deck-test:${root}`,
  });
  await mkdir(join(root, "generation"), { recursive: true });
  await writeFile(join(root, "generation", "authorization-plan.json"), `${JSON.stringify({
    styleLockSha256: "a".repeat(64),
    pageIds: PROJECT_SLIDES,
    callBudget: PROJECT_SLIDES.length,
    outboundDisclosure: { sendsText: true, references: [] },
    dependency: { kind: "ai-image-to-ppt", sha256: "b".repeat(64) },
    revisionId: (await readProject(root)).currentRevision.id,
  }, null, 2)}\n`);
  await approveGate(root, "generation-authorization");
}

async function deliverReviewedCandidate(options: {
  root: string;
  warnings?: string[];
  operations?: AssembleProjectOperations;
}) {
  if (!await assertGateCurrent(options.root, "generation-authorization")) {
    await authorizeDeckGeneration(options.root);
  }
  const candidate = await assembleProjectCandidate(options.root, options.operations);
  const review = await publishDeckReview(options.root, candidate.candidateId);
  const outcome = await applyDeckReviewAction(options.root, {
    action: "confirm-delivery",
    candidateId: candidate.candidateId,
    descriptorSha256: review.descriptorSha256,
  });
  if (outcome.action !== "confirm-delivery" || !outcome.delivery) {
    throw new Error("candidate delivery was not promoted");
  }
  return outcome.delivery;
}

async function writeCompletedClientEvidence(
  root: string,
  name: string,
  application: "WPS" | "PowerPoint" = "WPS",
): Promise<string> {
  const smoke = await createClientSmokeCopy(root);
  const evidence = join(root, name);
  await writeFile(evidence, `${JSON.stringify({
    application,
    smokeCopyDescriptorPath: smoke.descriptorPath,
    selectedObject: "slide-2:title",
    temporaryEditObserved: true,
    undoObserved: true,
    saveDecision: "discarded",
    reopenObserved: true,
    reopenedCopySha256: smoke.copy.initialSha256,
    observedResult: "临时标题修改可见；撤销并丢弃后重开，原始标题保持不变",
    confirmedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return evidence;
}

async function fakeUnboundOutputs(renders: FinalRender[], paths: { pptx: string; pdf: string; montage: string }): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [index, render] of renders.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld><p:pic><p:cNvPr name=\"page-${render.id}\"/></p:pic></p:sld>`);
  }
  await writeFile(paths.pptx, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
  await exportPdf(renders, paths.pdf);
  await buildMontage(renders, paths.montage);
}

test("uses the same ordered final renders for PPTX, PDF, and montage", async (t) => {
  const root = await directory(t);
  const first = await image(join(root, "first.png"), "#dc503c");
  const second = await image(join(root, "second.png"), "#1e64c8");
  const pages = [
    { id: "second", order: 1, mode: "image" as const, render: second.path, expectedSha256: second.sha256 },
    { id: "first", order: 0, mode: "image" as const, render: first.path, expectedSha256: first.sha256 },
  ];
  const pptx = join(root, "deck.pptx");
  const pdf = join(root, "deck.pdf");
  const montage = join(root, "montage.jpg");

  const ordered = await assembleDeck(pages, pptx);
  await exportPdf(ordered, pdf);
  await buildMontage(ordered, montage);

  const zip = await JSZip.loadAsync(await readFile(pptx));
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideNames.length, 2);
  const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const slide2 = await zip.file("ppt/slides/slide2.xml")!.async("string");
  assert.match(slide1, /name="page-first"/);
  assert.match(slide2, /name="page-second"/);
  assert.equal((await PDFDocument.load(await readFile(pdf))).getPageCount(), 2);
  const montageInfo = await sharp(montage).metadata();
  assert.equal(montageInfo.width, 800);
  assert.equal(montageInfo.height, 225);
});

test("rejects empty, duplicate, or non-contiguous deck orders", async (t) => {
  const root = await directory(t);
  const render = await image(join(root, "page.png"), "#123456");
  await assert.rejects(assembleDeck([], join(root, "empty.pptx")), /at least one page/);
  await assert.rejects(assembleDeck([
    { id: "a", order: 0, mode: "image", render: render.path },
    { id: "b", order: 0, mode: "image", render: render.path },
  ], join(root, "duplicate.pptx")), /order must be unique/);
  await assert.rejects(assembleDeck([
    { id: "a", order: 1, mode: "image", render: render.path },
  ], join(root, "gap.pptx")), /order must be contiguous/);
});

test("fully decodes exact 1920x1080 owned renders and binds their hashes", async (t) => {
  const root = await directory(t);
  const valid = await image(join(root, "valid.png"), "#123456");
  const linked = join(root, "linked.png");
  await symlink(valid.path, linked);
  await assert.rejects(assembleDeck([
    { id: "linked", order: 0, mode: "image", render: linked },
  ], join(root, "linked.pptx")), /regular file/);

  await assert.rejects(assembleDeck([
    { id: "tampered", order: 0, mode: "image", render: valid.path, expectedSha256: "0".repeat(64) },
  ], join(root, "tampered.pptx")), /hash does not match/);

  const wrongSize = join(root, "wrong-size.png");
  await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#abcdef" } }).png().toFile(wrongSize);
  await assert.rejects(assembleDeck([
    { id: "wrong-size", order: 0, mode: "image", render: wrongSize },
  ], join(root, "wrong-size.pptx")), /1920x1080/);

  const corrupt = join(root, "corrupt.png");
  await writeFile(corrupt, Buffer.from("not an image"));
  await assert.rejects(assembleDeck([
    { id: "corrupt", order: 0, mode: "image", render: corrupt },
  ], join(root, "corrupt.pptx")), /complete image/);
});

test("detects render replacement during its no-follow read", async (t) => {
  const root = await directory(t);
  const render = await image(join(root, "race.png"), "#123456");
  const replacement = await image(join(root, "replacement.png"), "#654321");
  await assert.rejects(assembleDeck([
    { id: "race", order: 0, mode: "image", render: render.path },
  ], join(root, "race.pptx"), {
    afterRenderOpened: async (path) => {
      await rename(path, `${path}.opened`);
      await rename(replacement.path, path);
    },
  }), /changed while reading/);
});

test("requires injected artifact runtime paths and anchors PPTX output", async (t) => {
  const root = await directory(t);
  const render = await image(join(root, "page.png"), "#123456");
  const runtime = process.env.RUNTIME_NODE;
  delete process.env.RUNTIME_NODE;
  try {
    await assert.rejects(assembleDeck([
      { id: "page", order: 0, mode: "image", render: render.path },
    ], join(root, "missing-runtime.pptx"), { trustedRoot: root }), /RUNTIME_NODE is required/);
  } finally {
    process.env.RUNTIME_NODE = runtime;
  }

  const outside = await directory(t);
  const redirect = join(root, "redirect");
  await symlink(outside, redirect);
  await assert.rejects(assembleDeck([
    { id: "page", order: 0, mode: "image", render: render.path },
  ], join(redirect, "escaped.pptx"), { trustedRoot: root }), /output escaped the trusted root/);
});

test("builds revision-bound initial acceptance with physical artifact hashes", async (t) => {
  const root = await directory(t);
  const render = await image(join(root, "page.png"), "#123456");
  const pptx = join(root, "deck.pptx");
  const pdf = join(root, "deck.pdf");
  const montage = join(root, "montage.jpg");
  await writeFile(pptx, "pptx");
  await writeFile(pdf, "pdf");
  await writeFile(montage, "montage");
  const revisionId = "00000000-0000-4000-8000-000000000801";
  const acceptance = await buildAcceptance({
    projectId: "00000000-0000-4000-8000-000000000800",
    revisionId,
    providerId: "test-provider",
    gatesCurrent: true,
    gateRevisionIds: {
      outline: revisionId,
      slideSpecs: revisionId,
      styleSample: revisionId,
    },
    pages: [{
      id: "00000000-0000-4000-8000-000000000802",
      order: 0,
      mode: "image",
      status: "ready",
      finalRender: render.path,
      finalRenderSha256: render.sha256,
    }],
    exports: { pptx, pdf, montage },
  });

  assert.equal(AcceptanceSchema.parse(acceptance).deliveryComplete, false);
  assert.deepEqual(acceptance.clientAcceptance, {
    application: null,
    observation: null,
    smokeCopy: null,
    selectedObject: null,
    temporaryEditObserved: false,
    undoObserved: false,
    saveDecision: null,
    reopenObserved: false,
    observedResult: null,
    confirmedAt: null,
  });
  assert.equal(acceptance.slides[0]!.finalRenderSha256, render.sha256);
  for (const [kind, path] of Object.entries({ pptx, pdf, montage })) {
    const evidence = acceptance.exports[kind as keyof typeof acceptance.exports];
    assert.equal(evidence.path, path);
    assert.equal(evidence.sha256, createHash("sha256").update(await readFile(path)).digest("hex"));
  }
  assert.throws(() => AcceptanceSchema.parse({
    ...acceptance,
    slides: acceptance.slides.map((slide) => ({ ...slide, mode: "editable" as const })),
  }), /editablePageIds must exactly match editable slides/);
});

test("refuses stale gates, non-ready pages, duplicate order, and render tampering in acceptance", async (t) => {
  const root = await directory(t);
  const render = await image(join(root, "page.png"), "#123456");
  const revisionId = "00000000-0000-4000-8000-000000000811";
  const base = {
    projectId: "00000000-0000-4000-8000-000000000810",
    revisionId,
    providerId: "test-provider",
    gatesCurrent: true,
    gateRevisionIds: { outline: revisionId, slideSpecs: revisionId, styleSample: revisionId },
    pages: [{
      id: "00000000-0000-4000-8000-000000000812",
      order: 0,
      mode: "image" as const,
      status: "ready",
      finalRender: render.path,
      finalRenderSha256: render.sha256,
    }],
    exports: { pptx: render.path, pdf: render.path, montage: render.path },
  };
  await assert.rejects(buildAcceptance({ ...base, gatesCurrent: false }), /planning gates must be current/);
  await assert.rejects(buildAcceptance({
    ...base,
    pages: [{ ...base.pages[0]!, status: "failed" }],
  }), /all pages must be ready/);
  await assert.rejects(buildAcceptance({
    ...base,
    pages: [base.pages[0]!, { ...base.pages[0]!, id: "00000000-0000-4000-8000-000000000813" }],
  }), /order must be unique/);
  await assert.rejects(buildAcceptance({
    ...base,
    pages: [{ ...base.pages[0]!, finalRenderSha256: "0".repeat(64) }],
  }), /final render hash does not match/);
});

test("assembles into an owned revision destination and publishes exact manifest refs", async (t) => {
  const fixture = await readyProject(t);
  const result = await deliverReviewedCandidate({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  });
  const manifest = await readProject(fixture.root);
  assert.equal(result.revisionId, fixture.revisionId);
  assert.equal(result.recovered, false);
  assert.equal(manifest.stage, "assembling");
  assert.deepEqual(manifest.exports, result.artifacts);
  assert.ok(manifest.slides.every((slide) => slide.finalRender?.sha256 === slide.image?.sha256));
  for (const artifact of Object.values(result.artifacts)) {
    assert.ok(artifact);
    assert.equal(createHash("sha256").update(await readFile(join(fixture.root, artifact!.path))).digest("hex"), artifact!.sha256);
  }
  const marker = JSON.parse(await readFile(join(fixture.root, "output", "revisions", "1", ".superppt-output.json"), "utf8"));
  assert.equal(marker.projectId, manifest.projectId);
  assert.equal(marker.revisionId, fixture.revisionId);
  assert.deepEqual(marker.artifacts, result.artifacts);
  assert.equal((await readProjectAcceptance(fixture.root)).deliveryComplete, false);
});

test("assembles a review-only candidate and promotes it only after exact deck review approval", async (t) => {
  const fixture = await readyProject(t);
  await authorizeDeckGeneration(fixture.root);
  const before = await readProject(fixture.root);

  const candidate = await assembleProjectCandidate(fixture.root, {
    buildOutputs: fakeOutputs,
  });
  const afterCandidate = await readProject(fixture.root);
  assert.deepEqual(afterCandidate.exports, before.exports);
  assert.equal(afterCandidate.outputRevisions?.length ?? 0, 0);
  assert.match(candidate.destination, /output\/candidates\/[0-9a-f-]{36}$/);
  assert.ok(Object.values(candidate.artifacts).every(({ path }) => path.startsWith(`output/candidates/${candidate.candidateId}/`)));

  const review = await publishDeckReview(fixture.root, candidate.candidateId);
  assert.deepEqual(review.actions, ["edit-page", "return-upstream", "confirm-delivery"]);
  assert.equal((await readProject(fixture.root)).stage, "deck-review");
  await assert.rejects(
    promoteApprovedCandidate(fixture.root, candidate.candidateId),
    /deck-review|action/i,
  );
  await assert.rejects(approveGate(fixture.root, "deck-review"), /action/i);
  const action = await applyDeckReviewAction(fixture.root, {
    action: "confirm-delivery",
    candidateId: candidate.candidateId,
    descriptorSha256: review.descriptorSha256,
  });
  assert.equal(action.action, "confirm-delivery");
  assert.ok(action.delivery);
  const delivery = action.delivery;
  assert.equal(delivery.revisionNumber, 1);
  assert.match(delivery.destination, /output\/revisions\/1$/);
  assert.deepEqual((await readProject(fixture.root)).exports, delivery.artifacts);
});

test("deck review return and edit actions are real non-promotion transitions", async (t) => {
  for (const [action, expectedStage] of [
    ["return-upstream", "generation-authorization"],
    ["edit-page", "revising"],
  ] as const) {
    const fixture = await readyProject(t);
    await authorizeDeckGeneration(fixture.root);
    const candidate = await assembleProjectCandidate(fixture.root, { buildOutputs: fakeOutputs });
    const before = await readProject(fixture.root);
    const review = await publishDeckReview(fixture.root, candidate.candidateId);
    const request = action === "edit-page"
      ? { action, slideId: PROJECT_SLIDES[0], candidateId: candidate.candidateId, descriptorSha256: review.descriptorSha256 }
      : { action, candidateId: candidate.candidateId, descriptorSha256: review.descriptorSha256 };
    const outcome = await applyDeckReviewAction(fixture.root, request);
    const after = await readProject(fixture.root);
    assert.equal(outcome.action, action);
    assert.equal(outcome.delivery, null);
    assert.equal(after.stage, expectedStage);
    assert.deepEqual(after.exports, before.exports);
    assert.deepEqual(after.outputRevisions ?? [], before.outputRevisions ?? []);
    assert.equal(await assertGateCurrent(fixture.root, "deck-review"), false);
    assert.equal(await assertGateCurrent(fixture.root, "generation-authorization"), true);
    await assert.rejects(promoteApprovedCandidate(fixture.root, candidate.candidateId), /action|deck-review/i);
    await access(join(fixture.root, `output/candidates/${candidate.candidateId}/.superppt-candidate.json`));
  }
});

test("promotion fails closed for candidate tampering and stale project revisions", async (t) => {
  const tampered = await readyProject(t);
  await authorizeDeckGeneration(tampered.root);
  const candidate = await assembleProjectCandidate(tampered.root, { buildOutputs: fakeOutputs });
  const review = await publishDeckReview(tampered.root, candidate.candidateId);
  await writeFile(join(tampered.root, "output/candidates/current/montage.jpg"), "wrong candidate montage");
  await assert.rejects(
    applyDeckReviewAction(tampered.root, {
      action: "confirm-delivery",
      candidateId: candidate.candidateId,
      descriptorSha256: review.descriptorSha256,
    }),
    /montage|hash|evidence|tamper/i,
  );
  assert.equal(await assertGateCurrent(tampered.root, "deck-review"), false);
  await assert.rejects(promoteApprovedCandidate(tampered.root, candidate.candidateId), /action|deck-review|montage/i);
  assert.equal((await readProject(tampered.root)).exports.pptx, null);

  const stale = await readyProject(t);
  await authorizeDeckGeneration(stale.root);
  const staleCandidate = await assembleProjectCandidate(stale.root, { buildOutputs: fakeOutputs });
  const staleReview = await publishDeckReview(stale.root, staleCandidate.candidateId);
  await applyDeckReviewAction(stale.root, {
    action: "edit-page",
    candidateId: staleCandidate.candidateId,
    descriptorSha256: staleReview.descriptorSha256,
    slideId: PROJECT_SLIDES[0],
  });
  assert.equal((await authenticateCurrentDeckEditSelection(stale.root, PROJECT_SLIDES[0])).slideId, PROJECT_SLIDES[0]);
  const impact = await publishImpactPlan(stale.root, { kind: "brief", title: "Changed after review" });
  await approveImpact(stale.root, impact.sha256);
  await applyRevision(stale.root, impact, impact.change);
  await assert.rejects(authenticateCurrentDeckEditSelection(stale.root, PROJECT_SLIDES[0]), /current reviewed deck|edit-page selection|stale/i);
  await assert.rejects(
    promoteApprovedCandidate(stale.root, staleCandidate.candidateId),
    /stale|revision|deck-review|candidate/i,
  );
  assert.equal((await readProject(stale.root)).exports.pptx, null);

  const replacedCandidate = await readyProject(t);
  await authorizeDeckGeneration(replacedCandidate.root);
  const firstCandidate = await assembleProjectCandidate(replacedCandidate.root, { buildOutputs: fakeOutputs });
  const firstReview = await publishDeckReview(replacedCandidate.root, firstCandidate.candidateId);
  await applyDeckReviewAction(replacedCandidate.root, {
    action: "edit-page",
    slideId: PROJECT_SLIDES[0],
    candidateId: firstCandidate.candidateId,
    descriptorSha256: firstReview.descriptorSha256,
  });
  await authenticateCurrentDeckEditSelection(replacedCandidate.root, PROJECT_SLIDES[0]);
  const newerCandidate = await assembleProjectCandidate(replacedCandidate.root, { buildOutputs: fakeOutputs });
  await publishDeckReview(replacedCandidate.root, newerCandidate.candidateId);
  await assert.rejects(
    authenticateCurrentDeckEditSelection(replacedCandidate.root, PROJECT_SLIDES[0]),
    /current reviewed deck|edit-page selection|stale/i,
  );
});

test("promotion rejects the wrong candidate approval and serializes concurrent replay", async (t) => {
  const wrong = await readyProject(t);
  await authorizeDeckGeneration(wrong.root);
  const approved = await assembleProjectCandidate(wrong.root, { buildOutputs: fakeOutputs });
  await publishDeckReview(wrong.root, approved.candidateId);
  const unapproved = await assembleProjectCandidate(wrong.root, { buildOutputs: fakeOutputs });
  await publishDeckReview(wrong.root, unapproved.candidateId);
  await assert.rejects(promoteApprovedCandidate(wrong.root, unapproved.candidateId), /deck-review|approval|action/i);
  await assert.rejects(promoteApprovedCandidate(wrong.root, approved.candidateId), /candidate|current|deck-review/i);
  assert.equal((await readProject(wrong.root)).exports.pptx, null);

  const concurrent = await readyProject(t);
  await authorizeDeckGeneration(concurrent.root);
  const candidate = await assembleProjectCandidate(concurrent.root, { buildOutputs: fakeOutputs });
  const concurrentReview = await publishDeckReview(concurrent.root, candidate.candidateId);
  await assert.rejects(approveGate(concurrent.root, "deck-review"), /action/i);
  const attempts = await Promise.allSettled([
    applyDeckReviewAction(concurrent.root, {
      action: "confirm-delivery",
      candidateId: candidate.candidateId,
      descriptorSha256: concurrentReview.descriptorSha256,
    }),
    applyDeckReviewAction(concurrent.root, {
      action: "confirm-delivery",
      candidateId: candidate.candidateId,
      descriptorSha256: concurrentReview.descriptorSha256,
    }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.ok((await readProject(concurrent.root)).exports.pptx);
});

test("promote approved candidate recovers a formal revision published before a manifest crash", async (t) => {
  const fixture = await readyProject(t);
  await authorizeDeckGeneration(fixture.root);
  const candidate = await assembleProjectCandidate(fixture.root, { buildOutputs: fakeOutputs });
  const review = await publishDeckReview(fixture.root, candidate.candidateId);

  await assert.rejects(applyDeckReviewAction(fixture.root, {
    action: "confirm-delivery",
    candidateId: candidate.candidateId,
    descriptorSha256: review.descriptorSha256,
  }, {
    checkpoint(step) {
      if (step === "output-promoted") throw new Error("simulated candidate promotion crash");
    },
  }), /simulated candidate promotion crash/);
  assert.equal((await readProject(fixture.root)).exports.pptx, null);

  const recovered = await promoteApprovedCandidate(fixture.root, candidate.candidateId);
  assert.equal(recovered.recovered, true);
  assert.deepEqual((await readProject(fixture.root)).exports, recovered.artifacts);
});

test("retains partial staging without mutating the manifest", async (t) => {
  const fixture = await readyProject(t);
  const before = await readProject(fixture.root);
  await assert.rejects(deliverReviewedCandidate({
    root: fixture.root,
    operations: {
      buildOutputs: async (renders, paths) => {
        await fakeOutputs(renders, paths);
        throw new Error("simulated build crash");
      },
    },
  }), /simulated build crash/);
  const after = await readProject(fixture.root);
  assert.deepEqual(after.exports, before.exports);
  await assert.rejects(access(join(fixture.root, "output", "revisions", "1")));
});

test("aborts promotion when the current revision changes during assembly", async (t) => {
  const fixture = await readyProject(t);
  await assert.rejects(deliverReviewedCandidate({
    root: fixture.root,
    operations: {
      buildOutputs: fakeOutputs,
      beforePromote: async () => {
        const change = { kind: "style" as const };
        const plan = await publishImpactPlan(fixture.root, change);
        await approveImpact(fixture.root, plan.sha256);
        await applyRevision(fixture.root, plan, change);
      },
    },
  }), /project revision or generation authorization changed during candidate assembly/);
  await assert.rejects(access(join(fixture.root, "output", "revisions", "1")));
});

test("records undo discard reopen evidence while preserving the canonical deck and owned smoke copy", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  });
  const manifest = await readProject(fixture.root);
  const canonicalPptx = join(fixture.root, manifest.exports.pptx!.path);
  const canonicalBytes = await readFile(canonicalPptx);
  const smoke = await createClientSmokeCopy(fixture.root);
  const smokeCopy = join(fixture.root, smoke.copy.path);
  const initialCopyBytes = await readFile(smokeCopy);
  const evidence = await writeCompletedClientEvidence(fixture.root, "discarded-evidence.json");

  const accepted = await recordClientAcceptance(fixture.root, evidence);

  assert.equal(accepted.deliveryComplete, true);
  assert.equal(accepted.clientAcceptance.application, "WPS");
  assert.equal(accepted.clientAcceptance.selectedObject, "slide-2:title");
  assert.equal(accepted.clientAcceptance.temporaryEditObserved, true);
  assert.equal(accepted.clientAcceptance.undoObserved, true);
  assert.equal(accepted.clientAcceptance.saveDecision, "discarded");
  assert.equal(accepted.clientAcceptance.reopenObserved, true);
  assert.equal(accepted.clientAcceptance.smokeCopy?.reopenedSha256, smoke.copy.initialSha256);
  assert.deepEqual(await readFile(smokeCopy), initialCopyBytes);
  assert.deepEqual(await readFile(canonicalPptx), canonicalBytes);

  const delivered = await readProject(fixture.root);
  const anchor = delivered.clientSmokeCopyAnchor!;
  assert.equal(delivered.stage, "delivered");
  assert.equal(anchor.state, "completed");
  assert.equal(anchor.reopenedCopySha256, smoke.copy.initialSha256);
  assert.ok(anchor.observation);
  assert.deepEqual(anchor.acceptanceRecord, delivered.exports.acceptance);
  const observation = JSON.parse(await readFile(join(fixture.root, anchor.observation!.path), "utf8"));
  assert.equal(observation.projectId, delivered.projectId);
  assert.equal(observation.revisionId, delivered.currentRevision.id);
  assert.deepEqual(observation.source, anchor.source);
  assert.deepEqual(observation.initialCopy, anchor.initialCopy);
  assert.equal(observation.descriptor.path, anchor.descriptor.path);
  assert.equal(observation.descriptor.sha256, anchor.descriptor.sha256);
  assert.equal(observation.reopenedCopySha256, anchor.initialCopy.sha256);
  assert.equal(observation.saveDecision, "discarded");

  assert.deepEqual(await recordClientAcceptance(fixture.root, evidence), accepted);
  const conflictingReplay = join(fixture.root, "conflicting-discard-replay.json");
  const submitted = JSON.parse(await readFile(evidence, "utf8"));
  await writeFile(conflictingReplay, `${JSON.stringify({
    ...submitted,
    observedResult: "different observation that was never recorded",
  })}\n`, { mode: 0o600 });
  await assert.rejects(
    recordClientAcceptance(fixture.root, conflictingReplay),
    /immutable client acceptance replay does not match/,
  );

  await writeFile(canonicalPptx, "tampered after acceptance");
  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /acceptance evidence is not current/);
});

test("rejects missing undo or reopen and a saved smoke modification without changing the canonical deck", async (t) => {
  for (const failure of ["undo", "reopen", "saved-copy", "reported-hash"] as const) {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    const manifest = await readProject(fixture.root);
    const canonicalPptx = join(fixture.root, manifest.exports.pptx!.path);
    const canonicalBytes = await readFile(canonicalPptx);
    const smoke = await createClientSmokeCopy(fixture.root);
    const copy = join(fixture.root, smoke.copy.path);
    const evidence = join(fixture.root, `${failure}.json`);
    const submitted: Record<string, unknown> = {
      application: "WPS",
      smokeCopyDescriptorPath: smoke.descriptorPath,
      selectedObject: "slide-2:title",
      temporaryEditObserved: true,
      undoObserved: true,
      saveDecision: "discarded",
      reopenObserved: true,
      reopenedCopySha256: smoke.copy.initialSha256,
      observedResult: "撤销并丢弃后重开，原始标题保持不变",
      confirmedAt: new Date().toISOString(),
    };
    if (failure === "undo") submitted.undoObserved = false;
    if (failure === "reopen") submitted.reopenObserved = false;
    if (failure === "saved-copy") await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from("saved modification")]));
    if (failure === "reported-hash") submitted.reopenedCopySha256 = "f".repeat(64);
    await writeFile(evidence, `${JSON.stringify(submitted)}\n`, { mode: 0o600 });

    await assert.rejects(recordClientAcceptance(fixture.root, evidence), /invalid|undo|reopen|discard|hash|unchanged/i);
    assert.equal((await readProject(fixture.root)).stage, "assembling");
    assert.deepEqual(await readFile(canonicalPptx), canonicalBytes);
  }
});

test("manual discard reopen helper creates only the owned copy and prints the human checklist", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const before = await readProject(fixture.root);
  const canonical = join(fixture.root, before.exports.pptx!.path);
  const canonicalBytes = await readFile(canonical);

  const { stdout } = await execFileAsync(join(process.cwd(), "scripts", "acceptance-smoke.sh"), [fixture.root], {
    cwd: process.cwd(),
    env: process.env,
  });

  for (const item of ["选定对象", "临时修改", "观察", "撤销", "丢弃/不保存", "关闭", "重开", "核验原内容"]) {
    assert.match(stdout, new RegExp(item));
  }
  assert.match(stdout, /不操作 WPS\/PowerPoint，也不声明验收通过/);
  assert.match(stdout, /禁止.*canonical.*deck\.pptx/is);
  const after = await readProject(fixture.root);
  assert.equal(after.stage, "assembling");
  assert.equal(after.clientSmokeCopyAnchor?.state, "ready");
  await access(join(fixture.root, after.clientSmokeCopyAnchor!.initialCopy.path));
  await assert.rejects(access(join(fixture.root, "output", "revisions", "1", "acceptance-record.json")));
  assert.deepEqual(await readFile(canonical), canonicalBytes);
});

test("rejects forged discard evidence and post-acceptance smoke-copy tampering", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const smoke = await createClientSmokeCopy(fixture.root);
  const evidence = join(fixture.root, "smoke-evidence.json");
  const base = {
    application: "PowerPoint",
    smokeCopyDescriptorPath: smoke.descriptorPath,
    selectedObject: "slide-1:title",
    temporaryEditObserved: true,
    undoObserved: true,
    saveDecision: "discarded",
    reopenObserved: true,
    reopenedCopySha256: smoke.copy.initialSha256,
    observedResult: "临时编辑已撤销，丢弃后重开仍为原内容",
    confirmedAt: new Date().toISOString(),
  };

  const copy = join(fixture.root, smoke.copy.path);
  const descriptorPath = join(fixture.root, smoke.descriptorPath);
  const descriptorBytes = await readFile(descriptorPath);
  const forgedDescriptor = JSON.parse(descriptorBytes.toString("utf8"));
  forgedDescriptor.source.path = "output/revisions/1/forged.pptx";
  const forgedDescriptorBytes = Buffer.from(`${JSON.stringify(forgedDescriptor, null, 2)}\n`);
  await writeFile(descriptorPath, forgedDescriptorBytes);
  await writeFile(evidence, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /descriptor hash mismatch/);
  await writeFile(descriptorPath, descriptorBytes);
  await writeFile(evidence, `${JSON.stringify({ ...base, source: { path: "forged", sha256: "0".repeat(64) } })}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /client acceptance input is invalid/);
  await writeFile(evidence, `${JSON.stringify({
    ...base,
    smokeCopyDescriptorSha256: smoke.descriptorSha256,
  })}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /client acceptance input is invalid/);
  await writeFile(evidence, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  await recordClientAcceptance(fixture.root, evidence);
  const delivered = await readProject(fixture.root);
  const observationPath = join(fixture.root, delivered.clientSmokeCopyAnchor!.observation!.path);
  const observationBytes = await readFile(observationPath);
  const forgedObservation = JSON.parse(observationBytes.toString("utf8"));
  forgedObservation.observedResult = "forged after delivery";
  await writeFile(observationPath, `${JSON.stringify(forgedObservation, null, 2)}\n`);
  await assert.rejects(readProjectAcceptance(fixture.root), /client observation evidence is not current/);
  await writeFile(observationPath, observationBytes);
  await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from("tampered")]));
  await assert.rejects(readProjectAcceptance(fixture.root), /client smoke copy evidence is not current/);
});

test("FORGE_ACCEPTED cannot self-attest a smoke descriptor without a trusted project anchor", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const manifest = await readProject(fixture.root);
  const revisionNumber = manifest.deckRevision ?? manifest.currentRevision.number;
  const directoryRef = `output/revisions/${revisionNumber}/client-smoke`;
  const descriptorRef = `${directoryRef}/descriptor.json`;
  const copyRef = `${directoryRef}/deck-smoke.pptx`;
  const canonical = manifest.exports.pptx!;
  const directory = join(fixture.root, directoryRef);
  await mkdir(directory);
  const copy = join(fixture.root, copyRef);
  await copyFile(join(fixture.root, canonical.path), copy);
  await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from("FORGE_ACCEPTED")]))
  const descriptorBytes = Buffer.from(`${JSON.stringify({
    descriptorVersion: 1,
    appId: "superppt",
    artifactKind: "client-smoke-copy",
    projectId: manifest.projectId,
    revisionId: manifest.currentRevision.id,
    revisionNumber,
    source: { path: canonical.path, sha256: canonical.sha256 },
    copy: { path: copyRef, initialSha256: canonical.sha256 },
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  await writeFile(join(fixture.root, descriptorRef), descriptorBytes);
  const evidence = join(fixture.root, "forged-acceptance.json");
  await writeFile(evidence, `${JSON.stringify({
    application: "WPS",
    smokeCopyDescriptorPath: descriptorRef,
    selectedObject: "slide-1:title",
    temporaryEditObserved: true,
    undoObserved: true,
    saveDecision: "discarded",
    reopenObserved: true,
    reopenedCopySha256: canonical.sha256,
    observedResult: "FORGE_ACCEPTED",
    confirmedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /trusted client smoke copy anchor is missing/);
  assert.equal((await readProjectAcceptance(fixture.root)).deliveryComplete, false);
});

test("FORGE_ACCEPTED cannot construct trust through exported store transitions", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const manifest = await readProject(fixture.root);
  const revisionNumber = manifest.deckRevision ?? manifest.currentRevision.number;
  const directoryRef = `output/revisions/${revisionNumber}/client-smoke`;
  const descriptorRef = `${directoryRef}/descriptor.json`;
  const copyRef = `${directoryRef}/deck-smoke.pptx`;
  const canonical = manifest.exports.pptx!;
  const anchorId = "00000000-0000-4000-8000-000000000991";
  const createdAt = new Date().toISOString();
  const descriptor = {
    descriptorVersion: 1,
    appId: "superppt",
    artifactKind: "client-smoke-copy",
    anchorId,
    projectId: manifest.projectId,
    revisionId: manifest.currentRevision.id,
    revisionNumber,
    source: { path: canonical.path, sha256: canonical.sha256 },
    copy: { path: copyRef, initialSha256: canonical.sha256 },
    createdAt,
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
  const rawStore = projectStore as Record<string, unknown>;
  const begin = rawStore.beginClientSmokeCopyAnchor as undefined | ((root: string, anchor: unknown) => Promise<unknown>);
  const ready = rawStore.markClientSmokeCopyAnchorReady as undefined | ((root: string, id: string) => Promise<unknown>);

  if (begin && ready) {
    await begin(fixture.root, {
      anchorVersion: 1,
      anchorId,
      projectId: manifest.projectId,
      revisionId: manifest.currentRevision.id,
      deckRevision: revisionNumber,
      source: canonical,
      descriptor: {
        path: descriptorRef,
        sha256: createHash("sha256").update(descriptorBytes).digest("hex"),
        revisionId: manifest.currentRevision.id,
      },
      initialCopy: { path: copyRef, sha256: canonical.sha256, revisionId: manifest.currentRevision.id },
      createdAt,
      state: "pending",
      observation: null,
      reopenedCopySha256: null,
      acceptanceRecord: null,
      completedAt: null,
    });
    await mkdir(join(fixture.root, directoryRef));
    await writeFile(join(fixture.root, descriptorRef), descriptorBytes);
    const copy = join(fixture.root, copyRef);
    await copyFile(join(fixture.root, canonical.path), copy);
    await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from("FORGE_ACCEPTED")]))
    await ready(fixture.root, anchorId);
  }
  assert.equal(begin, undefined, "raw smoke anchor creation must not be publicly callable");
  assert.equal(ready, undefined, "raw smoke anchor elevation must not be publicly callable");
  assert.equal(rawStore.completeClientSmokeCopyAnchor, undefined, "raw smoke anchor completion must not be publicly callable");
});

test("FORGE_ACCEPTED cannot publish a self-authored acceptance record through the store", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  await createClientSmokeCopy(fixture.root);
  const rawStore = projectStore as Record<string, unknown>;
  const commit = rawStore.commitClientSmokeCopyAcceptance as undefined | ((options: unknown) => Promise<unknown>);
  assert.equal(commit, undefined, "no raw acceptance completion authority may be exported");
  assert.notEqual((await readProject(fixture.root)).stage, "delivered");
  assert.equal((await readProjectAcceptance(fixture.root)).deliveryComplete, false);
});

test("non-completed smoke anchors reject every partial completion field", () => {
  const base = {
    anchorVersion: 1 as const,
    anchorId: "00000000-0000-4000-8000-000000000991",
    projectId: "00000000-0000-4000-8000-000000000992",
    revisionId: "00000000-0000-4000-8000-000000000993",
    deckRevision: 1,
    source: { path: "output/revisions/1/deck.pptx", sha256: "a".repeat(64), revisionId: "00000000-0000-4000-8000-000000000993" },
    descriptor: { path: "output/revisions/1/client-smoke/descriptor.json", sha256: "b".repeat(64), revisionId: "00000000-0000-4000-8000-000000000993" },
    initialCopy: { path: "output/revisions/1/client-smoke/deck-smoke.pptx", sha256: "a".repeat(64), revisionId: "00000000-0000-4000-8000-000000000993" },
    createdAt: new Date().toISOString(),
    state: "ready" as const,
    observation: null,
    reopenedCopySha256: null,
    acceptanceRecord: null,
    completedAt: null,
  };
  assert.throws(() => ClientSmokeCopyAnchorSchema.parse({
    ...base,
    observation: { path: "output/revisions/1/acceptance-observation.json", sha256: "c".repeat(64), revisionId: base.revisionId },
  }));
  assert.throws(() => ClientSmokeCopyAnchorSchema.parse({ ...base, reopenedCopySha256: "a".repeat(64) }));
  assert.throws(() => ClientSmokeCopyAnchorSchema.parse({
    ...base,
    acceptanceRecord: { path: "output/revisions/1/acceptance-record.json", sha256: "d".repeat(64), revisionId: base.revisionId },
  }));
  assert.throws(() => ClientSmokeCopyAnchorSchema.parse({ ...base, completedAt: new Date().toISOString() }));
});

test("serializes smoke-copy creation and recovers every trusted anchor publication boundary", async (t) => {
  const concurrent = await readyProject(t);
  await deliverReviewedCandidate({ root: concurrent.root, operations: { buildOutputs: fakeOutputs } });
  const [left, right] = await Promise.all([
    createClientSmokeCopy(concurrent.root),
    createClientSmokeCopy(concurrent.root),
  ]);
  assert.deepEqual(left, right);
  assert.equal((await readProject(concurrent.root)).clientSmokeCopyAnchor?.state, "ready");

  for (const checkpoint of ["before-anchor-commit", "anchor-committed", "files-promoted", "anchor-ready"] as const) {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    await assert.rejects(createClientSmokeCopy(fixture.root, {
      checkpoint: (step) => {
        if (step === checkpoint) throw new Error(`crash at ${checkpoint}`);
      },
    }), new RegExp(`crash at ${checkpoint}`));
    const crashed = await readProject(fixture.root);
    if (checkpoint === "before-anchor-commit") {
      assert.equal(crashed.clientSmokeCopyAnchor, undefined);
    } else if (checkpoint === "anchor-ready") {
      assert.equal(crashed.clientSmokeCopyAnchor?.state, "ready");
    } else {
      assert.equal(crashed.clientSmokeCopyAnchor?.state, "pending");
    }
    const recovered = await createClientSmokeCopy(fixture.root);
    assert.equal(recovered.anchorId, (await readProject(fixture.root)).clientSmokeCopyAnchor?.anchorId);
    assert.equal((await readProject(fixture.root)).clientSmokeCopyAnchor?.state, "ready");
  }
});

test("rejects ordinary anchor forgery plus linked or stale anchored smoke evidence", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const smoke = await createClientSmokeCopy(fixture.root);
  await assert.rejects(updateProject(fixture.root, (manifest) => ({
    ...manifest,
    clientSmokeCopyAnchor: {
      ...manifest.clientSmokeCopyAnchor!,
      descriptor: { ...manifest.clientSmokeCopyAnchor!.descriptor, sha256: "f".repeat(64) },
    },
  })), /client smoke copy trust fields require a controlled store transition/);

  const copy = join(fixture.root, smoke.copy.path);
  const replacement = join(fixture.root, "linked-smoke.pptx");
  await writeFile(replacement, "linked edit");
  await unlink(copy);
  await symlink(replacement, copy);
  const linkedEvidence = join(fixture.root, "linked-evidence.json");
  await writeFile(linkedEvidence, `${JSON.stringify({
    application: "WPS",
    smokeCopyDescriptorPath: smoke.descriptorPath,
    selectedObject: "slide-1:title",
    temporaryEditObserved: true,
    undoObserved: true,
    saveDecision: "discarded",
    reopenObserved: true,
    reopenedCopySha256: createHash("sha256").update("linked edit").digest("hex"),
    observedResult: "linked copy",
    confirmedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, linkedEvidence), /regular file|unexpected entries|fixed project key/);

  await unlink(copy);
  await copyFile(join(fixture.root, (await readProject(fixture.root)).exports.pptx!.path), copy);
  await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from("edited")]))
  const staleManifestPath = join(fixture.root, "superppt.json");
  const staleManifest = JSON.parse(await readFile(staleManifestPath, "utf8"));
  staleManifest.clientSmokeCopyAnchor.revisionId = "00000000-0000-4000-8000-000000000999";
  await writeFile(staleManifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`);
  await assert.rejects(recordClientAcceptance(fixture.root, linkedEvidence), /trusted client smoke copy anchor is stale/);
});

test("invalidates completed acceptance when a same-revision slide becomes editable", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  });
  const evidence = await writeCompletedClientEvidence(fixture.root, "accepted-mode-change.json");
  const completed = await recordClientAcceptance(fixture.root, evidence);
  assert.equal(completed.deliveryComplete, true);
  assert.deepEqual(completed.editablePageIds, []);

  await updateProject(fixture.root, (manifest) => ({
    ...manifest,
    slides: manifest.slides.map((slide, index) => index === 0 ? {
      ...slide,
      status: "editable" as const,
    } : slide),
  }));

  await assert.rejects(readProjectAcceptance(fixture.root), /acceptance slide mode is not current/);
});

test("rejects delivery when immutable gate snapshots or presentation pointers are tampered", async (t) => {
  for (const tamper of ["snapshot", "presentation"] as const) {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    const evidence = await writeCompletedClientEvidence(fixture.root, `gate-${tamper}.json`);
    const manifest = await readProject(fixture.root);
    const styleGate = [...manifest.gates].reverse().find((gate) => gate.gate === "style-sample")!;
    if (tamper === "snapshot") {
      await writeFile(join(fixture.root, styleGate.snapshotPath!, "snapshot.json"), "{}\n");
    } else {
      await writeFile(join(fixture.root, "style-sample.json"), "{}\n");
    }
    await assert.rejects(readProjectAcceptance(fixture.root), /snapshot|presentation|gate evidence/i);
    await assert.rejects(recordClientAcceptance(fixture.root, evidence), /snapshot|presentation|gate evidence/i);
    assert.notEqual((await readProject(fixture.root)).stage, "delivered");
  }
});

test("exposes candidate assembly and acceptance as strict CLI routes without legacy direct assembly", async (t) => {
  const root = await directory(t);
  const cli = join(process.cwd(), "src", "cli.ts");
  const invoke = async (args: string[], env: NodeJS.ProcessEnv = process.env) => {
    try {
      await execFileAsync(process.execPath, ["--import", "tsx", cli, ...args], { env });
      return "";
    } catch (error: unknown) {
      return String((error as { stderr?: string }).stderr ?? error);
    }
  };
  const legacyAssembleError = await invoke(["assemble", "--project", root], {
    ...process.env,
    SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: "",
    SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: "",
  });
  assert.match(legacyAssembleError, /unknown command/);

  const assembleError = await invoke(["assemble-candidate", "--project", root], {
    ...process.env,
    SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: "",
    SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: "",
  });
  assert.match(assembleError, /not owned by SuperPPT|planning artifact must be a regular file/);
  assert.doesNotMatch(assembleError, /unknown command/);

  const acceptanceError = await invoke(["acceptance", "--project", root]);
  assert.match(acceptanceError, /not owned by SuperPPT/);
  assert.doesNotMatch(acceptanceError, /unknown command/);

  const smokeCopyError = await invoke(["acceptance-smoke-copy", "--project", root]);
  assert.match(smokeCopyError, /not owned by SuperPPT|planning artifact must be a regular file/);
  assert.doesNotMatch(smokeCopyError, /unknown command/);

  const recordError = await invoke([
    "acceptance-record",
    "--project",
    root,
    "--input",
    join(root, "missing.json"),
  ]);
  assert.match(recordError, /client acceptance input must be a regular 0600 file/);
  assert.doesNotMatch(recordError, /unknown command/);
});

test("rejects a PPTX that names pages but has no bound media relationships", async (t) => {
  const fixture = await readyProject(t);
  await assert.rejects(deliverReviewedCandidate({
    root: fixture.root,
    operations: { buildOutputs: fakeUnboundOutputs },
  }), /PPTX.*media|media.*PPTX/i);
});

test("derives provider identity from every accepted attempt ledger", async (t) => {
  const fixture = await readyProject(t);
  const untrustedCallerOptions = {
    root: fixture.root,
    providerId: "spoofed-provider",
    operations: { buildOutputs: fakeOutputs },
  };
  await deliverReviewedCandidate(untrustedCallerOptions);
  assert.equal((await readProjectAcceptance(fixture.root)).providerId, "ledger-provider");
  const ledgerPath = join(fixture.root, "images", PROJECT_SLIDES[0], "attempt-1", "ledger.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  await writeFile(ledgerPath, `${JSON.stringify({ ...ledger, providerId: "forged-provider" }, null, 2)}\n`);
  await assert.rejects(
    readProjectAcceptance(fixture.root),
    /provider evidence is not current|one accepted provider identity/,
  );
});

test("recovers discard acceptance across observation, record, and manifest publication crashes", async (t) => {
  for (const checkpoint of ["observation-promoted", "record-promoted", "manifest-updated"] as const) {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({
      root: fixture.root,
      operations: { buildOutputs: fakeOutputs },
    });
    const evidence = await writeCompletedClientEvidence(fixture.root, `accepted-${checkpoint}.json`);
    await assert.rejects(recordClientAcceptance(fixture.root, evidence, {
      checkpoint: (step) => {
        if (step === checkpoint) throw new Error(`simulated crash at ${checkpoint}`);
      },
    }), new RegExp(`simulated crash at ${checkpoint}`));
    const crashed = await readProject(fixture.root);
    assert.equal(crashed.stage, checkpoint === "manifest-updated" ? "delivered" : "assembling");
    await access(join(fixture.root, "output", "revisions", "1", "acceptance-observation.json"));
    if (checkpoint === "observation-promoted") {
      await assert.rejects(access(join(fixture.root, "output", "revisions", "1", "acceptance-record.json")));
    } else {
      await access(join(fixture.root, "output", "revisions", "1", "acceptance-record.json"));
    }
    const recovered = await recordClientAcceptance(fixture.root, evidence);
    assert.equal(recovered.deliveryComplete, true);
    assert.equal((await readProject(fixture.root)).stage, "delivered");
  }
});

test("client acceptance input rejects a pathname swap through its anchored CLI reader", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const evidence = await writeCompletedClientEvidence(fixture.root, "accepted-swap.json");
  const retained = join(fixture.root, "accepted-swap-retained.json");
  await assert.rejects(recordClientAcceptance(fixture.root, evidence, {
    inputRead: {
      async afterPathStat() {
        await rename(evidence, retained);
        await writeFile(evidence, '{"application":"WPS"}\n', { mode: 0o600 });
      },
    },
  }), /client acceptance input must be a regular 0600 file/i);
  assert.equal((await readProject(fixture.root)).stage, "assembling");
});

test("rejects a coordinated rewrite of an orphaned immutable acceptance record", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  });
  const evidence = await writeCompletedClientEvidence(fixture.root, "accepted-tamper.json");
  await assert.rejects(recordClientAcceptance(fixture.root, evidence, {
    checkpoint: (step) => {
      if (step === "record-promoted") throw new Error("simulated hard crash");
    },
  }), /simulated hard crash/);
  const record = join(fixture.root, "output", "revisions", "1", "acceptance-record.json");
  const forged = AcceptanceSchema.parse(JSON.parse(await readFile(record, "utf8")));
  await writeFile(record, `${JSON.stringify({ ...forged, providerId: "forged-provider" }, null, 2)}\n`);
  await assert.rejects(
    recordClientAcceptance(fixture.root, evidence),
    /immutable acceptance record does not match current client evidence/,
  );
  assert.equal((await readProject(fixture.root)).stage, "assembling");
});

test("uses only injected workspace runtime paths and a platform PATH delimiter", async () => {
  const source = await readFile(join(process.cwd(), "src", "deck", "pptx.ts"), "utf8");
  const tests = await readFile(join(process.cwd(), "tests", "deck.test.ts"), "utf8");
  assert.doesNotMatch(source, /\/Users\/neomei/);
  assert.doesNotMatch(tests, /\/Users\/neomei/);
  assert.match(source, /delimiter/);
  assert.doesNotMatch(source, /PATH:\s*`\$\{runtime\.binDir\}:\$\{/);
});
