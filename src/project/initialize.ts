import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { syncDirectory, writeDurableExclusive } from "./durable.js";
import { validateProjectRoot } from "./paths.js";
import { promoteExclusive } from "./exclusive.js";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "./schemas.js";
import {
  createOwnershipMarker,
  MANIFEST,
  MARKER,
} from "./store.js";

const DIRECTORIES = [
  "source",
  "slides",
  "style/references",
  "style/sample",
  "images",
  "editable",
  "output",
  "failed-runs",
  "revisions",
];

export type InitializeCheckpoint =
  | "marker-written"
  | "directories-created"
  | "status-written"
  | "manifest-synced"
  | "before-promote";

export type InitializeOperations = {
  checkpoint?: (
    step: InitializeCheckpoint,
    stagingRoot: string,
  ) => Promise<void> | void;
  beforeExclusivePromote?: (
    stagingRoot: string,
    finalRoot: string,
  ) => Promise<void> | void;
  promote?: (stagingRoot: string, finalRoot: string) => Promise<void>;
};

async function refuseExistingTarget(root: string): Promise<void> {
  try {
    await lstat(root);
    throw new Error("project directory is not owned by SuperPPT");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function retainFailedInitialization(
  stagingRoot: string,
  finalRoot: string,
  promoted: boolean,
  failedRun: string,
  parent: string,
): Promise<void> {
  let source = promoted ? finalRoot : stagingRoot;
  try {
    await lstat(source);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (promoted) return;
    source = finalRoot;
    try {
      await lstat(source);
    } catch (finalError: unknown) {
      if ((finalError as NodeJS.ErrnoException).code === "ENOENT") return;
      throw finalError;
    }
  }
  await rename(source, failedRun);
  await syncDirectory(parent);
}

async function syncWorkspaceDirectories(stagingRoot: string): Promise<void> {
  const directories = [
    ...DIRECTORIES.map((directory) => join(stagingRoot, directory)),
    join(stagingRoot, "style"),
    stagingRoot,
  ].sort((left, right) => right.length - left.length);
  for (const directory of directories) await syncDirectory(directory);
}

export async function initializeProject(options: {
  root: string;
  title: string;
  idFactory?: () => string;
  operations?: InitializeOperations;
}): Promise<ProjectManifest> {
  const root = await validateProjectRoot(options.root);
  await refuseExistingTarget(root);

  const now = new Date().toISOString();
  const revisionId = randomUUID();
  const manifest = ProjectManifestSchema.parse({
    schemaVersion: 1,
    projectId: options.idFactory?.() ?? randomUUID(),
    title: options.title,
    stage: "intake",
    currentRevision: {
      id: revisionId,
      number: 1,
      createdAt: now,
      parentId: null,
    },
    revisions: [{
      id: revisionId,
      number: 1,
      createdAt: now,
      parentId: null,
    }],
    gates: [],
    brief: null,
    outline: null,
    style: null,
    slides: [],
    exports: {
      pptx: null,
      acceptance: null,
    },
  });

  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  await validateProjectRoot(root);
  await refuseExistingTarget(root);

  const runId = randomUUID();
  const stagingRoot = join(
    parent,
    `.${basename(root)}.superppt-init-${runId}.staging`,
  );
  const failedRun = join(
    parent,
    `.${basename(root)}.superppt-init-${runId}.failed-run`,
  );
  await mkdir(stagingRoot, { mode: 0o700 });

  let promoted = false;
  try {
    const marker = createOwnershipMarker(manifest.projectId, root);
    await writeDurableExclusive(
      join(stagingRoot, MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
    );
    await options.operations?.checkpoint?.("marker-written", stagingRoot);

    for (const directory of DIRECTORIES) {
      await mkdir(join(stagingRoot, directory), { recursive: true });
    }
    await options.operations?.checkpoint?.("directories-created", stagingRoot);

    await writeDurableExclusive(
      join(stagingRoot, "项目状态.md"),
      `# ${options.title}\n\n当前阶段：内容接收\n`,
    );
    await options.operations?.checkpoint?.("status-written", stagingRoot);

    await writeDurableExclusive(
      join(stagingRoot, MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await options.operations?.checkpoint?.("manifest-synced", stagingRoot);
    await syncWorkspaceDirectories(stagingRoot);
    await syncDirectory(parent);
    await options.operations?.checkpoint?.("before-promote", stagingRoot);

    await options.operations?.beforeExclusivePromote?.(stagingRoot, root);
    await (options.operations?.promote ?? promoteExclusive)(stagingRoot, root);
    promoted = true;
    await syncDirectory(parent);
    return manifest;
  } catch (error: unknown) {
    try {
      await retainFailedInitialization(
        stagingRoot,
        root,
        promoted,
        failedRun,
        parent,
      );
    } catch (evidenceError: unknown) {
      throw new AggregateError(
        [error, evidenceError],
        "initialization failed and failed-run evidence could not be promoted",
      );
    }
    throw error;
  }
}
