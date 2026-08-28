import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import sharp from "sharp";

import {
  AiImageSkillDependencySchema,
  type AiImageSkillDependency,
  type LegacyResolvedDependencies,
} from "../dependencies/schemas.js";
import { assertGateCurrent } from "../planning/confirm.js";
import { loadValidatedPlan } from "../planning/load.js";
import { StyleSelectionSchema } from "../planning/schemas.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import type { Artifact, ProjectManifest, SlideRecord } from "../project/schemas.js";
import { readProject, updateProject } from "../project/store.js";
import { loadBuiltInStyleCatalog } from "../styles/catalog.js";
import { compileSlidePrompt } from "../styles/prompt-compiler.js";
import { hasStyleLockEvidence, readApprovedStyleLock } from "../styles/style-lock.js";
import { GenerationDirectory, openGenerationDirectory } from "./anchored-dir.js";
import { cleanupAbandonedProjectStaging, ownedTemporaryName } from "./abandoned.js";
import { generationCallBudget, readCallLedger } from "./authorization.js";
import { readAndReauthenticateDelegatedResult } from "./delegation-result.js";
import { type ImageGenerationJob } from "./job-schemas.js";
import { assertJobAuthorized, prepareImageGenerationJob, readImageGenerationJob } from "./jobs.js";
import { readPrivateInputFile } from "./private-input.js";
import type { QualityDecision } from "./schemas.js";
import {
  AttemptLedgerSchema,
  QualityDecisionSchema,
  type AttemptLedger,
  type ImagePageResult,
} from "./schemas.js";
import { generateSlide } from "./provider.js";
import { correctivePrompt, correctivePromptFromEvidence, qualityEvidence } from "./quality.js";
import { reviewSlide } from "./quality.js";

const DeckGateSchema = z.enum(["outline", "slide-specs", "style-sample", "generation-authorization"]);
const QualityCorrectionSchema = z.object({
  issues: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
}).strict();
const RejectedResultPathSchema = z.string().regex(
  /^generation\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/results\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(\d+)\.json$/,
  "rejected result path must name an immutable delegated page result",
);

export type QualityCorrection = z.infer<typeof QualityCorrectionSchema>;

