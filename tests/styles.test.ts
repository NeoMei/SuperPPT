import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { loadBuiltInStyleCatalog, loadStyleCatalog, selectRepresentativeSlide } from "../src/styles/catalog.js";
import { compilePrompt, compileSlidePrompt } from "../src/styles/prompt-compiler.js";
import { StyleCatalogSchema } from "../src/styles/schemas.js";
import { approveGate } from "../src/planning/confirm.js";
import { configureGenerationAuthorizationTrustForTests } from "../src/generation/trusted-authorization.js";
import { initializeProject } from "../src/project/initialize.js";
import { publishPlanViews, publishStyleSample } from "../src/planning/views.js";
import { approveStyleLock, createProvisionalStyleLock, readApprovedStyleLock, readStyleLock } from "../src/styles/style-lock.js";
import { finalizeDelegatedStyleSampleForTest } from "./helpers/delegated-style-sample.js";

const catalogPath = "skills/superppt/assets/styles/catalog.json";
const promptSpec = { title: "AI Agent 协作系统", role: "content" as const, coreMessage: "Specialists cooperate", requiredText: ["AI Agent 协作系统"], visualSubject: "central orchestration core", composition: "one focal hub with six satellites", relationships: ["hub routes work"], forbidden: ["watermark"] };
const promptStyle = { id: "cinematic-tech", name: "电影科技", palette: ["midnight blue", "cyan", "restrained coral"], materials: ["smoked glass", "brushed metal"], lighting: ["volumetric key light", "cyan rim light"], medium: ["cinematic concept art", "photoreal 3D"], typography: ["clear title safe area", "precise sans serif"], detailLanguage: ["fine circuitry", "particle paths", "micro etched labels"], compositionRules: ["one dominant focal point", "layered depth", "controlled information zones"], forbidden: ["neon gamer UI"], pageVariants: { cover: "hero system core", section: "single transition portal", content: "deep layered system scene", process: "luminous directional route", comparison: "balanced opposing chambers", data: "integrated analytical observatory", summary: "converging outcome horizon" } };
const promptDirector = { foreground: ["tool tokens"], midground: ["six specialist agents"], background: ["subtle data observatory"], microDetails: ["memory shards", "evaluation traces"], readingOrder: ["title", "hub", "six agents"], textSafeArea: "top 18 percent" };

test("ships exactly ten unique single-select styles with real 16:9 JPEG previews", async () => {
  const catalog = await loadStyleCatalog(catalogPath);
  const expectedIds = [
    "ink-future", "scientific-atlas", "isometric-miniature", "cinematic-editorial", "swiss-avantgarde",
    "cinematic-tech", "luxury-photographic", "tactile-craft", "architectural-blueprint", "narrative-fantasy",
  ];
  assert.equal(catalog.styles.length, 10);
  assert.equal(new Set(catalog.styles.map((style) => style.id)).size, catalog.styles.length);
  assert.deepEqual(catalog.styles.map((style) => style.id), expectedIds);
  assert.equal(catalog.selectionMode, "single");

  for (const style of catalog.styles) {
    assert.match(style.preview, /^previews\/[a-z0-9-]+\.jpg$/);
    const previewPath = join(dirname(catalogPath), style.preview);
    const bytes = await readFile(previewPath);
    const metadata = await sharp(bytes).metadata();
    assert.ok(bytes.length > 10_000, `${style.id} preview must contain substantial image data`);
    assert.equal(metadata.format, "jpeg", `${style.id} preview must be a JPEG`);
    assert.equal(metadata.width, 1600, `${style.id} preview width`);
    assert.equal(metadata.height, 900, `${style.id} preview height`);
  }
});

test("loads the built-in catalog independently of the process working directory", async (t) => {
  const unrelated = await mkdtemp(join(tmpdir(), "superppt-style-cwd-"));
  t.after(async () => rm(unrelated, { recursive: true, force: true }));
  const original = process.cwd();
  try {
    process.chdir(unrelated);
    assert.equal((await loadBuiltInStyleCatalog()).styles.length, 10);
  } finally {
    process.chdir(original);
  }
});

