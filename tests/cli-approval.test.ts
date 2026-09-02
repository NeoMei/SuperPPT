import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";

import { formatLocalPptxLink, requireLocalDeckHandoff } from "../src/host/capabilities.js";
import { beginAgentCandidateConfirmation, confirmAgentEditDeck } from "../src/deck-revisions/workflow.js";
import { createDeckCandidate, readCurrentDeckPointer, readLocalDeckRevision, rollbackCurrentDeck } from "../src/deck-revisions/store.js";
import { finalizeSlideTopology } from "../src/deck-revisions/topology.js";
import {
  bindAgentDeckConfirmation,
  mapUpstreamDeckChange,
  presentUpstreamImpactPlan,
  requireImpactPlanConfirmation,
  translateManualDeckSignal,
} from "../src/editable/route.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject, updateProject } from "../src/project/store.js";
import { applyCompleteDeckReviewAction } from "../src/project/promotion.js";

const execFileAsync = promisify(execFile);
const CLI = ["--import", "tsx", "src/cli.ts"];
const HOST_CAPABILITIES = JSON.stringify({
  source: "agent-host",
  localFilesystem: true,
  localFileLinks: true,
});
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";

const digest = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

async function temporary(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "superppt CLI 中文 空格-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeDeck(slideCount: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>");
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}">${Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="${R}/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`);
  for (let index = 0; index < slideCount; index += 1) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld xmlns:p="${P}" xmlns:p14="${P14}"><p:cSld><p:spTree/><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId val="${1001 + index}"/></p:ext></p:extLst></p:cSld></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships xmlns="${REL}"/>`);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

