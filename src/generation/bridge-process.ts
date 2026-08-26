import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import type { Stats } from "node:fs";

const MAX_BRIDGE_OUTPUT = 1024 * 1024;

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function openModule(path: string): number {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("provider module is unsafe");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const opened = fstatSync(fd);
  if (!opened.isFile() || !sameIdentity(before, opened)) {
    closeSync(fd);
    throw new Error("provider module is unsafe");
  }
  return fd;
}

export async function runBridge(options: {
  runner: string;
  mode: "generate" | "review";
  modulePath: string;
  callable: string;
  inputFd: number;
  targetFd: number;
  targetPath: string;
  timeoutMs: number;
  afterModuleOpened?: () => Promise<void>;
}): Promise<string> {
  const moduleFd = openModule(options.modulePath);
  const inputArgument = "@fd:3";
  const targetArgument = process.platform === "win32" ? options.targetPath : "/dev/fd/5";
  try {
    await options.afterModuleOpened?.();
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("python3", [
        options.runner,
        options.mode,
        options.modulePath,
        options.callable,
        inputArgument,
        targetArgument,
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", options.inputFd, moduleFd, options.targetFd],
        env: { ...process.env, SUPERPPT_BRIDGE_MODULE_FD: "4" },
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let overflow = false;
      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BRIDGE_OUTPUT) {
          overflow = true;
          child.kill("SIGKILL");
        } else {
          stdout.push(chunk);
        }
      });
      // Drain, but deliberately never surface, provider-controlled stderr.
      child.stderr!.resume();
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("provider bridge execution failed"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || overflow) reject(new Error("provider bridge execution failed"));
        else resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
  } finally {
    closeSync(moduleFd);
  }
}
