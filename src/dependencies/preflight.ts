import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { PreflightReport, ResolvedDependencies } from "./schemas.js";

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function preflightDependencies(
  resolved: ResolvedDependencies,
): Promise<PreflightReport> {
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
