import { createHash, randomUUID } from "node:crypto";
import { closeSync } from "node:fs";

import { assertGateCurrent } from "../planning/confirm.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { assertProjectMutationNotFrozen, readProject } from "../project/store.js";
import { openGenerationDirectory } from "../generation/anchored-dir.js";
import { withGenerationLease } from "../generation/lease.js";
import { resolveStyleRecipe } from "./catalog.js";
import {
  StyleLockSchema,
  StyleSelectionSchema,
  type StyleLock,
  type StyleRecipe,
  type StyleSelection,
} from "./schemas.js";

const RECIPE_PATH = "style/recipe.json";
const LOCK_PATH = "style/lock.json";
const SAMPLE_PATH = "style/sample/slide.png";

export type LockedStyle = StyleLock & { styleLockSha256: string };

export type StyleReferenceInput = {
  path: string;
  role: "art-direction" | "content-reference";
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function canonicalFile(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function regularFileExists(style: ReturnType<typeof openGenerationDirectory>, name: string): boolean {
  try {
    const fd = style.openRegular(name);
    try { return true; } finally { closeSync(fd); }
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function matchingProvisionalLock(
  existing: LockedStyle,
  expected: StyleLock,
): boolean {
  return existing.approvalState === "provisional"
    && existing.projectId === expected.projectId
    && existing.revisionId === expected.revisionId
    && sameJson(existing.recipe, expected.recipe)
    && sameJson(existing.referenceArtifacts, expected.referenceArtifacts);
}

function recoverIncompleteLockFiles(root: string, expected: StyleLock): LockedStyle | null {
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  try {
    const lockExists = regularFileExists(style, "lock.json");
    const recipeExists = regularFileExists(style, "recipe.json");
    if ((!lockExists && !recipeExists) || (lockExists && recipeExists)) return null;
    if (!lockExists) throw new Error("style lock transaction is incomplete");
    const existing = parseExactLock(style.read("lock.json"));
    if (!matchingProvisionalLock(existing, expected)) {
      throw new Error("incomplete style lock does not match the authenticated selection");
    }
    const recipeBytes = canonicalFile(existing.recipe);
    if (sha256(recipeBytes) !== existing.styleRecipeSha256) {
      throw new Error("incomplete style lock recipe binding is invalid");
    }
    style.writeExclusive("recipe.json", recipeBytes);
    return existing;
  } finally {
    style.close();
    project.close();
  }
}

async function referenceArtifacts(root: string, references: StyleReferenceInput[]) {
  return Promise.all(references.map(async ({ path, role }) => ({
    path,
    role,
    sha256: sha256(await readOwnedRegularFile(root, path)),
  })));
}

function parseExactLock(bytes: Buffer): LockedStyle {
  let lock: StyleLock;
  try {
    lock = StyleLockSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("style lock is invalid", { cause: error });
  }
  if (bytes.toString("utf8") !== canonicalFile(lock)) throw new Error("style lock is not canonical");
  return { ...lock, styleLockSha256: sha256(bytes) };
}

async function verifyLock(root: string, lock: LockedStyle): Promise<void> {
  const recipe = await readOwnedRegularFile(root, RECIPE_PATH);
  if (recipe.toString("utf8") !== canonicalFile(lock.recipe) || sha256(recipe) !== lock.styleRecipeSha256) {
    throw new Error("style recipe hash mismatch");
  }
  for (const reference of lock.referenceArtifacts) {
    if (sha256(await readOwnedRegularFile(root, reference.path)) !== reference.sha256) {
      throw new Error("style reference artifact hash mismatch");
    }
  }
  if (lock.approvedSample) {
    if (lock.approvedSample.path !== SAMPLE_PATH || lock.approvedSample.revisionId !== lock.revisionId) {
      throw new Error("approved style sample binding is invalid");
    }
    if (sha256(await readOwnedRegularFile(root, SAMPLE_PATH)) !== lock.approvedSample.sha256) {
      throw new Error("approved style sample hash mismatch");
    }
  }
}

function createLockFiles(root: string, recipe: StyleRecipe, lock: StyleLock, afterLockPublished?: () => Promise<void> | void): Promise<void> {
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  return Promise.resolve().then(async () => {
    try {
      style.writeExclusive("lock.json", canonicalFile(lock));
      await afterLockPublished?.();
      style.writeExclusive("recipe.json", canonicalFile(recipe));
    } finally {
      style.close();
      project.close();
    }
  });
}

function replaceApprovedLock(root: string, lock: StyleLock): void {
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  try {
    style.replace("lock.json", canonicalFile(lock), `.${randomUUID()}.lock`);
  } finally {
    style.close();
    project.close();
  }
}

export async function hasStyleLockEvidence(root: string): Promise<boolean> {
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  try {
    const lock = regularFileExists(style, "lock.json");
    const recipe = regularFileExists(style, "recipe.json");
    if (lock !== recipe) throw new Error("style lock transaction is incomplete");
    return lock;
  } finally {
    style.close();
    project.close();
  }
}

export async function createProvisionalStyleLock(root: string, input: {
  selection: StyleSelection;
  referenceArtifacts: StyleReferenceInput[];
  operations?: {
    afterLockPublished?: () => Promise<void> | void;
    recoverIncomplete?: boolean;
  };
}): Promise<LockedStyle> {
  const selection = StyleSelectionSchema.parse(input.selection);
  return withGenerationLease(root, (generationRoot) => withProjectLease(generationRoot, "state", async (canonicalRoot) => {
    await assertProjectMutationNotFrozen(canonicalRoot);
    const [manifest, recipe, references] = await Promise.all([
      readProject(canonicalRoot),
      resolveStyleRecipe(selection),
      referenceArtifacts(canonicalRoot, input.referenceArtifacts),
    ]);
    const recipeBytes = canonicalFile(recipe);
    const lock = StyleLockSchema.parse({
      contractVersion: 1,
      projectId: manifest.projectId,
      revisionId: manifest.currentRevision.id,
      approvalState: "provisional",
      recipe,
      styleRecipeSha256: sha256(recipeBytes),
      approvedSample: null,
      referenceArtifacts: references,
      applyDependencyDefaultStyle: false,
      createdAt: new Date().toISOString(),
    });
    if (input.operations?.recoverIncomplete) {
      const recovered = recoverIncompleteLockFiles(canonicalRoot, lock);
      if (recovered) return recovered;
    }
    if (await hasStyleLockEvidence(canonicalRoot)) {
      const existing = await readStyleLock(canonicalRoot);
      if (matchingProvisionalLock(existing, lock)) return existing;
      throw new Error("style lock already exists and cannot be replaced");
    }
    await createLockFiles(canonicalRoot, recipe, lock, input.operations?.afterLockPublished);
    return { ...lock, styleLockSha256: sha256(canonicalFile(lock)) };
  }));
}

export async function readStyleLock(root: string): Promise<LockedStyle> {
  if (!await hasStyleLockEvidence(root)) throw new Error("style lock is missing");
  const lock = parseExactLock(await readOwnedRegularFile(root, LOCK_PATH));
  const manifest = await readProject(root);
  if (lock.projectId !== manifest.projectId || lock.revisionId !== manifest.currentRevision.id) {
    throw new Error("style lock does not bind the current project revision");
  }
  await verifyLock(root, lock);
  return lock;
}

export async function readStyleLockIfPresent(root: string): Promise<LockedStyle | null> {
  return await hasStyleLockEvidence(root) ? readStyleLock(root) : null;
}

export async function readApprovedStyleLock(root: string): Promise<LockedStyle> {
  const lock = await readStyleLock(root);
  if (lock.approvalState !== "approved" || !lock.approvedSample) throw new Error("style lock must be approved before deck generation");
  return lock;
}

export async function approveStyleLock(
  root: string,
  options: { operations?: { afterExpectedProvisionalRead?: () => Promise<void> | void } } = {},
): Promise<LockedStyle> {
  return withGenerationLease(root, (generationRoot) => withProjectLease(generationRoot, "state", async (canonicalRoot) => {
    await assertProjectMutationNotFrozen(canonicalRoot);
    if (!await assertGateCurrent(canonicalRoot, "style-sample")) {
      throw new Error("style-sample gate must be current before style lock approval");
    }
    const expectedLockBytes = await readOwnedRegularFile(canonicalRoot, LOCK_PATH);
    const lock = await readStyleLock(canonicalRoot);
    if (lock.approvalState === "approved") return lock;
    await options.operations?.afterExpectedProvisionalRead?.();
    const manifest = await readProject(canonicalRoot);
    const gate = [...manifest.gates].reverse().find(({ gate: kind }) => kind === "style-sample");
    const sample = await readOwnedRegularFile(canonicalRoot, SAMPLE_PATH);
    const sampleSha256 = sha256(sample);
    if (!gate || gate.revisionId !== lock.revisionId || gate.artifactHashes[SAMPLE_PATH] !== sampleSha256) {
      throw new Error("style-sample gate does not authenticate the current sample artifact");
    }
    const { styleLockSha256: _styleLockSha256, ...unhashedLock } = lock;
    const approved = StyleLockSchema.parse({
      ...unhashedLock,
      approvalState: "approved",
      approvedSample: { path: SAMPLE_PATH, sha256: sampleSha256, revisionId: lock.revisionId },
    });
    if (!expectedLockBytes.equals(await readOwnedRegularFile(canonicalRoot, LOCK_PATH))) {
      throw new Error("style lock changed during approval");
    }
    replaceApprovedLock(canonicalRoot, approved);
    return { ...approved, styleLockSha256: sha256(canonicalFile(approved)) };
  }));
}
