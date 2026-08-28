import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fsyncSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import type { AiImageSkillDependency } from "../dependencies/schemas.js";
import { AiImageSkillDependencySchema } from "../dependencies/schemas.js";
import { assertGateCurrent } from "../planning/confirm.js";
import { loadValidatedPlan } from "../planning/load.js";
import { SlideSpecSchema } from "../planning/schemas.js";
import { validateExecutionGateEvidence, validateOrdinaryGateEvidence } from "../project/evidence.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile, readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { canonicalStyleSample } from "../styles/sample-contract.js";
import { compileSlidePrompt } from "../styles/prompt-compiler.js";
import { readApprovedStyleLock, readStyleLock, type LockedStyle } from "../styles/style-lock.js";
import { StyleLockSchema, StyleRecipeSchema } from "../styles/schemas.js";
import { openGenerationDirectory } from "./anchored-dir.js";
import {
  CallLedgerEntrySchema,
  GenerationCallTupleSchema,
  GenerationAuthorizationPlanSchema,
  ImageGenerationJobSchema,
  canonicalContractFile,
  type CallLedgerEntry,
  type GenerationCallTuple,
  type GenerationAuthorizationPlan,
  type ImageGenerationJob,
  type ImageJobKind,
} from "./job-schemas.js";
import {
  appendTrustedGenerationCallLedgerEntry,
  assertTrustedCallEventJobBinding,
  assertTrustedGenerationAuthorizationCurrent,
  assertTrustedGenerationAuthorizationRecord,
  readTrustedGenerationCallLedger,
  trustedGenerationAuthorizationForGate,
  type TrustedGenerationCallEvent,
} from "./trusted-authorization.js";

const DECK_PLAN_PATH = "generation/authorization-plan.json";
const SAMPLE_PLAN_PATH = "style/sample/generation-plan.json";
const execFileAsync = promisify(execFile);

const REQUIRED_AI_SCRIPTS = {
  generationResult: "generation_result.py",
  hostRoutingPolicy: "host_routing_policy.py",
  importHostImage: "import_host_image.py",
  prepareEditableInput: "prepare_editable_input.py",
} as const;

type PlanPublicationRequest = {
  aiDependency: AiImageSkillDependency;
  callBudget: number;
};

export type GenerationExecutionResult<T> =
  | { executed: true; outcome: "success"; value: T; consumed: number; remaining: number }
  | { executed: false; outcome: "in-flight" | "success" | "failed"; consumed: number; remaining: number };

export type DelegatedGenerationAdmission = GenerationCallTuple & {
  admissionToken: string;
  consumed: number;
  remaining: number;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function aiSkillBinding(ai: AiImageSkillDependency): ImageGenerationJob["aiSkill"] {
  return {
    root: ai.root,
    skillSha256: ai.skillSha256,
    gitRevision: ai.gitRevision,
    scripts: {
      generationResult: { path: ai.scripts.generationResult, sha256: ai.scriptSha256.generationResult },
      hostRoutingPolicy: { path: ai.scripts.hostRoutingPolicy, sha256: ai.scriptSha256.hostRoutingPolicy },
      importHostImage: { path: ai.scripts.importHostImage, sha256: ai.scriptSha256.importHostImage },
      prepareEditableInput: { path: ai.scripts.prepareEditableInput, sha256: ai.scriptSha256.prepareEditableInput },
    },
  };
}

async function assertPhysicalFileIdentity(root: string, path: string, expectedSha256: string): Promise<void> {
  const relation = relative(root, path);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("ai-image-to-ppt Skill identity changed");
  }
  const info = await lstat(path).catch((error: unknown) => {
    throw new Error("ai-image-to-ppt Skill identity changed", { cause: error });
  });
  if (info.isSymbolicLink() || !info.isFile() || await realpath(path) !== path) {
    throw new Error("ai-image-to-ppt Skill identity changed");
  }
  if (sha256(await readRegularFileNoFollow(path)) !== expectedSha256) {
    throw new Error("ai-image-to-ppt Skill identity changed");
  }
}

async function assertGitRevisionCurrent(root: string, expected: string | null): Promise<void> {
  if (expected === null) return;
  let current: string;
  try {
    current = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  } catch (error: unknown) {
    throw new Error("ai-image-to-ppt Skill Git revision changed", { cause: error });
  }
  if (current !== expected) throw new Error("ai-image-to-ppt Skill Git revision changed");
}