export type GenerationProgress = {
  pages: Array<{
    slideId: string;
    order: number;
    promptSha256: string;
    status: "pending" | "not-reviewed" | "in-flight" | "accepted" | "rejected" | "failed" | "paused";
    artifacts: {
      master: { path: string; sha256: string } | null;
      normalized: { path: string; sha256: string } | null;
    };
  }>;
  calls: { authorized: number; consumed: number; remaining: number };
  currentJob: { jobId: string; kind: ImageGenerationJob["kind"] } | null;
  pausedCapabilityDecisions: Array<{
    slideId: string;
    references: Array<{ path: string; sha256: string }>;
  }>;
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dependencyFromJob(job: ImageGenerationJob): AiImageSkillDependency {
  return AiImageSkillDependencySchema.parse({
    kind: "ai-image-to-ppt",
    root: job.aiSkill.root,
    skillFile: join(job.aiSkill.root, "SKILL.md"),
    skillSha256: job.aiSkill.skillSha256,
    gitRevision: job.aiSkill.gitRevision,
    scripts: Object.fromEntries(Object.entries(job.aiSkill.scripts).map(([name, script]) => [name, script.path])),
    scriptSha256: Object.fromEntries(Object.entries(job.aiSkill.scripts).map(([name, script]) => [name, script.sha256])),
  });
}

async function assertCurrentDeckGates(root: string): Promise<void> {
  for (const gate of DeckGateSchema.options) {
    if (!await assertGateCurrent(root, gate)) throw new Error(`${gate} gate must be current before serial delegated deck generation`);
  }
}

async function currentGenerationJobs(root: string): Promise<ImageGenerationJob[]> {
  let entries;
  try {
    entries = await readdir(join(root, "generation", "jobs"), { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: ImageGenerationJob[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.name.startsWith("."))) {
      throw new Error("generation jobs directory contains an unsafe entry");
    }
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const job = await readImageGenerationJob(root, entry.name);
    if (job.kind === "style-sample") continue;
    const manifest = await readProject(root);
    if (job.projectRevisionId !== manifest.currentRevision.id) continue;
    await assertJobAuthorized(root, job);
    jobs.push(job);
  }
  return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function authenticatedResultOrNull(root: string, job: ImageGenerationJob) {
  try {
    return await readAndReauthenticateDelegatedResult(root, job.jobId);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("delegated aggregate result is unavailable")) return null;
    throw error;
  }
}

function progressStatus(page: ImagePageResult): GenerationProgress["pages"][number]["status"] {
  if (page.status === "paused") return "paused";
  if (page.status === "failed") return "failed";
  if (page.styleConsistency === "accepted") return "accepted";
  if (page.styleConsistency === "rejected") return "rejected";
  return "not-reviewed";
}

/**
 * Creates or resumes the single immutable, serially delegated deck job for
 * the current authorization. Provider execution remains entirely outside
 * SuperPPT in ai-image-to-ppt.
 */
export async function prepareDeckJob(
  root: string,
  aiDependency: AiImageSkillDependency,
): Promise<ImageGenerationJob> {
  await assertCurrentDeckGates(root);
  const jobs = await currentGenerationJobs(root);
  const existing = [...jobs].reverse().find((job) =>
    job.kind === "deck" && sameJson(dependencyFromJob(job), AiImageSkillDependencySchema.parse(aiDependency))
  );
  if (existing) {
    await authenticatedResultOrNull(root, existing);
    return existing;
  }
  return prepareImageGenerationJob(root, { kind: "deck", aiDependency });
}

/**
 * Reads only immutable jobs, authenticated delegated results, and the durable
 * call ledger. It intentionally exposes no provider or channel selection.
 */
export async function describeProjectGeneration(root: string): Promise<GenerationProgress> {
  const jobs = await currentGenerationJobs(root);
  if (jobs.length === 0) {
    return {
      pages: [],
      calls: { authorized: 0, consumed: 0, remaining: 0 },
      currentJob: null,
      pausedCapabilityDecisions: [],
    };
  }
  const pageState = new Map<string, GenerationProgress["pages"][number]>();
  const ledger = await readCallLedger(root);
  const pausedCapabilityDecisions: GenerationProgress["pausedCapabilityDecisions"] = [];
  for (const job of jobs) {
    for (const page of job.pages) {
      pageState.set(page.slideId, {
        slideId: page.slideId,
        order: page.order,
        promptSha256: page.promptSha256,
        status: "pending",
        artifacts: { master: null, normalized: null },
      });
    }
    const authenticated = await authenticatedResultOrNull(root, job);
    if (!authenticated) continue;
    for (const page of authenticated.result.pages) {
      const target = pageState.get(page.slideId);
      if (!target) throw new Error("authenticated delegated result has a page outside its immutable job");
      target.status = progressStatus(page);
      target.artifacts = page.artifacts ? {
        master: { path: page.artifacts.master.path, sha256: page.artifacts.master.sha256 },
        normalized: { path: page.artifacts.normalized.path, sha256: page.artifacts.normalized.sha256 },
      } : { master: null, normalized: null };
      for (let index = pausedCapabilityDecisions.length - 1; index >= 0; index -= 1) {
        if (pausedCapabilityDecisions[index]!.slideId === page.slideId) pausedCapabilityDecisions.splice(index, 1);
      }
      const unsupported = page.referenceUsage
        .filter(({ usage }) => usage === "unsupported")
        .map(({ path, sha256 }) => ({ path, sha256 }));
      if (target.status === "paused" && unsupported.length > 0) pausedCapabilityDecisions.push({ slideId: page.slideId, references: unsupported });
    }
    for (const page of job.pages) {
      const target = pageState.get(page.slideId)!;
      if (target.status !== "pending") continue;
      const admissions = ledger.filter((entry) => entry.entryKind === "admission"
        && entry.jobId === job.jobId && entry.slideId === page.slideId && entry.attempt === page.attempt);
      if (admissions.some((admission) => !ledger.some((entry) => entry.entryKind === "terminal"
        && entry.jobId === admission.jobId && entry.slideId === admission.slideId
        && entry.attempt === admission.attempt && entry.requestOrdinal === admission.requestOrdinal))) {
        target.status = "in-flight";
      } else if (admissions.length > 0) target.status = "failed";
    }
  }
  const current = jobs.at(-1)!;
  return {
    pages: [...pageState.values()].sort((left, right) => left.order - right.order),
    calls: await generationCallBudget(root, current),
    currentJob: { jobId: current.jobId, kind: current.kind },
    pausedCapabilityDecisions,
  };
}

/**
 * Publishes a one-page immutable correction job from a reauthenticated quality
 * rejection. The original result remains the audit record; no result is
 * overwritten or deleted.
 */
export async function preparePageRegenerationJob(
  root: string,
  rawRequest: {
    slideId: string;
    rejectedResultPath: string;
    correction: QualityCorrection;
  },
): Promise<ImageGenerationJob> {
  await assertCurrentDeckGates(root);
  const request = z.object({
    slideId: z.string().uuid(),
    rejectedResultPath: RejectedResultPathSchema,
    correction: QualityCorrectionSchema,
  }).strict().parse(rawRequest);
  const path = RejectedResultPathSchema.parse(request.rejectedResultPath);
  const match = /^generation\/jobs\/([^/]+)\/results\/([^/]+)-(\d+)\.json$/.exec(path)!;
  const [jobId, resultSlideId, attemptText] = [match[1]!, match[2]!, match[3]!];
  if (request.slideId !== resultSlideId) throw new Error("page-regeneration slide does not match the rejected result path");

  const authenticated = await readAndReauthenticateDelegatedResult(root, jobId);
  const rejected = authenticated.result.pages.find(({ slideId, attempt }) =>
    slideId === request.slideId && attempt === Number(attemptText)
  );
  if (!rejected || rejected.styleConsistency !== "rejected" || !rejected.presentationQa || !rejected.artifacts) {
    throw new Error("page-regeneration requires an authenticated rejected quality result");
  }
  const sealedPage = authenticated.job.pages.find(({ slideId, attempt }) =>
    slideId === request.slideId && attempt === rejected.attempt
  );
  if (!sealedPage || rejected.actualPromptSha256 !== sealedPage.promptSha256) {
    throw new Error("rejected quality result does not bind the immutable original prompt");
  }
  const correction: QualityCorrection = {
    issues: [...new Set(request.correction.issues.map((issue) => issue.trim()))],
  };
  const rejectedIssues = [...new Set(rejected.presentationQa.decision.issues.map((issue) => issue.trim()))];
  if (!sameJson(correction.issues, rejectedIssues)) {
    throw new Error("page-regeneration correction must match sanitized rejected quality evidence");
  }
  const finalPrompt = compileSlidePrompt({
    spec: sealedPage.spec,
    styleLock: authenticated.job.styleLock,
    correction,
  }).text;
  return prepareImageGenerationJob(root, {
    kind: "page-regeneration",
    aiDependency: dependencyFromJob(authenticated.job),
    slideId: request.slideId,
    previousPromptSha256: rejected.actualPromptSha256,
    finalPrompt,
  });
}

const BatchPageSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["ready", "stale", "failed"]),
  prompt: z.string().min(1),
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  output: z.string().min(1),
  attempts: z.number().int().min(0).max(3).optional(),
}).strict();

