import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

import koffi from "koffi";

type NativeAt = {
  openat(directory: number, name: string, flags: number, mode: number): number;
  mkdirat(directory: number, name: string, mode: number): number;
  renameat(oldDirectory: number, oldName: string, newDirectory: number, newName: string): number;
  renameExclusive(oldDirectory: number, oldName: string, newDirectory: number, newName: string): number;
  unlinkat(directory: number, name: string, flags: number): number;
};

type WindowsApi = {
  createFile(path: string, desiredAccess: number, shareMode: number, security: number, disposition: number, flags: number, template: number): number | bigint;
  closeHandle(handle: number | bigint): number;
  getFileAttributes(path: string): number;
  getLastError(): number;
  moveFileEx(source: string, target: string, flags: number): number;
};

const nativeAt: NativeAt | null = (() => {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const system = process.platform === "darwin"
    ? koffi.load("/usr/lib/libSystem.B.dylib")
    : (() => { try { return koffi.load("libc.so.6"); } catch { return koffi.load("libc.so"); } })();
  const rawOpenAt = system.func("int openat(int directory, const char *name, int flags, ...)") as (
    directory: number, name: string, flags: number, type: string, mode: number,
  ) => number;
  const rawRenameExclusive = process.platform === "darwin"
    ? system.func("int renameatx_np(int old_directory, const char *old_name, int new_directory, const char *new_name, unsigned int flags)") as (
      oldDirectory: number, oldName: string, newDirectory: number, newName: string, flags: number,
    ) => number
    : system.func("int renameat2(int old_directory, const char *old_name, int new_directory, const char *new_name, unsigned int flags)") as (
      oldDirectory: number, oldName: string, newDirectory: number, newName: string, flags: number,
    ) => number;
  return {
    openat: (directory, name, flags, mode) => rawOpenAt(directory, name, flags, "unsigned int", mode),
    mkdirat: system.func("int mkdirat(int directory, const char *name, unsigned int mode)"),
    renameat: system.func("int renameat(int old_directory, const char *old_name, int new_directory, const char *new_name)"),
    renameExclusive: (oldDirectory, oldName, newDirectory, newName) => rawRenameExclusive(
      oldDirectory, oldName, newDirectory, newName, process.platform === "darwin" ? 4 : 1,
    ),
    unlinkat: system.func("int unlinkat(int directory, const char *name, int flags)"),
  } as NativeAt;
})();

const windowsApi: WindowsApi | null = (() => {
  if (process.platform !== "win32") return null;
  const kernel = koffi.load("kernel32.dll");
  return {
    createFile: kernel.func("intptr_t __stdcall CreateFileW(str16 path, unsigned int desired_access, unsigned int share_mode, void *security, unsigned int disposition, unsigned int flags, intptr_t template)"),
    closeHandle: kernel.func("int __stdcall CloseHandle(intptr_t handle)"),
    getFileAttributes: kernel.func("unsigned int __stdcall GetFileAttributesW(str16 path)"),
    getLastError: kernel.func("unsigned int __stdcall GetLastError(void)"),
    moveFileEx: kernel.func("int __stdcall MoveFileExW(str16 source, str16 target, unsigned int flags)"),
  } as WindowsApi;
})();

const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const MOVEFILE_REPLACE_EXISTING = 0x00000001;
const MOVEFILE_WRITE_THROUGH = 0x00000008;

function openWindowsGuard(path: string): number | bigint | null {
  if (!windowsApi) return null;
  const handle = windowsApi.createFile(
    path,
    0,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    0,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    0,
  );
  if (Number(handle) === -1) throw new Error(`unable to anchor generation directory: ${windowsApi.getLastError()}`);
  const attributes = windowsApi.getFileAttributes(path);
  if (attributes === INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    windowsApi.closeHandle(handle);
    throw new Error("generation directory is a reparse point");
  }
  return handle;
}

function moveWindows(source: string, target: string, replace: boolean): void {
  if (!windowsApi || !windowsApi.moveFileEx(
    source,
    target,
    MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0),
  )) throw new Error(`generation atomic move failed: ${windowsApi?.getLastError() ?? -1}`);
}

function safeName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("unsafe generation path component");
  }
}

