import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { validateProjectRoot } from "./paths.js";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "./schemas.js";
import { MARKER, writeProject } from "./store.js";

const DIRECTORIES = [
  "source",
  "slides",
  "style/references",
  "style/sample",
  "images",
  "editable",
  "previews",
  "output",
  "failed-runs",
];

async function refuseExistingTarget(root: string): Promise<void> {
  try {
    await lstat(root);
    throw new Error("project directory is not owned by SuperPPT");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function initializeProject(options: {
  root: string;
  title: string;
  idFactory?: () => string;
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
      pdf: null,
      montage: null,
      acceptance: null,
    },
  });

  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, MARKER),
    `${JSON.stringify({
      markerVersion: 1,
      appId: "superppt",
      artifactKind: "project",
    }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  for (const directory of DIRECTORIES) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(
    join(root, "项目状态.md"),
    `# ${options.title}\n\n当前阶段：内容接收\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await writeProject(root, manifest);
  return manifest;
}