export async function assertAiImageSkillDependencyCurrent(raw: AiImageSkillDependency): Promise<AiImageSkillDependency> {
  const ai = AiImageSkillDependencySchema.parse(raw);
  const rootInfo = await lstat(ai.root).catch((error: unknown) => {
    throw new Error("ai-image-to-ppt Skill identity changed", { cause: error });
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(ai.root) !== ai.root) {
    throw new Error("ai-image-to-ppt Skill identity changed");
  }
  if (ai.skillFile !== join(ai.root, "SKILL.md")) throw new Error("ai-image-to-ppt Skill identity changed");
  const skillBytes = await readRegularFileNoFollow(ai.skillFile);
  if (sha256(skillBytes) !== ai.skillSha256) throw new Error("ai-image-to-ppt Skill identity changed");
  for (const [name, filename] of Object.entries(REQUIRED_AI_SCRIPTS) as Array<[
    keyof typeof REQUIRED_AI_SCRIPTS,
    string,
  ]>) {
    const script = ai.scripts[name];
    if (script !== join(ai.root, "scripts", filename)) throw new Error("ai-image-to-ppt Skill identity changed");
    await assertPhysicalFileIdentity(ai.root, script, ai.scriptSha256[name]);
  }
  await assertGitRevisionCurrent(ai.root, ai.gitRevision);
  return ai;
}

async function assertAiSkillBindingCurrent(binding: ImageGenerationJob["aiSkill"]): Promise<void> {
  const info = await lstat(binding.root).catch((error: unknown) => {
    throw new Error("ai-image-to-ppt Skill identity changed", { cause: error });
  });
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(binding.root) !== binding.root) {
    throw new Error("ai-image-to-ppt Skill identity changed");
  }
  const skillFile = join(binding.root, "SKILL.md");
  if (sha256(await readRegularFileNoFollow(skillFile)) !== binding.skillSha256) {
    throw new Error("ai-image-to-ppt Skill identity changed");
  }
  for (const [name, filename] of Object.entries(REQUIRED_AI_SCRIPTS) as Array<[
    keyof typeof REQUIRED_AI_SCRIPTS,
    string,
  ]>) {
    const script = binding.scripts[name];
    if (script.path !== join(binding.root, "scripts", filename)) throw new Error("ai-image-to-ppt Skill identity changed");
    await assertPhysicalFileIdentity(binding.root, script.path, script.sha256);
  }
  await assertGitRevisionCurrent(binding.root, binding.gitRevision);
}

async function requirePlanningGates(root: string, includeStyleSample: boolean): Promise<void> {
  if (!await assertGateCurrent(root, "outline") || !await assertGateCurrent(root, "slide-specs")) {
    throw new Error("outline and slide-specs gates must be current before generation authorization");
  }
  if (includeStyleSample && !await assertGateCurrent(root, "style-sample")) {
    throw new Error("style-sample gate must be current before generation authorization");
  }
}

function writeFixedPlan(root: string, projectPath: typeof DECK_PLAN_PATH | typeof SAMPLE_PLAN_PATH, bytes: string): void {
  const project = openGenerationDirectory(root);
  let first: ReturnType<typeof openGenerationDirectory> | undefined;
  let second: ReturnType<typeof openGenerationDirectory> | undefined;
  try {
    if (projectPath === DECK_PLAN_PATH) {
      first = project.child("generation");
      if (project.fd >= 0) fsyncSync(project.fd);
      first.replace("authorization-plan.json", bytes, `.authorization-plan-${randomUUID()}.staging`);
    } else {
      first = project.child("style", false);
      second = first.child("sample", false);
      second.replace("generation-plan.json", bytes, `.generation-plan-${randomUUID()}.staging`);
    }
  } finally {
    second?.close();
    first?.close();
    project.close();
  }
}

function basePlan(options: {
  kind: ImageJobKind;
  projectId: string;
  projectRevisionId: string;
  aiDependency: AiImageSkillDependency;
  lock: LockedStyle;
  callBudget: number;
  pages: GenerationAuthorizationPlan["pages"];
  previousAuthorizationDigest?: string | null;
  previousPromptSha256?: string | null;
}): GenerationAuthorizationPlan {
  return GenerationAuthorizationPlanSchema.parse({
    contractVersion: 1,
    kind: options.kind,
    projectId: options.projectId,
    projectRevisionId: options.projectRevisionId,
    aiSkill: aiSkillBinding(options.aiDependency),
    styleLockPath: "style/lock.json",
    styleLockSha256: options.lock.styleLockSha256,
    callBudget: options.callBudget,
    outboundDisclosure: { sendsText: true, references: options.lock.referenceArtifacts },
    pages: options.pages,
    previousAuthorizationDigest: options.previousAuthorizationDigest ?? null,
    previousPromptSha256: options.previousPromptSha256 ?? null,
    createdAt: new Date().toISOString(),
  });
}

