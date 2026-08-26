import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { GenerationDirectory, openGenerationDirectory } from "./anchored-dir.js";

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
  const name = `${randomUUID()}.${options.suffix}`;
  try {
    directory = parent.child(".private");
    const path = join(directory.path, name);
    directory.writeExclusive(name, options.value);
    fd = directory.openRegular(name);
    parent.assertCurrent();
    directory.assertCurrent();
    await options.beforeExecute?.(path);
    parent.assertCurrent();
    directory.assertCurrent();
    return await options.action({ path, fd });
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { if (directory && fd !== undefined) directory.remove(name); } finally {
      directory?.close();
      if (ownsParent) parent.close();
    }
    await rm(join(dirname(options.target), ".private"), { force: true }).catch(() => undefined);
  }
}
