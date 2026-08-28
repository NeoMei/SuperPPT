import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  AiCapabilitiesSchema,
  AiImageSkillDependencySchema,
  ImageToEditablePptxSkillDependencySchema,
  type AiCapabilities,
  type LegacyResolvedDependencies,
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function isPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw new Error(`capability manifest is unreadable: ${path}`, { cause: error });
  }
}

async function loadCapabilities(path: string): Promise<AiCapabilities> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`capability manifest is unreadable: ${path}`, { cause: error });
  }
  try {
    return AiCapabilitiesSchema.parse(JSON.parse(source));
  } catch (error) {
    throw new Error(`capability manifest is invalid: ${path}`, { cause: error });
  }
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

async function resolveEditableSkill(root: string) {
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

export async function resolveSkillDependencies(
  request: ResolveDependencyRequest,
): Promise<ResolvedDependencies> {
  const aiRoot = await canonicalSkillRoot(request.aiSkillRoot, "ai-image-to-ppt");
  const editableRoot = await canonicalSkillRoot(request.editableSkillRoot, "image-to-editable-pptx");
  const skillFile = await requiredRegularFile(
    aiRoot,
    join(aiRoot, "SKILL.md"),
    "ai-image-to-ppt Skill entry is missing",
    "ai-image-to-ppt Skill entry is unsafe",
  );
  const scripts = await Promise.all(Object.entries(requiredAiScripts).map(async ([name, filename]) => [
    name,
    await requiredRegularFile(
      aiRoot,
      join(aiRoot, "scripts", filename),
      `ai-image-to-ppt required script is missing: ${filename}`,
      `ai-image-to-ppt required script is unsafe: ${filename}`,
    ),
  ] as const));
  const scriptPaths = Object.fromEntries(scripts) as ResolvedDependencies["ai"]["scripts"];
  const ai = AiImageSkillDependencySchema.parse({
    kind: "ai-image-to-ppt",
    root: aiRoot,
    skillFile,
    skillSha256: await sha256(skillFile),
    gitRevision: await gitRevision(aiRoot),
    scripts: scriptPaths,
  });
  const editable = await resolveEditableSkill(editableRoot);
  return {
    ai,
    editable,
    integrity: {
      aiSkillSha256: ai.skillSha256,
      aiScripts: Object.fromEntries(await Promise.all(Object.entries(ai.scripts).map(async ([name, path]) => [
        name,
        await sha256(path),
      ]))) as ResolvedDependencies["integrity"]["aiScripts"],
      editablePackageSha256: editable.packageSha256,
      editableSkillSha256: editable.skillSha256,
    },
  };
}

async function legacyCapabilities(root: string): Promise<AiCapabilities> {
  const providers = [];
  if (await exists(join(root, "scripts", "gen_slide_gemini.py"))) {
    providers.push({
      id: "gemini-legacy",
      module: "scripts/gen_slide_gemini.py",
      callable: "gen" as const,
      outputFormats: ["jpg" as const],
      supportsReferenceImages: false,
    });
  }
  if (await exists(join(root, "scripts", "gen_slide_doubao.py"))) {
    providers.push({
      id: "doubao-legacy",
      module: "scripts/gen_slide_doubao.py",
      callable: "gen" as const,
      outputFormats: ["jpg" as const],
      supportsReferenceImages: false,
    });
  }
  if (providers.length === 0) throw new Error("ai-image-to-ppt exposes no supported providers");
  const reviewer = await exists(join(root, "scripts", "vision_check_gemini.py"))
    ? { module: "scripts/vision_check_gemini.py", callable: "check" as const }
    : null;
  return { contractVersion: 1, defaultProvider: providers[0].id, providers, reviewer };
}

/** @deprecated Kept only while generation callers migrate away from provider discovery. */
export async function resolveDependencies(options: {
  aiRoot: string;
  editableRoot: string;
}): Promise<LegacyResolvedDependencies> {
  const aiRoot = await realpath(resolve(options.aiRoot));
  const editableRoot = await realpath(resolve(options.editableRoot));
  if (!await exists(join(aiRoot, "SKILL.md"))) throw new Error("ai-image-to-ppt Skill entry is missing");
  const capabilityPath = join(aiRoot, "references", "capabilities.json");
  const manifest = await isPresent(capabilityPath);
  const ai = manifest ? await loadCapabilities(capabilityPath) : await legacyCapabilities(aiRoot);
  for (const provider of ai.providers) {
    if (!await exists(join(aiRoot, provider.module))) throw new Error(`provider module is missing: ${provider.module}`);
  }
  if (ai.reviewer && !await exists(join(aiRoot, ai.reviewer.module))) {
    throw new Error(`reviewer module is missing: ${ai.reviewer.module}`);
  }
  const pkg = JSON.parse(await readFile(join(editableRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (pkg.name !== "image-to-editable-pptx" || !pkg.version || !isCompatibleEditableVersion(pkg.version)) {
    throw new Error("a compatible image-to-editable-pptx >=0.1.0 <0.2.0 is required");
  }
  if (!await exists(join(editableRoot, "skills", "image-to-editable-pptx", "SKILL.md"))) {
    throw new Error("editable Skill entry is missing");
  }
  return {
    ai: { ...ai, root: aiRoot, source: manifest ? "manifest" : "legacy" },
    editable: { root: editableRoot, version: pkg.version, cli: { cwd: editableRoot, command: "npm", args: ["run", "cli", "--"] } },
  };
}

/** @deprecated Kept only while generation callers migrate away from provider discovery. */
export async function resolveFromSkillEntries(options: {
  aiSkill: string;
  editableSkill: string;
}): Promise<LegacyResolvedDependencies> {
  const aiEntry = await realpath(options.aiSkill);
  const editableEntry = await realpath(options.editableSkill);
  if (basename(aiEntry) !== "SKILL.md") throw new Error("aiSkill must be the root SKILL.md");
  const aiRoot = dirname(aiEntry);
  if (await realpath(join(aiRoot, "SKILL.md")) !== aiEntry) throw new Error("aiSkill must be the root SKILL.md");
  const editableSkillDir = dirname(editableEntry);
  const editableSkillsDir = dirname(editableSkillDir);
  const editableRoot = dirname(editableSkillsDir);
  if (
    basename(editableEntry) !== "SKILL.md"
    || basename(editableSkillDir) !== "image-to-editable-pptx"
    || basename(editableSkillsDir) !== "skills"
    || await realpath(join(editableRoot, "skills", "image-to-editable-pptx", "SKILL.md")) !== editableEntry
  ) throw new Error("editableSkill must be skills/image-to-editable-pptx/SKILL.md");
  return resolveDependencies({ aiRoot, editableRoot });
}