async function cliProject(t: TestContext) {
  const parent = await temporary(t);
  const root = join(parent, "项目 空格");
  const project = await initializeProject({ root, title: "本地完整演示" });
  const slideIds = [randomUUID(), randomUUID(), randomUUID()];
  const revisionId = randomUUID();
  const relativePath = `output/deck-revisions/${revisionId}/deck.pptx`;
  const absolutePath = join(root, ...relativePath.split("/"));
  const bytes = await makeDeck(slideIds.length);
  await mkdir(join(root, "output", "deck-revisions", revisionId), { recursive: true });
  await writeFile(absolutePath, bytes);
  const topology = finalizeSlideTopology(slideIds.map((stableSlideId, position) => ({
    stableSlideId,
    slidePart: `ppt/slides/slide${position + 1}.xml`,
    position,
    management: "managed" as const,
    presentationSlideId: 256 + position,
    creationId: 1001 + position,
  })), []);
  await writeFile(join(root, "output", "deck-revisions", revisionId, "revision.json"), `${JSON.stringify({
    schemaVersion: 1,
    revisionId,
    parentRevisionId: null,
    projectId: project.projectId,
    projectRevisionId: project.currentRevision.id,
    reason: "initial",
    relativePath,
    sha256: digest(bytes),
    slideTopology: topology,
    editableSlideIds: slideIds,
    changedSlideIds: slideIds,
    reviewRequiredObjectsBySlideId: {},
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  const current = { schemaVersion: 1 as const, revisionId, relativePath, sha256: digest(bytes), updatedAt: new Date().toISOString() };
  await writeFile(join(root, "output", "current.json"), `${JSON.stringify(current, null, 2)}\n`);
  await updateProject(root, (manifest) => ({
    ...manifest,
    stage: "deck-review",
    currentDeck: current,
    slides: slideIds.map((id, order) => ({
      id,
      order,
      title: `Slide ${order + 1}`,
      role: order === 0 ? "cover" as const : order === slideIds.length - 1 ? "summary" as const : "content" as const,
      specRevisionId: manifest.currentRevision.id,
      promptRevisionId: null,
      styleRevisionId: null,
      status: "ready" as const,
      image: null,
      editable: null,
      finalRender: null,
      staleReasons: [],
    })),
  }));
  return { root, slideIds, revisionId, absolutePath };
}

async function runCli(args: string[], capabilities = HOST_CAPABILITIES) {
  return execFileAsync(process.execPath, [...CLI, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, SUPERPPT_HOST_CAPABILITIES: capabilities },
  });
}

async function runCliJson(args: string[]) {
  const result = await runCli(args);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout) as Record<string, any>;
}

test("requires an injected host capability object and never infers local handoff support", () => {
  assert.throws(() => requireLocalDeckHandoff(undefined), /host.*capabil|local.*link/i);
  assert.throws(() => requireLocalDeckHandoff({ source: "agent-host", localFilesystem: true, localFileLinks: false }), /local.*link/i);
  assert.doesNotThrow(() => requireLocalDeckHandoff({ source: "agent-host", localFilesystem: true, localFileLinks: true }));
});

test("formats canonical absolute Chinese and space-containing PPTX paths as robust angle-bracket links", () => {
  const canonicalDeckPath = process.platform === "win32"
    ? "C:\\tmp\\中文 目录\\deck.pptx"
    : "/tmp/中文 目录/deck.pptx";
  assert.equal(
    formatLocalPptxLink(canonicalDeckPath, "演示 [终稿].pptx"),
    `[演示 \\[终稿\\].pptx](<${canonicalDeckPath}>)`,
  );
  for (const path of ["relative/deck.pptx", "/tmp/../tmp/deck.pptx", "/tmp/deck.pdf", "/tmp/bad>deck.pptx", "/tmp/bad\ndeck.pptx"]) {
    assert.throws(() => formatLocalPptxLink(path, "deck.pptx"), /absolute|canonical|pptx|unsafe|control|target/i, path);
  }
});

test("manual commands return one clickable complete PPTX and adopt only saved-and-closed", async (t) => {
  const project = await cliProject(t);
  const current = await runCliJson(["current-deck-link", "--project", project.root]);
  assert.equal(current.kind, "complete-local-pptx");
  assert.equal(current.absolutePath, project.absolutePath);
  assert.equal(current.markdownLink, `[${current.linkLabel}](<${current.absolutePath}>)`);
  assert.equal("sessionId" in current, false);

  const editPage = await runCliJson([
    "complete-deck-review", "--project", project.root, "--action", "edit-page",
    "--revision-id", project.revisionId, "--sha256", digest(await readFile(project.absolutePath)),
    "--slide-id", project.slideIds[1]!,
  ]);
  assert.equal(editPage.stage, "revising");

  const prepared = await runCliJson([
    "prepare-manual-deck", "--project", project.root, "--revision-id", project.revisionId, "--slide-id", project.slideIds[1]!,
  ]);
  assert.equal(prepared.kind, "complete-local-pptx");
  assert.equal(prepared.mode, "manual");
  assert.equal(prepared.slideCount, project.slideIds.length);
  assert.equal(prepared.targetSlideId, project.slideIds[1]);
  assert.match(prepared.absolutePath, /output[\/\\]deck-revisions[\/\\].+[\/\\]deck\.pptx$/);
  assert.equal(prepared.markdownLink, `[${prepared.linkLabel}](<${prepared.absolutePath}>)`);
  assert.equal(prepared.waitFor, "已保存并关闭");

  assert.throws(() => translateManualDeckSignal("已保存"), /已保存并关闭/);
  const internalSignal = translateManualDeckSignal("已保存并关闭");
  const adopted = await runCliJson([
    "adopt-saved-deck", "--project", project.root, "--session-id", prepared.sessionId, "--user-signal", internalSignal,
  ]);
  assert.equal(adopted.currentRevisionId, prepared.revisionId);
  assert.equal("absolutePath" in adopted, false);
  assert.match(adopted.nextRequiredAction, /current-deck-link/);
  assert.equal((await readProject(project.root)).stage, "deck-review");
  const savedBytes = await readFile(prepared.absolutePath);
  const delivery = await runCliJson([
    "complete-deck-review", "--project", project.root, "--action", "confirm-delivery",
    "--revision-id", adopted.currentRevisionId, "--sha256", adopted.sha256,
  ]);
  assert.equal(delivery.stage, "delivered");
  const delivered = await readProject(project.root);
  assert.equal(delivered.formalDelivery?.revisionId, adopted.currentRevisionId);
  assert.equal(delivered.formalDelivery?.absolutePath, prepared.absolutePath);
  assert.equal(delivered.formalDelivery?.sha256, adopted.sha256);
  assert.equal(delivered.exports.pptx?.path, `output/deck-revisions/${adopted.currentRevisionId}/deck.pptx`);
  const acceptance = JSON.parse(await readFile(join(project.root, delivered.exports.acceptance!.path), "utf8"));
  assert.deepEqual(acceptance.completeDeck, delivered.formalDelivery);
  assert.deepEqual(acceptance.formalDelivery, delivered.formalDelivery);
  assert.deepEqual(acceptance.exports.pptx, delivered.formalDelivery);
  assert.deepEqual(acceptance.client.completeDeck, delivered.formalDelivery);
  assert.deepEqual(await readFile(prepared.absolutePath), savedBytes, "manual adopt through acceptance remains byte-identical");
});

test("complete-deck-review CLI authenticates all three choices and confirm-delivery binds exact current bytes", async (t) => {
  const project = await cliProject(t);
  const before = await readFile(project.absolutePath);
  const confirmed = await runCliJson([
    "complete-deck-review",
    "--project", project.root,
    "--action", "confirm-delivery",
    "--revision-id", project.revisionId,
    "--sha256", digest(before),
  ]);
  assert.equal(confirmed.action, "confirm-delivery");
  assert.equal(confirmed.stage, "delivered");
  const manifest = await readProject(project.root);
  assert.equal(manifest.stage, "delivered");
  assert.deepEqual(manifest.formalDelivery, {
    revisionId: project.revisionId,
    absolutePath: project.absolutePath,
    sha256: digest(before),
  });
  assert.deepEqual(manifest.exports.pptx, {
    path: `output/deck-revisions/${project.revisionId}/deck.pptx`,
    sha256: digest(before),
    revisionId: manifest.currentRevision.id,
  });
  assert.equal(manifest.exports.acceptance?.revisionId, manifest.currentRevision.id);
  const acceptance = JSON.parse(await readFile(join(project.root, manifest.exports.acceptance!.path), "utf8"));
  assert.deepEqual(acceptance.completeDeck, manifest.formalDelivery);
  assert.deepEqual(acceptance.formalDelivery, manifest.formalDelivery);
  assert.deepEqual(acceptance.exports.pptx, manifest.formalDelivery);
  assert.deepEqual(acceptance.client.completeDeck, manifest.formalDelivery);
  assert.equal(acceptance.actionEvidenceSha256, confirmed.evidence.actionEvidenceSha256);
  assert.deepEqual(await readFile(project.absolutePath), before, "formal delivery must not rewrite current PPTX bytes");

  const stale = await cliProject(t);
  await assert.rejects(runCli([
    "complete-deck-review", "--project", stale.root, "--action", "confirm-delivery",
    "--revision-id", stale.revisionId, "--sha256", "0".repeat(64),
  ]), /stale|current|sha-256/i);
});

test("one pending edit binding is required, exact, atomically consumed, and not replayable", async (t) => {
  const project = await cliProject(t);
  const sessionsRoot = join(project.root, "output", "deck-edit-sessions");
  const revisionsRoot = join(project.root, "output", "deck-revisions");
  const beforeSessions = await readdir(sessionsRoot).catch(() => []);
  const beforeRevisions = await readdir(revisionsRoot);

  await assert.rejects(runCli([
    "prepare-manual-deck", "--project", project.root, "--revision-id", project.revisionId,
    "--slide-id", project.slideIds[0]!,
  ]), /pending edit|edit-page.*required|authorization/i);
  await assert.rejects(createDeckCandidate(project.root, {
    sourceRevisionId: project.revisionId,
    reason: "agent-edit",
    changedSlideIds: [project.slideIds[0]!],
    editableSlideIds: project.slideIds,
    targetSlideId: project.slideIds[0]!,
    mode: "agent",
  }), /pending edit|edit-page.*required|authorization/i);
  assert.deepEqual(await readdir(sessionsRoot).catch(() => []), beforeSessions);
  assert.deepEqual(await readdir(revisionsRoot), beforeRevisions);

  const current = await readCurrentDeckPointer(project.root);
  await runCliJson([
    "complete-deck-review", "--project", project.root, "--action", "edit-page",
    "--revision-id", current.revisionId, "--sha256", current.sha256,
    "--slide-id", project.slideIds[1]!,
  ]);
  assert.deepEqual((await readProject(project.root)).pendingDeckEdit, {
    revisionId: current.revisionId,
    sha256: current.sha256,
    slideId: project.slideIds[1],
  });

  await assert.rejects(runCli([
    "prepare-manual-deck", "--project", project.root, "--revision-id", project.revisionId,
    "--slide-id", project.slideIds[0]!,
  ]), /pending edit.*slide|does not match|wrong.*slide/i);
  assert.deepEqual(await readdir(sessionsRoot).catch(() => []), beforeSessions);
  assert.deepEqual(await readdir(revisionsRoot), beforeRevisions);
  assert.equal((await readProject(project.root)).pendingDeckEdit?.slideId, project.slideIds[1]);

  const prepared = await runCliJson([
    "prepare-manual-deck", "--project", project.root, "--revision-id", project.revisionId,
    "--slide-id", project.slideIds[1]!,
  ]);
  assert.equal((await readProject(project.root)).pendingDeckEdit, null);
  const adopted = await runCliJson([
    "adopt-saved-deck", "--project", project.root, "--session-id", prepared.sessionId,
    "--user-signal", "saved-and-closed",
  ]);
  assert.equal((await readProject(project.root)).pendingDeckEdit, null);
  await assert.rejects(runCli([
    "prepare-manual-deck", "--project", project.root, "--revision-id", adopted.currentRevisionId,
    "--slide-id", project.slideIds[1]!,
  ]), /pending edit|edit-page.*required|authorization/i, "consumed binding cannot be replayed");

  await updateProject(project.root, (manifest) => ({
    ...manifest,
    stage: "revising",
    pendingDeckEdit: {
      revisionId: project.revisionId,
      sha256: current.sha256,
      slideId: project.slideIds[1]!,
    },
  }));
  const staleSessions = await readdir(sessionsRoot);
  const staleRevisions = await readdir(revisionsRoot);
  await assert.rejects(createDeckCandidate(project.root, {
    sourceRevisionId: adopted.currentRevisionId,
    reason: "agent-edit",
    changedSlideIds: [project.slideIds[1]!],
    editableSlideIds: project.slideIds,
    targetSlideId: project.slideIds[1]!,
    mode: "agent",
  }), /pending edit.*stale|revision|SHA-256/i);
  assert.deepEqual(await readdir(sessionsRoot), staleSessions);
  assert.deepEqual(await readdir(revisionsRoot), staleRevisions);
});

test("fixed exact-current acceptance recovers crashes and replays identical delivery without rewriting deck bytes", async (t) => {
  for (const phase of ["acceptance-artifact-written", "manifest-before-update"] as const) {
    const project = await cliProject(t);
    const current = await readCurrentDeckPointer(project.root);
    const deckBytes = await readFile(current.absolutePath);
    await assert.rejects(applyCompleteDeckReviewAction(project.root, {
      action: "confirm-delivery",
      revisionId: current.revisionId,
      deckSha256: current.sha256,
    }, {
      checkpoint(step) {
        if (step === phase) throw new Error(`injected ${phase}`);
      },
    }), new RegExp(`injected ${phase}`));
    assert.equal((await readProject(project.root)).stage, "deck-review");
    const acceptancePath = join(project.root, "output", "deck-revisions", current.revisionId, "acceptance.json");
    const written = await readFile(acceptancePath);
    const recovered = await applyCompleteDeckReviewAction(project.root, {
      action: "confirm-delivery",
      revisionId: current.revisionId,
      deckSha256: current.sha256,
    });
    assert.equal(recovered.stage, "delivered");
    assert.deepEqual(await readFile(acceptancePath), written);
    assert.deepEqual(await readFile(current.absolutePath), deckBytes);
  }

  const linked = await cliProject(t);
  const linkedCurrent = await readCurrentDeckPointer(linked.root);
  const outsideAcceptance = join(dirname(linked.root), "outside-acceptance.json");
  const outsideBytes = Buffer.from("outside trust root must remain untouched\n");
  await writeFile(outsideAcceptance, outsideBytes);
  await symlink(outsideAcceptance, join(linked.root, "output", "deck-revisions", linkedCurrent.revisionId, "acceptance.json"));
  await assert.rejects(applyCompleteDeckReviewAction(linked.root, {
    action: "confirm-delivery",
    revisionId: linkedCurrent.revisionId,
    deckSha256: linkedCurrent.sha256,
  }), /acceptance.*conflict|owned|symbolic|regular/i);
  assert.deepEqual(await readFile(outsideAcceptance), outsideBytes, "fixed acceptance never follows or removes an external trust-root symlink");

  const project = await cliProject(t);
  const initial = await readCurrentDeckPointer(project.root);
  await runCliJson([
    "complete-deck-review", "--project", project.root, "--action", "edit-page",
    "--revision-id", initial.revisionId, "--sha256", initial.sha256, "--slide-id", project.slideIds[1]!,
  ]);
  const prepared = await runCliJson([
    "prepare-manual-deck", "--project", project.root, "--revision-id", initial.revisionId,
    "--slide-id", project.slideIds[1]!,
  ]);
  const adopted = await runCliJson([
    "adopt-saved-deck", "--project", project.root, "--session-id", prepared.sessionId,
    "--user-signal", "saved-and-closed",
  ]);
  const adoptedBytes = await readFile(prepared.absolutePath);
  await applyCompleteDeckReviewAction(project.root, {
    action: "confirm-delivery", revisionId: adopted.currentRevisionId, deckSha256: adopted.sha256,
  });
  const acceptancePath = join(project.root, "output", "deck-revisions", adopted.currentRevisionId, "acceptance.json");
  const acceptedBytes = await readFile(acceptancePath);
  await rollbackCurrentDeck(project.root, initial.revisionId);
  await rollbackCurrentDeck(project.root, adopted.currentRevisionId);
  await applyCompleteDeckReviewAction(project.root, {
    action: "confirm-delivery", revisionId: adopted.currentRevisionId, deckSha256: adopted.sha256,
  });
  assert.deepEqual(await readFile(acceptancePath), acceptedBytes, "redelivery reuses identical acceptance bytes");
  assert.deepEqual(await readFile(prepared.absolutePath), adoptedBytes, "redelivery never rewrites the user deck");

  await rollbackCurrentDeck(project.root, initial.revisionId);
  await rollbackCurrentDeck(project.root, adopted.currentRevisionId);
  const conflict = JSON.parse(acceptedBytes.toString("utf8"));
  conflict.completeDeck.sha256 = "0".repeat(64);
  await writeFile(acceptancePath, `${JSON.stringify(conflict, null, 2)}\n`);
  await assert.rejects(applyCompleteDeckReviewAction(project.root, {
    action: "confirm-delivery", revisionId: adopted.currentRevisionId, deckSha256: adopted.sha256,
  }), /acceptance.*conflict|existing.*acceptance|exact current/i);
  assert.deepEqual(await readFile(prepared.absolutePath), adoptedBytes, "conflict does not delete or rewrite the user deck");
});

test("resolves repeated page-number edits from the current reconciled deck topology", async (t) => {
  const project = await cliProject(t);
  const resolved = await runCliJson([
    "resolve-current-deck-page", "--project", project.root, "--page-number", "2",
  ]);
  assert.deepEqual(resolved, {
    revisionId: project.revisionId,
    pageNumber: 2,
    stableSlideId: project.slideIds[1],
    management: "managed",
  });
  await assert.rejects(runCli([
    "resolve-current-deck-page", "--project", project.root, "--page-number", "4",
  ]), /outside.*topology|page number/i);
});

test("prepare-manual-deck binds the resolver revision and leaves no candidate when it is stale", async (t) => {
  const project = await cliProject(t);
  const resolved = await runCliJson([
    "resolve-current-deck-page", "--project", project.root, "--page-number", "2",
  ]);
  const resolvedCurrent = await readCurrentDeckPointer(project.root);
  await applyCompleteDeckReviewAction(project.root, {
    action: "edit-page",
    revisionId: resolvedCurrent.revisionId,
    deckSha256: resolvedCurrent.sha256,
    slideId: resolved.stableSlideId,
  });
  const candidate = await createDeckCandidate(project.root, {
    sourceRevisionId: resolved.revisionId,
    reason: "agent-edit",
    changedSlideIds: [resolved.stableSlideId],
    editableSlideIds: project.slideIds,
    targetSlideId: resolved.stableSlideId,
    mode: "agent",
  });
  const presented = await beginAgentCandidateConfirmation({
    root: project.root,
    sessionId: candidate.sessionId,
    slideId: resolved.stableSlideId,
  });
  const promoted = await confirmAgentEditDeck({
    root: project.root,
    sessionId: presented.sessionId,
    confirmedSha256: presented.sha256,
  });
  const promotedRevision = await readLocalDeckRevision(project.root, promoted.revisionId);
  assert.ok(promotedRevision.slideTopology.entries.some(({ stableSlideId }) => stableSlideId === resolved.stableSlideId));
  const revisionDirectoriesBefore = await readdir(join(project.root, "output", "deck-revisions"));
  const sessionDirectoriesBefore = await readdir(join(project.root, "output", "deck-edit-sessions"));

  await assert.rejects(runCli([
    "prepare-manual-deck",
    "--project", project.root,
    "--revision-id", resolved.revisionId,
    "--slide-id", resolved.stableSlideId,
  ]), /stale|current revision changed|no longer current/i);

  assert.equal((await readCurrentDeckPointer(project.root)).revisionId, promoted.revisionId);
  assert.deepEqual(await readdir(join(project.root, "output", "deck-revisions")), revisionDirectoriesBefore);
  assert.deepEqual(await readdir(join(project.root, "output", "deck-edit-sessions")), sessionDirectoriesBefore);
  assert.equal((await readProject(project.root)).activeDeckEditSessionId, null);
});

test("Agent confirmation, rejection, and deck rollback use exact complete-deck identities", async (t) => {
  const project = await cliProject(t);
  const first = await readCurrentDeckPointer(project.root);
  assert.equal((await applyCompleteDeckReviewAction(project.root, {
    action: "edit-page",
    revisionId: first.revisionId,
    deckSha256: first.sha256,
    slideId: project.slideIds[0]!,
  })).stage, "revising");
  const rejectedCandidate = await createDeckCandidate(project.root, {
    sourceRevisionId: first.revisionId,
    reason: "agent-edit",
    changedSlideIds: [project.slideIds[0]!],
    editableSlideIds: project.slideIds,
    targetSlideId: project.slideIds[0]!,
    mode: "agent",
  });
  const rejected = await beginAgentCandidateConfirmation({ root: project.root, sessionId: rejectedCandidate.sessionId, slideId: project.slideIds[0]! });
  const rejectResult = await runCliJson(["reject-deck-candidate", "--project", project.root, "--session-id", rejected.sessionId]);
  assert.equal(rejectResult.rejected, true);
  assert.equal((await readCurrentDeckPointer(project.root)).revisionId, first.revisionId);
  assert.equal((await readProject(project.root)).stage, "deck-review");

  assert.equal((await applyCompleteDeckReviewAction(project.root, {
    action: "edit-page",
    revisionId: first.revisionId,
    deckSha256: first.sha256,
    slideId: project.slideIds[1]!,
  })).stage, "revising");
  const candidate = await createDeckCandidate(project.root, {
    sourceRevisionId: first.revisionId,
    reason: "agent-edit",
    changedSlideIds: [project.slideIds[1]!],
    editableSlideIds: project.slideIds,
    targetSlideId: project.slideIds[1]!,
    mode: "agent",
  });
  const presented = await beginAgentCandidateConfirmation({ root: project.root, sessionId: candidate.sessionId, slideId: project.slideIds[1]! });
  assert.throws(() => bindAgentDeckConfirmation("确认一下", presented.sha256), /精确.*确认|exact.*确认/i);
  await assert.rejects(runCli([
    "confirm-agent-deck", "--project", project.root, "--session-id", presented.sessionId, "--sha256", "0".repeat(64),
  ]), /hash|sha-256|presented/i);
  const confirmed = await runCliJson([
    "confirm-agent-deck", "--project", project.root, "--session-id", presented.sessionId, "--sha256", bindAgentDeckConfirmation("确认", presented.sha256),
  ]);
  assert.equal(confirmed.currentRevisionId, presented.revisionId);
  assert.equal("absolutePath" in confirmed, false);
  assert.match(confirmed.nextRequiredAction, /current-deck-link/);
  assert.equal((await readProject(project.root)).stage, "deck-review");
  const rolledBack = await runCliJson(["rollback-deck", "--project", project.root, "--revision-id", first.revisionId]);
  assert.equal(rolledBack.currentRevisionId, first.revisionId);
  assert.equal("absolutePath" in rolledBack, false);
  assert.match(rolledBack.nextRequiredAction, /current-deck-link/);
  assert.equal((await readProject(project.root)).stage, "deck-review");
});

test("upstream choices publish hash-bound actual impact, wait, then resume from restartStage", async (t) => {
  const cases = [
    ["修改大纲", "outline"],
    ["修改第 2 页描述", "slide-specs"],
    ["换风格", "style"],
  ] as const;
  for (const [choice, expectedRestartStage] of cases) {
    const project = await cliProject(t);
    const current = await readCurrentDeckPointer(project.root);
    const beforeSelection = await readFile(join(project.root, "superppt.json"));
    const selected = await applyCompleteDeckReviewAction(project.root, {
      action: "return-upstream",
      revisionId: current.revisionId,
      deckSha256: current.sha256,
    });
    assert.equal(selected.stage, "deck-review", choice);
    assert.deepEqual(await readFile(join(project.root, "superppt.json")), beforeSelection, choice);

    const change = mapUpstreamDeckChange(choice, project.slideIds);
    const changePath = join(project.root, `change-${expectedRestartStage}.json`);
    await writeFile(changePath, `${JSON.stringify(change)}\n`, { mode: 0o600 });
    const plan = await runCliJson(["impact", "--project", project.root, "--change", changePath]);
    const presentation = presentUpstreamImpactPlan(plan);
    assert.equal(plan.restartStage, expectedRestartStage, choice);
    assert.deepEqual(
      plan.staleSlideIds,
      choice === "修改第 2 页描述" ? [project.slideIds[1]] : project.slideIds,
      choice,
    );
    assert.deepEqual(plan.invalidatedOutputs, ["complete-local-pptx", "formal-delivery", "acceptance-evidence"], choice);
    assert.match(plan.sha256, /^[a-f0-9]{64}$/, choice);
    assert.equal(presentation.waitFor, "确认", choice);
    assert.equal((await readProject(project.root)).stage, "deck-review", `${choice} must wait before apply`);

    assert.throws(() => requireImpactPlanConfirmation("同意", presentation.sha256), /精确.*确认|exact.*确认/i);
    const confirmedPlanSha256 = requireImpactPlanConfirmation("确认", presentation.sha256);
    const approved = await runCliJson(["approve-impact", "--project", project.root, "--sha256", confirmedPlanSha256]);
    assert.equal(approved.approved, true, choice);
    assert.equal((await readProject(project.root)).stage, "deck-review", `${choice} approval alone must not apply`);
    const applied = await runCliJson(["apply-impact", "--project", project.root]);
    assert.equal(applied.applied, true, choice);
    assert.equal(applied.restartStage, expectedRestartStage, choice);
    assert.equal((await readProject(project.root)).stage, expectedRestartStage, choice);
  }
});

test("complete-deck review actions fail closed on stale hashes and persist revision path hash evidence", async (t) => {
  const project = await cliProject(t);
  const current = await readCurrentDeckPointer(project.root);
  await assert.rejects(applyCompleteDeckReviewAction(project.root, {
    action: "confirm-delivery",
    revisionId: current.revisionId,
    deckSha256: "0".repeat(64),
  }), /stale|exact current/i);

  const outcome = await applyCompleteDeckReviewAction(project.root, {
    action: "confirm-delivery",
    revisionId: current.revisionId,
    deckSha256: current.sha256,
  });
  assert.equal(outcome.stage, "delivered");
  assert.equal(outcome.currentRevisionId, current.revisionId);
  assert.equal(outcome.evidence.absolutePath, current.absolutePath);
  assert.equal(outcome.evidence.deckSha256, current.sha256);
  const gate = (await readProject(project.root)).gates.at(-1)!;
  assert.deepEqual(gate.deckReview, {
    revisionId: current.revisionId,
    absolutePath: current.absolutePath,
    sha256: current.sha256,
  });
  assert.deepEqual(gate.artifactHashes, {});
  assert.equal(gate.presentation, undefined);
});

test("removed preview and image-review commands fail with the complete-deck replacement", async () => {
  for (const command of [
    "render-editable",
    "confirm-preview",
    "replace-slide",
    "export-review-derived",
    "assemble-candidate",
    "publish-deck-review",
    "deck-review-action",
  ]) {
    await assert.rejects(runCli([command]), (error: unknown) => {
      const stderr = String((error as { stderr?: string }).stderr ?? error);
      assert.match(stderr, /complete deck|current-deck-link|prepare-manual-deck/i, command);
      return true;
    });
  }
});

test("local-link preflight fails before touching an invalid project", async () => {
  await assert.rejects(
    runCli(["current-deck-link", "--project", "/definitely/not/a/project"], JSON.stringify({
      source: "agent-host",
      localFilesystem: false,
      localFileLinks: false,
    })),
    (error: unknown) => {
      assert.match(String((error as { stderr?: string }).stderr ?? error), /local filesystem|local file links/i);
      return true;
    },
  );
});