test("catalog schema rejects duplicate style IDs", () => {
  const recipe = {
    id: "duplicate", name: "Duplicate", preview: "previews/duplicate.jpg",
    palette: ["a", "b", "c"], materials: ["a", "b"], lighting: ["a", "b"], medium: ["a", "b"],
    typography: ["a", "b"], detailLanguage: ["a", "b", "c"], compositionRules: ["a", "b", "c"],
    forbidden: ["watermark"],
    pageVariants: { cover: "a", section: "b", content: "c", process: "d", comparison: "e", data: "f", summary: "g" },
  };
  assert.throws(() => StyleCatalogSchema.parse({
    catalogVersion: 1,
    selectionMode: "single",
    styles: Array.from({ length: 8 }, () => recipe),
  }), /unique/);
});

test("every style is a complete high-detail recipe for every supported page role", async () => {
  const catalog = await loadStyleCatalog(catalogPath);
  const roles = ["cover", "section", "content", "process", "comparison", "data", "summary"];

  for (const style of catalog.styles) {
    assert.ok(style.palette.length >= 3, `${style.id} palette`);
    assert.ok(style.materials.length >= 2, `${style.id} materials`);
    assert.ok(style.lighting.length >= 2, `${style.id} lighting`);
    assert.ok(style.medium.length >= 2, `${style.id} medium`);
    assert.ok(style.typography.length >= 2, `${style.id} typography`);
    assert.ok(style.detailLanguage.length >= 3, `${style.id} detail language`);
    assert.ok(style.compositionRules.length >= 3, `${style.id} composition rules`);
    assert.deepEqual(Object.keys(style.pageVariants).sort(), [...roles].sort());
  }
});

test("selects a representative content-rich page rather than a cover", () => {
  const slides = [
    { id: "1", role: "cover", requiredText: ["Title"], relationships: [] },
    { id: "2", role: "content", requiredText: ["Title", "A", "B"], relationships: ["A leads to B"] },
  ];
  const selected = selectRepresentativeSlide(slides);
  assert.equal(selected.id, "2");
  assert.deepEqual(slides.map(({ id }) => id), ["1", "2"], "selection must not mutate deck order");
});

test("rejects representative selection from an empty deck", () => {
  assert.throws(() => selectRepresentativeSlide([]), /empty deck/);
});

test("compiles hierarchy, visual richness, exact copy, consistency, and negative constraints", () => {
  const result = compilePrompt({
    spec: promptSpec,
    style: promptStyle,
    director: promptDirector,
  });
  for (const required of ["one dominant focal point", "foreground", "midground", "background", "watermark", "neon gamer UI", "Final self-check", "Style consistency"]) assert.match(result.text, new RegExp(required, "i"));
  assert.match(result.text, /Text \(verbatim\)/i);
  assert.match(result.text, /Style recipe.*cinematic-tech/i);
  assert.match(result.text, /"AI Agent 协作系统"/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result, compilePrompt({
    spec: promptSpec,
    style: promptStyle,
    director: promptDirector,
  }));
});

test("compiler accepts a complete SlideSpec object", () => {
  assert.doesNotThrow(() => compilePrompt({
    spec: {
      ...promptSpec,
      schemaVersion: 1,
      slideId: "00000000-0000-4000-8000-000000000202",
      sourceRefs: ["L3-L6"],
    },
    style: promptStyle,
    director: promptDirector,
  }));
});