export async function publishGenerationAuthorizationPlan(
  root: string,
  request: PlanPublicationRequest,
): Promise<GenerationAuthorizationPlan> {
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    await requirePlanningGates(canonicalRoot, true);
    const [ai, manifest, lock, plan] = await Promise.all([
      assertAiImageSkillDependencyCurrent(request.aiDependency),
      readProject(canonicalRoot),
      readApprovedStyleLock(canonicalRoot),
      loadValidatedPlan(canonicalRoot),
    ]);
    const pages = plan.specs.map((spec, index) => ({
      slideId: spec.slideId,
      order: plan.outline.slides.find(({ id }) => id === spec.slideId)?.order ?? index,
      promptSha256: compileSlidePrompt({ spec, styleLock: lock }).sha256,
    }));
    const published = basePlan({
      kind: "deck",
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      aiDependency: ai,
      lock,
      callBudget: request.callBudget,
      pages,
    });
    await requirePlanningGates(canonicalRoot, true);
    const current = await readProject(canonicalRoot);
    if (current.currentRevision.id !== manifest.currentRevision.id) throw new Error("project revision changed during generation authorization publication");
    writeFixedPlan(canonicalRoot, DECK_PLAN_PATH, canonicalContractFile(published));
    return published;
  });
}

export async function publishStyleSampleGenerationPlan(
  root: string,
  request: PlanPublicationRequest,
): Promise<GenerationAuthorizationPlan> {
  if (request.callBudget !== 1) throw new Error("style-sample call budget must be exactly 1");
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    await requirePlanningGates(canonicalRoot, false);
    const [ai, manifest, lock, sample, plan] = await Promise.all([
      assertAiImageSkillDependencyCurrent(request.aiDependency),
      readProject(canonicalRoot),
      readStyleLock(canonicalRoot),
      canonicalStyleSample(canonicalRoot),
      loadValidatedPlan(canonicalRoot),
    ]);
    if (lock.approvalState !== "provisional") throw new Error("style-sample generation requires a provisional style lock");
    const order = plan.outline.slides.find(({ id }) => id === sample.spec.slideId)?.order;
    if (order === undefined) throw new Error("representative slide is not ordered in the current plan");
    const published = basePlan({
      kind: "style-sample",
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      aiDependency: ai,
      lock,
      callBudget: 1,
      pages: [{ slideId: sample.spec.slideId, order, promptSha256: sample.compiled.sha256 }],
    });
    writeFixedPlan(canonicalRoot, SAMPLE_PLAN_PATH, canonicalContractFile(published));
    return published;
  });
}

export async function publishPageRegenerationAuthorizationPlan(root: string, request: {
  aiDependency: AiImageSkillDependency;
  slideId: string;
  previousPromptSha256: string;
  finalPrompt: string;
  callBudget: number;
}): Promise<GenerationAuthorizationPlan> {
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    await requirePlanningGates(canonicalRoot, true);
    const [ai, manifest, lock, plan, currentAuthorization] = await Promise.all([
      assertAiImageSkillDependencyCurrent(request.aiDependency),
      readProject(canonicalRoot),
      readApprovedStyleLock(canonicalRoot),
      loadValidatedPlan(canonicalRoot),
      readCurrentAuthorizedPlan(canonicalRoot, "deck"),
    ]);
    const specIndex = plan.specs.findIndex(({ slideId }) => slideId === request.slideId);
    if (specIndex < 0) throw new Error("page-regeneration slide is not in the current plan");
    await assertPreviousPromptPublished(
      canonicalRoot,
      request.slideId,
      request.previousPromptSha256,
      currentAuthorization.digest,
    );
    const promptSha256 = sha256(request.finalPrompt);
    if (promptSha256 === request.previousPromptSha256) throw new Error("page-regeneration requires a new prompt hash");
    const published = basePlan({
      kind: "page-regeneration",
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      aiDependency: ai,
      lock,
      callBudget: request.callBudget,
      pages: [{
        slideId: request.slideId,
        order: plan.outline.slides.find(({ id }) => id === request.slideId)!.order,
        promptSha256,
      }],
      previousAuthorizationDigest: currentAuthorization.digest,
      previousPromptSha256: request.previousPromptSha256,
    });
    writeFixedPlan(canonicalRoot, DECK_PLAN_PATH, canonicalContractFile(published));
    return published;
  });
}

function parsePlan(bytes: Buffer, label: string): GenerationAuthorizationPlan {
  try {
    const parsed = GenerationAuthorizationPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (bytes.toString("utf8") !== canonicalContractFile(parsed)) throw new Error(`${label} is not canonical`);
    return parsed;
  } catch (error: unknown) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
}

async function assertStyleSampleExecutionGate(root: string, bytes: Buffer): Promise<void> {
  const manifest = await readProject(root);
  const gate = [...manifest.gates].reverse().find((candidate) =>
    candidate.gate === "style-sample-generation" && candidate.revisionId === manifest.currentRevision.id
  );
  if (!gate) throw new Error("style sample generation authorization is absent");
  try {
    await validateExecutionGateEvidence(root, manifest, gate);
  } catch (error: unknown) {
    throw new Error("style sample generation authorization is stale", { cause: error });
  }
  if (gate.artifactHashes[SAMPLE_PLAN_PATH] !== sha256(bytes)) {
    throw new Error("style sample generation authorization is stale");
  }
}

