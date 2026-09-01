import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type TestRuntime = {
  node: string;
  nodeModules: string;
  binDir: string;
};

const RUNTIME_ENVIRONMENT = [
  "RUNTIME_NODE",
  "RUNTIME_NODE_MODULES",
  "RUNTIME_BIN_DIR",
] as const;

async function requireRuntimeEntry(
  path: string,
  label: string,
  kind: "file" | "directory",
): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || (kind === "file" ? !metadata.isFile() : !metadata.isDirectory())) {
    throw new Error(`${label} must be a non-symlink ${kind}: ${path}`);
  }
}

async function validateRuntime(runtime: TestRuntime): Promise<TestRuntime> {
  await requireRuntimeEntry(runtime.node, "RUNTIME_NODE", "file");
  await requireRuntimeEntry(runtime.nodeModules, "RUNTIME_NODE_MODULES", "directory");
  await requireRuntimeEntry(runtime.binDir, "RUNTIME_BIN_DIR", "directory");
  await requireRuntimeEntry(
    join(runtime.nodeModules, "@oai", "artifact-tool", "package.json"),
    "workspace runtime artifact-tool package",
    "file",
  );
  return runtime;
}

export async function resolveTestRuntime(
  environment: NodeJS.ProcessEnv,
  options: { homeDirectory?: string } = {},
): Promise<TestRuntime> {
  const configured = RUNTIME_ENVIRONMENT.filter((name) => environment[name] !== undefined);
  if (configured.length > 0 && configured.length !== RUNTIME_ENVIRONMENT.length) {
    throw new Error("RUNTIME_NODE, RUNTIME_NODE_MODULES, and RUNTIME_BIN_DIR must all be set together");
  }
  if (configured.length === RUNTIME_ENVIRONMENT.length) {
    return validateRuntime({
      node: environment.RUNTIME_NODE!,
      nodeModules: environment.RUNTIME_NODE_MODULES!,
      binDir: environment.RUNTIME_BIN_DIR!,
    });
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const cacheRoot = environment.XDG_CACHE_HOME === undefined
    ? join(homeDirectory, ".cache")
    : environment.XDG_CACHE_HOME;
  if (!isAbsolute(cacheRoot)) throw new Error("XDG_CACHE_HOME must be absolute when set");
  const dependencies = join(
    resolve(cacheRoot),
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
  );
  try {
    return await validateRuntime({
      node: join(dependencies, "node", "bin", "node"),
      nodeModules: join(dependencies, "node", "node_modules"),
      binDir: join(dependencies, "bin", "override"),
    });
  } catch (error: unknown) {
    throw new Error(
      "SuperPPT tests require the Codex workspace runtime; set all three RUNTIME_* paths from load_workspace_dependencies",
      { cause: error },
    );
  }
}

export async function runTests(
  environment: NodeJS.ProcessEnv = process.env,
  options: { compiled?: boolean } = {},
): Promise<number> {
  const runtime = await resolveTestRuntime(environment);
  const testArguments = options.compiled
    ? ["--experimental-detect-module", "--test", "dist/tests/*.test.js"]
    : ["--import", "tsx", "--test", "tests/*.test.ts"];
  const child = spawn(process.execPath, testArguments, {
    cwd: process.cwd(),
    env: {
      ...environment,
      RUNTIME_NODE: runtime.node,
      RUNTIME_NODE_MODULES: runtime.nodeModules,
      RUNTIME_BIN_DIR: runtime.binDir,
    },
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
