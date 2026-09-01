import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import {
  adoptManualSavedDeck,
  beginAgentCandidateConfirmation,
  confirmAgentEditDeck,
  prepareManualEditDeck,
  rejectDeckEdit,
  resolveCurrentDeckPage,
} from "../src/deck-revisions/workflow.js";
import { promoteProjectEditableTarget } from "../src/editable/operations.js";
import {
  createDeckCandidate,
  readCurrentDeckPointer,
  readLocalDeckRevision,
  rollbackCurrentDeck,
} from "../src/deck-revisions/store.js";
import { editActualSlideObjects, replaceRegeneratedSlideShapeTree } from "../src/deck-revisions/edit-slide.js";
import { inspectLocalPptx } from "../src/deck-revisions/inspect.js";
import { finalizeSlideTopology } from "../src/deck-revisions/topology.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject, updateProject } from "../src/project/store.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function slideXml(creationId: number, label: string): string {
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:p14="${P14}"><p:cSld><p:spTree><p:nvGrpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="text-${label}"/></p:nvSpPr><p:spPr><a:xfrm rot="0"><a:off x="952500" y="762000"/><a:ext cx="5715000" cy="762000"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="3200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Aptos"/></a:rPr><a:t>${label}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="shape-card-Card"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="762000" y="1714500"/><a:ext cx="6096000" cy="3048000"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr></p:sp></p:spTree><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId val="${creationId}"/></p:ext></p:extLst></p:cSld></p:sld>`;
}

function sensitiveTextSlideXml(creationId: number, label: string): string {
  if (label !== "two") return slideXml(creationId, label);
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:p14="${P14}"><p:cSld><p:spTree><p:nvGrpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="text-two"/></p:nvSpPr><p:spPr><a:xfrm rot="0"><a:off x="952500" y="762000"/><a:ext cx="5715000" cy="1524000"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="3200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Aptos"/></a:rPr><a:t>A&amp;B</a:t></a:r><a:r><a:rPr lang="en-US" sz="2800" i="1"><a:solidFill><a:srgbClr val="FFCC00"/></a:solidFill><a:latin typeface="Courier New"/></a:rPr><a:t>&lt;C&gt;</a:t></a:r></a:p><a:p><a:pPr algn="r"/><a:r><a:rPr lang="zh-CN" sz="2400" b="0"><a:solidFill><a:srgbClr val="00CCFF"/></a:solidFill><a:latin typeface="Noto Sans CJK SC"/></a:rPr><a:t>&#x4E2D;&#25991;</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="shape-card-Card"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="762000" y="1714500"/><a:ext cx="6096000" cy="3048000"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr></p:sp></p:spTree><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId val="${creationId}"/></p:ext></p:extLst></p:cSld></p:sld>`;
}

async function makeDeck(labels: string[], slideFactory: (creationId: number, label: string) => string = slideXml): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"png\" ContentType=\"image/png\"/></Types>");
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${labels.map((_label, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}">${labels.map((_label, index) => `<Relationship Id="rId${index + 1}" Type="${R}/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`);
  for (const [index, label] of labels.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, slideFactory(1001 + index, label));
    const mediaName = index < 2 ? "shared-existing.png" : "untouched-existing.png";
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships xmlns="${REL}"><Relationship Id="rId9" Type="${R}/image" Target="../media/${mediaName}"/></Relationships>`);
  }
  zip.file("ppt/media/shared-existing.png", await sharp({ create: { width: 16, height: 16, channels: 3, background: "#102030" } }).png().toBuffer());
  zip.file("ppt/media/untouched-existing.png", await sharp({ create: { width: 12, height: 12, channels: 4, background: { r: 45, g: 67, b: 89, alpha: 0.5 } } }).png().toBuffer());
  return zip.generateAsync({ type: "nodebuffer" });
}

type WorkflowFixture = Awaited<ReturnType<typeof workflowFixture>>;

async function workflowFixture(t: TestContext, slideFactory: (creationId: number, label: string) => string = slideXml) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "superppt-full-deck-editing-")));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  const project = await initializeProject({ root, title: "Complete deck editing" });
  const slideIds = [randomUUID(), randomUUID(), randomUUID()];
  const revisionId = randomUUID();
  const relativePath = `output/deck-revisions/${revisionId}/deck.pptx`;
  const absolutePath = join(root, ...relativePath.split("/"));
  await mkdir(join(root, "output", "deck-revisions", revisionId), { recursive: true });
  const deckBytes = await makeDeck(["one", "two", "three"], slideFactory);
  await writeFile(absolutePath, deckBytes);
  const topology = finalizeSlideTopology(slideIds.map((stableSlideId, position) => ({
    stableSlideId,
    slidePart: `ppt/slides/slide${position + 1}.xml`,
    position,
    management: "managed" as const,
    presentationSlideId: 256 + position,
    creationId: 1001 + position,
  })), []);
  const revision = {
    schemaVersion: 1 as const,
    revisionId,
    parentRevisionId: null,
    projectId: project.projectId,
    projectRevisionId: project.currentRevision.id,
    reason: "initial" as const,
    relativePath,
    sha256: digest(deckBytes),
    slideTopology: topology,
    editableSlideIds: [...slideIds],
    changedSlideIds: [...slideIds],
    reviewRequiredObjectsBySlideId: {
      [slideIds[0]!]: [{ elementId: "chart", label: "Review chart", role: "data-visual" }],
      [slideIds[1]!]: [{ elementId: "icon", label: "Review icon", role: "foreground-object" }],
    },
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(root, "output", "deck-revisions", revisionId, "revision.json"), `${JSON.stringify(revision, null, 2)}\n`);
  const current = {
    schemaVersion: 1 as const,
    revisionId,
    relativePath,
    sha256: digest(deckBytes),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(root, "output", "current.json"), `${JSON.stringify(current, null, 2)}\n`);
  await updateProject(root, (manifest) => ({ ...manifest, currentDeck: current, activeDeckEditSessionId: null }));
  return { root, slideIds, revisionId, absolutePath, deckBytes };
}

