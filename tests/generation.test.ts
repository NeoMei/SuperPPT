import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import JSZip from "jszip";

import {
  describeProjectGeneration,
  prepareDeckJob,
  preparePageRegenerationJob,
} from "../src/generation/batch.js";
import {
  admitDelegatedGenerationCall,
  executeAuthorizedGenerationCall,
  generationCallBudget,
  publishGenerationAuthorizationPlan,
  publishPageRegenerationAuthorizationPlan,
  publishStyleSampleGenerationPlan,
  readCallLedger,
} from "../src/generation/authorization.js";
import {
  recordDelegatedResult,
} from "../src/generation/delegation-result.js";
import { ImageGenerationJobSchema, canonicalContractFile } from "../src/generation/job-schemas.js";
import { assertJobAuthorized, prepareImageGenerationJob } from "../src/generation/jobs.js";
import { withGenerationLease } from "../src/generation/lease.js";
import { finalizeStyleSample, prepareStyleSampleJob } from "../src/generation/style-sample.js";
import {
  assertTrustedGenerationAuthorizationRecord,
  configureGenerationAuthorizationTrustForTests,
} from "../src/generation/trusted-authorization.js";
import {
  DependencyGenerationResultSchema,
  ImageGenerationResultSchema,
  SerialStickyReportSchema,
  type SerialStickyReport,
} from "../src/generation/schemas.js";
import { resolveSkillDependencies } from "../src/dependencies/resolve.js";
import type { AiImageSkillDependency } from "../src/dependencies/schemas.js";
import { assembleProjectCandidate, type FinalRender } from "../src/deck/assemble.js";
import { buildMontage } from "../src/deck/montage.js";
import { exportPdf } from "../src/deck/pdf.js";
import { approveExecutionGate, approveGate, assertGateCurrent } from "../src/planning/confirm.js";
import { loadValidatedPlan } from "../src/planning/load.js";
import { publishPlanViews, publishStyleSample } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { addDescriptorIntegrity, sha256Evidence, snapshotManifestEvidenceHash } from "../src/project/evidence.js";
import { ProjectManifestSchema } from "../src/project/schemas.js";
import { readProject } from "../src/project/store.js";
import {
  applyRevision,
  approveImpact,
  publishImpactPlan,
  recoverRollbackTransaction,
  rollbackToRevision,
} from "../src/revisions/apply.js";
import { loadBuiltInStyleCatalog } from "../src/styles/catalog.js";
import { compileSlidePrompt } from "../src/styles/prompt-compiler.js";
import { approveStyleLock, createProvisionalStyleLock, readApprovedStyleLock } from "../src/styles/style-lock.js";
import { writeCanonicalStyleSample } from "./helpers/style-sample.js";
import { finalizeDelegatedStyleSampleForTest } from "./helpers/delegated-style-sample.js";

const execFileAsync = promisify(execFile);
const SLIDE_IDS = [
  "00000000-0000-4000-8000-000000000711",
  "00000000-0000-4000-8000-000000000712",
  "00000000-0000-4000-8000-000000000713",
] as const;

async function directory(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return realpath(root);
}

test("a delayed async descendant reacquires the generation lease after its owner settles", async (t) => {
  const parent = await directory(t, "superppt-generation-lease-descendant-");
  const root = join(parent, "project");
  await initializeProject({ root, title: "Generation Lease" });
  const events: string[] = [];
  let releaseDescendant!: () => void;
  const descendantMayStart = new Promise<void>((resolve) => { releaseDescendant = resolve; });
  let descendant!: Promise<void>;

  await withGenerationLease(root, async () => {
    descendant = (async () => {
      await descendantMayStart;
      await withGenerationLease(root, async () => {
        events.push("descendant-entered");
      });
    })();
    events.push("owner-entered");
  });

  await withGenerationLease(root, async () => {
    events.push("new-holder-entered");
    releaseDescendant();
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.push("new-holder-exited");
  });
  await descendant;

  assert.deepEqual(events, [
    "owner-entered",
    "new-holder-entered",
    "new-holder-exited",
    "descendant-entered",
  ]);
});

test("a live generation lease permits nested reentry through a canonical root alias", async (t) => {
  const parent = await directory(t, "superppt-generation-lease-alias-");
  const root = join(parent, "project");
  await initializeProject({ root, title: "Generation Lease Alias" });
  const events: string[] = [];

  await withGenerationLease(root, async (canonicalRoot) => {
    events.push(`outer:${canonicalRoot}`);
    await withGenerationLease(`${root}/.`, async (nestedRoot) => {
      events.push(`nested:${nestedRoot}`);
    });
  });

  assert.deepEqual(events, [`outer:${root}`, `nested:${root}`]);
});

