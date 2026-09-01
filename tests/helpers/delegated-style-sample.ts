import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "sharp";

import type { AiImageSkillDependency } from "../../src/dependencies/schemas.js";
import { resolveSkillDependencies } from "../../src/dependencies/resolve.js";
import { attestWorkflowDependencies } from "../../src/dependencies/preflight.js";
import { admitDelegatedGenerationCall, publishStyleSampleGenerationPlan } from "../../src/generation/authorization.js";
import { recordDelegatedResult } from "../../src/generation/delegation-result.js";
import { finalizeStyleSample, prepareStyleSampleJob } from "../../src/generation/style-sample.js";
import { approveExecutionGate, approveGate } from "../../src/planning/confirm.js";
import { publishStyleSample } from "../../src/planning/views.js";
import { createProvisionalStyleLock, readStyleLockIfPresent } from "../../src/styles/style-lock.js";
import { StyleSampleSelectionSchema } from "../../src/styles/schemas.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function testAiDependency(root: string): Promise<AiImageSkillDependency> {
  const aiRoot = join(dirname(root), "delegated-style-sample-agent");
  const scriptsRoot = join(aiRoot, "scripts");
  await mkdir(scriptsRoot, { recursive: true });
  await mkdir(join(aiRoot, "references"), { recursive: true });
  const skillFile = join(aiRoot, "SKILL.md");
  await writeFile(skillFile, "---\nname: ai-image-to-ppt\n---\n");
  const scripts = {
    generationResult: join(scriptsRoot, "generation_result.py"),
    hostRoutingPolicy: join(scriptsRoot, "host_routing_policy.py"),
    importHostImage: join(scriptsRoot, "import_host_image.py"),
    prepareEditableInput: join(scriptsRoot, "prepare_editable_input.py"),
    apiGenerator: join(scriptsRoot, "gen_slide.py"),
    normalizedExport: join(scriptsRoot, "export_images.py"),
  };
  await Promise.all(Object.values(scripts).map((path) => writeFile(path, "raise SystemExit('test fake is never executed')\n")));
  await writeFile(join(aiRoot, "references", "capabilities.json"), `${JSON.stringify({
    schemaVersion: 1,
    skill: "ai-image-to-ppt",
    contracts: { generationResult: 1, serialStickyRouterReport: 1, hostImageImport: 1, editableInput: 1 },
    routingOrder: [
      { provider: "openai", channel: "host", modelSelection: "host-owned" },
      { provider: "openai", channel: "api", defaultModel: "gpt-image-2" },
      { provider: "gemini", channel: "host", modelSelection: "host-owned" },
      { provider: "gemini", channel: "api", defaultModel: "gemini-3.1-flash-image" },
      { provider: "doubao", channel: "host", modelSelection: "host-owned" },
      { provider: "doubao", channel: "api", defaultModel: "doubao-seedream-5-0-260128" },
    ],
    outputs: { normalizedSlide: { format: "image", width: 1920, height: 1080 }, editableInput: { format: "png", width: 1280, height: 720 } },
    scripts: Object.fromEntries(Object.entries(scripts).map(([name, path]) => [name, `scripts/${path.split("/").at(-1)}`])),
  }, null, 2)}\n`);
  const editableRoot = join(dirname(root), "delegated-style-sample-editable");
  await mkdir(join(editableRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(editableRoot, "skills", "image-to-editable-pptx"), { recursive: true });
  await mkdir(join(editableRoot, "src", "export"), { recursive: true });
  await writeFile(join(editableRoot, "package.json"), JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.2.0",
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  }));
  await writeFile(join(editableRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.2.0",
    skills: "./skills/",
  }));
  await writeFile(join(editableRoot, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  await writeFile(join(editableRoot, "src", "cli.ts"), "throw new Error('fixture CLI is never executed');\n");
  await writeFile(join(editableRoot, "src", "contracts.ts"), 'import { z } from "zod";\nexport const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) }).strict();\n');
  await writeFile(join(editableRoot, "src", "pipeline.ts"), 'function outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return `${imagePath}-editable.pptx`; }\nexport function buildSlide(imagePath?: string): string { return outputName(imagePath); }\n');
  await writeFile(join(editableRoot, "src", "export", "pptx.ts"), 'export async function exportPptx(element: any): Promise<void> { const pptx = new PptxGenConstructor(); const slide = pptx.addSlide(); slide.addImage({ objectName: "asset-background" }); slide.addText("", { objectName: `text-${element.id}` }); slide.addShape("", { objectName: `shape-${element.id}-${element.label}` }); slide.addImage({ objectName: `asset-${element.id}` }); await pptx.writeFile({ fileName: "out.pptx" }); }\n');
  return attestWorkflowDependencies(await resolveSkillDependencies({
    aiSkillRoot: aiRoot,
    editableSkillRoot: editableRoot,
  }), { source: "agent-host", localFilesystem: true, localFileLinks: true }).ai;
}

/** Creates authenticated sample evidence as if the external Agent had completed its one admitted call. */
export async function finalizeDelegatedStyleSampleForTest(
  root: string,
  options: { publish?: boolean; approveGate?: boolean } = {},
): Promise<{ jobId: string }> {
  if (!await readStyleLockIfPresent(root)) {
    const selection = StyleSampleSelectionSchema.parse(JSON.parse(await readFile(join(root, "style", "selection.json"), "utf8")));
    if (!("styleId" in selection)) throw new Error("test fake needs an explicit Style Lock for custom sample selection");
    await createProvisionalStyleLock(root, {
      selection: { kind: "catalog", styleId: selection.styleId },
      referenceArtifacts: [],
    });
  }
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
  if (options.publish ?? true) await publishStyleSample(root);
  if (options.approveGate ?? true) await approveGate(root, "style-sample");
  return { jobId: job.jobId };
}