export type BatchPage = z.infer<typeof BatchPageSchema>;
type GenerationResult = { ok: boolean; output: string };

/** @deprecated Legacy direct-provider batch bridge; removed in Task 10. */
export async function runBatch(options: {
  pages: BatchPage[];
  concurrency: number;
  generate: (page: BatchPage, attempt: number) => Promise<GenerationResult>;
  review: (page: BatchPage, attempt: number) => Promise<QualityDecision>;
}): Promise<{ pages: BatchPage[]; errors: { pageId: string; attempt: number; code: "generate" | "review" }[] }> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error("concurrency must be between 1 and 8");
  }
  const pages = options.pages.map((page) => BatchPageSchema.parse({ ...page }));
  const pending = pages.filter((page) => page.status !== "ready");
  const errors: { pageId: string; attempt: number; code: "generate" | "review" }[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      const page = pending[cursor++]!;
      let prompt = page.prompt;
      page.status = "stale";
      const firstAttempt = (page.attempts ?? 0) + 1;
      for (let attempt = firstAttempt; attempt <= 3; attempt++) {
        let generated: GenerationResult;
        try {
          generated = await options.generate({ ...page, prompt }, attempt);
        } catch {
          errors.push({ pageId: page.id, attempt, code: "generate" });
          continue;
        }
        if (!generated.ok) {
          errors.push({ pageId: page.id, attempt, code: "generate" });
          continue;
        }
        let quality: QualityDecision;
        try {
          quality = QualityDecisionSchema.parse(await options.review({ ...page, prompt }, attempt));
        } catch {
          errors.push({ pageId: page.id, attempt, code: "review" });
          continue;
        }
        if (quality.ok) {
          page.status = "ready";
          page.attempts = attempt;
          break;
        }
        prompt = correctivePrompt(prompt, quality);
        page.attempts = attempt;
      }
      if (page.status !== "ready") page.status = "failed";
    }
  }));
  return { pages, errors };
}

type ProjectGenerationResult = {
  providerId: string;
  pageCount: number;
  callCount: number;
  outputRoot: string;
  reviewer: "dependency" | "manual";
  pages: { id: string; status: SlideRecord["status"]; attempts: number }[];
};

