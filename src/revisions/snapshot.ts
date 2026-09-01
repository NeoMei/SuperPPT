import { randomUUID } from "node:crypto";
import { z } from "zod";

import { sha256Evidence } from "../project/evidence.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { ProjectManifestSchema, type ProjectManifest } from "../project/schemas.js";
import {
  StyleLockSchema,
  StyleRecipeSchema,
  StyleSampleSelectionSchema,
} from "../styles/schemas.js";
import {
  type AnchoredDirectory,
  type RevisionEvidenceOperations,
  withAnchoredRevisions,
} from "./anchored-fs.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SnapshotV1BaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("revision-manifest-snapshot"),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  snapshotPath: z.string().startsWith("revisions/"),
  manifestPath: z.string().startsWith("revisions/"),
  manifestSha256: HashSchema,
  manifestSize: z.number().int().nonnegative(),
}).strict();

const SnapshotArtifactSchema = z.object({
  projectPath: z.enum(["style/selection.json", "style/lock.json", "style/recipe.json"]),
  snapshotFile: z.enum(["style-selection.json", "style-lock.json", "style-recipe.json"]),
  sha256: HashSchema,
  size: z.number().int().positive(),
}).strict();

const SnapshotV2BaseSchema = SnapshotV1BaseSchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(2),
  styleArtifacts: z.array(SnapshotArtifactSchema).max(3),
}).strict();

const RevisionSnapshotV1DescriptorSchema = SnapshotV1BaseSchema.extend({
  descriptorSha256: HashSchema,
}).strict();

const RevisionSnapshotV2DescriptorSchema = SnapshotV2BaseSchema.extend({
  descriptorSha256: HashSchema,
}).strict();

export const RevisionSnapshotDescriptorSchema = z.union([
  RevisionSnapshotV1DescriptorSchema,
  RevisionSnapshotV2DescriptorSchema,
]);

export type RevisionSnapshotDescriptor = z.infer<typeof RevisionSnapshotDescriptorSchema>;

