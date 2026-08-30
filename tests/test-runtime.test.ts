import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { resolveTestRuntime } from "../scripts/test.js";

async function runtimeFixture(t: TestContext, root: string) {
  const node = join(root, "dependencies", "node", "bin", "node");
  const nodeModules = join(root, "dependencies", "node", "node_modules");
  const binDir = join(root, "dependencies", "bin", "override");
  await mkdir(join(root, "dependencies", "node", "bin"), { recursive: true });
  await mkdir(join(nodeModules, "@oai", "artifact-tool"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(node, "fixture node");
  await writeFile(join(nodeModules, "@oai", "artifact-tool", "package.json"), "{}\n");
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { node, nodeModules, binDir };
}

test("test runtime uses one complete explicit path set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "superppt-explicit-runtime-"));
  const expected = await runtimeFixture(t, root);
  const actual = await resolveTestRuntime({
    RUNTIME_NODE: expected.node,
    RUNTIME_NODE_MODULES: expected.nodeModules,
    RUNTIME_BIN_DIR: expected.binDir,
  }, { homeDirectory: join(root, "missing-home") });
  assert.deepEqual(actual, expected);
});

test("test runtime rejects a partial explicit path set", async () => {
  await assert.rejects(resolveTestRuntime({
    RUNTIME_NODE: "/absolute/node",
  }, { homeDirectory: "/absolute/missing-home" }), /all be set together/);
});

test("test runtime resolves the validated Codex primary bundle from the cache root", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "superppt-codex-cache-"));
  t.after(async () => rm(cache, { recursive: true, force: true }));
  const root = join(cache, "codex-runtimes", "codex-primary-runtime");
  const expected = await runtimeFixture(t, root);
  const actual = await resolveTestRuntime({ XDG_CACHE_HOME: cache }, { homeDirectory: join(cache, "unused-home") });
  assert.deepEqual(actual, expected);
});

test("test runtime rejects a bundle without artifact-tool", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "superppt-incomplete-runtime-"));
  const expected = await runtimeFixture(t, root);
  await rm(join(expected.nodeModules, "@oai"), { recursive: true, force: true });
  await assert.rejects(resolveTestRuntime({
    RUNTIME_NODE: expected.node,
    RUNTIME_NODE_MODULES: expected.nodeModules,
    RUNTIME_BIN_DIR: expected.binDir,
  }, { homeDirectory: join(root, "missing-home") }), /artifact-tool/);
});
