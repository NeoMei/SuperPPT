import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
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
import { assembleDeck, assembleProject, readProjectAcceptance, recordClientAcceptance, type FinalRender } from "../src/deck/assemble.js";
import { exportPdf } from "../src/deck/pdf.js";
import { buildMontage } from "../src/deck/montage.js";
import { approveGate } from "../src/planning/confirm.js";
import { publishPlanViews, publishStyleSample } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject, updateProject } from "../src/project/store.js";
import { applyRevision, approveImpact, publishImpactPlan } from "../src/revisions/apply.js";
import { publishRevisionSnapshot } from "../src/revisions/snapshot.js";
import { writeCanonicalStyleSample } from "./helpers/style-sample.js";

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
  await writeCanonicalStyleSample(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await publishStyleSample(root);
  await approveGate(root, "style-sample");

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

async function writeCompletedClientEvidence(
  root: string,
  name: string,
  application: "WPS" | "PowerPoint" = "WPS",
): Promise<string> {
  const smoke = await createClientSmokeCopy(root);
  const copy = join(root, smoke.copy.path);
  await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from("saved client edit")]));
  const evidence = join(root, name);
  await writeFile(evidence, `${JSON.stringify({
    application,
    smokeCopyDescriptorPath: smoke.descriptorPath,
    smokeCopyDescriptorSha256: smoke.descriptorSha256,
    savedCopySha256: createHash("sha256").update(await readFile(copy)).digest("hex"),
    opened: true,
    edited: true,
    saved: true,
    closed: true,
    reopened: true,
    result: "passed",
    observedResult: "代表文本对象在重新打开后仍可编辑",
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
    smokeCopy: null,
    opened: false,
    edited: false,
    saved: false,
    closed: false,
    reopened: false,
    result: null,
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
  const result = await assembleProject({
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

test("retains partial staging without mutating the manifest", async (t) => {
  const fixture = await readyProject(t);
  const before = await readProject(fixture.root);
  await assert.rejects(assembleProject({
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

test("recovers a promoted output after a crash before the manifest update", async (t) => {
  const fixture = await readyProject(t);
  await assert.rejects(assembleProject({
    root: fixture.root,
    operations: {
      buildOutputs: fakeOutputs,
      checkpoint: (step) => {
        if (step === "output-promoted") throw new Error("simulated promotion crash");
      },
    },
  }), /simulated promotion crash/);
  assert.equal((await readProject(fixture.root)).exports.pptx, null);

  const recovered = await assembleProject({
    root: fixture.root,
    operations: { buildOutputs: async () => { throw new Error("must reuse promoted output"); } },
  });
  assert.equal(recovered.recovered, true);
  assert.ok((await readProject(fixture.root)).exports.pptx);
});

test("serializes concurrent assembly and never overwrites an unowned or tampered destination", async (t) => {
  const fixture = await readyProject(t);
  let builds = 0;
  const operations = {
    buildOutputs: async (renders: FinalRender[], paths: { pptx: string; pdf: string; montage: string }) => {
      builds += 1;
      await fakeOutputs(renders, paths);
    },
  };
  const results = await Promise.all([
    assembleProject({ root: fixture.root, operations }),
    assembleProject({ root: fixture.root, operations }),
  ]);
  assert.equal(builds, 1);
  assert.equal(results.filter((result) => result.recovered).length, 1);

  const pptx = join(fixture.root, results[0]!.artifacts.pptx!.path);
  await writeFile(pptx, "tampered");
  await assert.rejects(assembleProject({
    root: fixture.root,
    operations,
  }), /owned output evidence is invalid/);

  const second = await readyProject(t);
  const destination = join(second.root, "output", "revisions", "1");
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "foreign.txt"), "do not delete");
  await assert.rejects(assembleProject({
    root: second.root,
    operations,
  }), /destination is not owned by SuperPPT/);
  assert.equal(await readFile(join(destination, "foreign.txt"), "utf8"), "do not delete");
});

test("aborts promotion when the current revision changes during assembly", async (t) => {
  const fixture = await readyProject(t);
  await assert.rejects(assembleProject({
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
  }), /revision changed during assembly/);
  await assert.rejects(access(join(fixture.root, "output", "revisions", "1")));
});

test("records delivery only from an edited owned smoke copy while preserving the canonical deck", async (t) => {
  const fixture = await readyProject(t);
  await assembleProject({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  });
  const manifest = await readProject(fixture.root);
  const canonicalPptx = join(fixture.root, manifest.exports.pptx!.path);
  const canonicalBytes = await readFile(canonicalPptx);
  const smoke = await createClientSmokeCopy(fixture.root);
  const smokeCopy = join(fixture.root, smoke.copy.path);
  assert.deepEqual(await readFile(smokeCopy), canonicalBytes);
  assert.equal(smoke.source.path, manifest.exports.pptx!.path);
  assert.equal(smoke.source.sha256, manifest.exports.pptx!.sha256);
  assert.equal(smoke.copy.initialSha256, manifest.exports.pptx!.sha256);
  assert.equal(smoke.descriptorPath, `output/revisions/${manifest.deckRevision ?? manifest.currentRevision.number}/client-smoke/descriptor.json`);
  await writeFile(smokeCopy, Buffer.concat([await readFile(smokeCopy), Buffer.from("saved client edit")]));
  const savedCopySha256 = createHash("sha256").update(await readFile(smokeCopy)).digest("hex");
  assert.deepEqual(await createClientSmokeCopy(fixture.root), smoke);
  assert.equal(createHash("sha256").update(await readFile(smokeCopy)).digest("hex"), savedCopySha256);
  const incomplete = join(fixture.root, "incomplete.json");
  await writeFile(incomplete, `${JSON.stringify({
    application: "WPS",
    smokeCopyDescriptorPath: smoke.descriptorPath,
    smokeCopyDescriptorSha256: smoke.descriptorSha256,
    savedCopySha256,
    opened: true,
    edited: true,
    saved: false,
    closed: true,
    reopened: true,
    result: "passed",
    observedResult: "代表文本对象在重新打开后仍可编辑",
    confirmedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, incomplete), /all six client acceptance checks/);

  const evidence = join(fixture.root, "accepted.json");
  await writeFile(evidence, `${JSON.stringify({
    application: "WPS",
    smokeCopyDescriptorPath: smoke.descriptorPath,
    smokeCopyDescriptorSha256: smoke.descriptorSha256,
    savedCopySha256,
    opened: true,
    edited: true,
    saved: true,
    closed: true,
    reopened: true,
    result: "passed",
    observedResult: "代表文本对象在重新打开后仍可编辑",
    confirmedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const accepted = await recordClientAcceptance(fixture.root, evidence);
  assert.equal(accepted.deliveryComplete, true);
  assert.equal(accepted.clientAcceptance.smokeCopy?.path, smoke.copy.path);
  assert.equal(accepted.clientAcceptance.smokeCopy?.savedSha256, savedCopySha256);
  assert.equal(accepted.clientAcceptance.closed, true);
  assert.equal(accepted.clientAcceptance.result, "passed");
  assert.deepEqual(await readFile(canonicalPptx), canonicalBytes);
  assert.equal((await readProject(fixture.root)).stage, "delivered");

  await writeFile(canonicalPptx, "tampered after acceptance");
  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /acceptance evidence is not current/);
});

test("rejects unchanged smoke copies, forged source evidence, and post-acceptance copy tampering", async (t) => {
  const fixture = await readyProject(t);
  await assembleProject({ root: fixture.root, operations: { buildOutputs: fakeOutputs } });
  const smoke = await createClientSmokeCopy(fixture.root);
  const evidence = join(fixture.root, "smoke-evidence.json");
  const base = {
    application: "PowerPoint",
    smokeCopyDescriptorPath: smoke.descriptorPath,
    smokeCopyDescriptorSha256: smoke.descriptorSha256,
    savedCopySha256: smoke.copy.initialSha256,
    opened: true,
    edited: true,
    saved: true,
    closed: true,
    reopened: true,
    result: "passed",
    observedResult: "文本保存并重新打开成功",
    confirmedAt: new Date().toISOString(),
  };
  await writeFile(evidence, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /smoke copy must change after the client edit/);

  const copy = join(fixture.root, smoke.copy.path);
  await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from("edited")]));
  const savedCopySha256 = createHash("sha256").update(await readFile(copy)).digest("hex");
  const descriptorPath = join(fixture.root, smoke.descriptorPath);
  const descriptorBytes = await readFile(descriptorPath);
  const forgedDescriptor = JSON.parse(descriptorBytes.toString("utf8"));
  forgedDescriptor.source.path = "output/revisions/1/forged.pptx";
  const forgedDescriptorBytes = Buffer.from(`${JSON.stringify(forgedDescriptor, null, 2)}\n`);
  await writeFile(descriptorPath, forgedDescriptorBytes);
  await writeFile(evidence, `${JSON.stringify({
    ...base,
    savedCopySha256,
    smokeCopyDescriptorSha256: createHash("sha256").update(forgedDescriptorBytes).digest("hex"),
  })}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /descriptor identity does not match/);
  await writeFile(descriptorPath, descriptorBytes);
  await writeFile(evidence, `${JSON.stringify({ ...base, savedCopySha256, source: { path: "forged", sha256: "0".repeat(64) } })}\n`, { mode: 0o600 });
  await assert.rejects(recordClientAcceptance(fixture.root, evidence), /client acceptance input is invalid/);
  await writeFile(evidence, `${JSON.stringify({ ...base, savedCopySha256 })}\n`, { mode: 0o600 });
  await recordClientAcceptance(fixture.root, evidence);
  await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from("tampered")]));
  await assert.rejects(readProjectAcceptance(fixture.root), /client smoke copy evidence is not current/);
});

