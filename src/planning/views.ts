import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import {
  addDescriptorIntegrity,
  PlanPublicationDescriptorSchema,
  type PlanPublicationDescriptor,
  type PresentationBinding,
  sha256Evidence,
  StylePublicationDescriptorSchema,
  type StylePublicationDescriptor,
  validatePlanPublicationEvidence,
  validateStylePublicationEvidence,
} from "../project/evidence.js";
import { withPlanningLock, withProjectLease, type ProjectLockOptions } from "../project/lock.js";
import { promoteExclusive } from "../project/exclusive.js";
import { localProjectPath, readOwnedRegularFile } from "../project/safe-file.js";
import { assertProjectMutationNotFrozen, readProject } from "../project/store.js";
import { loadValidatedOutline, loadValidatedPlan } from "./load.js";
import { renderBrief, renderOutline, renderSlideSpec } from "./render.js";
import {
  lockSelection,
  representativeSlideId,
  readStyleSampleArtifacts,
  STYLE_SAMPLE_ARTIFACTS,
  type StyleSampleArtifacts,
  validateCanonicalStyleSample,
} from "../styles/sample-contract.js";
import { assertFinalizedStyleSample } from "../generation/style-sample.js";
import { withGenerationLease } from "../generation/lease.js";
import { resolveStyleRecipe } from "../styles/catalog.js";
import { readStyleLockIfPresent } from "../styles/style-lock.js";
import { StyleSampleSelectionSchema, type StyleSampleSelection } from "../styles/schemas.js";

export type ViewCheckpoint = "snapshot-published" | "authority-published" | "convenience-written";
export type PublishPlanOptions = {
  operations?: { checkpoint?: (step: ViewCheckpoint) => Promise<void> | void };
  lock?: ProjectLockOptions;
};
export type PublishedPlanViews = {
  publicationPath: string;
  brief: string;
  outline: string;
  slides: Record<string, string>;
};
export type PublishedStyleSample = {
  descriptor: StylePublicationDescriptor;
  selection: StyleSampleSelection;
  prompt: Buffer;
  sample: Buffer;
  nextActions: readonly ["keep-style", "revise-style-recipe", "authorize-new-sample"];
};

const STYLE_SAMPLE_NEXT_ACTIONS = ["keep-style", "revise-style-recipe", "authorize-new-sample"] as const;