function nativeError(operation: string): NodeJS.ErrnoException {
  const errno = koffi.errno();
  const error = new Error(`${operation} failed`) as NodeJS.ErrnoException;
  error.errno = errno;
  if (errno === koffi.os.errno.ENOENT) error.code = "ENOENT";
  else if (errno === koffi.os.errno.EEXIST) error.code = "EEXIST";
  else if (errno === koffi.os.errno.ELOOP) error.code = "ELOOP";
  return error;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncDirectory(fd: number): void {
  if (fd >= 0 && process.platform !== "win32") fsyncSync(fd);
}

export class GenerationDirectory {
  readonly path: string;
  readonly fd: number;
  private readonly identity: Stats;
  private readonly windowsGuard: number | bigint | null;

  constructor(path: string, fd: number) {
    this.path = path;
    this.fd = fd;
    this.windowsGuard = openWindowsGuard(path);
    this.identity = fd >= 0 ? fstatSync(fd) : lstatSync(path);
    if (!this.identity.isDirectory()) throw new Error("generation directory is unsafe");
    this.assertCurrent();
  }

  assertCurrent(): void {
    const current = lstatSync(this.path);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(this.identity, current)) {
      throw new Error("generation directory changed while in use");
    }
  }

  child(name: string, create = true): GenerationDirectory {
    safeName(name);
    if (nativeAt) {
      if (create && nativeAt.mkdirat(this.fd, name, 0o700) !== 0 && koffi.errno() !== koffi.os.errno.EEXIST) {
        throw nativeError("mkdirat");
      }
      const fd = nativeAt.openat(this.fd, name, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0), 0);
      if (fd < 0) throw nativeError("openat directory");
      const child = new GenerationDirectory(join(this.path, name), fd);
      if (process.platform !== "win32") chmodSync(child.path, 0o700);
      child.assertCurrent();
      return child;
    }
    const path = join(this.path, name);
    if (create) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const fd = process.platform === "win32" ? -1 : openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const child = new GenerationDirectory(path, fd);
    if (process.platform !== "win32") chmodSync(path, 0o700);
    child.assertCurrent();
    return child;
  }

  writeExclusive(name: string, value: string | Buffer): void {
    safeName(name);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    const fd = nativeAt ? nativeAt.openat(this.fd, name, flags, 0o600) : openSync(join(this.path, name), flags, 0o600);
    if (fd < 0) throw nativeError("openat exclusive file");
    try {
      writeFileSync(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  openRegular(name: string, flags = constants.O_RDONLY): number {
    safeName(name);
    const safeFlags = flags | (constants.O_NOFOLLOW ?? 0);
    let before: Stats | undefined;
    if (!nativeAt) {
      const path = join(this.path, name);
      if (windowsApi) {
        const attributes = windowsApi.getFileAttributes(path);
        if (attributes === INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
          throw new Error("generation file is a reparse point");
        }
      }
      before = lstatSync(path);
      if (before.isSymbolicLink() || !before.isFile()) throw new Error("generation file is unsafe");
    }
    const fd = nativeAt ? nativeAt.openat(this.fd, name, safeFlags, 0) : openSync(join(this.path, name), safeFlags);
    if (fd < 0) throw nativeError("openat file");
    const opened = fstatSync(fd);
    if (!opened.isFile() || (before && !sameIdentity(before, opened))) {
      closeSync(fd);
      throw new Error("generation file is unsafe");
    }
    this.assertCurrent();
    return fd;
  }

  read(name: string): Buffer {
    const fd = this.openRegular(name);
    try { return readFileSync(fd); } finally { closeSync(fd); }
  }

  readBounded(name: string, maximumBytes: number): Buffer {
    const fd = this.openRegular(name);
    try {
      const info = fstatSync(fd);
      if (info.size <= 0 || info.size > maximumBytes) throw new Error("generation file exceeds its size limit");
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  replace(name: string, value: string | Buffer, temporaryName: string): void {
    safeName(name);
    safeName(temporaryName);
    this.writeExclusive(temporaryName, value);
    try {
      if (nativeAt) {
        if (nativeAt.renameat(this.fd, temporaryName, this.fd, name) !== 0) throw nativeError("renameat");
      } else if (process.platform === "win32") {
        moveWindows(join(this.path, temporaryName), join(this.path, name), true);
      } else {
        renameSync(join(this.path, temporaryName), join(this.path, name));
      }
      syncDirectory(this.fd);
      this.assertCurrent();
    } catch (error: unknown) {
      this.remove(temporaryName);
      throw error;
    }
  }

  remove(name: string): void {
    safeName(name);
    if (nativeAt) {
      if (nativeAt.unlinkat(this.fd, name, 0) !== 0 && koffi.errno() !== koffi.os.errno.ENOENT) throw nativeError("unlinkat");
    } else {
      try { unlinkSync(join(this.path, name)); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    syncDirectory(this.fd);
    this.assertCurrent();
  }

  removeEmptyChild(name: string): void {
    safeName(name);
    if (nativeAt) {
      const atRemoveDir = process.platform === "darwin" ? 0x80 : 0x200;
      if (nativeAt.unlinkat(this.fd, name, atRemoveDir) !== 0 && koffi.errno() !== koffi.os.errno.ENOENT) {
        throw nativeError("unlinkat directory");
      }
    } else {
      try { rmdirSync(join(this.path, name)); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    syncDirectory(this.fd);
    this.assertCurrent();
  }

  promoteChildExclusive(stagingName: string, targetName: string): void {
    safeName(stagingName);
    safeName(targetName);
    if (nativeAt) {
      if (nativeAt.renameExclusive(this.fd, stagingName, this.fd, targetName) !== 0) throw nativeError("exclusive renameat");
    } else if (process.platform === "win32") {
      moveWindows(join(this.path, stagingName), join(this.path, targetName), false);
    } else {
      try {
        lstatSync(join(this.path, targetName));
        const error = new Error("generation attempt already exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      renameSync(join(this.path, stagingName), join(this.path, targetName));
    }
    syncDirectory(this.fd);
    this.assertCurrent();
  }

  promoteFileExclusive(stagingName: string, targetName: string): void {
    safeName(stagingName);
    safeName(targetName);
    const staged = lstatSync(join(this.path, stagingName));
    if (staged.isSymbolicLink() || !staged.isFile()) throw new Error("generation staged file is unsafe");
    if (nativeAt) {
      if (nativeAt.renameExclusive(this.fd, stagingName, this.fd, targetName) !== 0) throw nativeError("exclusive renameat");
    } else if (process.platform === "win32") {
      moveWindows(join(this.path, stagingName), join(this.path, targetName), false);
    } else {
      try {
        lstatSync(join(this.path, targetName));
        const error = new Error("generation file already exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      renameSync(join(this.path, stagingName), join(this.path, targetName));
    }
    syncDirectory(this.fd);
    this.assertCurrent();
  }

  close(): void {
    if (this.fd >= 0) closeSync(this.fd);
    if (this.windowsGuard !== null) windowsApi!.closeHandle(this.windowsGuard);
  }
}

export function openGenerationDirectory(path: string): GenerationDirectory {
  const fd = process.platform === "win32" ? -1 : openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  return new GenerationDirectory(path, fd);
}