export type GenerationPlan = {
  providerId: string;
  pageCount: number;
  callCount: number;
  outputRoot: string;
  reviewer: "dependency" | "manual";
};

type ProjectPage = {
  id: string;
  order: number;
  title: string;
  role: SlideRecord["role"];
  requiredText: string[];
  prompt: string;
  promptSha256: string;
  status: SlideRecord["status"];
  attempts: number;
};

const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function portable(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value.startsWith("..") || value.split(sep).includes("..")) {
    throw new Error("generation output escaped the project root");
  }
  return value.split(sep).join("/");
}

async function gateGeneration(root: string): Promise<ProjectManifest> {
  const manifest = await readProject(root);
  const gates = ["outline", "slide-specs", "style-sample"] as const;
  const current = await Promise.all(gates.map(async (gate) => {
    const approved = [...manifest.gates].reverse().find((item) => item.gate === gate);
    return approved?.revisionId === manifest.currentRevision.id && await assertGateCurrent(root, gate);
  }));
  if (current.some((value) => !value)) {
    throw new Error("outline, slide-specs, and style-sample gates must be current");
  }
  return manifest;
}

async function attemptCount(root: string, slideId: string): Promise<number> {
  const path = join(root, "images", slideId);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("attempt directory is unsafe");
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error("attempt directory is unsafe");
    const values = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => /^attempt-([1-3])$/.exec(entry.name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    return values.length === 0 ? 0 : Math.max(...values);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function latestAttemptLedger(root: string, page: ProjectPage): Promise<AttemptLedger | null> {
  if (page.attempts < 1) return null;
  const path = `images/${page.id}/attempt-${page.attempts}/ledger.json`;
  try {
    const ledger = AttemptLedgerSchema.parse(JSON.parse((await readOwnedRegularFile(root, path)).toString("utf8")));
    if (ledger.slideId !== page.id || ledger.attempt !== page.attempts) throw new Error("attempt identity mismatch");
    return ledger;
  } catch (error: unknown) {
    throw new Error("attempt ledger is invalid", { cause: error });
  }
}

async function authenticateLedgerImage(
  root: string,
  page: ProjectPage,
  ledger: AttemptLedger,
): Promise<Artifact | null> {
  const expectedPath = `images/${page.id}/attempt-${ledger.attempt}/slide.png`;
  if (
    ledger.output !== expectedPath
    || !ledger.outputSha256
    || !ledger.outputBytes
  ) return null;
  try {
    const bytes = await readOwnedRegularFile(root, expectedPath);
    if (bytes.length !== ledger.outputBytes || hash(bytes) !== ledger.outputSha256) return null;
    const decoder = sharp(bytes, { failOn: "error", limitInputPixels: 1920 * 1080, animated: false });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== "png"
      || metadata.width !== 1920
      || metadata.height !== 1080
      || (metadata.pages ?? 1) !== 1
    ) return null;
    await decoder.clone().raw().toBuffer();
    return { path: expectedPath, sha256: ledger.outputSha256, revisionId: ledger.revisionId! };
  } catch {
    return null;
  }
}

async function inspectAttemptStates(
  root: string,
  revisionId: string,
  pages: ProjectPage[],
): Promise<Map<string, { ledger: AttemptLedger; artifact: Artifact | null }>> {
  const states = new Map<string, { ledger: AttemptLedger; artifact: Artifact | null }>();
  for (const page of pages) {
    const ledger = await latestAttemptLedger(root, page);
    if (ledger?.revisionId !== revisionId) continue;
    states.set(page.id, { ledger, artifact: await authenticateLedgerImage(root, page, ledger) });
  }
  return states;
}

async function recoverProjectAttempts(
  root: string,
  revisionId: string,
  pages: ProjectPage[],
): Promise<void> {
  const recovered = await inspectAttemptStates(root, revisionId, pages);
  if (recovered.size === 0) return;
  await updateBoundProject(root, revisionId, (manifest) => ({
    ...manifest,
    slides: manifest.slides.map((slide) => {
      const state = recovered.get(slide.id);
      if (!state) return slide;
      const { ledger, artifact } = state;
      if (ledger.outcome === "accepted" && artifact) {
        return {
          ...slide,
          status: "ready" as const,
          image: artifact,
        };
      }
      if (ledger.outcome === "generated" && artifact) return { ...slide, status: "generating" as const };
      return { ...slide, status: "failed" as const };
    }),
  }));
}

async function projectPages(root: string, manifest: ProjectManifest): Promise<{ pages: ProjectPage[]; styleName: string }> {
  const plan = await loadValidatedPlan(root);
  let styleName: string;
  let compile: (spec: typeof plan.specs[number]) => { text: string };
  if (await hasStyleLockEvidence(root)) {
    const lock = await readApprovedStyleLock(root);
    styleName = lock.recipe.name;
    compile = (spec) => compileSlidePrompt({ spec, styleLock: lock });
  } else {
    // Compatibility for projects authored before the Style Lock contract. Once
    // a lock exists it is mandatory and a provisional lock can never leak here.
    const selection = StyleSelectionSchema.parse(JSON.parse((await readOwnedRegularFile(root, "style/selection.json")).toString("utf8")));
    const catalog = await loadBuiltInStyleCatalog();
    const style = catalog.styles.find(({ id }) => id === selection.styleId);
    if (!style) throw new Error("selected style is not in the built-in catalog");
    styleName = style.name;
    compile = (spec) => compileSlidePrompt({ spec, style });
  }
  const records = new Map(manifest.slides.map((slide) => [slide.id, slide]));
  const pages: ProjectPage[] = [];
  for (const [index, spec] of plan.specs.entries()) {
    const { text: prompt } = compile(spec);
    pages.push({
      id: spec.slideId,
      order: index,
      title: spec.title,
      role: spec.role,
      requiredText: spec.requiredText,
      prompt,
      promptSha256: hash(prompt),
      status: records.get(spec.slideId)?.status ?? "approved",
      attempts: await attemptCount(root, spec.slideId),
    });
  }
  if (manifest.slides.some((slide) => !pages.some((page) => page.id === slide.id))) {
    throw new Error("manifest slides do not match the current slide specifications");
  }
  return { pages, styleName };
}

function initialRecord(page: ProjectPage, revisionId: string): SlideRecord {
  return {
    id: page.id,
    order: page.order,
    title: page.title,
    role: page.role,
    specRevisionId: revisionId,
    promptRevisionId: revisionId,
    styleRevisionId: revisionId,
    status: page.status === "ready" ? "ready" : "approved",
    image: null,
    editable: null,
    finalRender: null,
    staleReasons: [],
  };
}

async function updateBoundProject(
  root: string,
  revisionId: string,
  updater: (manifest: ProjectManifest) => ProjectManifest,
): Promise<ProjectManifest> {
  return updateProject(root, (manifest) => {
    if (manifest.currentRevision.id !== revisionId) throw new Error("project revision changed during generation");
    return updater(manifest);
  });
}

function writeLedger(directory: GenerationDirectory, ledger: AttemptLedger): void {
  directory.writeExclusive("ledger.json", `${JSON.stringify(AttemptLedgerSchema.parse(ledger), null, 2)}\n`);
}

function qualityMatches(quality: QualityDecision, requiredText: string[]): void {
  if (
    quality.requiredText.length !== requiredText.length
    || quality.requiredText.some((item, index) => item.text !== requiredText[index])
  ) throw new Error("reviewer returned invalid quality JSON");
}

async function performAttempt(options: {
  root: string;
  revisionId: string;
  page: ProjectPage;
  attempt: number;
  prompt: string;
  provider: LegacyResolvedDependencies["ai"]["providers"][number];
  ai: LegacyResolvedDependencies["ai"];
  runner: string;
  styleName: string;
}): Promise<{ ledger: AttemptLedger; quality: QualityDecision | null; artifact: Artifact | null }> {
  const projectDirectory = openGenerationDirectory(await realpath(options.root));
  const imagesDirectory = projectDirectory.child("images", false);
  const slideDirectory = imagesDirectory.child(options.page.id);
  const slideRoot = slideDirectory.path;
  const attemptName = `attempt-${options.attempt}`;
  const attemptRoot = join(slideRoot, attemptName);
  try {
    await lstat(attemptRoot);
    throw new Error("attempt evidence already exists");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagingName = `.${attemptName}.${ownedTemporaryName("staging")}`;
  const stagingDirectory = slideDirectory.child(stagingName);
  const staging = stagingDirectory.path;
  const output = join(staging, "slide.png");
  const started = performance.now();
  let ledger: AttemptLedger;
  let quality: QualityDecision | null = null;
  let promoted = false;
  const promote = () => {
    stagingDirectory.assertCurrent();
    stagingDirectory.close();
    slideDirectory.promoteChildExclusive(stagingName, attemptName);
    promoted = true;
  };
  try {
    try {
      ledger = await generateSlide({
        runner: options.runner,
        modulePath: join(options.ai.root, options.provider.module),
        callable: options.provider.callable,
        providerId: options.provider.id,
        slideId: options.page.id,
        revisionId: options.revisionId,
        prompt: options.prompt,
        output,
        attempt: options.attempt,
        allowedFormats: options.provider.outputFormats,
        trustedRoot: staging,
      });
    } catch (error: unknown) {
      const invalid = error instanceof Error && error.message === "provider output is not an allowed complete image";
      ledger = AttemptLedgerSchema.parse({
        ledgerVersion: 1,
        slideId: options.page.id,
        revisionId: options.revisionId,
        attempt: options.attempt,
        providerId: options.provider.id,
        promptSha256: hash(options.prompt),
        promptPurged: true,
        output: null,
        outputSha256: null,
        outputBytes: null,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        quality: null,
        outcome: "provider-error",
        errorCode: invalid ? "invalid-image" : "provider-failed",
      });
      writeLedger(stagingDirectory, ledger);
      promote();
      return { ledger, quality: null, artifact: null };
    }

    if (options.ai.reviewer) {
      try {
        quality = await reviewSlide({
          runner: options.runner,
          modulePath: join(options.ai.root, options.ai.reviewer.module),
          callable: options.ai.reviewer.callable,
          image: output,
          requiredText: options.page.requiredText,
          styleName: options.styleName,
        });
        qualityMatches(quality, options.page.requiredText);
        ledger = AttemptLedgerSchema.parse({
          ...ledger,
          quality: qualityEvidence(quality),
          outcome: quality.ok ? "accepted" : "rejected",
        });
      } catch {
        ledger = AttemptLedgerSchema.parse({
          ...ledger,
          quality: null,
          outcome: "review-error",
          errorCode: "review-failed",
        });
      }
    }
    const finalOutput = portable(options.root, join(attemptRoot, "slide.png"));
    ledger = AttemptLedgerSchema.parse({ ...ledger, output: finalOutput });
    writeLedger(stagingDirectory, ledger);
    promote();
    const artifact: Artifact = {
      path: finalOutput,
      sha256: ledger.outputSha256!,
      revisionId: options.revisionId,
    };
    return { ledger, quality, artifact };
  } finally {
    if (!promoted) {
      try { stagingDirectory.close(); } catch { /* already closed */ }
      slideDirectory.assertCurrent();
      await rm(staging, { recursive: true, force: true });
    }
    slideDirectory.close();
    imagesDirectory.close();
    projectDirectory.close();
  }
}

async function generateSelected(options: {
  root: string;
  ai: LegacyResolvedDependencies["ai"];
  runner: string;
  concurrency: number;
  selectedIds?: Set<string>;
  operations?: { afterAttemptPromoted?: (pageId: string, attempt: number, ledger: AttemptLedger) => Promise<void> };
}): Promise<ProjectGenerationResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error("concurrency must be between 1 and 8");
  }
  const provider = options.ai.providers.find(({ id }) => id === options.ai.defaultProvider);
  if (!provider) throw new Error("default provider is unavailable");
  return withProjectLease(options.root, "generation", async (root) => {
    const gated = await gateGeneration(root);
    const revisionId = gated.currentRevision.id;
    const recoveryPlan = await loadValidatedPlan(root);
    await cleanupAbandonedProjectStaging(root, recoveryPlan.specs.map(({ slideId }) => slideId));
    let prepared = await projectPages(root, gated);
    await updateBoundProject(root, revisionId, (manifest) => {
      const prior = new Map(manifest.slides.map((slide) => [slide.id, slide]));
      return {
        ...manifest,
        stage: "generating",
        slides: prepared.pages.map((page) => prior.get(page.id) ?? initialRecord(page, revisionId)),
      };
    });
    await recoverProjectAttempts(root, revisionId, prepared.pages);
    prepared = await projectPages(root, await readProject(root));
    const attemptStates = await inspectAttemptStates(root, revisionId, prepared.pages);
    const awaitingManual = new Set([...attemptStates.entries()]
      .filter(([, state]) => !options.ai.reviewer && state.ledger.outcome === "generated" && state.artifact)
      .map(([pageId]) => pageId));
    const requested = prepared.pages.filter((page) =>
      (options.selectedIds
        ? options.selectedIds.has(page.id)
        : page.status !== "ready" && !awaitingManual.has(page.id))
    );
    if (options.selectedIds && requested.length !== options.selectedIds.size) throw new Error("retry page is not in the current slide plan");
    if (requested.some((page) => page.status === "ready")) throw new Error("ready pages cannot be retried");
    if (requested.some((page) => awaitingManual.has(page.id))) throw new Error("page is awaiting manual QA");
    if (options.selectedIds && requested.some((page) => page.attempts >= 3)) throw new Error("page has reached the three-attempt limit");
    const selected = requested.filter((page) => page.attempts < 3);

    let cursor = 0;
    let callCount = 0;
    await Promise.all(Array.from({ length: Math.min(options.concurrency, selected.length) }, async () => {
      while (cursor < selected.length) {
        const page = selected[cursor++]!;
        const retained = attemptStates.get(page.id)?.ledger;
        let prompt = retained && retained.attempt === page.attempts && retained.outcome !== "generated"
          ? correctivePromptFromEvidence(page.prompt, retained.quality)
          : page.prompt;
        let finalStatus: SlideRecord["status"] = "failed";
        let finalArtifact: Artifact | null = null;
        const first = page.attempts + 1;
        for (let attempt = first; attempt <= 3; attempt++) {
          callCount += 1;
          if ((await gateGeneration(root)).currentRevision.id !== revisionId) {
            throw new Error("project revision changed during generation");
          }
          await updateBoundProject(root, revisionId, (manifest) => ({
            ...manifest,
            slides: manifest.slides.map((slide) => slide.id === page.id ? { ...slide, status: "generating" } : slide),
          }));
          const result = await performAttempt({
            root,
            revisionId,
            page,
            attempt,
            prompt,
            provider,
            ai: options.ai,
            runner: options.runner,
            styleName: prepared.styleName,
          });
          await options.operations?.afterAttemptPromoted?.(page.id, attempt, result.ledger);
          if (!result.artifact) continue;
          finalArtifact = result.artifact;
          if (!options.ai.reviewer) {
            finalStatus = "generating";
            break;
          }
          if (result.quality?.ok) {
            finalStatus = "ready";
            break;
          }
          if (result.quality) prompt = correctivePrompt(prompt, result.quality);
        }
        if ((await gateGeneration(root)).currentRevision.id !== revisionId) {
          throw new Error("project revision changed during generation");
        }
        await updateBoundProject(root, revisionId, (manifest) => ({
          ...manifest,
          slides: manifest.slides.map((slide) => slide.id === page.id ? {
            ...slide,
            status: finalStatus,
            image: finalStatus === "ready" ? finalArtifact : slide.image,
            promptRevisionId: revisionId,
            styleRevisionId: revisionId,
          } : slide),
        }));
      }
    }));
    const final = await readProject(root);
    const pages = await Promise.all(final.slides.map(async (slide) => ({
      id: slide.id,
      status: slide.status,
      attempts: await attemptCount(root, slide.id),
    })));
    return {
      providerId: provider.id,
      pageCount: selected.length,
      callCount,
      outputRoot: join(root, "images"),
      reviewer: options.ai.reviewer ? "dependency" : "manual",
      pages,
    };
  });
}

