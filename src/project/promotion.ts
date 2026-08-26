import koffi from "koffi";

type NativeRename = (source: string, target: string) => number;

const RENAME_NOREPLACE = 1;
const RENAME_EXCL = 4;
const AT_FDCWD = -100;

let nativeRename: NativeRename | undefined;

function loadNativeRename(): NativeRename {
  if (nativeRename) return nativeRename;
  if (process.platform === "darwin") {
    const system = koffi.load("/usr/lib/libSystem.B.dylib");
    const renameExclusive = system.func(
      "int renamex_np(const char *source, const char *target, unsigned int flags)",
    ) as (source: string, target: string, flags: number) => number;
    nativeRename = (source, target) =>
      renameExclusive(source, target, RENAME_EXCL);
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
    ) as (
      oldDirectory: number,
      source: string,
      newDirectory: number,
      target: string,
      flags: number,
    ) => number;
    nativeRename = (source, target) =>
      renameNoReplace(
        AT_FDCWD,
        source,
        AT_FDCWD,
        target,
        RENAME_NOREPLACE,
      );
    return nativeRename;
  }
  throw new Error(`exclusive project promotion is unsupported on ${process.platform}`);
}

export async function promoteExclusive(
  source: string,
  target: string,
): Promise<void> {
  if (loadNativeRename()(source, target) === 0) return;
  const errno = koffi.errno();
  const error = new Error(
    errno === koffi.os.errno.EEXIST
      ? `project target already exists: ${target}`
      : `exclusive project promotion failed with errno ${errno}`,
  ) as NodeJS.ErrnoException;
  error.code = errno === koffi.os.errno.EEXIST ? "EEXIST" : `ERRNO_${errno}`;
  error.errno = errno;
  throw error;
}
