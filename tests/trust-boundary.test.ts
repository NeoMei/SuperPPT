import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  attestWorkflowDependencies,
  preflightDependencies,
} from "../src/dependencies/preflight.js";
import { resolveSkillDependencies } from "../src/dependencies/resolve.js";
import { WorkflowPreflightBindingSchema } from "../src/dependencies/schemas.js";
import { convertProjectPage } from "../src/editable/adapter.js";

const hostCapabilities = {
  source: "agent-host",
  localFilesystem: true,
  localFileLinks: true,
} as const;

const aiScripts = {
  generationResult: "scripts/generation_result.py",
  hostRoutingPolicy: "scripts/host_routing_policy.py",
  importHostImage: "scripts/import_host_image.py",
  prepareEditableInput: "scripts/prepare_editable_input.py",
  apiGenerator: "scripts/gen_slide.py",
  normalizedExport: "scripts/export_images.py",
} as const;

const aiCapabilityManifest = {
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
  scripts: aiScripts,
};

const dependencyContract = {
  contractVersion: 3,
  dependencies: [
    {
      skill: "ai-image-to-ppt",
      cliFlag: "--ai-skill",
      resolution: "explicit-only",
      required: ["SKILL.md", "references/capabilities.json"],
      capabilityManifest: {
        path: "references/capabilities.json",
        schemaVersion: 1,
        contracts: aiCapabilityManifest.contracts,
        scripts: aiCapabilityManifest.scripts,
        routingOrder: aiCapabilityManifest.routingOrder,
        outputs: aiCapabilityManifest.outputs,
      },
    },
    {
      skill: "image-to-editable-pptx",
      cliFlag: "--editable-skill",
      resolution: "explicit-only",
      required: [
        "package.json",
        ".codex-plugin/plugin.json",
        "skills/image-to-editable-pptx/SKILL.md",
        "src/cli.ts",
      ],
      consumerProfile: {
        package: {
          name: "image-to-editable-pptx",
          version: ">=0.2.0 <0.3.0",
          stable: true,
          nodeEngine: ">=22.6",
          cliScript: "tsx src/cli.ts",
        },
        plugin: {
          name: "image-to-editable-pptx",
          versionMatchesPackage: true,
          skills: "./skills/",
        },
        invocation: {
          command: "npm",
          script: "cli",
          separator: "--",
          subcommand: "run",
          inputFlag: "--image",
          outputFlag: "--out",
        },
        outputContract: {
          ownershipMarker: {
            path: ".image-to-editable-pptx-output.json",
            markerVersion: 1,
            appId: "image-to-editable-pptx",
            artifactKind: "published-output",
          },
          manifest: { path: "manifest.json", version: 2 },
          ledger: { path: "run-ledger.json", version: 2 },
          officialDonor: "slide-editable.pptx",
          objectNames: {
            background: "asset-background",
            text: "text-<id>",
            shape: "shape-<id>-<label>",
            asset: "asset-<id>",
          },
        },
      },
    },
  ],
};

type Fixture = {
  root: string;
  ai: string;
  editable: string;
  contractFile: string;
};

