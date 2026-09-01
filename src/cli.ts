import { resolve } from "node:path";

import { attestWorkflowDependencies, preflightDependencies } from "./dependencies/preflight.js";
import { resolveSkillDependencies } from "./dependencies/resolve.js";
import {
  readProjectAcceptance,
  recordClientAcceptance,
} from "./deck/assemble.js";
import { createClientSmokeCopy } from "./acceptance/smoke-copy.js";
import {
  describeProjectGeneration,
  PageRegenerationRequestSchema,
  prepareDeckJob,
  preparePageRegenerationJob,
} from "./generation/batch.js";
import {
  admitDelegatedGenerationCall,
  publishGenerationAuthorizationPlan,
  publishStyleSampleGenerationPlan,
} from "./generation/authorization.js";
import { DelegatedResultIntakeSchema, recordDelegatedResult } from "./generation/delegation-result.js";
import { ImageGenerationJobSchema, canonicalContractFile } from "./generation/job-schemas.js";
import { readImageGenerationJob } from "./generation/jobs.js";
import { SerialStickyReportSchema } from "./generation/schemas.js";
import { finalizeStyleSample, prepareStyleSampleJob } from "./generation/style-sample.js";
import { convertProjectPage } from "./editable/adapter.js";
import {
  AlreadyEditableSlideError,
  applyProjectEditPlan,
  promoteProjectEditableTarget,
  UnsupportedEditableTargetError,
} from "./editable/operations.js";
import { EditPlanSchema, type EditPlan } from "./editable/schemas.js";
import { DeckEditRouteSchema, prepareAgentEditDeck } from "./editable/route.js";
import { approveExecutionGate, approveGate, type PlanningGate } from "./planning/confirm.js";
import { normalizeInput, type InputRequest } from "./planning/intake.js";
import { publishOutlineViews, publishPlanViews, publishStyleSample } from "./planning/views.js";
import { initializeProject } from "./project/initialize.js";
import { readRegularFileNoFollow } from "./project/safe-file.js";
import { readProject } from "./project/store.js";
import { readCliJsonInput } from "./cli-input.js";
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
import {
  adoptManualSavedDeck,
  confirmAgentEditDeck,
  prepareManualEditDeck,
  rejectDeckEdit,
  resolveCurrentDeckPage,
} from "./deck-revisions/workflow.js";
import {
  readCurrentDeckPointer,
  readLocalDeckRevision,
  rollbackCurrentDeck,
} from "./deck-revisions/store.js";
import {
  formatLocalPptxLink,
  readInjectedHostRuntimeCapabilities,
} from "./host/capabilities.js";

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
  if (value === "outline" || value === "slide-specs" || value === "style-sample" || value === "generation-authorization") {
    return value;
  }
  throw new Error(`invalid planning gate: ${value}`);
}

