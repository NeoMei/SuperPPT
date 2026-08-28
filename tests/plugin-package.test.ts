import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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
