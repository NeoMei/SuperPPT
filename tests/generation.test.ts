import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";

import { generateProject, recordManualQa, retryProjectPage, runBatch } from "../src/generation/batch.js";
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
import { ImageGenerationJobSchema } from "../src/generation/job-schemas.js";
import { assertJobAuthorized, prepareImageGenerationJob } from "../src/generation/jobs.js";
import { finalizeStyleSample, prepareStyleSampleJob } from "../src/generation/style-sample.js";
import { generateSlide } from "../src/generation/provider.js";
import { reviewSlide } from "../src/generation/quality.js";
import { privateSecurityPolicy } from "../src/generation/private-input.js";
import { bridgeContainmentPolicy } from "../src/generation/bridge-process.js";
import {
  AttemptLedgerSchema,
  DependencyGenerationResultSchema,
  ImageGenerationResultSchema,
  QualityDecisionSchema,
  SerialStickyReportSchema,
  type SerialStickyReport,
} from "../src/generation/schemas.js";
import { resolveSkillDependencies } from "../src/dependencies/resolve.js";
import type { AiImageSkillDependency, LegacyResolvedDependencies } from "../src/dependencies/schemas.js";
import { approveExecutionGate, approveGate, assertGateCurrent } from "../src/planning/confirm.js";
import { loadValidatedPlan } from "../src/planning/load.js";
import { publishPlanViews, publishStyleSample } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject } from "../src/project/store.js";
import { applyRevision, approveImpact, publishImpactPlan } from "../src/revisions/apply.js";
import { loadBuiltInStyleCatalog } from "../src/styles/catalog.js";
import { compileSlidePrompt } from "../src/styles/prompt-compiler.js";
import { approveStyleLock, createProvisionalStyleLock, readApprovedStyleLock } from "../src/styles/style-lock.js";
import { writeCanonicalStyleSample } from "./helpers/style-sample.js";
import { finalizeDelegatedStyleSampleForTest } from "./helpers/delegated-style-sample.js";

const runner = join(process.cwd(), "scripts", "run_ai_image_provider.py");
const fakeProvider = join(process.cwd(), "tests", "fixtures", "fake_ai_provider.py");
const fakeReviewer = join(process.cwd(), "tests", "fixtures", "fake_ai_reviewer.py");
const orphanProbe = join(process.cwd(), "tests", "fixtures", "orphan_generation_probe.ts");
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for probe state");
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function approvedProject(
  t: TestContext,
  prefix: string,
  styleLock?: Parameters<typeof createProvisionalStyleLock>[1],
): Promise<{ root: string; ai: LegacyResolvedDependencies["ai"]; aiDependency: AiImageSkillDependency; editableRoot: string }> {
  const parent = await directory(t, prefix);
  const root = join(parent, "project");
  await initializeProject({ root, title: "Generation Demo" });
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
  await mkdir(join(aiRoot, "references"));
  await writeFile(join(aiRoot, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  await writeFile(join(aiRoot, "scripts", "provider.py"), await readFile(fakeProvider));
  await writeFile(join(aiRoot, "scripts", "reviewer.py"), await readFile(fakeReviewer));
  for (const script of ["generation_result.py", "host_routing_policy.py", "import_host_image.py", "prepare_editable_input.py"]) {
    await writeFile(join(aiRoot, "scripts", script), "raise SystemExit('not executed by job preparation')\n");
  }
  const capabilities = {
    contractVersion: 1,
    defaultProvider: "openai-gpt-image-2",
    providers: [{ id: "openai-gpt-image-2", module: "scripts/provider.py", callable: "gen", outputFormats: ["png"], supportsReferenceImages: true }],
    reviewer: { module: "scripts/reviewer.py", callable: "check" },
  };
  await writeFile(join(aiRoot, "references", "capabilities.json"), JSON.stringify(capabilities));
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
  } else {
    await publishStyleSample(root);
    await approveGate(root, "style-sample");
  }
  return {
    root,
    editableRoot,
    aiDependency,
    ai: {
      ...capabilities as LegacyResolvedDependencies["ai"],
      root: aiRoot,
      source: "manifest",
    },
  };
}

const lockedStyle = {
  selection: { kind: "catalog" as const, styleId: "cinematic-tech" },
  referenceArtifacts: [],
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
  const fixture = await approvedProject(t, "superppt-image-job-staging-cleanup-");
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
  const fixture = await approvedProject(t, "superppt-image-job-sample-");
  const referencePath = "style/references/style-direction.txt";
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  await writeFile(join(fixture.root, ...referencePath.split("/")), "required art direction");
  await createProvisionalStyleLock(fixture.root, {
    ...lockedStyle,
    referenceArtifacts: [{ path: referencePath, role: "art-direction" }],
  });
  await writeCanonicalStyleSample(fixture.root);
  await assert.rejects(publishStyleSample(fixture.root), /completion receipt|delegated style sample/i);
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
  const finalized = await finalizeStyleSample(fixture.root, job.jobId);
  assert.deepEqual(Object.keys(finalized).sort(), ["style/sample/director.json", "style/sample/ledger.json", "style/sample/prompt.txt", "style/sample/slide.png", "style/selection.json"]);
  await assert.rejects(access(staleTemp), { code: "ENOENT" });
  const receiptPath = join(fixture.root, "style", "sample", "completion.json");
  const receipt = await readFile(receiptPath);
  await finalizeStyleSample(fixture.root, job.jobId);
  assert.deepEqual(await readFile(receiptPath), receipt, "receipt-last finalization is idempotent after a crash retry");
  await publishStyleSample(fixture.root);
  await approveGate(fixture.root, "style-sample");
  const approved = await approveStyleLock(fixture.root);
  assert.equal(approved.approvalState, "approved");
});