const STYLE_KEYS = STYLE_SAMPLE_ARTIFACTS;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe publication directory: ${path}`);
}

async function ensurePublicationParent(root: string, revisionId: string, kind: string): Promise<string> {
  let cursor = root;
  for (const part of ["revisions", revisionId, kind]) {
    cursor = join(cursor, part);
    await ensureDirectory(cursor);
  }
  return cursor;
}

async function writeReplacement(path: string, value: string): Promise<void> {
  const staging = join(dirname(path), `.superppt-${randomUUID()}.replacement`);
  await writeDurableExclusive(staging, value);
  await rename(staging, path);
  await syncDirectory(dirname(path));
}

async function writeEvidenceTree(
  staging: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  const directories = new Set<string>([staging]);
  for (const [path, value] of Object.entries(files)) {
    const destination = join(staging, localProjectPath(path));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    let cursor = dirname(destination);
    while (cursor.startsWith(staging) && cursor !== staging) {
      directories.add(cursor);
      cursor = dirname(cursor);
    }
    await writeDurableExclusive(destination, value);
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
}

async function readPlanPointer(
  root: string,
  pointerPath = "planning-views.json",
): Promise<PlanPublicationDescriptor> {
  const pointer = PlanPublicationDescriptorSchema.parse(JSON.parse(
    (await readOwnedRegularFile(root, pointerPath)).toString("utf8"),
  ));
  const immutable = await validatePlanPublicationEvidence(root, pointer.publicationPath);
  if (!sameJson(pointer, immutable)) throw new Error("planning publication descriptor identity mismatch");
  return pointer;
}

async function readStylePointer(root: string): Promise<StylePublicationDescriptor> {
  const pointer = StylePublicationDescriptorSchema.parse(JSON.parse(
    (await readOwnedRegularFile(root, "style-sample.json")).toString("utf8"),
  ));
  const immutable = await validateStylePublicationEvidence(root, pointer.publicationPath);
  if (!sameJson(pointer, immutable)) throw new Error("style publication descriptor identity mismatch");
  return pointer;
}

async function readAuthority(root: string, pointer: PlanPublicationDescriptor): Promise<PublishedPlanViews> {
  const validated = await validatePlanPublicationEvidence(root, pointer.publicationPath);
  if (!sameJson(pointer, validated)) throw new Error("planning publication descriptor identity mismatch");
  const result: PublishedPlanViews = { publicationPath: pointer.publicationPath, brief: "", outline: "", slides: {} };
  for (const [path, expected] of Object.entries(pointer.viewHashes)) {
    const bytes = await readOwnedRegularFile(root, `${pointer.publicationPath}/${path}`);
    if (sha256Evidence(bytes) !== expected) throw new Error(`published planning view hash mismatch: ${path}`);
    const value = bytes.toString("utf8");
    if (path === "brief.md") result.brief = value;
    else if (path === "outline.md") result.outline = value;
    else {
      const match = /^slides\/([0-9a-f-]{36})\/spec\.md$/.exec(path);
      if (!match) throw new Error(`unknown planning view path: ${path}`);
      result.slides[match[1]!] = value;
    }
  }
  return result;
}

async function updateConvenienceViews(
  root: string,
  views: PublishedPlanViews,
  afterWrite?: () => Promise<void> | void,
): Promise<void> {
  await writeReplacement(join(root, "brief.md"), views.brief);
  await afterWrite?.();
  await writeReplacement(join(root, "outline.md"), views.outline);
  await afterWrite?.();
  for (const [slideId, value] of Object.entries(views.slides)) {
    await writeReplacement(join(root, "slides", slideId, "spec.md"), value);
    await afterWrite?.();
  }
}

async function recoverUnlocked(
  root: string,
  pointerPath = "planning-views.json",
  journalName = ".superppt-view-journals",
): Promise<void> {
  let pointer: PlanPublicationDescriptor;
  try {
    pointer = await readPlanPointer(root, pointerPath);
  } catch (error: unknown) {
    const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || cause?.code === "ENOENT") return;
    throw error;
  }
  const journalRoot = join(root, journalName);
  await ensureDirectory(journalRoot);
  const pending = (await readdir(journalRoot)).filter((name) => name.endsWith(".pending.json"));
  if (pending.length === 0) return;
  await updateConvenienceViews(root, await readAuthority(root, pointer));
  for (const name of pending) {
    await rename(join(journalRoot, name), join(journalRoot, name.replace(/\.pending\.json$/, ".completed")));
  }
  await syncDirectory(journalRoot);
}

async function publishPlanningViews(
  root: string,
  stage: "outline" | "slide-specs",
  options: PublishPlanOptions = {},
): Promise<{ publicationPath: string; slideCount: number }> {
  const pointerPath = stage === "outline" ? "outline-views.json" : "planning-views.json";
  const journalName = stage === "outline" ? ".superppt-outline-view-journals" : ".superppt-view-journals";
  return withGenerationLease(root, (generationRoot) => withPlanningLock(generationRoot, async (canonicalRoot) => {
    await assertProjectMutationNotFrozen(canonicalRoot);
    return withProjectLease(canonicalRoot, "state", async () => {
      await recoverUnlocked(canonicalRoot, pointerPath, journalName);
      const manifest = await readProject(canonicalRoot);
      const plan = stage === "outline"
        ? { ...(await loadValidatedOutline(canonicalRoot)), specs: [] }
        : await loadValidatedPlan(canonicalRoot);
      const publicationId = randomUUID();
      const publicationPath = `revisions/${manifest.currentRevision.id}/planning-views/${publicationId}`;
      const views: Record<string, string> = {
        "brief.md": renderBrief(plan.brief),
        "outline.md": renderOutline(plan.outline),
      };
      plan.specs.forEach((value) => { views[`slides/${value.slideId}/spec.md`] = renderSlideSpec(value); });
      const sourceHashes = Object.fromEntries(Object.entries(plan.artifacts).map(([path, value]) => [path, sha256Evidence(value)]));
      const viewHashes = Object.fromEntries(Object.entries(views).map(([path, value]) => [path, sha256Evidence(value)]));
      const pointer = PlanPublicationDescriptorSchema.parse(addDescriptorIntegrity({
        schemaVersion: 1 as const,
        kind: "planning-views" as const,
        projectId: manifest.projectId,
        revisionId: manifest.currentRevision.id,
        publicationId,
        publicationPath,
        outlineSlideIds: [...plan.outline.slides].sort((a, b) => a.order - b.order).map((slide) => slide.id),
        sourceHashes,
        viewHashes,
        publishedAt: new Date().toISOString(),
      }));
      const files: Record<string, string | Buffer> = {
        ...views,
        ...Object.fromEntries(Object.entries(plan.artifacts).map(([path, value]) => [`sources/${path}`, value])),
        "publication.json": `${JSON.stringify(pointer, null, 2)}\n`,
      };
      const parent = await ensurePublicationParent(canonicalRoot, manifest.currentRevision.id, "planning-views");
      const staging = join(parent, `.${publicationId}.staging`);
      await mkdir(staging, { mode: 0o700 });
      await writeEvidenceTree(staging, files);
      await syncDirectory(parent);
      await promoteExclusive(staging, join(canonicalRoot, localProjectPath(publicationPath)));
      await syncDirectory(parent);
      await options.operations?.checkpoint?.("snapshot-published");

      const journalRoot = join(canonicalRoot, ".superppt-view-journals");
      await ensureDirectory(journalRoot);
      const pending = join(journalRoot, `${publicationId}.pending.json`);
      await writeDurableExclusive(pending, `${JSON.stringify(pointer, null, 2)}\n`);
      await syncDirectory(journalRoot);
      await writeReplacement(join(canonicalRoot, pointerPath), `${JSON.stringify(pointer, null, 2)}\n`);
      await options.operations?.checkpoint?.("authority-published");
      await updateConvenienceViews(
        canonicalRoot,
        await readAuthority(canonicalRoot, pointer),
        () => options.operations?.checkpoint?.("convenience-written"),
      );
      await rename(pending, join(journalRoot, `${publicationId}.completed`));
      await syncDirectory(journalRoot);
      return { publicationPath, slideCount: plan.outline.slides.length };
    });
  }, options.lock));
}

export async function publishOutlineViews(
  root: string,
  options: PublishPlanOptions = {},
): Promise<{ publicationPath: string; slideCount: number }> {
  return publishPlanningViews(root, "outline", options);
}

export async function publishPlanViews(
  root: string,
  options: PublishPlanOptions = {},
): Promise<{ publicationPath: string; slideCount: number }> {
  return publishPlanningViews(root, "slide-specs", options);
}

async function styleArtifacts(root: string): Promise<{
  values: StyleSampleArtifacts;
  selection: StyleSampleSelection;
}> {
  const values = await readStyleSampleArtifacts(root);
  const selection = StyleSampleSelectionSchema.parse(JSON.parse(values[STYLE_KEYS[0]]!.toString("utf8")));
  await validateCanonicalStyleSample(root, values);
  return { values, selection };
}

export async function publishStyleSample(root: string): Promise<StylePublicationDescriptor> {
  return withGenerationLease(root, (generationRoot) => withPlanningLock(generationRoot, async (canonicalRoot) => {
    await assertProjectMutationNotFrozen(canonicalRoot);
    return withProjectLease(canonicalRoot, "state", async () => {
      const manifest = await readProject(canonicalRoot);
      const { values, selection } = await styleArtifacts(canonicalRoot);
      const styleLock = await readStyleLockIfPresent(canonicalRoot);
      await assertFinalizedStyleSample(canonicalRoot, values);
      const recipe = styleLock?.recipe
        ?? await resolveStyleRecipe(lockSelection(selection));
      const publicationId = randomUUID();
      const publicationPath = `revisions/${manifest.currentRevision.id}/style-samples/${publicationId}`;
      const pointer = StylePublicationDescriptorSchema.parse(addDescriptorIntegrity({
        schemaVersion: 1 as const,
        kind: "style-sample" as const,
        projectId: manifest.projectId,
        revisionId: manifest.currentRevision.id,
        publicationId,
        publicationPath,
        styleId: recipe.id,
        representativeSlideId: representativeSlideId(selection),
        sourceHashes: Object.fromEntries(Object.entries(values).map(([path, value]) => [path, sha256Evidence(value)])),
        publishedAt: new Date().toISOString(),
      }));
      const parent = await ensurePublicationParent(canonicalRoot, manifest.currentRevision.id, "style-samples");
      const staging = join(parent, `.${publicationId}.staging`);
      await mkdir(staging, { mode: 0o700 });
      await writeEvidenceTree(staging, {
        ...Object.fromEntries(Object.entries(values).map(([path, value]) => [`sources/${path}`, value])),
        "publication.json": `${JSON.stringify(pointer, null, 2)}\n`,
      });
      await syncDirectory(parent);
      await promoteExclusive(staging, join(canonicalRoot, localProjectPath(publicationPath)));
      await syncDirectory(parent);
      await writeReplacement(join(canonicalRoot, "style-sample.json"), `${JSON.stringify(pointer, null, 2)}\n`);
      return pointer;
    });
  }));
}

export async function readPublishedPlanViews(root: string): Promise<PublishedPlanViews> {
  await readProject(root);
  return readAuthority(root, await readPlanPointer(root));
}

export async function readPublishedOutlineViews(root: string): Promise<PublishedPlanViews> {
  await readProject(root);
  return readAuthority(root, await readPlanPointer(root, "outline-views.json"));
}

export async function readPublishedStyleSample(root: string): Promise<PublishedStyleSample> {
  await readProject(root);
  const descriptor = await readStylePointer(root);
  const selection = StyleSampleSelectionSchema.parse(JSON.parse(
    (await readOwnedRegularFile(root, `${descriptor.publicationPath}/sources/${STYLE_KEYS[0]}`)).toString("utf8"),
  ));
  return {
    descriptor,
    selection,
    prompt: await readOwnedRegularFile(root, `${descriptor.publicationPath}/sources/${STYLE_KEYS[2]}`),
    sample: await readOwnedRegularFile(root, `${descriptor.publicationPath}/sources/${STYLE_KEYS[3]}`),
    nextActions: STYLE_SAMPLE_NEXT_ACTIONS,
  };
}

export async function requireCurrentPlanPresentation(
  root: string,
  artifactHashes: Record<string, string>,
): Promise<PresentationBinding> {
  let pointer: PlanPublicationDescriptor;
  try {
    pointer = await readPlanPointer(root);
  } catch (error: unknown) {
    throw new Error("authoritative planning publication is required", { cause: error });
  }
  const manifest = await readProject(root);
  if (pointer.projectId !== manifest.projectId || pointer.revisionId !== manifest.currentRevision.id) {
    throw new Error("authoritative planning publication does not match current project revision");
  }
  for (const [path, expected] of Object.entries(artifactHashes)) {
    if (pointer.sourceHashes[path] !== expected) {
      throw new Error("gate artifacts do not match authoritative planning publication");
    }
  }
  return { kind: "planning-views", publicationPath: pointer.publicationPath, descriptorSha256: pointer.descriptorSha256 };
}

export async function requireCurrentOutlinePresentation(
  root: string,
  artifactHashes: Record<string, string>,
): Promise<PresentationBinding> {
  let pointer: PlanPublicationDescriptor;
  try {
    pointer = await readPlanPointer(root, "outline-views.json");
  } catch (error: unknown) {
    throw new Error("authoritative planning publication is required for outline", { cause: error });
  }
  const manifest = await readProject(root);
  if (pointer.projectId !== manifest.projectId || pointer.revisionId !== manifest.currentRevision.id) {
    throw new Error("authoritative planning publication for outline does not match current project revision");
  }
  if (
    !sameJson(Object.keys(pointer.sourceHashes).sort(), ["brief.json", "outline.json"])
    || !sameJson(Object.keys(pointer.viewHashes).sort(), ["brief.md", "outline.md"])
  ) throw new Error("authoritative planning publication for outline has invalid coverage");
  for (const [path, expected] of Object.entries(artifactHashes)) {
    if (pointer.sourceHashes[path] !== expected) {
      throw new Error("gate artifacts do not match authoritative planning publication for outline");
    }
  }
  return { kind: "planning-views", publicationPath: pointer.publicationPath, descriptorSha256: pointer.descriptorSha256 };
}

export async function requireCurrentStylePresentation(
  root: string,
  artifactHashes: Record<string, string>,
): Promise<PresentationBinding> {
  let pointer: StylePublicationDescriptor;
  try {
    pointer = await readStylePointer(root);
  } catch (error: unknown) {
    throw new Error("authoritative style sample publication is required", { cause: error });
  }
  const manifest = await readProject(root);
  if (pointer.projectId !== manifest.projectId || pointer.revisionId !== manifest.currentRevision.id) {
    throw new Error("authoritative style sample publication does not match current project revision");
  }
  for (const [path, expected] of Object.entries(artifactHashes)) {
    if (pointer.sourceHashes[path] !== expected) {
      throw new Error("gate artifacts do not match authoritative style sample publication");
    }
  }
  return { kind: "style-sample", publicationPath: pointer.publicationPath, descriptorSha256: pointer.descriptorSha256 };
}

async function requireCurrentArtifactPresentation(
  root: string,
  kind: "generation-plan" | "deck-review",
  publicationPath: "generation/authorization-plan.json" | "output/candidates/current/review.json",
  artifactHashes: Record<string, string>,
): Promise<PresentationBinding> {
  const expected = kind === "generation-plan"
    ? ["generation/authorization-plan.json"]
    : [
      "output/candidates/current/action.json",
      "output/candidates/current/montage.jpg",
      "output/candidates/current/review.json",
    ];
  if (!sameJson(Object.keys(artifactHashes).sort(), expected)) {
    throw new Error("gate artifacts do not match authoritative publication");
  }
  const bytes = await readOwnedRegularFile(root, publicationPath);
  const descriptorSha256 = sha256Evidence(bytes);
  if (artifactHashes[publicationPath] !== descriptorSha256) {
    throw new Error("gate artifacts do not match authoritative publication");
  }
  return { kind, publicationPath, descriptorSha256 };
}

export async function requireCurrentGenerationPlanPresentation(
  root: string,
  artifactHashes: Record<string, string>,
): Promise<PresentationBinding> {
  return requireCurrentArtifactPresentation(
    root,
    "generation-plan",
    "generation/authorization-plan.json",
    artifactHashes,
  );
}

export async function requireCurrentDeckReviewPresentation(
  root: string,
  artifactHashes: Record<string, string>,
): Promise<PresentationBinding> {
  return requireCurrentArtifactPresentation(
    root,
    "deck-review",
    "output/candidates/current/review.json",
    artifactHashes,
  );
}

export async function recoverPlanViews(root: string, lock: ProjectLockOptions = {}): Promise<void> {
  await withGenerationLease(root, (generationRoot) => withPlanningLock(generationRoot, (canonicalRoot) =>
    withProjectLease(canonicalRoot, "state", async () => {
      await assertProjectMutationNotFrozen(canonicalRoot);
      await recoverUnlocked(canonicalRoot);
    }, lock), lock));
}
