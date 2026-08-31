import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AiImageCapabilityManifestSchema,
  AiImageSkillDependencySchema,
  DependencyContractSchema,
  ImageToEditablePptxSkillDependencySchema,
  type AiImageSkillDependency,
  type ImageToEditablePptxSkillDependency,
  type ResolvedDependencies,
} from "./schemas.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CONTRACT_FILE = fileURLToPath(new URL("../../references/dependencies.json", import.meta.url));

export type ResolveDependencyRequest = {
  aiSkillRoot: string;
  editableSkillRoot: string;
  contractFile?: string;
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function canonicalSkillRoot(path: string, dependency: string): Promise<string> {
  const requested = resolve(path);
  let info;
  try {
    info = await lstat(requested);
  } catch (error) {
    throw new Error(`${dependency} Skill root is unavailable`, { cause: error });
  }
  if (info.isSymbolicLink()) throw new Error(`${dependency} Skill root must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${dependency} Skill root must be a directory`);
  return realpath(requested);
}

async function requiredRegularFile(root: string, path: string, missingMessage: string, unsafeMessage: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error(missingMessage);
    throw new Error(unsafeMessage, { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(unsafeMessage);
  const physicalPath = await realpath(path);
  const relation = relative(root, physicalPath);
  if (physicalPath !== path || relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(unsafeMessage);
  }
  return path;
}

async function canonicalContractFile(path: string): Promise<string> {
  const lexical = resolve(path);
  let info;
  try {
    info = await lstat(lexical);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error("dependency contract is missing");
    throw new Error("dependency contract path is unsafe", { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("dependency contract path is unsafe");
  return realpath(lexical);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function gitRevision(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    const revision = stdout.trim();
    return revision === "" ? null : revision;
  } catch {
    return null;
  }
}

async function loadDependencyContract(path = DEFAULT_CONTRACT_FILE) {
  const contractFile = await canonicalContractFile(path);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(contractFile, "utf8"));
  } catch (error) {
    throw new Error("dependency contract is invalid JSON", { cause: error });
  }
  try {
    return { contractFile, contract: DependencyContractSchema.parse(value), contractSha256: await sha256(contractFile) };
  } catch (error) {
    throw new Error("dependency contract is invalid: manifestVersion 2, official donor slide-editable.pptx, and exact capability contracts are required", { cause: error });
  }
}

function compatibleVersion(version: string, range: string): boolean {
  if (range !== ">=0.2.0 <0.3.0") throw new Error("unsupported image-to-editable-pptx version requirement");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[-0-9A-Za-z.]+)?(?:\+[-0-9A-Za-z.]+)?$/.exec(version);
  if (!match) return false;
  return Number(match[1]) === 0 && Number(match[2]) === 2;
}

type LoadedContract = Awaited<ReturnType<typeof loadDependencyContract>>["contract"];

async function resolveEditableSkill(root: string, requirements: LoadedContract["dependencies"][1]): Promise<ImageToEditablePptxSkillDependency> {
  const packageFile = await requiredRegularFile(root, join(root, "package.json"), "image-to-editable-pptx package.json is missing", "image-to-editable-pptx package.json is unsafe");
  let pkg: { name?: string; version?: string };
  try {
    pkg = JSON.parse(await readFile(packageFile, "utf8")) as { name?: string; version?: string };
  } catch (error) {
    throw new Error("image-to-editable-pptx package.json is invalid", { cause: error });
  }
  if (pkg.name !== "image-to-editable-pptx" || !pkg.version || !compatibleVersion(pkg.version, requirements.capabilities.version)) {
    throw new Error(`a compatible image-to-editable-pptx ${requirements.capabilities.version} is required`);
  }
  const skillFile = await requiredRegularFile(root, join(root, "skills", "image-to-editable-pptx", "SKILL.md"), "editable Skill entry is missing", "editable Skill entry is unsafe");
  return ImageToEditablePptxSkillDependencySchema.parse({
    kind: "image-to-editable-pptx",
    root,
    packageFile,
    packageSha256: await sha256(packageFile),
    skillFile,
    skillSha256: await sha256(skillFile),
    version: pkg.version,
    manifestVersion: requirements.capabilities.manifestVersion,
    officialDonor: requirements.capabilities.officialDonor,
    objectNames: requirements.capabilities.objectNames,
  });
}

async function resolveAiWithContract(aiSkillRoot: string, requirements: LoadedContract["dependencies"][0]): Promise<AiImageSkillDependency> {
  const aiRoot = await canonicalSkillRoot(aiSkillRoot, "ai-image-to-ppt");
  const skillFile = await requiredRegularFile(aiRoot, join(aiRoot, "SKILL.md"), "ai-image-to-ppt Skill entry is missing", "ai-image-to-ppt Skill entry is unsafe");
  const capabilityManifestFile = await requiredRegularFile(
    aiRoot,
    join(aiRoot, ...requirements.capabilityManifest.path.split("/")),
    "ai-image-to-ppt capability manifest is missing",
    "ai-image-to-ppt capability manifest is unsafe",
  );
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(capabilityManifestFile, "utf8"));
  } catch (error) {
    throw new Error("ai-image-to-ppt capability manifest is invalid JSON", { cause: error });
  }
  let manifest;
  try {
    manifest = AiImageCapabilityManifestSchema.parse(rawManifest);
  } catch (error) {
    throw new Error("ai-image-to-ppt capability manifest is invalid", { cause: error });
  }
  if (
    manifest.schemaVersion !== requirements.capabilityManifest.schemaVersion
    || JSON.stringify(manifest.contracts) !== JSON.stringify(requirements.capabilityManifest.contracts)
    || JSON.stringify(manifest.scripts) !== JSON.stringify(requirements.capabilityManifest.scripts)
  ) throw new Error("ai-image-to-ppt capability manifest and dependency-contract script requirements disagree");

  const entries: Array<readonly [string, string]> = [];
  for (const [name, relativePath] of Object.entries(manifest.scripts)) {
    const filename = relativePath.split("/").at(-1)!;
    const absolutePath = await requiredRegularFile(
      aiRoot,
      join(aiRoot, ...relativePath.split("/")),
      `ai-image-to-ppt required script is missing: ${filename}`,
      `ai-image-to-ppt required script is unsafe: ${filename}`,
    );
    entries.push([name, absolutePath] as const);
  }
  const scripts = Object.fromEntries(entries) as AiImageSkillDependency["scripts"];
  const scriptSha256 = Object.fromEntries(await Promise.all(entries.map(async ([name, path]) => [name, await sha256(path)]))) as AiImageSkillDependency["scriptSha256"];
  return AiImageSkillDependencySchema.parse({
    kind: "ai-image-to-ppt",
    root: aiRoot,
    skillFile,
    skillSha256: await sha256(skillFile),
    gitRevision: await gitRevision(aiRoot),
    capabilityManifestFile,
    capabilityManifestSha256: await sha256(capabilityManifestFile),
    capabilitySchemaVersion: manifest.schemaVersion,
    contracts: manifest.contracts,
    routingOrder: manifest.routingOrder,
    outputs: manifest.outputs,
    scripts,
    scriptSha256,
  });
}

export async function resolveAiImageSkillDependency(aiSkillRoot: string): Promise<AiImageSkillDependency> {
  const { contract } = await loadDependencyContract();
  return resolveAiWithContract(aiSkillRoot, contract.dependencies[0]);
}

export async function resolveEditableSkillDependency(editableSkillRoot: string): Promise<ImageToEditablePptxSkillDependency> {
  const { contract } = await loadDependencyContract();
  return resolveEditableSkill(await canonicalSkillRoot(editableSkillRoot, "image-to-editable-pptx"), contract.dependencies[1]);
}

export async function resolveSkillDependencies(request: ResolveDependencyRequest): Promise<ResolvedDependencies> {
  const loaded = await loadDependencyContract(request.contractFile);
  const [ai, editable] = await Promise.all([
    resolveAiWithContract(request.aiSkillRoot, loaded.contract.dependencies[0]),
    canonicalSkillRoot(request.editableSkillRoot, "image-to-editable-pptx").then((root) => resolveEditableSkill(root, loaded.contract.dependencies[1])),
  ]);
  return {
    contractFile: loaded.contractFile,
    contractSha256: loaded.contractSha256,
    ai,
    editable,
    integrity: {
      aiSkillSha256: ai.skillSha256,
      aiCapabilityManifestSha256: ai.capabilityManifestSha256,
      aiScripts: ai.scriptSha256,
      editablePackageSha256: editable.packageSha256,
      editableSkillSha256: editable.skillSha256,
      contractSha256: loaded.contractSha256,
    },
  };
}