async function approvedProject(
  t: TestContext,
  prefix: string,
  styleLock?: Parameters<typeof createProvisionalStyleLock>[1],
  prepareStyleSample = true,
): Promise<{
  root: string;
  aiDependency: AiImageSkillDependency;
  editableRoot: string;
  authorizationTrustRoot: string;
}> {
  const parent = await directory(t, prefix);
  const root = join(parent, "project");
  await initializeProject({ root, title: "Generation Demo" });
  const authorizationTrustRoot = join(parent, "authorization-trust");
  await configureGenerationAuthorizationTrustForTests(root, {
    root: authorizationTrustRoot,
    deterministicKeySeed: `superppt-generation-test:${prefix}`,
  });
  const outline = {
    schemaVersion: 1,
    slides: SLIDE_IDS.map((id, order) => ({
      id,
      order,
      title: `Slide ${order + 1}`,
      role: order === 0 ? "cover" : order === 1 ? "process" : "summary",
      purpose: `Purpose ${order + 1}`,
      sourceRefs: [`L${order + 1}`],
    })),
  };
  await writeFile(join(root, "brief.json"), `${JSON.stringify({
    schemaVersion: 1,
    title: "Generation Demo",
    purpose: "Test generation",
    audience: "Testers",
    language: "en",
    targetSlides: 3,
    mustCover: ["Slide 1", "Slide 2", "Slide 3"],
    constraints: ["16:9"],
  })}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline)}\n`);
  for (const slide of outline.slides) {
    const slideRoot = join(root, "slides", slide.id);
    await mkdir(slideRoot);
    await writeFile(join(slideRoot, "spec.json"), `${JSON.stringify({
      schemaVersion: 1,
      slideId: slide.id,
      title: slide.title,
      role: slide.role,
      coreMessage: `Core ${slide.order + 1}`,
      requiredText: ["Title"],
      visualSubject: "One central subject",
      composition: "Layered foreground midground background",
      relationships: ["A leads to B"],
      forbidden: ["watermark"],
      sourceRefs: slide.sourceRefs,
    })}\n`);
  }
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
    schemaVersion: 1,
    styleId: "cinematic-tech",
    representativeSlideId: SLIDE_IDS[1],
  })}\n`);
  await writeCanonicalStyleSample(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  const aiRoot = join(parent, "ai-image-to-ppt");
  await mkdir(join(aiRoot, "scripts"), { recursive: true });
  await writeFile(join(aiRoot, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  for (const script of ["generation_result.py", "host_routing_policy.py", "import_host_image.py", "prepare_editable_input.py"]) {
    await writeFile(join(aiRoot, "scripts", script), "raise SystemExit('not executed by job preparation')\n");
  }
  const editableRoot = join(parent, "image-to-editable-pptx");
  await mkdir(join(editableRoot, "skills", "image-to-editable-pptx"), { recursive: true });
  await writeFile(join(editableRoot, "package.json"), JSON.stringify({ name: "image-to-editable-pptx", version: "0.1.0" }));
  await writeFile(join(editableRoot, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  await writeFile(join(editableRoot, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  const aiDependency = (await resolveSkillDependencies({
    aiSkillRoot: aiRoot,
    editableSkillRoot: editableRoot,
  })).ai;
  if (styleLock) {
    await createProvisionalStyleLock(root, styleLock);
    await finalizeDelegatedStyleSampleForTest(root);
    await approveStyleLock(root);
  } else if (prepareStyleSample) {
    await finalizeDelegatedStyleSampleForTest(root);
    await approveStyleLock(root);
  }
  return {
    root,
    editableRoot,
    authorizationTrustRoot,
    aiDependency,
  };
}

const lockedStyle = {
  selection: { kind: "catalog" as const, styleId: "cinematic-tech" },
  referenceArtifacts: [],
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function trustedAuthorizationRecordPath(
  fixture: { authorizationTrustRoot: string },
  job: Awaited<ReturnType<typeof prepareImageGenerationJob>>,
): string {
  return join(fixture.authorizationTrustRoot, "records", `${job.authorizationTrust!.recordId}.json`);
}

async function rewriteProjectAuthorizationEvidence(
  root: string,
  job: Awaited<ReturnType<typeof prepareImageGenerationJob>>,
  forgedPlan: Awaited<ReturnType<typeof prepareImageGenerationJob>>["authorizationPlan"],
) {
  const planBytes = Buffer.from(canonicalContractFile(forgedPlan));
  const forgedDigest = sha256(planBytes);
  const manifestPath = join(root, "superppt.json");
  const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const gate = manifest.gates.find(({ approvalId }) => approvalId === job.authorizationGate.approvalId)!;
  gate.artifactHashes["generation/authorization-plan.json"] = forgedDigest;
  gate.presentation = { ...gate.presentation!, descriptorSha256: forgedDigest };
  gate.snapshotManifestSha256 = snapshotManifestEvidenceHash(manifest, gate.approvalId!);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const snapshotRoot = join(root, ...gate.snapshotPath!.split("/"));
  await writeFile(join(snapshotRoot, "superppt.json"), manifestBytes, { mode: 0o600 });
  await writeFile(
    join(snapshotRoot, "artifacts", "generation", "authorization-plan.json"),
    planBytes,
    { mode: 0o600 },
  );
  const previousDescriptor = JSON.parse(await readFile(join(snapshotRoot, "snapshot.json"), "utf8"));
  const { descriptorSha256: _oldIntegrity, ...descriptorBase } = previousDescriptor;
  const descriptor = addDescriptorIntegrity({
    ...descriptorBase,
    manifestSha256: sha256Evidence(manifestBytes),
    artifactHashes: { "generation/authorization-plan.json": forgedDigest },
    artifactSizes: { "generation/authorization-plan.json": planBytes.length },
    presentation: { ...descriptorBase.presentation, descriptorSha256: forgedDigest },
  });
  await writeFile(join(snapshotRoot, "snapshot.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const forged = ImageGenerationJobSchema.parse({
    ...job,
    authorizationDigest: forgedDigest,
    authorizationPlan: forgedPlan,
    authorizationGate: {
      ...job.authorizationGate,
      snapshotManifestSha256: gate.snapshotManifestSha256,
      authorizationPlanSha256: forgedDigest,
    },
    callBudget: forgedPlan.callBudget,
  });
  await writeFile(
    join(root, "generation", "jobs", job.jobId, "job.json"),
    canonicalContractFile(forged),
    { mode: 0o600 },
  );
  return forged;
}

async function normalizedImageSha256(masterPath: string): Promise<string> {
  const bytes = await sharp(await readFile(masterPath), { failOn: "error" })
    .resize(1920, 1080, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  return sha256(bytes);
}

function passingPresentationQa(
  job: Awaited<ReturnType<typeof prepareImageGenerationJob>>,
  page: Awaited<ReturnType<typeof prepareImageGenerationJob>>["pages"][number],
  normalizedSha256: string,
) {
  return {
    approvedSampleSha256: job.styleLock.approvedSample!.sha256,
    normalizedImageSha256: normalizedSha256,
    slideSpecSha256: page.specSnapshot.sha256,
    pageRole: page.spec.role,
    decision: {
      ok: true,
      issues: [],
      requiredText: page.spec.requiredText.map((text) => ({ text, present: true, exact: true })),
      styleConsistent: true,
      hierarchyClear: true,
      richDetail: true,
      noForbiddenContent: true,
    },
  };
}

async function admittedApiSuccessIntake(
  root: string,
  job: Awaited<ReturnType<typeof prepareImageGenerationJob>>,
  page: Awaited<ReturnType<typeof prepareImageGenerationJob>>["pages"][number],
  requestOrdinal: number,
  batchReport: SerialStickyReport,
  background: string,
) {
  const masterPath = join(root, ...page.target.split("/"));
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background } }).png().toFile(masterPath);
  const admission = await admitDelegatedGenerationCall(root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal,
  });
  return {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal,
    admissionToken: admission.admissionToken,
    dependency: {
      status: "success" as const,
      provider: "openai" as const,
      channel: "api" as const,
      output_path: masterPath,
      safe_message: "",
    },
    batchReport,
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: job.styleLock.referenceArtifacts.map(({ path, sha256 }) => ({ path, sha256, usage: "used" as const })),
    presentationQa: passingPresentationQa(job, page, await normalizedImageSha256(masterPath)),
  };
}

async function authorizedDeckProject(t: TestContext, prefix: string) {
  const fixture = await approvedProject(t, prefix, lockedStyle);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    callBudget: 3,
  });
  await approveGate(fixture.root, "generation-authorization");
  return fixture;
}

async function fakeCandidateOutputs(
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

test("older delegated replay stays read-only and rollback restores the exact authenticated target history", async (t) => {
  const fixture = await approvedProject(t, "superppt-monotonic-attachment-", lockedStyle);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    callBudget: 4,
  });
  await approveGate(fixture.root, "generation-authorization");
  const deck = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const reports: SerialStickyReport[] = deck.pages.map((_page, index) => ({
    batch_mode: "serial-sticky-monotonic",
    stopped: false,
    search_candidate: "api-openai",
    sticky_candidate: "api-openai",
    pages: deck.pages.slice(0, index + 1).map((_candidate, pageIndex) => ({
      page: pageIndex + 1,
      outcome: "success" as const,
      candidate: "api-openai" as const,
      summary: "",
    })),
    switches: [],
  }));
  const oldIntakes: Awaited<ReturnType<typeof admittedApiSuccessIntake>>[] = [];
  for (const [index, page] of deck.pages.entries()) {
    const intake = await admittedApiSuccessIntake(
      fixture.root,
      deck,
      page,
      index + 1,
      reports[index]!,
      ["#102030", "#203040", "#304050"][index]!,
    );
    oldIntakes.push(intake);
    await recordDelegatedResult(fixture.root, intake);
  }
  const oldReplay = { ...oldIntakes[0]!, batchReport: reports.at(-1)! };
  const manifestPath = join(fixture.root, "superppt.json");
  const beforeHistoricalReplay = await lstat(manifestPath, { bigint: true });
  await recordDelegatedResult(fixture.root, oldReplay);
  const afterHistoricalReplay = await lstat(manifestPath, { bigint: true });
  assert.equal(afterHistoricalReplay.ino, beforeHistoricalReplay.ino, "historical replay is read-only before a newer attachment");

  const original = deck.pages[0]!;
  const correctedPrompt = `${original.finalPrompt}\n\nCorrection: strengthen the focal hierarchy.`;
  const regeneration = await prepareImageGenerationJob(fixture.root, {
    kind: "page-regeneration",
    aiDependency: fixture.aiDependency,
    slideId: original.slideId,
    previousPromptSha256: original.promptSha256,
    finalPrompt: correctedPrompt,
  });
  const regenerationReport: SerialStickyReport = {
    batch_mode: "serial-sticky-monotonic",
    stopped: false,
    search_candidate: "api-openai",
    sticky_candidate: "api-openai",
    pages: [{ page: 1, outcome: "success", candidate: "api-openai", summary: "" }],
    switches: [],
  };
  const newer = await recordDelegatedResult(fixture.root, await admittedApiSuccessIntake(
    fixture.root,
    regeneration,
    regeneration.pages[0]!,
    4,
    regenerationReport,
    "#abcdef",
  ));
  const newerArtifact = newer.pages[0]!.artifacts!.normalized;
  const beforeOlderReplay = await lstat(manifestPath, { bigint: true });
  const historical = await recordDelegatedResult(fixture.root, oldReplay);
  const afterOlderReplay = await lstat(manifestPath, { bigint: true });
  assert.equal(historical.jobId, deck.jobId, "exact replay still returns its immutable historical aggregate");
  assert.equal(afterOlderReplay.ino, beforeOlderReplay.ino, "older replay must not rewrite the manifest");
  const manifest = await readProject(fixture.root);
  assert.deepEqual(manifest.slides.find(({ id }) => id === original.slideId)!.image, newerArtifact);

  const candidate = await assembleProjectCandidate(fixture.root, { buildOutputs: fakeCandidateOutputs });
  const marker = JSON.parse(await readFile(join(candidate.destination, ".superppt-candidate.json"), "utf8")) as {
    slides: Array<{ id: string; order: number; mode: string; path: string; sha256: string }>;
  };
  assert.deepEqual(marker.slides.find(({ id }) => id === original.slideId), {
    id: original.slideId,
    order: original.order,
    mode: "image",
    path: newerArtifact.path,
    sha256: newerArtifact.sha256,
  });

  const targetPrompt = `${regeneration.pages[0]!.finalPrompt}\n\nCorrection: add an authenticated rollback focal point.`;
  await publishPageRegenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    slideId: original.slideId,
    previousPromptSha256: regeneration.pages[0]!.promptSha256,
    finalPrompt: targetPrompt,
    callBudget: 1,
  });
  await approveGate(fixture.root, "generation-authorization");
  const targetRegeneration = await prepareImageGenerationJob(fixture.root, {
    kind: "page-regeneration",
    aiDependency: fixture.aiDependency,
    slideId: original.slideId,
    previousPromptSha256: regeneration.pages[0]!.promptSha256,
    finalPrompt: targetPrompt,
  });
  const targetResult = await recordDelegatedResult(fixture.root, await admittedApiSuccessIntake(
    fixture.root,
    targetRegeneration,
    targetRegeneration.pages[0]!,
    1,
    regenerationReport,
    "#c0ffee",
  ));
  const targetArtifact = targetResult.pages[0]!.artifacts!.normalized;
  const targetProjectManifest = await readProject(fixture.root);
  const targetRevisionId = targetProjectManifest.currentRevision.id;
  const targetSlide = targetProjectManifest.slides.find(({ id }) => id === original.slideId)!;
  assert.equal(targetSlide.generationHistory?.length, 2);
  assert.deepEqual(targetSlide.image, targetArtifact);
  const impact = await publishImpactPlan(fixture.root, { kind: "outline-order" });
  await approveImpact(fixture.root, impact.sha256);
  await applyRevision(fixture.root, impact, impact.change);
  await publishPlanViews(fixture.root);
  await approveGate(fixture.root, "outline");
  await approveGate(fixture.root, "slide-specs");
  await unlink(join(fixture.root, "style", "lock.json"));
  await unlink(join(fixture.root, "style", "recipe.json"));
  await createProvisionalStyleLock(fixture.root, lockedStyle);
  await finalizeDelegatedStyleSampleForTest(fixture.root);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    callBudget: 3,
  });
  await approveGate(fixture.root, "generation-authorization");
  const latest = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const latestResult = await recordDelegatedResult(fixture.root, await admittedApiSuccessIntake(
    fixture.root,
    latest,
    latest.pages[0]!,
    1,
    regenerationReport,
    "#fedcba",
  ));
  const latestArtifact = latestResult.pages[0]!.artifacts!.normalized;
  const beforeRollback = await readProject(fixture.root);
  const latestSlide = beforeRollback.slides.find(({ id }) => id === original.slideId)!;
  assert.equal(latestSlide.generationHistory?.length, 3);
  assert.deepEqual(latestSlide.image, latestArtifact);

  await assert.rejects(rollbackToRevision(fixture.root, targetRevisionId, {
    operations: {
      rollbackCheckpoint: (step) => {
        if (step === "manifest-published") throw new Error("crash after history restore");
      },
    },
  }), /crash after history restore/);
  const crashJournalRoot = join(fixture.root, "revisions", "rollback-transaction");
  const crashJournalPath = join(crashJournalRoot, "journal.json");
  const crashRollbackManifestPath = join(crashJournalRoot, "rollback-superppt.json");
  const crashTargetSnapshotRoot = join(fixture.root, "revisions", targetRevisionId, "manifest-snapshot");
  const crashTargetManifestPath = join(crashTargetSnapshotRoot, "superppt.json");
  const crashTargetDescriptorPath = join(crashTargetSnapshotRoot, "snapshot.json");
  const [
    publishedManifestBytes,
    crashJournalBytes,
    crashRollbackManifestBytes,
    crashTargetManifestBytes,
    crashTargetDescriptorBytes,
  ] = await Promise.all([
    readFile(manifestPath),
    readFile(crashJournalPath),
    readFile(crashRollbackManifestPath),
    readFile(crashTargetManifestPath),
    readFile(crashTargetDescriptorPath),
  ]);
  const forgedCrashTarget = JSON.parse(crashTargetManifestBytes.toString("utf8"));
  const forgedCrashTargetSlide = forgedCrashTarget.slides.find(({ id }: { id: string }) => id === original.slideId);
  forgedCrashTargetSlide.generationHistory = [...forgedCrashTargetSlide.generationHistory].reverse();
  const forgedCrashTargetBytes = Buffer.from(`${JSON.stringify(forgedCrashTarget, null, 2)}\n`);
  const forgedCrashTargetDescriptor = JSON.parse(crashTargetDescriptorBytes.toString("utf8"));
  forgedCrashTargetDescriptor.manifestSha256 = sha256(forgedCrashTargetBytes);
  forgedCrashTargetDescriptor.manifestSize = forgedCrashTargetBytes.length;
  const { descriptorSha256: _crashTargetDescriptor, ...forgedCrashTargetDescriptorBase } = forgedCrashTargetDescriptor;
  forgedCrashTargetDescriptor.descriptorSha256 = sha256(JSON.stringify(forgedCrashTargetDescriptorBase));
  const forgedCrashRollback = JSON.parse(crashRollbackManifestBytes.toString("utf8"));
  forgedCrashRollback.slides = forgedCrashTarget.slides;
  const forgedTargetIndex = forgedCrashRollback.revisions
    .findIndex(({ id }: { id: string }) => id === targetRevisionId);
  forgedCrashRollback.revisions[forgedTargetIndex + 1].parentSnapshotDescriptorSha256
    = forgedCrashTargetDescriptor.descriptorSha256;
  const forgedCrashJournal = JSON.parse(crashJournalBytes.toString("utf8"));
  const normalizedForgedRollback = structuredClone(forgedCrashRollback);
  delete normalizedForgedRollback.currentRevision.rollbackTransactionDescriptorSha256;
  delete normalizedForgedRollback.revisions.at(-1).rollbackTransactionDescriptorSha256;
  forgedCrashJournal.rollbackPlanSha256 = sha256(`${JSON.stringify(normalizedForgedRollback, null, 2)}\n`);
  const {
    descriptorSha256: _crashJournalDescriptor,
    transactionAnchorSha256: _crashTransactionAnchor,
    rollbackManifestSha256: _crashRollbackManifest,
    rollbackManifestSize: _crashRollbackSize,
    ...forgedCrashAnchorBase
  } = forgedCrashJournal;
  forgedCrashJournal.transactionAnchorSha256 = sha256(JSON.stringify(forgedCrashAnchorBase));
  forgedCrashRollback.currentRevision.rollbackTransactionDescriptorSha256
    = forgedCrashJournal.transactionAnchorSha256;
  forgedCrashRollback.revisions.at(-1).rollbackTransactionDescriptorSha256
    = forgedCrashJournal.transactionAnchorSha256;
  const forgedCrashRollbackBytes = Buffer.from(`${JSON.stringify(forgedCrashRollback, null, 2)}\n`);
  forgedCrashJournal.rollbackManifestSha256 = sha256(forgedCrashRollbackBytes);
  forgedCrashJournal.rollbackManifestSize = forgedCrashRollbackBytes.length;
  const { descriptorSha256: _forgedCrashJournalDescriptor, ...forgedCrashJournalBase } = forgedCrashJournal;
  forgedCrashJournal.descriptorSha256 = sha256(JSON.stringify(forgedCrashJournalBase));
  await Promise.all([
    writeFile(crashTargetManifestPath, forgedCrashTargetBytes),
    writeFile(crashTargetDescriptorPath, `${JSON.stringify(forgedCrashTargetDescriptor, null, 2)}\n`),
    writeFile(crashRollbackManifestPath, forgedCrashRollbackBytes),
    writeFile(crashJournalPath, `${JSON.stringify(forgedCrashJournal, null, 2)}\n`),
    writeFile(manifestPath, forgedCrashRollbackBytes),
  ]);
  await assert.rejects(
    recoverRollbackTransaction(fixture.root),
    /authenticated pre-rollback base evidence/,
  );
  await Promise.all([
    writeFile(manifestPath, publishedManifestBytes),
    writeFile(crashJournalPath, crashJournalBytes),
    writeFile(crashRollbackManifestPath, crashRollbackManifestBytes),
    writeFile(crashTargetManifestPath, crashTargetManifestBytes),
    writeFile(crashTargetDescriptorPath, crashTargetDescriptorBytes),
  ]);
  const forgedPlanRollback = JSON.parse(crashRollbackManifestBytes.toString("utf8"));
  forgedPlanRollback.currentRevision.createdAt = "2099-01-01T00:00:00.000Z";
  forgedPlanRollback.revisions.at(-1).createdAt = "2099-01-01T00:00:00.000Z";
  const forgedPlanJournal = JSON.parse(crashJournalBytes.toString("utf8"));
  const normalizedForgedPlan = structuredClone(forgedPlanRollback);
  delete normalizedForgedPlan.currentRevision.rollbackTransactionDescriptorSha256;
  delete normalizedForgedPlan.revisions.at(-1).rollbackTransactionDescriptorSha256;
  forgedPlanJournal.rollbackPlanSha256 = sha256(`${JSON.stringify(normalizedForgedPlan, null, 2)}\n`);
  const {
    descriptorSha256: _forgedPlanDescriptor,
    transactionAnchorSha256: _forgedPlanTransaction,
    rollbackManifestSha256: _forgedPlanManifest,
    rollbackManifestSize: _forgedPlanSize,
    ...forgedPlanAnchorBase
  } = forgedPlanJournal;
  forgedPlanJournal.transactionAnchorSha256 = sha256(JSON.stringify(forgedPlanAnchorBase));
  forgedPlanRollback.currentRevision.rollbackTransactionDescriptorSha256
    = forgedPlanJournal.transactionAnchorSha256;
  forgedPlanRollback.revisions.at(-1).rollbackTransactionDescriptorSha256
    = forgedPlanJournal.transactionAnchorSha256;
  const forgedPlanRollbackBytes = Buffer.from(`${JSON.stringify(forgedPlanRollback, null, 2)}\n`);
  forgedPlanJournal.rollbackManifestSha256 = sha256(forgedPlanRollbackBytes);
  forgedPlanJournal.rollbackManifestSize = forgedPlanRollbackBytes.length;
  const { descriptorSha256: _forgedPlanFinalDescriptor, ...forgedPlanJournalBase } = forgedPlanJournal;
  forgedPlanJournal.descriptorSha256 = sha256(JSON.stringify(forgedPlanJournalBase));
  await Promise.all([
    writeFile(manifestPath, forgedPlanRollbackBytes),
    writeFile(crashRollbackManifestPath, forgedPlanRollbackBytes),
    writeFile(crashJournalPath, `${JSON.stringify(forgedPlanJournal, null, 2)}\n`),
  ]);
  await assert.rejects(
    recoverRollbackTransaction(fixture.root),
    /rollback journal plan does not match immutable pre-rollback base snapshot/,
  );
  await Promise.all([
    writeFile(manifestPath, publishedManifestBytes),
    writeFile(crashJournalPath, crashJournalBytes),
    writeFile(crashRollbackManifestPath, crashRollbackManifestBytes),
  ]);
  await rollbackToRevision(fixture.root, targetRevisionId);

  const rolledBack = await readProject(fixture.root);
  const restored = rolledBack.slides.find(({ id }) => id === original.slideId)!;
  assert.deepEqual(restored.generationHistory, targetSlide.generationHistory);
  assert.deepEqual(restored.image, targetSlide.image);
  assert.deepEqual(restored.finalRender, targetSlide.finalRender);

  await assert.rejects(rollbackToRevision(fixture.root, targetRevisionId, {
    operations: {
      rollbackCheckpoint: (step) => {
        if (step === "marker-published") throw new Error("leave authenticated history journal");
      },
    },
  }), /leave authenticated history journal/);
  const journalRoot = join(fixture.root, "revisions", "rollback-transaction");
  const journalPath = join(journalRoot, "journal.json");
  const rollbackManifestPath = join(journalRoot, "rollback-superppt.json");
  const [journalBytes, rollbackManifestBytes] = await Promise.all([
    readFile(journalPath),
    readFile(rollbackManifestPath),
  ]);
  const originalJournal = JSON.parse(journalBytes.toString("utf8"));
  const baseSnapshotRoot = join(
    fixture.root,
    "revisions",
    originalJournal.baseRevisionId,
    "manifest-snapshot",
  );
  const detachedBaseSnapshotRoot = `${baseSnapshotRoot}.detached`;
  await rename(baseSnapshotRoot, detachedBaseSnapshotRoot);
  await assert.rejects(
    recoverRollbackTransaction(fixture.root),
    /rollback journal pre-rollback base evidence is invalid/,
  );
  await rename(detachedBaseSnapshotRoot, baseSnapshotRoot);

  const rolledBackAnchorJournal = structuredClone(originalJournal);
  const targetSnapshotDescriptor = JSON.parse(await readFile(
    join(fixture.root, "revisions", targetRevisionId, "manifest-snapshot", "snapshot.json"),
    "utf8",
  ));
  assert.notEqual(
    rolledBackAnchorJournal.baseSnapshotDescriptorSha256,
    targetSnapshotDescriptor.descriptorSha256,
  );
  rolledBackAnchorJournal.baseSnapshotDescriptorSha256 = targetSnapshotDescriptor.descriptorSha256;
  const {
    descriptorSha256: _rolledBackDescriptor,
    transactionAnchorSha256: _rolledBackTransaction,
    rollbackManifestSha256: _rolledBackManifestHash,
    rollbackManifestSize: _rolledBackManifestSize,
    ...rolledBackAnchorBase
  } = rolledBackAnchorJournal;
  rolledBackAnchorJournal.transactionAnchorSha256 = sha256(JSON.stringify(rolledBackAnchorBase));
  const rolledBackAnchorManifest = JSON.parse(rollbackManifestBytes.toString("utf8"));
  rolledBackAnchorManifest.currentRevision.rollbackTransactionDescriptorSha256
    = rolledBackAnchorJournal.transactionAnchorSha256;
  rolledBackAnchorManifest.revisions.at(-1).rollbackTransactionDescriptorSha256
    = rolledBackAnchorJournal.transactionAnchorSha256;
  const rolledBackAnchorManifestBytes = Buffer.from(`${JSON.stringify(rolledBackAnchorManifest, null, 2)}\n`);
  rolledBackAnchorJournal.rollbackManifestSha256 = sha256(rolledBackAnchorManifestBytes);
  rolledBackAnchorJournal.rollbackManifestSize = rolledBackAnchorManifestBytes.length;
  const { descriptorSha256: _rolledBackFinalDescriptor, ...rolledBackAnchorJournalBase } = rolledBackAnchorJournal;
  rolledBackAnchorJournal.descriptorSha256 = sha256(JSON.stringify(rolledBackAnchorJournalBase));
  await writeFile(rollbackManifestPath, rolledBackAnchorManifestBytes);
  await writeFile(journalPath, `${JSON.stringify(rolledBackAnchorJournal, null, 2)}\n`);
  await assert.rejects(
    recoverRollbackTransaction(fixture.root),
    /rollback journal pre-rollback base evidence is invalid/,
  );
  await writeFile(rollbackManifestPath, rollbackManifestBytes);
  await writeFile(journalPath, journalBytes);

  const originalRollbackManifest = JSON.parse(rollbackManifestBytes.toString("utf8"));
  const originalHistory = originalRollbackManifest.slides
    .find(({ id }: { id: string }) => id === original.slideId).generationHistory;
  assert.equal(originalHistory.length, 2);
  const historyForgeries = [
    { name: "missing", history: undefined },
    { name: "truncated", history: originalHistory.slice(0, 1) },
    { name: "reordered", history: [...originalHistory].reverse() },
    { name: "extended", history: [...originalHistory, originalHistory[0]] },
    { name: "forged", history: [{ ...originalHistory[0], jobId: randomUUID() }, originalHistory[1]] },
  ] as const;
  for (const forgery of historyForgeries) {
    const forgedRollbackManifest = structuredClone(originalRollbackManifest);
    const forgedSlide = forgedRollbackManifest.slides.find(({ id }: { id: string }) => id === original.slideId);
    if (forgery.history === undefined) delete forgedSlide.generationHistory;
    else forgedSlide.generationHistory = forgery.history;
    const forgedRollbackBytes = Buffer.from(`${JSON.stringify(forgedRollbackManifest, null, 2)}\n`);
    const forgedJournal = JSON.parse(journalBytes.toString("utf8"));
    forgedJournal.rollbackManifestSha256 = sha256(forgedRollbackBytes);
    forgedJournal.rollbackManifestSize = forgedRollbackBytes.length;
    const { descriptorSha256: _descriptor, ...forgedJournalBase } = forgedJournal;
    forgedJournal.descriptorSha256 = sha256(JSON.stringify(forgedJournalBase));
    await writeFile(rollbackManifestPath, forgedRollbackBytes);
    await writeFile(journalPath, `${JSON.stringify(forgedJournal, null, 2)}\n`);
    await assert.rejects(
      recoverRollbackTransaction(fixture.root),
      /rollback journal planned manifest identity|authenticated pre-rollback base evidence/,
      forgery.name,
    );
  }

  await writeFile(rollbackManifestPath, rollbackManifestBytes);
  await writeFile(journalPath, journalBytes);
  await recoverRollbackTransaction(fixture.root);
  const targetSnapshotRoot = join(fixture.root, "revisions", targetRevisionId, "manifest-snapshot");
  const targetManifestPath = join(targetSnapshotRoot, "superppt.json");
  const targetDescriptorPath = join(targetSnapshotRoot, "snapshot.json");
  const targetManifest = JSON.parse(await readFile(targetManifestPath, "utf8"));
  targetManifest.slides.find(({ id }: { id: string }) => id === original.slideId).generationHistory = [];
  const forgedTargetBytes = Buffer.from(`${JSON.stringify(targetManifest, null, 2)}\n`);
  const targetDescriptor = JSON.parse(await readFile(targetDescriptorPath, "utf8"));
  targetDescriptor.manifestSha256 = sha256(forgedTargetBytes);
  targetDescriptor.manifestSize = forgedTargetBytes.length;
  const { descriptorSha256: _targetDescriptor, ...targetDescriptorBase } = targetDescriptor;
  targetDescriptor.descriptorSha256 = sha256(JSON.stringify(targetDescriptorBase));
  await writeFile(targetManifestPath, forgedTargetBytes);
  await writeFile(targetDescriptorPath, `${JSON.stringify(targetDescriptor, null, 2)}\n`);
  await assert.rejects(
    rollbackToRevision(fixture.root, targetRevisionId),
    /rollback target snapshot descriptor anchor mismatch/,
  );
});

test("serial delegated deck preparation requires every current approval gate", async (t) => {
  for (const gate of ["outline", "slide-specs", "style-sample", "generation-authorization"] as const) {
    await t.test(gate, async (t) => {
      const fixture = await authorizedDeckProject(t, `superppt-serial-gate-${gate}-`);
      const manifestPath = join(fixture.root, "superppt.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.gates = manifest.gates.filter((candidate: { gate: string }) => candidate.gate !== gate);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(prepareDeckJob(fixture.root, fixture.aiDependency), new RegExp(`${gate}.*current|current.*${gate}`, "i"));
    });
  }
});

test("serial delegated deck copies the approved lock and exact ordered prompts into one immutable job", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-serial-delegated-deck-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const lock = await readApprovedStyleLock(fixture.root);
  const plan = await loadValidatedPlan(fixture.root);

  assert.equal(job.kind, "deck");
  assert.equal(job.styleLockSha256, lock.styleLockSha256);
  assert.equal(job.authorizationPlan.kind, "deck");
  assert.equal(sha256(`${JSON.stringify(job.authorizationPlan, null, 2)}\n`), job.authorizationDigest);
  assert.equal("concurrency" in job, false);
  assert.deepEqual(job.pages.map(({ slideId, order, finalPrompt, promptSha256 }) => ({
    slideId,
    order,
    finalPrompt,
    promptSha256,
  })), plan.specs.map((spec, order) => {
    const prompt = compileSlidePrompt({ spec, styleLock: lock });
    return { slideId: spec.slideId, order, finalPrompt: prompt.text, promptSha256: prompt.sha256 };
  }));
});

test("resume delegated generation keeps authenticated accepted pages without another request", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-resume-delegated-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const page = job.pages[0]!;
  const report = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "api-openai" as const,
    sticky_candidate: "api-openai" as const,
    pages: [{ page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" }],
    switches: [],
  };
  await recordDelegatedResult(fixture.root, await admittedApiSuccessIntake(fixture.root, job, page, 1, report, "#142536"));

  const resumed = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const progress = await describeProjectGeneration(fixture.root);
  assert.equal(resumed.jobId, job.jobId);
  assert.equal(progress.calls.consumed, 1);
  assert.equal(progress.pages[0]!.status, "accepted");
  assert.equal(progress.pages[0]!.artifacts.normalized?.sha256, (await readProject(fixture.root)).slides[0]!.image?.sha256);
});

test("delegated progress reports a pending job without an aggregate result as actionable", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-progress-pending-no-aggregate-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);

  const progress = await describeProjectGeneration(fixture.root);
  assert.deepEqual(progress.pages.map(({ status }) => status), ["pending", "pending", "pending"]);
  assert.deepEqual(progress.currentJob, { jobId: job.jobId, kind: "deck" });
});

test("delegated progress reports an admitted call without an aggregate result as in-flight", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-progress-in-flight-no-aggregate-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const page = job.pages[0]!;
  await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  });

  const progress = await describeProjectGeneration(fixture.root);
  assert.equal(progress.pages[0]!.status, "in-flight");
  assert.deepEqual(progress.currentJob, { jobId: job.jobId, kind: "deck" });
});

test("delegated progress reports terminal success awaiting aggregate publication as not-reviewed", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-progress-success-no-aggregate-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const page = job.pages[0]!;
  await executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  }, () => "generated outside aggregate intake");

  const progress = await describeProjectGeneration(fixture.root);
  assert.equal(progress.pages[0]!.status, "not-reviewed");
  assert.deepEqual(progress.currentJob, { jobId: job.jobId, kind: "deck" });
});

test("delegated progress reports terminal failure without treating the blocked job as actionable", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-progress-failed-no-aggregate-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const page = job.pages[0]!;
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  }, () => {
    throw new Error("injected generation failure");
  }), /injected generation failure/);

  const progress = await describeProjectGeneration(fixture.root);
  assert.equal(progress.pages[0]!.status, "failed");
  assert.equal(progress.currentJob, null);
});

test("provider switch evidence leaves serial delegated prompt hashes unchanged", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-provider-switch-prompt-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const first = job.pages[0]!;
  const second = job.pages[1]!;
  const firstReport = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "api-openai" as const,
    sticky_candidate: "api-openai" as const,
    pages: [{ page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" }],
    switches: [],
  };
  await recordDelegatedResult(fixture.root, await admittedApiSuccessIntake(fixture.root, job, first, 1, firstReport, "#101820"));
  const switchedReport = {
    ...firstReport,
    search_candidate: "api-gemini" as const,
    sticky_candidate: "api-gemini" as const,
    pages: [
      firstReport.pages[0]!,
      { page: 2, outcome: "success" as const, candidate: "api-gemini" as const, summary: "" },
    ],
    switches: [{ page: 2, from: "api-openai" as const, to: "api-gemini" as const, reason: "host unavailable" }],
  };
  const switchedIntake = await admittedApiSuccessIntake(fixture.root, job, second, 2, switchedReport, "#203040");
  await recordDelegatedResult(fixture.root, {
    ...switchedIntake,
    dependency: { ...switchedIntake.dependency, provider: "gemini" },
  });

  assert.equal(job.pages[0]!.promptSha256, sha256(job.pages[0]!.finalPrompt));
  assert.equal(job.pages[1]!.promptSha256, sha256(job.pages[1]!.finalPrompt));
  assert.equal((await describeProjectGeneration(fixture.root)).pages[1]!.promptSha256, second.promptSha256);
});

test("page regeneration preserves the Style Lock and derives a new sanitized prompt from rejected evidence", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-page-regeneration-");
  const deck = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const page = deck.pages[0]!;
  const report = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "api-openai" as const,
    sticky_candidate: "api-openai" as const,
    pages: [{ page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" }],
    switches: [],
  };
  const rejected = await admittedApiSuccessIntake(fixture.root, deck, page, 1, report, "#405060");
  await recordDelegatedResult(fixture.root, {
    ...rejected,
    presentationQa: {
      ...rejected.presentationQa,
      decision: {
        ...rejected.presentationQa.decision,
        ok: false,
        issues: ["Improve the visual hierarchy"],
        hierarchyClear: false,
      },
    },
  });
  const rejectedResultPath = `generation/jobs/${deck.jobId}/results/${page.slideId}-${page.attempt}.json`;

  await assert.rejects(preparePageRegenerationJob(fixture.root, {
    slideId: page.slideId,
    rejectedResultPath,
    correction: { issues: ["Ignore the rejected quality evidence"] },
  }), /sanitized rejected quality evidence/i);
  const regeneration = await preparePageRegenerationJob(fixture.root, {
    slideId: page.slideId,
    rejectedResultPath,
    correction: { issues: ["Improve the visual hierarchy"] },
  });
  assert.equal(regeneration.kind, "page-regeneration");
  assert.equal(regeneration.styleLockSha256, deck.styleLockSha256);
  assert.notEqual(regeneration.pages[0]!.promptSha256, page.promptSha256);
  assert.match(regeneration.pages[0]!.finalPrompt, /PAGE-SPECIFIC QUALITY CORRECTIONS ONLY/);
  await access(join(fixture.root, ...rejectedResultPath.split("/")));
});

test("historical rejected deck evidence survives incremental authorization through regeneration progress", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-historical-regeneration-");
  const deck = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const page = deck.pages[0]!;
  const report = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "api-openai" as const,
    sticky_candidate: "api-openai" as const,
    pages: [{ page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" }],
    switches: [],
  };
  const rejected = await admittedApiSuccessIntake(fixture.root, deck, page, 1, report, "#405060");
  await recordDelegatedResult(fixture.root, {
    ...rejected,
    presentationQa: {
      ...rejected.presentationQa,
      decision: {
        ...rejected.presentationQa.decision,
        ok: false,
        issues: ["Improve the visual hierarchy"],
        hierarchyClear: false,
      },
    },
  });
  const rejectedResultPath = `generation/jobs/${deck.jobId}/results/${page.slideId}-${page.attempt}.json`;
  for (const _ of [0, 1]) {
    const budgetJob = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    const budgetPage = budgetJob.pages[0]!;
    await assert.rejects(executeAuthorizedGenerationCall(fixture.root, {
      jobId: budgetJob.jobId,
      slideId: budgetPage.slideId,
      attempt: budgetPage.attempt,
      requestOrdinal: 1,
    }, () => {
      throw new Error("injected spent budget call");
    }), /injected spent budget call/);
  }
  const correctedPrompt = compileSlidePrompt({
    spec: page.spec,
    styleLock: deck.styleLock,
    correction: { issues: ["Improve the visual hierarchy"] },
  }).text;
  await publishPageRegenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    slideId: page.slideId,
    previousPromptSha256: page.promptSha256,
    finalPrompt: correctedPrompt,
    callBudget: 1,
  });
  await approveGate(fixture.root, "generation-authorization");
  const regeneration = await preparePageRegenerationJob(fixture.root, {
    slideId: page.slideId,
    rejectedResultPath,
    correction: { issues: ["Improve the visual hierarchy"] },
  });
  await recordDelegatedResult(fixture.root, await admittedApiSuccessIntake(fixture.root, regeneration, regeneration.pages[0]!, 1, report, "#203040"));

  const progress = await describeProjectGeneration(fixture.root);
  assert.equal(progress.pages.find(({ slideId }) => slideId === page.slideId)?.status, "accepted");
  assert.equal(progress.currentJob, null);
});

test("authorized budget rejects a fourth delegated result admission", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-authorized-budget-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const budgetJobs = await Promise.all(job.pages.map(() => prepareImageGenerationJob(fixture.root, {
    kind: "deck",
    aiDependency: fixture.aiDependency,
  })));
  for (const budgetJob of budgetJobs) {
    const page = budgetJob.pages[0]!;
    await executeAuthorizedGenerationCall(fixture.root, {
      jobId: budgetJob.jobId,
      slideId: page.slideId,
      attempt: page.attempt,
      requestOrdinal: 1,
    }, () => undefined);
  }
  await assert.rejects(admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 2,
  }), /budget is exhausted/i);
  assert.deepEqual((await describeProjectGeneration(fixture.root)).calls, { authorized: 3, consumed: 3, remaining: 0 });
});

test("serial delegated deck admission rejects out-of-order and concurrent page calls", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-serial-admission-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  await assert.rejects(admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[1]!.slideId,
    attempt: job.pages[1]!.attempt,
    requestOrdinal: 1,
  }), /serial.*next|out.of.order/i);
  await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 1,
  });
  await assert.rejects(admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[1]!.slideId,
    attempt: job.pages[1]!.attempt,
    requestOrdinal: 1,
  }), /serial.*in.flight|in.flight.*serial/i);
});

test("serial delegated deck requires the exact next ordinal after an accepted page", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-serial-exact-ordinal-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  const first = job.pages[0]!;
  await recordDelegatedResult(fixture.root, await admittedApiSuccessIntake(fixture.root, job, first, 1, {
    batch_mode: "serial-sticky-monotonic",
    stopped: false,
    search_candidate: "api-openai",
    sticky_candidate: "api-openai",
    pages: [{ page: 1, outcome: "success", candidate: "api-openai", summary: "" }],
    switches: [],
  }, "#203040"));

  const second = job.pages[1]!;
  await assert.rejects(admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: second.slideId,
    attempt: second.attempt,
    requestOrdinal: 1,
  }), /ordinal.*non.monotonic|non.monotonic.*ordinal/i);
});

test("execution admission rechecks replacement generation authorization", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-execute-current-authorization-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  await publishGenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    callBudget: 3,
  });
  await approveGate(fixture.root, "generation-authorization");

  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 1,
  }, () => "must not execute"), /current matching authorization/i);
});

test("execution admission enforces the delegated deck's first ordered page", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-execute-serial-order-");
  const job = await prepareDeckJob(fixture.root, fixture.aiDependency);
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[1]!.slideId,
    attempt: job.pages[1]!.attempt,
    requestOrdinal: 2,
  }, () => "must not execute"), /ordinal.*non.monotonic|non.monotonic.*ordinal/i);
});

test("image generation job publishes an immutable approved deck binding", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-image-job-deck-");
  const job = await prepareImageGenerationJob(fixture.root, {
    kind: "deck",
    aiDependency: fixture.aiDependency,
  });

  assert.equal(job.styleLock.approvalState, "approved");
  assert.equal(job.pages.length, 3);
  assert.equal(job.callBudget, 3);
  assert.deepEqual(job.pages.map(({ order }) => order), [0, 1, 2]);
  assert.equal(job.pages[0]!.promptSha256, sha256(job.pages[0]!.finalPrompt));
  assert.equal(job.pages[0]!.target, `generation/jobs/${job.jobId}/ai-image-output/${job.pages[0]!.slideId}.png`);
  assert.equal(job.pages[0]!.specSnapshot.path, `generation/jobs/${job.jobId}/inputs/specs/${job.pages[0]!.slideId}.json`);
  assert.equal(job.sealedInputs.styleLock.sha256, job.styleLockSha256);
  assert.deepEqual(
    ImageGenerationJobSchema.parse(JSON.parse(await readFile(join(
      fixture.root,
      "generation",
      "jobs",
      job.jobId,
      "job.json",
    ), "utf8"))),
    job,
  );
  await assertJobAuthorized(fixture.root, job);

  const sealedSpecPath = join(fixture.root, ...job.pages[0]!.specSnapshot.path.split("/"));
  const sealedSpec = await readFile(sealedSpecPath);
  await writeFile(sealedSpecPath, "{}\n", { mode: 0o600 });
  await assert.rejects(assertJobAuthorized(fixture.root, job), /sealed.*slide spec|slide spec.*sealed/i);
  await writeFile(sealedSpecPath, sealedSpec, { mode: 0o600 });
  await assertJobAuthorized(fixture.root, job);

  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency, callBudget: 2 } as never),
    /budget.*page count|page count.*budget/i,
  );
  assert.throws(
    () => ImageGenerationJobSchema.parse({ ...job, pages: [...job.pages].reverse() }),
    /order/i,
  );

  const promptPath = join(fixture.root, ...job.pages[0]!.promptArtifact.split("/"));
  await writeFile(promptPath, "mutated after immutable job publication\n", { mode: 0o600 });
  await assert.rejects(assertJobAuthorized(fixture.root, job), /prompt.*changed|prompt.*hash/i);
});

test("image job publication failure removes only its owned nested staging inputs", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-staging-cleanup-", undefined, false);
  const referencePath = "style/references/private-round-2.bin";
  const referenceBytes = Buffer.from("private reference bytes that must not remain in abandoned staging\n");
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  await writeFile(join(fixture.root, ...referencePath.split("/")), referenceBytes);
  await createProvisionalStyleLock(fixture.root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [{ path: referencePath, role: "content-reference" }],
  });
  await finalizeDelegatedStyleSampleForTest(fixture.root);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    callBudget: 3,
  });
  await approveGate(fixture.root, "generation-authorization");

  const jobsRoot = join(fixture.root, "generation", "jobs");
  const committedJobs = await readdir(jobsRoot);
  const unrelatedRoot = join(jobsRoot, ".unrelated-staging");
  const unrelatedMarker = join(unrelatedRoot, "keep.txt");
  await mkdir(unrelatedRoot, { recursive: true });
  await writeFile(unrelatedMarker, "unrelated evidence must remain\n");
  let ownedStaging = "";

  await assert.rejects(prepareImageGenerationJob(
    fixture.root,
    { kind: "deck", aiDependency: fixture.aiDependency },
    {
      checkpoint: (step, stagingRoot) => {
        if (step === "sealed-inputs-synced") {
          ownedStaging = stagingRoot;
          throw new Error("injected failure after sealed inputs fsync");
        }
      },
    },
  ), /injected failure after sealed inputs fsync/);

  assert.notEqual(ownedStaging, "", "the failure must occur after nested inputs exist");
  await assert.rejects(access(ownedStaging), /ENOENT/);
  assert.deepEqual((await readdir(jobsRoot)).sort(), [...committedJobs, ".unrelated-staging"].sort());
  assert.equal(await readFile(unrelatedMarker, "utf8"), "unrelated evidence must remain\n");
});

test("generation authorization rejects absent and stale deck approval", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-authorization-", lockedStyle);
  await approveStyleLock(fixture.root);
  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /generation authorization/i,
  );

  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
  await approveGate(fixture.root, "generation-authorization");
  await writeFile(join(fixture.root, "generation", "authorization-plan.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /generation authorization/i,
  );
});

test("image generation job rejects mutated style and dependency identities", async (t) => {
  const styleFixture = await authorizedDeckProject(t, "superppt-image-job-style-identity-");
  const styleJob = await prepareImageGenerationJob(styleFixture.root, {
    kind: "deck",
    aiDependency: styleFixture.aiDependency,
  });
  const lockPath = join(styleFixture.root, "style", "lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
  await writeFile(lockPath, `${JSON.stringify({ ...lock, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  await assert.rejects(assertJobAuthorized(styleFixture.root, styleJob), /style lock/i);

  const dependencyFixture = await authorizedDeckProject(t, "superppt-image-job-dependency-identity-");
  const dependencyJob = await prepareImageGenerationJob(dependencyFixture.root, {
    kind: "deck",
    aiDependency: dependencyFixture.aiDependency,
  });
  await writeFile(dependencyFixture.aiDependency.skillFile, "changed Skill identity\n");
  await assert.rejects(assertJobAuthorized(dependencyFixture.root, dependencyJob), /Skill identity changed/);

  const scriptFixture = await authorizedDeckProject(t, "superppt-image-job-script-identity-");
  const scriptJob = await prepareImageGenerationJob(scriptFixture.root, {
    kind: "deck",
    aiDependency: scriptFixture.aiDependency,
  });
  await writeFile(scriptFixture.aiDependency.scripts.generationResult, "changed required script identity\n");
  await assert.rejects(assertJobAuthorized(scriptFixture.root, scriptJob), /Skill identity changed/);
});

test("image generation job rejects a self-consistent forged authorization snapshot", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-image-job-authorization-forgery-");
  const job = await prepareImageGenerationJob(fixture.root, {
    kind: "deck",
    aiDependency: fixture.aiDependency,
  });
  const forgedPlan = { ...job.authorizationPlan, callBudget: job.callBudget + 1 };
  const forgedDigest = sha256(canonicalContractFile(forgedPlan));
  const forged = ImageGenerationJobSchema.parse({
    ...job,
    authorizationPlan: forgedPlan,
    authorizationDigest: forgedDigest,
    authorizationGate: { ...job.authorizationGate, authorizationPlanSha256: forgedDigest },
    callBudget: forgedPlan.callBudget,
  });
  await writeFile(
    join(fixture.root, "generation", "jobs", job.jobId, "job.json"),
    canonicalContractFile(forged),
    { mode: 0o600 },
  );

  await assert.rejects(assertJobAuthorized(fixture.root, forged), /authorization.*gate|gate.*authorization/i);
});