test("delegated style sample cannot finalize or retry after its one authorized call fails", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-sample-failure-");
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
  const second = await executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[1]!.slideId,
    attempt: 1,
    requestOrdinal: 2,
  }, async () => "second image");
  assert.deepEqual(second, { executed: true, outcome: "success", value: "second image", consumed: 2, remaining: 1 });
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[2]!.slideId,
    attempt: 1,
    requestOrdinal: 3,
  }, async () => {
    throw new Error("third request failed");
  }), /third request failed/);
  await assert.rejects(executeAuthorizedGenerationCall(fixture.root, {
    jobId: job.jobId,
    slideId: job.pages[0]!.slideId,
    attempt: 1,
    requestOrdinal: 4,
  }, async () => "over budget"), /call budget.*exhausted/i);
  assert.equal((await readCallLedger(fixture.root)).filter(({ jobId }) => jobId === job.jobId).length, 6);
  assert.deepEqual(await generationCallBudget(fixture.root, job), { authorized: 3, consumed: 3, remaining: 0 });
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

test("call budget keeps an exact page-regeneration duplicate idempotent after its last call", async (t) => {
  const fixture = await approvedProject(t, "superppt-image-job-regeneration-duplicate-", lockedStyle);
  await approveStyleLock(fixture.root);
  await publishGenerationAuthorizationPlan(fixture.root, { aiDependency: fixture.aiDependency, callBudget: 4 });
  await approveGate(fixture.root, "generation-authorization");
  const deck = await prepareImageGenerationJob(fixture.root, { kind: "deck", aiDependency: fixture.aiDependency });
  for (const [index, page] of deck.pages.entries()) {
    await executeAuthorizedGenerationCall(fixture.root, {
      jobId: deck.jobId,
      slideId: page.slideId,
      attempt: 1,
      requestOrdinal: index + 1,
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
  for (const [index, page] of deck.pages.entries()) {
    const request = {
      jobId: deck.jobId,
      slideId: page.slideId,
      attempt: 1,
      requestOrdinal: index + 1,
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
  for (const [index, page] of job.pages.entries()) {
    await executeAuthorizedGenerationCall(fixture.root, {
      jobId: job.jobId,
      slideId: page.slideId,
      attempt: page.attempt,
      requestOrdinal: index + 1,
    }, async () => `initial-${index}`);
  }

  let actualCalls = 0;
  const contenders = [4, 5].map((requestOrdinal) => executeAuthorizedGenerationCall(fixture.root, {
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
  assert.match(String((settled.find(({ status }) => status === "rejected") as PromiseRejectedResult).reason), /call budget.*exhausted/i);
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
  const fixture = await approvedProject(t, "superppt-delegated-result-host-");
  const referencePath = "style/references/art-direction.png";
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  const referenceBytes = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#6a4c93" } }).png().toBuffer();
  await writeFile(join(fixture.root, ...referencePath.split("/")), referenceBytes);
  await createProvisionalStyleLock(fixture.root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [{ path: referencePath, role: "art-direction" }],
  });
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
  assert.deepEqual((await readCallLedger(fixture.root)).map(({ entryKind, outcome }) => ({ entryKind, outcome })), [
    { entryKind: "admission", outcome: "in-flight" },
    { entryKind: "terminal", outcome: "success" },
  ]);
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#abcdef" } }).png().toFile(
    join(fixture.root, ...recorded.pages[0]!.artifacts!.normalized.path.split("/")),
  );
  await assert.rejects(recordDelegatedResult(fixture.root, intake), /normalized.*deterministic|normalized.*master/i);
});

test("unsupported art direction pauses intake and every failed actual request remains spent", async (t) => {
  const fixture = await approvedProject(t, "superppt-delegated-result-paused-");
  const referencePath = "style/references/art-direction.png";
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  await writeFile(join(fixture.root, ...referencePath.split("/")), "required art direction reference");
  await createProvisionalStyleLock(fixture.root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [{ path: referencePath, role: "art-direction" }],
  });
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
  const fixture = await approvedProject(t, "superppt-delegated-result-stale-api-");
  const referencePath = "style/references/content.png";
  await mkdir(join(fixture.root, "style", "references"), { recursive: true });
  await writeFile(join(fixture.root, ...referencePath.split("/")), "sealed content reference");
  await createProvisionalStyleLock(fixture.root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [{ path: referencePath, role: "content-reference" }],
  });
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

test("passes prompts through a 0600 file in a 0700 directory and atomically normalizes output", async (t) => {
  const root = await directory(t, "superppt-provider-");
  const output = join(root, "slide.png");
  const privatePaths: string[] = [];
  const prompt = "private content that must never escape";
  const ledger = await generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    providerId: "manifest-provider",
    slideId: "00000000-0000-4000-8000-000000000701",
    prompt,
    output,
    attempt: 1,
    beforeExecute: async (privatePath) => {
      privatePaths.push(privatePath);
      assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(privatePath, ".."))).mode & 0o777, 0o700);
    },
  });

  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 1080);
  assert.equal(metadata.format, "png");
  assert.equal(isAbsolute(ledger.output!), true);
  assert.equal(AttemptLedgerSchema.parse(ledger).promptPurged, true);
  assert.doesNotMatch(JSON.stringify(ledger), new RegExp(prompt));
  for (const path of privatePaths) await assert.rejects(access(path));
});

test("purges private input and suppresses provider stdout, stderr, and exception text on failure", async (t) => {
  const root = await directory(t, "superppt-provider-failure-");
  const output = join(root, "slide.png");
  const secret = "TOP SECRET PROMPT VALUE";
  let privatePath = "";

  await assert.rejects(generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "noisy_failure",
    providerId: "manifest-provider",
    slideId: "00000000-0000-4000-8000-000000000702",
    prompt: secret,
    output,
    attempt: 1,
    timeoutMs: 2_000,
    beforeExecute: async (path) => { privatePath = path; },
  }), (error: unknown) => {
    assert.doesNotMatch(String(error), new RegExp(secret));
    assert.match(String(error), /provider generation failed/);
    return true;
  });
  await assert.rejects(access(privatePath));
  await assert.rejects(access(output));
});

