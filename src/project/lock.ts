import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";

import { syncDirectory, writeDurableExclusive } from "./durable.js";
import { readRegularFileNoFollow } from "./safe-file.js";
import { readProject } from "./store.js";

export type ProjectLockOptions = {
  staleAfterMs?: number;
  waitTimeoutMs?: number;
  retryMs?: number;
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`unsafe planning lock directory: ${path}`);
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function archiveStaleLock(
  lockPath: string,
  archiveRoot: string,
  staleAfterMs: number,
): Promise<boolean> {
  const info = await lstat(lockPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("unsafe planning lock");
  }
  let acquiredAt = info.mtimeMs;
  let pid = -1;
  try {
    const owner = JSON.parse((await readRegularFileNoFollow(join(lockPath, "owner.json"))).toString("utf8")) as {
      acquiredAt?: string;
      pid?: number;
    };
    const parsed = Date.parse(owner.acquiredAt ?? "");
    if (Number.isFinite(parsed)) acquiredAt = Math.max(acquiredAt, parsed);
    if (Number.isInteger(owner.pid)) pid = owner.pid!;
  } catch {
    // A crashed owner can leave only the atomic lock directory. Its mtime is
    // sufficient after the conservative stale interval.
  }
  if (Date.now() - acquiredAt < staleAfterMs || (pid > 0 && processIsAlive(pid))) {
    return false;
  }
  await rename(lockPath, join(archiveRoot, `${randomUUID()}.stale`));
  await syncDirectory(archiveRoot);
  return true;
}

export async function withPlanningLock<T>(
  projectRoot: string,
  action: (canonicalRoot: string) => Promise<T>,
  options: ProjectLockOptions = {},
): Promise<T> {
  await readProject(projectRoot);
  const root = await realpath(projectRoot);
  const archiveRoot = join(root, ".superppt-locks");
  await ensureDirectory(archiveRoot);
  const lockPath = join(root, ".superppt-planning.lock");
  const id = randomUUID();
  const startedAt = Date.now();
  const staleAfterMs = options.staleAfterMs ?? 300_000;
  const waitTimeoutMs = options.waitTimeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 10;

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeDurableExclusive(join(lockPath, "owner.json"), `${JSON.stringify({
        version: 1,
        id,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }, null, 2)}\n`);
      await syncDirectory(lockPath);
      await syncDirectory(root);
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await archiveStaleLock(lockPath, archiveRoot, staleAfterMs).catch((staleError: unknown) => {
        if ((staleError as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw staleError;
      })) continue;
      if (Date.now() - startedAt >= waitTimeoutMs) {
        throw new Error("planning project is locked by another process");
      }
      await delay(retryMs);
    }
  }

  let succeeded = false;
  try {
    const result = await action(root);
    succeeded = true;
    return result;
  } finally {
    const suffix = succeeded ? "completed" : "failed";
    await rename(lockPath, join(archiveRoot, `${id}.${suffix}`));
    await syncDirectory(archiveRoot);
    await syncDirectory(root);
  }
}