async function replaceSlideText(path: string, part: string, from: string, to: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file(part)!.async("string");
  zip.file(part, xml.replace(`>${from}</a:t>`, `>${to}</a:t>`));
  const saved = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, saved);
  return saved;
}

async function reorderInsertDelete(path: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await readFile(path));
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="257" r:id="rId2"/><p:sldId id="300" r:id="rId4"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="rId2" Type="${R}/slide" Target="slides/slide2.xml"/><Relationship Id="rId4" Type="${R}/slide" Target="slides/slide4.xml"/><Relationship Id="rId3" Type="${R}/slide" Target="slides/slide3.xml"/></Relationships>`);
  zip.remove("ppt/slides/slide1.xml");
  zip.remove("ppt/slides/_rels/slide1.xml.rels");
  zip.file("ppt/slides/slide4.xml", slideXml(2004, "inserted"));
  zip.file("ppt/slides/_rels/slide4.xml.rels", `<Relationships xmlns="${REL}"/>`);
  zip.file("ppt/slides/slide3.xml", (await zip.file("ppt/slides/slide3.xml")!.async("string")).replace(">three</a:t>", ">three changed outside target</a:t>"));
  const saved = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, saved);
  return saved;
}

function withoutCreationId(xml: string): string {
  const stripped = xml.replace(
    /<p:extLst><p:ext uri="\{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E\}"><p14:creationId val="[0-9]+"\/><\/p:ext><\/p:extLst>/,
    "",
  );
  assert.notEqual(stripped, xml, "fixture must remove one official creation ID");
  return stripped;
}

async function wpsReorderInsertDeleteAndDropCreationIds(path: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await readFile(path));
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="257" r:id="rId2"/><p:sldId id="259" r:id="rId4"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="rId2" Type="${R}/slide" Target="slides/slide2.xml"/><Relationship Id="rId4" Type="${R}/slide" Target="slides/slide4.xml"/><Relationship Id="rId3" Type="${R}/slide" Target="slides/slide3.xml"/></Relationships>`);
  zip.remove("ppt/slides/slide1.xml");
  zip.remove("ppt/slides/_rels/slide1.xml.rels");
  for (const part of ["ppt/slides/slide2.xml", "ppt/slides/slide3.xml"] as const) {
    zip.file(part, withoutCreationId(await zip.file(part)!.async("string")));
  }
  zip.file("ppt/slides/slide4.xml", withoutCreationId(slideXml(2004, "inserted")));
  zip.file("ppt/slides/_rels/slide4.xml.rels", `<Relationships xmlns="${REL}"/>`);
  const saved = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, saved);
  return saved;
}

async function sessionState(fixture: WorkflowFixture, sessionId: string): Promise<string> {
  const raw = JSON.parse(await readFile(join(fixture.root, "output", "deck-edit-sessions", sessionId, "session.json"), "utf8")) as { state: string };
  return raw.state;
}

async function installConflictingReviewMetadata(fixture: WorkflowFixture): Promise<void> {
  const path = join(fixture.root, "output", "deck-revisions", fixture.revisionId, "revision.json");
  const revision = JSON.parse(await readFile(path, "utf8")) as {
    reviewRequiredObjectsBySlideId: Record<string, Array<{ elementId: string; label: string; role: string }>>;
  };
  revision.reviewRequiredObjectsBySlideId[fixture.slideIds[0]!] = [
    { elementId: "chart", label: "First authenticated label", role: "data-visual" },
    { elementId: "chart", label: "Conflicting authenticated label", role: "data-visual" },
  ];
  await writeFile(path, `${JSON.stringify(revision, null, 2)}\n`);
}

async function leaseEvidence(fixture: WorkflowFixture): Promise<string[]> {
  const root = join(fixture.root, ".superppt-leases");
  const result: string[] = [];
  let leaseNames: string[];
  try {
    leaseNames = await readdir(root);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const leaseName of leaseNames.sort()) {
    for (const name of (await readdir(join(root, leaseName))).sort()) result.push(`${leaseName}/${name}`);
  }
  return result;
}