export async function readCurrentAuthorizedPlan(
  root: string,
  kind: ImageJobKind,
): Promise<{ plan: GenerationAuthorizationPlan; bytes: Buffer; digest: string }> {
  const path = kind === "style-sample" ? SAMPLE_PLAN_PATH : DECK_PLAN_PATH;
  let bytes: Buffer;
  try {
    bytes = await readOwnedRegularFile(root, path);
  } catch (error: unknown) {
    throw new Error(kind === "style-sample"
      ? "style sample generation authorization is absent"
      : "generation authorization is absent", { cause: error });
  }
  if (kind === "style-sample") {
    await requirePlanningGates(root, false);
    await assertStyleSampleExecutionGate(root, bytes);
  } else if (!await assertGateCurrent(root, "generation-authorization")) {
    throw new Error("generation authorization is absent or stale");
  }
  const plan = parsePlan(bytes, kind === "style-sample" ? "style sample generation plan" : "generation authorization plan");
  const manifest = await readProject(root);
  if (plan.projectId !== manifest.projectId || plan.projectRevisionId !== manifest.currentRevision.id) {
    throw new Error("generation authorization does not bind the current project revision");
  }
  return { plan, bytes, digest: sha256(bytes) };
}

async function readJob(root: string, jobId: string): Promise<ImageGenerationJob> {
  const path = `generation/jobs/${jobId}/job.json`;
  let bytes: Buffer;
  try {
    bytes = await readOwnedRegularFile(root, path);
  } catch (error: unknown) {
    throw new Error("immutable image generation job is unavailable", { cause: error });
  }
  try {
    const job = ImageGenerationJobSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (job.jobId !== jobId || bytes.toString("utf8") !== canonicalContractFile(job)) {
      throw new Error("job identity or canonical bytes differ");
    }
    return job;
  } catch (error: unknown) {
    throw new Error("immutable image generation job is invalid", { cause: error });
  }
}

async function listPublishedJobs(root: string): Promise<ImageGenerationJob[]> {
  const jobsRoot = join(root, "generation", "jobs");
  let entries;
  try {
    entries = await import("node:fs/promises").then(({ readdir }) => readdir(jobsRoot, { withFileTypes: true }));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: ImageGenerationJob[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.name.startsWith("."))) {
      throw new Error("generation jobs directory contains an unsafe entry");
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) jobs.push(await readJob(root, entry.name));
  }
  return jobs;
}

export async function assertPreviousPromptPublished(
  root: string,
  slideId: string,
  promptSha256: string,
  authorizationDigest?: string,
): Promise<void> {
  const jobs = await listPublishedJobs(root);
  if (!jobs.some((job) =>
    (authorizationDigest === undefined || job.authorizationDigest === authorizationDigest)
    && job.pages.some((page) => page.slideId === slideId && page.promptSha256 === promptSha256)
  )) {
    throw new Error("page-regeneration previous prompt hash is not an immutable published job prompt");
  }
}

export async function assertAuthorizedJobBinding(root: string, job: ImageGenerationJob): Promise<void> {
  const current = await readJob(root, job.jobId);
  if (!sameJson(current, job)) throw new Error("immutable image generation job changed after publication");
  await assertAiSkillBindingCurrent(job.aiSkill);
  await assertSealedJobInputs(root, job);
  const manifest = await readProject(root);
  if (manifest.currentRevision.id === job.projectRevisionId) {
    const currentLock = job.kind === "style-sample" ? await readStyleLock(root) : await readApprovedStyleLock(root);
    if (job.kind !== "style-sample" || currentLock.approvalState === "provisional") {
      const { styleLockSha256, ...embeddedStyleLock } = currentLock;
      if (styleLockSha256 !== job.styleLockSha256 || !sameJson(embeddedStyleLock, job.styleLock)) {
        throw new Error("image generation job style lock changed after publication");
      }
    }
  }
  for (const page of job.pages) {
    const prompt = await readOwnedRegularFile(root, page.promptArtifact).catch((error: unknown) => {
      throw new Error("job prompt artifact changed after publication", { cause: error });
    });
    if (prompt.toString("utf8") !== page.finalPrompt || sha256(prompt) !== page.promptSha256) {
      throw new Error("job prompt artifact hash changed after publication");
    }
  }
  const plan = GenerationAuthorizationPlanSchema.parse(job.authorizationPlan);
  const digest = sha256(canonicalContractFile(plan));
  if (job.authorizationDigest !== digest) throw new Error("image generation job authorization snapshot is invalid");
  await assertJobAuthorizationGate(root, job, plan, digest, manifest);
  if (
    job.projectId !== plan.projectId
    || job.projectRevisionId !== plan.projectRevisionId
    || !sameJson(job.aiSkill, plan.aiSkill)
    || job.styleLockSha256 !== plan.styleLockSha256
    || job.callBudget !== plan.callBudget
    || !sameJson(job.outboundDisclosure, plan.outboundDisclosure)
  ) throw new Error("image generation job does not match its authorization");
  if (plan.kind === job.kind) {
    if (!sameJson(job.pages.map(({ slideId, order, promptSha256 }) => ({ slideId, order, promptSha256 })), plan.pages)) {
      throw new Error("image generation job prompts do not match their authorization");
    }
  } else if (job.kind !== "page-regeneration" || plan.kind !== "deck") {
    throw new Error("image generation job kind does not match its authorization");
  }
  if (job.kind === "page-regeneration") {
    const page = job.pages[0]!;
    if (plan.kind === "page-regeneration") {
      await assertPreviousPromptPublished(root, page.slideId, plan.previousPromptSha256!, plan.previousAuthorizationDigest!);
    } else {
      const original = plan.pages.find(({ slideId }) => slideId === page.slideId);
      if (!original || original.promptSha256 === page.promptSha256) {
        throw new Error("page-regeneration requires a new prompt hash");
      }
      if (original.order !== page.order) {
        throw new Error("page-regeneration order does not match deck authorization");
      }
      await assertPreviousPromptPublished(root, page.slideId, original.promptSha256, digest);
    }
  }
}

