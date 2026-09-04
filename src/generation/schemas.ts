import { isAbsolute } from "node:path";

import { z } from "zod";

import { RoleSchema } from "../planning/schemas.js";
import { ArtifactSchema, Sha256Schema } from "../project/schemas.js";

const CREDENTIAL_LIKE_DIAGNOSTIC = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:api[_-]?key|access[_-]?token|password|secret|x-amz-signature)\b\s*[:=]\s*(?!\[REDACTED\])\S+|\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}|https?:\/\/\S+[?&](?:token|key|signature|sig|x-amz-credential)=)/i;

function delegatedDiagnostic(maximum: number, requireText = false) {
  let schema = z.string().refine(
    (value) => Array.from(value).length <= maximum,
    `delegated diagnostic exceeds ${maximum} characters`,
  ).refine(
    (value) => !CREDENTIAL_LIKE_DIAGNOSTIC.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value),
    "delegated diagnostic contains secret-like or unsafe text",
  );
  if (requireText) schema = schema.min(1);
  return schema;
}

export const QualityDecisionSchema = z.object({
  ok: z.boolean(),
  issues: z.array(z.string().min(1)),
  requiredText: z.array(z.object({
    text: z.string().min(1),
    present: z.boolean(),
    exact: z.boolean(),
  }).strict()),
  styleConsistent: z.boolean(),
  hierarchyClear: z.boolean(),
  richDetail: z.boolean(),
  noForbiddenContent: z.boolean(),
}).strict().superRefine((value, context) => {
  const shouldPass = value.issues.length === 0
    && value.requiredText.every((item) => item.present && item.exact)
    && value.styleConsistent
    && value.hierarchyClear
    && value.richDetail
    && value.noForbiddenContent;
  if (value.ok !== shouldPass) {
    context.addIssue({
      code: "custom",
      message: "ok must equal the quality checks",
      path: ["ok"],
    });
  }
});

export const DelegatedPresentationQaSchema = z.object({
  approvedSampleSha256: Sha256Schema,
  normalizedImageSha256: Sha256Schema,
  slideSpecSha256: Sha256Schema,
  pageRole: RoleSchema,
  decision: QualityDecisionSchema,
}).strict();

export const DependencyGenerationResultSchema = z.object({
  status: z.enum([
    "success",
    "unavailable",
    "auth_unavailable",
    "retryable_exhausted",
    "policy_refused",
    "invalid_input",
    "invalid_output",
    "local_failure",
  ]),
  provider: z.enum(["openai", "gemini", "doubao"]),
  channel: z.enum(["host", "api"]),
  output_path: z.string().min(1).nullable(),
  safe_message: delegatedDiagnostic(300),
}).strict().superRefine((result, context) => {
  if (result.status === "success") {
    if (!result.output_path || !isAbsolute(result.output_path)) {
      context.addIssue({ code: "custom", path: ["output_path"], message: "success requires an absolute output path" });
    }
  } else if (result.output_path !== null) {
    context.addIssue({ code: "custom", path: ["output_path"], message: "only success may carry an output path" });
  }
});

const RoutingCandidateSchema = z.enum([
  "host-openai",
  "api-openai",
  "host-gemini",
  "api-gemini",
  "host-doubao",
  "api-doubao",
]);

const SerialStickyPageSchema = z.object({
  page: z.number().int().positive(),
  outcome: z.enum(["success", "cached", "fatal", "exhausted"]),
  candidate: RoutingCandidateSchema.nullable(),
  summary: delegatedDiagnostic(2_000),
}).strict().superRefine((page, context) => {
  const requiresCandidate = page.outcome === "success" || page.outcome === "fatal";
  if (requiresCandidate !== (page.candidate !== null)) {
    context.addIssue({ code: "custom", path: ["candidate"], message: "routing page candidate does not match its outcome" });
  }
});

const SerialStickySwitchSchema = z.object({
  page: z.number().int().positive(),
  from: RoutingCandidateSchema,
  to: RoutingCandidateSchema,
  reason: delegatedDiagnostic(500, true),
}).strict();