async function deckEditSessionDirectories(fixture: WorkflowFixture): Promise<string[]> {
  try {
    return await readdir(join(fixture.root, "output", "deck-edit-sessions"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("manual flow exposes only one complete deck and adopts exact bytes only after saved-and-closed", async (t) => {
  const fixture = await workflowFixture(t);
  const before = await readCurrentDeckPointer(fixture.root);
  const prepared = await prepareManualEditDeck({ root: fixture.root, revisionId: before.revisionId, slideId: fixture.slideIds[1]! });

  assert.equal(prepared.kind, "complete-local-pptx");
  assert.equal(prepared.mode, "manual");
  assert.equal(prepared.slideCount, fixture.slideIds.length);
  assert.equal(prepared.localLink, prepared.absolutePath);
  assert.equal(prepared.targetSlideIndex, 1);
  assert.deepEqual(prepared.reviewRequiredObjects, [
    {
      stableSlideId: fixture.slideIds[0],
      elementId: "chart",
      label: "Review chart",
      role: "data-visual",
    },
    {
      stableSlideId: fixture.slideIds[1],
      elementId: "icon",
      label: "Review icon",
      role: "foreground-object",
    },
  ]);
  assert.deepEqual(await readdir(join(fixture.root, "output", "deck-revisions", prepared.revisionId)), ["deck.pptx"]);
  for (const forbidden of ["singleSlidePath", "preview", "pdf", "montage", "viewer"]) {
    assert.equal(forbidden in prepared, false);
  }

  await assert.rejects(adoptManualSavedDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    userSignal: "saved",
  }), /saved-and-closed/i);
  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, before.revisionId);
  assert.equal(await sessionState(fixture, prepared.sessionId), "external-editing");

  const saved = await replaceSlideText(prepared.absolutePath, "ppt/slides/slide2.xml", "two", "user saved");
  const savedStat = await stat(prepared.absolutePath);
  const adopted = await adoptManualSavedDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    userSignal: "saved-and-closed",
  });
  const adoptedStat = await stat(prepared.absolutePath);
  assert.deepEqual(await readFile(prepared.absolutePath), saved);
  assert.equal(adoptedStat.ino, savedStat.ino);
  assert.equal(adoptedStat.size, savedStat.size);
  assert.equal(adopted.absolutePath, prepared.absolutePath);
  assert.equal(adopted.sha256, digest(saved));
  assert.deepEqual(await readFile(fixture.absolutePath), fixture.deckBytes);
});

test("manual preparation rejects a stale resolved revision even when the stable slide still exists", async (t) => {
  const fixture = await workflowFixture(t);
  const resolved = await resolveCurrentDeckPage({ root: fixture.root, pageNumber: 2 });
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: resolved.revisionId,
    reason: "agent-edit",
    changedSlideIds: [resolved.stableSlideId],
    editableSlideIds: fixture.slideIds,
    targetSlideId: resolved.stableSlideId,
    mode: "agent",
  });
  const presented = await beginAgentCandidateConfirmation({
    root: fixture.root,
    sessionId: candidate.sessionId,
    slideId: resolved.stableSlideId,
  });
  const promoted = await confirmAgentEditDeck({
    root: fixture.root,
    sessionId: presented.sessionId,
    confirmedSha256: presented.sha256,
  });
  const promotedRevision = await readLocalDeckRevision(fixture.root, promoted.revisionId);
  assert.ok(promotedRevision.slideTopology.entries.some(({ stableSlideId }) => stableSlideId === resolved.stableSlideId));
  const revisionDirectoriesBefore = await readdir(join(fixture.root, "output", "deck-revisions"));
  const sessionDirectoriesBefore = await deckEditSessionDirectories(fixture);

  await assert.rejects(prepareManualEditDeck({
    root: fixture.root,
    revisionId: resolved.revisionId,
    slideId: resolved.stableSlideId,
  }), /stale|current revision changed|no longer current/i);

  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, promoted.revisionId);
  assert.deepEqual(await readdir(join(fixture.root, "output", "deck-revisions")), revisionDirectoriesBefore);
  assert.deepEqual(await deckEditSessionDirectories(fixture), sessionDirectoriesBefore);
  assert.equal((await readProject(fixture.root)).activeDeckEditSessionId, null);
});