async function assertJobAuthorizationGate(
  root: string,
  job: ImageGenerationJob,
  plan: GenerationAuthorizationPlan,
  digest: string,
  manifest: Awaited<ReturnType<typeof readProject>>,
): Promise<void> {
  const expectedGate = job.kind === "style-sample" ? "style-sample-generation" : "generation-authorization";
  const binding = job.authorizationGate;
  if (binding.gate !== expectedGate || binding.authorizationPlanSha256 !== digest) {
    throw new Error("image generation job authorization gate binding is invalid");
  }
  const gate = manifest.gates.find((candidate) => candidate.approvalId === binding.approvalId);
  if (
    !gate
    || gate.gate !== expectedGate
    || gate.revisionId !== job.projectRevisionId
    || gate.snapshotPath !== binding.snapshotPath
    || gate.snapshotManifestSha256 !== binding.snapshotManifestSha256
  ) throw new Error("image generation job authorization gate evidence is unavailable");
  const planPath = job.kind === "style-sample" ? SAMPLE_PLAN_PATH : DECK_PLAN_PATH;
  const evidence = expectedGate === "style-sample-generation"
    ? await validateExecutionGateEvidence(root, manifest, gate)
    : await validateOrdinaryGateEvidence(root, manifest, gate);
  const bytes = evidence.artifacts[planPath];
  if (!bytes || sha256(bytes) !== binding.authorizationPlanSha256) {
    throw new Error("image generation job authorization gate artifact changed");
  }
  const evidencePlan = parsePlan(bytes, "immutable generation authorization gate artifact");
  if (!sameJson(evidencePlan, plan)) throw new Error("image generation job authorization does not match its gate evidence");
  if (expectedGate === "generation-authorization") {
    if (!job.authorizationTrust) throw new Error("image generation job has no trusted authorization record");
    if (!("presentation" in evidence.descriptor)) throw new Error("generation authorization gate evidence is not ordinary approval evidence");
    await assertTrustedGenerationAuthorizationRecord(root, job.authorizationTrust, plan, binding, evidence.descriptor);
  } else if (job.authorizationTrust !== null) {
    throw new Error("style-sample image generation job cannot carry deck authorization trust");
  }
}

