import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import sharp from "sharp";

import type { ResolvedDependencies } from "../dependencies/schemas.js";
import { assertGateCurrent } from "../planning/confirm.js";
import { loadValidatedPlan } from "../planning/load.js";
import { StyleSelectionSchema } from "../planning/schemas.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import type { Artifact, ProjectManifest, SlideRecord } from "../project/schemas.js";
import { readProject, updateProject } from "../project/store.js";
import { loadBuiltInStyleCatalog } from "../styles/catalog.js";
import { GenerationDirectory, openGenerationDirectory } from "./anchored-dir.js";
import { readPrivateInputFile } from "./private-input.js";
import type { QualityDecision } from "./schemas.js";
import { AttemptLedgerSchema, QualityDecisionSchema, type AttemptLedger } from "./schemas.js";
import { generateSlide } from "./provider.js";
import { correctivePrompt, correctivePromptFromEvidence, qualityEvidence } from "./quality.js";
import { reviewSlide } from "./quality.js";

const BatchPageSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["ready", "stale", "failed"]),
  prompt: z.string().min(1),
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  output: z.string().min(1),
  attempts: z.number().int().min(0).max(3).optional(),
}).strict();

export type BatchPage = z.infer<typeof BatchPageSchema>;
type GenerationResult = { ok: boolean; output: string };

export async function runBatch(options: {
  pages: BatchPage[];
  concurrency: number;
  generate: (page: BatchPage, attempt: number) => Promise<GenerationResult>;
  review: (page: BatchPage, attempt: number) => Promise<QualityDecision>;
}): Promise<{ pages: BatchPage[]; errors: { pageId: string; attempt: number; code: "generate" | "review" }[] }> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error("concurrency must be between 1 and 8");
  }
  const pages = options.pages.map((page) => BatchPageSchema.parse({ ...page }));
  const pending = pages.filter((page) => page.status !== "ready");
  const errors: { pageId: string; attempt: number; code: "generate" | "review" }[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      const page = pending[cursor++]!;
      let prompt = page.prompt;
      page.status = "stale";
      const firstAttempt = (page.attempts ?? 0) + 1;
      for (let attempt = firstAttempt; attempt <= 3; attempt++) {
        let generated: GenerationResult;
        try {
          generated = await options.generate({ ...page, prompt }, attempt);
        } catch {
          errors.push({ pageId: page.id, attempt, code: "generate" });
          continue;
        }
        if (!generated.ok) {
          errors.push({ pageId: page.id, attempt, code: "generate" });
          continue;
        }
        let quality: QualityDecision;
        try {
          quality = QualityDecisionSchema.parse(await options.review({ ...page, prompt }, attempt));
        } catch {
          errors.push({ pageId: page.id, attempt, code: "review" });
          continue;
        }
        if (quality.ok) {
          page.status = "ready";
          page.attempts = attempt;
          break;
        }
        prompt = correctivePrompt(prompt, quality);
        page.attempts = attempt;
      }
      if (page.status !== "ready") page.status = "failed";
    }
  }));
  return { pages, errors };
}

type ProjectGenerationResult = {
  providerId: string;
  pageCount: number;
  callCount: number;
  outputRoot: string;
  reviewer: "dependency" | "manual";
  pages: { id: string; status: SlideRecord["status"]; attempts: number }[];
};

export type GenerationPlan = {
  providerId: string;
  pageCount: number;
  callCount: number;
  outputRoot: string;
  reviewer: "dependency" | "manual";
};

type ProjectPage = {
  id: string;
  order: number;
  title: string;
  role: SlideRecord["role"];
  requiredText: string[];
  prompt: string;
  promptSha256: string;
  status: SlideRecord["status"];
  attempts: number;
};

const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function portable(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value.startsWith("..") || value.split(sep).includes("..")) {
    throw new Error("generation output escaped the project root");
  }
  return value.split(sep).join("/");
}

async function gateGeneration(root: string): Promise<ProjectManifest> {
  const manifest = await readProject(root);
  const gates = ["outline", "slide-specs", "style-sample"] as const;
  const current = await Promise.all(gates.map(async (gate) => {
    const approved = [...manifest.gates].reverse().find((item) => item.gate === gate);
    return approved?.revisionId === manifest.currentRevision.id && await assertGateCurrent(root, gate);
  }));
  if (current.some((value) => !value)) {
    throw new Error("outline, slide-specs, and style-sample gates must be current");
  }
  return manifest;
}

