import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
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
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { approveExecutionGate, approveGate } from "../src/planning/confirm.js";
import { publishPlanViews } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import {
  commitApprovedImpactRevision,
  readProject,
  updateProject,
  writeProject,
} from "../src/project/store.js";
import {
  applyRevision,
  approveImpact,
  publishImpactPlan,
  recoverRollbackTransaction,
  rollbackToRevision,
} from "../src/revisions/apply.js";
import { moveFileDurable } from "../src/revisions/anchored-fs.js";
import {
  ImpactPlanSchema,
  planImpact,
} from "../src/revisions/impact.js";
import { publishRevisionSnapshot } from "../src/revisions/snapshot.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000301";
const A = "00000000-0000-4000-8000-000000000401";
const B = "00000000-0000-4000-8000-000000000402";
const C = "00000000-0000-4000-8000-000000000403";
const UNKNOWN = "00000000-0000-4000-8000-000000000499";
const execFileAsync = promisify(execFile);

async function project(t: TestContext, prefix: string): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await initializeProject({ root, title: "Demo", idFactory: () => PROJECT_ID });
  return root;
}

async function manifestWithSlides(t: TestContext) {
  const manifest = await readProject(await project(t, "superppt-impact-plan-"));
  manifest.slides = [A, B].map((id, order) => ({
    id,
    order,
    title: id,
    role: "content" as const,
    specRevisionId: manifest.currentRevision.id,
    promptRevisionId: manifest.currentRevision.id,
    styleRevisionId: manifest.currentRevision.id,
    status: "ready" as const,
    image: null,
    editable: null,
    finalRender: null,
    staleReasons: [],
  }));
  return manifest;
}

async function seedSlides(root: string): Promise<void> {
  const artifacts = [
    [`images/${A}.png`, Buffer.from("image-a")],
    [`images/${B}.png`, Buffer.from("image-b")],
    [`previews/${A}.png`, Buffer.from("preview-a")],
    [`previews/${B}.png`, Buffer.from("preview-b")],
    ["output/deck.pptx", Buffer.from("deck")],
  ] as const;
  for (const [path, bytes] of artifacts) {
    await writeFile(join(root, ...path.split("/")), bytes);
  }
  const hashes = Object.fromEntries(artifacts.map(([path, bytes]) => [
    path,
    createHash("sha256").update(bytes).digest("hex"),
  ]));
  await updateProject(root, (manifest) => ({
    ...manifest,
    slides: [A, B].map((id, order) => ({
      id,
      order,
      title: id,
      role: "content" as const,
      specRevisionId: manifest.currentRevision.id,
      promptRevisionId: manifest.currentRevision.id,
      styleRevisionId: manifest.currentRevision.id,
      status: "ready" as const,
      image: {
        path: `images/${id}.png`,
        sha256: hashes[`images/${id}.png`]!,
        revisionId: manifest.currentRevision.id,
      },
      editable: null,
      finalRender: {
        path: `previews/${id}.png`,
        sha256: hashes[`previews/${id}.png`]!,
        revisionId: manifest.currentRevision.id,
      },
      staleReasons: [],
    })),
    exports: {
      ...manifest.exports,
      pptx: {
        path: "output/deck.pptx",
        sha256: hashes["output/deck.pptx"]!,
        revisionId: manifest.currentRevision.id,
      },
    },
  }));
}

const approvedBrief = {
  schemaVersion: 1 as const,
  title: "Authenticated V1",
  purpose: "Exercise revision evidence",
  audience: "Reviewers",
  language: "en-US",
  targetSlides: 3,
  mustCover: ["alpha", "beta", "gamma"],
  constraints: ["16:9"],
};

const approvedOutline = {
  schemaVersion: 1 as const,
  slides: [A, B, C].map((id, order) => ({
    id,
    order,
    title: ["Alpha", "Beta", "Gamma"][order]!,
    role: (order === 0 ? "cover" : order === 2 ? "summary" : "content") as "cover" | "content" | "summary",
    purpose: ["Explain alpha", "Explain beta", "Explain gamma"][order]!,
    sourceRefs: [`L${order + 1}`],
  })),
};

