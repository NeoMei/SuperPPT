import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withProjectLease } from "../project/lock.js";
import { promoteExclusive } from "../project/exclusive.js";
import { withGenerationLease } from "../generation/lease.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import type { ClientSmokeCopyAnchor, ProjectManifest } from "../project/schemas.js";
import {
  createClientSmokeCopyAnchor,
  readProject,
  sha256,
} from "../project/store.js";
import {
  ClientAcceptanceObservationSchema,
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

export type ClientSmokeCopyCheckpoint =
  | "before-anchor-commit"
  | "anchor-committed"
  | "files-promoted"
  | "anchor-ready";

export type ClientSmokeCopyOperations = {
  checkpoint?: (step: ClientSmokeCopyCheckpoint) => Promise<void> | void;
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

function descriptorFromAnchor(anchor: ClientSmokeCopyAnchor): ClientSmokeCopyDescriptor {
  return ClientSmokeCopyDescriptorSchema.parse({
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
  });
}

function descriptorBytes(anchor: ClientSmokeCopyAnchor): Buffer {
  return Buffer.from(`${JSON.stringify(descriptorFromAnchor(anchor), null, 2)}\n`);
}

function publishedFromAnchor(anchor: ClientSmokeCopyAnchor): PublishedClientSmokeCopy {
  return {
    ...descriptorFromAnchor(anchor),
    descriptorPath: anchor.descriptor.path,
    descriptorSha256: anchor.descriptor.sha256,
  };
}

function requireCurrentAnchor(
  manifest: ProjectManifest,
  allowPending: boolean,
): ClientSmokeCopyAnchor {
  const anchor = manifest.clientSmokeCopyAnchor;
  const canonical = manifest.exports.pptx;
  const paths = smokePaths(deckRevisionNumber(manifest));
  if (!anchor) throw new Error("trusted client smoke copy anchor is missing");
  if (
    !canonical
    || anchor.projectId !== manifest.projectId
    || anchor.revisionId !== manifest.currentRevision.id
    || anchor.deckRevision !== deckRevisionNumber(manifest)
    || JSON.stringify(anchor.source) !== JSON.stringify(canonical)
    || anchor.descriptor.path !== paths.descriptorRef
    || anchor.descriptor.revisionId !== manifest.currentRevision.id
    || anchor.initialCopy.path !== paths.copyRef
    || anchor.initialCopy.sha256 !== canonical.sha256
    || anchor.initialCopy.revisionId !== manifest.currentRevision.id
  ) throw new Error("trusted client smoke copy anchor is stale");
  if (!allowPending && anchor.state === "pending") {
    throw new Error("trusted client smoke copy anchor is not ready");
  }
  return anchor;
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
  allowPendingAnchor?: boolean;
}): Promise<ValidatedSmokeCopy> {
  const anchor = requireCurrentAnchor(options.manifest, options.allowPendingAnchor ?? false);
  const paths = smokePaths(anchor.deckRevision);
  if (options.descriptorPath !== anchor.descriptor.path) {
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
  if (descriptorSha256 !== anchor.descriptor.sha256) {
    throw new Error("client smoke copy descriptor hash mismatch");
  }
  let descriptor: ClientSmokeCopyDescriptor;
  try {
    descriptor = ClientSmokeCopyDescriptorSchema.parse(JSON.parse(descriptorBytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("client smoke copy descriptor is invalid", { cause: error });
  }
  if (
    JSON.stringify(descriptor) !== JSON.stringify(descriptorFromAnchor(anchor))
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

export async function createClientSmokeCopy(
  root: string,
  operations: ClientSmokeCopyOperations = {},
): Promise<PublishedClientSmokeCopy> {
  return withGenerationLease(root, (generationRoot) => withProjectLease(generationRoot, "acceptance-smoke-copy", async (canonicalRoot) => {
    let manifest = await readProject(canonicalRoot);
    const canonical = manifest.exports.pptx;
    const revisionNumber = deckRevisionNumber(manifest);
    const paths = smokePaths(revisionNumber);
    if (
      !canonical
      || canonical.revisionId !== manifest.currentRevision.id
      || canonical.path !== canonicalPptxRef(manifest)
      || !manifest.exports.acceptance
    ) throw new Error("current assembled canonical PPTX is required before creating a smoke copy");
    if (manifest.stage === "delivered") throw new Error("delivered acceptance is missing its owned smoke copy evidence");

    const source = await readOwnedRegularFile(canonicalRoot, canonical.path);
    if (sha256(source) !== canonical.sha256) throw new Error("canonical PPTX evidence is not current");
    const anchor = await createClientSmokeCopyAnchor(canonicalRoot, {
      checkpoint: operations.checkpoint,
      materialize: async (pending) => {
        const outputRevision = join(canonicalRoot, "output", "revisions", String(revisionNumber));
        const outputInfo = await lstat(outputRevision);
        if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory() || await realpath(outputRevision) !== outputRevision) {
          throw new Error("canonical output revision directory is unsafe");
        }
        let promoted = false;
        try {
          await lstat(join(outputRevision, "client-smoke"));
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const staging = join(outputRevision, `.client-smoke-${randomUUID()}.staging`);
          await mkdir(staging, { mode: 0o700 });
          try {
            await writeDurableExclusive(join(staging, "deck-smoke.pptx"), source);
            await writeDurableExclusive(join(staging, "descriptor.json"), descriptorBytes(pending));
            await syncDirectory(staging);
            await syncDirectory(outputRevision);
            await promoteExclusive(staging, join(outputRevision, "client-smoke"));
            promoted = true;
            await syncDirectory(outputRevision);
          } finally {
            if (!promoted) await rm(staging, { recursive: true, force: true });
          }
        }
      },
    });
    manifest = await readProject(canonicalRoot);
    const existing = await validateClientSmokeCopyDescriptor({
      root: canonicalRoot,
      manifest,
      descriptorPath: anchor.descriptor.path,
    });
    const { currentCopySha256: _current, ...published } = existing;
    return published;
  }));
}

export async function validateRecordedClientSmokeCopy(
  root: string,
  manifest: ProjectManifest,
  client: ClientAcceptance,
): Promise<void> {
  if (!client.smokeCopy) throw new Error("client smoke copy evidence is missing");
  const anchor = requireCurrentAnchor(manifest, false);
  if (
    anchor.state !== "completed"
    || !client.observation
    || JSON.stringify(anchor.observation) !== JSON.stringify(client.observation)
    || anchor.reopenedCopySha256 !== client.smokeCopy.reopenedSha256
    || !anchor.acceptanceRecord
    || JSON.stringify(anchor.acceptanceRecord) !== JSON.stringify(manifest.exports.acceptance)
  ) throw new Error("client smoke copy completion anchor is not current");
  const validated = await validateClientSmokeCopyDescriptor({
    root,
    manifest,
    descriptorPath: client.smokeCopy.descriptorPath,
  });
  if (
    client.smokeCopy.path !== validated.copy.path
    || client.smokeCopy.descriptorSha256 !== anchor.descriptor.sha256
    || client.smokeCopy.initialSha256 !== validated.copy.initialSha256
    || client.smokeCopy.reopenedSha256 !== validated.currentCopySha256
    || client.smokeCopy.reopenedSha256 !== client.smokeCopy.initialSha256
  ) throw new Error("client smoke copy evidence is not current");
  const observationBytes = await readOwnedRegularFile(root, client.observation.path);
  if (sha256(observationBytes) !== client.observation.sha256) {
    throw new Error("client observation evidence is not current");
  }
  const observation = ClientAcceptanceObservationSchema.parse(JSON.parse(observationBytes.toString("utf8")));
  if (
    client.observation.revisionId !== manifest.currentRevision.id
    || observation.anchorId !== anchor.anchorId
    || observation.projectId !== manifest.projectId
    || observation.revisionId !== manifest.currentRevision.id
    || observation.deckRevision !== anchor.deckRevision
    || JSON.stringify(observation.descriptor) !== JSON.stringify(anchor.descriptor)
    || JSON.stringify(observation.source) !== JSON.stringify(anchor.source)
    || JSON.stringify(observation.initialCopy) !== JSON.stringify(anchor.initialCopy)
    || observation.reopenedCopySha256 !== anchor.reopenedCopySha256
    || observation.application !== client.application
    || observation.selectedObject !== client.selectedObject
    || observation.temporaryEditObserved !== client.temporaryEditObserved
    || observation.undoObserved !== client.undoObserved
    || observation.saveDecision !== client.saveDecision
    || observation.reopenObserved !== client.reopenObserved
    || observation.observedResult !== client.observedResult
    || observation.confirmedAt !== client.confirmedAt
  ) throw new Error("client observation does not bind the current acceptance result");
}
