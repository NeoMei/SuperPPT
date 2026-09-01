import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { preflightDependencies } from "../src/dependencies/preflight.js";
import { resolveSkillDependencies } from "../src/dependencies/resolve.js";
import { AiImageSkillDependencySchema, DependencyContractSchema } from "../src/dependencies/schemas.js";

const execFileAsync = promisify(execFile);
const requiredScripts = {
  generationResult: "generation_result.py",
  hostRoutingPolicy: "host_routing_policy.py",
  importHostImage: "import_host_image.py",
  prepareEditableInput: "prepare_editable_input.py",
  apiGenerator: "gen_slide.py",
  normalizedExport: "export_images.py",
} as const;
const requiredScriptBytes = "raise SystemExit('this script must never execute during dependency resolution')\n";

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

type Fixture = { root: string; ai: string; editable: string };

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "superppt-skill-deps-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ai = join(root, "provided-ai-skill");
  const editable = join(root, "provided-editable-skill");
  await mkdir(join(ai, "scripts"), { recursive: true });
  await mkdir(join(ai, "references"), { recursive: true });
  await mkdir(join(editable, ".codex-plugin"), { recursive: true });
  await mkdir(join(editable, "skills", "image-to-editable-pptx"), { recursive: true });
  await mkdir(join(editable, "src"), { recursive: true });
  await writeFile(join(ai, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  await Promise.all(Object.values(requiredScripts).map((script) => writeFile(join(ai, "scripts", script), requiredScriptBytes)));
  await writeFile(join(ai, "references", "capabilities.json"), `${JSON.stringify(capabilityManifest, null, 2)}\n`);
  await writeFile(join(editable, "package.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.2.0",
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  })}\n`);
  await writeFile(join(editable, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.2.0",
    skills: "./skills/",
  })}\n`);
  await writeFile(join(editable, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  await writeFile(join(editable, "src", "cli.ts"), "this source is identity evidence only and is never interpreted during admission\n");
  return { root, ai, editable };
}

function request(current: Fixture) {
  return { aiSkillRoot: current.ai, editableSkillRoot: current.editable };
}

function packageRootFromTestModule(): string {
  const containingRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  return basename(containingRoot) === "dist" ? dirname(containingRoot) : containingRoot;
}

test("dependency contract v3 keeps exactly the two explicit local dependencies", async () => {
  const contract = DependencyContractSchema.parse(JSON.parse(await readFile(join(process.cwd(), "references", "dependencies.json"), "utf8")));
  assert.equal(contract.contractVersion, 3);
  assert.deepEqual(contract.dependencies.map(({ skill }) => skill), ["ai-image-to-ppt", "image-to-editable-pptx"]);
  assert.deepEqual(contract.dependencies[1].required, [
    "package.json",
    ".codex-plugin/plugin.json",
    "skills/image-to-editable-pptx/SKILL.md",
    "src/cli.ts",
  ]);
  assert.equal("capabilities" in contract.dependencies[1], false);
});

test("resolves exactly the supplied Skill roots and attests declarative identities", async (t) => {
  const current = await fixture(t);
  const sibling = join(current.root, "ai-image-to-ppt");
  await mkdir(join(sibling, "scripts"), { recursive: true });
  await writeFile(join(sibling, "SKILL.md"), "wrong sibling Skill\n");
  const resolved = await resolveSkillDependencies(request(current));
  const ai = AiImageSkillDependencySchema.parse(resolved.ai);

  assert.equal(ai.root, current.ai);
  assert.equal(ai.capabilitySchemaVersion, 1);
  assert.deepEqual(ai.contracts, capabilityManifest.contracts);
  assert.deepEqual(ai.outputs, capabilityManifest.outputs);
  assert.deepEqual(ai.routingOrder, capabilityManifest.routingOrder);
  assert.equal(ai.capabilityManifestSha256, createHash("sha256").update(await readFile(join(current.ai, "references", "capabilities.json"))).digest("hex"));
  assert.deepEqual(ai.scriptSha256, Object.fromEntries(Object.keys(requiredScripts).map((name) => [
    name,
    createHash("sha256").update(requiredScriptBytes).digest("hex"),
  ])));
  assert.equal(resolved.editable.root, current.editable);
  assert.equal(resolved.editable.version, "0.2.0");
  assert.equal(resolved.editable.pluginFile, join(current.editable, ".codex-plugin", "plugin.json"));
  assert.equal(resolved.editable.cliFile, join(current.editable, "src", "cli.ts"));
  assert.deepEqual(resolved.editable.invocation, {
    command: "npm",
    script: "cli",
    separator: "--",
    subcommand: "run",
    inputFlag: "--image",
    outputFlag: "--out",
  });
  assert.equal(resolved.editable.outputContract.manifest.version, 2);
  assert.equal(resolved.editable.outputContract.ledger.version, 2);
  assert.equal(resolved.editable.outputContract.officialDonor, "slide-editable.pptx");
  assert.deepEqual(resolved.editable.outputContract.objectNames, {
    background: "asset-background",
    text: "text-<id>",
    shape: "shape-<id>-<label>",
    asset: "asset-<id>",
  });
});

test("default dependency authority ignores valid, invalid, and symlinked dist shadows", async (t) => {
  const packageRoot = packageRootFromTestModule();
  const canonicalContract = await realpath(join(packageRoot, "references", "dependencies.json"));
  const canonicalBytes = await readFile(canonicalContract);
  const canonicalSha256 = createHash("sha256").update(canonicalBytes).digest("hex");
  const shadowRoot = join(packageRoot, "dist", "references");
  const shadowContract = join(shadowRoot, "dependencies.json");

  for (const variant of ["valid", "invalid", "symlink"] as const) {
    await t.test(variant, async (subtest) => {
      const current = await fixture(subtest);
      await mkdir(shadowRoot, { recursive: true });
      subtest.after(async () => rm(shadowRoot, { recursive: true, force: true }));
      if (variant === "valid") {
        await writeFile(shadowContract, Buffer.concat([canonicalBytes, Buffer.from("\n")]));
      } else if (variant === "invalid") {
        await writeFile(shadowContract, "{}\n");
      } else {
        const legacy = join(shadowRoot, "legacy-dependencies.json");
        await writeFile(legacy, canonicalBytes);
        await symlink(legacy, shadowContract);
      }

      const resolved = await resolveSkillDependencies(request(current));
      assert.equal(resolved.contractFile, canonicalContract);
      assert.equal(resolved.contractSha256, canonicalSha256);
    });
  }
});

test("an explicit dependency contract file remains the selected authority", async (t) => {
  const current = await fixture(t);
  const explicitContract = join(current.root, "explicit-dependencies.json");
  const bytes = Buffer.concat([
    await readFile(join(packageRootFromTestModule(), "references", "dependencies.json")),
    Buffer.from("\n"),
  ]);
  await writeFile(explicitContract, bytes);

  const resolved = await resolveSkillDependencies({ ...request(current), contractFile: explicitContract });
  assert.equal(resolved.contractFile, await realpath(explicitContract));
  assert.equal(resolved.contractSha256, createHash("sha256").update(bytes).digest("hex"));
});

test("rejects a missing or malformed AI capability manifest", async (t) => {
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

test("rejects AI model, routing, output, and script drift from the authoritative contract", async (t) => {
  for (const [name, mutate, pattern] of [
    ["script", (manifest: any) => { manifest.scripts.apiGenerator = "scripts/other.py"; }, /script.*disagree|apiGenerator/i],
    ["Gemini model", (manifest: any) => { manifest.routingOrder[3].defaultModel = "gemini-other"; }, /capability manifest.*invalid|routing.*disagree/i],
    ["Doubao model", (manifest: any) => { manifest.routingOrder[5].defaultModel = "doubao-other"; }, /capability manifest.*invalid|routing.*disagree/i],
    ["normalized output", (manifest: any) => { manifest.outputs.normalizedSlide.width = 1280; }, /capability manifest.*invalid|output.*disagree/i],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      const path = join(current.ai, "references", "capabilities.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      mutate(manifest);
      if (name === "script") await writeFile(join(current.ai, "scripts", "other.py"), requiredScriptBytes);
      await writeFile(path, `${JSON.stringify(manifest)}\n`);
      await assert.rejects(resolveSkillDependencies(request(current)), pattern);
    });
  }
});

test("rejects symlinked roots, script ancestors, and required files", async (t) => {
  await t.test("root", async (subtest) => {
    const current = await fixture(subtest);
    const linkedRoot = join(current.root, "linked-ai-skill");
    await symlink(current.ai, linkedRoot);
    await assert.rejects(resolveSkillDependencies({ ...request(current), aiSkillRoot: linkedRoot }), /root must not be a symbolic link/);
  });
  await t.test("external scripts", async (subtest) => {
    const current = await fixture(subtest);
    const external = join(current.root, "external-scripts");
    await mkdir(external);
    await Promise.all(Object.values(requiredScripts).map((script) => writeFile(join(external, script), requiredScriptBytes)));
    await rm(join(current.ai, "scripts"), { recursive: true });
    await symlink(external, join(current.ai, "scripts"));
    await assert.rejects(resolveSkillDependencies(request(current)), /required script is unsafe/);
  });
  await t.test("in-root scripts", async (subtest) => {
    const current = await fixture(subtest);
    const retained = join(current.ai, "real-scripts");
    await rename(join(current.ai, "scripts"), retained);
    await symlink(retained, join(current.ai, "scripts"));
    await assert.rejects(resolveSkillDependencies(request(current)), /required script is unsafe/);
  });
});

test("rejects missing AI Skill and required scripts without fallback", async (t) => {
  await t.test("Skill", async (subtest) => {
    const current = await fixture(subtest);
    await unlink(join(current.ai, "SKILL.md"));
    await assert.rejects(resolveSkillDependencies(request(current)), /Skill entry is missing/);
  });
  await t.test("script", async (subtest) => {
    const current = await fixture(subtest);
    await unlink(join(current.ai, "scripts", requiredScripts.importHostImage));
    await assert.rejects(resolveSkillDependencies(request(current)), /required script is missing: import_host_image\.py/);
  });
});

test("preflight detects changed, removed, or relinked AI identity", async (t) => {
  for (const [name, mutate] of [
    ["changed script", async (current: Fixture) => writeFile(join(current.ai, "scripts", requiredScripts.hostRoutingPolicy), "changed\n")],
    ["removed script", async (current: Fixture) => unlink(join(current.ai, "scripts", requiredScripts.prepareEditableInput))],
    ["linked script ancestor", async (current: Fixture) => {
      const retained = join(current.ai, "retained-scripts");
      await rename(join(current.ai, "scripts"), retained);
      await symlink(retained, join(current.ai, "scripts"));
    }],
  ] as const) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      const resolved = await resolveSkillDependencies(request(current));
      await mutate(current);
      const report = await preflightDependencies(resolved);
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((error) => error.dependency === "ai-image-to-ppt" && error.code === "identity_changed"));
    });
  }
});

