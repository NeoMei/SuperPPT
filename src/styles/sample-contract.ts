import { createHash } from "node:crypto";

import sharp from "sharp";
import { z } from "zod";

import { AttemptLedgerSchema, type AttemptLedger } from "../generation/schemas.js";
import { loadValidatedPlan } from "../planning/load.js";
import { Sha256Schema } from "../project/schemas.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { resolveStyleRecipe } from "./catalog.js";
import { compilePrompt, compileSlidePrompt, visualDirectorForSpec, type CompiledPrompt } from "./prompt-compiler.js";
import { readStyleLockIfPresent } from "./style-lock.js";
import { StyleSampleSelectionSchema, VisualDirectorSchema, type StyleRecipe, type StyleSampleSelection, type VisualDirector } from "./schemas.js";

export const STYLE_SAMPLE_ARTIFACTS = [
  "style/selection.json",
  "style/sample/director.json",
  "style/sample/prompt.txt",
  "style/sample/slide.png",
  "style/sample/ledger.json",
] as const;

export const STYLE_SAMPLE_COMPLETION_RECEIPT = "style/sample/completion.json";

const ReceiptArtifactSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
}).strict();

export const StyleSampleCompletionReceiptSchema = z.object({
  receiptVersion: z.literal(1),
  jobId: z.string().uuid(),
  job: ReceiptArtifactSchema,
  result: ReceiptArtifactSchema,
  authorization: ReceiptArtifactSchema,
  artifactHashes: z.object({
    "style/selection.json": Sha256Schema,
    "style/sample/director.json": Sha256Schema,
    "style/sample/prompt.txt": Sha256Schema,
    "style/sample/slide.png": Sha256Schema,
    "style/sample/ledger.json": Sha256Schema,
  }).strict(),
  finalizedAt: z.string().datetime(),
}).strict();

export type StyleSampleArtifactPath = typeof STYLE_SAMPLE_ARTIFACTS[number];
export type StyleSampleArtifacts = Record<StyleSampleArtifactPath, Buffer>;
export type StyleSampleCompletionReceipt = z.infer<typeof StyleSampleCompletionReceiptSchema>;

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type CanonicalStyleSample = {
  projectRevisionId: string;
  selection: StyleSampleSelection;
  spec: Awaited<ReturnType<typeof loadValidatedPlan>>["specs"][number];
  style: StyleRecipe;
  director: VisualDirector;
  compiled: CompiledPrompt;
};

export function delegatedStyleSampleArtifacts(
  canonical: CanonicalStyleSample,
  normalizedSample: Buffer,
  providerId: string,
  durationMs: number,
): StyleSampleArtifacts {
  const ledger = AttemptLedgerSchema.parse({
    ledgerVersion: 1,
    slideId: representativeSlideId(canonical.selection),
    revisionId: canonical.projectRevisionId,
    attempt: 1,
    providerId,
    promptSha256: canonical.compiled.sha256,
    promptPurged: true,
    output: STYLE_SAMPLE_ARTIFACTS[3],
    outputSha256: digest(normalizedSample),
    outputBytes: normalizedSample.length,
    durationMs,
    quality: null,
    outcome: "generated",
    errorCode: null,
  });
  return {
    [STYLE_SAMPLE_ARTIFACTS[0]]: Buffer.from(`${JSON.stringify(canonical.selection, null, 2)}\n`),
    [STYLE_SAMPLE_ARTIFACTS[1]]: Buffer.from(`${JSON.stringify(canonical.director, null, 2)}\n`),
    [STYLE_SAMPLE_ARTIFACTS[2]]: Buffer.from(canonical.compiled.text),
    [STYLE_SAMPLE_ARTIFACTS[3]]: normalizedSample,
    [STYLE_SAMPLE_ARTIFACTS[4]]: Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`),
  };
}

export function representativeSlideId(selection: StyleSampleSelection): string {
  return selection.representativeSlideId;
}

export function lockSelection(selection: StyleSampleSelection) {
  return "selection" in selection
    ? selection.selection
    : { kind: "catalog" as const, styleId: selection.styleId };
}

export async function canonicalStyleSample(root: string): Promise<CanonicalStyleSample> {
  const [manifest, plan, selectionBytes] = await Promise.all([
    readProject(root),
    loadValidatedPlan(root),
    readOwnedRegularFile(root, STYLE_SAMPLE_ARTIFACTS[0]),
  ]);
  const selection = StyleSampleSelectionSchema.parse(JSON.parse(selectionBytes.toString("utf8")));
  const spec = plan.specs.find(({ slideId }) => slideId === representativeSlideId(selection));
  if (!spec) throw new Error("representative slide must exist in current outline");
  const styleLock = await readStyleLockIfPresent(root);
  const style = styleLock?.recipe ?? await resolveStyleRecipe(lockSelection(selection));
  const director = visualDirectorForSpec(spec, style);
  return {
    projectRevisionId: manifest.currentRevision.id,
    selection,
    spec,
    style,
    director,
    compiled: styleLock
      ? compileSlidePrompt({ spec, styleLock })
      : compilePrompt({ spec, style, director }),
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
  const selection = StyleSampleSelectionSchema.parse(JSON.parse(values[STYLE_SAMPLE_ARTIFACTS[0]].toString("utf8")));
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
    ledger.slideId !== representativeSlideId(canonical.selection)
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
