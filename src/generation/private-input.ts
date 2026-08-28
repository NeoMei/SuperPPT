import { closeSync, constants, fstatSync, fsyncSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { openGenerationDirectory } from "./anchored-dir.js";

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
