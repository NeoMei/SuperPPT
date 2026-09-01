import { AsyncLocalStorage } from "node:async_hooks";
import {
  open as exportedOpen,
  readdir as exportedReaddir,
  realpath as exportedRealpath,
} from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

type AsyncBuiltin = (...args: any[]) => Promise<any>;

type SourceTreeScanRace = {
  sourceRoot: string;
  sentinelFile?: string;
  targetEntry?: string;
  enabled?: () => boolean;
  beforeSourceRootRead?: (scan: number) => Promise<void>;
  afterSentinelRead?: (read: number) => Promise<void>;
  afterEntryRealpath?: (state: { entryRealpaths: number; sourceRootReads: number }) => Promise<void>;
  sourceReads: number;
  sentinelReads: number;
  entryRealpaths: number;
};

const require = createRequire(import.meta.url);
const mutable = require("node:fs/promises") as Record<"open" | "readdir" | "realpath", AsyncBuiltin>;
const originalOpen = mutable.open;
const originalReaddir = mutable.readdir;
const originalRealpath = mutable.realpath;
const raceStorage = new AsyncLocalStorage<SourceTreeScanRace>();
let installedScopes = 0;

function sameStringPath(value: unknown, expected: string): boolean {
  return typeof value === "string" && resolve(value) === expected;
}

const raceReaddir: AsyncBuiltin = async (...args: any[]) => {
  const race = raceStorage.getStore() ?? null;
  const enabled = race !== null && (race.enabled?.() ?? true);
  if (enabled && sameStringPath(args[0], race.sourceRoot)) {
    race.sourceReads += 1;
    await race.beforeSourceRootRead?.(race.sourceReads);
  }
  return originalReaddir(...args);
};
const raceOpen: AsyncBuiltin = async (...args: any[]) => {
  const race = raceStorage.getStore() ?? null;
  const handle = await originalOpen(...args);
  const enabled = race !== null && (race.enabled?.() ?? true);
  if (!enabled || race.sentinelFile === undefined || !sameStringPath(args[0], race.sentinelFile)) return handle;
  let closed = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "close") {
        return async () => {
          const result = await target.close();
          if (!closed) {
            closed = true;
            race.sentinelReads += 1;
            await race.afterSentinelRead?.(race.sentinelReads);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
const raceRealpath: AsyncBuiltin = async (...args: any[]) => {
  const physicalPath = await originalRealpath(...args);
  const race = raceStorage.getStore() ?? null;
  const enabled = race !== null && (race.enabled?.() ?? true);
  if (enabled && race.targetEntry !== undefined && sameStringPath(args[0], race.targetEntry)) {
    race.entryRealpaths += 1;
    await race.afterEntryRealpath?.({
      entryRealpaths: race.entryRealpaths,
      sourceRootReads: race.sourceReads,
    });
  }
  return physicalPath;
};

export function sourceTreeScanRaceBuiltinsRestored(): boolean {
  return mutable.open === originalOpen
    && mutable.readdir === originalReaddir
    && mutable.realpath === originalRealpath
    && exportedOpen === originalOpen
    && exportedReaddir === originalReaddir
    && exportedRealpath === originalRealpath;
}

function installSourceTreeRaceBuiltins(): void {
  if (installedScopes === 0) {
    if (!sourceTreeScanRaceBuiltinsRestored()) throw new Error("source-tree race builtins were replaced outside the scoped helper");
    mutable.open = raceOpen;
    mutable.readdir = raceReaddir;
    mutable.realpath = raceRealpath;
    syncBuiltinESMExports();
  }
  installedScopes += 1;
}

function restoreSourceTreeRaceBuiltins(): void {
  installedScopes -= 1;
  if (installedScopes < 0) throw new Error("source-tree race builtin scope underflow");
  if (installedScopes === 0) {
    mutable.open = originalOpen;
    mutable.readdir = originalReaddir;
    mutable.realpath = originalRealpath;
    syncBuiltinESMExports();
  }
}

export async function withSourceTreeScanRace<T>(options: {
  sourceRoot: string;
  sentinelFile?: string;
  targetEntry?: string;
  enabled?: () => boolean;
  beforeSourceRootRead?: (scan: number) => Promise<void>;
  afterSentinelRead?: (read: number) => Promise<void>;
  afterEntryRealpath?: (state: { entryRealpaths: number; sourceRootReads: number }) => Promise<void>;
}, operation: () => Promise<T>): Promise<T> {
  const race: SourceTreeScanRace = {
    ...options,
    sourceRoot: await originalRealpath(resolve(options.sourceRoot)),
    sentinelFile: options.sentinelFile === undefined ? undefined : await originalRealpath(resolve(options.sentinelFile)),
    targetEntry: options.targetEntry === undefined ? undefined : await originalRealpath(resolve(options.targetEntry)),
    sourceReads: 0,
    sentinelReads: 0,
    entryRealpaths: 0,
  };
  installSourceTreeRaceBuiltins();
  try {
    return await raceStorage.run(race, operation);
  } finally {
    restoreSourceTreeRaceBuiltins();
  }
}
