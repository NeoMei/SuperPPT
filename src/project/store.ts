import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { validateAcceptanceManifestBinding } from "../acceptance/current.js";
import {
  AcceptanceSchema,
  ClientAcceptanceInputSchema,
  ClientAcceptanceSchema,
  type Acceptance,
} from "../acceptance/schema.js";
import { assertCompleteEditablePreview } from "../editable/preview-image.js";
import { syncDirectory, writeDurableExclusive } from "./durable.js";
import { promoteExclusive } from "./exclusive.js";
import {
  sha256Evidence,
  validateCurrentPresentationBinding,
  validateExecutionGateEvidence,
  validateOrdinaryGateEvidence,
} from "./evidence.js";
import { withProjectLease } from "./lock.js";
import { validateProjectRoot } from "./paths.js";
import { assertNoPendingRollbackTransaction } from "./rollback-guard.js";
import {
  readAnchoredRegularFile,
  readOwnedRegularFile,
  readRegularFileNoFollow,
  type SafeReadOperations,
} from "./safe-file.js";
import {
  ProjectManifestSchema,
  type Artifact,
  type ClientSmokeCopyAnchor,
  type ProjectManifest,
} from "./schemas.js";
import {
  ChangeRequestSchema,
  ImpactPlanSchema,
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
  if (mode === "ordinary" || mode === "delegated-generation-attach") {
    if (appended.length > 0 || markerChanged || smokeAnchorChanged) {
      throw new Error("revision, rollback, and client smoke copy trust fields require a controlled store transition");
    }
    return;
  }
  if (mode === "smoke-copy-create" || mode === "smoke-copy-ready" || mode === "smoke-copy-complete") {
    if (appended.length > 0 || markerChanged || !smokeAnchorChanged) {
      throw new Error("client smoke copy trust transition is invalid");
    }
    return;
  }
  if (mode === "revision-append") {
    if (appended.length === 0 || markerChanged || smokeAnchorChanged) {
      throw new Error("controlled revision append has an invalid rollback marker transition");
    }
  } else if (mode === "rollback-begin") {
    const marker = next.rollbackTransaction;
    if (
      appended.length !== 0
      || previous.rollbackTransaction
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
    ) throw new Error("rollback abort marker transition is invalid");
    return;
  } else {
    const marker = previous.rollbackTransaction;
    const revision = appended[0];
    if (
      appended.length !== 1
      || !marker
      || next.rollbackTransaction
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

async function validateSlidePreviewGateEvidence(
  root: string,
  manifest: ProjectManifest,
  gate: ProjectManifest["gates"][number],
): Promise<void> {
  const binding = gate.slidePreview;
  if (gate.gate !== "slide-preview" || !binding) throw new Error("slide preview binding is missing");
  const slide = manifest.slides.find((candidate) => candidate.id === binding.slideId);
  const appliedBinding = slide?.status === "editable" && slide.editableRevision
    && sameJson(binding, slide.editableRevision)
    ? slide.editableRevision.sourceFinalRender
    : null;
  let source = appliedBinding ?? slide?.finalRender ?? null;
  if (!source && slide?.status === "ready" && slide.image) {
    const selected = await (await import("./promotion.js")).authenticateCurrentDeckEditSelection(root, slide.id);
    if (sameJson(selected.sourceMaster, binding.sourceFinalRender)) source = selected.sourceMaster;
  }
  if (
    !source
    || binding.projectId !== manifest.projectId
    || binding.projectRevisionId !== manifest.currentRevision.id
    || gate.revisionId !== manifest.currentRevision.id
    || !sameJson(binding.sourceFinalRender, source)
  ) throw new Error("slide preview binding is stale");
  for (const [path, expected] of Object.entries(gate.artifactHashes)) {
    const bytes = await readOwnedRegularFile(root, path);
    if (path === binding.preview.path) await assertCompleteEditablePreview(bytes);
    if (sha256Evidence(bytes) !== expected) {
      throw new Error("slide preview gate artifact hash mismatch");
    }
  }
  if (sha256Evidence(await readOwnedRegularFile(root, binding.modifiedManifest.path)) !== binding.modifiedManifest.sha256) {
    throw new Error("slide preview modified manifest hash mismatch");
  }
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
): Promise<void> {
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
    : owned.manifest;
  if (
    !preservesArtifactEvidence(owned.manifest, valid)
    && !await hasExactRevisionSnapshot(owned.root, snapshotBase)
  ) {
    throw new Error(
      "immutable artifact evidence requires an exact revision snapshot",
    );
  }

  for (const gate of valid.gates.slice(owned.manifest.gates.length)) {
    if (
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
    } else if (gate.gate === "slide-preview") {
      try {
        await validateSlidePreviewGateEvidence(owned.root, valid, gate);
      } catch (error: unknown) {
        throw new Error("slide preview gate evidence is invalid", { cause: error });
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
  await (operations.promote ?? rename)(staging, target);
  await operations.checkpoint?.("manifest-promoted", staging);
  await syncDirectory(owned.root);
  await operations.checkpoint?.("parent-synced", staging);
}

export async function writeProject(
  root: string,
  manifest: ReadProjectManifest,
  operations: WriteProjectOperations = {},
): Promise<void> {
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
  let result: ProjectManifest | undefined;
  const owned = await ownedProject(root);
  await assertNoPendingRollbackTransaction(owned.root);
  await withProjectLease(owned.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    const proposed = await updater(structuredClone(current.manifest));
    const valid = ProjectManifestSchema.parse(proposed);
    await persistProject(current, valid, operations);
    result = valid;
  });
  return result!;
}

export async function updateProjectWithDelegatedGenerationAttachment(
  root: string,
  updater: (current: ProjectManifest) => ProjectManifest,
): Promise<void> {
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

function currentDeckRevision(manifest: ProjectManifest): number {
  return manifest.deckRevision ?? manifest.currentRevision.number;
}

function fixedSmokeCopyPaths(manifest: ProjectManifest): { descriptor: string; copy: string } {
  const base = `output/revisions/${currentDeckRevision(manifest)}/client-smoke`;
  return { descriptor: `${base}/descriptor.json`, copy: `${base}/deck-smoke.pptx` };
}

function anchorTargetsCurrentDeck(manifest: ProjectManifest, anchor: ClientSmokeCopyAnchor): boolean {
  const canonical = manifest.exports.pptx;
  const fixed = fixedSmokeCopyPaths(manifest);
  return Boolean(
    canonical
    && anchor.projectId === manifest.projectId
    && anchor.revisionId === manifest.currentRevision.id
    && anchor.deckRevision === currentDeckRevision(manifest)
    && sameJson(anchor.source, canonical)
    && anchor.descriptor.path === fixed.descriptor
    && anchor.descriptor.revisionId === manifest.currentRevision.id
    && anchor.initialCopy.path === fixed.copy
    && anchor.initialCopy.sha256 === canonical.sha256
    && anchor.initialCopy.revisionId === manifest.currentRevision.id
  );
}

function smokeDescriptor(anchor: ClientSmokeCopyAnchor): Record<string, unknown> {
  return {
    descriptorVersion: 1,
    appId: "superppt",
    artifactKind: "client-smoke-copy",
    anchorId: anchor.anchorId,
    projectId: anchor.projectId,
    revisionId: anchor.revisionId,
    revisionNumber: anchor.deckRevision,
    source: { path: anchor.source.path, sha256: anchor.source.sha256 },
    copy: { path: anchor.initialCopy.path, initialSha256: anchor.initialCopy.sha256 },
    createdAt: anchor.createdAt,
  };
}

function smokeDescriptorBytes(anchor: ClientSmokeCopyAnchor): Buffer {
  return Buffer.from(`${JSON.stringify(smokeDescriptor(anchor), null, 2)}\n`);
}

async function validateInitialSmokeCopyFiles(
  root: string,
  manifest: ProjectManifest,
  anchor: ClientSmokeCopyAnchor,
): Promise<void> {
  if (!anchorTargetsCurrentDeck(manifest, anchor)) throw new Error("trusted client smoke copy anchor is stale");
  const canonical = manifest.exports.pptx!;
  const paths = fixedSmokeCopyPaths(manifest);
  const directory = join(root, ...paths.descriptor.split("/").slice(0, -1));
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || await realpath(directory) !== directory) {
    throw new Error("client smoke copy directory is unsafe");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    sameJson(entries.map(({ name }) => name).sort(), ["deck-smoke.pptx", "descriptor.json"])
    === false
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) throw new Error("client smoke copy directory must contain only regular controlled artifacts");
  const canonicalBytes = await readOwnedRegularFile(root, canonical.path);
  if (sha256(canonicalBytes) !== canonical.sha256) throw new Error("canonical PPTX evidence is not current");
  const descriptorBytes = await readOwnedRegularFile(root, paths.descriptor);
  if (
    sha256(descriptorBytes) !== anchor.descriptor.sha256
    || !sameJson(JSON.parse(descriptorBytes.toString("utf8")), smokeDescriptor(anchor))
  ) throw new Error("client smoke copy descriptor does not match its trusted anchor");
  const copyBytes = await readOwnedRegularFile(root, paths.copy);
  if (sha256(copyBytes) !== anchor.initialCopy.sha256) {
    throw new Error("new client smoke copy does not match the canonical PPTX");
  }
}

async function beginClientSmokeCopyAnchor(
  root: string,
  rawAnchor: ClientSmokeCopyAnchor,
): Promise<ClientSmokeCopyAnchor> {
  let result: ClientSmokeCopyAnchor | undefined;
  const owned = await ownedProject(root);
  await assertNoPendingRollbackTransaction(owned.root);
  await withProjectLease(owned.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    const anchor = ProjectManifestSchema.shape.clientSmokeCopyAnchor.unwrap().parse(rawAnchor);
    const prior = current.manifest.clientSmokeCopyAnchor;
    if (prior && anchorTargetsCurrentDeck(current.manifest, prior)) {
      if (!sameJson(prior, anchor)) throw new Error("current client smoke copy anchor is immutable");
      result = prior;
      return;
    }
    if (
      !current.manifest.exports.acceptance
      || anchor.state !== "pending"
      || anchor.savedCopySha256 !== null
      || anchor.acceptanceRecord !== null
      || anchor.completedAt !== null
      || !anchorTargetsCurrentDeck(current.manifest, anchor)
    ) throw new Error("new client smoke copy anchor does not match the current canonical deck");
    const valid = ProjectManifestSchema.parse({ ...current.manifest, clientSmokeCopyAnchor: anchor });
    await persistProject(current, valid, {}, "smoke-copy-create");
    result = anchor;
  });
  return result!;
}

async function markClientSmokeCopyAnchorReady(
  root: string,
  anchorId: string,
): Promise<ClientSmokeCopyAnchor> {
  let result: ClientSmokeCopyAnchor | undefined;
  const owned = await ownedProject(root);
  await assertNoPendingRollbackTransaction(owned.root);
  await withProjectLease(owned.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    const anchor = current.manifest.clientSmokeCopyAnchor;
    if (!anchor || anchor.anchorId !== anchorId || !anchorTargetsCurrentDeck(current.manifest, anchor)) {
      throw new Error("trusted client smoke copy anchor is missing or stale");
    }
    if (anchor.state === "ready") {
      result = anchor;
      return;
    }
    if (anchor.state !== "pending") throw new Error("completed client smoke copy anchor cannot become ready again");
    await validateInitialSmokeCopyFiles(canonicalRoot, current.manifest, anchor);
    const ready: ClientSmokeCopyAnchor = { ...anchor, state: "ready" };
    const valid = ProjectManifestSchema.parse({ ...current.manifest, clientSmokeCopyAnchor: ready });
    await persistProject(current, valid, {}, "smoke-copy-ready");
    result = ready;
  });
  return result!;
}

export type CreateClientSmokeCopyAnchorOperations = {
  checkpoint?: (step: "before-anchor-commit" | "anchor-committed" | "files-promoted" | "anchor-ready") => Promise<void> | void;
  materialize: (anchor: ClientSmokeCopyAnchor) => Promise<void>;
};

export async function createClientSmokeCopyAnchor(
  root: string,
  operations: CreateClientSmokeCopyAnchorOperations,
): Promise<ClientSmokeCopyAnchor> {
  const manifest = await readProject(root);
  const canonical = manifest.exports.pptx;
  if (!canonical || !manifest.exports.acceptance) {
    throw new Error("current assembled canonical PPTX is required before creating a smoke copy");
  }
  let anchor = manifest.clientSmokeCopyAnchor;
  if (!anchor || !anchorTargetsCurrentDeck(manifest, anchor)) {
    const fixed = fixedSmokeCopyPaths(manifest);
    const base: ClientSmokeCopyAnchor = {
      anchorVersion: 1,
      anchorId: randomUUID(),
      projectId: manifest.projectId,
      revisionId: manifest.currentRevision.id,
      deckRevision: currentDeckRevision(manifest),
      source: canonical,
      descriptor: { path: fixed.descriptor, sha256: "0".repeat(64), revisionId: manifest.currentRevision.id },
      initialCopy: { path: fixed.copy, sha256: canonical.sha256, revisionId: manifest.currentRevision.id },
      createdAt: new Date().toISOString(),
      state: "pending",
      savedCopySha256: null,
      acceptanceRecord: null,
      completedAt: null,
    };
    anchor = { ...base, descriptor: { ...base.descriptor, sha256: sha256(smokeDescriptorBytes(base)) } };
    await operations.checkpoint?.("before-anchor-commit");
    anchor = await beginClientSmokeCopyAnchor(root, anchor);
    await operations.checkpoint?.("anchor-committed");
  }
  if (anchor.state === "completed") return anchor;
  if (anchor.state === "pending") {
    await operations.materialize(anchor);
    await operations.checkpoint?.("files-promoted");
  }
  anchor = await markClientSmokeCopyAnchorReady(root, anchor.anchorId);
  await operations.checkpoint?.("anchor-ready");
  return anchor;
}

async function completeClientSmokeCopyAcceptance(options: {
  root: string;
  expectedManifest: ProjectManifest;
  anchorId: string;
  savedCopySha256: string;
  acceptanceRecord: Artifact;
  completedAt: string;
}): Promise<ProjectManifest> {
  let result: ProjectManifest | undefined;
  const owned = await ownedProject(options.root);
  await assertNoPendingRollbackTransaction(owned.root);
  await withProjectLease(owned.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    if (!sameJson(current.manifest, options.expectedManifest)) {
      throw new Error("project changed while completing client smoke copy acceptance");
    }
    const anchor = current.manifest.clientSmokeCopyAnchor;
    if (!anchor || anchor.anchorId !== options.anchorId || !anchorTargetsCurrentDeck(current.manifest, anchor)) {
      throw new Error("trusted client smoke copy anchor is missing or stale");
    }
    if (
      anchor.state !== "ready"
      || options.savedCopySha256 === anchor.initialCopy.sha256
      || options.acceptanceRecord.revisionId !== current.manifest.currentRevision.id
      || options.acceptanceRecord.path !== `output/revisions/${currentDeckRevision(current.manifest)}/acceptance-record.json`
    ) throw new Error("client smoke copy completion does not match its trusted anchor");
    const canonicalBytes = await readOwnedRegularFile(canonicalRoot, anchor.source.path);
    if (sha256(canonicalBytes) !== anchor.source.sha256) throw new Error("canonical PPTX changed during client acceptance");
    const descriptorBytes = await readOwnedRegularFile(canonicalRoot, anchor.descriptor.path);
    if (
      sha256(descriptorBytes) !== anchor.descriptor.sha256
      || !sameJson(JSON.parse(descriptorBytes.toString("utf8")), smokeDescriptor(anchor))
    ) throw new Error("client smoke copy descriptor does not match its trusted anchor");
    const savedCopyBytes = await readOwnedRegularFile(canonicalRoot, anchor.initialCopy.path);
    if (sha256(savedCopyBytes) !== options.savedCopySha256) throw new Error("saved client smoke copy hash does not match the observed file");
    const acceptanceBytes = await readOwnedRegularFile(canonicalRoot, options.acceptanceRecord.path);
    if (sha256(acceptanceBytes) !== options.acceptanceRecord.sha256) throw new Error("acceptance record hash does not match the observed file");
    const completed: ClientSmokeCopyAnchor = {
      ...anchor,
      state: "completed",
      savedCopySha256: options.savedCopySha256,
      acceptanceRecord: options.acceptanceRecord,
      completedAt: options.completedAt,
    };
    const valid = ProjectManifestSchema.parse({
      ...current.manifest,
      stage: "delivered",
      clientSmokeCopyAnchor: completed,
      exports: { ...current.manifest.exports, acceptance: options.acceptanceRecord },
    });
    await persistProject(current, valid, {}, "smoke-copy-complete");
    result = valid;
  });
  return result!;
}

async function validateCurrentSmokeCopyFiles(
  root: string,
  manifest: ProjectManifest,
  anchor: ClientSmokeCopyAnchor,
): Promise<{ descriptorSha256: string; copySha256: string }> {
  if (!anchorTargetsCurrentDeck(manifest, anchor) || anchor.state === "pending") {
    throw new Error("trusted client smoke copy anchor is stale");
  }
  const canonicalBytes = await readOwnedRegularFile(root, anchor.source.path);
  if (sha256(canonicalBytes) !== anchor.source.sha256) throw new Error("canonical PPTX changed during client acceptance");
  const descriptorBytes = await readOwnedRegularFile(root, anchor.descriptor.path);
  const descriptorSha256 = sha256(descriptorBytes);
  if (descriptorSha256 !== anchor.descriptor.sha256) throw new Error("client smoke copy descriptor hash mismatch");
  if (!sameJson(JSON.parse(descriptorBytes.toString("utf8")), smokeDescriptor(anchor))) {
    throw new Error("client smoke copy descriptor does not match its trusted anchor");
  }
  const copySha256 = sha256(await readOwnedRegularFile(root, anchor.initialCopy.path));
  return { descriptorSha256, copySha256 };
}

function acceptancePath(manifest: ProjectManifest, delivered: boolean): string {
  const base = `output/revisions/${currentDeckRevision(manifest)}`;
  return delivered ? `${base}/acceptance-record.json` : `${base}/acceptance.json`;
}

async function readBoundAcceptance(root: string, manifest: ProjectManifest): Promise<Acceptance> {
  const artifact = manifest.exports.acceptance;
  if (
    !artifact
    || artifact.revisionId !== manifest.currentRevision.id
    || artifact.path !== acceptancePath(manifest, manifest.stage === "delivered")
  ) throw new Error("acceptance evidence is not current");
  const bytes = await readOwnedRegularFile(root, artifact.path);
  if (sha256(bytes) !== artifact.sha256) throw new Error("acceptance evidence is not current");
  const acceptance = AcceptanceSchema.parse(JSON.parse(bytes.toString("utf8")));
  await validateAcceptanceManifestBinding(root, manifest, acceptance);
  if (manifest.stage === "delivered") {
    const anchor = manifest.clientSmokeCopyAnchor;
    const smoke = acceptance.clientAcceptance.smokeCopy;
    if (
      !anchor
      || anchor.state !== "completed"
      || !smoke
      || anchor.savedCopySha256 !== smoke.savedSha256
      || !sameJson(anchor.acceptanceRecord, artifact)
    ) throw new Error("client smoke copy completion anchor is not current");
    const current = await validateCurrentSmokeCopyFiles(root, manifest, anchor);
    if (
      smoke.descriptorPath !== anchor.descriptor.path
      || smoke.descriptorSha256 !== current.descriptorSha256
      || smoke.path !== anchor.initialCopy.path
      || smoke.initialSha256 !== anchor.initialCopy.sha256
      || smoke.savedSha256 !== current.copySha256
      || smoke.savedSha256 === smoke.initialSha256
    ) throw new Error("client smoke copy evidence is not current");
  }
  return acceptance;
}

export type AcceptanceRecordCheckpoint = "record-promoted" | "manifest-updated";
export type AcceptanceRecordOperations = {
  checkpoint?: (step: AcceptanceRecordCheckpoint) => Promise<void> | void;
  inputRead?: SafeReadOperations;
};

export async function recordClientAcceptance(
  root: string,
  input: string,
  operations: AcceptanceRecordOperations = {},
): Promise<Acceptance> {
  let inputBytes: Buffer;
  try {
    inputBytes = await readAnchoredRegularFile(input, {
      label: "client acceptance input",
      maxBytes: 1024 * 1024,
      privateInput: true,
      operations: operations.inputRead,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("must be private")) throw error;
    throw new Error("client acceptance input must be a regular 0600 file", { cause: error });
  }
  let submitted;
  try {
    submitted = ClientAcceptanceInputSchema.parse(JSON.parse(inputBytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("client acceptance input is invalid", { cause: error });
  }
  if (
    !submitted.opened
    || !submitted.edited
    || !submitted.saved
    || !submitted.closed
    || !submitted.reopened
    || submitted.result !== "passed"
  ) throw new Error("all six client acceptance checks must be explicitly complete");

  return withProjectLease(root, "acceptance", async (canonicalRoot) => {
    const manifest = await readProject(canonicalRoot);
    const current = await readBoundAcceptance(canonicalRoot, manifest);
    if (current.deliveryComplete) {
      const recorded = current.clientAcceptance;
      if (
        recorded.application !== submitted.application
        || recorded.smokeCopy?.descriptorPath !== submitted.smokeCopyDescriptorPath
        || recorded.smokeCopy?.savedSha256 !== submitted.savedCopySha256
        || recorded.opened !== submitted.opened
        || recorded.edited !== submitted.edited
        || recorded.saved !== submitted.saved
        || recorded.closed !== submitted.closed
        || recorded.reopened !== submitted.reopened
        || recorded.result !== submitted.result
        || recorded.observedResult !== submitted.observedResult
        || recorded.confirmedAt !== submitted.confirmedAt
      ) throw new Error("immutable client acceptance replay does not match the recorded evidence");
      return current;
    }
    const anchor = manifest.clientSmokeCopyAnchor;
    if (!anchor || anchor.state !== "ready" || submitted.smokeCopyDescriptorPath !== anchor.descriptor.path) {
      throw new Error("trusted client smoke copy anchor is missing or stale");
    }
    const smoke = await validateCurrentSmokeCopyFiles(canonicalRoot, manifest, anchor);
    if (smoke.copySha256 !== submitted.savedCopySha256) {
      throw new Error("saved client smoke copy hash does not match the observed file");
    }
    if (smoke.copySha256 === anchor.initialCopy.sha256) throw new Error("smoke copy must change after the client edit");
    const client = ClientAcceptanceSchema.parse({
      application: submitted.application,
      smokeCopy: {
        descriptorPath: anchor.descriptor.path,
        descriptorSha256: smoke.descriptorSha256,
        path: anchor.initialCopy.path,
        initialSha256: anchor.initialCopy.sha256,
        savedSha256: smoke.copySha256,
      },
      opened: submitted.opened,
      edited: submitted.edited,
      saved: submitted.saved,
      closed: submitted.closed,
      reopened: submitted.reopened,
      result: submitted.result,
      observedResult: submitted.observedResult,
      confirmedAt: submitted.confirmedAt,
    });
    const completed = AcceptanceSchema.parse({ ...current, deliveryComplete: true, clientAcceptance: client });
    await publishRevisionSnapshot(canonicalRoot, manifest);
    const bytes = Buffer.from(`${JSON.stringify(completed, null, 2)}\n`);
    const recordRef = acceptancePath(manifest, true);
    const recordPath = join(canonicalRoot, ...recordRef.split("/"));
    const nextAcceptance: Artifact = {
      path: recordRef,
      sha256: sha256(bytes),
      revisionId: manifest.currentRevision.id,
    };
    try {
      await lstat(recordPath);
      const existing = await readRegularFileNoFollow(recordPath);
      if (!existing.equals(bytes)) throw new Error("immutable acceptance record does not match current client evidence");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const directory = join(canonicalRoot, "output", "revisions", String(currentDeckRevision(manifest)));
      const staging = join(directory, `.acceptance-record-${randomUUID()}.staging.json`);
      await writeDurableExclusive(staging, bytes);
      await promoteExclusive(staging, recordPath);
      await syncDirectory(directory);
    }
    await operations.checkpoint?.("record-promoted");
    await completeClientSmokeCopyAcceptance({
      root: canonicalRoot,
      expectedManifest: manifest,
      anchorId: anchor.anchorId,
      savedCopySha256: smoke.copySha256,
      acceptanceRecord: nextAcceptance,
      completedAt: submitted.confirmedAt,
    });
    await operations.checkpoint?.("manifest-updated");
    const delivered = await readBoundAcceptance(canonicalRoot, await readProject(canonicalRoot));
    if (!sameJson(delivered, completed)) throw new Error("acceptance evidence is not current");
    return delivered;
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
    const snapshot = await publishRevisionSnapshot(
      canonicalRoot,
      current.manifest,
      evidenceOperations,
    );
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
        pdf: null,
        montage: null,
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
  await withProjectLease(root, "revision-impact", (canonicalRoot) =>
    commitApprovedImpactRevisionLocked(
      canonicalRoot,
      rawPlan,
      rawChange,
      evidenceOperations,
    ));
}

export async function beginProjectRollbackTransaction(
  root: string,
  targetRevisionId: string,
  evidenceOperations?: RevisionEvidenceOperations,
): Promise<void> {
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
    const after = await authenticatedPlanningArtifacts(canonicalRoot, target);
    await assertManifestArtifactReferences(canonicalRoot, target, after);
    await assertCurrentRevisionPlanningEvidence(canonicalRoot, current.manifest);
    await assertManifestArtifactReferences(canonicalRoot, current.manifest);
    const currentSnapshot = await publishRevisionSnapshot(canonicalRoot, current.manifest, evidenceOperations);
    const rollbackRevisionBase = {
      id: randomUUID(),
      number: current.manifest.currentRevision.number + 1,
      createdAt: new Date().toISOString(),
      parentId: current.manifest.currentRevision.id,
      parentSnapshotDescriptorSha256: currentSnapshot.descriptorSha256,
    };
    const before = await readProjectFileSet(canonicalRoot, [...after.keys()]);
    const published = await publishRollbackJournal({
      root: canonicalRoot,
      current: current.manifest,
      baseManifestSha256: current.baseIdentity,
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
