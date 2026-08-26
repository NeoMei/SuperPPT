import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { initializeProject } from "../src/project/initialize.js";
import { readProject, writeProject } from "../src/project/store.js";

const execFileAsync = promisify(execFile);
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const DIRECTORIES = [
  "source",
  "slides",
  "style/references",
  "style/sample",
  "images",
  "editable",
  "previews",
  "output",
  "failed-runs",
];

async function temporaryParent(t: TestContext, prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  return realpath(parent);
}

test("initializes the complete owned workspace and reopens it", async (t) => {
  const parent = await temporaryParent(t, "superppt-project-");
  const root = join(parent, "demo");
  const manifest = await initializeProject({
    root,
    title: "AI Agent 协作系统",
    idFactory: () => PROJECT_ID,
  });

  assert.equal(manifest.projectId, PROJECT_ID);
  assert.equal(manifest.stage, "intake");
  assert.deepEqual((await readProject(root)).slides, []);
  const marker = JSON.parse(
    await readFile(join(root, ".superppt-project.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(marker.appId, "superppt");
  assert.equal(marker.markerVersion, 1);
  assert.equal(marker.artifactKind, "project");
  assert.equal(marker.projectId, PROJECT_ID);
  assert.equal(marker.canonicalRoot, root);
  assert.equal(
    await readFile(join(root, "项目状态.md"), "utf8"),
    "# AI Agent 协作系统\n\n当前阶段：内容接收\n",
  );
  await Promise.all(DIRECTORIES.map((directory) => access(join(root, directory))));
  assert.equal((await lstat(join(root, "superppt.json"))).mode & 0o777, 0o600);
});

test("refuses roots, source files, unowned targets, and symlink aliases", async (t) => {
  const parent = await temporaryParent(t, "superppt-unsafe-");
  const source = join(parent, "source.md");
  const unowned = join(parent, "unowned");
  await writeFile(source, "source");
  await mkdir(unowned);
  const alias = join(parent, "alias");
  await symlink(dirname(process.cwd()), alias);

  const unsafeRoots = [
    "",
    ".",
    "relative-project",
    parse(process.cwd()).root,
    process.cwd(),
    dirname(process.cwd()),
    source,
    unowned,
    alias,
  ];
  for (const root of unsafeRoots) {
    await assert.rejects(
      initializeProject({ root, title: "unsafe" }),
      /Unsafe project root|directory is not owned/,
      root,
    );
  }

  assert.deepEqual(await readdir(unowned), []);
  await assert.rejects(readProject(unowned), /directory is not owned/);
});

test("refuses an intermediate symlink alias without mutating its target", async (t) => {
  const parent = await temporaryParent(t, "superppt-alias-");
  const target = join(parent, "target");
  const alias = join(parent, "alias");
  await mkdir(target);
  await symlink(target, alias);

  await assert.rejects(
    initializeProject({ root: join(alias, "demo"), title: "unsafe" }),
    /Unsafe project root/,
  );
  assert.deepEqual(await readdir(target), []);
});

test("rejects an invalid manifest before creating a project directory", async (t) => {
  const parent = await temporaryParent(t, "superppt-invalid-");
  const root = join(parent, "demo");

  await assert.rejects(
    initializeProject({ root, title: "", idFactory: () => "not-a-uuid" }),
    /Invalid/,
  );
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("retains the previous manifest when a staged write fails validation", async (t) => {
  const parent = await temporaryParent(t, "superppt-atomic-");
  const root = join(parent, "demo");
  const current = await initializeProject({
    root,
    title: "Demo",
    idFactory: () => "00000000-0000-4000-8000-000000000002",
  });
  const before = await readFile(join(root, "superppt.json"), "utf8");

  await assert.rejects(
    writeProject(root, { ...current, schemaVersion: 99 as 1 }),
    /Invalid/,
  );
  assert.equal(await readFile(join(root, "superppt.json"), "utf8"), before);
  assert.equal((await readProject(root)).schemaVersion, 1);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes(".staging.")),
    [],
  );
});

test("refuses manifest writes after ownership is removed", async (t) => {
  const parent = await temporaryParent(t, "superppt-ownership-");
  const root = join(parent, "demo");
  const current = await initializeProject({ root, title: "Demo" });
  await writeFile(
    join(root, ".superppt-project.json"),
    JSON.stringify({ markerVersion: 1, appId: "someone-else", artifactKind: "project" }),
  );

  await assert.rejects(writeProject(root, current), /directory is not owned/);
  await assert.rejects(readProject(root), /directory is not owned/);
});

test("binds ownership to the canonical root and manifest project UUID", async (t) => {
  const parent = await temporaryParent(t, "superppt-marker-copy-");
  const firstRoot = join(parent, "first");
  const secondRoot = join(parent, "second");
  const first = await initializeProject({ root: firstRoot, title: "First" });
  const second = await initializeProject({ root: secondRoot, title: "Second" });
  const copiedMarker = await readFile(join(firstRoot, ".superppt-project.json"));
  await writeFile(join(secondRoot, ".superppt-project.json"), copiedMarker);

  await assert.rejects(readProject(secondRoot), /directory is not owned/);
  await assert.rejects(writeProject(secondRoot, second), /directory is not owned/);

  await writeFile(
    join(firstRoot, ".superppt-project.json"),
    `${JSON.stringify({
      markerVersion: 1,
      appId: "superppt",
      artifactKind: "project",
      projectId: second.projectId,
      canonicalRoot: firstRoot,
    })}\n`,
  );
  await assert.rejects(readProject(firstRoot), /directory is not owned/);
  await assert.rejects(writeProject(firstRoot, first), /directory is not owned/);
});

test("rejects a symlink ownership marker", async (t) => {
  const parent = await temporaryParent(t, "superppt-marker-link-");
  const root = join(parent, "demo");
  const manifest = await initializeProject({ root, title: "Demo" });
  const marker = join(root, ".superppt-project.json");
  const markerBackup = join(root, ".superppt-project.backup.json");
  await rename(marker, markerBackup);
  await symlink(markerBackup, marker);

  await assert.rejects(readProject(root), /directory is not owned/);
  await assert.rejects(writeProject(root, manifest), /directory is not owned/);
});

test("retains failed initialization evidence without exposing a partial project", async (t) => {
  const parent = await temporaryParent(t, "superppt-init-fail-");
  const checkpoints = ["marker-written", "status-written", "manifest-synced"];

  for (const [index, failedAt] of checkpoints.entries()) {
    const root = join(parent, `demo-${index}`);
    await assert.rejects(
      initializeProject({
        root,
        title: `Failure ${index}`,
        operations: {
          checkpoint(step: string) {
            if (step === failedAt) throw new Error(`injected ${failedAt}`);
          },
        },
      }),
      new RegExp(`injected ${failedAt}`),
    );
    await assert.rejects(lstat(root), { code: "ENOENT" });
  }

  const evidence = (await readdir(parent)).filter((name) =>
    name.includes(".superppt-init-") && name.endsWith(".failed-run")
  );
  assert.equal(evidence.length, checkpoints.length);
  assert.ok(evidence.some((name) => name.startsWith(".demo-0.")));
  assert.ok(evidence.some((name) => name.startsWith(".demo-1.")));
  assert.ok(evidence.some((name) => name.startsWith(".demo-2.")));
});

test("retains a complete failed run when initialization promotion fails", async (t) => {
  const parent = await temporaryParent(t, "superppt-init-promote-");
  const root = join(parent, "demo");

  await assert.rejects(
    initializeProject({
      root,
      title: "Promotion failure",
      operations: {
        async promote() {
          throw new Error("injected initialization promotion failure");
        },
      },
    }),
    /injected initialization promotion failure/,
  );
  await assert.rejects(lstat(root), { code: "ENOENT" });
  const [failedRun] = (await readdir(parent)).filter((name) =>
    name.startsWith(".demo.superppt-init-") && name.endsWith(".failed-run")
  );
  assert.ok(failedRun);
  const failedRoot = join(parent, failedRun);
  await Promise.all([
    access(join(failedRoot, ".superppt-project.json")),
    access(join(failedRoot, "superppt.json")),
    access(join(failedRoot, "项目状态.md")),
    ...DIRECTORIES.map((directory) => access(join(failedRoot, directory))),
  ]);

  const retry = await initializeProject({ root, title: "Retry" });
  assert.equal(retry.title, "Retry");
});

test("moves a promoted root to failed evidence when promotion throws afterward", async (t) => {
  const parent = await temporaryParent(t, "superppt-init-post-promote-");
  const root = join(parent, "demo");

  await assert.rejects(
    initializeProject({
      root,
      title: "Post-promotion failure",
      operations: {
        async promote(stagingRoot: string, finalRoot: string) {
          await rename(stagingRoot, finalRoot);
          throw new Error("injected after initialization promotion");
        },
      },
    }),
    /injected after initialization promotion/,
  );

  await assert.rejects(lstat(root), { code: "ENOENT" });
  const evidence = (await readdir(parent)).filter((name) =>
    name.startsWith(".demo.superppt-init-") && name.endsWith(".failed-run")
  );
  assert.equal(evidence.length, 1);
  await access(join(parent, evidence[0]!, "superppt.json"));
});

test("keeps old manifest bytes and staged evidence when a durable write fails", async (t) => {
  const parent = await temporaryParent(t, "superppt-write-fail-");
  const root = join(parent, "demo");
  const current = await initializeProject({ root, title: "Original" });
  const updated = { ...current, title: "Updated" };
  const manifestPath = join(root, "superppt.json");
  const before = await readFile(manifestPath, "utf8");

  await assert.rejects(
    writeProject(root, updated, {
      checkpoint(step: string) {
        if (step === "staged-written") throw new Error("injected after staged write");
      },
    }),
    /injected after staged write/,
  );
  assert.equal(await readFile(manifestPath, "utf8"), before);
  let staging = (await readdir(root)).filter((name) => name.endsWith(".staging.json"));
  assert.equal(staging.length, 1);
  assert.equal(
    (JSON.parse(await readFile(join(root, staging[0]!), "utf8")) as { title: string }).title,
    "Updated",
  );

  await assert.rejects(
    writeProject(root, updated, {
      async promote() {
        throw new Error("injected manifest promotion failure");
      },
    }),
    /injected manifest promotion failure/,
  );
  assert.equal(await readFile(manifestPath, "utf8"), before);
  staging = (await readdir(root)).filter((name) => name.endsWith(".staging.json"));
  assert.equal(staging.length, 2);
});

test("syncs the staged manifest and project directory around promotion", async (t) => {
  const parent = await temporaryParent(t, "superppt-write-sync-");
  const root = join(parent, "demo");
  const current = await initializeProject({ root, title: "Original" });
  const checkpoints: string[] = [];

  await writeProject(root, { ...current, title: "Updated" }, {
    checkpoint(step: string) {
      checkpoints.push(step);
    },
  });

  assert.deepEqual(checkpoints, [
    "staged-written",
    "staged-synced",
    "manifest-promoted",
    "parent-synced",
  ]);
  assert.equal((await readProject(root)).title, "Updated");
});

test("CLI initializes and reports project status without changing preflight routing", async (t) => {
  const parent = await temporaryParent(t, "superppt-cli-");
  const root = join(parent, "demo");
  const invocation = ["--import", "tsx", "src/cli.ts"];

  const initialized = await execFileAsync(
    process.execPath,
    [...invocation, "init", "--project", root, "--title", "CLI Demo"],
    { cwd: process.cwd() },
  );
  assert.equal(initialized.stderr, "");
  assert.equal((JSON.parse(initialized.stdout) as { title: string }).title, "CLI Demo");

  const status = await execFileAsync(
    process.execPath,
    [...invocation, "status", "--project", root],
    { cwd: process.cwd() },
  );
  assert.equal(status.stderr, "");
  assert.equal((JSON.parse(status.stdout) as { stage: string }).stage, "intake");

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...invocation, "status", "--project", root, "--project", root],
      { cwd: process.cwd() },
    ),
    /invalid or duplicate CLI flag/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [...invocation, "unknown"], {
      cwd: process.cwd(),
    }),
    /unknown command/,
  );
});
