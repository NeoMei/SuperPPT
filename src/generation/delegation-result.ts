import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import sharp from "sharp";
import { z } from "zod";

import {
  assertAiImageSkillDependencyCurrent,
  assertAuthorizedJobBinding,
  assertSealedJobInputs,
  readCallLedger,
  readCallLedgerUnderGenerationLease,
  settleDelegatedGenerationCall,
} from "./authorization.js";
import { openGenerationDirectory } from "./anchored-dir.js";
import { withGenerationLease } from "./lease.js";
import { canonicalContractFile, type ImageGenerationJob } from "./job-schemas.js";
import { readImageGenerationJob } from "./jobs.js";
import {
  DependencyGenerationResultSchema,
  ImageGenerationResultSchema,
  ImagePageResultSchema,
  SerialStickyReportSchema,
  type ImageGenerationResult,
  type ImagePageResult,
  type SerialStickyReport,
} from "./schemas.js";
import { DelegatedPresentationQaSchema, delegatedStyleConsistency } from "./quality.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import {
  assertProjectMutationNotFrozen,
  readProject,
  updateProjectWithDelegatedGenerationAttachment,
} from "../project/store.js";
import { Sha256Schema, type Artifact, type ProjectManifest } from "../project/schemas.js";

const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;

export const DelegatedResultIntakeSchema = z.object({
  jobId: z.string().uuid(),
  slideId: z.string().uuid(),
  attempt: z.number().int().positive(),
  requestOrdinal: z.number().int().nonnegative(),
  admissionToken: z.string().regex(/^[a-f0-9]{64}$/),
  dependency: DependencyGenerationResultSchema,
  batchReport: SerialStickyReportSchema,
  actualPromptSha256: Sha256Schema,
  styleLockSha256: Sha256Schema,
  styleRecipeSha256: Sha256Schema,
  referenceUsage: z.array(z.object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    usage: z.enum(["used", "unsupported"]),
  }).strict()),
  presentationQa: DelegatedPresentationQaSchema.nullable(),
}).strict();

export type DelegatedResultIntake = z.input<typeof DelegatedResultIntakeSchema>;

type AuthenticatedIntake = {
  intake: z.output<typeof DelegatedResultIntakeSchema>;
  job: ImageGenerationJob;
  page: ImageGenerationJob["pages"][number];
  status: ImagePageResult["status"];
  styleConsistency: ImagePageResult["styleConsistency"];
  artifacts: ImagePageResult["artifacts"];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectPath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split("/"));
}

function isMissing(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as NodeJS.ErrnoException).code === "ENOENT") return true;
    current = current.cause;
  }
  return false;
}

function dependencyBinding(job: ImageGenerationJob) {
  return {
    kind: "ai-image-to-ppt" as const,
    root: job.aiSkill.root,
    skillFile: join(job.aiSkill.root, "SKILL.md"),
    skillSha256: job.aiSkill.skillSha256,
    gitRevision: job.aiSkill.gitRevision,
    capabilityManifestFile: join(job.aiSkill.root, "references", "capabilities.json"),
    capabilityManifestSha256: job.aiSkill.capabilityManifestSha256,
    capabilitySchemaVersion: job.aiSkill.capabilitySchemaVersion,
    contracts: job.aiSkill.contracts,
    routingOrder: job.aiSkill.routingOrder,
    outputs: job.aiSkill.outputs,
    workflowPreflight: job.aiSkill.workflowPreflight,
    scripts: Object.fromEntries(Object.entries(job.aiSkill.scripts).map(([name, script]) => [name, script.path])) as import("../dependencies/schemas.js").AiImageSkillDependency["scripts"],
    scriptSha256: Object.fromEntries(Object.entries(job.aiSkill.scripts).map(([name, script]) => [name, script.sha256])) as import("../dependencies/schemas.js").AiImageSkillDependency["scriptSha256"],
  };
}

function validateRoutingPage(
  job: ImageGenerationJob,
  slideId: string,
  dependency: z.output<typeof DependencyGenerationResultSchema>,
  report: SerialStickyReport,
): void {
  report.pages.forEach((entry, index) => {
    if (entry.page !== index + 1 || !job.pages[index]) {
      throw new Error("routing report includes a page outside the immutable serial job prefix");
    }
  });
  const pageNumber = job.pages.findIndex((page) => page.slideId === slideId) + 1;
  const evidence = report.pages.find(({ page }) => page === pageNumber);
  if (!evidence) throw new Error("routing report does not contain the delegated result page");
  const expectedCandidate = `${dependency.channel}-${dependency.provider}`;
  const fallback = new Set(["unavailable", "auth_unavailable", "retryable_exhausted"]);
  if (dependency.status === "success") {
    if (evidence.outcome !== "success" || evidence.candidate !== expectedCandidate) {
      throw new Error("routing report provider/channel candidate does not match dependency success");
    }
  } else if (fallback.has(dependency.status)) {
    if (evidence.outcome !== "exhausted" || evidence.candidate !== null || expectedCandidate !== "api-doubao") {
      throw new Error("routing report exhausted outcome does not bind the live final api-doubao candidate");
    }
  } else if (evidence.outcome !== "fatal" || evidence.candidate !== expectedCandidate) {
    throw new Error("routing report fatal provider/channel candidate does not match the dependency result");
  }
}

