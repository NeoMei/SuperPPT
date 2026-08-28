import { closeSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import type { AiImageSkillDependency } from "../dependencies/schemas.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import {
  canonicalStyleSample,
  delegatedStyleSampleArtifacts,
  STYLE_SAMPLE_COMPLETION_RECEIPT,
  STYLE_SAMPLE_ARTIFACTS,
  StyleSampleCompletionReceiptSchema,
  validateCanonicalStyleSample,
  type StyleSampleCompletionReceipt,
  type StyleSampleArtifacts,
} from "../styles/sample-contract.js";
import { openGenerationDirectory } from "./anchored-dir.js";
import { authorizationCallBudget, authorizationForPreparation } from "./authorization.js";
import { readAndReauthenticateDelegatedResult } from "./delegation-result.js";
import { type ImageGenerationJob } from "./job-schemas.js";
import { prepareImageGenerationJob } from "./jobs.js";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalReceiptFile(receipt: StyleSampleCompletionReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function artifactHashes(values: StyleSampleArtifacts): StyleSampleCompletionReceipt["artifactHashes"] {
  return Object.fromEntries(STYLE_SAMPLE_ARTIFACTS.map((path) => [path, sha256(values[path])])) as StyleSampleCompletionReceipt["artifactHashes"];
}

function sampleJobPath(job: ImageGenerationJob): string {
  return `generation/jobs/${job.jobId}/job.json`;
}

function sampleResultPath(job: ImageGenerationJob): string {
  return `generation/jobs/${job.jobId}/result.json`;
}

function isMissing(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ((current as NodeJS.ErrnoException).code === "ENOENT") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function readReceipt(root: string): Promise<StyleSampleCompletionReceipt> {
  const bytes = await readOwnedRegularFile(root, STYLE_SAMPLE_COMPLETION_RECEIPT).catch((error: unknown) => {
    throw new Error("delegated style sample completion receipt is unavailable", { cause: error });
  });
  try {
    const receipt = StyleSampleCompletionReceiptSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (bytes.toString("utf8") !== canonicalReceiptFile(receipt)) throw new Error("non-canonical receipt");
    return receipt;
  } catch (error: unknown) {
    throw new Error("delegated style sample completion receipt is invalid", { cause: error });
  }
}

async function assertAcceptedSampleResult(root: string, job: ImageGenerationJob) {
  if (job.kind !== "style-sample" || job.callBudget !== 1 || job.pages.length !== 1) {
    throw new Error("style sample finalization requires an immutable one-call sample job");
  }
  const { result } = await readAndReauthenticateDelegatedResult(root, job.jobId);
  const page = result.pages[0];
  const expected = job.pages[0]!;
  if (
    result.jobId !== job.jobId
    || result.projectRevisionId !== job.projectRevisionId
    || result.outcome !== "success"
    || result.actualRequestCount !== 1
    || result.pages.length !== 1
    || !page
    || page.slideId !== expected.slideId
    || page.attempt !== expected.attempt
    || page.status !== "success"
    || page.styleConsistency !== "not-reviewed"
    || page.presentationQa !== null
    || !page.artifacts
    || page.actualPromptSha256 !== expected.promptSha256
    || page.styleLockSha256 !== job.styleLockSha256
    || page.styleRecipeSha256 !== job.styleLock.styleRecipeSha256
    || page.artifacts.normalized.path !== `generation/jobs/${job.jobId}/normalized/${expected.slideId}.png`
    || page.artifacts.normalized.revisionId !== job.projectRevisionId
  ) throw new Error("delegated style sample result is not an accepted authenticated one-call result");
  const budget = await authorizationCallBudget(root, job.authorizationDigest, job.callBudget);
  if (budget.consumed !== 1 || budget.remaining !== 0) throw new Error("delegated style sample must consume its one authorized call");
  return result;
}

function cleanupOwnedStyleTemps(style: ReturnType<typeof openGenerationDirectory>): void {
  for (const entry of readdirSync(style.path, { withFileTypes: true })) {
    if (!/^\.style-sample-finalize-[a-f0-9-]+-selection\.json$/.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("style sample finalization temporary is unsafe");
    const fd = style.openRegular(entry.name);
    closeSync(fd);
    style.remove(entry.name);
  }
}

function cleanupOwnedSampleTemps(sample: ReturnType<typeof openGenerationDirectory>): void {
  for (const entry of readdirSync(sample.path, { withFileTypes: true })) {
    if (!/^(?:\.finalize-(?:director\.json|prompt\.txt|ledger\.json|slide\.png)|\.style-sample-finalize-[a-f0-9-]+-(?:director\.json|prompt\.txt|ledger\.json|slide\.png|completion\.json))$/.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("style sample finalization temporary is unsafe");
    const fd = sample.openRegular(entry.name);
    closeSync(fd);
    sample.remove(entry.name);
  }
}

async function assertReceiptBindings(
  root: string,
  job: ImageGenerationJob,
  values: StyleSampleArtifacts,
): Promise<StyleSampleCompletionReceipt> {
  const receipt = await readReceipt(root);
  const [jobBytes, resultBytes, authorizationBytes] = await Promise.all([
    readOwnedRegularFile(root, sampleJobPath(job)),
    readOwnedRegularFile(root, sampleResultPath(job)),
    readOwnedRegularFile(root, "style/sample/generation-plan.json"),
  ]);
  const currentArtifacts = artifactHashes(values);
  const changedArtifacts = STYLE_SAMPLE_ARTIFACTS.filter((path) => receipt.artifactHashes[path] !== currentArtifacts[path]);
  const bindings = {
    jobId: receipt.jobId === job.jobId,
    job: receipt.job.path === sampleJobPath(job) && receipt.job.sha256 === sha256(jobBytes),
    result: receipt.result.path === sampleResultPath(job) && receipt.result.sha256 === sha256(resultBytes),
    authorization: receipt.authorization.path === "style/sample/generation-plan.json" && receipt.authorization.sha256 === sha256(authorizationBytes),
    artifacts: JSON.stringify(receipt.artifactHashes) === JSON.stringify(currentArtifacts),
  };
  if (!Object.values(bindings).every(Boolean)) throw new Error(`delegated style sample completion receipt does not bind current evidence: ${Object.entries(bindings).filter(([, valid]) => !valid).map(([key]) => key).join(", ")}${changedArtifacts.length ? ` (${changedArtifacts.join(", ")})` : ""}`);
  return receipt;
}

export async function assertFinalizedStyleSample(root: string, values: StyleSampleArtifacts): Promise<void> {
  const receipt = await readReceipt(root);
  const { job } = await readAndReauthenticateDelegatedResult(root, receipt.jobId);
  await assertAcceptedSampleResult(root, job);
  await assertReceiptBindings(root, job, values);
}

export async function prepareStyleSampleJob(
  root: string,
  aiDependency: AiImageSkillDependency,
): Promise<ImageGenerationJob> {
  const authorization = await authorizationForPreparation(root, "style-sample");
  const budget = await authorizationCallBudget(root, authorization.digest, authorization.plan.callBudget);
  if (budget.remaining === 0) {
    throw new Error("a new style sample generation plan is required after its one-call budget is exhausted");
  }
  return prepareImageGenerationJob(root, { kind: "style-sample", aiDependency });
}

export async function finalizeStyleSample(root: string, jobId: string): Promise<StyleSampleArtifacts> {
  return withProjectLease(root, "state", async (canonicalRoot) => {
    const { job } = await readAndReauthenticateDelegatedResult(canonicalRoot, jobId);
    const result = await assertAcceptedSampleResult(canonicalRoot, job);
    const normalized = await readOwnedRegularFile(canonicalRoot, result.pages[0]!.artifacts!.normalized.path);
    if (sha256(normalized) !== result.pages[0]!.artifacts!.normalized.sha256) {
      throw new Error("delegated style sample normalized artifact hash changed");
    }
    const canonical = await canonicalStyleSample(canonicalRoot);
    if (
      canonical.projectRevisionId !== job.projectRevisionId
      || canonical.spec.slideId !== job.pages[0]!.slideId
      || canonical.compiled.sha256 !== job.pages[0]!.promptSha256
    ) throw new Error("delegated style sample job no longer matches the current provisional style lock");
    const values = delegatedStyleSampleArtifacts(
      canonical,
      normalized,
      `${result.pages[0]!.dependency.channel}-${result.pages[0]!.dependency.provider}`,
    );
    await validateCanonicalStyleSample(canonicalRoot, values);
    const existingReceipt = await readReceipt(canonicalRoot)
      .then((receipt) => receipt)
      .catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
    if (existingReceipt?.jobId === jobId) {
      await assertFinalizedStyleSample(canonicalRoot, values);
      return values;
    }
    const project = openGenerationDirectory(canonicalRoot);
    const style = project.child("style", false);
    const sample = style.child("sample", false);
    try {
      cleanupOwnedStyleTemps(style);
      cleanupOwnedSampleTemps(sample);
      style.replace(
        "selection.json",
        values[STYLE_SAMPLE_ARTIFACTS[0]],
        `.style-sample-finalize-${randomUUID()}-selection.json`,
      );
      for (const path of STYLE_SAMPLE_ARTIFACTS.slice(1)) {
        sample.replace(
          path.slice("style/sample/".length),
          values[path],
          `.style-sample-finalize-${randomUUID()}-${path.slice("style/sample/".length)}`,
        );
      }
    } finally {
      sample.close();
      style.close();
      project.close();
    }
    const finalized = {
      [STYLE_SAMPLE_ARTIFACTS[0]]: await readOwnedRegularFile(canonicalRoot, STYLE_SAMPLE_ARTIFACTS[0]),
      [STYLE_SAMPLE_ARTIFACTS[1]]: await readOwnedRegularFile(canonicalRoot, STYLE_SAMPLE_ARTIFACTS[1]),
      [STYLE_SAMPLE_ARTIFACTS[2]]: await readOwnedRegularFile(canonicalRoot, STYLE_SAMPLE_ARTIFACTS[2]),
      [STYLE_SAMPLE_ARTIFACTS[3]]: await readOwnedRegularFile(canonicalRoot, STYLE_SAMPLE_ARTIFACTS[3]),
      [STYLE_SAMPLE_ARTIFACTS[4]]: await readOwnedRegularFile(canonicalRoot, STYLE_SAMPLE_ARTIFACTS[4]),
    } as StyleSampleArtifacts;
    await validateCanonicalStyleSample(canonicalRoot, finalized);
    const [jobBytes, resultBytes, authorizationBytes] = await Promise.all([
      readOwnedRegularFile(canonicalRoot, sampleJobPath(job)),
      readOwnedRegularFile(canonicalRoot, sampleResultPath(job)),
      readOwnedRegularFile(canonicalRoot, "style/sample/generation-plan.json"),
    ]);
    const receipt = StyleSampleCompletionReceiptSchema.parse({
      receiptVersion: 1,
      jobId: job.jobId,
      job: { path: sampleJobPath(job), sha256: sha256(jobBytes) },
      result: { path: sampleResultPath(job), sha256: sha256(resultBytes) },
      authorization: { path: "style/sample/generation-plan.json", sha256: sha256(authorizationBytes) },
      artifactHashes: artifactHashes(finalized),
      finalizedAt: new Date().toISOString(),
    });
    const receiptProject = openGenerationDirectory(canonicalRoot);
    const receiptStyle = receiptProject.child("style", false);
    const receiptSample = receiptStyle.child("sample", false);
    try {
      receiptSample.replace("completion.json", canonicalReceiptFile(receipt), `.style-sample-finalize-${randomUUID()}-completion.json`);
    } finally {
      receiptSample.close();
      receiptStyle.close();
      receiptProject.close();
    }
    await assertFinalizedStyleSample(canonicalRoot, finalized);
    return finalized;
  });
}
