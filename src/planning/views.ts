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
import { promoteExclusive } from "../project/promotion.js";
import { localProjectPath, readOwnedRegularFile } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { loadValidatedPlan } from "./load.js";
import { renderBrief, renderOutline, renderSlideSpec } from "./render.js";
import { StyleSelectionSchema, type StyleSelection } from "./schemas.js";
import { validateStylePublication } from "../styles/publication.js";

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
  selection: StyleSelection;
  prompt: Buffer;
  sample: Buffer;
};

const STYLE_KEYS = [
  "style/selection.json",
  "style/sample/prompt.txt",
  "style/sample/sample.png",
] as const;

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

async function readPlanPointer(root: string): Promise<PlanPublicationDescriptor> {
  const pointer = PlanPublicationDescriptorSchema.parse(JSON.parse(
    (await readOwnedRegularFile(root, "planning-views.json")).toString("utf8"),
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

async function recoverUnlocked(root: string): Promise<void> {
  let pointer: PlanPublicationDescriptor;
  try {
    pointer = await readPlanPointer(root);
  } catch (error: unknown) {
    const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || cause?.code === "ENOENT") return;
    throw error;
  }
  const journalRoot = join(root, ".superppt-view-journals");
  await ensureDirectory(journalRoot);
  const pending = (await readdir(journalRoot)).filter((name) => name.endsWith(".pending.json"));
  if (pending.length === 0) return;
  await updateConvenienceViews(root, await readAuthority(root, pointer));
  for (const name of pending) {
    await rename(join(journalRoot, name), join(journalRoot, name.replace(/\.pending\.json$/, ".completed")));
  }
  await syncDirectory(journalRoot);
}

export async function publishPlanViews(
  root: string,
  options: PublishPlanOptions = {},
): Promise<{ publicationPath: string; slideCount: number }> {
  return withPlanningLock(root, async (canonicalRoot) => {
    return withProjectLease(canonicalRoot, "state", async () => {
      await recoverUnlocked(canonicalRoot);
      const manifest = await readProject(canonicalRoot);
      const plan = await loadValidatedPlan(canonicalRoot);
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
      await writeReplacement(join(canonicalRoot, "planning-views.json"), `${JSON.stringify(pointer, null, 2)}\n`);
      await options.operations?.checkpoint?.("authority-published");
      await updateConvenienceViews(
        canonicalRoot,
        await readAuthority(canonicalRoot, pointer),
        () => options.operations?.checkpoint?.("convenience-written"),
      );
      await rename(pending, join(journalRoot, `${publicationId}.completed`));
      await syncDirectory(journalRoot);
      return { publicationPath, slideCount: plan.specs.length };
    });
  }, options.lock);
}

async function styleArtifacts(root: string): Promise<{
  values: Record<string, Buffer>;
  selection: StyleSelection;
}> {
  const plan = await loadValidatedPlan(root);
  const values = Object.fromEntries(await Promise.all(STYLE_KEYS.map(async (path) => [path, await readOwnedRegularFile(root, path)])));
  const selection = StyleSelectionSchema.parse(JSON.parse(values[STYLE_KEYS[0]]!.toString("utf8")));
  if (!values[STYLE_KEYS[1]]!.toString("utf8").trim()) throw new Error("style sample prompt must not be empty");
  const sample = values[STYLE_KEYS[2]]!;
  await validateStylePublication(plan.specs, selection, sample);
  return { values, selection };
}

export async function publishStyleSample(root: string): Promise<StylePublicationDescriptor> {
  return withPlanningLock(root, async (canonicalRoot) => {
    return withProjectLease(canonicalRoot, "state", async () => {
      const manifest = await readProject(canonicalRoot);
      const { values, selection } = await styleArtifacts(canonicalRoot);
      const publicationId = randomUUID();
      const publicationPath = `revisions/${manifest.currentRevision.id}/style-samples/${publicationId}`;
      const pointer = StylePublicationDescriptorSchema.parse(addDescriptorIntegrity({
        schemaVersion: 1 as const,
        kind: "style-sample" as const,
        projectId: manifest.projectId,
        revisionId: manifest.currentRevision.id,
        publicationId,
        publicationPath,
        styleId: selection.styleId,
        representativeSlideId: selection.representativeSlideId,
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
  });
}

export async function readPublishedPlanViews(root: string): Promise<PublishedPlanViews> {
  await readProject(root);
  return readAuthority(root, await readPlanPointer(root));
}

export async function readPublishedStyleSample(root: string): Promise<PublishedStyleSample> {
  await readProject(root);
  const descriptor = await readStylePointer(root);
  const selection = StyleSelectionSchema.parse(JSON.parse(
    (await readOwnedRegularFile(root, `${descriptor.publicationPath}/sources/${STYLE_KEYS[0]}`)).toString("utf8"),
  ));
  return {
    descriptor,
    selection,
    prompt: await readOwnedRegularFile(root, `${descriptor.publicationPath}/sources/${STYLE_KEYS[1]}`),
    sample: await readOwnedRegularFile(root, `${descriptor.publicationPath}/sources/${STYLE_KEYS[2]}`),
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

export async function recoverPlanViews(root: string, lock: ProjectLockOptions = {}): Promise<void> {
  await withPlanningLock(root, recoverUnlocked, lock);
}
