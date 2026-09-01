import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const enabled = process.env.SUPERPPT_RELEASE_SMOKE === "1";

test("the release archive installs without dev dependencies and starts the real CLI", {
  skip: enabled ? false : "release archive smoke is an explicit release gate",
  timeout: 180_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "superppt-release-install-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const archiveDirectory = join(root, "archive");
  const consumer = join(root, "consumer");
  const npmUserConfig = join(root, "npmrc");
  await Promise.all([mkdir(archiveDirectory), mkdir(consumer)]);
  await writeFile(npmUserConfig, "");
  const npmEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
  };
  delete npmEnvironment.NPM_CONFIG_ALLOW_SCRIPTS;
  delete npmEnvironment.npm_config_allow_scripts;

  const packed = await execFileAsync("npm", ["pack", "--pack-destination", archiveDirectory, "--json"], {
    cwd: process.cwd(),
    env: npmEnvironment,
    maxBuffer: 4 * 1024 * 1024,
  });
  const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const archive = join(archiveDirectory, filename);
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
  await execFileAsync("npm", ["install", "--omit=dev", archive], {
    cwd: consumer,
    env: npmEnvironment,
    maxBuffer: 4 * 1024 * 1024,
  });

  const installedRoot = join(consumer, "node_modules", "superppt");
  const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(installedPackage.version, "0.1.0");
  await assert.rejects(
    execFileAsync("npm", ["run", "cli", "--", "release-smoke-invalid"], {
      cwd: installedRoot,
      env: {
        ...npmEnvironment,
        SUPERPPT_HOST_CAPABILITIES: JSON.stringify({
          source: "agent-host",
          localFilesystem: true,
          localFileLinks: true,
        }),
      },
      maxBuffer: 4 * 1024 * 1024,
    }),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? "", /unknown command: release-smoke-invalid/);
      assert.doesNotMatch(error.stderr ?? "", /tsx: (?:command )?not found|ERR_MODULE_NOT_FOUND/);
      return true;
    },
  );
});