function pagePrompt(stylePrompt: string, spec: Awaited<ReturnType<typeof loadValidatedPlan>>["specs"][number]): string {
  return [
    stylePrompt.trim(),
    "SUPERPPT PAGE ADAPTATION (canonical JSON):",
    JSON.stringify({
      title: spec.title,
      role: spec.role,
      coreMessage: spec.coreMessage,
      requiredText: spec.requiredText,
      visualSubject: spec.visualSubject,
      composition: spec.composition,
      relationships: spec.relationships,
      forbidden: spec.forbidden,
    }),
    "Preserve exact required copy and the approved deck style. Produce exactly one 16:9 slide with no logo or watermark.",
  ].join("\n\n");
}

async function attemptCount(root: string, slideId: string): Promise<number> {
  const path = join(root, "images", slideId);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("attempt directory is unsafe");
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error("attempt directory is unsafe");
    const values = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => /^attempt-([1-3])$/.exec(entry.name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    return values.length === 0 ? 0 : Math.max(...values);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function latestAttemptLedger(root: string, page: ProjectPage): Promise<AttemptLedger | null> {
  if (page.attempts < 1) return null;
  const path = `images/${page.id}/attempt-${page.attempts}/ledger.json`;
  try {
    const ledger = AttemptLedgerSchema.parse(JSON.parse((await readOwnedRegularFile(root, path)).toString("utf8")));
    if (ledger.slideId !== page.id || ledger.attempt !== page.attempts) throw new Error("attempt identity mismatch");
    return ledger;
  } catch (error: unknown) {
    throw new Error("attempt ledger is invalid", { cause: error });
  }
}

async function authenticateLedgerImage(
  root: string,
  page: ProjectPage,
  ledger: AttemptLedger,
): Promise<Artifact | null> {
  const expectedPath = `images/${page.id}/attempt-${ledger.attempt}/slide.png`;
  if (
    ledger.output !== expectedPath
    || !ledger.outputSha256
    || !ledger.outputBytes
  ) return null;
  try {
    const bytes = await readOwnedRegularFile(root, expectedPath);
    if (bytes.length !== ledger.outputBytes || hash(bytes) !== ledger.outputSha256) return null;
    const decoder = sharp(bytes, { failOn: "error", limitInputPixels: 1920 * 1080, animated: false });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== "png"
      || metadata.width !== 1920
      || metadata.height !== 1080
      || (metadata.pages ?? 1) !== 1
    ) return null;
    await decoder.clone().raw().toBuffer();
    return { path: expectedPath, sha256: ledger.outputSha256, revisionId: ledger.revisionId! };
  } catch {
    return null;
  }
}

async function inspectAttemptStates(
  root: string,
  revisionId: string,
  pages: ProjectPage[],
): Promise<Map<string, { ledger: AttemptLedger; artifact: Artifact | null }>> {
  const states = new Map<string, { ledger: AttemptLedger; artifact: Artifact | null }>();
  for (const page of pages) {
    const ledger = await latestAttemptLedger(root, page);
    if (ledger?.revisionId !== revisionId) continue;
    states.set(page.id, { ledger, artifact: await authenticateLedgerImage(root, page, ledger) });
  }
  return states;
}

async function recoverProjectAttempts(
  root: string,
  revisionId: string,
  pages: ProjectPage[],
): Promise<void> {
  const recovered = await inspectAttemptStates(root, revisionId, pages);
  if (recovered.size === 0) return;
  await updateBoundProject(root, revisionId, (manifest) => ({
    ...manifest,
    slides: manifest.slides.map((slide) => {
      const state = recovered.get(slide.id);
      if (!state) return slide;
      const { ledger, artifact } = state;
      if (ledger.outcome === "accepted" && artifact) {
        return {
          ...slide,
          status: "ready" as const,
          image: artifact,
        };
      }
      if (ledger.outcome === "generated" && artifact) return { ...slide, status: "generating" as const };
      return { ...slide, status: "failed" as const };
    }),
  }));
}

async function projectPages(root: string, manifest: ProjectManifest): Promise<{ pages: ProjectPage[]; styleName: string }> {
  const plan = await loadValidatedPlan(root);
  const selection = StyleSelectionSchema.parse(JSON.parse((await readOwnedRegularFile(root, "style/selection.json")).toString("utf8")));
  const catalog = await loadBuiltInStyleCatalog();
  const style = catalog.styles.find(({ id }) => id === selection.styleId);
  if (!style) throw new Error("selected style is not in the built-in catalog");
  const stylePrompt = (await readOwnedRegularFile(root, "style/sample/prompt.txt")).toString("utf8");
  const records = new Map(manifest.slides.map((slide) => [slide.id, slide]));
  const pages: ProjectPage[] = [];
  for (const [index, spec] of plan.specs.entries()) {
    const prompt = pagePrompt(stylePrompt, spec);
    pages.push({
      id: spec.slideId,
      order: index,
      title: spec.title,
      role: spec.role,
      requiredText: spec.requiredText,
      prompt,
      promptSha256: hash(prompt),
      status: records.get(spec.slideId)?.status ?? "approved",
      attempts: await attemptCount(root, spec.slideId),
    });
  }
  if (manifest.slides.some((slide) => !pages.some((page) => page.id === slide.id))) {
    throw new Error("manifest slides do not match the current slide specifications");
  }
  return { pages, styleName: style.name };
}

function initialRecord(page: ProjectPage, revisionId: string): SlideRecord {
  return {
    id: page.id,
    order: page.order,
    title: page.title,
    role: page.role,
    specRevisionId: revisionId,
    promptRevisionId: revisionId,
    styleRevisionId: revisionId,
    status: page.status === "ready" ? "ready" : "approved",
    image: null,
    editable: null,
    finalRender: null,
    staleReasons: [],
  };
}

async function updateBoundProject(
  root: string,
  revisionId: string,
  updater: (manifest: ProjectManifest) => ProjectManifest,
): Promise<ProjectManifest> {
  return updateProject(root, (manifest) => {
    if (manifest.currentRevision.id !== revisionId) throw new Error("project revision changed during generation");
    return updater(manifest);
  });
}

function writeLedger(directory: GenerationDirectory, ledger: AttemptLedger): void {
  directory.writeExclusive("ledger.json", `${JSON.stringify(AttemptLedgerSchema.parse(ledger), null, 2)}\n`);
}

function qualityMatches(quality: QualityDecision, requiredText: string[]): void {
  if (
    quality.requiredText.length !== requiredText.length
    || quality.requiredText.some((item, index) => item.text !== requiredText[index])
  ) throw new Error("reviewer returned invalid quality JSON");
}

async function performAttempt(options: {
  root: string;
  revisionId: string;
  page: ProjectPage;
  attempt: number;
  prompt: string;
  provider: ResolvedDependencies["ai"]["providers"][number];
  ai: ResolvedDependencies["ai"];
  runner: string;
  styleName: string;
}): Promise<{ ledger: AttemptLedger; quality: QualityDecision | null; artifact: Artifact | null }> {
  const projectDirectory = openGenerationDirectory(await realpath(options.root));
  const imagesDirectory = projectDirectory.child("images", false);
  const slideDirectory = imagesDirectory.child(options.page.id);
  const slideRoot = slideDirectory.path;
  const attemptName = `attempt-${options.attempt}`;
  const attemptRoot = join(slideRoot, attemptName);
  try {
    await lstat(attemptRoot);
    throw new Error("attempt evidence already exists");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagingName = `.${attemptName}.${randomUUID()}.staging`;
  const stagingDirectory = slideDirectory.child(stagingName);
  const staging = stagingDirectory.path;
  const output = join(staging, "slide.png");
  const started = performance.now();
  let ledger: AttemptLedger;
  let quality: QualityDecision | null = null;
  let promoted = false;
  const promote = () => {
    stagingDirectory.assertCurrent();
    stagingDirectory.close();
    slideDirectory.promoteChildExclusive(stagingName, attemptName);
    promoted = true;
  };
  try {
    try {
      ledger = await generateSlide({
        runner: options.runner,
        modulePath: join(options.ai.root, options.provider.module),
        callable: options.provider.callable,
        providerId: options.provider.id,
        slideId: options.page.id,
        revisionId: options.revisionId,
        prompt: options.prompt,
        output,
        attempt: options.attempt,
        allowedFormats: options.provider.outputFormats,
        trustedRoot: staging,
      });
    } catch (error: unknown) {
      const invalid = error instanceof Error && error.message === "provider output is not an allowed complete image";
      ledger = AttemptLedgerSchema.parse({
        ledgerVersion: 1,
        slideId: options.page.id,
        revisionId: options.revisionId,
        attempt: options.attempt,
        providerId: options.provider.id,
        promptSha256: hash(options.prompt),
        promptPurged: true,
        output: null,
        outputSha256: null,
        outputBytes: null,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        quality: null,
        outcome: "provider-error",
        errorCode: invalid ? "invalid-image" : "provider-failed",
      });
      writeLedger(stagingDirectory, ledger);
      promote();
      return { ledger, quality: null, artifact: null };
    }

    if (options.ai.reviewer) {
      try {
        quality = await reviewSlide({
          runner: options.runner,
          modulePath: join(options.ai.root, options.ai.reviewer.module),
          callable: options.ai.reviewer.callable,
          image: output,
          requiredText: options.page.requiredText,
          styleName: options.styleName,
        });
        qualityMatches(quality, options.page.requiredText);
        ledger = AttemptLedgerSchema.parse({
          ...ledger,
          quality: qualityEvidence(quality),
          outcome: quality.ok ? "accepted" : "rejected",
        });
      } catch {
        ledger = AttemptLedgerSchema.parse({
          ...ledger,
          quality: null,
          outcome: "review-error",
          errorCode: "review-failed",
        });
      }
    }
    const finalOutput = portable(options.root, join(attemptRoot, "slide.png"));
    ledger = AttemptLedgerSchema.parse({ ...ledger, output: finalOutput });
    writeLedger(stagingDirectory, ledger);
    promote();
    const artifact: Artifact = {
      path: finalOutput,
      sha256: ledger.outputSha256!,
      revisionId: options.revisionId,
    };
    return { ledger, quality, artifact };
  } finally {
    if (!promoted) {
      try { stagingDirectory.close(); } catch { /* already closed */ }
      slideDirectory.assertCurrent();
      await rm(staging, { recursive: true, force: true });
    }
    slideDirectory.close();
    imagesDirectory.close();
    projectDirectory.close();
  }
}

async function generateSelected(options: {
  root: string;
  ai: ResolvedDependencies["ai"];
  runner: string;
  concurrency: number;
  selectedIds?: Set<string>;
  operations?: { afterAttemptPromoted?: (pageId: string, attempt: number, ledger: AttemptLedger) => Promise<void> };
}): Promise<ProjectGenerationResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error("concurrency must be between 1 and 8");
  }
  const provider = options.ai.providers.find(({ id }) => id === options.ai.defaultProvider);
  if (!provider) throw new Error("default provider is unavailable");
  return withProjectLease(options.root, "generation", async (root) => {
    const gated = await gateGeneration(root);
    const revisionId = gated.currentRevision.id;
    let prepared = await projectPages(root, gated);
    await updateBoundProject(root, revisionId, (manifest) => {
      const prior = new Map(manifest.slides.map((slide) => [slide.id, slide]));
      return {
        ...manifest,
        stage: "generating",
        slides: prepared.pages.map((page) => prior.get(page.id) ?? initialRecord(page, revisionId)),
      };
    });
    await recoverProjectAttempts(root, revisionId, prepared.pages);
    prepared = await projectPages(root, await readProject(root));
    const attemptStates = await inspectAttemptStates(root, revisionId, prepared.pages);
    const awaitingManual = new Set([...attemptStates.entries()]
      .filter(([, state]) => !options.ai.reviewer && state.ledger.outcome === "generated" && state.artifact)
      .map(([pageId]) => pageId));
    const requested = prepared.pages.filter((page) =>
      (options.selectedIds
        ? options.selectedIds.has(page.id)
        : page.status !== "ready" && !awaitingManual.has(page.id))
    );
    if (options.selectedIds && requested.length !== options.selectedIds.size) throw new Error("retry page is not in the current slide plan");
    if (requested.some((page) => page.status === "ready")) throw new Error("ready pages cannot be retried");
    if (requested.some((page) => awaitingManual.has(page.id))) throw new Error("page is awaiting manual QA");
    if (options.selectedIds && requested.some((page) => page.attempts >= 3)) throw new Error("page has reached the three-attempt limit");
    const selected = requested.filter((page) => page.attempts < 3);

    let cursor = 0;
    let callCount = 0;
    await Promise.all(Array.from({ length: Math.min(options.concurrency, selected.length) }, async () => {
      while (cursor < selected.length) {
        const page = selected[cursor++]!;
        const retained = attemptStates.get(page.id)?.ledger;
        let prompt = retained && retained.attempt === page.attempts && retained.outcome !== "generated"
          ? correctivePromptFromEvidence(page.prompt, retained.quality)
          : page.prompt;
        let finalStatus: SlideRecord["status"] = "failed";
        let finalArtifact: Artifact | null = null;
        const first = page.attempts + 1;
        for (let attempt = first; attempt <= 3; attempt++) {
          callCount += 1;
          if ((await gateGeneration(root)).currentRevision.id !== revisionId) {
            throw new Error("project revision changed during generation");
          }
          await updateBoundProject(root, revisionId, (manifest) => ({
            ...manifest,
            slides: manifest.slides.map((slide) => slide.id === page.id ? { ...slide, status: "generating" } : slide),
          }));
          const result = await performAttempt({
            root,
            revisionId,
            page,
            attempt,
            prompt,
            provider,
            ai: options.ai,
            runner: options.runner,
            styleName: prepared.styleName,
          });
          await options.operations?.afterAttemptPromoted?.(page.id, attempt, result.ledger);
          if (!result.artifact) continue;
          finalArtifact = result.artifact;
          if (!options.ai.reviewer) {
            finalStatus = "generating";
            break;
          }
          if (result.quality?.ok) {
            finalStatus = "ready";
            break;
          }
          if (result.quality) prompt = correctivePrompt(prompt, result.quality);
        }
        if ((await gateGeneration(root)).currentRevision.id !== revisionId) {
          throw new Error("project revision changed during generation");
        }
        await updateBoundProject(root, revisionId, (manifest) => ({
          ...manifest,
          slides: manifest.slides.map((slide) => slide.id === page.id ? {
            ...slide,
            status: finalStatus,
            image: finalStatus === "ready" ? finalArtifact : slide.image,
            promptRevisionId: revisionId,
            styleRevisionId: revisionId,
          } : slide),
        }));
      }
    }));
    const final = await readProject(root);
    const pages = await Promise.all(final.slides.map(async (slide) => ({
      id: slide.id,
      status: slide.status,
      attempts: await attemptCount(root, slide.id),
    })));
    return {
      providerId: provider.id,
      pageCount: selected.length,
      callCount,
      outputRoot: join(root, "images"),
      reviewer: options.ai.reviewer ? "dependency" : "manual",
      pages,
    };
  });
}

