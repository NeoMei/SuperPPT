import { createHash, randomUUID } from "node:crypto";

import { assertGateCurrent } from "../planning/confirm.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { openGenerationDirectory } from "../generation/anchored-dir.js";
import { resolveStyleRecipe } from "./catalog.js";
import { canonicalStyleSample } from "./sample-contract.js";
import {
  StyleLockSchema,
  StyleRecipeSchema,
  StyleSelectionSchema,
  type StyleLock,
  type StyleRecipe,
  type StyleSelection,
} from "./schemas.js";

const RECIPE_PATH = "style/recipe.json";
const LOCK_PATH = "style/lock.json";
const SAMPLE_PATH = "style/sample/sample.png";

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

function writeLockFiles(root: string, recipe: StyleRecipe, lock: StyleLock): void {
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  try {
    style.replace("recipe.json", canonicalFile(recipe), `.${randomUUID()}.recipe`);
    style.replace("lock.json", canonicalFile(lock), `.${randomUUID()}.lock`);
  } finally {
    style.close();
    project.close();
  }
}

export async function createProvisionalStyleLock(root: string, input: {
  selection: StyleSelection;
  referenceArtifacts: StyleReferenceInput[];
}): Promise<LockedStyle> {
  const selection = StyleSelectionSchema.parse(input.selection);
  return withProjectLease(root, "state", async (canonicalRoot) => {
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
    writeLockFiles(canonicalRoot, recipe, lock);
    return { ...lock, styleLockSha256: sha256(canonicalFile(lock)) };
  });
}

export async function readStyleLock(root: string): Promise<LockedStyle> {
  const lock = parseExactLock(await readOwnedRegularFile(root, LOCK_PATH));
  const manifest = await readProject(root);
  if (lock.projectId !== manifest.projectId || lock.revisionId !== manifest.currentRevision.id) {
    throw new Error("style lock does not bind the current project revision");
  }
  await verifyLock(root, lock);
  return lock;
}

export async function readApprovedStyleLock(root: string): Promise<LockedStyle> {
  const lock = await readStyleLock(root);
  if (lock.approvalState !== "approved" || !lock.approvedSample) throw new Error("style lock must be approved before deck generation");
  return lock;
}

export async function approveStyleLock(root: string): Promise<LockedStyle> {
  return withProjectLease(root, "state", async (canonicalRoot) => {
    if (!await assertGateCurrent(canonicalRoot, "style-sample")) {
      throw new Error("style-sample gate must be current before style lock approval");
    }
    const lock = await readStyleLock(canonicalRoot);
    if (lock.approvalState === "approved") return lock;
    const manifest = await readProject(canonicalRoot);
    const canonicalSample = await canonicalStyleSample(canonicalRoot);
    if (canonicalJson(canonicalSample.style) !== canonicalJson(lock.recipe)) {
      throw new Error("style-sample gate recipe does not match the provisional style lock");
    }
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
    writeLockFiles(canonicalRoot, approved.recipe, approved);
    return { ...approved, styleLockSha256: sha256(canonicalFile(approved)) };
  });
}
