import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  AiImageSkillDependencySchema,
  ImageToEditablePptxSkillDependencySchema,
  type AiImageSkillDependency,
  type ImageToEditablePptxSkillDependency,
  type ResolvedDependencies,
} from "./schemas.js";

const execFileAsync = promisify(execFile);

const requiredAiScripts = {
  generationResult: "generation_result.py",
  hostRoutingPolicy: "host_routing_policy.py",
  importHostImage: "import_host_image.py",
  prepareEditableInput: "prepare_editable_input.py",
} as const;

export type ResolveDependencyRequest = {
  aiSkillRoot: string;
  editableSkillRoot: string;
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isCompatibleEditableVersion(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match;
  return major === "0" && minor === "1";
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

async function requiredRegularFile(
  root: string,
  path: string,
  missingMessage: string,
  unsafeMessage: string,
): Promise<string> {
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

async function resolveEditableSkill(root: string): Promise<ImageToEditablePptxSkillDependency> {
  const packageFile = await requiredRegularFile(
    root,
    join(root, "package.json"),
    "image-to-editable-pptx package.json is missing",
    "image-to-editable-pptx package.json is unsafe",
  );
  let pkg: { name?: string; version?: string };
  try {
    pkg = JSON.parse(await readFile(packageFile, "utf8")) as { name?: string; version?: string };
  } catch (error) {
    throw new Error("image-to-editable-pptx package.json is invalid", { cause: error });
  }
  if (pkg.name !== "image-to-editable-pptx" || !pkg.version || !isCompatibleEditableVersion(pkg.version)) {
    throw new Error("a compatible image-to-editable-pptx >=0.1.0 <0.2.0 is required");
  }
  const skillFile = await requiredRegularFile(
    root,
    join(root, "skills", "image-to-editable-pptx", "SKILL.md"),
    "editable Skill entry is missing",
    "editable Skill entry is unsafe",
  );
  return ImageToEditablePptxSkillDependencySchema.parse({
    kind: "image-to-editable-pptx",
    root,
    packageFile,
    packageSha256: await sha256(packageFile),
    skillFile,
    skillSha256: await sha256(skillFile),
    version: pkg.version,
  });
}

export async function resolveAiImageSkillDependency(
  aiSkillRoot: string,
): Promise<AiImageSkillDependency> {
  const aiRoot = await canonicalSkillRoot(aiSkillRoot, "ai-image-to-ppt");
  const skillFile = await requiredRegularFile(
    aiRoot,
    join(aiRoot, "SKILL.md"),
    "ai-image-to-ppt Skill entry is missing",
    "ai-image-to-ppt Skill entry is unsafe",
  );
  const scripts: Array<[keyof typeof requiredAiScripts, string]> = [];
  for (const name of Object.keys(requiredAiScripts) as Array<keyof typeof requiredAiScripts>) {
    const filename = requiredAiScripts[name];
    scripts.push([name, await requiredRegularFile(
      aiRoot,
      join(aiRoot, "scripts", filename),
      `ai-image-to-ppt required script is missing: ${filename}`,
      `ai-image-to-ppt required script is unsafe: ${filename}`,
    )]);
  }
  const scriptPaths = Object.fromEntries(scripts) as AiImageSkillDependency["scripts"];
  const scriptSha256 = Object.fromEntries(await Promise.all(Object.entries(scriptPaths).map(async ([name, path]) => [
    name,
    await sha256(path),
  ]))) as AiImageSkillDependency["scriptSha256"];
  return AiImageSkillDependencySchema.parse({
    kind: "ai-image-to-ppt",
    root: aiRoot,
    skillFile,
    skillSha256: await sha256(skillFile),
    gitRevision: await gitRevision(aiRoot),
    scripts: scriptPaths,
    scriptSha256,
  });
}

export async function resolveEditableSkillDependency(
  editableSkillRoot: string,
): Promise<ImageToEditablePptxSkillDependency> {
  return resolveEditableSkill(await canonicalSkillRoot(editableSkillRoot, "image-to-editable-pptx"));
}

export async function resolveSkillDependencies(
  request: ResolveDependencyRequest,
): Promise<ResolvedDependencies> {
  const [ai, editable] = await Promise.all([
    resolveAiImageSkillDependency(request.aiSkillRoot),
    resolveEditableSkillDependency(request.editableSkillRoot),
  ]);
  return {
    ai,
    editable,
    integrity: {
      aiSkillSha256: ai.skillSha256,
      aiScripts: ai.scriptSha256,
      editablePackageSha256: editable.packageSha256,
      editableSkillSha256: editable.skillSha256,
    },
  };
}
