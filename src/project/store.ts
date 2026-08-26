import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { syncDirectory, writeDurableExclusive } from "./durable.js";
import {
  sha256Evidence,
  validateCurrentPresentationBinding,
  validateOrdinaryGateEvidence,
} from "./evidence.js";
import { withProjectLease } from "./lock.js";
import { validateProjectRoot } from "./paths.js";
import { assertNoPendingRollbackTransaction } from "./rollback-guard.js";
import { readOwnedRegularFile } from "./safe-file.js";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "./schemas.js";
import { validateImpactGateEvidence } from "../revisions/impact.js";
import { hasExactRevisionSnapshot, readRevisionSnapshot } from "../revisions/snapshot.js";

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

  if (
    next.gates.length < previous.gates.length
    || previous.gates.some((gate, index) => !sameJson(gate, next.gates[index]))
  ) {
    throw new Error("gate history must remain an exact prefix");
  }
}

type ProjectPersistMode = "ordinary" | "revision-append" | "rollback-begin" | "rollback-abort" | "rollback-finish";

async function assertControlledRevisionTrust(
  root: string,
  previous: ProjectManifest,
  next: ProjectManifest,
  mode: ProjectPersistMode,
): Promise<void> {
  const appended = next.revisions.slice(previous.revisions.length);
  const markerChanged = !sameJson(previous.rollbackTransaction, next.rollbackTransaction);
  if (mode === "ordinary") {
    if (appended.length > 0 || markerChanged) {
      throw new Error("revision and rollback trust fields require a controlled store transition");
    }
    return;
  }
  if (mode === "revision-append") {
    if (appended.length === 0 || markerChanged) {
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
    if (gate.gate === "outline" || gate.gate === "slide-specs" || gate.gate === "style-sample") {
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
    } else if (gate.gate === "revision-impact") {
      try {
        await validateImpactGateEvidence(owned.root, owned.manifest, gate);
      } catch (error: unknown) {
        throw new Error("revision impact gate evidence is invalid", { cause: error });
      }
    }
  }
  const ordinarySnapshotPaths = valid.gates
    .filter((gate) => gate.gate === "outline" || gate.gate === "slide-specs" || gate.gate === "style-sample")
    .map((gate) => gate.snapshotPath)
    .filter((path): path is string => path !== undefined);
  if (new Set(ordinarySnapshotPaths).size !== ordinarySnapshotPaths.length) {
    throw new Error("ordinary gate evidence snapshot paths must be unique");
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

export async function readProjectForRollbackRecovery(root: string): Promise<{
  root: string;
  manifest: ProjectManifest;
  manifestBytes: Buffer;
  baseIdentity: string;
}> {
  return ownedProject(root);
}

export async function updateProjectWithRevisionAppend(
  root: string,
  updater: ProjectUpdater,
  operations: WriteProjectOperations = {},
): Promise<ProjectManifest> {
  let result: ProjectManifest | undefined;
  const expected = await ownedProject(root);
  await assertNoPendingRollbackTransaction(expected.root);
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    const valid = ProjectManifestSchema.parse(await updater(structuredClone(current.manifest)));
    await persistProject(current, valid, operations, "revision-append");
    result = valid;
  });
  return result!;
}

export async function beginProjectRollbackTransaction(
  root: string,
  updater: (
    manifest: ProjectManifest,
    baseIdentity: string,
  ) => ProjectManifest | Promise<ProjectManifest>,
  operations: WriteProjectOperations = {},
): Promise<ProjectManifest> {
  let result: ProjectManifest | undefined;
  const expected = await ownedProject(root);
  await assertNoPendingRollbackTransaction(expected.root);
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    await assertNoPendingRollbackTransaction(current.root);
    const proposed = await updater(structuredClone(current.manifest), current.baseIdentity);
    const valid = ProjectManifestSchema.parse(proposed);
    await persistProject(current, valid, operations, "rollback-begin");
    result = valid;
  });
  return result!;
}

export async function finishProjectRollbackTransaction(
  root: string,
  updater: ProjectUpdater,
  operations: WriteProjectOperations = {},
): Promise<ProjectManifest> {
  let result: ProjectManifest | undefined;
  const expected = await ownedProject(root);
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    const valid = ProjectManifestSchema.parse(await updater(structuredClone(current.manifest)));
    await persistProject(current, valid, operations, "rollback-finish");
    result = valid;
  });
  return result!;
}

export async function abortProjectRollbackTransaction(
  root: string,
  updater: ProjectUpdater,
  operations: WriteProjectOperations = {},
): Promise<ProjectManifest> {
  let result: ProjectManifest | undefined;
  const expected = await ownedProject(root);
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    const valid = ProjectManifestSchema.parse(await updater(structuredClone(current.manifest)));
    await persistProject(current, valid, operations, "rollback-abort");
    result = valid;
  });
  return result!;
}
