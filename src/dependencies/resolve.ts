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

type ParsedCapabilitySource = {
  source: ts.SourceFile;
  checker: ts.TypeChecker;
};

function parsedSource(path: string, source: string): ParsedCapabilitySource {
  const filename = resolve(path);
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) throw new Error("installed TypeScript capability evidence is not syntactically valid");
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext };
  const baseHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (candidate) => resolve(candidate) === filename,
    readFile: (candidate) => resolve(candidate) === filename ? source : undefined,
    getSourceFile: (candidate) => resolve(candidate) === filename ? parsed : undefined,
  };
  const program = ts.createProgram([filename], options, host);
  return { source: parsed, checker: program.getTypeChecker() };
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

type ExecutableFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

type AbstractValue =
  | { kind: "unknown" }
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "bigint"; zero: boolean }
  | { kind: "string"; value: string }
  | { kind: "template"; value: string }
  | { kind: "function"; node: ExecutableFunction; closure?: Map<ts.Symbol, AbstractValue> }
  | { kind: "object"; properties: Map<string, AbstractValue> }
  | { kind: "array"; values: AbstractValue[] }
  | { kind: "pptx"; id: number }
  | { kind: "slide"; id: number; pptxId: number };

type Completion =
  | { kind: "normal" }
  | { kind: "return"; value: AbstractValue }
  | { kind: "throw" }
  | { kind: "break"; label?: string }
  | { kind: "continue"; label?: string };

type FlowState = {
  env: Map<ts.Symbol, AbstractValue>;
  completion: Completion;
  objectNames: Map<number, Set<string>>;
};

type CallRecord = {
  target: Extract<AbstractValue, { kind: "function" }>;
  arguments: AbstractValue[];
};

type FlowContext = {
  parsed: ParsedCapabilitySource;
  functions: Map<ts.Symbol, ExecutableFunction>;
  staticValues: Map<ts.Symbol, AbstractValue>;
  calls: CallRecord[];
  objectRequirements?: ReadonlySet<string>;
  objectProof: boolean;
  slideOwners: Map<number, number>;
  nextIdentity: number;
  symbolIds: Map<ts.Symbol, number>;
};

type EvalResult = { state: FlowState; value: AbstractValue };

const UNKNOWN_VALUE: AbstractValue = { kind: "unknown" };
const UNDEFINED_VALUE: AbstractValue = { kind: "undefined" };
const NULL_VALUE: AbstractValue = { kind: "null" };
const NORMAL_COMPLETION: Completion = { kind: "normal" };
const MAX_LOOP_ITERATIONS = 4;
const MAX_FLOW_STATES = 512;

function collectFunctions(parsed: ParsedCapabilitySource): Map<ts.Symbol, ExecutableFunction> {
  const functions = new Map<ts.Symbol, ExecutableFunction>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const symbol = parsed.checker.getSymbolAtLocation(node.name);
      if (symbol) functions.set(symbol, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.source);
  return functions;
}

function staticInitializer(
  expression: ts.Expression,
  parsed: ParsedCapabilitySource,
  functions: Map<ts.Symbol, ExecutableFunction>,
  known: Map<ts.Symbol, AbstractValue>,
): AbstractValue {
  const node = unwrapExpression(expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return NULL_VALUE;
  if (ts.isNumericLiteral(node)) return { kind: "number", value: Number(node.text) };
  if (ts.isBigIntLiteral(node)) return { kind: "bigint", zero: /^0+n$/i.test(node.text) };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "string", value: node.text };
  if (ts.isObjectLiteralExpression(node)) return { kind: "object", properties: new Map() };
  if (ts.isArrayLiteralExpression(node)) return {
    kind: "array",
    values: node.elements.map((element) => ts.isOmittedExpression(element) ? UNDEFINED_VALUE : staticInitializer(element, parsed, functions, known)),
  };
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return { kind: "function", node };
  if (ts.isIdentifier(node)) {
    const symbol = parsed.checker.getSymbolAtLocation(node);
    if (symbol && known.has(symbol)) return known.get(symbol)!;
    const target = symbol ? functions.get(symbol) : undefined;
    if (target) return { kind: "function", node: target };
    if (node.text === "undefined" && symbol === undefined) return UNDEFINED_VALUE;
    return UNKNOWN_VALUE;
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = staticInitializer(node.operand, parsed, functions, known);
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      const truth = truthOf(operand);
      return truth === undefined ? UNKNOWN_VALUE : { kind: "boolean", value: !truth };
    }
    if (node.operator === ts.SyntaxKind.MinusToken && operand.kind === "number") return { kind: "number", value: -operand.value };
    if (node.operator === ts.SyntaxKind.PlusToken && operand.kind === "number") return operand;
  }
  return UNKNOWN_VALUE;
}

