import { createRequire, syncBuiltinESMExports } from "node:module";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

type AsyncBuiltin = (...args: any[]) => Promise<any>;

type SourceTreeScanRace = {
  sourceRoot: string;
  sentinelFile: string;
  enabled?: () => boolean;
  beforeSourceRootRead?: (scan: number) => Promise<void>;
  afterSentinelRead: (read: number) => Promise<void>;
  sourceReads: number;
  sentinelReads: number;
};

const require = createRequire(import.meta.url);
const mutable = require("node:fs/promises") as Record<"open" | "readdir", AsyncBuiltin>;
const originalOpen = mutable.open;
const originalReaddir = mutable.readdir;
let activeRace: SourceTreeScanRace | null = null;

function sameStringPath(value: unknown, expected: string): boolean {
  return typeof value === "string" && resolve(value) === expected;
}

mutable.readdir = async (...args: any[]) => {
  const race = activeRace;
  const enabled = race !== null && (race.enabled?.() ?? true);
  if (enabled && sameStringPath(args[0], race.sourceRoot)) {
    race.sourceReads += 1;
    await race.beforeSourceRootRead?.(race.sourceReads);
  }
  return originalReaddir(...args);
};
mutable.open = async (...args: any[]) => {
  const race = activeRace;
  const handle = await originalOpen(...args);
  const enabled = race !== null && (race.enabled?.() ?? true);
  if (!enabled || !sameStringPath(args[0], race.sentinelFile)) return handle;
  let closed = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "close") {
        return async () => {
          const result = await target.close();
          if (!closed) {
            closed = true;
            race.sentinelReads += 1;
            await race.afterSentinelRead(race.sentinelReads);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
syncBuiltinESMExports();

export async function withSourceTreeScanRace<T>(options: {
  sourceRoot: string;
  sentinelFile: string;
  enabled?: () => boolean;
  beforeSourceRootRead?: (scan: number) => Promise<void>;
  afterSentinelRead: (read: number) => Promise<void>;
}, operation: () => Promise<T>): Promise<T> {
  if (activeRace !== null) throw new Error("source-tree scan race hooks must not overlap");
  activeRace = {
    ...options,
    sourceRoot: await realpath(resolve(options.sourceRoot)),
    sentinelFile: await realpath(resolve(options.sentinelFile)),
    sourceReads: 0,
    sentinelReads: 0,
  };
  try {
    return await operation();
  } finally {
    activeRace = null;
  }
}