export const SerialStickyReportSchema = z.object({
  batch_mode: z.literal("serial-sticky-monotonic"),
  stopped: z.boolean(),
  search_candidate: RoutingCandidateSchema,
  sticky_candidate: RoutingCandidateSchema.nullable(),
  pages: z.array(SerialStickyPageSchema),
  switches: z.array(SerialStickySwitchSchema),
}).strict().superRefine((report, context) => {
  report.pages.forEach((page, index) => {
    if (index > 0 && page.page <= report.pages[index - 1]!.page) {
      context.addIssue({ code: "custom", path: ["pages", index, "page"], message: "routing pages must be strictly increasing" });
    }
  });
  const terminal = report.pages.at(-1)?.outcome;
  if (report.stopped !== (terminal === "fatal" || terminal === "exhausted")) {
    context.addIssue({ code: "custom", path: ["stopped"], message: "stopped must match the terminal routing outcome" });
  }
  const candidates = ["host-openai", "api-openai", "host-gemini", "api-gemini", "host-doubao", "api-doubao"];
  let selected: z.infer<typeof RoutingCandidateSchema> | null = null;
  const expectedSwitchPages = new Set<number>();
  for (const page of report.pages) {
    if (page.outcome !== "success") continue;
    if (selected !== null && page.candidate !== selected) expectedSwitchPages.add(page.page);
    selected = page.candidate;
  }
  if (report.sticky_candidate !== selected) {
    context.addIssue({ code: "custom", path: ["sticky_candidate"], message: "sticky candidate must equal the last successful candidate" });
  }
  if (report.search_candidate !== (selected ?? "host-openai")) {
    context.addIssue({ code: "custom", path: ["search_candidate"], message: "search candidate must equal the committed successful candidate" });
  }
  report.switches.forEach((entry, index) => {
    if (report.switches.findIndex(({ page }) => page === entry.page) !== index) {
      context.addIssue({ code: "custom", path: ["switches", index, "page"], message: "routing switch pages must be unique" });
    }
    if (candidates.indexOf(entry.to) <= candidates.indexOf(entry.from)) {
      context.addIssue({ code: "custom", path: ["switches", index], message: "routing switches must move forward" });
    }
    if (!report.pages.some(({ page }) => page === entry.page)) {
      context.addIssue({ code: "custom", path: ["switches", index, "page"], message: "routing switch page is absent" });
    }
    const pageIndex = report.pages.findIndex(({ page }) => page === entry.page);
    const priorSuccess = report.pages.slice(0, pageIndex).filter(({ outcome }) => outcome === "success").at(-1);
    const switchedPage = report.pages[pageIndex];
    if (!priorSuccess?.candidate || entry.from !== priorSuccess.candidate || switchedPage?.candidate !== entry.to) {
      context.addIssue({ code: "custom", path: ["switches", index], message: "routing switch does not bind the prior and current successful candidates" });
    }
    expectedSwitchPages.delete(entry.page);
  });
  if (expectedSwitchPages.size > 0) {
    context.addIssue({ code: "custom", path: ["switches"], message: "routing report is missing a committed provider switch" });
  }
});

const ReferenceUsageSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  usage: z.enum(["used", "unsupported"]),
}).strict();

export const ImagePageResultSchema = z.object({
  contractVersion: z.literal(1),
  jobId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  slideId: z.string().uuid(),
  attempt: z.number().int().positive(),
  requestOrdinal: z.number().int().nonnegative(),
  requestCount: z.number().int().min(0),
  status: z.enum(["success", "cached", "failed", "paused"]),
  dependency: DependencyGenerationResultSchema,
  actualPromptSha256: Sha256Schema,
  styleLockSha256: Sha256Schema,
  styleRecipeSha256: Sha256Schema,
  referenceUsage: z.array(ReferenceUsageSchema),
  artifacts: z.object({
    raw: ArtifactSchema.nullable(),
    master: ArtifactSchema,
    normalized: ArtifactSchema,
  }).strict().nullable(),
  styleConsistency: z.enum(["accepted", "rejected", "not-reviewed"]),
  presentationQa: DelegatedPresentationQaSchema.nullable(),
  recordedAt: z.string().datetime(),
}).strict().superRefine((page, context) => {
  if ((page.status === "success" || page.status === "cached") !== (page.artifacts !== null)) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "successful pages require authenticated artifacts" });
  }
  if ((page.status === "failed" || page.status === "paused") && page.styleConsistency !== "not-reviewed") {
    context.addIssue({ code: "custom", path: ["styleConsistency"], message: "non-success pages cannot carry presentation acceptance" });
  }
  if (page.status !== "success" && page.status !== "cached" && page.presentationQa !== null) {
    context.addIssue({ code: "custom", path: ["presentationQa"], message: "only successful or cached pages may carry presentation QA" });
  }
  if ((page.styleConsistency === "accepted" || page.styleConsistency === "rejected") !== (page.presentationQa !== null)) {
    context.addIssue({ code: "custom", path: ["presentationQa"], message: "reviewed style consistency requires bound presentation QA" });
  }
  if (page.status === "success" && page.dependency.status !== "success") {
    context.addIssue({ code: "custom", path: ["dependency", "status"], message: "successful pages require dependency success" });
  }
  if (page.status === "failed" && page.dependency.status === "success") {
    context.addIssue({ code: "custom", path: ["dependency", "status"], message: "failed pages require dependency failure" });
  }
  if (
    page.artifacts
    && page.dependency.status === "success"
    && page.dependency.channel === "host"
    && page.artifacts.raw === null
  ) context.addIssue({ code: "custom", path: ["artifacts", "raw"], message: "host success requires a raw artifact" });
  if (page.artifacts) {
    for (const [name, artifact] of Object.entries(page.artifacts)) {
      if (artifact && artifact.revisionId !== page.projectRevisionId) {
        context.addIssue({ code: "custom", path: ["artifacts", name, "revisionId"], message: "page artifacts must bind the project revision" });
      }
    }
  }
});

