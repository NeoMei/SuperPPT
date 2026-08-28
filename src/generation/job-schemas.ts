import { createHash } from "node:crypto";

import { z } from "zod";

import { Sha256Schema } from "../project/schemas.js";
import { SlideSpecSchema } from "../planning/schemas.js";
import { StyleLockSchema, StyleReferenceSchema } from "../styles/schemas.js";

export const ImageJobKindSchema = z.enum([
  "style-sample",
  "deck",
  "page-regeneration",
]);

const AiSkillBindingSchema = z.object({
  root: z.string().min(1),
  skillSha256: Sha256Schema,
  gitRevision: z.string().min(1).nullable(),
  scripts: z.object({
    generationResult: z.object({ path: z.string().min(1), sha256: Sha256Schema }).strict(),
    hostRoutingPolicy: z.object({ path: z.string().min(1), sha256: Sha256Schema }).strict(),
    importHostImage: z.object({ path: z.string().min(1), sha256: Sha256Schema }).strict(),
    prepareEditableInput: z.object({ path: z.string().min(1), sha256: Sha256Schema }).strict(),
  }).strict(),
}).strict();

const OutboundDisclosureSchema = z.object({
  sendsText: z.literal(true),
  references: z.array(StyleReferenceSchema),
}).strict();

const AuthorizationPageSchema = z.object({
  slideId: z.string().uuid(),
  order: z.number().int().nonnegative(),
  promptSha256: Sha256Schema,
}).strict();

const AuthorizationGateBindingSchema = z.object({
  gate: z.enum(["style-sample-generation", "generation-authorization"]),
  approvalId: z.string().uuid(),
  snapshotPath: z.string().startsWith("revisions/"),
  snapshotManifestSha256: Sha256Schema,
  authorizationPlanSha256: Sha256Schema,
}).strict();

export const GenerationAuthorizationPlanSchema = z.object({
  contractVersion: z.literal(1),
  kind: ImageJobKindSchema,
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  aiSkill: AiSkillBindingSchema,
  styleLockPath: z.literal("style/lock.json"),
  styleLockSha256: Sha256Schema,
  callBudget: z.number().int().positive(),
  outboundDisclosure: OutboundDisclosureSchema,
  pages: z.array(AuthorizationPageSchema).min(1),
  previousAuthorizationDigest: Sha256Schema.nullable(),
  previousPromptSha256: Sha256Schema.nullable(),
  createdAt: z.string().datetime(),
}).strict().superRefine((plan, context) => {
  validateOrderedPages(plan.pages, context);
  if (plan.kind === "style-sample" && (plan.pages.length !== 1 || plan.callBudget !== 1)) {
    context.addIssue({ code: "custom", message: "style-sample call budget must be exactly 1" });
  }
  if (plan.callBudget < plan.pages.length) {
    context.addIssue({ code: "custom", path: ["callBudget"], message: "call budget must cover the initial page count" });
  }
  if (plan.kind === "page-regeneration") {
    if (plan.pages.length !== 1 || !plan.previousPromptSha256 || !plan.previousAuthorizationDigest) {
      context.addIssue({ code: "custom", message: "page-regeneration authorization requires one previous prompt and authorization hash" });
    } else if (plan.pages[0]?.promptSha256 === plan.previousPromptSha256) {
      context.addIssue({ code: "custom", path: ["pages", 0, "promptSha256"], message: "page-regeneration requires a new prompt hash" });
    }
  } else if (plan.previousPromptSha256 !== null || plan.previousAuthorizationDigest !== null) {
    context.addIssue({ code: "custom", message: "only page-regeneration binds previous prompt and authorization hashes" });
  }
});

const ImageGenerationPageSchema = z.object({
  slideId: z.string().uuid(),
  order: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  promptArtifact: z.string().startsWith("slides/"),
  finalPrompt: z.string().min(1),
  promptSha256: Sha256Schema,
  target: z.string().startsWith("generation/jobs/"),
  spec: SlideSpecSchema,
  specSnapshot: z.object({
    path: z.string().startsWith("generation/jobs/"),
    sha256: Sha256Schema,
  }).strict(),
}).strict();

const SealedInputArtifactSchema = z.object({
  path: z.string().startsWith("generation/jobs/"),
  sha256: Sha256Schema,
}).strict();

