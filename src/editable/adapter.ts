import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import sharp from "sharp";

import { preflightDependencies } from "../dependencies/preflight.js";
import type { ResolvedDependencies } from "../dependencies/schemas.js";
import { assertAiImageSkillDependencyCurrent } from "../generation/authorization.js";
import { withGenerationLease } from "../generation/lease.js";
import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { validateProjectRoot } from "../project/paths.js";
import { readOwnedRegularFile, readRegularFileNoFollow } from "../project/safe-file.js";
import { assertProjectMutationNotFrozen, readProject, sha256 as projectSha256 } from "../project/store.js";
import { scanOoxmlRanges, type OoxmlElementRange } from "../deck-revisions/ooxml.js";
import {
  AuthenticatedEditableConversionSchema,
  ConversionRecordSchema,
  ConverterOwnershipMarkerSchema,
  EditableConversionStagingMarkerSchema,
  EditableManifestSchema,
  EditableManifestV2Schema,
  EditableProjectPathSchema,
  EditableRevisionMarkerSchema,
  EditableSlideMarkerSchema,
  RunLedgerV2Schema,
  type EditableManifest,
  type EditableManifestV2,
  type AuthenticatedEditableConversion,
  type RunLedgerV2,
} from "./schemas.js";

const execFileAsync = promisify(execFile);
const OUTPUT_MARKER = ".image-to-editable-pptx-output.json";
const MAX_JSON = 16 * 1024 * 1024;
const MAX_ASSET = 64 * 1024 * 1024;
const MAX_OUTPUT = 512 * 1024 * 1024;
const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DOCUMENT_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const IMAGE_RELATIONSHIP = `${DOCUMENT_RELATIONSHIPS}/image`;
const LAYOUT_RELATIONSHIP = `${DOCUMENT_RELATIONSHIPS}/slideLayout`;
export const CONVERTER_OUTPUT_DIRECTORY = "converter-output";

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
  donorPptx: string;
  assets: Record<string, string>;
  outputs: Record<string, string>;
};

export type EditableConversionResult = {
  converterRoot: string;
  outputRoot: string;
  manifestPath: string;
  cleanBackground: string;
  donorPptx: string;
  ledgerPath: string;
  manifest: EditableManifest;
  officialManifest: EditableManifestV2;
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
  return Boolean(match && match[1] === "0" && match[2] === "2");
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
  ) throw new Error("converter package is not a compatible image-to-editable-pptx 0.2.x package");
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

async function exactOwnedPreparedPng(revisionRoot: string, path: string): Promise<Buffer> {
  const expected = join(revisionRoot, "source-1280x720.png");
  if (resolve(path) !== resolve(expected)) throw new Error("prepared editable input path is outside its owned revision");
  if (await realpath(revisionRoot) !== resolve(revisionRoot)) throw new Error("prepared editable input revision path is unsafe");
  const before = await lstat(path).catch((error: unknown) => {
    throw new Error("prepared editable input must be a regular non-symlink file", { cause: error });
  });
  if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error("prepared editable input must be a regular non-symlink file");
  }
  const bytes = await exactPng(path, 1280, 720, "prepared editable input");
  const after = await lstat(path);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || !after.isFile()
    || after.isSymbolicLink()
    || await realpath(path) !== resolve(path)
  ) throw new Error("prepared editable input changed identity while validating");
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

function xmlAttribute(element: OoxmlElementRange, namespaceUri: string, localName: string): string | null {
  const matches = element.attributes.filter((attribute) =>
    attribute.namespaceUri === namespaceUri && attribute.localName === localName);
  if (matches.length > 1) throw new Error(`duplicate OOXML ${localName} attribute`);
  return matches[0]?.value ?? null;
}

