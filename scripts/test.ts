import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type TestRuntime = {
  node: string;
  nodeModules: string;
  binDir: string;
};

export async function resolveTestRuntime(
  _environment: NodeJS.ProcessEnv,
): Promise<TestRuntime> {
  const nodeModules = join(process.cwd(), "node_modules");
  return {
    node: process.execPath,
    nodeModules,
    binDir: join(nodeModules, ".bin"),
  };
}

export async function runTests(
  environment: NodeJS.ProcessEnv = process.env,
  options: { compiled?: boolean } = {},
): Promise<number> {
  const runtime = await resolveTestRuntime(environment);
  const testArguments = options.compiled
    ? ["--experimental-detect-module", "--test", "dist/tests/*.test.js"]
    : ["--import", "tsx", "--test", "tests/*.test.ts"];
  const child = spawn(runtime.node, testArguments, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  return new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`test runner exited from signal ${signal}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--compiled")) {
    process.stderr.write("usage: test.ts [--compiled]\n");
    process.exitCode = 1;
  } else runTests(process.env, { compiled: arguments_.includes("--compiled") })
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