test("review identity conflicts fail before manual or Agent presentation without an active freeze", async (t) => {
  await t.test("manual concurrent and repeated preparation", async (st) => {
    const fixture = await workflowFixture(st);
    await installConflictingReviewMetadata(fixture);
    const before = await readCurrentDeckPointer(fixture.root);
    const leasesBefore = await leaseEvidence(fixture);
    const attempts = await Promise.allSettled([
      prepareManualEditDeck({ root: fixture.root, revisionId: fixture.revisionId, slideId: fixture.slideIds[1]! }),
      prepareManualEditDeck({ root: fixture.root, revisionId: fixture.revisionId, slideId: fixture.slideIds[1]! }),
    ]);
    assert.deepEqual(attempts.map((result) => result.status), ["rejected", "rejected"]);
    for (const result of attempts) {
      if (result.status === "rejected") assert.match(String(result.reason), /conflicting object identity/i);
    }
    assert.equal((await readProject(fixture.root)).activeDeckEditSessionId, null);
    assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, before.revisionId);
    assert.deepEqual(await deckEditSessionDirectories(fixture), []);
    assert.deepEqual(await leaseEvidence(fixture), leasesBefore);

    await assert.rejects(
      prepareManualEditDeck({ root: fixture.root, revisionId: fixture.revisionId, slideId: fixture.slideIds[1]! }),
      /conflicting object identity/i,
    );
    assert.equal((await readProject(fixture.root)).activeDeckEditSessionId, null);
    assert.deepEqual(await deckEditSessionDirectories(fixture), []);
  });

  await t.test("Agent preparation and repeated signal", async (st) => {
    const fixture = await workflowFixture(st);
    await installConflictingReviewMetadata(fixture);
    const before = await readCurrentDeckPointer(fixture.root);
    const candidate = await createDeckCandidate(fixture.root, {
      sourceRevisionId: before.revisionId,
      reason: "agent-edit",
      changedSlideIds: [fixture.slideIds[1]!],
      editableSlideIds: fixture.slideIds,
      targetSlideId: fixture.slideIds[1]!,
      mode: "agent",
    });
    await assert.rejects(beginAgentCandidateConfirmation({
      root: fixture.root,
      sessionId: candidate.sessionId,
      slideId: fixture.slideIds[1]!,
    }), /conflicting object identity/i);
    assert.equal((await readProject(fixture.root)).activeDeckEditSessionId, null);
    assert.equal(await sessionState(fixture, candidate.sessionId), "rejected");
    assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, before.revisionId);
    assert.equal((await leaseEvidence(fixture)).some((name) => /\.(?:pending|active)\.json$/.test(name)), false);
    await assert.rejects(beginAgentCandidateConfirmation({
      root: fixture.root,
      sessionId: candidate.sessionId,
      slideId: fixture.slideIds[1]!,
    }), /stale|active|rejected/i);
  });
});

test("serializes external editing and rejects Agent access to an open candidate", async (t) => {
  const fixture = await workflowFixture(t);
  const prepared = await prepareManualEditDeck({ root: fixture.root, revisionId: fixture.revisionId, slideId: fixture.slideIds[0]! });
  await assert.rejects(
    prepareManualEditDeck({ root: fixture.root, revisionId: fixture.revisionId, slideId: fixture.slideIds[1]! }),
    /another deck edit session|active/i,
  );
  await assert.rejects(beginAgentCandidateConfirmation({
    root: fixture.root,
    sessionId: prepared.sessionId,
    slideId: fixture.slideIds[0]!,
  }), /agent|external-editing|manual/i);
  await assert.rejects(promoteProjectEditableTarget({
    root: fixture.root,
    slideId: fixture.slideIds[0]!,
    sourceRevisionId: fixture.revisionId,
    elementId: "title",
    expectedKind: "text",
  }), /external-editing|frozen/i);
  await assert.rejects(
    updateProject(fixture.root, (project) => ({ ...project, title: "must remain frozen" })),
    /open|external-editing|frozen/i,
  );
  assert.equal(await sessionState(fixture, prepared.sessionId), "external-editing");
});

test("manual adoption reconciles reorder, insertion, and deletion and the next edit starts from those exact bytes", async (t) => {
  const fixture = await workflowFixture(t);
  const prepared = await prepareManualEditDeck({ root: fixture.root, revisionId: fixture.revisionId, slideId: fixture.slideIds[1]! });
  const saved = await reorderInsertDelete(prepared.absolutePath);
  const adopted = await adoptManualSavedDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    userSignal: "saved-and-closed",
  });
  const revision = await readLocalDeckRevision(fixture.root, adopted.revisionId);
  assert.deepEqual(revision.slideTopology.entries.map((entry) => ({
    stableSlideId: entry.stableSlideId,
    position: entry.position,
    management: entry.management,
  })), [
    { stableSlideId: fixture.slideIds[1], position: 0, management: "managed" },
    { stableSlideId: revision.slideTopology.entries[1]!.stableSlideId, position: 1, management: "unmanaged" },
    { stableSlideId: fixture.slideIds[2], position: 2, management: "managed" },
  ]);
  assert.deepEqual(revision.slideTopology.deletedStableSlideIds, [fixture.slideIds[0]]);
  assert.deepEqual(revision.changedSlideIds, [
    fixture.slideIds[1],
    revision.slideTopology.entries[1]!.stableSlideId,
    fixture.slideIds[2],
    fixture.slideIds[0],
  ], "manual adoption records moved, inserted, non-target XML changed, and deleted stable IDs");

  const unmanaged = revision.slideTopology.entries[1]!;
  const next = await prepareManualEditDeck({ root: fixture.root, revisionId: adopted.revisionId, slideId: unmanaged.stableSlideId });
  assert.equal(next.targetSlideIndex, 1);
  assert.deepEqual(await readFile(next.absolutePath), saved);
  const savedAgain = await replaceSlideText(next.absolutePath, unmanaged.slidePart, "inserted", "inserted edited again");
  const adoptedAgain = await adoptManualSavedDeck({
    root: fixture.root,
    sessionId: next.sessionId,
    userSignal: "saved-and-closed",
  });
  assert.deepEqual(await readFile(next.absolutePath), savedAgain);
  assert.equal((await readLocalDeckRevision(fixture.root, adoptedAgain.revisionId)).slideTopology.entries[1]!.stableSlideId, unmanaged.stableSlideId);
  await assert.rejects(adoptManualSavedDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    userSignal: "saved-and-closed",
  }), /stale|active session/i);
  assert.equal((await readProject(fixture.root)).activeDeckEditSessionId, null);
});

