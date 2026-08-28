import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

import { preflightDependencies } from "../dependencies/preflight.js";
import type { ResolvedDependencies } from "../dependencies/schemas.js";
import { assertAiImageSkillDependencyCurrent } from "../generation/authorization.js";
import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { validateProjectRoot } from "../project/paths.js";
import { readOwnedRegularFile, readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject, sha256 as projectSha256 } from "../project/store.js";
import {
  ConversionRecordSchema,
  ConverterOwnershipMarkerSchema,
  EditableManifestSchema,
  EditableRevisionMarkerSchema,
  EditableSlideMarkerSchema,
  RunLedgerV2Schema,
  type EditableManifest,
  type RunLedgerV2,
} from "./schemas.js";

const execFileAsync = promisify(execFile);
const OUTPUT_MARKER = ".image-to-editable-pptx-output.json";
const MAX_JSON = 16 * 1024 * 1024;
const MAX_ASSET = 64 * 1024 * 1024;
const MAX_OUTPUT = 512 * 1024 * 1024;

export type EditableConverterExecutor = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    maxBuffer: number;
  },
) => Promise<{ stdout?: string; stderr?: string } | void>;

export type EditableInputPreparationExecutor = EditableConverterExecutor;

export type EditableArtifactHashes = {
  sourceImage: string;
  manifest: string;
  runLedger: string;
  cleanBackground: string;
  assets: Record<string, string>;
  outputs: Record<string, string>;
};

export type EditableConversionResult = {
  converterRoot: string;
  outputRoot: string;
  manifestPath: string;
  cleanBackground: string;
  ledgerPath: string;
  manifest: EditableManifest;
  ledger: RunLedgerV2;
  artifactHashes: EditableArtifactHashes;
};

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

