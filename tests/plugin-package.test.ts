import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

test("packages the approved SuperPPT identity", async () => {
  const [pkg, plugin, skill, ui] = await Promise.all([
    json("package.json"),
    json(".codex-plugin/plugin.json"),
    readFile("skills/superppt/SKILL.md", "utf8"),
    readFile("skills/superppt/agents/openai.yaml", "utf8"),
  ]);

  assert.equal(pkg.name, "superppt");
  assert.equal(pkg.version, "0.1.2");
  assert.equal(pkg.engines.node, ">=22.6");
  assert.deepEqual(pkg.author, { name: "NeoMei", url: "https://github.com/NeoMei" });
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "git+https://github.com/NeoMei/SuperPPT.git",
  });
  assert.equal(pkg.homepage, "https://github.com/NeoMei/SuperPPT#readme");
  assert.deepEqual(pkg.bugs, { url: "https://github.com/NeoMei/SuperPPT/issues" });
  assert.equal(plugin.name, "superppt");
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.interface.displayName, "SuperPPT");
  assert.equal(plugin.repository, "https://github.com/NeoMei/SuperPPT");
  assert.match(skill, /^name: superppt$/m);
  assert.match(skill, /^# SuperPPT$/m);
  assert.match(ui, /display_name: "SuperPPT"/);
  assert.match(ui, /default_prompt: "[^"]*\$superppt[^"]*"/);
  assert.match(ui, /allow_implicit_invocation: true/);
  for (const line of ui.split("\n")) {
    const value = line.match(/^\s*[a-z_]+:\s*(.+)$/)?.[1];
    if (value && value !== "true" && value !== "false") {
      assert.match(value, /^".*"$/, `openai.yaml string must be quoted: ${line}`);
    }
  }
  assert.doesNotMatch(`${skill}\n${ui}`, new RegExp(`\\[${"TO" + "DO"}:|${"T" + "BD"}`));
});

test("the shipped module surface contains no executable provider bridge or direct-generation compatibility API", async () => {
  const [batch, dependencies, preflight, deck] = await Promise.all([
    import("../src/generation/batch.js"),
    import("../src/dependencies/resolve.js"),
    import("../src/dependencies/preflight.js"),
    import("../src/deck/assemble.js"),
  ]);
  for (const [module, names] of [
    [batch, ["runBatch", "describeLegacyProjectGeneration", "generateProject", "retryProjectPage", "recordManualQa"]],
    [dependencies, ["resolveDependencies", "resolveFromSkillEntries"]],
    [preflight, ["preflightLegacyDependencies"]],
    [deck, ["assembleProject"]],
  ] as const) {
    for (const name of names) assert.equal(name in module, false, name);
  }
  for (const path of [
    "src/generation/provider.ts",
    "src/generation/bridge-process.ts",
    "scripts/run_ai_image_provider.py",
    "tests/fixtures/fake_ai_provider.py",
  ]) {
    await assert.rejects(access(path), { code: "ENOENT" }, path);
  }
});

