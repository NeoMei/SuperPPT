import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  AiCapabilitiesSchema,
  type AiCapabilities,
  type ResolvedDependencies,
} from "./schemas.js";

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
  if (!match) {
    return false;
  }
  const [, major, minor] = match;
  return major === "0" && minor === "1";
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
  if (providers.length === 0) {
    throw new Error("ai-image-to-ppt exposes no supported providers");
  }
  const reviewer = await exists(join(root, "scripts", "vision_check_gemini.py"))
    ? { module: "scripts/vision_check_gemini.py", callable: "check" as const }
    : null;
  return {
    contractVersion: 1,
    defaultProvider: providers[0].id,
    providers,
    reviewer,
  };
}

export async function resolveDependencies(options: {
  aiRoot: string;
  editableRoot: string;
}): Promise<ResolvedDependencies> {
  const aiRoot = await realpath(resolve(options.aiRoot));
  const editableRoot = await realpath(resolve(options.editableRoot));
  if (!await exists(join(aiRoot, "SKILL.md"))) {
    throw new Error("ai-image-to-ppt Skill entry is missing");
  }
  const capabilityPath = join(aiRoot, "references", "capabilities.json");
  const manifest = await isPresent(capabilityPath);
  const ai = manifest
    ? await loadCapabilities(capabilityPath)
    : await legacyCapabilities(aiRoot);
  for (const provider of ai.providers) {
    if (!await exists(join(aiRoot, provider.module))) {
      throw new Error(`provider module is missing: ${provider.module}`);
    }
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
    editable: {
      root: editableRoot,
      version: pkg.version,
      cli: { cwd: editableRoot, command: "npm", args: ["run", "cli", "--"] },
    },
  };
}

export async function resolveFromSkillEntries(options: {
  aiSkill: string;
  editableSkill: string;
}): Promise<ResolvedDependencies> {
  const aiEntry = await realpath(options.aiSkill);
  const editableEntry = await realpath(options.editableSkill);
  if (basename(aiEntry) !== "SKILL.md") {
    throw new Error("aiSkill must be the root SKILL.md");
  }
  const aiRoot = dirname(aiEntry);
  if (await realpath(join(aiRoot, "SKILL.md")) !== aiEntry) {
    throw new Error("aiSkill must be the root SKILL.md");
  }

  const editableSkillDir = dirname(editableEntry);
  const editableSkillsDir = dirname(editableSkillDir);
  const editableRoot = dirname(editableSkillsDir);
  if (
    basename(editableEntry) !== "SKILL.md"
    || basename(editableSkillDir) !== "image-to-editable-pptx"
    || basename(editableSkillsDir) !== "skills"
    || await realpath(join(editableRoot, "skills", "image-to-editable-pptx", "SKILL.md")) !== editableEntry
  ) {
    throw new Error("editableSkill must be skills/image-to-editable-pptx/SKILL.md");
  }
  return resolveDependencies({
    aiRoot,
    editableRoot,
  });
}