test("manual adoption accepts WPS presentation identities after creation IDs are removed and the next Agent edit still binds", async (t) => {
  const fixture = await workflowFixture(t);
  const prepared = await prepareManualEditDeck({
    root: fixture.root,
    revisionId: fixture.revisionId,
    slideId: fixture.slideIds[1]!,
  });
  const saved = await wpsReorderInsertDeleteAndDropCreationIds(prepared.absolutePath);
  const savedStat = await stat(prepared.absolutePath);

  const adopted = await adoptManualSavedDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    userSignal: "saved-and-closed",
  });
  const adoptedStat = await stat(prepared.absolutePath);
  assert.deepEqual(await readFile(prepared.absolutePath), saved);
  assert.equal(adopted.sha256, digest(saved));
  assert.equal(adoptedStat.ino, savedStat.ino);
  assert.equal(adoptedStat.size, savedStat.size);

  const revision = await readLocalDeckRevision(fixture.root, adopted.revisionId);
  assert.deepEqual(revision.slideTopology.entries.map(({ stableSlideId, presentationSlideId, creationId, management }) => ({
    stableSlideId,
    presentationSlideId,
    creationId,
    management,
  })), [
    { stableSlideId: fixture.slideIds[1], presentationSlideId: 257, creationId: null, management: "managed" },
    { stableSlideId: revision.slideTopology.entries[1]!.stableSlideId, presentationSlideId: 259, creationId: null, management: "unmanaged" },
    { stableSlideId: fixture.slideIds[2], presentationSlideId: 258, creationId: null, management: "managed" },
  ]);
  assert.deepEqual(revision.slideTopology.deletedSlideIdentities, [
    { stableSlideId: fixture.slideIds[0], presentationSlideId: 256, creationId: 1001 },
  ]);

  const resolved = await resolveCurrentDeckPage({ root: fixture.root, pageNumber: 1 });
  assert.equal(resolved.revisionId, adopted.revisionId);
  assert.equal(resolved.stableSlideId, fixture.slideIds[1]);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: resolved.revisionId,
    reason: "agent-edit",
    changedSlideIds: [resolved.stableSlideId],
    editableSlideIds: revision.editableSlideIds,
    targetSlideId: resolved.stableSlideId,
    mode: "agent",
  });
  assert.deepEqual(await readFile(candidate.absolutePath), saved);
  await editActualSlideObjects({
    root: fixture.root,
    currentRevisionId: resolved.revisionId,
    sessionId: candidate.sessionId,
    candidatePath: candidate.absolutePath,
    slideId: resolved.stableSlideId,
    manifest: {
      manifestVersion: 2,
      canvas: { width: 1280, height: 720 },
      warnings: [],
      elements: [{
        kind: "text",
        id: "two",
        text: "two",
        bbox: { x: 100, y: 80, width: 600, height: 80 },
        rotation: 0,
        color: "#ffffff",
        fontSizePx: 48,
        bold: true,
        align: "center",
        zIndex: 1,
      }],
    },
    operations: [{ kind: "replace-text", elementId: "two", text: "Agent after WPS" }],
  });
  const editedInspection = await inspectLocalPptx(candidate.absolutePath);
  assert.deepEqual(editedInspection.slides.map((slide) => slide.creationId), [null, null, null]);
  const editedZip = await JSZip.loadAsync(await readFile(candidate.absolutePath));
  assert.match(await editedZip.file("ppt/slides/slide2.xml")!.async("string"), /<a:t>Agent after WPS<\/a:t>/);
  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, adopted.revisionId);

  const agentBytes = await readFile(candidate.absolutePath);
  const presented = await beginAgentCandidateConfirmation({
    root: fixture.root,
    sessionId: candidate.sessionId,
    slideId: resolved.stableSlideId,
  });
  assert.equal(presented.sha256, digest(agentBytes));
  const confirmed = await confirmAgentEditDeck({
    root: fixture.root,
    sessionId: presented.sessionId,
    confirmedSha256: presented.sha256,
  });
  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, confirmed.revisionId);
  assert.deepEqual(await readFile(prepared.absolutePath), saved);
  assert.deepEqual(await readFile(candidate.absolutePath), agentBytes);

  const rolledBack = await rollbackCurrentDeck(fixture.root, adopted.revisionId);
  assert.equal(rolledBack.revisionId, adopted.revisionId);
  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, adopted.revisionId);
  assert.deepEqual(await readFile(prepared.absolutePath), saved);
  assert.deepEqual(await readFile(candidate.absolutePath), agentBytes);

  const regenerationCandidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: adopted.revisionId,
    reason: "slide-regeneration",
    changedSlideIds: [resolved.stableSlideId],
    editableSlideIds: revision.editableSlideIds.filter((slideId) => slideId !== resolved.stableSlideId),
    targetSlideId: resolved.stableSlideId,
    mode: "agent",
  });
  const normalizedImage = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#334455" } }).png().toBuffer();
  await replaceRegeneratedSlideShapeTree({
    root: fixture.root,
    currentRevisionId: adopted.revisionId,
    sessionId: regenerationCandidate.sessionId,
    candidatePath: regenerationCandidate.absolutePath,
    slideId: resolved.stableSlideId,
    normalizedImage,
    normalizedImageSha256: digest(normalizedImage),
  });
  assert.deepEqual(
    (await inspectLocalPptx(regenerationCandidate.absolutePath)).slides.map((slide) => slide.creationId),
    [null, null, null],
  );
  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, adopted.revisionId);
  const regenerationPresented = await beginAgentCandidateConfirmation({
    root: fixture.root,
    sessionId: regenerationCandidate.sessionId,
    slideId: resolved.stableSlideId,
  });
  await rejectDeckEdit({ root: fixture.root, sessionId: regenerationPresented.sessionId });
});

