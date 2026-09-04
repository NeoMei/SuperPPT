import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACTION_PINS = {
  checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  attest: "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
  uploadArtifact: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  downloadArtifact: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
} as const;

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
  const { stdout, stderr } = await verifyRelease("v0.1.3");

  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    package: "superppt",
    version: "0.1.3",
    tag: "v0.1.3",
    repository: "https://github.com/NeoMei/SuperPPT",
    publication: "github-release",
    npmPublication: false,
    portableCiOs: ["ubuntu-latest", "macos-latest", "windows-latest"],
    fullRuntimeGate: "node scripts/verify-full.mjs",
  });
});

test("release readiness rejects a tag that does not exactly match the plugin version", async () => {
  await assert.rejects(
    verifyRelease("v0.1.2"),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? "", /release tag must be v0\.1\.3/);
      return true;
    },
  );
});

test("CI and release workflows pin third-party actions to reviewed commits", async () => {
  const [ci, release] = await Promise.all([
    readFile(".github/workflows/ci.yml", "utf8").then(JSON.parse),
    readFile(".github/workflows/release.yml", "utf8").then(JSON.parse),
  ]);
  const ciUses = ci.jobs.portable.steps.flatMap((step: { uses?: string }) => step.uses ? [step.uses] : []);
  const buildUses = release.jobs.build.steps.flatMap((step: { uses?: string }) => step.uses ? [step.uses] : []);
  const publishUses = release.jobs.publish.steps.flatMap((step: { uses?: string }) => step.uses ? [step.uses] : []);

  assert.deepEqual(ciUses, [ACTION_PINS.checkout, ACTION_PINS.setupNode]);
  assert.deepEqual(buildUses, [ACTION_PINS.checkout, ACTION_PINS.setupNode, ACTION_PINS.uploadArtifact]);
  assert.deepEqual(publishUses, [ACTION_PINS.downloadArtifact, ACTION_PINS.attest]);
});

test("release builds without write authority and publishes without repository code execution", async () => {
  const release = JSON.parse(await readFile(".github/workflows/release.yml", "utf8"));
  const build = release.jobs.build;
  const publish = release.jobs.publish;

  assert.deepEqual(release.permissions, { contents: "read" });
  assert.deepEqual(build.permissions, { contents: "read" });
  assert.deepEqual(publish.permissions, {
    contents: "write",
    "id-token": "write",
    attestations: "write",
    "artifact-metadata": "write",
  });
  assert.deepEqual(publish.needs, ["build"]);
  assert.equal(publish.steps.some((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@")), false);
  assert.equal(publish.steps.some((step: { run?: string }) => /npm (?:ci|run|pack)/.test(step.run ?? "")), false);
});

test("repository ignores the exact failed initialization evidence directory shape", async () => {
  const ignored = await execFileAsync("git", [
    "check-ignore",
    "--no-index",
    ".demo.superppt-init-10000000-0000-4000-8000-000000000001.failed-run/evidence.json",
  ], { cwd: process.cwd() });
  assert.match(ignored.stdout, /\.failed-run\/evidence\.json/);
});

test("macOS handoff guidance keeps provider credentials ephemeral", async () => {
  const guide = await readFile("docs/macOS交接与接力开发指南.md", "utf8");
  assert.doesNotMatch(guide, /~\/\.secrets|export\s+DASHSCOPE_API_KEY\s*=/);
  assert.match(guide, /macOS 钥匙串|Keychain/i);
  assert.match(guide, /只注入需要它的受控子进程/);
  assert.match(guide, /撤销.*轮换|轮换.*撤销/);
});
