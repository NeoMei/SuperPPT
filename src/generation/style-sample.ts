import { createHash } from "node:crypto";

import type { AiImageSkillDependency } from "../dependencies/schemas.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import {
  canonicalStyleSample,
  delegatedStyleSampleArtifacts,
  STYLE_SAMPLE_ARTIFACTS,
  validateCanonicalStyleSample,
  type StyleSampleArtifacts,
} from "../styles/sample-contract.js";
import { openGenerationDirectory } from "./anchored-dir.js";
import { assertAuthorizedJobBinding, authorizationCallBudget, authorizationForPreparation, readCallLedger } from "./authorization.js";
import { ImageGenerationResultSchema, type ImageGenerationResult } from "./schemas.js";
import { canonicalContractFile, type ImageGenerationJob } from "./job-schemas.js";
import { prepareImageGenerationJob, readImageGenerationJob } from "./jobs.js";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readAcceptedSampleResult(root: string, job: ImageGenerationJob): Promise<ImageGenerationResult> {
  if (job.kind !== "style-sample" || job.callBudget !== 1 || job.pages.length !== 1) {
    throw new Error("style sample finalization requires an immutable one-call sample job");
  }
  const bytes = await readOwnedRegularFile(root, `generation/jobs/${job.jobId}/result.json`).catch((error: unknown) => {
    throw new Error("accepted delegated style sample result is unavailable", { cause: error });
  });
  let result: ImageGenerationResult;
  try {
    result = ImageGenerationResultSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (bytes.toString("utf8") !== canonicalContractFile(result)) throw new Error("non-canonical result");
  } catch (error: unknown) {
    throw new Error("accepted delegated style sample result is invalid", { cause: error });
  }
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
  const calls = await readCallLedger(root);
  const entries = calls.filter((entry) => entry.jobId === job.jobId);
  if (entries.length !== 2 || entries[0]?.entryKind !== "admission" || entries[1]?.entryKind !== "terminal" || entries[1].outcome !== "success") {
    throw new Error("delegated style sample result does not have one successful durable admission");
  }
  const budget = await authorizationCallBudget(root, job.authorizationDigest, job.callBudget);
  if (budget.consumed !== 1 || budget.remaining !== 0) throw new Error("delegated style sample must consume its one authorized call");
  return result;
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
    const job = await readImageGenerationJob(canonicalRoot, jobId);
    await assertAuthorizedJobBinding(canonicalRoot, job);
    const result = await readAcceptedSampleResult(canonicalRoot, job);
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
    const project = openGenerationDirectory(canonicalRoot);
    const style = project.child("style", false);
    const sample = style.child("sample", false);
    try {
      for (const path of STYLE_SAMPLE_ARTIFACTS.slice(1)) {
        sample.replace(path.slice("style/sample/".length), values[path], `.finalize-${path.slice("style/sample/".length)}`);
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
    return finalized;
  });
}
