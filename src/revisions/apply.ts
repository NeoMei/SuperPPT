import { randomUUID } from "node:crypto";
import { z } from "zod";

import { withProjectLease } from "../project/lock.js";
import { ProjectManifestSchema, type ProjectManifest } from "../project/schemas.js";
import { readProject, updateProject } from "../project/store.js";
import {
  ChangeRequestSchema,
  createImpactApprovalDescriptor,
  ImpactPlanSchema,
  PENDING_IMPACT_PATH,
  manifestIdentity,
  planImpact,
  readPendingImpactEvidence,
  serializeImpactPlan,
  validateImpactGateEvidence,
  type ChangeRequest,
  type ImpactPlan,
} from "./impact.js";
import {
  type RevisionEvidenceOperations,
  withAnchoredRevisions,
} from "./anchored-fs.js";

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

async function snapshotRevision(
  root: string,
  manifest: ProjectManifest,
  operations?: RevisionEvidenceOperations,
): Promise<void> {
  const serialized = `${JSON.stringify(ProjectManifestSchema.parse(manifest), null, 2)}\n`;
  await withAnchoredRevisions(root, operations, (revisions) => {
    const directory = revisions.child(manifest.currentRevision.id);
    try {
      const existing = directory.read("superppt.json");
      if (existing) {
        if (existing.toString("utf8") !== serialized) {
          throw new Error(`immutable revision snapshot differs: ${manifest.currentRevision.id}`);
        }
        return;
      }
      directory.writeExclusive("superppt.json", serialized);
      directory.assertCurrent();
    } finally {
      directory.close();
    }
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
  return withProjectLease(root, "revision-impact", async (canonicalRoot) => {
    const plan = planImpact(await readProject(canonicalRoot), validChange);
    await replacePendingImpact(canonicalRoot, serializeImpactPlan(plan), options.operations);
    return plan;
  });
}

export async function approveImpact(
  root: string,
  sha256: string,
  options: RevisionControlOptions = {},
): Promise<void> {
  const expected = z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);
  await withProjectLease(root, "revision-impact", async (canonicalRoot) => {
    const evidence = await readPendingImpactEvidence(canonicalRoot);
    if (evidence.plan.sha256 !== expected) {
      throw new Error("pending impact hash does not match the requested approval");
    }
    const base = await readProject(canonicalRoot);
    assertExactPlanBase(base, evidence.plan);
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
    await updateProject(canonicalRoot, (manifest) => {
      assertExactPlanBase(manifest, evidence.plan);
      const latestGate = manifest.gates.at(-1);
      if (
        latestGate?.gate === "revision-impact"
        && latestGate.revisionId === manifest.currentRevision.id
      ) {
        throw new Error("pending impact is already approved");
      }
      return {
        ...manifest,
        gates: [...manifest.gates, {
          gate: "revision-impact" as const,
          revisionId: manifest.currentRevision.id,
          approvalId,
          artifactHashes: { [PENDING_IMPACT_PATH]: evidence.fileSha256 },
          snapshotPath,
          snapshotManifestSha256: evidence.plan.baseManifestSha256,
          confirmedAt,
        }],
      };
    });
  });
}

async function requireApprovedPlan(
  root: string,
  manifest: ProjectManifest,
  requested: ImpactPlan,
): Promise<void> {
  const gate = manifest.gates.at(-1);
  if (!gate || gate.gate !== "revision-impact") {
    throw new Error("revision impact must be approved before apply");
  }
  const base = ProjectManifestSchema.parse({
    ...manifest,
    gates: manifest.gates.slice(0, -1),
  });
  const approved = await validateImpactGateEvidence(root, base, gate);
  if (!sameJson(approved, requested)) {
    throw new Error("approved revision impact does not match the requested plan");
  }
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

  await withProjectLease(root, "revision-impact", async (canonicalRoot) => {
    const pending = await readPendingImpactEvidence(canonicalRoot);
    if (!sameJson(pending.plan, plan)) throw new Error("pending impact evidence does not match apply request");
    await updateProject(canonicalRoot, async (manifest) => {
      if (manifest.currentRevision.id !== plan.baseRevisionId) {
        throw new Error("impact plan is stale for the current base revision");
      }
      await requireApprovedPlan(canonicalRoot, manifest, plan);
      await snapshotRevision(canonicalRoot, manifest, options.operations);
      const nextRevision = {
        id: randomUUID(),
        number: manifest.currentRevision.number + 1,
        createdAt: new Date().toISOString(),
        parentId: manifest.currentRevision.id,
      };
      const stale = new Set(plan.staleSlideIds);
      return {
        ...manifest,
        title: change.kind === "brief" && change.title ? change.title : manifest.title,
        stage: plan.restartStage,
        currentRevision: nextRevision,
        revisions: [...manifest.revisions, nextRevision],
        slides: manifest.slides.map((slide) => stale.has(slide.id) ? {
          ...slide,
          status: "stale" as const,
          image: null,
          editable: null,
          finalRender: null,
          staleReasons: [...new Set([...slide.staleReasons, change.kind])],
        } : slide),
        exports: plan.invalidateExports ? {
          pptx: null,
          pdf: null,
          montage: null,
          acceptance: null,
        } : manifest.exports,
      };
    });
  });
}

async function readRollbackTarget(
  root: string,
  revisionId: string,
  operations?: RevisionEvidenceOperations,
): Promise<ProjectManifest> {
  let bytes: Buffer;
  try {
    bytes = await withAnchoredRevisions(root, operations, (revisions) => {
      const directory = revisions.child(revisionId, false);
      try {
        const value = directory.read("superppt.json");
        if (!value) throw new Error("snapshot does not exist");
        directory.assertCurrent();
        return value;
      } finally {
        directory.close();
      }
    });
  } catch (error: unknown) {
    throw new Error(`rollback revision snapshot is missing or unsafe: ${revisionId}`, { cause: error });
  }
  try {
    return ProjectManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error(`rollback revision snapshot is corrupt: ${revisionId}`, { cause: error });
  }
}

export async function rollbackToRevision(
  root: string,
  rawRevisionId: string,
  options: RevisionControlOptions = {},
): Promise<void> {
  const revisionId = RevisionIdSchema.parse(rawRevisionId);
  await withProjectLease(root, "revision-impact", async (canonicalRoot) => {
    await updateProject(canonicalRoot, async (current) => {
      if (revisionId === current.currentRevision.id) {
        throw new Error("rollback target must be an earlier revision");
      }
      const targetIndex = current.revisions.findIndex((revision) => revision.id === revisionId);
      if (targetIndex < 0) throw new Error("rollback target is not in the project revision ledger");
      const target = await readRollbackTarget(canonicalRoot, revisionId, options.operations);
      const targetPrefix = current.revisions.slice(0, targetIndex + 1);
      if (
        target.projectId !== current.projectId
        || target.currentRevision.id !== revisionId
        || target.revisions.at(-1)?.id !== revisionId
        || !sameJson(target.revisions, targetPrefix)
      ) {
        throw new Error("rollback target snapshot is not a legal project revision prefix");
      }
      await snapshotRevision(canonicalRoot, current);
      const rollbackRevision = {
        id: randomUUID(),
        number: current.currentRevision.number + 1,
        createdAt: new Date().toISOString(),
        parentId: current.currentRevision.id,
      };
      return ProjectManifestSchema.parse({
        ...target,
        currentRevision: rollbackRevision,
        revisions: [...current.revisions, rollbackRevision],
        gates: current.gates,
      });
    });
  });
}