function integerFlag(value: string, label: string, minimum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} must be at least ${minimum}`);
  return parsed;
}

async function verifiedJob(root: string, path: string) {
  let supplied;
  try {
    supplied = await readCliJsonInput(path, "job", ImageGenerationJobSchema);
  } catch (error: unknown) {
    throw new Error("job file is unsafe or invalid", { cause: error });
  }
  const published = await readImageGenerationJob(root, supplied.jobId);
  if (canonicalContractFile(supplied) !== canonicalContractFile(published)) {
    throw new Error("job file does not match the immutable published job");
  }
  const expected = resolve(root, "generation", "jobs", supplied.jobId, "job.json");
  if (resolve(path) !== expected) throw new Error("job file must name the immutable published job");
  return published;
}

async function editPlan(path: string): Promise<EditPlan> {
  return readCliJsonInput(path, "edit plan", EditPlanSchema, { privateInput: true });
}

function editPlanSummary(plan: EditPlan): Record<string, unknown> {
  if (plan.route === "regenerate") return { route: "regenerate" };
  return {
    route: "editable",
    operationCount: plan.operations.length,
    operationKinds: [...new Set(plan.operations.map((operation) => operation.kind))].sort(),
  };
}

function requireInjectedLocalHandoff(): void {
  readInjectedHostRuntimeCapabilities(process.env);
}

async function resolveInjectedWorkflowDependencies(aiSkillRoot: string, editableSkillRoot: string) {
  const host = readInjectedHostRuntimeCapabilities(process.env);
  const resolved = await resolveSkillDependencies({ aiSkillRoot, editableSkillRoot });
  const report = await preflightDependencies(resolved);
  if (!report.ok) throw new Error("full workflow dependency preflight failed");
  return attestWorkflowDependencies(resolved, host);
}

function completeDeckOutput(
  title: string,
  deck: {
    revisionId: string;
    absolutePath: string;
    sha256: string;
    slideCount: number;
    reviewRequiredObjects: unknown[];
    mode?: "manual" | "agent";
    sessionId?: string;
    targetSlideId?: string;
  },
): Record<string, unknown> {
  const linkLabel = `${title}.pptx`;
  return {
    kind: "complete-local-pptx",
    ...(deck.mode ? { mode: deck.mode } : {}),
    revisionId: deck.revisionId,
    ...(deck.sessionId ? { sessionId: deck.sessionId } : {}),
    ...(deck.targetSlideId ? { targetSlideId: deck.targetSlideId } : {}),
    absolutePath: deck.absolutePath,
    linkLabel,
    markdownLink: formatLocalPptxLink(deck.absolutePath, linkLabel),
    sha256: deck.sha256,
    slideCount: deck.slideCount,
    reviewRequiredObjects: deck.reviewRequiredObjects,
    nextRequiredAction: "open this complete PPTX in WPS or PowerPoint",
    ...(deck.mode ? { waitFor: deck.mode === "manual" ? "已保存并关闭" : "确认" } : {}),
  };
}

function currentDeckStateAcknowledgement(currentRevisionId: string, sha256: string): Record<string, unknown> {
  return {
    currentRevisionId,
    sha256,
    nextRequiredAction: "run current-deck-link to present the current complete local PPTX",
  };
}

function revisionReviewObjects(revision: Awaited<ReturnType<typeof readLocalDeckRevision>>) {
  return Object.entries(revision.reviewRequiredObjectsBySlideId)
    .flatMap(([stableSlideId, objects]) => objects.map((object) => ({ stableSlideId, ...object })))
    .sort((left, right) => `${left.stableSlideId}:${left.elementId}`.localeCompare(`${right.stableSlideId}:${right.elementId}`));
}

const REMOVED_COMPLETE_DECK_COMMANDS = new Set([
  "render-editable",
  "confirm-preview",
  "replace-slide",
  "export-review-derived",
  "assemble-candidate",
  "publish-deck-review",
  "deck-review-action",
]);

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command && REMOVED_COMPLETE_DECK_COMMANDS.has(command)) {
    throw new Error(`${command} was removed: use current-deck-link, prepare-manual-deck, or prepare-agent-deck for one complete deck`);
  }

  if (command === "resolve-current-deck-page") {
    const options = exactFlags(argv.slice(1), ["--project", "--page-number"]);
    outputJson(await resolveCurrentDeckPage({
      root: options.get("--project")!,
      pageNumber: integerFlag(options.get("--page-number")!, "page number", 1),
    }));
    return;
  }

  if (command === "current-deck-link") {
    requireInjectedLocalHandoff();
    const options = exactFlags(argv.slice(1), ["--project"]);
    const root = options.get("--project")!;
    const [project, current] = await Promise.all([readProject(root), readCurrentDeckPointer(root)]);
    const revision = await readLocalDeckRevision(root, current.revisionId);
    outputJson(completeDeckOutput(project.title, {
      revisionId: current.revisionId,
      absolutePath: current.absolutePath,
      sha256: current.sha256,
      slideCount: revision.slideTopology.entries.length,
      reviewRequiredObjects: revisionReviewObjects(revision),
    }));
    return;
  }

  if (command === "prepare-manual-deck") {
    requireInjectedLocalHandoff();
    const options = selectedFlags(
      argv.slice(1),
      ["--project", "--revision-id", "--slide-id"],
      ["--project", "--revision-id", "--slide-id", "--conversion-root"],
    );
    const root = options.get("--project")!;
    const project = await readProject(root);
    const prepared = await prepareManualEditDeck({
      root,
      revisionId: options.get("--revision-id")!,
      slideId: options.get("--slide-id")!,
      ...(options.has("--conversion-root") ? { conversionRoot: options.get("--conversion-root")! } : {}),
    });
    outputJson(completeDeckOutput(project.title, prepared));
    return;
  }

  if (command === "adopt-saved-deck") {
    const options = exactFlags(argv.slice(1), ["--project", "--session-id", "--user-signal"]);
    const current = await adoptManualSavedDeck({
      root: options.get("--project")!,
      sessionId: options.get("--session-id")!,
      userSignal: options.get("--user-signal")!,
    });
    outputJson(currentDeckStateAcknowledgement(current.revisionId, current.sha256));
    return;
  }

  if (command === "prepare-agent-deck") {
    requireInjectedLocalHandoff();
    const options = selectedFlags(
      argv.slice(1),
      ["--project", "--route"],
      ["--project", "--route", "--conversion-root", "--generation-job-id"],
    );
    const root = options.get("--project")!;
    const project = await readProject(root);
    const prepared = await prepareAgentEditDeck({
      root,
      route: await readCliJsonInput(options.get("--route")!, "deck edit route", DeckEditRouteSchema, { privateInput: true }),
      ...(options.has("--conversion-root") ? { conversionRoot: options.get("--conversion-root")! } : {}),
      ...(options.has("--generation-job-id") ? { generationJobId: options.get("--generation-job-id")! } : {}),
    });
    outputJson(completeDeckOutput(project.title, prepared));
    return;
  }

  if (command === "confirm-agent-deck") {
    const options = exactFlags(argv.slice(1), ["--project", "--session-id", "--sha256"]);
    const current = await confirmAgentEditDeck({
      root: options.get("--project")!,
      sessionId: options.get("--session-id")!,
      confirmedSha256: options.get("--sha256")!,
    });
    outputJson(currentDeckStateAcknowledgement(current.revisionId, current.sha256));
    return;
  }

  if (command === "reject-deck-candidate") {
    const options = exactFlags(argv.slice(1), ["--project", "--session-id"]);
    await rejectDeckEdit({ root: options.get("--project")!, sessionId: options.get("--session-id")! });
    outputJson({ sessionId: options.get("--session-id")!, rejected: true });
    return;
  }

  if (command === "rollback-deck") {
    const options = exactFlags(argv.slice(1), ["--project", "--revision-id"]);
    const current = await rollbackCurrentDeck(options.get("--project")!, options.get("--revision-id")!);
    outputJson(currentDeckStateAcknowledgement(current.revisionId, current.sha256));
    return;
  }
  if (command === "preflight") {
    requireInjectedLocalHandoff();
    const options = exactFlags(argv.slice(1), ["--ai-skill", "--editable-skill"]);
    const report = await preflightDependencies(await resolveSkillDependencies({
      aiSkillRoot: options.get("--ai-skill")!,
      editableSkillRoot: options.get("--editable-skill")!,
    }));
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

  if (command === "validate-outline") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson(await publishOutlineViews(options.get("--project")!));
    return;
  }

  if (command === "publish-style-sample") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson({
      ...await publishStyleSample(options.get("--project")!),
      nextRequiredAction: "show the published sample and ask the user to approve style-sample",
    });
    return;
  }

  if (command === "publish-sample-generation-plan") {
    const options = exactFlags(argv.slice(1), ["--project", "--ai-skill", "--editable-skill"]);
    const dependencies = await resolveInjectedWorkflowDependencies(options.get("--ai-skill")!, options.get("--editable-skill")!);
    const plan = await publishStyleSampleGenerationPlan(options.get("--project")!, {
      aiDependency: dependencies.ai,
      callBudget: 1,
    });
    outputJson({ plan, nextRequiredAction: "ask the user to approve style-sample-generation" });
    return;
  }

  if (command === "prepare-style-sample-job") {
    const options = exactFlags(argv.slice(1), ["--project", "--ai-skill", "--editable-skill"]);
    const dependencies = await resolveInjectedWorkflowDependencies(options.get("--ai-skill")!, options.get("--editable-skill")!);
    const job = await prepareStyleSampleJob(
      options.get("--project")!,
      dependencies.ai,
    );
    outputJson({ job, nextRequiredAction: "invoke ai-image-to-ppt as the Agent, then admit and record its exact result" });
    return;
  }

  if (command === "finalize-style-sample") {
    const options = exactFlags(argv.slice(1), ["--project", "--job-id"]);
    outputJson({
      ...await finalizeStyleSample(options.get("--project")!, options.get("--job-id")!),
      nextRequiredAction: "publish the finalized style sample for user review",
    });
    return;
  }

  if (command === "approve") {
    const options = exactFlags(argv.slice(1), ["--project", "--gate"]);
    const root = options.get("--project")!;
    await readProject(root);
    const requestedGate = options.get("--gate")!;
    if (requestedGate === "deck-review") {
      throw new Error("generic deck-review approval is unavailable; use current-deck-link and bind the exact complete deck revision and SHA-256");
    }
    if (requestedGate === "style-sample-generation") {
      await approveExecutionGate(root, "style-sample-generation", "style/sample/generation-plan.json");
      outputJson({ gate: requestedGate, current: true, nextRequiredAction: "prepare the style sample job" });
      return;
    }
    const gate = planningGate(requestedGate);
    await approveGate(root, gate);
    const nextRequiredAction = gate === "outline"
      ? "author and validate the slide specifications, then show them to the user"
      : gate === "slide-specs"
        ? "show the compact single-select style choices to the user"
        : gate === "style-sample"
          ? "publish the deck generation authorization plan for user approval"
          : "prepare the immutable deck generation job";
    outputJson({ gate, current: true, nextRequiredAction });
    return;
  }

  if (command === "publish-generation-plan") {
    const options = exactFlags(argv.slice(1), ["--project", "--ai-skill", "--editable-skill", "--call-budget"]);
    const dependencies = await resolveInjectedWorkflowDependencies(options.get("--ai-skill")!, options.get("--editable-skill")!);
    const plan = await publishGenerationAuthorizationPlan(options.get("--project")!, {
      aiDependency: dependencies.ai,
      callBudget: integerFlag(options.get("--call-budget")!, "call budget", 1),
    });
    outputJson({ plan, nextRequiredAction: "ask the user to approve generation-authorization" });
    return;
  }

  if (command === "prepare-deck-job") {
    const options = exactFlags(argv.slice(1), ["--project", "--ai-skill", "--editable-skill"]);
    const dependencies = await resolveInjectedWorkflowDependencies(options.get("--ai-skill")!, options.get("--editable-skill")!);
    const job = await prepareDeckJob(
      options.get("--project")!,
      dependencies.ai,
    );
    outputJson({ job, nextRequiredAction: "invoke ai-image-to-ppt serially as the Agent; admit each exact call first" });
    return;
  }

  if (command === "admit-image-call") {
    const options = exactFlags(argv.slice(1), ["--project", "--job", "--slide", "--attempt", "--request-ordinal", "--ai-skill", "--editable-skill"]);
    const dependencies = await resolveInjectedWorkflowDependencies(options.get("--ai-skill")!, options.get("--editable-skill")!);
    const root = options.get("--project")!;
    const job = await verifiedJob(root, options.get("--job")!);
    const slideId = options.get("--slide")!;
    const attempt = integerFlag(options.get("--attempt")!, "attempt", 1);
    const requestOrdinal = integerFlag(options.get("--request-ordinal")!, "request ordinal", 0);
    if (!job.pages.some((page) => page.slideId === slideId && page.attempt === attempt)) {
      throw new Error("admission tuple does not name a page in the immutable job");
    }
    if (JSON.stringify(job.aiSkill.workflowPreflight) !== JSON.stringify(dependencies.ai.workflowPreflight)) {
      throw new Error("external generation call dependency preflight does not match the immutable job");
    }
    outputJson({
      ...await admitDelegatedGenerationCall(root, { jobId: job.jobId, slideId, attempt, requestOrdinal }),
      nextRequiredAction: "pass this one-time token only in the private result file",
    });
    return;
  }

  if (command === "record-image-result") {
    const options = exactFlags(argv.slice(1), ["--project", "--job", "--result", "--route-report"]);
    const root = options.get("--project")!;
    const job = await verifiedJob(root, options.get("--job")!);
    const resultBase = await readCliJsonInput(
      options.get("--result")!,
      "result",
      DelegatedResultIntakeSchema.omit({ batchReport: true }),
      { privateInput: true },
    );
    const batchReport = await readCliJsonInput(
      options.get("--route-report")!,
      "route report",
      SerialStickyReportSchema,
      { privateInput: true },
    );
    if (resultBase.jobId !== job.jobId) throw new Error("result does not bind the supplied immutable job");
    const result = await recordDelegatedResult(root, { ...resultBase, batchReport });
    outputJson({ result, nextRequiredAction: "review generation status and request the next staged user action" });
    return;
  }

  if (command === "prepare-page-regeneration-job") {
    const options = exactFlags(argv.slice(1), ["--project", "--request", "--ai-skill", "--editable-skill"]);
    const dependencies = await resolveInjectedWorkflowDependencies(options.get("--ai-skill")!, options.get("--editable-skill")!);
    const job = await preparePageRegenerationJob(
      options.get("--project")!,
      await readCliJsonInput(
        options.get("--request")!,
        "page-regeneration request",
        PageRegenerationRequestSchema,
        { privateInput: true },
      ),
      dependencies.ai,
    );
    outputJson({ job, nextRequiredAction: "publish and approve a new incremental generation authorization when required" });
    return;
  }

  if (command === "generation-status") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    const status = await describeProjectGeneration(options.get("--project")!);
    outputJson({ ...status, nextRequiredAction: status.currentJob ? "continue the exact current serial job" : "use current-deck-link for the complete local PPTX" });
    return;
  }

  if (command === "impact") {
    const options = exactFlags(argv.slice(1), ["--project", "--change"]);
    const changePath = options.get("--change")!;
    outputJson(await publishImpactPlan(
      options.get("--project")!,
      await readCliJsonInput(changePath, "impact change", ChangeRequestSchema),
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
    outputJson({ sha256: plan.sha256, applied: true, restartStage: plan.restartStage });
    return;
  }

  if (command === "rollback") {
    const options = exactFlags(argv.slice(1), ["--project", "--revision"]);
    const revisionId = options.get("--revision")!;
    await rollbackToRevision(options.get("--project")!, revisionId);
    outputJson({ revisionId, rolledBack: true });
    return;
  }

  if (command === "convert-page") {
    const options = exactFlags(argv.slice(1), ["--project", "--slide", "--ai-skill", "--editable-skill"]);
    const resolved = await resolveInjectedWorkflowDependencies(options.get("--ai-skill")!, options.get("--editable-skill")!);
    const result = await convertProjectPage({
      root: options.get("--project")!,
      slideId: options.get("--slide")!,
      dependencies: resolved,
    });
    outputJson({
      route: "editable",
      slideId: options.get("--slide")!,
      revisionId: result.revisionId,
      revisionRoot: result.revisionRoot,
      sourcePng: result.sourcePng,
      manifestPath: result.manifestPath,
      ledgerPath: result.ledgerPath,
      cleanBackground: result.cleanBackground,
      artifactHashes: result.artifactHashes,
    });
    return;
  }

  if (command === "plan-edit") {
    const options = exactFlags(argv.slice(1), ["--input"]);
    outputJson(editPlanSummary(await editPlan(options.get("--input")!)));
    return;
  }

  if (command === "apply-edit") {
    const options = exactFlags(argv.slice(1), ["--project", "--slide", "--revision", "--input"]);
    const result = await applyProjectEditPlan({
      root: options.get("--project")!,
      slideId: options.get("--slide")!,
      sourceRevisionId: options.get("--revision")!,
      rawPlan: await editPlan(options.get("--input")!),
    });
    outputJson({
      route: "editable",
      slideId: options.get("--slide")!,
      revisionId: result.revisionId,
      revisionRoot: result.revisionRoot,
      modifiedManifestPath: result.modifiedManifestPath,
      modifiedRevisionRecordSha256: (await import("node:crypto")).createHash("sha256").update(
        await readRegularFileNoFollow(`${result.revisionRoot}/modified-revision-record.json`),
      ).digest("hex"),
    });
    return;
  }

  if (command === "promote-editable") {
    const options = exactFlags(argv.slice(1), ["--project", "--slide", "--revision", "--element", "--kind"]);
    const expectedKind = options.get("--kind")!;
    if (expectedKind !== "text" && expectedKind !== "asset") {
      throw new Error("promote-editable kind must be text or asset");
    }
    let result;
    try {
      result = await promoteProjectEditableTarget({
        root: options.get("--project")!,
        slideId: options.get("--slide")!,
        sourceRevisionId: options.get("--revision")!,
        elementId: options.get("--element")!,
        expectedKind,
      });
    } catch (error: unknown) {
      if (error instanceof AlreadyEditableSlideError) {
        process.stdout.write('{"route":"editable","status":"already-editable"}\n');
        return;
      }
      if (error instanceof UnsupportedEditableTargetError) {
        process.stdout.write('{"route":"regenerate"}\n');
        return;
      }
      throw error;
    }
    outputJson({
      route: "editable",
      slideId: options.get("--slide")!,
      revisionId: result.revisionId,
      revisionRoot: result.revisionRoot,
      modifiedManifestPath: result.modifiedManifestPath,
      modifiedRevisionRecordSha256: (await import("node:crypto")).createHash("sha256").update(
        await readRegularFileNoFollow(`${result.revisionRoot}/modified-revision-record.json`),
      ).digest("hex"),
    });
    return;
  }


  if (command === "acceptance") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson(await readProjectAcceptance(options.get("--project")!));
    return;
  }

  if (command === "acceptance-smoke-copy") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    outputJson(await createClientSmokeCopy(options.get("--project")!));
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