function collectStaticValues(parsed: ParsedCapabilitySource, functions: Map<ts.Symbol, ExecutableFunction>): Map<ts.Symbol, AbstractValue> {
  const values = new Map<ts.Symbol, AbstractValue>();
  const declarations = parsed.source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      ? [...statement.declarationList.declarations]
      : []
  );
  for (let pass = 0; pass < declarations.length + 1; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const symbol = parsed.checker.getSymbolAtLocation(declaration.name);
      if (!symbol || values.has(symbol)) continue;
      const value = staticInitializer(declaration.initializer, parsed, functions, values);
      if (value.kind !== "unknown") {
        values.set(symbol, value);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return values;
}

function flowContext(parsed: ParsedCapabilitySource, objectRequirements?: ReadonlySet<string>): FlowContext {
  const functions = collectFunctions(parsed);
  return {
    parsed,
    functions,
    staticValues: collectStaticValues(parsed, functions),
    calls: [],
    ...(objectRequirements === undefined ? {} : { objectRequirements }),
    objectProof: false,
    slideOwners: new Map(),
    nextIdentity: 1,
    symbolIds: new Map(),
  };
}

function cloneState(state: FlowState): FlowState {
  return {
    env: new Map(state.env),
    completion: state.completion.kind === "return"
      ? { kind: "return", value: state.completion.value }
      : state.completion.kind === "break" || state.completion.kind === "continue"
        ? { kind: state.completion.kind, ...(state.completion.label === undefined ? {} : { label: state.completion.label }) }
        : { kind: state.completion.kind },
    objectNames: new Map([...state.objectNames].map(([id, values]) => [id, new Set(values)])),
  };
}

function valueSignature(value: AbstractValue): string {
  switch (value.kind) {
    case "unknown":
    case "undefined":
    case "null": return value.kind;
    case "boolean":
    case "number":
    case "string":
    case "template": return `${value.kind}:${String(value.value)}`;
    case "bigint": return `bigint:${value.zero ? "0" : "1"}`;
    case "function": return `function:${value.node.pos}`;
    case "array": return `array:[${value.values.map(valueSignature).join(",")}]`;
    case "pptx": return `pptx:${value.id}`;
    case "slide": return `slide:${value.id}:${value.pptxId}`;
    case "object": return `object:{${[...value.properties].map(([name, nested]) => `${name}=${valueSignature(nested)}`).sort().join(",")}}`;
  }
}

function stateSignature(state: FlowState, context: FlowContext): string {
  const symbolId = (symbol: ts.Symbol): number => {
    const known = context.symbolIds.get(symbol);
    if (known !== undefined) return known;
    const created = context.symbolIds.size + 1;
    context.symbolIds.set(symbol, created);
    return created;
  };
  const env = [...state.env]
    .map(([symbol, value]) => `${symbolId(symbol)}=${valueSignature(value)}`)
    .sort()
    .join(";");
  const names = [...state.objectNames]
    .map(([id, values]) => `${id}:${[...values].sort().join(",")}`)
    .sort()
    .join(";");
  const completion = state.completion.kind === "return"
    ? `return:${valueSignature(state.completion.value)}`
    : state.completion.kind === "break" || state.completion.kind === "continue"
      ? `${state.completion.kind}:${state.completion.label ?? ""}`
      : state.completion.kind;
  return `${completion}|${env}|${names}`;
}

function dedupeStates(states: FlowState[], context: FlowContext): FlowState[] {
  const unique = new Map<string, FlowState>();
  for (const state of states) {
    const signature = stateSignature(state, context);
    if (!unique.has(signature)) unique.set(signature, state);
    if (unique.size >= MAX_FLOW_STATES) break;
  }
  return [...unique.values()];
}

function truthOf(value: AbstractValue): boolean | undefined {
  switch (value.kind) {
    case "undefined":
    case "null": return false;
    case "boolean": return value.value;
    case "number": return value.value !== 0 && !Number.isNaN(value.value);
    case "bigint": return !value.zero;
    case "string": return value.value.length > 0;
    case "function":
    case "object":
    case "array":
    case "pptx":
    case "slide": return true;
    case "unknown":
    case "template": return undefined;
  }
}

function nullishOf(value: AbstractValue): boolean | undefined {
  if (value.kind === "undefined" || value.kind === "null") return true;
  if (value.kind === "unknown") return undefined;
  return false;
}

function samePrimitive(left: AbstractValue, right: AbstractValue): boolean | undefined {
  if (left.kind === "unknown" || right.kind === "unknown" || left.kind === "template" || right.kind === "template") return undefined;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "undefined":
    case "null": return true;
    case "boolean": return left.value === (right as Extract<AbstractValue, { kind: "boolean" }>).value;
    case "number": return left.value === (right as Extract<AbstractValue, { kind: "number" }>).value;
    case "bigint": return left.zero === (right as Extract<AbstractValue, { kind: "bigint" }>).zero;
    case "string": return left.value === (right as Extract<AbstractValue, { kind: "string" }>).value;
    default: return left === right;
  }
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function functionValue(node: ExecutableFunction, state: FlowState): AbstractValue {
  return {
    kind: "function",
    node,
    ...(node.parent && ts.isSourceFile(node.parent) ? {} : { closure: new Map(state.env) }),
  };
}

function definitelyThrows(target: ExecutableFunction): boolean {
  if (!target.body || !ts.isBlock(target.body)) return false;
  const firstExecutable = target.body.statements.find((statement) => !ts.isEmptyStatement(statement) && !ts.isFunctionDeclaration(statement));
  return firstExecutable !== undefined && ts.isThrowStatement(firstExecutable);
}

function refineCondition(expression: ts.Expression, state: FlowState, truth: boolean, context: FlowContext): FlowState {
  const node = unwrapExpression(expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return refineCondition(node.operand, state, !truth, context);
  }
  if (!ts.isIdentifier(node) || bindingValue(node, state, context).kind !== "unknown") return state;
  return setBinding(node, { kind: "boolean", value: truth }, state, context);
}

function bindingValue(identifier: ts.Identifier, state: FlowState, context: FlowContext): AbstractValue {
  const symbol = context.parsed.checker.getSymbolAtLocation(identifier);
  if (symbol && state.env.has(symbol)) return state.env.get(symbol)!;
  if (symbol && context.staticValues.has(symbol)) return context.staticValues.get(symbol)!;
  const target = symbol ? context.functions.get(symbol) : undefined;
  if (target) return functionValue(target, state);
  if (identifier.text === "undefined" && symbol === undefined) return UNDEFINED_VALUE;
  return UNKNOWN_VALUE;
}

function setBinding(identifier: ts.Identifier, value: AbstractValue, state: FlowState, context: FlowContext): FlowState {
  const next = cloneState(state);
  const symbol = context.parsed.checker.getSymbolAtLocation(identifier);
  if (symbol) next.env.set(symbol, value);
  return next;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

function evaluateObject(node: ts.ObjectLiteralExpression, state: FlowState, context: FlowContext): EvalResult[] {
  type ObjectBranch = { state: FlowState; properties: Map<string, AbstractValue> };
  let branches: ObjectBranch[] = [{ state, properties: new Map() }];
  for (const property of node.properties) {
    const next: ObjectBranch[] = [];
    for (const branch of branches) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name);
        for (const result of evaluateExpression(property.initializer, branch.state, context)) {
          const properties = new Map(branch.properties);
          if (name !== undefined) properties.set(name, result.value);
          next.push({ state: result.state, properties });
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const value = bindingValue(property.name, branch.state, context);
        const properties = new Map(branch.properties);
        properties.set(property.name.text, value);
        next.push({ state: branch.state, properties });
      } else if (ts.isSpreadAssignment(property)) {
        for (const result of evaluateExpression(property.expression, branch.state, context)) {
          const properties = new Map(branch.properties);
          if (result.value.kind === "object") {
            for (const [name, value] of result.value.properties) properties.set(name, value);
          }
          next.push({ state: result.state, properties });
        }
      } else {
        next.push(branch);
      }
    }
    branches = next;
  }
  return branches.map((branch) => ({ state: branch.state, value: { kind: "object", properties: branch.properties } }));
}

