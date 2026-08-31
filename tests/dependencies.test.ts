import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { preflightDependencies } from "../src/dependencies/preflight.js";
import { resolveSkillDependencies } from "../src/dependencies/resolve.js";
import { AiImageSkillDependencySchema } from "../src/dependencies/schemas.js";

const execFileAsync = promisify(execFile);

const requiredScripts = {
  generationResult: "generation_result.py",
  hostRoutingPolicy: "host_routing_policy.py",
  importHostImage: "import_host_image.py",
  prepareEditableInput: "prepare_editable_input.py",
  apiGenerator: "gen_slide.py",
  normalizedExport: "export_images.py",
} as const;
const requiredScriptBytes = "raise SystemExit('this script must never be executed by dependency resolution')\n";

const capabilityManifest = {
  schemaVersion: 1,
  skill: "ai-image-to-ppt",
  contracts: {
    generationResult: 1,
    serialStickyRouterReport: 1,
    hostImageImport: 1,
    editableInput: 1,
  },
  routingOrder: [
    { provider: "openai", channel: "host", modelSelection: "host-owned" },
    { provider: "openai", channel: "api", defaultModel: "gpt-image-2" },
    { provider: "gemini", channel: "host", modelSelection: "host-owned" },
    { provider: "gemini", channel: "api", defaultModel: "gemini-3.1-flash-image" },
    { provider: "doubao", channel: "host", modelSelection: "host-owned" },
    { provider: "doubao", channel: "api", defaultModel: "doubao-seedream-5-0-260128" },
  ],
  outputs: {
    normalizedSlide: { format: "image", width: 1920, height: 1080 },
    editableInput: { format: "png", width: 1280, height: 720 },
  },
  scripts: Object.fromEntries(Object.entries(requiredScripts).map(([name, file]) => [name, `scripts/${file}`])),
};

const dependencyContract = {
  contractVersion: 2,
  dependencies: [
    {
      skill: "ai-image-to-ppt",
      cliFlag: "--ai-skill",
      resolution: "explicit-only",
      required: ["SKILL.md", "references/capabilities.json"],
      capabilityManifest: {
        path: "references/capabilities.json",
        schemaVersion: 1,
        contracts: capabilityManifest.contracts,
        scripts: capabilityManifest.scripts,
        routingOrder: capabilityManifest.routingOrder,
        outputs: capabilityManifest.outputs,
      },
    },
    {
      skill: "image-to-editable-pptx",
      cliFlag: "--editable-skill",
      resolution: "explicit-only",
      required: ["package.json", "skills/image-to-editable-pptx/SKILL.md", "src/contracts.ts", "src/pipeline.ts", "src/export/pptx.ts"],
      capabilities: {
        version: ">=0.2.0 <0.3.0",
        manifestVersion: 2,
        officialDonor: "slide-editable.pptx",
        objectNames: {
          background: "asset-background",
          text: "text-<id>",
          shape: "shape-<id>-<label>",
          asset: "asset-<id>",
        },
        evidence: {
          manifestSchema: "src/contracts.ts",
          officialDonor: "src/pipeline.ts",
          objectNames: "src/export/pptx.ts",
        },
      },
    },
  ],
};

type Fixture = { root: string; ai: string; editable: string; contractFile: string };

