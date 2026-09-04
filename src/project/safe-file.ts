import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type SafeReadOperations = {
  afterParentOpen?: (path: string) => Promise<void> | void;
  afterPathStat?: (path: string) => Promise<void> | void;
  afterFileOpen?: (path: string) => Promise<void> | void;
  afterOpen?: (path: string) => Promise<void> | void;
  afterRead?: (path: string) => Promise<void> | void;
  maxBytes?: number;
};

export const DEFAULT_SAFE_READ_MAX_BYTES = 256 * 1024 * 1024;

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

const SNAPSHOT_OPEN_ATTEMPTS = 3;

export type AnchoredReadOptions = {
  label: string;
  maxBytes: number;
  privateInput?: boolean;
  operations?: SafeReadOperations;
};

function safeReadError(label: string, cause?: unknown): Error {
  return new Error(`${label} file is unsafe or invalid`, cause === undefined ? undefined : { cause });
}

async function boundedDescriptorRead(
  handle: Awaited<ReturnType<typeof open>>,
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset <= maximum) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - offset));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset === 0 || offset > maximum) throw new Error("bounded input size is invalid");
  return Buffer.concat(chunks, offset);
}

async function readDescriptor(
  handle: Awaited<ReturnType<typeof open>>,
  maximum: number,
  expectedSize: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(maximum)
    || maximum <= 0
    || !Number.isSafeInteger(expectedSize)
    || expectedSize < 0
    || expectedSize > maximum
  ) throw new Error("bounded input size is invalid");
  const value = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(value, offset, expectedSize - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === expectedSize ? value : value.subarray(0, offset);
}

/**
 * Reads an external pathname through one anchored parent/final descriptor
 * sequence. Bytes are not returned until both descriptor and pathname
 * identities have been rechecked, so file and ancestor swaps fail closed.
 */
export async function readAnchoredRegularFile(
  path: string,
  options: AnchoredReadOptions,
): Promise<Buffer> {
  const requested = resolve(path);
  const requestedParent = dirname(requested);
  const { label, maxBytes, privateInput = false, operations = {} } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw safeReadError(label);
  try {
    const canonicalParent = await realpath(requestedParent);
    if (canonicalParent !== requestedParent) throw new Error("linked ancestor");
    const parentBefore = await lstat(requestedParent, { bigint: true });
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) throw new Error("unsafe parent");
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    const directoryOnly = process.platform === "win32" ? 0 : (constants.O_DIRECTORY ?? 0);
    const parent = await open(requestedParent, constants.O_RDONLY | noFollow | directoryOnly);
    try {
      const parentOpened = await parent.stat({ bigint: true });
      if (!parentOpened.isDirectory() || !sameContentVersion(parentBefore, parentOpened)) {
        throw new Error("parent identity changed");
      }
      await operations.afterParentOpen?.(requestedParent);
      const before = await lstat(requested, { bigint: true });
      if (
        before.isSymbolicLink()
        || !before.isFile()
        || before.nlink !== 1n
        || before.size <= 0n
        || before.size > BigInt(maxBytes)
      ) throw new Error("unsafe file");
      if (process.platform !== "win32" && privateInput && (before.mode & 0o777n) !== 0o600n) {
        throw new Error("private mode");
      }
      await operations.afterPathStat?.(requested);
      const file = await open(requested, constants.O_RDONLY | noFollow);
      try {
        await operations.afterFileOpen?.(requested);
        const opened = await file.stat({ bigint: true });
        if (
          !opened.isFile()
          || opened.nlink !== 1n
          || !sameContentVersion(before, opened)
          || (process.platform !== "win32" && privateInput && (opened.mode & 0o777n) !== 0o600n)
        ) throw new Error("file identity changed");
        await operations.afterOpen?.(requested);
        const value = await boundedDescriptorRead(file, maxBytes);
        await operations.afterRead?.(requested);
        const fileAfter = await file.stat({ bigint: true });
        const pathAfter = await lstat(requested, { bigint: true });
        const parentAfter = await parent.stat({ bigint: true });
        const parentPathAfter = await lstat(requestedParent, { bigint: true });
        if (
          pathAfter.isSymbolicLink()
          || !pathAfter.isFile()
          || pathAfter.nlink !== 1n
          || !sameContentVersion(opened, fileAfter)
          || !sameContentVersion(fileAfter, pathAfter)
          || parentPathAfter.isSymbolicLink()
          || !parentPathAfter.isDirectory()
          || !sameContentVersion(parentOpened, parentAfter)
          || !sameContentVersion(parentAfter, parentPathAfter)
          || await realpath(requestedParent) !== canonicalParent
          || await realpath(requested) !== requested
        ) throw new Error("path identity changed");
        return value;
      } finally {
        await file.close();
      }
    } finally {
      await parent.close();
    }
  } catch (error: unknown) {
    if (
      process.platform !== "win32"
      && privateInput
      && error instanceof Error
      && error.message === "private mode"
    ) throw new Error(`${label} file must be private (mode 0600)`);
    throw safeReadError(label, error);
  }
}

export async function readRegularFileNoFollow(
  path: string,
  operations: SafeReadOperations = {},
): Promise<Buffer> {
  const maximum = operations.maxBytes ?? DEFAULT_SAFE_READ_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error(`planning artifact size limit is invalid: ${path}`);
  }
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    throw new Error(`planning artifact must be a regular file: ${path}`, { cause: error });
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.size > BigInt(maximum)
  ) {
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
    const value = await readDescriptor(handle, maximum, Number(opened.size));
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
  const maximum = operations.maxBytes ?? DEFAULT_SAFE_READ_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error(`planning artifact size limit is invalid: ${path}`);
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  for (let attempt = 0; attempt < SNAPSHOT_OPEN_ATTEMPTS; attempt += 1) {
    let before: BigIntStats;
    try {
      before = await lstat(path, { bigint: true });
    } catch (error: unknown) {
      throw new Error(`planning artifact must be a regular file: ${path}`, { cause: error });
    }
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.size > BigInt(maximum)
    ) {
      throw new Error(`planning artifact must be a regular file: ${path}`);
    }
    await operations.afterPathStat?.(path);

    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      await operations.afterFileOpen?.(path);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()) {
        throw new Error(`planning artifact changed while reading: ${path}`);
      }
      if (!sameFile(before, opened)) {
        if (attempt + 1 < SNAPSHOT_OPEN_ATTEMPTS) continue;
        throw new Error(`planning artifact changed while reading: ${path}`);
      }
      if (!sameOpenedSnapshot(before, opened)) {
        throw new Error(`planning artifact changed while reading: ${path}`);
      }
      await operations.afterOpen?.(path);
      const value = await readDescriptor(handle, maximum, Number(opened.size));
      const afterOpen = await handle.stat({ bigint: true });
      if (!sameOpenedSnapshot(opened, afterOpen)) {
        throw new Error(`planning artifact changed while reading: ${path}`);
      }
      return value;
    } finally {
      await handle.close();
    }
  }
  throw new Error(`planning artifact changed while reading: ${path}`);
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
