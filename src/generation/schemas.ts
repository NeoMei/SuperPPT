import { z } from "zod";

import { Sha256Schema } from "../project/schemas.js";

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
  durationMs: z.number().int().nonnegative(),
  quality: QualityDecisionSchema.nullable(),
  outcome: z.enum(["generated", "accepted", "rejected", "provider-error", "review-error"]).default("generated"),
  errorCode: z.enum(["provider-failed", "invalid-image", "review-failed"]).nullable().default(null),
}).strict().superRefine((value, context) => {
  if ((value.output === null) !== (value.outputSha256 === null)) {
    context.addIssue({ code: "custom", message: "output and outputSha256 must be present together", path: ["output"] });
  }
  if (value.outcome === "accepted" && !value.quality?.ok) {
    context.addIssue({ code: "custom", message: "accepted attempts require passing quality", path: ["quality"] });
  }
  if (value.outcome === "rejected" && value.quality?.ok !== false) {
    context.addIssue({ code: "custom", message: "rejected attempts require failing quality", path: ["quality"] });
  }
});

export type QualityDecision = z.infer<typeof QualityDecisionSchema>;
export type AttemptLedger = z.infer<typeof AttemptLedgerSchema>;
