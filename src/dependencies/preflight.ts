import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { PreflightReport, ResolvedDependencies } from "./schemas.js";

export async function preflightDependencies(
  resolved: ResolvedDependencies,
): Promise<PreflightReport> {
  const problems: string[] = [];
  for (const provider of resolved.ai.providers) {
    try {
      await access(join(resolved.ai.root, provider.module), constants.R_OK);
    } catch {
      problems.push(`provider module is unreadable: ${provider.module}`);
    }
  }
  try {
    await access(join(resolved.editable.root, "package-lock.json"), constants.R_OK);
  } catch {
    problems.push("image-to-editable-pptx package-lock.json is missing");
  }
  return {
    ok: problems.length === 0,
    aiRoot: resolved.ai.root,
    editableRoot: resolved.editable.root,
    providers: resolved.ai.providers.map((provider) => provider.id),
    reviewerAvailable: resolved.ai.reviewer !== null,
    problems,
  };
}