export async function assertSealedJobInputs(root: string, job: ImageGenerationJob): Promise<void> {
  const readSealed = async (path: string, expectedSha256: string, label: string): Promise<Buffer> => {
    let bytes: Buffer;
    try { bytes = await readOwnedRegularFile(root, path); } catch (error: unknown) {
      throw new Error(`sealed image generation ${label} is unavailable`, { cause: error });
    }
    if (sha256(bytes) !== expectedSha256) throw new Error(`sealed image generation ${label} hash changed`);
    return bytes;
  };
  const lockBytes = await readSealed(job.sealedInputs.styleLock.path, job.sealedInputs.styleLock.sha256, "Style Lock");
  const recipeBytes = await readSealed(job.sealedInputs.styleRecipe.path, job.sealedInputs.styleRecipe.sha256, "style recipe");
  let sealedLock;
  let sealedRecipe;
  try {
    sealedLock = StyleLockSchema.parse(JSON.parse(lockBytes.toString("utf8")));
    sealedRecipe = StyleRecipeSchema.parse(JSON.parse(recipeBytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("sealed image generation style inputs are invalid", { cause: error });
  }
  if (!sameJson(sealedLock, job.styleLock) || !sameJson(sealedRecipe, job.styleLock.recipe)) {
    throw new Error("sealed image generation style inputs conflict with the immutable job");
  }
  if (job.sealedInputs.approvedSample) {
    await readSealed(job.sealedInputs.approvedSample.path, job.sealedInputs.approvedSample.sha256, "approved sample");
  }
  for (const [index, reference] of job.sealedInputs.references.entries()) {
    await readSealed(reference.snapshot.path, reference.snapshot.sha256, `reference ${index + 1}`);
  }
  for (const page of job.pages) {
    const specBytes = await readSealed(page.specSnapshot.path, page.specSnapshot.sha256, `slide spec ${page.slideId}`);
    let spec;
    try { spec = SlideSpecSchema.parse(JSON.parse(specBytes.toString("utf8"))); } catch (error: unknown) {
      throw new Error("sealed image generation slide spec is invalid", { cause: error });
    }
    if (!sameJson(spec, page.spec)) throw new Error("sealed image generation slide spec conflicts with the immutable job");
  }
}

async function authenticatedCallLedger(root: string): Promise<{
  entries: CallLedgerEntry[];
  events: TrustedGenerationCallEvent[];
}> {
  const trusted = await readTrustedGenerationCallLedger(root);
  callStates(trusted.entries);
  return trusted;
}

export async function readCallLedger(root: string): Promise<CallLedgerEntry[]> {
  return (await authenticatedCallLedger(root)).entries;
}

type CallState = {
  admission: Extract<CallLedgerEntry, { entryKind: "admission" }>;
  terminal?: Extract<CallLedgerEntry, { entryKind: "terminal" }>;
};

function tupleKey(tuple: GenerationCallTuple): string {
  return `${tuple.jobId}\u0000${tuple.slideId}\u0000${tuple.attempt}\u0000${tuple.requestOrdinal}`;
}

function callStates(ledger: CallLedgerEntry[]): Map<string, CallState> {
  const states = new Map<string, CallState>();
  for (const entry of ledger) {
    const key = tupleKey(entry);
    const state = states.get(key);
    if (entry.entryKind === "admission") {
      if (state) throw new Error("generation call ledger has a conflicting duplicate admission");
      states.set(key, { admission: entry });
    } else {
      if (!state) throw new Error("generation call ledger has a terminal entry without an admission");
      if (state.terminal) throw new Error("generation call ledger has a conflicting duplicate terminal entry");
      if (state.admission.admissionTokenSha256 !== entry.admissionTokenSha256) {
        throw new Error("generation call ledger terminal token does not match its admission");
      }
      state.terminal = entry;
    }
  }
  return states;
}

async function assertSerialDeckAdmission(
  root: string,
  request: GenerationCallTuple,
  job: ImageGenerationJob,
  ledger: CallLedgerEntry[],
): Promise<void> {
  if (job.kind !== "deck") return;
  const { readAndReauthenticateDelegatedResult } = await import("./delegation-result.js");
  let result: Awaited<ReturnType<typeof readAndReauthenticateDelegatedResult>>["result"] | null = null;
  try {
    result = (await readAndReauthenticateDelegatedResult(root, job.jobId)).result;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !error.message.startsWith("delegated aggregate result is unavailable")) throw error;
  }
  const accepted = new Set(result?.pages
    .filter((page) => (page.status === "success" || page.status === "cached") && page.styleConsistency === "accepted")
    .map(({ slideId }) => slideId));
  const next = job.pages.find(({ slideId }) => !accepted.has(slideId));
  if (!next) throw new Error("serial delegated deck has no unresolved page to admit");
  const expectedOrdinal = next.order + 1;
  if (request.requestOrdinal !== expectedOrdinal) {
    throw new Error("serial delegated deck call ordinal is non-monotonic");
  }
  const states = callStates(ledger);
  if (result?.pages.some((page) => page.slideId === next.slideId && page.attempt === next.attempt)) {
    throw new Error("serial delegated deck page already has a terminal result");
  }
  if ([...states.values()].some((state) =>
    state.admission.jobId === job.jobId
    && state.admission.slideId === next.slideId
    && state.admission.attempt === next.attempt
    && state.terminal
  )) throw new Error("serial delegated deck page already has a terminal call");
  const priorInFlight = job.pages
    .slice(0, job.pages.findIndex(({ slideId }) => slideId === next.slideId))
    .some((page) => [...states.values()].some((state) =>
      state.admission.jobId === job.jobId
      && state.admission.slideId === page.slideId
      && state.admission.attempt === page.attempt
      && !state.terminal
    ));
  if (priorInFlight) throw new Error("serial delegated deck has a prior in-flight page");
  const nextInFlight = [...states.values()].some((state) =>
    state.admission.jobId === job.jobId
    && state.admission.slideId === next.slideId
    && state.admission.attempt === next.attempt
    && !state.terminal
  );
  if (nextInFlight) throw new Error("serial delegated deck next page is in-flight");
  if (request.slideId !== next.slideId || request.attempt !== next.attempt) {
    throw new Error("serial delegated deck admission must use the next unresolved ordered page");
  }
}

async function validateCallTuple(
  root: string,
  raw: GenerationCallTuple,
  options: { allowStaleRevision?: boolean } = {},
): Promise<{ request: GenerationCallTuple; job: ImageGenerationJob }> {
  const request = GenerationCallTupleSchema.parse(raw);
  const job = await readJob(root, request.jobId);
  const manifest = await readProject(root);
  await assertAuthorizedJobBinding(root, job);
  if (!options.allowStaleRevision && manifest.currentRevision.id !== job.projectRevisionId) {
    throw new Error("generation call job does not bind the current project revision");
  }
  const page = job.pages.find(({ slideId }) => slideId === request.slideId);
  if (!page || page.attempt !== request.attempt) {
    throw new Error("generation call tuple is not declared by the immutable job");
  }
  return { request, job };
}

async function assertCurrentAdmissionAuthorization(root: string, job: ImageGenerationJob): Promise<void> {
  const { plan, digest } = await readCurrentAuthorizedPlan(root, job.kind);
  if (digest !== job.authorizationDigest || plan.projectRevisionId !== job.projectRevisionId) {
    throw new Error("generation call requires the current matching authorization");
  }
  if (job.kind !== "style-sample") {
    if (!job.authorizationTrust) throw new Error("generation call has no trusted authorization record");
    await assertTrustedGenerationAuthorizationCurrent(root, job.authorizationTrust, job.authorizationPlan, job.authorizationGate);
  }
}

export async function admitDelegatedGenerationCall(
  root: string,
  raw: GenerationCallTuple,
): Promise<DelegatedGenerationAdmission> {
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    const { request, job } = await validateCallTuple(canonicalRoot, raw);
    await assertCurrentAdmissionAuthorization(canonicalRoot, job);
    const ledger = await readCallLedger(canonicalRoot);
    if (callStates(ledger).has(tupleKey(request))) {
      throw new Error("delegated generation call tuple already has a durable admission");
    }
    const before = await callBudgetForDigest(canonicalRoot, job.authorizationDigest, job.callBudget);
    if (before.remaining === 0) throw new Error("generation call budget is exhausted");
    await assertSerialDeckAdmission(canonicalRoot, request, job, ledger);
    const admissionToken = randomBytes(32).toString("hex");
    const admission = CallLedgerEntrySchema.parse({
      ...request,
      entryKind: "admission",
      outcome: "in-flight",
      admissionTokenSha256: sha256(admissionToken),
      recordedAt: new Date().toISOString(),
    });
    await appendTrustedGenerationCallLedgerEntry(canonicalRoot, job, admission);
    return {
      ...request,
      admissionToken,
      consumed: before.consumed + 1,
      remaining: before.remaining - 1,
    };
  });
}