function evaluateArguments(argumentsList: readonly ts.Expression[], state: FlowState, context: FlowContext): Array<{ state: FlowState; values: AbstractValue[] }> {
  let branches: Array<{ state: FlowState; values: AbstractValue[] }> = [{ state, values: [] }];
  for (const argument of argumentsList) {
    const next: Array<{ state: FlowState; values: AbstractValue[] }> = [];
    for (const branch of branches) {
      for (const result of evaluateExpression(argument, branch.state, context)) {
        next.push({ state: result.state, values: [...branch.values, result.value] });
      }
    }
    branches = next;
  }
  return branches;
}

function recordObjectCall(
  receiver: AbstractValue | undefined,
  member: string | undefined,
  argumentsList: AbstractValue[],
  state: FlowState,
  context: FlowContext,
): void {
  if (!context.objectRequirements || !receiver || !member) return;
  if (receiver.kind === "slide" && ["addImage", "addText", "addShape"].includes(member)) {
    const found = state.objectNames.get(receiver.id) ?? new Set<string>();
    for (const argument of argumentsList) {
      if (argument.kind !== "object") continue;
      const objectName = argument.properties.get("objectName");
      if (objectName?.kind === "string" || objectName?.kind === "template") found.add(objectName.value);
    }
    state.objectNames.set(receiver.id, found);
    return;
  }
  if (receiver.kind !== "pptx" || member !== "writeFile") return;
  for (const [slideId, found] of state.objectNames) {
    if (context.slideOwners.get(slideId) !== receiver.id) continue;
    if ([...context.objectRequirements].every((required) => found.has(required))) {
      context.objectProof = true;
      return;
    }
  }
}

function evaluateCall(node: ts.CallExpression, state: FlowState, context: FlowContext): EvalResult[] {
  type Callee = { state: FlowState; value: AbstractValue; receiver?: AbstractValue; member?: string };
  const calleeExpression = unwrapExpression(node.expression);
  let callees: Callee[];
  if (ts.isPropertyAccessExpression(calleeExpression)) {
    callees = evaluateExpression(calleeExpression.expression, state, context).map((result) => ({
      state: result.state,
      value: result.value.kind === "object" ? result.value.properties.get(calleeExpression.name.text) ?? UNKNOWN_VALUE : UNKNOWN_VALUE,
      receiver: result.value,
      member: calleeExpression.name.text,
    }));
  } else {
    callees = evaluateExpression(calleeExpression, state, context).map((result) => ({ state: result.state, value: result.value }));
  }
  const results: EvalResult[] = [];
  for (const callee of callees) {
    for (const evaluated of evaluateArguments(node.arguments, callee.state, context)) {
      const nextState = cloneState(evaluated.state);
      recordObjectCall(callee.receiver, callee.member, evaluated.values, nextState, context);
      if (callee.value.kind === "function") context.calls.push({ target: callee.value, arguments: evaluated.values });
      if (callee.value.kind === "function" && definitelyThrows(callee.value.node)) continue;
      if (callee.receiver?.kind === "pptx" && callee.member === "addSlide") {
        const id = context.nextIdentity++;
        context.slideOwners.set(id, callee.receiver.id);
        results.push({ state: nextState, value: { kind: "slide", id, pptxId: callee.receiver.id } });
      } else {
        results.push({ state: nextState, value: UNKNOWN_VALUE });
      }
    }
  }
  return results;
}