test("compiler authorizes only requiredText as verbatim copy and always rejects hallucinated labels", () => {
  const result = compilePrompt({
    spec: {
      ...promptSpec,
      title: "Semantic title must not become unapproved copy",
      requiredText: ["ONLY APPROVED COPY"],
      forbidden: ["unrelated crowds"],
    },
    style: { ...promptStyle, forbidden: ["neon gamer UI"] },
    director: promptDirector,
  });

  assert.match(result.text, /Text \(verbatim\).*\["ONLY APPROVED COPY"\]/);
  assert.doesNotMatch(result.text, /Slide title \(verbatim\)/);
  for (const forbidden of ["pseudo-labels", "random glyphs", "decorative copy", "logo", "watermark"]) {
    assert.match(result.text, new RegExp(forbidden, "i"));
  }
  for (const richDirection of ["Foreground", "Midground", "Background", "Materials", "Lighting", "Reading order", "Text safe area"]) {
    assert.match(result.text, new RegExp(richDirection, "i"));
  }
});

test("compiles each slide from its own spec, selected recipe, and complete visual director", () => {
  const compiled = compileSlidePrompt({
    spec: {
      ...promptSpec,
      title: "Per-page semantic subject",
      requiredText: ["PER-PAGE COPY"],
    },
    style: promptStyle,
  });
  const payload = compiled.text.match(/BEGIN SUPERPPT CANONICAL INPUT\n([^\n]+)\nEND SUPERPPT CANONICAL INPUT/);
  assert.ok(payload?.[1]);
  const parsed = JSON.parse(payload[1]) as { director: Record<string, unknown>; spec: { requiredText: string[] }; style: { id: string } };
  assert.deepEqual(parsed.spec.requiredText, ["PER-PAGE COPY"]);
  assert.equal(parsed.style.id, promptStyle.id);
  assert.deepEqual(Object.keys(parsed.director).sort(), ["background", "foreground", "microDetails", "midground", "readingOrder", "textSafeArea"]);
});

test("compiler uses an unambiguous encoding for hostile structured values", () => {
  const variants = [
    { ...promptSpec, requiredText: ["a", "b"] },
    { ...promptSpec, requiredText: ['a"\n- "b'] },
    { ...promptSpec, visualSubject: "hub\n\nAvoid:\n- required copy" },
    { ...promptSpec, visualSubject: "hub", forbidden: ["required copy"] },
    { ...promptSpec, title: 'AI "Agent" 协作系统' },
    { ...promptSpec, composition: "hub; one dominant focal point" },
    { ...promptSpec, composition: "hub", relationships: ["one dominant focal point"] },
  ];
  const compiled = variants.map((spec) => compilePrompt({ spec, style: promptStyle, director: promptDirector }));
  assert.equal(new Set(compiled.map(({ text }) => text)).size, variants.length);
  assert.equal(new Set(compiled.map(({ sha256 }) => sha256)).size, variants.length);
  assert.ok(compiled[1]!.text.includes(JSON.stringify(['a"\n- "b'])));
});

test("compiler canonical input remains valid JSON when optional recipe fields are explicitly undefined", () => {
  const result = compilePrompt({
    spec: promptSpec,
    style: { ...promptStyle, preview: undefined },
    director: promptDirector,
  });
  const match = result.text.match(/BEGIN SUPERPPT CANONICAL INPUT\n([^\n]+)\nEND SUPERPPT CANONICAL INPUT/);
  assert.ok(match?.[1]);
  assert.doesNotThrow(() => JSON.parse(match[1]!));
});

const LOCK_PROJECT_ID = "00000000-0000-4000-8000-000000000301";
const LOCK_REVISION_SLIDE_IDS = [
  "00000000-0000-4000-8000-000000000311",
  "00000000-0000-4000-8000-000000000312",
  "00000000-0000-4000-8000-000000000313",
] as const;