const STYLE_ARTIFACTS = [
  { projectPath: "style/selection.json", snapshotFile: "style-selection.json" },
  { projectPath: "style/lock.json", snapshotFile: "style-lock.json" },
  { projectPath: "style/recipe.json", snapshotFile: "style-recipe.json" },
] as const;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function canonicalFile(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function validateStyleArtifacts(
  manifest: ProjectManifest,
  artifacts: ReadonlyMap<string, Buffer>,
): void {
  if (!manifest.style) {
    if (artifacts.size !== 0) throw new Error("revision snapshot has unexpected style artifacts");
    return;
  }
  if (
    manifest.style.path !== "style/selection.json"
    || !manifest.revisions.some(({ id }) => id === manifest.style!.revisionId)
    || artifacts.size !== STYLE_ARTIFACTS.length
  ) throw new Error("revision snapshot style artifact identity mismatch");
  const selectionBytes = artifacts.get("style/selection.json");
  const lockBytes = artifacts.get("style/lock.json");
  const recipeBytes = artifacts.get("style/recipe.json");
  if (!selectionBytes || !lockBytes || !recipeBytes) {
    throw new Error("revision snapshot style artifact chain is incomplete");
  }
  const selection = StyleSampleSelectionSchema.parse(JSON.parse(selectionBytes.toString("utf8")));
  const lock = StyleLockSchema.parse(JSON.parse(lockBytes.toString("utf8")));
  const recipe = StyleRecipeSchema.parse(JSON.parse(recipeBytes.toString("utf8")));
  const selectionBoundLockBytes = lock.approvalState === "provisional"
    ? lockBytes
    : Buffer.from(canonicalFile({ ...lock, approvalState: "provisional", approvedSample: null }));
  if (
    selection.schemaVersion !== 2
    || selectionBytes.toString("utf8") !== canonicalFile(selection)
    || lockBytes.toString("utf8") !== canonicalFile(lock)
    || recipeBytes.toString("utf8") !== canonicalFile(recipe)
    || manifest.style.sha256 !== sha256Evidence(selectionBytes)
    || selection.projectRevisionId !== manifest.style.revisionId
    || selection.styleLockSha256 !== sha256Evidence(selectionBoundLockBytes)
    || lock.projectId !== manifest.projectId
    || lock.revisionId !== manifest.style.revisionId
    || lock.styleRecipeSha256 !== sha256Evidence(recipeBytes)
    || canonicalJson(lock.recipe) !== canonicalJson(recipe)
  ) throw new Error("revision snapshot style artifact chain is invalid");
}

async function currentStyleArtifacts(
  root: string,
  manifest: ProjectManifest,
): Promise<Map<string, Buffer>> {
  if (!manifest.style) return new Map();
  const artifacts = new Map(await Promise.all(STYLE_ARTIFACTS.map(async ({ projectPath }) => [
    projectPath,
    await readOwnedRegularFile(root, projectPath),
  ] as const)));
  validateStyleArtifacts(manifest, artifacts);
  return artifacts;
}

function descriptorFor(
  manifest: ProjectManifest,
  bytes: Buffer,
  artifacts: ReadonlyMap<string, Buffer>,
): RevisionSnapshotDescriptor {
  const revisionId = manifest.currentRevision.id;
  const snapshotPath = `revisions/${revisionId}/manifest-snapshot`;
  const base = SnapshotV2BaseSchema.parse({
    schemaVersion: 2,
    kind: "revision-manifest-snapshot",
    projectId: manifest.projectId,
    revisionId,
    snapshotPath,
    manifestPath: `${snapshotPath}/superppt.json`,
    manifestSha256: sha256Evidence(bytes),
    manifestSize: bytes.length,
    styleArtifacts: STYLE_ARTIFACTS.filter(({ projectPath }) => artifacts.has(projectPath))
      .map(({ projectPath, snapshotFile }) => {
        const value = artifacts.get(projectPath)!;
        return { projectPath, snapshotFile, sha256: sha256Evidence(value), size: value.length };
      }),
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
  artifacts: Map<string, Buffer>;
} {
  const beforeTree = directory.listRegularFiles();
  const descriptorBytes = directory.read("snapshot.json");
  const manifestBytes = directory.read("superppt.json");
  if (!descriptorBytes || !manifestBytes) throw new Error("revision snapshot is incomplete");
  const descriptor = RevisionSnapshotDescriptorSchema.parse(
    JSON.parse(descriptorBytes.toString("utf8")),
  );
  const expectedArtifacts = descriptor.schemaVersion === 2 ? descriptor.styleArtifacts : [];
  if (
    descriptor.schemaVersion === 2
    && !sameList(
      descriptor.styleArtifacts.map(({ projectPath, snapshotFile }) => `${projectPath}:${snapshotFile}`),
      STYLE_ARTIFACTS.filter(({ projectPath }) =>
        descriptor.styleArtifacts.some((artifact) => artifact.projectPath === projectPath))
        .map(({ projectPath, snapshotFile }) => `${projectPath}:${snapshotFile}`),
    )
  ) throw new Error("revision snapshot style artifact identity mismatch");
  const expectedTree = [
    "snapshot.json",
    "superppt.json",
    ...expectedArtifacts.map(({ snapshotFile }) => snapshotFile),
  ].sort();
  if (!sameList(beforeTree, expectedTree)) throw new Error("revision snapshot tree is not exact");
  const artifacts = new Map(expectedArtifacts.map(({ projectPath, snapshotFile, sha256, size }) => {
    const value = directory.read(snapshotFile);
    if (!value || value.length !== size || sha256Evidence(value) !== sha256) {
      throw new Error(`revision snapshot artifact hash mismatch: ${projectPath}`);
    }
    return [projectPath, value] as const;
  }));
  const descriptorAgain = directory.read("snapshot.json");
  const manifestAgain = directory.read("superppt.json");
  const artifactsAgain = new Map(expectedArtifacts.map(({ projectPath, snapshotFile }) => [
    projectPath,
    directory.read(snapshotFile),
  ] as const));
  const afterTree = directory.listRegularFiles();
  if (
    !descriptorAgain
    || !manifestAgain
    || !sameBytes(descriptorBytes, descriptorAgain)
    || !sameBytes(manifestBytes, manifestAgain)
    || [...artifacts].some(([path, value]) => !artifactsAgain.get(path)?.equals(value))
    || !sameList(afterTree, expectedTree)
  ) throw new Error("revision snapshot changed while authenticating");
  const { descriptorSha256, ...base } = descriptor;
  if (descriptorSha256 !== sha256Evidence(JSON.stringify(base))) {
    throw new Error("revision snapshot descriptor integrity mismatch");
  }
  if (
    descriptor.manifestSha256 !== sha256Evidence(manifestBytes)
    || descriptor.manifestSize !== manifestBytes.length
  ) throw new Error("revision snapshot manifest hash mismatch");
  const manifest = ProjectManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  validateStyleArtifacts(manifest, artifacts);
  return { descriptor, bytes: manifestBytes, manifest, artifacts };
}

export async function readRevisionSnapshot(
  root: string,
  revisionId: string,
  operations?: RevisionEvidenceOperations,
): Promise<{
  descriptor: RevisionSnapshotDescriptor;
  bytes: Buffer;
  manifest: ProjectManifest;
  artifacts: Map<string, Buffer>;
}> {
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
  const artifacts = await currentStyleArtifacts(root, manifest);
  const descriptor = descriptorFor(manifest, bytes, artifacts);
  if (descriptor.schemaVersion !== 2) throw new Error("new revision snapshots require schema v2");
  try {
    const existing = await readRevisionSnapshot(root, manifest.currentRevision.id, operations);
    const compatibleLegacy = existing.descriptor.schemaVersion === 1
      && !manifest.style
      && existing.artifacts.size === 0;
    if (
      !existing.bytes.equals(bytes)
      || (!compatibleLegacy && JSON.stringify(existing.descriptor) !== JSON.stringify(descriptor))
      || [...artifacts].some(([path, value]) => !existing.artifacts.get(path)?.equals(value))
    ) {
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
        for (const { projectPath, snapshotFile } of STYLE_ARTIFACTS) {
          const value = artifacts.get(projectPath);
          if (value) staging.writeExclusive(snapshotFile, value);
        }
        await operations?.revisionSnapshotCheckpoint?.("manifest-written");
        staging.writeExclusive("snapshot.json", `${JSON.stringify(descriptor, null, 2)}\n`);
        await operations?.revisionSnapshotCheckpoint?.("descriptor-written");
        const expectedTree = [
          "snapshot.json",
          "superppt.json",
          ...descriptor.styleArtifacts.map(({ snapshotFile }) => snapshotFile),
        ].sort();
        if (!sameList(staging.listRegularFiles(), expectedTree)) {
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