async function fixture(t: TestContext, version = "0.2.0"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "superppt-skill-deps-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ai = join(root, "provided-ai-skill");
  const editable = join(root, "provided-editable-skill");
  const contractFile = join(root, "dependencies.json");
  await mkdir(join(ai, "scripts"), { recursive: true });
  await mkdir(join(ai, "references"), { recursive: true });
  await mkdir(join(editable, "skills", "image-to-editable-pptx"), { recursive: true });
  await mkdir(join(editable, "src", "export"), { recursive: true });
  await writeFile(join(ai, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  await Promise.all(Object.values(requiredScripts).map((script) => writeFile(
    join(ai, "scripts", script),
    requiredScriptBytes,
  )));
  await writeFile(join(ai, "references", "capabilities.json"), `${JSON.stringify(capabilityManifest, null, 2)}\n`);
  await writeFile(join(editable, "package.json"), JSON.stringify({
    name: "image-to-editable-pptx",
    version,
  }));
  await writeFile(
    join(editable, "skills", "image-to-editable-pptx", "SKILL.md"),
    "---\nname: image-to-editable-pptx\n---\nmanifestVersion: 2\nofficial donor: slide-editable.pptx\nobject names: asset-background, text-<id>, shape-<id>-<label>, asset-<id>\n",
  );
  await writeFile(join(editable, "src", "contracts.ts"), 'import { z } from "zod";\nexport const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) }).strict();\n');
  await writeFile(join(editable, "src", "pipeline.ts"), 'function outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return `${imagePath}-editable.pptx`; }\nexport function buildSlide(imagePath?: string): string { return outputName(imagePath); }\n');
  await writeFile(join(editable, "src", "export", "pptx.ts"), [
    "export async function exportPptx(element: any): Promise<void> {",
    "  const pptx = new PptxGenConstructor();",
    "  const slide = pptx.addSlide();",
    '  slide.addImage({ objectName: "asset-background" });',
    '  slide.addText("", { objectName: `text-${element.id}` });',
    '  slide.addShape("", { objectName: `shape-${element.id}-${element.label}` });',
    '  slide.addImage({ objectName: `asset-${element.id}` });',
    '  await pptx.writeFile({ fileName: "out.pptx" });',
    "}",
    "",
  ].join("\n"));
  await writeFile(contractFile, `${JSON.stringify(dependencyContract, null, 2)}\n`);
  return { root, ai, editable, contractFile };
}

function request(fixture: Fixture) {
  return {
    aiSkillRoot: fixture.ai,
    editableSkillRoot: fixture.editable,
    contractFile: fixture.contractFile,
  };
}

test("resolves exactly the supplied Skill roots without provider discovery", async (t) => {
  const current = await fixture(t);
  const sibling = join(current.root, "ai-image-to-ppt");
  await mkdir(join(sibling, "scripts"), { recursive: true });
  await writeFile(join(sibling, "SKILL.md"), "wrong sibling Skill\n");

  const resolved = await resolveSkillDependencies(request(current));
  const ai = AiImageSkillDependencySchema.parse(resolved.ai);
  const aiRoot = await realpath(current.ai);
  const editableRoot = await realpath(current.editable);

  assert.equal(ai.kind, "ai-image-to-ppt");
  assert.equal(ai.root, aiRoot);
  assert.equal(ai.skillFile, join(aiRoot, "SKILL.md"));
  assert.equal(ai.capabilityManifestFile, join(aiRoot, "references", "capabilities.json"));
  assert.equal(ai.capabilityManifestSha256, createHash("sha256").update(
    await readFile(join(aiRoot, "references", "capabilities.json")),
  ).digest("hex"));
  assert.equal(ai.capabilitySchemaVersion, 1);
  assert.deepEqual(ai.contracts, capabilityManifest.contracts);
  assert.deepEqual(ai.outputs, capabilityManifest.outputs);
  assert.deepEqual(ai.routingOrder, capabilityManifest.routingOrder);
  assert.deepEqual(ai.scripts, {
    generationResult: join(aiRoot, "scripts", "generation_result.py"),
    hostRoutingPolicy: join(aiRoot, "scripts", "host_routing_policy.py"),
    importHostImage: join(aiRoot, "scripts", "import_host_image.py"),
    prepareEditableInput: join(aiRoot, "scripts", "prepare_editable_input.py"),
    apiGenerator: join(aiRoot, "scripts", "gen_slide.py"),
    normalizedExport: join(aiRoot, "scripts", "export_images.py"),
  });
  assert.deepEqual(ai.scriptSha256, Object.fromEntries(
    Object.keys(requiredScripts).map((name) => [
      name,
      createHash("sha256").update(requiredScriptBytes).digest("hex"),
    ]),
  ));
  assert.equal(resolved.editable.root, editableRoot);
  assert.equal(resolved.editable.version, "0.2.0");
  assert.equal(resolved.editable.manifestVersion, 2);
  assert.equal(resolved.editable.officialDonor, "slide-editable.pptx");
  assert.deepEqual(resolved.editable.objectNames, {
    background: "asset-background",
    text: "text-<id>",
    shape: "shape-<id>-<label>",
    asset: "asset-<id>",
  });
});

test("rejects a missing or malformed ai-image-to-ppt capability manifest before resolving scripts", async (t) => {
  for (const [name, mutate, pattern] of [
    ["missing", async (current: Fixture) => unlink(join(current.ai, "references", "capabilities.json")), /capability manifest.*missing/i],
    ["malformed", async (current: Fixture) => writeFile(join(current.ai, "references", "capabilities.json"), "{not-json"), /capability manifest.*invalid/i],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await mutate(current);
      await assert.rejects(resolveSkillDependencies(request(current)), pattern);
    });
  }
});

test("rejects ai-image-to-ppt manifest and dependency-contract script disagreement", async (t) => {
  const current = await fixture(t);
  const manifestPath = join(current.ai, "references", "capabilities.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts.apiGenerator = "scripts/other.py";
  await writeFile(join(current.ai, "scripts", "other.py"), requiredScriptBytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(resolveSkillDependencies(request(current)), /capability.*script.*disagree|apiGenerator/i);
});

test("rejects Gemini and Doubao default-model drift from the authoritative capability contract", async (t) => {
  for (const [name, index, model] of [
    ["Gemini", 3, "gemini-other"],
    ["Doubao", 5, "doubao-other"],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      const manifestPath = join(current.ai, "references", "capabilities.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.routingOrder[index].defaultModel = model;
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      await assert.rejects(resolveSkillDependencies(request(current)), /capability manifest.*invalid|routing.*disagree/i);
    });
  }
});

test("rejects installed editable capability evidence drift before converter execution", async (t) => {
  for (const [name, path, replacement, pattern] of [
    ["manifest v1", "src/contracts.ts", "export const V1 = { manifestVersion: z.literal(1) };\n", /manifest.*v2|capability evidence/i],
    ["missing official donor", "src/pipeline.ts", "export const officialDonor = \"other.pptx\";\n", /official donor|capability evidence/i],
    ["object-name drift", "src/export/pptx.ts", "export const names = ['background', 'text', 'shape', 'asset'];\n", /object.name|capability evidence/i],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await writeFile(join(current.editable, ...path.split("/")), replacement);
      await assert.rejects(resolveSkillDependencies(request(current)), pattern);
    });
  }
});

test("rejects comment-only and dead editable capability literals", async (t) => {
  for (const [name, path, replacement, pattern] of [
    ["comment-only manifest", "src/contracts.ts", "// export const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) });\n", /manifest.*v2|semantic.*evidence/i],
    ["dead manifest literal", "src/contracts.ts", "const unused = { manifestVersion: z.literal(2) };\n", /manifest.*v2|semantic.*evidence/i],
    ["comment-only donor", "src/pipeline.ts", "// function outputName() { return \"slide-editable.pptx\"; }\n", /official donor|semantic.*evidence/i],
    ["dead donor literal", "src/pipeline.ts", "const unused = \"slide-editable.pptx\";\n", /official donor|semantic.*evidence/i],
    ["comment-only object names", "src/export/pptx.ts", "// objectName: \"asset-background\"; `text-${element.id}`; `shape-${element.id}-${element.label}`; `asset-${element.id}`\n", /object.name|semantic.*evidence/i],
    ["dead object-name literals", "src/export/pptx.ts", "const unused = [\"asset-background\", `text-${element.id}`, `shape-${element.id}-${element.label}`, `asset-${element.id}`];\n", /object.name|semantic.*evidence/i],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await writeFile(join(current.editable, ...path.split("/")), replacement);
      await assert.rejects(resolveSkillDependencies(request(current)), pattern);
    });
  }
});

test("rejects non-Zod and unreachable editable AST evidence", async (t) => {
  for (const [name, path, replacement, pattern] of [
    ["non-Zod schema lookalike", "src/contracts.ts", "const z = fake;\nexport const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) }).strict();\n", /manifest.*v2|semantic.*evidence/i],
    ["aliased Zod binding", "src/contracts.ts", "import { z as schema } from \"zod\";\nexport const SlideManifestV2Schema = schema.object({ manifestVersion: schema.literal(2) }).strict();\n", /manifest.*v2|semantic.*evidence/i],
    ["namespace Zod binding", "src/contracts.ts", "import * as z from \"zod\";\nexport const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) }).strict();\n", /manifest.*v2|semantic.*evidence/i],
    ["type-only Zod binding", "src/contracts.ts", "import type { z } from \"zod\";\nexport const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) }).strict();\n", /manifest.*v2|semantic.*evidence/i],
    ["shadowed Zod binding", "src/contracts.ts", "import { z } from \"zod\";\nconst z = fake;\nexport const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) }).strict();\n", /manifest.*v2|semantic.*evidence/i],
    ["competing Zod binding", "src/contracts.ts", "import { z } from \"zod\";\nimport { fake as z } from \"other\";\nexport const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) }).strict();\n", /manifest.*v2|semantic.*evidence/i],
    ["false-branch donor", "src/pipeline.ts", "function outputName(imagePath?: string): string { if (imagePath === undefined) return \"slide-editable.pptx\"; return \"other.pptx\"; }\nexport function buildSlide(): string { if (false) return outputName(); return \"other.pptx\"; }\n", /official donor|semantic.*evidence/i],
    ["uninvoked nested donor", "src/pipeline.ts", "function outputName(imagePath?: string): string { if (imagePath === undefined) return \"slide-editable.pptx\"; return \"other.pptx\"; }\nexport function buildSlide(): string { function unused() { return outputName(); } return \"other.pptx\"; }\n", /official donor|semantic.*evidence/i],
    ["unrelated exported donor", "src/pipeline.ts", "function outputName(imagePath?: string): string { if (imagePath === undefined) return \"slide-editable.pptx\"; return \"other.pptx\"; }\nexport function unrelated(): string { return outputName(); }\nexport function buildSlide(): string { return \"other.pptx\"; }\n", /official donor|semantic.*evidence/i],
    ["false-branch object calls", "src/export/pptx.ts", "export async function exportPptx(element: any, pptx: any, slide: any): Promise<void> { if (false) { slide.addImage({ objectName: \"asset-background\" }); slide.addText(\"\", { objectName: `text-${element.id}` }); slide.addShape(\"\", { objectName: `shape-${element.id}-${element.label}` }); slide.addImage({ objectName: `asset-${element.id}` }); await pptx.writeFile({ fileName: \"out.pptx\" }); } }\n", /object.name|semantic.*evidence/i],
    ["uninvoked nested object calls", "src/export/pptx.ts", "export async function exportPptx(element: any, pptx: any, slide: any): Promise<void> { async function unused() { slide.addImage({ objectName: \"asset-background\" }); slide.addText(\"\", { objectName: `text-${element.id}` }); slide.addShape(\"\", { objectName: `shape-${element.id}-${element.label}` }); slide.addImage({ objectName: `asset-${element.id}` }); await pptx.writeFile({ fileName: \"out.pptx\" }); } }\n", /object.name|semantic.*evidence/i],
    ["object names after write", "src/export/pptx.ts", "export async function exportPptx(element: any): Promise<void> { const pptx = new PptxGenConstructor(); const slide = pptx.addSlide(); await pptx.writeFile({ fileName: \"out.pptx\" }); slide.addImage({ objectName: \"asset-background\" }); slide.addText(\"\", { objectName: `text-${element.id}` }); slide.addShape(\"\", { objectName: `shape-${element.id}-${element.label}` }); slide.addImage({ objectName: `asset-${element.id}` }); }\n", /object.name|semantic.*evidence/i],
    ["wrong object-call receiver", "src/export/pptx.ts", "export async function exportPptx(element: any): Promise<void> { const pptx = new PptxGenConstructor(); const slide = pptx.addSlide(); other.addImage({ objectName: \"asset-background\" }); other.addText(\"\", { objectName: `text-${element.id}` }); other.addShape(\"\", { objectName: `shape-${element.id}-${element.label}` }); other.addImage({ objectName: `asset-${element.id}` }); await pptx.writeFile({ fileName: \"out.pptx\" }); }\n", /object.name|semantic.*evidence/i],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await writeFile(join(current.editable, ...path.split("/")), replacement);
      await assert.rejects(resolveSkillDependencies(request(current)), pattern);
    });
  }
});

