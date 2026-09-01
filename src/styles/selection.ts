import { join } from "node:path";

import { z } from "zod";

import { assertGateCurrent } from "../planning/confirm.js";
import { loadValidatedPlan } from "../planning/load.js";
import { readProject, updateProject } from "../project/store.js";
import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { StyleReferenceSchema, StyleSelectionSchema } from "./schemas.js";
import { createProvisionalStyleLock } from "./style-lock.js";

export const StyleSelectionRequestSchema = z.object({
  projectRevisionId: z.string().uuid(),
  representativeSlideId: z.string().uuid(),
  selection: StyleSelectionSchema,
  referenceArtifacts: z.array(StyleReferenceSchema.pick({ path: true, role: true })),
}).strict();

export async function authenticateStyleSelection(root: string, rawRequest: unknown): Promise<{
  stage: "style-selection";
  projectRevisionId: string;
  representativeSlideId: string;
  styleId: string;
  styleLockSha256: string;
}> {
  const request = StyleSelectionRequestSchema.parse(rawRequest);
  const manifest = await readProject(root);
  if (manifest.currentRevision.id !== request.projectRevisionId) {
    throw new Error("style selection is stale for the current project revision");
  }
  if (!await assertGateCurrent(root, "slide-specs")) {
    throw new Error("style selection requires the current slide-specs approval");
  }
  const plan = await loadValidatedPlan(root);
  if (!plan.specs.some(({ slideId }) => slideId === request.representativeSlideId)) {
    throw new Error("style selection representative slide is not in the current project revision");
  }
  const lock = await createProvisionalStyleLock(root, {
    selection: request.selection,
    referenceArtifacts: request.referenceArtifacts,
  });
  const selection = {
    schemaVersion: 2 as const,
    projectRevisionId: request.projectRevisionId,
    representativeSlideId: request.representativeSlideId,
    selection: request.selection,
    styleLockSha256: lock.styleLockSha256,
  };
  await writeDurableExclusive(join(root, "style", "selection.json"), `${JSON.stringify(selection, null, 2)}\n`);
  await syncDirectory(join(root, "style"));
  await updateProject(root, (current) => {
    if (current.currentRevision.id !== request.projectRevisionId) {
      throw new Error("style selection became stale before stage publication");
    }
    return { ...current, stage: "style-selection" };
  });
  return {
    stage: "style-selection",
    projectRevisionId: request.projectRevisionId,
    representativeSlideId: request.representativeSlideId,
    styleId: lock.recipe.id,
    styleLockSha256: lock.styleLockSha256,
  };
}
