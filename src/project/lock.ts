import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { syncDirectory, writeDurableExclusive } from "./durable.js";
import { validateProjectRoot } from "./paths.js";
import { readRegularFileNoFollow } from "./safe-file.js";

export type ProjectLockOptions = {
  staleAfterMs?: number;
  waitTimeoutMs?: number;
  retryMs?: number;
};

type LeaseStatus = "pending" | "active";
type LeaseRequest = {
  version: 1;
  id: string;
  token: string;
  pid: number;
  createdAt: string;
};
type RequestEntry = {
  request: LeaseRequest | null;
  name: string;
  status: LeaseStatus;
  birthtimeNs: bigint;
  mtimeMs: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe project lease directory: ${path}`);
}

async function assertOwnedRoot(root: string): Promise<void> {
  const markerPath = join(root, ".superppt-project.json");
  const marker = JSON.parse((await readRegularFileNoFollow(markerPath)).toString("utf8")) as {
    appId?: string;
    canonicalRoot?: string;
  };
  if (marker.appId !== "superppt" || marker.canonicalRoot !== root) {
    throw new Error("project directory is not owned by SuperPPT");
  }
  // superppt.json is mutable under the state lease. Reading it before a
  // contender joins that lease can race the current owner's atomic promotion.
  // Store actions authenticate the manifest after acquiring the state lease.
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseRequest(value: unknown, id: string): LeaseRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid lease request");
  const request = value as Record<string, unknown>;
  if (
    request.version !== 1
    || request.id !== id
    || typeof request.token !== "string"
    || !UUID.test(request.token)
    || !Number.isInteger(request.pid)
    || (request.pid as number) <= 0
    || typeof request.createdAt !== "string"
    || !Number.isFinite(Date.parse(request.createdAt))
    || Object.keys(request).some((key) => !["version", "id", "token", "pid", "createdAt"].includes(key))
  ) throw new Error("invalid lease request");
  return request as LeaseRequest;
}

async function entries(leaseRoot: string): Promise<RequestEntry[]> {
  const result: RequestEntry[] = [];
  for (const name of await readdir(leaseRoot)) {
    const match = /^([0-9a-f-]{36})\.(pending|active)\.json$/i.exec(name);
    if (!match || !UUID.test(match[1]!)) continue;
    const path = join(leaseRoot, name);
    let info;
    try {
      info = await stat(path, { bigint: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) throw new Error(`unsafe project lease request: ${name}`);
    let request: LeaseRequest | null = null;
    try {
      request = parseRequest(JSON.parse((await readRegularFileNoFollow(path)).toString("utf8")), match[1]!);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
      if (cause?.code === "ENOENT") continue;
      // Invalid requests fail closed while recent and become recoverable only
      // after their filesystem age exceeds the stale threshold.
    }
    result.push({
      request,
      name,
      status: match[2] as LeaseStatus,
      birthtimeNs: info.birthtimeNs,
      mtimeMs: Number(info.mtimeNs / 1_000_000n),
    });
  }
  return result;
}

function compareRequests(left: RequestEntry, right: RequestEntry): number {
  if (left.birthtimeNs !== right.birthtimeNs) return left.birthtimeNs < right.birthtimeNs ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function isStale(entry: RequestEntry, staleAfterMs: number): boolean {
  const declared = entry.request ? Date.parse(entry.request.createdAt) : 0;
  const age = Date.now() - Math.max(entry.mtimeMs, declared);
  return age >= staleAfterMs && (!entry.request || !processIsAlive(entry.request.pid));
}

async function archiveStale(leaseRoot: string, staleAfterMs: number): Promise<void> {
  for (const entry of await entries(leaseRoot)) {
    if (!isStale(entry, staleAfterMs)) continue;
    const staleName = entry.name.replace(/\.(pending|active)\.json$/, ".stale.json");
    await rename(join(leaseRoot, entry.name), join(leaseRoot, staleName)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  await syncDirectory(leaseRoot);
}

export async function withProjectLease<T>(
  projectRoot: string,
  leaseName: string,
  action: (canonicalRoot: string) => Promise<T>,
  options: ProjectLockOptions = {},
): Promise<T> {
  if (!/^[a-z0-9-]+$/.test(leaseName)) throw new Error(`invalid project lease name: ${leaseName}`);
  const root = await validateProjectRoot(projectRoot);
  await assertOwnedRoot(root);
  const leasesRoot = join(root, ".superppt-leases");
  await ensureDirectory(leasesRoot);
  const leaseRoot = join(leasesRoot, leaseName);
  await ensureDirectory(leaseRoot);
  const id = randomUUID();
  const token = randomUUID();
  const request: LeaseRequest = {
    version: 1,
    id,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  let requestName = `${id}.pending.json`;
  await writeDurableExclusive(join(leaseRoot, requestName), `${JSON.stringify(request, null, 2)}\n`);
  await syncDirectory(leaseRoot);
  const startedAt = Date.now();
  const staleAfterMs = options.staleAfterMs ?? 300_000;
  const waitTimeoutMs = options.waitTimeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 10;

  while (true) {
    await archiveStale(leaseRoot, staleAfterMs);
    const available = await entries(leaseRoot);
    const active = available.filter((entry) => entry.status === "active").sort(compareRequests);
    if (active.length > 0) {
      if (active[0]!.request?.id === id && active[0]!.request.token === token) break;
    } else {
      const pending = available.filter((entry) => entry.status === "pending").sort(compareRequests);
      if (pending[0]?.request?.id === id && pending[0].request.token === token) {
        const activeName = `${id}.active.json`;
        await rename(join(leaseRoot, requestName), join(leaseRoot, activeName));
        requestName = activeName;
        await syncDirectory(leaseRoot);
        continue;
      }
    }
    if (Date.now() - startedAt >= waitTimeoutMs) {
      const timedOut = `${id}.timed-out.json`;
      await rename(join(leaseRoot, requestName), join(leaseRoot, timedOut)).catch(() => undefined);
      await syncDirectory(leaseRoot);
      throw new Error(`project ${leaseName} lease timed out`);
    }
    await delay(retryMs);
  }

  let succeeded = false;
  try {
    const result = await action(root);
    succeeded = true;
    return result;
  } finally {
    const finalName = `${id}.${succeeded ? "completed" : "failed"}.json`;
    await rename(join(leaseRoot, requestName), join(leaseRoot, finalName));
    await syncDirectory(leaseRoot);
  }
}

export async function withPlanningLock<T>(
  projectRoot: string,
  action: (canonicalRoot: string) => Promise<T>,
  options: ProjectLockOptions = {},
): Promise<T> {
  return withProjectLease(projectRoot, "planning", action, options);
}