test("generation authorization trust fails closed for missing, tampered, and symlinked external evidence", async (t) => {
  await t.test("missing signed record", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-record-missing-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    await unlink(trustedAuthorizationRecordPath(fixture, job));
    await assert.rejects(assertJobAuthorized(fixture.root, job), /trusted authorization.*record|record.*trusted authorization/i);
  });

  await t.test("tampered signed record", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-record-tampered-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    const path = trustedAuthorizationRecordPath(fixture, job);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.callBudget += 1;
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(assertJobAuthorized(fixture.root, job), /trusted authorization.*(?:digest|signature)|(?:digest|signature).*trusted authorization/i);
  });

  await t.test("symlinked signed record", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-record-symlink-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    const path = trustedAuthorizationRecordPath(fixture, job);
    const backup = `${path}.backup`;
    await rename(path, backup);
    await symlink(backup, path);
    await assert.rejects(assertJobAuthorized(fixture.root, job), /trusted authorization.*regular file|regular file.*trusted authorization|symbolic link/i);
  });

  await t.test("missing HMAC key", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-key-missing-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    await unlink(join(fixture.authorizationTrustRoot, "hmac.key"));
    await assert.rejects(assertJobAuthorized(fixture.root, job), /trusted authorization.*key|key.*trusted authorization/i);
  });

  await t.test("tampered HMAC key", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-key-tampered-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    await writeFile(join(fixture.authorizationTrustRoot, "hmac.key"), Buffer.alloc(32, 0x5a), { mode: 0o600 });
    await assert.rejects(assertJobAuthorized(fixture.root, job), /trusted authorization.*signature|signature.*trusted authorization/i);
  });
});