function evaluateExpression(input: ts.Expression, state: FlowState, context: FlowContext): EvalResult[] {
  const node = unwrapExpression(input);
  if (ts.isIdentifier(node)) return [{ state, value: bindingValue(node, state, context) }];
  if (node.kind === ts.SyntaxKind.TrueKeyword) return [{ state, value: { kind: "boolean", value: true } }];
  if (node.kind === ts.SyntaxKind.FalseKeyword) return [{ state, value: { kind: "boolean", value: false } }];
  if (node.kind === ts.SyntaxKind.NullKeyword) return [{ state, value: NULL_VALUE }];
  if (ts.isNumericLiteral(node)) return [{ state, value: { kind: "number", value: Number(node.text) } }];
  if (ts.isBigIntLiteral(node)) return [{ state, value: { kind: "bigint", zero: /^0+n$/i.test(node.text) } }];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [{ state, value: { kind: "string", value: node.text } }];
  if (ts.isTemplateExpression(node)) return [{ state, value: { kind: "template", value: node.getText(context.parsed.source) } }];
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return [{ state, value: functionValue(node, state) }];
  if (ts.isObjectLiteralExpression(node)) return evaluateObject(node, state, context);
  if (ts.isArrayLiteralExpression(node)) {
    return evaluateArguments(node.elements, state, context).map((result) => ({ state: result.state, value: { kind: "array", values: result.values } }));
  }
  if (ts.isPropertyAccessExpression(node)) {
    return evaluateExpression(node.expression, state, context).map((result) => ({
      state: result.state,
      value: result.value.kind === "object" ? result.value.properties.get(node.name.text) ?? UNKNOWN_VALUE : UNKNOWN_VALUE,
    }));
  }
  if (ts.isElementAccessExpression(node)) {
    const results: EvalResult[] = [];
    for (const receiver of evaluateExpression(node.expression, state, context)) {
      if (!node.argumentExpression) results.push({ state: receiver.state, value: UNKNOWN_VALUE });
      else for (const argument of evaluateExpression(node.argumentExpression, receiver.state, context)) results.push({ state: argument.state, value: UNKNOWN_VALUE });
    }
    return results;
  }
  if (ts.isAwaitExpression(node)) return evaluateExpression(node.expression, state, context);
  if (ts.isVoidExpression(node)) return evaluateExpression(node.expression, state, context).map((result) => ({ state: result.state, value: UNDEFINED_VALUE }));
  if (ts.isCallExpression(node)) return evaluateCall(node, state, context);
  if (ts.isNewExpression(node)) {
    const argumentResults = evaluateArguments(node.arguments ?? [], state, context);
    const trusted = ts.isIdentifier(node.expression)
      && node.expression.text === "PptxGenConstructor"
      && (() => {
        const symbol = context.parsed.checker.getSymbolAtLocation(node.expression);
        return symbol === undefined || !(symbol.declarations ?? []).some((declaration) => enclosingFunction(declaration) !== undefined);
      })();
    return argumentResults.map((result) => trusted
      ? { state: result.state, value: { kind: "pptx", id: context.nextIdentity++ } }
      : { state: result.state, value: UNKNOWN_VALUE });
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const results: EvalResult[] = [];
    for (const operand of evaluateExpression(node.operand, state, context)) {
      if (node.operator === ts.SyntaxKind.ExclamationToken) {
        const truth = truthOf(operand.value);
        results.push({ state: operand.state, value: truth === undefined ? UNKNOWN_VALUE : { kind: "boolean", value: !truth } });
      } else if (node.operator === ts.SyntaxKind.MinusToken && operand.value.kind === "number") {
        results.push({ state: operand.state, value: { kind: "number", value: -operand.value.value } });
      } else if (node.operator === ts.SyntaxKind.PlusToken && operand.value.kind === "number") {
        results.push(operand);
      } else {
        results.push({ state: operand.state, value: UNKNOWN_VALUE });
      }
    }
    return results;
  }
  if (ts.isPostfixUnaryExpression(node)) {
    return evaluateExpression(node.operand, state, context).map((result) => ({ state: result.state, value: UNKNOWN_VALUE }));
  }
  if (ts.isConditionalExpression(node)) {
    const results: EvalResult[] = [];
    for (const condition of evaluateExpression(node.condition, state, context)) {
      const truth = truthOf(condition.value);
      if (truth !== false) {
        const whenTrue = truth === undefined ? refineCondition(node.condition, cloneState(condition.state), true, context) : condition.state;
        results.push(...evaluateExpression(node.whenTrue, whenTrue, context));
      }
      if (truth !== true) {
        const whenFalse = truth === undefined ? refineCondition(node.condition, cloneState(condition.state), false, context) : condition.state;
        results.push(...evaluateExpression(node.whenFalse, whenFalse, context));
      }
    }
    return results;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.EqualsToken) {
      const results: EvalResult[] = [];
      for (const right of evaluateExpression(node.right, state, context)) {
        const left = unwrapExpression(node.left);
        results.push({ state: ts.isIdentifier(left) ? setBinding(left, right.value, right.state, context) : right.state, value: right.value });
      }
      return results;
    }
    if (operator === ts.SyntaxKind.CommaToken) {
      const results: EvalResult[] = [];
      for (const left of evaluateExpression(node.left, state, context)) results.push(...evaluateExpression(node.right, left.state, context));
      return results;
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      const results: EvalResult[] = [];
      for (const left of evaluateExpression(node.left, state, context)) {
        const decision = operator === ts.SyntaxKind.QuestionQuestionToken ? nullishOf(left.value) : truthOf(left.value);
        const reachesRight = operator === ts.SyntaxKind.AmpersandAmpersandToken
          ? decision !== false
          : operator === ts.SyntaxKind.QuestionQuestionToken
            ? decision !== false
            : decision !== true;
        const keepsLeft = operator === ts.SyntaxKind.AmpersandAmpersandToken
          ? decision !== true
          : operator === ts.SyntaxKind.QuestionQuestionToken
            ? decision !== true
            : decision !== false;
        if (keepsLeft) results.push({ state: decision === undefined ? cloneState(left.state) : left.state, value: left.value });
        if (reachesRight) results.push(...evaluateExpression(node.right, decision === undefined ? cloneState(left.state) : left.state, context));
      }
      return results;
    }
    const results: EvalResult[] = [];
    for (const left of evaluateExpression(node.left, state, context)) {
      for (const right of evaluateExpression(node.right, left.state, context)) {
        if (
          operator === ts.SyntaxKind.EqualsEqualsEqualsToken
          || operator === ts.SyntaxKind.EqualsEqualsToken
          || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
          || operator === ts.SyntaxKind.ExclamationEqualsToken
        ) {
          const equal = samePrimitive(left.value, right.value);
          const negated = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
          results.push({ state: right.state, value: equal === undefined ? UNKNOWN_VALUE : { kind: "boolean", value: negated ? !equal : equal } });
        } else {
          results.push({ state: right.state, value: UNKNOWN_VALUE });
        }
      }
    }
    return results;
  }
  if (ts.isSpreadElement(node)) return evaluateExpression(node.expression, state, context);
  return [{ state, value: UNKNOWN_VALUE }];
}

