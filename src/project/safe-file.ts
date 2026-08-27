import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type SafeReadOperations = {
  afterOpen?: (path: string) => Promise<void> | void;
};

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentVersion(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameOpenedSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  // Replacing the pathname detaches its single-link old inode and changes only
  // ctime/nlink. In-place writers cannot restore ctime through utimes.
  const atomicallyDetached = left.nlink === 1n && right.nlink === 0n;
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && (left.ctimeNs === right.ctimeNs || atomicallyDetached);
}

export async function readRegularFileNoFollow(
  path: string,
  operations: SafeReadOperations = {},
): Promise<Buffer> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    throw new Error(`planning artifact must be a regular file: ${path}`, { cause: error });
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`planning artifact must be a regular file: ${path}`);
  }

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameContentVersion(before, opened)) {
      throw new Error(`planning artifact changed while reading: ${path}`);
    }
    await operations.afterOpen?.(path);
    const value = await handle.readFile();
    const afterOpen = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || !sameContentVersion(opened, afterOpen)
      || !sameContentVersion(afterOpen, after)
    ) {
      throw new Error(`planning artifact changed while reading: ${path}`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function readRegularFileSnapshotNoFollow(
  path: string,
  operations: SafeReadOperations = {},
): Promise<Buffer> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    throw new Error(`planning artifact must be a regular file: ${path}`, { cause: error });
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`planning artifact must be a regular file: ${path}`);
  }

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameContentVersion(before, opened)) {
      throw new Error(`planning artifact changed while reading: ${path}`);
    }
    await operations.afterOpen?.(path);
    const value = await handle.readFile();
    const afterOpen = await handle.stat({ bigint: true });
    if (!sameOpenedSnapshot(opened, afterOpen)) {
      throw new Error(`planning artifact changed while reading: ${path}`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

export function localProjectPath(projectPath: string): string {
  return projectPath.split("/").join(sep);
}

export async function readOwnedRegularFile(
  root: string,
  projectPath: string,
  operations: SafeReadOperations = {},
): Promise<Buffer> {
  if (
    !projectPath
    || projectPath.includes("\\")
    || projectPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`planning artifact is outside project: ${projectPath}`);
  }
  const canonicalRoot = await realpath(root);
  const path = resolve(canonicalRoot, localProjectPath(projectPath));
  const canonicalPath = await realpath(path).catch((error: unknown) => {
    throw new Error(`planning artifact must be a regular file: ${path}`, { cause: error });
  });
  const difference = relative(canonicalRoot, canonicalPath);
  if (difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error(`planning artifact is outside project: ${projectPath}`);
  }
  if (difference.split(sep).join("/") !== projectPath) {
    throw new Error(`planning artifact path does not match fixed project key: ${projectPath}`);
  }
  const value = await readRegularFileNoFollow(path, operations);
  const afterPath = await realpath(path);
  if (afterPath !== canonicalPath) {
    throw new Error(`planning artifact changed while reading: ${path}`);
  }
  return value;
}