test("rejects statically unreachable donor calls in expressions and loops", async (t) => {
  const outputName = 'function outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return "other.pptx"; }\n';
  for (const [name, body] of [
    ["false && donor", 'false && outputName(); return "other.pptx";'],
    ["true || donor", 'true || outputName(); return "other.pptx";'],
    ["false ?? donor", 'false ?? outputName(); return "other.pptx";'],
    ["nested false && donor", '((false)) && outputName(); return "other.pptx";'],
    ["truthy object || donor", '({}) || outputName(); return "other.pptx";'],
    ["non-nullish object ?? donor", '({}) ?? outputName(); return "other.pptx";'],
    ["static conditional donor", 'return true ? "other.pptx" : outputName();'],
    ["truthy object conditional donor", 'return ({}) ? "other.pptx" : outputName();'],
    ["while false donor", 'while (false) outputName(); return "other.pptx";'],
    ["for false donor", 'for (; false;) outputName(); return "other.pptx";'],
    ["for unreachable increment donor", 'for (; false; outputName()) {} return "other.pptx";'],
    ["do-while short-circuit donor", 'do {} while (false && outputName()); return "other.pptx";'],
    ["do-while condition after return donor", 'do { return "other.pptx"; } while (outputName());'],
    ["for increment after return donor", 'for (;; outputName()) { return "other.pptx"; }'],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await writeFile(
        join(current.editable, "src", "pipeline.ts"),
        `${outputName}export function buildSlide(): string { ${body} }\n`,
      );
      await assert.rejects(resolveSkillDependencies(request(current)), /official donor|semantic.*evidence/i);
    });
  }
});