test("rejects incomplete or unsafe provider images without replacing an existing output", async (t) => {
  const root = await directory(t, "superppt-provider-invalid-");
  const modulePath = join(root, "provider.py");
  const output = join(root, "slide.png");
  const prior = Buffer.from("prior successful bytes");
  await writeFile(output, prior, { mode: 0o600 });
  await writeFile(modulePath, "def gen(prompt, out_path, retries=0):\n open(out_path, 'wb').write(b'not-an-image'); return True\n");

  await assert.rejects(generateSlide({
    runner,
    modulePath,
    callable: "gen",
    providerId: "generic-provider",
    slideId: "00000000-0000-4000-8000-000000000703",
    prompt: "private",
    output,
    attempt: 1,
  }), /provider output is not an allowed complete image/);
  assert.deepEqual(await readFile(output), prior);
  assert.equal((await lstat(output)).isFile(), true);
});

test("anchors output and private directories against replacement races", async (t) => {
  const parent = await directory(t, "superppt-provider-race-");
  const outputRoot = join(parent, "output");
  const movedRoot = join(parent, "moved-output");
  await mkdir(outputRoot, { mode: 0o700 });
  await assert.rejects(generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    prompt: "never redirect me",
    output: join(outputRoot, "slide.png"),
    trustedRoot: outputRoot,
    attempt: 1,
    afterOutputDirectoryOpened: async () => {
      await rename(outputRoot, movedRoot);
      await mkdir(outputRoot, { mode: 0o700 });
    },
  }), /provider generation failed/);
  assert.deepEqual(await readdir(outputRoot), []);

  const secondRoot = join(parent, "second");
  const stolenPrivate = join(parent, "stolen-private");
  const attacker = join(parent, "attacker");
  await mkdir(secondRoot, { mode: 0o700 });
  await mkdir(attacker, { mode: 0o700 });
  await assert.rejects(generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    prompt: "private race content",
    output: join(secondRoot, "slide.png"),
    trustedRoot: secondRoot,
    attempt: 1,
    beforeExecute: async (privatePath) => {
      await rename(join(privatePath, ".."), stolenPrivate);
      await symlink(attacker, join(privatePath, ".."));
    },
  }), /provider generation failed/);
  assert.deepEqual(await readdir(attacker), []);
  assert.equal((await readdir(stolenPrivate)).length, 0);
});

test("executes the already-opened provider module when its path is replaced", async (t) => {
  const root = await directory(t, "superppt-provider-module-race-");
  const modulePath = join(root, "provider.py");
  const original = await readFile(fakeProvider);
  await writeFile(modulePath, original);
  const ledger = await generateSlide({
    runner,
    modulePath,
    callable: "gen",
    prompt: "private",
    output: join(root, "slide.png"),
    attempt: 1,
    afterProviderModuleOpened: async () => {
      await rename(modulePath, join(root, "provider.opened.py"));
      await writeFile(modulePath, "def gen(prompt, out_path, retries=0):\n raise RuntimeError(prompt)\n");
    },
  });
  assert.equal(ledger.outcome, "generated");
});

test("cleans private input after provider timeout and rejects trusted-root escape", async (t) => {
  const root = await directory(t, "superppt-provider-timeout-");
  const modulePath = join(root, "slow.py");
  await writeFile(modulePath, "import time\ndef gen(prompt, out_path, retries=0):\n time.sleep(5); return True\n");
  let privatePath = "";
  await assert.rejects(generateSlide({
    runner,
    modulePath,
    callable: "gen",
    prompt: "timeout secret",
    output: join(root, "slide.png"),
    attempt: 1,
    timeoutMs: 50,
    beforeExecute: async (path) => { privatePath = path; },
  }), /provider generation failed/);
  await assert.rejects(access(privatePath));

  const trusted = join(root, "trusted");
  const outside = join(root, "outside");
  await mkdir(trusted);
  await mkdir(outside);
  await assert.rejects(generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    prompt: "private",
    output: join(outside, "slide.png"),
    trustedRoot: trusted,
    attempt: 1,
  }), /outside the trusted root/);
});

test("contains the provider and unlinks private input when its orchestrator is SIGKILLed", { skip: process.platform === "win32" }, async (t) => {
  const root = await directory(t, "superppt-orphan-probe-");
  const provider = join(root, "provider.py");
  const pidMarker = join(root, "provider.pid");
  const privateMarker = join(root, "private.path");
  await writeFile(provider, [
    "import os",
    "import time",
    "def gen(prompt, out_path, retries=0):",
    " open(os.environ['SUPERPPT_ORPHAN_PID_MARKER'], 'w').write(str(os.getpid()))",
    " while True: time.sleep(1)",
    "",
  ].join("\n"));
  const orchestrator = spawn(process.execPath, [
    "--import", "tsx", orphanProbe, root, runner, provider, privateMarker,
  ], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: { ...process.env, SUPERPPT_ORPHAN_PID_MARKER: pidMarker },
  });
  let providerPid = 0;
  try {
    await waitFor(async () => {
      try {
        providerPid = Number(await readFile(pidMarker, "utf8"));
        return Number.isInteger(providerPid) && providerPid > 0 && (await readFile(privateMarker, "utf8")).length > 0;
      } catch { return false; }
    }, 15_000);
    const privatePath = await readFile(privateMarker, "utf8");
    assert.equal(processExists(providerPid), true);
    orchestrator.kill("SIGKILL");
    await new Promise<void>((resolve) => orchestrator.once("close", () => resolve()));
    await waitFor(async () => !processExists(providerPid), 3_000);
    await assert.rejects(access(privatePath));
  } finally {
    if (orchestrator.exitCode === null && orchestrator.signalCode === null) orchestrator.kill("SIGKILL");
    if (providerPid > 0 && processExists(providerPid)) process.kill(providerPid, "SIGKILL");
  }
});

