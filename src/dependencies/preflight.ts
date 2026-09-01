import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { requireLocalDeckHandoff } from "../host/capabilities.js";
import { readAnchoredRegularFile } from "../project/safe-file.js";
import {
  AiImageSkillDependencyIdentitySchema,
  AiImageSkillDependencySchema,
  WorkflowPreflightBindingSchema,
  type AiImageSkillDependency,
  type DependencyPreflight,
  type ResolvedDependencies,
} from "./schemas.js";
import { computeEditableSourceTreeIdentity, resolveSkillDependencies } from "./resolve.js";

const MAX_DEPENDENCY_IDENTITY_BYTES = 16 * 1024 * 1024;

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function aiIdentity(ai: AiImageSkillDependency) {
  const { workflowPreflight: _workflowPreflight, ...identity } = ai;
  return AiImageSkillDependencyIdentitySchema.parse(identity);
}

export function attestWorkflowDependencies(
  resolved: ResolvedDependencies,
  hostCapabilities: unknown,
): ResolvedDependencies {
  requireLocalDeckHandoff(hostCapabilities);
  const host = { source: "agent-host" as const, localFilesystem: true as const, localFileLinks: true as const };
  const ai = aiIdentity(resolved.ai);
  const body = {
    bindingVersion: 2 as const,
    contractFile: resolved.contractFile,
    contractSha256: resolved.contractSha256,
    ai,
    editable: resolved.editable,
    host,
  };
  const workflowPreflight = WorkflowPreflightBindingSchema.parse({
    ...body,
    attestationSha256: sha256Json(body),
  });
  return {
    ...resolved,
    ai: AiImageSkillDependencySchema.parse({ ...resolved.ai, workflowPreflight }),
  };
}

export async function assertWorkflowPreflightCurrent(raw: AiImageSkillDependency): Promise<AiImageSkillDependency> {
  const ai = AiImageSkillDependencySchema.parse(raw);
  const binding = ai.workflowPreflight;
  if (!binding) throw new Error("full workflow preflight attestation is required before generation or conversion");
  const { attestationSha256, ...body } = binding;
  if (sha256Json(body) !== attestationSha256) throw new Error("workflow preflight attestation hash is invalid");
  requireLocalDeckHandoff(binding.host);
  if (!isDeepStrictEqual(aiIdentity(ai), binding.ai)) {
    throw new Error("workflow preflight AI dependency does not match the attested canonical identity");
  }
  const resolved = await resolveSkillDependencies({
    aiSkillRoot: binding.ai.root,
    editableSkillRoot: binding.editable.root,
    contractFile: binding.contractFile,
  });
  if (
    resolved.contractSha256 !== binding.contractSha256
    || !isDeepStrictEqual(aiIdentity(resolved.ai), binding.ai)
    || !isDeepStrictEqual(resolved.editable, binding.editable)
  ) throw new Error("full workflow preflight attestation is no longer current");
  const report = await preflightDependencies(resolved);
  if (!report.ok) throw new Error("full workflow preflight attestation is no longer current");
  return ai;
}

async function currentSha256(root: string, path: string): Promise<string | null> {
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(root) !== root) return null;
    const relation = relative(root, path);
    if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) return null;
    const info = await lstat(path);
    if (
      info.isSymbolicLink()
      || !info.isFile()
      || info.size === 0
      || info.size > MAX_DEPENDENCY_IDENTITY_BYTES
    ) return null;
    if (await realpath(path) !== path) return null;
    const bytes = await readAnchoredRegularFile(path, {
      label: "dependency identity",
      maxBytes: MAX_DEPENDENCY_IDENTITY_BYTES,
    });
    return createHash("sha256").update(bytes).digest("hex");
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
    { path, sha256: observedScripts[name] ?? resolved.ai.scriptSha256[name as keyof typeof resolved.ai.scriptSha256] },
  ]));
  const aiFilesChanged = changed(resolved.ai.skillSha256, await currentSha256(resolved.ai.root, resolved.ai.skillFile))
    || changed(resolved.ai.capabilityManifestSha256, await currentSha256(resolved.ai.root, resolved.ai.capabilityManifestFile))
    || Object.entries(resolved.ai.scripts).some(([name]) => changed(
      resolved.ai.scriptSha256[name as keyof typeof resolved.ai.scriptSha256],
      observedScripts[name] ?? null,
    ));
  if (aiFilesChanged) {
    errors.push({
      dependency: "ai-image-to-ppt",
      code: "identity_changed",
      safeMessage: "required Skill files changed after resolution",
    });
  }

  let sourceTreeChanged = true;
  try {
    sourceTreeChanged = !isDeepStrictEqual(
      await computeEditableSourceTreeIdentity(resolved.editable.root),
      resolved.editable.sourceTree,
    );
  } catch {
    sourceTreeChanged = true;
  }
  const editableFilesChanged = changed(
    resolved.editable.packageSha256,
    await currentSha256(resolved.editable.root, resolved.editable.packageFile),
  ) || changed(
    resolved.editable.pluginSha256,
    await currentSha256(resolved.editable.root, resolved.editable.pluginFile),
  ) || changed(
    resolved.editable.skillSha256,
    await currentSha256(resolved.editable.root, resolved.editable.skillFile),
  ) || changed(
    resolved.editable.cliSha256,
    await currentSha256(resolved.editable.root, resolved.editable.cliFile),
  ) || sourceTreeChanged;
  if (editableFilesChanged) {
    errors.push({
      dependency: "image-to-editable-pptx",
      code: "identity_changed",
      safeMessage: "required Skill files changed after resolution",
    });
  }
  if (changed(resolved.contractSha256, await currentSha256(dirname(resolved.contractFile), resolved.contractFile))) {
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
      version: resolved.editable.version,
      packageSha256: resolved.editable.packageSha256,
      pluginSha256: resolved.editable.pluginSha256,
      skillSha256: resolved.editable.skillSha256,
      cliSha256: resolved.editable.cliSha256,
      sourceTreeSha256: resolved.editable.sourceTree.sha256,
      manifestVersion: resolved.editable.outputContract.manifest.version,
      ledgerVersion: resolved.editable.outputContract.ledger.version,
      officialDonor: resolved.editable.outputContract.officialDonor,
      objectNames: resolved.editable.outputContract.objectNames,
      invocation: resolved.editable.invocation,
    },
    errors,
  };
}
