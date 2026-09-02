import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";
import sharp from "sharp";

import { buildAcceptance } from "../src/acceptance/build.js";
import { AcceptanceSchema } from "../src/acceptance/schema.js";
import {
  configureGenerationAuthorizationTrustForTests,
} from "../src/generation/trusted-authorization.js";
import {
  assembleDeck,
  assembleProjectCandidate,
  type AssembleProjectOperations,
  type FinalRender,
} from "../src/deck/assemble.js";
import { createDeckCandidate, readCurrentDeckPointer } from "../src/deck-revisions/store.js";
import { approveGate, assertGateCurrent } from "../src/planning/confirm.js";
import { publishPlanViews } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import {
  applyDeckReviewAction,
  authenticateCurrentDeckEditSelection,
  promoteApprovedCandidate,
  publishDeckReview,
} from "../src/project/promotion.js";
import {
  readProject,
  updateProject,
} from "../src/project/store.js";
import { applyRevision, approveImpact, publishImpactPlan } from "../src/revisions/apply.js";
import { finalizeDelegatedStyleSampleForTest } from "./helpers/delegated-style-sample.js";
import { authorizeCompleteDeckEdit } from "./helpers/deck-edit.js";

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

async function fakeOutputs(renders: FinalRender[], paths: { pptx: string }): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [index, render] of renders.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld><p:pic><p:cNvPr name=\"page-${render.id}\"/><a:blip r:embed=\"rIdImage\"/></p:pic></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships><Relationship Id=\"rIdImage\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/image${index + 1}.png\"/></Relationships>`);
    zip.file(`ppt/media/image${index + 1}.png`, render.bytes);
  }
  await writeFile(paths.pptx, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
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

async function fakeUnboundOutputs(renders: FinalRender[], paths: { pptx: string }): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [index, render] of renders.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld><p:pic><p:cNvPr name=\"page-${render.id}\"/></p:pic></p:sld>`);
  }
  await writeFile(paths.pptx, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
}