test("cleans only owned abandoned provider files and never follows matching symlinks", async (t) => {
  const root = await directory(t, "superppt-abandoned-provider-");
  const privateRoot = join(root, ".private");
  const deadPid = 2_000_000_000;
  const firstId = "00000000-0000-4000-8000-000000000781";
  const secondId = "00000000-0000-4000-8000-000000000782";
  await mkdir(privateRoot, { mode: 0o700 });
  const abandonedPrivate = join(privateRoot, `pid-${deadPid}-${firstId}.prompt.txt`);
  const abandonedRaw = join(root, `.pid-${deadPid}-${firstId}.provider-image`);
  await writeFile(abandonedPrivate, "ABANDONED_PRIVATE_SENTINEL", { mode: 0o600 });
  await writeFile(abandonedRaw, "abandoned raw", { mode: 0o600 });
  const outside = join(root, "outside.txt");
  const linkedRaw = join(root, `.pid-${deadPid}-${secondId}.provider-image`);
  await writeFile(outside, "outside stays");
  await symlink(outside, linkedRaw);

  await generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    prompt: "new private prompt",
    output: join(root, "slide.png"),
    trustedRoot: root,
    attempt: 1,
  });

  await assert.rejects(access(abandonedPrivate));
  await assert.rejects(access(abandonedRaw));
  assert.equal((await lstat(linkedRaw)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), "outside stays");
});

test("cleans only validated dead-owner attempt staging during project recovery", async (t) => {
  const fixture = await approvedProject(t, "superppt-abandoned-staging-");
  const slideRoot = join(fixture.root, "images", SLIDE_IDS[0]);
  const deadPid = 2_000_000_000;
  const firstId = "00000000-0000-4000-8000-000000000783";
  const secondId = "00000000-0000-4000-8000-000000000784";
  const abandoned = join(slideRoot, `.attempt-1.pid-${deadPid}-${firstId}.staging`);
  const privateRoot = join(abandoned, ".private");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(privateRoot, `pid-${deadPid}-${firstId}.prompt.txt`), "ABANDONED_STAGING_SENTINEL", { mode: 0o600 });
  await writeFile(join(abandoned, `.pid-${deadPid}-${firstId}.provider-image`), "raw", { mode: 0o600 });
  const outside = join(fixture.root, "outside-staging");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "outside stays");
  const linked = join(slideRoot, `.attempt-1.pid-${deadPid}-${secondId}.staging`);
  await symlink(outside, linked);

  await assert.rejects(
    generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 }),
    /attempt directory is unsafe/,
  );

  await assert.rejects(access(abandoned));
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "outside stays");
});

test("uses process groups on POSIX and a Job Object branch on Windows", () => {
  assert.deepEqual(bridgeContainmentPolicy("darwin"), { detached: true, killProcessGroup: true, windowsJobObject: false });
  assert.deepEqual(bridgeContainmentPolicy("linux"), { detached: true, killProcessGroup: true, windowsJobObject: false });
  assert.deepEqual(bridgeContainmentPolicy("win32"), { detached: false, killProcessGroup: false, windowsJobObject: true });
});

