import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const packageJson = await json("package.json");
const manifest = await json(".codex-plugin/plugin.json");

if (packageJson.name !== "superppt" || manifest.name !== "superppt") {
  fail("package and plugin IDs must remain superppt");
}
if (packageJson.version !== manifest.version) {
  fail("package and plugin versions must match");
}
if (packageJson.engines?.node !== ">=22.6") {
  fail("Node engine must remain >=22.6");
}
if (manifest.interface?.displayName !== "SuperPPT") {
  fail("plugin display name must remain SuperPPT");
}

const skill = await readFile("skills/superppt/SKILL.md", "utf8");
if (!/^name: superppt$/m.test(skill)) {
  fail("internal Skill ID must remain superppt");
}
if (!/^# SuperPPT$/m.test(skill)) {
  fail("display heading must remain SuperPPT");
}
if (!skill.includes("风格只能单选")) {
  fail("single-select contract is missing");
}

const roots = [
  ".codex-plugin",
  "skills",
  "src",
  "references",
  "README.md",
  "SECURITY.md",
];
const unfinished = /\[(?:TO\x44O):|\bT\x42D\b|\bFIX\x4dE\b/;

const scan = async (entry) => {
  const stats = await readdir(entry, { withFileTypes: true }).catch(() => null);
  if (stats === null) {
    const content = await readFile(entry, "utf8").catch(() => "");
    if (unfinished.test(content)) fail(`unfinished placeholders found in ${entry}`);
    return;
  }
  for (const item of stats) {
    if (item.name === "node_modules" || item.name === "dist") continue;
    const child = path.join(entry, item.name);
    if (item.isDirectory()) await scan(child);
    else if (item.isFile()) {
      const content = await readFile(child, "utf8").catch(() => "");
      if (unfinished.test(content)) fail(`unfinished placeholders found in ${child}`);
    }
  }
};

for (const root of roots) await scan(root);
console.log("Repository contracts verified.");
