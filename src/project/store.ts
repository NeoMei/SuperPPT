import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { syncDirectory, writeDurableExclusive } from "./durable.js";
import { renameSafe } from "./exclusive.js";
import {
  sha256Evidence,
  validateCurrentPresentationBinding,
  validateExecutionGateEvidence,
  validateOrdinaryGateEvidence,
} from "./evidence.js";
import { withProjectLease } from "./lock.js";
import { validateProjectRoot } from "./paths.js";
import { assertNoPendingRollbackTransaction } from "./rollback-guard.js";
import { withGenerationLease } from "../generation/lease.js";
import {
  readOwnedRegularFile,
  readRegularFileNoFollow,
  type SafeReadOperations,
} from "./safe-file.js";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "./schemas.js";
import {
  ChangeRequestSchema,
  ImpactPlanSchema,
  PENDING_IMPACT_PATH,
  manifestIdentity,
  readPendingImpactEvidence,
  validateImpactGateEvidence,
  type ChangeRequest,
  type ImpactPlan,
} from "../revisions/impact.js";
import {
  authenticatedPlanningArtifacts,
  assertCurrentRevisionPlanningEvidence,
  assertManifestArtifactReferences,
} from "../revisions/physical.js";
import {
  publishRollbackJournal,
  readRollbackJournal,
  rollbackRevisionBaseForEvidence,
} from "../revisions/rollback-journal.js";
import { readProjectFileSet } from "../revisions/project-files.js";
import {
  hasExactRevisionSnapshot,
  publishRevisionSnapshot,
  readRevisionSnapshot,
} from "../revisions/snapshot.js";
import type { RevisionEvidenceOperations } from "../revisions/anchored-fs.js";

export const MARKER = ".superppt-project.json";
export const MANIFEST = "superppt.json";

const PresentedDeckEditSessionSchema = z.object({
  sessionId: z.string().uuid(),
  state: z.enum(["prepared", "external-editing", "awaiting-confirmation", "adopting", "adopted", "rejected"]),
}).passthrough();

export const OwnershipMarkerSchema = z.object({
  markerVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("project"),
  projectId: z.string().uuid(),
  canonicalRoot: z.string().min(1),
}).strict();

export type OwnershipMarker = z.infer<typeof OwnershipMarkerSchema>;
export type WriteProjectCheckpoint =
  | "staged-written"
  | "staged-synced"
  | "manifest-promoted"
  | "parent-synced";

export type WriteProjectOperations = {
  checkpoint?: (
    step: WriteProjectCheckpoint,
    stagingPath: string,
  ) => Promise<void> | void;
  promote?: (stagingPath: string, manifestPath: string) => Promise<void>;
};

export type ProjectUpdater = (
  manifest: ProjectManifest,
) => ProjectManifest | Promise<ProjectManifest>;

const PROJECT_BASE_IDENTITY: unique symbol = Symbol("superppt.project-base-identity");
export type ReadProjectManifest = ProjectManifest & {
  readonly [PROJECT_BASE_IDENTITY]: string;
};

export const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function assertNoPresentedDeckEditSessionForManifest(
  root: string,
  manifest: ProjectManifest,
): Promise<void> {
  if (manifest.activeDeckEditSessionId === null) return;
  let session: z.infer<typeof PresentedDeckEditSessionSchema>;
  try {
    const path = join(root, "output", "deck-edit-sessions", manifest.activeDeckEditSessionId, "session.json");
    session = PresentedDeckEditSessionSchema.parse(JSON.parse((await readRegularFileNoFollow(path)).toString("utf8")));
  } catch (error: unknown) {
    throw new Error("project mutations are frozen by an unreadable active deck edit session", { cause: error });
  }
  if (session.sessionId !== manifest.activeDeckEditSessionId) {
    throw new Error("project mutations are frozen by an inconsistent active deck edit session");
  }
  if (session.state === "external-editing" || session.state === "awaiting-confirmation") {
    throw new Error(`project mutations are frozen while the complete deck candidate is ${session.state}`);
  }
}

async function assertProjectMutationAllowed(
  root: string,
  _allowCompletedRevisionTransition = false,
): Promise<void> {
  const current = await ownedProject(root);
  if (current.manifest.clientAcceptanceTransaction) {
    throw new Error("project mutations are frozen while client acceptance is pending");
  }
  await assertNoPresentedDeckEditSessionForManifest(current.root, current.manifest);
}

export async function assertProjectMutationNotFrozen(root: string): Promise<void> {
  await assertProjectMutationAllowed(root);
}

export async function assertNoPresentedDeckEditSession(root: string): Promise<void> {
  const current = await ownedProject(root);
  await assertNoPresentedDeckEditSessionForManifest(current.root, current.manifest);
}

export async function assertProjectRevisionTransitionNotFrozen(root: string): Promise<void> {
  await assertProjectMutationAllowed(root, true);
}