test("a valid signed authorization record cannot authenticate a different project", async (t) => {
  const source = await approvedProject(t, "superppt-trust-wrong-project-source-", lockedStyle);
  const target = await approvedProject(t, "superppt-trust-wrong-project-target-", lockedStyle);
  const sharedTrustRoot = await directory(t, "superppt-shared-authorization-trust-");
  await configureGenerationAuthorizationTrustForTests(source.root, {
    root: sharedTrustRoot,
    deterministicKeySeed: "shared-wrong-project-seed",
  });
  await configureGenerationAuthorizationTrustForTests(target.root, {
    root: sharedTrustRoot,
    deterministicKeySeed: "shared-wrong-project-seed",
  });
  await publishGenerationAuthorizationPlan(source.root, { aiDependency: source.aiDependency, callBudget: 3 });
  await approveGate(source.root, "generation-authorization");
  const sourceJob = await prepareImageGenerationJob(source.root, { kind: "deck", aiDependency: source.aiDependency });

  await assert.rejects(assertTrustedGenerationAuthorizationRecord(
    target.root,
    sourceJob.authorizationTrust!,
    sourceJob.authorizationPlan,
    sourceJob.authorizationGate,
  ), /trusted authorization.*project|project.*trusted authorization/i);
});

test("authorization trust store creation is private and safe under concurrent project approvals", async (t) => {
  const first = await approvedProject(t, "superppt-trust-concurrent-first-", lockedStyle);
  const second = await approvedProject(t, "superppt-trust-concurrent-second-", lockedStyle);
  const sharedTrustRoot = await directory(t, "superppt-concurrent-authorization-trust-");
  for (const fixture of [first, second]) {
    await configureGenerationAuthorizationTrustForTests(fixture.root, {
      root: sharedTrustRoot,
      deterministicKeySeed: "concurrent-deterministic-key-seed",
    });
    await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
  }

  await Promise.all([
    approveGate(first.root, "generation-authorization"),
    approveGate(second.root, "generation-authorization"),
  ]);
  const [firstJob, secondJob] = await Promise.all([
    prepareImageGenerationJob(first.root, { kind: "deck", aiDependency: first.aiDependency }),
    prepareImageGenerationJob(second.root, { kind: "deck", aiDependency: second.aiDependency }),
  ]);
  await Promise.all([
    assertJobAuthorized(first.root, firstJob),
    assertJobAuthorized(second.root, secondJob),
  ]);
  if (process.platform !== "win32") {
    assert.equal((await stat(sharedTrustRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(sharedTrustRoot, "records"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(sharedTrustRoot, "hmac.key"))).mode & 0o777, 0o600);
    assert.equal((await stat(trustedAuthorizationRecordPath({ authorizationTrustRoot: sharedTrustRoot }, firstJob))).mode & 0o777, 0o600);
  }
});

test("authorization trust store rejects a symlinked ancestor outside the project", async (t) => {
  const fixture = await approvedProject(t, "superppt-trust-symlink-ancestor-", lockedStyle);
  const parent = await directory(t, "superppt-trust-symlink-parent-");
  const actual = join(parent, "actual");
  const alias = join(parent, "alias");
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias);
  await configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: join(alias, "authorization-trust"),
    deterministicKeySeed: "symlink-ancestor-key-seed",
  });
  await assert.rejects(
    async () => {
      await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
      await approveGate(fixture.root, "generation-authorization");
    },
    /trusted authorization.*symbolic link ancestor|symbolic link ancestor.*trusted authorization/i,
  );
  assert.equal((await readProject(fixture.root)).gates.some(({ gate }) => gate === "generation-authorization"), false);
});

test("external trust reads reject oversized keys, records, and authorization heads before use", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-trust-bounded-reads-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const keyPath = join(fixture.authorizationTrustRoot, "hmac.key");
  const recordPath = trustedAuthorizationRecordPath(fixture, job);
  const projectId = (await readProject(fixture.root)).projectId;
  const headsRoot = join(fixture.authorizationTrustRoot, "authorization-heads", projectId, "heads");
  const headPath = join(headsRoot, (await readdir(headsRoot)).sort().at(-1)!);
  const [key, record, head] = await Promise.all([readFile(keyPath), readFile(recordPath), readFile(headPath)]);

  await writeFile(keyPath, Buffer.alloc(33), { mode: 0o600 });
  await assert.rejects(assertJobAuthorized(fixture.root, job), /trusted authorization.*key.*(?:size|large|length)/i);
  await writeFile(keyPath, key, { mode: 0o600 });

  await writeFile(recordPath, Buffer.alloc(128 * 1024), { mode: 0o600 });
  await assert.rejects(assertJobAuthorized(fixture.root, job), /trusted authorization.*record.*(?:size|large)/i);
  await writeFile(recordPath, record, { mode: 0o600 });

  await writeFile(headPath, Buffer.alloc(128 * 1024), { mode: 0o600 });
  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /trusted authorization.*head.*(?:size|large)/i,
  );
  await writeFile(headPath, head, { mode: 0o600 });
});

test("trust publication crash points leave no partial final and exact retry converges", async (t) => {
  const fixture = await approvedProject(t, "superppt-trust-publication-crash-", lockedStyle);
  const trustRoot = `${fixture.authorizationTrustRoot}-crash`;
  const seed = "superppt-trust-publication-crash-seed";
  const configure = async (crashAt?: string) => configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: trustRoot,
    deterministicKeySeed: seed,
    operations: crashAt ? {
      checkpoint(step: string) {
        if (step === crashAt) throw new Error(`injected ${step}`);
      },
    } : undefined,
  });

  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
  await configure("key-temp-synced");
  await assert.rejects(approveGate(fixture.root, "generation-authorization"), /injected key-temp-synced/);
  await assert.rejects(access(join(trustRoot, "hmac.key")), { code: "ENOENT" });
  assert.equal((await readdir(trustRoot)).some((name) => name.includes(".tmp")), false);

  await configure();
  await approveGate(fixture.root, "generation-authorization");
  const projectId = (await readProject(fixture.root)).projectId;
  const recordsRoot = join(trustRoot, "records");
  const headsRoot = join(trustRoot, "authorization-heads", projectId, "heads");

  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 4 });
  const recordsBefore = (await readdir(recordsRoot)).sort();
  await configure("record-temp-synced");
  await assert.rejects(approveGate(fixture.root, "generation-authorization"), /injected record-temp-synced/);
  assert.deepEqual((await readdir(recordsRoot)).sort(), recordsBefore);

  await configure();
  await approveGate(fixture.root, "generation-authorization");
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 5 });
  const headsBefore = (await readdir(headsRoot)).sort();
  await configure("authorization-head-temp-synced");
  await assert.rejects(approveGate(fixture.root, "generation-authorization"), /injected authorization-head-temp-synced/);
  assert.deepEqual((await readdir(headsRoot)).sort(), headsBefore);
  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /generation authorization.*(?:absent|stale)|trusted authorization.*current/i,
  );

  await configure();
  await approveGate(fixture.root, "generation-authorization");
  const first = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const retry = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  assert.deepEqual(retry.authorizationTrust, first.authorizationTrust);
});

test("project registry publication crash points leave no partial state and retry advances monotonically", async (t) => {
  const fixture = await approvedProject(t, "superppt-registry-publication-crash-", lockedStyle);
  const trustRoot = `${fixture.authorizationTrustRoot}-registry-crash`;
  const seed = "superppt-registry-publication-crash-seed";
  const configure = async (crashAt?: string) => configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: trustRoot,
    deterministicKeySeed: seed,
    operations: crashAt ? {
      checkpoint(step: string) {
        if (step === crashAt) throw new Error(`injected ${step}`);
      },
    } : undefined,
  });
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
  const projectId = (await readProject(fixture.root)).projectId;
  const registrationPath = join(trustRoot, "project-registrations", `${projectId}.json`);

  await configure("registration-temp-synced");
  await assert.rejects(approveGate(fixture.root, "generation-authorization"), /injected registration-temp-synced/);
  await assert.rejects(access(registrationPath), { code: "ENOENT" });

  await configure("registry-state-temp-synced");
  await assert.rejects(approveGate(fixture.root, "generation-authorization"), /injected registry-state-temp-synced/);
  const statesRoot = join(trustRoot, "project-registry", projectId, "states");
  assert.deepEqual((await readdir(statesRoot)).filter((name) => name.endsWith(".json")), []);
  assert.equal((await readdir(statesRoot)).some((name) => name.endsWith(".tmp")), false);

  await configure();
  await approveGate(fixture.root, "generation-authorization");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  await assertJobAuthorized(fixture.root, job);
  assert.equal((await readdir(statesRoot)).filter((name) => name.endsWith(".json")).length, 2);
});

