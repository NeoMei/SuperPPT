import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

import {
  AiImageCapabilityManifestSchema,
  AiImageSkillDependencySchema,
  DependencyContractSchema,
  ImageToEditablePptxSkillDependencySchema,
  type AiImageSkillDependency,
  type ImageToEditablePptxSkillDependency,
  type ResolvedDependencies,
} from "./schemas.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CONTRACT_FILE = fileURLToPath(new URL("../../references/dependencies.json", import.meta.url));

export type ResolveDependencyRequest = {
  aiSkillRoot: string;
  editableSkillRoot: string;
  contractFile?: string;
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(unsafeMessage);
  const physicalPath = await realpath(path);
  const relation = relative(root, physicalPath);
  if (physicalPath !== path || relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(unsafeMessage);
  }
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

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function gitRevision(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    const revision = stdout.trim();
    return revision === "" ? null : revision;
  } catch {
    return null;
  }
}

async function loadDependencyContract(path = DEFAULT_CONTRACT_FILE) {
  const contractFile = await canonicalContractFile(path);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(contractFile, "utf8"));
  } catch (error) {
    throw new Error("dependency contract is invalid JSON", { cause: error });
  }
  try {
    return { contractFile, contract: DependencyContractSchema.parse(value), contractSha256: await sha256(contractFile) };
  } catch (error) {
    throw new Error("dependency contract is invalid: manifestVersion 2, official donor slide-editable.pptx, and exact capability contracts are required", { cause: error });
  }
}

function compatibleVersion(version: string, range: string): boolean {
  if (range !== ">=0.2.0 <0.3.0") throw new Error("unsupported image-to-editable-pptx version requirement");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[-0-9A-Za-z.]+)?(?:\+[-0-9A-Za-z.]+)?$/.exec(version);
  if (!match) return false;
  return Number(match[1]) === 0 && Number(match[2]) === 2;
}

type LoadedContract = Awaited<ReturnType<typeof loadDependencyContract>>["contract"];

function parsedSource(path: string, source: string): ts.SourceFile {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) throw new Error("installed TypeScript capability evidence is not syntactically valid");
  return parsed;
}

function exported(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword));
}

function callTo(expression: ts.Expression, receiver: string, member: string): expression is ts.CallExpression {
  return ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.expression.text === receiver
    && expression.expression.name.text === member;
}

function baseFluentCall(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && ts.isCallExpression(current.expression.expression)) {
    current = current.expression.expression;
  }
  return current;
}

function manifestV2Exported(source: ts.SourceFile, version: number): boolean {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !exported(statement)) continue;
    const declaration = statement.declarationList.declarations.find(({ name }) => ts.isIdentifier(name) && name.text === "SlideManifestV2Schema");
    if (!declaration?.initializer) continue;
    const base = baseFluentCall(declaration.initializer);
    if (!callTo(base, "z", "object") || base.arguments.length !== 1 || !ts.isObjectLiteralExpression(base.arguments[0]!)) continue;
    const property = base.arguments[0]!.properties.find((candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate)
      && ((ts.isIdentifier(candidate.name) && candidate.name.text === "manifestVersion") || (ts.isStringLiteral(candidate.name) && candidate.name.text === "manifestVersion"))
    );
    if (property && callTo(property.initializer, "z", "literal") && property.initializer.arguments.length === 1) {
      const literal = property.initializer.arguments[0]!;
      if (ts.isNumericLiteral(literal) && Number(literal.text) === version) return true;
    }
  }
  return false;
}

function officialDonorIsExecutable(source: ts.SourceFile, donor: string): boolean {
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) functions.set(statement.name.text, statement);
  }
  const outputName = functions.get("outputName");
  if (!outputName?.body || outputName.parameters.length !== 1 || !ts.isIdentifier(outputName.parameters[0]!.name) || outputName.parameters[0]!.name.text !== "imagePath") return false;
  const hasDefaultReturn = outputName.body.statements.some((statement) => {
    if (!ts.isIfStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false;
    const condition = statement.expression;
    const exactUndefined = condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && ts.isIdentifier(condition.left) && condition.left.text === "imagePath"
      && ts.isIdentifier(condition.right) && condition.right.text === "undefined";
    const returned = ts.isReturnStatement(statement.thenStatement)
      ? statement.thenStatement
      : ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.length === 1 && ts.isReturnStatement(statement.thenStatement.statements[0]!)
        ? statement.thenStatement.statements[0]
        : undefined;
    return exactUndefined && returned?.expression !== undefined && ts.isStringLiteral(returned.expression) && returned.expression.text === donor;
  });
  const callsFrom = (declaration: ts.FunctionDeclaration): Set<string> => {
    const calls = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text);
      ts.forEachChild(node, visit);
    };
    if (declaration.body) visit(declaration.body);
    return calls;
  };
  const pending = [...functions.values()].filter(exported).map(({ name }) => name!.text);
  const reachable = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const declaration = functions.get(name);
    if (!declaration) continue;
    for (const called of callsFrom(declaration)) if (functions.has(called)) pending.push(called);
  }
  return hasDefaultReturn && reachable.has("outputName");
}