function assertRevisionEvolution(
  previous: ProjectManifest,
  next: ProjectManifest,
): void {
  if (
    next.revisions.length < previous.revisions.length
    || previous.revisions.some((revision, index) =>
      !sameJson(revision, next.revisions[index])
    )
  ) {
    throw new Error("immutable revision history must remain an exact prefix");
  }

  const appended = next.revisions.slice(previous.revisions.length);
  let prior = previous.revisions.at(-1)!;
  for (const revision of appended) {
    if (
      revision.parentId !== prior.id
      || revision.number !== prior.number + 1
    ) {
      throw new Error("immutable revision history must append a contiguous chain");
    }
    prior = revision;
  }

  const currentValid = appended.length === 0
    ? sameJson(next.currentRevision, previous.currentRevision)
    : sameJson(next.currentRevision, appended.at(-1));
  if (!currentValid) {
    throw new Error(
      "immutable revision history requires currentRevision to remain unchanged or equal the appended tail",
    );
  }

  const previousOutputs = previous.outputRevisions ?? [];
  const nextOutputs = next.outputRevisions ?? [];
  if (
    nextOutputs.length < previousOutputs.length
    || previousOutputs.some((revision, index) => !sameJson(revision, nextOutputs[index]))
  ) throw new Error("immutable output revision history must remain an exact prefix");
  const previousDeckRevision = previous.deckRevision ?? previous.currentRevision.number;
  const nextDeckRevision = next.deckRevision ?? next.currentRevision.number;
  if (nextDeckRevision < previousDeckRevision || nextDeckRevision > previousDeckRevision + 1) {
    throw new Error("deck revision must remain current or advance exactly once");
  }

  if (
    next.gates.length < previous.gates.length
    || previous.gates.some((gate, index) => !sameJson(gate, next.gates[index]))
  ) {
    throw new Error("gate history must remain an exact prefix");
  }
}

type ProjectPersistMode =
  | "ordinary"
  | "delegated-generation-attach"
  | "revision-append"
  | "rollback-begin"
  | "rollback-abort"
  | "rollback-finish"
  | "smoke-copy-create"
  | "smoke-copy-ready"
  | "acceptance-transaction-begin"
  | "acceptance-transaction-recover"
  | "smoke-copy-complete";

async function assertControlledRevisionTrust(
  root: string,
  previous: ProjectManifest,
  next: ProjectManifest,
  mode: ProjectPersistMode,
): Promise<void> {
  const appended = next.revisions.slice(previous.revisions.length);
  const markerChanged = !sameJson(previous.rollbackTransaction, next.rollbackTransaction);
  const smokeAnchorChanged = !sameJson(previous.clientSmokeCopyAnchor, next.clientSmokeCopyAnchor);
  const acceptanceTransactionChanged = !sameJson(
    previous.clientAcceptanceTransaction,
    next.clientAcceptanceTransaction,
  );
  if (mode === "ordinary" || mode === "delegated-generation-attach") {
    if (appended.length > 0 || markerChanged || smokeAnchorChanged || acceptanceTransactionChanged) {
      throw new Error("revision, rollback, and client acceptance trust fields require a controlled store transition");
    }
    return;
  }
  if (mode === "smoke-copy-create" || mode === "smoke-copy-ready") {
    if (appended.length > 0 || markerChanged || !smokeAnchorChanged || acceptanceTransactionChanged) {
      throw new Error("client smoke copy trust transition is invalid");
    }
    return;
  }
  if (mode === "acceptance-transaction-begin") {
    if (
      appended.length > 0
      || markerChanged
      || smokeAnchorChanged
      || previous.clientAcceptanceTransaction
      || !next.clientAcceptanceTransaction
    ) throw new Error("client acceptance transaction begin is invalid");
    return;
  }
  if (mode === "acceptance-transaction-recover") {
    if (
      appended.length > 0
      || markerChanged
      || smokeAnchorChanged
      || !previous.clientAcceptanceTransaction
      || !next.clientAcceptanceTransaction
      || sameJson(previous.clientAcceptanceTransaction, next.clientAcceptanceTransaction)
    ) throw new Error("client acceptance transaction recovery is invalid");
    return;
  }
  if (mode === "smoke-copy-complete") {
    if (
      appended.length > 0
      || markerChanged
      || !smokeAnchorChanged
      || !acceptanceTransactionChanged
      || !previous.clientAcceptanceTransaction
      || next.clientAcceptanceTransaction
    ) throw new Error("client smoke copy completion trust transition is invalid");
    return;
  }
  if (mode === "revision-append") {
    if (appended.length === 0 || markerChanged || smokeAnchorChanged || acceptanceTransactionChanged) {
      throw new Error("controlled revision append has an invalid rollback marker transition");
    }
  } else if (mode === "rollback-begin") {
    const marker = next.rollbackTransaction;
    if (
      appended.length !== 0
      || previous.rollbackTransaction
      || acceptanceTransactionChanged
      || !marker
      || marker.baseRevisionId !== previous.currentRevision.id
      || !previous.revisions.some((revision) => revision.id === marker.targetRevisionId)
    ) throw new Error("rollback begin marker transition is invalid");
    return;
  } else if (mode === "rollback-abort") {
    if (
      appended.length !== 0
      || !previous.rollbackTransaction
      || next.rollbackTransaction
      || acceptanceTransactionChanged
    ) throw new Error("rollback abort marker transition is invalid");
    return;
  } else {
    const marker = previous.rollbackTransaction;
    const revision = appended[0];
    if (
      appended.length !== 1
      || !marker
      || next.rollbackTransaction
      || acceptanceTransactionChanged
      || !revision
      || revision.id !== marker.rollbackRevisionId
      || revision.parentId !== marker.baseRevisionId
      || revision.rollbackTransactionDescriptorSha256 !== marker.descriptorSha256
    ) throw new Error("rollback finish marker transition is invalid");
  }

  let parent = previous.currentRevision;
  for (const revision of appended) {
    const snapshot = await readRevisionSnapshot(root, parent.id);
    if (revision.parentSnapshotDescriptorSha256 !== snapshot.descriptor.descriptorSha256) {
      throw new Error("revision parent snapshot descriptor anchor mismatch");
    }
    if (mode !== "rollback-finish" && revision.rollbackTransactionDescriptorSha256) {
      throw new Error("rollback transaction anchors require a controlled finish transition");
    }
    parent = revision;
  }
}

