import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";

import { approveGate, assertGateCurrent, readGateSnapshot, toPortableProjectPath } from "../src/planning/confirm.js";
import { normalizeInput } from "../src/planning/intake.js";
import { renderBrief, renderOutline, renderSlideSpec } from "../src/planning/render.js";
import { BriefSchema, OutlineSchema, SlideSpecSchema } from "../src/planning/schemas.js";
import { publishPlanViews, publishStyleSample, readPublishedOutlineViews, readPublishedPlanViews, recoverPlanViews } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { addDescriptorIntegrity, sha256Evidence } from "../src/project/evidence.js";
import { withProjectLease } from "../src/project/lock.js";
import { readProject, updateProject, writeProject } from "../src/project/store.js";
import { writeCanonicalStyleSample } from "./helpers/style-sample.js";

const execFileAsync = promisify(execFile);
const PROJECT_ID = "00000000-0000-4000-8000-000000000101";
const SLIDE_IDS = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
  "00000000-0000-4000-8000-000000000203",
] as const;

async function temporaryParent(t: TestContext, prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  return realpath(parent);
}

async function project(t: TestContext, prefix: string): Promise<string> {
  const root = join(await temporaryParent(t, prefix), "project");
  await initializeProject({ root, title: "Demo", idFactory: () => PROJECT_ID });
  return root;
}

const brief = {
  schemaVersion: 1 as const,
  title: "AI Agent 协作系统",
  purpose: "解释协作编排",
  audience: "产品与技术团队",
  language: "zh-CN",
  targetSlides: 3,
  mustCover: ["六类角色", "闭环", "交付价值"],
  constraints: ["16:9", "无水印"],
};

const outline = {
  schemaVersion: 1 as const,
  slides: [
    { id: SLIDE_IDS[0], order: 0, title: "AI Agent 协作系统", role: "cover" as const, purpose: "建立主题并介绍六类角色", sourceRefs: ["L1-L2"] },
    { id: SLIDE_IDS[1], order: 1, title: "六类角色如何形成闭环", role: "process" as const, purpose: "解释闭环协作", sourceRefs: ["L3-L6"] },
    { id: SLIDE_IDS[2], order: 2, title: "交付价值", role: "summary" as const, purpose: "总结交付价值", sourceRefs: ["L7-L8"] },
  ],
};

function spec(index: number) {
  const slide = outline.slides[index]!;
  return {
    schemaVersion: 1 as const,
    slideId: slide.id,
    title: slide.title,
    role: slide.role,
    coreMessage: `Core ${index + 1}`,
    requiredText: [slide.title],
    visualSubject: "One central orchestration hub",
    composition: "hub and spoke",
    relationships: ["hub controls six agents"],
    forbidden: ["watermark"],
    sourceRefs: slide.sourceRefs,
  };
}

async function writeValidPlan(root: string): Promise<void> {
  await writeFile(join(root, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline, null, 2)}\n`);
  for (const [index, slide] of outline.slides.entries()) {
    const directory = join(root, "slides", slide.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "spec.json"), `${JSON.stringify(spec(index), null, 2)}\n`);
  }
}

async function writeValidStyleSample(root: string): Promise<void> {
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
    schemaVersion: 1,
    styleId: "cinematic-tech",
    representativeSlideId: SLIDE_IDS[1],
  }, null, 2)}\n`);
  await writeCanonicalStyleSample(root);
}

async function approveAll(root: string): Promise<void> {
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await publishStyleSample(root);
  await approveGate(root, "style-sample");
}

test("preserves text and Markdown bytes with strict runtime input validation", async (t) => {
  const root = await project(t, "superppt-input-");
  const source = "# 原始标题\n\n保留  **Markdown**  间距。\r\n";
  const destination = await normalizeInput(root, { kind: "text", value: source });
  assert.deepEqual(await readFile(destination), Buffer.from(source));

  const second = join(await temporaryParent(t, "superppt-input-md-"), "project");
  await initializeProject({ root: second, title: "Second" });
  const markdown = join(await temporaryParent(t, "superppt-source-"), "source.MD");
  const bytes = Buffer.from([0x23, 0x20, 0xe4, 0xb8, 0xad, 0x0d, 0x0a]);
  await writeFile(markdown, bytes);
  await normalizeInput(second, { kind: "markdown", path: markdown });
  assert.deepEqual(await readFile(join(second, "source", "original.md")), bytes);

  const third = join(await temporaryParent(t, "superppt-invalid-kind-"), "project");
  await initializeProject({ root: third, title: "Third" });
  await assert.rejects(normalizeInput(third, { kind: "url", value: "https://example.com" } as never), /invalid input request/);
  await assert.rejects(normalizeInput(third, { kind: "text", value: "x", extra: true } as never), /invalid input request/);
});

