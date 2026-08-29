import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
import {
  appendTrustedGenerationCallLedgerEntry,
  configureGenerationAuthorizationTrustForTests,
  readTrustedClientAcceptanceCommitment,
} from "../src/generation/trusted-authorization.js";
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
import { normalizeInput } from "../src/planning/intake.js";
import { initializeProject } from "../src/project/initialize.js";
import {
  applyDeckReviewAction,
  authenticateCurrentDeckEditSelection,
  promoteApprovedCandidate,
  publishDeckReview,
} from "../src/project/promotion.js";
import { ClientSmokeCopyAnchorSchema, ProjectManifestSchema } from "../src/project/schemas.js";
import {
  beginProjectRollbackTransaction,
  commitApprovedImpactRevision,
  readProject,
  updateProject,
  updateProjectWithDelegatedGenerationAttachment,
} from "../src/project/store.js";
import * as projectStore from "../src/project/store.js";
import { applyRevision, approveImpact, publishImpactPlan, recoverRollbackTransaction } from "../src/revisions/apply.js";
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

async function rewriteAcceptanceTransactionForConflictingInput(
  root: string,
  originalEvidence: string,
  name: string,
): Promise<string> {
  const manifest = await readProject(root);
  const anchor = manifest.clientSmokeCopyAnchor!;
  const submitted = JSON.parse(await readFile(originalEvidence, "utf8"));
  const conflicting = {
    ...submitted,
    selectedObject: "slide-9:forged-title",
    observedResult: "coordinated forged observation and acceptance record",
    confirmedAt: new Date(Date.parse(submitted.confirmedAt) + 1_000).toISOString(),
  };
  const observationPath = join(root, "output", "revisions", "1", "acceptance-observation.json");
  const observation = JSON.parse(await readFile(observationPath, "utf8"));
  const forgedObservation = {
    ...observation,
    selectedObject: conflicting.selectedObject,
    observedResult: conflicting.observedResult,
    confirmedAt: conflicting.confirmedAt,
  };
  const observationBytes = Buffer.from(`${JSON.stringify(forgedObservation, null, 2)}\n`);
  const observationArtifact = {
    path: "output/revisions/1/acceptance-observation.json",
    sha256: createHash("sha256").update(observationBytes).digest("hex"),
    revisionId: manifest.currentRevision.id,
  };
  const base = await readProjectAcceptance(root);
  const forgedAcceptance = AcceptanceSchema.parse({
    ...base,
    deliveryComplete: true,
    clientAcceptance: {
      application: conflicting.application,
      observation: observationArtifact,
      smokeCopy: {
        descriptorPath: anchor.descriptor.path,
        descriptorSha256: anchor.descriptor.sha256,
        path: anchor.initialCopy.path,
        initialSha256: anchor.initialCopy.sha256,
        reopenedSha256: conflicting.reopenedCopySha256,
      },
      selectedObject: conflicting.selectedObject,
      temporaryEditObserved: true,
      undoObserved: true,
      saveDecision: "discarded",
      reopenObserved: true,
      observedResult: conflicting.observedResult,
      confirmedAt: conflicting.confirmedAt,
    },
  });
  await writeFile(observationPath, observationBytes);
  await writeFile(
    join(root, "output", "revisions", "1", "acceptance-record.json"),
    `${JSON.stringify(forgedAcceptance, null, 2)}\n`,
  );
  const manifestPath = join(root, "superppt.json");
  const coordinatedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  coordinatedManifest.clientAcceptanceTransaction = {
    ...coordinatedManifest.clientAcceptanceTransaction,
    observation: observationArtifact,
    acceptanceRecord: {
      path: "output/revisions/1/acceptance-record.json",
      sha256: createHash("sha256")
        .update(`${JSON.stringify(forgedAcceptance, null, 2)}\n`)
        .digest("hex"),
      revisionId: manifest.currentRevision.id,
    },
    confirmedAt: conflicting.confirmedAt,
  };
  await writeFile(manifestPath, `${JSON.stringify(coordinatedManifest, null, 2)}\n`);
  const conflictingEvidence = join(root, name);
  await writeFile(conflictingEvidence, `${JSON.stringify(conflicting)}\n`, { mode: 0o600 });
  return conflictingEvidence;
}

function deckTrustKey(root: string): Buffer {
  return createHash("sha256").update(`superppt-deck-test:${root}`).digest();
}

function signTrustedBase(key: Buffer, base: object): string {
  return createHmac("sha256", key).update(JSON.stringify(base)).digest("hex");
}

async function rewriteLatestRegistryStateAsV1(root: string): Promise<void> {
  const projectId = (await readProject(root)).projectId;
  const statesRoot = join(root, "..", "authorization-trust", "project-registry", projectId, "states");
  const statePath = join(statesRoot, (await readdir(statesRoot)).sort().at(-1)!);
  const currentState = JSON.parse(await readFile(statePath, "utf8"));
  const stateBase = {
    schemaVersion: 1,
    kind: currentState.kind,
    projectId: currentState.projectId,
    registrationSha256: currentState.registrationSha256,
    version: currentState.version,
    predecessorStateSha256: currentState.predecessorStateSha256,
    authorization: currentState.authorization,
    calls: currentState.calls,
  };
  await writeFile(statePath, `${JSON.stringify({
    ...stateBase,
    signature: signTrustedBase(deckTrustKey(root), stateBase),
  }, null, 2)}\n`, { mode: 0o600 });
}

async function rewriteAcceptanceHistoryAsLegacyV1(root: string): Promise<void> {
  const projectId = (await readProject(root)).projectId;
  const trustRoot = join(root, "..", "authorization-trust");
  const acceptanceRoot = join(trustRoot, "client-acceptance", projectId);
  const eventsRoot = join(acceptanceRoot, "events");
  const headsRoot = join(acceptanceRoot, "heads");
  const eventNames = (await readdir(eventsRoot)).sort();
  const headNames = (await readdir(headsRoot)).sort();
  const key = deckTrustKey(root);
  let predecessorEvent: { eventId: string; eventSha256: string } | null = null;
  let predecessorHeadSha256: string | null = null;
  let currentHeadSha256: string | null = null;

  for (const [index, eventName] of eventNames.entries()) {
    const rawEvent = JSON.parse(await readFile(join(eventsRoot, eventName), "utf8"));
    const eventBase: Record<string, unknown> = {
      schemaVersion: 1,
      kind: rawEvent.kind,
      eventId: rawEvent.eventId,
      projectId: rawEvent.projectId,
      sequence: rawEvent.sequence,
      predecessor: predecessorEvent,
      state: rawEvent.state,
      commitment: rawEvent.commitment,
      completedAnchorSha256: rawEvent.completedAnchorSha256,
    };
    const eventBytes: Buffer = Buffer.from(`${JSON.stringify({
      ...eventBase,
      signature: signTrustedBase(key, eventBase),
    }, null, 2)}\n`);
    await writeFile(join(eventsRoot, eventName), eventBytes, { mode: 0o600 });
    const eventSha256: string = createHash("sha256").update(eventBytes).digest("hex");

    const rawHead = JSON.parse(await readFile(join(headsRoot, headNames[index]!), "utf8"));
    const headBase: Record<string, unknown> = {
      schemaVersion: 1,
      kind: rawHead.kind,
      projectId: rawHead.projectId,
      sequence: rawHead.sequence,
      eventId: rawHead.eventId,
      eventSha256,
      state: rawHead.state,
      transactionId: rawHead.transactionId,
      predecessorHeadSha256,
    };
    const headBytes: Buffer = Buffer.from(`${JSON.stringify({
      ...headBase,
      signature: signTrustedBase(key, headBase),
    }, null, 2)}\n`);
    await writeFile(join(headsRoot, headNames[index]!), headBytes, { mode: 0o600 });
    currentHeadSha256 = createHash("sha256").update(headBytes).digest("hex");
    predecessorEvent = { eventId: rawEvent.eventId, eventSha256 };
    predecessorHeadSha256 = currentHeadSha256;
  }

  assert.ok(currentHeadSha256);
  await rewriteLatestRegistryStateAsV1(root);
  await rm(join(trustRoot, "project-registrations", projectId, "acceptances"), { recursive: true, force: true });
  await rm(join(trustRoot, "project-registrations", projectId, "authority"), { recursive: true, force: true });
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
  const acceptanceTrustRoot = join(
    fixture.root,
    "..",
    "authorization-trust",
    "client-acceptance",
    delivered.projectId,
  );
  assert.equal((await readdir(join(acceptanceTrustRoot, "events"))).length, 2);
  assert.equal((await readdir(join(acceptanceTrustRoot, "heads"))).length, 2);
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
  })), /client acceptance trust fields require a controlled store transition/);

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

