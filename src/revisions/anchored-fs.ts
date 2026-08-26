import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";

export type RevisionEvidenceOperations = {
  afterRevisionsDirectoryOpened?: () => Promise<void> | void;
  afterPlanningArtifactRestored?: (path: string) => Promise<void> | void;
  revisionSnapshotCheckpoint?: (
    step: "manifest-written" | "descriptor-written" | "published",
  ) => Promise<void> | void;
  beforePlanningArtifactWrite?: (path: string, index: number) => Promise<void> | void;
  rollbackCheckpoint?: (
    step: "journal-published" | "files-written" | "manifest-published",
  ) => Promise<void> | void;
};

type NativeAt = {
  openat(directory: number, name: string, flags: number, mode: number): number;
  mkdirat(directory: number, name: string, mode: number): number;
  renameat(oldDirectory: number, oldName: string, newDirectory: number, newName: string): number;
  renameExclusive(oldDirectory: number, oldName: string, newDirectory: number, newName: string): number;
  unlinkat(directory: number, name: string, flags: number): number;
};

const nativeAt: NativeAt | null = (() => {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const system = process.platform === "darwin"
    ? koffi.load("/usr/lib/libSystem.B.dylib")
    : (() => {
      try { return koffi.load("libc.so.6"); } catch { return koffi.load("libc.so"); }
    })();
  const rawOpenAt = system.func("int openat(int directory, const char *name, int flags, ...)") as (
    directory: number,
    name: string,
    flags: number,
    type: string,
    mode: number,
  ) => number;
  const renameExclusive = process.platform === "darwin"
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
    renameExclusive: (oldDirectory, oldName, newDirectory, newName) =>
      renameExclusive(oldDirectory, oldName, newDirectory, newName, process.platform === "darwin" ? 4 : 1),
    unlinkat: system.func("int unlinkat(int directory, const char *name, int flags)"),
  } as NativeAt;
})();

type WindowsDirectoryGuardApi = {
  createFile(path: string, desiredAccess: number, shareMode: number, security: number, disposition: number, flags: number, template: number): number | bigint;
  closeHandle(handle: number | bigint): number;
  getFileAttributes(path: string): number;
  getLastError(): number;
  moveFileEx(source: string, target: string, flags: number): number;
};

const windowsGuardApi: WindowsDirectoryGuardApi | null = (() => {
  if (process.platform !== "win32") return null;
  const kernel = koffi.load("kernel32.dll");
  return {
    createFile: kernel.func("intptr_t __stdcall CreateFileW(str16 path, unsigned int desired_access, unsigned int share_mode, void *security, unsigned int disposition, unsigned int flags, intptr_t template)"),
    closeHandle: kernel.func("int __stdcall CloseHandle(intptr_t handle)"),
    getFileAttributes: kernel.func("unsigned int __stdcall GetFileAttributesW(str16 path)"),
    getLastError: kernel.func("unsigned int __stdcall GetLastError(void)"),
    moveFileEx: kernel.func("int __stdcall MoveFileExW(str16 source, str16 target, unsigned int flags)"),
  } as WindowsDirectoryGuardApi;
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

export type WindowsMoveApi = Pick<WindowsDirectoryGuardApi, "moveFileEx" | "getLastError">;

export function moveFileDurable(
  source: string,
  target: string,
  replace: boolean,
  platform: NodeJS.Platform = process.platform,
  api: WindowsMoveApi | null = windowsGuardApi,
): void {
  if (platform !== "win32") {
    renameSync(source, target);
    return;
  }
  if (!api) throw new Error("Windows durable move is unavailable");
  const flags = MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0);
  if (!api.moveFileEx(source, target, flags)) {
    throw new Error(`MoveFileExW failed: ${api.getLastError()}`);
  }
}

function openWindowsDirectoryGuard(path: string): number | bigint | null {
  if (!windowsGuardApi) return null;
  const handle = windowsGuardApi.createFile(
    path,
    0,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    0,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    0,
  );
  if (Number(handle) === -1) {
    throw new Error(`unable to anchor Windows revision evidence directory: ${windowsGuardApi.getLastError()}`);
  }
  const attributes = windowsGuardApi.getFileAttributes(path);
  if (attributes === INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    windowsGuardApi.closeHandle(handle);
    throw new Error("Windows revision evidence directory is a reparse point");
  }
  return handle;
}

function nativeError(operation: string): NodeJS.ErrnoException {
  const errno = koffi.errno();
  const error = new Error(`${operation} failed with errno ${errno}`) as NodeJS.ErrnoException;
  error.errno = errno;
  if (errno === koffi.os.errno.ENOENT) error.code = "ENOENT";
  else if (errno === koffi.os.errno.EEXIST) error.code = "EEXIST";
  else if (errno === koffi.os.errno.ELOOP) error.code = "ELOOP";
  else error.code = `ERRNO_${errno}`;
  return error;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`unsafe revision evidence name: ${name}`);
  }
}

