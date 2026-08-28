import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import sharp from "sharp";
import { z } from "zod";

import { assertAiImageSkillDependencyCurrent, readCallLedger, settleDelegatedGenerationCall } from "./authorization.js";
import { openGenerationDirectory } from "./anchored-dir.js";
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
import { SlideSpecSchema } from "../planning/schemas.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { readProject, updateProject } from "../project/store.js";
import { Sha256Schema, type Artifact, type ProjectManifest } from "../project/schemas.js";
import { StyleLockSchema } from "../styles/schemas.js";

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
    scripts: {
      generationResult: job.aiSkill.scripts.generationResult.path,
      hostRoutingPolicy: job.aiSkill.scripts.hostRoutingPolicy.path,
      importHostImage: job.aiSkill.scripts.importHostImage.path,
      prepareEditableInput: job.aiSkill.scripts.prepareEditableInput.path,
    },
    scriptSha256: {
      generationResult: job.aiSkill.scripts.generationResult.sha256,
      hostRoutingPolicy: job.aiSkill.scripts.hostRoutingPolicy.sha256,
      importHostImage: job.aiSkill.scripts.importHostImage.sha256,
      prepareEditableInput: job.aiSkill.scripts.prepareEditableInput.sha256,
    },
  };
}

function validateRoutingReport(job: ImageGenerationJob, intake: z.output<typeof DelegatedResultIntakeSchema>): void {
  const report = intake.batchReport;
  report.pages.forEach((entry, index) => {
    if (entry.page !== index + 1 || !job.pages[index]) {
      throw new Error("routing report includes a page outside the immutable serial job prefix");
    }
  });
  const pageNumber = job.pages.findIndex(({ slideId }) => slideId === intake.slideId) + 1;
  const evidence = report.pages.find(({ page }) => page === pageNumber);
  if (!evidence) throw new Error("routing report does not contain the delegated result page");
  const expectedCandidate = intake.dependency.channel && intake.dependency.provider
    ? `${intake.dependency.channel}-${intake.dependency.provider}`
    : null;
  if (evidence.candidate !== null && evidence.candidate !== expectedCandidate) {
    throw new Error("routing report provider/channel does not match the delegated result");
  }
  if (intake.dependency.status === "success" && evidence.outcome !== "success") {
    throw new Error("routing report outcome does not match dependency success");
  }
  if (intake.dependency.status !== "success" && evidence.outcome === "success") {
    throw new Error("routing report outcome does not match dependency failure");
  }
}

