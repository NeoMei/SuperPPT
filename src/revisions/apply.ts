import { randomUUID } from "node:crypto";
import { z } from "zod";

import { withProjectLease } from "../project/lock.js";
import { withGenerationLease } from "../generation/lease.js";
import { ProjectManifestSchema, type ProjectManifest } from "../project/schemas.js";
import {
  beginProjectRollbackTransaction,
  appendApprovedImpactGate,
  commitApprovedImpactRevision,
  finishProjectRollbackTransaction,
  assertProjectMutationNotFrozen,
  assertProjectRevisionTransitionNotFrozen,
  readProject,
} from "../project/store.js";
import {
  ChangeRequestSchema,
  createImpactApprovalDescriptor,
  ImpactPlanSchema,
  manifestIdentity,
  planImpact,
  readPendingImpactEvidence,
  serializeImpactPlan,
  type ChangeRequest,
  type ImpactPlan,
} from "./impact.js";
import { type RevisionEvidenceOperations, withAnchoredRevisions } from "./anchored-fs.js";
import { assertCurrentRevisionPlanningEvidence, assertManifestArtifactReferences } from "./physical.js";
import { writeProjectFileSet } from "./project-files.js";
import {
  finalizeRollbackJournal,
  readRollbackJournal,
} from "./rollback-journal.js";
import {
  recoverRollbackTransaction as recoverRollbackTransactionImpl,
  recoverRollbackTransactionLocked,
  type RollbackRecoveryOptions,
} from "./rollback-recovery.js";

const RevisionIdSchema = z.string().uuid();

export type RevisionControlOptions = {
  operations?: RevisionEvidenceOperations;
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function publishImpactApprovalSnapshot(
  root: string,
  base: ProjectManifest,
  evidence: Awaited<ReturnType<typeof readPendingImpactEvidence>>,
  approvalId: string,
  confirmedAt: string,
  operations?: RevisionEvidenceOperations,
): Promise<string> {
  const snapshotPath = `revisions/${base.currentRevision.id}/impact-approvals/${approvalId}`;
  const descriptor = createImpactApprovalDescriptor({
    schemaVersion: 1,
    kind: "revision-impact-approval",
    projectId: base.projectId,
    revisionId: base.currentRevision.id,
    approvalId,
    snapshotPath,
    planSha256: evidence.plan.sha256,
    pendingEvidenceSha256: evidence.fileSha256,
    baseManifestSha256: evidence.plan.baseManifestSha256,
    confirmedAt,
  });
  await withAnchoredRevisions(root, operations, (revisions) => {
    const revision = revisions.child(base.currentRevision.id);
    try {
      const approvals = revision.child("impact-approvals");
      try {
        const stagingName = `.${approvalId}.staging`;
        const staging = approvals.child(stagingName);
        try {
          staging.writeExclusive("approval.json", `${JSON.stringify(descriptor, null, 2)}\n`);
          staging.writeExclusive("impact.json", evidence.bytes);
          staging.writeExclusive(
            "superppt.json",
            `${JSON.stringify(ProjectManifestSchema.parse(base), null, 2)}\n`,
          );
          staging.assertCurrent();
        } finally {
          staging.close();
        }
        approvals.promoteChildExclusive(stagingName, approvalId);
      } finally {
        approvals.close();
      }
    } finally {
      revision.close();
    }
  });
  return snapshotPath;
}

async function replacePendingImpact(
  root: string,
  value: string,
  operations?: RevisionEvidenceOperations,
): Promise<void> {
  await withAnchoredRevisions(root, operations, (revisions) => {
    revisions.replace(
      "pending-impact.json",
      value,
      `.pending-impact-${randomUUID()}.staging`,
    );
  });
}

function assertExactPlanBase(manifest: ProjectManifest, plan: ImpactPlan): void {
  if (
    plan.projectId !== manifest.projectId
    || plan.baseRevisionId !== manifest.currentRevision.id
    || plan.baseRevisionNumber !== manifest.currentRevision.number
    || plan.baseManifestSha256 !== manifestIdentity(manifest)
  ) {
    throw new Error("impact plan has a stale base manifest identity");
  }
}

export async function publishImpactPlan(
  root: string,
  change: ChangeRequest,
  options: RevisionControlOptions = {},
): Promise<ImpactPlan> {
  const validChange = ChangeRequestSchema.parse(change);
  return withGenerationLease(root, (generationRoot) => withProjectLease(generationRoot, "revision-impact", async (canonicalRoot) => {
    await assertProjectRevisionTransitionNotFrozen(canonicalRoot);
    const plan = planImpact(await readProject(canonicalRoot), validChange);
    await replacePendingImpact(canonicalRoot, serializeImpactPlan(plan), options.operations);
    return plan;
  }));
}

export async function approveImpact(
  root: string,
  sha256: string,
  options: RevisionControlOptions = {},
): Promise<void> {
  const expected = z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);
  await withGenerationLease(root, (generationRoot) => withProjectLease(generationRoot, "revision-impact", async (canonicalRoot) => {
    await assertProjectRevisionTransitionNotFrozen(canonicalRoot);
    const evidence = await readPendingImpactEvidence(canonicalRoot);
    if (evidence.plan.sha256 !== expected) {
      throw new Error("pending impact hash does not match the requested approval");
    }
    const base = await readProject(canonicalRoot);
    assertExactPlanBase(base, evidence.plan);
    await assertCurrentRevisionPlanningEvidence(canonicalRoot, base);
    await assertManifestArtifactReferences(canonicalRoot, base);
    const approvalId = randomUUID();
    const confirmedAt = new Date().toISOString();
    const snapshotPath = await publishImpactApprovalSnapshot(
      canonicalRoot,
      base,
      evidence,
      approvalId,
      confirmedAt,
      options.operations,
    );
    await appendApprovedImpactGate(canonicalRoot, evidence.plan, {
      approvalId,
      confirmedAt,
      snapshotPath,
    });
  }));
}

