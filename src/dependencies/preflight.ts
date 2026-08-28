import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DependencyPreflight,
  LegacyPreflightReport,
  LegacyResolvedDependencies,
  ResolvedDependencies,
} from "./schemas.js";

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function currentSha256(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

function changed(expected: string, actual: string | null): boolean {
  return actual === null || actual !== expected;
}

export async function preflightDependencies(
  resolved: ResolvedDependencies,
): Promise<DependencyPreflight> {
  const errors: DependencyPreflight["errors"] = [];
  const observedScripts = Object.fromEntries(await Promise.all(Object.entries(resolved.ai.scripts).map(async ([name, path]) => [
    name,
    await currentSha256(path),
  ])));
  const requiredScripts = Object.fromEntries(Object.entries(resolved.ai.scripts).map(([name, path]) => [
    name,
    { path, sha256: observedScripts[name] ?? resolved.integrity.aiScripts[name as keyof typeof resolved.integrity.aiScripts] },
  ]));
  const aiFilesChanged = changed(resolved.integrity.aiSkillSha256, await currentSha256(resolved.ai.skillFile))
    || Object.entries(resolved.ai.scripts).some(([name, path]) => changed(
      resolved.integrity.aiScripts[name as keyof typeof resolved.integrity.aiScripts],
      observedScripts[name] ?? null,
    ));
  if (aiFilesChanged) {
    errors.push({
      dependency: "ai-image-to-ppt",
      code: "identity_changed",
      safeMessage: "required Skill files changed after resolution",
    });
  }
  if (changed(resolved.integrity.editableSkillSha256, await currentSha256(resolved.editable.skillFile))) {
    errors.push({
      dependency: "image-to-editable-pptx",
      code: "identity_changed",
      safeMessage: "required Skill files changed after resolution",
    });
  }
  return {
    ok: errors.length === 0,
    aiImageToPpt: {
      root: resolved.ai.root,
      skillSha256: resolved.ai.skillSha256,
      gitRevision: resolved.ai.gitRevision,
      requiredScripts,
    },
    imageToEditablePptx: {
      root: resolved.editable.root,
      skillSha256: resolved.editable.skillSha256,
      version: resolved.editable.version,
    },
    errors,
  };
}

/** @deprecated Kept only while generation callers migrate away from provider discovery. */
export async function preflightLegacyDependencies(
  resolved: LegacyResolvedDependencies,
): Promise<LegacyPreflightReport> {
  const problems: string[] = [];
  for (const provider of resolved.ai.providers) {
    if (!await readable(join(resolved.ai.root, provider.module))) {
      problems.push(`provider module is unreadable: ${provider.module}`);
    }
  }
  const reviewerAvailable = resolved.ai.reviewer !== null
    && await readable(join(resolved.ai.root, resolved.ai.reviewer.module));
  if (resolved.ai.reviewer && !reviewerAvailable) {
    problems.push(`reviewer module is unreadable: ${resolved.ai.reviewer.module}`);
  }
  if (!await readable(join(resolved.editable.root, "package-lock.json"))) {
    problems.push("image-to-editable-pptx package-lock.json is missing");
  }
  return {
    ok: problems.length === 0,
    aiRoot: resolved.ai.root,
    editableRoot: resolved.editable.root,
    providers: resolved.ai.providers.map((provider) => provider.id),
    reviewerAvailable,
    problems,
  };
}