test("external authorization head rejects project rollback, gate reorder, and older signed head replay", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-trust-monotonic-head-");
  const manifestPath = join(fixture.root, "superppt.json");
  const planPath = join(fixture.root, "generation", "authorization-plan.json");
  const manifestABytes = await readFile(manifestPath);
  const planABytes = await readFile(planPath);
  const manifestA = ProjectManifestSchema.parse(JSON.parse(manifestABytes.toString("utf8")));
  const jobA = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const headsRoot = join(fixture.authorizationTrustRoot, "authorization-heads", manifestA.projectId, "heads");
  const headAPath = join(headsRoot, (await readdir(headsRoot)).sort().at(-1)!);
  const headABytes = await readFile(headAPath);

  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 4 });
  await approveGate(fixture.root, "generation-authorization");
  const manifestBBytes = await readFile(manifestPath);
  const planBBytes = await readFile(planPath);
  const manifestB = ProjectManifestSchema.parse(JSON.parse(manifestBBytes.toString("utf8")));
  const jobB = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const headBPath = join(headsRoot, (await readdir(headsRoot)).sort().at(-1)!);
  const headBBytes = await readFile(headBPath);
  await assertJobAuthorized(fixture.root, jobA);

  await writeFile(manifestPath, manifestABytes, { mode: 0o600 });
  await writeFile(planPath, planABytes, { mode: 0o600 });
  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /trusted authorization.*current|current.*trusted authorization/i,
  );
  const requestA = {
    jobId: jobA.jobId,
    slideId: jobA.pages[0]!.slideId,
    attempt: jobA.pages[0]!.attempt,
    requestOrdinal: 1,
  };
  await assert.rejects(admitDelegatedGenerationCall(fixture.root, requestA), /trusted authorization.*current|current.*trusted authorization/i);
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, requestA, () => "must not run"), /trusted authorization.*current|current.*trusted authorization/i);

  const gateA = manifestA.gates.find(({ approvalId }) => approvalId === jobA.authorizationGate.approvalId)!;
  const gateB = manifestB.gates.find(({ approvalId }) => approvalId === jobB.authorizationGate.approvalId)!;
  const reordered = ProjectManifestSchema.parse({
    ...manifestB,
    gates: [...manifestB.gates.filter(({ gate }) => gate !== "generation-authorization"), gateB, gateA],
  });
  await writeFile(manifestPath, `${JSON.stringify(reordered, null, 2)}\n`, { mode: 0o600 });
  await writeFile(planPath, planABytes, { mode: 0o600 });
  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /trusted authorization.*current|current.*trusted authorization/i,
  );

  await writeFile(manifestPath, manifestBBytes, { mode: 0o600 });
  await writeFile(planPath, planBBytes, { mode: 0o600 });
  await writeFile(headBPath, headABytes, { mode: 0o600 });
  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /trusted authorization.*head|trusted authorization.*current/i,
  );
  await writeFile(headBPath, headBBytes, { mode: 0o600 });
  assert.deepEqual(
    (await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency })).authorizationTrust,
    jobB.authorizationTrust,
  );
});

test("external project high-water rejects deleting the newest authorization head and restoring the old project gate", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-trust-high-water-authorization-");
  const manifestPath = join(fixture.root, "superppt.json");
  const planPath = join(fixture.root, "generation", "authorization-plan.json");
  const manifestA = await readFile(manifestPath);
  const planA = await readFile(planPath);
  const projectId = (await readProject(fixture.root)).projectId;
  const headsRoot = join(fixture.authorizationTrustRoot, "authorization-heads", projectId, "heads");

  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 4 });
  await approveGate(fixture.root, "generation-authorization");
  const latestHead = (await readdir(headsRoot)).filter((name) => name.endsWith(".json")).sort().at(-1)!;
  await unlink(join(headsRoot, latestHead));
  await writeFile(manifestPath, manifestA, { mode: 0o600 });
  await writeFile(planPath, planA, { mode: 0o600 });

  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /registry|high-water|authorization.*(?:truncated|rollback)/i,
  );
});

test("external project registry missing or tampered after registration fails closed", async (t) => {
  await t.test("missing registry", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-registry-missing-");
    const projectId = (await readProject(fixture.root)).projectId;
    await rm(join(fixture.authorizationTrustRoot, "project-registry", projectId), { recursive: true, force: true });
    await assert.rejects(readCallLedger(fixture.root), /project registry.*missing|registered project.*registry/i);
  });

  await t.test("tampered registry", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-registry-tampered-");
    const projectId = (await readProject(fixture.root)).projectId;
    const statesRoot = join(fixture.authorizationTrustRoot, "project-registry", projectId, "states");
    await mkdir(statesRoot, { recursive: true, mode: 0o700 });
    const names = (await readdir(statesRoot)).filter((name) => name.endsWith(".json")).sort();
    const statePath = join(statesRoot, names.at(-1) ?? "0000000000000001.json");
    await writeFile(statePath, "{}\n", { mode: 0o600 });
    await assert.rejects(readCallLedger(fixture.root), /project registry.*(?:invalid|signature|tampered)/i);
  });
});

test("coordinated project-root authorization rewrites cannot replace external approval trust", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-trust-coordinated-rewrite-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const forgedPlan = { ...job.authorizationPlan, callBudget: job.callBudget + 1 };
  const forged = await rewriteProjectAuthorizationEvidence(fixture.root, job, forgedPlan);

  await assert.rejects(assertJobAuthorized(fixture.root, forged), /trusted authorization/i);
});

test("an external approval orphan cannot authorize before manifest publication and exact preparation retry is idempotent", async (t) => {
  const fixture = await approvedProject(t, "superppt-trust-orphan-transition-", lockedStyle);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
  await assert.rejects(approveGate(fixture.root, "generation-authorization", {
    operations: {
      checkpoint(step) {
        if (step === "snapshot-published") throw new Error("injected after trusted authorization publication");
      },
    },
  }), /injected after trusted authorization publication/);
  assert.equal((await readProject(fixture.root)).gates.some(({ gate }) => gate === "generation-authorization"), false);
  await assert.rejects(
    prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency }),
    /generation authorization.*absent|generation-authorization.*current/i,
  );

  await approveGate(fixture.root, "generation-authorization");
  const first = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const retry = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  assert.deepEqual(retry.authorizationTrust, first.authorizationTrust);
});

test("image generation job rejects a changed non-null Skill Git revision", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-git-identity-", lockedStyle);
  await execFileAsync("git", ["-C", fixture.aiDependency.root, "init"]);
  await execFileAsync("git", ["-C", fixture.aiDependency.root, "config", "user.email", "tests@superppt.invalid"]);
  await execFileAsync("git", ["-C", fixture.aiDependency.root, "config", "user.name", "SuperPPT Tests"]);
  await execFileAsync("git", ["-C", fixture.aiDependency.root, "add", "."]);
  await execFileAsync("git", ["-C", fixture.aiDependency.root, "commit", "-m", "initial Skill"]);
  const dependency = (await resolveSkillDependencies({
    aiSkillRoot: fixture.aiDependency.root,
    editableSkillRoot: fixture.editableRoot,
  })).ai;
  assert.notEqual(dependency.gitRevision, null);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: dependency, callBudget: 3 });
  await approveGate(fixture.root, "generation-authorization");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: dependency });

  await writeFile(join(dependency.root, "REVISION.txt"), "moves HEAD without changing required files\n");
  await execFileAsync("git", ["-C", dependency.root, "add", "REVISION.txt"]);
  await execFileAsync("git", ["-C", dependency.root, "commit", "-m", "move Skill HEAD"]);
  await assert.rejects(assertJobAuthorized(fixture.root, job), /Skill identity changed|Git revision/i);
});

test("delegated style sample requires execution authorization, finalizes its authenticated artifact, then approves the lock", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-sample-", undefined, false);
  await assert.rejects(publishStyleSample(fixture.root), /completion receipt|delegated style sample/i);
  const referencePath = "style/references/style-direction.txt";
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  await writeFile(join(fixture.root, ...referencePath.split("/")), "required art direction");
  await createProvisionalStyleLock(fixture.root, {
    ...lockedStyle,
    referenceArtifacts: [{ path: referencePath, role: "art-direction" }],
  });
  await writeCanonicalStyleSample(fixture.root);
  await assert.rejects(
    publishStyleSampleGenerationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 2 }),
    /exactly 1/i,
  );
  const plan = await publishStyleSampleGenerationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    callBudget: 1,
  });
  assert.equal(plan.kind, "style-sample");
  assert.equal(plan.pages.length, 1);
  await assert.rejects(
    prepareStyleSampleJob(fixture.root, fixture.aiDependency),
    /authorization/i,
  );

  await approveExecutionGate(fixture.root, "style-sample-generation", "style/sample/generation-plan.json");
  const job = await prepareStyleSampleJob(fixture.root, fixture.aiDependency);
  assert.equal(job.callBudget, 1);
  assert.equal(job.pages.length, 1);
  assert.equal(job.styleLock.approvalState, "provisional");
  const page = job.pages[0]!;
  const masterPath = join(fixture.root, ...page.target.split("/"));
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#102030" } }).png().toFile(masterPath);
  const admission = await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  });
  const result = await recordDelegatedResult(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: admission.admissionToken,
    dependency: { status: "success", provider: "openai", channel: "api", output_path: masterPath, safe_message: "" },
    batchReport: {
      batch_mode: "serial-sticky-monotonic",
      stopped: false,
      search_candidate: "api-openai",
      sticky_candidate: "api-openai",
      pages: [{ page: 1, outcome: "success", candidate: "api-openai", summary: "" }],
      switches: [],
    },
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: job.styleLock.referenceArtifacts.map(({ path, sha256 }) => ({ path, sha256, usage: "used" as const })),
    presentationQa: null,
  });
  assert.equal(result.outcome, "success");
  assert.equal(result.pages[0]!.styleConsistency, "not-reviewed");
  assert.deepEqual((await readProject(fixture.root)).slides, [], "a provisional sample is never attached as a deck page");

  const aggregatePath = join(fixture.root, "generation", "jobs", job.jobId, "result.json");
  const aggregateBytes = await readFile(aggregatePath);
  const aggregate = JSON.parse(aggregateBytes.toString("utf8")) as {
    pages: Array<{ referenceUsage: Array<{ usage: string }> }>;
    batchReport: { search_candidate: string; sticky_candidate: string; pages: Array<{ candidate: string }> };
  };
  aggregate.pages[0]!.referenceUsage[0]!.usage = "unsupported";
  await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
  await assert.rejects(finalizeStyleSample(fixture.root, job.jobId), /reference usage|status conflicts/i);
  await writeFile(aggregatePath, aggregateBytes);
  const routed = JSON.parse(aggregateBytes.toString("utf8")) as typeof aggregate;
  routed.batchReport.search_candidate = "host-openai";
  routed.batchReport.sticky_candidate = "host-openai";
  routed.batchReport.pages[0]!.candidate = "host-openai";
  await writeFile(aggregatePath, `${JSON.stringify(routed, null, 2)}\n`);
  await assert.rejects(finalizeStyleSample(fixture.root, job.jobId), /routing.*provider|provider.*routing/i);
  await writeFile(aggregatePath, aggregateBytes);
  const staleTemp = join(fixture.root, "style", "sample", ".style-sample-finalize-00000000-0000-4000-8000-000000000000-director.json");
  await writeFile(staleTemp, "stale owned finalization temporary");
  const staleSelectionTemp = join(fixture.root, "style", ".style-sample-finalize-00000000-0000-4000-8000-000000000000-selection.json");
  await writeFile(staleSelectionTemp, "stale owned selection temporary");
  const wrongDirectoryStyleTemp = join(fixture.root, "style", ".style-sample-finalize-00000000-0000-4000-8000-000000000000-director.json");
  const wrongDirectorySampleTemp = join(fixture.root, "style", "sample", ".style-sample-finalize-00000000-0000-4000-8000-000000000000-selection.json");
  const impossibleStyleTemp = join(fixture.root, "style", ".style-sample-finalize-deadbeef-selection.json");
  const impossibleSampleTemp = join(fixture.root, "style", "sample", ".style-sample-finalize---director.json");
  await writeFile(wrongDirectoryStyleTemp, "unowned wrong-directory style evidence");
  await writeFile(wrongDirectorySampleTemp, "unowned wrong-directory sample evidence");
  await writeFile(impossibleStyleTemp, "impossible UUID style evidence");
  await writeFile(impossibleSampleTemp, "impossible UUID sample evidence");
  const finalized = await finalizeStyleSample(fixture.root, job.jobId);
  assert.deepEqual(Object.keys(finalized).sort(), ["style/sample/director.json", "style/sample/ledger.json", "style/sample/prompt.txt", "style/sample/slide.png", "style/selection.json"]);
  await assert.rejects(access(staleTemp), { code: "ENOENT" });
  await assert.rejects(access(staleSelectionTemp), { code: "ENOENT" });
  assert.equal(await readFile(wrongDirectoryStyleTemp, "utf8"), "unowned wrong-directory style evidence");
  assert.equal(await readFile(wrongDirectorySampleTemp, "utf8"), "unowned wrong-directory sample evidence");
  assert.equal(await readFile(impossibleStyleTemp, "utf8"), "impossible UUID style evidence");
  assert.equal(await readFile(impossibleSampleTemp, "utf8"), "impossible UUID sample evidence");
  assert.equal(JSON.parse(finalized["style/sample/ledger.json"].toString("utf8")).durationMs, null);
  const receiptPath = join(fixture.root, "style", "sample", "completion.json");
  const receipt = await readFile(receiptPath);
  await finalizeStyleSample(fixture.root, job.jobId);
  assert.deepEqual(await readFile(receiptPath), receipt, "receipt-last finalization is idempotent after a crash retry");
  await publishStyleSample(fixture.root);
  await approveGate(fixture.root, "style-sample");
  const approved = await approveStyleLock(fixture.root);
  assert.equal(approved.approvalState, "approved");
});

test("a newly authorized delegated style sample supersedes a prior receipt", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-sample-regeneration-", undefined, false);
  await finalizeDelegatedStyleSampleForTest(fixture.root);
  const before = JSON.parse(await readFile(join(fixture.root, "style", "sample", "completion.json"), "utf8")) as { jobId: string };
  const plan = await publishStyleSampleGenerationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 1 });
  await approveExecutionGate(fixture.root, "style-sample-generation", "style/sample/generation-plan.json");
  const job = await prepareStyleSampleJob(fixture.root, fixture.aiDependency);
  assert.notEqual(job.jobId, before.jobId);
  const page = job.pages[0]!;
  const masterPath = join(fixture.root, ...page.target.split("/"));
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#d04020" } }).png().toFile(masterPath);
  const admission = await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId, slideId: page.slideId, attempt: page.attempt, requestOrdinal: 1,
  });
  await recordDelegatedResult(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: admission.admissionToken,
    dependency: { status: "success", provider: "openai", channel: "api", output_path: masterPath, safe_message: "" },
    batchReport: {
      batch_mode: "serial-sticky-monotonic", stopped: false, search_candidate: "api-openai", sticky_candidate: "api-openai",
      pages: [{ page: 1, outcome: "success", candidate: "api-openai", summary: "" }], switches: [],
    },
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: [],
    presentationQa: null,
  });
  await finalizeStyleSample(fixture.root, job.jobId);
  await publishStyleSample(fixture.root);
  const after = JSON.parse(await readFile(join(fixture.root, "style", "sample", "completion.json"), "utf8")) as { jobId: string };
  assert.equal(after.jobId, job.jobId);
  assert.notEqual(after.jobId, before.jobId);
  assert.equal(plan.kind, "style-sample");
});

test("delegated style sample cannot finalize or retry after its one authorized call fails", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-sample-failure-", undefined, false);
  await createProvisionalStyleLock(fixture.root, lockedStyle);
  await publishStyleSampleGenerationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 1 });
  await approveExecutionGate(fixture.root, "style-sample-generation", "style/sample/generation-plan.json");
  const job = await prepareStyleSampleJob(fixture.root, fixture.aiDependency);
  const page = job.pages[0]!;
  const admission = await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  });
  await recordDelegatedResult(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: admission.admissionToken,
    dependency: { status: "local_failure", provider: "openai", channel: "api", output_path: null, safe_message: "unavailable" },
    batchReport: {
      batch_mode: "serial-sticky-monotonic",
      stopped: true,
      search_candidate: "host-openai",
      sticky_candidate: null,
      pages: [{ page: 1, outcome: "fatal", candidate: "api-openai", summary: "unavailable" }],
      switches: [],
    },
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: [],
    presentationQa: null,
  });

  await assert.rejects(finalizeStyleSample(fixture.root, job.jobId), /accepted|successful/i);
  await assert.rejects(prepareStyleSampleJob(fixture.root, fixture.aiDependency), /budget.*exhausted|new.*plan/i);
  await assert.rejects(publishStyleSample(fixture.root), /canonical|artifact|sample/i);
});

