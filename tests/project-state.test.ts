import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  return parent;
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
