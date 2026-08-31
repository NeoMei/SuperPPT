import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ProjectManifestSchema,
  Sha256Schema,
  type ProjectManifest,
} from "../project/schemas.js";
import { withAnchoredRevisions } from "./anchored-fs.js";

export const PENDING_IMPACT_PATH = "revisions/pending-impact.json";

const UniqueSlideIdsSchema = z.array(z.string().uuid()).min(1).refine(
  (ids) => new Set(ids).size === ids.length,
  "slide IDs must be unique",
);

export const ChangeRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("brief"), title: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("outline-order") }).strict(),
  z.object({ kind: z.literal("outline-structure"), slideIds: UniqueSlideIdsSchema }).strict(),
  z.object({ kind: z.literal("slide-spec"), slideIds: UniqueSlideIdsSchema }).strict(),
  z.object({ kind: z.literal("style") }).strict(),
]);

export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

const ImpactPlanBodySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("revision-impact-plan"),
  projectId: z.string().uuid(),
  baseRevisionId: z.string().uuid(),
  baseRevisionNumber: z.number().int().positive(),
  baseManifestSha256: Sha256Schema,
  evidencePath: z.literal(PENDING_IMPACT_PATH),
  change: ChangeRequestSchema,
  staleSlideIds: z.array(z.string().uuid()),
  invalidatedOutputs: z.tuple([
    z.literal("complete-local-pptx"),
    z.literal("formal-delivery"),
    z.literal("acceptance-evidence"),
  ]),
  invalidateExports: z.literal(true),
  restartStage: z.enum(["outline", "slide-specs", "style"]),
}).strict();

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function impactDigest(body: z.infer<typeof ImpactPlanBodySchema>): string {
  return digest(JSON.stringify(body));
}

export const ImpactPlanSchema = ImpactPlanBodySchema.extend({
  sha256: Sha256Schema,
}).strict().superRefine((plan, context) => {
  const { sha256, ...body } = plan;
  if (sha256 !== impactDigest(ImpactPlanBodySchema.parse(body))) {
    context.addIssue({
      code: "custom",
      path: ["sha256"],
      message: "impact plan integrity check failed",
    });
  }
});

export type ImpactPlan = z.infer<typeof ImpactPlanSchema>;

const ImpactApprovalBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("revision-impact-approval"),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  approvalId: z.string().uuid(),
  snapshotPath: z.string().startsWith("revisions/"),
  planSha256: Sha256Schema,
  pendingEvidenceSha256: Sha256Schema,
  baseManifestSha256: Sha256Schema,
  confirmedAt: z.string().datetime(),
}).strict();

export const ImpactApprovalDescriptorSchema = ImpactApprovalBaseSchema.extend({
  descriptorSha256: Sha256Schema,
}).strict().superRefine((descriptor, context) => {
  const { descriptorSha256, ...base } = descriptor;
  if (descriptorSha256 !== digest(JSON.stringify(base))) {
    context.addIssue({ code: "custom", path: ["descriptorSha256"], message: "impact approval descriptor integrity check failed" });
  }
  const expected = `revisions/${descriptor.revisionId}/impact-approvals/${descriptor.approvalId}`;
  if (descriptor.snapshotPath !== expected) {
    context.addIssue({ code: "custom", path: ["snapshotPath"], message: "impact approval descriptor path identity mismatch" });
  }
});

export type ImpactApprovalDescriptor = z.infer<typeof ImpactApprovalDescriptorSchema>;

export function createImpactApprovalDescriptor(
  value: z.infer<typeof ImpactApprovalBaseSchema>,
): ImpactApprovalDescriptor {
  const base = ImpactApprovalBaseSchema.parse(value);
  return ImpactApprovalDescriptorSchema.parse({
    ...base,
    descriptorSha256: digest(JSON.stringify(base)),
  });
}

export function manifestIdentity(manifest: ProjectManifest): string {
  const valid = ProjectManifestSchema.parse(manifest);
  return digest(`${JSON.stringify(valid, null, 2)}\n`);
}

export function serializeImpactPlan(plan: ImpactPlan): string {
  return `${JSON.stringify(ImpactPlanSchema.parse(plan), null, 2)}\n`;
}

export async function readPendingImpactEvidence(root: string): Promise<{
  plan: ImpactPlan;
  bytes: Buffer;
  fileSha256: string;
}> {
  const bytes = await withAnchoredRevisions(root, undefined, (revisions) => {
    const value = revisions.read("pending-impact.json");
    if (!value) throw new Error("pending impact evidence does not exist");
    return value;
  });
  let plan: ImpactPlan;
  try {
    plan = ImpactPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("pending impact evidence is invalid", { cause: error });
  }
  if (bytes.toString("utf8") !== serializeImpactPlan(plan)) {
    throw new Error("pending impact evidence is not canonically serialized");
  }
  return { plan, bytes, fileSha256: digest(bytes) };
}

