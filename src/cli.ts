import { preflightDependencies } from "./dependencies/preflight.js";
import { resolveDependencies } from "./dependencies/resolve.js";
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

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command === "preflight") {
    exactFlags(argv.slice(1), []);
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

  throw new Error(`unknown command: ${command ?? ""}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