function artifactEvidence(manifest: ProjectManifest): string[] {
  const artifacts = [
    manifest.brief,
    manifest.outline,
    manifest.style,
    ...manifest.slides.flatMap((slide) => [
      slide.image,
      slide.editable,
      slide.finalRender,
      ...(slide.generationHistory ?? []).flatMap((entry) => [entry.image, entry.finalRender]),
    ]),
    ...(manifest.outputRevisions ?? []).flatMap((revision) => [
      ...revision.slides.flatMap((slide) => [slide.finalRender, slide.editable]),
      ...Object.values(revision.exports),
    ]),
    ...Object.values(manifest.exports),
  ];
  const persistedIds = new Set(manifest.revisions.map((revision) => revision.id));
  return artifacts
    .filter((artifact) => artifact && persistedIds.has(artifact.revisionId))
    .map((artifact) => JSON.stringify(artifact))
    .sort();
}

function preservesArtifactEvidence(
  previous: ProjectManifest,
  next: ProjectManifest,
): boolean {
  const remaining = artifactEvidence(next);
  for (const evidence of artifactEvidence(previous)) {
    const index = remaining.indexOf(evidence);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function isExactCurrentDeckReviewReset(
  previous: ProjectManifest,
  next: ProjectManifest,
): boolean {
  if (
    previous.stage !== "delivered"
    || next.stage !== "deck-review"
    || !previous.currentDeck
    || !previous.formalDelivery
    || previous.formalDelivery.revisionId !== previous.currentDeck.revisionId
    || previous.formalDelivery.sha256 !== previous.currentDeck.sha256
    || previous.exports.pptx?.path !== previous.currentDeck.relativePath
    || previous.exports.pptx.sha256 !== previous.currentDeck.sha256
    || !previous.exports.acceptance
    || next.exports.pptx !== null
    || next.exports.acceptance !== null
    || next.pendingDeckEdit !== null
  ) return false;
  const {
    formalDelivery: _formalDelivery,
    clientSmokeCopyAnchor: _clientSmokeCopyAnchor,
    clientAcceptanceTransaction: _clientAcceptanceTransaction,
    ...base
  } = previous;
  return sameJson({
    ...base,
    stage: "deck-review",
    currentDeck: next.currentDeck,
    pendingDeckEdit: null,
    exports: { pptx: null, acceptance: null },
  }, next);
}

async function assertGenerationHistoryEvolution(
  root: string,
  previous: ProjectManifest,
  next: ProjectManifest,
): Promise<void> {
  const delegatedPath = (path: string, slideId: string): string | null => {
    const escapedSlideId = slideId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^generation/jobs/([0-9a-f-]{36})/normalized/${escapedSlideId}\\.png$`).exec(path)?.[1] ?? null;
  };
  let delegatedModule: typeof import("../generation/delegation-result.js") | undefined;
  for (const slide of next.slides) {
    const prior = previous.slides.find(({ id }) => id === slide.id);
    const before = prior?.generationHistory ?? [];
    const after = slide.generationHistory ?? [];
    if (after.length < before.length || !before.every((entry, index) => sameJson(entry, after[index]))) {
      throw new Error("delegated generation history must remain an exact prefix");
    }
    if (after.length === before.length) continue;
    const appended = after.slice(before.length);
    const entry = appended[0];
    if (
      !prior
      || appended.length !== 1
      || !entry
      || !prior.image
      || !prior.finalRender
      || !slide.image
      || !slide.finalRender
      || !sameJson(entry.image, prior.image)
      || !sameJson(entry.finalRender, prior.finalRender)
      || !sameJson(prior.image, prior.finalRender)
      || !sameJson(slide.image, slide.finalRender)
    ) throw new Error("delegated generation history transition is invalid");
    const oldJobId = delegatedPath(prior.image.path, slide.id);
    const newJobId = delegatedPath(slide.image.path, slide.id);
    if (!oldJobId || !newJobId || entry.jobId !== oldJobId) {
      throw new Error("delegated generation history does not bind immutable jobs");
    }
    delegatedModule ??= await import("../generation/delegation-result.js");
    const { readAndReauthenticateDelegatedResult } = delegatedModule;
    const [oldResult, newResult] = await Promise.all([
      readAndReauthenticateDelegatedResult(root, oldJobId),
      readAndReauthenticateDelegatedResult(root, newJobId),
    ]);
    const oldPage = oldResult.result.pages.find(({ slideId }) => slideId === slide.id);
    const newPage = newResult.result.pages.find(({ slideId }) => slideId === slide.id);
    if (
      oldResult.authorizationSequence === null
      || newResult.authorizationSequence === null
      || !oldPage?.artifacts
      || !newPage?.artifacts
      || !sameJson(oldPage.artifacts.normalized, prior.image)
      || !sameJson(newPage.artifacts.normalized, slide.image)
      || entry.authorizationSequence !== oldResult.authorizationSequence
      || entry.attempt !== oldPage.attempt
      || (newResult.authorizationSequence - oldResult.authorizationSequence || newPage.attempt - oldPage.attempt) <= 0
    ) throw new Error("delegated generation history precedence is not authenticated");
  }
}

function assertGenerationHistoryUnchanged(previous: ProjectManifest, next: ProjectManifest): void {
  for (const slide of next.slides) {
    const prior = previous.slides.find(({ id }) => id === slide.id);
    if (!sameJson(prior?.generationHistory ?? [], slide.generationHistory ?? [])) {
      throw new Error("delegated generation history requires an authenticated attachment transition");
    }
  }
}

async function validateCompleteDeckReviewGateEvidence(
  root: string,
  manifest: ProjectManifest,
  gate: ProjectManifest["gates"][number],
): Promise<void> {
  const binding = gate.deckReview;
  const current = manifest.currentDeck;
  if (gate.gate !== "deck-review" || !binding || !current) {
    throw new Error("complete deck review binding is missing");
  }
  const absolutePath = join(root, ...current.relativePath.split("/"));
  if (
    binding.revisionId !== current.revisionId
    || binding.absolutePath !== absolutePath
    || binding.sha256 !== current.sha256
    || sha256Evidence(await readRegularFileNoFollow(absolutePath)) !== current.sha256
  ) throw new Error("complete deck review binding is stale or does not bind the exact local PPTX");
}

export function createOwnershipMarker(
  projectId: string,
  canonicalRoot: string,
): OwnershipMarker {
  return OwnershipMarkerSchema.parse({
    markerVersion: 1,
    appId: "superppt",
    artifactKind: "project",
    projectId,
    canonicalRoot,
  });
}

async function requireRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("project directory is not owned by SuperPPT");
  }
}

async function ownedProject(root: string): Promise<{
  root: string;
  manifest: ProjectManifest;
  baseIdentity: string;
  manifestBytes: Buffer;
}> {
  const canonical = await validateProjectRoot(root);
  try {
    const markerPath = join(canonical, MARKER);
    const manifestPath = join(canonical, MANIFEST);
    await requireRegularFile(markerPath);
    const marker = OwnershipMarkerSchema.parse(
      JSON.parse(await readFile(markerPath, "utf8")),
    );
    if (marker.canonicalRoot !== canonical) {
      throw new Error("marker root mismatch");
    }
    await requireRegularFile(manifestPath);
    const manifestBytes = await readFile(manifestPath);
    const manifest = ProjectManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    if (marker.projectId !== manifest.projectId) {
      throw new Error("marker project mismatch");
    }
    return { root: canonical, manifest, baseIdentity: sha256(manifestBytes), manifestBytes };
  } catch {
    throw new Error("project directory is not owned by SuperPPT");
  }
}

export async function readProject(root: string): Promise<ReadProjectManifest> {
  const owned = await ownedProject(root);
  await assertNoPendingRollbackTransaction(owned.root);
  if (owned.manifest.rollbackTransaction) {
    throw new Error("project has an orphaned rollback transaction marker");
  }
  Object.defineProperty(owned.manifest, PROJECT_BASE_IDENTITY, {
    value: owned.baseIdentity,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return owned.manifest as ReadProjectManifest;
}

async function persistProject(
  owned: { root: string; manifest: ProjectManifest },
  valid: ProjectManifest,
  operations: WriteProjectOperations = {},
  mode: ProjectPersistMode = "ordinary",
  _allowCompletedRevisionTransition = false,
): Promise<void> {
  if (
    mode !== "acceptance-transaction-begin"
    && mode !== "acceptance-transaction-recover"
    && mode !== "smoke-copy-complete"
  ) {
    if (owned.manifest.clientAcceptanceTransaction) {
      throw new Error("project mutations are frozen while client acceptance is pending");
    }
  }
  if (valid.projectId !== owned.manifest.projectId) {
    throw new Error("project directory is not owned by SuperPPT");
  }
  assertRevisionEvolution(owned.manifest, valid);
  if (mode !== "delegated-generation-attach" && mode !== "rollback-finish") {
    assertGenerationHistoryUnchanged(owned.manifest, valid);
  }
  await assertControlledRevisionTrust(owned.root, owned.manifest, valid, mode);
  const snapshotBase = mode === "rollback-finish" && owned.manifest.rollbackTransaction
    ? ProjectManifestSchema.parse((({ rollbackTransaction: _marker, ...base }) => base)(owned.manifest))
    : mode === "smoke-copy-complete" && owned.manifest.clientAcceptanceTransaction
      ? ProjectManifestSchema.parse((({ clientAcceptanceTransaction: _transaction, ...base }) => base)(owned.manifest))
      : owned.manifest;
  if (
    !preservesArtifactEvidence(owned.manifest, valid)
    && !isExactCurrentDeckReviewReset(owned.manifest, valid)
    && !(mode === "revision-append"
      && owned.manifest.stage === "delivered"
      && owned.manifest.clientSmokeCopyAnchor?.state === "completed")
    && !await hasExactRevisionSnapshot(owned.root, snapshotBase)
  ) {
    throw new Error(
      "immutable artifact evidence requires an exact revision snapshot",
    );
  }

  for (const gate of valid.gates.slice(owned.manifest.gates.length)) {
    if (gate.gate === "deck-review" && gate.deckReview) {
      try {
        if (gate.revisionId !== valid.currentRevision.id) {
          throw new Error("complete deck review project revision must be current");
        }
        await validateCompleteDeckReviewGateEvidence(owned.root, valid, gate);
      } catch (error: unknown) {
        throw new Error("complete deck review evidence is invalid", { cause: error });
      }
    } else if (
      gate.gate === "outline"
      || gate.gate === "slide-specs"
      || gate.gate === "style-sample"
      || gate.gate === "generation-authorization"
      || gate.gate === "deck-review"
    ) {
      try {
        if (gate.revisionId !== valid.currentRevision.id) {
          throw new Error("ordinary gate revision must be current");
        }
        const evidence = await validateOrdinaryGateEvidence(owned.root, valid, gate);
        if (!sameJson(evidence.manifest, valid)) {
          throw new Error("ordinary gate snapshot manifest must exactly match the publication");
        }
        await validateCurrentPresentationBinding(owned.root, evidence.descriptor.presentation);
        for (const [path, expected] of Object.entries(gate.artifactHashes)) {
          if (sha256Evidence(await readOwnedRegularFile(owned.root, path)) !== expected) {
            throw new Error("ordinary gate artifact is not current");
          }
        }
      } catch (error: unknown) {
        throw new Error("ordinary gate evidence is invalid", { cause: error });
      }
    } else if (gate.gate === "style-sample-generation") {
      try {
        if (gate.revisionId !== valid.currentRevision.id) {
          throw new Error("execution authorization revision must be current");
        }
        const evidence = await validateExecutionGateEvidence(owned.root, valid, gate);
        if (!sameJson(evidence.manifest, valid)) {
          throw new Error("execution authorization snapshot manifest must exactly match the publication");
        }
        for (const [path, expected] of Object.entries(gate.artifactHashes)) {
          if (sha256Evidence(await readOwnedRegularFile(owned.root, path)) !== expected) {
            throw new Error("execution authorization artifact is not current");
          }
        }
      } catch (error: unknown) {
        throw new Error("execution authorization evidence is invalid", { cause: error });
      }
    } else if (gate.gate === "revision-impact") {
      try {
        await validateImpactGateEvidence(owned.root, owned.manifest, gate);
      } catch (error: unknown) {
        throw new Error("revision impact gate evidence is invalid", { cause: error });
      }
    }
  }
  const immutableSnapshotPaths = valid.gates
    .filter((gate) => (
      gate.gate === "outline"
      || gate.gate === "slide-specs"
      || gate.gate === "style-sample"
      || gate.gate === "style-sample-generation"
      || gate.gate === "generation-authorization"
      || gate.gate === "deck-review"
    ))
    .map((gate) => gate.snapshotPath)
    .filter((path): path is string => path !== undefined);
  if (new Set(immutableSnapshotPaths).size !== immutableSnapshotPaths.length) {
    throw new Error("immutable gate evidence snapshot paths must be unique");
  }

  const staging = join(owned.root, `.superppt.${randomUUID()}.staging.json`);
  const target = join(owned.root, MANIFEST);
  await writeDurableExclusive(
    staging,
    `${JSON.stringify(valid, null, 2)}\n`,
    () => operations.checkpoint?.("staged-written", staging),
  );
  await operations.checkpoint?.("staged-synced", staging);
  await (operations.promote ?? renameSafe)(staging, target);
  await operations.checkpoint?.("manifest-promoted", staging);
  await syncDirectory(owned.root);
  await operations.checkpoint?.("parent-synced", staging);
}

export async function writeProject(
  root: string,
  manifest: ReadProjectManifest,
  operations: WriteProjectOperations = {},
): Promise<void> {
  return withGenerationLease(root, async (trustedRoot) => writeProjectUnderTrustedLease(trustedRoot, manifest, operations));
}

async function writeProjectUnderTrustedLease(
  root: string,
  manifest: ReadProjectManifest,
  operations: WriteProjectOperations = {},
): Promise<void> {
  await assertProjectMutationNotFrozen(root);
  const valid = ProjectManifestSchema.parse(manifest);
  const expected = await ownedProject(root);
  await assertNoPendingRollbackTransaction(expected.root);
  const baseIdentity = (manifest as ProjectManifest & {
    [PROJECT_BASE_IDENTITY]?: unknown;
  })[PROJECT_BASE_IDENTITY];
  if (typeof baseIdentity !== "string") {
    throw new Error("writeProject requires a manifest returned by readProject");
  }
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    if (current.baseIdentity !== baseIdentity) {
      throw new Error("stale project manifest base; retry through updateProject");
    }
    await persistProject(current, valid, operations);
  });
}

export async function updateProject(
  root: string,
  updater: ProjectUpdater,
  operations: WriteProjectOperations = {},
): Promise<ProjectManifest> {
  return withGenerationLease(root, (trustedRoot) => updateProjectUnderTrustedLease(trustedRoot, updater, operations));
}

async function updateProjectUnderTrustedLease(
  root: string,
  updater: ProjectUpdater,
  operations: WriteProjectOperations = {},
  allowCompletedRevisionTransition = false,
): Promise<ProjectManifest> {
  await assertProjectMutationAllowed(root, allowCompletedRevisionTransition);
  let result: ProjectManifest | undefined;
  const owned = await ownedProject(root);
  await assertNoPendingRollbackTransaction(owned.root);
  await withProjectLease(owned.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    const proposed = await updater(structuredClone(current.manifest));
    const valid = ProjectManifestSchema.parse(proposed);
    await persistProject(current, valid, operations, "ordinary", allowCompletedRevisionTransition);
    result = valid;
  });
  return result!;
}

export async function appendApprovedImpactGate(
  root: string,
  rawPlan: ImpactPlan,
  approval: {
    approvalId: string;
    confirmedAt: string;
    snapshotPath: string;
  },
): Promise<ProjectManifest> {
  const plan = ImpactPlanSchema.parse(rawPlan);
  return withGenerationLease(root, (trustedRoot) => updateProjectUnderTrustedLease(
    trustedRoot,
    async (manifest) => {
      const pending = await readPendingImpactEvidence(trustedRoot);
      if (!sameJson(pending.plan, plan)) {
        throw new Error("pending impact evidence does not match approved revision transition");
      }
      if (
        plan.projectId !== manifest.projectId
        || plan.baseRevisionId !== manifest.currentRevision.id
        || plan.baseRevisionNumber !== manifest.currentRevision.number
        || plan.baseManifestSha256 !== manifestIdentity(manifest)
      ) throw new Error("impact plan has a stale base manifest identity");
      await assertCurrentRevisionPlanningEvidence(trustedRoot, manifest);
      await assertManifestArtifactReferences(trustedRoot, manifest);
      const latestGate = manifest.gates.at(-1);
      if (
        latestGate?.gate === "revision-impact"
        && latestGate.revisionId === manifest.currentRevision.id
      ) throw new Error("pending impact is already approved");
      return {
        ...manifest,
        gates: [...manifest.gates, {
          gate: "revision-impact" as const,
          revisionId: manifest.currentRevision.id,
          approvalId: approval.approvalId,
          artifactHashes: { [PENDING_IMPACT_PATH]: pending.fileSha256 },
          snapshotPath: approval.snapshotPath,
          snapshotManifestSha256: plan.baseManifestSha256,
          confirmedAt: approval.confirmedAt,
        }],
      };
    },
    {},
    true,
  ));
}

export async function updateProjectWithDelegatedGenerationAttachment(
  root: string,
  updater: (current: ProjectManifest) => ProjectManifest,
): Promise<void> {
  return withGenerationLease(root, (trustedRoot) =>
    updateProjectWithDelegatedGenerationAttachmentUnderTrustedLease(trustedRoot, updater));
}

async function updateProjectWithDelegatedGenerationAttachmentUnderTrustedLease(
  root: string,
  updater: (current: ProjectManifest) => ProjectManifest,
): Promise<void> {
  await assertProjectMutationNotFrozen(root);
  const before = await readProject(root);
  const planned = ProjectManifestSchema.parse(updater(before));
  await assertGenerationHistoryEvolution(root, before, planned);
  await withProjectLease(root, "generation-attachment", async (canonicalRoot) => {
    const owned = await ownedProject(canonicalRoot);
    if (!sameJson(owned.manifest, before)) throw new Error("project changed during delegated attachment authentication");
    const valid = ProjectManifestSchema.parse(updater(owned.manifest));
    if (!sameJson(valid, planned)) throw new Error("delegated attachment updater is not deterministic");
    await persistProject(owned, valid, {}, "delegated-generation-attach");
  });
}

export async function readProjectForRollbackRecovery(root: string): Promise<{
  root: string;
  manifest: ProjectManifest;
  manifestBytes: Buffer;
  baseIdentity: string;
}> {
  return ownedProject(root);
}

export async function readProjectForTrustedAuthorization(root: string): Promise<{
  root: string;
  manifest: ProjectManifest;
  manifestBytes: Buffer;
  baseIdentity: string;
}> {
  return ownedProject(root);
}

async function commitApprovedImpactRevisionLocked(
  root: string,
  rawPlan: ImpactPlan,
  rawChange: ChangeRequest,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<void> {
  const plan = ImpactPlanSchema.parse(rawPlan);
  const change = ChangeRequestSchema.parse(rawChange);
  if (!sameJson(plan.change, change)) {
    throw new Error("impact plan change does not match apply request");
  }
  let result: ProjectManifest | undefined;
  const expected = await ownedProject(root);
  await assertNoPendingRollbackTransaction(expected.root);
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    const pending = await readPendingImpactEvidence(canonicalRoot);
    if (!sameJson(pending.plan, plan)) {
      throw new Error("pending impact evidence does not match apply request");
    }
    const gate = current.manifest.gates.at(-1);
    if (!gate || gate.gate !== "revision-impact") {
      throw new Error("revision impact must be approved before apply");
    }
    const base = ProjectManifestSchema.parse({
      ...current.manifest,
      gates: current.manifest.gates.slice(0, -1),
    });
    if (
      plan.projectId !== base.projectId
      || plan.baseRevisionId !== base.currentRevision.id
      || plan.baseRevisionNumber !== base.currentRevision.number
      || plan.baseManifestSha256 !== manifestIdentity(base)
    ) throw new Error("impact plan has a stale base manifest identity");
    const approved = await validateImpactGateEvidence(canonicalRoot, base, gate);
    if (!sameJson(approved, plan)) {
      throw new Error("approved revision impact does not match the requested plan");
    }
    await assertCurrentRevisionPlanningEvidence(canonicalRoot, current.manifest);
    await assertManifestArtifactReferences(canonicalRoot, current.manifest);
    let snapshot: Awaited<ReturnType<typeof publishRevisionSnapshot>>;
    if (base.stage === "delivered" && base.clientSmokeCopyAnchor?.state === "completed") {
      const existing = await readRevisionSnapshot(
        canonicalRoot,
        base.currentRevision.id,
        evidenceOperations,
      );
      const reconstructedDelivered = ProjectManifestSchema.parse({
        ...existing.manifest,
        stage: "delivered",
        clientSmokeCopyAnchor: base.clientSmokeCopyAnchor,
        exports: {
          ...existing.manifest.exports,
          acceptance: base.exports.acceptance,
        },
      });
      if (!sameJson(reconstructedDelivered, base)) {
        throw new Error("completed client acceptance does not descend from its immutable ready snapshot");
      }
      snapshot = existing.descriptor;
    } else {
      snapshot = await publishRevisionSnapshot(
        canonicalRoot,
        current.manifest,
        evidenceOperations,
      );
    }
    const revision = {
      id: randomUUID(),
      number: current.manifest.currentRevision.number + 1,
      createdAt: new Date().toISOString(),
      parentId: current.manifest.currentRevision.id,
      parentSnapshotDescriptorSha256: snapshot.descriptorSha256,
    };
    const stale = new Set(plan.staleSlideIds);
    const valid = ProjectManifestSchema.parse({
      ...current.manifest,
      title: change.kind === "brief" && change.title ? change.title : current.manifest.title,
      stage: plan.restartStage,
      style: null,
      currentRevision: revision,
      revisions: [...current.manifest.revisions, revision],
      slides: current.manifest.slides.map((slide) => stale.has(slide.id) ? {
        ...slide,
        status: "stale" as const,
        image: null,
        editable: null,
        finalRender: null,
        staleReasons: [...new Set([...slide.staleReasons, change.kind])],
      } : slide),
      exports: plan.invalidateExports ? {
        pptx: null,
        acceptance: null,
      } : current.manifest.exports,
    });
    await persistProject(current, valid, {}, "revision-append");
    result = valid;
  });
  if (!result) throw new Error("approved impact revision was not committed");
}

export async function commitApprovedImpactRevision(
  root: string,
  rawPlan: ImpactPlan,
  rawChange: ChangeRequest,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<void> {
  await withGenerationLease(root, (trustedRoot) =>
    withProjectLease(trustedRoot, "revision-impact", async (canonicalRoot) => {
      await assertProjectRevisionTransitionNotFrozen(canonicalRoot);
      return (
      commitApprovedImpactRevisionLocked(
        canonicalRoot,
        rawPlan,
        rawChange,
        evidenceOperations,
      ));
    }));
}

export async function beginProjectRollbackTransaction(
  root: string,
  targetRevisionId: string,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<void> {
  return withGenerationLease(root, (trustedRoot) =>
    beginProjectRollbackTransactionUnderTrustedLease(trustedRoot, targetRevisionId, evidenceOperations));
}

async function beginProjectRollbackTransactionUnderTrustedLease(
  root: string,
  targetRevisionId: string,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<void> {
  await assertProjectMutationNotFrozen(root);
  const expected = await ownedProject(root);
  await assertNoPendingRollbackTransaction(expected.root);
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    if (targetRevisionId === current.manifest.currentRevision.id) {
      throw new Error("rollback target must be an earlier revision");
    }
    const targetIndex = current.manifest.revisions.findIndex((revision) => revision.id === targetRevisionId);
    if (targetIndex < 0) throw new Error("rollback target is not in the project revision ledger");
    let targetSnapshot: Awaited<ReturnType<typeof readRevisionSnapshot>>;
    try {
      targetSnapshot = await readRevisionSnapshot(canonicalRoot, targetRevisionId, evidenceOperations);
    } catch (error: unknown) {
      throw new Error(`rollback revision snapshot is missing, unsafe, or unauthentic: ${targetRevisionId}`, { cause: error });
    }
    const target = targetSnapshot.manifest;
    const targetPrefix = current.manifest.revisions.slice(0, targetIndex + 1);
    if (
      target.projectId !== current.manifest.projectId
      || target.currentRevision.id !== targetRevisionId
      || target.revisions.at(-1)?.id !== targetRevisionId
      || !sameJson(target.revisions, targetPrefix)
    ) throw new Error("rollback target snapshot is not a legal project revision prefix");
    const targetChild = current.manifest.revisions[targetIndex + 1];
    if (
      !targetChild
      || targetChild.parentId !== targetRevisionId
      || targetChild.parentSnapshotDescriptorSha256 !== targetSnapshot.descriptor.descriptorSha256
    ) throw new Error("rollback target snapshot descriptor anchor mismatch");
    const after = await authenticatedPlanningArtifacts(
      canonicalRoot,
      target,
      targetSnapshot.artifacts,
    );
    await assertManifestArtifactReferences(canonicalRoot, target, after);
    await assertCurrentRevisionPlanningEvidence(canonicalRoot, current.manifest);
    await assertManifestArtifactReferences(canonicalRoot, current.manifest);
    const currentSnapshot = await publishRevisionSnapshot(canonicalRoot, current.manifest, evidenceOperations);
    const rollbackRevisionBase = rollbackRevisionBaseForEvidence({
      projectId: current.manifest.projectId,
      baseRevision: current.manifest.currentRevision,
      targetRevisionId,
      baseSnapshotDescriptorSha256: currentSnapshot.descriptorSha256,
    });
    const before = await readProjectFileSet(canonicalRoot, [...after.keys()]);
    const published = await publishRollbackJournal({
      root: canonicalRoot,
      current: current.manifest,
      baseManifestSha256: current.baseIdentity,
      baseSnapshotDescriptorSha256: currentSnapshot.descriptorSha256,
      targetRevisionId,
      rollbackRevisionId: rollbackRevisionBase.id,
      rollbackManifest: (transactionAnchorSha256) => {
        const rollbackRevision = {
          ...rollbackRevisionBase,
          rollbackTransactionDescriptorSha256: transactionAnchorSha256,
        };
        return ProjectManifestSchema.parse({
          ...target,
          currentRevision: rollbackRevision,
          revisions: [...current.manifest.revisions, rollbackRevision],
          gates: current.manifest.gates,
        });
      },
      before,
      after,
      operations: evidenceOperations,
    });
    await evidenceOperations?.rollbackCheckpoint?.("journal-published");
    const valid = ProjectManifestSchema.parse({
      ...current.manifest,
      rollbackTransaction: {
        transactionId: published.journal.transactionId,
        baseRevisionId: published.journal.baseRevisionId,
        targetRevisionId: published.journal.targetRevisionId,
        rollbackRevisionId: published.journal.rollbackRevisionId,
        descriptorSha256: published.journal.transactionAnchorSha256,
      },
    });
    await persistProject(current, valid, {}, "rollback-begin");
  });
}

async function assertJournalFileSet(
  root: string,
  expected: ReadonlyMap<string, Buffer | null>,
): Promise<void> {
  const actual = await readProjectFileSet(root, [...expected.keys()]);
  for (const [path, bytes] of expected) {
    const value = actual.get(path) ?? null;
    if (bytes === null ? value !== null : !value?.equals(bytes)) {
      throw new Error(`rollback transaction file set is not current: ${path}`);
    }
  }
}

export async function finishProjectRollbackTransaction(
  root: string,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<ProjectManifest> {
  return withGenerationLease(root, (trustedRoot) =>
    finishProjectRollbackTransactionUnderTrustedLease(trustedRoot, evidenceOperations));
}

async function finishProjectRollbackTransactionUnderTrustedLease(
  root: string,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<ProjectManifest> {
  await assertProjectMutationNotFrozen(root);
  let result: ProjectManifest | undefined;
  const expected = await ownedProject(root);
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    const evidence = await readRollbackJournal(canonicalRoot, evidenceOperations);
    const marker = current.manifest.rollbackTransaction;
    if (!marker || !sameJson(marker, {
      transactionId: evidence.journal.transactionId,
      baseRevisionId: evidence.journal.baseRevisionId,
      targetRevisionId: evidence.journal.targetRevisionId,
      rollbackRevisionId: evidence.journal.rollbackRevisionId,
      descriptorSha256: evidence.journal.transactionAnchorSha256,
    })) throw new Error("rollback transaction descriptor anchor mismatch");
    await assertJournalFileSet(canonicalRoot, evidence.after);
    const valid = evidence.rollbackManifest;
    await persistProject(current, valid, {}, "rollback-finish");
    result = valid;
  });
  return result!;
}

export async function abortProjectRollbackTransaction(
  root: string,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<ProjectManifest> {
  return withGenerationLease(root, (trustedRoot) =>
    abortProjectRollbackTransactionUnderTrustedLease(trustedRoot, evidenceOperations));
}

async function abortProjectRollbackTransactionUnderTrustedLease(
  root: string,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<ProjectManifest> {
  await assertProjectMutationNotFrozen(root);
  let result: ProjectManifest | undefined;
  const expected = await ownedProject(root);
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    const evidence = await readRollbackJournal(canonicalRoot, evidenceOperations);
    const marker = current.manifest.rollbackTransaction;
    if (!marker || marker.descriptorSha256 !== evidence.journal.transactionAnchorSha256) {
      throw new Error("rollback transaction descriptor anchor mismatch");
    }
    await assertJournalFileSet(canonicalRoot, evidence.before);
    const { rollbackTransaction: _transaction, ...base } = current.manifest;
    const valid = ProjectManifestSchema.parse(base);
    if (sha256(Buffer.from(`${JSON.stringify(valid, null, 2)}\n`)) !== evidence.journal.baseManifestSha256) {
      throw new Error("rollback journal does not match the current manifest state");
    }
    await persistProject(current, valid, {}, "rollback-abort");
    result = valid;
  });
  return result!;
}