function executeVariableDeclarations(node: ts.VariableDeclarationList, state: FlowState, context: FlowContext): FlowState[] {
  let states = [state];
  for (const declaration of node.declarations) {
    const next: FlowState[] = [];
    for (const current of states) {
      const values = declaration.initializer
        ? evaluateExpression(declaration.initializer, current, context)
        : [{ state: current, value: UNDEFINED_VALUE }];
      for (const result of values) {
        next.push(ts.isIdentifier(declaration.name)
          ? setBinding(declaration.name, result.value, result.state, context)
          : result.state);
      }
    }
    states = dedupeStates(next, context);
  }
  return states;
}

function executeStatements(statements: readonly ts.Statement[], initial: FlowState[], context: FlowContext): FlowState[] {
  let states = initial;
  for (const statement of statements) {
    const next: FlowState[] = [];
    for (const state of states) {
      if (state.completion.kind === "normal") next.push(...executeStatement(statement, state, context));
      else next.push(state);
    }
    states = dedupeStates(next, context);
  }
  return states;
}

function loopCompletionMatches(completion: Extract<Completion, { kind: "break" | "continue" }>, label?: string): boolean {
  return completion.label === undefined || completion.label === label;
}

function normalCopy(state: FlowState): FlowState {
  const next = cloneState(state);
  next.completion = NORMAL_COMPLETION;
  return next;
}

function executeWhile(node: ts.WhileStatement, state: FlowState, context: FlowContext, label?: string): FlowState[] {
  const iterate = (active: FlowState[], iteration: number): FlowState[] => {
    const outputs: FlowState[] = [];
    const repeat: FlowState[] = [];
    for (const current of active) {
      for (const condition of evaluateExpression(node.expression, current, context)) {
        const truth = truthOf(condition.value);
        if (truth !== true) outputs.push(truth === undefined ? cloneState(condition.state) : condition.state);
        if (truth === false || iteration >= MAX_LOOP_ITERATIONS) continue;
        const bodyStart = truth === undefined ? cloneState(condition.state) : condition.state;
        for (const body of executeStatement(node.statement, bodyStart, context)) {
          if (body.completion.kind === "normal") repeat.push(body);
          else if (body.completion.kind === "continue" && loopCompletionMatches(body.completion, label)) repeat.push(normalCopy(body));
          else if (body.completion.kind === "break" && loopCompletionMatches(body.completion, label)) outputs.push(normalCopy(body));
          else outputs.push(body);
        }
      }
    }
    if (repeat.length > 0) outputs.push(...iterate(dedupeStates(repeat, context), iteration + 1));
    return dedupeStates(outputs, context);
  };
  return iterate([state], 0);
}

function evaluateForInitializer(node: ts.ForInitializer | undefined, state: FlowState, context: FlowContext): FlowState[] {
  if (!node) return [state];
  if (ts.isVariableDeclarationList(node)) return executeVariableDeclarations(node, state, context);
  return evaluateExpression(node, state, context).map((result) => result.state);
}

function executeFor(node: ts.ForStatement, state: FlowState, context: FlowContext, label?: string): FlowState[] {
  const iterate = (active: FlowState[], iteration: number): FlowState[] => {
    const outputs: FlowState[] = [];
    const repeat: FlowState[] = [];
    for (const current of active) {
      const conditions = node.condition
        ? evaluateExpression(node.condition, current, context)
        : [{ state: current, value: { kind: "boolean", value: true } as AbstractValue }];
      for (const condition of conditions) {
        const truth = truthOf(condition.value);
        if (truth !== true) outputs.push(truth === undefined ? cloneState(condition.state) : condition.state);
        if (truth === false || iteration >= MAX_LOOP_ITERATIONS) continue;
        const bodyStart = truth === undefined ? cloneState(condition.state) : condition.state;
        for (const body of executeStatement(node.statement, bodyStart, context)) {
          if (body.completion.kind === "break" && loopCompletionMatches(body.completion, label)) {
            outputs.push(normalCopy(body));
            continue;
          }
          if (body.completion.kind !== "normal" && !(body.completion.kind === "continue" && loopCompletionMatches(body.completion, label))) {
            outputs.push(body);
            continue;
          }
          const continuing = body.completion.kind === "continue" ? normalCopy(body) : body;
          if (!node.incrementor) repeat.push(continuing);
          else for (const increment of evaluateExpression(node.incrementor, continuing, context)) repeat.push(increment.state);
        }
      }
    }
    if (repeat.length > 0) outputs.push(...iterate(dedupeStates(repeat, context), iteration + 1));
    return dedupeStates(outputs, context);
  };
  const initialized = evaluateForInitializer(node.initializer, state, context);
  return iterate(initialized, 0);
}