test("blocking identity ambiguity preserves the previous current pointer and saved candidate bytes", async (t) => {
  const fixture = await workflowFixture(t);
  const prepared = await prepareManualEditDeck({ root: fixture.root, revisionId: fixture.revisionId, slideId: fixture.slideIds[1]! });
  const before = await readCurrentDeckPointer(fixture.root);
  const zip = await JSZip.loadAsync(await readFile(prepared.absolutePath));
  zip.file("ppt/slides/slide3.xml", slideXml(1002, "duplicate identity"));
  const ambiguous = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(prepared.absolutePath, ambiguous);

  await assert.rejects(adoptManualSavedDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    userSignal: "saved-and-closed",
  }), /duplicate|ambiguous/i);
  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, before.revisionId);
  assert.deepEqual(await readFile(prepared.absolutePath), ambiguous);
});

test("Agent candidate is not current until presented and confirmed hashes both match exact bytes", async (t) => {
  const fixture = await workflowFixture(t);
  const before = await readCurrentDeckPointer(fixture.root);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: before.revisionId,
    reason: "agent-edit",
    changedSlideIds: [fixture.slideIds[1]!],
    editableSlideIds: fixture.slideIds,
    targetSlideId: fixture.slideIds[1]!,
    mode: "agent",
  });
  const agentBytes = await replaceSlideText(candidate.absolutePath, "ppt/slides/slide2.xml", "two", "agent candidate");
  const prepared = await beginAgentCandidateConfirmation({
    root: fixture.root,
    sessionId: candidate.sessionId,
    slideId: fixture.slideIds[1]!,
  });
  assert.deepEqual(await readCurrentDeckPointer(fixture.root), before);
  assert.equal(prepared.sha256, digest(agentBytes));
  assert.equal(prepared.slideCount, fixture.slideIds.length);
  assert.equal(prepared.localLink, candidate.absolutePath);

  await assert.rejects(confirmAgentEditDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    confirmedSha256: "0".repeat(64),
  }), /exact candidate/i);
  assert.equal(await sessionState(fixture, prepared.sessionId), "awaiting-confirmation");
  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, before.revisionId);

  const adopted = await confirmAgentEditDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    confirmedSha256: prepared.sha256,
  });
  assert.equal(adopted.revisionId, prepared.revisionId);
  assert.deepEqual(await readFile(adopted.absolutePath), agentBytes);

  const next = await prepareManualEditDeck({ root: fixture.root, revisionId: adopted.revisionId, slideId: fixture.slideIds[0]! });
  assert.deepEqual(await readFile(next.absolutePath), agentBytes);
});

test("Agent text edits patch the current OOXML object while preserving WPS formatting and every other slide", async (t) => {
  const fixture = await workflowFixture(t);
  const before = await readCurrentDeckPointer(fixture.root);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: before.revisionId,
    reason: "agent-edit",
    changedSlideIds: [fixture.slideIds[1]!],
    editableSlideIds: fixture.slideIds,
    targetSlideId: fixture.slideIds[1]!,
    mode: "agent",
  });
  const beforeZip = await JSZip.loadAsync(await readFile(candidate.absolutePath));
  const beforeTarget = await beforeZip.file("ppt/slides/slide2.xml")!.async("string");
  const beforeUntouched = await beforeZip.file("ppt/slides/slide1.xml")!.async("nodebuffer");

  const edited = await editActualSlideObjects({
    root: fixture.root,
    currentRevisionId: before.revisionId,
    sessionId: candidate.sessionId,
    candidatePath: candidate.absolutePath,
    slideId: fixture.slideIds[1]!,
    manifest: {
      manifestVersion: 2,
      canvas: { width: 1280, height: 720 },
      warnings: [],
      elements: [{
        kind: "text",
        id: "two",
        text: "two",
        bbox: { x: 100, y: 80, width: 600, height: 80 },
        rotation: 0,
        color: "#ffffff",
        fontSizePx: 48,
        bold: true,
        align: "center",
        zIndex: 1,
      }],
    },
    operations: [{ kind: "replace-text", elementId: "two", text: "Agent updated title" }],
  });

  const afterZip = await JSZip.loadAsync(await readFile(candidate.absolutePath));
  const afterTarget = await afterZip.file("ppt/slides/slide2.xml")!.async("string");
  assert.equal(edited.slideId, fixture.slideIds[1]);
  assert.equal(edited.currentRevisionId, before.revisionId);
  assert.match(afterTarget, /<a:t>Agent updated title<\/a:t>/);
  for (const retained of [
    '<a:pPr algn="ctr"/>',
    '<a:xfrm rot="0"><a:off x="952500" y="762000"/><a:ext cx="5715000" cy="762000"/></a:xfrm>',
    '<a:rPr lang="zh-CN" sz="3200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Aptos"/></a:rPr>',
    'name="shape-card-Card"',
  ]) assert.equal(afterTarget.includes(retained), true, retained);
  assert.equal(afterTarget, beforeTarget.replace(">two</a:t>", ">Agent updated title</a:t>"));
  assert.deepEqual(await afterZip.file("ppt/slides/slide1.xml")!.async("nodebuffer"), beforeUntouched);
  assert.deepEqual(await readFile(fixture.absolutePath), fixture.deckBytes);
});

