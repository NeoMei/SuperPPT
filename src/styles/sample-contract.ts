import { createHash } from "node:crypto";

import sharp from "sharp";

import { AttemptLedgerSchema, type AttemptLedger } from "../generation/schemas.js";
import { loadValidatedPlan } from "../planning/load.js";
import { StyleSelectionSchema, type StyleSelection } from "../planning/schemas.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { loadBuiltInStyleCatalog } from "./catalog.js";
import { compilePrompt, visualDirectorForSpec, type CompiledPrompt } from "./prompt-compiler.js";
import { VisualDirectorSchema, type StyleRecipe, type VisualDirector } from "./schemas.js";

export const STYLE_SAMPLE_ARTIFACTS = [
  "style/selection.json",
  "style/sample/director.json",
  "style/sample/prompt.txt",
  "style/sample/sample.png",
  "style/sample/ledger.json",
] as const;

export type StyleSampleArtifactPath = typeof STYLE_SAMPLE_ARTIFACTS[number];
export type StyleSampleArtifacts = Record<StyleSampleArtifactPath, Buffer>;

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type CanonicalStyleSample = {
  projectRevisionId: string;
  selection: StyleSelection;
  spec: Awaited<ReturnType<typeof loadValidatedPlan>>["specs"][number];
  style: StyleRecipe;
  director: VisualDirector;
  compiled: CompiledPrompt;
};

export async function canonicalStyleSample(root: string): Promise<CanonicalStyleSample> {
  const [manifest, plan, catalog, selectionBytes] = await Promise.all([
    readProject(root),
    loadValidatedPlan(root),
    loadBuiltInStyleCatalog(),
    readOwnedRegularFile(root, STYLE_SAMPLE_ARTIFACTS[0]),
  ]);
  const selection = StyleSelectionSchema.parse(JSON.parse(selectionBytes.toString("utf8")));
  const spec = plan.specs.find(({ slideId }) => slideId === selection.representativeSlideId);
  if (!spec) throw new Error("representative slide must exist in current outline");
  const style = catalog.styles.find(({ id }) => id === selection.styleId);
  if (!style) throw new Error(`unknown built-in style: ${selection.styleId}`);
  const director = visualDirectorForSpec(spec, style);
  return {
    projectRevisionId: manifest.currentRevision.id,
    selection,
    spec,
    style,
    director,
    compiled: compilePrompt({ spec, style, director }),
  };
}

export async function readStyleSampleArtifacts(root: string): Promise<StyleSampleArtifacts> {
  return Object.fromEntries(await Promise.all(STYLE_SAMPLE_ARTIFACTS.map(async (path) => [
    path,
    await readOwnedRegularFile(root, path),
  ]))) as StyleSampleArtifacts;
}

export async function validateCanonicalStyleSample(
  root: string,
  values: StyleSampleArtifacts,
): Promise<{ canonical: CanonicalStyleSample; ledger: AttemptLedger }> {
  const canonical = await canonicalStyleSample(root);
  const selection = StyleSelectionSchema.parse(JSON.parse(values[STYLE_SAMPLE_ARTIFACTS[0]].toString("utf8")));
  if (!sameJson(selection, canonical.selection)) throw new Error("style sample selection is not canonical");

  const director = VisualDirectorSchema.parse(JSON.parse(values[STYLE_SAMPLE_ARTIFACTS[1]].toString("utf8")));
  const expectedDirector = `${JSON.stringify(canonical.director, null, 2)}\n`;
  if (!sameJson(director, canonical.director) || values[STYLE_SAMPLE_ARTIFACTS[1]].toString("utf8") !== expectedDirector) {
    throw new Error("style sample director is not canonical");
  }
  if (values[STYLE_SAMPLE_ARTIFACTS[2]].toString("utf8") !== canonical.compiled.text) {
    throw new Error("canonical style sample prompt does not match the current spec, recipe, and director");
  }

  const sample = values[STYLE_SAMPLE_ARTIFACTS[3]];
  const decoder = sharp(sample, { failOn: "error", limitInputPixels: 1920 * 1080, animated: false });
  const metadata = await decoder.metadata();
  if (metadata.format !== "png" || metadata.width !== 1920 || metadata.height !== 1080 || (metadata.pages ?? 1) !== 1) {
    throw new Error("canonical style sample must be an exact 1920x1080 PNG");
  }
  await decoder.clone().raw().toBuffer();

  const ledgerText = values[STYLE_SAMPLE_ARTIFACTS[4]].toString("utf8");
  const ledger = AttemptLedgerSchema.parse(JSON.parse(ledgerText));
  if (ledgerText !== `${JSON.stringify(ledger, null, 2)}\n`) throw new Error("style sample provider ledger is not canonical");
  if (
    ledger.slideId !== canonical.selection.representativeSlideId
    || ledger.revisionId !== canonical.projectRevisionId
    || ledger.attempt !== 1
    || ledger.promptSha256 !== canonical.compiled.sha256
    || ledger.promptPurged !== true
    || ledger.output !== STYLE_SAMPLE_ARTIFACTS[3]
    || ledger.outputSha256 !== digest(sample)
    || ledger.outputBytes !== sample.length
    || ledger.quality !== null
    || ledger.outcome !== "generated"
    || ledger.errorCode !== null
  ) throw new Error("style sample provider ledger does not bind the canonical provider output");
  return { canonical, ledger };
}
