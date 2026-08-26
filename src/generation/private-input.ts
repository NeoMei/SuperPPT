import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { GenerationDirectory, openGenerationDirectory } from "./anchored-dir.js";

export function privateSecurityPolicy(platform: NodeJS.Platform = process.platform): {
  directoryMode: 0o700 | undefined;
  fileMode: 0o600 | undefined;
  requireExactMode: boolean;
} {
  return platform === "win32"
    ? { directoryMode: undefined, fileMode: undefined, requireExactMode: false }
    : { directoryMode: 0o700, fileMode: 0o600, requireExactMode: true };
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

export async function withPrivateInput<T>(options: {
  target: string;
  suffix: string;
  value: string;
  parent?: GenerationDirectory;
  beforeExecute?: (path: string) => Promise<void>;
  action: (input: { path: string; fd: number }) => Promise<T>;
}): Promise<T> {
  const ownsParent = options.parent === undefined;
  const parent = options.parent ?? openGenerationDirectory(dirname(options.target));
  let directory: GenerationDirectory | undefined;
  let fd: number | undefined;
  let created = false;
  const name = `${randomUUID()}.${options.suffix}`;
  try {
    directory = parent.child(".private");
    const path = join(directory.path, name);
    directory.writeExclusive(name, options.value);
    created = true;
    fd = directory.openRegular(name);
    parent.assertCurrent();
    directory.assertCurrent();
    await options.beforeExecute?.(path);
    parent.assertCurrent();
    directory.assertCurrent();
    return await options.action({ path, fd });
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { if (directory && created) directory.remove(name); } finally {
      directory?.close();
      if (ownsParent) parent.close();
    }
  }
}
