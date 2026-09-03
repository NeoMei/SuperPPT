import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("verify:full must run through npm so the current npm CLI is known");
}

run(process.execPath, [join(root, "scripts", "verify-contract.mjs")]);
for (const args of [
  ["test"],
  ["run", "lint:types"],
  ["run", "build"],
  ["run", "test:compiled"],
  ["run", "audit:dependencies"],
]) run(process.execPath, [npmExecPath, ...args]);
run("git", ["diff", "--check"]);
