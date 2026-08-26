import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { readOwnedRegularFile, type SafeReadOperations } from "../project/safe-file.js";
import { BriefSchema, OutlineSchema, SlideSpecSchema, type Brief, type Outline, type SlideSpec } from "./schemas.js";

export type ValidatedOutline = {
  brief: Brief;
  outline: Outline;
  artifacts: Record<string, Buffer>;
};

export type ValidatedPlan = ValidatedOutline & {
  specs: SlideSpec[];
};

function parseJson(value: Buffer, label: string): unknown {
  try {
    return JSON.parse(value.toString("utf8"));
  } catch (error: unknown) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
}

export async function loadValidatedOutline(
  root: string,
  operations: SafeReadOperations = {},
): Promise<ValidatedOutline> {
  const briefBytes = await readOwnedRegularFile(root, "brief.json", operations);
  const outlineBytes = await readOwnedRegularFile(root, "outline.json", operations);
  const brief = BriefSchema.parse(parseJson(briefBytes, "brief.json"));
  const outline = OutlineSchema.parse(parseJson(outlineBytes, "outline.json"));
  if (brief.targetSlides !== outline.slides.length) {
    throw new Error("brief targetSlides must equal outline slide count");
  }
  const outlineText = outline.slides
    .flatMap((slide) => [slide.title, slide.purpose])
    .join("\n");
  for (const required of brief.mustCover) {
    if (!outlineText.includes(required)) {
      throw new Error(`outline does not cover required topic: ${required}`);
    }
  }
  return {
    brief,
    outline,
    artifacts: { "brief.json": briefBytes, "outline.json": outlineBytes },
  };
}

export async function loadValidatedPlan(
  root: string,
  operations: SafeReadOperations = {},
): Promise<ValidatedPlan> {
  const validated = await loadValidatedOutline(root, operations);
  const slidesRoot = join(await realpath(root), "slides");
  const slidesInfo = await lstat(slidesRoot);
  if (slidesInfo.isSymbolicLink() || !slidesInfo.isDirectory()) {
    throw new Error("slide workspace must be a regular directory");
  }
  const directories = (await readdir(slidesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
  if (directories.some((entry) => entry.isSymbolicLink())) {
    throw new Error("slide directories must be regular directories");
  }
  const expectedIds = [...validated.outline.slides]
    .sort((left, right) => left.order - right.order)
    .map((slide) => slide.id);
  if (
    directories.length !== expectedIds.length
    || directories.map(({ name }) => name).sort().some((id, index) => id !== [...expectedIds].sort()[index])
  ) {
    throw new Error("spec IDs must exactly match outline IDs");
  }
  const artifacts: Record<string, Buffer> = { ...validated.artifacts };
  const specs: SlideSpec[] = [];
  for (const slide of [...validated.outline.slides].sort((left, right) => left.order - right.order)) {
    const key = `slides/${slide.id}/spec.json`;
    const bytes = await readOwnedRegularFile(root, key, operations);
    const value = SlideSpecSchema.parse(parseJson(bytes, key));
    if (
      value.slideId !== slide.id
      || value.title !== slide.title
      || value.role !== slide.role
      || JSON.stringify(value.sourceRefs) !== JSON.stringify(slide.sourceRefs)
    ) {
      throw new Error(`slide spec must match outline: ${slide.id}`);
    }
    artifacts[key] = bytes;
    specs.push(value);
  }
  return { ...validated, specs, artifacts };
}
