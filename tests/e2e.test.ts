import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { runOfflineAcceptance } from "../src/acceptance/offline.js";
import { assembleProjectCandidate } from "../src/deck/assemble.js";
import { editActualSlideObjects } from "../src/deck-revisions/edit-slide.js";
import {
  adoptManualSavedDeck,
  beginAgentCandidateConfirmation,
  confirmAgentEditDeck,
  prepareManualEditDeck,
  resolveCurrentDeckPage,
} from "../src/deck-revisions/workflow.js";
import {
  bootstrapInitialDeckRevision,
  createDeckCandidate,
  readCurrentDeckPointer,
  readLocalDeckRevision,
  rollbackCurrentDeck,
} from "../src/deck-revisions/store.js";
import { finalizeSlideTopology } from "../src/deck-revisions/topology.js";
import { translateManualDeckSignal } from "../src/editable/route.js";
import { initializeProject } from "../src/project/initialize.js";
import { sha256 } from "../src/project/store.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function editableSlideXml(creationId: number, label: string): string {
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:p14="${P14}"><p:cSld><p:spTree><p:nvGrpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="text-${label}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="952500" y="762000"/><a:ext cx="5715000" cy="762000"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="3200" b="1"/><a:t>${label}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId val="${creationId}"/></p:ext></p:extLst></p:cSld></p:sld>`;
}

