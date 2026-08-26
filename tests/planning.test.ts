import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { approveGate, assertGateCurrent } from "../src/planning/confirm.js";
import { normalizeInput } from "../src/planning/intake.js";
import { renderBrief, renderOutline, renderSlideSpec } from "../src/planning/render.js";
import {
  BriefSchema,
  OutlineSchema,
  SlideSpecSchema,
} from "../src/planning/schemas.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject } from "../src/project/store.js";

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
  mustCover: ["六类角色", "闭环"],
  constraints: ["16:9", "无水印"],
};

const outline = {
  schemaVersion: 1 as const,
  slides: SLIDE_IDS.map((id, order) => ({
    id,
    order,
    title: `Page ${order + 1}`,
    role: (["cover", "content", "summary"] as const)[order]!,
    purpose: `Purpose ${order + 1}`,
    sourceRefs: [`L${order + 1}`],
  })),
};

function spec(slideId: string, title = "Page") {
  return {
    schemaVersion: 1 as const,
    slideId,
    title,
    role: "content" as const,
    coreMessage: "One idea",
    requiredText: ["A"],
    visualSubject: "One central orchestration hub",
    composition: "hub and spoke",
    relationships: ["hub controls six agents"],
    forbidden: ["watermark"],
    sourceRefs: ["L1-L2"],
  };
}

test("preserves description and Markdown inputs without rewriting source bytes", async (t) => {
  const root = await project(t, "superppt-input-");
  const source = "# 原始标题\n\n保留  **Markdown**  间距。\r\n";

  const destination = await normalizeInput(root, { kind: "text", value: source });

  assert.equal(destination, join(root, "source", "original.md"));
  assert.deepEqual(await readFile(destination), Buffer.from(source));
  assert.equal((await readFile(join(root, "superppt.json"), "utf8")).includes(source), false);
});

test("copies Markdown input exactly and rejects empty, linked, repeated, and unowned writes", async (t) => {
  const parent = await temporaryParent(t, "superppt-input-safety-");
  const first = join(parent, "first");
  const second = join(parent, "second");
  await initializeProject({ root: first, title: "First" });
  await initializeProject({ root: second, title: "Second" });
  const markdown = join(parent, "input.MD");
  const linked = join(parent, "linked.md");
  const bytes = Buffer.from([0x23, 0x20, 0xe4, 0xb8, 0xad, 0x0d, 0x0a]);
  await writeFile(markdown, bytes);
  await symlink(markdown, linked);

  await normalizeInput(first, { kind: "markdown", path: markdown });
  assert.deepEqual(await readFile(join(first, "source", "original.md")), bytes);
  await assert.rejects(
    normalizeInput(first, { kind: "description", value: "replacement" }),
    /exist|already/i,
  );
  await assert.rejects(
    normalizeInput(second, { kind: "markdown", path: linked }),
    /regular \.md file/,
  );
  await assert.rejects(
    normalizeInput(second, { kind: "description", value: "   \r\n" }),
    /must not be empty/,
  );
  await assert.rejects(
    normalizeInput(join(parent, "unowned"), { kind: "text", value: "content" }),
    /not owned/,
  );
});

test("requires strict briefs, unique stable slide IDs, and contiguous current order", () => {
  assert.throws(() => BriefSchema.parse({ ...brief, extra: true }), /unrecognized/i);
  assert.throws(() => OutlineSchema.parse({
    schemaVersion: 1,
    slides: [outline.slides[0], { ...outline.slides[1], id: SLIDE_IDS[0] }, outline.slides[2]],
  }), /stable slide IDs must be unique/);
  assert.throws(() => OutlineSchema.parse({
    schemaVersion: 1,
    slides: [outline.slides[0], { ...outline.slides[1], order: 3 }, outline.slides[2]],
  }), /slide order must be contiguous from zero/);
  assert.doesNotThrow(() => SlideSpecSchema.parse(spec(SLIDE_IDS[0])));
  assert.throws(() => SlideSpecSchema.parse({ ...spec(SLIDE_IDS[0]), slideId: "slide-1" }), /uuid/i);
});