test("accepts donor calls on statically executed expression and loop paths", async (t) => {
  const outputName = 'function outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return "other.pptx"; }\n';
  for (const [name, body] of [
    ["null ?? donor", 'return null ?? outputName();'],
    ["selected conditional donor", 'return false ? "other.pptx" : outputName();'],
    ["do-while body donor", 'do { return outputName(); } while (false);'],
    ["for initializer donor", 'for (outputName(); false;) {} return "other.pptx";'],
    ["variable initializer donor", 'const donor = outputName(); return donor;'],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await writeFile(
        join(current.editable, "src", "pipeline.ts"),
        `${outputName}export function buildSlide(): string { ${body} }\n`,
      );
      const resolved = await resolveSkillDependencies(request(current));
      assert.equal(resolved.editable.officialDonor, "slide-editable.pptx");
    });
  }
});

test("rejects statically unreachable object-name and writeFile calls", async (t) => {
  const prefix = "export async function exportPptx(element: any): Promise<void> { const pptx = new PptxGenConstructor(); const slide = pptx.addSlide(); ";
  const names = 'slide.addImage({ objectName: "asset-background" }); slide.addText("", { objectName: `text-${element.id}` }); slide.addShape("", { objectName: `shape-${element.id}-${element.label}` }); slide.addImage({ objectName: `asset-${element.id}` }); ';
  const write = 'await pptx.writeFile({ fileName: "out.pptx" });';
  for (const [name, body] of [
    ["false && object-name calls", 'false && slide.addImage({ objectName: "asset-background" }); false && slide.addText("", { objectName: `text-${element.id}` }); false && slide.addShape("", { objectName: `shape-${element.id}-${element.label}` }); false && slide.addImage({ objectName: `asset-${element.id}` }); await pptx.writeFile({ fileName: "out.pptx" });'],
    ["true || object-name calls", 'true || slide.addImage({ objectName: "asset-background" }); true || slide.addText("", { objectName: `text-${element.id}` }); true || slide.addShape("", { objectName: `shape-${element.id}-${element.label}` }); true || slide.addImage({ objectName: `asset-${element.id}` }); await pptx.writeFile({ fileName: "out.pptx" });'],
    ["false conditional object-name calls", `false ? (${names.replaceAll("; ", ", ")} undefined) : undefined; ${write}`],
    ["while false object-name and writeFile calls", `while (false) { ${names}${write} }`],
    ["false && writeFile", `${names}false && pptx.writeFile({ fileName: "out.pptx" });`],
    ["true || writeFile", `${names}true || pptx.writeFile({ fileName: "out.pptx" });`],
    ["false ?? writeFile", `${names}false ?? pptx.writeFile({ fileName: "out.pptx" });`],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await writeFile(join(current.editable, "src", "export", "pptx.ts"), `${prefix}${body} }\n`);
      await assert.rejects(resolveSkillDependencies(request(current)), /object.name|semantic.*evidence/i);
    });
  }
});