/** @deprecated Kept only while the legacy CLI still uses direct generation. */
export async function describeLegacyProjectGeneration(options: {
  root: string;
  ai: LegacyResolvedDependencies["ai"];
  selectedIds?: Set<string>;
}): Promise<GenerationPlan> {
  const provider = options.ai.providers.find(({ id }) => id === options.ai.defaultProvider);
  if (!provider) throw new Error("default provider is unavailable");
  const manifest = await gateGeneration(options.root);
  const prepared = await projectPages(options.root, manifest);
  const attemptStates = await inspectAttemptStates(options.root, manifest.currentRevision.id, prepared.pages);
  const awaitingManual = new Set([...attemptStates.entries()]
    .filter(([, state]) => !options.ai.reviewer && state.ledger.outcome === "generated" && state.artifact)
    .map(([pageId]) => pageId));
  const selected = prepared.pages.filter((page) =>
    options.selectedIds ? options.selectedIds.has(page.id) : page.status !== "ready" && !awaitingManual.has(page.id)
  );
  if (options.selectedIds && selected.length !== options.selectedIds.size) throw new Error("retry page is not in the current slide plan");
  if (selected.some((page) => awaitingManual.has(page.id))) throw new Error("page is awaiting manual QA");
  return {
    providerId: provider.id,
    pageCount: selected.length,
    callCount: selected.reduce((sum, page) => sum + Math.max(0, 3 - page.attempts), 0),
    outputRoot: join(await realpath(options.root), "images"),
    reviewer: options.ai.reviewer ? "dependency" : "manual",
  };
}