export async function describeProjectGeneration(options: {
  root: string;
  ai: ResolvedDependencies["ai"];
  selectedIds?: Set<string>;
}): Promise<GenerationPlan> {
  const provider = options.ai.providers.find(({ id }) => id === options.ai.defaultProvider);
  if (!provider) throw new Error("default provider is unavailable");
  const manifest = await gateGeneration(options.root);
  const prepared = await projectPages(options.root, manifest);
  const attemptStates = await inspectAttemptStates(options.root, manifest.currentRevision.id, prepared.pages);
  const awaitingManual = new Set([...attemptStates.entries()]
    .filter(([, state]) => !options.ai.reviewer && state.ledger.outcome === "generated" && state.artifact)
    .map(([pageId]) => pageId));
  const selected = prepared.pages.filter((page) =>
    options.selectedIds ? options.selectedIds.has(page.id) : page.status !== "ready" && !awaitingManual.has(page.id)
  );
  if (options.selectedIds && selected.length !== options.selectedIds.size) throw new Error("retry page is not in the current slide plan");
  if (selected.some((page) => awaitingManual.has(page.id))) throw new Error("page is awaiting manual QA");
  return {
    providerId: provider.id,
    pageCount: selected.length,
    callCount: selected.reduce((sum, page) => sum + Math.max(0, 3 - page.attempts), 0),
    outputRoot: join(await realpath(options.root), "images"),
    reviewer: options.ai.reviewer ? "dependency" : "manual",
  };
}