test("preflight reports current identities without executing local dependency code", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  const report = await preflightDependencies(resolved);
  assert.equal(report.ok, true);
  assert.equal(report.aiImageToPpt.root, current.ai);
  assert.equal(report.imageToEditablePptx.root, current.editable);
  assert.equal(report.imageToEditablePptx.version, "0.2.0");
  assert.equal(report.imageToEditablePptx.manifestVersion, 2);
  assert.equal(report.imageToEditablePptx.ledgerVersion, 2);
  assert.deepEqual(report.errors, []);
});

test("preflight CLI uses explicit roots and rejects environment or provider fallback", async (t) => {
  const current = await fixture(t);
  const environment = {
    ...process.env,
    SUPERPPT_HOST_CAPABILITIES: JSON.stringify({ source: "agent-host", localFilesystem: true, localFileLinks: true }),
    SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: join(current.root, "environment-ai"),
    SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: join(current.root, "environment-editable"),
  };
  const invoke = (args: string[]) => execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "preflight", ...args], {
    cwd: process.cwd(),
    env: environment,
  });
  const { stdout } = await invoke(["--ai-skill", current.ai, "--editable-skill", current.editable]);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.aiImageToPpt.root, current.ai);
  assert.equal(report.imageToEditablePptx.root, current.editable);
  await assert.rejects(invoke([]), /required CLI flags: --ai-skill --editable-skill/i);
  await assert.rejects(invoke(["--ai-skill", current.ai, "--editable-skill", current.editable, "--provider", "openai"]), /unknown CLI flag: --provider/i);
});
