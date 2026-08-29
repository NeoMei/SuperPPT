import { resolve } from "node:path";

import { preflightDependencies } from "./dependencies/preflight.js";
import { resolveAiImageSkillDependency, resolveSkillDependencies } from "./dependencies/resolve.js";
import {
  applyEditableReplacement,
  assembleProjectCandidate,
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
import { confirmEditablePreview, renderProjectEditablePreview } from "./editable/render.js";
import { EditPlanSchema, type EditPlan } from "./editable/schemas.js";
import { approveExecutionGate, approveGate, type PlanningGate } from "./planning/confirm.js";
import { normalizeInput, type InputRequest } from "./planning/intake.js";
import { publishOutlineViews, publishPlanViews, publishStyleSample } from "./planning/views.js";
import { initializeProject } from "./project/initialize.js";
import { readRegularFileNoFollow } from "./project/safe-file.js";
import { readProject } from "./project/store.js";
import { readCliJsonInput } from "./cli-input.js";
import { applyDeckReviewAction, publishDeckReview } from "./project/promotion.js";
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

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command === "preflight") {
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
    const options = exactFlags(argv.slice(1), ["--project", "--ai-skill"]);
    const plan = await publishStyleSampleGenerationPlan(options.get("--project")!, {
      aiDependency: await resolveAiImageSkillDependency(options.get("--ai-skill")!),
      callBudget: 1,
    });
    outputJson({ plan, nextRequiredAction: "ask the user to approve style-sample-generation" });
    return;
  }

  if (command === "prepare-style-sample-job") {
    const options = exactFlags(argv.slice(1), ["--project", "--ai-skill"]);
    const job = await prepareStyleSampleJob(
      options.get("--project")!,
      await resolveAiImageSkillDependency(options.get("--ai-skill")!),
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
      throw new Error("deck-review approval requires deck-review-action --action confirm-delivery");
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
    const options = exactFlags(argv.slice(1), ["--project", "--ai-skill", "--call-budget"]);
    const plan = await publishGenerationAuthorizationPlan(options.get("--project")!, {
      aiDependency: await resolveAiImageSkillDependency(options.get("--ai-skill")!),
      callBudget: integerFlag(options.get("--call-budget")!, "call budget", 1),
    });
    outputJson({ plan, nextRequiredAction: "ask the user to approve generation-authorization" });
    return;
  }

  if (command === "prepare-deck-job") {
    const options = exactFlags(argv.slice(1), ["--project", "--ai-skill"]);
    const job = await prepareDeckJob(
      options.get("--project")!,
      await resolveAiImageSkillDependency(options.get("--ai-skill")!),
    );
    outputJson({ job, nextRequiredAction: "invoke ai-image-to-ppt serially as the Agent; admit each exact call first" });
    return;
  }

  if (command === "admit-image-call") {
    const options = exactFlags(argv.slice(1), ["--project", "--job", "--slide", "--attempt", "--request-ordinal"]);
    const root = options.get("--project")!;
    const job = await verifiedJob(root, options.get("--job")!);
    const slideId = options.get("--slide")!;
    const attempt = integerFlag(options.get("--attempt")!, "attempt", 1);
    const requestOrdinal = integerFlag(options.get("--request-ordinal")!, "request ordinal", 0);
    if (!job.pages.some((page) => page.slideId === slideId && page.attempt === attempt)) {
      throw new Error("admission tuple does not name a page in the immutable job");
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
    const options = exactFlags(argv.slice(1), ["--project", "--request"]);
    const job = await preparePageRegenerationJob(
      options.get("--project")!,
      await readCliJsonInput(
        options.get("--request")!,
        "page-regeneration request",
        PageRegenerationRequestSchema,
        { privateInput: true },
      ),
    );
    outputJson({ job, nextRequiredAction: "publish and approve a new incremental generation authorization when required" });
    return;
  }

  if (command === "generation-status") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    const status = await describeProjectGeneration(options.get("--project")!);
    outputJson({ ...status, nextRequiredAction: status.currentJob ? "continue the exact current serial job" : "review the completed pages before candidate assembly" });
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

  if (command === "convert-page") {
    const options = exactFlags(argv.slice(1), ["--project", "--slide", "--ai-skill", "--editable-skill"]);
    const resolved = await resolveSkillDependencies({
      aiSkillRoot: options.get("--ai-skill")!,
      editableSkillRoot: options.get("--editable-skill")!,
    });
    const result = await convertProjectPage({
      root: options.get("--project")!,
      slideId: options.get("--slide")!,
      converterRoot: resolved.editable.root,
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

  if (command === "render-editable") {
    const options = exactFlags(argv.slice(1), ["--project", "--slide", "--revision", "--record-sha256"]);
    outputJson(await renderProjectEditablePreview({
      root: options.get("--project")!,
      slideId: options.get("--slide")!,
      modifiedRevisionId: options.get("--revision")!,
      expectedModifiedRevisionRecordSha256: options.get("--record-sha256")!,
    }));
    return;
  }

  if (command === "confirm-preview") {
    const options = selectedFlags(
      argv.slice(1),
      ["--project", "--slide", "--revision", "--record-sha256", "--render"],
      ["--project", "--slide", "--revision", "--record-sha256", "--render", "--decision"],
    );
    const decision = options.get("--decision") ?? "approved";
    if (decision !== "approved" && decision !== "rejected") throw new Error("preview decision must be approved or rejected");
    const result = await confirmEditablePreview({
      root: options.get("--project")!,
      slideId: options.get("--slide")!,
      modifiedRevisionId: options.get("--revision")!,
      expectedModifiedRevisionRecordSha256: options.get("--record-sha256")!,
      preview: options.get("--render")!,
      approved: decision === "approved",
    });
    outputJson(result ? { approved: true, ...result } : { approved: false });
    return;
  }

  if (command === "replace-slide") {
    const options = exactFlags(argv.slice(1), ["--project", "--slide", "--revision", "--record-sha256"]);
    outputJson({
      ...await applyEditableReplacement({
      root: options.get("--project")!,
      slideId: options.get("--slide")!,
      modifiedRevisionId: options.get("--revision")!,
      expectedModifiedRevisionRecordSha256: options.get("--record-sha256")!,
      }),
      nextRequiredAction: "assemble and review a new candidate before delivery",
    });
    return;
  }

  if (command === "assemble-candidate") {
    const options = exactFlags(argv.slice(1), ["--project"]);
    const candidate = await assembleProjectCandidate(options.get("--project")!);
    outputJson({ ...candidate, nextRequiredAction: "publish this exact candidate for deck review" });
    return;
  }

  if (command === "publish-deck-review") {
    const options = exactFlags(argv.slice(1), ["--project", "--candidate-id"]);
    const review = await publishDeckReview(options.get("--project")!, options.get("--candidate-id")!);
    outputJson({ review, nextRequiredAction: "ask the user to choose edit-page, return-upstream, or confirm-delivery" });
    return;
  }

  if (command === "deck-review-action") {
    const parsed = flags(argv.slice(1));
    for (const key of parsed.keys()) {
      if (!["--project", "--candidate-id", "--descriptor-sha256", "--action", "--slide-id"].includes(key)) {
        throw new Error(`unknown CLI flag: ${key}`);
      }
    }
    for (const key of ["--project", "--candidate-id", "--descriptor-sha256", "--action"]) {
      if (!parsed.has(key)) throw new Error("required CLI flags: --project --candidate-id --descriptor-sha256 --action");
    }
    const action = parsed.get("--action")!;
    if (action === "edit-page" && !parsed.has("--slide-id")) throw new Error("edit-page requires exactly one --slide-id");
    if (action !== "edit-page" && parsed.has("--slide-id")) throw new Error("only edit-page accepts --slide-id");
    const outcome = await applyDeckReviewAction(parsed.get("--project")!, {
      action,
      candidateId: parsed.get("--candidate-id")!,
      descriptorSha256: parsed.get("--descriptor-sha256")!,
      ...(action === "edit-page" ? { slideId: parsed.get("--slide-id")! } : {}),
    } as Parameters<typeof applyDeckReviewAction>[1]);
    outputJson({
      ...outcome,
      nextRequiredAction: action === "confirm-delivery"
        ? "create a controlled smoke copy; temporarily edit the selected object, observe the edit, undo it, discard/do not save, close, reopen, verify the original content, then submit authenticated acceptance-record evidence"
        : action === "edit-page"
          ? "convert only the selected page, confirm its preview, then assemble a new candidate"
          : "revise the upstream generation inputs with the user",
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
