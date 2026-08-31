import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";

import type { DependencyPreflight, ResolvedDependencies } from "./schemas.js";

async function currentSha256(root: string, path: string): Promise<string | null> {
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(root) !== root) return null;
    const relation = relative(root, path);
    if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) return null;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    if (await realpath(path) !== path) return null;
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
    await currentSha256(resolved.ai.root, path),
  ])));
  const requiredScripts = Object.fromEntries(Object.entries(resolved.ai.scripts).map(([name, path]) => [
    name,
    { path, sha256: observedScripts[name] ?? resolved.integrity.aiScripts[name as keyof typeof resolved.integrity.aiScripts] },
  ]));
  const aiFilesChanged = changed(resolved.integrity.aiSkillSha256, await currentSha256(resolved.ai.root, resolved.ai.skillFile))
    || changed(resolved.integrity.aiCapabilityManifestSha256, await currentSha256(resolved.ai.root, resolved.ai.capabilityManifestFile))
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
  const editableFilesChanged = changed(
    resolved.integrity.editablePackageSha256,
    await currentSha256(resolved.editable.root, resolved.editable.packageFile),
  ) || changed(
    resolved.integrity.editableSkillSha256,
    await currentSha256(resolved.editable.root, resolved.editable.skillFile),
  );
  if (editableFilesChanged) {
    errors.push({
      dependency: "image-to-editable-pptx",
      code: "identity_changed",
      safeMessage: "required Skill files changed after resolution",
    });
  }
  if (changed(resolved.integrity.contractSha256, await currentSha256(dirname(resolved.contractFile), resolved.contractFile))) {
    errors.push({
      dependency: "superppt-dependency-contract",
      code: "identity_changed",
      safeMessage: "dependency authority changed after resolution",
    });
  }
  return {
    ok: errors.length === 0,
    aiImageToPpt: {
      root: resolved.ai.root,
      skillSha256: resolved.ai.skillSha256,
      gitRevision: resolved.ai.gitRevision,
      capabilityManifestSha256: resolved.ai.capabilityManifestSha256,
      capabilitySchemaVersion: resolved.ai.capabilitySchemaVersion,
      contracts: resolved.ai.contracts,
      routingOrder: resolved.ai.routingOrder,
      outputs: resolved.ai.outputs,
      requiredScripts,
    },
    imageToEditablePptx: {
      root: resolved.editable.root,
      skillSha256: resolved.editable.skillSha256,
      version: resolved.editable.version,
      manifestVersion: resolved.editable.manifestVersion,
      officialDonor: resolved.editable.officialDonor,
      objectNames: resolved.editable.objectNames,
    },
    errors,
  };
}
