import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
  const capabilityPath = join(aiRoot, "references", "capabilities.json");
  const manifest = await exists(capabilityPath);
  const ai = manifest
    ? AiCapabilitiesSchema.parse(JSON.parse(await readFile(capabilityPath, "utf8")))
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
  if (pkg.name !== "image-to-editable-pptx" || !pkg.version || !/^0\.1\.\d+$/.test(pkg.version)) {
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
  return resolveDependencies({
    aiRoot: dirname(aiEntry),
    editableRoot: resolve(dirname(editableEntry), "..", ".."),
  });
}