test("package allowlist and dry-run exclude build leftovers and removed provider paths", async () => {
  const [pkg, dependencies] = await Promise.all([
    json("package.json"),
    json("references/dependencies.json"),
  ]);
  assert.deepEqual(pkg.files, [
    ".codex-plugin/",
    "skills/",
    "src/",
    "scripts/",
    "references/",
    "README.md",
    "SECURITY.md",
    "LICENSE",
    "package-lock.json",
    "tsconfig.json",
  ]);
  const npmCli = process.env.npm_execpath;
  const { stdout } = await execFileAsync(
    npmCli ? process.execPath : "npm",
    npmCli ? [npmCli, "pack", "--dry-run", "--json"] : ["pack", "--dry-run", "--json"],
    {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
  const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = packed[0]!.files.map(({ path }) => path);
  for (const required of [
    "skills/superppt/SKILL.md",
    "skills/superppt/references/阶段契约.json",
    "references/dependencies.json",
    "src/cli.ts",
    "src/deck-revisions/workflow.ts",
    "src/deck-revisions/store.ts",
    "src/deck-revisions/topology.ts",
    "src/deck-revisions/edit-slide.ts",
    "src/editable/route.ts",
  ]) assert.ok(paths.includes(required), `package is missing ${required}`);
  assert.ok(paths.every((path) => !path.startsWith("dist/")));
  assert.ok(paths.every((path) => !/(?:provider|bridge-process|run_ai_image_provider|fake_ai_provider)/i.test(path)));
  const generatedArtifact = (path: string): boolean => {
    if (path.startsWith("skills/superppt/assets/styles/previews/")) return false;
    return /(?:\.pptx$|\.pdf$|montage|(?:^|\/)(?:preview|previews)(?:\/|\.|-)|user[-_ ]?edit|single[-_ ]?(?:page|slide)|slide-editable|(?:^|\/)staging(?:\/|$)|\.staging(?:\.|\/|$))/i.test(path);
  };
  assert.deepEqual(paths.filter(generatedArtifact), [], "package must exclude generated/user edit and review artifacts");
  assert.equal(paths.includes("scripts/acceptance-smoke.sh"), false, "legacy smoke-copy script must not ship");
  assert.equal(paths.includes("src/acceptance/smoke-copy.ts"), false, "legacy smoke-copy implementation must not ship");
  const cli = await readFile("src/cli.ts", "utf8");
  assert.doesNotMatch(cli, /command === "acceptance(?:-(?:smoke-copy|record))?"/);
  const [store, deck, trusted] = await Promise.all([
    import("../src/project/store.js"),
    import("../src/deck/assemble.js"),
    import("../src/generation/trusted-authorization.js"),
  ]);
  for (const legacy of [
    "createClientSmokeCopyAnchor",
    "recordClientAcceptance",
    "readProjectAcceptance",
    "commitTrustedClientAcceptancePending",
    "completeTrustedClientAcceptance",
    "readTrustedClientAcceptanceCommitment",
  ]) {
    assert.equal(legacy in store || legacy in deck || legacy in trusted, false, `legacy acceptance API ${legacy} must not be public`);
  }
  assert.deepEqual(dependencies.dependencies.map((dependency: Record<string, unknown>) => ({
    skill: dependency.skill,
    cliFlag: dependency.cliFlag,
    resolution: dependency.resolution,
  })), [
    { skill: "ai-image-to-ppt", cliFlag: "--ai-skill", resolution: "explicit-only" },
    { skill: "image-to-editable-pptx", cliFlag: "--editable-skill", resolution: "explicit-only" },
  ]);
  assert.doesNotMatch(JSON.stringify(dependencies), /SUPERPPT_.*_SOURCE|"override"/);
});

test("runtime package and dependency authority expose only the two full-deck capabilities", async () => {
  const [pkg, contract] = await Promise.all([
    json("package.json"),
    json("references/dependencies.json"),
  ]);

  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "jszip",
    "koffi",
    "pptxgenjs",
    "saxes",
    "sharp",
    "tsx",
    "zod",
  ]);
  assert.deepEqual({
    jszip: pkg.dependencies.jszip,
    pptxgenjs: pkg.dependencies.pptxgenjs,
  }, {
    jszip: "3.10.1",
    pptxgenjs: "4.0.1",
  });
  assert.equal(pkg.devDependencies.typescript, "^5.9.0");
  assert.deepEqual(contract.dependencies.map((entry: Record<string, unknown>) => entry.skill), [
    "ai-image-to-ppt",
    "image-to-editable-pptx",
  ]);
  assert.deepEqual(contract.dependencies[0].capabilityManifest, {
    path: "references/capabilities.json",
    schemaVersion: 1,
    contracts: {
      generationResult: 1,
      serialStickyRouterReport: 1,
      hostImageImport: 1,
      editableInput: 1,
    },
    scripts: {
      generationResult: "scripts/generation_result.py",
      hostRoutingPolicy: "scripts/host_routing_policy.py",
      importHostImage: "scripts/import_host_image.py",
      prepareEditableInput: "scripts/prepare_editable_input.py",
      apiGenerator: "scripts/gen_slide.py",
      normalizedExport: "scripts/export_images.py",
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
  });
  assert.equal(contract.contractVersion, 3);
  assert.deepEqual(contract.dependencies[1].consumerProfile, {
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
  });
  for (const path of [
    "src/deck/pdf.ts",
    "src/deck/montage.ts",
    "src/editable/preview-image.ts",
    "src/editable/render.ts",
  ]) {
    await assert.rejects(access(path), { code: "ENOENT" }, path);
  }
});
