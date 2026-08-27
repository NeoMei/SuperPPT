import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withProjectLease } from "../project/lock.js";
import { promoteExclusive } from "../project/promotion.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import type { ProjectManifest } from "../project/schemas.js";
import { readProject, sha256 } from "../project/store.js";
import {
  ClientSmokeCopyDescriptorSchema,
  type ClientAcceptance,
} from "./schema.js";

export type ClientSmokeCopyDescriptor = ReturnType<typeof ClientSmokeCopyDescriptorSchema.parse>;

export type PublishedClientSmokeCopy = ClientSmokeCopyDescriptor & {
  descriptorPath: string;
  descriptorSha256: string;
};

type ValidatedSmokeCopy = PublishedClientSmokeCopy & {
  currentCopySha256: string;
};

function deckRevisionNumber(manifest: ProjectManifest): number {
  return manifest.deckRevision ?? manifest.currentRevision.number;
}

function smokePaths(revisionNumber: number): {
  directoryRef: string;
  descriptorRef: string;
  copyRef: string;
} {
  const directoryRef = `output/revisions/${revisionNumber}/client-smoke`;
  return {
    directoryRef,
    descriptorRef: `${directoryRef}/descriptor.json`,
    copyRef: `${directoryRef}/deck-smoke.pptx`,
  };
}

function canonicalPptxRef(manifest: ProjectManifest): string {
  return `output/revisions/${deckRevisionNumber(manifest)}/deck.pptx`;
}

async function requireExactSmokeDirectory(root: string, directoryRef: string): Promise<void> {
  const directory = join(root, ...directoryRef.split("/"));
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
    throw new Error("client smoke copy directory is unsafe");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (JSON.stringify(entries.map(({ name }) => name).sort()) !== JSON.stringify(["deck-smoke.pptx", "descriptor.json"])) {
    throw new Error("client smoke copy directory has unexpected entries");
  }
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("client smoke copy artifacts must be regular files");
  }
}

