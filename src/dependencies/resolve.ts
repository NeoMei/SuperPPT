import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readAnchoredRegularFile } from "../project/safe-file.js";
import { isolatedChildEnvironment } from "../process/environment.js";

import {
  AiImageCapabilityManifestSchema,
  AiImageSkillDependencySchema,
  DependencyContractSchema,
  EditableSourceTreeIdentitySchema,
  ImageToEditablePptxSkillDependencySchema,
  type AiImageSkillDependency,
  type ImageToEditablePptxSkillDependency,
  type ResolvedDependencies,
} from "./schemas.js";

const execFileAsync = promisify(execFile);
const MODULE_FILE = fileURLToPath(import.meta.url);
const SOURCE_TREE_ROOT = dirname(dirname(MODULE_FILE));
const BUILD_OR_PACKAGE_ROOT = dirname(SOURCE_TREE_ROOT);
const PACKAGE_ROOT = basename(BUILD_OR_PACKAGE_ROOT) === "dist" && extname(MODULE_FILE) === ".js"
  ? dirname(BUILD_OR_PACKAGE_ROOT)
  : BUILD_OR_PACKAGE_ROOT;
const DEFAULT_CONTRACT_FILE = join(PACKAGE_ROOT, "references", "dependencies.json");
const MAX_EDITABLE_SOURCE_FILES = 2048;
const MAX_EDITABLE_SOURCE_ENTRIES = 4096;
const MAX_EDITABLE_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EDITABLE_SOURCE_TREE_BYTES = 128 * 1024 * 1024;
const MAX_EDITABLE_SOURCE_DEPTH = 64;

