import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { openGenerationDirectory, type GenerationDirectory } from "../generation/anchored-dir.js";
import { withGenerationLease } from "../generation/lease.js";
import { assertGateCurrent } from "../planning/confirm.js";
import { loadValidatedPlan } from "../planning/load.js";
import { readProject, updateProject } from "../project/store.js";
import { readRevisionSnapshot } from "../revisions/snapshot.js";
import {
  StyleLockSchema,
  StyleReferenceSchema,
  StyleSampleSelectionSchema,
  StyleSelectionSchema,
  type StyleSampleSelection,
} from "./schemas.js";
import { canonicalJson, createProvisionalStyleLock } from "./style-lock.js";

export const StyleSelectionRequestSchema = z.object({
  projectRevisionId: z.string().uuid(),
  representativeSlideId: z.string().uuid(),
  selection: StyleSelectionSchema,
  referenceArtifacts: z.array(StyleReferenceSchema.pick({ path: true, role: true })),
}).strict();

export type StyleSelectionCheckpoint =
  | "lock-written"
  | "selection-written"
  | "manifest-before-update"
  | "stale-selection-removed"
  | "stale-recipe-removed"
  | "stale-lock-removed";

export type StyleSelectionOperations = {
  checkpoint?: (step: StyleSelectionCheckpoint) => Promise<void> | void;
};

type StyleSelectionRequest = z.infer<typeof StyleSelectionRequestSchema>;

type SelectionResult = {
  stage: "style-selection";
  projectRevisionId: string;
  representativeSlideId: string;
  styleId: string;
  styleLockSha256: string;
};