function relationshipTarget(slidePart: string, target: string): string {
  if (!target || target.includes("\\") || target.split("/").some((part) => part === ".")) {
    throw new Error("donor relationship target is unsafe");
  }
  const resolved = target.startsWith("/")
    ? target.slice(1)
    : posix.normalize(posix.join(posix.dirname(slidePart), target));
  if (!/^ppt\/media\/[A-Za-z0-9._-]+\.png$/.test(resolved) || resolved.includes("../")) {
    throw new Error("donor image relationship target is unsafe or not PNG");
  }
  return resolved;
}

export type OfficialEditableDonorInspection = {
  zip: JSZip;
  slidePart: string;
  slideXml: string;
  relationshipsPart: string;
  relationshipsXml: string;
  objectNames: string[];
  imageRelationships: Array<{ id: string; targetPart: string }>;
};

export async function inspectOfficialEditableDonor(
  bytes: Buffer,
  manifest: EditableManifestV2,
): Promise<OfficialEditableDonorInspection> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error: unknown) {
    throw new Error("official editable donor PPTX is invalid", { cause: error });
  }
  const names = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
  const forbidden = names.find((name) =>
    /(?:vbaProject|\/embeddings\/|\/activeX\/|\/charts\/|\/diagrams\/)/i.test(name)
    || (/^ppt\/media\//.test(name) && !/\.png$/i.test(name)));
  if (forbidden) throw new Error(`official editable donor contains unsupported active content: ${forbidden}`);
  for (const required of ["ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"]) {
    if (!zip.file(required)) throw new Error(`official editable donor is missing ${required}`);
  }
  const slideParts = names.filter((name) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name));
  if (slideParts.length !== 1) throw new Error("official editable donor must contain exactly one slide");
  const presentationXml = await zip.file("ppt/presentation.xml")!.async("string");
  const presentationElements = scanOoxmlRanges(presentationXml).elements;
  const slideIds = presentationElements.filter((element) =>
    element.namespaceUri === PRESENTATION && element.localName === "sldId");
  if (slideIds.length !== 1) throw new Error("official editable donor must contain exactly one slide");
  const slideSize = presentationElements.filter((element) =>
    element.namespaceUri === PRESENTATION && element.localName === "sldSz");
  if (slideSize.length !== 1) throw new Error("official editable donor page size is missing or ambiguous");
  const width = Number(xmlAttribute(slideSize[0]!, "", "cx"));
  const height = Number(xmlAttribute(slideSize[0]!, "", "cy"));
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * 9 !== height * 16) {
    throw new Error("official editable donor page size must be 16:9");
  }
  const presentationRels = scanOoxmlRanges(await zip.file("ppt/_rels/presentation.xml.rels")!.async("string")).elements
    .filter((element) => element.namespaceUri === PACKAGE_RELATIONSHIPS && element.localName === "Relationship");
  const slideRelationshipId = xmlAttribute(slideIds[0]!, DOCUMENT_RELATIONSHIPS, "id");
  const slideRelationship = presentationRels.find((element) => xmlAttribute(element, "", "Id") === slideRelationshipId);
  const slideTarget = slideRelationship && xmlAttribute(slideRelationship, "", "Target");
  if (!slideTarget || xmlAttribute(slideRelationship!, "", "TargetMode") === "External") {
    throw new Error("official editable donor slide relationship is invalid");
  }
  const slidePart = posix.normalize(posix.join("ppt", slideTarget));
  if (slidePart !== slideParts[0] || !/^ppt\/slides\/slide[0-9]+\.xml$/.test(slidePart)) {
    throw new Error("official editable donor slide relationship is ambiguous");
  }
  const slideXml = await zip.file(slidePart)!.async("string");
  const slideElements = scanOoxmlRanges(slideXml).elements;
  const shapeTrees = slideElements.filter((element) =>
    element.namespaceUri === PRESENTATION && element.localName === "spTree");
  if (shapeTrees.length !== 1) throw new Error("official editable donor must contain exactly one shape tree");
  const objectNames = slideElements
    .filter((element) => element.namespaceUri === PRESENTATION && element.localName === "cNvPr")
    .map((element) => xmlAttribute(element, "", "name"))
    .filter((name): name is string => Boolean(name));
  if (new Set(objectNames).size !== objectNames.length) throw new Error("official editable donor has duplicate object names");
  const expectedNames = ["asset-background", ...manifest.elements.map((element) => {
    if (element.kind === "text") return `text-${element.id}`;
    if (element.kind === "shape") return `shape-${element.id}-${element.label}`;
    return `asset-${element.id}`;
  })];
  for (const name of expectedNames) {
    if (objectNames.filter((candidate) => candidate === name).length !== 1) {
      throw new Error(`official editable donor object name does not match manifest: ${name}`);
    }
  }
  const links = shapeTrees.flatMap((shapeTree) => slideElements.filter((element) =>
    element.start >= shapeTree.start && element.end <= shapeTree.end)
    .flatMap((element) => element.attributes.filter((attribute) =>
      attribute.namespaceUri === DOCUMENT_RELATIONSHIPS && attribute.localName === "link")));
  if (links.length > 0) throw new Error("official editable donor shape tree contains r:link");
  const embeds = new Set(shapeTrees.flatMap((shapeTree) => slideElements.filter((element) =>
    element.start >= shapeTree.start && element.end <= shapeTree.end)
    .flatMap((element) => element.attributes.filter((attribute) =>
      attribute.namespaceUri === DOCUMENT_RELATIONSHIPS && attribute.localName === "embed")
      .map((attribute) => attribute.value))));
  const relationshipsPart = `ppt/slides/_rels/${posix.basename(slidePart)}.rels`;
  const relationshipsFile = zip.file(relationshipsPart);
  if (!relationshipsFile) throw new Error("official editable donor slide relationships are missing");
  const relationshipsXml = await relationshipsFile.async("string");
  const relationshipElements = scanOoxmlRanges(relationshipsXml).elements.filter((element) =>
    element.namespaceUri === PACKAGE_RELATIONSHIPS && element.localName === "Relationship");
  const ids = new Set<string>();
  const imageRelationships: OfficialEditableDonorInspection["imageRelationships"] = [];
  for (const relationship of relationshipElements) {
    const id = xmlAttribute(relationship, "", "Id");
    const type = xmlAttribute(relationship, "", "Type");
    const target = xmlAttribute(relationship, "", "Target");
    if (!id || !type || !target || ids.has(id)) throw new Error("official editable donor relationship is incomplete or duplicate");
    ids.add(id);
    if (xmlAttribute(relationship, "", "TargetMode") === "External") throw new Error("official editable donor contains an external relationship");
    if (type !== IMAGE_RELATIONSHIP && type !== LAYOUT_RELATIONSHIP) {
      throw new Error(`official editable donor contains an unsupported relationship: ${type}`);
    }
    if (embeds.has(id)) {
      if (type !== IMAGE_RELATIONSHIP) throw new Error("official editable donor shape-tree relationship must be an image");
      const targetPart = relationshipTarget(slidePart, target);
      if (!zip.file(targetPart)) throw new Error("official editable donor image relationship target is missing");
      imageRelationships.push({ id, targetPart });
    }
  }
  if (imageRelationships.length !== embeds.size || imageRelationships.length === 0) {
    throw new Error("official editable donor image relationship binding is incomplete");
  }
  return { zip, slidePart, slideXml, relationshipsPart, relationshipsXml, objectNames: expectedNames, imageRelationships };
}