async function fixture(t: TestContext, version = "0.2.0"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "superppt-trust-boundary-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ai = join(root, "ai");
  const editable = join(root, "editable");
  const contractFile = join(root, "dependencies.json");
  await mkdir(join(ai, "references"), { recursive: true });
  await mkdir(join(ai, "scripts"), { recursive: true });
  await mkdir(join(editable, ".codex-plugin"), { recursive: true });
  await mkdir(join(editable, "skills", "image-to-editable-pptx"), { recursive: true });
  await mkdir(join(editable, "src", "export"), { recursive: true });
  await writeFile(join(ai, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  await writeFile(join(ai, "references", "capabilities.json"), `${JSON.stringify(aiCapabilityManifest)}\n`);
  await Promise.all(Object.values(aiScripts).map((relativePath) => writeFile(
    join(ai, ...relativePath.split("/")),
    "raise SystemExit('dependency resolution must not execute scripts')\n",
  )));
  await writeFile(join(editable, "package.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version,
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  })}\n`);
  await writeFile(join(editable, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version,
    skills: "./skills/",
  })}\n`);
  await writeFile(join(editable, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  await writeFile(join(editable, "src", "cli.ts"), "throw new Error('must not execute during admission');\n");
  await writeFile(join(editable, "src", "contracts.ts"), 'import { z } from "zod"; export const SlideManifestV2Schema = z.object({ manifestVersion: z.literal(2) });\n');
  await writeFile(join(editable, "src", "pipeline.ts"), 'function outputName(imagePath?: string): string { if (imagePath === undefined) return "slide-editable.pptx"; return `${imagePath}-editable.pptx`; }\nexport function buildSlide(imagePath?: string): string { return outputName(imagePath); }\n');
  await writeFile(join(editable, "src", "export", "pptx.ts"), 'export async function exportPptx(element: any) { const pptx = new PptxGenConstructor(); const slide = pptx.addSlide(); slide.addImage({ objectName: "asset-background" }); slide.addText("", { objectName: `text-${element.id}` }); slide.addShape("", { objectName: `shape-${element.id}-${element.label}` }); slide.addImage({ objectName: `asset-${element.id}` }); await pptx.writeFile({ fileName: "out.pptx" }); }\n');
  await writeFile(contractFile, `${JSON.stringify(dependencyContract)}\n`);
  return { root, ai, editable, contractFile };
}

function request(current: Fixture) {
  return {
    aiSkillRoot: current.ai,
    editableSkillRoot: current.editable,
    contractFile: current.contractFile,
  };
}

test("repository dependency contract and workflow attestation use the corrected versions", async (t) => {
  const repositoryContract = JSON.parse(await readFile(join(process.cwd(), "references", "dependencies.json"), "utf8"));
  assert.equal(repositoryContract.contractVersion, 3);

  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  const attested = attestWorkflowDependencies(resolved, hostCapabilities);
  assert.equal(attested.ai.workflowPreflight?.bindingVersion, 2);
});

test("editable admission requires the selected plugin manifest and CLI identity", async (t) => {
  for (const [name, mutate, pattern] of [
    ["missing package manifest", async (current: Fixture) => unlink(join(current.editable, "package.json")), /package\.json.*missing/i],
    ["malformed package manifest", async (current: Fixture) => writeFile(join(current.editable, "package.json"), "[]"), /package\.json.*invalid/i],
    ["package name mismatch", async (current: Fixture) => writeFile(join(current.editable, "package.json"), JSON.stringify({ name: "lookalike", version: "0.2.0", engines: { node: ">=22.6" }, scripts: { cli: "tsx src/cli.ts" } })), /stable image-to-editable-pptx|0\.2/i],
    ["Node engine mismatch", async (current: Fixture) => writeFile(join(current.editable, "package.json"), JSON.stringify({ name: "image-to-editable-pptx", version: "0.2.0", engines: { node: ">=20" }, scripts: { cli: "tsx src/cli.ts" } })), /Node engine/i],
    ["missing plugin manifest", async (current: Fixture) => unlink(join(current.editable, ".codex-plugin", "plugin.json")), /plugin\.json.*missing/i],
    ["malformed plugin manifest", async (current: Fixture) => writeFile(join(current.editable, ".codex-plugin", "plugin.json"), "{bad"), /plugin\.json.*invalid/i],
    ["plugin name mismatch", async (current: Fixture) => writeFile(join(current.editable, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "lookalike", version: "0.2.0", skills: "./skills/" })), /plugin name/i],
    ["plugin version mismatch", async (current: Fixture) => writeFile(join(current.editable, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "image-to-editable-pptx", version: "0.2.1", skills: "./skills/" })), /plugin.*version|version.*plugin/i],
    ["plugin skills mismatch", async (current: Fixture) => writeFile(join(current.editable, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "image-to-editable-pptx", version: "0.2.0", skills: "./other/" })), /plugin.*skills|skills.*plugin/i],
    ["missing Skill", async (current: Fixture) => unlink(join(current.editable, "skills", "image-to-editable-pptx", "SKILL.md")), /Skill entry.*missing/i],
    ["missing CLI", async (current: Fixture) => unlink(join(current.editable, "src", "cli.ts")), /cli\.ts.*missing/i],
    ["wrong CLI script", async (current: Fixture) => writeFile(join(current.editable, "package.json"), JSON.stringify({ name: "image-to-editable-pptx", version: "0.2.0", engines: { node: ">=22.6" }, scripts: { cli: "tsx src/other.ts" } })), /script.*cli|cli.*script/i],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      await mutate(current);
      await assert.rejects(resolveSkillDependencies(request(current)), pattern);
    });
  }
});

