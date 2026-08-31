import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  AiImageSkillDependencySchema,
  type AiImageSkillDependency,
} from "../dependencies/schemas.js";
import { DeckEditRouteSchema, type DeckEditRoute } from "../editable/route.js";
import { assertGateCurrent } from "../planning/confirm.js";
import { loadValidatedPlan } from "../planning/load.js";
import { readProject } from "../project/store.js";
import { compileSlidePrompt } from "../styles/prompt-compiler.js";
import { readApprovedStyleLock } from "../styles/style-lock.js";
import {
  generationCallBudgetUnderGenerationLease,
  readCallLedgerUnderGenerationLease,
} from "./authorization.js";
import { readAndReauthenticateDelegatedResult } from "./delegation-result.js";
import { type ImageGenerationJob } from "./job-schemas.js";
import { withGenerationLease } from "./lease.js";
import { assertJobAuthorized, assertRegeneratedSlideJobBinding, prepareImageGenerationJob, readImageGenerationJob } from "./jobs.js";
import { type ImagePageResult } from "./schemas.js";

const DeckGateSchema = z.enum(["outline", "slide-specs", "style-sample", "generation-authorization"]);
const QualityCorrectionSchema = z.object({
  issues: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
}).strict();
const RejectedResultPathSchema = z.string().regex(
  /^generation\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/results\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(\d+)\.json$/,
  "rejected result path must name an immutable delegated page result",
);

export const PageRegenerationRequestSchema = z.object({
  slideId: z.string().uuid(),
  rejectedResultPath: RejectedResultPathSchema,
  correction: QualityCorrectionSchema,
}).strict();

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

export async function prepareRegeneratedSlideJob(
  rawRoute: DeckEditRoute,
  options: {
    root: string;
    currentRevisionId: string;
    aiDependency: AiImageSkillDependency;
    previousPromptSha256: string;
  },
): Promise<ImageGenerationJob> {
  const route = DeckEditRouteSchema.parse(rawRoute);
  if (route.route !== "regenerate-slide") throw new Error("regenerated slide jobs require the regenerate-slide route");
  const [manifest, lock, validated] = await Promise.all([
    readProject(options.root),
    readApprovedStyleLock(options.root),
    loadValidatedPlan(options.root),
  ]);
  if (manifest.currentRevision.id !== options.currentRevisionId) {
    throw new Error("regenerated slide route does not bind the current project revision");
  }
  if (lock.styleLockSha256 !== route.styleLockSha256) {
    throw new Error("regenerated slide route does not bind the approved Style Lock");
  }
  const spec = validated.specs.find(({ slideId }) => slideId === route.slideId);
  if (!spec) throw new Error("regenerated slide route target is not in the current plan");
  const finalPrompt = compileSlidePrompt({
    spec,
    styleLock: lock,
    correction: { issues: [route.reason] },
  }).text;
  const job = await prepareImageGenerationJob(options.root, {
    kind: "page-regeneration",
    aiDependency: options.aiDependency,
    slideId: route.slideId,
    previousPromptSha256: options.previousPromptSha256,
    finalPrompt,
  });
  return assertRegeneratedSlideJobBinding(job, {
    slideId: route.slideId,
    projectRevisionId: options.currentRevisionId,
    styleLockSha256: route.styleLockSha256,
  });
}

/**
 * Reads only immutable jobs, authenticated delegated results, and the durable
 * call ledger. It intentionally exposes no provider or channel selection.
 */
export async function describeProjectGeneration(root: string): Promise<GenerationProgress> {
  return withGenerationLease(root, describeProjectGenerationUnderLease);
}

async function describeProjectGenerationUnderLease(root: string): Promise<GenerationProgress> {
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
  const ledger = await readCallLedgerUnderGenerationLease(root);
  const pausedCapabilityDecisions: GenerationProgress["pausedCapabilityDecisions"] = [];
  const actionableJobs: ImageGenerationJob[] = [];
  const jobBudgets = new Map<string, GenerationProgress["calls"]>();
  for (const job of jobs) {
    const jobPageState = new Map<string, GenerationProgress["pages"][number]>();
    for (const page of job.pages) {
      const target = {
        slideId: page.slideId,
        order: page.order,
        promptSha256: page.promptSha256,
        status: "pending",
        artifacts: { master: null, normalized: null },
      } as GenerationProgress["pages"][number];
      jobPageState.set(page.slideId, target);
      pageState.set(page.slideId, target);
      for (let index = pausedCapabilityDecisions.length - 1; index >= 0; index -= 1) {
        if (pausedCapabilityDecisions[index]!.slideId === page.slideId) pausedCapabilityDecisions.splice(index, 1);
      }
    }
    const authenticated = await authenticatedResultOrNull(root, job);
    if (authenticated) {
      for (const page of authenticated.result.pages) {
        const target = jobPageState.get(page.slideId);
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
    }
    for (const page of job.pages) {
      const target = jobPageState.get(page.slideId)!;
      if (target.status !== "pending") continue;
      const admissions = ledger.filter((entry) => entry.entryKind === "admission"
        && entry.jobId === job.jobId && entry.slideId === page.slideId && entry.attempt === page.attempt);
      if (admissions.some((admission) => !ledger.some((entry) => entry.entryKind === "terminal"
        && entry.jobId === admission.jobId && entry.slideId === admission.slideId
        && entry.attempt === admission.attempt && entry.requestOrdinal === admission.requestOrdinal))) {
        target.status = "in-flight";
      } else if (admissions.some((admission) => ledger.some((entry) => entry.entryKind === "terminal"
        && entry.jobId === admission.jobId && entry.slideId === admission.slideId
        && entry.attempt === admission.attempt && entry.requestOrdinal === admission.requestOrdinal
        && entry.outcome === "success"))) {
        target.status = "not-reviewed";
      } else if (admissions.length > 0) target.status = "failed";
    }
    const budget = await generationCallBudgetUnderGenerationLease(root, job);
    jobBudgets.set(job.jobId, budget);
    const nextUnresolved = [...jobPageState.values()]
      .sort((left, right) => left.order - right.order)
      .find(({ status }) => status !== "accepted");
    if (nextUnresolved && (
      nextUnresolved.status === "in-flight"
      || nextUnresolved.status === "not-reviewed"
      || (nextUnresolved.status === "pending" && budget.remaining > 0)
    )) actionableJobs.push(job);
  }
  const current = actionableJobs.at(-1) ?? null;
  const budgetJob = current ?? jobs.at(-1)!;
  return {
    pages: [...pageState.values()].sort((left, right) => left.order - right.order),
    calls: jobBudgets.get(budgetJob.jobId)!,
    currentJob: current ? { jobId: current.jobId, kind: current.kind } : null,
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
  rawRequest: z.input<typeof PageRegenerationRequestSchema>,
): Promise<ImageGenerationJob> {
  await assertCurrentDeckGates(root);
  const request = PageRegenerationRequestSchema.parse(rawRequest);
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