function validateDecisionBinding(manifest: EditableManifestV2, ledger: RunLedgerV2): void {
  const decisionElements = manifest.elements.filter((element) => element.kind !== "shape");
  const accepted = ledger.decisions.filter((decision) => decision.decision === "accepted");
  if (accepted.length !== decisionElements.length) {
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
  for (const element of decisionElements) {
    const decision = byElement.get(element.id);
    if (!decision || decision.output.state !== "editable_layer" || !sameBox(decision.bbox, element.bbox)) {
      throw new Error(`converter ledger decision does not authenticate manifest element: ${element.id}`);
    }
    if (element.kind === "text") {
      if (decision.kind !== "text" || decision.extraction !== "none" || decision.output.assetPath !== undefined) {
        throw new Error(`converter ledger decision does not authenticate text element: ${element.id}`);
      }
    } else if (
      !["icon", "foreground-object", "text-backing", "compound-group"].includes(decision.kind)
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

async function verifyConverterOutput(
  outDir: string,
  sourceBytes: Buffer,
  converterVersionValue: string,
): Promise<Omit<EditableConversionResult, "converterRoot">> {
  AuthenticatedEditableConversionSchema.shape.converterVersion.parse(converterVersionValue);
  const canonicalOutput = await requireDirectory(outDir, "converter output");
  const canonicalParent = await realpath(dirname(resolve(outDir)));
  if (canonicalOutput !== join(canonicalParent, basename(resolve(outDir)))) {
    throw new Error("converter output path contains an unsafe symlink");
  }
  await parseJson(join(outDir, OUTPUT_MARKER), MAX_JSON, "converter ownership marker", (value) => ConverterOwnershipMarkerSchema.parse(value));
  const manifestPath = join(outDir, "manifest.json");
  const parsedManifest = await parseJson(manifestPath, MAX_JSON, "converter manifest", (value) => EditableManifestV2Schema.parse(value));
  const ledgerPath = join(outDir, "run-ledger.json");
  const parsedLedger = await parseJson(ledgerPath, MAX_JSON, "converter run ledger", (value) => RunLedgerV2Schema.parse(value));
  const { value: officialManifest, bytes: manifestBytes } = parsedManifest;
  const { value: ledger, bytes: ledgerBytes } = parsedLedger;
  validateDecisionBinding(officialManifest, ledger);
  if (ledger.hashes.sourceImage !== sha256(sourceBytes)) throw new Error("source image hash mismatch");
  if (ledger.hashes.manifest !== sha256(manifestBytes)) throw new Error("converter manifest hash mismatch");

  const visionName = basename(ledger.outputs.vision);
  if (visionName !== "vision.json" && visionName !== "scene-graph.json") {
    throw new Error("converter ledger vision output path is invalid");
  }
  const outputNames = {
    ocr: "ocr.json",
    vision: visionName,
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
  if (pptxRelative !== "slide-editable.pptx") throw new Error("converter ledger must publish the official slide-editable.pptx donor");
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

  const referencedAssets = officialManifest.elements.flatMap((element) => element.kind === "asset" ? [element.assetPath] : []);
  if (new Set(referencedAssets).size !== referencedAssets.length) throw new Error("converter manifest asset paths must be unique");
  const ledgerAssetKeys = Object.keys(ledger.hashes.assets).sort();
  if (JSON.stringify([...referencedAssets].sort()) !== JSON.stringify(ledgerAssetKeys)) {
    throw new Error("converter asset hashes must exactly authenticate referenced assets");
  }
  const assetHashes: Record<string, string> = {};
  for (const assetPath of referencedAssets) {
    const checked = await verifyOutputHash(outDir, assetPath, ledger.hashes.assets[assetPath]!, `converter asset ${assetPath}`, MAX_ASSET);
    if (!await transparentPng(checked.bytes)) throw new Error(`converter asset ${assetPath} must be a transparent PNG`);
    const element = officialManifest.elements.find((candidate) => candidate.kind === "asset" && candidate.assetPath === assetPath);
    if (!element || element.kind !== "asset" || element.provenance.assetSha256 !== checked.hash) {
      throw new Error(`converter asset provenance hash mismatch: ${assetPath}`);
    }
    assetHashes[assetPath] = checked.hash;
  }
  await inspectOfficialEditableDonor(pptx.bytes, officialManifest);
  const legacyElements: EditableManifest["elements"] = [];
  for (const element of officialManifest.elements) {
    if (element.kind === "shape") continue;
    if (element.kind === "text") {
      legacyElements.push(element);
      continue;
    }
    const { role: _role, groupId: _groupId, provenance: _provenance, relations: _relations, reviewRequired: _reviewRequired, ...legacy } = element;
    legacyElements.push(legacy);
  }
  const manifest = EditableManifestSchema.parse({
    manifestVersion: 1,
    canvas: officialManifest.canvas,
    elements: legacyElements,
    warnings: officialManifest.warnings,
  });
  return {
    outputRoot: canonicalOutput,
    manifestPath,
    cleanBackground: join(outDir, "clean-background.png"),
    donorPptx: join(outDir, "slide-editable.pptx"),
    ledgerPath,
    manifest,
    officialManifest,
    ledger,
    artifactHashes: {
      sourceImage: sha256(sourceBytes),
      manifest: sha256(manifestBytes),
      runLedger: sha256(ledgerBytes),
      cleanBackground: ledger.hashes.cleanBackground,
      donorPptx: ledger.hashes.pptx,
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
  const version = await converterVersion(converterRoot);
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
    ...await verifyConverterOutput(options.outDir, sourceBytes, version),
  };
}

export async function validateEditableConversionOutput(options: {
  sourcePng: string;
  outDir: string;
  converterVersion?: string;
}): Promise<Omit<EditableConversionResult, "converterRoot">> {
  const sourceBytes = await exactPng(options.sourcePng, 1280, 720, "converter source");
  let version = options.converterVersion;
  if (!version) {
    try {
      const record = await parseJson(
        join(dirname(options.outDir), "conversion-record.json"),
        MAX_JSON,
        "conversion record",
        (value) => ConversionRecordSchema.parse(value),
      );
      version = record.value.converterVersion;
    } catch (error: unknown) {
      throw new Error("converter version evidence is missing or invalid", { cause: error });
    }
  }
  return verifyConverterOutput(options.outDir, sourceBytes, version);
}

export type AuthenticatedEditableConversionResult = AuthenticatedEditableConversion & {
  manifest: EditableManifestV2;
  ledger: RunLedgerV2;
};

export async function authenticateProjectEditableConversion(options: {
  projectRoot: string;
  conversionRoot: string;
  slideId: string;
}): Promise<AuthenticatedEditableConversionResult> {
  const projectRoot = await validateProjectRoot(options.projectRoot);
  const project = await readProject(projectRoot);
  const conversionRoot = resolve(options.conversionRoot);
  const expectedPrefix = join(projectRoot, "editable", options.slideId);
  if (!inside(expectedPrefix, conversionRoot) || dirname(conversionRoot) !== expectedPrefix) {
    throw new Error("editable conversion root is outside its owned slide path");
  }
  if (await realpath(conversionRoot) !== conversionRoot) throw new Error("editable conversion root is not canonical");
  const recordResult = await parseJson(
    join(conversionRoot, "conversion-record.json"),
    MAX_JSON,
    "conversion record",
    (value) => ConversionRecordSchema.parse(value),
  );
  const record = recordResult.value;
  if (
    record.projectId !== project.projectId
    || record.slideId !== options.slideId
    || record.revisionId !== basename(conversionRoot)
  ) throw new Error("conversion record does not bind the owned project slide revision");
  const sourcePng = join(conversionRoot, "source-1280x720.png");
  const outputRoot = join(conversionRoot, CONVERTER_OUTPUT_DIRECTORY);
  const converted = await validateEditableConversionOutput({
    sourcePng,
    outDir: outputRoot,
    converterVersion: record.converterVersion,
  });
  if (JSON.stringify(converted.artifactHashes) !== JSON.stringify(record.artifacts)) {
    throw new Error("conversion record artifact hashes do not match official converter output");
  }
  const ownedPath = (path: string): string => {
    const value = relative(projectRoot, path).split("\\").join("/");
    return EditableProjectPathSchema.parse(value);
  };
  const authenticated = AuthenticatedEditableConversionSchema.parse({
    converterVersion: record.converterVersion,
    manifestVersion: converted.officialManifest.manifestVersion,
    sourceImagePath: ownedPath(sourcePng),
    sourceImageSha256: converted.artifactHashes.sourceImage,
    manifestPath: ownedPath(converted.manifestPath),
    manifestSha256: converted.artifactHashes.manifest,
    ledgerPath: ownedPath(converted.ledgerPath),
    ledgerSha256: converted.artifactHashes.runLedger,
    cleanBackgroundPath: ownedPath(converted.cleanBackground),
    cleanBackgroundSha256: converted.artifactHashes.cleanBackground,
    donorPptxPath: ownedPath(converted.donorPptx),
    donorPptxSha256: converted.artifactHashes.donorPptx,
    assets: Object.fromEntries(Object.entries(converted.artifactHashes.assets).map(([path, hash]) => [
      ownedPath(join(outputRoot, ...path.split("/"))),
      hash,
    ])),
    reviewRequiredObjects: converted.officialManifest.elements.flatMap((element) =>
      element.kind === "asset" && element.reviewRequired
        ? [{ elementId: element.id, label: element.label, role: element.role }]
        : []),
  });
  return { ...authenticated, manifest: converted.officialManifest, ledger: converted.ledger };
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
  dependencies: ResolvedDependencies;
  prepareExecute?: EditableInputPreparationExecutor;
  execute?: EditableConverterExecutor;
  nodeVersion?: string;
  idFactory?: () => string;
}): Promise<ProjectConversionResult> {
  return withGenerationLease(options.root, async (generationRoot) => {
  await assertProjectMutationNotFrozen(generationRoot);
  const manifest = await readProject(generationRoot);
  const root = await validateProjectRoot(generationRoot);
  const slide = manifest.slides.find((candidate) => candidate.id === options.slideId);
  if (!slide) throw new Error("editable conversion slide ID is not in the current project");
  if (!options.dependencies) throw new Error("editable conversion requires preflight-resolved dependencies");
  const report = await preflightDependencies(options.dependencies);
  if (!report.ok) throw new Error("editable conversion dependency preflight failed");
  await assertAiImageSkillDependencyCurrent(options.dependencies.ai);
  if (await realpath(options.converterRoot) !== options.dependencies.editable.root) {
    throw new Error("editable converter root does not match the preflight-resolved dependency");
  }
  const selection = await (await import("../project/promotion.js")).authenticateCurrentDeckEditSelection(root, options.slideId);
  const sourceMaster = selection.sourceMaster;
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
  const stagingMarker = EditableConversionStagingMarkerSchema.parse({
    stagingMarkerVersion: 1,
    appId: "superppt",
    artifactKind: "editable-conversion-staging",
    projectId: manifest.projectId,
    slideId: slide.id,
    revisionId,
  });
  await mkdir(revisionRoot, { mode: 0o700 });
  const stagingMarkerPath = join(revisionRoot, ".superppt-editable-conversion-staging.json");
  await writeDurableExclusive(stagingMarkerPath, `${JSON.stringify(stagingMarker, null, 2)}\n`);
  const sourcePng = join(revisionRoot, "source-1280x720.png");
  const converterOutputRoot = join(revisionRoot, CONVERTER_OUTPUT_DIRECTORY);
  try {
    const scriptPath = options.dependencies.ai.scripts.prepareEditableInput;
    const scriptSha256 = options.dependencies.ai.scriptSha256.prepareEditableInput;
    await assertAiImageSkillDependencyCurrent(options.dependencies.ai);
    const executePrepare = options.prepareExecute ?? (execFileAsync as unknown as EditableInputPreparationExecutor);
    let prepared: Awaited<ReturnType<EditableInputPreparationExecutor>>;
    try {
      prepared = await executePrepare("python3", [scriptPath, join(root, ...sourceMaster.path.split("/")), sourcePng], {
        cwd: options.dependencies.ai.root,
        env: { ...process.env },
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch (error: unknown) {
      throw new Error("ai-image-to-ppt editable input preparation failed", { cause: error });
    }
    const expectedStdout = `  OK: ${sourcePng} (1280x720 PNG, editable-converter input)\n`;
    if ((prepared?.stdout ?? "") !== expectedStdout || (prepared?.stderr ?? "") !== "") {
      throw new Error("ai-image-to-ppt editable input preparation returned malformed or extra output");
    }
    const normalized = await exactOwnedPreparedPng(revisionRoot, sourcePng);
    const preparedIdentity = await lstat(sourcePng);
    await syncDirectory(revisionRoot);
    const currentDependencies = await preflightDependencies(options.dependencies);
    if (!currentDependencies.ok) throw new Error("editable conversion dependency changed after input preparation");
    const converted = await runEditableConversion({
      converterRoot: options.converterRoot,
      sourcePng,
      outDir: converterOutputRoot,
      execute: options.execute,
      nodeVersion: options.nodeVersion,
    });
    const preparedAfterConversion = await lstat(sourcePng);
    if (
      preparedAfterConversion.dev !== preparedIdentity.dev
      || preparedAfterConversion.ino !== preparedIdentity.ino
      || preparedAfterConversion.size !== preparedIdentity.size
      || preparedAfterConversion.isSymbolicLink()
      || !preparedAfterConversion.isFile()
      || await realpath(sourcePng) !== resolve(sourcePng)
      || projectSha256(await readRegularFileNoFollow(sourcePng)) !== projectSha256(normalized)
    ) throw new Error("prepared editable input changed identity during conversion");
    try {
      const current = await readProject(root);
      const currentSlide = current.slides.find((candidate) => candidate.id === slide.id);
      if (
        current.currentRevision.id !== manifest.currentRevision.id
        || !currentSlide
        || currentSlide.status !== "ready"
      ) throw new Error("stale identity");
      const currentSelection = await (await import("../project/promotion.js")).authenticateCurrentDeckEditSelection(root, slide.id);
      if (JSON.stringify(currentSelection) !== JSON.stringify(selection)) throw new Error("stale reviewed selection");
      const currentRender = await readOwnedRegularFile(root, sourceMaster.path);
      if (projectSha256(currentRender) !== sourceMaster.sha256) throw new Error("stale bytes");
    } catch (error: unknown) {
      throw new Error("project revision or final render changed during editable conversion", { cause: error });
    }
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
        scriptPath,
        scriptSha256,
        sourceMaster,
        output1280x720: {
          path: `editable/${slide.id}/${revisionId}/source-1280x720.png`,
          sha256: projectSha256(normalized),
          revisionId: manifest.currentRevision.id,
        },
      },
      deckReviewSelection: {
        candidateId: selection.candidateId,
        reviewDescriptorSha256: selection.reviewDescriptorSha256,
        actionEvidenceSha256: selection.actionEvidenceSha256,
      },
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
    await syncDirectory(converterOutputRoot);
    await syncDirectory(revisionRoot);
    await unlink(stagingMarkerPath);
    await syncDirectory(revisionRoot);
    await syncDirectory(slideRoot);
    return { ...converted, revisionId, revisionRoot, sourcePng, conversionRecord };
  } catch (error: unknown) {
    try {
      const marker = EditableConversionStagingMarkerSchema.parse(JSON.parse(await readFile(stagingMarkerPath, "utf8")));
      const info = await lstat(revisionRoot);
      if (
        JSON.stringify(marker) !== JSON.stringify(stagingMarker)
        || info.isSymbolicLink()
        || !info.isDirectory()
        || await realpath(revisionRoot) !== resolve(revisionRoot)
        || dirname(revisionRoot) !== slideRoot
        || basename(revisionRoot) !== revisionId
      ) throw new Error("conversion staging ownership changed");
      await rm(revisionRoot, { recursive: true, force: false });
      await syncDirectory(slideRoot);
    } catch (cleanupError: unknown) {
      throw new Error("editable conversion failed and owned staging cleanup could not be proven", { cause: cleanupError });
    }
    throw error;
  }
  });
}