test("completed acceptance blocks ordinary same-revision mutation and permits a controlled descendant revision", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  });
  const evidence = await writeCompletedClientEvidence(fixture.root, "accepted-mode-change.json");
  const completed = await recordClientAcceptance(fixture.root, evidence);
  assert.equal(completed.deliveryComplete, true);
  assert.deepEqual(completed.editablePageIds, []);
  const delivered = await readProject(fixture.root);
  const deliveredBytes = await readFile(join(fixture.root, "superppt.json"));

  await assert.rejects(updateProject(fixture.root, (manifest) => ({
    ...manifest,
    slides: manifest.slides.map((slide, index) => index === 0 ? {
      ...slide,
      status: "editable" as const,
    } : slide),
  })), /completed client acceptance|explicit.*revision|frozen/i);
  assert.deepEqual(await readFile(join(fixture.root, "superppt.json")), deliveredBytes);

  const plan = await publishImpactPlan(fixture.root, { kind: "brief", title: "Controlled revision" });
  await approveImpact(fixture.root, plan.sha256);
  await applyRevision(fixture.root, plan, plan.change);
  const revised = await readProject(fixture.root);
  assert.equal(revised.currentRevision.number, 2);
  assert.equal(revised.currentRevision.parentId, delivered.currentRevision.id);
  assert.equal(revised.stage, plan.restartStage);
  assert.equal((await updateProject(fixture.root, (manifest) => ({
    ...manifest,
    title: "Ordinary work after authenticated descent",
  }))).title, "Ordinary work after authenticated descent");
});