async function writeApprovedOutline(
  root: string,
  brief = approvedBrief,
  outline = approvedOutline,
): Promise<void> {
  await writeFile(join(root, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline, null, 2)}\n`);
  for (const slide of outline.slides) {
    const directory = join(root, "slides", slide.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "spec.json"), `${JSON.stringify({
      schemaVersion: 1,
      slideId: slide.id,
      title: slide.title,
      role: slide.role,
      coreMessage: slide.purpose,
      requiredText: [slide.title],
      visualSubject: "One authenticated subject",
      composition: "one focal point",
      relationships: ["subject supports message"],
      forbidden: ["watermark"],
      sourceRefs: slide.sourceRefs,
    }, null, 2)}\n`);
  }
  await publishPlanViews(root);
  await approveGate(root, "outline");
}

async function advanceWithBriefArtifact(root: string, brief: typeof approvedBrief): Promise<void> {
  const plan = await publishImpactPlan(root, { kind: "brief", title: brief.title });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);
}

function revisionSnapshotRoot(root: string, revisionId: string): string {
  return join(root, "revisions", revisionId, "manifest-snapshot");
}

async function authenticatedRollbackVersions(
  t: TestContext,
  prefix: string,
): Promise<{
  root: string;
  targetId: string;
  current: Awaited<ReturnType<typeof readProject>>;
  beforeFiles: Map<string, Buffer>;
  targetFiles: Map<string, Buffer>;
}> {
  const root = await project(t, prefix);
  await writeApprovedOutline(root);
  const targetId = (await readProject(root)).currentRevision.id;
  const targetFiles = new Map([
    ["brief.json", await readFile(join(root, "brief.json"))],
    ["outline.json", await readFile(join(root, "outline.json"))],
  ]);
  const plan = await publishImpactPlan(root, { kind: "outline-order" });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);
  const v2Brief = { ...approvedBrief, title: `${prefix} V2` };
  const v2Outline = {
    ...approvedOutline,
    slides: approvedOutline.slides.map((slide) => ({
      ...slide,
      title: `${slide.title} ${prefix} V2`,
    })),
  };
  await advanceWithBriefArtifact(root, v2Brief);
  await writeApprovedOutline(root, v2Brief, v2Outline);
  const current = await readProject(root);
  const beforeFiles = new Map([
    ["brief.json", await readFile(join(root, "brief.json"))],
    ["outline.json", await readFile(join(root, "outline.json"))],
  ]);
  const firstPath = [...targetFiles.keys()].sort()[0]!;
  assert.equal(firstPath, "brief.json");
  assert.notDeepEqual(beforeFiles.get(firstPath), targetFiles.get(firstPath));
  return {
    root,
    targetId,
    current,
    beforeFiles,
    targetFiles,
  };
}

async function rawManifest(root: string) {
  return JSON.parse(await readFile(join(root, "superppt.json"), "utf8"));
}

test("plans local and global invalidation while preserving order-only images", async (t) => {
  const manifest = await manifestWithSlides(t);
  assert.deepEqual(planImpact(manifest, { kind: "slide-spec", slideIds: [B] }).staleSlideIds, [B]);
  assert.deepEqual(planImpact(manifest, { kind: "outline-structure", slideIds: [A] }).staleSlideIds, [A]);
  assert.deepEqual(planImpact(manifest, { kind: "style" }).staleSlideIds, [A, B]);
  assert.deepEqual(planImpact(manifest, { kind: "brief", title: "Changed" }).staleSlideIds, [A, B]);
  assert.deepEqual(planImpact(manifest, { kind: "outline-order" }).staleSlideIds, []);
});

test("uses durable non-replacing and replacing Windows moves with exact flags", () => {
  const calls: Array<{ source: string; target: string; flags: number }> = [];
  const api = {
    moveFileEx(source: string, target: string, flags: number): number {
      calls.push({ source, target, flags });
      return 1;
    },
    getLastError: () => 0,
  };
  moveFileDurable("pending.staging", "pending.json", true, "win32", api);
  moveFileDurable("approval.staging", "approval-id", false, "win32", api);
  assert.deepEqual(calls, [
    { source: "pending.staging", target: "pending.json", flags: 0x9 },
    { source: "approval.staging", target: "approval-id", flags: 0x8 },
  ]);
  assert.throws(() => moveFileDurable("a", "b", false, "win32", {
    moveFileEx: () => 0,
    getLastError: () => 5,
  }), /MoveFileExW failed: 5/);
});

test("rejects unknown, duplicate, and non-strict slide change identities", async (t) => {
  const manifest = await manifestWithSlides(t);
  assert.throws(
    () => planImpact(manifest, { kind: "slide-spec", slideIds: [UNKNOWN] }),
    /unknown slide ID/,
  );
  assert.throws(
    () => planImpact(manifest, { kind: "slide-spec", slideIds: [A, A] }),
    /unique/,
  );
  assert.throws(
    () => planImpact(manifest, { kind: "style", slideIds: [A] } as never),
    /unrecognized|invalid/i,
  );
});

test("produces a strict deterministic hash bound to the exact base manifest", async (t) => {
  const manifest = await manifestWithSlides(t);
  const first = planImpact(manifest, { kind: "slide-spec", slideIds: [B] });
  const second = planImpact(structuredClone(manifest), { kind: "slide-spec", slideIds: [B] });
  assert.deepEqual(first, second);
  assert.equal(ImpactPlanSchema.parse(first).sha256, first.sha256);
  assert.throws(() => ImpactPlanSchema.parse({ ...first, extra: true }), /unrecognized/i);

  const changed = structuredClone(manifest);
  changed.title = "Changed without a revision bump";
  const changedPlan = planImpact(changed, { kind: "slide-spec", slideIds: [B] });
  assert.equal(changedPlan.baseRevisionId, first.baseRevisionId);
  assert.notEqual(changedPlan.baseManifestSha256, first.baseManifestSha256);
  assert.notEqual(changedPlan.sha256, first.sha256);
});

test("publishes a fixed-path plan and requires a real exact-base approval before apply", async (t) => {
  const root = await project(t, "superppt-impact-apply-");
  await seedSlides(root);
  const before = await readProject(root);
  const plan = await publishImpactPlan(root, { kind: "slide-spec", slideIds: [B] });
  await access(join(root, "revisions", "pending-impact.json"));
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "revisions", "pending-impact.json"), "utf8")),
    plan,
  );
  await assert.rejects(
    applyRevision(root, plan, plan.change),
    /must be approved/,
  );

  await approveImpact(root, plan.sha256);
  const approved = await readProject(root);
  assert.equal(approved.gates.at(-1)?.gate, "revision-impact");
  await applyRevision(root, plan, plan.change);
  const applied = await readProject(root);
  assert.equal(applied.revisions.length, before.revisions.length + 1);
  assert.equal(applied.currentRevision.parentId, before.currentRevision.id);
  assert.equal(applied.slides[0]!.status, "ready");
  assert.ok(applied.slides[0]!.image);
  assert.equal(applied.slides[1]!.status, "stale");
  assert.equal(applied.slides[1]!.image, null);
  assert.equal(applied.slides[1]!.finalRender, null);
  assert.deepEqual(applied.slides[1]!.staleReasons, ["slide-spec"]);
  assert.equal(applied.exports.pptx, null);

  const snapshot = JSON.parse(await readFile(
    join(revisionSnapshotRoot(root, before.currentRevision.id), "superppt.json"),
    "utf8",
  ));
  assert.deepEqual(snapshot, JSON.parse(JSON.stringify(approved)));
  await assert.rejects(applyRevision(root, plan, plan.change), /stale|base revision/i);
});

test("requires current physical ordinary-gate evidence before approval and apply", async (t) => {
  const approvalRoot = await project(t, "superppt-impact-physical-approval-");
  await writeApprovedOutline(approvalRoot);
  const approvalPlan = await publishImpactPlan(approvalRoot, { kind: "brief", title: "V2" });
  await writeFile(join(approvalRoot, "brief.json"), `${JSON.stringify({
    ...approvedBrief,
    title: "Tampered before approval",
  }, null, 2)}\n`);
  await assert.rejects(
    approveImpact(approvalRoot, approvalPlan.sha256),
    /ordinary planning gate evidence is not current/,
  );
  assert.deepEqual((await readProject(approvalRoot)).gates.map((gate) => gate.gate), ["outline"]);

  const applyRoot = await project(t, "superppt-impact-physical-apply-");
  await writeApprovedOutline(applyRoot);
  const applyPlan = await publishImpactPlan(applyRoot, { kind: "brief", title: "V2" });
  await approveImpact(applyRoot, applyPlan.sha256);
  const approved = await readProject(applyRoot);
  await writeFile(join(applyRoot, "brief.json"), `${JSON.stringify({
    ...approvedBrief,
    title: "Tampered after approval",
  }, null, 2)}\n`);
  await assert.rejects(
    applyRevision(applyRoot, applyPlan, applyPlan.change),
    /ordinary planning gate evidence is not current/,
  );
  assert.equal((await readProject(applyRoot)).currentRevision.id, approved.currentRevision.id);
  await assert.rejects(access(join(
    applyRoot,
    "revisions",
    approved.currentRevision.id,
    "superppt.json",
  )), { code: "ENOENT" });
});

test("requires every manifest Artifact reference to match owned physical bytes", async (t) => {
  const v1 = Buffer.from("artifact-v1");
  const artifactSha256 = createHash("sha256").update(v1).digest("hex");
  const approvalRoot = await project(t, "superppt-impact-artifact-approval-");
  const artifactPath = join(approvalRoot, "source", "brief.bin");
  await writeFile(artifactPath, v1);
  await updateProject(approvalRoot, (manifest) => ({
    ...manifest,
    brief: {
      path: "source/brief.bin",
      sha256: artifactSha256,
      revisionId: manifest.currentRevision.id,
    },
  }));
  const approvalPlan = await publishImpactPlan(approvalRoot, { kind: "style" });
  await writeFile(artifactPath, "artifact-v2");
  await assert.rejects(
    approveImpact(approvalRoot, approvalPlan.sha256),
    /manifest Artifact reference is not current/,
  );
  assert.deepEqual((await readProject(approvalRoot)).gates, []);

  const applyRoot = await project(t, "superppt-impact-artifact-apply-");
  const applyArtifactPath = join(applyRoot, "source", "brief.bin");
  await writeFile(applyArtifactPath, v1);
  await updateProject(applyRoot, (manifest) => ({
    ...manifest,
    brief: {
      path: "source/brief.bin",
      sha256: artifactSha256,
      revisionId: manifest.currentRevision.id,
    },
  }));
  const applyPlan = await publishImpactPlan(applyRoot, { kind: "style" });
  await approveImpact(applyRoot, applyPlan.sha256);
  const before = await readProject(applyRoot);
  await writeFile(applyArtifactPath, "artifact-v2");
  await assert.rejects(
    applyRevision(applyRoot, applyPlan, applyPlan.change),
    /manifest Artifact reference is not current/,
  );
  assert.equal((await readProject(applyRoot)).currentRevision.id, before.currentRevision.id);
});

test("rolls back by appending a new revision while preserving the full ledger", async (t) => {
  const root = await project(t, "superppt-impact-rollback-");
  await seedSlides(root);
  const before = await readProject(root);
  const plan = await publishImpactPlan(root, { kind: "brief", title: "After" });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);
  const changed = await readProject(root);
  assert.equal(changed.title, "After");

  await rollbackToRevision(root, before.currentRevision.id);
  const rolledBack = await readProject(root);
  assert.equal(rolledBack.title, "Demo");
  assert.equal(rolledBack.revisions.length, changed.revisions.length + 1);
  assert.deepEqual(
    rolledBack.revisions.slice(0, changed.revisions.length),
    changed.revisions,
  );
  assert.equal(rolledBack.currentRevision.parentId, changed.currentRevision.id);
  assert.equal(rolledBack.currentRevision.number, changed.currentRevision.number + 1);
  assert.deepEqual(rolledBack.gates, changed.gates);
  assert.deepEqual(rolledBack.slides, before.slides);
  assert.deepEqual(
    JSON.parse(await readFile(
      join(revisionSnapshotRoot(root, changed.currentRevision.id), "superppt.json"),
      "utf8",
    )),
    JSON.parse(JSON.stringify(changed)),
  );
});

test("restores authenticated fixed planning artifacts from the rollback target", async (t) => {
  const root = await project(t, "superppt-rollback-artifacts-");
  await writeApprovedOutline(root);
  const v1Brief = await readFile(join(root, "brief.json"));
  const v1Outline = await readFile(join(root, "outline.json"));
  const executionPath = join(root, "style", "sample", "generation-plan.json");
  const v1Execution = Buffer.from("{\"schemaVersion\":1,\"authorization\":\"v1\"}\n");
  await writeFile(executionPath, v1Execution);
  await approveExecutionGate(root, "style-sample-generation", "style/sample/generation-plan.json");
  const targetId = (await readProject(root)).currentRevision.id;

  const plan = await publishImpactPlan(root, { kind: "outline-order" });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);

  const v2Brief = { ...approvedBrief, title: "Authenticated V2" };
  const v2Outline = {
    ...approvedOutline,
    slides: approvedOutline.slides.map((slide) => ({
      ...slide,
      title: `${slide.title} V2`,
    })),
  };
  await advanceWithBriefArtifact(root, v2Brief);
  await writeApprovedOutline(root, v2Brief, v2Outline);
  await writeFile(executionPath, "{\"schemaVersion\":1,\"authorization\":\"v2\"}\n");
  const before = await readProject(root);
  assert.notDeepEqual(await readFile(join(root, "brief.json")), v1Brief);
  assert.notDeepEqual(await readFile(join(root, "outline.json")), v1Outline);

  await rollbackToRevision(root, targetId);

  const rolledBack = await readProject(root);
  assert.deepEqual(await readFile(join(root, "brief.json")), v1Brief);
  assert.deepEqual(await readFile(join(root, "outline.json")), v1Outline);
  assert.deepEqual(await readFile(executionPath), v1Execution);
  assert.equal(rolledBack.revisions.length, before.revisions.length + 1);
  assert.deepEqual(rolledBack.gates, before.gates);
  assert.ok(rolledBack.slides.every((slide) => (slide.generationHistory ?? []).length === 0));
  assert.equal(rolledBack.brief, null);
});

test("recovers rollback journals at every durable crash boundary", async (t) => {
  const crashes = [
    { name: "before-files", checkpoint: "journal-published", after: false },
    { name: "after-marker", checkpoint: "marker-published", after: false },
    { name: "after-files", checkpoint: "files-written", after: false },
    { name: "after-manifest", checkpoint: "manifest-published", after: true },
  ] as const;
  for (const crash of crashes) {
    const fixture = await authenticatedRollbackVersions(t, `superppt-rollback-${crash.name}-`);
    await assert.rejects(rollbackToRevision(fixture.root, fixture.targetId, {
      operations: {
        rollbackCheckpoint: (step) => {
          if (step === crash.checkpoint) throw new Error(`crash ${crash.name}`);
        },
      },
    }), new RegExp(`crash ${crash.name}`));
    await assert.rejects(readProject(fixture.root), /pending rollback transaction/);
    await assert.rejects(execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "status", "--project", fixture.root,
    ], { cwd: process.cwd() }), /pending rollback transaction/);
    const pendingManifest = await rawManifest(fixture.root);
    assert.equal(
      pendingManifest.currentRevision.id === fixture.current.currentRevision.id,
      !crash.after,
    );

    await recoverRollbackTransaction(fixture.root);
    const recovered = await readProject(fixture.root);
    assert.equal(
      recovered.currentRevision.id === fixture.current.currentRevision.id,
      !crash.after,
    );
    const expected = crash.after ? fixture.targetFiles : fixture.beforeFiles;
    for (const [path, bytes] of expected) {
      assert.deepEqual(await readFile(join(fixture.root, path)), bytes);
    }
    await assert.rejects(access(join(fixture.root, "revisions", "rollback-transaction")), { code: "ENOENT" });
  }
});

test("keeps a partial rollback fail-closed across persistent writes and later converges", async (t) => {
  const fixture = await authenticatedRollbackVersions(t, "superppt-rollback-persistent-");
  const persistentFailure = {
    beforePlanningArtifactWrite: (_path: string, index: number) => {
      if (index === 1) throw new Error("permission denied persistently");
    },
  };
  await assert.rejects(rollbackToRevision(fixture.root, fixture.targetId, {
    operations: persistentFailure,
  }), /permission denied persistently/);
  assert.deepEqual(await readFile(join(fixture.root, "brief.json")), fixture.targetFiles.get("brief.json"));
  assert.deepEqual(await readFile(join(fixture.root, "outline.json")), fixture.beforeFiles.get("outline.json"));
  await assert.rejects(readProject(fixture.root), /pending rollback transaction/);
  await assert.rejects(
    recoverRollbackTransaction(fixture.root, { operations: persistentFailure }),
    /permission denied persistently/,
  );
  await assert.rejects(readProject(fixture.root), /pending rollback transaction/);

  await recoverRollbackTransaction(fixture.root);
  const recovered = await readProject(fixture.root);
  assert.equal(recovered.currentRevision.id, fixture.current.currentRevision.id);
  for (const [path, bytes] of fixture.beforeFiles) {
    assert.deepEqual(await readFile(join(fixture.root, path)), bytes);
  }

  await rollbackToRevision(fixture.root, fixture.targetId);
  const rolledBack = await readProject(fixture.root);
  assert.equal(rolledBack.revisions.length, fixture.current.revisions.length + 1);
  for (const [path, bytes] of fixture.targetFiles) {
    assert.deepEqual(await readFile(join(fixture.root, path)), bytes);
  }
});

test("rollback automatically recovers a prior mid-file journal before retrying", async (t) => {
  const fixture = await authenticatedRollbackVersions(t, "superppt-rollback-auto-recover-");
  await assert.rejects(rollbackToRevision(fixture.root, fixture.targetId, {
    operations: {
      beforePlanningArtifactWrite: (_path, index) => {
        if (index === 1) throw new Error("mid-files crash");
      },
    },
  }), /mid-files crash/);
  await rollbackToRevision(fixture.root, fixture.targetId);
  const rolledBack = await readProject(fixture.root);
  assert.equal(rolledBack.revisions.length, fixture.current.revisions.length + 1);
  for (const [path, bytes] of fixture.targetFiles) {
    assert.deepEqual(await readFile(join(fixture.root, path)), bytes);
  }
});

test("same-target retry after manifest publication recovers without a duplicate revision", async (t) => {
  const fixture = await authenticatedRollbackVersions(t, "superppt-rollback-after-manifest-retry-");
  await assert.rejects(rollbackToRevision(fixture.root, fixture.targetId, {
    operations: {
      rollbackCheckpoint: (step) => {
        if (step === "manifest-published") throw new Error("cleanup crash");
      },
    },
  }), /cleanup crash/);
  const appended = await rawManifest(fixture.root);
  assert.equal(appended.revisions.length, fixture.current.revisions.length + 1);

  await rollbackToRevision(fixture.root, fixture.targetId);
  const recovered = await readProject(fixture.root);
  assert.equal(recovered.revisions.length, fixture.current.revisions.length + 1);
  assert.equal(recovered.currentRevision.id, appended.currentRevision.id);
});

test("CLI explicitly recovers a pending rollback transaction", async (t) => {
  const fixture = await authenticatedRollbackVersions(t, "superppt-rollback-cli-recover-");
  await assert.rejects(rollbackToRevision(fixture.root, fixture.targetId, {
    operations: {
      rollbackCheckpoint: (step) => {
        if (step === "journal-published") throw new Error("leave pending for CLI");
      },
    },
  }), /leave pending for CLI/);
  const recovered = await execFileAsync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "recover-rollback", "--project", fixture.root,
  ], { cwd: process.cwd() });
  assert.equal(recovered.stderr, "");
  assert.deepEqual(JSON.parse(recovered.stdout), { recovered: true });
  assert.equal((await readProject(fixture.root)).currentRevision.id, fixture.current.currentRevision.id);
});

test("rejects tampered, extra-entry, and linked rollback journals while reads stay closed", async (t) => {
  async function pending(prefix: string): Promise<string> {
    const fixture = await authenticatedRollbackVersions(t, prefix);
    await assert.rejects(rollbackToRevision(fixture.root, fixture.targetId, {
      operations: {
        rollbackCheckpoint: (step) => {
          if (step === "journal-published") throw new Error("leave journal");
        },
      },
    }), /leave journal/);
    return fixture.root;
  }

  const tampered = await pending("superppt-rollback-journal-tampered-");
  const activeTampered = join(tampered, "revisions", "rollback-transaction");
  await writeFile(join(activeTampered, "journal.json"), "{}\n");
  await assert.rejects(recoverRollbackTransaction(tampered), /rollback journal.*invalid/i);
  await assert.rejects(readProject(tampered), /pending rollback transaction/);

  const extra = await pending("superppt-rollback-journal-extra-");
  await writeFile(join(extra, "revisions", "rollback-transaction", "extra.json"), "{}\n");
  await assert.rejects(recoverRollbackTransaction(extra), /rollback journal.*tree/i);
  await assert.rejects(readProject(extra), /pending rollback transaction/);

  const linked = await pending("superppt-rollback-journal-linked-");
  const activeLinked = join(linked, "revisions", "rollback-transaction");
  const owned = `${activeLinked}.owned`;
  await rename(activeLinked, owned);
  await symlink(owned, activeLinked);
  await assert.rejects(recoverRollbackTransaction(linked), /rollback journal.*unsafe/i);
  await assert.rejects(readProject(linked), /pending rollback transaction/);

  const coordinated = await authenticatedRollbackVersions(t, "superppt-rollback-journal-rehash-");
  await assert.rejects(rollbackToRevision(coordinated.root, coordinated.targetId, {
    operations: {
      beforePlanningArtifactWrite: (_path, index) => {
        if (index === 1) throw new Error("leave anchored journal");
      },
    },
  }), /leave anchored journal/);
  const activeCoordinated = join(coordinated.root, "revisions", "rollback-transaction");
  const journalPath = join(activeCoordinated, "journal.json");
  const forgedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  const beforeEntry = forgedJournal.files.find((entry: { before: unknown }) => entry.before);
  assert.ok(beforeEntry?.before?.file);
  const forgedBefore = Buffer.from("coordinated forged before bytes");
  await writeFile(join(activeCoordinated, beforeEntry.before.file), forgedBefore);
  beforeEntry.before.sha256 = createHash("sha256").update(forgedBefore).digest("hex");
  beforeEntry.before.size = forgedBefore.length;
  const {
    descriptorSha256: _oldJournalHash,
    transactionAnchorSha256: _oldAnchorHash,
    rollbackManifestSha256: _rollbackManifestHash,
    rollbackManifestSize: _rollbackManifestSize,
    ...forgedAnchorBase
  } = forgedJournal;
  forgedJournal.transactionAnchorSha256 = createHash("sha256")
    .update(JSON.stringify(forgedAnchorBase)).digest("hex");
  const rollbackManifestPath = join(activeCoordinated, "rollback-superppt.json");
  const forgedRollbackManifest = JSON.parse(await readFile(rollbackManifestPath, "utf8"));
  forgedRollbackManifest.currentRevision.rollbackTransactionDescriptorSha256 = forgedJournal.transactionAnchorSha256;
  forgedRollbackManifest.revisions.at(-1).rollbackTransactionDescriptorSha256 = forgedJournal.transactionAnchorSha256;
  const forgedRollbackBytes = Buffer.from(`${JSON.stringify(forgedRollbackManifest, null, 2)}\n`);
  await writeFile(rollbackManifestPath, forgedRollbackBytes);
  forgedJournal.rollbackManifestSha256 = createHash("sha256").update(forgedRollbackBytes).digest("hex");
  forgedJournal.rollbackManifestSize = forgedRollbackBytes.length;
  const { descriptorSha256: _ignoredJournalHash, ...forgedJournalBase } = forgedJournal;
  forgedJournal.descriptorSha256 = createHash("sha256")
    .update(JSON.stringify(forgedJournalBase)).digest("hex");
  await writeFile(journalPath, `${JSON.stringify(forgedJournal, null, 2)}\n`);
  await assert.rejects(
    recoverRollbackTransaction(coordinated.root),
    /rollback transaction descriptor anchor mismatch/,
  );
  await assert.rejects(readProject(coordinated.root), /pending rollback transaction/);
});

test("rejects corrupted target planning snapshots before restoring any bytes", async (t) => {
  const root = await project(t, "superppt-rollback-artifacts-corrupt-");
  await writeApprovedOutline(root);
  const targetId = (await readProject(root)).currentRevision.id;
  const plan = await publishImpactPlan(root, { kind: "outline-order" });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);

  const v2Brief = { ...approvedBrief, title: "Corruption-safe V2" };
  await advanceWithBriefArtifact(root, v2Brief);
  await writeApprovedOutline(root, v2Brief, approvedOutline);
  const before = await readProject(root);
  const briefBefore = await readFile(join(root, "brief.json"));
  const target = JSON.parse(await readFile(
    join(revisionSnapshotRoot(root, targetId), "superppt.json"),
    "utf8",
  ));
  const outlineGate = target.gates.find((gate: { gate: string }) => gate.gate === "outline");
  assert.ok(outlineGate?.snapshotPath);
  await writeFile(
    join(root, ...outlineGate.snapshotPath.split("/"), "artifacts", "brief.json"),
    "corrupted target snapshot\n",
  );

  await assert.rejects(
    rollbackToRevision(root, targetId),
    /rollback planning artifact evidence is invalid/,
  );
  assert.equal((await readProject(root)).currentRevision.id, before.currentRevision.id);
  assert.deepEqual(await readFile(join(root, "brief.json")), briefBefore);
});

test("applies order-only without invalidating slide images and applies style globally", async (t) => {
  const orderRoot = await project(t, "superppt-impact-order-");
  await seedSlides(orderRoot);
  const orderPlan = await publishImpactPlan(orderRoot, { kind: "outline-order" });
  await approveImpact(orderRoot, orderPlan.sha256);
  await applyRevision(orderRoot, orderPlan, orderPlan.change);
  const ordered = await readProject(orderRoot);
  assert.deepEqual(ordered.slides.map((slide) => slide.status), ["ready", "ready"]);
  assert.ok(ordered.slides.every((slide) => slide.image && slide.finalRender));
  assert.equal(ordered.exports.pptx, null);

  const styleRoot = await project(t, "superppt-impact-style-");
  await seedSlides(styleRoot);
  const stylePlan = await publishImpactPlan(styleRoot, { kind: "style" });
  await approveImpact(styleRoot, stylePlan.sha256);
  await applyRevision(styleRoot, stylePlan, stylePlan.change);
  const styled = await readProject(styleRoot);
  assert.deepEqual(styled.slides.map((slide) => slide.status), ["stale", "stale"]);
  assert.ok(styled.slides.every((slide) => slide.image === null && slide.finalRender === null));
});

test("rejects a forged impact gate and any plan whose exact base changed", async (t) => {
  const forgedRoot = await project(t, "superppt-impact-forged-");
  const plan = await publishImpactPlan(forgedRoot, { kind: "style" });
  const manifest = await readProject(forgedRoot);
  const bytes = await readFile(join(forgedRoot, "revisions", "pending-impact.json"));
  await assert.rejects(writeProject(forgedRoot, {
    ...manifest,
    gates: [...manifest.gates, {
      gate: "revision-impact",
      revisionId: manifest.currentRevision.id,
      approvalId: "00000000-0000-4000-8000-000000000777",
      artifactHashes: {
        "revisions/pending-impact.json": createHash("sha256").update(bytes).digest("hex"),
      },
      snapshotPath: `revisions/${manifest.currentRevision.id}/impact-approvals/00000000-0000-4000-8000-000000000777`,
      snapshotManifestSha256: "0".repeat(64),
      confirmedAt: new Date().toISOString(),
    }],
  }), /revision impact gate evidence/);
  assert.deepEqual((await readProject(forgedRoot)).gates, []);

  const matchedRoot = await project(t, "superppt-impact-matched-forgery-");
  const matchedPlan = await publishImpactPlan(matchedRoot, { kind: "style" });
  const matchedManifest = await readProject(matchedRoot);
  const matchedBytes = await readFile(join(matchedRoot, "revisions", "pending-impact.json"));
  await assert.rejects(writeProject(matchedRoot, {
    ...matchedManifest,
    gates: [...matchedManifest.gates, {
      gate: "revision-impact",
      revisionId: matchedManifest.currentRevision.id,
      approvalId: "00000000-0000-4000-8000-000000000778",
      artifactHashes: {
        "revisions/pending-impact.json": createHash("sha256").update(matchedBytes).digest("hex"),
      },
      snapshotPath: `revisions/${matchedManifest.currentRevision.id}/impact-approvals/00000000-0000-4000-8000-000000000778`,
      snapshotManifestSha256: matchedPlan.baseManifestSha256,
      confirmedAt: new Date().toISOString(),
    }],
  }), /revision impact gate evidence/);
  assert.deepEqual((await readProject(matchedRoot)).gates, []);

  const staleRoot = await project(t, "superppt-impact-stale-");
  const stalePlan = await publishImpactPlan(staleRoot, { kind: "brief", title: "Planned" });
  await updateProject(staleRoot, (current) => ({ ...current, title: "Concurrent mutation" }));
  await assert.rejects(approveImpact(staleRoot, stalePlan.sha256), /stale base manifest identity/);
  assert.deepEqual((await readProject(staleRoot)).gates, []);
});

test("rejects tampered and linked pending impact evidence", async (t) => {
  const tamperedRoot = await project(t, "superppt-impact-tampered-");
  const plan = await publishImpactPlan(tamperedRoot, { kind: "style" });
  await writeFile(join(tamperedRoot, "revisions", "pending-impact.json"), "{}\n");
  await assert.rejects(approveImpact(tamperedRoot, plan.sha256), /pending impact evidence is invalid/);
  assert.deepEqual((await readProject(tamperedRoot)).gates, []);

  const semanticRoot = await project(t, "superppt-impact-semantic-tamper-");
  await seedSlides(semanticRoot);
  const semanticPlan = await publishImpactPlan(semanticRoot, { kind: "style" });
  const { sha256: _oldSha, ...forgedBody } = { ...semanticPlan, staleSlideIds: [] };
  const forgedPlan = {
    ...forgedBody,
    sha256: createHash("sha256").update(JSON.stringify(forgedBody)).digest("hex"),
  };
  await writeFile(
    join(semanticRoot, "revisions", "pending-impact.json"),
    `${JSON.stringify(forgedPlan, null, 2)}\n`,
  );
  await assert.rejects(
    approveImpact(semanticRoot, forgedPlan.sha256),
    /revision impact gate evidence is invalid/,
  );
  assert.deepEqual((await readProject(semanticRoot)).gates, []);

  const linkedRoot = await project(t, "superppt-impact-linked-");
  const linkedPlan = await publishImpactPlan(linkedRoot, { kind: "style" });
  const outside = join(await realpath(await mkdtemp(join(tmpdir(), "superppt-impact-outside-"))), "impact.json");
  t.after(async () => rm(outside, { force: true }));
  await writeFile(outside, JSON.stringify(linkedPlan));
  await rm(join(linkedRoot, "revisions", "pending-impact.json"));
  await symlink(outside, join(linkedRoot, "revisions", "pending-impact.json"));
  await assert.rejects(approveImpact(linkedRoot, linkedPlan.sha256), /outside project|fixed project key|unsafe/);
  assert.deepEqual((await readProject(linkedRoot)).gates, []);
});

test("serializes concurrent apply so exactly one revision is appended", async (t) => {
  const root = await project(t, "superppt-impact-concurrent-");
  await seedSlides(root);
  const plan = await publishImpactPlan(root, { kind: "slide-spec", slideIds: [A] });
  await approveImpact(root, plan.sha256);
  const results = await Promise.allSettled([
    applyRevision(root, plan, plan.change),
    applyRevision(root, plan, plan.change),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await readProject(root)).revisions.length, 2);
});

test("direct impact commit holds the pending-evidence lease through revision publication", async (t) => {
  const root = await project(t, "superppt-impact-commit-atomic-");
  const plan = await publishImpactPlan(root, { kind: "brief", title: "Committed" });
  await approveImpact(root, plan.sha256);
  let replacement: Promise<Awaited<ReturnType<typeof publishImpactPlan>>> | undefined;
  await commitApprovedImpactRevision(root, plan, plan.change, {
    revisionSnapshotCheckpoint: async (step) => {
      if (step === "descriptor-written") {
        replacement = publishImpactPlan(root, { kind: "style" });
        const result = await Promise.race([
          replacement.then(() => "replaced" as const),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 150)),
        ]);
        assert.equal(result, "blocked", "pending evidence replacement bypassed the revision-impact lease");
      }
    },
  });
  assert.ok(replacement);
  const nextPlan = await replacement;
  const current = await readProject(root);
  assert.equal(nextPlan.baseRevisionId, current.currentRevision.id);
  assert.notEqual(nextPlan.baseRevisionId, plan.baseRevisionId);
  const pending = JSON.parse(await readFile(join(root, "revisions", "pending-impact.json"), "utf8"));
  assert.equal(pending.baseRevisionId, current.currentRevision.id);
});

test("allows a new approved impact after the prior approval was applied", async (t) => {
  const root = await project(t, "superppt-impact-chained-");
  const first = await publishImpactPlan(root, { kind: "brief", title: "Second" });
  await approveImpact(root, first.sha256);
  await applyRevision(root, first, first.change);
  const second = await publishImpactPlan(root, { kind: "brief", title: "Third" });
  await approveImpact(root, second.sha256);
  await applyRevision(root, second, second.change);
  const current = await readProject(root);
  assert.equal(current.title, "Third");
  assert.equal(current.revisions.length, 3);
  assert.deepEqual(current.gates.map((gate) => gate.revisionId), [
    current.revisions[0]!.id,
    current.revisions[1]!.id,
  ]);
});

test("rejects missing, corrupt, linked, current, and non-ledger rollback targets without mutation", async (t) => {
  async function changedProject(prefix: string): Promise<{
    root: string;
    targetId: string;
  }> {
    const root = await project(t, prefix);
    const targetId = (await readProject(root)).currentRevision.id;
    const plan = await publishImpactPlan(root, { kind: "brief", title: "After" });
    await approveImpact(root, plan.sha256);
    await applyRevision(root, plan, plan.change);
    return { root, targetId };
  }

  const missing = await changedProject("superppt-rollback-missing-");
  await rm(revisionSnapshotRoot(missing.root, missing.targetId), { recursive: true });
  const missingBefore = await readProject(missing.root);
  await assert.rejects(rollbackToRevision(missing.root, missing.targetId), /missing, unsafe, or unauthentic/);
  assert.equal((await readProject(missing.root)).currentRevision.id, missingBefore.currentRevision.id);

  const corrupt = await changedProject("superppt-rollback-corrupt-");
  await writeFile(join(revisionSnapshotRoot(corrupt.root, corrupt.targetId), "superppt.json"), "{}\n");
  const corruptBefore = await readProject(corrupt.root);
  await assert.rejects(rollbackToRevision(corrupt.root, corrupt.targetId), /missing, unsafe, or unauthentic/);
  assert.equal((await readProject(corrupt.root)).currentRevision.id, corruptBefore.currentRevision.id);

  const linked = await changedProject("superppt-rollback-linked-");
  const linkedPath = join(revisionSnapshotRoot(linked.root, linked.targetId), "superppt.json");
  const outsideDirectory = await realpath(await mkdtemp(join(tmpdir(), "superppt-rollback-outside-")));
  t.after(async () => rm(outsideDirectory, { recursive: true, force: true }));
  const outside = join(outsideDirectory, "superppt.json");
  await writeFile(outside, await readFile(linkedPath));
  await rm(linkedPath);
  await symlink(outside, linkedPath);
  const linkedBefore = await readProject(linked.root);
  await assert.rejects(rollbackToRevision(linked.root, linked.targetId), /missing, unsafe, or unauthentic/);
  assert.equal((await readProject(linked.root)).currentRevision.id, linkedBefore.currentRevision.id);

  const illegal = await changedProject("superppt-rollback-illegal-");
  const illegalManifest = await readProject(illegal.root);
  await assert.rejects(
    rollbackToRevision(illegal.root, illegalManifest.currentRevision.id),
    /earlier revision/,
  );
  await assert.rejects(
    rollbackToRevision(illegal.root, "00000000-0000-4000-8000-000000000999"),
    /not in the project revision ledger/,
  );
  assert.equal((await readProject(illegal.root)).currentRevision.id, illegalManifest.currentRevision.id);
});

test("refuses to overwrite a conflicting immutable current snapshot during rollback", async (t) => {
  const root = await project(t, "superppt-rollback-immutable-");
  const targetId = (await readProject(root)).currentRevision.id;
  const plan = await publishImpactPlan(root, { kind: "brief", title: "After" });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);
  const current = await readProject(root);
  const currentDirectory = revisionSnapshotRoot(root, current.currentRevision.id);
  await mkdir(currentDirectory, { recursive: true });
  await writeFile(join(currentDirectory, "superppt.json"), "{}\n");
  await assert.rejects(rollbackToRevision(root, targetId), /immutable revision snapshot differs/);
  assert.equal((await readProject(root)).currentRevision.id, current.currentRevision.id);
});

test("authenticates revision snapshot descriptors and exact trees before rollback", async (t) => {
  const root = await project(t, "superppt-rollback-snapshot-auth-");
  const targetId = (await readProject(root)).currentRevision.id;
  const plan = await publishImpactPlan(root, { kind: "brief", title: "After" });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);
  const before = await readProject(root);
  const snapshotRoot = revisionSnapshotRoot(root, targetId);
  const snapshot = JSON.parse(await readFile(join(snapshotRoot, "superppt.json"), "utf8"));
  await writeFile(join(snapshotRoot, "superppt.json"), `${JSON.stringify({
    ...snapshot,
    title: "Schema-valid forged title",
  }, null, 2)}\n`);

  await assert.rejects(rollbackToRevision(root, targetId), /snapshot.*authentic|hash mismatch/i);
  assert.equal((await readProject(root)).currentRevision.id, before.currentRevision.id);

  const extraRoot = await project(t, "superppt-rollback-snapshot-extra-");
  const extraTarget = (await readProject(extraRoot)).currentRevision.id;
  const extraPlan = await publishImpactPlan(extraRoot, { kind: "brief", title: "After" });
  await approveImpact(extraRoot, extraPlan.sha256);
  await applyRevision(extraRoot, extraPlan, extraPlan.change);
  await writeFile(join(revisionSnapshotRoot(extraRoot, extraTarget), "extra.json"), "{}\n");
  await assert.rejects(rollbackToRevision(extraRoot, extraTarget), /snapshot.*unauthentic/i);

  const rehashedRoot = await project(t, "superppt-rollback-snapshot-rehash-");
  const rehashedTarget = (await readProject(rehashedRoot)).currentRevision.id;
  const rehashedPlan = await publishImpactPlan(rehashedRoot, { kind: "brief", title: "After" });
  await approveImpact(rehashedRoot, rehashedPlan.sha256);
  await applyRevision(rehashedRoot, rehashedPlan, rehashedPlan.change);
  const rehashedSnapshotRoot = revisionSnapshotRoot(rehashedRoot, rehashedTarget);
  const forgedManifest = JSON.parse(await readFile(join(rehashedSnapshotRoot, "superppt.json"), "utf8"));
  forgedManifest.title = "Coordinated snapshot forgery";
  const forgedBytes = Buffer.from(`${JSON.stringify(forgedManifest, null, 2)}\n`);
  await writeFile(join(rehashedSnapshotRoot, "superppt.json"), forgedBytes);
  const forgedDescriptor = JSON.parse(await readFile(join(rehashedSnapshotRoot, "snapshot.json"), "utf8"));
  forgedDescriptor.manifestSha256 = createHash("sha256").update(forgedBytes).digest("hex");
  forgedDescriptor.manifestSize = forgedBytes.length;
  const { descriptorSha256: _oldDescriptorHash, ...forgedDescriptorBase } = forgedDescriptor;
  forgedDescriptor.descriptorSha256 = createHash("sha256")
    .update(JSON.stringify(forgedDescriptorBase)).digest("hex");
  await writeFile(join(rehashedSnapshotRoot, "snapshot.json"), `${JSON.stringify(forgedDescriptor, null, 2)}\n`);
  await assert.rejects(
    rollbackToRevision(rehashedRoot, rehashedTarget),
    /snapshot descriptor anchor mismatch/,
  );
});

test("retries safely after a crash leaves only a partial snapshot staging tree", async (t) => {
  const root = await project(t, "superppt-snapshot-partial-");
  const plan = await publishImpactPlan(root, { kind: "brief", title: "After" });
  await approveImpact(root, plan.sha256);
  await assert.rejects(applyRevision(root, plan, plan.change, {
    operations: {
      revisionSnapshotCheckpoint: (step) => {
        if (step === "manifest-written") throw new Error("snapshot crash");
      },
    },
  }), /snapshot crash/);
  assert.equal((await readProject(root)).revisions.length, 1);
  await assert.rejects(access(revisionSnapshotRoot(root, plan.baseRevisionId)), { code: "ENOENT" });

  await applyRevision(root, plan, plan.change);
  assert.equal((await readProject(root)).revisions.length, 2);
  assert.deepEqual(
    (await readdir(revisionSnapshotRoot(root, plan.baseRevisionId))).sort(),
    ["snapshot.json", "superppt.json"],
  );
});

test("fails closed if revisions is swapped to a symlink during pending, snapshot, or rollback access", async (t) => {
  async function swapRevisions(root: string, outside: string): Promise<void> {
    await rename(join(root, "revisions"), join(root, "revisions-owned"));
    await symlink(outside, join(root, "revisions"));
  }

  const pendingRoot = await project(t, "superppt-impact-pending-race-");
  const pendingOutside = await realpath(await mkdtemp(join(tmpdir(), "superppt-impact-pending-outside-")));
  t.after(async () => rm(pendingOutside, { recursive: true, force: true }));
  await assert.rejects(publishImpactPlan(pendingRoot, { kind: "style" }, {
    operations: { afterRevisionsDirectoryOpened: () => swapRevisions(pendingRoot, pendingOutside) },
  }), /changed while accessing revision evidence/);
  assert.deepEqual(await readFile(join(pendingOutside, ".keep"), "utf8").catch(() => null), null);

  const approvalRoot = await project(t, "superppt-impact-approval-race-");
  const approvalPlan = await publishImpactPlan(approvalRoot, { kind: "style" });
  const approvalOutside = await realpath(await mkdtemp(join(tmpdir(), "superppt-impact-approval-outside-")));
  t.after(async () => rm(approvalOutside, { recursive: true, force: true }));
  await assert.rejects(approveImpact(approvalRoot, approvalPlan.sha256, {
    operations: { afterRevisionsDirectoryOpened: () => swapRevisions(approvalRoot, approvalOutside) },
  }), /changed while accessing revision evidence/);
  assert.deepEqual(await readFile(join(approvalOutside, "approval.json"), "utf8").catch(() => null), null);
  assert.deepEqual((await readProject(approvalRoot)).gates, []);

  const applyRoot = await project(t, "superppt-impact-snapshot-race-");
  const plan = await publishImpactPlan(applyRoot, { kind: "style" });
  await approveImpact(applyRoot, plan.sha256);
  const applyOutside = await realpath(await mkdtemp(join(tmpdir(), "superppt-impact-snapshot-outside-")));
  t.after(async () => rm(applyOutside, { recursive: true, force: true }));
  await assert.rejects(applyRevision(applyRoot, plan, plan.change, {
    operations: { afterRevisionsDirectoryOpened: () => swapRevisions(applyRoot, applyOutside) },
  }), /changed while accessing revision evidence|immutable artifact evidence|missing.*unsafe|ENOTDIR/);
  assert.deepEqual(await readFile(join(applyOutside, "superppt.json"), "utf8").catch(() => null), null);

  const rollbackRoot = await project(t, "superppt-rollback-read-race-");
  const targetId = (await readProject(rollbackRoot)).currentRevision.id;
  const rollbackPlan = await publishImpactPlan(rollbackRoot, { kind: "brief", title: "After" });
  await approveImpact(rollbackRoot, rollbackPlan.sha256);
  await applyRevision(rollbackRoot, rollbackPlan, rollbackPlan.change);
  const rollbackOutside = await realpath(await mkdtemp(join(tmpdir(), "superppt-rollback-read-outside-")));
  t.after(async () => rm(rollbackOutside, { recursive: true, force: true }));
  await assert.rejects(rollbackToRevision(rollbackRoot, targetId, {
    operations: { afterRevisionsDirectoryOpened: () => swapRevisions(rollbackRoot, rollbackOutside) },
  }), /changed while accessing revision evidence|immutable artifact evidence|missing.*unsafe|ENOTDIR/);
  assert.deepEqual(await readFile(join(rollbackOutside, "superppt.json"), "utf8").catch(() => null), null);
});

test("rejects linked or non-exact immutable impact approval trees", async (t) => {
  const extraRoot = await project(t, "superppt-impact-approval-extra-");
  const extraPlan = await publishImpactPlan(extraRoot, { kind: "style" });
  await approveImpact(extraRoot, extraPlan.sha256);
  const extraGate = (await readProject(extraRoot)).gates.at(-1)!;
  await writeFile(join(extraRoot, ...extraGate.snapshotPath!.split("/"), "extra.json"), "{}\n");
  await assert.rejects(applyRevision(extraRoot, extraPlan, extraPlan.change), /approval evidence tree is invalid/);

  const linkedRoot = await project(t, "superppt-impact-approval-linked-");
  const linkedPlan = await publishImpactPlan(linkedRoot, { kind: "style" });
  await approveImpact(linkedRoot, linkedPlan.sha256);
  const linkedGate = (await readProject(linkedRoot)).gates.at(-1)!;
  const approvalPath = join(linkedRoot, ...linkedGate.snapshotPath!.split("/"));
  const backupPath = `${approvalPath}.owned`;
  await rename(approvalPath, backupPath);
  await symlink(backupPath, approvalPath);
  await assert.rejects(applyRevision(linkedRoot, linkedPlan, linkedPlan.change), /approval evidence tree is invalid/);
});

test("CLI plans, approves, applies, and rolls back in distinct commands", async (t) => {
  const root = await project(t, "superppt-impact-cli-");
  const base = await readProject(root);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "superppt-impact-cli-change-")));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const changePath = join(parent, "change.json");
  await writeFile(changePath, `${JSON.stringify({ kind: "brief", title: "CLI After" })}\n`);
  const invocation = ["--import", "tsx", "src/cli.ts"];

  const planned = await execFileAsync(process.execPath, [
    ...invocation,
    "impact",
    "--project",
    root,
    "--change",
    changePath,
  ], { cwd: process.cwd() });
  assert.equal(planned.stderr, "");
  const plan = ImpactPlanSchema.parse(JSON.parse(planned.stdout));
  assert.equal((await readProject(root)).currentRevision.id, base.currentRevision.id);
  assert.deepEqual((await readProject(root)).gates, []);

  await assert.rejects(execFileAsync(process.execPath, [
    ...invocation,
    "apply-impact",
    "--project",
    root,
  ], { cwd: process.cwd() }), /must be approved/);
  await execFileAsync(process.execPath, [
    ...invocation,
    "approve-impact",
    "--project",
    root,
    "--sha256",
    plan.sha256,
  ], { cwd: process.cwd() });
  await execFileAsync(process.execPath, [
    ...invocation,
    "apply-impact",
    "--project",
    root,
  ], { cwd: process.cwd() });
  const applied = await readProject(root);
  assert.equal(applied.title, "CLI After");
  assert.equal(applied.revisions.length, 2);

  await execFileAsync(process.execPath, [
    ...invocation,
    "rollback",
    "--project",
    root,
    "--revision",
    base.currentRevision.id,
  ], { cwd: process.cwd() });
  const rolledBack = await readProject(root);
  assert.equal(rolledBack.title, "Demo");
  assert.equal(rolledBack.revisions.length, 3);
});
