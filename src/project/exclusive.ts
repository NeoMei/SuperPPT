import koffi from "koffi";

type NativeRename = (source: string, target: string) => number;

const RENAME_NOREPLACE = 1;
const RENAME_EXCL = 4;
const AT_FDCWD = -100;
const ERROR_FILE_EXISTS = 80;
const ERROR_ALREADY_EXISTS = 183;
const MOVEFILE_WRITE_THROUGH = 8;

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
    const moveFileExclusive = system.func(
      "int __stdcall MoveFileExW(str16 source, str16 target, unsigned int flags)",
    ) as (source: string, target: string, flags: number) => number;
    const getLastError = system.func("unsigned int __stdcall GetLastError(void)") as () => number;
    let lastError = 0;
    nativeRename = (source, target) => {
      const succeeded = moveFileExclusive(source, target, MOVEFILE_WRITE_THROUGH);
      if (!succeeded) lastError = getLastError();
      return succeeded ? 0 : -1;
    };
    nativeError = () => lastError;
    return nativeRename;
  }
  throw new Error(`exclusive project promotion is unsupported on ${process.platform}`);
}

export async function promoteExclusive(source: string, target: string): Promise<void> {
  if (loadNativeRename()(source, target) === 0) return;
  const errno = nativeError();
  const targetExists = process.platform === "win32"
    ? errno === ERROR_FILE_EXISTS || errno === ERROR_ALREADY_EXISTS
    : errno === koffi.os.errno.EEXIST;
  const error = new Error(
    targetExists
      ? `project target already exists: ${target}`
      : `exclusive project promotion failed with errno ${errno}`,
  ) as NodeJS.ErrnoException;
  error.code = targetExists ? "EEXIST" : `ERRNO_${errno}`;
  error.errno = errno;
  throw error;
}
