import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