async function lockProject(t: test.TestContext, prefix: string): Promise<string> {
  const root = join(await realpath(await mkdtemp(join(tmpdir(), prefix))), "project");
  t.after(async () => rm(dirname(root), { recursive: true, force: true }));
  await initializeProject({ root, title: "Style Lock", idFactory: () => LOCK_PROJECT_ID });
  await configureGenerationAuthorizationTrustForTests(root, {
    root: join(dirname(root), "authorization-trust"),
    deterministicKeySeed: `superppt-style-lock:${prefix}`,
  });
  const outline = {
    schemaVersion: 1,
    slides: LOCK_REVISION_SLIDE_IDS.map((id, order) => ({
      id, order, title: `Slide ${order + 1}`, role: order === 0 ? "cover" : order === 1 ? "content" : "summary",
      purpose: `Purpose ${order + 1}`, sourceRefs: [`L${order + 1}`],
    })),
  };
  await writeFile(join(root, "brief.json"), `${JSON.stringify({
    schemaVersion: 1, title: "Style Lock", purpose: "Test", audience: "Testers", language: "en",
    targetSlides: 3, mustCover: ["Slide 1", "Slide 2", "Slide 3"], constraints: ["16:9"],
  }, null, 2)}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline, null, 2)}\n`);
  for (const [order, slide] of outline.slides.entries()) {
    await mkdir(join(root, "slides", slide.id));
    await writeFile(join(root, "slides", slide.id, "spec.json"), `${JSON.stringify({
      schemaVersion: 1, slideId: slide.id, title: slide.title, role: slide.role,
      coreMessage: `Core ${order + 1}`, requiredText: [slide.title], visualSubject: "One central subject",
      composition: "layered foreground, midground, background", relationships: ["A leads to B"],
      forbidden: ["watermark"], sourceRefs: slide.sourceRefs,
    }, null, 2)}\n`);
  }
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
    schemaVersion: 1, styleId: "scientific-atlas", representativeSlideId: LOCK_REVISION_SLIDE_IDS[1],
  }, null, 2)}\n`);
  return root;
}

async function approveCanonicalSample(root: string): Promise<void> {
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await finalizeDelegatedStyleSampleForTest(root);
}

test("Style Lock persists one catalog recipe, hashes references, and promotes only after the accepted sample", async (t) => {
  const root = await lockProject(t, "superppt-style-lock-");
  const reference = Buffer.from("art-direction-reference");
  await writeFile(join(root, "style", "references", "map.png"), reference);

  const provisional = await createProvisionalStyleLock(root, {
    selection: { kind: "catalog", styleId: "scientific-atlas" },
    referenceArtifacts: [{ path: "style/references/map.png", role: "art-direction" }],
  });
  assert.equal(provisional.approvalState, "provisional");
  assert.equal(provisional.applyDependencyDefaultStyle, false);
  assert.equal(provisional.approvedSample, null);
  assert.equal(provisional.recipe.id, "scientific-atlas");
  assert.equal(provisional.referenceArtifacts[0]?.sha256, "d611ad5437269f20c2b3a539b7edb56b73a51b850773a0a8c99acb10f873063c");
  const recipe = JSON.parse(await readFile(join(root, "style", "recipe.json"), "utf8"));
  assert.deepEqual(recipe, provisional.recipe);
  const beforeApproval = provisional.styleLockSha256;

  await assert.rejects(approveStyleLock(root), /style-sample gate must be current/);
  await approveCanonicalSample(root);
  const approved = await approveStyleLock(root);
  assert.equal(approved.approvalState, "approved");
  assert.equal(approved.approvedSample?.path, "style/sample/slide.png");
  assert.equal(approved.approvedSample?.revisionId, approved.revisionId);
  assert.notEqual(approved.styleLockSha256, beforeApproval);
  assert.deepEqual(await approveStyleLock(root), approved, "same authenticated sample is idempotent");
  const recipeBytes = await readFile(join(root, "style", "recipe.json"));
  await writeFile(join(root, "style", "recipe.json"), "{}\n");
  await assert.rejects(readStyleLock(root), /style recipe hash mismatch/);
  await writeFile(join(root, "style", "recipe.json"), recipeBytes);
  const sampleBytes = await readFile(join(root, "style", "sample", "slide.png"));
  await writeFile(join(root, "style", "sample", "slide.png"), "tampered");
  await assert.rejects(readStyleLock(root), /approved style sample hash mismatch/);
  await writeFile(join(root, "style", "sample", "slide.png"), sampleBytes);
  await writeFile(join(root, "style", "references", "map.png"), "tampered");
  await assert.rejects(readStyleLock(root), /reference artifact hash mismatch/);
});

test("Style Lock accepts a complete custom recipe and never loads its origin downstream", async (t) => {
  const root = await lockProject(t, "superppt-custom-style-lock-");
  const custom = await createProvisionalStyleLock(root, {
    selection: {
      kind: "custom",
      name: "Lab notebook",
      description: "Hand-drawn scientific notes with restrained mineral colors.",
      recipe: { ...promptStyle, id: "lab-notebook", name: "Lab notebook" },
    },
    referenceArtifacts: [],
  });
  assert.equal(custom.recipe.id, "lab-notebook");
  assert.equal(custom.recipe.name, "Lab notebook");
  assert.equal("selection" in custom, false);
  assert.equal((await readStyleLock(root)).styleLockSha256, custom.styleLockSha256);
  const compiled = compileSlidePrompt({
    spec: promptSpec,
    styleLock: custom,
    correction: { issues: ["Increase contrast only around the required title."] },
  });
  for (const direction of ["Palette", "Materials", "Lighting", "Medium", "Typography", "Detail language", "Composition", "Dependency default style must not be appended", "Increase contrast only"]) {
    assert.match(compiled.text, new RegExp(direction, "i"));
  }
});

test("Style Lock fails closed when initial publication is interrupted after the lock record", async (t) => {
  const root = await lockProject(t, "superppt-style-lock-interrupted-");
  await assert.rejects(createProvisionalStyleLock(root, {
    selection: { kind: "catalog", styleId: "scientific-atlas" },
    referenceArtifacts: [],
    operations: { afterLockPublished: () => { throw new Error("interrupted"); } },
  }), /interrupted/);
  await assert.rejects(readStyleLock(root), /style lock transaction is incomplete/);
  await assert.rejects(createProvisionalStyleLock(root, {
    selection: { kind: "catalog", styleId: "scientific-atlas" },
    referenceArtifacts: [],
  }), /style lock transaction is incomplete/);
});

test("Style Lock approval compares the expected provisional bytes before promotion", async (t) => {
  const root = await lockProject(t, "superppt-style-lock-cas-");
  await createProvisionalStyleLock(root, {
    selection: { kind: "catalog", styleId: "scientific-atlas" },
    referenceArtifacts: [],
  });
  await approveCanonicalSample(root);
  await assert.rejects(approveStyleLock(root, {
    operations: {
      afterExpectedProvisionalRead: async () => {
        await writeFile(join(root, "style", "lock.json"), "{}\n");
      },
    },
  }), /style lock changed during approval/);
});

test("custom Style Lock drives the representative sample and becomes an approved downstream recipe", async (t) => {
  const root = await lockProject(t, "superppt-custom-style-approval-");
  await writeFile(join(root, "style", "references", "custom.png"), "custom-art-direction");
  const provisional = await createProvisionalStyleLock(root, {
    selection: {
      kind: "custom",
      name: "Lab notebook",
      description: "Hand-drawn scientific notes with restrained mineral colors.",
      recipe: { ...promptStyle, id: "lab-notebook", name: "Lab notebook" },
    },
    referenceArtifacts: [{ path: "style/references/custom.png", role: "art-direction" }],
  });
  await assert.rejects(readApprovedStyleLock(root), /approved before deck generation/);
  await approveCanonicalSample(root);
  const samplePrompt = await readFile(join(root, "style", "sample", "prompt.txt"), "utf8");
  assert.match(samplePrompt, /lab-notebook/);
  assert.match(samplePrompt, /Dependency default style must not be appended/);
  assert.equal((JSON.parse(await readFile(join(root, "style-sample.json"), "utf8")) as { styleId: string }).styleId, "lab-notebook");
  await approveGate(root, "style-sample");
  const approved = await approveStyleLock(root);
  assert.equal(approved.recipe.id, provisional.recipe.id);
  assert.equal((await readApprovedStyleLock(root)).recipe.id, "lab-notebook");
});