test("renders deterministic human-readable brief, outline, and slide views", () => {
  const parsedBrief = BriefSchema.parse(brief);
  const parsedOutline = OutlineSchema.parse({
    ...outline,
    slides: [outline.slides[2], outline.slides[0], outline.slides[1]],
  });
  const parsedSpec = SlideSpecSchema.parse(spec(SLIDE_IDS[0], "A"));

  assert.match(renderBrief(parsedBrief), /^# AI Agent 协作系统\n/);
  assert.ok(renderOutline(parsedOutline).indexOf("## 1. Page 1") < renderOutline(parsedOutline).indexOf("## 3. Page 3"));
  assert.match(renderSlideSpec(parsedSpec), /- 页面 ID：00000000-0000-4000-8000-000000000201/);
  assert.equal(renderBrief(parsedBrief), renderBrief(parsedBrief));
});

test("approves only current gates in outline then slide-specs then style-sample order", async (t) => {
  const root = await project(t, "superppt-gates-");
  const outlinePath = join(root, "outline.json");
  const specPath = join(root, "slides", SLIDE_IDS[0], "spec.json");
  const samplePath = join(root, "style", "sample", "sample.png");
  await mkdir(join(root, "slides", SLIDE_IDS[0]), { recursive: true });
  await writeFile(outlinePath, JSON.stringify({ schemaVersion: 1, slides: [] }));
  await writeFile(specPath, JSON.stringify(spec(SLIDE_IDS[0])));
  await writeFile(samplePath, "sample");

  await assert.rejects(approveGate(root, "slide-specs", [specPath]), /outline gate must be current/);
  await assert.rejects(approveGate(root, "style-sample", [samplePath]), /slide-specs gate must be current/);
  await approveGate(root, "outline", [outlinePath]);
  assert.equal(await assertGateCurrent(root, "outline"), true);
  await approveGate(root, "slide-specs", [specPath]);
  await approveGate(root, "style-sample", [samplePath]);
  assert.equal(await assertGateCurrent(root, "style-sample"), true);

  await writeFile(outlinePath, JSON.stringify({ schemaVersion: 1, slides: [{ id: SLIDE_IDS[0] }] }));
  assert.equal(await assertGateCurrent(root, "outline"), false);
  assert.equal(await assertGateCurrent(root, "slide-specs"), false);
  assert.equal(await assertGateCurrent(root, "style-sample"), false);
  await assert.rejects(approveGate(root, "slide-specs", [specPath]), /outline gate must be current/);
  await assert.rejects(approveGate(root, "style-sample", [samplePath]), /slide-specs gate must be current/);
  await assert.rejects(approveGate(root, "outline", []), /at least one artifact/);
  await assert.rejects(
    approveGate(root, "revision-impact" as never, [outlinePath]),
    /invalid planning gate/,
  );
});

test("stores collision-free project-relative hashes and rejects artifacts outside the project", async (t) => {
  const parent = await temporaryParent(t, "superppt-gate-paths-");
  const root = join(parent, "project");
  await initializeProject({ root, title: "Demo" });
  const first = join(root, "slides", SLIDE_IDS[0], "spec.json");
  const second = join(root, "slides", SLIDE_IDS[1], "spec.json");
  const outside = join(parent, "outside.json");
  await mkdir(join(root, "slides", SLIDE_IDS[0]), { recursive: true });
  await mkdir(join(root, "slides", SLIDE_IDS[1]), { recursive: true });
  await writeFile(first, "first");
  await writeFile(second, "second");
  await writeFile(outside, "outside");

  await approveGate(root, "outline", [first, second]);
  const approved = (await readProject(root)).gates.at(-1)!;
  assert.deepEqual(Object.keys(approved.artifactHashes).sort(), [
    `slides/${SLIDE_IDS[0]}/spec.json`,
    `slides/${SLIDE_IDS[1]}/spec.json`,
  ]);
  await assert.rejects(approveGate(root, "outline", [outside]), /outside project/);
});

test("validate-plan CLI writes validated Markdown views and rejects incomplete coverage", async (t) => {
  const root = await project(t, "superppt-validate-plan-");
  const invocation = ["--import", "tsx", "src/cli.ts"];
  await writeFile(join(root, "brief.json"), `${JSON.stringify(brief)}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline)}\n`);
  for (const slide of outline.slides) {
    const directory = join(root, "slides", slide.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "spec.json"), `${JSON.stringify(spec(slide.id, slide.title))}\n`);
  }

  const validated = await execFileAsync(
    process.execPath,
    [...invocation, "validate-plan", "--project", root],
    { cwd: process.cwd() },
  );
  assert.equal(validated.stderr, "");
  assert.equal((JSON.parse(validated.stdout) as { slideCount: number }).slideCount, 3);
  await Promise.all([
    access(join(root, "brief.md")),
    access(join(root, "outline.md")),
    ...SLIDE_IDS.map((id) => access(join(root, "slides", id, "spec.md"))),
  ]);

  await rm(join(root, "slides", SLIDE_IDS[2]), { recursive: true });
  await assert.rejects(
    execFileAsync(process.execPath, [...invocation, "validate-plan", "--project", root], { cwd: process.cwd() }),
    /spec IDs must exactly match outline IDs/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [...invocation, "validate-plan", "--project", "relative"], { cwd: process.cwd() }),
    /Unsafe project root/,
  );
});