test("multi-run text replacement preserves paragraphs and run formatting while escaping replacement metacharacters", async (t) => {
  const fixture = await workflowFixture(t, sensitiveTextSlideXml);
  const current = await readCurrentDeckPointer(fixture.root);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: current.revisionId,
    reason: "agent-edit",
    changedSlideIds: [fixture.slideIds[1]!],
    editableSlideIds: fixture.slideIds,
    targetSlideId: fixture.slideIds[1]!,
    mode: "agent",
  });
  const beforeZip = await JSZip.loadAsync(await readFile(candidate.absolutePath));
  const beforeTarget = await beforeZip.file("ppt/slides/slide2.xml")!.async("string");
  const beforeUntouched = await beforeZip.file("ppt/slides/slide1.xml")!.async("nodebuffer");

  await editActualSlideObjects({
    root: fixture.root,
    currentRevisionId: current.revisionId,
    sessionId: candidate.sessionId,
    candidatePath: candidate.absolutePath,
    slideId: fixture.slideIds[1]!,
    manifest: {
      manifestVersion: 2,
      canvas: { width: 1280, height: 720 },
      warnings: [],
      elements: [{
        kind: "text",
        id: "two",
        text: "A&B<C>中文",
        bbox: { x: 100, y: 80, width: 600, height: 160 },
        rotation: 0,
        color: "#ffffff",
        fontSizePx: 48,
        bold: true,
        align: "center",
        zIndex: 1,
      }],
    },
    operations: [{ kind: "replace-text", elementId: "two", text: "X&Y<Z>\"'中文" }],
  });

  const afterZip = await JSZip.loadAsync(await readFile(candidate.absolutePath));
  const afterTarget = await afterZip.file("ppt/slides/slide2.xml")!.async("string");
  const expected = beforeTarget
    .replace("A&amp;B", "X&amp;Y")
    .replace("&lt;C&gt;", "&lt;Z&gt;")
    .replace("&#x4E2D;&#25991;", "\"'中文");
  assert.equal(afterTarget, expected);
  for (const retained of [
    '<a:pPr algn="ctr"/>',
    '<a:pPr algn="r"/>',
    '<a:xfrm rot="0"><a:off x="952500" y="762000"/><a:ext cx="5715000" cy="1524000"/></a:xfrm>',
    '<a:rPr lang="zh-CN" sz="3200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Aptos"/></a:rPr>',
    '<a:rPr lang="en-US" sz="2800" i="1"><a:solidFill><a:srgbClr val="FFCC00"/></a:solidFill><a:latin typeface="Courier New"/></a:rPr>',
    '<a:rPr lang="zh-CN" sz="2400" b="0"><a:solidFill><a:srgbClr val="00CCFF"/></a:solidFill><a:latin typeface="Noto Sans CJK SC"/></a:rPr>',
  ]) assert.equal(afterTarget.includes(retained), true, retained);
  assert.deepEqual(await afterZip.file("ppt/slides/slide1.xml")!.async("nodebuffer"), beforeUntouched);
  assert.deepEqual(await readFile(fixture.absolutePath), fixture.deckBytes);
});

test("regeneration rejects a staged mutation of any pre-existing media member", async (t) => {
  const fixture = await workflowFixture(t);
  const current = await readCurrentDeckPointer(fixture.root);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: current.revisionId,
    reason: "slide-regeneration",
    changedSlideIds: [fixture.slideIds[0]!],
    editableSlideIds: fixture.slideIds.slice(1),
    targetSlideId: fixture.slideIds[0]!,
    mode: "agent",
  });
  const originalCandidate = await readFile(candidate.absolutePath);
  const normalizedImage = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#445566" } }).png().toBuffer();

  await assert.rejects(replaceRegeneratedSlideShapeTree({
    root: fixture.root,
    currentRevisionId: current.revisionId,
    sessionId: candidate.sessionId,
    candidatePath: candidate.absolutePath,
    slideId: fixture.slideIds[0]!,
    normalizedImage,
    normalizedImageSha256: digest(normalizedImage),
    operations: {
      beforeAtomicReplace: async (stagingPath: string) => {
        const staged = await JSZip.loadAsync(await readFile(stagingPath));
        staged.file("ppt/media/shared-existing.png", Buffer.from("tampered existing shared media"));
        await writeFile(stagingPath, await staged.generateAsync({ type: "nodebuffer" }));
      },
    },
  }), /pre-existing package member|shared-existing\.png/i);
  assert.deepEqual(await readFile(candidate.absolutePath), originalCandidate);
});

