import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const fail = (message) => {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
};

const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if ((flag !== "--root" && flag !== "--tag") || value === undefined || values.has(flag)) {
    fail("usage: verify-release.mjs --root <absolute-root> --tag <vSEMVER>");
  }
  values.set(flag, value);
}
if (values.size !== 2) fail("usage: verify-release.mjs --root <absolute-root> --tag <vSEMVER>");

const requestedRoot = values.get("--root");
if (!isAbsolute(requestedRoot)) fail("release root must be absolute");
const root = await realpath(requestedRoot).catch(() => fail("release root is unavailable"));
const rootInfo = await lstat(root);
if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("release root must be a real directory");

const inside = (path) => {
  const local = relative(root, path);
  return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
};

const readOwnedJson = async (localPath) => {
  const path = resolve(root, localPath);
  if (!inside(path)) fail(`release metadata path escapes the root: ${localPath}`);
  const info = await lstat(path).catch(() => fail(`release metadata is missing: ${localPath}`));
  if (info.isSymbolicLink() || !info.isFile()) fail(`release metadata is unsafe: ${localPath}`);
  const physical = await realpath(path).catch(() => fail(`release metadata is unsafe: ${localPath}`));
  if (physical !== path || !inside(physical)) fail(`release metadata is unsafe: ${localPath}`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`release metadata is not valid JSON: ${localPath}`);
  }
};

const [pkg, lock, plugin, marketplace, ci, release] = await Promise.all([
  readOwnedJson("package.json"),
  readOwnedJson("package-lock.json"),
  readOwnedJson(".codex-plugin/plugin.json"),
  readOwnedJson(".agents/plugins/marketplace.json"),
  readOwnedJson(".github/workflows/ci.yml"),
  readOwnedJson(".github/workflows/release.yml"),
]);

const repository = "https://github.com/NeoMei/SuperPPT";
const repositoryGit = `${repository}.git`;
if (pkg.name !== "superppt" || plugin.name !== "superppt") fail("package and plugin IDs must be superppt");
if (
  pkg.author?.name !== "NeoMei"
  || pkg.author?.url !== "https://github.com/NeoMei"
  || pkg.license !== "MIT"
  || pkg.repository?.type !== "git"
  || pkg.repository?.url !== `git+${repositoryGit}`
  || pkg.homepage !== `${repository}#readme`
  || pkg.bugs?.url !== `${repository}/issues`
) fail("package publication metadata must bind NeoMei/SuperPPT and MIT");
if (typeof pkg.version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(pkg.version)) {
  fail("release version must be stable semantic versioning");
}
if (plugin.version !== pkg.version || lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
  fail("package, lockfile, and plugin versions must match");
}
const expectedTag = `v${pkg.version}`;
if (values.get("--tag") !== expectedTag) fail(`release tag must be ${expectedTag}`);
if (pkg.private !== true) fail("SuperPPT V1 is GitHub-only and package.json private must remain true");
if (plugin.repository !== repository || plugin.homepage !== `${repository}#readme` || plugin.interface?.websiteURL !== repository) {
  fail("plugin repository metadata must bind NeoMei/SuperPPT");
}
if (plugin.skills !== "./skills/" || plugin.interface?.displayName !== "SuperPPT") {
  fail("plugin entrypoint and display identity are invalid");
}

const marketplaceEntry = marketplace.plugins?.find((entry) => entry?.name === "superppt");
if (
  marketplace.name !== "superppt"
  || marketplaceEntry?.source?.source !== "url"
  || marketplaceEntry.source.url !== repositoryGit
  || marketplaceEntry.source.ref !== "main"
  || marketplaceEntry.policy?.installation !== "AVAILABLE"
  || marketplaceEntry.policy?.authentication !== "ON_INSTALL"
) fail("marketplace must publish SuperPPT from NeoMei/SuperPPT main with explicit install policy");

const portableOs = ["ubuntu-latest", "macos-latest", "windows-latest"];
const ciJob = ci.jobs?.portable;
if (
  ci.name !== "CI"
  || JSON.stringify(ci.on) !== JSON.stringify({ push: { branches: ["main"] }, pull_request: {} })
  || ci.permissions?.contents !== "read"
  || JSON.stringify(ciJob?.strategy?.matrix?.os) !== JSON.stringify(portableOs)
  || ciJob?.["runs-on"] !== "${{ matrix.os }}"
  || !Number.isInteger(ciJob?.["timeout-minutes"])
  || ciJob["timeout-minutes"] < 10
  || ciJob["timeout-minutes"] > 30
  || !ciJob.steps?.some((step) => step.run === "npm ci")
  || !ciJob.steps?.some((step) => step.run === "npm run verify:portable")
  || ciJob.steps?.some((step) => String(step.run ?? "").includes("scripts/verify.sh"))
) fail("public CI must run the portable gate on the exact three-OS matrix");

const releaseJob = release.jobs?.release;
const releaseRuns = releaseJob?.steps?.map((step) => step.run).filter(Boolean) ?? [];
if (
  release.name !== "Release"
  || JSON.stringify(release.on) !== JSON.stringify({ push: { tags: ["v*"] } })
  || release.permissions?.contents !== "write"
  || release.permissions?.["id-token"] !== "write"
  || release.permissions?.attestations !== "write"
  || release.permissions?.["artifact-metadata"] !== "write"
  || releaseJob?.["runs-on"] !== "ubuntu-latest"
  || !releaseJob.steps?.some((step) => step.run === "npm run verify:portable")
  || !releaseJob.steps?.some((step) => step.run === "npm run test:release-install")
  || !releaseRuns.some((run) => run.includes("npm run release:check -- --root") && run.includes("$GITHUB_REF_NAME"))
  || !releaseRuns.some((run) => run.includes("npm pack --pack-destination release-artifacts"))
  || !releaseRuns.some((run) => run.includes("sha256sum") && run.includes("SHA256SUMS"))
  || !releaseJob.steps?.some((step) => step.uses === "actions/attest@v4" && step.with?.["subject-path"] === "release-artifacts/*")
  || !releaseRuns.some((run) => run.includes("gh release create") && run.includes("--verify-tag"))
) fail("tag release workflow must verify, package, checksum, attest, and publish one GitHub Release");

const scripts = pkg.scripts ?? {};
if (
  scripts["verify:full"] !== "node scripts/verify-full.mjs"
  || !String(scripts["test:portable"] ?? "").includes("tests/publication.test.ts")
  || !String(scripts["test:portable:compiled"] ?? "").includes("dist/tests/publication.test.js")
  || !String(scripts["verify:portable"] ?? "").includes("test:portable")
  || !String(scripts["verify:portable"] ?? "").includes("test:portable:compiled")
  || scripts["release:check"] !== "node scripts/verify-release.mjs"
  || scripts["test:release-install"] !== "node scripts/run-release-install-smoke.mjs"
) fail("package scripts must expose distinct portable, full-runtime, and release gates");

process.stdout.write(`${JSON.stringify({
  ok: true,
  package: pkg.name,
  version: pkg.version,
  tag: expectedTag,
  repository,
  publication: "github-release",
  npmPublication: false,
  portableCiOs: portableOs,
  fullRuntimeGate: scripts["verify:full"],
}, null, 2)}\n`);