test("fails closed when a Markdown pathname is swapped after its handle opens", async (t) => {
  const root = await project(t, "superppt-input-swap-");
  const parent = await temporaryParent(t, "superppt-swapped-source-");
  const source = join(parent, "source.md");
  const backup = join(parent, "source.backup.md");
  await writeFile(source, "original");
  await assert.rejects(
    normalizeInput(root, { kind: "markdown", path: source }, {
      async afterSourceOpened() {
        await rename(source, backup);
        await writeFile(source, "replacement");
      },
    }),
    /changed while reading/,
  );
  await assert.rejects(access(join(root, "source", "original.md")), { code: "ENOENT" });
});

test("fails closed on same-inode truncate and rewrite after opening", async (t) => {
  const root = await project(t, "superppt-input-in-place-");
  const parent = await temporaryParent(t, "superppt-in-place-source-");
  const source = join(parent, "source.md");
  await writeFile(source, "original");
  await assert.rejects(normalizeInput(root, { kind: "markdown", path: source }, {
    async afterSourceOpened() {
      await writeFile(source, "replaced");
    },
  }), /changed while reading/);
  await assert.rejects(access(join(root, "source", "original.md")), { code: "ENOENT" });
});

test("rejects empty, linked, non-file, repeated, and unowned input writes", async (t) => {
  const parent = await temporaryParent(t, "superppt-input-safety-");
  const first = join(parent, "first");
  const second = join(parent, "second");
  await initializeProject({ root: first, title: "First" });
  await initializeProject({ root: second, title: "Second" });
  const markdown = join(parent, "input.md");
  const linked = join(parent, "linked.md");
  const directory = join(parent, "directory.md");
  await writeFile(markdown, "source");
  await symlink(markdown, linked);
  await mkdir(directory);
  await normalizeInput(first, { kind: "markdown", path: markdown });
  await assert.rejects(normalizeInput(first, { kind: "text", value: "replacement" }), /exist|already/i);
  await assert.rejects(normalizeInput(second, { kind: "markdown", path: linked }), /regular \.md file/);
  await assert.rejects(normalizeInput(second, { kind: "markdown", path: directory }), /regular \.md file/);
  await assert.rejects(normalizeInput(second, { kind: "description", value: " \r\n" }), /must not be empty/);
  await assert.rejects(normalizeInput(join(parent, "unowned"), { kind: "text", value: "content" }), /not owned/);
});

test("requires strict briefs, stable UUIDs, contiguous order, and strict specs", () => {
  assert.throws(() => BriefSchema.parse({ ...brief, extra: true }), /unrecognized/i);
  assert.throws(() => OutlineSchema.parse({ ...outline, slides: [] }), /too_small|>=3|small/i);
  assert.throws(() => OutlineSchema.parse({ ...outline, slides: [outline.slides[0], { ...outline.slides[1], id: SLIDE_IDS[0] }, outline.slides[2]] }), /stable slide IDs must be unique/);
  assert.throws(() => OutlineSchema.parse({ ...outline, slides: [outline.slides[0], { ...outline.slides[1], order: 3 }, outline.slides[2]] }), /slide order must be contiguous from zero/);
  assert.doesNotThrow(() => SlideSpecSchema.parse(spec(0)));
  assert.throws(() => SlideSpecSchema.parse({ ...spec(0), slideId: "slide-1" }), /uuid/i);
});

test("renders fixed deterministic views without mutating cloned inputs", () => {
  const parsedBrief = BriefSchema.parse(structuredClone(brief));
  assert.equal(renderBrief(parsedBrief), "# AI Agent 协作系统\n\n- 用途：解释协作编排\n- 受众：产品与技术团队\n- 语言：zh-CN\n- 目标页数：3\n\n## 必须覆盖\n\n- 六类角色\n- 闭环\n- 交付价值\n\n## 限制\n\n- 16:9\n- 无水印\n");
  const reversed = OutlineSchema.parse({ ...outline, slides: structuredClone(outline.slides).reverse() });
  const before = structuredClone(reversed);
  const first = renderOutline(reversed);
  assert.equal(first, renderOutline(structuredClone(reversed)));
  assert.deepEqual(reversed, before);
  assert.ok(first.indexOf("## 1.") < first.indexOf("## 3."));
  assert.match(renderSlideSpec(SlideSpecSchema.parse(spec(0))), /- 页面 ID：00000000-0000-4000-8000-000000000201/);
});

