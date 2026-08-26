import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { approveGate, assertGateCurrent, readGateSnapshot, toPortableProjectPath } from "../src/planning/confirm.js";
import { normalizeInput } from "../src/planning/intake.js";
import { renderBrief, renderOutline, renderSlideSpec } from "../src/planning/render.js";
import { BriefSchema, OutlineSchema, SlideSpecSchema } from "../src/planning/schemas.js";
import { publishPlanViews, readPublishedPlanViews, recoverPlanViews } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject, writeProject } from "../src/project/store.js";

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
  await writeFile(join(root, "style", "sample", "prompt.txt"), "one focal point\n");
  await writeFile(join(root, "style", "sample", "sample.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
}

async function approveAll(root: string): Promise<void> {
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
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
  assert.deepEqual(Object.keys(manifest.gates[2]!.artifactHashes).sort(), ["style/sample/prompt.txt", "style/sample/sample.png", "style/selection.json"]);
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
  await approveGate(specRoot, "outline");
  await writeFile(join(specRoot, "slides", SLIDE_IDS[1], "spec.json"), JSON.stringify({ ...spec(1), title: "Wrong" }));
  await assert.rejects(approveGate(specRoot, "slide-specs"), /must match outline/);

  const styleRoot = join(await temporaryParent(t, "superppt-invalid-style-"), "project");
  await initializeProject({ root: styleRoot, title: "Style" });
  await writeValidPlan(styleRoot);
  await writeValidStyleSample(styleRoot);
  await approveGate(styleRoot, "outline");
  await approveGate(styleRoot, "slide-specs");
  await writeFile(join(styleRoot, "style", "selection.json"), JSON.stringify({ schemaVersion: 1, styleId: "cinematic-tech", representativeSlideId: PROJECT_ID }));
  await assert.rejects(approveGate(styleRoot, "style-sample"), /representative slide must exist/);
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
  await Promise.all([approveGate(root, "outline"), approveGate(root, "outline")]);
  const gates = (await readProject(root)).gates;
  assert.equal(gates.length, 2);
  assert.equal(new Set(gates.map(({ snapshotPath }) => snapshotPath)).size, 2);
});

test("recovers an abandoned stale planning lock without deleting its evidence", async (t) => {
  const root = await project(t, "superppt-stale-lock-");
  await writeValidPlan(root);
  const lock = join(root, ".superppt-planning.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ version: 1, id: "00000000-0000-4000-8000-000000000999", pid: 99999999, acquiredAt: "2000-01-01T00:00:00.000Z" }));
  await utimes(lock, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  await approveGate(root, "outline", { lock: { staleAfterMs: 1 } });
  assert.equal((await readProject(root)).gates.length, 1);
  assert.ok((await readdir(join(root, ".superppt-locks"))).some((name) => name.endsWith(".stale")));
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

test("manifest writes reject removing persisted gate history", async (t) => {
  const root = await project(t, "superppt-gate-prefix-");
  await writeValidPlan(root);
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
