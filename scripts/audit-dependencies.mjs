import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  fail("dependency audit must run through npm so npm_execpath is authenticated");
} else {
  const audit = spawnSync(process.execPath, [npmExecPath, "audit", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (audit.error) throw audit.error;
  if (audit.status === 0) {
    process.stdout.write("Dependency audit passed with no known vulnerabilities.\n");
  } else {
    fail(audit.stdout || audit.stderr || "npm audit failed");
  }
}