export async function applyRevision(
  root: string,
  rawPlan: ImpactPlan,
  rawChange: ChangeRequest,
  options: RevisionControlOptions = {},
): Promise<void> {
  const plan = ImpactPlanSchema.parse(rawPlan);
  const change = ChangeRequestSchema.parse(rawChange);
  if (!sameJson(plan.change, change)) throw new Error("impact plan change does not match apply request");

  await commitApprovedImpactRevision(root, plan, change, options.operations);
}

export async function recoverRollbackTransaction(
  root: string,
  options: RollbackRecoveryOptions = {},
): Promise<boolean> {
  return recoverRollbackTransactionImpl(root, options);
}

export async function rollbackToRevision(
  root: string,
  rawRevisionId: string,
  options: RevisionControlOptions = {},
): Promise<void> {
  const revisionId = RevisionIdSchema.parse(rawRevisionId);
  await withGenerationLease(root, (generationRoot) => withProjectLease(generationRoot, "revision-impact", async (canonicalRoot) => {
    await assertProjectMutationNotFrozen(canonicalRoot);
    const recovered = await recoverRollbackTransactionLocked(canonicalRoot, options);
    if (
      recovered
      && recovered.outcome === "after"
      && recovered.targetRevisionId === revisionId
    ) return;
    await beginProjectRollbackTransaction(canonicalRoot, revisionId, options.operations);
    await options.operations?.rollbackCheckpoint?.("marker-published");
    const published = await readRollbackJournal(canonicalRoot, options.operations);
    await writeProjectFileSet(canonicalRoot, published.after, options.operations);
    await options.operations?.rollbackCheckpoint?.("files-written");
    await finishProjectRollbackTransaction(canonicalRoot, options.operations);
    await options.operations?.rollbackCheckpoint?.("manifest-published");
    await finalizeRollbackJournal(canonicalRoot, published.journal.transactionId, options.operations);
  }));
}
