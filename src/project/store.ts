import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { syncDirectory, writeDurableExclusive } from "./durable.js";
import { validateProjectRoot } from "./paths.js";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "./schemas.js";

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
    const manifest = ProjectManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    if (marker.projectId !== manifest.projectId) {
      throw new Error("marker project mismatch");
    }
    return { root: canonical, manifest };
  } catch {
    throw new Error("project directory is not owned by SuperPPT");
  }
}

export async function readProject(root: string): Promise<ProjectManifest> {
  return (await ownedProject(root)).manifest;
}

export async function writeProject(
  root: string,
  manifest: ProjectManifest,
  operations: WriteProjectOperations = {},
): Promise<void> {
  const valid = ProjectManifestSchema.parse(manifest);
  const owned = await ownedProject(root);
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