export async function settleDelegatedGenerationCall(
  root: string,
  raw: GenerationCallTuple & { admissionToken: string; outcome: "success" | "failed" },
): Promise<{ consumed: number; remaining: number }> {
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    const request = GenerationCallTupleSchema.parse({
      jobId: raw.jobId,
      slideId: raw.slideId,
      attempt: raw.attempt,
      requestOrdinal: raw.requestOrdinal,
    });
    const { job } = await validateCallTuple(canonicalRoot, request, { allowStaleRevision: true });
    const ledger = await readCallLedger(canonicalRoot);
    const state = callStates(ledger).get(tupleKey(request));
    if (!state) throw new Error("delegated generation result has no prior admission");
    const tokenSha256 = sha256(raw.admissionToken);
    if (state.admission.admissionTokenSha256 === null || state.admission.admissionTokenSha256 !== tokenSha256) {
      throw new Error("delegated generation admission token is invalid");
    }
    if (state.terminal) {
      if (state.terminal.outcome !== raw.outcome) {
        throw new Error("delegated generation result conflicts with its terminal call outcome");
      }
    } else {
      const terminal = CallLedgerEntrySchema.parse({
        ...request,
        entryKind: "terminal",
        outcome: raw.outcome,
        admissionTokenSha256: tokenSha256,
        recordedAt: new Date().toISOString(),
      });
      await appendTrustedGenerationCallLedgerEntry(canonicalRoot, job, terminal);
    }
    return callBudgetForDigest(canonicalRoot, job.authorizationDigest, job.callBudget);
  });
}

async function callBudgetForDigest(root: string, digest: string, budget: number): Promise<{ consumed: number; remaining: number }> {
  const trusted = await authenticatedCallLedger(root);
  const jobs = new Map<string, ImageGenerationJob>();
  for (const event of trusted.events) {
    let historicalJob = jobs.get(event.entry.jobId);
    if (!historicalJob) {
      historicalJob = await readJob(root, event.entry.jobId);
      jobs.set(event.entry.jobId, historicalJob);
    }
    try {
      await assertAuthorizedJobBinding(root, historicalJob);
      assertTrustedCallEventJobBinding(event, historicalJob);
    } catch (error: unknown) {
      throw new Error(`historical image generation job is not authorized: ${event.entry.jobId}`, { cause: error });
    }
  }
  const consumed = trusted.events.filter((event) =>
    event.entry.entryKind === "admission" && event.authorizationDigest === digest
  ).length;
  if (consumed > budget) throw new Error("generation call ledger exceeds its authorized budget");
  return { consumed, remaining: budget - consumed };
}