const SealedJobInputsSchema = z.object({
  styleLock: SealedInputArtifactSchema,
  styleRecipe: SealedInputArtifactSchema,
  approvedSample: SealedInputArtifactSchema.nullable(),
  references: z.array(z.object({
    sourcePath: z.string().startsWith("style/references/"),
    role: z.enum(["art-direction", "content-reference"]),
    snapshot: SealedInputArtifactSchema,
  }).strict()),
}).strict();

export const ImageGenerationJobSchema = z.object({
  contractVersion: z.literal(1),
  jobId: z.string().uuid(),
  kind: ImageJobKindSchema,
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  authorizationDigest: Sha256Schema,
  authorizationPlan: GenerationAuthorizationPlanSchema,
  authorizationGate: AuthorizationGateBindingSchema,
  routePolicy: z.literal("ai-image-to-ppt-default"),
  aiSkill: AiSkillBindingSchema,
  styleLockPath: z.literal("style/lock.json"),
  styleLockSha256: Sha256Schema,
  styleLock: StyleLockSchema,
  sealedInputs: SealedJobInputsSchema,
  callBudget: z.number().int().positive(),
  outboundDisclosure: OutboundDisclosureSchema,
  pages: z.array(ImageGenerationPageSchema).min(1),
  createdAt: z.string().datetime(),
}).strict().superRefine((job, context) => {
  validateOrderedPages(job.pages, context);
  if (job.styleLock.projectId !== job.projectId || job.styleLock.revisionId !== job.projectRevisionId) {
    context.addIssue({ code: "custom", path: ["styleLock"], message: "style lock must bind the job project revision" });
  }
  if (
    job.authorizationDigest !== sha256(canonicalContractFile(job.authorizationPlan))
    || job.authorizationPlan.projectId !== job.projectId
    || job.authorizationPlan.projectRevisionId !== job.projectRevisionId
    || (job.authorizationPlan.kind !== job.kind && !(job.kind === "page-regeneration" && job.authorizationPlan.kind === "deck"))
  ) context.addIssue({ code: "custom", path: ["authorizationPlan"], message: "immutable job authorization snapshot does not bind the job" });
  if (
    job.authorizationGate.gate !== (job.kind === "style-sample" ? "style-sample-generation" : "generation-authorization")
    || job.authorizationGate.authorizationPlanSha256 !== job.authorizationDigest
  ) context.addIssue({ code: "custom", path: ["authorizationGate"], message: "immutable job authorization gate does not bind the job" });
  if (job.styleLockSha256 !== sha256(`${canonicalJson(job.styleLock)}\n`)) {
    context.addIssue({ code: "custom", path: ["styleLockSha256"], message: "style lock hash must bind the embedded style lock" });
  }
  if (canonicalJson(job.outboundDisclosure.references) !== canonicalJson(job.styleLock.referenceArtifacts)) {
    context.addIssue({ code: "custom", path: ["outboundDisclosure", "references"], message: "outbound references must match the style lock" });
  }
  const inputBase = `generation/jobs/${job.jobId}/inputs`;
  if (
    job.sealedInputs.styleLock.path !== `${inputBase}/style-lock.json`
    || job.sealedInputs.styleLock.sha256 !== job.styleLockSha256
    || job.sealedInputs.styleRecipe.path !== `${inputBase}/style-recipe.json`
    || job.sealedInputs.styleRecipe.sha256 !== job.styleLock.styleRecipeSha256
  ) context.addIssue({ code: "custom", path: ["sealedInputs"], message: "sealed style inputs must bind the immutable job Style Lock" });
  const approvedSample = job.styleLock.approvedSample;
  if (approvedSample === null ? job.sealedInputs.approvedSample !== null : (
    job.sealedInputs.approvedSample?.path !== `${inputBase}/approved-sample.bin`
    || job.sealedInputs.approvedSample.sha256 !== approvedSample.sha256
  )) context.addIssue({ code: "custom", path: ["sealedInputs", "approvedSample"], message: "sealed approved sample must bind the Style Lock" });
  if (
    job.sealedInputs.references.length !== job.styleLock.referenceArtifacts.length
    || job.sealedInputs.references.some((reference, index) => {
      const expected = job.styleLock.referenceArtifacts[index];
      return !expected
        || reference.sourcePath !== expected.path
        || reference.role !== expected.role
        || reference.snapshot.path !== `${inputBase}/references/${index}.bin`
        || reference.snapshot.sha256 !== expected.sha256;
    })
  ) context.addIssue({ code: "custom", path: ["sealedInputs", "references"], message: "sealed references must bind the Style Lock in order" });
  if (job.callBudget < job.pages.length) {
    context.addIssue({ code: "custom", path: ["callBudget"], message: "call budget must cover the initial page count" });
  }
  if (job.kind === "style-sample") {
    if (job.pages.length !== 1 || job.callBudget !== 1) {
      context.addIssue({ code: "custom", message: "style-sample call budget must be exactly 1" });
    }
    if (job.styleLock.approvalState !== "provisional") {
      context.addIssue({ code: "custom", path: ["styleLock", "approvalState"], message: "style-sample jobs require a provisional style lock" });
    }
  } else if (job.styleLock.approvalState !== "approved") {
    context.addIssue({ code: "custom", path: ["styleLock", "approvalState"], message: "deck and page-regeneration jobs require an approved style lock" });
  }
  if (job.kind === "page-regeneration" && job.pages.length !== 1) {
    context.addIssue({ code: "custom", path: ["pages"], message: "page-regeneration jobs require exactly one page" });
  }
  for (const [index, page] of job.pages.entries()) {
    if (page.promptSha256 !== sha256(page.finalPrompt)) {
      context.addIssue({ code: "custom", path: ["pages", index, "promptSha256"], message: "prompt hash must bind the final prompt" });
    }
    const expectedPrompt = `slides/${page.slideId}/prompts/${job.jobId}.txt`;
    if (page.promptArtifact !== expectedPrompt) {
      context.addIssue({ code: "custom", path: ["pages", index, "promptArtifact"], message: "prompt artifact must bind the job and slide" });
    }
    const expectedTarget = `generation/jobs/${job.jobId}/ai-image-output/${page.slideId}.png`;
    if (page.target !== expectedTarget) {
      context.addIssue({ code: "custom", path: ["pages", index, "target"], message: "output target must bind the job and slide" });
    }
    if (page.spec.slideId !== page.slideId) {
      context.addIssue({ code: "custom", path: ["pages", index, "spec"], message: "sealed slide spec must bind the job page" });
    }
    if (page.specSnapshot.path !== `${inputBase}/specs/${page.slideId}.json`) {
      context.addIssue({ code: "custom", path: ["pages", index, "specSnapshot", "path"], message: "sealed slide spec path must bind the job page" });
    }
  }
});