test("generation execution admits before the callback, counts failures, and replays exact tuples without another call", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-image-job-ledger-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const first = { jobId: job.jobId, slideId: job.pages[0]!.slideId, attempt: 1, requestOrdinal: 1 };
  assert.equal((await readCallLedger(fixture.root)).filter(({ jobId }) => jobId === job.jobId).length, 0, "job preparation consumes no deck-call budget");
  let firstCalls = 0;
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, first, async () => {
    firstCalls += 1;
    throw new Error("provider request failed");
  }), /provider request failed/);
  const replay = await executeAuthorizedGenerationCall(fixture.root, first, async () => {
    firstCalls += 1;
    return "must not run";
  });
  assert.deepEqual(replay, { executed: false, outcome: "failed", consumed: 1, remaining: 2 });
  assert.equal(firstCalls, 1);
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[1]!.slideId,
    attempt: 1,
    requestOrdinal: 2,
  }, async () => "second image"), /terminal call|serial delegated/i);
  assert.equal((await readCallLedger(fixture.root)).filter(({ jobId }) => jobId === job.jobId).length, 2);
  assert.deepEqual(await generationCallBudget(fixture.root, job), { authorized: 3, consumed: 1, remaining: 2 });
});

test("generation call ledger rejects conflicting duplicate tuple entries", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-image-job-ledger-conflict-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  await executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 1,
  }, async () => "image");
  const admission = (await readCallLedger(fixture.root)).find(({ jobId }) => jobId === job.jobId)!;
  await writeFile(
    join(fixture.root, "generation", "call-ledger.jsonl"),
    `${JSON.stringify({ ...admission, recordedAt: new Date().toISOString() })}\n`,
    { flag: "a" },
  );
  await assert.rejects(readCallLedger(fixture.root), /conflicting duplicate admission/i);
});

test("external call ledger rejects project deletion, truncation, relabeling, swapping, duplication, and reorder", async (t) => {
  await t.test("deletion", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-call-trust-delete-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    await admitDelegatedGenerationCall(fixture.root, {
      jobId: job.jobId,
      slideId: job.pages[0]!.slideId,
      attempt: job.pages[0]!.attempt,
      requestOrdinal: 1,
    });
    await unlink(join(fixture.root, "generation", "call-ledger.jsonl"));
    await assert.rejects(generationCallBudget(fixture.root, job), /trusted call ledger|project call ledger.*match/i);
  });

  await t.test("truncation", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-call-trust-truncate-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    const page = job.pages[0]!;
    await executeAuthorizedGenerationCall(fixture.root, {
      jobId: job.jobId,
      slideId: page.slideId,
      attempt: page.attempt,
      requestOrdinal: 1,
    }, () => "success");
    const firstLine = (await readFile(join(fixture.root, "generation", "call-ledger.jsonl"), "utf8")).split("\n")[0]!;
    await writeFile(join(fixture.root, "generation", "call-ledger.jsonl"), `${firstLine}\n`, { mode: 0o600 });
    await assert.rejects(readCallLedger(fixture.root), /trusted call ledger|project call ledger.*match/i);
  });

  await t.test("relabel and job ID swap", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-call-trust-relabel-");
    const [first, second] = await Promise.all([0, 1].map(() => prepareImageGenerationJob(fixture.root, {
      kind: "deck",
      aiDependency: fixture.aiDependency,
    })));
    for (const job of [first!, second!]) {
      await admitDelegatedGenerationCall(fixture.root, {
        jobId: job.jobId,
        slideId: job.pages[0]!.slideId,
        attempt: job.pages[0]!.attempt,
        requestOrdinal: 1,
      });
    }
    const ledgerPath = join(fixture.root, "generation", "call-ledger.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    const relabeled = lines.map((entry, index) => index === 1
      ? { ...entry, outcome: entry.outcome === "success" ? "failed" : "success" }
      : entry);
    await writeFile(ledgerPath, `${relabeled.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
    await assert.rejects(readCallLedger(fixture.root), /trusted call ledger|project call ledger.*match/i);

    const swapped = lines.map((entry) => ({ ...entry }));
    const firstDeckIndex = swapped.length - 2;
    const secondDeckIndex = swapped.length - 1;
    const firstDeckJobId = swapped[firstDeckIndex]!.jobId;
    swapped[firstDeckIndex]!.jobId = swapped[secondDeckIndex]!.jobId;
    swapped[secondDeckIndex]!.jobId = firstDeckJobId;
    await writeFile(ledgerPath, `${swapped.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
    await assert.rejects(readCallLedger(fixture.root), /trusted call ledger|project call ledger.*match/i);

    await writeFile(ledgerPath, `${[...lines, lines[0]].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
    await assert.rejects(readCallLedger(fixture.root), /duplicate admission|trusted call ledger/i);
  });

  await t.test("reorder", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-call-trust-reorder-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    const page = job.pages[0]!;
    await executeAuthorizedGenerationCall(fixture.root, {
      jobId: job.jobId,
      slideId: page.slideId,
      attempt: page.attempt,
      requestOrdinal: 1,
    }, () => "success");
    const ledgerPath = join(fixture.root, "generation", "call-ledger.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).trimEnd().split("\n");
    await writeFile(ledgerPath, `${lines.reverse().join("\n")}\n`, { mode: 0o600 });
    await assert.rejects(readCallLedger(fixture.root), /terminal entry without an admission|trusted call ledger/i);
  });
});

test("external call ledger rejects oversized events, oversized or mismatched heads, and a missing empty head", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-call-trust-external-tamper-");
  const projectId = (await readProject(fixture.root)).projectId;
  await readCallLedger(fixture.root);
  const callRoot = join(fixture.authorizationTrustRoot, "call-ledgers", projectId);
  const headsRoot = join(callRoot, "heads");
  const emptyHeadPath = join(headsRoot, (await readdir(headsRoot)).sort()[0]!);
  const emptyHeadBytes = await readFile(emptyHeadPath);
  await unlink(emptyHeadPath);
  await assert.rejects(readCallLedger(fixture.root), /trusted call ledger.*head.*missing|empty.*head/i);
  await writeFile(emptyHeadPath, emptyHeadBytes, { mode: 0o600 });

  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 1,
  });
  const eventPath = join(callRoot, "events", (await readdir(join(callRoot, "events"))).filter((name) => name.endsWith(".json")).sort().at(-1)!);
  const headPath = join(headsRoot, (await readdir(headsRoot)).filter((name) => name.endsWith(".json")).sort().at(-1)!);
  const [eventBytes, headBytes] = await Promise.all([readFile(eventPath), readFile(headPath)]);
  await writeFile(eventPath, Buffer.alloc(128 * 1024), { mode: 0o600 });
  await assert.rejects(readCallLedger(fixture.root), /trusted call ledger.*event.*(?:size|large)/i);
  await writeFile(eventPath, eventBytes, { mode: 0o600 });
  await writeFile(headPath, Buffer.alloc(128 * 1024), { mode: 0o600 });
  await assert.rejects(readCallLedger(fixture.root), /trusted call ledger.*head.*(?:size|large)/i);
  await writeFile(headPath, headBytes, { mode: 0o600 });
  const head = JSON.parse(headBytes.toString("utf8"));
  await writeFile(headPath, `${JSON.stringify({ ...head, eventSha256: "0".repeat(64) }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(readCallLedger(fixture.root), /trusted call ledger.*head|signature/i);
});

test("external call high-water rejects deleting the complete call subtree and project mirror", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-call-high-water-delete-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const request = {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 1,
  };
  let callbacks = 0;
  await executeAuthorizedGenerationCall(fixture.root, request, () => {
    callbacks += 1;
    return "generated";
  });
  const projectId = (await readProject(fixture.root)).projectId;
  await rm(join(fixture.authorizationTrustRoot, "call-ledgers", projectId), { recursive: true, force: true });
  await unlink(join(fixture.root, "generation", "call-ledger.jsonl"));

  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, request, () => {
    callbacks += 1;
    return "must not run";
  }), /registry|high-water|trusted call ledger.*missing/i);
  assert.equal(callbacks, 1);
});

test("a valid call head exactly ahead of project high-water recovers without invoking the callback", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-call-registry-crash-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const request = {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 1,
  };
  let callbacks = 0;
  await configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: fixture.authorizationTrustRoot,
    deterministicKeySeed: "call-registry-crash-seed",
    operations: {
      checkpoint(step: string) {
        if (step === "registry-before-call-advance") throw new Error("injected registry call advance crash");
      },
    },
  });
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, request, () => {
    callbacks += 1;
    return "must not run";
  }), /injected registry call advance crash/);
  assert.equal(callbacks, 0);

  await configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: fixture.authorizationTrustRoot,
    deterministicKeySeed: "call-registry-crash-seed",
  });
  assert.deepEqual(await executeAuthorizedGenerationCall(fixture.root, request, () => {
    callbacks += 1;
    return "must not run";
  }), { executed: false, outcome: "in-flight", consumed: 1, remaining: 2 });
  assert.equal(callbacks, 0);
});

test("progress recovery and exact replay serialize one missing project ledger line", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-call-recovery-lease-race-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const request = {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 1,
  };
  await configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: fixture.authorizationTrustRoot,
    deterministicKeySeed: "call-recovery-race-seed",
    operations: {
      checkpoint(step: string) {
        if (step === "call-event-published") throw new Error("injected admission orphan");
      },
    },
  });
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, request, () => "must not run"), /injected admission orphan/);

  let releaseRecovery!: () => void;
  let signalRecovery!: () => void;
  const released = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const signaled = new Promise<void>((resolve) => { signalRecovery = resolve; });
  let recoveryEntrants = 0;
  await configureGenerationAuthorizationTrustForTests(fixture.root, {
    root: fixture.authorizationTrustRoot,
    deterministicKeySeed: "call-recovery-race-seed",
    operations: {
      async checkpoint(step: string) {
        if (step !== "call-recovery-before-project-append") return;
        recoveryEntrants += 1;
        signalRecovery();
        await released;
      },
    },
  });
  const progress = describeProjectGeneration(fixture.root);
  await Promise.race([
    signaled,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("recovery checkpoint was not reached")), 2_000)),
  ]);
  let callbacks = 0;
  const replay = executeAuthorizedGenerationCall(fixture.root, request, () => {
    callbacks += 1;
    return "must not run";
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(recoveryEntrants, 1, "the replay must wait behind the progress recovery lease");
  releaseRecovery();
  await Promise.all([progress, replay]);
  assert.equal(callbacks, 0);
  assert.equal((await readCallLedger(fixture.root)).filter((entry) =>
    entry.jobId === job.jobId && entry.entryKind === "admission"
  ).length, 1);
});

test("trusted directory scans are bounded before parsing and reject path replacement", async (t) => {
  await t.test("authorization heads", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-directory-auth-limit-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    const projectId = (await readProject(fixture.root)).projectId;
    const headsRoot = join(fixture.authorizationTrustRoot, "authorization-heads", projectId, "heads");
    for (const name of ["9999999999999997.json", "9999999999999998.json", "9999999999999999.json"]) {
      await writeFile(join(headsRoot, name), "{}\n", { mode: 0o600 });
    }
    await configureGenerationAuthorizationTrustForTests(fixture.root, {
      root: fixture.authorizationTrustRoot,
      deterministicKeySeed: "directory-limit-seed",
      operations: { limits: { authorizationHeads: 3 } },
    } as never);
    await assert.rejects(assertJobAuthorized(fixture.root, job), /authorization head history is too large/i);
  });

  await t.test("call heads and events", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-directory-call-limit-");
    const projectId = (await readProject(fixture.root)).projectId;
    const callRoot = join(fixture.authorizationTrustRoot, "call-ledgers", projectId);
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    await admitDelegatedGenerationCall(fixture.root, {
      jobId: job.jobId,
      slideId: job.pages[0]!.slideId,
      attempt: job.pages[0]!.attempt,
      requestOrdinal: 1,
    });
    await configureGenerationAuthorizationTrustForTests(fixture.root, {
      root: fixture.authorizationTrustRoot,
      deterministicKeySeed: "directory-limit-seed",
      operations: { limits: { callHeads: 3, callEvents: 2 } },
    } as never);
    await assert.rejects(readCallLedger(fixture.root), /call ledger head history is too large/i);

    await configureGenerationAuthorizationTrustForTests(fixture.root, {
      root: fixture.authorizationTrustRoot,
      deterministicKeySeed: "directory-limit-seed",
      operations: { limits: { callHeads: 100, callEvents: 2 } },
    } as never);
    await assert.rejects(readCallLedger(fixture.root), /call ledger event history is too large/i);
    assert.ok((await readdir(join(callRoot, "events"))).length > 2);
  });

  await t.test("authorization head directory replacement", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-trust-directory-replace-");
    const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
    const projectId = (await readProject(fixture.root)).projectId;
    const headsRoot = join(fixture.authorizationTrustRoot, "authorization-heads", projectId, "heads");
    const detached = `${headsRoot}.detached`;
    let replaced = false;
    await configureGenerationAuthorizationTrustForTests(fixture.root, {
      root: fixture.authorizationTrustRoot,
      deterministicKeySeed: "directory-replace-seed",
      operations: {
        async checkpoint(step: string) {
          if (step !== "authorization-head-directory-opened" || replaced) return;
          replaced = true;
          await rename(headsRoot, detached);
          await mkdir(headsRoot, { mode: 0o700 });
        },
      },
    });
    await assert.rejects(assertJobAuthorized(fixture.root, job), /authorization head directory changed/i);
  });
});

test("project call-ledger mirror rejects oversized bytes and too many entries before use", async (t) => {
  await t.test("oversized bytes", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-project-ledger-byte-limit-");
    const ledgerPath = join(fixture.root, "generation", "call-ledger.jsonl");
    const handle = await open(ledgerPath, "r+");
    try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await assert.rejects(readCallLedger(fixture.root), /project call ledger.*size.*large/i);
  });

  await t.test("too many entries", async (t) => {
    const fixture = await authorizedDeckProject(t, "superppt-project-ledger-entry-limit-");
    await configureGenerationAuthorizationTrustForTests(fixture.root, {
      root: fixture.authorizationTrustRoot,
      deterministicKeySeed: "project-ledger-entry-limit-seed",
      operations: { limits: { projectLedgerEntries: 1 } },
    } as never);
    await assert.rejects(readCallLedger(fixture.root), /project call ledger has too many entries/i);
  });
});

test("signed external admission crash gaps conservatively spend once and exact replay never calls twice", async (t) => {
  for (const crashAt of ["call-event-published", "call-project-ledger-appended"] as const) {
    await t.test(crashAt, async (t) => {
      const fixture = await authorizedDeckProject(t, `superppt-call-trust-${crashAt}-`);
      const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
      const request = {
        jobId: job.jobId,
        slideId: job.pages[0]!.slideId,
        attempt: job.pages[0]!.attempt,
        requestOrdinal: 1,
      };
      let actualCalls = 0;
      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: fixture.authorizationTrustRoot,
        deterministicKeySeed: "call-crash-seed",
        operations: {
          checkpoint(step: string) {
            if (step === crashAt) throw new Error(`injected ${step}`);
          },
        },
      });
      await assert.rejects(executeAuthorizedGenerationCall(fixture.root, request, () => {
        actualCalls += 1;
        return "must not run";
      }), new RegExp(`injected ${crashAt}`));
      assert.equal(actualCalls, 0);

      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: fixture.authorizationTrustRoot,
        deterministicKeySeed: "call-crash-seed",
      });
      assert.deepEqual((await readCallLedger(fixture.root))
        .filter(({ jobId }) => jobId === job.jobId)
        .map(({ entryKind, outcome }) => ({ entryKind, outcome })), [
        { entryKind: "admission", outcome: "in-flight" },
      ]);
      assert.deepEqual(await executeAuthorizedGenerationCall(fixture.root, request, () => {
        actualCalls += 1;
        return "must not run";
      }), { executed: false, outcome: "in-flight", consumed: 1, remaining: 2 });
      assert.equal(actualCalls, 0);
    });
  }
});

test("signed external terminal crash gaps converge to one terminal and replay is idempotent", async (t) => {
  for (const crashAt of ["call-event-published", "call-project-ledger-appended"] as const) {
    await t.test(crashAt, async (t) => {
      const fixture = await authorizedDeckProject(t, `superppt-call-terminal-${crashAt}-`);
      const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
      const request = {
        jobId: job.jobId,
        slideId: job.pages[0]!.slideId,
        attempt: job.pages[0]!.attempt,
        requestOrdinal: 1,
      };
      let checkpointCount = 0;
      let actualCalls = 0;
      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: fixture.authorizationTrustRoot,
        deterministicKeySeed: "call-terminal-crash-seed",
        operations: {
          checkpoint(step: string) {
            if (step === crashAt && ++checkpointCount === 2) {
              throw new Error(`injected terminal ${step}`);
            }
          },
        },
      });
      await assert.rejects(executeAuthorizedGenerationCall(fixture.root, request, () => {
        actualCalls += 1;
        return "generated";
      }), new RegExp(`injected terminal ${crashAt}`));
      assert.equal(actualCalls, 1);

      await configureGenerationAuthorizationTrustForTests(fixture.root, {
        root: fixture.authorizationTrustRoot,
        deterministicKeySeed: "call-terminal-crash-seed",
      });
      assert.deepEqual((await readCallLedger(fixture.root))
        .filter(({ jobId }) => jobId === job.jobId)
        .map(({ entryKind, outcome }) => ({ entryKind, outcome })), [
        { entryKind: "admission", outcome: "in-flight" },
        { entryKind: "terminal", outcome: "success" },
      ]);
      assert.deepEqual(await executeAuthorizedGenerationCall(fixture.root, request, () => {
        actualCalls += 1;
        return "must not run";
      }), { executed: false, outcome: "success", consumed: 1, remaining: 2 });
      assert.equal(actualCalls, 1);
    });
  }
});