function validateRoutingReport(job: ImageGenerationJob, intake: z.output<typeof DelegatedResultIntakeSchema>): void {
  validateRoutingPage(job, intake.slideId, intake.dependency, intake.batchReport);
}

async function readImageArtifact(root: string, path: string, label: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readOwnedRegularFile(root, path, { maxBytes: MAX_IMAGE_BYTES });
  } catch (error: unknown) {
    throw new Error(`${label} artifact is unavailable or unsafe`, { cause: error });
  }
  if (bytes.length <= 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error(`${label} artifact exceeds its size limit`);
  try {
    const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    if (!metadata.width || !metadata.height) throw new Error("dimensions unavailable");
  } catch (error: unknown) {
    throw new Error(`${label} artifact is not a decodable image`, { cause: error });
  }
  return bytes;
}

async function authenticatedArtifacts(
  root: string,
  job: ImageGenerationJob,
  page: ImageGenerationJob["pages"][number],
  dependency: z.output<typeof DependencyGenerationResultSchema>,
  publishNormalized: boolean,
): Promise<ImagePageResult["artifacts"]> {
  if (dependency.status !== "success") return null;
  const expectedMaster = projectPath(root, page.target);
  if (!isAbsolute(dependency.output_path!) || dependency.output_path !== expectedMaster) {
    throw new Error("dependency output path does not bind the immutable job target");
  }
  const masterBytes = await readImageArtifact(root, page.target, "master");
  const masterMetadata = await sharp(masterBytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  if (
    masterMetadata.format !== "png"
    || !masterMetadata.width
    || !masterMetadata.height
    || masterMetadata.width * 9 !== masterMetadata.height * 16
  ) throw new Error("master artifact must be a strict 16:9 PNG");

  const outputBase = `generation/jobs/${job.jobId}/ai-image-output`;
  const rawPath = `${outputBase}/raw/${page.slideId}.png`;
  let raw: Artifact | null = null;
  try {
    const rawBytes = await readImageArtifact(root, rawPath, "raw");
    raw = { path: rawPath, sha256: sha256(rawBytes), revisionId: job.projectRevisionId };
  } catch (error: unknown) {
    if (dependency.channel === "host" || !isMissing(error)) {
      if (dependency.channel === "host") throw new Error("host success requires an authenticated raw artifact", { cause: error });
      throw error;
    }
  }

  const normalizedPath = `generation/jobs/${job.jobId}/normalized/${page.slideId}.png`;
  const expectedNormalizedBytes = await sharp(masterBytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS })
    .resize(1920, 1080, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  let normalizedBytes: Buffer | null = null;
  try {
    normalizedBytes = await readOwnedRegularFile(root, normalizedPath, { maxBytes: MAX_IMAGE_BYTES });
    const metadata = await sharp(normalizedBytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    if (metadata.width !== 1920 || metadata.height !== 1080 || metadata.format !== "png") {
      throw new Error("existing normalized artifact has invalid dimensions");
    }
    if (!normalizedBytes.equals(expectedNormalizedBytes)) {
      throw new Error("normalized artifact is not the deterministic derivative of the authenticated master");
    }
  } catch (error: unknown) {
    if (!isMissing(error)) throw new Error("normalized artifact is unsafe, invalid, or not deterministic from master", { cause: error });
  }
  if (normalizedBytes === null) {
    normalizedBytes = expectedNormalizedBytes;
  }
  if (publishNormalized) {
    let alreadyPublished = true;
    try { await readOwnedRegularFile(root, normalizedPath, { maxBytes: MAX_IMAGE_BYTES }); } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      alreadyPublished = false;
    }
    if (!alreadyPublished) {
      const project = openGenerationDirectory(root);
      const generation = project.child("generation", false);
      const jobs = generation.child("jobs", false);
      const jobDir = jobs.child(job.jobId, false);
      const normalized = jobDir.child("normalized");
      const stagingName = `.${page.slideId}-${randomUUID()}.png`;
      try {
        normalized.writeExclusive(stagingName, normalizedBytes);
        normalized.promoteFileExclusive(stagingName, `${page.slideId}.png`);
        if (!normalized.readBounded(`${page.slideId}.png`, MAX_IMAGE_BYTES).equals(normalizedBytes)) {
          throw new Error("normalized artifact changed during atomic publication");
        }
      } catch (error: unknown) {
        try { normalized.remove(stagingName); } catch { /* absent after promotion */ }
        throw error;
      } finally {
        normalized.close();
        jobDir.close();
        jobs.close();
        generation.close();
        project.close();
      }
    }
  }
  return {
    raw,
    master: { path: page.target, sha256: sha256(masterBytes), revisionId: job.projectRevisionId },
    normalized: { path: normalizedPath, sha256: sha256(normalizedBytes!), revisionId: job.projectRevisionId },
  };
}

async function authenticateIntake(
  root: string,
  raw: DelegatedResultIntake,
  publishNormalized: boolean,
): Promise<AuthenticatedIntake> {
  let intake: z.output<typeof DelegatedResultIntakeSchema>;
  try {
    intake = DelegatedResultIntakeSchema.parse(raw);
  } catch (error: unknown) {
    throw new Error("delegated result intake is invalid", { cause: error });
  }
  const job = await readImageGenerationJob(root, intake.jobId);
  const page = job.pages.find(({ slideId }) => slideId === intake.slideId);
  if (!page || page.attempt !== intake.attempt) throw new Error("delegated result page is not declared by the immutable job");
  await assertAiImageSkillDependencyCurrent(dependencyBinding(job));
  await assertSealedJobInputs(root, job);
  if (
    intake.styleLockSha256 !== job.styleLockSha256
    || intake.styleRecipeSha256 !== job.styleLock.styleRecipeSha256
  ) throw new Error("delegated result Style Lock hashes do not match the immutable job");
  const expectedUsage = job.styleLock.referenceArtifacts.map(({ path, sha256 }) => ({ path, sha256 }));
  if (
    intake.referenceUsage.length !== expectedUsage.length
    || intake.referenceUsage.some((usage, index) => usage.path !== expectedUsage[index]?.path || usage.sha256 !== expectedUsage[index]?.sha256)
  ) throw new Error("delegated result reference usage does not match the Style Lock");
  intake.referenceUsage.forEach((usage, index) => {
    if (usage.usage === "unsupported" && job.styleLock.referenceArtifacts[index]?.role !== "art-direction") {
      throw new Error("only an art-direction reference may report unsupported usage");
    }
  });

  const prompt = await readOwnedRegularFile(root, page.promptArtifact);
  if (
    prompt.toString("utf8") !== page.finalPrompt
    || sha256(prompt) !== page.promptSha256
    || intake.actualPromptSha256 !== page.promptSha256
  ) throw new Error("delegated result prompt hash does not match the immutable job");
  validateRoutingReport(job, intake);

  const unsupportedArtDirection = intake.referenceUsage.some(({ usage }) => usage === "unsupported");
  const status: ImagePageResult["status"] = unsupportedArtDirection
    ? "paused"
    : intake.dependency.status === "success" ? "success" : "failed";
  let styleConsistency: ImagePageResult["styleConsistency"] = "not-reviewed";
  const authenticated = await authenticatedArtifacts(root, job, page, intake.dependency, publishNormalized && status === "success");
  if (status === "success" && intake.presentationQa) {
    if (!job.styleLock.approvedSample) throw new Error("provisional style samples cannot claim approved-sample consistency");
    if (!authenticated) throw new Error("successful delegated result is missing authenticated artifacts");
    styleConsistency = delegatedStyleConsistency(intake.presentationQa, {
      approvedSampleSha256: job.styleLock.approvedSample.sha256,
      normalizedImageSha256: authenticated.normalized.sha256,
      slideSpecSha256: page.specSnapshot.sha256,
      pageRole: page.spec.role,
      requiredText: page.spec.requiredText,
    });
  } else if (intake.presentationQa) {
    throw new Error("presentation QA is accepted only for a successful delegated page");
  }
  const artifacts = status === "success" ? authenticated : null;
  return { intake, job, page, status, styleConsistency, artifacts };
}

function pageWithoutTimestamp(page: ImagePageResult): Omit<ImagePageResult, "recordedAt"> {
  const { recordedAt: _recordedAt, ...content } = page;
  return content;
}

async function readExistingPage(root: string, jobId: string, slideId: string, attempt: number): Promise<ImagePageResult | null> {
  try {
    const bytes = await readOwnedRegularFile(root, `generation/jobs/${jobId}/results/${slideId}-${attempt}.json`);
    const parsed = ImagePageResultSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (bytes.toString("utf8") !== canonicalContractFile(parsed)) throw new Error("non-canonical page result");
    return parsed;
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw new Error("delegated page result is invalid or unsafe", { cause: error });
  }
}

async function readAggregate(root: string, jobId: string): Promise<ImageGenerationResult | null> {
  try {
    const bytes = await readOwnedRegularFile(root, `generation/jobs/${jobId}/result.json`);
    const parsed = ImageGenerationResultSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (bytes.toString("utf8") !== canonicalContractFile(parsed)) throw new Error("non-canonical aggregate result");
    return parsed;
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw new Error("delegated aggregate result is invalid or unsafe", { cause: error });
  }
}

async function pageResults(root: string, job: ImageGenerationJob): Promise<ImagePageResult[]> {
  const directory = join(root, "generation", "jobs", job.jobId, "results");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  const pages: ImagePageResult[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("delegated result directory contains an unsafe entry");
    const match = /^([a-f0-9-]+)-(\d+)\.json$/.exec(entry.name);
    if (!match) throw new Error("delegated result directory contains an unexpected entry");
    const page = await readExistingPage(root, job.jobId, match[1]!, Number(match[2]));
    if (!page || !job.pages.some((candidate) => candidate.slideId === page.slideId && candidate.attempt === page.attempt)) {
      throw new Error("delegated result directory contains an unauthorized page");
    }
    pages.push(page);
  }
  return pages.sort((left, right) =>
    job.pages.findIndex(({ slideId }) => slideId === left.slideId)
    - job.pages.findIndex(({ slideId }) => slideId === right.slideId)
  );
}

async function reauthenticateStoredPage(
  root: string,
  job: ImageGenerationJob,
  page: ImagePageResult,
  report: SerialStickyReport,
  ledger: Awaited<ReturnType<typeof readCallLedger>>,
): Promise<void> {
  const jobPage = job.pages.find((candidate) => candidate.slideId === page.slideId && candidate.attempt === page.attempt);
  if (
    !jobPage
    || page.jobId !== job.jobId
    || page.projectRevisionId !== job.projectRevisionId
    || page.actualPromptSha256 !== jobPage.promptSha256
    || page.styleLockSha256 !== job.styleLockSha256
    || page.styleRecipeSha256 !== job.styleLock.styleRecipeSha256
  ) throw new Error("aggregate page does not bind the immutable job identity");
  const expectedUsage = job.styleLock.referenceArtifacts.map(({ path, sha256 }) => ({ path, sha256 }));
  if (
    page.referenceUsage.length !== expectedUsage.length
    || page.referenceUsage.some((usage, index) => usage.path !== expectedUsage[index]?.path || usage.sha256 !== expectedUsage[index]?.sha256)
  ) throw new Error("aggregate page reference usage does not bind the immutable job");
  page.referenceUsage.forEach((usage, index) => {
    if (usage.usage === "unsupported" && job.styleLock.referenceArtifacts[index]?.role !== "art-direction") {
      throw new Error("aggregate page reports unsupported use for a non-art-direction reference");
    }
  });
  if (page.status !== "cached") {
    const expectedStatus: ImagePageResult["status"] = page.referenceUsage.some(({ usage }) => usage === "unsupported")
      ? "paused"
      : page.dependency.status === "success" ? "success" : "failed";
    if (page.status !== expectedStatus) throw new Error("aggregate page status conflicts with authenticated dependency and reference evidence");
  }
  const prompt = await readOwnedRegularFile(root, jobPage.promptArtifact);
  if (prompt.toString("utf8") !== jobPage.finalPrompt || sha256(prompt) !== jobPage.promptSha256) {
    throw new Error("aggregate page prompt artifact changed");
  }
  if (page.status !== "cached") {
    const admissions = ledger.filter((entry) => entry.entryKind === "admission"
      && entry.jobId === job.jobId
      && entry.slideId === page.slideId
      && entry.attempt === page.attempt);
    const terminals = ledger.filter((entry) => entry.entryKind === "terminal"
      && entry.jobId === job.jobId
      && entry.slideId === page.slideId
      && entry.attempt === page.attempt);
    if (
      admissions.length !== page.requestCount
      || terminals.length !== admissions.length
      || !admissions.some(({ requestOrdinal }) => requestOrdinal === page.requestOrdinal)
    ) throw new Error("aggregate page admission and terminal state is incomplete or conflicting");
    const terminal = terminals.find(({ requestOrdinal }) => requestOrdinal === page.requestOrdinal);
    const expectedTerminal = page.dependency.status === "success" ? "success" : "failed";
    if (!terminal || terminal.outcome !== expectedTerminal) {
      throw new Error("aggregate page terminal state does not bind the dependency result");
    }
  }
  if (page.status !== "cached") validateRoutingPage(job, page.slideId, page.dependency, report);
  const physical = await authenticatedArtifacts(root, job, jobPage, page.dependency, false);
  if (!sameJson(physical, page.artifacts)) throw new Error("aggregate page physical artifact hashes changed");
  let expectedConsistency: ImagePageResult["styleConsistency"] = "not-reviewed";
  if (page.presentationQa) {
    if (!job.styleLock.approvedSample || !physical) throw new Error("aggregate page QA lacks approved physical evidence");
    expectedConsistency = delegatedStyleConsistency(page.presentationQa, {
      approvedSampleSha256: job.styleLock.approvedSample.sha256,
      normalizedImageSha256: physical.normalized.sha256,
      slideSpecSha256: jobPage.specSnapshot.sha256,
      pageRole: jobPage.spec.role,
      requiredText: jobPage.spec.requiredText,
    });
  }
  if (expectedConsistency !== page.styleConsistency) throw new Error("aggregate page presentation QA decision changed");
}

async function reauthenticateAggregatePages(
  root: string,
  job: ImageGenerationJob,
  report: SerialStickyReport,
  pages: ImagePageResult[],
  ledger: Awaited<ReturnType<typeof readCallLedger>>,
): Promise<void> {
  if (report.pages.length !== pages.length) {
    throw new Error("routing report pages do not match the authenticated page intake records");
  }
  for (const [index, page] of pages.entries()) {
    const jobIndex = job.pages.findIndex(({ slideId }) => slideId === page.slideId);
    const evidence = report.pages[index];
    if (!evidence || evidence.page !== jobIndex + 1) {
      throw new Error("routing report page order does not match authenticated page intake records");
    }
    if (page.status === "cached") {
      if (evidence.outcome !== "cached") throw new Error("routing report does not bind the cached page result");
    }
    await reauthenticateStoredPage(root, job, page, report, ledger);
  }
}

async function reauthenticateAggregate(
  root: string,
  job: ImageGenerationJob,
  aggregate: ImageGenerationResult,
  ledger: Awaited<ReturnType<typeof readCallLedger>>,
): Promise<void> {
  if (
    aggregate.jobId !== job.jobId
    || aggregate.projectRevisionId !== job.projectRevisionId
    || aggregate.styleRecipeSha256 !== job.styleLock.styleRecipeSha256
    || aggregate.approvedSampleSha256 !== (job.styleLock.approvedSample?.sha256 ?? null)
  ) throw new Error("delegated aggregate identity does not bind the immutable job");
  await reauthenticateAggregatePages(root, job, aggregate.batchReport, aggregate.pages, ledger);
  if (aggregate.outcome !== aggregateOutcome(job, aggregate.pages, aggregate.batchReport)) {
    throw new Error("delegated aggregate outcome conflicts with authenticated page evidence");
  }
}

export type ReauthenticatedDelegatedResult = {
  job: ImageGenerationJob;
  result: ImageGenerationResult;
  authorizationSequence: number | null;
};

export async function readAndReauthenticateDelegatedResult(
  root: string,
  jobId: string,
): Promise<ReauthenticatedDelegatedResult> {
  const job = await readImageGenerationJob(root, jobId);
  const authorizationSequence = await assertAuthorizedJobBinding(root, job);
  const result = await readAggregate(root, jobId);
  if (!result) throw new Error("delegated aggregate result is unavailable");
  const ledger = await readCallLedger(root);
  await reauthenticateAggregate(root, job, result, ledger);
  const storedPages = await pageResults(root, job);
  if (!sameJson(storedPages, result.pages)) {
    throw new Error("delegated aggregate pages do not match immutable page results");
  }
  return { job, result, authorizationSequence };
}

function aggregateOutcome(job: ImageGenerationJob, pages: ImagePageResult[], report: SerialStickyReport): ImageGenerationResult["outcome"] {
  if (pages.some(({ status }) => status === "paused")) return "attention-required";
  const terminal = report.pages.at(-1)?.outcome;
  if (terminal === "fatal") return "fatal";
  if (terminal === "exhausted") return "exhausted";
  if (
    pages.length === job.pages.length
    && pages.every(({ status }) => status === "success" || status === "cached")
    && (job.styleLock.approvalState === "provisional" || pages.every(({ styleConsistency }) => styleConsistency === "accepted"))
  ) return "success";
  return "partial";
}

type AttachmentPrecedence = {
  authorizationSequence: number;
  attempt: number;
  jobId: string;
};

type AttachmentDecision = {
  page: ImagePageResult;
  action: "attach" | "keep";
  prior: AttachmentPrecedence | null;
};

function authenticatedAttachmentPrecedence(
  job: ImageGenerationJob,
  page: ImagePageResult,
  authorizationSequence: number | null,
): AttachmentPrecedence {
  if (authorizationSequence === null) throw new Error("deck attachment requires trusted generation authorization");
  return { authorizationSequence, attempt: page.attempt, jobId: job.jobId };
}

async function currentAttachmentPrecedence(
  root: string,
  manifest: ProjectManifest,
  slideId: string,
  cache: Map<string, ReauthenticatedDelegatedResult>,
): Promise<AttachmentPrecedence | null> {
  const slide = manifest.slides.find(({ id }) => id === slideId);
  if (!slide?.image) return null;
  const escapedSlideId = slideId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^generation/jobs/([0-9a-f-]{36})/normalized/${escapedSlideId}\\.png$`).exec(slide.image.path);
  if (!match) return null;
  const authenticated = cache.get(match[1]!) ?? await readAndReauthenticateDelegatedResult(root, match[1]!);
  cache.set(match[1]!, authenticated);
  const page = authenticated.result.pages.find(({ slideId: candidate }) => candidate === slideId);
  if (
    !page
    || !page.artifacts
    || page.styleConsistency !== "accepted"
    || page.status !== "success"
    || !sameJson(page.artifacts.normalized, slide.image)
  ) throw new Error("current delegated attachment is not authenticated");
  return authenticatedAttachmentPrecedence(authenticated.job, page, authenticated.authorizationSequence);
}

function compareAttachmentPrecedence(left: AttachmentPrecedence, right: AttachmentPrecedence): number {
  return left.authorizationSequence - right.authorizationSequence || left.attempt - right.attempt;
}

function stageAfterAcceptedPageAttachment(
  manifest: ProjectManifest,
  page: ImagePageResult,
): ProjectManifest["stage"] {
  const pending = manifest.pendingDeckEdit;
  return manifest.stage === "revising"
    && pending?.slideId === page.slideId
    && manifest.currentDeck?.revisionId === pending.revisionId
    && manifest.currentDeck.sha256 === pending.sha256
    ? "revising"
    : "generating";
}

function attachAcceptedPage(
  manifest: ProjectManifest,
  page: ImagePageResult,
  job: ImageGenerationJob,
  prior: AttachmentPrecedence | null,
): ProjectManifest {
  if (
    manifest.currentRevision.id !== page.projectRevisionId
    || page.status !== "success"
    || page.styleConsistency !== "accepted"
    || !page.artifacts
  ) return manifest;
  const index = manifest.slides.findIndex(({ id }) => id === page.slideId);
  if (index < 0) {
    const jobPage = job.pages.find(({ slideId }) => slideId === page.slideId);
    if (!jobPage) return manifest;
    const slides = [...manifest.slides, {
      id: page.slideId,
      order: jobPage.order,
      title: jobPage.spec.title,
      role: jobPage.spec.role,
      specRevisionId: page.projectRevisionId,
      promptRevisionId: page.projectRevisionId,
      styleRevisionId: page.projectRevisionId,
      status: "ready" as const,
      image: page.artifacts.normalized,
      editable: null,
      finalRender: page.artifacts.normalized,
      staleReasons: [],
    }].sort((left, right) => left.order - right.order);
    return { ...manifest, stage: stageAfterAcceptedPageAttachment(manifest, page), slides };
  }
  const slides = [...manifest.slides];
  const previous = slides[index]!;
  const generationHistory = prior && previous.image && previous.finalRender
    ? [...(previous.generationHistory ?? []), {
      jobId: prior.jobId,
      authorizationSequence: prior.authorizationSequence,
      attempt: prior.attempt,
      image: previous.image,
      finalRender: previous.finalRender,
    }]
    : previous.generationHistory;
  slides[index] = {
    ...previous,
    ...(generationHistory ? { generationHistory } : {}),
    promptRevisionId: page.projectRevisionId,
    styleRevisionId: page.projectRevisionId,
    status: "ready",
    image: page.artifacts.normalized,
    finalRender: page.artifacts.normalized,
  };
  return { ...manifest, stage: stageAfterAcceptedPageAttachment(manifest, page), slides };
}

function attachAcceptedPages(
  manifest: ProjectManifest,
  decisions: AttachmentDecision[],
  job: ImageGenerationJob,
): ProjectManifest {
  let attached = manifest;
  for (const decision of decisions) {
    if (decision.action === "attach") attached = attachAcceptedPage(attached, decision.page, job, decision.prior);
  }
  return attached;
}

class AttachmentRaceError extends Error {}

async function attachAcceptedPagesMonotonically(
  root: string,
  pages: ImagePageResult[],
  job: ImageGenerationJob,
): Promise<void> {
  const accepted = pages.filter((page) =>
    page.status === "success" && page.styleConsistency === "accepted" && page.artifacts
  );
  if (accepted.length === 0) return;
  const authenticatedIncoming = await readAndReauthenticateDelegatedResult(root, job.jobId);
  const incoming = new Map<string, AttachmentPrecedence>();
  for (const page of accepted) incoming.set(
    page.slideId,
    authenticatedAttachmentPrecedence(job, page, authenticatedIncoming.authorizationSequence),
  );

  for (let retry = 0; retry < 3; retry += 1) {
    const before = await readProject(root);
    const cache = new Map<string, ReauthenticatedDelegatedResult>([[job.jobId, authenticatedIncoming]]);
    const decisions: AttachmentDecision[] = [];
    for (const page of accepted) {
      const prior = await currentAttachmentPrecedence(root, before, page.slideId, cache);
      if (!prior) {
        decisions.push({ page, action: "attach", prior: null });
        continue;
      }
      const next = incoming.get(page.slideId)!;
      const comparison = compareAttachmentPrecedence(next, prior);
      if (comparison < 0) {
        decisions.push({ page, action: "keep", prior });
      } else if (comparison > 0) {
        decisions.push({ page, action: "attach", prior });
      } else {
        const current = before.slides.find(({ id }) => id === page.slideId)!;
        if (next.jobId !== prior.jobId || !sameJson(current.image, page.artifacts!.normalized)) {
          throw new Error("conflicting delegated attachment at the same authenticated precedence");
        }
        decisions.push({ page, action: "keep", prior });
      }
    }
    if (decisions.every(({ action }) => action === "keep")) return;
    try {
      await updateProjectWithDelegatedGenerationAttachment(root, (current) => {
        for (const decision of decisions) {
          const priorSlide = before.slides.find(({ id }) => id === decision.page.slideId);
          const currentSlide = current.slides.find(({ id }) => id === decision.page.slideId);
          if (!sameJson(priorSlide?.image ?? null, currentSlide?.image ?? null)
            || !sameJson(priorSlide?.finalRender ?? null, currentSlide?.finalRender ?? null)) {
            throw new AttachmentRaceError("delegated attachment changed while authenticating");
          }
        }
        return attachAcceptedPages(current, decisions, job);
      });
      return;
    } catch (error: unknown) {
      if (!(error instanceof AttachmentRaceError) || retry === 2) throw error;
    }
  }
}

export async function recordDelegatedResult(
  root: string,
  raw: DelegatedResultIntake,
  operations: {
    checkpoint?: (step: "after-page-promotion" | "after-aggregate-promotion" | "before-manifest-attach" | "after-manifest-attach") => Promise<void> | void;
  } = {},
): Promise<ImageGenerationResult> {
  return withGenerationLease(root, async (canonicalRoot) => {
  await assertProjectMutationNotFrozen(canonicalRoot);
  const preflight = await authenticateIntake(canonicalRoot, raw, false);
  await settleDelegatedGenerationCall(canonicalRoot, {
    jobId: preflight.job.jobId,
    slideId: preflight.page.slideId,
    attempt: preflight.page.attempt,
    requestOrdinal: preflight.intake.requestOrdinal,
    admissionToken: preflight.intake.admissionToken,
    outcome: preflight.intake.dependency.status === "success" ? "success" : "failed",
  });

  const publication = await withGenerationLease(canonicalRoot, async (canonicalRoot) => {
    const authenticated = await authenticateIntake(canonicalRoot, raw, false);
    const ledger = await readCallLedgerUnderGenerationLease(canonicalRoot);
    const requestCount = ledger.filter((entry) =>
      entry.entryKind === "admission"
      && entry.jobId === authenticated.job.jobId
      && entry.slideId === authenticated.page.slideId
      && entry.attempt === authenticated.page.attempt
    ).length;
    if (requestCount <= 0 || requestCount > authenticated.job.callBudget) {
      throw new Error("delegated result actual request count does not match authorized admissions");
    }
    const candidate = ImagePageResultSchema.parse({
      contractVersion: 1,
      jobId: authenticated.job.jobId,
      projectRevisionId: authenticated.job.projectRevisionId,
      slideId: authenticated.page.slideId,
      attempt: authenticated.page.attempt,
      requestOrdinal: authenticated.intake.requestOrdinal,
      requestCount,
      status: authenticated.status,
      dependency: authenticated.intake.dependency,
      actualPromptSha256: authenticated.intake.actualPromptSha256,
      styleLockSha256: authenticated.intake.styleLockSha256,
      styleRecipeSha256: authenticated.intake.styleRecipeSha256,
      referenceUsage: authenticated.intake.referenceUsage,
      artifacts: authenticated.artifacts,
      styleConsistency: authenticated.styleConsistency,
      presentationQa: authenticated.intake.presentationQa,
      recordedAt: new Date().toISOString(),
    });
    const existing = await readExistingPage(
      canonicalRoot,
      authenticated.job.jobId,
      authenticated.page.slideId,
      authenticated.page.attempt,
    );
    if (existing && !sameJson(pageWithoutTimestamp(existing), pageWithoutTimestamp(candidate))) {
      throw new Error("conflicting delegated result replay");
    }
    const priorPages = await pageResults(canonicalRoot, authenticated.job);
    const mergedPages = [...priorPages.filter(({ slideId }) => slideId !== candidate.slideId), existing ?? candidate].sort((left, right) =>
      authenticated.job.pages.findIndex(({ slideId }) => slideId === left.slideId)
      - authenticated.job.pages.findIndex(({ slideId }) => slideId === right.slideId)
    );
    await reauthenticateAggregatePages(canonicalRoot, authenticated.job, authenticated.intake.batchReport, mergedPages, ledger);
    const priorAggregate = await readAggregate(canonicalRoot, authenticated.job.jobId);
    if (priorAggregate) {
      await reauthenticateAggregate(canonicalRoot, authenticated.job, priorAggregate, ledger);
      if (priorAggregate.pages.length > mergedPages.length) {
        throw new Error("delegated aggregate contains pages absent from immutable intake records");
      }
      if (!priorAggregate.pages.every((page, index) => sameJson(page, mergedPages[index]))) {
        throw new Error("delegated aggregate conflicts with immutable page results");
      }
      if (
        !sameJson(priorAggregate.batchReport.pages, authenticated.intake.batchReport.pages.slice(0, priorAggregate.batchReport.pages.length))
        || !sameJson(priorAggregate.batchReport.switches, authenticated.intake.batchReport.switches.slice(0, priorAggregate.batchReport.switches.length))
      ) throw new Error("delegated aggregate routing evidence is not an immutable prefix");
    }

    const publishedAuthentication = await authenticateIntake(canonicalRoot, raw, true);
    const publishedCandidate = existing ?? ImagePageResultSchema.parse({
      ...candidate,
      artifacts: publishedAuthentication.artifacts,
    });
    if (existing) await reauthenticateStoredPage(canonicalRoot, authenticated.job, existing, authenticated.intake.batchReport, ledger);
    if (!existing) {
      const project = openGenerationDirectory(canonicalRoot);
      const generation = project.child("generation", false);
      const jobs = generation.child("jobs", false);
      const jobDir = jobs.child(authenticated.job.jobId, false);
      const results = jobDir.child("results");
      try { results.writeExclusive(`${publishedCandidate.slideId}-${publishedCandidate.attempt}.json`, canonicalContractFile(publishedCandidate)); }
      finally {
        results.close(); jobDir.close(); jobs.close(); generation.close(); project.close();
      }
    }
    await operations.checkpoint?.("after-page-promotion");

    const pages = await pageResults(canonicalRoot, authenticated.job);
    await reauthenticateAggregatePages(canonicalRoot, authenticated.job, authenticated.intake.batchReport, pages, ledger);
    const aggregate = ImageGenerationResultSchema.parse({
      contractVersion: 1,
      jobId: authenticated.job.jobId,
      projectRevisionId: authenticated.job.projectRevisionId,
      styleRecipeSha256: authenticated.job.styleLock.styleRecipeSha256,
      approvedSampleSha256: authenticated.job.styleLock.approvedSample?.sha256 ?? null,
      outcome: aggregateOutcome(authenticated.job, pages, authenticated.intake.batchReport),
      actualRequestCount: pages.reduce((sum, page) => sum + page.requestCount, 0),
      batchReport: authenticated.intake.batchReport,
      pages,
      updatedAt: new Date().toISOString(),
    });
    let result = aggregate;
    let aggregateCurrent = false;
    if (priorAggregate) {
      if (priorAggregate.pages.length === aggregate.pages.length) {
        const { updatedAt: _priorUpdatedAt, ...priorContent } = priorAggregate;
        const { updatedAt: _aggregateUpdatedAt, ...aggregateContent } = aggregate;
        if (!sameJson(priorContent, aggregateContent)) throw new Error("conflicting delegated aggregate replay");
        result = priorAggregate;
        aggregateCurrent = true;
      }
    }
    if (!aggregateCurrent) {
      const projectForAggregate = openGenerationDirectory(canonicalRoot);
      const generationForAggregate = projectForAggregate.child("generation", false);
      const jobsForAggregate = generationForAggregate.child("jobs", false);
      const jobForAggregate = jobsForAggregate.child(authenticated.job.jobId, false);
      try { jobForAggregate.replace("result.json", canonicalContractFile(aggregate), `.result-${randomUUID()}.json`); }
      finally { jobForAggregate.close(); jobsForAggregate.close(); generationForAggregate.close(); projectForAggregate.close(); }
    }
    await operations.checkpoint?.("after-aggregate-promotion");
    return result;
  });

  await operations.checkpoint?.("before-manifest-attach");
  await attachAcceptedPagesMonotonically(canonicalRoot, publication.pages, preflight.job);
  await operations.checkpoint?.("after-manifest-attach");
  return publication;
  });
}
