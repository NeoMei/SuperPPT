import { createHash, randomUUID } from "node:crypto";
import { fsyncSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { AiImageSkillDependency } from "../dependencies/schemas.js";
import { AiImageSkillDependencySchema } from "../dependencies/schemas.js";
import { assertGateCurrent } from "../planning/confirm.js";
import { loadValidatedPlan } from "../planning/load.js";
import { validateExecutionGateEvidence } from "../project/evidence.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile, readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { canonicalStyleSample } from "../styles/sample-contract.js";
import { compileSlidePrompt } from "../styles/prompt-compiler.js";
import { readApprovedStyleLock, readStyleLock, type LockedStyle } from "../styles/style-lock.js";
import { openGenerationDirectory } from "./anchored-dir.js";
import {
  CallLedgerEntrySchema,
  GenerationAuthorizationPlanSchema,
  ImageGenerationJobSchema,
  canonicalContractFile,
  type CallLedgerEntry,
  type GenerationAuthorizationPlan,
  type ImageGenerationJob,
  type ImageJobKind,
} from "./job-schemas.js";
import { appendPrivateInputLine } from "./private-input.js";

const DECK_PLAN_PATH = "generation/authorization-plan.json";
const SAMPLE_PLAN_PATH = "style/sample/generation-plan.json";
const CALL_LEDGER_PATH = "generation/call-ledger.jsonl";

type PlanPublicationRequest = {
  aiDependency: AiImageSkillDependency;
  callBudget: number;
};

export type GenerationCallRecord = Omit<CallLedgerEntry, "recordedAt"> & { recordedAt?: string };
export type CallBudgetState = { recorded: boolean; consumed: number; remaining: number };

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function aiSkillBinding(ai: AiImageSkillDependency): ImageGenerationJob["aiSkill"] {
  return { root: ai.root, skillSha256: ai.skillSha256, gitRevision: ai.gitRevision };
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
  for (const script of Object.values(ai.scripts)) {
    const relation = relative(ai.root, script);
    if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || await realpath(script) !== script) {
      throw new Error("ai-image-to-ppt Skill identity changed");
    }
    await readRegularFileNoFollow(script);
  }
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
  let currentLock: LockedStyle;
  try {
    currentLock = job.kind === "style-sample" ? await readStyleLock(root) : await readApprovedStyleLock(root);
  } catch (error: unknown) {
    throw new Error("image generation job style lock is stale or invalid", { cause: error });
  }
  const { styleLockSha256, ...embeddedStyleLock } = currentLock;
  if (styleLockSha256 !== job.styleLockSha256 || !sameJson(embeddedStyleLock, job.styleLock)) {
    throw new Error("image generation job style lock changed after publication");
  }
  for (const page of job.pages) {
    const prompt = await readOwnedRegularFile(root, page.promptArtifact).catch((error: unknown) => {
      throw new Error("job prompt artifact changed after publication", { cause: error });
    });
    if (prompt.toString("utf8") !== page.finalPrompt || sha256(prompt) !== page.promptSha256) {
      throw new Error("job prompt artifact hash changed after publication");
    }
  }
  const { plan, digest } = await readCurrentAuthorizedPlan(root, job.kind);
  if (job.authorizationDigest !== digest) throw new Error("image generation job authorization digest is stale");
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
      await assertPreviousPromptPublished(root, page.slideId, original.promptSha256, digest);
    }
  }
}

function isMissing(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as NodeJS.ErrnoException).code === "ENOENT") return true;
    current = current.cause;
  }
  return false;
}

export async function readCallLedger(root: string): Promise<CallLedgerEntry[]> {
  let bytes: Buffer;
  try {
    bytes = await readOwnedRegularFile(root, CALL_LEDGER_PATH);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw new Error("generation call ledger is unsafe or unreadable", { cause: error });
  }
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("generation call ledger is not complete JSONL");
  return text.slice(0, -1).split("\n").map((line, index) => {
    try {
      const entry = CallLedgerEntrySchema.parse(JSON.parse(line));
      if (line !== JSON.stringify(entry)) throw new Error("non-canonical ledger line");
      return entry;
    } catch (error: unknown) {
      throw new Error(`generation call ledger entry ${index + 1} is invalid`, { cause: error });
    }
  });
}

async function callBudgetForDigest(root: string, digest: string, budget: number): Promise<{ consumed: number; remaining: number }> {
  const ledger = await readCallLedger(root);
  const jobDigests = new Map<string, string>();
  for (const entry of ledger) {
    if (!jobDigests.has(entry.jobId)) jobDigests.set(entry.jobId, (await readJob(root, entry.jobId)).authorizationDigest);
  }
  const consumed = ledger.filter(({ jobId }) => jobDigests.get(jobId) === digest).length;
  if (consumed > budget) throw new Error("generation call ledger exceeds its authorized budget");
  return { consumed, remaining: budget - consumed };
}

export async function recordGenerationCall(root: string, raw: GenerationCallRecord): Promise<CallBudgetState> {
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    const entry = CallLedgerEntrySchema.parse({ ...raw, recordedAt: raw.recordedAt ?? new Date().toISOString() });
    const job = await readJob(canonicalRoot, entry.jobId);
    await assertAuthorizedJobBinding(canonicalRoot, job);
    const page = job.pages.find(({ slideId }) => slideId === entry.slideId);
    if (!page || page.attempt !== entry.attempt) throw new Error("generation call tuple is not declared by the immutable job");
    const ledger = await readCallLedger(canonicalRoot);
    const duplicate = ledger.find((candidate) =>
      candidate.jobId === entry.jobId
      && candidate.slideId === entry.slideId
      && candidate.attempt === entry.attempt
      && candidate.requestOrdinal === entry.requestOrdinal
    );
    const before = await callBudgetForDigest(canonicalRoot, job.authorizationDigest, job.callBudget);
    if (duplicate) {
      if (duplicate.outcome !== entry.outcome) throw new Error("duplicate generation call tuple has a conflicting outcome");
      return { recorded: false, consumed: before.consumed, remaining: before.remaining };
    }
    if (before.remaining === 0) throw new Error("generation call budget is exhausted");
    appendPrivateInputLine(join(canonicalRoot, CALL_LEDGER_PATH), JSON.stringify(entry));
    return { recorded: true, consumed: before.consumed + 1, remaining: before.remaining - 1 };
  });
}

export async function assertGenerationCallAuthorized(root: string, request: {
  jobId: string;
  slideId: string;
  attempt: number;
  requestOrdinal: number;
}): Promise<{ duplicate: boolean; remaining: number }> {
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    const job = await readJob(canonicalRoot, request.jobId);
    await assertAuthorizedJobBinding(canonicalRoot, job);
    const page = job.pages.find(({ slideId }) => slideId === request.slideId);
    if (!page || page.attempt !== request.attempt || !Number.isInteger(request.requestOrdinal) || request.requestOrdinal < 0) {
      throw new Error("generation call tuple is not declared by the immutable job");
    }
    const ledger = await readCallLedger(canonicalRoot);
    const duplicate = ledger.some((candidate) =>
      candidate.jobId === request.jobId
      && candidate.slideId === request.slideId
      && candidate.attempt === request.attempt
      && candidate.requestOrdinal === request.requestOrdinal
    );
    const budget = await callBudgetForDigest(canonicalRoot, job.authorizationDigest, job.callBudget);
    if (!duplicate && budget.remaining === 0) throw new Error("generation call budget is exhausted");
    return { duplicate, remaining: budget.remaining };
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
  return readCurrentAuthorizedPlan(root, kind);
}