test("call budget rejects digest laundering through a rewritten historical job", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-call-budget-digest-laundering-");
  const historical = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const historicalPage = historical.pages[0]!;
  await admitDelegatedGenerationCall(fixture.root, {
    jobId: historical.jobId,
    slideId: historicalPage.slideId,
    attempt: historicalPage.attempt,
    requestOrdinal: 1,
  });

  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 4 });
  await approveGate(fixture.root, "generation-authorization");
  const current = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  assert.notEqual(current.authorizationDigest, historical.authorizationDigest);
  const forgedHistorical = ImageGenerationJobSchema.parse({
    ...historical,
    authorizationDigest: current.authorizationDigest,
    authorizationPlan: current.authorizationPlan,
    authorizationGate: current.authorizationGate,
    callBudget: current.callBudget,
  });
  await writeFile(
    join(fixture.root, "generation", "jobs", historical.jobId, "job.json"),
    canonicalContractFile(forgedHistorical),
    { mode: 0o600 },
  );

  await assert.rejects(generationCallBudget(fixture.root, current), /trusted authorization|historical.*job|job.*authorization/i);
});

test("call budget keeps an exact page-regeneration duplicate idempotent after its last call", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-regeneration-duplicate-", lockedStyle);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 4 });
  await approveGate(fixture.root, "generation-authorization");
  const deck = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const budgetJobs = await Promise.all(deck.pages.map(() => prepareImageGenerationJob(fixture.root, {
    kind: "deck",
    aiDependency: fixture.aiDependency,
  })));
  for (const [index, budgetJob] of budgetJobs.entries()) {
    const page = budgetJob.pages[0]!;
    await executeAuthorizedGenerationCall(fixture.root, {
      jobId: budgetJob.jobId,
      slideId: page.slideId,
      attempt: 1,
      requestOrdinal: 1,
    }, async () => `deck-${index}`);
  }
  const regeneration = await prepareImageGenerationJob(fixture.root, {
    kind: "page-regeneration",
    aiDependency: fixture.aiDependency,
    slideId: deck.pages[0]!.slideId,
    previousPromptSha256: deck.pages[0]!.promptSha256,
    finalPrompt: `${deck.pages[0]!.finalPrompt}\n\nCorrection: use a stronger focal point.`,
  });
  const actual = {
    jobId: regeneration.jobId,
    slideId: regeneration.pages[0]!.slideId,
    attempt: regeneration.pages[0]!.attempt,
    requestOrdinal: 4,
  };
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, actual, async () => {
    throw new Error("regeneration failed");
  }), /regeneration failed/);
  let replayCalls = 0;
  assert.deepEqual(await executeAuthorizedGenerationCall(fixture.root, actual, async () => {
    replayCalls += 1;
    return "must not run";
  }), { executed: false, outcome: "failed", consumed: 4, remaining: 0 });
  assert.equal(replayCalls, 0);
});

test("page-regeneration requires a new prompt hash and incremental authorization after exhaustion", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-image-job-regeneration-");
  const deck = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const budgetJobs = await Promise.all(deck.pages.map(() => prepareImageGenerationJob(fixture.root, {
    kind: "deck",
    aiDependency: fixture.aiDependency,
  })));
  for (const [index, budgetJob] of budgetJobs.entries()) {
    const page = budgetJob.pages[0]!;
    const request = {
      jobId: budgetJob.jobId,
      slideId: page.slideId,
      attempt: 1,
      requestOrdinal: 1,
    };
    if (index === 0) {
      await assert.rejects(executeAuthorizedGenerationCall(fixture.root, request, async () => {
        throw new Error("first request failed");
      }), /first request failed/);
    } else {
      await executeAuthorizedGenerationCall(fixture.root, request, async () => `deck-${index}`);
    }
  }
  await assert.rejects(prepareImageGenerationJob(fixture.root, {
    kind: "page-regeneration",
    aiDependency: fixture.aiDependency,
    slideId: deck.pages[0]!.slideId,
    previousPromptSha256: deck.pages[0]!.promptSha256,
    finalPrompt: deck.pages[0]!.finalPrompt,
  }), /new prompt hash/i);
  const correctedPrompt = `${deck.pages[0]!.finalPrompt}\n\nCorrection: strengthen hierarchy.`;
  await assert.rejects(prepareImageGenerationJob(fixture.root, {
    kind: "page-regeneration",
    aiDependency: fixture.aiDependency,
    slideId: deck.pages[0]!.slideId,
    previousPromptSha256: deck.pages[0]!.promptSha256,
    finalPrompt: correctedPrompt,
  }), /incremental generation authorization/i);

  await publishPageRegenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    slideId: deck.pages[0]!.slideId,
    previousPromptSha256: deck.pages[0]!.promptSha256,
    finalPrompt: correctedPrompt,
    callBudget: 1,
  });
  await approveGate(fixture.root, "generation-authorization");
  const regeneration = await prepareImageGenerationJob(fixture.root, {
    kind: "page-regeneration",
    aiDependency: fixture.aiDependency,
    slideId: deck.pages[0]!.slideId,
    previousPromptSha256: deck.pages[0]!.promptSha256,
    finalPrompt: correctedPrompt,
  });
  assert.equal(regeneration.pages.length, 1);
  assert.notEqual(regeneration.pages[0]!.promptSha256, deck.pages[0]!.promptSha256);
  assert.equal(regeneration.callBudget, 1);
  await assertJobAuthorized(fixture.root, regeneration);
});

test("external authorization trust preserves a nonzero page-regeneration order", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-image-job-regeneration-nonzero-order-");
  const deck = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const original = deck.pages[1]!;
  const correctedPrompt = `${original.finalPrompt}\n\nCorrection: emphasize the second slide's comparison.`;

  await publishPageRegenerationAuthorizationPlan(fixture.root, {
    aiDependency: fixture.aiDependency,
    slideId: original.slideId,
    previousPromptSha256: original.promptSha256,
    finalPrompt: correctedPrompt,
    callBudget: 1,
  });
  await approveGate(fixture.root, "generation-authorization");
  const regeneration = await prepareImageGenerationJob(fixture.root, {
    kind: "page-regeneration",
    aiDependency: fixture.aiDependency,
    slideId: original.slideId,
    previousPromptSha256: original.promptSha256,
    finalPrompt: correctedPrompt,
  });

  assert.equal(regeneration.pages[0]!.order, original.order);
  assert.ok(regeneration.pages[0]!.order > 0);
  await assertJobAuthorized(fixture.root, regeneration);
});