test("editable admission rejects unsupported and prerelease versions", async (t) => {
  for (const version of ["0.1.9", "0.3.0", "0.2.1-beta.1"]) {
    await t.test(version, async (subtest) => {
      const current = await fixture(subtest, version);
      await assert.rejects(resolveSkillDependencies(request(current)), /stable|0\.2|compatible/i);
    });
  }
});

test("editable admission rejects plugin and CLI symlink escape", async (t) => {
  for (const [name, relativePath] of [
    ["plugin manifest", [".codex-plugin", "plugin.json"]],
    ["CLI", ["src", "cli.ts"]],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      const external = join(current.root, `${name.replaceAll(" ", "-")}-external`);
      await writeFile(external, "external\n");
      const target = join(current.editable, ...relativePath);
      await unlink(target);
      await symlink(external, target);
      await assert.rejects(resolveSkillDependencies(request(current)), /unsafe|symbolic link|outside/i);
    });
  }
});

test("editable admission rejects a symlinked root or source-tree entry", async (t) => {
  await t.test("root", async (subtest) => {
    const current = await fixture(subtest);
    const linkedRoot = join(current.root, "editable-link");
    await symlink(current.editable, linkedRoot);
    await assert.rejects(resolveSkillDependencies({ ...request(current), editableSkillRoot: linkedRoot }), /root must not be a symbolic link/i);
  });
  await t.test("source tree entry", async (subtest) => {
    const current = await fixture(subtest);
    const external = join(current.root, "external-source.ts");
    await writeFile(external, "external source\n");
    await symlink(external, join(current.editable, "src", "linked.ts"));
    await assert.rejects(resolveSkillDependencies(request(current)), /source tree.*symbolic link|source tree.*unsafe/i);
  });
});

test("editable source-tree identity fails closed on oversized files", async (t) => {
  const current = await fixture(t);
  const oversized = join(current.editable, "src", "oversized.ts");
  await writeFile(oversized, "x");
  await truncate(oversized, 16 * 1024 * 1024 + 1);
  await assert.rejects(resolveSkillDependencies(request(current)), /source file exceeds the identity budget/i);
});

test("editable source syntax is outside admission and is only a TOCTOU identity", async (t) => {
  const current = await fixture(t);
  await writeFile(join(current.editable, "src", "contracts.ts"), "this is deliberately not TypeScript\n");
  await writeFile(join(current.editable, "src", "pipeline.ts"), "// no donor literal\n");
  await writeFile(join(current.editable, "src", "export", "pptx.ts"), "// no object-name literals\n");

  const resolved = await resolveSkillDependencies(request(current));
  assert.equal(resolved.editable.version, "0.2.0");
});

test("preflight detects plugin-manifest and CLI identity drift", async (t) => {
  for (const [name, relativePath] of [
    ["package manifest", ["package.json"]],
    ["plugin manifest", [".codex-plugin", "plugin.json"]],
    ["Skill", ["skills", "image-to-editable-pptx", "SKILL.md"]],
    ["CLI", ["src", "cli.ts"]],
    ["source tree", ["src", "pipeline.ts"]],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      const resolved = await resolveSkillDependencies(request(current));
      await writeFile(join(current.editable, ...relativePath), "changed after resolution\n");
      const report = await preflightDependencies(resolved);
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((error) => error.dependency === "image-to-editable-pptx" && error.code === "identity_changed"));
    });
  }
});

test("binding v1 is rejected instead of silently upgraded", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  const binding = attestWorkflowDependencies(resolved, hostCapabilities).ai.workflowPreflight;
  assert.ok(binding);
  assert.equal(WorkflowPreflightBindingSchema.safeParse({ ...binding, bindingVersion: 1 }).success, false);
});

test("product conversion boundary rejects a caller-supplied converterRoot authority", async (t) => {
  const current = await fixture(t);
  const dependencies = attestWorkflowDependencies(
    await resolveSkillDependencies(request(current)),
    hostCapabilities,
  );
  await assert.rejects(convertProjectPage({
    root: "/definitely/not/a/project",
    slideId: "00000000-0000-4000-8000-000000000001",
    converterRoot: current.editable,
    dependencies,
  } as Parameters<typeof convertProjectPage>[0]), /no longer accepts converterRoot|converterRoot.*not accepted/i);
});
