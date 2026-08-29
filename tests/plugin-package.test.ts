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
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.engines.node, ">=22.6");
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
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
  const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = packed[0]!.files.map(({ path }) => path);
  assert.ok(paths.includes("src/cli.ts"));
  assert.ok(paths.includes("skills/superppt/SKILL.md"));
  assert.ok(paths.every((path) => !path.startsWith("dist/")));
  assert.ok(paths.every((path) => !/(?:provider|bridge-process|run_ai_image_provider|fake_ai_provider)/i.test(path)));
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