function bindForEachInitializer(node: ts.ForInitializer, state: FlowState, context: FlowContext, value: AbstractValue = UNKNOWN_VALUE): FlowState[] {
  if (ts.isVariableDeclarationList(node)) {
    const declaration = node.declarations[0];
    if (!declaration || !ts.isIdentifier(declaration.name)) return [state];
    return [setBinding(declaration.name, value, state, context)];
  }
  const target = unwrapExpression(node);
  return [ts.isIdentifier(target) ? setBinding(target, value, state, context) : state];
}

function executeForEach(node: ts.ForOfStatement | ts.ForInStatement, state: FlowState, context: FlowContext, label?: string): FlowState[] {
  const iterable = evaluateExpression(node.expression, state, context);
  const iterate = (active: FlowState[], iteration: number): FlowState[] => {
    const outputs = active.map(cloneState);
    if (iteration >= MAX_LOOP_ITERATIONS) return dedupeStates(outputs, context);
    const repeat: FlowState[] = [];
    for (const current of active) {
      for (const bound of bindForEachInitializer(node.initializer, cloneState(current), context)) {
        for (const body of executeStatement(node.statement, bound, context)) {
          if (body.completion.kind === "break" && loopCompletionMatches(body.completion, label)) outputs.push(normalCopy(body));
          else if (body.completion.kind === "normal") repeat.push(body);
          else if (body.completion.kind === "continue" && loopCompletionMatches(body.completion, label)) repeat.push(normalCopy(body));
          else outputs.push(body);
        }
      }
    }
    if (repeat.length > 0) outputs.push(...iterate(dedupeStates(repeat, context), iteration + 1));
    return dedupeStates(outputs, context);
  };
  const outputs: FlowState[] = [];
  const unknownLength: FlowState[] = [];
  for (const result of iterable) {
    if (result.value.kind !== "array") {
      unknownLength.push(result.state);
      continue;
    }
    let active = [result.state];
    for (const value of result.value.values) {
      const next: FlowState[] = [];
      for (const current of active) {
        for (const bound of bindForEachInitializer(node.initializer, current, context, value)) {
          for (const body of executeStatement(node.statement, bound, context)) {
            if (body.completion.kind === "break" && loopCompletionMatches(body.completion, label)) outputs.push(normalCopy(body));
            else if (body.completion.kind === "normal") next.push(body);
            else if (body.completion.kind === "continue" && loopCompletionMatches(body.completion, label)) next.push(normalCopy(body));
            else outputs.push(body);
          }
        }
      }
      active = dedupeStates(next, context);
      if (active.length === 0) break;
    }
    outputs.push(...active);
  }
  if (unknownLength.length > 0) outputs.push(...iterate(unknownLength, 0));
  return dedupeStates(outputs, context);
}

function executeDo(node: ts.DoStatement, state: FlowState, context: FlowContext, label?: string): FlowState[] {
  const iterate = (active: FlowState[], iteration: number): FlowState[] => {
    const outputs: FlowState[] = [];
    const repeat: FlowState[] = [];
    for (const current of active) {
      for (const body of executeStatement(node.statement, current, context)) {
        if (body.completion.kind === "break" && loopCompletionMatches(body.completion, label)) {
          outputs.push(normalCopy(body));
          continue;
        }
        if (body.completion.kind !== "normal" && !(body.completion.kind === "continue" && loopCompletionMatches(body.completion, label))) {
          outputs.push(body);
          continue;
        }
        const continuing = body.completion.kind === "continue" ? normalCopy(body) : body;
        for (const condition of evaluateExpression(node.expression, continuing, context)) {
          const truth = truthOf(condition.value);
          if (truth !== true) outputs.push(truth === undefined ? cloneState(condition.state) : condition.state);
          if (truth !== false && iteration < MAX_LOOP_ITERATIONS) repeat.push(truth === undefined ? cloneState(condition.state) : condition.state);
        }
      }
    }
    if (repeat.length > 0) outputs.push(...iterate(dedupeStates(repeat, context), iteration + 1));
    return dedupeStates(outputs, context);
  };
  return iterate([state], 0);
}

function staticCaseValue(expression: ts.Expression): AbstractValue {
  const node = unwrapExpression(expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return NULL_VALUE;
  if (ts.isNumericLiteral(node)) return { kind: "number", value: Number(node.text) };
  if (ts.isBigIntLiteral(node)) return { kind: "bigint", zero: /^0+n$/i.test(node.text) };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "string", value: node.text };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = staticCaseValue(node.operand);
    if (operand.kind === "number") return { kind: "number", value: -operand.value };
  }
  return UNKNOWN_VALUE;
}