test("rejects donor evidence with non-normal completion or the wrong lexical binding", async (t) => {
  const realOutputName = 'function outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return "other.pptx"; }\n';
  for (const [name, replacement] of [
    ["do break skips the condition", `${realOutputName}export function buildSlide(): string { do { break; } while (outputName()); return "other.pptx"; }\n`],
    ["for break skips the increment", `${realOutputName}export function buildSlide(): string { for (;; outputName()) { break; } return "other.pptx"; }\n`],
    ["continue skips the rest of the loop body", `${realOutputName}export function buildSlide(): string { for (;;) { continue; outputName(); } }\n`],
    ["nested labelled break skips the outer remainder", `${realOutputName}export function buildSlide(): string { outer: for (;;) { for (;;) { break outer; } outputName(); } return "other.pptx"; }\n`],
    ["nested labelled continue skips the outer remainder", `${realOutputName}export function buildSlide(): string { outer: for (;;) { for (;;) { continue outer; } outputName(); } }\n`],
    ["switch skips a non-matching case", `${realOutputName}export function buildSlide(): string { switch (0) { case 1: return outputName(); } return "other.pptx"; }\n`],
    ["switch break skips its default", `${realOutputName}export function buildSlide(): string { switch (0) { case 0: break; default: return outputName(); } return "other.pptx"; }\n`],
    ["switch selected return prevents fallthrough evidence", `${realOutputName}export function buildSlide(): string { switch (0) { case 0: return "other.pptx"; case 1: outputName(); default: return "other.pptx"; } }\n`],
    ["try return survives an empty finally", `${realOutputName}export function buildSlide(): string { try { return "other.pptx"; } finally {} outputName(); }\n`],
    ["try throw survives an empty finally", `${realOutputName}export function buildSlide(): string { try { throw new Error("stop"); } finally {} outputName(); }\n`],
    ["const false binding prunes the branch", `${realOutputName}export function buildSlide(): string { const ENABLED = false; if (ENABLED) return outputName(); return "other.pptx"; }\n`],
    ["top-level const false binding prunes the branch", `const ENABLED = false;\n${realOutputName}export function buildSlide(): string { if (ENABLED) return outputName(); return "other.pptx"; }\n`],
    ["negative zero prunes the branch", `${realOutputName}export function buildSlide(): string { if (-0) return outputName(); return "other.pptx"; }\n`],
    ["bigint zero prunes the branch", `${realOutputName}export function buildSlide(): string { if (0n) return outputName(); return "other.pptx"; }\n`],
    ["uncalled object method is not executable", `${realOutputName}export function buildSlide(): string { const holder = { run() { return outputName(); } }; return "other.pptx"; }\n`],
    ["uninstantiated constructor is not executable", `${realOutputName}class Holder { constructor() { outputName(); } }\nexport function buildSlide(): string { return "other.pptx"; }\n`],
    ["definitely throwing helper prevents later donor evidence", `${realOutputName}function stop(): never { throw new Error("stop"); }\nexport function buildSlide(): string { stop(); return outputName(); }\n`],
    ["dead official return does not prove outputName", 'function outputName(imagePath?: string): string { return "other.pptx"; if (imagePath === undefined) return "slide-editable.pptx"; }\nexport function buildSlide(): string { return outputName(); }\n'],
    ["top-level undefined shadow does not select the official return", 'const undefined = "shadowed";\nfunction outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return "other.pptx"; }\nexport function buildSlide(): string { return outputName(); }\n'],
    ["non-undefined argument does not select the official donor", `${realOutputName}export function buildSlide(): string { return outputName("source.png"); }\n`],
    ["parameter shadow does not call the real outputName", `${realOutputName}export function buildSlide(outputName: () => string): string { return outputName(); }\n`],
    ["local shadow does not call the real outputName", `${realOutputName}export function buildSlide(): string { const outputName = () => "other.pptx"; return outputName(); }\n`],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await writeFile(join(current.editable, "src", "pipeline.ts"), replacement);
      await assert.rejects(resolveSkillDependencies(request(current)), /official donor|semantic.*evidence/i);
    });
  }
});