test("bridge and provider descendants exit when the parent-liveness pipe reaches EOF", async (t) => {
  const root = await directory(t, "superppt-parent-pipe-");
  const modulePath = join(root, "provider.py");
  const inputPath = join(root, "prompt.txt");
  const targetPath = join(root, "raw.png");
  const bridgeMarker = join(root, "bridge.pid");
  const descendantMarker = join(root, "descendant.pid");
  await writeFile(inputPath, "PARENT_PIPE_PRIVATE_SENTINEL", { mode: 0o600 });
  await chmod(inputPath, 0o600);
  await writeFile(modulePath, [
    "import os",
    "import subprocess",
    "import sys",
    "import time",
    "def gen(prompt, out_path, retries=0):",
    " open(os.environ['SUPERPPT_BRIDGE_PID_MARKER'], 'w').write(str(os.getpid()))",
    " code = \"import os,time; open(os.environ['SUPERPPT_DESCENDANT_PID_MARKER'], 'w').write(str(os.getpid())); time.sleep(60)\"",
    " subprocess.Popen([sys.executable, '-c', code])",
    " while True: time.sleep(1)",
    "",
  ].join("\n"));
  await writeFile(targetPath, "", { mode: 0o600 });
  const inputFd = openSync(inputPath, constants.O_RDONLY);
  const moduleFd = openSync(modulePath, constants.O_RDONLY);
  const targetFd = openSync(targetPath, constants.O_RDWR);
  const policy = bridgeContainmentPolicy();
  const child = spawn("python3", [
    runner,
    "generate",
    modulePath,
    "gen",
    "@fd:3",
    process.platform === "win32" ? targetPath : "/dev/fd/5",
  ], {
    windowsHide: true,
    detached: policy.detached,
    stdio: ["ignore", "ignore", "ignore", inputFd, moduleFd, targetFd, "pipe"],
    env: {
      ...process.env,
      SUPERPPT_BRIDGE_MODULE_FD: "4",
      SUPERPPT_BRIDGE_PID_MARKER: bridgeMarker,
      SUPERPPT_DESCENDANT_PID_MARKER: descendantMarker,
    },
  });
  closeSync(inputFd);
  closeSync(moduleFd);
  closeSync(targetFd);
  let bridgePid = 0;
  let descendantPid = 0;
  try {
    await waitFor(async () => {
      try {
        bridgePid = Number(await readFile(bridgeMarker, "utf8"));
        descendantPid = Number(await readFile(descendantMarker, "utf8"));
        return processExists(bridgePid) && processExists(descendantPid);
      } catch { return false; }
    }, 15_000);
    const streams: readonly unknown[] = child.stdio;
    const parentLiveness = streams[6];
    assert.ok(parentLiveness instanceof Writable);
    parentLiveness.destroy();
    await waitFor(async () => !processExists(bridgePid) && !processExists(descendantPid), 3_000);
  } finally {
    if (child.pid && processExists(child.pid)) {
      if (policy.killProcessGroup) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    }
    if (descendantPid > 0 && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
  }
});

test("uses a private review request and rejects non-exact reviewer JSON", async (t) => {
  const root = await directory(t, "superppt-review-");
  const image = join(root, "slide.png");
  await sharp({ create: { width: 16, height: 9, channels: 3, background: "#123456" } }).png().toFile(image);
  const privatePaths: string[] = [];
  const quality = await reviewSlide({
    runner,
    modulePath: fakeReviewer,
    callable: "check",
    image,
    requiredText: ["Title"],
    styleName: "Manifest Style",
    beforeExecute: async (privatePath) => {
      privatePaths.push(privatePath);
      assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
    },
  });
  assert.equal(QualityDecisionSchema.parse(quality).ok, true);
  await assert.rejects(reviewSlide({
    runner,
    modulePath: fakeReviewer,
    callable: "malformed",
    image,
    requiredText: ["Title"],
    styleName: "Manifest Style",
  }), /reviewer returned invalid quality JSON/);
  for (const path of privatePaths) await assert.rejects(access(path));
});

test("runs only stale or failed pages, isolates page errors, and stops after three attempts", async () => {
  const calls: string[] = [];
  const result = await runBatch({
    pages: [
      { id: "ready", status: "ready", prompt: "A", promptSha256: "a".repeat(64), output: "/unused/ready.png" },
      { id: "stale", status: "stale", prompt: "B", promptSha256: "b".repeat(64), output: "/tmp/stale.png" },
      { id: "isolated", status: "failed", prompt: "C", promptSha256: "c".repeat(64), output: "/tmp/isolated.png" },
    ],
    concurrency: 4,
    generate: async (page, attempt) => {
      calls.push(`${page.id}:${attempt}`);
      if (page.id === "isolated") throw new Error("isolated error");
      return { ok: true, output: page.output };
    },
    review: async (_page, attempt) => ({
      ok: false,
      issues: [`attempt ${attempt}`],
      requiredText: [],
      styleConsistent: false,
      hierarchyClear: false,
      richDetail: false,
      noForbiddenContent: true,
    }),
  });

  assert.deepEqual(calls.filter((call) => call.startsWith("stale")), ["stale:1", "stale:2", "stale:3"]);
  assert.equal(calls.some((call) => call.startsWith("ready")), false);
  assert.equal(calls.filter((call) => call.startsWith("isolated")).length, 3);
  assert.equal(result.pages.find((page) => page.id === "stale")?.status, "failed");
  assert.equal(result.pages.find((page) => page.id === "ready")?.status, "ready");
  assert.equal(result.pages.find((page) => page.id === "isolated")?.status, "failed");
  assert.equal(result.errors.length, 3);
});

test("rejects invalid concurrency before invoking a provider", async () => {
  let called = false;
  await assert.rejects(runBatch({
    pages: [{ id: "page", status: "stale", prompt: "A", promptSha256: "a".repeat(64), output: "/tmp/page.png" }],
    concurrency: 9,
    generate: async () => { called = true; return { ok: true, output: "/tmp/page.png" }; },
    review: async () => ({ ok: true, issues: [], requiredText: [], styleConsistent: true, hierarchyClear: true, richDetail: true, noForbiddenContent: true }),
  }), /concurrency must be between 1 and 8/);
  assert.equal(called, false);
});

test("quality decisions require exact self-consistency", () => {
  assert.throws(() => QualityDecisionSchema.parse({
    ok: true,
    issues: ["missing title"],
    requiredText: [],
    styleConsistent: true,
    hierarchyClear: true,
    richDetail: true,
    noForbiddenContent: true,
  }), /ok must equal/);
});

test("generates a gated project through the manifest-declared provider and retains every accepted ledger", async (t) => {
  const fixture = await approvedProject(t, "superppt-project-generation-");
  const result = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 2 });

  assert.equal(result.providerId, "openai-gpt-image-2");
  assert.equal(result.callCount, 3);
  assert.equal(result.reviewer, "dependency");
  const manifest = await readProject(fixture.root);
  assert.equal(manifest.stage, "generating");
  assert.deepEqual(manifest.slides.map(({ status }) => status), ["ready", "ready", "ready"]);
  assert.equal(await assertGateCurrent(fixture.root, "outline"), true);
  assert.equal(await assertGateCurrent(fixture.root, "slide-specs"), true);
  assert.equal(await assertGateCurrent(fixture.root, "style-sample"), true);
  for (const slide of manifest.slides) {
    const ledgerPath = join(fixture.root, "images", slide.id, "attempt-1", "ledger.json");
    const ledger = AttemptLedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
    assert.equal(ledger.providerId, "openai-gpt-image-2");
    assert.equal(ledger.revisionId, manifest.currentRevision.id);
    assert.equal(ledger.outcome, "accepted");
    assert.doesNotMatch(JSON.stringify(ledger), /private compiled visual director prompt/);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(ledgerPath, ".."))).mode & 0o777, 0o700);
  }
});

test("batch generation hashes each page's canonical spec recipe and director prompt", async (t) => {
  const fixture = await approvedProject(t, "superppt-canonical-batch-");
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 2 });
  const catalog = await loadBuiltInStyleCatalog();
  const style = catalog.styles.find(({ id }) => id === "cinematic-tech");
  assert.ok(style);

  for (const slideId of SLIDE_IDS) {
    const spec = JSON.parse(await readFile(join(fixture.root, "slides", slideId, "spec.json"), "utf8"));
    const expected = compileSlidePrompt({ spec, style });
    const ledger = AttemptLedgerSchema.parse(JSON.parse(await readFile(
      join(fixture.root, "images", slideId, "attempt-1", "ledger.json"),
      "utf8",
    )));
    assert.equal(ledger.promptSha256, expected.sha256, slideId);
  }
});