test("ordinary gates derive and validate fixed artifact sets in exact order", async (t) => {
  const root = await project(t, "superppt-gates-");
  await writeValidPlan(root);
  await writeValidStyleSample(root);
  await assert.rejects(approveGate(root, "slide-specs"), /outline gate must be current/);
  await assert.rejects(approveGate(root, "style-sample"), /slide-specs gate must be current/);
  await approveAll(root);
  const manifest = await readProject(root);
  assert.deepEqual(manifest.gates.map(({ gate }) => gate), ["outline", "slide-specs", "style-sample"]);
  assert.deepEqual(Object.keys(manifest.gates[0]!.artifactHashes).sort(), ["brief.json", "outline.json"]);
  assert.deepEqual(Object.keys(manifest.gates[1]!.artifactHashes).sort(), ["outline.json", ...SLIDE_IDS.map((id) => `slides/${id}/spec.json`)].sort());
  assert.deepEqual(Object.keys(manifest.gates[2]!.artifactHashes).sort(), [
    "style/sample/director.json",
    "style/sample/ledger.json",
    "style/sample/prompt.txt",
    "style/sample/sample.png",
    "style/selection.json",
  ]);
  assert.equal(await assertGateCurrent(root, "style-sample"), true);
  await assert.rejects(approveGate(root, "revision-impact" as never), /invalid planning gate/);
  await assert.rejects(approveGate(root, "outline", { artifacts: [join(root, "superppt.json")] } as never), /invalid approval options/);
});

test("rejects invalid empty, target-count, must-cover, spec, and style contracts before approval", async (t) => {
  const cases: Array<{ name: string; mutate(root: string): Promise<void>; expected: RegExp }> = [
    { name: "empty", async mutate(root) { await writeFile(join(root, "outline.json"), JSON.stringify({ schemaVersion: 1, slides: [] })); }, expected: /too_small|>=3|small/i },
    { name: "target", async mutate(root) { await writeFile(join(root, "brief.json"), JSON.stringify({ ...brief, targetSlides: 4 })); }, expected: /targetSlides must equal outline slide count/ },
    { name: "coverage", async mutate(root) { await writeFile(join(root, "brief.json"), JSON.stringify({ ...brief, mustCover: ["未覆盖主题"] })); }, expected: /outline does not cover required topic/ },
  ];
  for (const value of cases) {
    const root = join(await temporaryParent(t, `superppt-invalid-${value.name}-`), "project");
    await initializeProject({ root, title: value.name });
    await writeValidPlan(root);
    await value.mutate(root);
    await assert.rejects(approveGate(root, "outline"), value.expected);
    assert.deepEqual((await readProject(root)).gates, []);
  }
  const specRoot = join(await temporaryParent(t, "superppt-invalid-spec-"), "project");
  await initializeProject({ root: specRoot, title: "Spec" });
  await writeValidPlan(specRoot);
  await publishPlanViews(specRoot);
  await approveGate(specRoot, "outline");
  await writeFile(join(specRoot, "slides", SLIDE_IDS[1], "spec.json"), JSON.stringify({ ...spec(1), title: "Wrong" }));
  await assert.rejects(approveGate(specRoot, "slide-specs"), /must match outline/);

  const styleRoot = join(await temporaryParent(t, "superppt-invalid-style-"), "project");
  await initializeProject({ root: styleRoot, title: "Style" });
  await writeValidPlan(styleRoot);
  await writeValidStyleSample(styleRoot);
  await publishPlanViews(styleRoot);
  await approveGate(styleRoot, "outline");
  await approveGate(styleRoot, "slide-specs");
  await writeFile(join(styleRoot, "style", "selection.json"), JSON.stringify({ schemaVersion: 1, styleId: "cinematic-tech", representativeSlideId: PROJECT_ID }));
  await assert.rejects(approveGate(styleRoot, "style-sample"), /representative slide must exist/);
});

test("style publication requires a built-in recipe and an exact decodable canonical PNG", async (t) => {
  const root = await project(t, "superppt-style-semantics-");
  await writeValidPlan(root);
  await writeValidStyleSample(root);

  await writeFile(join(root, "style", "selection.json"), JSON.stringify({
    schemaVersion: 1,
    styleId: "not-a-built-in-style",
    representativeSlideId: SLIDE_IDS[1],
  }));
  await assert.rejects(publishStyleSample(root), /unknown built-in style/);

  await writeFile(join(root, "style", "selection.json"), JSON.stringify({
    schemaVersion: 1,
    styleId: "cinematic-tech",
    representativeSlideId: SLIDE_IDS[1],
  }));
  await writeCanonicalStyleSample(root);
  await writeFile(join(root, "style", "sample", "sample.png"), await sharp({
    create: { width: 800, height: 800, channels: 3, background: "#102030" },
  }).png().toBuffer());
  await assert.rejects(publishStyleSample(root), /exact 1920x1080 PNG/);

  await writeFile(join(root, "style", "sample", "sample.png"), Buffer.from("not a png"));
  await assert.rejects(publishStyleSample(root));

  const complete = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: "#102030" },
  }).png().toBuffer();
  const truncated = complete.subarray(0, complete.length - 64);
  assert.equal((await sharp(truncated).metadata()).format, "png", "regression fixture must retain a valid PNG header");
  await writeFile(join(root, "style", "sample", "sample.png"), truncated);
  await assert.rejects(publishStyleSample(root));
});

