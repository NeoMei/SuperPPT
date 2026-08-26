import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import type { Stats } from "node:fs";
import { Writable } from "node:stream";

const MAX_BRIDGE_OUTPUT = 1024 * 1024;

export function bridgeContainmentPolicy(platform: NodeJS.Platform = process.platform): {
  detached: boolean;
  killProcessGroup: boolean;
  windowsJobObject: boolean;
} {
  return platform === "win32"
    ? { detached: false, killProcessGroup: false, windowsJobObject: true }
    : { detached: true, killProcessGroup: true, windowsJobObject: false };
}

function terminateBridge(child: ChildProcess): void {
  const policy = bridgeContainmentPolicy();
  if (policy.killProcessGroup && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall through */ }
  }
  child.kill("SIGKILL");
}

function extraWritable(child: ChildProcess, index: number): Writable {
  const streams: readonly unknown[] = child.stdio;
  const stream = streams[index];
  if (!(stream instanceof Writable)) {
    terminateBridge(child);
    throw new Error("provider bridge containment unavailable");
  }
  return stream;
}

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
  inputValue: string;
  targetFd: number;
  targetPath: string;
  timeoutMs: number;
  maximumTargetBytes?: number;
  afterModuleOpened?: () => Promise<void>;
}): Promise<string> {
  const moduleFd = openModule(options.modulePath);
  const inputArgument = "@fd:3";
  const targetArgument = process.platform === "win32" ? options.targetPath : "/dev/fd/5";
  try {
    await options.afterModuleOpened?.();
    return await new Promise<string>((resolve, reject) => {
      const policy = bridgeContainmentPolicy();
      const child = spawn("python3", [
        options.runner,
        options.mode,
        options.modulePath,
        options.callable,
        inputArgument,
        targetArgument,
      ], {
        windowsHide: true,
        detached: policy.detached,
        stdio: ["ignore", "pipe", "pipe", policy.windowsJobObject ? "pipe" : options.inputFd, moduleFd, options.targetFd, "pipe"],
        env: {
          ...process.env,
          SUPERPPT_BRIDGE_MODULE_FD: "4",
          ...(options.maximumTargetBytes === undefined ? {} : {
            SUPERPPT_BRIDGE_MAX_OUTPUT_BYTES: String(options.maximumTargetBytes),
          }),
        },
      });
      if (policy.windowsJobObject) {
        const privatePipe = extraWritable(child, 3);
        privatePipe.on("error", () => undefined);
        privatePipe.end(options.inputValue);
      }
      // The parent owns the only write end. Parent exit (normal or forced)
      // closes it in the OS; the bridge treats EOF as an unconditional death signal.
      const parentLiveness = extraWritable(child, 6);
      parentLiveness.on("error", () => undefined);
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let overflow = false;
      let targetLimitExceeded = false;
      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BRIDGE_OUTPUT) {
          overflow = true;
          terminateBridge(child);
        } else {
          stdout.push(chunk);
        }
      });
      // Drain, but deliberately never surface, provider-controlled stderr.
      child.stderr!.resume();
      const timer = setTimeout(() => terminateBridge(child), options.timeoutMs);
      const targetMonitor = options.maximumTargetBytes === undefined ? undefined : setInterval(() => {
        try {
          if (fstatSync(options.targetFd).size > options.maximumTargetBytes!) {
            targetLimitExceeded = true;
            terminateBridge(child);
          }
        } catch {
          targetLimitExceeded = true;
          terminateBridge(child);
        }
      }, 5);
      child.once("error", () => {
        clearTimeout(timer);
        if (targetMonitor) clearInterval(targetMonitor);
        reject(new Error("provider bridge execution failed"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (targetMonitor) clearInterval(targetMonitor);
        if (code !== 0 || overflow || targetLimitExceeded) reject(new Error("provider bridge execution failed"));
        else resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
  } finally {
    closeSync(moduleFd);
  }
}
