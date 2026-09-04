import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { CurrentDeckPointer } from "../deck-revisions/schemas.js";
import { openGenerationDirectory, type GenerationDirectory } from "../generation/anchored-dir.js";
import { sha256Evidence } from "./evidence.js";
import { readOwnedRegularFile } from "./safe-file.js";
import type { Artifact, FormalDeckDeliveryBinding } from "./schemas.js";

const DELIVERY_DIRECTORY = "交付";
const RESERVED_WINDOWS_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export type PublishedFinalDeck = {
  revisionId: string;
  relativePath: string;
  absolutePath: string;
  sha256: string;
};

export function finalDeckFileName(title: string): string {
  let stem = title.normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.pptx$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "");
  stem = Array.from(stem).slice(0, 96).join("").replace(/[. ]+$/g, "");
  if (!stem || RESERVED_WINDOWS_NAME.test(stem) || /^deck$/i.test(stem)) stem = "SuperPPT";
  return `${stem}.pptx`;
}

export async function authenticateFinalDeck(
  root: string,
  current: CurrentDeckPointer,
  formal: FormalDeckDeliveryBinding,
  artifact: Artifact,
): Promise<PublishedFinalDeck> {
  if (!/^交付\/[^/]+\.pptx$/i.test(artifact.path)) {
    throw new Error("final delivery must use one shallow semantic PPTX path");
  }
  const absolutePath = join(root, ...artifact.path.split("/"));
  if (
    formal.revisionId !== current.revisionId
    || formal.sha256 !== current.sha256
    || formal.absolutePath !== absolutePath
    || artifact.sha256 !== current.sha256
  ) throw new Error("final delivery does not bind the exact current complete deck");
  if (sha256Evidence(await readOwnedRegularFile(root, artifact.path)) !== current.sha256) {
    throw new Error("final delivery PPTX changed after publication");
  }
  return {
    revisionId: current.revisionId,
    relativePath: artifact.path,
    absolutePath,
    sha256: current.sha256,
  };
}

function existingDigest(directory: GenerationDirectory, name: string): string | null {
  try {
    return sha256Evidence(directory.read(name));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function publishFinalDeck(
  root: string,
  title: string,
  current: CurrentDeckPointer,
): Promise<PublishedFinalDeck> {
  const bytes = await readOwnedRegularFile(root, current.relativePath);
  if (sha256Evidence(bytes) !== current.sha256) {
    throw new Error("current complete deck changed before final delivery publication");
  }
  const project = openGenerationDirectory(root);
  let directory: GenerationDirectory | undefined;
  try {
    directory = project.child(DELIVERY_DIRECTORY);
    const baseName = finalDeckFileName(title);
    const baseDigest = existingDigest(directory, baseName);
    const fileName = baseDigest === null || baseDigest === current.sha256
      ? baseName
      : `${baseName.slice(0, -5)}-${current.sha256.slice(0, 8)}.pptx`;
    const targetDigest = existingDigest(directory, fileName);
    if (targetDigest !== null && targetDigest !== current.sha256) {
      throw new Error("final delivery target already exists with different bytes");
    }
    if (targetDigest === null) {
      const stagingName = `.${fileName}.${randomUUID()}.staging`;
      directory.writeExclusive(stagingName, bytes);
      try {
        directory.promoteFileExclusive(stagingName, fileName);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST"
          || existingDigest(directory, fileName) !== current.sha256) throw error;
      } finally {
        directory.remove(stagingName);
      }
    }
    if (existingDigest(directory, fileName) !== current.sha256) {
      throw new Error("final delivery PPTX changed during publication");
    }
    return {
      revisionId: current.revisionId,
      relativePath: `${DELIVERY_DIRECTORY}/${fileName}`,
      absolutePath: join(directory.path, fileName),
      sha256: current.sha256,
    };
  } finally {
    try {
      directory?.close();
    } finally {
      project.close();
    }
  }
}
