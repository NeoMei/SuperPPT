import { randomUUID } from "node:crypto";
import { z } from "zod";

import { sha256Evidence } from "../project/evidence.js";
import { ProjectManifestSchema, type ProjectManifest } from "../project/schemas.js";
import {
  type AnchoredDirectory,
  type RevisionEvidenceOperations,
  withAnchoredRevisions,
} from "./anchored-fs.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SnapshotBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("revision-manifest-snapshot"),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  snapshotPath: z.string().startsWith("revisions/"),
  manifestPath: z.string().startsWith("revisions/"),
  manifestSha256: HashSchema,
  manifestSize: z.number().int().nonnegative(),
}).strict();

export const RevisionSnapshotDescriptorSchema = SnapshotBaseSchema.extend({
  descriptorSha256: HashSchema,
}).strict();

export type RevisionSnapshotDescriptor = z.infer<typeof RevisionSnapshotDescriptorSchema>;

function descriptorFor(manifest: ProjectManifest, bytes: Buffer): RevisionSnapshotDescriptor {
  const revisionId = manifest.currentRevision.id;
  const snapshotPath = `revisions/${revisionId}/manifest-snapshot`;
  const base = SnapshotBaseSchema.parse({
    schemaVersion: 1,
    kind: "revision-manifest-snapshot",
    projectId: manifest.projectId,
    revisionId,
    snapshotPath,
    manifestPath: `${snapshotPath}/superppt.json`,
    manifestSha256: sha256Evidence(bytes),
    manifestSize: bytes.length,
  });
  return RevisionSnapshotDescriptorSchema.parse({
    ...base,
    descriptorSha256: sha256Evidence(JSON.stringify(base)),
  });
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readSnapshotDirectory(directory: AnchoredDirectory): {
  descriptor: RevisionSnapshotDescriptor;
  bytes: Buffer;
  manifest: ProjectManifest;
} {
  const expectedTree = ["snapshot.json", "superppt.json"];
  const beforeTree = directory.listRegularFiles();
  if (!sameList(beforeTree, expectedTree)) throw new Error("revision snapshot tree is not exact");
  const descriptorBytes = directory.read("snapshot.json");
  const manifestBytes = directory.read("superppt.json");
  if (!descriptorBytes || !manifestBytes) throw new Error("revision snapshot is incomplete");
  const descriptorAgain = directory.read("snapshot.json");
  const manifestAgain = directory.read("superppt.json");
  const afterTree = directory.listRegularFiles();
  if (
    !descriptorAgain
    || !manifestAgain
    || !sameBytes(descriptorBytes, descriptorAgain)
    || !sameBytes(manifestBytes, manifestAgain)
    || !sameList(afterTree, expectedTree)
  ) throw new Error("revision snapshot changed while authenticating");

  const descriptor = RevisionSnapshotDescriptorSchema.parse(
    JSON.parse(descriptorBytes.toString("utf8")),
  );
  const { descriptorSha256, ...base } = descriptor;
  if (descriptorSha256 !== sha256Evidence(JSON.stringify(base))) {
    throw new Error("revision snapshot descriptor integrity mismatch");
  }
  if (
    descriptor.manifestSha256 !== sha256Evidence(manifestBytes)
    || descriptor.manifestSize !== manifestBytes.length
  ) throw new Error("revision snapshot manifest hash mismatch");
  const manifest = ProjectManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  return { descriptor, bytes: manifestBytes, manifest };
}

export async function readRevisionSnapshot(
  root: string,
  revisionId: string,
  operations?: RevisionEvidenceOperations,
): Promise<{ descriptor: RevisionSnapshotDescriptor; bytes: Buffer; manifest: ProjectManifest }> {
  return withAnchoredRevisions(root, operations, (revisions) => {
    const revision = revisions.child(revisionId, false);
    try {
      const snapshot = revision.child("manifest-snapshot", false);
      try {
        const result = readSnapshotDirectory(snapshot);
        const expectedPath = `revisions/${revisionId}/manifest-snapshot`;
        if (
          result.descriptor.projectId !== result.manifest.projectId
          || result.descriptor.revisionId !== revisionId
          || result.manifest.currentRevision.id !== revisionId
          || result.manifest.revisions.at(-1)?.id !== revisionId
          || result.descriptor.snapshotPath !== expectedPath
          || result.descriptor.manifestPath !== `${expectedPath}/superppt.json`
        ) throw new Error("revision snapshot identity mismatch");
        return result;
      } finally {
        snapshot.close();
      }
    } finally {
      revision.close();
    }
  });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function publishRevisionSnapshot(
  root: string,
  rawManifest: ProjectManifest,
  operations?: RevisionEvidenceOperations,
): Promise<RevisionSnapshotDescriptor> {
  const manifest = ProjectManifestSchema.parse(rawManifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const descriptor = descriptorFor(manifest, bytes);
  try {
    const existing = await readRevisionSnapshot(root, manifest.currentRevision.id, operations);
    if (!existing.bytes.equals(bytes) || JSON.stringify(existing.descriptor) !== JSON.stringify(descriptor)) {
      throw new Error(`immutable revision snapshot differs: ${manifest.currentRevision.id}`);
    }
    return existing.descriptor;
  } catch (error: unknown) {
    if (!missing(error)) {
      if ((error as Error).message.startsWith("immutable revision snapshot differs")) throw error;
      try {
        await withAnchoredRevisions(root, operations, (revisions) => {
          const revision = revisions.child(manifest.currentRevision.id, false);
          try {
            const existing = revision.child("manifest-snapshot", false);
            existing.close();
          } finally {
            revision.close();
          }
        });
        throw new Error(`immutable revision snapshot differs: ${manifest.currentRevision.id}`, { cause: error });
      } catch (probe: unknown) {
        if (!missing(probe)) throw probe;
      }
    }
  }

  await withAnchoredRevisions(root, operations, async (revisions) => {
    const revision = revisions.child(manifest.currentRevision.id);
    try {
      const stagingName = `.manifest-snapshot-${randomUUID()}.staging`;
      const staging = revision.child(stagingName);
      try {
        staging.writeExclusive("superppt.json", bytes);
        await operations?.revisionSnapshotCheckpoint?.("manifest-written");
        staging.writeExclusive("snapshot.json", `${JSON.stringify(descriptor, null, 2)}\n`);
        await operations?.revisionSnapshotCheckpoint?.("descriptor-written");
        if (!sameList(staging.listRegularFiles(), ["snapshot.json", "superppt.json"])) {
          throw new Error("revision snapshot staging tree is not exact");
        }
      } finally {
        staging.close();
      }
      revision.promoteChildExclusive(stagingName, "manifest-snapshot");
      await operations?.revisionSnapshotCheckpoint?.("published");
    } finally {
      revision.close();
    }
  });
  return descriptor;
}

export async function hasExactRevisionSnapshot(
  root: string,
  manifest: ProjectManifest,
): Promise<boolean> {
  try {
    const snapshot = await readRevisionSnapshot(root, manifest.currentRevision.id);
    return snapshot.bytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  } catch {
    return false;
  }
}