async function completeThreeSlideDeck(): Promise<Buffer> {
  const labels = ["one", "two", "three"];
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>");
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${labels.map((_label, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}">${labels.map((_label, index) => `<Relationship Id="rId${index + 1}" Type="${R}/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`);
  for (const [index, label] of labels.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, editableSlideXml(1001 + index, label));
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships xmlns="${REL}"/>`);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

async function simulateWpsSavedCompleteDeck(path: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await readFile(path));
  const target = await zip.file("ppt/slides/slide2.xml")!.async("string");
  zip.file("ppt/slides/slide2.xml", target
    .replace('algn="ctr"', 'algn="r"')
    .replace(">two</a:t>", ">WPS manual saved</a:t>"));
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="258" r:id="rId3"/><p:sldId id="300" r:id="rId4"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="rId3" Type="${R}/slide" Target="slides/slide3.xml"/><Relationship Id="rId4" Type="${R}/slide" Target="slides/slide4.xml"/><Relationship Id="rId2" Type="${R}/slide" Target="slides/slide2.xml"/></Relationships>`);
  zip.remove("ppt/slides/slide1.xml");
  zip.remove("ppt/slides/_rels/slide1.xml.rels");
  zip.file("ppt/slides/slide4.xml", editableSlideXml(2004, "inserted"));
  zip.file("ppt/slides/_rels/slide4.xml.rels", `<Relationships xmlns="${REL}"/>`);
  const saved = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, saved);
  return saved;
}

test("keeps editable preparation private and emits no post-save reconstruction artifacts", async (t) => {
  const temporary = process.env.SUPERPPT_ACCEPTANCE_ROOT
    ?? await mkdtemp(join(tmpdir(), "superppt-e2e-"));
  if (!process.env.SUPERPPT_ACCEPTANCE_ROOT) {
    t.after(() => rm(temporary, { recursive: true, force: true }));
  }
  const root = join(temporary, "project");

  const result = await runOfflineAcceptance({
    root,
    fixtures: "tests/fixtures/e2e",
    editable: "tests/fixtures/editable",
  });

  assert.equal(result.before.slideCount, 3);
  assert.deepEqual(result.deckReview, {
    action: "confirm-delivery",
    promotedRevision: 1,
  });
  const initialAcceptance = JSON.parse(await readFile(result.before.acceptance, "utf8"));
  assert.equal(initialAcceptance.deckReviewConfirmation.action, "confirm-delivery");
  assert.equal(initialAcceptance.deckReviewConfirmation.candidateId, initialAcceptance.candidateReview.candidateId);
  assert.equal(result.before.slideCount, result.after.slideCount);
  assert.deepEqual(result.after.slideOrder, result.before.slideOrder);
  assert.deepEqual(result.after.editableSlideIds, []);
  assert.deepEqual(result.after.renderHashes, result.before.renderHashes);

  assert.equal(result.editOperation.kind, "replace-text");
  assert.notEqual(result.editOperation.before, result.editOperation.after);
  assert.equal(result.providerCalls.total, 4);
  assert.deepEqual(result.providerCalls.perSlide, [1, 1, 1]);
  assert.ok(result.providerCalls.total <= 10);
  assert.ok(result.providerCalls.perSlide.every((calls) => calls <= 3));
  assert.equal(result.logs.some((line) => /secret|api[_-]?key|authorization/i.test(line)), false);
  assert.equal(result.logs.some((line) => line.includes("一个编排核心") || line.includes(result.editOperation.after)), false);

  const editableRoot = join(result.root, "editable", result.changedSlideId);
  const editableRevisions = await readdir(editableRoot);
  let authenticatedConversion: { root: string; record: { converterVersion: string } } | null = null;
  for (const revision of editableRevisions.filter((name) => /^[0-9a-f-]{36}$/.test(name))) {
    try {
      authenticatedConversion = {
        root: join(editableRoot, revision),
        record: JSON.parse(await readFile(join(editableRoot, revision, "conversion-record.json"), "utf8")),
      };
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  assert.ok(authenticatedConversion, "offline acceptance must retain its authenticated conversion evidence");
  assert.equal(authenticatedConversion.record.converterVersion, "0.2.0");
  const officialManifest = JSON.parse(await readFile(join(authenticatedConversion.root, "converter-output", "manifest.json"), "utf8"));
  assert.equal(officialManifest.manifestVersion, 2);
  const officialDonor = await JSZip.loadAsync(await readFile(join(authenticatedConversion.root, "converter-output", "slide-editable.pptx")));
  assert.ok(officialDonor.file("ppt/presentation.xml"));
  assert.ok(officialDonor.file("ppt/slides/slide1.xml"));

  for (const snapshot of [result.before, result.after]) {
    const acceptance = JSON.parse(await readFile(snapshot.acceptance, "utf8"));
    assert.equal(acceptance.slides.length, 3);
    assert.deepEqual(acceptance.slides.map((slide: { id: string }) => slide.id), snapshot.slideOrder);
    assert.deepEqual(acceptance.editablePageIds, snapshot.editableSlideIds);
    for (const slide of acceptance.slides as Array<{ id: string; finalRenderSha256: string }>) {
      assert.equal(slide.finalRenderSha256, snapshot.renderHashes[slide.id]);
    }
    for (const kind of ["pptx"] as const) {
      const bytes = await readFile(snapshot.exports[kind]);
      assert.equal(acceptance.exports[kind].sha256, sha256(bytes));
    }
  }
  for (const path of [
    join(result.root, "output/revisions/1/deck.pdf"),
    join(result.root, "output/revisions/1/montage.jpg"),
    join(result.root, "output/candidates/current/montage.jpg"),
  ]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }

  const jobsRoot = join(result.root, "generation", "jobs");
  let deckJobId: string | null = null;
  for (const entry of await readdir(jobsRoot)) {
    const job = JSON.parse(await readFile(join(jobsRoot, entry, "job.json"), "utf8"));
    if (job.kind === "deck") {
      deckJobId = entry;
      break;
    }
  }
  assert.ok(deckJobId);
  const aggregatePath = join(jobsRoot, deckJobId, "result.json");
  const aggregate = JSON.parse(await readFile(aggregatePath, "utf8"));
  aggregate.pages[0].recordedAt = "2000-01-01T00:00:00.000Z";
  await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
  await assert.rejects(
    assembleProjectCandidate(result.root),
    /aggregate pages do not match immutable page results|delegated.*evidence/i,
  );
});

test("continues from exact WPS-saved deck bytes through current-page Agent confirmation and rollback", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "superppt-full-deck-e2e-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  const project = await initializeProject({ root, title: "Task 7 complete deck acceptance" });
  const slideIds = [randomUUID(), randomUUID(), randomUUID()];
  const generatedCandidateId = randomUUID();
  const generatedPath = join(root, "output", "candidates", generatedCandidateId, "deck.pptx");
  await mkdir(join(root, "output", "candidates", generatedCandidateId), { recursive: true });
  const generatedBytes = await completeThreeSlideDeck();
  await writeFile(generatedPath, generatedBytes);
  const initialRevisionId = randomUUID();
  const initialTopology = finalizeSlideTopology(slideIds.map((stableSlideId, position) => ({
    stableSlideId,
    slidePart: `ppt/slides/slide${position + 1}.xml`,
    position,
    management: "managed" as const,
    presentationSlideId: 256 + position,
    creationId: 1001 + position,
  })), []);
  const initial = await bootstrapInitialDeckRevision(root, {
    revisionId: initialRevisionId,
    projectRevisionId: project.currentRevision.id,
    sourceAbsolutePath: generatedPath,
    slideTopology: initialTopology,
    changedSlideIds: slideIds,
  });

  const initialRecordPath = join(root, "output", "deck-revisions", initialRevisionId, "revision.json");
  const initialRecord = JSON.parse(await readFile(initialRecordPath, "utf8")) as {
    editableSlideIds: string[];
    reviewRequiredObjectsBySlideId: Record<string, Array<{ elementId: string; label: string; role: string }>>;
  };
  initialRecord.editableSlideIds = [...slideIds];
  initialRecord.reviewRequiredObjectsBySlideId = {
    [slideIds[1]!]: [{ elementId: "two", label: "Slide 2 title alignment", role: "text" }],
  };
  await writeFile(initialRecordPath, `${JSON.stringify(initialRecord, null, 2)}\n`);
  assert.equal(initial.sha256, digest(generatedBytes));
  assert.equal((await readCurrentDeckPointer(root)).revisionId, initialRevisionId);

  const manual = await prepareManualEditDeck({ root, slideId: slideIds[1]! });
  assert.equal(manual.slideCount, 3);
  assert.equal(manual.targetSlideIndex, 1);
  assert.deepEqual(manual.reviewRequiredObjects.map(({ label }) => label), ["Slide 2 title alignment"]);
  assert.equal(manual.localLink, manual.absolutePath);
  const savedBytes = await simulateWpsSavedCompleteDeck(manual.absolutePath);
  const savedSha256 = digest(savedBytes);
  assert.throws(() => translateManualDeckSignal("已保存"), /已保存并关闭/);
  const adoptedManual = await adoptManualSavedDeck({
    root,
    sessionId: manual.sessionId,
    userSignal: translateManualDeckSignal("已保存并关闭"),
  });
  assert.equal(adoptedManual.sha256, savedSha256);
  assert.deepEqual(await readFile(manual.absolutePath), savedBytes);
  const manualRevision = await readLocalDeckRevision(root, adoptedManual.revisionId);
  assert.deepEqual(manualRevision.slideTopology.entries.map(({ stableSlideId, position, management }) => ({
    stableSlideId, position, management,
  })), [
    { stableSlideId: slideIds[2], position: 0, management: "managed" },
    { stableSlideId: manualRevision.slideTopology.entries[1]!.stableSlideId, position: 1, management: "unmanaged" },
    { stableSlideId: slideIds[1], position: 2, management: "managed" },
  ]);
  assert.deepEqual(manualRevision.slideTopology.deletedStableSlideIds, [slideIds[0]]);

  const nextTarget = await resolveCurrentDeckPage({ root, pageNumber: 3 });
  assert.deepEqual(nextTarget, {
    revisionId: adoptedManual.revisionId,
    pageNumber: 3,
    stableSlideId: slideIds[1],
    management: "managed",
  });

  const agentCandidate = await createDeckCandidate(root, {
    sourceRevisionId: adoptedManual.revisionId,
    reason: "agent-edit",
    changedSlideIds: [nextTarget.stableSlideId],
    editableSlideIds: manualRevision.editableSlideIds,
    targetSlideId: nextTarget.stableSlideId,
    mode: "agent",
  });
  assert.deepEqual(await readFile(agentCandidate.absolutePath), savedBytes);
  await editActualSlideObjects({
    root,
    currentRevisionId: adoptedManual.revisionId,
    sessionId: agentCandidate.sessionId,
    candidatePath: agentCandidate.absolutePath,
    slideId: nextTarget.stableSlideId,
    manifest: {
      manifestVersion: 2,
      canvas: { width: 1280, height: 720 },
      warnings: [],
      elements: [{
        kind: "text",
        id: "two",
        text: "WPS manual saved",
        bbox: { x: 100, y: 80, width: 600, height: 80 },
        rotation: 0,
        color: "#ffffff",
        fontSizePx: 48,
        bold: true,
        align: "right",
        zIndex: 1,
      }],
    },
    operations: [{ kind: "replace-text", elementId: "two", text: "Agent confirmed title" }],
  });
  const agent = await beginAgentCandidateConfirmation({
    root,
    sessionId: agentCandidate.sessionId,
    slideId: nextTarget.stableSlideId,
  });
  const agentBytes = await readFile(agent.absolutePath);
  const agentZip = await JSZip.loadAsync(agentBytes);
  const agentTargetXml = await agentZip.file("ppt/slides/slide2.xml")!.async("string");
  assert.match(agentTargetXml, /algn="r"/);
  assert.match(agentTargetXml, />Agent confirmed title<\/a:t>/);
  assert.equal((await readCurrentDeckPointer(root)).revisionId, adoptedManual.revisionId);

  const confirmed = await confirmAgentEditDeck({
    root,
    sessionId: agent.sessionId,
    confirmedSha256: agent.sha256,
  });
  assert.equal(confirmed.revisionId, agent.revisionId);
  assert.deepEqual(await readFile(agent.absolutePath), agentBytes);
  const rolledBack = await rollbackCurrentDeck(root, adoptedManual.revisionId);
  assert.equal(rolledBack.revisionId, adoptedManual.revisionId);
  assert.equal((await readCurrentDeckPointer(root)).revisionId, adoptedManual.revisionId);
  assert.deepEqual(await readFile(manual.absolutePath), savedBytes);
  assert.deepEqual(await readFile(agent.absolutePath), agentBytes);

  const outputEntries = await readdir(join(root, "output"), { recursive: true });
  assert.equal(outputEntries.some((entry) => /(?:\.pdf$|montage|preview|single[-_]?slide|single[-_]?page)/i.test(String(entry))), false);
});
