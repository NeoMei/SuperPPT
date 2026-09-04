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
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { initializeProject } from "../src/project/initialize.js";
import { ProjectManifestSchema } from "../src/project/schemas.js";
import {
  beginProjectRollbackTransaction,
  commitApprovedImpactRevision,
  finishProjectRollbackTransaction,
  readProject,
  updateProject,
  writeProject,
} from "../src/project/store.js";
import * as projectStore from "../src/project/store.js";
import { applyRevision, approveImpact, publishImpactPlan } from "../src/revisions/apply.js";
import { planImpact } from "../src/revisions/impact.js";
import { publishRevisionSnapshot } from "../src/revisions/snapshot.js";

const execFileAsync = promisify(execFile);
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const DIRECTORIES = [
  "source",
  "slides",
  "style/references",
  "style/sample",
  "images",
  "editable",
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
  await assert.rejects(access(join(root, "previews")), { code: "ENOENT" });
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(root, "superppt.json"))).mode & 0o777, 0o600);
  }
});

test("rejects an oversized project manifest even when its JSON remains valid", async (t) => {
  const parent = await temporaryParent(t, "superppt-project-size-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "bounded manifest", idFactory: () => PROJECT_ID });
  const manifestPath = join(root, "superppt.json");
  const original = await readFile(manifestPath);
  await writeFile(manifestPath, Buffer.concat([original, Buffer.alloc(16 * 1024 * 1024, 0x20)]));

  await assert.rejects(readProject(root), /directory is not owned|size|limit/i);
});

test("generation authorization and complete-deck review stages accept authenticated evidence", async (t) => {
  const parent = await temporaryParent(t, "superppt-guided-stage-model-");
  const root = join(parent, "demo");
  const manifest = await initializeProject({
    root,
    title: "Guided stages",
    idFactory: () => PROJECT_ID,
  });

  for (const stage of ["style-sample", "generation-authorization", "deck-review"] as const) {
    assert.equal(ProjectManifestSchema.parse({ ...manifest, stage }).stage, stage);
  }
  const generation = ProjectManifestSchema.parse({
    ...manifest,
    gates: [{
      gate: "generation-authorization",
      revisionId: manifest.currentRevision.id,
      artifactHashes: { "generation/authorization-plan.json": "a".repeat(64) },
      presentation: {
        kind: "generation-plan",
        publicationPath: "generation/authorization-plan.json",
        descriptorSha256: "a".repeat(64),
      },
      confirmedAt: new Date().toISOString(),
    }],
  });
  assert.equal(generation.gates[0]!.presentation?.kind, "generation-plan");

  const deckRevisionId = "00000000-0000-4000-8000-000000000099";
  const completeDeck = ProjectManifestSchema.parse({
    ...manifest,
    gates: [{
      gate: "deck-review",
      revisionId: manifest.currentRevision.id,
      artifactHashes: {},
      deckReview: {
        revisionId: deckRevisionId,
        absolutePath: `/tmp/project/output/deck-revisions/${deckRevisionId}/deck.pptx`,
        sha256: "b".repeat(64),
      },
      confirmedAt: new Date().toISOString(),
    }],
  });
  assert.equal(completeDeck.gates[0]!.deckReview?.revisionId, deckRevisionId);
  assert.equal(completeDeck.gates[0]!.presentation, undefined);
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
  await initializeProject({
    root,
    title: "Demo",
    idFactory: () => "00000000-0000-4000-8000-000000000002",
  });
  const current = await readProject(root);
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
  await initializeProject({ root, title: "Demo" });
  const current = await readProject(root);
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
  await initializeProject({ root: firstRoot, title: "First" });
  await initializeProject({ root: secondRoot, title: "Second" });
  const first = await readProject(firstRoot);
  const second = await readProject(secondRoot);
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
  await initializeProject({ root, title: "Demo" });
  const manifest = await readProject(root);
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
  await assert.rejects(access(join(failedRoot, "previews")), { code: "ENOENT" });

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

test("does not clobber an unowned target raced into initialization promotion", async (t) => {
  const parent = await temporaryParent(t, "superppt-init-race-");
  const root = join(parent, "demo");
  const sentinel = join(root, "sentinel.txt");
  const bytes = Buffer.from([0, 1, 2, 3, 255]);

  await assert.rejects(
    initializeProject({
      root,
      title: "Raced project",
      operations: {
        async beforeExclusivePromote() {
          await mkdir(root);
          await writeFile(sentinel, bytes);
        },
      },
    }),
    /already exists|EEXIST/,
  );

  assert.deepEqual(await readFile(sentinel), bytes);
  assert.deepEqual(await readdir(root), ["sentinel.txt"]);
  const evidence = (await readdir(parent)).filter((name) =>
    name.startsWith(".demo.superppt-init-") && name.endsWith(".failed-run")
  );
  assert.equal(evidence.length, 1);
  await access(join(parent, evidence[0]!, "superppt.json"));
});

test("Windows atomically promotes a new project directory", {
  skip: process.platform !== "win32",
}, async (t) => {
  const parent = await temporaryParent(t, "superppt-win-promote-");
  const root = join(parent, "demo");

  const manifest = await initializeProject({ root, title: "Windows Demo" });

  assert.equal((await readProject(root)).projectId, manifest.projectId);
  await access(join(root, ".superppt-project.json"));
});

test("Windows atomic promotion preserves a raced target", {
  skip: process.platform !== "win32",
}, async (t) => {
  const parent = await temporaryParent(t, "superppt-win-race-");
  const root = join(parent, "demo");
  const sentinel = join(root, "sentinel.bin");
  const bytes = Buffer.from([255, 0, 127, 64]);

  await assert.rejects(initializeProject({
    root,
    title: "Windows race",
    operations: {
      async beforeExclusivePromote() {
        await mkdir(root);
        await writeFile(sentinel, bytes);
      },
    },
  }), /already exists|EEXIST/);

  assert.deepEqual(await readFile(sentinel), bytes);
  assert.deepEqual(await readdir(root), ["sentinel.bin"]);
  assert.equal(
    (await readdir(parent)).filter((name) => name.endsWith(".failed-run")).length,
    1,
  );
});

test("keeps old manifest bytes and staged evidence when a durable write fails", async (t) => {
  const parent = await temporaryParent(t, "superppt-write-fail-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "Original" });
  const current = await readProject(root);
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
  await initializeProject({ root, title: "Original" });
  const current = await readProject(root);
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

test("writeProject rejects a manifest object read before an intervening update", async (t) => {
  const root = join(await temporaryParent(t, "superppt-stale-base-"), "demo");
  await initializeProject({ root, title: "Original" });
  const stale = await readProject(root);
  const current = await readProject(root);

  await writeProject(root, { ...current, title: "Current update" });
  await assert.rejects(
    writeProject(root, { ...stale, stage: "outline" }),
    /stale project manifest base/,
  );

  const persisted = await readProject(root);
  assert.equal(persisted.title, "Current update");
  assert.equal(persisted.stage, "intake");
});

test("rejects removing, changing, or reordering persisted revisions", async (t) => {
  const parent = await temporaryParent(t, "superppt-revision-prefix-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "Demo" });
  const first = await readProject(root);
  const plan = await publishImpactPlan(root, { kind: "brief", title: "Revision 2" });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);
  const persisted = await readProject(root);
  const before = await readFile(join(root, "superppt.json"), "utf8");
  const mutations = [
    {
      ...persisted,
      currentRevision: persisted.revisions[0]!,
      revisions: persisted.revisions.slice(0, 1),
    },
    {
      ...persisted,
      currentRevision: { ...persisted.currentRevision, number: 99 },
      revisions: [
        persisted.revisions[0]!,
        { ...persisted.revisions[1]!, number: 99 },
      ],
    },
    {
      ...persisted,
      currentRevision: persisted.revisions[0]!,
      revisions: [persisted.revisions[1]!, persisted.revisions[0]!],
    },
    {
      ...persisted,
      currentRevision: persisted.revisions[0]!,
    },
  ];

  for (const mutation of mutations) {
    await assert.rejects(
      writeProject(root, mutation),
      /immutable revision history/,
    );
    assert.equal(await readFile(join(root, "superppt.json"), "utf8"), before);
  }
});

test("does not expose a generic privileged revision append API", async (t) => {
  const parent = await temporaryParent(t, "superppt-revision-append-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "Demo" });
  const first = await readProject(root);
  const next = {
    id: "00000000-0000-4000-8000-000000000103",
    number: 2,
    createdAt: new Date().toISOString(),
    parentId: first.currentRevision.id,
  };
  assert.equal("updateProjectWithRevisionAppend" in projectStore, false);
  await assert.rejects(writeProject(root, {
    ...first,
    currentRevision: next,
    revisions: [...first.revisions, next],
  }), /controlled store transition/);
});

test("rejects appending a revision while retaining the old currentRevision", async (t) => {
  const parent = await temporaryParent(t, "superppt-revision-old-current-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "Demo" });
  const first = await readProject(root);
  const next = {
    id: "00000000-0000-4000-8000-000000000105",
    number: 2,
    createdAt: new Date().toISOString(),
    parentId: first.currentRevision.id,
  };
  const before = await readFile(join(root, "superppt.json"), "utf8");

  await assert.rejects(writeProject(root, {
    ...first,
    revisions: [...first.revisions, next],
  }), /currentRevision.*appended tail/);

  assert.equal(await readFile(join(root, "superppt.json"), "utf8"), before);
});

test("rejects forged rollback trust fields through ordinary project updates", async (t) => {
  const parent = await temporaryParent(t, "superppt-rollback-marker-forge-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "Demo" });
  const current = await readProject(root);
  await assert.rejects(updateProject(root, (manifest) => ({
    ...manifest,
    rollbackTransaction: {
      transactionId: "00000000-0000-4000-8000-000000000201",
      baseRevisionId: current.currentRevision.id,
      targetRevisionId: current.currentRevision.id,
      rollbackRevisionId: "00000000-0000-4000-8000-000000000202",
      descriptorSha256: "a".repeat(64),
    },
  })), /controlled store transition/);
  assert.equal((await readProject(root)).rollbackTransaction, undefined);
});

test("public revision transition APIs cannot accept privileged updater forgeries", async (t) => {
  const parent = await temporaryParent(t, "superppt-transition-api-forge-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "Demo" });
  const initial = await readProject(root);
  const forgedPlan = planImpact(initial, { kind: "brief", title: "Forged" });
  await assert.rejects(
    commitApprovedImpactRevision(root, forgedPlan, forgedPlan.change),
    /pending impact evidence|approved before apply|must be approved/i,
  );
  const forgedUpdater = (manifest: typeof initial) => ({
    ...manifest,
    title: "Forged",
    rollbackTransaction: {
      transactionId: "00000000-0000-4000-8000-000000000211",
      baseRevisionId: manifest.currentRevision.id,
      targetRevisionId: manifest.currentRevision.id,
      rollbackRevisionId: "00000000-0000-4000-8000-000000000212",
      descriptorSha256: "b".repeat(64),
    },
  });
  await assert.rejects(
    (beginProjectRollbackTransaction as unknown as (root: string, updater: unknown) => Promise<void>)(root, forgedUpdater),
    /not in the project revision ledger/,
  );
  await assert.rejects(
    (finishProjectRollbackTransaction as unknown as (root: string, updater: unknown) => Promise<void>)(root, forgedUpdater),
    /rollback journal/i,
  );
  const reopened = await readProject(root);
  assert.equal(reopened.title, "Demo");
  assert.equal(reopened.revisions.length, 1);
  assert.equal(reopened.rollbackTransaction, undefined);
});

test("requires an exact planned revision snapshot before dropping old artifact evidence", async (t) => {
  const parent = await temporaryParent(t, "superppt-artifact-history-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "Demo" });
  const initial = await readProject(root);
  const withArtifact = {
    ...initial,
    brief: {
      path: "source/brief.json",
      sha256: "a".repeat(64),
      revisionId: initial.currentRevision.id,
    },
  };
  await writeProject(root, withArtifact);
  const persisted = await readProject(root);
  const dropsArtifact = {
    ...persisted,
    brief: null,
  };

  await assert.rejects(
    updateProject(root, () => dropsArtifact),
    /snapshot|openat/i,
  );

  const externalSnapshot = join(parent, "external-snapshot");
  await mkdir(join(externalSnapshot, persisted.currentRevision.id), {
    recursive: true,
  });
  await writeFile(
    join(externalSnapshot, persisted.currentRevision.id, "superppt.json"),
    `${JSON.stringify(persisted, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await rmdir(join(root, "revisions"));
  await symlink(externalSnapshot, join(root, "revisions"));
  await assert.rejects(
    updateProject(root, () => dropsArtifact),
    /snapshot|unsafe|not a directory/i,
  );
  await unlink(join(root, "revisions"));

  await mkdir(join(root, "revisions"));
  await publishRevisionSnapshot(root, persisted);
  await updateProject(root, () => dropsArtifact);
  assert.equal((await readProject(root)).brief, null);
});

test("ordinary project updates cannot forge delegated generation history", async (t) => {
  const parent = await temporaryParent(t, "superppt-generation-history-forge-");
  const root = join(parent, "demo");
  await initializeProject({ root, title: "Demo" });
  await assert.rejects(updateProject(root, (current) => ({
    ...current,
    slides: [{
      id: "00000000-0000-4000-8000-000000000311",
      order: 0,
      title: "Forged",
      role: "cover",
      specRevisionId: current.currentRevision.id,
      promptRevisionId: current.currentRevision.id,
      styleRevisionId: current.currentRevision.id,
      status: "ready",
      image: null,
      generationHistory: [{
        jobId: "00000000-0000-4000-8000-000000000312",
        authorizationSequence: 1,
        attempt: 1,
        image: { path: "forged.png", sha256: "a".repeat(64), revisionId: current.currentRevision.id },
        finalRender: { path: "forged.png", sha256: "a".repeat(64), revisionId: current.currentRevision.id },
      }],
      editable: null,
      finalRender: null,
      staleReasons: [],
    }],
  })), /generation history requires an authenticated attachment/i);
  assert.deepEqual((await readProject(root)).slides, []);
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

test("delegation CLI exposes only explicit Agent-mediated image routes", async () => {
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const localHandoffEnvironment = {
    ...process.env,
    SUPERPPT_HOST_CAPABILITIES: JSON.stringify({
      source: "agent-host",
      localFilesystem: true,
      localFileLinks: true,
    }),
  };
  const invoke = async (args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> => {
    try {
      await execFileAsync(process.execPath, [...invocation, ...args], { cwd: process.cwd(), env });
      return "";
    } catch (error: unknown) {
      return String((error as { stderr?: string }).stderr ?? error);
    }
  };

  for (const command of [
    "preflight",
    "publish-sample-generation-plan",
    "prepare-style-sample-job",
    "record-image-result",
    "finalize-style-sample",
    "publish-generation-plan",
    "prepare-deck-job",
    "admit-image-call",
    "prepare-page-regeneration-job",
    "generation-status",
  ]) {
    const error = await invoke([command], localHandoffEnvironment);
    assert.match(error, /required CLI flags/);
    assert.doesNotMatch(error, /unknown command/, command);
  }

  for (const command of ["assemble-candidate", "publish-deck-review", "deck-review-action"]) {
    assert.match(await invoke([command]), /complete deck|current-deck-link|prepare-manual-deck/i, command);
  }

  for (const command of ["current-deck-link", "prepare-manual-deck", "prepare-agent-deck"]) {
    const error = await invoke([command]);
    assert.match(error, /injected host capabilities/i, command);
    assert.doesNotMatch(error, /unknown command/, command);
  }

  for (const command of ["generate-style-sample", "generate", "retry-page", "record-qa", "assemble", "promote-delivery"]) {
    assert.match(await invoke([command]), /unknown command/, command);
  }

  assert.match(await invoke([
    "preflight",
    "--ai-skill", "/missing-ai",
    "--editable-skill", "/missing-editable",
    "--provider", "openai",
  ], localHandoffEnvironment), /unknown CLI flag: --provider/);
  assert.match(await invoke([
    "prepare-deck-job",
    "--project", "/missing-project",
    "--ai-skill", "/missing-ai",
    "--concurrency", "2",
  ], localHandoffEnvironment), /unknown CLI flag: --concurrency/);
  assert.match(await invoke(["generation-status", "--project"]), /invalid or duplicate CLI flag/);

  const environmentOnly = {
    ...localHandoffEnvironment,
    SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: "/environment-ai",
    SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: "/environment-editable",
  };
  assert.match(await invoke(["preflight"], environmentOnly), /required CLI flags/);
});
