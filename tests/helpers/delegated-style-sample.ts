import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "sharp";

import type { AiImageSkillDependency } from "../../src/dependencies/schemas.js";
import { admitDelegatedGenerationCall, publishStyleSampleGenerationPlan } from "../../src/generation/authorization.js";
import { recordDelegatedResult } from "../../src/generation/delegation-result.js";
import { finalizeStyleSample, prepareStyleSampleJob } from "../../src/generation/style-sample.js";
import { approveExecutionGate, approveGate } from "../../src/planning/confirm.js";
import { publishStyleSample } from "../../src/planning/views.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function testAiDependency(root: string): Promise<AiImageSkillDependency> {
  const aiRoot = join(dirname(root), "delegated-style-sample-agent");
  const scriptsRoot = join(aiRoot, "scripts");
  await mkdir(scriptsRoot, { recursive: true });
  const skillFile = join(aiRoot, "SKILL.md");
  await writeFile(skillFile, "---\nname: ai-image-to-ppt\n---\n");
  const scripts = {
    generationResult: join(scriptsRoot, "generation_result.py"),
    hostRoutingPolicy: join(scriptsRoot, "host_routing_policy.py"),
    importHostImage: join(scriptsRoot, "import_host_image.py"),
    prepareEditableInput: join(scriptsRoot, "prepare_editable_input.py"),
  };
  await Promise.all(Object.values(scripts).map((path) => writeFile(path, "raise SystemExit('test fake is never executed')\n")));
  const [skill, generationResult, hostRoutingPolicy, importHostImage, prepareEditableInput] = await Promise.all([
    skillFile,
    scripts.generationResult,
    scripts.hostRoutingPolicy,
    scripts.importHostImage,
    scripts.prepareEditableInput,
  ].map(async (path) => ({ bytes: await readFile(path) })));
  return {
    kind: "ai-image-to-ppt",
    root: aiRoot,
    skillFile,
    skillSha256: sha256(skill.bytes),
    gitRevision: null,
    scripts,
    scriptSha256: {
      generationResult: sha256(generationResult.bytes),
      hostRoutingPolicy: sha256(hostRoutingPolicy.bytes),
      importHostImage: sha256(importHostImage.bytes),
      prepareEditableInput: sha256(prepareEditableInput.bytes),
    },
  };
}

/** Creates authenticated sample evidence as if the external Agent had completed its one admitted call. */
export async function finalizeDelegatedStyleSampleForTest(root: string): Promise<void> {
  const aiDependency = await testAiDependency(root);
  await publishStyleSampleGenerationPlan(root, { aiDependency, callBudget: 1 });
  await approveExecutionGate(root, "style-sample-generation", "style/sample/generation-plan.json");
  const job = await prepareStyleSampleJob(root, aiDependency);
  const page = job.pages[0]!;
  const output = join(root, ...page.target.split("/"));
  await mkdir(dirname(output), { recursive: true });
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#102030" } }).png().toFile(output);
  const admission = await admitDelegatedGenerationCall(root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
  });
  await recordDelegatedResult(root, {
    jobId: job.jobId,
    slideId: page.slideId,
    attempt: page.attempt,
    requestOrdinal: 1,
    admissionToken: admission.admissionToken,
    dependency: { status: "success", provider: "openai", channel: "api", output_path: output, safe_message: "" },
    batchReport: {
      batch_mode: "serial-sticky-monotonic",
      stopped: false,
      search_candidate: "api-openai",
      sticky_candidate: "api-openai",
      pages: [{ page: 1, outcome: "success", candidate: "api-openai", summary: "" }],
      switches: [],
    },
    actualPromptSha256: page.promptSha256,
    styleLockSha256: job.styleLockSha256,
    styleRecipeSha256: job.styleLock.styleRecipeSha256,
    referenceUsage: job.styleLock.referenceArtifacts.map(({ path, sha256: hash }) => ({ path, sha256: hash, usage: "used" as const })),
    presentationQa: null,
  });
  await finalizeStyleSample(root, job.jobId);
  await publishStyleSample(root);
  await approveGate(root, "style-sample");
}