test("uses private manual QA when no reviewer exists and retries only one failed stable page", async (t) => {
  const fixture = await approvedProject(t, "superppt-manual-qa-");
  fixture.ai.reviewer = null;
  const generated = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 3 });
  assert.equal(generated.reviewer, "manual");
  assert.deepEqual((await readProject(fixture.root)).slides.map(({ status }) => status), ["generating", "generating", "generating"]);

  const accepted = {
    ok: true,
    issues: [],
    requiredText: [{ text: "Title", present: true, exact: true }],
    styleConsistent: true,
    hierarchyClear: true,
    richDetail: true,
    noForbiddenContent: true,
  };
  const rejected = { ...accepted, ok: false, issues: ["hierarchy needs repair"], hierarchyClear: false };
  const evidenceRoot = join(await directory(t, "superppt-manual-evidence-"), "qa");
  await mkdir(evidenceRoot, { mode: 0o700 });
  for (const [index, slideId] of SLIDE_IDS.entries()) {
    const input = join(evidenceRoot, `${slideId}.json`);
    await writeFile(input, JSON.stringify(index === 0 ? rejected : accepted), { mode: 0o600 });
    await chmod(input, 0o600);
    await recordManualQa({ root: fixture.root, slideId, input });
  }
  const beforeRetry = await readProject(fixture.root);
  assert.deepEqual(beforeRetry.slides.map(({ status }) => status), ["failed", "ready", "ready"]);
  const peerHashes = beforeRetry.slides.slice(1).map(({ image }) => image?.sha256);

  const retried = await retryProjectPage({ root: fixture.root, slideId: SLIDE_IDS[0], ai: fixture.ai, runner });
  assert.equal(retried.callCount, 1);
  const afterRetry = await readProject(fixture.root);
  assert.deepEqual(afterRetry.slides.map(({ status }) => status), ["generating", "ready", "ready"]);
  assert.deepEqual(afterRetry.slides.slice(1).map(({ image }) => image?.sha256), peerHashes);
  await access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-1", "ledger.json"));
  await access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-2", "ledger.json"));
});

test("rejects generation when any of the three planning gates is no longer current", async (t) => {
  const fixture = await approvedProject(t, "superppt-stale-gate-");
  await writeFile(join(fixture.root, "slides", SLIDE_IDS[0], "spec.json"), "{}\n");
  await assert.rejects(
    generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 }),
    /outline, slide-specs, and style-sample gates must be current/,
  );
  assert.equal((await readProject(fixture.root)).slides.length, 0);
});

test("deck generation refuses an existing provisional Style Lock", async (t) => {
  const fixture = await approvedProject(t, "superppt-provisional-style-lock-");
  await createProvisionalStyleLock(fixture.root, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [],
  });
  await assert.rejects(
    generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 }),
    /style lock must be approved before deck generation/,
  );
});

test("deck generation consumes the approved custom Style Lock rather than mutable selection", async (t) => {
  const recipe = (await loadBuiltInStyleCatalog()).styles.find(({ id }) => id === "cinematic-tech")!;
  const fixture = await approvedProject(t, "superppt-custom-style-lock-generation-", {
    selection: {
      kind: "custom",
      name: "Custom cinematic notes",
      description: "Warm handcrafted scientific cinematic direction.",
      recipe: { ...recipe, id: "custom-cinematic-notes", name: "Custom cinematic notes" },
    },
    referenceArtifacts: [],
  });
  await approveStyleLock(fixture.root);
  const result = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 });
  assert.equal(result.pageCount, 3);
  const ledger = AttemptLedgerSchema.parse(JSON.parse(await readFile(join(fixture.root, "images", SLIDE_IDS[0], "attempt-1", "ledger.json"), "utf8")));
  const lock = await readApprovedStyleLock(fixture.root);
  const expected = compileSlidePrompt({ spec: (await loadValidatedPlan(fixture.root)).specs[0]!, styleLock: lock });
  assert.equal(lock.recipe.id, "custom-cinematic-notes");
  assert.equal(ledger.promptSha256, expected.sha256);
});

test("manual QA requires a regular 0600 JSON file and exact reviewer schema", async (t) => {
  const fixture = await approvedProject(t, "superppt-manual-private-");
  fixture.ai.reviewer = null;
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 });
  const input = join(await directory(t, "superppt-manual-private-input-"), "qa.json");
  await writeFile(input, JSON.stringify({ ok: true }), { mode: 0o644 });
  await chmod(input, 0o644);
  await assert.rejects(recordManualQa({ root: fixture.root, slideId: SLIDE_IDS[0], input }), /manual QA input must have mode 0600/);
  await chmod(input, 0o600);
  const secret = "QA_INVALID_ERROR_SENTINEL";
  await writeFile(input, JSON.stringify({ unexpected: secret }));
  await assert.rejects(recordManualQa({ root: fixture.root, slideId: SLIDE_IDS[0], input }), (error: unknown) => {
    assert.match(String(error), /manual QA evidence is invalid/);
    assert.doesNotMatch(String(error), new RegExp(secret));
    assert.equal((error as Error).cause, undefined);
    return true;
  });
});

test("recovers an accepted manual ledger after a crash before manifest publication", async (t) => {
  const fixture = await approvedProject(t, "superppt-manual-recovery-");
  fixture.ai.reviewer = null;
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 2 });
  const input = join(await directory(t, "superppt-manual-recovery-input-"), "qa.json");
  await writeFile(input, JSON.stringify({
    ok: true,
    issues: [],
    requiredText: [{ text: "Title", present: true, exact: true }],
    styleConsistent: true,
    hierarchyClear: true,
    richDetail: true,
    noForbiddenContent: true,
  }), { mode: 0o600 });
  await chmod(input, 0o600);
  await assert.rejects(recordManualQa({
    root: fixture.root,
    slideId: SLIDE_IDS[0],
    input,
    afterLedgerWritten: async () => { throw new Error("injected after ledger"); },
  }), /injected after ledger/);
  assert.equal((await readProject(fixture.root)).slides[0]!.status, "generating");

  const resumed = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 2 });
  assert.equal(resumed.pages.find(({ id }) => id === SLIDE_IDS[0])?.status, "ready");
  assert.equal(resumed.callCount, 0);
  await assert.rejects(access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-2")));
});

