import { preflightDependencies } from "./dependencies/preflight.js";
import { resolveDependencies } from "./dependencies/resolve.js";
import { approveGate, type PlanningGate } from "./planning/confirm.js";
import { normalizeInput, type InputRequest } from "./planning/intake.js";
import { publishPlanViews } from "./planning/views.js";
import { initializeProject } from "./project/initialize.js";
import { readProject } from "./project/store.js";

function flags(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error("invalid or duplicate CLI flag");
    }
    result.set(key, value);
  }
  return result;
}

function exactFlags(argv: string[], expected: string[]): Map<string, string> {
  const parsed = flags(argv);
  for (const key of parsed.keys()) {
    if (!expected.includes(key)) {
      throw new Error(`unknown CLI flag: ${key}`);
    }
  }
  if (expected.some((key) => !parsed.has(key))) {
    throw new Error(`required CLI flags: ${expected.join(" ")}`);
  }
  return parsed;
}

function selectedFlags(
  argv: string[],
  required: string[],
  allowed: string[],
): Map<string, string> {
  const parsed = flags(argv);
  for (const key of parsed.keys()) {
    if (!allowed.includes(key)) throw new Error(`unknown CLI flag: ${key}`);
  }
  if (required.some((key) => !parsed.has(key))) {
    throw new Error(`required CLI flags: ${required.join(" ")}`);
  }
  return parsed;
}

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function inputRequest(options: Map<string, string>): InputRequest {
  const inputs = ["--description", "--text", "--markdown"]
    .filter((key) => options.has(key));
  if (inputs.length !== 1) throw new Error("ingest requires exactly one input flag");
  const key = inputs[0]!;
  if (key === "--markdown") {
    return { kind: "markdown", path: options.get(key)! };
  }
  return {
    kind: key === "--description" ? "description" : "text",
    value: options.get(key)!,
  };
}

function planningGate(value: string): PlanningGate {
  if (value === "outline" || value === "slide-specs" || value === "style-sample") {
    return value;
  }
  throw new Error(`invalid planning gate: ${value}`);
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command === "preflight") {
    const aiRoot = process.env.SUPERPPT_AI_IMAGE_TO_PPT_SOURCE;
    const editableRoot = process.env.SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE;
    if (!aiRoot || !editableRoot) {
      throw new Error("both dependency source overrides are required by the initial CLI");
    }
    const report = await preflightDependencies(
      await resolveDependencies({ aiRoot, editableRoot }),
    );
    outputJson(report);
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "init") {
    const options = exactFlags(argv.slice(1), ["--project", "--title"]);
    outputJson(await initializeProject({
      root: options.get("--project")!,
      title: options.get("--title")!,
    }));
    return;
  }

  if (command === "status") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson(await readProject(options.get("--project")!));
    return;
  }

  if (command === "ingest") {
    const options = selectedFlags(
      argv.slice(1),
      ["--project"],
      ["--project", "--description", "--text", "--markdown"],
    );
    outputJson({
      source: await normalizeInput(
        options.get("--project")!,
        inputRequest(options),
      ),
    });
    return;
  }

  if (command === "validate-plan") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson(await publishPlanViews(options.get("--project")!));
    return;
  }

  if (command === "approve") {
    const options = exactFlags(argv.slice(1), ["--project", "--gate"]);
    const root = options.get("--project")!;
    await readProject(root);
    const gate = planningGate(options.get("--gate")!);
    await approveGate(root, gate);
    outputJson({ gate, current: true });
    return;
  }

  throw new Error(`unknown command: ${command ?? ""}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
