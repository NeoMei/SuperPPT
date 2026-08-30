import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { runOfflineAcceptance } from "../src/acceptance/offline.js";
import { assembleProjectCandidate } from "../src/deck/assemble.js";
import { sha256 } from "../src/project/store.js";

test("runs intake through mixed-slide replacement without changing untouched renders", async (t) => {
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
    promotedRevision: 2,
  });
  const initialAcceptance = JSON.parse(await readFile(result.before.acceptance, "utf8"));
  assert.equal(initialAcceptance.deckReviewConfirmation.action, "confirm-delivery");
  assert.equal(initialAcceptance.deckReviewConfirmation.candidateId, initialAcceptance.candidateReview.candidateId);
  assert.equal(result.before.slideCount, result.after.slideCount);
  assert.deepEqual(result.after.slideOrder, result.before.slideOrder);
  assert.deepEqual(result.after.editableSlideIds, [result.changedSlideId]);
  assert.notEqual(
    result.before.renderHashes[result.changedSlideId],
    result.after.renderHashes[result.changedSlideId],
  );
  for (const [id, hash] of Object.entries(result.before.renderHashes)) {
    if (id !== result.changedSlideId) assert.equal(result.after.renderHashes[id], hash);
  }

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
    for (const kind of ["pptx", "pdf", "montage"] as const) {
      const bytes = await readFile(snapshot.exports[kind]);
      assert.equal(acceptance.exports[kind].sha256, sha256(bytes));
    }
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