function syncAnchoredDirectory(fd: number): void {
  if (process.platform !== "win32") fsyncSync(fd);
}

export class AnchoredDirectory {
  readonly fd: number;
  readonly path: string;
  private readonly identity: Stats;
  private readonly windowsGuard: number | bigint | null;

  constructor(path: string, fd: number) {
    this.path = path;
    this.fd = fd;
    this.windowsGuard = openWindowsDirectoryGuard(path);
    this.identity = fd >= 0 ? fstatSync(fd) : lstatSync(path);
    if (!this.identity.isDirectory()) throw new Error(`revision evidence path is not a directory: ${path}`);
  }

  assertCurrent(): void {
    let current: Stats;
    try {
      current = lstatSync(this.path);
    } catch (error: unknown) {
      throw new Error("revision evidence directory changed while accessing revision evidence", { cause: error });
    }
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(this.identity, current)) {
      throw new Error("revision evidence directory changed while accessing revision evidence");
    }
  }

  child(name: string, create = true): AnchoredDirectory {
    safeName(name);
    if (nativeAt) {
      if (create && nativeAt.mkdirat(this.fd, name, 0o700) !== 0 && koffi.errno() !== koffi.os.errno.EEXIST) {
        throw nativeError(`mkdirat ${name}`);
      }
      const fd = nativeAt.openat(
        this.fd,
        name,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
        0,
      );
      if (fd < 0) throw nativeError(`openat directory ${name}`);
      const child = new AnchoredDirectory(join(this.path, name), fd);
      child.assertCurrent();
      return child;
    }
    const path = join(this.path, name);
    if (create) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const fd = process.platform === "win32"
      ? -1
      : openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const child = new AnchoredDirectory(path, fd);
    child.assertCurrent();
    return child;
  }

  read(name: string): Buffer | null {
    safeName(name);
    let fd: number;
    let before: Stats | undefined;
    if (nativeAt) {
      fd = nativeAt.openat(this.fd, name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), 0);
      if (fd < 0) {
        const error = nativeError(`openat file ${name}`);
        if (error.code === "ENOENT") return null;
        if (error.code === "ELOOP") {
          throw new Error(`revision evidence file is unsafe: ${name}`, { cause: error });
        }
        throw error;
      }
    } else {
      const path = join(this.path, name);
      try {
        before = lstatSync(path);
        if (before.isSymbolicLink() || !before.isFile()) {
          throw new Error(`revision evidence file is unsafe: ${name}`);
        }
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new Error(`revision evidence is not a regular file: ${name}`);
      if (before && !sameIdentity(before, info)) {
        throw new Error(`revision evidence file changed while reading: ${name}`);
      }
      const value = readFileSync(fd);
      if (before) {
        const after = lstatSync(join(this.path, name));
        if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(info, after)) {
          throw new Error(`revision evidence file changed while reading: ${name}`);
        }
      }
      return value;
    } finally {
      closeSync(fd);
    }
  }

  listRegularFiles(): string[] {
    this.assertCurrent();
    const entries = readdirSync(this.path, { withFileTypes: true });
    this.assertCurrent();
    if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
      throw new Error("revision evidence directory contains a non-regular entry");
    }
    return entries.map((entry) => entry.name).sort();
  }

  writeExclusive(name: string, value: string | Buffer): void {
    safeName(name);
    let fd: number;
    if (nativeAt) {
      fd = nativeAt.openat(
        this.fd,
        name,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      if (fd < 0) throw nativeError(`openat exclusive file ${name}`);
    } else {
      fd = openSync(
        join(this.path, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    }
    try {
      writeFileSync(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  replace(name: string, value: string | Buffer, temporaryName: string): void {
    safeName(name);
    safeName(temporaryName);
    this.assertCurrent();
    this.writeExclusive(temporaryName, value);
    try {
      if (nativeAt) {
        if (nativeAt.renameat(this.fd, temporaryName, this.fd, name) !== 0) {
          throw nativeError(`renameat ${temporaryName}`);
        }
      } else {
        moveFileDurable(join(this.path, temporaryName), join(this.path, name), true);
      }
      syncAnchoredDirectory(this.fd);
      this.assertCurrent();
    } catch (error: unknown) {
      if (nativeAt) nativeAt.unlinkat(this.fd, temporaryName, 0);
      else {
        try { unlinkSync(join(this.path, temporaryName)); } catch { /* retained only if removal fails */ }
      }
      throw error;
    }
  }

  remove(name: string): void {
    safeName(name);
    this.assertCurrent();
    if (nativeAt) {
      if (nativeAt.unlinkat(this.fd, name, 0) !== 0) throw nativeError(`unlinkat ${name}`);
    } else {
      unlinkSync(join(this.path, name));
    }
    syncAnchoredDirectory(this.fd);
    this.assertCurrent();
  }

  promoteChildExclusive(stagingName: string, targetName: string): void {
    safeName(stagingName);
    safeName(targetName);
    if (nativeAt) {
      if (nativeAt.renameExclusive(this.fd, stagingName, this.fd, targetName) !== 0) {
        throw nativeError(`exclusive renameat ${stagingName}`);
      }
    } else {
      // The target is a random UUID. Refuse a pre-existing entry before the
      // platform promotion and revalidate the anchored parent afterward.
      try {
        lstatSync(join(this.path, targetName));
        const error = new Error(`revision evidence target already exists: ${targetName}`) as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      moveFileDurable(join(this.path, stagingName), join(this.path, targetName), false);
    }
    syncAnchoredDirectory(this.fd);
    this.assertCurrent();
  }

  close(): void {
    try {
      if (this.fd >= 0) closeSync(this.fd);
    } finally {
      if (this.windowsGuard !== null) windowsGuardApi!.closeHandle(this.windowsGuard);
    }
  }
}

export async function withAnchoredRevisions<T>(
  root: string,
  operations: RevisionEvidenceOperations | undefined,
  action: (revisions: AnchoredDirectory) => Promise<T> | T,
): Promise<T> {
  if (!nativeAt && !windowsGuardApi) {
    throw new Error(`anchored revision evidence is unsupported on ${process.platform}`);
  }
  const path = join(root, "revisions");
  const fd = process.platform === "win32"
    ? -1
    : openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const revisions = new AnchoredDirectory(path, fd);
  try {
    await operations?.afterRevisionsDirectoryOpened?.();
    revisions.assertCurrent();
    const result = await action(revisions);
    revisions.assertCurrent();
    return result;
  } finally {
    revisions.close();
  }
}

export async function withAnchoredDirectory<T>(
  path: string,
  action: (directory: AnchoredDirectory) => Promise<T> | T,
): Promise<T> {
  if (!nativeAt && !windowsGuardApi) {
    throw new Error(`anchored filesystem access is unsupported on ${process.platform}`);
  }
  const fd = process.platform === "win32"
    ? -1
    : openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const directory = new AnchoredDirectory(path, fd);
  try {
    directory.assertCurrent();
    const result = await action(directory);
    directory.assertCurrent();
    return result;
  } finally {
    directory.close();
  }
}