function executeSwitch(node: ts.SwitchStatement, state: FlowState, context: FlowContext, label?: string): FlowState[] {
  const results: FlowState[] = [];
  for (const discriminant of evaluateExpression(node.expression, state, context)) {
    const clauses = node.caseBlock.clauses;
    const starts = new Set<number>();
    let defaultIndex: number | undefined;
    let certainMatch = false;
    for (let index = 0; index < clauses.length; index += 1) {
      const clause = clauses[index]!;
      if (ts.isDefaultClause(clause)) {
        defaultIndex = index;
        continue;
      }
      const equal = samePrimitive(discriminant.value, staticCaseValue(clause.expression));
      if (equal === true) {
        starts.add(index);
        certainMatch = true;
        break;
      }
      if (equal === undefined) starts.add(index);
    }
    if (!certainMatch) {
      if (defaultIndex !== undefined) starts.add(defaultIndex);
      else results.push(cloneState(discriminant.state));
    }
    for (const start of starts) {
      let falling = [cloneState(discriminant.state)];
      const exited: FlowState[] = [];
      for (let index = start; index < clauses.length && falling.length > 0; index += 1) {
        const executed = executeStatements(clauses[index]!.statements, falling, context);
        falling = [];
        for (const current of executed) {
          if (current.completion.kind === "break" && loopCompletionMatches(current.completion, label)) exited.push(normalCopy(current));
          else if (current.completion.kind === "normal") falling.push(current);
          else exited.push(current);
        }
      }
      results.push(...exited, ...falling);
    }
  }
  return dedupeStates(results, context);
}

function executeTry(node: ts.TryStatement, state: FlowState, context: FlowContext): FlowState[] {
  const attempted = executeStatement(node.tryBlock, state, context);
  const caught: FlowState[] = [];
  for (const current of attempted) {
    if (current.completion.kind !== "throw" || !node.catchClause) {
      caught.push(current);
      continue;
    }
    let catchStart = normalCopy(current);
    const variable = node.catchClause.variableDeclaration?.name;
    if (variable && ts.isIdentifier(variable)) catchStart = setBinding(variable, UNKNOWN_VALUE, catchStart, context);
    caught.push(...executeStatement(node.catchClause.block, catchStart, context));
  }
  if (!node.finallyBlock) return caught;
  const finalized: FlowState[] = [];
  for (const current of caught) {
    const incoming = current.completion;
    for (const result of executeStatement(node.finallyBlock, normalCopy(current), context)) {
      if (result.completion.kind === "normal") {
        const restored = cloneState(result);
        restored.completion = incoming;
        finalized.push(restored);
      } else {
        finalized.push(result);
      }
    }
  }
  return dedupeStates(finalized, context);
}

function executeStatement(node: ts.Statement, state: FlowState, context: FlowContext, label?: string): FlowState[] {
  if (ts.isBlock(node)) return executeStatements(node.statements, [state], context);
  if (ts.isVariableStatement(node)) return executeVariableDeclarations(node.declarationList, state, context);
  if (ts.isExpressionStatement(node)) return evaluateExpression(node.expression, state, context).map((result) => result.state);
  if (ts.isReturnStatement(node)) {
    const values = node.expression ? evaluateExpression(node.expression, state, context) : [{ state, value: UNDEFINED_VALUE }];
    return values.map((result) => {
      const next = cloneState(result.state);
      next.completion = { kind: "return", value: result.value };
      return next;
    });
  }
  if (ts.isThrowStatement(node)) {
    const values = evaluateExpression(node.expression, state, context);
    return values.map((result) => {
      const next = cloneState(result.state);
      next.completion = { kind: "throw" };
      return next;
    });
  }
  if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
    const next = cloneState(state);
    next.completion = {
      kind: ts.isBreakStatement(node) ? "break" : "continue",
      ...(node.label === undefined ? {} : { label: node.label.text }),
    };
    return [next];
  }
  if (ts.isIfStatement(node)) {
    const results: FlowState[] = [];
    for (const condition of evaluateExpression(node.expression, state, context)) {
      const truth = truthOf(condition.value);
      if (truth !== false) {
        const thenStart = truth === undefined ? refineCondition(node.expression, cloneState(condition.state), true, context) : condition.state;
        results.push(...executeStatement(node.thenStatement, thenStart, context));
      }
      if (truth !== true) {
        const elseStart = truth === undefined ? refineCondition(node.expression, cloneState(condition.state), false, context) : condition.state;
        results.push(...(node.elseStatement ? executeStatement(node.elseStatement, elseStart, context) : [elseStart]));
      }
    }
    return dedupeStates(results, context);
  }
  if (ts.isSwitchStatement(node)) return executeSwitch(node, state, context, label);
  if (ts.isWhileStatement(node)) return executeWhile(node, state, context, label);
  if (ts.isDoStatement(node)) return executeDo(node, state, context, label);
  if (ts.isForStatement(node)) return executeFor(node, state, context, label);
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return executeForEach(node, state, context, label);
  if (ts.isTryStatement(node)) return executeTry(node, state, context);
  if (ts.isLabeledStatement(node)) {
    const executed = executeStatement(node.statement, state, context, node.label.text);
    return executed.map((current) => current.completion.kind === "break" && current.completion.label === node.label.text ? normalCopy(current) : current);
  }
  if (ts.isExportAssignment(node)) return evaluateExpression(node.expression, state, context).map((result) => result.state);
  if (
    ts.isFunctionDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isEmptyStatement(node)
    || ts.isDebuggerStatement(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node)
    || ts.isModuleDeclaration(node)
  ) return [state];
  return [state];
}