export async function generateProject(options: {
  root: string;
  ai: ResolvedDependencies["ai"];
  runner: string;
  concurrency: number;
  operations?: { afterAttemptPromoted?: (pageId: string, attempt: number, ledger: AttemptLedger) => Promise<void> };
}): Promise<ProjectGenerationResult> {
  return generateSelected(options);
}

export async function retryProjectPage(options: {
  root: string;
  slideId: string;
  ai: ResolvedDependencies["ai"];
  runner: string;
}): Promise<ProjectGenerationResult> {
  return generateSelected({ ...options, concurrency: 1, selectedIds: new Set([options.slideId]) });
}

export async function recordManualQa(options: {
  root: string;
  slideId: string;
  input: string;
  ai?: ResolvedDependencies["ai"];
  afterLedgerWritten?: () => Promise<void>;
}): Promise<{ slideId: string; status: "ready" | "failed"; ok: boolean; passedChecks: number; totalChecks: number }> {
  if (options.ai?.reviewer) throw new Error("manual QA is available only when no dependency reviewer exists");
  const inputInfo = await lstat(options.input);
  if (inputInfo.isSymbolicLink() || !inputInfo.isFile()) throw new Error("manual QA input must be a regular file");
  let quality: QualityDecision;
  try {
    quality = QualityDecisionSchema.parse(JSON.parse(readPrivateInputFile(options.input).toString("utf8")));
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "private input must have mode 0600") {
      throw new Error("manual QA input must have mode 0600");
    }
    throw new Error("manual QA evidence is invalid");
  }
  return withProjectLease(options.root, "generation", async (root) => {
    const manifest = await gateGeneration(root);
    const page = (await projectPages(root, manifest)).pages.find(({ id }) => id === options.slideId);
    const slide = manifest.slides.find(({ id }) => id === options.slideId);
    if (!page || !slide || slide.status !== "generating") throw new Error("slide is not awaiting manual QA");
    try {
      qualityMatches(quality, page.requiredText);
    } catch {
      throw new Error("manual QA evidence is invalid");
    }
    const attempt = await attemptCount(root, options.slideId);
    if (attempt < 1) throw new Error("slide has no generated attempt to review");
    const ledgerPath = `images/${options.slideId}/attempt-${attempt}/ledger.json`;
    let ledger: AttemptLedger;
    try {
      ledger = AttemptLedgerSchema.parse(JSON.parse((await readOwnedRegularFile(root, ledgerPath)).toString("utf8")));
    } catch (error: unknown) {
      throw new Error("attempt ledger is invalid", { cause: error });
    }
    if (ledger.revisionId !== manifest.currentRevision.id || ledger.quality !== null || ledger.outcome !== "generated") {
      throw new Error("attempt is not awaiting manual QA");
    }
    const artifact = await authenticateLedgerImage(root, page, ledger);
    if (!artifact) throw new Error("attempt image is missing or invalid");
    const evidence = qualityEvidence(quality);
    const next = AttemptLedgerSchema.parse({ ...ledger, quality: evidence, outcome: quality.ok ? "accepted" : "rejected" });
    const projectDirectory = openGenerationDirectory(await realpath(root));
    const imagesDirectory = projectDirectory.child("images", false);
    const slideDirectory = imagesDirectory.child(options.slideId, false);
    const attemptDirectory = slideDirectory.child(`attempt-${attempt}`, false);
    try {
      attemptDirectory.replace("ledger.json", `${JSON.stringify(next, null, 2)}\n`, `.ledger.${randomUUID()}.staging`);
    } finally {
      attemptDirectory.close();
      slideDirectory.close();
      imagesDirectory.close();
      projectDirectory.close();
    }
    await options.afterLedgerWritten?.();
    await updateBoundProject(root, manifest.currentRevision.id, (current) => ({
      ...current,
      slides: current.slides.map((record) => record.id === options.slideId ? {
        ...record,
        status: quality.ok ? "ready" : "failed",
        image: quality.ok ? artifact : record.image,
      } : record),
    }));
    const passedChecks = evidence.requiredText.filter((item) => item.present && item.exact).length
      + [evidence.styleConsistent, evidence.hierarchyClear, evidence.richDetail, evidence.noForbiddenContent]
        .filter(Boolean).length;
    return {
      slideId: options.slideId,
      status: quality.ok ? "ready" : "failed",
      ok: quality.ok,
      passedChecks,
      totalChecks: evidence.requiredText.length + 4,
    };
  });
}