test("uses the ordered final renders for the complete PPTX", async (t) => {
  const root = await directory(t);
  const first = await image(join(root, "first.png"), "#dc503c");
  const second = await image(join(root, "second.png"), "#1e64c8");
  const pages = [
    { id: "second", order: 1, mode: "image" as const, render: second.path, expectedSha256: second.sha256 },
    { id: "first", order: 0, mode: "image" as const, render: first.path, expectedSha256: first.sha256 },
  ];
  const pptx = join(root, "deck.pptx");

  await assembleDeck(pages, pptx);

  const zip = await JSZip.loadAsync(await readFile(pptx));
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideNames.length, 2);
  const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const slide2 = await zip.file("ppt/slides/slide2.xml")!.async("string");
  assert.match(slide1, /name="page-first"/);
  assert.match(slide2, /name="page-second"/);
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

test("assembles without Codex runtime and rejects output escaping the trusted root", async (t) => {
  const root = await directory(t);
  const render = await image(join(root, "page.png"), "#123456");
  const runtime = {
    RUNTIME_NODE: process.env.RUNTIME_NODE,
    RUNTIME_NODE_MODULES: process.env.RUNTIME_NODE_MODULES,
    RUNTIME_BIN_DIR: process.env.RUNTIME_BIN_DIR,
  };
  delete process.env.RUNTIME_NODE;
  delete process.env.RUNTIME_NODE_MODULES;
  delete process.env.RUNTIME_BIN_DIR;
  try {
    await assembleDeck([
      { id: "page", order: 0, mode: "image", render: render.path },
    ], join(root, "one-page.pptx"), { trustedRoot: root });

    const outside = await directory(t);
    const redirect = join(root, "redirect");
    await symlink(outside, redirect);
    await assert.rejects(assembleDeck([
      { id: "page", order: 0, mode: "image", render: render.path },
    ], join(redirect, "escaped.pptx"), { trustedRoot: root }), /output escaped the trusted root/);
  } finally {
    for (const [name, value] of Object.entries(runtime)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("builds revision-bound initial acceptance with physical artifact hashes", async (t) => {
  const root = await directory(t);
  const render = await image(join(root, "page.png"), "#123456");
  const pptx = join(root, "deck.pptx");
  await writeFile(pptx, "pptx");
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
    exports: { pptx },
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
  assert.equal(acceptance.exports.pptx.path, pptx);
  assert.equal(acceptance.exports.pptx.sha256, createHash("sha256").update(await readFile(pptx)).digest("hex"));
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
    exports: { pptx: render.path },
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
  const acceptance = AcceptanceSchema.parse(JSON.parse(await readFile(join(fixture.root, manifest.exports.acceptance!.path), "utf8")));
  assert.equal(acceptance.deliveryComplete, false);
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

test("production candidate assembly bootstraps the initial immutable deck revision and current pointer", async (t) => {
  const fixture = await readyProject(t);
  await authorizeDeckGeneration(fixture.root);
  await assembleProjectCandidate(fixture.root);
  const current = await readCurrentDeckPointer(fixture.root);
  await updateProject(fixture.root, (manifest) => ({ ...manifest, stage: "deck-review" }));
  await authorizeCompleteDeckEdit(fixture.root, PROJECT_SLIDES[0]);
  assert.match(current.relativePath, /^output\/deck-revisions\/[0-9a-f-]{36}\/deck\.pptx$/);
  const edit = await createDeckCandidate(fixture.root, {
    sourceRevisionId: current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [PROJECT_SLIDES[0]],
    editableSlideIds: [],
    targetSlideId: PROJECT_SLIDES[0],
    mode: "manual",
  });
  assert.equal(edit.parentRevisionId, current.revisionId);
});

test("candidate assembly emits only a complete PPTX and structural acceptance evidence", async (t) => {
  const fixture = await readyProject(t);
  await authorizeDeckGeneration(fixture.root);

  const candidate = await assembleProjectCandidate(fixture.root, { buildOutputs: fakeOutputs });

  assert.deepEqual(Object.keys(candidate.artifacts).sort(), ["acceptance", "pptx"]);
  await assert.rejects(access(join(candidate.destination, "deck.pdf")), { code: "ENOENT" });
  await assert.rejects(access(join(candidate.destination, "montage.jpg")), { code: "ENOENT" });
  await assert.rejects(access(join(candidate.destination, "slides")), { code: "ENOENT" });
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
  await writeFile(join(tampered.root, candidate.artifacts.pptx.path), "wrong candidate pptx");
  await assert.rejects(
    applyDeckReviewAction(tampered.root, {
      action: "confirm-delivery",
      candidateId: candidate.candidateId,
      descriptorSha256: review.descriptorSha256,
    }),
    /PPTX|hash|evidence|tamper|candidate/i,
  );
  assert.equal(await assertGateCurrent(tampered.root, "deck-review"), false);
  await assert.rejects(promoteApprovedCandidate(tampered.root, candidate.candidateId), /action|deck-review|PPTX|candidate/i);
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

test("legacy manual discard helper is not a current entrypoint", async () => {
  await assert.rejects(access(join(process.cwd(), "scripts", "acceptance-smoke.sh")), { code: "ENOENT" });
});

test("removes candidate assembly and legacy acceptance CLI entrypoints", async (t) => {
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
  assert.match(assembleError, /complete deck|current-deck-link|prepare-manual-deck/i);
  assert.doesNotMatch(assembleError, /unknown command/);

  for (const command of ["acceptance", "acceptance-smoke-copy", "acceptance-record"]) {
    const error = await invoke([command, "--project", root]);
    assert.match(error, /unknown command/, command);
  }
});

test("rejects a PPTX that names pages but has no bound media relationships", async (t) => {
  const fixture = await readyProject(t);
  await assert.rejects(deliverReviewedCandidate({
    root: fixture.root,
    operations: { buildOutputs: fakeUnboundOutputs },
  }), /PPTX.*media|media.*PPTX/i);
});

test("removes the preview-bound confirm-delivery CLI in favor of exact complete-deck review evidence", async () => {
  const cli = join(process.cwd(), "src", "cli.ts");
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", cli, "deck-review-action"]),
    /complete deck|current-deck-link|prepare-manual-deck/i,
  );
});

test("delegates PPTX writing without workspace runtime paths", async () => {
  const source = await readFile(join(process.cwd(), "src", "deck", "pptx.ts"), "utf8");
  const tests = await readFile(join(process.cwd(), "tests", "deck.test.ts"), "utf8");
  assert.doesNotMatch(source, /\/Users\/neomei/);
  assert.doesNotMatch(tests, /\/Users\/neomei/);
  assert.doesNotMatch(source, /runtime|delimiter|PATH:/i);
  assert.match(source, /return writePresentation\(pages, output, trustedRoot\);/);
});
