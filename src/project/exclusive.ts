import { lstat, rename } from "node:fs/promises";

import koffi from "koffi";

type NativeRename = (source: string, target: string, replace?: boolean) => number;

const RENAME_NOREPLACE = 1;
const RENAME_EXCL = 4;
const AT_FDCWD = -100;
const ERROR_FILE_EXISTS = 80;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NOT_SAME_DEVICE = 17;
const ERROR_SHARING_VIOLATION = 32;
const MOVEFILE_WRITE_THROUGH = 8;
const MOVEFILE_REPLACE_EXISTING = 1;

let nativeRename: NativeRename | undefined;
let nativeError = (): number => koffi.errno();

function loadNativeRename(): NativeRename {
  if (nativeRename) return nativeRename;
  if (process.platform === "darwin") {
    const system = koffi.load("/usr/lib/libSystem.B.dylib");
    const renameExclusive = system.func(
      "int renamex_np(const char *source, const char *target, unsigned int flags)",
    ) as (source: string, target: string, flags: number) => number;
    nativeRename = (source, target) => renameExclusive(source, target, RENAME_EXCL);
    return nativeRename;
  }
  if (process.platform === "linux") {
    let system;
    try {
      system = koffi.load("libc.so.6");
    } catch {
      system = koffi.load("libc.so");
    }
    const renameNoReplace = system.func(
      "int renameat2(int olddirfd, const char *source, int newdirfd, const char *target, unsigned int flags)",
    ) as (oldDirectory: number, source: string, newDirectory: number, target: string, flags: number) => number;
    nativeRename = (source, target) => renameNoReplace(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE);
    return nativeRename;
  }
  if (process.platform === "win32") {
    const system = koffi.load("kernel32.dll");
    // MoveFileExW without the \\?\ long-path prefix cannot operate on paths that
    // reach the MAX_PATH boundary, even when Node's own file APIs created them.
    const longPath = (path: string): string => {
      if (path.startsWith("\\\\?\\")) return path;
      if (path.startsWith("\\\\")) return `\\\\?\\UNC${path.slice(1)}`;
      return `\\\\?\\${path}`;
    };
    const moveFileExclusive = system.func(
      "int __stdcall MoveFileExW(str16 source, str16 target, unsigned int flags)",
    ) as (source: string, target: string, flags: number) => number;
    const getLastError = system.func("unsigned int __stdcall GetLastError(void)") as () => number;
    let lastError = 0;
    nativeRename = (source, target, replace = false) => {
      const flags = MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0);
      const succeeded = moveFileExclusive(longPath(source), longPath(target), flags);
      if (!succeeded) lastError = getLastError();
      return succeeded ? 0 : -1;
    };
    nativeError = () => lastError;
    return nativeRename;
  }
  throw new Error(`exclusive project promotion is unsupported on ${process.platform}`);
}

export async function promoteExclusive(source: string, target: string): Promise<void> {
  const attempts = process.platform === "win32" ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (loadNativeRename()(source, target, false) === 0) return;
    const errno = nativeError();
    let targetExists = process.platform === "win32"
      ? errno === ERROR_FILE_EXISTS || errno === ERROR_ALREADY_EXISTS
      : errno === koffi.os.errno.EEXIST;
    if (
      process.platform === "win32"
      && (errno === ERROR_ACCESS_DENIED || errno === ERROR_SHARING_VIOLATION)
    ) {
      targetExists = await lstat(target).then(() => true, () => false);
    }
    if (
      !targetExists
      && process.platform === "win32"
      && (errno === ERROR_ACCESS_DENIED || errno === ERROR_SHARING_VIOLATION)
      && attempt + 1 < attempts
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      continue;
    }
    const error = new Error(
      targetExists
        ? `project target already exists: ${target}`
        : `exclusive project promotion failed with errno ${errno}`,
    ) as NodeJS.ErrnoException;
    error.code = targetExists ? "EEXIST" : `ERRNO_${errno}`;
    error.errno = errno;
    throw error;
  }
}

/** Replace a target atomically, with write-through durability on Windows. */
export async function renameSafe(source: string, target: string): Promise<void> {
  if (process.platform === "win32") {
    const result = loadNativeRename()(source, target, true);
    if (result === 0) return;
    const errno = nativeError();
    const error = new Error(`renameSafe failed with errno ${errno}`) as NodeJS.ErrnoException;
    if (errno === ERROR_FILE_NOT_FOUND || errno === ERROR_PATH_NOT_FOUND) error.code = "ENOENT";
    else if (errno === ERROR_ACCESS_DENIED) error.code = "EACCES";
    else if (errno === ERROR_NOT_SAME_DEVICE) error.code = "EXDEV";
    else if (errno === ERROR_SHARING_VIOLATION) error.code = "EBUSY";
    else if (errno === ERROR_FILE_EXISTS || errno === ERROR_ALREADY_EXISTS) error.code = "EEXIST";
    else error.code = `ERRNO_${errno}`;
    error.errno = errno;
    throw error;
  }
  await rename(source, target);
}
