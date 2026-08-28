import { closeSync, constants, fstatSync, fsyncSync, readFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { GenerationDirectory, openGenerationDirectory } from "./anchored-dir.js";
import { cleanupAbandonedProviderFiles, ownedTemporaryName } from "./abandoned.js";

export function privateSecurityPolicy(platform: NodeJS.Platform = process.platform): {
  directoryMode: 0o700 | undefined;
  fileMode: 0o600 | undefined;
  requireExactMode: boolean;
  transport: "unlinked-regular-file" | "anonymous-pipe";
} {
  return platform === "win32"
    ? { directoryMode: undefined, fileMode: undefined, requireExactMode: false, transport: "anonymous-pipe" }
    : { directoryMode: 0o700, fileMode: 0o600, requireExactMode: true, transport: "unlinked-regular-file" };
}

export function readPrivateInputFile(path: string): Buffer {
  const directory = openGenerationDirectory(dirname(path));
  let fd: number | undefined;
  try {
    fd = directory.openRegular(basename(path));
    const policy = privateSecurityPolicy();
    if (policy.requireExactMode && (fstatSync(fd).mode & 0o777) !== policy.fileMode) {
      throw new Error("private input must have mode 0600");
    }
    return readFileSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    directory.close();
  }
}

export function appendPrivateInputLine(path: string, value: string): void {
  if (!value || value.includes("\n") || value.includes("\r")) {
    throw new Error("private append value must be one non-empty line");
  }
  const directory = openGenerationDirectory(dirname(path));
  let fd: number | undefined;
  try {
    try {
      fd = directory.openRegular(basename(path), constants.O_WRONLY | constants.O_APPEND);
      const policy = privateSecurityPolicy();
      if (policy.requireExactMode && (fstatSync(fd).mode & 0o777) !== policy.fileMode) {
        throw new Error("private append target must have mode 0600");
      }
      writeSync(fd, `${value}\n`);
      fsyncSync(fd);
      directory.assertCurrent();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      directory.writeExclusive(basename(path), `${value}\n`);
      if (directory.fd >= 0) fsyncSync(directory.fd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    directory.close();
  }
}

export async function withPrivateInput<T>(options: {
  target: string;
  suffix: string;
  value: string;
  parent?: GenerationDirectory;
  beforeExecute?: (path: string) => Promise<void>;
  action: (input: { path: string; fd: number; value: string }) => Promise<T>;
}): Promise<T> {
  if (privateSecurityPolicy().transport === "anonymous-pipe") {
    await options.beforeExecute?.("@anonymous-private-input");
    return options.action({ path: "@anonymous-private-input", fd: -1, value: options.value });
  }
  const ownsParent = options.parent === undefined;
  const parent = options.parent ?? openGenerationDirectory(dirname(options.target));
  let directory: GenerationDirectory | undefined;
  let fd: number | undefined;
  let created = false;
  const name = ownedTemporaryName(options.suffix);
  try {
    directory = parent.child(".private");
    cleanupAbandonedProviderFiles(parent);
    const path = join(directory.path, name);
    directory.writeExclusive(name, options.value);
    created = true;
    fd = directory.openRegular(name);
    parent.assertCurrent();
    directory.assertCurrent();
    await options.beforeExecute?.(path);
    parent.assertCurrent();
    directory.assertCurrent();
    // POSIX children consume the already-opened descriptor. Removing its directory
    // entry before spawn leaves no plaintext pathname behind if the orchestrator dies.
    if (process.platform !== "win32") {
      directory.remove(name);
      created = false;
    }
    return await options.action({ path, fd, value: options.value });
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { if (directory && created) directory.remove(name); } finally {
      directory?.close();
      if (ownsParent) parent.close();
    }
  }
}