test("CLI generate prints its provider disclosure before state-changing results", async (t) => {
  const fixture = await approvedProject(t, "superppt-generation-cli-");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "generate",
    "--project", fixture.root,
    "--concurrency", "2",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: fixture.ai.root,
      SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: fixture.editableRoot,
    },
  });
  assert.equal(stderr, "");
  const documents = stdout.trim().split(/\n(?=\{)/).map((value) => JSON.parse(value) as Record<string, unknown>);
  assert.equal(documents.length, 2);
  assert.deepEqual(documents[0], {
    event: "generation-plan",
    providerId: "openai-gpt-image-2",
    pageCount: 3,
    callCount: 9,
    outputRoot: join(fixture.root, "images"),
    reviewer: "dependency",
  });
  assert.equal(documents[1]!.callCount, 3);
});

test("CLI no longer executes a direct style-sample provider call", async (t) => {
  const fixture = await approvedProject(t, "superppt-style-sample-cli-");
  const callCounter = join(await directory(t, "superppt-style-sample-counter-"), "calls.log");
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const environment = {
    ...process.env,
    SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: fixture.ai.root,
    SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: fixture.editableRoot,
    SUPERPPT_TEST_CALL_COUNTER: callCounter,
  };
  const run = (args: string[]) => execFileAsync(process.execPath, [...invocation, ...args], {
    cwd: process.cwd(),
    env: environment,
  });

  await assert.rejects(run(["generate-style-sample", "--project", fixture.root]), /unknown command/i);
  await assert.rejects(access(callCounter), { code: "ENOENT" }, "the deprecated command must not reach a provider");
});

test("CLI record-qa and retry-page use manual evidence without regenerating peers", async (t) => {
  const fixture = await approvedProject(t, "superppt-manual-cli-");
  fixture.ai.reviewer = null;
  const capabilitiesPath = join(fixture.ai.root, "references", "capabilities.json");
  const capabilities = JSON.parse(await readFile(capabilitiesPath, "utf8")) as Record<string, unknown>;
  capabilities.reviewer = null;
  await writeFile(capabilitiesPath, JSON.stringify(capabilities));
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 3 });

  const evidenceRoot = await directory(t, "superppt-manual-cli-evidence-");
  const rejectedPath = join(evidenceRoot, "rejected.json");
  await writeFile(rejectedPath, JSON.stringify({
    ok: false,
    issues: ["QA_CLI_SECRET_SENTINEL repair hierarchy"],
    requiredText: [{ text: "Title", present: true, exact: true }],
    styleConsistent: true,
    hierarchyClear: false,
    richDetail: true,
    noForbiddenContent: true,
  }), { mode: 0o600 });
  await chmod(rejectedPath, 0o600);
  const env = {
    ...process.env,
    SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: fixture.ai.root,
    SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: fixture.editableRoot,
  };
  const recorded = await execFileAsync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "record-qa",
    "--project", fixture.root,
    "--slide", SLIDE_IDS[0],
    "--input", rejectedPath,
  ], { cwd: process.cwd(), env });
  assert.equal(recorded.stderr, "");
  assert.deepEqual(JSON.parse(recorded.stdout), {
    slideId: SLIDE_IDS[0],
    status: "failed",
    ok: false,
    passedChecks: 4,
    totalChecks: 5,
  });
  assert.doesNotMatch(recorded.stdout, /QA_CLI_SECRET_SENTINEL|repair hierarchy|Title|issues|requiredText/);
  const before = await readProject(fixture.root);
  assert.equal(before.slides[0]!.status, "failed");
  const peerLedger = await readFile(join(fixture.root, "images", SLIDE_IDS[1], "attempt-1", "ledger.json"));

  const retried = await execFileAsync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "retry-page",
    "--project", fixture.root,
    "--slide", SLIDE_IDS[0],
  ], { cwd: process.cwd(), env });
  assert.equal(retried.stderr, "");
  assert.match(retried.stdout, /"pageCount": 1/);
  await access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-2", "ledger.json"));
  assert.deepEqual(await readFile(join(fixture.root, "images", SLIDE_IDS[1], "attempt-1", "ledger.json")), peerLedger);
});

test("ordinary resume leaves generated attempts awaiting manual QA without consuming another attempt", async (t) => {
  const fixture = await approvedProject(t, "superppt-awaiting-manual-");
  fixture.ai.reviewer = null;
  const first = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 3 });
  assert.equal(first.callCount, 3);
  const resumed = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 3 });
  assert.equal(resumed.callCount, 0);
  for (const slideId of SLIDE_IDS) {
    await access(join(fixture.root, "images", slideId, "attempt-1", "ledger.json"));
    await assert.rejects(access(join(fixture.root, "images", slideId, "attempt-2")));
  }
});

test("does not trust accepted recovery when the fixed image is missing or tampered", async (t) => {
  const fixture = await approvedProject(t, "superppt-recovery-auth-");
  fixture.ai.reviewer = null;
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 3 });
  const inputRoot = await directory(t, "superppt-recovery-auth-input-");
  const input = join(inputRoot, "qa.json");
  const accepted = {
    ok: true,
    issues: [],
    requiredText: [{ text: "Title", present: true, exact: true }],
    styleConsistent: true,
    hierarchyClear: true,
    richDetail: true,
    noForbiddenContent: true,
  };
  await writeFile(input, JSON.stringify(accepted), { mode: 0o600 });
  await chmod(input, 0o600);
  for (const slideId of SLIDE_IDS.slice(0, 2)) {
    await assert.rejects(recordManualQa({
      root: fixture.root,
      slideId,
      input,
      afterLedgerWritten: async () => { throw new Error("injected accepted-ledger crash"); },
    }), /injected accepted-ledger crash/);
  }
  await unlink(join(fixture.root, "images", SLIDE_IDS[0], "attempt-1", "slide.png"));
  await writeFile(join(fixture.root, "images", SLIDE_IDS[1], "attempt-1", "slide.png"), "tampered");

  const resumed = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 2 });
  assert.equal(resumed.pages.find(({ id }) => id === SLIDE_IDS[0])?.status, "generating");
  assert.equal(resumed.pages.find(({ id }) => id === SLIDE_IDS[1])?.status, "generating");
  assert.equal(resumed.callCount, 2);
  await access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-2", "ledger.json"));
  await access(join(fixture.root, "images", SLIDE_IDS[1], "attempt-2", "ledger.json"));
  await assert.rejects(access(join(fixture.root, "images", SLIDE_IDS[2], "attempt-2")));
});

