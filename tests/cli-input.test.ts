import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { z } from "zod";

import { readCliJsonInput } from "../src/cli-input.js";

async function fixture(t: TestContext, label: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `superppt-cli-${label}-`)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  const path = join(directory, "input.json");
  await mkdir(directory);
  await writeFile(path, '{"value":"trusted"}\n', { mode: 0o600 });
  return { root, directory, path };
}

const StrictValueSchema = z.object({ value: z.literal("trusted") }).strict();

async function rejectsFileSwap(t: TestContext, label: string) {
  const current = await fixture(t, `${label}-file-swap`);
  await assert.rejects(readCliJsonInput(current.path, label, StrictValueSchema, {
    privateInput: true,
    operations: {
      async afterPathStat() {
        await rename(current.path, join(current.directory, "retained.json"));
        await writeFile(current.path, '{"value":"attacker"}\n', { mode: 0o600 });
      },
    },
  }), new RegExp(`${label} file is unsafe or invalid`, "i"));
}

async function rejectsAncestorSwap(t: TestContext, label: string) {
  const current = await fixture(t, `${label}-ancestor-swap`);
  await assert.rejects(readCliJsonInput(current.path, label, StrictValueSchema, {
    privateInput: true,
    operations: {
      async afterParentOpen() {
        await rename(current.directory, join(current.root, "retained"));
        await mkdir(current.directory);
        await writeFile(current.path, '{"value":"attacker"}\n', { mode: 0o600 });
      },
    },
  }), new RegExp(`${label} file is unsafe or invalid`, "i"));
}

test("private delegated result and route-report inputs fail closed on file and ancestor swaps", async (t) => {
  for (const label of ["result", "route report"]) {
    await t.test(`${label} file swap`, (t) => rejectsFileSwap(t, label));
    await t.test(`${label} ancestor swap`, (t) => rejectsAncestorSwap(t, label));
  }
});

test("edit-plan, impact, and acceptance CLI inputs share the anchored swap-safe reader", async (t) => {
  await t.test("edit plan file swap", (t) => rejectsFileSwap(t, "edit plan"));
  await t.test("impact ancestor swap", (t) => rejectsAncestorSwap(t, "impact change"));
  await t.test("acceptance file swap", (t) => rejectsFileSwap(t, "client acceptance input"));
});

test("private CLI input requires exact mode 0600 and rejects extra schema fields", async (t) => {
  const current = await fixture(t, "strict-private");
  if (process.platform !== "win32") {
    await chmod(current.path, 0o640);
    await assert.rejects(readCliJsonInput(current.path, "result", StrictValueSchema, {
      privateInput: true,
    }), /result file must be private \(mode 0600\)/i);
    await chmod(current.path, 0o600);
  }
  await writeFile(current.path, '{"value":"trusted","extra":true}\n', { mode: 0o600 });
  await assert.rejects(readCliJsonInput(current.path, "result", StrictValueSchema, {
    privateInput: true,
  }), /result file is unsafe or invalid/i);
});
