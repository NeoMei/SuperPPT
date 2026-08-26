import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withPlanningLock, type ProjectLockOptions } from "../project/lock.js";
import { promoteExclusive } from "../project/promotion.js";
import { localProjectPath, readOwnedRegularFile } from "../project/safe-file.js";
import { readProject, sha256 } from "../project/store.js";
import { loadValidatedPlan } from "./load.js";
import { renderBrief, renderOutline, renderSlideSpec } from "./render.js";

export type ViewCheckpoint = "snapshot-published" | "authority-published" | "convenience-written";
export type PublishPlanOptions = {
  operations?: {
    checkpoint?: (step: ViewCheckpoint) => Promise<void> | void;
  };
  lock?: ProjectLockOptions;
};

export type PublishedPlanViews = {
  publicationPath: string;
  brief: string;
  outline: string;
  slides: Record<string, string>;
};

const PointerSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().uuid(),
  publicationId: z.string().uuid(),
  publicationPath: z.string().startsWith("revisions/"),
  viewHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  publishedAt: z.string().datetime(),
}).strict();

type Pointer = z.infer<typeof PointerSchema>;

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`unsafe planning view directory: ${path}`);
  }
}

async function ensurePublicationParent(root: string, revisionId: string): Promise<string> {
  let cursor = root;
  for (const part of ["revisions", revisionId, "planning-views"]) {
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

async function readPointer(root: string): Promise<Pointer> {
  return PointerSchema.parse(JSON.parse(
    (await readOwnedRegularFile(root, "planning-views.json")).toString("utf8"),
  ));
}

async function readAuthority(root: string, pointer: Pointer): Promise<PublishedPlanViews> {
  const result: PublishedPlanViews = {
    publicationPath: pointer.publicationPath,
    brief: "",
    outline: "",
    slides: {},
  };
  for (const [path, expected] of Object.entries(pointer.viewHashes)) {
    const bytes = await readOwnedRegularFile(root, `${pointer.publicationPath}/${path}`);
    if (sha256(bytes) !== expected) throw new Error(`published planning view hash mismatch: ${path}`);
    const value = bytes.toString("utf8");
    if (path === "brief.md") result.brief = value;
    else if (path === "outline.md") result.outline = value;
    else {
      const match = /^slides\/([0-9a-f-]{36})\/spec\.md$/.exec(path);
      if (!match) throw new Error(`unknown planning view path: ${path}`);
      result.slides[match[1]!] = value;
    }
  }
  if (!result.brief || !result.outline) throw new Error("published planning view set is incomplete");
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
  let pointer: Pointer;
  try {
    pointer = await readPointer(root);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).cause && ((error as { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT")) return;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
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
    await recoverUnlocked(canonicalRoot);
    const manifest = await readProject(canonicalRoot);
    const plan = await loadValidatedPlan(canonicalRoot);
    const publicationId = randomUUID();
    const publicationPath = `revisions/${manifest.currentRevision.id}/planning-views/${publicationId}`;
    const parent = await ensurePublicationParent(canonicalRoot, manifest.currentRevision.id);
    const staging = join(parent, `.${publicationId}.staging`);
    await mkdir(staging, { mode: 0o700 });
    const views: Record<string, string> = {
      "brief.md": renderBrief(plan.brief),
      "outline.md": renderOutline(plan.outline),
    };
    plan.specs.forEach((value) => {
      views[`slides/${value.slideId}/spec.md`] = renderSlideSpec(value);
    });
    const directories = new Set<string>([staging]);
    for (const [path, value] of Object.entries(views)) {
      const destination = join(staging, localProjectPath(path));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      let cursor = dirname(destination);
      while (cursor.startsWith(staging) && cursor !== staging) {
        directories.add(cursor);
        cursor = dirname(cursor);
      }
      await writeDurableExclusive(destination, value);
    }
    const viewHashes = Object.fromEntries(
      Object.entries(views).map(([path, value]) => [path, sha256(value)]),
    );
    const pointer = PointerSchema.parse({
      schemaVersion: 1,
      revisionId: manifest.currentRevision.id,
      publicationId,
      publicationPath,
      viewHashes,
      publishedAt: new Date().toISOString(),
    });
    await writeDurableExclusive(join(staging, "publication.json"), `${JSON.stringify(pointer, null, 2)}\n`);
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await syncDirectory(directory);
    }
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
  }, options.lock);
}

export async function readPublishedPlanViews(root: string): Promise<PublishedPlanViews> {
  await readProject(root);
  return readAuthority(root, await readPointer(root));
}

export async function recoverPlanViews(root: string, lock: ProjectLockOptions = {}): Promise<void> {
  await withPlanningLock(root, recoverUnlocked, lock);
}