test("persists only hashed non-secret QA evidence", async (t) => {
  const fixture = await approvedProject(t, "superppt-qa-evidence-");
  fixture.ai.reviewer = { module: "scripts/reviewer.py", callable: "check" };
  await writeFile(join(fixture.ai.root, "scripts", "reviewer.py"), await readFile(fakeReviewer));
  fixture.ai.reviewer.callable = "check";
  const input = join(await directory(t, "superppt-qa-evidence-input-"), "qa.json");
  await writeFile(input, JSON.stringify({
    ok: false,
    issues: ["QA_SECRET_SENTINEL manual issue"],
    requiredText: [{ text: "Title", present: true, exact: true }],
    styleConsistent: true,
    hierarchyClear: false,
    richDetail: true,
    noForbiddenContent: true,
  }), { mode: 0o600 });
  await chmod(input, 0o600);
  fixture.ai.reviewer = null;
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 });
  const summary = await recordManualQa({ root: fixture.root, slideId: SLIDE_IDS[0], input });
  const ledgerBytes = await readFile(join(fixture.root, "images", SLIDE_IDS[0], "attempt-1", "ledger.json"), "utf8");
  assert.doesNotMatch(ledgerBytes, /QA_SECRET_SENTINEL|manual issue|"text"\s*:\s*"Title"/);
  const ledger = AttemptLedgerSchema.parse(JSON.parse(ledgerBytes));
  assert.equal(ledger.quality?.issueCount, 1);
  assert.equal(ledger.quality?.issueHashes.length, 1);
  assert.equal(ledger.quality?.requiredText[0]?.textSha256.length, 64);
  assert.doesNotMatch(JSON.stringify(summary), /QA_SECRET_SENTINEL|manual issue|Title/);
});

test("terminates an oversized provider during execution and isolates a concurrent normal call", async (t) => {
  const root = await directory(t, "superppt-provider-cap-");
  const oversized = join(root, "oversized.py");
  await writeFile(oversized, "def gen(prompt, out_path, retries=0):\n f=open(out_path,'wb')\n while True: f.write(b'x' * 1048576); f.flush()\n");
  const started = performance.now();
  const [failed, succeeded] = await Promise.allSettled([
    generateSlide({ runner, modulePath: oversized, callable: "gen", prompt: "private oversized", output: join(root, "too-big.png"), attempt: 1, timeoutMs: 10_000 }),
    generateSlide({ runner, modulePath: fakeProvider, callable: "gen", prompt: "private normal", output: join(root, "normal.png"), attempt: 1, timeoutMs: 10_000 }),
  ]);
  assert.equal(failed.status, "rejected");
  assert.equal(succeeded.status, "fulfilled");
  assert.ok(performance.now() - started < 5_000);
  assert.equal((await sharp(join(root, "normal.png")).metadata()).width, 1920);
  assert.deepEqual((await readdir(root)).filter((name) => name.includes("provider-image")), []);
  assert.deepEqual(await readdir(join(root, ".private")), []);
});

test("private security policy keeps exact POSIX modes but does not require them on Windows", () => {
  assert.deepEqual(privateSecurityPolicy("darwin"), { directoryMode: 0o700, fileMode: 0o600, requireExactMode: true, transport: "unlinked-regular-file" });
  assert.deepEqual(privateSecurityPolicy("linux"), { directoryMode: 0o700, fileMode: 0o600, requireExactMode: true, transport: "unlinked-regular-file" });
  assert.deepEqual(privateSecurityPolicy("win32"), { directoryMode: undefined, fileMode: undefined, requireExactMode: false, transport: "anonymous-pipe" });
});

test("crash resume derives a new corrective prompt from sanitized retained evidence", async (t) => {
  const fixture = await approvedProject(t, "superppt-corrective-resume-");
  await writeFile(
    join(fixture.ai.root, "scripts", "reviewer.py"),
    `${await readFile(fakeReviewer, "utf8")}\ncheck = reject_with_sensitive_issue\n`,
  );
  let injected = false;
  await assert.rejects(generateProject({
    root: fixture.root,
    ai: fixture.ai,
    runner,
    concurrency: 1,
    operations: {
      afterAttemptPromoted: async (pageId, attempt) => {
        if (!injected && pageId === SLIDE_IDS[0] && attempt === 1) {
          injected = true;
          throw new Error("injected rejected-attempt crash");
        }
      },
    },
  }), /injected rejected-attempt crash/);

  const resumed = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 });
  assert.equal(resumed.callCount, 8);
  const first = AttemptLedgerSchema.parse(JSON.parse(await readFile(join(fixture.root, "images", SLIDE_IDS[0], "attempt-1", "ledger.json"), "utf8")));
  const second = AttemptLedgerSchema.parse(JSON.parse(await readFile(join(fixture.root, "images", SLIDE_IDS[0], "attempt-2", "ledger.json"), "utf8")));
  assert.notEqual(first.promptSha256, second.promptSha256);
  for (const slideId of SLIDE_IDS) {
    for (const attempt of [1, 2, 3]) {
      const path = join(fixture.root, "images", slideId, `attempt-${attempt}`, "ledger.json");
      try { assert.doesNotMatch(await readFile(path, "utf8"), /QA_SECRET_SENTINEL|hierarchy needs repair|"text"\s*:\s*"Title"/); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
});