test("completed acceptance rejects a forged or reordered descendant manifest", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const evidence = await writeCompletedClientEvidence(fixture.root, "forged-descendant.json");
  assert.equal((await recordClientAcceptance(fixture.root, evidence)).deliveryComplete, true);
  const delivered = await readProject(fixture.root);
  const forgedRevision = {
    id: "00000000-0000-4000-8000-000000000997",
    number: delivered.currentRevision.number + 1,
    createdAt: new Date().toISOString(),
    parentId: delivered.currentRevision.id,
    parentSnapshotDescriptorSha256: "f".repeat(64),
  };
  await writeFile(join(fixture.root, "superppt.json"), `${JSON.stringify({
    ...delivered,
    stage: "outline",
    currentRevision: forgedRevision,
    revisions: [...delivered.revisions, forgedRevision],
  }, null, 2)}\n`);

  await assert.rejects(
    updateProject(fixture.root, (manifest) => ({ ...manifest, title: "forged mutation" })),
    /revision ancestry|strictly newer descendant|snapshot|reordered|frozen/i,
  );
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
  for (const checkpoint of [
    "observation-promoted",
    "record-promoted",
    "manifest-completed-before-external",
    "external-completed-committed",
    "manifest-updated",
  ] as const) {
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
    assert.equal(
      crashed.stage,
      ["manifest-completed-before-external", "external-completed-committed", "manifest-updated"].includes(checkpoint)
        ? "delivered"
        : "assembling",
    );
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

test("first discard commitment rejects coordinated observation and record rewrites after crash", async (t) => {
  for (const checkpoint of ["observation-promoted", "record-promoted"] as const) {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    const original = await writeCompletedClientEvidence(fixture.root, `original-${checkpoint}.json`);
    await assert.rejects(recordClientAcceptance(fixture.root, original, {
      checkpoint: (step) => {
        if (step === checkpoint) throw new Error(`crash before completion at ${checkpoint}`);
      },
    }), new RegExp(`crash before completion at ${checkpoint}`));
    const originalObservation = await readFile(join(fixture.root, "output", "revisions", "1", "acceptance-observation.json"));
    const conflicting = await rewriteAcceptanceTransactionForConflictingInput(
      fixture.root,
      original,
      `conflicting-${checkpoint}.json`,
    );

    await assert.rejects(
      recordClientAcceptance(fixture.root, conflicting),
      /first-write|commitment|immutable client acceptance transaction|acceptance registration/i,
    );
    assert.equal((await readProject(fixture.root)).stage, "assembling");

    const recovered = await recordClientAcceptance(fixture.root, original);
    assert.equal(recovered.deliveryComplete, true);
    assert.equal((await readProject(fixture.root)).clientAcceptanceTransaction, undefined);
    assert.deepEqual(
      await readFile(join(fixture.root, "output", "revisions", "1", "acceptance-observation.json")),
      originalObservation,
    );
  }
});

test("external acceptance commitment freezes mutations before the local marker and exact replay recovers", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const original = await writeCompletedClientEvidence(fixture.root, "external-pending-original.json");
  await assert.rejects(recordClientAcceptance(fixture.root, original, {
    checkpoint(step) {
      if (step === "external-pending-committed") throw new Error("crash after external first write");
    },
  }), /crash after external first write/);
  const before = await readFile(join(fixture.root, "superppt.json"));
  const projectId = (await readProject(fixture.root)).projectId;
  assert.equal((await readProject(fixture.root)).clientAcceptanceTransaction, undefined);
  const trustRoot = join(fixture.root, "..", "authorization-trust");
  const acceptanceRoot = join(trustRoot, "client-acceptance", projectId);
  const registryStates = join(trustRoot, "project-registry", projectId, "states");
  const beforeFrozenEvidence = {
    events: await readdir(join(acceptanceRoot, "events")),
    heads: await readdir(join(acceptanceRoot, "heads")),
    registry: await readdir(registryStates),
    smoke: await readdir(join(fixture.root, "output", "revisions", "1", "client-smoke")),
    planningViews: await readFile(join(fixture.root, "planning-views.json")),
  };

  await assert.rejects(updateProject(fixture.root, (manifest) => ({ ...manifest, title: "forged while pending" })), /client acceptance.*pending|frozen/i);
  await assert.rejects(updateProjectWithDelegatedGenerationAttachment(fixture.root, (manifest) => ({
    ...manifest,
    title: "delegated mutation while pending",
  })), /client acceptance.*pending|frozen/i);
  await assert.rejects(commitApprovedImpactRevision(fixture.root, {} as never, {} as never), /client acceptance.*pending|frozen/i);
  await assert.rejects(beginProjectRollbackTransaction(fixture.root, (await readProject(fixture.root)).currentRevision.id), /client acceptance.*pending|frozen/i);
  await assert.rejects(recoverRollbackTransaction(fixture.root), /client acceptance.*pending|frozen/i);
  await assert.rejects(assembleProjectCandidate(fixture.root, { buildOutputs: fakeOutputs }), /client acceptance.*pending|frozen/i);
  await assert.rejects(applyDeckReviewAction(fixture.root, {} as never), /client acceptance.*pending|frozen/i);
  await assert.rejects(createClientSmokeCopy(fixture.root), /client acceptance.*pending|frozen/i);
  await assert.rejects(publishPlanViews(fixture.root), /client acceptance.*pending|frozen/i);
  await assert.rejects(publishImpactPlan(fixture.root, { kind: "style" }), /client acceptance.*pending|frozen/i);
  await assert.rejects(access(join(fixture.root, "revisions", "pending-impact.json")));
  assert.deepEqual(await readFile(join(fixture.root, "superppt.json")), before);
  assert.deepEqual({
    events: await readdir(join(acceptanceRoot, "events")),
    heads: await readdir(join(acceptanceRoot, "heads")),
    registry: await readdir(registryStates),
    smoke: await readdir(join(fixture.root, "output", "revisions", "1", "client-smoke")),
    planningViews: await readFile(join(fixture.root, "planning-views.json")),
  }, beforeFrozenEvidence);

  const recovered = await recordClientAcceptance(fixture.root, original);
  assert.equal(recovered.deliveryComplete, true);
});

test("independent acceptance registration survives acceptance and registry-tail deletion", async (t) => {
  await t.test("pending first write", async (t) => {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    const original = await writeCompletedClientEvidence(fixture.root, "registration-pending-original.json");
    await assert.rejects(recordClientAcceptance(fixture.root, original, {
      checkpoint(step) {
        if (step === "record-promoted") throw new Error("retain local pending evidence");
      },
    }), /retain local pending evidence/);
    const projectId = (await readProject(fixture.root)).projectId;
    const trustRoot = join(fixture.root, "..", "authorization-trust");
    await rm(join(trustRoot, "client-acceptance", projectId), { recursive: true, force: true });
    const statesRoot = join(trustRoot, "project-registry", projectId, "states");
    for (const name of await readdir(statesRoot)) await unlink(join(statesRoot, name));
    const conflicting = await rewriteAcceptanceTransactionForConflictingInput(
      fixture.root,
      original,
      "registration-pending-conflict.json",
    );

    await assert.rejects(
      recordClientAcceptance(fixture.root, conflicting),
      /acceptance registration|immutable first write|trusted client acceptance/i,
    );
    assert.equal((await readdir(join(
      trustRoot,
      "project-registrations",
      projectId,
      "acceptances",
    ))).length, 1);
  });

  await t.test("completed first write", async (t) => {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    const original = await writeCompletedClientEvidence(fixture.root, "registration-completed-original.json");
    const readyManifest = await readFile(join(fixture.root, "superppt.json"));
    assert.equal((await recordClientAcceptance(fixture.root, original)).deliveryComplete, true);
    const delivered = await readProject(fixture.root);
    const trustRoot = join(fixture.root, "..", "authorization-trust");
    await rm(join(trustRoot, "client-acceptance", delivered.projectId), { recursive: true, force: true });
    const statesRoot = join(trustRoot, "project-registry", delivered.projectId, "states");
    for (const name of await readdir(statesRoot)) await unlink(join(statesRoot, name));
    await writeFile(join(fixture.root, "superppt.json"), readyManifest);
    await unlink(join(fixture.root, "output", "revisions", "1", "acceptance-observation.json"));
    await unlink(join(fixture.root, "output", "revisions", "1", "acceptance-record.json"));
    const submitted = JSON.parse(await readFile(original, "utf8"));
    const conflicting = join(fixture.root, "registration-completed-conflict.json");
    await writeFile(conflicting, `${JSON.stringify({
      ...submitted,
      selectedObject: "slide-3:conflicting-title",
      confirmedAt: new Date(Date.parse(submitted.confirmedAt) + 1000).toISOString(),
    })}\n`, { mode: 0o600 });

    await assert.rejects(
      recordClientAcceptance(fixture.root, conflicting),
      /acceptance registration|completed|immutable first write|trusted client acceptance/i,
    );
    assert.equal((await readdir(join(
      trustRoot,
      "project-registrations",
      delivered.projectId,
      "acceptances",
    ))).length, 1);
  });
});

test("root acceptance authority survives combined child registration, chain, and registry suffix deletion", async (t) => {
  await t.test("pending commitment", async (t) => {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    const original = await writeCompletedClientEvidence(fixture.root, "root-authority-pending-original.json");
    const projectId = (await readProject(fixture.root)).projectId;
    const trustRoot = join(fixture.root, "..", "authorization-trust");
    const statesRoot = join(trustRoot, "project-registry", projectId, "states");
    const registryPrefix = new Set(await readdir(statesRoot));
    await assert.rejects(recordClientAcceptance(fixture.root, original, {
      checkpoint(step) {
        if (step === "record-promoted") throw new Error("retain pending local evidence");
      },
    }), /retain pending local evidence/);
    await rm(join(trustRoot, "project-registrations", projectId, "acceptances"), { recursive: true, force: true });
    await rm(join(trustRoot, "client-acceptance", projectId), { recursive: true, force: true });
    for (const name of await readdir(statesRoot)) {
      if (!registryPrefix.has(name)) await unlink(join(statesRoot, name));
    }
    await rewriteLatestRegistryStateAsV1(fixture.root);
    const conflicting = await rewriteAcceptanceTransactionForConflictingInput(
      fixture.root,
      original,
      "root-authority-pending-conflict.json",
    );

    await assert.rejects(
      recordClientAcceptance(fixture.root, conflicting),
      /root authority|registration set|trust recovery|immutable first write/i,
    );
  });

  await t.test("completed commitment", async (t) => {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    const projectId = (await readProject(fixture.root)).projectId;
    const trustRoot = join(fixture.root, "..", "authorization-trust");
    const statesRoot = join(trustRoot, "project-registry", projectId, "states");
    const registryPrefix = new Set(await readdir(statesRoot));
    const original = await writeCompletedClientEvidence(fixture.root, "root-authority-completed-original.json");
    const readyManifest = await readFile(join(fixture.root, "superppt.json"));
    assert.equal((await recordClientAcceptance(fixture.root, original)).deliveryComplete, true);
    await rm(join(trustRoot, "project-registrations", projectId, "acceptances"), { recursive: true, force: true });
    await rm(join(trustRoot, "client-acceptance", projectId), { recursive: true, force: true });
    for (const name of await readdir(statesRoot)) {
      if (!registryPrefix.has(name)) await unlink(join(statesRoot, name));
    }
    await rewriteLatestRegistryStateAsV1(fixture.root);
    await writeFile(join(fixture.root, "superppt.json"), readyManifest);
    await unlink(join(fixture.root, "output", "revisions", "1", "acceptance-observation.json"));
    await unlink(join(fixture.root, "output", "revisions", "1", "acceptance-record.json"));
    const submitted = JSON.parse(await readFile(original, "utf8"));
    const conflicting = join(fixture.root, "root-authority-completed-conflict.json");
    await writeFile(conflicting, `${JSON.stringify({
      ...submitted,
      selectedObject: "slide-8:conflicting-title",
      confirmedAt: new Date(Date.parse(submitted.confirmedAt) + 1_000).toISOString(),
    })}\n`, { mode: 0o600 });

    await assert.rejects(
      recordClientAcceptance(fixture.root, conflicting),
      /root authority|registration set|trust recovery|immutable first write/i,
    );
  });
});

test("root acceptance authority current head rejects deletion, downgrade, tamper, unsafe mode, symlink, and predecessor fork", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const original = await writeCompletedClientEvidence(fixture.root, "root-authority-head-original.json");
  await assert.rejects(recordClientAcceptance(fixture.root, original, {
    checkpoint(step) {
      if (step === "external-pending-committed") throw new Error("retain root authority pending state");
    },
  }), /retain root authority pending state/);
  const projectId = (await readProject(fixture.root)).projectId;
  const authorityRoot = join(
    fixture.root,
    "..",
    "authorization-trust",
    "project-registrations",
    projectId,
    "authority",
  );
  const currentPath = join(authorityRoot, "current.json");
  const headsRoot = join(authorityRoot, "heads");
  const statesRoot = join(authorityRoot, "states");
  const currentBytes = await readFile(currentPath);
  const headNames = (await readdir(headsRoot)).sort();
  const latestHeadPath = join(headsRoot, headNames.at(-1)!);
  const latestHeadBytes = await readFile(latestHeadPath);
  const stateNames = (await readdir(statesRoot)).sort();

  await unlink(currentPath);
  await assert.rejects(updateProject(fixture.root, (manifest) => ({ ...manifest, title: "missing authority" })), /root authority|current head|trust recovery/i);
  await writeFile(currentPath, currentBytes, { mode: 0o600 });

  const removedAuthorityTail = await Promise.all(stateNames.slice(1).map(async (name, index) => ({
    stateName: name,
    stateBytes: await readFile(join(statesRoot, name)),
    headName: headNames[index + 1]!,
    headBytes: await readFile(join(headsRoot, headNames[index + 1]!)),
  })));
  for (const tail of removedAuthorityTail) {
    await unlink(join(statesRoot, tail.stateName));
    await unlink(join(headsRoot, tail.headName));
  }
  await writeFile(currentPath, await readFile(join(headsRoot, headNames[0]!)), { mode: 0o600 });
  await assert.rejects(
    updateProject(fixture.root, (manifest) => ({ ...manifest, title: "coordinated authority rollback" })),
    /root authority|registration set|high-water|trust recovery/i,
  );
  for (const tail of removedAuthorityTail) {
    await writeFile(join(statesRoot, tail.stateName), tail.stateBytes, { mode: 0o600 });
    await writeFile(join(headsRoot, tail.headName), tail.headBytes, { mode: 0o600 });
  }
  await writeFile(currentPath, currentBytes, { mode: 0o600 });

  await writeFile(currentPath, await readFile(join(headsRoot, headNames[0]!)), { mode: 0o600 });
  await assert.rejects(updateProject(fixture.root, (manifest) => ({ ...manifest, title: "downgraded authority" })), /root authority|downgraded|current head/i);
  await writeFile(currentPath, currentBytes, { mode: 0o600 });

  const tamperedCurrent = JSON.parse(currentBytes.toString("utf8"));
  tamperedCurrent.authoritySha256 = "f".repeat(64);
  await writeFile(currentPath, `${JSON.stringify(tamperedCurrent, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(updateProject(fixture.root, (manifest) => ({ ...manifest, title: "tampered authority" })), /root authority|signature|current head/i);
  await writeFile(currentPath, currentBytes, { mode: 0o600 });

  await chmod(currentPath, 0o644);
  await assert.rejects(updateProject(fixture.root, (manifest) => ({ ...manifest, title: "wrong authority mode" })), /mode 0600|root authority|current head/i);
  await chmod(currentPath, 0o600);

  const detachedCurrent = `${currentPath}.detached`;
  await rename(currentPath, detachedCurrent);
  await symlink(detachedCurrent, currentPath);
  await assert.rejects(updateProject(fixture.root, (manifest) => ({ ...manifest, title: "linked authority" })), /root authority|current head|symbolic link|regular file/i);
  await unlink(currentPath);
  await rename(detachedCurrent, currentPath);

  const latestStatePath = join(statesRoot, stateNames.at(-1)!);
  const latestStateBytes = await readFile(latestStatePath);
  const rawState = JSON.parse(latestStateBytes.toString("utf8"));
  const forkedStateBase = {
    schemaVersion: rawState.schemaVersion,
    kind: rawState.kind,
    projectId: rawState.projectId,
    baseRegistrationSha256: rawState.baseRegistrationSha256,
    version: rawState.version,
    predecessorAuthoritySha256: "e".repeat(64),
    clientAcceptance: rawState.clientAcceptance,
  };
  const forkedStateBytes = Buffer.from(`${JSON.stringify({
    ...forkedStateBase,
    signature: signTrustedBase(deckTrustKey(fixture.root), forkedStateBase),
  }, null, 2)}\n`);
  await writeFile(latestStatePath, forkedStateBytes, { mode: 0o600 });
  const rawHead = JSON.parse(latestHeadBytes.toString("utf8"));
  const forkedHeadBase = {
    schemaVersion: rawHead.schemaVersion,
    kind: rawHead.kind,
    projectId: rawHead.projectId,
    version: rawHead.version,
    authoritySha256: createHash("sha256").update(forkedStateBytes).digest("hex"),
    predecessorHeadSha256: rawHead.predecessorHeadSha256,
  };
  const forkedHeadBytes = Buffer.from(`${JSON.stringify({
    ...forkedHeadBase,
    signature: signTrustedBase(deckTrustKey(fixture.root), forkedHeadBase),
  }, null, 2)}\n`);
  await writeFile(latestHeadPath, forkedHeadBytes, { mode: 0o600 });
  await writeFile(currentPath, forkedHeadBytes, { mode: 0o600 });
  await assert.rejects(updateProject(fixture.root, (manifest) => ({ ...manifest, title: "forked authority" })), /root authority|predecessor|fork/i);
});

test("delivered project copied without its external trust root fails closed", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const evidence = await writeCompletedClientEvidence(fixture.root, "delivered-copy-original.json");
  assert.equal((await recordClientAcceptance(fixture.root, evidence)).deliveryComplete, true);
  const copiedRoot = join(await directory(t), "copied-delivered-project");
  await cp(fixture.root, copiedRoot, { recursive: true });
  const copiedOwnership = JSON.parse(await readFile(join(copiedRoot, ".superppt-project.json"), "utf8"));
  await writeFile(join(copiedRoot, ".superppt-project.json"), `${JSON.stringify({
    ...copiedOwnership,
    canonicalRoot: copiedRoot,
  }, null, 2)}\n`, { mode: 0o600 });
  const copiedTrustRoot = join(copiedRoot, "..", "copied-authorization-trust");
  await configureGenerationAuthorizationTrustForTests(copiedRoot, {
    root: copiedTrustRoot,
    deterministicKeySeed: `copied-delivered:${copiedRoot}`,
  });

  await assert.rejects(readTrustedClientAcceptanceCommitment(copiedRoot), /trust migration|trust recovery|trust root|authorization store.*missing/i);
  await assert.rejects(
    updateProject(copiedRoot, (manifest) => ({ ...manifest, title: "mutable copied delivery" })),
    /trust migration|trust recovery|trust root|authorization store.*missing/i,
  );
  await assert.rejects(access(copiedTrustRoot), { code: "ENOENT" });
});

test("legacy V1 acceptance history requires explicit read-only migration and preserves generation trust", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const original = await writeCompletedClientEvidence(fixture.root, "legacy-v1-pending-original.json");
  await assert.rejects(recordClientAcceptance(fixture.root, original, {
    checkpoint(step) {
      if (step === "external-pending-committed") throw new Error("retain pending legacy source");
    },
  }), /retain pending legacy source/);
  await rewriteAcceptanceHistoryAsLegacyV1(fixture.root);
  const projectId = (await readProject(fixture.root)).projectId;
  const trustRoot = join(fixture.root, "..", "authorization-trust");
  const authorityRoot = join(trustRoot, "project-registrations", projectId, "authority");
  const beforeAuthorization = await readdir(join(trustRoot, "authorization-heads", projectId, "heads"));
  const beforeCalls = await readdir(join(trustRoot, "call-ledgers", projectId, "heads")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });

  await assert.rejects(readTrustedClientAcceptanceCommitment(fixture.root), /legacy.*migration|required.*migration|trust migration/i);
  await assert.rejects(access(authorityRoot), { code: "ENOENT" });
  const trustModule = await import("../src/generation/trusted-authorization.js") as typeof import("../src/generation/trusted-authorization.js") & {
    migrateLegacyTrustedClientAcceptance?: (root: string) => Promise<void>;
  };
  assert.equal(typeof trustModule.migrateLegacyTrustedClientAcceptance, "function");
  await trustModule.migrateLegacyTrustedClientAcceptance!(fixture.root);
  assert.equal((await readTrustedClientAcceptanceCommitment(fixture.root))?.state, "pending");
  assert.deepEqual(await readdir(join(trustRoot, "authorization-heads", projectId, "heads")), beforeAuthorization);
  assert.deepEqual(await readdir(join(trustRoot, "call-ledgers", projectId, "heads")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }), beforeCalls);
  assert.equal((await recordClientAcceptance(fixture.root, original)).deliveryComplete, true);
});

test("legacy V1 completed acceptance migrates without rewriting history and deletion remains detectable", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const original = await writeCompletedClientEvidence(fixture.root, "legacy-v1-completed-original.json");
  assert.equal((await recordClientAcceptance(fixture.root, original)).deliveryComplete, true);
  await rewriteAcceptanceHistoryAsLegacyV1(fixture.root);
  const projectId = (await readProject(fixture.root)).projectId;
  const trustRoot = join(fixture.root, "..", "authorization-trust");
  const eventsRoot = join(trustRoot, "client-acceptance", projectId, "events");
  const headsRoot = join(trustRoot, "client-acceptance", projectId, "heads");
  const statesRoot = join(trustRoot, "project-registry", projectId, "states");
  const historyBefore = {
    events: await Promise.all((await readdir(eventsRoot)).sort().map((name) => readFile(join(eventsRoot, name)))),
    heads: await Promise.all((await readdir(headsRoot)).sort().map((name) => readFile(join(headsRoot, name)))),
    registryNames: (await readdir(statesRoot)).sort(),
    registry: await Promise.all((await readdir(statesRoot)).sort().map((name) => readFile(join(statesRoot, name)))),
  };
  const trustModule = await import("../src/generation/trusted-authorization.js");

  await assert.rejects(readTrustedClientAcceptanceCommitment(fixture.root), /legacy.*migration|required.*migration|trust migration/i);
  await trustModule.migrateLegacyTrustedClientAcceptance(fixture.root);
  assert.equal((await readTrustedClientAcceptanceCommitment(fixture.root))?.state, "completed");
  assert.deepEqual(
    await Promise.all((await readdir(eventsRoot)).sort().map((name) => readFile(join(eventsRoot, name)))),
    historyBefore.events,
  );
  assert.deepEqual(
    await Promise.all((await readdir(headsRoot)).sort().map((name) => readFile(join(headsRoot, name)))),
    historyBefore.heads,
  );
  for (const [index, name] of historyBefore.registryNames.entries()) {
    assert.deepEqual(await readFile(join(statesRoot, name)), historyBefore.registry[index]);
  }
  const authorityBeforeReplay = await readdir(join(trustRoot, "project-registrations", projectId, "authority", "states"));
  const registryBeforeReplay = await readdir(statesRoot);
  await trustModule.migrateLegacyTrustedClientAcceptance(fixture.root);
  assert.deepEqual(await readdir(join(trustRoot, "project-registrations", projectId, "authority", "states")), authorityBeforeReplay);
  assert.deepEqual(await readdir(statesRoot), registryBeforeReplay);

  await rm(join(trustRoot, "project-registrations", projectId, "acceptances"), { recursive: true, force: true });
  await rm(join(trustRoot, "client-acceptance", projectId), { recursive: true, force: true });
  for (const name of await readdir(statesRoot)) {
    if (!historyBefore.registryNames.includes(name)) await unlink(join(statesRoot, name));
  }
  await assert.rejects(
    readTrustedClientAcceptanceCommitment(fixture.root),
    /root authority|registration set|high-water|trust recovery/i,
  );
});

test("legacy V1 migration rejects missing delivered history and recovers exact crash checkpoints", async (t) => {
  await t.test("missing delivered history", async (t) => {
    const fixture = await readyProject(t);
    await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
    const original = await writeCompletedClientEvidence(fixture.root, "legacy-v1-missing-original.json");
    assert.equal((await recordClientAcceptance(fixture.root, original)).deliveryComplete, true);
    await rewriteAcceptanceHistoryAsLegacyV1(fixture.root);
    const projectId = (await readProject(fixture.root)).projectId;
    const trustRoot = join(fixture.root, "..", "authorization-trust");
    await rm(join(trustRoot, "client-acceptance", projectId), { recursive: true, force: true });
    await assert.rejects(
      (await import("../src/generation/trusted-authorization.js")).migrateLegacyTrustedClientAcceptance(fixture.root),
      /no surviving legacy external history|trust recovery/i,
    );
    await assert.rejects(access(join(trustRoot, "project-registrations", projectId, "authority")), { code: "ENOENT" });
  });

  for (const checkpoint of [
    "acceptance-registration-published",
    "acceptance-authority-registration-current-published",
    "registry-before-acceptance-advance",
    "acceptance-authority-completed-current-published",
  ] as const) {
    await t.test(checkpoint, async (t) => {
      const fixture = await readyProject(t);
      await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
      const original = await writeCompletedClientEvidence(fixture.root, `legacy-v1-crash-${checkpoint}.json`);
      assert.equal((await recordClientAcceptance(fixture.root, original)).deliveryComplete, true);
      await rewriteAcceptanceHistoryAsLegacyV1(fixture.root);
      const trustRoot = join(fixture.root, "..", "authorization-trust");
      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: trustRoot,
        deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
        operations: {
          checkpoint(step) {
            if (step === checkpoint) throw new Error(`injected legacy migration ${checkpoint}`);
          },
        },
      });
      await assert.rejects(
        (await import("../src/generation/trusted-authorization.js")).migrateLegacyTrustedClientAcceptance(fixture.root),
        new RegExp(`injected legacy migration ${checkpoint}`),
      );
      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: trustRoot,
        deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
      });
      await (await import("../src/generation/trusted-authorization.js")).migrateLegacyTrustedClientAcceptance(fixture.root);
      assert.equal((await readTrustedClientAcceptanceCommitment(fixture.root))?.state, "completed");
    });
  }
});

test("legacy V1 migration rejects event and head crash gaps without creating trust authority", async (t) => {
  for (const missing of ["head", "event"] as const) {
    await t.test(missing, async (t) => {
      const fixture = await readyProject(t);
      await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
      const original = await writeCompletedClientEvidence(fixture.root, `legacy-v1-${missing}-gap.json`);
      await assert.rejects(recordClientAcceptance(fixture.root, original, {
        checkpoint(step) {
          if (step === "external-pending-committed") throw new Error("retain legacy V1 gap source");
        },
      }), /retain legacy V1 gap source/);
      await rewriteAcceptanceHistoryAsLegacyV1(fixture.root);
      const projectId = (await readProject(fixture.root)).projectId;
      const trustRoot = join(fixture.root, "..", "authorization-trust");
      const acceptanceRoot = join(trustRoot, "client-acceptance", projectId);
      const gapRoot = join(acceptanceRoot, missing === "head" ? "heads" : "events");
      await unlink(join(gapRoot, (await readdir(gapRoot)).at(0)!));

      await assert.rejects(
        (await import("../src/generation/trusted-authorization.js")).migrateLegacyTrustedClientAcceptance(fixture.root),
        /missing|truncated|forked|history|event/i,
      );
      await assert.rejects(
        access(join(trustRoot, "project-registrations", projectId, "authority")),
        { code: "ENOENT" },
      );
    });
  }
});

test("blocked acceptance guard does not recreate a deleted records directory", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const original = await writeCompletedClientEvidence(fixture.root, "records-read-only-original.json");
  await assert.rejects(recordClientAcceptance(fixture.root, original, {
    checkpoint(step) {
      if (step === "external-pending-committed") throw new Error("retain pending state for read-only guard");
    },
  }), /retain pending state for read-only guard/);
  const recordsRoot = join(fixture.root, "..", "authorization-trust", "records");
  await rm(recordsRoot, { recursive: true, force: true });

  await assert.rejects(
    updateProject(fixture.root, (manifest) => ({ ...manifest, title: "blocked without records" })),
    /client acceptance.*pending|frozen|trust recovery/i,
  );
  await assert.rejects(access(recordsRoot), { code: "ENOENT" });
});

test("normalizeInput leaves source untouched while trusted acceptance is pending", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const original = await writeCompletedClientEvidence(fixture.root, "normalize-pending-original.json");
  await assert.rejects(recordClientAcceptance(fixture.root, original, {
    checkpoint(step) {
      if (step === "external-pending-committed") throw new Error("retain external pending state");
    },
  }), /retain external pending state/);
  const markdown = join(fixture.root, "pending-input.md");
  await writeFile(markdown, "# external Markdown");
  const sourceBefore = await readdir(join(fixture.root, "source"));
  let sourceOpened = 0;
  for (const request of [
    { kind: "description" as const, value: "description" },
    { kind: "text" as const, value: "plain text" },
    { kind: "markdown" as const, path: markdown },
  ]) {
    await assert.rejects(normalizeInput(fixture.root, request, {
      afterSourceOpened() { sourceOpened += 1; },
    }), /client acceptance.*pending|frozen/i);
    assert.deepEqual(await readdir(join(fixture.root, "source")), sourceBefore);
  }
  assert.equal(sourceOpened, 1, "the external Markdown is anchored before the mutation lease guard");
});

test("blocked generation ledger append never repairs acceptance crash gaps", async (t) => {
  for (const checkpoint of ["acceptance-event-published", "registry-before-acceptance-advance"] as const) {
    await t.test(checkpoint, async (t) => {
      const fixture = await readyProject(t);
      await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
      const original = await writeCompletedClientEvidence(fixture.root, `blocked-call-${checkpoint}.json`);
      const trustRoot = join(fixture.root, "..", "authorization-trust");
      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: trustRoot,
        deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
        operations: {
          checkpoint(step) {
            if (step === checkpoint) throw new Error(`injected ${checkpoint}`);
          },
        },
      });
      await assert.rejects(recordClientAcceptance(fixture.root, original), new RegExp(`injected ${checkpoint}`));
      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: trustRoot,
        deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
      });
      const project = await readProject(fixture.root);
      const acceptanceRoot = join(trustRoot, "client-acceptance", project.projectId);
      const statesRoot = join(trustRoot, "project-registry", project.projectId, "states");
      const before = {
        events: await readdir(join(acceptanceRoot, "events")),
        heads: await readdir(join(acceptanceRoot, "heads")),
        states: await readdir(statesRoot),
      };
      const jobId = "00000000-0000-4000-8000-000000000991";
      await assert.rejects(appendTrustedGenerationCallLedgerEntry(fixture.root, {
        projectId: project.projectId,
        jobId,
      } as never, {
        jobId,
        slideId: PROJECT_SLIDES[0],
        attempt: 1,
        requestOrdinal: 1,
        entryKind: "admission",
        outcome: "in-flight",
        admissionTokenSha256: null,
        recordedAt: new Date().toISOString(),
      }), /client acceptance.*pending|frozen|recovery is required|event history is missing, truncated, or forked/i);
      assert.deepEqual({
        events: await readdir(join(acceptanceRoot, "events")),
        heads: await readdir(join(acceptanceRoot, "heads")),
        states: await readdir(statesRoot),
      }, before);
      assert.equal((await recordClientAcceptance(fixture.root, original)).deliveryComplete, true);
    });
  }
});

test("trusted client acceptance rejects registry, chain, subtree, mode, symlink, truncation, and fork tamper", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const original = await writeCompletedClientEvidence(fixture.root, "external-tamper-original.json");
  await assert.rejects(recordClientAcceptance(fixture.root, original, {
    checkpoint(step) {
      if (step === "external-pending-committed") throw new Error("retain external pending state");
    },
  }), /retain external pending state/);
  const projectId = (await readProject(fixture.root)).projectId;
  const trustRoot = join(fixture.root, "..", "authorization-trust");
  const acceptanceRoot = join(trustRoot, "client-acceptance", projectId);
  const headsRoot = join(acceptanceRoot, "heads");
  const eventsRoot = join(acceptanceRoot, "events");
  const headPath = join(headsRoot, (await readdir(headsRoot)).sort().at(-1)!);
  const eventPath = join(eventsRoot, (await readdir(eventsRoot)).sort().at(-1)!);
  const statesRoot = join(trustRoot, "project-registry", projectId, "states");
  const registryRoot = join(trustRoot, "project-registry", projectId);
  const registrationRoot = join(trustRoot, "project-registrations", projectId, "acceptances");
  const registrationName = (await readdir(registrationRoot)).at(0)!;
  const registrationPath = join(registrationRoot, registrationName);
  const registryPath = join(statesRoot, (await readdir(statesRoot)).sort().at(-1)!);
  const [headBytes, eventBytes, registryBytes, registrationBytes] = await Promise.all([
    readFile(headPath),
    readFile(eventPath),
    readFile(registryPath),
    readFile(registrationPath),
  ]);

  await chmod(registrationPath, 0o644);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /mode 0600|acceptance registration/i);
  await chmod(registrationPath, 0o600);

  const tamperedRegistration = JSON.parse(registrationBytes.toString("utf8"));
  tamperedRegistration.commitment.confirmedAt = "2039-01-01T00:00:00.000Z";
  await writeFile(registrationPath, `${JSON.stringify(tamperedRegistration, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, original), /signature|acceptance registration/i);
  await writeFile(registrationPath, registrationBytes, { mode: 0o600 });

  await unlink(registrationPath);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /registration|immutable/i);
  await writeFile(registrationPath, registrationBytes, { mode: 0o600 });

  const forkRegistrationPath = join(registrationRoot, `fork-${registrationName}`);
  await copyFile(registrationPath, forkRegistrationPath);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /registration.*(?:filename|fork|invalid|unsafe)|unexpected/i);
  await unlink(forkRegistrationPath);

  await chmod(registrationRoot, 0o755);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /mode 0700|acceptance registration directory/i);
  await chmod(registrationRoot, 0o700);

  const detachedRegistration = `${registrationRoot}.detached`;
  await rename(registrationRoot, detachedRegistration);
  await symlink(detachedRegistration, registrationRoot);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /acceptance registration directory.*(?:unsafe|symbolic link)/i);
  await unlink(registrationRoot);
  await rename(detachedRegistration, registrationRoot);

  await chmod(registryRoot, 0o755);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /mode 0700|project registry directory/i);
  await chmod(registryRoot, 0o700);

  await chmod(acceptanceRoot, 0o755);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /mode 0700|client acceptance directory/i);
  await chmod(acceptanceRoot, 0o700);

  await chmod(headPath, 0o644);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /mode 0600|trusted client acceptance head/i);
  await chmod(headPath, 0o600);

  const tamperedHead = JSON.parse(headBytes.toString("utf8"));
  tamperedHead.eventSha256 = "f".repeat(64);
  await writeFile(headPath, `${JSON.stringify(tamperedHead, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, original), /signature|trusted client acceptance head/i);
  await writeFile(headPath, headBytes, { mode: 0o600 });

  await chmod(eventPath, 0o644);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /mode 0600|trusted client acceptance event/i);
  await chmod(eventPath, 0o600);

  const tamperedEvent = JSON.parse(eventBytes.toString("utf8"));
  tamperedEvent.commitment.confirmedAt = "2039-01-01T00:00:00.000Z";
  await writeFile(eventPath, `${JSON.stringify(tamperedEvent, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, original), /signature|trusted client acceptance event/i);
  await writeFile(eventPath, eventBytes, { mode: 0o600 });

  await unlink(eventPath);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /event.*missing|missing.*event|digest/i);
  await writeFile(eventPath, eventBytes, { mode: 0o600 });

  await unlink(headPath);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /high-water|missing|truncated/i);
  await writeFile(headPath, headBytes, { mode: 0o600 });

  const forkName = "0000000000000002-00000000-0000-4000-8000-000000000998.json";
  await writeFile(join(eventsRoot, forkName), eventBytes, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, original), /missing, truncated, or forked|event history|orphan event conflicts/i);
  await unlink(join(eventsRoot, forkName));

  const tamperedRegistry = JSON.parse(registryBytes.toString("utf8"));
  tamperedRegistry.clientAcceptance.headSha256 = "e".repeat(64);
  await writeFile(registryPath, `${JSON.stringify(tamperedRegistry, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, original), /registry state|signature|tampered/i);
  await writeFile(registryPath, registryBytes, { mode: 0o600 });

  const detached = `${acceptanceRoot}.detached`;
  await rename(acceptanceRoot, detached);
  await symlink(detached, acceptanceRoot);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /client acceptance directory is unsafe|symbolic link/i);
  await unlink(acceptanceRoot);
  await rename(detached, acceptanceRoot);

  await rename(acceptanceRoot, detached);
  await assert.rejects(recordClientAcceptance(fixture.root, original), /high-water|missing|deleted|truncated/i);
  await rename(detached, acceptanceRoot);

  await configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: trustRoot,
    deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
    operations: { limits: { acceptanceHeads: 0 } },
  });
  await assert.rejects(recordClientAcceptance(fixture.root, original), /client acceptance head (?:directory|history) is too large/i);
  await configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: trustRoot,
    deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
    operations: { limits: { acceptanceRegistrations: 0 } },
  });
  await assert.rejects(recordClientAcceptance(fixture.root, original), /acceptance registration (?:directory|history) is too large/i);
  await configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: trustRoot,
    deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
  });

  assert.equal((await recordClientAcceptance(fixture.root, original)).deliveryComplete, true);
});

test("registry V1 generation trust migrates to V2 without invalidating authorization history", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const manifest = await readProject(fixture.root);
  const trustRoot = join(fixture.root, "..", "authorization-trust");
  const statesRoot = join(trustRoot, "project-registry", manifest.projectId, "states");
  const statePath = join(statesRoot, (await readdir(statesRoot)).sort().at(-1)!);
  const current = JSON.parse(await readFile(statePath, "utf8"));
  const { signature: _signature, clientAcceptance: _acceptance, ...unsigned } = current;
  const v1 = { ...unsigned, schemaVersion: 1 };
  const key = createHash("sha256").update(`superppt-deck-test:${fixture.root}`).digest();
  const signature = createHmac("sha256", key).update(JSON.stringify(v1)).digest("hex");
  await writeFile(statePath, `${JSON.stringify({ ...v1, signature }, null, 2)}\n`, { mode: 0o600 });

  const evidence = await writeCompletedClientEvidence(fixture.root, "v1-registry-acceptance.json");
  assert.equal((await recordClientAcceptance(fixture.root, evidence)).deliveryComplete, true);
  const latest = JSON.parse(await readFile(
    join(statesRoot, (await readdir(statesRoot)).sort().at(-1)!),
    "utf8",
  ));
  assert.equal(latest.schemaVersion, 2);
  assert.equal(latest.clientAcceptance.sequence, 2);
});

test("trusted client acceptance recovers every external pending publication checkpoint", async (t) => {
  for (const checkpoint of [
    "acceptance-registration-temp-synced",
    "acceptance-registration-published",
    "acceptance-authority-registration-state-temp-synced",
    "acceptance-authority-registration-state-published",
    "acceptance-authority-registration-head-temp-synced",
    "acceptance-authority-registration-head-published",
    "acceptance-authority-registration-current-temp-synced",
    "acceptance-authority-registration-current-published",
    "acceptance-event-temp-synced",
    "acceptance-event-published",
    "acceptance-head-temp-synced",
    "acceptance-head-published",
    "registry-before-acceptance-advance",
    "acceptance-authority-pending-state-temp-synced",
    "acceptance-authority-pending-state-published",
    "acceptance-authority-pending-head-temp-synced",
    "acceptance-authority-pending-head-published",
    "acceptance-authority-pending-current-temp-synced",
    "acceptance-authority-pending-current-published",
  ] as const) {
    await t.test(checkpoint, async (t) => {
      const fixture = await readyProject(t);
      await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
      const evidence = await writeCompletedClientEvidence(fixture.root, `external-${checkpoint}.json`);
      const trustRoot = join(fixture.root, "..", "authorization-trust");
      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: trustRoot,
        deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
        operations: {
          checkpoint(step) {
            if (step === checkpoint) throw new Error(`injected ${checkpoint}`);
          },
        },
      });
      await assert.rejects(recordClientAcceptance(fixture.root, evidence), new RegExp(`injected ${checkpoint}`));

      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: trustRoot,
        deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
      });
      if (
        checkpoint === "acceptance-registration-published"
        || checkpoint === "registry-before-acceptance-advance"
      ) {
        const projectId = (await readProject(fixture.root)).projectId;
        const statesRoot = join(trustRoot, "project-registry", projectId, "states");
        const statesBeforeBlockedMutation = await readdir(statesRoot);
        await assert.rejects(
          updateProject(fixture.root, (manifest) => ({ ...manifest, title: "must stay frozen" })),
          /client acceptance recovery is required|client acceptance.*pending|frozen|registration.*recovery is required/i,
        );
        assert.deepEqual(await readdir(statesRoot), statesBeforeBlockedMutation);
      }
      assert.equal((await recordClientAcceptance(fixture.root, evidence)).deliveryComplete, true);
    });
  }
});

test("trusted client acceptance recovers every external completion publication checkpoint", async (t) => {
  for (const checkpoint of [
    "acceptance-event-temp-synced",
    "acceptance-event-published",
    "acceptance-head-temp-synced",
    "acceptance-head-published",
    "registry-before-acceptance-advance",
    "acceptance-authority-completed-state-temp-synced",
    "acceptance-authority-completed-state-published",
    "acceptance-authority-completed-head-temp-synced",
    "acceptance-authority-completed-head-published",
    "acceptance-authority-completed-current-temp-synced",
    "acceptance-authority-completed-current-published",
  ] as const) {
    await t.test(checkpoint, async (t) => {
      const fixture = await readyProject(t);
      await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
      const evidence = await writeCompletedClientEvidence(fixture.root, `external-complete-${checkpoint}.json`);
      const trustRoot = join(fixture.root, "..", "authorization-trust");
      let occurrences = 0;
      const completionOnlyCheckpoint = checkpoint.startsWith("acceptance-authority-completed-");
      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: trustRoot,
        deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
        operations: {
          checkpoint(step) {
            if (step === checkpoint && ++occurrences === (completionOnlyCheckpoint ? 1 : 2)) {
              throw new Error(`injected completion ${checkpoint}`);
            }
          },
        },
      });
      await assert.rejects(
        recordClientAcceptance(fixture.root, evidence),
        new RegExp(`injected completion ${checkpoint}`),
      );
      assert.equal((await readProject(fixture.root)).stage, "delivered");

      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: trustRoot,
        deterministicKeySeed: `superppt-deck-test:${fixture.root}`,
      });
      assert.equal((await recordClientAcceptance(fixture.root, evidence)).deliveryComplete, true);
    });
  }
});

test("acceptance transaction commitment repairs marker tamper only on exact original replay and rejects wrong anchor bindings", async (t) => {
  const fixture = await readyProject(t);
  await deliverReviewedCandidate({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const evidence = await writeCompletedClientEvidence(fixture.root, "committed-marker.json");
  await assert.rejects(recordClientAcceptance(fixture.root, evidence, {
    checkpoint: (step) => {
      if (step === "observation-promoted") throw new Error("crash with committed marker");
    },
  }), /crash with committed marker/);
  const manifest = await readProject(fixture.root);
  const transaction = manifest.clientAcceptanceTransaction!;
  assert.ok(transaction);

  for (const tampered of [
    { ...transaction, revisionId: "00000000-0000-4000-8000-000000000999" },
    { ...transaction, descriptor: { ...transaction.descriptor, sha256: "f".repeat(64) } },
    { ...transaction, initialCopy: { ...transaction.initialCopy, sha256: "e".repeat(64) }, reopenedCopySha256: "e".repeat(64) },
    { ...transaction, source: { ...transaction.source, sha256: "d".repeat(64) } },
  ]) {
    assert.throws(
      () => ProjectManifestSchema.parse({ ...manifest, clientAcceptanceTransaction: tampered }),
      /client acceptance transaction|artifacts must bind/i,
    );
  }

  const manifestPath = join(fixture.root, "superppt.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  raw.clientAcceptanceTransaction.observation.sha256 = "c".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  assert.equal((await recordClientAcceptance(fixture.root, evidence)).deliveryComplete, true);
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

test("rejects orphaned acceptance evidence when the transaction commitment is missing", async (t) => {
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
  const manifestPath = join(fixture.root, "superppt.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.clientAcceptanceTransaction;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    recordClientAcceptance(fixture.root, evidence),
    /orphaned client acceptance evidence/i,
  );
  assert.equal((await readProject(fixture.root)).stage, "assembling");
});

test("confirm-delivery CLI requires temporary edit, undo, discard, reopen, and authenticated evidence", async (t) => {
  const fixture = await readyProject(t);
  await authorizeDeckGeneration(fixture.root);
  const candidate = await assembleProjectCandidate(fixture.root, { buildOutputs: fakeOutputs });
  const review = await publishDeckReview(fixture.root, candidate.candidateId);
  const cli = join(process.cwd(), "src", "cli.ts");
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    cli,
    "deck-review-action",
    "--project",
    fixture.root,
    "--candidate-id",
    candidate.candidateId,
    "--descriptor-sha256",
    review.descriptorSha256,
    "--action",
    "confirm-delivery",
  ]);
  const output = JSON.parse(stdout);
  assert.match(output.nextRequiredAction, /controlled smoke copy/i);
  assert.match(output.nextRequiredAction, /temporarily edit.*observe.*undo.*discard.*do not save.*close.*reopen.*verify (?:the )?original.*acceptance-record/i);
  assert.doesNotMatch(output.nextRequiredAction, /edit-save|save[ -]?and[ -]?reopen/i);
});

test("uses only injected workspace runtime paths and a platform PATH delimiter", async () => {
  const source = await readFile(join(process.cwd(), "src", "deck", "pptx.ts"), "utf8");
  const tests = await readFile(join(process.cwd(), "tests", "deck.test.ts"), "utf8");
  assert.doesNotMatch(source, /\/Users\/neomei/);
  assert.doesNotMatch(tests, /\/Users\/neomei/);
  assert.match(source, /delimiter/);
  assert.doesNotMatch(source, /PATH:\s*`\$\{runtime\.binDir\}:\$\{/);
});