/** @deprecated Legacy direct-provider generation; removed in Task 10. */
export async function generateProject(options: {
  root: string;
  ai: LegacyResolvedDependencies["ai"];
  runner: string;
  concurrency: number;
  operations?: { afterAttemptPromoted?: (pageId: string, attempt: number, ledger: AttemptLedger) => Promise<void> };
}): Promise<ProjectGenerationResult> {
  return generateSelected(options);
}

/** @deprecated Legacy direct-provider retry; removed in Task 10. */
export async function retryProjectPage(options: {
  root: string;
  slideId: string;
  ai: LegacyResolvedDependencies["ai"];
  runner: string;
}): Promise<ProjectGenerationResult> {
  return generateSelected({ ...options, concurrency: 1, selectedIds: new Set([options.slideId]) });
}

/** @deprecated Legacy direct-provider manual QA; removed in Task 10. */
export async function recordManualQa(options: {
  root: string;
  slideId: string;
  input: string;
  ai?: LegacyResolvedDependencies["ai"];
  afterLedgerWritten?: () => Promise<void>;
}): Promise<{ slideId: string; status: "ready" | "failed"; ok: boolean; passedChecks: number; totalChecks: number }> {
  if (options.ai?.reviewer) throw new Error("manual QA is available only when no dependency reviewer exists");
  const inputInfo = await lstat(options.input);
  if (inputInfo.isSymbolicLink() || !inputInfo.isFile()) throw new Error("manual QA input must be a regular file");
  let quality: QualityDecision;
  try {
    quality = QualityDecisionSchema.parse(JSON.parse(readPrivateInputFile(options.input).toString("utf8")));
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "private input must have mode 0600") {
      throw new Error("manual QA input must have mode 0600");
    }
    throw new Error("manual QA evidence is invalid");
  }
  return withProjectLease(options.root, "generation", async (root) => {
    const manifest = await gateGeneration(root);
    const page = (await projectPages(root, manifest)).pages.find(({ id }) => id === options.slideId);
    const slide = manifest.slides.find(({ id }) => id === options.slideId);
    if (!page || !slide || slide.status !== "generating") throw new Error("slide is not awaiting manual QA");
    try {
      qualityMatches(quality, page.requiredText);
    } catch {
      throw new Error("manual QA evidence is invalid");
    }
    const attempt = await attemptCount(root, options.slideId);
    if (attempt < 1) throw new Error("slide has no generated attempt to review");
    const ledgerPath = `images/${options.slideId}/attempt-${attempt}/ledger.json`;
    let ledger: AttemptLedger;
    try {
      ledger = AttemptLedgerSchema.parse(JSON.parse((await readOwnedRegularFile(root, ledgerPath)).toString("utf8")));
    } catch (error: unknown) {
      throw new Error("attempt ledger is invalid", { cause: error });
    }
    if (ledger.revisionId !== manifest.currentRevision.id || ledger.quality !== null || ledger.outcome !== "generated") {
      throw new Error("attempt is not awaiting manual QA");
    }
    const artifact = await authenticateLedgerImage(root, page, ledger);
    if (!artifact) throw new Error("attempt image is missing or invalid");
    const evidence = qualityEvidence(quality);
    const next = AttemptLedgerSchema.parse({ ...ledger, quality: evidence, outcome: quality.ok ? "accepted" : "rejected" });
    const projectDirectory = openGenerationDirectory(await realpath(root));
    const imagesDirectory = projectDirectory.child("images", false);
    const slideDirectory = imagesDirectory.child(options.slideId, false);
    const attemptDirectory = slideDirectory.child(`attempt-${attempt}`, false);
    try {
      attemptDirectory.replace("ledger.json", `${JSON.stringify(next, null, 2)}\n`, `.ledger.${randomUUID()}.staging`);
    } finally {
      attemptDirectory.close();
      slideDirectory.close();
      imagesDirectory.close();
      projectDirectory.close();
    }
    await options.afterLedgerWritten?.();
    await updateBoundProject(root, manifest.currentRevision.id, (current) => ({
      ...current,
      slides: current.slides.map((record) => record.id === options.slideId ? {
        ...record,
        status: quality.ok ? "ready" : "failed",
        image: quality.ok ? artifact : record.image,
      } : record),
    }));
    const passedChecks = evidence.requiredText.filter((item) => item.present && item.exact).length
      + [evidence.styleConsistent, evidence.hierarchyClear, evidence.richDetail, evidence.noForbiddenContent]
        .filter(Boolean).length;
    return {
      slideId: options.slideId,
      status: quality.ok ? "ready" : "failed",
      ok: quality.ok,
      passedChecks,
      totalChecks: evidence.requiredText.length + 4,
    };
  });
}
