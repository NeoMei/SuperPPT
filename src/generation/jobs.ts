import { createHash, randomUUID } from "node:crypto";
import { fsyncSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { AiImageSkillDependencySchema, type AiImageSkillDependency } from "../dependencies/schemas.js";
import { loadValidatedPlan } from "../planning/load.js";
import type { SlideSpec } from "../planning/schemas.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import { canonicalStyleSample } from "../styles/sample-contract.js";
import { compileSlidePrompt } from "../styles/prompt-compiler.js";
import { readApprovedStyleLock, readStyleLock, type LockedStyle } from "../styles/style-lock.js";
import {
  assertAiImageSkillDependencyCurrent,
  assertAuthorizedJobBinding,
  assertPreviousPromptPublished,
  authorizationCallBudget,
  authorizationForPreparation,
} from "./authorization.js";
import { openGenerationDirectory, type GenerationDirectory } from "./anchored-dir.js";
import {
  ImageGenerationJobSchema,
  canonicalContractFile,
  type GenerationAuthorizationPlan,
  type ImageGenerationJob,
} from "./job-schemas.js";

const DeckRequestSchema = z.object({
  kind: z.literal("deck"),
  aiDependency: AiImageSkillDependencySchema,
  callBudget: z.number().int().positive().optional(),
}).strict();

const StyleSampleRequestSchema = z.object({
  kind: z.literal("style-sample"),
  aiDependency: AiImageSkillDependencySchema,
}).strict();

const PageRegenerationRequestSchema = z.object({
  kind: z.literal("page-regeneration"),
  aiDependency: AiImageSkillDependencySchema,
  slideId: z.string().uuid(),
  previousPromptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  finalPrompt: z.string().min(1),
}).strict();

const PrepareImageGenerationJobRequestSchema = z.discriminatedUnion("kind", [
  DeckRequestSchema,
  StyleSampleRequestSchema,
  PageRegenerationRequestSchema,
]);

export type PrepareImageGenerationJobRequest = z.input<typeof PrepareImageGenerationJobRequestSchema>;

export type PrepareImageGenerationJobCheckpoint = "sealed-inputs-synced";

export type PrepareImageGenerationJobOperations = {
  checkpoint?: (
    step: PrepareImageGenerationJobCheckpoint,
    stagingRoot: string,
  ) => Promise<void> | void;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function embeddedLock(lock: LockedStyle): ImageGenerationJob["styleLock"] {
  const { styleLockSha256: _styleLockSha256, ...value } = lock;
  return value;
}

function dependencyBinding(ai: AiImageSkillDependency): ImageGenerationJob["aiSkill"] {
  return {
    root: ai.root,
    skillSha256: ai.skillSha256,
    gitRevision: ai.gitRevision,
    scripts: {
      generationResult: { path: ai.scripts.generationResult, sha256: ai.scriptSha256.generationResult },
      hostRoutingPolicy: { path: ai.scripts.hostRoutingPolicy, sha256: ai.scriptSha256.hostRoutingPolicy },
      importHostImage: { path: ai.scripts.importHostImage, sha256: ai.scriptSha256.importHostImage },
      prepareEditableInput: { path: ai.scripts.prepareEditableInput, sha256: ai.scriptSha256.prepareEditableInput },
    },
  };
}

async function readPublishedJobs(root: string): Promise<ImageGenerationJob[]> {
  let entries;
  try {
    entries = await readdir(join(root, "generation", "jobs"), { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: ImageGenerationJob[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.name.startsWith("."))) {
      throw new Error("generation jobs directory contains an unsafe entry");
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) jobs.push(await readImageGenerationJob(root, entry.name));
  }
  return jobs;
}

async function nextAttempt(root: string, slideId: string): Promise<number> {
  const attempts = (await readPublishedJobs(root)).flatMap((job) =>
    job.pages.filter((page) => page.slideId === slideId).map(({ attempt }) => attempt)
  );
  return (attempts.length === 0 ? 0 : Math.max(...attempts)) + 1;
}

function assertCommonAuthorization(options: {
  plan: GenerationAuthorizationPlan;
  manifest: Awaited<ReturnType<typeof readProject>>;
  ai: AiImageSkillDependency;
  lock: LockedStyle;
}): void {
  if (
    options.plan.projectId !== options.manifest.projectId
    || options.plan.projectRevisionId !== options.manifest.currentRevision.id
    || !sameJson(options.plan.aiSkill, dependencyBinding(options.ai))
    || options.plan.styleLockSha256 !== options.lock.styleLockSha256
    || !sameJson(options.plan.outboundDisclosure, {
      sendsText: true,
      references: options.lock.referenceArtifacts,
    })
  ) throw new Error("generation authorization does not match current project, style, or dependency identity");
}

type PreparedPage = {
  slideId: string;
  order: number;
  attempt: number;
  finalPrompt: string;
  spec: SlideSpec;
};

async function preparePages(
  root: string,
  request: z.output<typeof PrepareImageGenerationJobRequestSchema>,
  plan: GenerationAuthorizationPlan,
  lock: LockedStyle,
  authorizationDigest: string,
): Promise<PreparedPage[]> {
  const validated = await loadValidatedPlan(root);
  if (request.kind === "style-sample") {
    if (plan.kind !== "style-sample") throw new Error("style sample generation authorization has the wrong job kind");
    const sample = await canonicalStyleSample(root);
    const order = validated.outline.slides.find(({ id }) => id === sample.spec.slideId)?.order;
    if (order === undefined) throw new Error("representative slide is not ordered in the current plan");
    const pages = [{ slideId: sample.spec.slideId, order, attempt: 1, finalPrompt: sample.compiled.text, spec: sample.spec }];
    if (!sameJson(plan.pages, pages.map(({ slideId, order, finalPrompt }) => ({ slideId, order, promptSha256: sha256(finalPrompt) })))) {
      throw new Error("style sample prompt does not match its generation authorization");
    }
    return pages;
  }
  if (request.kind === "deck") {
    if (plan.kind !== "deck") throw new Error("deck generation requires a deck authorization plan");
    const pages = validated.specs.map((spec) => ({
      slideId: spec.slideId,
      order: validated.outline.slides.find(({ id }) => id === spec.slideId)!.order,
      attempt: 1,
      finalPrompt: compileSlidePrompt({ spec, styleLock: lock }).text,
      spec,
    }));
    if (request.callBudget !== undefined && request.callBudget !== plan.callBudget) {
      if (request.callBudget < pages.length) throw new Error("job call budget cannot be smaller than the initial page count");
      throw new Error("job call budget must equal its generation authorization");
    }
    if (!sameJson(plan.pages, pages.map(({ slideId, order, finalPrompt }) => ({ slideId, order, promptSha256: sha256(finalPrompt) })))) {
      throw new Error("deck prompts or page order do not match generation authorization");
    }
    return pages;
  }

  const specIndex = validated.specs.findIndex(({ slideId }) => slideId === request.slideId);
  if (specIndex < 0) throw new Error("page-regeneration slide is not in the current plan");
  const promptSha256 = sha256(request.finalPrompt);
  if (promptSha256 === request.previousPromptSha256) throw new Error("page-regeneration requires a new prompt hash");
  if (plan.kind === "page-regeneration") {
    await assertPreviousPromptPublished(
      root,
      request.slideId,
      request.previousPromptSha256,
      plan.previousAuthorizationDigest!,
    );
    if (
      plan.previousPromptSha256 !== request.previousPromptSha256
      || plan.pages.length !== 1
      || plan.pages[0]!.slideId !== request.slideId
      || plan.pages[0]!.promptSha256 !== promptSha256
    ) throw new Error("page-regeneration prompt does not match incremental generation authorization");
  } else if (plan.kind === "deck") {
    await assertPreviousPromptPublished(root, request.slideId, request.previousPromptSha256, authorizationDigest);
    const original = plan.pages.find(({ slideId }) => slideId === request.slideId);
    if (!original || original.promptSha256 !== request.previousPromptSha256) {
      throw new Error("page-regeneration previous prompt does not match deck authorization");
    }
    const budget = await authorizationCallBudget(root, authorizationDigest, plan.callBudget);
    if (budget.remaining === 0) throw new Error("incremental generation authorization is required after call budget exhaustion");
  } else {
    throw new Error("page-regeneration has no applicable generation authorization");
  }
  return [{
    slideId: request.slideId,
    order: validated.outline.slides.find(({ id }) => id === request.slideId)!.order,
    attempt: await nextAttempt(root, request.slideId),
    finalPrompt: request.finalPrompt,
    spec: validated.specs[specIndex]!,
  }];
}

type SealedJobBytes = {
  styleLock: Buffer;
  styleRecipe: Buffer;
  approvedSample: Buffer | null;
  references: Buffer[];
  specs: Buffer[];
};

async function prepareSealedInputs(
  root: string,
  jobId: string,
  lock: LockedStyle,
  pages: PreparedPage[],
): Promise<{ sealedInputs: ImageGenerationJob["sealedInputs"]; bytes: SealedJobBytes }> {
  const styleLock = await readOwnedRegularFile(root, "style/lock.json");
  const styleRecipe = await readOwnedRegularFile(root, "style/recipe.json");
  const approvedSample = lock.approvedSample ? await readOwnedRegularFile(root, lock.approvedSample.path) : null;
  const references = await Promise.all(lock.referenceArtifacts.map(({ path }) => readOwnedRegularFile(root, path)));
  const specs = await Promise.all(pages.map(async (page) => {
    const bytes = await readOwnedRegularFile(root, `slides/${page.slideId}/spec.json`);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!sameJson(parsed, page.spec)) throw new Error("slide spec changed while sealing image generation inputs");
    return bytes;
  }));
  if (sha256(styleLock) !== lock.styleLockSha256 || sha256(styleRecipe) !== lock.styleRecipeSha256) {
    throw new Error("style inputs changed while sealing image generation inputs");
  }
  const inputBase = `generation/jobs/${jobId}/inputs`;
  return {
    sealedInputs: {
      styleLock: { path: `${inputBase}/style-lock.json`, sha256: sha256(styleLock) },
      styleRecipe: { path: `${inputBase}/style-recipe.json`, sha256: sha256(styleRecipe) },
      approvedSample: approvedSample === null ? null : {
        path: `${inputBase}/approved-sample.bin`,
        sha256: sha256(approvedSample),
      },
      references: lock.referenceArtifacts.map((reference, index) => ({
        sourcePath: reference.path,
        role: reference.role,
        snapshot: { path: `${inputBase}/references/${index}.bin`, sha256: sha256(references[index]!) },
      })),
    },
    bytes: { styleLock, styleRecipe, approvedSample, references, specs },
  };
}

function writePromptArtifacts(root: string, job: ImageGenerationJob): void {
  const project = openGenerationDirectory(root);
  let slides: GenerationDirectory | undefined;
  try {
    slides = project.child("slides", false);
    for (const page of job.pages) {
      const slide = slides.child(page.slideId, false);
      const prompts = slide.child("prompts");
      try {
        prompts.writeExclusive(`${job.jobId}.txt`, page.finalPrompt);
        if (prompts.fd >= 0) fsyncSync(prompts.fd);
        if (slide.fd >= 0) fsyncSync(slide.fd);
      } finally {
        prompts.close();
        slide.close();
      }
    }
  } finally {
    slides?.close();
    project.close();
  }
}

function entries(directory: GenerationDirectory): Dirent[] {
  directory.assertCurrent();
  const values = readdirSync(directory.path, { withFileTypes: true });
  directory.assertCurrent();
  return values;
}

function validateOwnedEntries(
  directory: GenerationDirectory,
  allowedFiles: ReadonlySet<string>,
  allowedDirectories: ReadonlySet<string>,
): Dirent[] {
  const values = entries(directory);
  for (const entry of values) {
    if (
      entry.isSymbolicLink()
      || (allowedFiles.has(entry.name) ? !entry.isFile() : (
        allowedDirectories.has(entry.name) ? !entry.isDirectory() : true
      ))
    ) throw new Error("image job staging contains unexpected or unsafe evidence");
  }
  return values;
}

function cleanupOwnedJobStaging(
  jobs: GenerationDirectory,
  stagingName: string,
  job: ImageGenerationJob,
): void {
  const staging = jobs.child(stagingName, false);
  let output: GenerationDirectory | undefined;
  let inputs: GenerationDirectory | undefined;
  let references: GenerationDirectory | undefined;
  let specs: GenerationDirectory | undefined;
  try {
    const rootEntries = validateOwnedEntries(
      staging,
      new Set(["job.json"]),
      new Set(["ai-image-output", "inputs"]),
    );
    const rootDirectoryNames = new Set(rootEntries.filter((entry) => entry.isDirectory()).map(({ name }) => name));
    output = rootDirectoryNames.has("ai-image-output") ? staging.child("ai-image-output", false) : undefined;
    const outputEntries = output ? validateOwnedEntries(output, new Set(), new Set()) : [];
    inputs = rootDirectoryNames.has("inputs") ? staging.child("inputs", false) : undefined;
    const inputEntries = inputs ? validateOwnedEntries(
      inputs,
      new Set([
        "style-lock.json",
        "style-recipe.json",
        ...(job.sealedInputs.approvedSample ? ["approved-sample.bin"] : []),
      ]),
      new Set(["references", "specs"]),
    ) : [];
    const inputDirectoryNames = new Set(inputEntries.filter((entry) => entry.isDirectory()).map(({ name }) => name));
    references = inputs && inputDirectoryNames.has("references") ? inputs.child("references", false) : undefined;
    const referenceEntries = references ? validateOwnedEntries(
      references,
      new Set(job.sealedInputs.references.map((_reference, index) => `${index}.bin`)),
      new Set(),
    ) : [];
    specs = inputs && inputDirectoryNames.has("specs") ? inputs.child("specs", false) : undefined;
    const specEntries = specs ? validateOwnedEntries(
      specs,
      new Set(job.pages.map(({ slideId }) => `${slideId}.json`)),
      new Set(),
    ) : [];

    for (const entry of referenceEntries) references!.remove(entry.name);
    if (references) {
      references.close();
      references = undefined;
      inputs!.removeEmptyChild("references");
    }
    for (const entry of specEntries) specs!.remove(entry.name);
    if (specs) {
      specs.close();
      specs = undefined;
      inputs!.removeEmptyChild("specs");
    }
    for (const entry of inputEntries.filter((entry) => entry.isFile())) inputs!.remove(entry.name);
    if (inputs) {
      inputs.close();
      inputs = undefined;
      staging.removeEmptyChild("inputs");
    }
    if (output) {
      for (const entry of outputEntries) output.remove(entry.name);
      output.close();
      output = undefined;
      staging.removeEmptyChild("ai-image-output");
    }
    for (const entry of rootEntries.filter((entry) => entry.isFile())) staging.remove(entry.name);
  } finally {
    specs?.close();
    references?.close();
    inputs?.close();
    output?.close();
    staging.close();
  }
  jobs.removeEmptyChild(stagingName);
}

async function publishJob(
  root: string,
  job: ImageGenerationJob,
  sealed: SealedJobBytes,
  operations: PrepareImageGenerationJobOperations,
): Promise<void> {
  const project = openGenerationDirectory(root);
  const generation = project.child("generation");
  if (project.fd >= 0) fsyncSync(project.fd);
  const jobs = generation.child("jobs");
  if (generation.fd >= 0) fsyncSync(generation.fd);
  const stagingName = `.${job.jobId}.staging`;
  const staging = jobs.createChildExclusive(stagingName);
  let stagingClosed = false;
  try {
    const output = staging.child("ai-image-output");
    output.close();
    const inputs = staging.child("inputs");
    try {
      inputs.writeExclusive("style-lock.json", sealed.styleLock);
      inputs.writeExclusive("style-recipe.json", sealed.styleRecipe);
      if (sealed.approvedSample) inputs.writeExclusive("approved-sample.bin", sealed.approvedSample);
      const references = inputs.child("references");
      try {
        sealed.references.forEach((bytes, index) => references.writeExclusive(`${index}.bin`, bytes));
        if (references.fd >= 0) fsyncSync(references.fd);
      } finally { references.close(); }
      const specs = inputs.child("specs");
      try {
        job.pages.forEach((page, index) => specs.writeExclusive(`${page.slideId}.json`, sealed.specs[index]!));
        if (specs.fd >= 0) fsyncSync(specs.fd);
      } finally { specs.close(); }
      if (inputs.fd >= 0) fsyncSync(inputs.fd);
    } finally { inputs.close(); }
    await operations.checkpoint?.("sealed-inputs-synced", staging.path);
    staging.writeExclusive("job.json", canonicalContractFile(job));
    if (staging.fd >= 0) fsyncSync(staging.fd);
    staging.close();
    stagingClosed = true;
    jobs.promoteChildExclusive(stagingName, job.jobId);
  } catch (error: unknown) {
    if (!stagingClosed) {
      try { staging.close(); } catch { /* cleanup reopens the anchored owned directory */ }
    }
    try { cleanupOwnedJobStaging(jobs, stagingName, job); } catch { /* retain unexpected evidence for inspection */ }
    throw error;
  } finally {
    jobs.close();
    generation.close();
    project.close();
  }
}

export async function prepareImageGenerationJob(
  root: string,
  rawRequest: PrepareImageGenerationJobRequest,
  operations: PrepareImageGenerationJobOperations = {},
): Promise<ImageGenerationJob> {
  let request: z.output<typeof PrepareImageGenerationJobRequestSchema>;
  try {
    request = PrepareImageGenerationJobRequestSchema.parse(rawRequest);
  } catch (error: unknown) {
    throw new Error("invalid image generation job request", { cause: error });
  }
  return withProjectLease(root, "generation", async (canonicalRoot) => {
    const ai = await assertAiImageSkillDependencyCurrent(request.aiDependency);
    const authorization = await authorizationForPreparation(canonicalRoot, request.kind);
    const [manifest, lock] = await Promise.all([
      readProject(canonicalRoot),
      request.kind === "style-sample" ? readStyleLock(canonicalRoot) : readApprovedStyleLock(canonicalRoot),
    ]);
    if (request.kind === "style-sample" && lock.approvalState !== "provisional") {
      throw new Error("style-sample image generation job requires a provisional style lock");
    }
    assertCommonAuthorization({ plan: authorization.plan, manifest, ai, lock });
    const preparedPages = await preparePages(canonicalRoot, request, authorization.plan, lock, authorization.digest);
    if (authorization.plan.callBudget < preparedPages.length) {
      throw new Error("job call budget cannot be smaller than the initial page count");
    }
    const jobId = randomUUID();
    const sealed = await prepareSealedInputs(canonicalRoot, jobId, lock, preparedPages);
    const job = ImageGenerationJobSchema.parse({
      contractVersion: 1,
      jobId,
      kind: request.kind,
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      authorizationDigest: authorization.digest,
      authorizationPlan: authorization.plan,
      authorizationGate: authorization.gate,
      routePolicy: "ai-image-to-ppt-default",
      aiSkill: dependencyBinding(ai),
      styleLockPath: "style/lock.json",
      styleLockSha256: lock.styleLockSha256,
      styleLock: embeddedLock(lock),
      sealedInputs: sealed.sealedInputs,
      callBudget: authorization.plan.callBudget,
      outboundDisclosure: { sendsText: true, references: lock.referenceArtifacts },
      pages: preparedPages.map((page, index) => ({
        ...page,
        promptArtifact: `slides/${page.slideId}/prompts/${jobId}.txt`,
        promptSha256: sha256(page.finalPrompt),
        target: `generation/jobs/${jobId}/ai-image-output/${page.slideId}.png`,
        spec: page.spec,
        specSnapshot: {
          path: `generation/jobs/${jobId}/inputs/specs/${page.slideId}.json`,
          sha256: sha256(sealed.bytes.specs[index]!),
        },
      })),
      createdAt: new Date().toISOString(),
    });
    writePromptArtifacts(canonicalRoot, job);
    await publishJob(canonicalRoot, job, sealed.bytes, operations);
    await assertAuthorizedJobBinding(canonicalRoot, job);
    return job;
  });
}

export async function readImageGenerationJob(root: string, jobId: string): Promise<ImageGenerationJob> {
  if (!z.string().uuid().safeParse(jobId).success) throw new Error("image generation job ID must be a UUID");
  const bytes = await readOwnedRegularFile(root, `generation/jobs/${jobId}/job.json`).catch((error: unknown) => {
    throw new Error("immutable image generation job is unavailable", { cause: error });
  });
  try {
    const job = ImageGenerationJobSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (job.jobId !== jobId || bytes.toString("utf8") !== canonicalContractFile(job)) throw new Error("canonical job identity mismatch");
    return job;
  } catch (error: unknown) {
    throw new Error("immutable image generation job is invalid", { cause: error });
  }
}

export async function assertJobAuthorized(root: string, job: ImageGenerationJob): Promise<void> {
  await withProjectLease(root, "generation", async (canonicalRoot) => {
    await assertAuthorizedJobBinding(canonicalRoot, ImageGenerationJobSchema.parse(job));
  });
}