const RETIREMENT_TRANSACTION = "retirement-transaction";
const RetirementArtifactSchema = z.object({
  projectPath: z.enum(["style/selection.json", "style/lock.json", "style/recipe.json"]),
  file: z.enum(["selection.json", "lock.json", "recipe.json"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
}).strict();
const RetirementBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("style-retirement-transaction"),
  transactionId: z.string().uuid(),
  projectId: z.string().uuid(),
  staleRevisionId: z.string().uuid(),
  currentRevisionId: z.string().uuid(),
  snapshotDescriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifacts: z.array(RetirementArtifactSchema).length(3),
}).strict();
const RetirementDescriptorSchema = RetirementBaseSchema.extend({
  descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type RetirementDescriptor = z.infer<typeof RetirementDescriptorSchema>;

const RETIREMENT_ARTIFACTS = [
  { projectPath: "style/selection.json", file: "selection.json", checkpoint: "stale-selection-removed" },
  { projectPath: "style/recipe.json", file: "recipe.json", checkpoint: "stale-recipe-removed" },
  { projectPath: "style/lock.json", file: "lock.json", checkpoint: "stale-lock-removed" },
] as const;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalFile(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readOptional(style: GenerationDirectory, name: string): Buffer | null {
  try {
    return style.read(name);
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addRetirementIntegrity(base: z.infer<typeof RetirementBaseSchema>): RetirementDescriptor {
  return RetirementDescriptorSchema.parse({
    ...base,
    descriptorSha256: sha256(JSON.stringify(base)),
  });
}

function readRetirementTransaction(style: GenerationDirectory): {
  descriptor: RetirementDescriptor;
  artifacts: Map<string, Buffer>;
} | null {
  let transaction: GenerationDirectory;
  try {
    transaction = style.child(RETIREMENT_TRANSACTION, false);
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const expectedTree = ["transaction.json", ...RETIREMENT_ARTIFACTS.map(({ file }) => file)].sort();
    if (!sameList(transaction.listRegularFiles(), expectedTree)) {
      throw new Error("style retirement transaction tree is invalid");
    }
    const descriptorBytes = transaction.read("transaction.json");
    const descriptor = RetirementDescriptorSchema.parse(JSON.parse(descriptorBytes.toString("utf8")));
    const { descriptorSha256, ...base } = descriptor;
    if (descriptorSha256 !== sha256(JSON.stringify(base))) {
      throw new Error("style retirement transaction descriptor integrity mismatch");
    }
    const expectedDescriptors = RETIREMENT_ARTIFACTS.map(({ projectPath, file }) => ({ projectPath, file }));
    if (!sameJson(
      descriptor.artifacts.map(({ projectPath, file }) => ({ projectPath, file })),
      expectedDescriptors,
    )) throw new Error("style retirement transaction artifact identity mismatch");
    const artifacts = new Map(descriptor.artifacts.map(({ projectPath, file, sha256: digest, size }) => {
      const bytes = transaction.read(file);
      if (bytes.length !== size || sha256(bytes) !== digest) {
        throw new Error(`style retirement transaction artifact hash mismatch: ${projectPath}`);
      }
      return [projectPath, bytes] as const;
    }));
    if (
      !transaction.read("transaction.json").equals(descriptorBytes)
      || [...descriptor.artifacts].some(({ projectPath, file }) =>
        !transaction.read(file).equals(artifacts.get(projectPath)!))
      || !sameList(transaction.listRegularFiles(), expectedTree)
    ) throw new Error("style retirement transaction changed while authenticating");
    return { descriptor, artifacts };
  } finally {
    transaction.close();
  }
}

function publishRetirementTransaction(
  style: GenerationDirectory,
  input: {
    projectId: string;
    staleRevisionId: string;
    currentRevisionId: string;
    snapshotDescriptorSha256: string;
    artifacts: ReadonlyMap<string, Buffer>;
  },
): void {
  const transactionId = randomUUID();
  const descriptors = RETIREMENT_ARTIFACTS.map(({ projectPath, file }) => {
    const bytes = input.artifacts.get(projectPath);
    if (!bytes) throw new Error(`style retirement artifact is missing: ${projectPath}`);
    return { projectPath, file, sha256: sha256(bytes), size: bytes.length };
  });
  const base = RetirementBaseSchema.parse({
    schemaVersion: 1,
    kind: "style-retirement-transaction",
    transactionId,
    projectId: input.projectId,
    staleRevisionId: input.staleRevisionId,
    currentRevisionId: input.currentRevisionId,
    snapshotDescriptorSha256: input.snapshotDescriptorSha256,
    artifacts: descriptors,
  });
  const descriptor = addRetirementIntegrity(base);
  const stagingName = `.retirement-${transactionId}`;
  const staging = style.createChildExclusive(stagingName);
  let complete = false;
  try {
    for (const { projectPath, file } of descriptors) {
      staging.writeExclusive(file, input.artifacts.get(projectPath)!);
    }
    staging.writeExclusive("transaction.json", `${JSON.stringify(descriptor, null, 2)}\n`);
    const expectedTree = ["transaction.json", ...descriptors.map(({ file }) => file)].sort();
    if (!sameList(staging.listRegularFiles(), expectedTree)) {
      throw new Error("style retirement transaction staging tree is invalid");
    }
    staging.close();
    style.promoteChildExclusive(stagingName, RETIREMENT_TRANSACTION);
    complete = true;
  } finally {
    if (!complete) {
      try { staging.close(); } catch { /* best effort close before preserving evidence */ }
    }
  }
}

async function resumeRetirementTransaction(
  root: string,
  style: GenerationDirectory,
  manifest: Awaited<ReturnType<typeof readProject>>,
  operations: StyleSelectionOperations,
): Promise<boolean> {
  const evidence = readRetirementTransaction(style);
  if (!evidence) return false;
  const { descriptor, artifacts } = evidence;
  if (
    descriptor.projectId !== manifest.projectId
    || descriptor.currentRevisionId !== manifest.currentRevision.id
  ) throw new Error("style retirement transaction does not bind the current project revision");
  const staleIndex = manifest.revisions.findIndex(({ id }) => id === descriptor.staleRevisionId);
  const currentIndex = manifest.revisions.findIndex(({ id }) => id === manifest.currentRevision.id);
  const child = staleIndex >= 0 ? manifest.revisions[staleIndex + 1] : undefined;
  if (
    staleIndex < 0
    || currentIndex < 0
    || staleIndex >= currentIndex
    || !child
    || child.parentId !== descriptor.staleRevisionId
    || child.parentSnapshotDescriptorSha256 !== descriptor.snapshotDescriptorSha256
  ) throw new Error("style retirement transaction revision anchor is invalid");
  const snapshot = await readRevisionSnapshot(root, descriptor.staleRevisionId);
  if (
    snapshot.descriptor.descriptorSha256 !== descriptor.snapshotDescriptorSha256
    || [...artifacts].some(([path, bytes]) => !snapshot.artifacts.get(path)?.equals(bytes))
    || snapshot.artifacts.size !== artifacts.size
  ) throw new Error("style retirement transaction conflicts with its immutable revision snapshot");
  for (const { projectPath, file, checkpoint } of RETIREMENT_ARTIFACTS) {
    const expected = artifacts.get(projectPath)!;
    const live = readOptional(style, file);
    if (live && !live.equals(expected)) {
      throw new Error(`style retirement live evidence conflicts: ${projectPath}`);
    }
    if (live) style.remove(file);
    await operations.checkpoint?.(checkpoint);
  }
  style.promoteChildExclusive(
    RETIREMENT_TRANSACTION,
    `.retirement-completed-${descriptor.transactionId}`,
  );
  return true;
}

function parseSelection(bytes: Buffer): StyleSampleSelection {
  try {
    return StyleSampleSelectionSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("style selection evidence is invalid", { cause: error });
  }
}

function selectionBoundLockSha256(
  lock: z.infer<typeof StyleLockSchema>,
  lockBytes: Buffer,
): string {
  return sha256(lock.approvalState === "provisional"
    ? lockBytes
    : canonicalFile({ ...lock, approvalState: "provisional", approvedSample: null }));
}

function selectionChoice(selection: StyleSampleSelection) {
  return selection.schemaVersion === 1 && "styleId" in selection
    ? { kind: "catalog" as const, styleId: selection.styleId }
    : selection.selection;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function selectionMatchesRequest(selection: StyleSampleSelection, request: StyleSelectionRequest): boolean {
  return selection.representativeSlideId === request.representativeSlideId
    && sameJson(selectionChoice(selection), request.selection)
    && (selection.schemaVersion === 1 || selection.projectRevisionId === request.projectRevisionId);
}

function assertLegacySelectionMatchesBeforeRecovery(root: string, request: StyleSelectionRequest): void {
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  try {
    const bytes = readOptional(style, "selection.json");
    if (!bytes) return;
    const selection = parseSelection(bytes);
    if (selection.schemaVersion === 1 && !selectionMatchesRequest(selection, request)) {
      throw new Error("existing legacy style selection conflicts with the authenticated request");
    }
  } finally {
    style.close();
    project.close();
  }
}

/** Retire only exact evidence authenticated by an anchored old-revision snapshot. */
async function retireCoherentStaleEvidence(
  root: string,
  manifest: Awaited<ReturnType<typeof readProject>>,
  operations: StyleSelectionOperations,
): Promise<void> {
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  try {
    if (await resumeRetirementTransaction(root, style, manifest, operations)) return;
    const lockBytes = readOptional(style, "lock.json");
    if (!lockBytes) return;
    let lock;
    try {
      lock = StyleLockSchema.parse(JSON.parse(lockBytes.toString("utf8")));
    } catch (error: unknown) {
      throw new Error("style lock evidence is invalid", { cause: error });
    }
    if (lockBytes.toString("utf8") !== canonicalFile(lock)) {
      throw new Error("style lock evidence is not canonical");
    }
    if (lock.revisionId === manifest.currentRevision.id) return;
    if (lock.projectId !== manifest.projectId) {
      throw new Error("stale style lock belongs to another project");
    }
    const staleIndex = manifest.revisions.findIndex(({ id }) => id === lock.revisionId);
    const currentIndex = manifest.revisions.findIndex(({ id }) => id === manifest.currentRevision.id);
    const child = staleIndex >= 0 ? manifest.revisions[staleIndex + 1] : undefined;
    if (
      staleIndex < 0
      || currentIndex < 0
      || staleIndex >= currentIndex
      || !child
      || child.parentId !== lock.revisionId
      || !child.parentSnapshotDescriptorSha256
    ) throw new Error("stale style lock revision is not a strictly older authenticated project revision");

    const recipeBytes = readOptional(style, "recipe.json");
    if (recipeBytes && (
      recipeBytes.toString("utf8") !== canonicalFile(lock.recipe)
      || sha256(recipeBytes) !== lock.styleRecipeSha256
    )) throw new Error("stale style recipe conflicts with its lock");

    const selectionBytes = readOptional(style, "selection.json");
    const selection = selectionBytes ? parseSelection(selectionBytes) : null;
    if (selection?.schemaVersion === 2 && (
      selection.projectRevisionId !== lock.revisionId
      || selection.styleLockSha256 !== selectionBoundLockSha256(lock, lockBytes)
    )) throw new Error("stale style selection conflicts with its lock");
    if (selection?.schemaVersion !== 2 || !selectionBytes || !recipeBytes) {
      throw new Error("stale style evidence is incomplete and cannot be retired");
    }

    const snapshot = await readRevisionSnapshot(root, lock.revisionId);
    const snapshotStyle = snapshot.manifest.style;
    if (
      snapshot.descriptor.projectId !== manifest.projectId
      || snapshot.manifest.projectId !== manifest.projectId
      || snapshot.descriptor.descriptorSha256 !== child.parentSnapshotDescriptorSha256
      || !snapshotStyle
      || snapshotStyle.path !== "style/selection.json"
      || snapshotStyle.revisionId !== lock.revisionId
      || snapshotStyle.sha256 !== sha256(selectionBytes)
      || !snapshot.artifacts.get("style/selection.json")?.equals(selectionBytes)
      || !snapshot.artifacts.get("style/lock.json")?.equals(lockBytes)
      || !snapshot.artifacts.get("style/recipe.json")?.equals(recipeBytes)
      || snapshot.artifacts.size !== 3
    ) throw new Error("stale style evidence is not bound by its immutable revision snapshot");
    if (
      !readOptional(style, "selection.json")?.equals(selectionBytes)
      || !readOptional(style, "lock.json")?.equals(lockBytes)
      || !readOptional(style, "recipe.json")?.equals(recipeBytes)
    ) throw new Error("stale style evidence changed after snapshot authentication");

    publishRetirementTransaction(style, {
      projectId: manifest.projectId,
      staleRevisionId: lock.revisionId,
      currentRevisionId: manifest.currentRevision.id,
      snapshotDescriptorSha256: snapshot.descriptor.descriptorSha256,
      artifacts: snapshot.artifacts,
    });
    await resumeRetirementTransaction(root, style, manifest, operations);
  } finally {
    style.close();
    project.close();
  }
}

function readAndValidateExistingSelection(
  root: string,
  request: StyleSelectionRequest,
): { bytes: Buffer; selection: StyleSampleSelection } | null {
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  try {
    const bytes = readOptional(style, "selection.json");
    if (!bytes) return null;
    const selection = parseSelection(bytes);
    if (!selectionMatchesRequest(selection, request)) {
      throw new Error("existing style selection conflicts with the authenticated request");
    }
    if (selection.schemaVersion === 2) {
      const lockBytes = readOptional(style, "lock.json");
      const recipeBytes = readOptional(style, "recipe.json");
      if (!lockBytes || !recipeBytes || sha256(lockBytes) !== selection.styleLockSha256) {
        throw new Error("authenticated style selection conflicts with its Style Lock");
      }
    }
    return { bytes, selection };
  } finally {
    style.close();
    project.close();
  }
}

function publishSelection(
  root: string,
  existing: ReturnType<typeof readAndValidateExistingSelection>,
  selection: StyleSampleSelection,
): void {
  if (existing?.selection.schemaVersion === 2) return;
  const project = openGenerationDirectory(root);
  const style = project.child("style", false);
  try {
    const bytes = canonicalFile(selection);
    if (existing) {
      if (!readOptional(style, "selection.json")?.equals(existing.bytes)) {
        throw new Error("style selection changed before authenticated migration");
      }
      style.replace("selection.json", bytes, `.${randomUUID()}.selection`);
    } else {
      style.writeExclusive("selection.json", bytes);
    }
  } finally {
    style.close();
    project.close();
  }
}

export async function authenticateStyleSelection(
  root: string,
  rawRequest: unknown,
  operations: StyleSelectionOperations = {},
): Promise<SelectionResult> {
  const request = StyleSelectionRequestSchema.parse(rawRequest);
  return withGenerationLease(root, async (canonicalRoot) => {
    let manifest = await readProject(canonicalRoot);
    if (manifest.currentRevision.id !== request.projectRevisionId) {
      throw new Error("style selection is stale for the current project revision");
    }
    if (!await assertGateCurrent(canonicalRoot, "slide-specs")) {
      throw new Error("style selection requires the current slide-specs approval");
    }
    const plan = await loadValidatedPlan(canonicalRoot);
    if (!plan.specs.some(({ slideId }) => slideId === request.representativeSlideId)) {
      throw new Error("style selection representative slide is not in the current project revision");
    }

    assertLegacySelectionMatchesBeforeRecovery(canonicalRoot, request);
    await retireCoherentStaleEvidence(canonicalRoot, manifest, operations);
    const existing = readAndValidateExistingSelection(canonicalRoot, request);
    const lock = await createProvisionalStyleLock(canonicalRoot, {
      selection: request.selection,
      referenceArtifacts: request.referenceArtifacts,
      operations: {
        recoverIncomplete: true,
        afterLockPublished: () => operations.checkpoint?.("lock-written"),
      },
    });
    if (existing?.selection.schemaVersion === 2
      && existing.selection.styleLockSha256 !== lock.styleLockSha256) {
      throw new Error("authenticated style selection conflicts with its Style Lock");
    }
    const selection = StyleSampleSelectionSchema.parse({
      schemaVersion: 2,
      projectRevisionId: request.projectRevisionId,
      representativeSlideId: request.representativeSlideId,
      selection: request.selection,
      styleLockSha256: lock.styleLockSha256,
    });
    publishSelection(canonicalRoot, existing, selection);
    await operations.checkpoint?.("selection-written");
    await operations.checkpoint?.("manifest-before-update");

    manifest = await readProject(canonicalRoot);
    if (manifest.currentRevision.id !== request.projectRevisionId) {
      throw new Error("style selection became stale before stage publication");
    }
    const selectionBytes = readAndValidateExistingSelection(canonicalRoot, request)?.bytes;
    if (!selectionBytes) throw new Error("authenticated style selection publication is missing");
    const styleArtifact = {
      path: "style/selection.json",
      sha256: sha256(selectionBytes),
      revisionId: request.projectRevisionId,
    };
    if (manifest.stage !== "style-selection" || !sameJson(manifest.style, styleArtifact)) {
      await updateProject(canonicalRoot, (current) => {
        if (current.currentRevision.id !== request.projectRevisionId) {
          throw new Error("style selection became stale before stage publication");
        }
        return { ...current, stage: "style-selection", style: styleArtifact };
      });
    }
    return {
      stage: "style-selection",
      projectRevisionId: request.projectRevisionId,
      representativeSlideId: request.representativeSlideId,
      styleId: lock.recipe.id,
      styleLockSha256: lock.styleLockSha256,
    };
  });
}
