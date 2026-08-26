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
import { readOwnedRegularFile } from "./safe-file.js";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "./schemas.js";
import { validateImpactGateEvidence } from "../revisions/impact.js";

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

async function hasExactRevisionSnapshot(
  root: string,
  manifest: ProjectManifest,
): Promise<boolean> {
  const snapshotPath = join(
    root,
    "revisions",
    manifest.currentRevision.id,
    MANIFEST,
  );
  try {
    await requireRegularDirectory(join(root, "revisions"));
    await requireRegularDirectory(
      join(root, "revisions", manifest.currentRevision.id),
    );
    await requireRegularFile(snapshotPath);
    const snapshot = ProjectManifestSchema.parse(
      JSON.parse(await readFile(snapshotPath, "utf8")),
    );
    return sameJson(snapshot, manifest);
  } catch {
    return false;
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

async function requireRegularDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("immutable history directory is unsafe");
  }
}

async function ownedProject(root: string): Promise<{
  root: string;
  manifest: ProjectManifest;
  baseIdentity: string;
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
    return { root: canonical, manifest, baseIdentity: sha256(manifestBytes) };
  } catch {
    throw new Error("project directory is not owned by SuperPPT");
  }
}

export async function readProject(root: string): Promise<ReadProjectManifest> {
  const owned = await ownedProject(root);
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
): Promise<void> {
  if (valid.projectId !== owned.manifest.projectId) {
    throw new Error("project directory is not owned by SuperPPT");
  }
  assertRevisionEvolution(owned.manifest, valid);
  if (
    !preservesArtifactEvidence(owned.manifest, valid)
    && !await hasExactRevisionSnapshot(owned.root, owned.manifest)
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
  const baseIdentity = (manifest as ProjectManifest & {
    [PROJECT_BASE_IDENTITY]?: unknown;
  })[PROJECT_BASE_IDENTITY];
  if (typeof baseIdentity !== "string") {
    throw new Error("writeProject requires a manifest returned by readProject");
  }
  await withProjectLease(expected.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
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
  await withProjectLease(owned.root, "state", async (canonicalRoot) => {
    const current = await ownedProject(canonicalRoot);
    const proposed = await updater(structuredClone(current.manifest));
    const valid = ProjectManifestSchema.parse(proposed);
    await persistProject(current, valid, operations);
    result = valid;
  });
  return result!;
}
