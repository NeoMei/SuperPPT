import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { validateProjectRoot } from "./paths.js";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "./schemas.js";

export const MARKER = ".superppt-project.json";
export const MANIFEST = "superppt.json";

const OwnershipMarkerSchema = z.object({
  markerVersion: z.literal(1),
  appId: z.literal("superppt"),
  artifactKind: z.literal("project"),
}).strict();

export const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

async function ownedProjectRoot(root: string): Promise<string> {
  const canonical = await validateProjectRoot(root);
  try {
    OwnershipMarkerSchema.parse(
      JSON.parse(await readFile(join(canonical, MARKER), "utf8")),
    );
  } catch {
    throw new Error("project directory is not owned by SuperPPT");
  }
  return canonical;
}

export async function readProject(root: string): Promise<ProjectManifest> {
  const ownedRoot = await ownedProjectRoot(root);
  return ProjectManifestSchema.parse(
    JSON.parse(await readFile(join(ownedRoot, MANIFEST), "utf8")),
  );
}

export async function writeProject(
  root: string,
  manifest: ProjectManifest,
): Promise<void> {
  const valid = ProjectManifestSchema.parse(manifest);
  const ownedRoot = await ownedProjectRoot(root);
  const staging = join(ownedRoot, `.superppt.${randomUUID()}.staging.json`);
  await writeFile(staging, `${JSON.stringify(valid, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(staging, join(ownedRoot, MANIFEST));
}
