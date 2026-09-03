import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function verifyRelease(tag: string) {
  return execFileAsync(process.execPath, [
    "scripts/verify-release.mjs",
    "--root",
    process.cwd(),
    "--tag",
    tag,
  ], {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("release readiness authenticates the exact GitHub-only plugin publication contract", async () => {
  const { stdout, stderr } = await verifyRelease("v0.1.2");

  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    package: "superppt",
    version: "0.1.2",
    tag: "v0.1.2",
    repository: "https://github.com/NeoMei/SuperPPT",
    publication: "github-release",
    npmPublication: false,
    portableCiOs: ["ubuntu-latest", "macos-latest", "windows-latest"],
    fullRuntimeGate: "node scripts/verify-full.mjs",
  });
});

test("release readiness rejects a tag that does not exactly match the plugin version", async () => {
  await assert.rejects(
    verifyRelease("v0.1.3"),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? "", /release tag must be v0\.1\.2/);
      return true;
    },
  );
});