export async function validateImpactGateEvidence(
  root: string,
  base: ProjectManifest,
  gate: ProjectManifest["gates"][number],
): Promise<ImpactPlan> {
  if (gate.gate !== "revision-impact") {
    throw new Error("impact evidence validator received a non-impact gate");
  }
  if (!gate.approvalId || !gate.snapshotPath || !gate.snapshotManifestSha256) {
    throw new Error("revision impact gate lacks immutable approval evidence identity");
  }
  const expectedPath = `revisions/${gate.revisionId}/impact-approvals/${gate.approvalId}`;
  if (gate.snapshotPath !== expectedPath) {
    throw new Error("revision impact gate approval path is untrusted");
  }
  let descriptorBytes: Buffer;
  let planBytes: Buffer;
  let baseBytes: Buffer;
  try {
    ({ descriptorBytes, planBytes, baseBytes } = await withAnchoredRevisions(
      root,
      undefined,
      (revisions) => {
        const revision = revisions.child(gate.revisionId, false);
        try {
          const approvals = revision.child("impact-approvals", false);
          try {
            const approval = approvals.child(gate.approvalId!, false);
            try {
              if (!sameJson(
                approval.listRegularFiles(),
                ["approval.json", "impact.json", "superppt.json"],
              )) throw new Error("revision impact approval evidence tree is invalid");
              const descriptorBytes = approval.read("approval.json");
              const planBytes = approval.read("impact.json");
              const baseBytes = approval.read("superppt.json");
              if (!descriptorBytes || !planBytes || !baseBytes) {
                throw new Error("revision impact approval evidence tree is incomplete");
              }
              approval.assertCurrent();
              return { descriptorBytes, planBytes, baseBytes };
            } finally {
              approval.close();
            }
          } finally {
            approvals.close();
          }
        } finally {
          revision.close();
        }
      },
    ));
  } catch (error: unknown) {
    throw new Error("revision impact approval evidence tree is invalid", { cause: error });
  }
  let descriptor: ImpactApprovalDescriptor;
  let approvedPlan: ImpactPlan;
  let approvedBase: ProjectManifest;
  try {
    descriptor = ImpactApprovalDescriptorSchema.parse(JSON.parse(descriptorBytes.toString("utf8")));
    approvedPlan = ImpactPlanSchema.parse(JSON.parse(planBytes.toString("utf8")));
    approvedBase = ProjectManifestSchema.parse(JSON.parse(baseBytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("revision impact approval snapshot is invalid", { cause: error });
  }
  if (
    planBytes.toString("utf8") !== serializeImpactPlan(approvedPlan)
    || baseBytes.toString("utf8") !== `${JSON.stringify(approvedBase, null, 2)}\n`
    || !sameJson(approvedBase, ProjectManifestSchema.parse(base))
  ) {
    throw new Error("revision impact approval snapshot is not the exact base evidence");
  }
  const evidence = await readPendingImpactEvidence(root);
  const expectedHash = gate.artifactHashes[PENDING_IMPACT_PATH];
  if (
    Object.keys(gate.artifactHashes).length !== 1
    || expectedHash !== evidence.fileSha256
    || expectedHash !== digest(planBytes)
    || !sameJson(evidence.plan, approvedPlan)
    || gate.snapshotManifestSha256 !== approvedPlan.baseManifestSha256
    || gate.revisionId !== base.currentRevision.id
    || approvedPlan.projectId !== base.projectId
    || approvedPlan.baseRevisionId !== base.currentRevision.id
    || approvedPlan.baseRevisionNumber !== base.currentRevision.number
    || approvedPlan.baseManifestSha256 !== manifestIdentity(base)
    || !sameJson(approvedPlan, planImpact(base, approvedPlan.change))
    || descriptor.projectId !== base.projectId
    || descriptor.revisionId !== gate.revisionId
    || descriptor.approvalId !== gate.approvalId
    || descriptor.snapshotPath !== gate.snapshotPath
    || descriptor.planSha256 !== approvedPlan.sha256
    || descriptor.pendingEvidenceSha256 !== expectedHash
    || descriptor.baseManifestSha256 !== approvedPlan.baseManifestSha256
    || descriptor.confirmedAt !== gate.confirmedAt
  ) {
    throw new Error("revision impact gate evidence does not match the exact base manifest");
  }
  return approvedPlan;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function planImpact(
  rawManifest: ProjectManifest,
  rawChange: ChangeRequest,
): ImpactPlan {
  const manifest = ProjectManifestSchema.parse(rawManifest);
  const change = ChangeRequestSchema.parse(rawChange);
  const selected = "slideIds" in change ? new Set(change.slideIds) : new Set<string>();
  const known = new Set(manifest.slides.map((slide) => slide.id));
  for (const id of selected) {
    if (!known.has(id)) throw new Error(`unknown slide ID: ${id}`);
  }

  const global = change.kind === "brief" || change.kind === "style";
  const local = change.kind === "slide-spec" || change.kind === "outline-structure";
  const staleSlideIds = manifest.slides
    .filter((slide) => global || (local && selected.has(slide.id)))
    .map((slide) => slide.id);
  const restartStage = change.kind === "style"
    ? "style" as const
    : change.kind === "slide-spec"
      ? "slide-specs" as const
      : "outline" as const;
  const body = ImpactPlanBodySchema.parse({
    schemaVersion: 1,
    kind: "revision-impact-plan",
    projectId: manifest.projectId,
    baseRevisionId: manifest.currentRevision.id,
    baseRevisionNumber: manifest.currentRevision.number,
    baseManifestSha256: manifestIdentity(manifest),
    evidencePath: PENDING_IMPACT_PATH,
    change,
    staleSlideIds,
    invalidatedOutputs: ["complete-local-pptx", "formal-delivery", "acceptance-evidence"],
    invalidateExports: true,
    restartStage,
  });
  return ImpactPlanSchema.parse({ ...body, sha256: impactDigest(body) });
}