test("rejects symlink and non-file fixed gate artifacts without following them", async (t) => {
  const parent = await temporaryParent(t, "superppt-gate-links-");
  for (const kind of ["symlink", "directory"] as const) {
    const root = join(parent, kind);
    await initializeProject({ root, title: kind });
    await writeValidPlan(root);
    const briefPath = join(root, "brief.json");
    await rm(briefPath);
    if (kind === "symlink") {
      const outside = join(parent, `${kind}.json`);
      await writeFile(outside, JSON.stringify(brief));
      await symlink(outside, briefPath);
    } else await mkdir(briefPath);
    await assert.rejects(approveGate(root, "outline"), /regular file|outside project/);
    assert.deepEqual((await readProject(root)).gates, []);
  }
});

test("fails closed when a fixed gate artifact is swapped after opening", async (t) => {
  const root = await project(t, "superppt-gate-swap-");
  await writeValidPlan(root);
  const briefPath = join(root, "brief.json");
  const backup = join(root, "brief.backup.json");
  let swapped = false;
  await assert.rejects(approveGate(root, "outline", {
    operations: {
      async afterArtifactOpened(path) {
        if (!swapped && path === briefPath) {
          swapped = true;
          await rename(briefPath, backup);
          await writeFile(briefPath, JSON.stringify(brief));
        }
      },
    },
  }), /changed while reading/);
  assert.deepEqual((await readProject(root)).gates, []);
});

test("stores portable keys and revision-owned immutable approval snapshots", async (t) => {
  const root = await project(t, "superppt-gate-snapshot-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  assert.equal(toPortableProjectPath("slides\\id\\spec.json"), "slides/id/spec.json");
  await approveGate(root, "outline");
  const firstGate = (await readProject(root)).gates[0]!;
  assert.ok(firstGate.snapshotPath?.startsWith("revisions/"));
  assert.equal(Object.keys(firstGate.artifactHashes).some((key) => key.includes("\\")), false);
  const snapshot = await readGateSnapshot(root, "outline");
  const approvedBrief = await readFile(join(root, "brief.json"));
  assert.deepEqual(snapshot.artifacts["brief.json"], approvedBrief);
  assert.equal(snapshot.manifest.gates.at(-1)?.gate, "outline");
  await writeFile(join(root, "brief.json"), JSON.stringify({ ...brief, title: "Changed later" }));
  assert.deepEqual((await readGateSnapshot(root, "outline")).artifacts["brief.json"], approvedBrief);
  await writeFile(join(root, "brief.json"), approvedBrief);
  await approveGate(root, "outline");
  const gates = (await readProject(root)).gates.filter(({ gate }) => gate === "outline");
  assert.equal(gates.length, 2);
  assert.notEqual(gates[0]!.snapshotPath, gates[1]!.snapshotPath);
  await access(join(root, ...gates[0]!.snapshotPath!.split("/"), "snapshot.json"));
  await access(join(root, ...gates[1]!.snapshotPath!.split("/"), "snapshot.json"));
});

test("retains snapshot evidence if manifest publication fails", async (t) => {
  const root = await project(t, "superppt-gate-snapshot-fail-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  await assert.rejects(approveGate(root, "outline", {
    operations: { checkpoint(step) { if (step === "snapshot-published") throw new Error("injected after snapshot"); } },
  }), /injected after snapshot/);
  assert.deepEqual((await readProject(root)).gates, []);
  const gateRoot = join(root, "revisions", (await readProject(root)).currentRevision.id, "gates");
  assert.ok((await readdir(gateRoot)).some((name) => name.includes("outline") && !name.includes("staging")));
});