test("invalidates completed acceptance when a same-revision slide becomes editable", async (t) => {
  const fixture = await readyProject(t);
  await assembleProject({
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

test("exposes assemble, acceptance, acceptance-smoke-copy, and acceptance-record as strict CLI routes", async (t) => {
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
  const assembleError = await invoke(["assemble", "--project", root], {
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
  assert.match(recordError, /ENOENT/);
  assert.doesNotMatch(recordError, /unknown command/);
});

test("rejects a PPTX that names pages but has no bound media relationships", async (t) => {
  const fixture = await readyProject(t);
  await assert.rejects(assembleProject({
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
  await assembleProject(untrustedCallerOptions);
  assert.equal((await readProjectAcceptance(fixture.root)).providerId, "ledger-provider");
  const ledgerPath = join(fixture.root, "images", PROJECT_SLIDES[0], "attempt-1", "ledger.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  await writeFile(ledgerPath, `${JSON.stringify({ ...ledger, providerId: "forged-provider" }, null, 2)}\n`);
  await assert.rejects(
    readProjectAcceptance(fixture.root),
    /provider evidence is not current|one accepted provider identity/,
  );
});

test("recovery rejects self-consistent output markers with noncanonical artifact paths", async (t) => {
  const fixture = await readyProject(t);
  const result = await assembleProject({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  });
  const destination = result.destination;
  const markerPath = join(destination, ".superppt-output.json");
  const acceptancePath = join(destination, "acceptance.json");
  const wrongPptx = join(destination, "renamed-deck.pptx");
  await copyFile(join(destination, "deck.pptx"), wrongPptx);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
  const wrongRef = `output/revisions/1/renamed-deck.pptx`;
  marker.artifacts.pptx.path = wrongRef;
  acceptance.exports.pptx.path = wrongRef;
  const acceptanceBytes = Buffer.from(`${JSON.stringify(acceptance, null, 2)}\n`);
  await writeFile(acceptancePath, acceptanceBytes);
  marker.artifacts.acceptance.sha256 = createHash("sha256").update(acceptanceBytes).digest("hex");
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  await assert.rejects(assembleProject({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  }), /canonical artifact paths/);
});

test("aborts and quarantines output when a same-revision render changes after promotion", async (t) => {
  const fixture = await readyProject(t);
  const replacementRoot = join(fixture.root, "images", PROJECT_SLIDES[0], "attempt-2");
  await mkdir(replacementRoot, { recursive: true });
  const replacement = await image(join(replacementRoot, "slide.png"), "#777777");
  await assert.rejects(assembleProject({
    root: fixture.root,
    operations: {
      buildOutputs: fakeOutputs,
      checkpoint: async (step) => {
        if (step !== "output-promoted") return;
        await publishRevisionSnapshot(fixture.root, await readProject(fixture.root));
        await updateProject(fixture.root, (manifest) => ({
          ...manifest,
          slides: manifest.slides.map((slide) => slide.id === PROJECT_SLIDES[0] ? {
            ...slide,
            image: {
              path: `images/${slide.id}/attempt-2/slide.png`,
              sha256: replacement.sha256,
              revisionId: manifest.currentRevision.id,
            },
          } : slide),
        }));
      },
    },
  }), /slide binding changed during assembly/);
  await assert.rejects(access(join(fixture.root, "output", "revisions", "1")));
});

test("recovers acceptance after a hard crash following immutable record promotion", async (t) => {
  const fixture = await readyProject(t);
  await assembleProject({
    root: fixture.root,
    operations: { buildOutputs: fakeOutputs },
  });
  const evidence = await writeCompletedClientEvidence(fixture.root, "accepted-crash.json");
  const recordWithOperations = recordClientAcceptance as unknown as (
    root: string,
    input: string,
    operations: { checkpoint: (step: string) => Promise<void> | void },
  ) => Promise<unknown>;
  await assert.rejects(recordWithOperations(fixture.root, evidence, {
    checkpoint: (step) => {
      if (step === "record-promoted") throw new Error("simulated hard crash");
    },
  }), /simulated hard crash/);
  const recovered = await recordClientAcceptance(fixture.root, evidence);
  assert.equal(recovered.deliveryComplete, true);
  assert.equal((await readProject(fixture.root)).stage, "delivered");
});

test("rejects a coordinated rewrite of an orphaned immutable acceptance record", async (t) => {
  const fixture = await readyProject(t);
  await assembleProject({
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