export const GenerationCallTupleSchema = z.object({
  jobId: z.string().uuid(),
  slideId: z.string().uuid(),
  attempt: z.number().int().positive(),
  requestOrdinal: z.number().int().nonnegative(),
}).strict();

const CallLedgerTupleShape = GenerationCallTupleSchema.shape;

export const CallLedgerEntrySchema = z.discriminatedUnion("entryKind", [
  z.object({
    ...CallLedgerTupleShape,
    entryKind: z.literal("admission"),
    outcome: z.literal("in-flight"),
    admissionTokenSha256: Sha256Schema.nullable().default(null),
    recordedAt: z.string().datetime(),
  }).strict(),
  z.object({
    ...CallLedgerTupleShape,
    entryKind: z.literal("terminal"),
    outcome: z.enum(["success", "failed"]),
    admissionTokenSha256: Sha256Schema.nullable().default(null),
    recordedAt: z.string().datetime(),
  }).strict(),
]);

function validateOrderedPages(
  pages: ReadonlyArray<{ slideId: string; order: number }>,
  context: z.RefinementCtx,
): void {
  if (new Set(pages.map(({ slideId }) => slideId)).size !== pages.length) {
    context.addIssue({ code: "custom", path: ["pages"], message: "page slide IDs must be unique" });
  }
  pages.forEach((page, index) => {
    if (index > 0 && page.order <= pages[index - 1]!.order) {
      context.addIssue({ code: "custom", path: ["pages", index, "order"], message: "pages must be in strictly increasing order" });
    }
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function canonicalContractFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type ImageJobKind = z.infer<typeof ImageJobKindSchema>;
export type GenerationAuthorizationPlan = z.infer<typeof GenerationAuthorizationPlanSchema>;
export type ImageGenerationJob = z.infer<typeof ImageGenerationJobSchema>;
export type GenerationCallTuple = z.infer<typeof GenerationCallTupleSchema>;
export type CallLedgerEntry = z.infer<typeof CallLedgerEntrySchema>;
