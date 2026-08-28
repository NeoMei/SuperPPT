import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { realpath } from "node:fs/promises";

import { GenerationDirectory, openGenerationDirectory } from "./anchored-dir.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PRIVATE_NAME = new RegExp(`^pid-(\\d+)-(${UUID})\\.(prompt\\.txt|review\\.json)$`);
const PROVIDER_NAME = new RegExp(`^\\.pid-(\\d+)-(${UUID})\\.(provider-image|normalized\\.png)$`);
const STAGING_NAME = new RegExp(`^\\.attempt-[1-3]\\.pid-(\\d+)-(${UUID})\\.staging$`);
// This cleanup is intentionally limited to the pre-delegation direct-provider
// staging tree. Immutable delegated jobs, results, and call ledgers are audit
// records and must never be discovered here for deletion.
const LEGACY_STAGING_ROOT = "images";

export function ownedTemporaryName(suffix: string): string {
  if (!suffix || suffix.includes("/") || suffix.includes("\\")) throw new Error("unsafe temporary suffix");
  return `pid-${process.pid}-${randomUUID()}.${suffix}`;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return true;
  try { process.kill(pid, 0); return true; } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function deadOwner(match: RegExpExecArray): number | null {
  const pid = Number(match[1]);
  return processIsAlive(pid) ? null : pid;
}

function entries(directory: GenerationDirectory): Dirent<string>[] {
  directory.assertCurrent();
  const result = readdirSync(directory.path, { withFileTypes: true });
  directory.assertCurrent();
  return result;
}

function removeVerifiedRegular(directory: GenerationDirectory, name: string): void {
  let fd: number | undefined;
  try {
    fd = directory.openRegular(name);
    if (process.platform !== "win32" && (fstatSync(fd).mode & 0o777) !== 0o600) return;
    if (process.platform === "win32") {
      closeSync(fd);
      fd = undefined;
    }
    directory.remove(name);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function privateDirectory(parent: GenerationDirectory): GenerationDirectory | null {
  try { return parent.child(".private", false); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function cleanupAbandonedProviderFiles(directory: GenerationDirectory): void {
  const privateRoot = privateDirectory(directory);
  if (privateRoot) {
    try {
      for (const entry of entries(privateRoot)) {
        const match = PRIVATE_NAME.exec(entry.name);
        if (match && deadOwner(match) !== null && entry.isFile() && !entry.isSymbolicLink()) {
          removeVerifiedRegular(privateRoot, entry.name);
        }
      }
    } finally {
      privateRoot.close();
    }
  }
  for (const entry of entries(directory)) {
    const match = PROVIDER_NAME.exec(entry.name);
    if (match && deadOwner(match) !== null && entry.isFile() && !entry.isSymbolicLink()) {
      removeVerifiedRegular(directory, entry.name);
    }
  }
}

function stagingIsValidated(staging: GenerationDirectory, ownerPid: number): boolean {
  for (const entry of entries(staging)) {
    if (entry.isSymbolicLink()) return false;
    if (entry.name === ".private" && entry.isDirectory()) {
      const privateRoot = staging.child(entry.name, false);
      try {
        for (const privateEntry of entries(privateRoot)) {
          const match = PRIVATE_NAME.exec(privateEntry.name);
          if (!match || Number(match[1]) !== ownerPid || !privateEntry.isFile() || privateEntry.isSymbolicLink()) return false;
        }
      } finally {
        privateRoot.close();
      }
      continue;
    }
    if (!entry.isFile()) return false;
    if (entry.name === "slide.png" || entry.name === "ledger.json") continue;
    const match = PROVIDER_NAME.exec(entry.name);
    if (!match || Number(match[1]) !== ownerPid) return false;
  }
  return true;
}

function removeValidatedStaging(slide: GenerationDirectory, name: string, ownerPid: number): void {
  const staging = slide.child(name, false);
  try {
    if (!stagingIsValidated(staging, ownerPid)) return;
    const privateRoot = privateDirectory(staging);
    if (privateRoot) {
      try {
        for (const entry of entries(privateRoot)) removeVerifiedRegular(privateRoot, entry.name);
      } finally {
        privateRoot.close();
      }
      staging.removeEmptyChild(".private");
    }
    for (const entry of entries(staging)) removeVerifiedRegular(staging, entry.name);
  } finally {
    staging.close();
  }
  slide.removeEmptyChild(name);
}

export async function cleanupAbandonedProjectStaging(root: string, slideIds: readonly string[]): Promise<void> {
  const project = openGenerationDirectory(await realpath(root));
  const images = project.child(LEGACY_STAGING_ROOT, false);
  try {
    for (const slideId of slideIds) {
      let slide: GenerationDirectory;
      try { slide = images.child(slideId, false); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        for (const entry of entries(slide)) {
          const match = STAGING_NAME.exec(entry.name);
          const ownerPid = match ? deadOwner(match) : null;
          if (match && ownerPid !== null && entry.isDirectory() && !entry.isSymbolicLink()) {
            removeValidatedStaging(slide, entry.name, ownerPid);
          }
        }
      } finally {
        slide.close();
      }
    }
  } finally {
    images.close();
    project.close();
  }
}