test("serializes concurrent approvals without lost gate updates", async (t) => {
  const root = await project(t, "superppt-gate-concurrent-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  await Promise.all([approveGate(root, "outline"), approveGate(root, "outline")]);
  const gates = (await readProject(root)).gates;
  assert.equal(gates.length, 2);
  assert.equal(new Set(gates.map(({ snapshotPath }) => snapshotPath)).size, 2);
});

test("recovers an abandoned unique planning lease request without reusing its name", async (t) => {
  const root = await project(t, "superppt-stale-lock-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  const leaseRoot = join(root, ".superppt-leases", "planning");
  await mkdir(leaseRoot, { recursive: true });
  const crashed = join(leaseRoot, "00000000-0000-4000-8000-000000000999.active.json");
  await writeFile(crashed, JSON.stringify({
    version: 1,
    id: "00000000-0000-4000-8000-000000000999",
    token: "00000000-0000-4000-8000-000000000998",
    pid: 99999999,
    createdAt: "2000-01-01T00:00:00.000Z",
  }));
  await utimes(crashed, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  await approveGate(root, "outline", { lock: { staleAfterMs: 1 } });
  assert.equal((await readProject(root)).gates.length, 1);
  assert.ok((await readdir(leaseRoot)).includes("00000000-0000-4000-8000-000000000999.stale.json"));
});

test("unique request leases prevent adversarial takeover and concurrent owners", async (t) => {
  const root = await project(t, "superppt-lease-mutual-exclusion-");
  const leaseRoot = join(root, ".superppt-leases", "adversarial");
  await mkdir(leaseRoot, { recursive: true });
  const crashed = join(leaseRoot, "00000000-0000-4000-8000-000000000997.active.json");
  await writeFile(crashed, JSON.stringify({
    version: 1,
    id: "00000000-0000-4000-8000-000000000997",
    token: "00000000-0000-4000-8000-000000000996",
    pid: 99999999,
    createdAt: "2000-01-01T00:00:00.000Z",
  }));
  await utimes(crashed, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  let owners = 0;
  let maximumOwners = 0;
  await Promise.all(Array.from({ length: 4 }, () => withProjectLease(root, "adversarial", async () => {
    owners += 1;
    maximumOwners = Math.max(maximumOwners, owners);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    owners -= 1;
  }, { staleAfterMs: 1 })));
  assert.equal(maximumOwners, 1);
  const evidence = await readdir(leaseRoot);
  assert.ok(evidence.includes("00000000-0000-4000-8000-000000000997.stale.json"));
  assert.equal(evidence.filter((name) => name.endsWith(".completed.json")).length, 4);
});

test("state lease contenders tolerate an atomic manifest promotion by the current owner", async (t) => {
  const root = await project(t, "superppt-state-lease-promotion-");
  let announcePromotion!: () => void;
  const promotionStarted = new Promise<void>((resolve) => { announcePromotion = resolve; });
  let releasePromotion!: () => void;
  const promotionReleased = new Promise<void>((resolve) => { releasePromotion = resolve; });

  const writer = updateProject(root, (manifest) => ({ ...manifest, title: "Promoted" }), {
    promote: async (stagingPath, manifestPath) => {
      announcePromotion();
      await promotionReleased;
      await rename(stagingPath, manifestPath);
    },
  });
  await promotionStarted;

  let opened = 0;
  let announceOpened!: () => void;
  const allOpened = new Promise<void>((resolve) => { announceOpened = resolve; });
  let releaseReads!: () => void;
  const readsReleased = new Promise<void>((resolve) => { releaseReads = resolve; });
  const contenderCount = 4;
  const contenders = Promise.allSettled(Array.from({ length: contenderCount }, () =>
    withProjectLease(root, "state", async () => undefined, {
      waitTimeoutMs: 60_000,
      manifestRead: {
        afterOpen: async () => {
          opened += 1;
          if (opened === contenderCount) announceOpened();
          await readsReleased;
        },
      },
    })
  ));
  let handshakeTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      allOpened,
      new Promise<never>((_resolve, reject) => {
        handshakeTimer = setTimeout(() => reject(new Error("manifest read handshake timed out")), 2_000);
      }),
    ]);
  } finally {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    releasePromotion();
    await writer;
    releaseReads();
  }

  const failures = (await contenders)
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(({ reason }) => reason instanceof Error ? reason.message : String(reason));
  assert.deepEqual(failures, []);
});

test("lease authentication rejects an in-place manifest rewrite before publishing lease evidence", async (t) => {
  const root = await project(t, "superppt-state-lease-in-place-");
  const manifestPath = join(root, "superppt.json");
  const original = await readFile(manifestPath, "utf8");
  const changed = original.replace('"title": "Demo"', '"title": "Damo"');
  assert.equal(changed.length, original.length);
  let actionCalled = false;

  await assert.rejects(withProjectLease(root, "state", async () => {
    actionCalled = true;
  }, {
    manifestRead: {
      afterOpen: async () => { await writeFile(manifestPath, changed); },
    },
  }), /not owned|changed while reading/i);
  assert.equal(actionCalled, false);
  await assert.rejects(readdir(join(root, ".superppt-leases")), { code: "ENOENT" });
});

test("recovery refuses missing, tampered, or linked manifests before writing project artifacts", async (t) => {
  for (const corruption of ["missing", "tampered", "symlink"] as const) {
    const root = await project(t, `superppt-recovery-${corruption}-manifest-`);
    await writeValidPlan(root);
    await publishPlanViews(root);
    await writeFile(join(root, "brief.json"), `${JSON.stringify({ ...brief, title: "Pending recovery" }, null, 2)}\n`);
    await assert.rejects(publishPlanViews(root, {
      operations: { checkpoint(step) { if (step === "convenience-written") throw new Error("leave pending recovery"); } },
    }), /leave pending recovery/);
    const briefBefore = await readFile(join(root, "brief.md"));
    const journalRoot = join(root, ".superppt-view-journals");
    const journalBefore = await readdir(journalRoot);
    assert.ok(journalBefore.some((name) => name.endsWith(".pending.json")));
    const leasesBefore = await readdir(join(root, ".superppt-leases", "planning"));
    const stateLeasesBefore = await readdir(join(root, ".superppt-leases", "state"));
    const manifestPath = join(root, "superppt.json");
    if (corruption === "missing") {
      await unlink(manifestPath);
    } else if (corruption === "tampered") {
      await writeFile(manifestPath, "{}\n");
    } else {
      const external = join(await temporaryParent(t, "superppt-linked-manifest-"), "manifest.json");
      await writeFile(external, await readFile(manifestPath));
      await unlink(manifestPath);
      await symlink(external, manifestPath);
    }

    await assert.rejects(recoverPlanViews(root), /not owned|regular file|manifest/i);
    assert.deepEqual(await readFile(join(root, "brief.md")), briefBefore);
    assert.deepEqual(await readdir(journalRoot), journalBefore);
    assert.deepEqual(await readdir(join(root, ".superppt-leases", "planning")), leasesBefore);
    assert.deepEqual(await readdir(join(root, ".superppt-leases", "state")), stateLeasesBefore);
  }
});

test("publishes review views as one authoritative revision tree", async (t) => {
  const root = await project(t, "superppt-views-");
  await writeValidPlan(root);
  const publication = await publishPlanViews(root);
  const read = await readPublishedPlanViews(root);
  assert.equal(read.publicationPath, publication.publicationPath);
  assert.equal(read.brief, renderBrief(BriefSchema.parse(brief)));
  assert.equal(read.outline, renderOutline(OutlineSchema.parse(outline)));
  assert.deepEqual(Object.keys(read.slides).sort(), [...SLIDE_IDS].sort());
  assert.equal(read.slides[SLIDE_IDS[0]], renderSlideSpec(SlideSpecSchema.parse(spec(0))));
  assert.equal(await readFile(join(root, "brief.md"), "utf8"), read.brief);
});

test("view publication failures expose only an old or new complete authoritative set", async (t) => {
  const root = await project(t, "superppt-views-failure-");
  await writeValidPlan(root);
  const first = await publishPlanViews(root);
  const oldRead = await readPublishedPlanViews(root);
  await writeFile(join(root, "brief.json"), `${JSON.stringify({ ...brief, title: "New title" }, null, 2)}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify({ ...outline, slides: [{ ...outline.slides[0], title: "New title" }, ...outline.slides.slice(1)] }, null, 2)}\n`);
  await writeFile(join(root, "slides", SLIDE_IDS[0], "spec.json"), `${JSON.stringify({ ...spec(0), title: "New title" }, null, 2)}\n`);
  await assert.rejects(publishPlanViews(root, {
    operations: { checkpoint(step) { if (step === "snapshot-published") throw new Error("before authority"); } },
  }), /before authority/);
  assert.equal((await readPublishedPlanViews(root)).publicationPath, first.publicationPath);
  assert.deepEqual(await readPublishedPlanViews(root), oldRead);
  await assert.rejects(publishPlanViews(root, {
    operations: { checkpoint(step) { if (step === "convenience-written") throw new Error("during convenience"); } },
  }), /during convenience/);
  const newRead = await readPublishedPlanViews(root);
  assert.notEqual(newRead.publicationPath, first.publicationPath);
  assert.match(newRead.brief, /^# New title/);
  assert.match(newRead.outline, /## 1\. New title/);
  assert.match(newRead.slides[SLIDE_IDS[0]], /^# New title/);
  assert.match(await readFile(join(root, "brief.md"), "utf8"), /^# New title/);
  assert.doesNotMatch(await readFile(join(root, "outline.md"), "utf8"), /## 1\. New title/);
  await recoverPlanViews(root);
  assert.equal(await readFile(join(root, "brief.md"), "utf8"), newRead.brief);
  assert.ok((await readdir(join(root, ".superppt-view-journals"))).some((name) => name.endsWith(".completed")));
});

test("gate approval is bound to the exact authoritative plan and style publications", async (t) => {
  const root = await project(t, "superppt-presentation-binding-");
  await writeValidPlan(root);
  await assert.rejects(approveGate(root, "outline"), /authoritative planning publication is required/);
  await publishPlanViews(root);
  const originalBrief = await readFile(join(root, "brief.json"));
  await writeFile(join(root, "brief.json"), JSON.stringify(brief));
  await assert.rejects(approveGate(root, "outline"), /do not match authoritative planning publication/);
  await writeFile(join(root, "brief.json"), originalBrief);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");

  await writeValidStyleSample(root);
  await assert.rejects(approveGate(root, "style-sample"), /authoritative style sample publication is required/);
  await publishStyleSample(root);
  await writeFile(join(root, "style", "sample", "prompt.txt"), "changed after presentation\n");
  await assert.rejects(approveGate(root, "style-sample"), /canonical style sample prompt/);
});

test("rejects forged ordinary gates submitted directly through writeProject", async (t) => {
  const root = await project(t, "superppt-forged-gate-");
  const manifest = await readProject(root);
  await assert.rejects(writeProject(root, {
    ...manifest,
    gates: [...manifest.gates, {
      gate: "outline",
      revisionId: manifest.currentRevision.id,
      artifactHashes: { "brief.json": "a".repeat(64), "outline.json": "b".repeat(64) },
      snapshotPath: `revisions/${manifest.currentRevision.id}/gates/outline-00000000-0000-4000-8000-000000000888`,
      confirmedAt: new Date().toISOString(),
    }],
  }), /ordinary gate evidence/);
  assert.deepEqual((await readProject(root)).gates, []);

  await writeValidPlan(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  const approved = await readProject(root);
  await assert.rejects(writeProject(root, {
    ...approved,
    gates: [...approved.gates, approved.gates[0]!],
  }), /ordinary gate evidence/);
  assert.equal((await readProject(root)).gates.length, 1);
});

test("snapshot descriptor corruption makes a gate stale and recovery reject", async (t) => {
  const root = await project(t, "superppt-corrupt-snapshot-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  const gate = (await readProject(root)).gates[0]!;
  await writeFile(join(root, ...gate.snapshotPath!.split("/"), "snapshot.json"), "{}\n");
  assert.equal(await assertGateCurrent(root, "outline"), false);
  await assert.rejects(readGateSnapshot(root, "outline"), /snapshot descriptor/);
});

test("recomputed snapshot self-hashes cannot hide manifest tampering", async (t) => {
  const root = await project(t, "superppt-rehashed-snapshot-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  const gate = (await readProject(root)).gates[0]!;
  const snapshotRoot = join(root, ...gate.snapshotPath!.split("/"));
  const manifestPath = join(snapshotRoot, "superppt.json");
  const descriptorPath = join(snapshotRoot, "snapshot.json");
  const snapshotManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  snapshotManifest.title = "tampered snapshot title";
  const manifestBytes = Buffer.from(`${JSON.stringify(snapshotManifest, null, 2)}\n`);
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>;
  delete descriptor.descriptorSha256;
  descriptor.manifestSha256 = sha256Evidence(manifestBytes);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(descriptorPath, `${JSON.stringify(addDescriptorIntegrity(descriptor), null, 2)}\n`);
  assert.equal(await assertGateCurrent(root, "outline"), false);
  await assert.rejects(readGateSnapshot(root, "outline"), /snapshot descriptor|tree/);
});

test("authoritative view reader validates immutable descriptor and exact coverage", async (t) => {
  const first = await project(t, "superppt-corrupt-publication-");
  await writeValidPlan(first);
  const publication = await publishPlanViews(first);
  await rm(join(first, ...publication.publicationPath.split("/"), "slides", SLIDE_IDS[1], "spec.md"));
  await assert.rejects(readPublishedPlanViews(first), /regular file|incomplete|coverage/);

  const second = join(await temporaryParent(t, "superppt-altered-pointer-"), "project");
  await initializeProject({ root: second, title: "Pointer" });
  await writeValidPlan(second);
  await publishPlanViews(second);
  const pointerPath = join(second, "planning-views.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { viewHashes: Record<string, string> };
  delete pointer.viewHashes[`slides/${SLIDE_IDS[1]}/spec.md`];
  await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  await assert.rejects(readPublishedPlanViews(second), /descriptor integrity|descriptor identity|coverage/);
});

test("concurrent non-planning manifest update and gate approval preserve both changes", async (t) => {
  const root = await project(t, "superppt-state-concurrency-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  await Promise.all([
    updateProject(root, (manifest) => ({ ...manifest, title: "Concurrent title", stage: "outline" })),
    approveGate(root, "outline"),
  ]);
  const manifest = await readProject(root);
  assert.equal(manifest.title, "Concurrent title");
  assert.equal(manifest.stage, "outline");
  assert.equal(manifest.gates.filter(({ gate }) => gate === "outline").length, 1);
});

test("authoritative publication serializes against project state writers", async (t) => {
  const root = await project(t, "superppt-publication-state-concurrency-");
  await writeValidPlan(root);
  let reachedSnapshot!: () => void;
  const snapshotReached = new Promise<void>((resolve) => { reachedSnapshot = resolve; });
  let releasePublication!: () => void;
  const publicationReleased = new Promise<void>((resolve) => { releasePublication = resolve; });
  const publication = publishPlanViews(root, {
    operations: {
      async checkpoint(step) {
        if (step === "snapshot-published") {
          reachedSnapshot();
          await publicationReleased;
        }
      },
    },
  });
  await snapshotReached;
  let updateFinished = false;
  const update = updateProject(root, (manifest) => ({ ...manifest, title: "After publication" }))
    .then(() => { updateFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(updateFinished, false);
  releasePublication();
  await Promise.all([publication, update]);
  assert.equal((await readProject(root)).title, "After publication");
  assert.equal((await readPublishedPlanViews(root)).slides[SLIDE_IDS[1]], renderSlideSpec(spec(1)));
});

test("manifest writes reject removing persisted gate history", async (t) => {
  const root = await project(t, "superppt-gate-prefix-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  const manifest = await readProject(root);
  await assert.rejects(writeProject(root, { ...manifest, gates: [] }), /gate history must remain an exact prefix/);
});

test("CLI validates and publishes plans and exposes no artifact override", async (t) => {
  const root = await project(t, "superppt-planning-cli-");
  await writeValidPlan(root);
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const source = "# CLI input\r\n\r\nexact\r\n";
  await execFileAsync(process.execPath, [...invocation, "ingest", "--project", root, "--text", source], { cwd: process.cwd() });
  assert.equal(await readFile(join(root, "source", "original.md"), "utf8"), source);
  const validated = await execFileAsync(process.execPath, [...invocation, "validate-plan", "--project", root], { cwd: process.cwd() });
  assert.equal(validated.stderr, "");
  assert.equal((JSON.parse(validated.stdout) as { slideCount: number }).slideCount, 3);
  await execFileAsync(process.execPath, [...invocation, "approve", "--project", root, "--gate", "outline"], { cwd: process.cwd() });
  assert.equal(await assertGateCurrent(root, "outline"), true);
  await assert.rejects(execFileAsync(process.execPath, [...invocation, "approve", "--project", root, "--gate", "outline", "--artifacts", "[\"superppt.json\"]"], { cwd: process.cwd() }), /unknown CLI flag/);
  await assert.rejects(execFileAsync(process.execPath, [...invocation, "validate-plan", "--project", "relative"], { cwd: process.cwd() }), /Unsafe project root/);
});

test("CLI publishes and approves the outline before any slide specs exist", async (t) => {
  const root = await project(t, "superppt-outline-stage-cli-");
  await writeFile(join(root, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline, null, 2)}\n`);
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const run = (args: string[]) => execFileAsync(process.execPath, [...invocation, ...args], { cwd: process.cwd() });

  const published = await run(["validate-outline", "--project", root]);
  assert.equal((JSON.parse(published.stdout) as { slideCount: number }).slideCount, 3);
  await run(["approve", "--project", root, "--gate", "outline"]);
  assert.equal(await assertGateCurrent(root, "outline"), true);
  await assert.rejects(run(["validate-plan", "--project", root]), /spec IDs must exactly match outline IDs/);
  assert.equal((await readPublishedOutlineViews(root)).slides[SLIDE_IDS[0]], undefined);
});

test("CLI publishes authoritative style evidence before the existing approval gate", async (t) => {
  const root = await project(t, "superppt-style-cli-");
  await writeValidPlan(root);
  await writeValidStyleSample(root);
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const run = (args: string[]) => execFileAsync(process.execPath, [...invocation, ...args], { cwd: process.cwd() });

  await run(["validate-plan", "--project", root]);
  await run(["approve", "--project", root, "--gate", "outline"]);
  await run(["approve", "--project", root, "--gate", "slide-specs"]);
  await assert.rejects(
    run(["approve", "--project", root, "--gate", "style-sample"]),
    /authoritative style sample publication is required/,
  );

  const published = await run(["publish-style-sample", "--project", root]);
  assert.equal(published.stderr, "");
  const descriptor = JSON.parse(published.stdout) as {
    kind: string;
    publicationPath: string;
    representativeSlideId: string;
    sourceHashes: Record<string, string>;
  };
  assert.equal(descriptor.kind, "style-sample");
  assert.match(descriptor.publicationPath, /^revisions\/[0-9a-f-]{36}\/style-samples\/[0-9a-f-]{36}$/);
  assert.equal(descriptor.representativeSlideId, SLIDE_IDS[1]);
  assert.deepEqual(Object.keys(descriptor.sourceHashes).sort(), [
    "style/sample/director.json",
    "style/sample/ledger.json",
    "style/sample/prompt.txt",
    "style/sample/sample.png",
    "style/selection.json",
  ]);
  assert.equal((await readProject(root)).gates.some(({ gate }) => gate === "style-sample"), false);

  await writeFile(join(root, "style", "sample", "prompt.txt"), "stale replacement\n");
  await assert.rejects(
    run(["approve", "--project", root, "--gate", "style-sample"]),
    /canonical style sample prompt/,
  );
  await writeCanonicalStyleSample(root);
  await run(["publish-style-sample", "--project", root]);
  await run(["approve", "--project", root, "--gate", "style-sample"]);
  assert.equal(await assertGateCurrent(root, "style-sample"), true);
});