function executeFunction(
  target: Extract<AbstractValue, { kind: "function" }>,
  argumentsList: AbstractValue[] | undefined,
  context: FlowContext,
): FlowState[] {
  let states: FlowState[] = [{
    env: new Map(target.closure ?? []),
    completion: NORMAL_COMPLETION,
    objectNames: new Map(),
  }];
  for (let index = 0; index < target.node.parameters.length; index += 1) {
    const parameter = target.node.parameters[index]!;
    if (!ts.isIdentifier(parameter.name)) continue;
    const symbol = context.parsed.checker.getSymbolAtLocation(parameter.name);
    if (!symbol) continue;
    const values = argumentsList === undefined
      ? parameter.questionToken || parameter.initializer
        ? [UNKNOWN_VALUE, UNDEFINED_VALUE]
        : [UNKNOWN_VALUE]
      : [argumentsList[index] ?? UNDEFINED_VALUE];
    states = states.flatMap((state) => values.map((value) => {
      const next = cloneState(state);
      next.env.set(symbol, value);
      return next;
    }));
  }
  const body = target.node.body;
  if (!body) return states;
  if (ts.isBlock(body)) return executeStatements(body.statements, states, context);
  return states.flatMap((state) => evaluateExpression(body, state, context).map((result) => {
    const returned = cloneState(result.state);
    returned.completion = { kind: "return", value: result.value };
    return returned;
  }));
}

function manifestV2Exported(source: ts.SourceFile, version: number): boolean {
  let directZodBindings = 0;
  let competingZBinding = false;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const module = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      if (statement.importClause.name?.text === "z") competingZBinding = true;
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === "z") competingZBinding = true;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.name.text !== "z") continue;
          const directRuntimeZod = module === "zod"
            && !statement.importClause.isTypeOnly
            && !element.isTypeOnly
            && (element.propertyName?.text ?? element.name.text) === "z";
          if (directRuntimeZod) directZodBindings += 1;
          else competingZBinding = true;
        }
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.declarations.some(({ name }) => ts.isIdentifier(name) && name.text === "z")) competingZBinding = true;
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isModuleDeclaration(statement))
      && statement.name?.text === "z"
    ) competingZBinding = true;
    if (ts.isImportEqualsDeclaration(statement) && statement.name.text === "z") competingZBinding = true;
  }
  if (directZodBindings !== 1 || competingZBinding) return false;
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

function officialDonorIsExecutable(parsed: ParsedCapabilitySource, donor: string): boolean {
  const outputCandidates = parsed.source.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "outputName" && statement.body !== undefined
  );
  if (outputCandidates.length !== 1) return false;
  const outputName = outputCandidates[0]!;
  if (outputName.parameters.length !== 1 || !ts.isIdentifier(outputName.parameters[0]!.name) || outputName.parameters[0]!.name.text !== "imagePath") return false;

  const defaultContext = flowContext(parsed);
  const defaultReturns = executeFunction({ kind: "function", node: outputName }, [UNDEFINED_VALUE], defaultContext);
  const hasDefaultReturn = defaultReturns.some((state) =>
    state.completion.kind === "return"
    && state.completion.value.kind === "string"
    && state.completion.value.value === donor
  );
  if (!hasDefaultReturn) return false;

  const entries = parsed.source.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement)
    && statement.body !== undefined
    && statement.name !== undefined
    && ["buildSlide", "runPipeline"].includes(statement.name.text)
    && exported(statement)
  );
  const context = flowContext(parsed);
  const pending: Array<{ target: Extract<AbstractValue, { kind: "function" }>; arguments?: AbstractValue[] }> = entries.map((node) => ({ target: { kind: "function", node } }));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const invocation = pending.pop()!;
    const key = `${invocation.target.node.pos}:${invocation.arguments?.map(valueSignature).join(",") ?? "entry"}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const callStart = context.calls.length;
    executeFunction(invocation.target, invocation.arguments, context);
    for (const call of context.calls.slice(callStart)) {
      if (call.target.node === outputName) {
        if (call.arguments.length === 0 || (call.arguments.length === 1 && call.arguments[0]!.kind === "undefined")) return true;
        continue;
      }
      pending.push({ target: call.target, arguments: call.arguments });
    }
  }
  return false;
}

function objectNamesAreExported(parsed: ParsedCapabilitySource, names: LoadedContract["dependencies"][1]["capabilities"]["objectNames"]): boolean {
  const candidates = parsed.source.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && exported(statement) && statement.name?.text === "exportPptx" && statement.body !== undefined
  );
  if (candidates.length !== 1) return false;
  const requirements = new Set([
    names.background,
    `\`text-\${element.id}\``,
    `\`shape-\${element.id}-\${element.label}\``,
    `\`asset-\${element.id}\``,
  ]);
  const context = flowContext(parsed, requirements);
  executeFunction({ kind: "function", node: candidates[0]! }, undefined, context);
  return context.objectProof;
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
  const manifestParsed = parsedSource(paths.manifestSchema, manifestSource);
  const donorParsed = parsedSource(paths.officialDonor, donorSource);
  const objectParsed = parsedSource(paths.objectNames, objectSource);
  if (!manifestV2Exported(manifestParsed.source, requirements.capabilities.manifestVersion)) {
    throw new Error("image-to-editable-pptx installed semantic capability evidence does not prove manifest v2");
  }
  if (!officialDonorIsExecutable(donorParsed, requirements.capabilities.officialDonor)) {
    throw new Error("image-to-editable-pptx installed semantic capability evidence does not prove the official donor");
  }
  if (!objectNamesAreExported(objectParsed, requirements.capabilities.objectNames)) {
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
