import { spawn } from "node:child_process";

const child = spawn(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "tests/release-install.test.ts",
], {
  cwd: process.cwd(),
  env: { ...process.env, SUPERPPT_RELEASE_SMOKE: "1" },
  stdio: "inherit",
});

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`release install smoke exited from signal ${signal}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
