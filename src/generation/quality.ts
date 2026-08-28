import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { basename, dirname } from "node:path";

import { z } from "zod";

import { RoleSchema } from "../planning/schemas.js";
import { openGenerationDirectory } from "./anchored-dir.js";
import { runBridge } from "./bridge-process.js";
import { withPrivateInput } from "./private-input.js";
import {
  DelegatedPresentationQaSchema,
  QualityDecisionSchema,
  QualityEvidenceSchema,
  type DelegatedPresentationQa,
  type QualityDecision,
  type QualityEvidence,
} from "./schemas.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export { DelegatedPresentationQaSchema };
export type { DelegatedPresentationQa };

export function delegatedStyleConsistency(
  raw: DelegatedPresentationQa,
  expected: {
    approvedSampleSha256: string;
    normalizedImageSha256: string;
    slideSpecSha256: string;
    pageRole: z.infer<typeof RoleSchema>;
    requiredText: string[];
  },
): "accepted" | "rejected" {
  const evidence = DelegatedPresentationQaSchema.parse(raw);
  if (
    evidence.approvedSampleSha256 !== expected.approvedSampleSha256
    || evidence.normalizedImageSha256 !== expected.normalizedImageSha256
    || evidence.slideSpecSha256 !== expected.slideSpecSha256
    || evidence.pageRole !== expected.pageRole
  ) throw new Error("presentation QA does not bind the approved sample, normalized image, and sealed page-role rules");
  if (
    evidence.decision.requiredText.length !== expected.requiredText.length
    || evidence.decision.requiredText.some((item, index) => item.text !== expected.requiredText[index])
  ) throw new Error("presentation QA required text does not bind the exact expected copy from the sealed slide spec");
  return evidence.decision.ok && evidence.decision.styleConsistent ? "accepted" : "rejected";
}

export async function reviewSlide(options: {
  runner: string;
  modulePath: string;
  callable?: string;
  image: string;
  requiredText: string[];
  styleName: string;
  approvedSampleSha256?: string;
  pageRole?: z.infer<typeof RoleSchema>;
  timeoutMs?: number;
  beforeExecute?: (privatePath: string) => Promise<void>;
  afterImageDirectoryOpened?: () => Promise<void>;
  afterReviewerModuleOpened?: () => Promise<void>;
}): Promise<QualityDecision> {
  const question = [
    "Return JSON only with exactly these keys: ok, issues, requiredText, styleConsistent, hierarchyClear, richDetail, noForbiddenContent.",
    `requiredText must contain one {text,present,exact} result for each required copy item: ${JSON.stringify(options.requiredText)}.`,
    `Expected style: ${options.styleName}.`,
    ...(options.approvedSampleSha256 && options.pageRole ? [
      `Compare against approved sample SHA-256 ${options.approvedSampleSha256} and apply the ${options.pageRole} page-role composition rules.`,
    ] : []),
    "Mark ok true only when issues is empty, every required item is present and exact, and every boolean check is true.",
  ].join("\n");
  const directory = openGenerationDirectory(dirname(options.image));
  let imageFd: number | undefined;
  try {
    await options.afterImageDirectoryOpened?.();
    directory.assertCurrent();
    imageFd = directory.openRegular(basename(options.image));
    const activeImageFd = imageFd;
    return await withPrivateInput({
      target: options.image,
      parent: directory,
      suffix: "review.json",
      value: JSON.stringify({ question }),
      beforeExecute: options.beforeExecute,
      action: async (input) => {
        let stdout: string;
        try {
          stdout = await runBridge({
            runner: options.runner,
            mode: "review",
            modulePath: options.modulePath,
            callable: options.callable ?? "check",
            inputFd: input.fd,
            inputValue: input.value,
            targetFd: activeImageFd,
            targetPath: options.image,
            timeoutMs: options.timeoutMs ?? 120_000,
            afterModuleOpened: options.afterReviewerModuleOpened,
          });
        } catch {
          throw new Error("reviewer execution failed");
        }
        try {
          return QualityDecisionSchema.parse(JSON.parse(stdout));
        } catch {
          throw new Error("reviewer returned invalid quality JSON");
        }
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && ["reviewer execution failed", "reviewer returned invalid quality JSON"].includes(error.message)) {
      throw error;
    }
    throw new Error("reviewer execution failed");
  } finally {
    if (imageFd !== undefined) closeSync(imageFd);
    directory.close();
  }
}

export function correctivePrompt(original: string, quality: QualityDecision): string {
  const decision = QualityDecisionSchema.parse(quality);
  return [
    original,
    "CORRECTION REQUIRED:",
    ...decision.issues.map((issue) => `- ${issue}`),
    "Preserve approved content and style; change only the listed failures.",
    "Final self-check must pass all prior constraints.",
  ].join("\n\n");
}

export function qualityEvidence(raw: QualityDecision): QualityEvidence {
  const quality = QualityDecisionSchema.parse(raw);
  const codes = new Set<QualityEvidence["issueCodes"][number]>();
  if (quality.issues.length > 0) codes.add("reviewer-issue");
  if (quality.requiredText.some((item) => !item.present)) codes.add("required-text-missing");
  if (quality.requiredText.some((item) => item.present && !item.exact)) codes.add("required-text-inexact");
  if (!quality.styleConsistent) codes.add("style-inconsistent");
  if (!quality.hierarchyClear) codes.add("hierarchy-unclear");
  if (!quality.richDetail) codes.add("insufficient-detail");
  if (!quality.noForbiddenContent) codes.add("forbidden-content");
  return QualityEvidenceSchema.parse({
    ok: quality.ok,
    issueCount: quality.issues.length,
    issueHashes: quality.issues.map(hash),
    issueCodes: [...codes],
    requiredText: quality.requiredText.map((item) => ({
      textSha256: hash(item.text),
      present: item.present,
      exact: item.exact,
    })),
    styleConsistent: quality.styleConsistent,
    hierarchyClear: quality.hierarchyClear,
    richDetail: quality.richDetail,
    noForbiddenContent: quality.noForbiddenContent,
  });
}

export function correctivePromptFromEvidence(original: string, evidence: QualityEvidence | null): string {
  const correction = evidence
    ? [
      `Failure codes: ${evidence.issueCodes.join(", ") || "unspecified-quality-failure"}.`,
      `Failure evidence hashes: ${evidence.issueHashes.join(", ") || "none"}.`,
    ]
    : ["Prior attempt did not complete strict review; re-check every approved constraint."];
  return [
    original,
    "CORRECTION REQUIRED FROM RETAINED NON-SECRET EVIDENCE:",
    ...correction,
    "Do not repeat the prior composition blindly. Preserve approved copy and style while correcting all failed checks.",
  ].join("\n\n");
}
