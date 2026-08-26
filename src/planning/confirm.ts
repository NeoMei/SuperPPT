import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { readProject, sha256, writeProject } from "../project/store.js";

export type PlanningGate = "outline" | "slide-specs" | "style-sample";

const previous: Record<PlanningGate, PlanningGate | null> = {
  outline: null,
  "slide-specs": "outline",
  "style-sample": "slide-specs",
};

function assertPlanningGate(gate: string): asserts gate is PlanningGate {
  if (!(gate in previous)) throw new Error(`invalid planning gate: ${gate}`);
}

function insideProject(projectPath: string): boolean {
  return projectPath !== ""
    && !projectPath.startsWith("..")
    && !isAbsolute(projectPath);
}

async function artifactHashes(
  root: string,
  paths: string[],
): Promise<Record<string, string>> {
  if (paths.length === 0) throw new Error("gate requires at least one artifact");
  const canonicalRoot = await realpath(root);
  const entries = await Promise.all(paths.map(async (path) => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`gate artifact must be a regular file: ${path}`);
    }
    const canonicalPath = await realpath(path);
    const projectPath = relative(canonicalRoot, canonicalPath);
    if (!insideProject(projectPath)) {
      throw new Error(`gate artifact is outside project: ${path}`);
    }
    return [projectPath, sha256(await readFile(canonicalPath))] as const;
  }));
  if (new Set(entries.map(([path]) => path)).size !== entries.length) {
    throw new Error("gate artifacts must be unique");
  }
  return Object.fromEntries(entries);
}

async function artifactIsCurrent(
  root: string,
  projectPath: string,
  expected: string,
): Promise<boolean> {
  if (!insideProject(projectPath)) return false;
  try {
    const canonicalRoot = await realpath(root);
    const candidate = resolve(canonicalRoot, projectPath);
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    const canonicalPath = await realpath(candidate);
    if (relative(canonicalRoot, canonicalPath) !== projectPath) return false;
    return sha256(await readFile(canonicalPath)) === expected;
  } catch {
    return false;
  }
}

export async function assertGateCurrent(
  root: string,
  gate: PlanningGate,
): Promise<boolean> {
  assertPlanningGate(gate);
  const manifest = await readProject(root);
  const required = previous[gate];
  if (required && !await assertGateCurrent(root, required)) return false;
  const approved = [...manifest.gates]
    .reverse()
    .find((item) => item.gate === gate);
  if (!approved || Object.keys(approved.artifactHashes).length === 0) return false;
  return (await Promise.all(
    Object.entries(approved.artifactHashes).map(([path, expected]) =>
      artifactIsCurrent(root, path, expected)
    ),
  )).every(Boolean);
}

export async function approveGate(
  root: string,
  gate: PlanningGate,
  artifactPaths: string[],
): Promise<void> {
  assertPlanningGate(gate);
  const required = previous[gate];
  if (required && !await assertGateCurrent(root, required)) {
    throw new Error(`${required} gate must be current`);
  }
  const manifest = await readProject(root);
  const hashes = await artifactHashes(root, artifactPaths);
  await writeProject(root, {
    ...manifest,
    gates: [...manifest.gates, {
      gate,
      revisionId: manifest.currentRevision.id,
      artifactHashes: hashes,
      confirmedAt: new Date().toISOString(),
    }],
  });
}