test("accepts a const lexical alias that calls the real outputName with undefined", async (t) => {
  const current = await fixture(t);
  await writeFile(join(current.editable, "src", "pipeline.ts"), [
    'function outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return "other.pptx"; }',
    "export function buildSlide(): string {",
    "  const selected = outputName;",
    "  return selected();",
    "}",
    "",
  ].join("\n"));

  const resolved = await resolveSkillDependencies(request(current));
  const report = await preflightDependencies(resolved);

  assert.equal(resolved.editable.officialDonor, "slide-editable.pptx");
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
});

test("rejects object-name evidence assembled from dead paths or rebound receivers", async (t) => {
  const setup = "let pptx = new PptxGenConstructor(); let slide = pptx.addSlide(); ";
  const names = 'slide.addImage({ objectName: "asset-background" }); slide.addText("", { objectName: `text-${element.id}` }); slide.addShape("", { objectName: `shape-${element.id}-${element.label}` }); slide.addImage({ objectName: `asset-${element.id}` }); ';
  const write = 'await pptx.writeFile({ fileName: "out.pptx" });';
  for (const [name, body] of [
    ["try return makes later names and write unreachable", `try { return; } finally {} ${names}${write}`],
    ["continue makes later names and write unreachable", `for (;;) { continue; ${names}${write} }`],
    ["break skips the for increment write", `for (;; pptx.writeFile({ fileName: "out.pptx" })) { ${names}break; }`],
    ["mutually exclusive if branches cannot combine names and write", `if (flag) { ${names} } else { ${write} }`],
    ["mutually exclusive switch cases cannot combine names and write", `switch (flag) { case 0: ${names}break; default: ${write} }`],
    ["selected switch return prevents fallthrough names and write", `switch (0) { case 0: return; case 1: ${names}default: ${write} }`],
    ["stable flag cannot change across loop iterations", `for (let index = 0; index < 2; index += 1) { if (flag) { ${names} } else { ${write} } }`],
    ["empty for-of never executes object-name calls", `for (const ignored of []) { ${names} } ${write}`],
    ["reassigned slide is not the constructed receiver", `slide = fakeSlide; ${names}${write}`],
    ["reassigned pptx is not the constructed receiver", `${names}pptx = fakePptx; ${write}`],
    ["uncalled object method does not construct receivers", `const holder = { async run() { ${setup}${names}${write} } };`],
    ["uninstantiated constructor does not construct receivers", `class Holder { constructor() { ${setup}${names}pptx.writeFile({ fileName: "out.pptx" }); } }`],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      const usesOuterSetup = !name.includes("does not construct receivers");
      await writeFile(
        join(current.editable, "src", "export", "pptx.ts"),
        `export async function exportPptx(element: any, flag: any, fakeSlide: any, fakePptx: any): Promise<void> { ${usesOuterSetup ? setup : ""}${body} }\n`,
      );
      await assert.rejects(resolveSkillDependencies(request(current)), /object.name|semantic.*evidence/i);
    });
  }
});