function objectNamesAreExported(source: ts.SourceFile, names: LoadedContract["dependencies"][1]["capabilities"]["objectNames"]): boolean {
  const exportFunction = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && exported(statement) && statement.name?.text === "exportPptx" && statement.body !== undefined
  );
  if (!exportFunction?.body) return false;
  const found = new Set<string>();
  let writesPptx = false;
  const objectVariables = new Map<string, ts.ObjectLiteralExpression>();
  const collectVariables = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      objectVariables.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectVariables);
  };
  collectVariables(exportFunction.body);
  const collectObjectName = (object: ts.ObjectLiteralExpression): void => {
    const property = object.properties.find((candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate)
      && ((ts.isIdentifier(candidate.name) && candidate.name.text === "objectName") || (ts.isStringLiteral(candidate.name) && candidate.name.text === "objectName"))
    );
    if (!property) return;
    if (ts.isStringLiteral(property.initializer)) found.add(property.initializer.text);
    else if (ts.isTemplateExpression(property.initializer)) found.add(property.initializer.getText(source));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "writeFile") writesPptx = true;
      if (["addImage", "addText", "addShape"].includes(method)) {
        for (const argument of node.arguments) {
          if (ts.isObjectLiteralExpression(argument)) collectObjectName(argument);
          else if (ts.isIdentifier(argument)) {
            const object = objectVariables.get(argument.text);
            if (object) collectObjectName(object);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(exportFunction.body);
  return writesPptx
    && found.has(names.background)
    && found.has(`\`text-\${element.id}\``)
    && found.has(`\`shape-\${element.id}-\${element.label}\``)
    && found.has(`\`asset-\${element.id}\``);
}

async function editableCapabilityEvidence(
  root: string,
  requirements: LoadedContract["dependencies"][1],
): Promise<ImageToEditablePptxSkillDependency["capabilityEvidence"]> {
  const paths = {
    manifestSchema: await requiredRegularFile(root, join(root, ...requirements.capabilities.evidence.manifestSchema.split("/")), "image-to-editable-pptx manifest capability evidence is missing", "image-to-editable-pptx manifest capability evidence is unsafe"),
    officialDonor: await requiredRegularFile(root, join(root, ...requirements.capabilities.evidence.officialDonor.split("/")), "image-to-editable-pptx official donor capability evidence is missing", "image-to-editable-pptx official donor capability evidence is unsafe"),
    objectNames: await requiredRegularFile(root, join(root, ...requirements.capabilities.evidence.objectNames.split("/")), "image-to-editable-pptx object-name capability evidence is missing", "image-to-editable-pptx object-name capability evidence is unsafe"),
  };
  const [manifestSource, donorSource, objectSource] = await Promise.all([
    readFile(paths.manifestSchema, "utf8"),
    readFile(paths.officialDonor, "utf8"),
    readFile(paths.objectNames, "utf8"),
  ]);
  if (!manifestV2Exported(parsedSource(paths.manifestSchema, manifestSource), requirements.capabilities.manifestVersion)) {
    throw new Error("image-to-editable-pptx installed semantic capability evidence does not prove manifest v2");
  }
  if (!officialDonorIsExecutable(parsedSource(paths.officialDonor, donorSource), requirements.capabilities.officialDonor)) {
    throw new Error("image-to-editable-pptx installed semantic capability evidence does not prove the official donor");
  }
  if (!objectNamesAreExported(parsedSource(paths.objectNames, objectSource), requirements.capabilities.objectNames)) {
    throw new Error("image-to-editable-pptx installed semantic capability evidence does not prove the object-name contract");
  }
  return {
    manifestSchema: { path: paths.manifestSchema, sha256: await sha256(paths.manifestSchema) },
    officialDonor: { path: paths.officialDonor, sha256: await sha256(paths.officialDonor) },
    objectNames: { path: paths.objectNames, sha256: await sha256(paths.objectNames) },
  };
}

async function resolveEditableSkill(root: string, requirements: LoadedContract["dependencies"][1]): Promise<ImageToEditablePptxSkillDependency> {
  const packageFile = await requiredRegularFile(root, join(root, "package.json"), "image-to-editable-pptx package.json is missing", "image-to-editable-pptx package.json is unsafe");
  let pkg: { name?: string; version?: string };
  try {
    pkg = JSON.parse(await readFile(packageFile, "utf8")) as { name?: string; version?: string };
  } catch (error) {
    throw new Error("image-to-editable-pptx package.json is invalid", { cause: error });
  }
  if (pkg.name !== "image-to-editable-pptx" || !pkg.version || !compatibleVersion(pkg.version, requirements.capabilities.version)) {
    throw new Error(`a compatible image-to-editable-pptx ${requirements.capabilities.version} is required`);
  }
  const skillFile = await requiredRegularFile(root, join(root, "skills", "image-to-editable-pptx", "SKILL.md"), "editable Skill entry is missing", "editable Skill entry is unsafe");
  const capabilityEvidence = await editableCapabilityEvidence(root, requirements);
  return ImageToEditablePptxSkillDependencySchema.parse({
    kind: "image-to-editable-pptx",
    root,
    packageFile,
    packageSha256: await sha256(packageFile),
    skillFile,
    skillSha256: await sha256(skillFile),
    version: pkg.version,
    manifestVersion: requirements.capabilities.manifestVersion,
    officialDonor: requirements.capabilities.officialDonor,
    objectNames: requirements.capabilities.objectNames,
    capabilityEvidence,
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
  try {
    rawManifest = JSON.parse(await readFile(capabilityManifestFile, "utf8"));
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
    capabilityManifestSha256: await sha256(capabilityManifestFile),
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
    canonicalSkillRoot(request.editableSkillRoot, "image-to-editable-pptx").then((root) => resolveEditableSkill(root, loaded.contract.dependencies[1])),
  ]);
  return {
    contractFile: loaded.contractFile,
    contractSha256: loaded.contractSha256,
    ai,
    editable,
    integrity: {
      aiSkillSha256: ai.skillSha256,
      aiCapabilityManifestSha256: ai.capabilityManifestSha256,
      aiScripts: ai.scriptSha256,
      editablePackageSha256: editable.packageSha256,
      editableSkillSha256: editable.skillSha256,
      editableCapabilityEvidence: editable.capabilityEvidence,
      contractSha256: loaded.contractSha256,
    },
  };
}
