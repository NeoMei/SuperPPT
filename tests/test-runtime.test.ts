import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveTestRuntime } from "../scripts/test.js";

function repositoryFile(...segments: string[]): string {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(testDirectory);
  const root = basename(parent) === "dist" ? dirname(parent) : parent;
  return join(root, ...segments);
}

test("test runtime uses the current Node and SuperPPT dependencies", async () => {
  const expected = {
    node: process.execPath,
    nodeModules: join(process.cwd(), "node_modules"),
    binDir: join(process.cwd(), "node_modules", ".bin"),
  };
  const actual = await resolveTestRuntime({});
  assert.deepEqual(actual, expected);
});

test("test runner source forbids Codex runtime fallback", async () => {
  const source = await readFile(repositoryFile("scripts", "test.ts"), "utf8");
  assert.doesNotMatch(source, /codex-runtimes|codex-primary-runtime|artifact-tool/);
});