export async function validateClientSmokeCopyDescriptor(options: {
  root: string;
  manifest: ProjectManifest;
  descriptorPath: string;
  expectedDescriptorSha256?: string;
}): Promise<ValidatedSmokeCopy> {
  const revisionNumber = deckRevisionNumber(options.manifest);
  const paths = smokePaths(revisionNumber);
  if (options.descriptorPath !== paths.descriptorRef) {
    throw new Error("client smoke copy descriptor must use its fixed project path");
  }
  const canonical = options.manifest.exports.pptx;
  if (
    !canonical
    || canonical.revisionId !== options.manifest.currentRevision.id
    || canonical.path !== canonicalPptxRef(options.manifest)
  ) throw new Error("canonical PPTX evidence is not current");
  const descriptorBytes = await readOwnedRegularFile(options.root, paths.descriptorRef);
  const descriptorSha256 = sha256(descriptorBytes);
  if (options.expectedDescriptorSha256 && descriptorSha256 !== options.expectedDescriptorSha256) {
    throw new Error("client smoke copy descriptor hash mismatch");
  }
  let descriptor: ClientSmokeCopyDescriptor;
  try {
    descriptor = ClientSmokeCopyDescriptorSchema.parse(JSON.parse(descriptorBytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("client smoke copy descriptor is invalid", { cause: error });
  }
  if (
    descriptor.projectId !== options.manifest.projectId
    || descriptor.revisionId !== options.manifest.currentRevision.id
    || descriptor.revisionNumber !== revisionNumber
    || descriptor.source.path !== canonical.path
    || descriptor.source.sha256 !== canonical.sha256
    || descriptor.copy.path !== paths.copyRef
    || descriptor.copy.initialSha256 !== canonical.sha256
  ) throw new Error("client smoke copy descriptor identity does not match the current canonical PPTX");
  const canonicalBytes = await readOwnedRegularFile(options.root, canonical.path);
  if (sha256(canonicalBytes) !== canonical.sha256) throw new Error("canonical PPTX changed during client acceptance");
  await requireExactSmokeDirectory(options.root, paths.directoryRef);
  const copyBytes = await readOwnedRegularFile(options.root, paths.copyRef);
  return {
    ...descriptor,
    descriptorPath: paths.descriptorRef,
    descriptorSha256,
    currentCopySha256: sha256(copyBytes),
  };
}

export async function createClientSmokeCopy(root: string): Promise<PublishedClientSmokeCopy> {
  return withProjectLease(root, "acceptance-smoke-copy", async (canonicalRoot) => {
    const manifest = await readProject(canonicalRoot);
    const canonical = manifest.exports.pptx;
    const revisionNumber = deckRevisionNumber(manifest);
    const paths = smokePaths(revisionNumber);
    if (
      !canonical
      || canonical.revisionId !== manifest.currentRevision.id
      || canonical.path !== canonicalPptxRef(manifest)
      || !manifest.exports.acceptance
    ) throw new Error("current assembled canonical PPTX is required before creating a smoke copy");
    try {
      const existing = await validateClientSmokeCopyDescriptor({
        root: canonicalRoot,
        manifest,
        descriptorPath: paths.descriptorRef,
      });
      const { currentCopySha256: _current, ...published } = existing;
      return published;
    } catch (error: unknown) {
      const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && cause?.code !== "ENOENT") throw error;
    }
    if (manifest.stage === "delivered") throw new Error("delivered acceptance is missing its owned smoke copy evidence");

    const source = await readOwnedRegularFile(canonicalRoot, canonical.path);
    if (sha256(source) !== canonical.sha256) throw new Error("canonical PPTX evidence is not current");
    const outputRevision = join(canonicalRoot, "output", "revisions", String(revisionNumber));
    const outputInfo = await lstat(outputRevision);
    if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory() || await realpath(outputRevision) !== outputRevision) {
      throw new Error("canonical output revision directory is unsafe");
    }
    const staging = join(outputRevision, `.client-smoke-${randomUUID()}.staging`);
    await mkdir(staging, { mode: 0o700 });
    const descriptor = ClientSmokeCopyDescriptorSchema.parse({
      descriptorVersion: 1,
      appId: "superppt",
      artifactKind: "client-smoke-copy",
      projectId: manifest.projectId,
      revisionId: manifest.currentRevision.id,
      revisionNumber,
      source: { path: canonical.path, sha256: canonical.sha256 },
      copy: { path: paths.copyRef, initialSha256: canonical.sha256 },
      createdAt: new Date().toISOString(),
    });
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
    await writeDurableExclusive(join(staging, "deck-smoke.pptx"), source);
    await writeDurableExclusive(join(staging, "descriptor.json"), descriptorBytes);
    await syncDirectory(staging);
    await syncDirectory(outputRevision);

    const latest = await readProject(canonicalRoot);
    if (
      latest.currentRevision.id !== manifest.currentRevision.id
      || JSON.stringify(latest.exports.pptx) !== JSON.stringify(canonical)
      || sha256(await readOwnedRegularFile(canonicalRoot, canonical.path)) !== canonical.sha256
    ) throw new Error("canonical PPTX changed while creating the client smoke copy");
    await promoteExclusive(staging, join(outputRevision, "client-smoke"));
    await syncDirectory(outputRevision);
    const validated = await validateClientSmokeCopyDescriptor({
      root: canonicalRoot,
      manifest: latest,
      descriptorPath: paths.descriptorRef,
      expectedDescriptorSha256: sha256(descriptorBytes),
    });
    if (validated.currentCopySha256 !== descriptor.copy.initialSha256) {
      throw new Error("new client smoke copy does not match the canonical PPTX");
    }
    const { currentCopySha256: _current, ...published } = validated;
    return published;
  });
}

export async function validateRecordedClientSmokeCopy(
  root: string,
  manifest: ProjectManifest,
  client: ClientAcceptance,
): Promise<void> {
  if (!client.smokeCopy) throw new Error("client smoke copy evidence is missing");
  const validated = await validateClientSmokeCopyDescriptor({
    root,
    manifest,
    descriptorPath: client.smokeCopy.descriptorPath,
    expectedDescriptorSha256: client.smokeCopy.descriptorSha256,
  });
  if (
    client.smokeCopy.path !== validated.copy.path
    || client.smokeCopy.initialSha256 !== validated.copy.initialSha256
    || client.smokeCopy.savedSha256 !== validated.currentCopySha256
    || client.smokeCopy.savedSha256 === client.smokeCopy.initialSha256
  ) throw new Error("client smoke copy evidence is not current");
}
