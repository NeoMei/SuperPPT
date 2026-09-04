import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_SAFE_READ_MAX_BYTES,
  readOwnedRegularFile,
  readRegularFileNoFollow,
} from "../src/project/safe-file.js";

test("bounded safe reads reject oversized files before allocating their contents", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "superppt-safe-read-budget-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "oversized.bin");
  await writeFile(path, "x");
  await truncate(path, 2 * 1024 * 1024);

  await assert.rejects(readRegularFileNoFollow(path, { maxBytes: 1024 * 1024 }), /size|invalid|regular file/i);
  await assert.rejects(readOwnedRegularFile(root, "oversized.bin", { maxBytes: 1024 * 1024 }), /size|invalid|regular file/i);
});

test("safe reads apply a finite default budget when callers omit maxBytes", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "superppt-safe-read-default-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "oversized.bin");
  await writeFile(path, "x");
  await truncate(path, DEFAULT_SAFE_READ_MAX_BYTES + 1);

  await assert.rejects(readRegularFileNoFollow(path), /size|invalid|regular file/i);
});