async function readImageArtifact(root: string, path: string, label: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readOwnedRegularFile(root, path);
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
  intake: z.output<typeof DelegatedResultIntakeSchema>,
  publishNormalized: boolean,
): Promise<ImagePageResult["artifacts"]> {
  if (intake.dependency.status !== "success") return null;
  const expectedMaster = projectPath(root, page.target);
  if (!isAbsolute(intake.dependency.output_path!) || intake.dependency.output_path !== expectedMaster) {
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
    if (intake.dependency.channel === "host" || !isMissing(error)) {
      if (intake.dependency.channel === "host") throw new Error("host success requires an authenticated raw artifact", { cause: error });
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
    normalizedBytes = await readOwnedRegularFile(root, normalizedPath);
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
    try { await readOwnedRegularFile(root, normalizedPath); } catch (error: unknown) {
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

  const lockBytes = await readOwnedRegularFile(root, job.styleLockPath);
  let lock;
  try { lock = StyleLockSchema.parse(JSON.parse(lockBytes.toString("utf8"))); } catch (error: unknown) {
    throw new Error("delegated result Style Lock is invalid", { cause: error });
  }
  if (
    sha256(lockBytes) !== job.styleLockSha256
    || !sameJson(lock, job.styleLock)
    || intake.styleLockSha256 !== job.styleLockSha256
    || intake.styleRecipeSha256 !== job.styleLock.styleRecipeSha256
  ) throw new Error("delegated result Style Lock hashes do not match the immutable job");
  const recipe = await readOwnedRegularFile(root, "style/recipe.json");
  if (sha256(recipe) !== job.styleLock.styleRecipeSha256) throw new Error("delegated result style recipe hash changed");
  if (job.styleLock.approvedSample) {
    const sample = await readOwnedRegularFile(root, job.styleLock.approvedSample.path);
    if (sha256(sample) !== job.styleLock.approvedSample.sha256) throw new Error("delegated result approved sample hash changed");
  }
  for (const reference of job.styleLock.referenceArtifacts) {
    if (sha256(await readOwnedRegularFile(root, reference.path)) !== reference.sha256) {
      throw new Error("delegated result reference artifact hash changed");
    }
  }
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

  const spec = SlideSpecSchema.parse(JSON.parse((await readOwnedRegularFile(root, `slides/${page.slideId}/spec.json`)).toString("utf8")));
  if (spec.slideId !== page.slideId) throw new Error("delegated result page role is not bound to the slide spec");
  const unsupportedArtDirection = intake.referenceUsage.some(({ usage }) => usage === "unsupported");
  const status: ImagePageResult["status"] = unsupportedArtDirection
    ? "paused"
    : intake.dependency.status === "success" ? "success" : "failed";
  let styleConsistency: ImagePageResult["styleConsistency"] = "not-reviewed";
  if (status === "success" && intake.presentationQa) {
    if (!job.styleLock.approvedSample) throw new Error("provisional style samples cannot claim approved-sample consistency");
    styleConsistency = delegatedStyleConsistency(intake.presentationQa, {
      approvedSampleSha256: job.styleLock.approvedSample.sha256,
      pageRole: spec.role,
    });
  } else if (intake.presentationQa) {
    throw new Error("presentation QA is accepted only for a successful delegated page");
  }
  const authenticated = await authenticatedArtifacts(root, job, page, intake, publishNormalized && status === "success");
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
  const entries = await readdir(directory, { withFileTypes: true });
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

function validateAggregateReport(
  job: ImageGenerationJob,
  report: SerialStickyReport,
  pages: ImagePageResult[],
): void {
  if (report.pages.length !== pages.length) {
    throw new Error("routing report pages do not match the authenticated page intake records");
  }
  pages.forEach((page, index) => {
    const jobIndex = job.pages.findIndex(({ slideId }) => slideId === page.slideId);
    const evidence = report.pages[index];
    if (!evidence || evidence.page !== jobIndex + 1) {
      throw new Error("routing report page order does not match authenticated page intake records");
    }
    if (page.status === "cached") {
      if (evidence.outcome !== "cached") throw new Error("routing report does not bind the cached page result");
      return;
    }
    const expectedCandidate = page.dependency.channel && page.dependency.provider
      ? `${page.dependency.channel}-${page.dependency.provider}`
      : null;
    if (evidence.candidate !== null && evidence.candidate !== expectedCandidate) {
      throw new Error("routing report provider/channel conflicts with an authenticated page result");
    }
    if ((page.dependency.status === "success") !== (evidence.outcome === "success")) {
      throw new Error("routing report outcome conflicts with an authenticated page result");
    }
  });
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

function attachAcceptedPage(manifest: ProjectManifest, page: ImagePageResult): ProjectManifest {
  if (
    manifest.currentRevision.id !== page.projectRevisionId
    || page.status !== "success"
    || page.styleConsistency !== "accepted"
    || !page.artifacts
  ) return manifest;
  const index = manifest.slides.findIndex(({ id }) => id === page.slideId);
  if (index < 0) return manifest;
  const slides = [...manifest.slides];
  slides[index] = {
    ...slides[index]!,
    promptRevisionId: page.projectRevisionId,
    styleRevisionId: page.projectRevisionId,
    status: "ready",
    image: page.artifacts.normalized,
    finalRender: page.artifacts.normalized,
  };
  return { ...manifest, stage: "generating", slides };
}

export async function recordDelegatedResult(
  root: string,
  raw: DelegatedResultIntake,
): Promise<ImageGenerationResult> {
  const preflight = await authenticateIntake(root, raw, false);
  await settleDelegatedGenerationCall(root, {
    jobId: preflight.job.jobId,
    slideId: preflight.page.slideId,
    attempt: preflight.page.attempt,
    requestOrdinal: preflight.intake.requestOrdinal,
    admissionToken: preflight.intake.admissionToken,
    outcome: preflight.intake.dependency.status === "success" ? "success" : "failed",
  });

  const publication = await withProjectLease(root, "generation", async (canonicalRoot) => {
    const authenticated = await authenticateIntake(canonicalRoot, raw, true);
    const ledger = await readCallLedger(canonicalRoot);
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
      requestCount,
      status: authenticated.status,
      dependency: authenticated.intake.dependency,
      actualPromptSha256: authenticated.intake.actualPromptSha256,
      styleLockSha256: authenticated.intake.styleLockSha256,
      styleRecipeSha256: authenticated.intake.styleRecipeSha256,
      referenceUsage: authenticated.intake.referenceUsage,
      artifacts: authenticated.artifacts,
      styleConsistency: authenticated.styleConsistency,
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

    const project = openGenerationDirectory(canonicalRoot);
    const generation = project.child("generation", false);
    const jobs = generation.child("jobs", false);
    const jobDir = jobs.child(authenticated.job.jobId, false);
    const results = jobDir.child("results");
    try {
      if (!existing) results.writeExclusive(`${candidate.slideId}-${candidate.attempt}.json`, canonicalContractFile(candidate));
    } finally {
      results.close();
      jobDir.close();
      jobs.close();
      generation.close();
      project.close();
    }

    const pages = await pageResults(canonicalRoot, authenticated.job);
    validateAggregateReport(authenticated.job, authenticated.intake.batchReport, pages);
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
    const priorAggregate = await readAggregate(canonicalRoot, authenticated.job.jobId);
    if (existing && priorAggregate && sameJson(priorAggregate.batchReport, aggregate.batchReport)) {
      return { result: priorAggregate, replayed: true };
    }
    const projectForAggregate = openGenerationDirectory(canonicalRoot);
    const generationForAggregate = projectForAggregate.child("generation", false);
    const jobsForAggregate = generationForAggregate.child("jobs", false);
    const jobForAggregate = jobsForAggregate.child(authenticated.job.jobId, false);
    try {
      jobForAggregate.replace("result.json", canonicalContractFile(aggregate), `.result-${randomUUID()}.json`);
    } finally {
      jobForAggregate.close();
      jobsForAggregate.close();
      generationForAggregate.close();
      projectForAggregate.close();
    }
    return { result: aggregate, replayed: false };
  });

  if (!publication.replayed && publication.result.pages.some((page) => page.styleConsistency === "accepted")) {
    const manifest = await readProject(root);
    if (
      manifest.currentRevision.id === publication.result.projectRevisionId
      && publication.result.pages.some((page) => manifest.slides.some(({ id }) => id === page.slideId))
    ) await updateProject(root, (current) => publication.result.pages.reduce(attachAcceptedPage, current));
  }
  return publication.result;
}