test("page-regeneration borrowing deck authorization binds the authorized page order", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-regeneration-order-", lockedStyle);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 4 });
  await approveGate(fixture.root, "generation-authorization");
  const deck = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const regeneration = await prepareImageGenerationJob(fixture.root, {
    kind: "page-regeneration",
    aiDependency: fixture.aiDependency,
    slideId: deck.pages[0]!.slideId,
    previousPromptSha256: deck.pages[0]!.promptSha256,
    finalPrompt: `${deck.pages[0]!.finalPrompt}\n\nCorrection: emphasize the focal point.`,
  });
  const changed = {
    ...regeneration,
    pages: [{ ...regeneration.pages[0]!, order: regeneration.pages[0]!.order + 10 }],
  };
  await writeFile(
    join(fixture.root, "generation", "jobs", regeneration.jobId, "job.json"),
    `${JSON.stringify(changed, null, 2)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(assertJobAuthorized(fixture.root, changed), /page-regeneration.*order|order.*authorization/i);
});

test("two workers cannot both execute the last authorized generation call", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-last-call-race-", lockedStyle);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 4 });
  await approveGate(fixture.root, "generation-authorization");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const initialJobs = await Promise.all([0, 1, 2].map(() => prepareImageGenerationJob(fixture.root, {
    kind: "deck",
    aiDependency: fixture.aiDependency,
  })));
  for (const initialJob of initialJobs) {
    const page = initialJob.pages[0]!;
    await executeAuthorizedGenerationCall(fixture.root, {
      jobId: initialJob.jobId,
      slideId: page.slideId,
      attempt: page.attempt,
      requestOrdinal: 1,
    }, async () => "initial");
  }

  let actualCalls = 0;
  const contenders = [1, 2].map((requestOrdinal) => executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal,
  }, async () => {
    actualCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return `winner-${requestOrdinal}`;
  }));
  const settled = await Promise.allSettled(contenders);
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  assert.match(
    String((settled.find(({ status }) => status === "rejected") as PromiseRejectedResult).reason),
    /call budget.*exhausted|serial delegated deck call ordinal is non-monotonic/i,
  );
  assert.equal(actualCalls, 1);
  assert.deepEqual(await generationCallBudget(fixture.root, job), { authorized: 4, consumed: 4, remaining: 0 });
});

test("an orphaned in-flight admission remains spent and its replay never invokes the callback", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-image-job-in-flight-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const request = {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: job.pages[0]!.attempt,
    requestOrdinal: 1,
  };
  let actualCalls = 0;
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, request, async () => {
    actualCalls += 1;
    return "must not run";
  }, {
    afterAdmission: () => { throw new Error("injected crash after durable admission"); },
  }), /injected crash after durable admission/);
  assert.equal(actualCalls, 0);
  assert.deepEqual((await readCallLedger(fixture.root)).filter(({ jobId }) => jobId === job.jobId).map(({ entryKind, outcome }) => ({ entryKind, outcome })), [
    { entryKind: "admission", outcome: "in-flight" },
  ]);
  assert.deepEqual(await generationCallBudget(fixture.root, job), { authorized: 3, consumed: 1, remaining: 2 });

  assert.deepEqual(await executeAuthorizedGenerationCall(fixture.root, request, async () => {
    actualCalls += 1;
    return "must not run";
  }), { executed: false, outcome: "in-flight", consumed: 1, remaining: 2 });
  assert.equal(actualCalls, 0);
});

test("delegated result schemas cover every dependency status and reject non-contract prose", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "tests", "fixtures", "fake_ai_skill_result.json"), "utf8"));
  const statuses = [
    "success",
    "unavailable",
    "auth_unavailable",
    "retryable_exhausted",
    "policy_refused",
    "invalid_input",
    "invalid_output",
    "local_failure",
  ] as const;
  for (const status of statuses) {
    const result = {
      ...fixture.dependency,
      status,
      output_path: status === "success" ? fixture.dependency.output_path : null,
    };
    assert.equal(DependencyGenerationResultSchema.parse(result).status, status);
  }
  assert.equal(SerialStickyReportSchema.parse(fixture.batchReport).batch_mode, "serial-sticky-monotonic");
  assert.throws(
    () => SerialStickyReportSchema.parse({ ...fixture.batchReport, sticky_candidate: "api-openai" }),
    /sticky.*successful|successful.*sticky/i,
  );
  assert.throws(
    () => SerialStickyReportSchema.parse({
      ...fixture.batchReport,
      switches: [{ page: 1, from: "host-openai", to: "api-openai", reason: "forged switch" }],
    }),
    /switch.*prior|prior.*switch/i,
  );
  assert.throws(
    () => DependencyGenerationResultSchema.parse({ ...fixture.dependency, explanation: "provider said this probably worked" }),
    /unrecognized|invalid/i,
  );
  const exhausted = JSON.parse(await readFile(join(
    process.cwd(),
    "tests",
    "fixtures",
    "fake_ai_skill_exhausted_result.json",
  ), "utf8"));
  assert.deepEqual(DependencyGenerationResultSchema.parse(exhausted.dependency), exhausted.dependency);
  assert.deepEqual(SerialStickyReportSchema.parse(exhausted.batchReport), exhausted.batchReport);
  assert.throws(
    () => DependencyGenerationResultSchema.parse({ ...exhausted.dependency, provider: "unknown" }),
    /provider|invalid/i,
  );
  assert.throws(
    () => DependencyGenerationResultSchema.parse({ ...exhausted.dependency, channel: "browser" }),
    /channel|invalid/i,
  );
});

test("exhausted delegated result binds the live final routing candidate", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-delegated-result-exhausted-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const page = job.pages[0]!;
  const admission = await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  });
  const live = JSON.parse(await readFile(join(
    process.cwd(),
    "tests",
    "fixtures",
    "fake_ai_skill_exhausted_result.json",
  ), "utf8"));
  const intake = {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: admission.admissionToken,
    dependency: live.dependency,
    batchReport: live.batchReport,
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: [],
    presentationQa: null,
  };
  await assert.rejects(
    recordDelegatedResult(fixture.root, {
      ...intake,
      dependency: { ...intake.dependency, provider: "openai", channel: "host" },
    }),
    /routing.*candidate|provider.*routing|routing.*provider/i,
  );
  const recorded = await recordDelegatedResult(fixture.root, intake);
  assert.equal(recorded.outcome, "exhausted");
  assert.equal(recorded.pages[0]!.dependency.safe_message, "");
});

test("delegated result authenticates host raw and master output, exact bindings, and routing report", async (t) => {
  const fixture = await approvedProject(t, "superppt-delegated-result-host-", undefined, false);
  const referencePath = "style/references/art-direction.png";
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  const referenceBytes = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#6a4c93" } }).png().toBuffer();
  await writeFile(join(fixture.root, ...referencePath.split("/")), referenceBytes);
  await createProvisionalStyleLock(fixture.root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [{ path: referencePath, role: "art-direction" }],
  });
  await finalizeDelegatedStyleSampleForTest(fixture.root);
  const lock = await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
  await approveGate(fixture.root, "generation-authorization");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const page = job.pages[0]!;
  const masterPath = join(fixture.root, ...page.target.split("/"));
  const rawPath = join(masterPath, "..", "raw", `${page.slideId}.png`);
  await mkdir(join(masterPath, "..", "raw"));
  await sharp({ create: { width: 2048, height: 1152, channels: 3, background: "#112233" } }).png().toFile(masterPath);

  const admission = await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  });
  const dependency = {
    status: "success" as const,
    provider: "openai" as const,
    channel: "host" as const,
    output_path: masterPath,
    safe_message: "host image imported",
  };
  const batchReport = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "host-openai" as const,
    sticky_candidate: "host-openai" as const,
    pages: [{ page: 1, outcome: "success" as const, candidate: "host-openai" as const, summary: "" }],
    switches: [],
  };
  const intake = {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: admission.admissionToken,
    dependency,
    batchReport,
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: job.styleLock.referenceArtifacts.map(({ path, sha256 }) => ({ path, sha256, usage: "used" as const })),
    presentationQa: passingPresentationQa(job, page, await normalizedImageSha256(masterPath)),
  };

  await assert.rejects(recordDelegatedResult(fixture.root, intake), /raw.*required|raw.*artifact/i);
  await sharp({ create: { width: 2050, height: 1152, channels: 3, background: "#223344" } }).png().toFile(rawPath);
  await assert.rejects(
    recordDelegatedResult(fixture.root, { ...intake, actualPromptSha256: "0".repeat(64) }),
    /prompt.*hash/i,
  );
  await assert.rejects(
    recordDelegatedResult(fixture.root, {
      ...intake,
      batchReport: {
        ...batchReport,
        search_candidate: "api-openai",
        sticky_candidate: "api-openai",
        pages: [{ ...batchReport.pages[0]!, candidate: "api-openai" }],
      },
    }),
    /routing report.*provider|provider.*routing report/i,
  );
  await assert.rejects(
    recordDelegatedResult(fixture.root, {
      ...intake,
      presentationQa: {
        ...intake.presentationQa,
        decision: { ...intake.presentationQa.decision, requiredText: [] },
      },
    }),
    /required text|expected copy/i,
  );
  await assert.rejects(
    recordDelegatedResult(fixture.root, {
      ...intake,
      presentationQa: { ...intake.presentationQa, normalizedImageSha256: "0".repeat(64) },
    }),
    /normalized image|image.*QA|QA.*image/i,
  );

  const recorded = await recordDelegatedResult(fixture.root, intake);
  assert.equal(ImageGenerationResultSchema.parse(recorded).outcome, "partial");
  assert.equal(recorded.actualRequestCount, 1);
  assert.equal(recorded.pages[0]!.status, "success");
  assert.equal(recorded.pages[0]!.styleConsistency, "accepted");
  assert.equal(recorded.pages[0]!.artifacts!.raw?.path, `generation/jobs/${job.jobId}/ai-image-output/raw/${page.slideId}.png`);
  assert.equal(recorded.pages[0]!.artifacts!.master.path, page.target);
  assert.equal(recorded.pages[0]!.artifacts!.normalized.path, `generation/jobs/${job.jobId}/normalized/${page.slideId}.png`);
  const normalized = await sharp(join(fixture.root, ...recorded.pages[0]!.artifacts!.normalized.path.split("/"))).metadata();
  assert.deepEqual([normalized.width, normalized.height, normalized.format], [1920, 1080, "png"]);
  const manifestBeforeReplay = await lstat(join(fixture.root, "superppt.json"), { bigint: true });
  assert.deepEqual(await recordDelegatedResult(fixture.root, intake), recorded, "an exact replay is read-only and idempotent");
  const manifestAfterReplay = await lstat(join(fixture.root, "superppt.json"), { bigint: true });
  assert.equal(manifestAfterReplay.ino, manifestBeforeReplay.ino, "exact replay must not rewrite the project manifest");
  await assert.rejects(
    recordDelegatedResult(fixture.root, { ...intake, dependency: { ...dependency, safe_message: "conflicting replay" } }),
    /conflicting delegated result replay/i,
  );
  assert.deepEqual((await readCallLedger(fixture.root)).filter(({ jobId }) => jobId === job.jobId).map(({ entryKind, outcome }) => ({ entryKind, outcome })), [
    { entryKind: "admission", outcome: "in-flight" },
    { entryKind: "terminal", outcome: "success" },
  ]);
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#abcdef" } }).png().toFile(
    join(fixture.root, ...recorded.pages[0]!.artifacts!.normalized.path.split("/")),
  );
  await assert.rejects(recordDelegatedResult(fixture.root, intake), /normalized.*deterministic|normalized.*master/i);
});

test("unsupported art direction pauses intake and every failed actual request remains spent", async (t) => {
  const fixture = await approvedProject(t, "superppt-delegated-result-paused-", undefined, false);
  const referencePath = "style/references/art-direction.png";
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  await writeFile(join(fixture.root, ...referencePath.split("/")), "required art direction reference");
  await createProvisionalStyleLock(fixture.root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [{ path: referencePath, role: "art-direction" }],
  });
  await finalizeDelegatedStyleSampleForTest(fixture.root);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
  await approveGate(fixture.root, "generation-authorization");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const page = job.pages[0]!;
  const admission = await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  });
  const recorded = await recordDelegatedResult(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: admission.admissionToken,
    dependency: {
      status: "invalid_input",
      provider: "openai",
      channel: "host",
      output_path: null,
      safe_message: "required reference capability unavailable",
    },
    batchReport: {
      batch_mode: "serial-sticky-monotonic",
      stopped: true,
      search_candidate: "host-openai",
      sticky_candidate: null,
      pages: [{ page: 1, outcome: "fatal", candidate: "host-openai", summary: "reference capability unavailable" }],
      switches: [],
    },
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: job.styleLock.referenceArtifacts.map(({ path, sha256 }) => ({ path, sha256, usage: "unsupported" as const })),
    presentationQa: null,
  });

  assert.equal(recorded.outcome, "attention-required");
  assert.equal(recorded.pages[0]!.status, "paused");
  assert.equal(recorded.pages[0]!.artifacts, null);
  assert.equal(recorded.pages[0]!.styleConsistency, "not-reviewed");
  assert.deepEqual(await generationCallBudget(fixture.root, job), { authorized: 3, consumed: 1, remaining: 2 });
  assert.equal((await readCallLedger(fixture.root)).at(-1)?.outcome, "failed");
});

test("delegated result permits API raw null and records stale revision evidence without attaching it", async (t) => {
  const fixture = await approvedProject(t, "superppt-delegated-result-stale-api-", undefined, false);
  const referencePath = "style/references/content.png";
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  await writeFile(join(fixture.root, ...referencePath.split("/")), "sealed content reference");
  await createProvisionalStyleLock(fixture.root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [{ path: referencePath, role: "content-reference" }],
  });
  await finalizeDelegatedStyleSampleForTest(fixture.root);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 3 });
  await approveGate(fixture.root, "generation-authorization");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const page = job.pages[0]!;
  const masterPath = join(fixture.root, ...page.target.split("/"));
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#334455" } }).png().toFile(masterPath);
  const batchReport = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "api-openai" as const,
    sticky_candidate: "api-openai" as const,
    pages: [{ page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" }],
    switches: [],
  };
  const baseIntake = {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: "0".repeat(64),
    dependency: {
      status: "success" as const,
      provider: "openai" as const,
      channel: "api" as const,
      output_path: masterPath,
      safe_message: "API image generated",
    },
    batchReport,
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: job.styleLock.referenceArtifacts.map(({ path, sha256 }) => ({ path, sha256, usage: "used" as const })),
    presentationQa: passingPresentationQa(job, page, await normalizedImageSha256(masterPath)),
  };
  await assert.rejects(recordDelegatedResult(fixture.root, baseIntake), /no prior admission/i);
  const admission = await admitDelegatedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  });

  const revisionPlan = await publishImpactPlan(fixture.root, { kind: "style" });
  await approveImpact(fixture.root, revisionPlan.sha256);
  await applyRevision(fixture.root, revisionPlan, revisionPlan.change);
  const manifestPath = join(fixture.root, "superppt.json");
  await writeFile(join(fixture.root, "style", "lock.json"), "{}\n");
  await writeFile(join(fixture.root, "style", "recipe.json"), "{}\n");
  await writeFile(join(fixture.root, ...job.styleLock.approvedSample!.path.split("/")), "changed approved sample");
  await writeFile(join(fixture.root, ...referencePath.split("/")), "changed reference");
  await writeFile(join(fixture.root, "slides", page.slideId, "spec.json"), `${JSON.stringify({
    ...page.spec,
    role: "data",
    requiredText: ["Changed current copy"],
  })}\n`);
  const staleManifestBytes = await readFile(manifestPath);

  const recorded = await recordDelegatedResult(fixture.root, { ...baseIntake, admissionToken: admission.admissionToken });
  assert.equal(recorded.pages[0]!.artifacts!.raw, null);
  assert.equal(recorded.pages[0]!.artifacts!.master.path, page.target);
  assert.equal(await readFile(manifestPath, "utf8"), staleManifestBytes.toString("utf8"), "stale evidence must not rewrite the current manifest");
  await access(join(fixture.root, "generation", "jobs", job.jobId, "results", `${page.slideId}-${page.attempt}.json`));
});

test("aggregate publication reauthenticates an earlier page's physical artifacts", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-delegated-result-aggregate-tamper-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const first = job.pages[0]!;
  const second = job.pages[1]!;
  const firstReport = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "api-openai" as const,
    sticky_candidate: "api-openai" as const,
    pages: [{ page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" }],
    switches: [],
  };
  const firstRecorded = await recordDelegatedResult(fixture.root, await admittedApiSuccessIntake(
    fixture.root, job, first, 1, firstReport, "#101820",
  ));
  const secondReport = {
    ...firstReport,
    pages: [
      firstReport.pages[0]!,
      { page: 2, outcome: "success" as const, candidate: "api-openai" as const, summary: "" },
    ],
  };
  const secondIntake = await admittedApiSuccessIntake(
    fixture.root, job, second, 2, secondReport, "#204060",
  );
  await assert.rejects(recordDelegatedResult(fixture.root, {
    ...secondIntake,
    batchReport: {
      ...secondReport,
      pages: [{ ...secondReport.pages[0]!, summary: "forged prior page summary" }, secondReport.pages[1]!],
    },
  }), /routing evidence.*immutable prefix|immutable prefix.*routing evidence/i);
  await assert.rejects(recordDelegatedResult(fixture.root, {
    ...secondIntake,
    presentationQa: {
      ...secondIntake.presentationQa,
      normalizedImageSha256: firstRecorded.pages[0]!.presentationQa!.normalizedImageSha256,
    },
  }), /normalized image|image.*QA|QA.*image/i, "QA accepted for one image cannot be reused for another image");
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#ff0055" } }).png().toFile(
    join(fixture.root, ...first.target.split("/")),
  );
  await assert.rejects(recordDelegatedResult(fixture.root, secondIntake), /master.*hash|artifact.*changed|deterministic.*master/i);
  await assert.rejects(access(join(
    fixture.root,
    "generation",
    "jobs",
    job.jobId,
    "results",
    `${second.slideId}-${second.attempt}.json`,
  )));
  await assert.rejects(access(join(fixture.root, "generation", "jobs", job.jobId, "normalized", `${second.slideId}.png`)));
  assert.equal((await readCallLedger(fixture.root)).at(-1)?.outcome, "success", "rejected publication retains terminal call evidence");
});

test("invalid aggregate routing evidence leaves no incoming page or normalized publication", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-delegated-result-invalid-aggregate-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const page = job.pages[0]!;
  const invalidReport = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "api-openai" as const,
    sticky_candidate: "api-openai" as const,
    pages: [
      { page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" },
      { page: 2, outcome: "success" as const, candidate: "api-openai" as const, summary: "forged future page" },
    ],
    switches: [],
  };
  const intake = await admittedApiSuccessIntake(fixture.root, job, page, 1, invalidReport, "#405060");
  await assert.rejects(recordDelegatedResult(fixture.root, intake), /report pages|intake records|aggregate/i);
  await assert.rejects(access(join(fixture.root, "generation", "jobs", job.jobId, "results", `${page.slideId}-${page.attempt}.json`)));
  await assert.rejects(access(join(fixture.root, "generation", "jobs", job.jobId, "normalized", `${page.slideId}.png`)));
});

test("delegated result publication checkpoints converge on exact replay", async (t) => {
  const checkpoints = [
    "after-page-promotion",
    "after-aggregate-promotion",
    "before-manifest-attach",
    "after-manifest-attach",
  ] as const;
  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, async (t) => {
      const fixture = await authorizedDeckProject(t, `superppt-delegated-result-crash-${checkpoint}-`);
      const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
      const page = job.pages[0]!;
      const report = {
        batch_mode: "serial-sticky-monotonic" as const,
        stopped: false,
        search_candidate: "api-openai" as const,
        sticky_candidate: "api-openai" as const,
        pages: [{ page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" }],
        switches: [],
      };
      const intake = await admittedApiSuccessIntake(fixture.root, job, page, 1, report, "#102030");
      await assert.rejects(recordDelegatedResult(fixture.root, intake, {
        checkpoint: (step) => {
          if (step === checkpoint) throw new Error(`injected ${checkpoint}`);
        },
      }), new RegExp(`injected ${checkpoint}`));
      const replayed = await recordDelegatedResult(fixture.root, intake);
      assert.equal(replayed.pages[0]!.styleConsistency, "accepted");
      await access(join(fixture.root, "generation", "jobs", job.jobId, "results", `${page.slideId}-${page.attempt}.json`));
      await access(join(fixture.root, "generation", "jobs", job.jobId, "normalized", `${page.slideId}.png`));
      await access(join(fixture.root, "generation", "jobs", job.jobId, "result.json"));
      const manifest = await readProject(fixture.root);
      assert.equal(manifest.slides.find(({ id }) => id === page.slideId)?.image?.sha256, replayed.pages[0]!.artifacts!.normalized.sha256);
    });
  }
});

test("tampered recoverable delegated-result intermediate fails closed", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-delegated-result-crash-tamper-");
  const job = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  const page = job.pages[0]!;
  const report = {
    batch_mode: "serial-sticky-monotonic" as const,
    stopped: false,
    search_candidate: "api-openai" as const,
    sticky_candidate: "api-openai" as const,
    pages: [{ page: 1, outcome: "success" as const, candidate: "api-openai" as const, summary: "" }],
    switches: [],
  };
  const intake = await admittedApiSuccessIntake(fixture.root, job, page, 1, report, "#708090");
  await assert.rejects(recordDelegatedResult(fixture.root, intake, {
    checkpoint: (step) => {
      if (step === "after-page-promotion") throw new Error("injected page crash");
    },
  }), /injected page crash/);
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#ff0000" } }).png().toFile(
    join(fixture.root, "generation", "jobs", job.jobId, "normalized", `${page.slideId}.png`),
  );
  await assert.rejects(recordDelegatedResult(fixture.root, intake), /normalized.*deterministic|normalized.*hash|intermediate/i);
});

test("delegation CLI admits an exact immutable job tuple and settles its private result token", async (t) => {
  const fixture = await authorizedDeckProject(t, "superppt-delegation-cli-roundtrip-");
  const cli = ["--import", "tsx", "src/cli.ts"];
  const environment = {
    ...process.env,
    SUPERPPT_AUTHORIZATION_TRUST_ROOT: fixture.authorizationTrustRoot,
  };
  const invoke = (args: string[]) => execFileAsync(process.execPath, [...cli, ...args], {
    cwd: process.cwd(),
    env: environment,
  });

  const prepared = await invoke([
    "prepare-deck-job",
    "--project", fixture.root,
    "--ai-skill", fixture.aiDependency.root,
  ]);
  assert.equal(prepared.stderr, "");
  const job = ImageGenerationJobSchema.parse(JSON.parse(prepared.stdout).job);
  const page = job.pages[0]!;
  const jobPath = join(fixture.root, "generation", "jobs", job.jobId, "job.json");
  const admitted = await invoke([
    "admit-image-call",
    "--project", fixture.root,
    "--job", jobPath,
    "--slide", page.slideId,
    "--attempt", String(page.attempt),
    "--request-ordinal", "1",
  ]);
  const admission = JSON.parse(admitted.stdout) as { admissionToken: string; remaining: number };
  assert.match(admission.admissionToken, /^[a-f0-9]{64}$/);
  assert.equal(admission.remaining, 2);

  const masterPath = join(fixture.root, ...page.target.split("/"));
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#314159" } }).png().toFile(masterPath);
  const privateRoot = await directory(t, "superppt-delegation-cli-private-");
  const resultPath = join(privateRoot, "result.json");
  const reportPath = join(privateRoot, "route-report.json");
  await writeFile(resultPath, JSON.stringify({
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: admission.admissionToken,
    dependency: { status: "success", provider: "openai", channel: "api", output_path: masterPath, safe_message: "" },
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: [],
    presentationQa: passingPresentationQa(job, page, await normalizedImageSha256(masterPath)),
  }), { mode: 0o600 });
  await writeFile(reportPath, JSON.stringify({
    batch_mode: "serial-sticky-monotonic",
    stopped: false,
    search_candidate: "api-openai",
    sticky_candidate: "api-openai",
    pages: [{ page: 1, outcome: "success", candidate: "api-openai", summary: "" }],
    switches: [],
  }), { mode: 0o600 });

  await chmod(resultPath, 0o644);
  await assert.rejects(invoke([
    "record-image-result",
    "--project", fixture.root,
    "--job", jobPath,
    "--result", resultPath,
    "--route-report", reportPath,
  ]), /result file must be private \(mode 0600\)/);
  assert.equal((await readCallLedger(fixture.root)).at(-1)?.entryKind, "admission");

  await chmod(resultPath, 0o600);
  const recorded = await invoke([
    "record-image-result",
    "--project", fixture.root,
    "--job", jobPath,
    "--result", resultPath,
    "--route-report", reportPath,
  ]);
  assert.equal(recorded.stderr, "");
  assert.equal(JSON.parse(recorded.stdout).result.pages[0].styleConsistency, "accepted");
  assert.equal((await readProject(fixture.root)).slides.find(({ id }) => id === page.slideId)?.status, "ready");
  assert.doesNotMatch(JSON.stringify(await readCallLedger(fixture.root)), new RegExp(admission.admissionToken));

  const status = await invoke(["generation-status", "--project", fixture.root]);
  assert.equal(JSON.parse(status.stdout).pages[0].status, "accepted");
});