test("rejects converter 0.1, manifest v1, and missing official donor contracts", async (t) => {
  await t.test("converter 0.1", async (subtest) => {
    const current = await fixture(subtest, "0.1.9");
    await assert.rejects(resolveSkillDependencies(request(current)), />=0\.2\.0 <0\.3\.0/);
  });
  for (const [name, mutate, pattern] of [
    ["manifest v1", (contract: any) => { contract.dependencies[1].capabilities.manifestVersion = 1; }, /manifestVersion.*2|manifest.*v2/i],
    ["missing donor", (contract: any) => { delete contract.dependencies[1].capabilities.officialDonor; }, /official donor|slide-editable\.pptx/i],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      const contract = JSON.parse(await readFile(current.contractFile, "utf8"));
      mutate(contract);
      await writeFile(current.contractFile, `${JSON.stringify(contract)}\n`);
      await assert.rejects(resolveSkillDependencies(request(current)), pattern);
    });
  }
});

test("rejects a symlinked Skill root", async (t) => {
  const current = await fixture(t);
  const linkedRoot = join(current.root, "linked-ai-skill");
  await symlink(current.ai, linkedRoot);

  await assert.rejects(
    resolveSkillDependencies({ ...request(current), aiSkillRoot: linkedRoot }),
    /ai-image-to-ppt Skill root must not be a symbolic link/,
  );
});

test("rejects required scripts reached through a symbolic link", async (t) => {
  const current = await fixture(t);
  const externalScripts = join(current.root, "external-scripts");
  await mkdir(externalScripts);
  await Promise.all(Object.values(requiredScripts).map((script) => writeFile(
    join(externalScripts, script),
    "wrong linked script\n",
  )));
  await rm(join(current.ai, "scripts"), { recursive: true, force: true });
  await symlink(externalScripts, join(current.ai, "scripts"));

  await assert.rejects(
    resolveSkillDependencies(request(current)),
    /ai-image-to-ppt required script is unsafe: generation_result\.py/,
  );
});

test("rejects required scripts reached through an in-root symbolic link", async (t) => {
  const current = await fixture(t);
  const aiRoot = await realpath(current.ai);
  const realScripts = join(aiRoot, "real-scripts");
  await rename(join(aiRoot, "scripts"), realScripts);
  await symlink(realScripts, join(aiRoot, "scripts"));

  await assert.rejects(
    resolveSkillDependencies(request(current)),
    /ai-image-to-ppt required script is unsafe: generation_result\.py/,
  );
});

test("rejects a missing ai-image-to-ppt SKILL.md", async (t) => {
  const current = await fixture(t);
  await unlink(join(current.ai, "SKILL.md"));

  await assert.rejects(
    resolveSkillDependencies(request(current)),
    /ai-image-to-ppt Skill entry is missing/,
  );
});

test("rejects a missing required AI Skill script without using a sibling fallback", async (t) => {
  const current = await fixture(t);
  await unlink(join(current.ai, "scripts", requiredScripts.importHostImage));
  const sibling = join(current.root, "ai-image-to-ppt");
  await mkdir(join(sibling, "scripts"), { recursive: true });
  await writeFile(join(sibling, "SKILL.md"), "sibling fallback\n");
  await writeFile(join(sibling, "scripts", requiredScripts.importHostImage), "wrong fallback\n");

  await assert.rejects(
    resolveSkillDependencies(request(current)),
    /ai-image-to-ppt required script is missing: import_host_image\.py/,
  );
});