function versionTuple(value: string): [number, number, number] | null {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function nodeSupported(value: string): boolean {
  const parsed = versionTuple(value);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major > 22 || (major === 22 && minor >= 6);
}

function compatibleConverterVersion(value: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return Boolean(match && match[1] === "0" && match[2] === "1");
}

async function boundedRegularFile(path: string, maximum: number, label: string): Promise<Buffer> {
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    throw new Error(`${label} must be a regular non-symlink file`, { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > maximum) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  try {
    return await readRegularFileNoFollow(path);
  } catch (error: unknown) {
    throw new Error(`${label} must be a regular non-symlink file`, { cause: error });
  }
}

async function parseJson<T>(path: string, maximum: number, label: string, parse: (raw: unknown) => T): Promise<{ value: T; bytes: Buffer }> {
  const bytes = await boundedRegularFile(path, maximum, label);
  try {
    return { value: parse(JSON.parse(bytes.toString("utf8"))), bytes };
  } catch (error: unknown) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
}

async function requireDirectory(path: string, label: string): Promise<string> {
  const info = await lstat(path).catch((error: unknown) => {
    throw new Error(`${label} must be a regular non-symlink directory`, { cause: error });
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  return realpath(path);
}

async function validateConverterRoot(root: string, nodeVersion: string): Promise<string> {
  if (!nodeSupported(nodeVersion)) throw new Error("image-to-editable-pptx requires Node.js 22.6 or newer");
  const canonical = await requireDirectory(resolve(root), "converter root");
  const pkgPath = join(canonical, "package.json");
  const { value: pkg } = await parseJson(pkgPath, MAX_JSON, "converter package", (value) => value as {
    name?: unknown;
    version?: unknown;
    engines?: { node?: unknown };
    scripts?: { cli?: unknown };
  });
  if (
    pkg.name !== "image-to-editable-pptx"
    || typeof pkg.version !== "string"
    || !compatibleConverterVersion(pkg.version)
    || pkg.engines?.node !== ">=22.6"
    || typeof pkg.scripts?.cli !== "string"
    || !pkg.scripts.cli.trim()
  ) throw new Error("converter package is not a compatible image-to-editable-pptx 0.1.x package");
  const skill = join(canonical, "skills", "image-to-editable-pptx", "SKILL.md");
  await boundedRegularFile(skill, MAX_JSON, "converter Skill entry");
  return canonical;
}

async function converterVersion(root: string): Promise<string> {
  const parsed = await parseJson(join(root, "package.json"), MAX_JSON, "converter package", (value) => value as { version?: unknown });
  if (typeof parsed.value.version !== "string") throw new Error("converter package version is invalid");
  return parsed.value.version;
}

async function exactPng(path: string, width: number, height: number, label: string): Promise<Buffer> {
  const bytes = await boundedRegularFile(path, MAX_OUTPUT, label);
  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
    await sharp(bytes).raw().toBuffer();
  } catch (error: unknown) {
    throw new Error(`${label} must be a valid PNG`, { cause: error });
  }
  if (metadata.format !== "png" || metadata.width !== width || metadata.height !== height) {
    throw new Error(`${label} must be an exact ${width}x${height} PNG`);
  }
  return bytes;
}

async function transparentPng(bytes: Buffer): Promise<boolean> {
  try {
    const metadata = await sharp(bytes).metadata();
    if (metadata.format !== "png" || !metadata.hasAlpha) return false;
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = info.channels - 1;
    for (let index = alpha; index < data.length; index += info.channels) {
      if (data[index]! < 255) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function inside(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

async function freshOutputPath(path: string, source: string): Promise<void> {
  const absolute = resolve(path);
  const parent = await realpath(dirname(absolute));
  const expected = join(parent, basename(absolute));
  const sourcePhysical = await realpath(source);
  if (inside(expected, sourcePhysical) || inside(sourcePhysical, expected)) {
    throw new Error("converter output must not be the source or its ancestor");
  }
  try {
    await lstat(absolute);
    throw new Error("converter output must be a fresh path");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function expectedOutput(outDir: string, output: string, relativeName: string): void {
  if (resolve(output) !== resolve(outDir, relativeName)) {
    throw new Error(`converter ledger output path mismatch: ${relativeName}`);
  }
}

function sameBox(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function validateDecisionBinding(manifest: EditableManifest, ledger: RunLedgerV2): void {
  const accepted = ledger.decisions.filter((decision) => decision.decision === "accepted");
  if (accepted.length !== manifest.elements.length) {
    throw new Error("converter ledger decision count does not match editable manifest elements");
  }
  const byElement = new Map<string, (typeof accepted)[number]>();
  for (const decision of accepted) {
    if (decision.output.state !== "editable_layer") {
      throw new Error("accepted converter ledger decision must publish an editable layer");
    }
    if (byElement.has(decision.output.manifestElementId)) {
      throw new Error("converter ledger decisions must bind manifest elements one-to-one");
    }
    byElement.set(decision.output.manifestElementId, decision);
  }
  for (const element of manifest.elements) {
    const decision = byElement.get(element.id);
    if (!decision || decision.output.state !== "editable_layer" || !sameBox(decision.bbox, element.bbox)) {
      throw new Error(`converter ledger decision does not authenticate manifest element: ${element.id}`);
    }
    if (element.kind === "text") {
      if (decision.kind !== "text" || decision.extraction !== "none" || decision.output.assetPath !== undefined) {
        throw new Error(`converter ledger decision does not authenticate text element: ${element.id}`);
      }
    } else if (
      decision.kind !== "icon"
      || decision.extraction !== "transparent"
      || decision.output.assetPath !== element.assetPath
    ) {
      throw new Error(`converter ledger decision does not authenticate asset element: ${element.id}`);
    }
  }
}

async function verifyHash(path: string, expected: string, label: string, maximum = MAX_OUTPUT): Promise<{ bytes: Buffer; hash: string }> {
  const bytes = await boundedRegularFile(path, maximum, label);
  const hash = sha256(bytes);
  if (hash !== expected) throw new Error(`${label} hash mismatch`);
  return { bytes, hash };
}

async function verifyOutputHash(
  outDir: string,
  projectPath: string,
  expected: string,
  label: string,
  maximum = MAX_OUTPUT,
): Promise<{ bytes: Buffer; hash: string }> {
  const canonicalRoot = await realpath(outDir);
  const lexical = join(canonicalRoot, ...projectPath.split("/"));
  let physical: string;
  try {
    physical = await realpath(lexical);
  } catch (error: unknown) {
    throw new Error(`${label} must stay inside converter output`, { cause: error });
  }
  if (physical !== lexical) throw new Error(`${label} contains a symlink or is outside converter output`);
  const checked = await verifyHash(lexical, expected, label, maximum);
  if (await realpath(lexical) !== physical) throw new Error(`${label} changed through a symlink while reading`);
  return checked;
}

async function verifyConverterOutput(outDir: string, sourceBytes: Buffer): Promise<Omit<EditableConversionResult, "converterRoot">> {
  const canonicalOutput = await requireDirectory(outDir, "converter output");
  const canonicalParent = await realpath(dirname(resolve(outDir)));
  if (canonicalOutput !== join(canonicalParent, basename(resolve(outDir)))) {
    throw new Error("converter output path contains an unsafe symlink");
  }
  await parseJson(join(outDir, OUTPUT_MARKER), MAX_JSON, "converter ownership marker", (value) => ConverterOwnershipMarkerSchema.parse(value));
  const manifestPath = join(outDir, "manifest.json");
  const parsedManifest = await parseJson(manifestPath, MAX_JSON, "converter manifest", (value) => EditableManifestSchema.parse(value));
  const ledgerPath = join(outDir, "run-ledger.json");
  const parsedLedger = await parseJson(ledgerPath, MAX_JSON, "converter run ledger", (value) => RunLedgerV2Schema.parse(value));
  const { value: manifest, bytes: manifestBytes } = parsedManifest;
  const { value: ledger, bytes: ledgerBytes } = parsedLedger;
  validateDecisionBinding(manifest, ledger);
  if (ledger.hashes.sourceImage !== sha256(sourceBytes)) throw new Error("source image hash mismatch");
  if (ledger.hashes.manifest !== sha256(manifestBytes)) throw new Error("converter manifest hash mismatch");

  const outputNames = {
    ocr: "ocr.json",
    vision: "vision.json",
    analysisLedger: "analysis-ledger.json",
    manifest: "manifest.json",
    removalMask: "removal-mask.png",
    cleanBackground: "clean-background.png",
  } as const;
  if (resolve(ledger.outputs.directory) !== resolve(outDir)) throw new Error("converter ledger output path mismatch: directory");
  for (const [key, name] of Object.entries(outputNames) as Array<[keyof typeof outputNames, string]>) {
    expectedOutput(outDir, ledger.outputs[key], name);
  }
  expectedOutput(outDir, ledger.outputs.assets, "assets");
  const pptxRelative = basename(ledger.outputs.pptx);
  if (extname(pptxRelative).toLowerCase() !== ".pptx") throw new Error("converter ledger PPTX output path is invalid");
  expectedOutput(outDir, ledger.outputs.pptx, pptxRelative);
  await requireDirectory(join(outDir, "assets"), "converter asset directory");

  const outputHashes: Record<string, string> = {};
  const hashOutputs = {
    ocr: ledger.hashes.ocr,
    vision: ledger.hashes.vision,
    analysisLedger: ledger.hashes.analysisLedger,
    removalMask: ledger.hashes.removalMask,
    cleanBackground: ledger.hashes.cleanBackground,
  } as const;
  for (const [key, expected] of Object.entries(hashOutputs) as Array<[keyof typeof hashOutputs, string]>) {
    const name = outputNames[key];
    const checked = await verifyOutputHash(outDir, name, expected, `converter output ${name}`);
    outputHashes[name] = checked.hash;
  }
  const pptx = await verifyOutputHash(outDir, pptxRelative, ledger.hashes.pptx, "converter PPTX output");
  outputHashes[pptxRelative] = pptx.hash;
  await exactPng(join(outDir, "clean-background.png"), 1280, 720, "clean background");
  await exactPng(join(outDir, "removal-mask.png"), 1280, 720, "removal mask");

  const referencedAssets = manifest.elements.flatMap((element) => element.kind === "asset" ? [element.assetPath] : []);
  if (new Set(referencedAssets).size !== referencedAssets.length) throw new Error("converter manifest asset paths must be unique");
  const ledgerAssetKeys = Object.keys(ledger.hashes.assets).sort();
  if (JSON.stringify([...referencedAssets].sort()) !== JSON.stringify(ledgerAssetKeys)) {
    throw new Error("converter asset hashes must exactly authenticate referenced assets");
  }
  const assetHashes: Record<string, string> = {};
  for (const assetPath of referencedAssets) {
    const checked = await verifyOutputHash(outDir, assetPath, ledger.hashes.assets[assetPath]!, `converter asset ${assetPath}`, MAX_ASSET);
    if (!await transparentPng(checked.bytes)) throw new Error(`converter asset ${assetPath} must be a transparent PNG`);
    assetHashes[assetPath] = checked.hash;
  }
  return {
    outputRoot: canonicalOutput,
    manifestPath,
    cleanBackground: join(outDir, "clean-background.png"),
    ledgerPath,
    manifest,
    ledger,
    artifactHashes: {
      sourceImage: sha256(sourceBytes),
      manifest: sha256(manifestBytes),
      runLedger: sha256(ledgerBytes),
      cleanBackground: ledger.hashes.cleanBackground,
      assets: assetHashes,
      outputs: outputHashes,
    },
  };
}

export async function prepareConversionInput(source: string, target: string): Promise<void> {
  const input = await boundedRegularFile(source, MAX_OUTPUT, "generated page source");
  const parent = dirname(resolve(target));
  await requireDirectory(parent, "conversion input parent");
  try {
    await lstat(target);
    throw new Error("conversion input target must be a fresh regular non-symlink path");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const output = await sharp(input).resize(1280, 720, { fit: "cover", position: "centre" }).png().toBuffer();
  await writeDurableExclusive(target, output);
  await syncDirectory(parent);
  await exactPng(target, 1280, 720, "conversion input");
}

export async function runEditableConversion(options: {
  converterRoot: string;
  sourcePng: string;
  outDir: string;
  execute?: EditableConverterExecutor;
  nodeVersion?: string;
}): Promise<EditableConversionResult> {
  const converterRoot = await validateConverterRoot(options.converterRoot, options.nodeVersion ?? process.versions.node);
  const sourceBytes = await exactPng(options.sourcePng, 1280, 720, "converter source");
  await freshOutputPath(options.outDir, options.sourcePng);
  const execute = options.execute ?? (execFileAsync as unknown as EditableConverterExecutor);
  try {
    await execute(
      "npm",
      ["run", "cli", "--", "run", "--image", options.sourcePng, "--out", options.outDir],
      {
        cwd: converterRoot,
        env: { ...process.env },
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (error: unknown) {
    throw new Error("image-to-editable-pptx conversion failed; retained output evidence may be inspected", { cause: error });
  }
  return {
    converterRoot,
    ...await verifyConverterOutput(options.outDir, sourceBytes),
  };
}

export async function validateEditableConversionOutput(options: {
  sourcePng: string;
  outDir: string;
}): Promise<Omit<EditableConversionResult, "converterRoot">> {
  const sourceBytes = await exactPng(options.sourcePng, 1280, 720, "converter source");
  return verifyConverterOutput(options.outDir, sourceBytes);
}

async function ownedSlideRoot(options: {
  root: string;
  projectId: string;
  slideId: string;
}): Promise<string> {
  const editableRoot = join(options.root, "editable");
  const physical = await requireDirectory(editableRoot, "editable project path").catch((error: unknown) => {
    throw new Error("editable project path is unsafe", { cause: error });
  });
  if (physical !== join(options.root, "editable")) throw new Error("editable project path is unsafe");
  const slideRoot = join(editableRoot, options.slideId);
  let created = false;
  try {
    await mkdir(slideRoot, { mode: 0o700 });
    created = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    await requireDirectory(slideRoot, "editable slide path");
    const markerPath = join(slideRoot, ".superppt-editable-slide.json");
    if (created) {
      await writeDurableExclusive(markerPath, `${JSON.stringify(EditableSlideMarkerSchema.parse({
        markerVersion: 1,
        appId: "superppt",
        artifactKind: "editable-slide",
        projectId: options.projectId,
        slideId: options.slideId,
      }), null, 2)}\n`);
      await syncDirectory(slideRoot);
      await syncDirectory(editableRoot);
    }
    const marker = await parseJson(markerPath, MAX_JSON, "editable slide marker", (value) => EditableSlideMarkerSchema.parse(value));
    if (marker.value.projectId !== options.projectId || marker.value.slideId !== options.slideId) {
      throw new Error("editable slide marker identity mismatch");
    }
  } catch (error: unknown) {
    throw new Error("editable slide path is unsafe or unowned", { cause: error });
  }
  return slideRoot;
}

export type ProjectConversionResult = EditableConversionResult & {
  revisionId: string;
  revisionRoot: string;
  sourcePng: string;
  conversionRecord: string;
};

export async function convertProjectPage(options: {
  root: string;
  slideId: string;
  converterRoot: string;
  dependencies?: ResolvedDependencies;
  prepareExecute?: EditableInputPreparationExecutor;
  execute?: EditableConverterExecutor;
  nodeVersion?: string;
  idFactory?: () => string;
}): Promise<ProjectConversionResult> {
  const manifest = await readProject(options.root);
  const root = await validateProjectRoot(options.root);
  const slide = manifest.slides.find((candidate) => candidate.id === options.slideId);
  if (!slide) throw new Error("editable conversion slide ID is not in the current project");
  let selection: Awaited<ReturnType<typeof import("../project/promotion.js")["authenticateCurrentDeckEditSelection"]>> | null = null;
  let sourceMaster = slide.finalRender;
  if (options.dependencies) {
    const report = await preflightDependencies(options.dependencies);
    if (!report.ok) throw new Error("editable conversion dependency preflight failed");
    await assertAiImageSkillDependencyCurrent(options.dependencies.ai);
    if (await realpath(options.converterRoot) !== options.dependencies.editable.root) {
      throw new Error("editable converter root does not match the preflight-resolved dependency");
    }
    selection = await (await import("../project/promotion.js")).authenticateCurrentDeckEditSelection(root, options.slideId);
    sourceMaster = selection.sourceMaster;
  }
  if (slide.status !== "ready" || !sourceMaster) throw new Error("editable conversion requires a ready current final render");
  if (sourceMaster.revisionId !== manifest.currentRevision.id) throw new Error("editable conversion final render is stale");
  const render = await readOwnedRegularFile(root, sourceMaster.path);
  if (projectSha256(render) !== sourceMaster.sha256) throw new Error("editable conversion final render hash mismatch");
  const metadata = await sharp(render).metadata();
  if (metadata.width !== 1920 || metadata.height !== 1080) throw new Error("editable conversion requires the current 1920x1080 page render");

  const revisionId = options.idFactory?.() ?? randomUUID();
  EditableRevisionMarkerSchema.shape.revisionId.parse(revisionId);
  const slideRoot = await ownedSlideRoot({ root, projectId: manifest.projectId, slideId: slide.id });
  const revisionRoot = join(slideRoot, revisionId);
  try {
    await lstat(revisionRoot);
    throw new Error("editable revision target already exists");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pendingSource = join(slideRoot, `.source-${revisionId}.png`);
  let normalized: Buffer;
  let preparation = {
    scriptPath: "superppt://legacy/prepareConversionInput",
    scriptSha256: sha256(Buffer.from("superppt legacy prepareConversionInput")),
  };
  if (options.dependencies) {
    const scriptPath = options.dependencies.ai.scripts.prepareEditableInput;
    const scriptSha256 = options.dependencies.ai.scriptSha256.prepareEditableInput;
    await assertAiImageSkillDependencyCurrent(options.dependencies.ai);
    const executePrepare = options.prepareExecute ?? (execFileAsync as unknown as EditableInputPreparationExecutor);
    let result: Awaited<ReturnType<EditableInputPreparationExecutor>>;
    try {
      result = await executePrepare("python3", [scriptPath, join(root, ...sourceMaster.path.split("/")), pendingSource], {
        cwd: options.dependencies.ai.root,
        env: { ...process.env },
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch (error: unknown) {
      throw new Error("ai-image-to-ppt editable input preparation failed", { cause: error });
    }
    const expectedStdout = `  OK: ${pendingSource} (1280x720 PNG, editable-converter input)\n`;
    if ((result?.stdout ?? "") !== expectedStdout || (result?.stderr ?? "") !== "") {
      throw new Error("ai-image-to-ppt editable input preparation returned malformed or extra output");
    }
    normalized = await exactPng(pendingSource, 1280, 720, "prepared editable input");
    preparation = { scriptPath, scriptSha256 };
  } else {
    normalized = await sharp(render).resize(1280, 720, { fit: "cover", position: "centre" }).png().toBuffer();
    await writeDurableExclusive(pendingSource, normalized);
  }
  await syncDirectory(slideRoot);
  if (options.dependencies) {
    const report = await preflightDependencies(options.dependencies);
    if (!report.ok) throw new Error("editable conversion dependency changed after input preparation");
  }
  let converted: EditableConversionResult;
  try {
    converted = await runEditableConversion({
      converterRoot: options.converterRoot,
      sourcePng: pendingSource,
      outDir: revisionRoot,
      execute: options.execute,
      nodeVersion: options.nodeVersion,
    });
  } catch (error: unknown) {
    throw error;
  }
  try {
    const current = await readProject(root);
    const currentSlide = current.slides.find((candidate) => candidate.id === slide.id);
    if (
      current.currentRevision.id !== manifest.currentRevision.id
      || !currentSlide
      || currentSlide.status !== "ready"
      || (selection === null && (
        !currentSlide.finalRender
        || currentSlide.finalRender.path !== sourceMaster.path
        || currentSlide.finalRender.sha256 !== sourceMaster.sha256
        || currentSlide.finalRender.revisionId !== sourceMaster.revisionId
      ))
    ) throw new Error("stale identity");
    if (selection) {
      const currentSelection = await (await import("../project/promotion.js")).authenticateCurrentDeckEditSelection(root, slide.id);
      if (JSON.stringify(currentSelection) !== JSON.stringify(selection)) throw new Error("stale reviewed selection");
    }
    const currentRender = await readOwnedRegularFile(root, sourceMaster.path);
    if (projectSha256(currentRender) !== sourceMaster.sha256) throw new Error("stale bytes");
  } catch (error: unknown) {
    throw new Error("project revision or final render changed during editable conversion", { cause: error });
  }
  const sourcePng = join(revisionRoot, "source-1280x720.png");
  await writeDurableExclusive(sourcePng, normalized);
  await unlink(pendingSource);
  const version = await converterVersion(converted.converterRoot);
  const conversionRecord = join(revisionRoot, "conversion-record.json");
  await writeDurableExclusive(conversionRecord, `${JSON.stringify(ConversionRecordSchema.parse({
    conversionRecordVersion: 1,
    projectId: manifest.projectId,
    slideId: slide.id,
    revisionId,
    projectRevisionId: manifest.currentRevision.id,
    finalRender: {
      path: sourceMaster.path,
      sha256: sourceMaster.sha256,
    },
    prepareEditableInput: {
      ...preparation,
      sourceMaster,
      output1280x720: {
        path: `editable/${slide.id}/${revisionId}/source-1280x720.png`,
        sha256: projectSha256(normalized),
        revisionId: manifest.currentRevision.id,
      },
    },
    deckReviewSelection: selection ? {
      candidateId: selection.candidateId,
      reviewDescriptorSha256: selection.reviewDescriptorSha256,
      actionEvidenceSha256: selection.actionEvidenceSha256,
    } : null,
    converterVersion: version,
    artifacts: converted.artifactHashes,
  }), null, 2)}\n`);
  await writeDurableExclusive(join(revisionRoot, ".superppt-editable-revision.json"), `${JSON.stringify(EditableRevisionMarkerSchema.parse({
    markerVersion: 1,
    appId: "superppt",
    artifactKind: "editable-slide-revision",
    projectId: manifest.projectId,
    slideId: slide.id,
    revisionId,
    revisionKind: "conversion",
  }), null, 2)}\n`);
  await syncDirectory(revisionRoot);
  await syncDirectory(slideRoot);
  return {
    ...converted,
    revisionId,
    revisionRoot,
    sourcePng,
    conversionRecord,
  };
}