export async function executeAuthorizedGenerationCall<T>(
  root: string,
  raw: GenerationCallTuple,
  callback: () => Promise<T> | T,
  operations: { afterAdmission?: () => Promise<void> | void } = {},
): Promise<GenerationExecutionResult<T>> {
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    const { request, job } = await validateCallTuple(canonicalRoot, raw);
    const ledger = await readCallLedger(canonicalRoot);
    const existing = callStates(ledger).get(tupleKey(request));
    const before = await callBudgetForDigest(canonicalRoot, job.authorizationDigest, job.callBudget);
    if (existing) {
      return {
        executed: false,
        outcome: existing.terminal?.outcome ?? "in-flight",
        consumed: before.consumed,
        remaining: before.remaining,
      };
    }
    await assertCurrentAdmissionAuthorization(canonicalRoot, job);
    if (before.remaining === 0) throw new Error("generation call budget is exhausted");
    await assertSerialDeckAdmission(canonicalRoot, request, job, ledger);

    const admission = CallLedgerEntrySchema.parse({
      ...request,
      entryKind: "admission",
      outcome: "in-flight",
      admissionTokenSha256: null,
      recordedAt: new Date().toISOString(),
    });
    await appendTrustedGenerationCallLedgerEntry(canonicalRoot, job, admission);
    const admitted = { consumed: before.consumed + 1, remaining: before.remaining - 1 };
    await operations.afterAdmission?.();

    let value: T;
    try {
      value = await callback();
    } catch (error: unknown) {
      const terminal = CallLedgerEntrySchema.parse({
        ...request,
        entryKind: "terminal",
        outcome: "failed",
        admissionTokenSha256: null,
        recordedAt: new Date().toISOString(),
      });
      await appendTrustedGenerationCallLedgerEntry(canonicalRoot, job, terminal);
      throw error;
    }
    const terminal = CallLedgerEntrySchema.parse({
      ...request,
      entryKind: "terminal",
      outcome: "success",
      admissionTokenSha256: null,
      recordedAt: new Date().toISOString(),
    });
    await appendTrustedGenerationCallLedgerEntry(canonicalRoot, job, terminal);
    return { executed: true, outcome: "success", value, ...admitted };
  });
}

export async function generationCallBudget(root: string, job: ImageGenerationJob): Promise<{ authorized: number; consumed: number; remaining: number }> {
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    await assertAuthorizedJobBinding(canonicalRoot, job);
    const state = await callBudgetForDigest(canonicalRoot, job.authorizationDigest, job.callBudget);
    return { authorized: job.callBudget, ...state };
  });
}

export async function authorizationCallBudget(
  root: string,
  digest: string,
  authorized: number,
): Promise<{ authorized: number; consumed: number; remaining: number }> {
  const state = await callBudgetForDigest(root, digest, authorized);
  return { authorized, ...state };
}

export async function authorizationForPreparation(root: string, kind: ImageJobKind) {
  const authorization = await readCurrentAuthorizedPlan(root, kind);
  const manifest = await readProject(root);
  const expectedGate = kind === "style-sample" ? "style-sample-generation" : "generation-authorization";
  const gate = [...manifest.gates].reverse().find((candidate) => candidate.gate === expectedGate
    && candidate.revisionId === manifest.currentRevision.id);
  if (!gate?.approvalId || !gate.snapshotPath || !gate.snapshotManifestSha256) {
    throw new Error("current generation authorization gate evidence is unavailable");
  }
  const planPath = kind === "style-sample" ? SAMPLE_PLAN_PATH : DECK_PLAN_PATH;
  const evidence = expectedGate === "style-sample-generation"
    ? await validateExecutionGateEvidence(root, manifest, gate)
    : await validateOrdinaryGateEvidence(root, manifest, gate);
  if (sha256(evidence.artifacts[planPath] ?? Buffer.alloc(0)) !== authorization.digest) {
    throw new Error("current generation authorization gate artifact is stale");
  }
  const gateBinding: Parameters<typeof trustedGenerationAuthorizationForGate>[2] = {
    gate: expectedGate,
    approvalId: gate.approvalId,
    snapshotPath: gate.snapshotPath,
    snapshotManifestSha256: gate.snapshotManifestSha256,
    authorizationPlanSha256: authorization.digest,
  };
  let trust: Awaited<ReturnType<typeof trustedGenerationAuthorizationForGate>> | null = null;
  if (expectedGate === "generation-authorization") {
    if (!("presentation" in evidence.descriptor)) throw new Error("generation authorization gate evidence is not ordinary approval evidence");
    trust = await trustedGenerationAuthorizationForGate(root, authorization.plan, gateBinding, evidence.descriptor);
  }
  return {
    ...authorization,
    gate: gateBinding,
    trust,
  };
}
