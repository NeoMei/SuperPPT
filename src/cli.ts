import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { preflightDependencies } from "./dependencies/preflight.js";
import { resolveDependencies } from "./dependencies/resolve.js";
import {
  assembleProject,
  readProjectAcceptance,
  recordClientAcceptance,
} from "./deck/assemble.js";
import {
  describeProjectGeneration,
  generateProject,
  recordManualQa,
  retryProjectPage,
} from "./generation/batch.js";
import { approveGate, type PlanningGate } from "./planning/confirm.js";
import { normalizeInput, type InputRequest } from "./planning/intake.js";
import { publishPlanViews, publishStyleSample } from "./planning/views.js";
import { initializeProject } from "./project/initialize.js";
import { readRegularFileNoFollow } from "./project/safe-file.js";
import { readProject } from "./project/store.js";
import {
  applyRevision,
  approveImpact,
  publishImpactPlan,
  recoverRollbackTransaction,
  rollbackToRevision,
} from "./revisions/apply.js";
import {
  ChangeRequestSchema,
  readPendingImpactEvidence,
} from "./revisions/impact.js";

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

async function configuredDependencies() {
  const aiRoot = process.env.SUPERPPT_AI_IMAGE_TO_PPT_SOURCE;
  const editableRoot = process.env.SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE;
  if (!aiRoot || !editableRoot) {
    throw new Error("both dependency source overrides are required by the initial CLI");
  }
  return resolveDependencies({ aiRoot, editableRoot });
}

async function providerRunner(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL("../scripts/run_ai_image_provider.py", import.meta.url)),
    fileURLToPath(new URL("../../scripts/run_ai_image_provider.py", import.meta.url)),
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try compiled layout */ }
  }
  throw new Error("provider bridge is missing");
}

function concurrency(value: string): number {
  if (!/^[1-8]$/.test(value)) throw new Error("concurrency must be between 1 and 8");
  return Number(value);
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command === "preflight") {
    const report = await preflightDependencies(
      await configuredDependencies(),
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

  if (command === "recover-rollback") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson({
      recovered: await recoverRollbackTransaction(options.get("--project")!),
    });
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

  if (command === "publish-style-sample") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson(await publishStyleSample(options.get("--project")!));
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

  if (command === "impact") {
    const options = exactFlags(argv.slice(1), ["--project", "--change"]);
    const changePath = options.get("--change")!;
    let change: unknown;
    try {
      change = JSON.parse((await readRegularFileNoFollow(changePath)).toString("utf8"));
    } catch (error: unknown) {
      throw new Error("impact change file is invalid", { cause: error });
    }
    outputJson(await publishImpactPlan(
      options.get("--project")!,
      ChangeRequestSchema.parse(change),
    ));
    return;
  }

  if (command === "approve-impact") {
    const options = exactFlags(argv.slice(1), ["--project", "--sha256"]);
    const sha256 = options.get("--sha256")!;
    await approveImpact(options.get("--project")!, sha256);
    outputJson({ sha256, approved: true });
    return;
  }

  if (command === "apply-impact") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    const root = options.get("--project")!;
    const { plan } = await readPendingImpactEvidence(root);
    await applyRevision(root, plan, plan.change);
    outputJson({ sha256: plan.sha256, applied: true });
    return;
  }

  if (command === "rollback") {
    const options = exactFlags(argv.slice(1), ["--project", "--revision"]);
    const revisionId = options.get("--revision")!;
    await rollbackToRevision(options.get("--project")!, revisionId);
    outputJson({ revisionId, rolledBack: true });
    return;
  }

  if (command === "generate") {
    const options = exactFlags(argv.slice(1), ["--project", "--concurrency"]);
    const root = options.get("--project")!;
    const resolved = await configuredDependencies();
    const runner = await providerRunner();
    const plan = await describeProjectGeneration({ root, ai: resolved.ai });
    outputJson({ event: "generation-plan", ...plan });
    outputJson(await generateProject({
      root,
      ai: resolved.ai,
      runner,
      concurrency: concurrency(options.get("--concurrency")!),
    }));
    return;
  }

  if (command === "record-qa") {
    const options = exactFlags(argv.slice(1), ["--project", "--slide", "--input"]);
    const resolved = await configuredDependencies();
    const result = await recordManualQa({
      root: options.get("--project")!,
      slideId: options.get("--slide")!,
      input: options.get("--input")!,
      ai: resolved.ai,
    });
    outputJson(result);
    return;
  }

  if (command === "retry-page") {
    const options = exactFlags(argv.slice(1), ["--project", "--slide"]);
    const root = options.get("--project")!;
    const slideId = options.get("--slide")!;
    const resolved = await configuredDependencies();
    const runner = await providerRunner();
    const plan = await describeProjectGeneration({ root, ai: resolved.ai, selectedIds: new Set([slideId]) });
    outputJson({ event: "generation-plan", ...plan });
    outputJson(await retryProjectPage({ root, slideId, ai: resolved.ai, runner }));
    return;
  }

  if (command === "assemble") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    const resolved = await configuredDependencies();
    outputJson(await assembleProject({
      root: options.get("--project")!,
      providerId: resolved.ai.defaultProvider,
    }));
    return;
  }

  if (command === "acceptance") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson(await readProjectAcceptance(options.get("--project")!));
    return;
  }

  if (command === "acceptance-record") {
    const options = exactFlags(argv.slice(1), ["--project", "--input"]);
    outputJson(await recordClientAcceptance(
      options.get("--project")!,
      options.get("--input")!,
    ));
    return;
  }

  throw new Error(`unknown command: ${command ?? ""}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