export type ResolveDependencyRequest = {
  aiSkillRoot: string;
  editableSkillRoot: string;
  contractFile?: string;
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function staysInside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`);
}

async function canonicalSkillRoot(path: string, dependency: string): Promise<string> {
  const requested = resolve(path);
  let info;
  try {
    info = await lstat(requested);
  } catch (error) {
    throw new Error(`${dependency} Skill root is unavailable`, { cause: error });
  }
  if (info.isSymbolicLink()) throw new Error(`${dependency} Skill root must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${dependency} Skill root must be a directory`);
  return realpath(requested);
}

async function requiredRegularFile(root: string, path: string, missingMessage: string, unsafeMessage: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error(missingMessage);
    throw new Error(unsafeMessage, { cause: error });
  }
  if (
    info.isSymbolicLink()
    || !info.isFile()
    || info.size === 0
    || info.size > MAX_EDITABLE_SOURCE_FILE_BYTES
  ) throw new Error(unsafeMessage);
  const physicalPath = await realpath(path);
  if (physicalPath !== path || !staysInside(root, physicalPath)) throw new Error(unsafeMessage);
  return path;
}

async function requiredDirectory(root: string, path: string, missingMessage: string, unsafeMessage: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error(missingMessage);
    throw new Error(unsafeMessage, { cause: error });
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(unsafeMessage);
  const physicalPath = await realpath(path);
  if (physicalPath !== path || !staysInside(root, physicalPath)) throw new Error(unsafeMessage);
  return path;
}

async function canonicalContractFile(path: string): Promise<string> {
  const lexical = resolve(path);
  let info;
  try {
    info = await lstat(lexical);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error("dependency contract is missing");
    throw new Error("dependency contract path is unsafe", { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("dependency contract path is unsafe");
  return realpath(lexical);
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readIdentityFile(path: string, label: string): Promise<Buffer> {
  return readAnchoredRegularFile(path, { label, maxBytes: MAX_EDITABLE_SOURCE_FILE_BYTES });
}

async function sha256(path: string): Promise<string> {
  return sha256Bytes(await readIdentityFile(path, "dependency identity"));
}

async function gitRevision(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
      env: isolatedChildEnvironment(),
    });
    const revision = stdout.trim();
    return revision === "" ? null : revision;
  } catch {
    return null;
  }
}

async function loadDependencyContract(path = DEFAULT_CONTRACT_FILE) {
  const contractFile = await canonicalContractFile(path);
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = await readIdentityFile(contractFile, "dependency contract");
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("dependency contract is invalid JSON", { cause: error });
  }
  try {
    return { contractFile, contract: DependencyContractSchema.parse(value), contractSha256: sha256Bytes(bytes) };
  } catch (error) {
    throw new Error("dependency contract is invalid: contract v3 with exact AI and editable consumer profiles is required", { cause: error });
  }
}

function compatibleStableVersion(version: string, range: string): boolean {
  if (range !== ">=0.2.0 <0.3.0") throw new Error("unsupported image-to-editable-pptx version requirement");
  return /^0\.2\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version);
}

type LoadedContract = Awaited<ReturnType<typeof loadDependencyContract>>["contract"];

type EditableSourceEntryKind = "directory" | "file";

type EditableSourceEntrySnapshot = {
  absolutePath: string;
  relativePath: string;
  kind: EditableSourceEntryKind;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type EditableSourceTopologySnapshot = {
  root: EditableSourceEntrySnapshot;
  entries: EditableSourceEntrySnapshot[];
  fileCount: number;
  totalBytes: number;
};

function sourceTreeChanged(cause?: unknown): Error {
  return new Error(
    "image-to-editable-pptx source tree changed during identity snapshot",
    cause === undefined ? undefined : { cause },
  );
}

function sourceEntrySnapshot(
  absolutePath: string,
  relativePath: string,
  kind: EditableSourceEntryKind,
  info: BigIntStats,
): EditableSourceEntrySnapshot {
  return {
    absolutePath,
    relativePath,
    kind,
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

async function inspectEditableSourceEntry(
  sourceRoot: string,
  path: string,
  relativePath: string,
): Promise<EditableSourceEntrySnapshot> {
  let beginInfo: BigIntStats;
  try {
    beginInfo = await lstat(path, { bigint: true });
  } catch (error) {
    throw new Error("image-to-editable-pptx source tree is unsafe", { cause: error });
  }
  if (beginInfo.isSymbolicLink()) throw new Error("image-to-editable-pptx source tree must not contain symbolic links");
  const beginKind = beginInfo.isDirectory() ? "directory" : beginInfo.isFile() ? "file" : null;
  if (beginKind === null) throw new Error("image-to-editable-pptx source tree contains an unsupported entry");
  let physicalPath: string;
  try {
    physicalPath = await realpath(path);
  } catch (error) {
    throw new Error("image-to-editable-pptx source tree path is unsafe", { cause: error });
  }
  if (
    physicalPath !== path
    || (path === sourceRoot ? physicalPath !== sourceRoot : !staysInside(sourceRoot, physicalPath))
  ) throw new Error("image-to-editable-pptx source tree path is unsafe");
  let endInfo: BigIntStats;
  try {
    endInfo = await lstat(path, { bigint: true });
  } catch (error) {
    throw sourceTreeChanged(error);
  }
  const endKind = endInfo.isDirectory() ? "directory" : endInfo.isFile() ? "file" : null;
  if (endInfo.isSymbolicLink() || endKind === null) throw sourceTreeChanged();
  const begin = sourceEntrySnapshot(path, relativePath, beginKind, beginInfo);
  const end = sourceEntrySnapshot(path, relativePath, endKind, endInfo);
  if (!sameEditableSourceEntry(begin, end)) throw sourceTreeChanged();
  return end;
}

async function enumerateEditableSourceTopology(sourceRoot: string): Promise<EditableSourceTopologySnapshot> {
  const root = await inspectEditableSourceEntry(sourceRoot, sourceRoot, ".");
  if (root.kind !== "directory") throw new Error("image-to-editable-pptx source tree is unsafe");
  const entries: EditableSourceEntrySnapshot[] = [];
  let visitedEntries = 0;
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_EDITABLE_SOURCE_DEPTH) throw new Error("image-to-editable-pptx source tree exceeds the depth identity budget");
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error("image-to-editable-pptx source tree is unsafe", { cause: error });
    }
    for (const child of children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      visitedEntries += 1;
      if (visitedEntries > MAX_EDITABLE_SOURCE_ENTRIES) throw new Error("image-to-editable-pptx source tree exceeds the entry-count identity budget");
      const path = join(directory, child.name);
      const local = relative(sourceRoot, path).split(sep).join("/");
      const entry = await inspectEditableSourceEntry(sourceRoot, path, local);
      entries.push(entry);
      if (entry.kind === "directory") {
        await walk(path, depth + 1);
        continue;
      }
      if (entry.size > BigInt(MAX_EDITABLE_SOURCE_FILE_BYTES)) {
        throw new Error("image-to-editable-pptx source file exceeds the identity budget");
      }
      fileCount += 1;
      if (fileCount > MAX_EDITABLE_SOURCE_FILES) throw new Error("image-to-editable-pptx source tree exceeds the file-count identity budget");
      totalBytes += Number(entry.size);
      if (totalBytes > MAX_EDITABLE_SOURCE_TREE_BYTES) throw new Error("image-to-editable-pptx source tree exceeds the identity budget");
    }
  };
  await walk(sourceRoot, 0);
  if (fileCount === 0) throw new Error("image-to-editable-pptx source tree is empty");
  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  return { root, entries, fileCount, totalBytes };
}

function sameEditableSourceEntry(left: EditableSourceEntrySnapshot, right: EditableSourceEntrySnapshot): boolean {
  return left.absolutePath === right.absolutePath
    && left.relativePath === right.relativePath
    && left.kind === right.kind
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameEditableSourceTopology(
  left: EditableSourceTopologySnapshot,
  right: EditableSourceTopologySnapshot,
): boolean {
  return sameEditableSourceEntry(left.root, right.root)
    && left.fileCount === right.fileCount
    && left.totalBytes === right.totalBytes
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => sameEditableSourceEntry(entry, right.entries[index]!));
}

async function assertEditableSourceTopologyCurrent(
  sourceRoot: string,
  expected: EditableSourceTopologySnapshot,
): Promise<void> {
  let current: EditableSourceTopologySnapshot;
  try {
    current = await enumerateEditableSourceTopology(sourceRoot);
  } catch (error) {
    throw sourceTreeChanged(error);
  }
  if (!sameEditableSourceTopology(expected, current)) throw sourceTreeChanged();
}

export async function computeEditableSourceTreeIdentity(root: string) {
  const sourceRoot = await requiredDirectory(
    root,
    join(root, "src"),
    "image-to-editable-pptx source tree is missing",
    "image-to-editable-pptx source tree is unsafe",
  );
  // This closes the bounded scan-window race; it is not an OS-level atomic
  // snapshot with a later spawn, so callers still re-run it at each last boundary.
  const initial = await enumerateEditableSourceTopology(sourceRoot);
  const contents = new Map<string, { bytes: number; sha256: string }>();
  for (const entry of initial.entries) {
    if (entry.kind !== "file") continue;
    const bytes = await readIdentityFile(entry.absolutePath, "image-to-editable-pptx source identity");
    if (BigInt(bytes.length) !== entry.size) throw sourceTreeChanged();
    contents.set(entry.relativePath, { bytes: bytes.length, sha256: sha256Bytes(bytes) });
  }
  await assertEditableSourceTopologyCurrent(sourceRoot, initial);
  for (const entry of [...initial.entries].reverse()) {
    if (entry.kind !== "file") continue;
    let bytes: Buffer;
    try {
      bytes = await readIdentityFile(entry.absolutePath, "image-to-editable-pptx source identity");
    } catch (error) {
      throw sourceTreeChanged(error);
    }
    const expected = contents.get(entry.relativePath)!;
    if (bytes.length !== expected.bytes || sha256Bytes(bytes) !== expected.sha256) throw sourceTreeChanged();
  }
  await assertEditableSourceTopologyCurrent(sourceRoot, initial);
  const digestEntries = initial.entries.map((entry) => entry.kind === "directory"
    ? ["directory", entry.relativePath] as const
    : ["file", entry.relativePath, contents.get(entry.relativePath)!.bytes, contents.get(entry.relativePath)!.sha256] as const);
  return EditableSourceTreeIdentitySchema.parse({
    root: sourceRoot,
    sha256: createHash("sha256").update(JSON.stringify(digestEntries)).digest("hex"),
    fileCount: initial.fileCount,
    totalBytes: initial.totalBytes,
  });
}

function parseJsonObject(bytes: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

async function resolveEditableSkill(root: string, requirements: LoadedContract["dependencies"][1]): Promise<ImageToEditablePptxSkillDependency> {
  const packageFile = await requiredRegularFile(
    root,
    join(root, "package.json"),
    "image-to-editable-pptx package.json is missing",
    "image-to-editable-pptx package.json is unsafe",
  );
  const packageBytes = await readIdentityFile(packageFile, "image-to-editable-pptx package.json");
  const pkg = parseJsonObject(packageBytes.toString("utf8"), "image-to-editable-pptx package.json");
  const engines = isRecord(pkg.engines) ? pkg.engines : null;
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : null;
  const profile = requirements.consumerProfile;
  if (
    pkg.name !== profile.package.name
    || typeof pkg.version !== "string"
    || !compatibleStableVersion(pkg.version, profile.package.version)
  ) throw new Error(`a stable image-to-editable-pptx ${profile.package.version} is required`);
  if (engines?.node !== profile.package.nodeEngine) {
    throw new Error(`image-to-editable-pptx package Node engine must be ${profile.package.nodeEngine}`);
  }
  if (scripts?.cli !== profile.package.cliScript) {
    throw new Error(`image-to-editable-pptx package cli script must be ${profile.package.cliScript}`);
  }

  const pluginFile = await requiredRegularFile(
    root,
    join(root, ".codex-plugin", "plugin.json"),
    "image-to-editable-pptx .codex-plugin/plugin.json is missing",
    "image-to-editable-pptx .codex-plugin/plugin.json is unsafe",
  );
  const pluginBytes = await readIdentityFile(pluginFile, "image-to-editable-pptx .codex-plugin/plugin.json");
  const plugin = parseJsonObject(pluginBytes.toString("utf8"), "image-to-editable-pptx .codex-plugin/plugin.json");
  if (plugin.name !== profile.plugin.name) throw new Error("image-to-editable-pptx plugin name is invalid");
  if (plugin.version !== pkg.version) throw new Error("image-to-editable-pptx plugin version must match package version");
  if (plugin.skills !== profile.plugin.skills) throw new Error("image-to-editable-pptx plugin skills path is invalid");

  const skillFile = await requiredRegularFile(
    root,
    join(root, "skills", "image-to-editable-pptx", "SKILL.md"),
    "editable Skill entry is missing",
    "editable Skill entry is unsafe",
  );
  const cliFile = await requiredRegularFile(
    root,
    join(root, "src", "cli.ts"),
    "image-to-editable-pptx src/cli.ts is missing",
    "image-to-editable-pptx src/cli.ts is unsafe",
  );
  const sourceTree = await computeEditableSourceTreeIdentity(root);
  const [skillBytes, cliBytes] = await Promise.all([
    readIdentityFile(skillFile, "image-to-editable-pptx Skill entry"),
    readIdentityFile(cliFile, "image-to-editable-pptx CLI identity"),
  ]);

  return ImageToEditablePptxSkillDependencySchema.parse({
    kind: "image-to-editable-pptx",
    root,
    packageFile,
    packageSha256: sha256Bytes(packageBytes),
    pluginFile,
    pluginSha256: sha256Bytes(pluginBytes),
    skillFile,
    skillSha256: sha256Bytes(skillBytes),
    cliFile,
    cliSha256: sha256Bytes(cliBytes),
    sourceTree,
    version: pkg.version,
    packageName: profile.package.name,
    nodeEngine: profile.package.nodeEngine,
    cliScript: profile.package.cliScript,
    pluginName: profile.plugin.name,
    pluginSkills: profile.plugin.skills,
    invocation: profile.invocation,
    outputContract: profile.outputContract,
  });
}

async function resolveAiWithContract(aiSkillRoot: string, requirements: LoadedContract["dependencies"][0]): Promise<AiImageSkillDependency> {
  const aiRoot = await canonicalSkillRoot(aiSkillRoot, "ai-image-to-ppt");
  const skillFile = await requiredRegularFile(aiRoot, join(aiRoot, "SKILL.md"), "ai-image-to-ppt Skill entry is missing", "ai-image-to-ppt Skill entry is unsafe");
  const capabilityManifestFile = await requiredRegularFile(
    aiRoot,
    join(aiRoot, ...requirements.capabilityManifest.path.split("/")),
    "ai-image-to-ppt capability manifest is missing",
    "ai-image-to-ppt capability manifest is unsafe",
  );
  let rawManifest: unknown;
  let capabilityManifestBytes: Buffer;
  try {
    capabilityManifestBytes = await readIdentityFile(capabilityManifestFile, "ai-image-to-ppt capability manifest");
    rawManifest = JSON.parse(capabilityManifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("ai-image-to-ppt capability manifest is invalid JSON", { cause: error });
  }
  let manifest;
  try {
    manifest = AiImageCapabilityManifestSchema.parse(rawManifest);
  } catch (error) {
    throw new Error("ai-image-to-ppt capability manifest is invalid", { cause: error });
  }
  if (
    manifest.schemaVersion !== requirements.capabilityManifest.schemaVersion
    || JSON.stringify(manifest.contracts) !== JSON.stringify(requirements.capabilityManifest.contracts)
    || JSON.stringify(manifest.scripts) !== JSON.stringify(requirements.capabilityManifest.scripts)
    || JSON.stringify(manifest.routingOrder) !== JSON.stringify(requirements.capabilityManifest.routingOrder)
    || JSON.stringify(manifest.outputs) !== JSON.stringify(requirements.capabilityManifest.outputs)
  ) throw new Error("ai-image-to-ppt capability manifest and dependency-contract script requirements disagree");

  const entries: Array<readonly [string, string]> = [];
  for (const [name, relativePath] of Object.entries(manifest.scripts)) {
    const filename = relativePath.split("/").at(-1)!;
    const absolutePath = await requiredRegularFile(
      aiRoot,
      join(aiRoot, ...relativePath.split("/")),
      `ai-image-to-ppt required script is missing: ${filename}`,
      `ai-image-to-ppt required script is unsafe: ${filename}`,
    );
    entries.push([name, absolutePath] as const);
  }
  const scripts = Object.fromEntries(entries) as AiImageSkillDependency["scripts"];
  const scriptSha256 = Object.fromEntries(await Promise.all(entries.map(async ([name, path]) => [name, await sha256(path)]))) as AiImageSkillDependency["scriptSha256"];
  return AiImageSkillDependencySchema.parse({
    kind: "ai-image-to-ppt",
    root: aiRoot,
    skillFile,
    skillSha256: await sha256(skillFile),
    gitRevision: await gitRevision(aiRoot),
    capabilityManifestFile,
    capabilityManifestSha256: sha256Bytes(capabilityManifestBytes),
    capabilitySchemaVersion: manifest.schemaVersion,
    contracts: manifest.contracts,
    routingOrder: manifest.routingOrder,
    outputs: manifest.outputs,
    scripts,
    scriptSha256,
    workflowPreflight: null,
  });
}

export async function resolveAiImageSkillDependency(aiSkillRoot: string): Promise<AiImageSkillDependency> {
  const { contract } = await loadDependencyContract();
  return resolveAiWithContract(aiSkillRoot, contract.dependencies[0]);
}

export async function resolveEditableSkillDependency(editableSkillRoot: string): Promise<ImageToEditablePptxSkillDependency> {
  const { contract } = await loadDependencyContract();
  return resolveEditableSkill(await canonicalSkillRoot(editableSkillRoot, "image-to-editable-pptx"), contract.dependencies[1]);
}

export async function resolveSkillDependencies(request: ResolveDependencyRequest): Promise<ResolvedDependencies> {
  const loaded = await loadDependencyContract(request.contractFile);
  const [ai, editable] = await Promise.all([
    resolveAiWithContract(request.aiSkillRoot, loaded.contract.dependencies[0]),
    canonicalSkillRoot(request.editableSkillRoot, "image-to-editable-pptx")
      .then((root) => resolveEditableSkill(root, loaded.contract.dependencies[1])),
  ]);
  return {
    contractFile: loaded.contractFile,
    contractSha256: loaded.contractSha256,
    ai,
    editable,
  };
}
