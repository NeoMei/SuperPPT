import { z } from "zod";

import { RoleSchema } from "../planning/schemas.js";
import {
  DelegatedPresentationQaSchema,
  type DelegatedPresentationQa,
} from "./schemas.js";

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