test("regeneration reports its own topology diagnostic for a staged identity mutation", async (t) => {
  const fixture = await workflowFixture(t);
  const current = await readCurrentDeckPointer(fixture.root);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: current.revisionId,
    reason: "slide-regeneration",
    changedSlideIds: [fixture.slideIds[0]!],
    editableSlideIds: fixture.slideIds.slice(1),
    targetSlideId: fixture.slideIds[0]!,
    mode: "agent",
  });
  const originalCandidate = await readFile(candidate.absolutePath);
  const normalizedImage = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#445566" } }).png().toBuffer();

  await assert.rejects(replaceRegeneratedSlideShapeTree({
    root: fixture.root,
    currentRevisionId: current.revisionId,
    sessionId: candidate.sessionId,
    candidatePath: candidate.absolutePath,
    slideId: fixture.slideIds[0]!,
    normalizedImage,
    normalizedImageSha256: digest(normalizedImage),
    operations: {
      beforeAtomicReplace: async (stagingPath: string) => {
        const staged = await JSZip.loadAsync(await readFile(stagingPath));
        const presentation = await staged.file("ppt/presentation.xml")!.async("string");
        staged.file("ppt/presentation.xml", presentation.replace('id="256"', 'id="999"'));
        await writeFile(stagingPath, await staged.generateAsync({ type: "nodebuffer" }));
      },
    },
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /slide regeneration changed stable complete-deck topology/i);
    assert.doesNotMatch(error.message, /direct edit/i);
    return true;
  });
  assert.deepEqual(await readFile(candidate.absolutePath), originalCandidate);
});

test("supported simple-shape edits target the named current shape without rebuilding the slide", async (t) => {
  const fixture = await workflowFixture(t);
  const current = await readCurrentDeckPointer(fixture.root);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: current.revisionId,
    reason: "agent-edit",
    changedSlideIds: [fixture.slideIds[0]!],
    editableSlideIds: fixture.slideIds,
    targetSlideId: fixture.slideIds[0]!,
    mode: "agent",
  });
  const beforeZip = await JSZip.loadAsync(await readFile(candidate.absolutePath));
  const beforeTarget = await beforeZip.file("ppt/slides/slide1.xml")!.async("string");

  await editActualSlideObjects({
    root: fixture.root,
    currentRevisionId: current.revisionId,
    sessionId: candidate.sessionId,
    candidatePath: candidate.absolutePath,
    slideId: fixture.slideIds[0]!,
    manifest: {
      manifestVersion: 2,
      canvas: { width: 1280, height: 720 },
      warnings: [],
      elements: [{
        kind: "shape",
        id: "card",
        label: "Card",
        shape: "roundRect",
        bbox: { x: 80, y: 180, width: 640, height: 320 },
        fillColor: "#112233",
        strokeColor: "#445566",
        strokeWidthPx: 2,
        cornerRadiusPx: 16,
        zIndex: 0,
      }],
    },
    operations: [{ kind: "set-shape-style", elementId: "card", fillColor: "#ABCDEF" }],
  });

  const afterZip = await JSZip.loadAsync(await readFile(candidate.absolutePath));
  const afterTarget = await afterZip.file("ppt/slides/slide1.xml")!.async("string");
  assert.equal(afterTarget, beforeTarget.replace('val="112233"', 'val="ABCDEF"'));
  assert.equal(afterTarget.includes('name="shape-card-Card"'), true);
  assert.equal(afterTarget.includes('<a:ln w="19050"><a:solidFill><a:srgbClr val="445566"/>'), true);
});

test("changing an Agent candidate after presentation invalidates confirmation and rejection leaves current unchanged", async (t) => {
  const fixture = await workflowFixture(t);
  const before = await readCurrentDeckPointer(fixture.root);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: before.revisionId,
    reason: "agent-edit",
    changedSlideIds: [fixture.slideIds[2]!],
    editableSlideIds: fixture.slideIds,
    targetSlideId: fixture.slideIds[2]!,
    mode: "agent",
  });
  const prepared = await beginAgentCandidateConfirmation({
    root: fixture.root,
    sessionId: candidate.sessionId,
    slideId: fixture.slideIds[2]!,
  });
  await replaceSlideText(candidate.absolutePath, "ppt/slides/slide3.xml", "three", "changed after presentation");
  await assert.rejects(confirmAgentEditDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    confirmedSha256: prepared.sha256,
  }), /exact candidate|presented hash/i);
  await rejectDeckEdit({ root: fixture.root, sessionId: prepared.sessionId });
  assert.equal((await readCurrentDeckPointer(fixture.root)).revisionId, before.revisionId);
  assert.equal(await sessionState(fixture, prepared.sessionId), "rejected");
  assert.equal((await readProject(fixture.root)).activeDeckEditSessionId, null);
  await assert.rejects(confirmAgentEditDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    confirmedSha256: prepared.sha256,
  }), /stale|active session|rejected/i);
});