export const ImageGenerationResultSchema = z.object({
  contractVersion: z.literal(1),
  jobId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  styleRecipeSha256: Sha256Schema,
  approvedSampleSha256: Sha256Schema.nullable(),
  outcome: z.enum(["success", "partial", "fatal", "exhausted", "attention-required"]),
  actualRequestCount: z.number().int().nonnegative(),
  batchReport: SerialStickyReportSchema,
  pages: z.array(ImagePageResultSchema),
  updatedAt: z.string().datetime(),
}).strict().superRefine((result, context) => {
  const requestCount = result.pages.reduce((sum, page) => sum + page.requestCount, 0);
  if (result.actualRequestCount !== requestCount) {
    context.addIssue({ code: "custom", path: ["actualRequestCount"], message: "actual request count must equal page intake evidence" });
  }
  if (result.pages.some((page) => page.jobId !== result.jobId || page.projectRevisionId !== result.projectRevisionId)) {
    context.addIssue({ code: "custom", path: ["pages"], message: "aggregate pages must bind the job revision" });
  }
  if (result.outcome === "attention-required" && !result.pages.some(({ status }) => status === "paused")) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "attention-required requires a paused page" });
  }
  if (result.outcome === "fatal" && result.batchReport.pages.at(-1)?.outcome !== "fatal") {
    context.addIssue({ code: "custom", path: ["outcome"], message: "fatal aggregate requires a fatal routing report" });
  }
  if (result.outcome === "exhausted" && result.batchReport.pages.at(-1)?.outcome !== "exhausted") {
    context.addIssue({ code: "custom", path: ["outcome"], message: "exhausted aggregate requires an exhausted routing report" });
  }
});

export const QualityIssueCodeSchema = z.enum([
  "reviewer-issue",
  "required-text-missing",
  "required-text-inexact",
  "style-inconsistent",
  "hierarchy-unclear",
  "insufficient-detail",
  "forbidden-content",
]);

export const QualityEvidenceSchema = z.object({
  ok: z.boolean(),
  issueCount: z.number().int().nonnegative(),
  issueHashes: z.array(Sha256Schema),
  issueCodes: z.array(QualityIssueCodeSchema),
  requiredText: z.array(z.object({
    textSha256: Sha256Schema,
    present: z.boolean(),
    exact: z.boolean(),
  }).strict()),
  styleConsistent: z.boolean(),
  hierarchyClear: z.boolean(),
  richDetail: z.boolean(),
  noForbiddenContent: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.issueCount !== value.issueHashes.length) {
    context.addIssue({ code: "custom", message: "issueCount must equal issueHashes length", path: ["issueCount"] });
  }
  const shouldPass = value.issueCount === 0
    && value.requiredText.every((item) => item.present && item.exact)
    && value.styleConsistent
    && value.hierarchyClear
    && value.richDetail
    && value.noForbiddenContent;
  if (value.ok !== shouldPass) {
    context.addIssue({ code: "custom", message: "ok must equal sanitized quality checks", path: ["ok"] });
  }
});

export const AttemptLedgerSchema = z.object({
  ledgerVersion: z.literal(1),
  slideId: z.string().min(1),
  revisionId: z.string().uuid().nullable().default(null),
  attempt: z.number().int().min(1).max(3),
  providerId: z.string().min(1),
  promptSha256: Sha256Schema,
  promptPurged: z.literal(true),
  output: z.string().min(1).nullable(),
  outputSha256: Sha256Schema.nullable(),
  outputBytes: z.number().int().positive().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable(),
  quality: QualityEvidenceSchema.nullable(),
  outcome: z.enum(["generated", "accepted", "rejected", "provider-error", "review-error"]).default("generated"),
  errorCode: z.enum(["provider-failed", "invalid-image", "review-failed"]).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (new Set([value.output === null, value.outputSha256 === null, value.outputBytes === null]).size !== 1) {
    context.addIssue({ code: "custom", message: "output, outputSha256, and outputBytes must be present together", path: ["output"] });
  }
  if (value.outcome === "accepted" && !value.quality?.ok) {
    context.addIssue({ code: "custom", message: "accepted attempts require passing quality", path: ["quality"] });
  }
  if (value.outcome === "rejected" && value.quality?.ok !== false) {
    context.addIssue({ code: "custom", message: "rejected attempts require failing quality", path: ["quality"] });
  }
});

export type QualityDecision = z.infer<typeof QualityDecisionSchema>;
export type DelegatedPresentationQa = z.infer<typeof DelegatedPresentationQaSchema>;
export type QualityEvidence = z.infer<typeof QualityEvidenceSchema>;
export type AttemptLedger = z.infer<typeof AttemptLedgerSchema>;
export type DependencyGenerationResult = z.infer<typeof DependencyGenerationResultSchema>;
export type SerialStickyReport = z.infer<typeof SerialStickyReportSchema>;
export type ImagePageResult = z.infer<typeof ImagePageResultSchema>;
export type ImageGenerationResult = z.infer<typeof ImageGenerationResultSchema>;