test("preflight reports a changed required script after resolution", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  await writeFile(join(current.ai, "scripts", requiredScripts.hostRoutingPolicy), "changed after resolution\n");

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [{
    dependency: "ai-image-to-ppt",
    code: "identity_changed",
    safeMessage: "required Skill files changed after resolution",
  }]);
  assert.match(report.aiImageToPpt.requiredScripts.hostRoutingPolicy.sha256, /^[a-f0-9]{64}$/);
});

test("preflight reports a removed required script after resolution", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  await unlink(join(current.ai, "scripts", requiredScripts.prepareEditableInput));

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [{
    dependency: "ai-image-to-ppt",
    code: "identity_changed",
    safeMessage: "required Skill files changed after resolution",
  }]);
});

test("preflight rejects an AI Skill root replaced by a symlink after resolution", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  const aiRoot = await realpath(current.ai);
  const retainedRoot = join(await realpath(current.root), "retained-ai-skill");
  await rename(aiRoot, retainedRoot);
  await symlink(retainedRoot, aiRoot);

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [{
    dependency: "ai-image-to-ppt",
    code: "identity_changed",
    safeMessage: "required Skill files changed after resolution",
  }]);
});

test("preflight rejects an AI Skill ancestor replaced by a symlink after resolution", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  const aiRoot = await realpath(current.ai);
  const scripts = join(aiRoot, "scripts");
  const retainedScripts = join(aiRoot, "retained-scripts");
  await rename(scripts, retainedScripts);
  await symlink(retainedScripts, scripts);

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [{
    dependency: "ai-image-to-ppt",
    code: "identity_changed",
    safeMessage: "required Skill files changed after resolution",
  }]);
});

test("preflight rejects an editable package identity changed after resolution", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  await writeFile(join(current.editable, "package.json"), JSON.stringify({
    name: "other-package",
    version: "9.9.9",
  }));

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [{
    dependency: "image-to-editable-pptx",
    code: "identity_changed",
    safeMessage: "required Skill files changed after resolution",
  }]);
});

test("preflight rejects a removed editable package identity after resolution", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  await unlink(join(current.editable, "package.json"));

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [{
    dependency: "image-to-editable-pptx",
    code: "identity_changed",
    safeMessage: "required Skill files changed after resolution",
  }]);
});

test("preflight reports the resolved dependency identities without executing Skill files", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  const aiRoot = await realpath(current.ai);
  const editableRoot = await realpath(current.editable);

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, true);
  assert.equal(report.aiImageToPpt.root, aiRoot);
  assert.equal(report.aiImageToPpt.skillSha256, resolved.ai.skillSha256);
  assert.equal(report.imageToEditablePptx.root, editableRoot);
  assert.equal(report.imageToEditablePptx.version, "0.2.0");
  assert.equal(report.aiImageToPpt.capabilityManifestSha256, resolved.ai.capabilityManifestSha256);
  assert.deepEqual(Object.keys(report.aiImageToPpt.requiredScripts).sort(), Object.keys(requiredScripts).sort());
  assert.deepEqual(report.errors, []);
});

test("preflight CLI uses only explicit roots and rejects env, sibling, and provider fallback", async (t) => {
  const current = await fixture(t);
  const sibling = join(process.cwd(), "ai-image-to-ppt");
  const fakeEnvironmentRoot = join(current.root, "environment-ai-skill");
  const environment = {
    ...process.env,
    SUPERPPT_HOST_CAPABILITIES: JSON.stringify({ source: "agent-host", localFilesystem: true, localFileLinks: true }),
    SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: fakeEnvironmentRoot,
    SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: join(current.root, "environment-editable-skill"),
  };
  const invoke = (args: string[]) => execFileAsync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "preflight", ...args,
  ], { cwd: process.cwd(), env: environment });

  const { stdout } = await invoke(["--ai-skill", current.ai, "--editable-skill", current.editable]);
  const report = JSON.parse(stdout) as { ok: boolean; aiImageToPpt: { root: string }; imageToEditablePptx: { root: string } };
  assert.equal(report.ok, true);
  assert.equal(report.aiImageToPpt.root, await realpath(current.ai));
  assert.equal(report.imageToEditablePptx.root, await realpath(current.editable));
  assert.notEqual(report.aiImageToPpt.root, fakeEnvironmentRoot);
  assert.notEqual(report.aiImageToPpt.root, sibling);

  await assert.rejects(invoke([]), /required CLI flags: --ai-skill --editable-skill/i);
  await assert.rejects(invoke([
    "--ai-skill", current.ai,
    "--editable-skill", current.editable,
    "--provider", "openai",
  ]), /unknown CLI flag: --provider/i);
});