test("validate-plan rejects planning inputs and slide roots linked outside the project", async (t) => {
  const parent = await temporaryParent(t, "superppt-validate-links-");
  const invocation = ["--import", "tsx", "src/cli.ts"];

  for (const linkedEntry of ["brief.json", "slides"] as const) {
    const root = join(parent, linkedEntry.replace(".", "-"));
    await initializeProject({ root, title: "Demo" });
    const outside = join(parent, `outside-${linkedEntry.replace(".", "-")}`);
    if (linkedEntry === "brief.json") {
      await writeFile(outside, JSON.stringify(brief));
      await symlink(outside, join(root, "brief.json"));
    } else {
      await rm(join(root, "slides"), { recursive: true });
      await mkdir(outside);
      await symlink(outside, join(root, "slides"));
      await writeFile(join(root, "brief.json"), JSON.stringify(brief));
    }
    await writeFile(join(root, "outline.json"), JSON.stringify(outline));

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [...invocation, "validate-plan", "--project", root],
        { cwd: process.cwd() },
      ),
      /planning artifact must be a regular file|slide workspace must be a regular directory/,
    );
  }
});

test("ingest and approve CLI routes preserve input and reject ambiguous flags", async (t) => {
  const root = await project(t, "superppt-planning-cli-");
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const source = "# Exact\r\n\r\nbytes\r\n";

  await execFileAsync(
    process.execPath,
    [...invocation, "ingest", "--project", root, "--text", source],
    { cwd: process.cwd() },
  );
  assert.equal(await readFile(join(root, "source", "original.md"), "utf8"), source);

  await writeFile(join(root, "outline.json"), JSON.stringify({ schemaVersion: 1, slides: [] }));
  await execFileAsync(
    process.execPath,
    [...invocation, "approve", "--project", root, "--gate", "outline", "--artifacts", "[\"outline.json\"]"],
    { cwd: process.cwd() },
  );
  assert.equal(await assertGateCurrent(root, "outline"), true);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...invocation, "ingest", "--project", root, "--text", "a", "--markdown", "b.md"],
      { cwd: process.cwd() },
    ),
    /unknown CLI flag|required CLI flags|exactly one input/i,
  );
});
