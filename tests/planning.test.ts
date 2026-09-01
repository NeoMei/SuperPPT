import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";

import { DeckReviewActionEvidenceSchema, DeckReviewDescriptorSchema } from "../src/acceptance/schema.js";
import { GenerationAuthorizationPlanSchema } from "../src/generation/job-schemas.js";
import {
  configureGenerationAuthorizationTrustForTests,
} from "../src/generation/trusted-authorization.js";
import {
  approveExecutionGate,
  approveDeckReviewActionGate,
  approveGate,
  assertGateCurrent,
  previousOrdinaryGate,
  readGateSnapshot,
  toPortableProjectPath,
} from "../src/planning/confirm.js";
import { normalizeInput } from "../src/planning/intake.js";
import { renderBrief, renderOutline, renderSlideSpec } from "../src/planning/render.js";
import { BriefSchema, OutlineSchema, SlideSpecSchema } from "../src/planning/schemas.js";
import { publishPlanViews, publishStyleSample, readPublishedOutlineViews, readPublishedPlanViews, readPublishedStyleSample, recoverPlanViews } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { addDescriptorIntegrity, sha256Evidence } from "../src/project/evidence.js";
import { withProjectLease } from "../src/project/lock.js";
import { readProject, updateProject, writeProject } from "../src/project/store.js";
import { applyRevision, approveImpact, publishImpactPlan } from "../src/revisions/apply.js";
import { authenticateStyleSelection, type StyleSelectionCheckpoint } from "../src/styles/selection.js";
import { StyleSampleSelectionSchema } from "../src/styles/schemas.js";
import { createProvisionalStyleLock } from "../src/styles/style-lock.js";
import { writeCanonicalStyleSample } from "./helpers/style-sample.js";
import { finalizeDelegatedStyleSampleForTest } from "./helpers/delegated-style-sample.js";

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
  const parent = await temporaryParent(t, prefix);
  const root = join(parent, "project");
  await initializeProject({ root, title: "Demo", idFactory: () => PROJECT_ID });
  await configureGenerationAuthorizationTrustForTests(root, {
    root: join(parent, "authorization-trust"),
    deterministicKeySeed: `superppt-planning-test:${prefix}`,
  });
  return root;
}

function projectCliOptions(root: string) {
  return {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPERPPT_AUTHORIZATION_TRUST_ROOT: join(root, "..", "authorization-trust"),
    },
  };
}

async function waitForHandshake<T>(signal: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} handshake timed out`)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function coordinateHandshake(options: {
  signal: Promise<void>;
  label: string;
  work: () => Promise<void>;
  release: () => void;
  contender: Promise<void>;
}): Promise<void> {
  const observed = options.contender.then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  let primary: { error: unknown } | undefined;
  try {
    await waitForHandshake(options.signal, options.label);
    await options.work();
  } catch (error: unknown) {
    primary = { error };
  } finally {
    try {
      options.release();
    } catch (error: unknown) {
      primary ??= { error };
    }
  }

  let settled: Awaited<typeof observed>;
  try {
    settled = await waitForHandshake(observed, `${options.label} contender settlement`);
  } catch (error: unknown) {
    if (primary) throw primary.error;
    throw error;
  }
  if (primary) throw primary.error;
  if (settled.status === "rejected") throw settled.reason;
}

test("handshake coordination settles its contender before preserving signal or work failures", async () => {
  for (const phase of ["signal", "work"] as const) {
    const primary = new Error(`primary ${phase} failure`);
    const secondary = new Error(`secondary contender failure after ${phase}`);
    let rejectContender!: (error: Error) => void;
    let contenderSettled = false;
    let workCalled = false;
    const contender = new Promise<void>((_resolve, reject) => { rejectContender = reject; })
      .finally(() => { contenderSettled = true; });

    await assert.rejects(coordinateHandshake({
      signal: phase === "signal" ? Promise.reject(primary) : Promise.resolve(),
      label: `${phase} failure-path probe`,
      work: async () => {
        workCalled = true;
        if (phase === "work") throw primary;
      },
      release: () => {
        setTimeout(() => rejectContender(secondary), 10);
      },
      contender,
    }), (error: unknown) => {
      assert.equal(error, primary);
      return true;
    });
    assert.equal(contenderSettled, true);
    assert.equal(workCalled, phase === "work");
  }
});

test("handshake coordination observes a contender rejection that precedes its signal", async () => {
  const secondary = new Error("contender rejected before signal");
  let announceSignal!: () => void;
  const signal = new Promise<void>((resolve) => { announceSignal = resolve; });
  const coordinated = coordinateHandshake({
    signal,
    label: "early contender rejection probe",
    work: async () => undefined,
    release: () => undefined,
    contender: Promise.reject(secondary),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  announceSignal();

  await assert.rejects(coordinated, (error: unknown) => {
    assert.equal(error, secondary);
    return true;
  });
});

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
}

async function readyStyleSelection(root: string, legacy = false): Promise<{
  projectRevisionId: string;
  representativeSlideId: string;
  selection: { kind: "catalog"; styleId: "scientific-atlas" };
  referenceArtifacts: [];
}> {
  await writeValidPlan(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  if (legacy) {
    await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
      schemaVersion: 1,
      styleId: "scientific-atlas",
      representativeSlideId: SLIDE_IDS[1],
    }, null, 2)}\n`);
  }
  return {
    projectRevisionId: (await readProject(root)).currentRevision.id,
    representativeSlideId: SLIDE_IDS[1],
    selection: { kind: "catalog", styleId: "scientific-atlas" },
    referenceArtifacts: [],
  };
}

async function approveAll(root: string): Promise<void> {
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await finalizeDelegatedStyleSampleForTest(root);
}

async function approveDownstreamGates(root: string): Promise<{
  authorization: Buffer;
  review: Buffer;
  pptx: Buffer;
  action: Buffer;
}> {
  const authorization = Buffer.from(JSON.stringify({
    styleLockSha256: "a".repeat(64),
    pageIds: SLIDE_IDS,
    callBudget: 3,
    outboundDisclosure: { sendsText: true, references: [] },
    dependency: { kind: "ai-image-to-ppt", sha256: "b".repeat(64) },
    revisionId: (await readProject(root)).currentRevision.id,
  }, null, 2) + "\n");
  await mkdir(join(root, "generation"), { recursive: true });
  await writeFile(join(root, "generation", "authorization-plan.json"), authorization);
  await approveGate(root, "generation-authorization");

  const pptx = Buffer.from("candidate pptx\n");
  const manifest = await readProject(root);
  const generationGate = manifest.gates.at(-1)!;
  const reviewDescriptor = DeckReviewDescriptorSchema.parse(addDescriptorIntegrity({
    schemaVersion: 1,
    kind: "deck-review",
    candidateId: "00000000-0000-4000-8000-000000000099",
    projectId: manifest.projectId,
    projectRevisionId: manifest.currentRevision.id,
    deckRevision: 1,
    candidatePath: "output/candidates/00000000-0000-4000-8000-000000000099",
    candidateMarkerSha256: "e".repeat(64),
    projectBindingSha256: "f".repeat(64),
    generationAuthorization: {
      approvalId: generationGate.approvalId!,
      snapshotPath: generationGate.snapshotPath!,
      snapshotManifestSha256: generationGate.snapshotManifestSha256!,
    },
    artifacts: {
      pptx: { path: "output/candidates/00000000-0000-4000-8000-000000000099/deck.pptx", sha256: sha256Evidence(pptx) },
      acceptance: { path: "output/candidates/00000000-0000-4000-8000-000000000099/acceptance.json", sha256: "a".repeat(64) },
    },
    actions: ["edit-page", "return-upstream", "confirm-delivery"],
    createdAt: new Date().toISOString(),
  }));
  const review = Buffer.from(`${JSON.stringify(reviewDescriptor, null, 2)}\n`);
  const actionBase = {
    schemaVersion: 1 as const,
    kind: "deck-review-action" as const,
    actionId: "00000000-0000-4000-8000-000000000098",
    action: "confirm-delivery" as const,
    candidateId: reviewDescriptor.candidateId,
    projectId: manifest.projectId,
    projectRevisionId: manifest.currentRevision.id,
    reviewDescriptorSha256: reviewDescriptor.descriptorSha256,
    presentedPptxSha256: sha256Evidence(pptx),
    actedAt: new Date().toISOString(),
  };
  const provisionalAction = DeckReviewActionEvidenceSchema.parse({
    ...actionBase,
    actionEvidenceSha256: "0".repeat(64),
  });
  const { actionEvidenceSha256: _placeholder, ...canonicalActionBase } = provisionalAction;
  const action = Buffer.from(`${JSON.stringify(DeckReviewActionEvidenceSchema.parse({
    ...canonicalActionBase,
    actionEvidenceSha256: sha256Evidence(JSON.stringify(canonicalActionBase)),
  }), null, 2)}\n`);
  await mkdir(join(root, "output", "candidates", "current"), { recursive: true });
  await mkdir(join(root, "output", "candidates", reviewDescriptor.candidateId), { recursive: true });
  await writeFile(join(root, "output", "candidates", "current", "review.json"), review);
  await writeFile(join(root, reviewDescriptor.artifacts.pptx.path), pptx);
  await writeFile(join(root, "output", "candidates", "current", "action.json"), action);
  await assert.rejects(approveGate(root, "deck-review"), /action boundary/i);
  await approveDeckReviewActionGate(root);
  return { authorization, review, pptx, action };
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
  assert.deepEqual(manifest.gates.map(({ gate }) => gate), ["outline", "slide-specs", "style-sample-generation", "style-sample"]);
  assert.deepEqual(Object.keys(manifest.gates[0]!.artifactHashes).sort(), ["brief.json", "outline.json"]);
  assert.deepEqual(Object.keys(manifest.gates[1]!.artifactHashes).sort(), ["outline.json", ...SLIDE_IDS.map((id) => `slides/${id}/spec.json`)].sort());
  assert.deepEqual(Object.keys(manifest.gates[3]!.artifactHashes).sort(), [
    "style/sample/director.json",
    "style/sample/ledger.json",
    "style/sample/prompt.txt",
    "style/sample/slide.png",
    "style/selection.json",
  ]);
  assert.equal(await assertGateCurrent(root, "style-sample"), true);
  await assert.rejects(approveGate(root, "revision-impact" as never), /invalid planning gate/);
  await assert.rejects(approveGate(root, "outline", { artifacts: [join(root, "superppt.json")] } as never), /invalid approval options/);
});

test("published style samples expose the user choices before Style Lock approval", async (t) => {
  const root = await project(t, "superppt-style-sample-choices-");
  await writeValidPlan(root);
  await writeValidStyleSample(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await finalizeDelegatedStyleSampleForTest(root);
  const published = await readPublishedStyleSample(root);

  assert.equal(published.descriptor.kind, "style-sample");
  assert.deepEqual(published.nextActions, ["keep-style", "revise-style-recipe", "authorize-new-sample"]);
});

test("generation authorization and deck review extend the ordinary gate chain", async (t) => {
  const root = await project(t, "superppt-extended-gates-");
  const ordinary = [
    "outline",
    "slide-specs",
    "style-sample",
    "generation-authorization",
    "deck-review",
  ] as const;

  assert.deepEqual(ordinary.map((gate) => previousOrdinaryGate[gate]), [
    null,
    "outline",
    "slide-specs",
    "style-sample",
    "generation-authorization",
  ]);
  assert.equal(await assertGateCurrent(root, "generation-authorization"), false);
  assert.equal(await assertGateCurrent(root, "deck-review"), false);
});

test("generation authorization plan schema binds ordered prompts and a sufficient call budget", () => {
  const workflowAi = {
    kind: "ai-image-to-ppt" as const,
    root: "/resolved/ai-image-to-ppt",
    skillFile: "/resolved/ai-image-to-ppt/SKILL.md",
    skillSha256: "a".repeat(64),
    gitRevision: null,
    capabilityManifestFile: "/resolved/ai-image-to-ppt/references/capabilities.json",
    capabilityManifestSha256: "9".repeat(64),
    capabilitySchemaVersion: 1 as const,
    contracts: { generationResult: 1 as const, serialStickyRouterReport: 1 as const, hostImageImport: 1 as const, editableInput: 1 as const },
    routingOrder: [
      { provider: "openai" as const, channel: "host" as const, modelSelection: "host-owned" as const },
      { provider: "openai" as const, channel: "api" as const, defaultModel: "gpt-image-2" as const },
      { provider: "gemini" as const, channel: "host" as const, modelSelection: "host-owned" as const },
      { provider: "gemini" as const, channel: "api" as const, defaultModel: "gemini-3.1-flash-image" as const },
      { provider: "doubao" as const, channel: "host" as const, modelSelection: "host-owned" as const },
      { provider: "doubao" as const, channel: "api" as const, defaultModel: "doubao-seedream-5-0-260128" as const },
    ],
    outputs: {
      normalizedSlide: { format: "image" as const, width: 1920 as const, height: 1080 as const },
      editableInput: { format: "png" as const, width: 1280 as const, height: 720 as const },
    },
    scripts: {
      generationResult: "/resolved/ai-image-to-ppt/scripts/generation_result.py",
      hostRoutingPolicy: "/resolved/ai-image-to-ppt/scripts/host_routing_policy.py",
      importHostImage: "/resolved/ai-image-to-ppt/scripts/import_host_image.py",
      prepareEditableInput: "/resolved/ai-image-to-ppt/scripts/prepare_editable_input.py",
      apiGenerator: "/resolved/ai-image-to-ppt/scripts/gen_slide.py",
      normalizedExport: "/resolved/ai-image-to-ppt/scripts/export_images.py",
    },
    scriptSha256: {
      generationResult: "c".repeat(64),
      hostRoutingPolicy: "d".repeat(64),
      importHostImage: "e".repeat(64),
      prepareEditableInput: "f".repeat(64),
      apiGenerator: "1".repeat(64),
      normalizedExport: "2".repeat(64),
    },
  };
  const plan = {
    contractVersion: 1 as const,
    kind: "deck" as const,
    projectId: PROJECT_ID,
    projectRevisionId: "00000000-0000-4000-8000-000000000301",
    aiSkill: {
      root: "/resolved/ai-image-to-ppt",
      skillSha256: "a".repeat(64),
      gitRevision: null,
      capabilityManifestSha256: "9".repeat(64),
      capabilitySchemaVersion: 1 as const,
      contracts: { generationResult: 1 as const, serialStickyRouterReport: 1 as const, hostImageImport: 1 as const, editableInput: 1 as const },
      routingOrder: [
        { provider: "openai" as const, channel: "host" as const, modelSelection: "host-owned" as const },
        { provider: "openai" as const, channel: "api" as const, defaultModel: "gpt-image-2" as const },
        { provider: "gemini" as const, channel: "host" as const, modelSelection: "host-owned" as const },
        { provider: "gemini" as const, channel: "api" as const, defaultModel: "gemini-3.1-flash-image" },
        { provider: "doubao" as const, channel: "host" as const, modelSelection: "host-owned" as const },
        { provider: "doubao" as const, channel: "api" as const, defaultModel: "doubao-seedream-5-0-260128" },
      ],
      outputs: {
        normalizedSlide: { format: "image" as const, width: 1920 as const, height: 1080 as const },
        editableInput: { format: "png" as const, width: 1280 as const, height: 720 as const },
      },
      scripts: {
        generationResult: { path: "/resolved/ai-image-to-ppt/scripts/generation_result.py", sha256: "c".repeat(64) },
        hostRoutingPolicy: { path: "/resolved/ai-image-to-ppt/scripts/host_routing_policy.py", sha256: "d".repeat(64) },
        importHostImage: { path: "/resolved/ai-image-to-ppt/scripts/import_host_image.py", sha256: "e".repeat(64) },
        prepareEditableInput: { path: "/resolved/ai-image-to-ppt/scripts/prepare_editable_input.py", sha256: "f".repeat(64) },
        apiGenerator: { path: "/resolved/ai-image-to-ppt/scripts/gen_slide.py", sha256: "1".repeat(64) },
        normalizedExport: { path: "/resolved/ai-image-to-ppt/scripts/export_images.py", sha256: "2".repeat(64) },
      },
      workflowPreflight: {
        bindingVersion: 2 as const,
        contractFile: "/resolved/SuperPPT/references/dependencies.json",
        contractSha256: "3".repeat(64),
        ai: workflowAi,
        editable: {
          kind: "image-to-editable-pptx" as const,
          root: "/resolved/image-to-editable-pptx",
          packageFile: "/resolved/image-to-editable-pptx/package.json",
          packageSha256: "4".repeat(64),
          pluginFile: "/resolved/image-to-editable-pptx/.codex-plugin/plugin.json",
          pluginSha256: "5".repeat(64),
          skillFile: "/resolved/image-to-editable-pptx/skills/image-to-editable-pptx/SKILL.md",
          skillSha256: "6".repeat(64),
          cliFile: "/resolved/image-to-editable-pptx/src/cli.ts",
          cliSha256: "7".repeat(64),
          sourceTree: {
            root: "/resolved/image-to-editable-pptx/src",
            sha256: "8".repeat(64),
            fileCount: 10,
            totalBytes: 1000,
          },
          version: "0.2.0",
          packageName: "image-to-editable-pptx" as const,
          nodeEngine: ">=22.6" as const,
          cliScript: "tsx src/cli.ts" as const,
          pluginName: "image-to-editable-pptx" as const,
          pluginSkills: "./skills/" as const,
          invocation: {
            command: "npm" as const,
            script: "cli" as const,
            separator: "--" as const,
            subcommand: "run" as const,
            inputFlag: "--image" as const,
            outputFlag: "--out" as const,
          },
          outputContract: {
            ownershipMarker: {
              path: ".image-to-editable-pptx-output.json" as const,
              markerVersion: 1 as const,
              appId: "image-to-editable-pptx" as const,
              artifactKind: "published-output" as const,
            },
            manifest: { path: "manifest.json" as const, version: 2 as const },
            ledger: { path: "run-ledger.json" as const, version: 2 as const },
            officialDonor: "slide-editable.pptx" as const,
            objectNames: {
              background: "asset-background" as const,
              text: "text-<id>" as const,
              shape: "shape-<id>-<label>" as const,
              asset: "asset-<id>" as const,
            },
          },
        },
        host: { source: "agent-host" as const, localFilesystem: true as const, localFileLinks: true as const },
        attestationSha256: "a".repeat(64),
      },
    },
    styleLockPath: "style/lock.json" as const,
    styleLockSha256: "b".repeat(64),
    callBudget: 3,
    outboundDisclosure: { sendsText: true as const, references: [] },
    pages: SLIDE_IDS.map((slideId, order) => ({
      slideId,
      order,
      promptSha256: String(order + 1).repeat(64),
    })),
    previousAuthorizationDigest: null,
    previousPromptSha256: null,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  assert.doesNotThrow(() => GenerationAuthorizationPlanSchema.parse(plan));
  assert.throws(
    () => GenerationAuthorizationPlanSchema.parse({ ...plan, callBudget: 2 }),
    /budget.*page count|page count.*budget/i,
  );
  assert.throws(
    () => GenerationAuthorizationPlanSchema.parse({ ...plan, pages: [...plan.pages].reverse() }),
    /order/i,
  );
  assert.throws(
    () => GenerationAuthorizationPlanSchema.parse({ ...plan, extra: true }),
    /unrecognized/i,
  );
  assert.throws(
    () => GenerationAuthorizationPlanSchema.parse({
      ...plan,
      aiSkill: { ...plan.aiSkill, scripts: { ...plan.aiSkill.scripts, generationResult: undefined } },
    }),
    /generationResult|required/i,
  );
});

test("generation authorization and deck review snapshots bind their published artifacts", async (t) => {
  const root = await project(t, "superppt-generation-review-artifacts-");
  await writeValidPlan(root);
  await writeValidStyleSample(root);
  await approveAll(root);

  const { authorization, review, action } = await approveDownstreamGates(root);
  assert.equal(await assertGateCurrent(root, "generation-authorization"), true);
  assert.equal(await assertGateCurrent(root, "deck-review"), true);

  const generationSnapshot = await readGateSnapshot(root, "generation-authorization");
  const reviewSnapshot = await readGateSnapshot(root, "deck-review");
  assert.deepEqual(generationSnapshot.artifacts, { "generation/authorization-plan.json": authorization });
  assert.deepEqual(reviewSnapshot.artifacts, {
    "output/candidates/current/action.json": action,
    "output/candidates/current/review.json": review,
  });
});

test("sample execution authorization records its evidence without becoming a content approval", async (t) => {
  const root = await project(t, "superppt-sample-execution-authorization-");
  const evidencePath = "style/sample/generation-plan.json";
  await writeFile(join(root, evidencePath), "{\"schemaVersion\":1}\n");

  await approveExecutionGate(root, "style-sample-generation", evidencePath);

  const manifest = await readProject(root);
  assert.deepEqual(manifest.gates.map(({ gate }) => gate), ["style-sample-generation"]);
  assert.equal(manifest.gates[0]!.presentation, undefined);
  assert.match(manifest.gates[0]!.snapshotPath ?? "", /^revisions\/[0-9a-f-]{36}\/execution-gates\/style-sample-generation-[0-9a-f-]{36}$/);
  assert.match(manifest.gates[0]!.snapshotManifestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(await assertGateCurrent(root, "style-sample"), false);
});

test("sample execution authorization fails closed after its current evidence is tampered", async (t) => {
  const root = await project(t, "superppt-sample-execution-tamper-");
  await writeValidPlan(root);
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await writeFile(join(root, "style", "sample", "generation-plan.json"), "{\"schemaVersion\":1}\n");
  await approveExecutionGate(root, "style-sample-generation", "style/sample/generation-plan.json");
  await writeFile(join(root, "style", "sample", "generation-plan.json"), "tampered\n");

  const plan = await publishImpactPlan(root, { kind: "brief", title: "Tampered execution evidence" });
  await assert.rejects(approveImpact(root, plan.sha256), /execution.*evidence|planning gate evidence/i);
});

test("revision changes invalidate downstream gates while preserving upstream history", async (t) => {
  const root = await project(t, "superppt-downstream-gates-");
  await writeValidPlan(root);
  await writeValidStyleSample(root);
  await approveAll(root);
  await approveDownstreamGates(root);
  assert.equal(await assertGateCurrent(root, "generation-authorization"), true);
  assert.equal(await assertGateCurrent(root, "deck-review"), true);
  const priorGates = (await readProject(root)).gates.map(({ gate }) => gate);

  const plan = await publishImpactPlan(root, { kind: "brief", title: "Revised demo" });
  await approveImpact(root, plan.sha256);
  await applyRevision(root, plan, plan.change);

  const revised = await readProject(root);
  assert.deepEqual(revised.gates.slice(0, priorGates.length).map(({ gate }) => gate), priorGates);
  assert.equal(revised.currentRevision.number, 2);
  assert.equal(await assertGateCurrent(root, "outline"), false);
  assert.equal(await assertGateCurrent(root, "style-sample"), false);
  assert.equal(await assertGateCurrent(root, "generation-authorization"), false);
  assert.equal(await assertGateCurrent(root, "deck-review"), false);
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
  await writeCanonicalStyleSample(styleRoot);
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
  await writeCanonicalStyleSample(root);

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
  await writeFile(join(root, "style", "sample", "slide.png"), await sharp({
    create: { width: 800, height: 800, channels: 3, background: "#102030" },
  }).png().toBuffer());
  await assert.rejects(publishStyleSample(root), /exact 1920x1080 PNG/);

  await writeFile(join(root, "style", "sample", "slide.png"), Buffer.from("not a png"));
  await assert.rejects(publishStyleSample(root));

  const complete = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: "#102030" },
  }).png().toBuffer();
  const truncated = complete.subarray(0, complete.length - 64);
  assert.equal((await sharp(truncated).metadata()).format, "png", "regression fixture must retain a valid PNG header");
  await writeFile(join(root, "style", "sample", "slide.png"), truncated);
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

test("state lease contender tolerates promotion after statting the old manifest before opening it", async (t) => {
  const root = await project(t, "superppt-state-lease-pre-open-promotion-");
  let announceStat!: () => void;
  const pathStatted = new Promise<void>((resolve) => { announceStat = resolve; });
  let releaseOpen!: () => void;
  const openReleased = new Promise<void>((resolve) => { releaseOpen = resolve; });
  let actionCalled = false;

  const contender = withProjectLease(root, "state", async () => {
    actionCalled = true;
  }, {
    manifestRead: {
      afterPathStat: async () => {
        announceStat();
        await openReleased;
      },
    },
  });
  await coordinateHandshake({
    signal: pathStatted,
    label: "manifest path stat",
    work: async () => {
      await updateProject(root, (manifest) => ({ ...manifest, title: "Promoted before contender opened manifest" }));
    },
    release: releaseOpen,
    contender,
  });
  assert.equal(actionCalled, true);
  assert.equal((await readProject(root)).title, "Promoted before contender opened manifest");
});

test("state lease contender tolerates pre-open promotion without O_NOFOLLOW", async (t) => {
  const root = await project(t, "superppt-state-lease-win32-pre-open-promotion-");
  let announceStat!: () => void;
  const pathStatted = new Promise<void>((resolve) => { announceStat = resolve; });
  let releaseOpen!: () => void;
  const openReleased = new Promise<void>((resolve) => { releaseOpen = resolve; });
  let actionCalled = false;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const contender = withProjectLease(root, "state", async () => {
      actionCalled = true;
    }, {
      manifestRead: {
        afterPathStat: async () => {
          announceStat();
          await openReleased;
        },
      },
    });
    await coordinateHandshake({
      signal: pathStatted,
      label: "win32 manifest path stat",
      work: async () => {
        await updateProject(root, (manifest) => ({ ...manifest, title: "Promoted without O_NOFOLLOW" }));
      },
      release: releaseOpen,
      contender,
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  assert.equal(actionCalled, true);
  assert.equal((await readProject(root)).title, "Promoted without O_NOFOLLOW");
});

test("lease snapshot rejects a symlink swapped in after statting the manifest", async (t) => {
  const root = await project(t, "superppt-state-lease-pre-open-symlink-");
  const manifestPath = join(root, "superppt.json");
  const external = join(await temporaryParent(t, "superppt-state-lease-external-manifest-"), "manifest.json");
  await writeFile(external, await readFile(manifestPath));
  let actionCalled = false;

  await assert.rejects(withProjectLease(root, "state", async () => {
    actionCalled = true;
  }, {
    manifestRead: {
      afterPathStat: async () => {
        await unlink(manifestPath);
        await symlink(external, manifestPath);
      },
    },
  }), /not owned/i);
  assert.equal(actionCalled, false);
  await assert.rejects(readdir(join(root, ".superppt-leases")), { code: "ENOENT" });
});

test("lease snapshot without O_NOFOLLOW rejects a symlink before reading its target", async (t) => {
  const root = await project(t, "superppt-state-lease-win32-pre-open-symlink-");
  const manifestPath = join(root, "superppt.json");
  const external = join(await temporaryParent(t, "superppt-state-lease-win32-external-manifest-"), "manifest.json");
  await writeFile(external, await readFile(manifestPath));
  let contentReadStarted = false;
  let actionCalled = false;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await assert.rejects(withProjectLease(root, "state", async () => {
      actionCalled = true;
    }, {
      manifestRead: {
        afterPathStat: async () => {
          await unlink(manifestPath);
          await symlink(external, manifestPath);
        },
        afterOpen: async () => { contentReadStarted = true; },
      },
    }), /not owned/i);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  assert.equal(contentReadStarted, false);
  assert.equal(actionCalled, false);
  await assert.rejects(readdir(join(root, ".superppt-leases")), { code: "ENOENT" });
});

test("lease snapshot bounds repeated pre-open promotions before reading content", async (t) => {
  const root = await project(t, "superppt-state-lease-win32-bounded-promotions-");
  const manifestPath = join(root, "superppt.json");
  const original = await readFile(manifestPath, "utf8");
  const replacements = await Promise.all(Array.from({ length: 3 }, async (_unused, index) => {
    const replacement = join(root, `manifest-promotion-${index}.json`);
    await writeFile(replacement, original.replace('"title": "Demo"', `"title": "Promotion ${index}"`));
    return replacement;
  }));
  let promotions = 0;
  let contentReadStarted = false;
  let actionCalled = false;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await assert.rejects(withProjectLease(root, "state", async () => {
      actionCalled = true;
    }, {
      manifestRead: {
        afterPathStat: async () => {
          await rename(replacements[promotions]!, manifestPath);
          promotions += 1;
        },
        afterOpen: async () => { contentReadStarted = true; },
      },
    }), /not owned|changed while reading/i);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  assert.equal(promotions, 3);
  assert.equal(contentReadStarted, false);
  assert.equal(actionCalled, false);
  await assert.rejects(readdir(join(root, ".superppt-leases")), { code: "ENOENT" });
});

test("state lease contender tolerates promotion after opening the old manifest before its first stat", async (t) => {
  const root = await project(t, "superppt-state-lease-pre-stat-promotion-");
  let announceOpened!: () => void;
  const fileOpened = new Promise<void>((resolve) => { announceOpened = resolve; });
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  let actionCalled = false;

  const contender = withProjectLease(root, "state", async () => {
    actionCalled = true;
  }, {
    manifestRead: {
      afterFileOpen: async () => {
        announceOpened();
        await readReleased;
      },
    },
  });
  await coordinateHandshake({
    signal: fileOpened,
    label: "manifest file open",
    work: async () => {
      await updateProject(root, (manifest) => ({ ...manifest, title: "Promoted while contender held old fd" }));
    },
    release: releaseRead,
    contender,
  });
  assert.equal(actionCalled, true);
  assert.equal((await readProject(root)).title, "Promoted while contender held old fd");
});

test("lease authentication rejects an in-place manifest rewrite before publishing lease evidence", async (t) => {
  const root = await project(t, "superppt-state-lease-in-place-");
  const manifestPath = join(root, "superppt.json");
  const original = await readFile(manifestPath, "utf8");
  const changed = original.replace('"title": "Demo"', '"title": "Damo"');
  assert.equal(changed.length, original.length);
  const fixedTimestamp = new Date("2024-01-01T00:00:00.000Z");
  await utimes(manifestPath, fixedTimestamp, fixedTimestamp);
  let actionCalled = false;

  await assert.rejects(withProjectLease(root, "state", async () => {
    actionCalled = true;
  }, {
    manifestRead: {
      afterOpen: async () => {
        const beforeRewrite = await stat(manifestPath, { bigint: true });
        await writeFile(manifestPath, changed);
        await utimes(manifestPath, fixedTimestamp, fixedTimestamp);
        const afterRewrite = await stat(manifestPath, { bigint: true });
        assert.equal(afterRewrite.ino, beforeRewrite.ino);
        assert.equal(afterRewrite.size, beforeRewrite.size);
        assert.equal(afterRewrite.mtimeNs, beforeRewrite.mtimeNs);
        assert.notEqual(afterRewrite.ctimeNs, beforeRewrite.ctimeNs);
      },
    },
  }), /not owned|changed while reading/i);
  assert.equal(actionCalled, false);
  await assert.rejects(readdir(join(root, ".superppt-leases")), { code: "ENOENT" });
});

test("state lease reauthenticates the current manifest after a mutated old inode is detached", async (t) => {
  const root = await project(t, "superppt-state-lease-detached-rewrite-");
  const manifestPath = join(root, "superppt.json");
  const replacementPath = join(root, "invalid-manifest.json");
  const original = await readFile(manifestPath, "utf8");
  const changed = original.replace('"title": "Demo"', '"title": "Damo"');
  assert.equal(changed.length, original.length);
  const fixedTimestamp = new Date("2024-01-01T00:00:00.000Z");
  await utimes(manifestPath, fixedTimestamp, fixedTimestamp);
  await writeFile(replacementPath, "{}\n");
  let actionCalled = false;

  await assert.rejects(withProjectLease(root, "state", async () => {
    actionCalled = true;
  }, {
    manifestRead: {
      afterOpen: async () => {
        await writeFile(manifestPath, changed);
        await utimes(manifestPath, fixedTimestamp, fixedTimestamp);
        await rename(replacementPath, manifestPath);
      },
    },
  }), /not owned/i);
  assert.equal(actionCalled, false);
  const stateEvidence = await readdir(join(root, ".superppt-leases", "state"));
  assert.equal(stateEvidence.length, 1);
  assert.match(stateEvidence[0]!, /\.failed\.json$/);
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
  await finalizeDelegatedStyleSampleForTest(root, { publish: false, approveGate: false });
  await assert.rejects(approveGate(root, "style-sample"), /authoritative style sample publication is required/);
  await finalizeDelegatedStyleSampleForTest(root);
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
  await execFileAsync(process.execPath, [...invocation, "ingest", "--project", root, "--text", source], projectCliOptions(root));
  assert.equal(await readFile(join(root, "source", "original.md"), "utf8"), source);
  const validated = await execFileAsync(process.execPath, [...invocation, "validate-plan", "--project", root], projectCliOptions(root));
  assert.equal(validated.stderr, "");
  assert.equal((JSON.parse(validated.stdout) as { slideCount: number }).slideCount, 3);
  await execFileAsync(process.execPath, [...invocation, "approve", "--project", root, "--gate", "outline"], projectCliOptions(root));
  assert.equal(await assertGateCurrent(root, "outline"), true);
  await assert.rejects(execFileAsync(process.execPath, [...invocation, "approve", "--project", root, "--gate", "outline", "--artifacts", "[\"superppt.json\"]"], projectCliOptions(root)), /unknown CLI flag/);
  await assert.rejects(execFileAsync(process.execPath, [...invocation, "validate-plan", "--project", "relative"], projectCliOptions(root)), /Unsafe project root/);
});

test("style-selection CLI authenticates one choice, representative slide, and project revision before sample authorization", async (t) => {
  const root = await project(t, "superppt-style-selection-cli-");
  await writeValidPlan(root);
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const run = (args: string[]) => execFileAsync(process.execPath, [...invocation, ...args], projectCliOptions(root));
  await run(["validate-plan", "--project", root]);
  await run(["approve", "--project", root, "--gate", "outline"]);
  await run(["approve", "--project", root, "--gate", "slide-specs"]);
  const revisionId = (await readProject(root)).currentRevision.id;
  const input = join(root, "selected-style.json");
  await writeFile(input, `${JSON.stringify({
    projectRevisionId: revisionId,
    representativeSlideId: SLIDE_IDS[1],
    selection: { kind: "catalog", styleId: "scientific-atlas" },
    referenceArtifacts: [],
  }, null, 2)}\n`);
  await chmod(input, 0o600);
  const selected = JSON.parse((await run(["style-selection", "--project", root, "--input", input])).stdout);
  assert.equal(selected.stage, "style-selection");
  assert.equal(selected.projectRevisionId, revisionId);
  assert.equal(selected.representativeSlideId, SLIDE_IDS[1]);
  assert.equal(selected.styleId, "scientific-atlas");
  assert.equal((await readProject(root)).stage, "style-selection");

  const stale = join(root, "stale-style.json");
  await writeFile(stale, `${JSON.stringify({
    projectRevisionId: "00000000-0000-4000-8000-000000000999",
    representativeSlideId: SLIDE_IDS[1],
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [],
  })}\n`);
  await chmod(stale, 0o600);
  await assert.rejects(run(["style-selection", "--project", root, "--input", stale]), /stale|project revision/i);
});

test("public style-selection migrates matching v1 and exact CLI retry repairs the stage without rewriting evidence", async (t) => {
  const root = await project(t, "superppt-style-selection-migrate-");
  const request = await readyStyleSelection(root, true);
  const first = await authenticateStyleSelection(root, request);
  const selectionPath = join(root, "style", "selection.json");
  const lockPath = join(root, "style", "lock.json");
  const recipePath = join(root, "style", "recipe.json");
  const selection = StyleSampleSelectionSchema.parse(JSON.parse(await readFile(selectionPath, "utf8")));
  assert.equal(selection.schemaVersion, 2);
  assert.equal(selection.projectRevisionId, request.projectRevisionId);
  assert.equal(selection.representativeSlideId, request.representativeSlideId);
  const before = await Promise.all([selectionPath, lockPath, recipePath].map((path) => readFile(path)));

  await updateProject(root, (manifest) => ({ ...manifest, stage: "slide-specs" }));
  const input = join(root, "retry-style.json");
  await writeFile(input, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const retried = JSON.parse((await execFileAsync(
    process.execPath,
    [...invocation, "style-selection", "--project", root, "--input", input],
    projectCliOptions(root),
  )).stdout);
  assert.deepEqual(retried, first);
  assert.equal((await readProject(root)).stage, "style-selection");
  const after = await Promise.all([selectionPath, lockPath, recipePath].map((path) => readFile(path)));
  assert.deepEqual(after, before, "exact retry must not rewrite authenticated evidence");
});

test("public style-selection conflicts fail closed with selection, lock, recipe, and manifest byte-exact", async (t) => {
  const root = await project(t, "superppt-style-selection-conflict-");
  const request = await readyStyleSelection(root, true);
  await authenticateStyleSelection(root, request);
  const paths = [
    join(root, "style", "selection.json"),
    join(root, "style", "lock.json"),
    join(root, "style", "recipe.json"),
    join(root, "superppt.json"),
  ];
  const before = await Promise.all(paths.map((path) => readFile(path)));
  const conflicts = [
    { ...request, representativeSlideId: SLIDE_IDS[0] },
    { ...request, selection: { kind: "catalog" as const, styleId: "cinematic-tech" } },
    { ...request, projectRevisionId: "00000000-0000-4000-8000-000000000999" },
  ];
  for (const conflict of conflicts) {
    await assert.rejects(authenticateStyleSelection(root, conflict), /stale|conflict|selection|lock|representative/i);
    assert.deepEqual(
      await Promise.all(paths.map((path) => readFile(path))),
      before,
      "rejected evidence must remain byte-exact",
    );
  }

  const legacyRoot = await project(t, "superppt-style-selection-v1-conflict-");
  const legacyRequest = await readyStyleSelection(legacyRoot, true);
  const legacyPaths = [join(legacyRoot, "style", "selection.json"), join(legacyRoot, "superppt.json")];
  const legacyBefore = await Promise.all(legacyPaths.map((path) => readFile(path)));
  await assert.rejects(authenticateStyleSelection(legacyRoot, {
    ...legacyRequest,
    selection: { kind: "catalog", styleId: "cinematic-tech" },
  }), /conflict|selection/i);
  assert.deepEqual(await Promise.all(legacyPaths.map((path) => readFile(path))), legacyBefore);
  assert.deepEqual((await readdir(join(legacyRoot, "style"))).sort(), ["references", "sample", "selection.json"]);

  const lockRoot = await project(t, "superppt-style-selection-lock-conflict-");
  const lockRequest = await readyStyleSelection(lockRoot);
  await createProvisionalStyleLock(lockRoot, {
    selection: { kind: "catalog", styleId: "cinematic-tech" },
    referenceArtifacts: [],
  });
  const lockPaths = [join(lockRoot, "style", "lock.json"), join(lockRoot, "style", "recipe.json"), join(lockRoot, "superppt.json")];
  const lockBefore = await Promise.all(lockPaths.map((path) => readFile(path)));
  await assert.rejects(authenticateStyleSelection(lockRoot, lockRequest), /lock|replace|selection/i);
  assert.deepEqual(await Promise.all(lockPaths.map((path) => readFile(path))), lockBefore);
  assert.equal((await readdir(join(lockRoot, "style"))).includes("selection.json"), false);
});

test("public style-selection exactly recovers all durable publication checkpoints", async (t) => {
  for (const checkpoint of ["lock-written", "selection-written", "manifest-before-update"] as const) {
    await t.test(checkpoint, async (t) => {
      const root = await project(t, `superppt-style-selection-${checkpoint}-`);
      const request = await readyStyleSelection(root, checkpoint !== "lock-written");
      let interrupted = false;
      await assert.rejects(authenticateStyleSelection(root, request, {
        checkpoint: (step) => {
          if (!interrupted && step === checkpoint) {
            interrupted = true;
            throw new Error(`injected ${checkpoint}`);
          }
        },
      }), new RegExp(`injected ${checkpoint}`));
      const durablePaths = checkpoint === "lock-written"
        ? [join(root, "style", "lock.json")]
        : [join(root, "style", "lock.json"), join(root, "style", "recipe.json"), join(root, "style", "selection.json")];
      const interruptedBytes = await Promise.all(durablePaths.map((path) => readFile(path)));
      const recovered = await authenticateStyleSelection(root, request);
      assert.equal(recovered.projectRevisionId, request.projectRevisionId);
      assert.equal((await readProject(root)).stage, "style-selection");
      const selection = StyleSampleSelectionSchema.parse(JSON.parse(
        await readFile(join(root, "style", "selection.json"), "utf8"),
      ));
      assert.equal(selection.schemaVersion, 2);
      assert.equal(selection.styleLockSha256, recovered.styleLockSha256);
      assert.deepEqual(
        await Promise.all(durablePaths.map((path) => readFile(path))),
        interruptedBytes,
        "recovery must reuse every already-durable exact byte",
      );
    });
  }
});

test("a revision change during style-selection leaves recoverable evidence for the next current revision", async (t) => {
  const root = await project(t, "superppt-style-selection-revision-race-");
  const request = await readyStyleSelection(root, true);
  let revised = false;
  await assert.rejects(authenticateStyleSelection(root, request, {
    checkpoint: async (step: StyleSelectionCheckpoint) => {
      if (step !== "manifest-before-update" || revised) return;
      revised = true;
      const plan = await publishImpactPlan(root, { kind: "brief", title: "Revision raced style selection" });
      await approveImpact(root, plan.sha256);
      await applyRevision(root, plan, plan.change);
    },
  }), /stale|revision/i);

  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  const next = {
    ...request,
    projectRevisionId: (await readProject(root)).currentRevision.id,
    selection: { kind: "catalog" as const, styleId: "cinematic-tech" },
  };
  const authenticated = await authenticateStyleSelection(root, next);
  assert.equal(authenticated.projectRevisionId, next.projectRevisionId);
  assert.equal(authenticated.styleId, "cinematic-tech");
  assert.equal((await readProject(root)).stage, "style-selection");
});

test("CLI publishes and approves the outline before any slide specs exist", async (t) => {
  const root = await project(t, "superppt-outline-stage-cli-");
  await writeFile(join(root, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline, null, 2)}\n`);
  const invocation = ["--import", "tsx", "src/cli.ts"];
  const run = (args: string[]) => execFileAsync(process.execPath, [...invocation, ...args], projectCliOptions(root));

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
  const run = (args: string[]) => execFileAsync(process.execPath, [...invocation, ...args], projectCliOptions(root));

  await run(["validate-plan", "--project", root]);
  await run(["approve", "--project", root, "--gate", "outline"]);
  await run(["approve", "--project", root, "--gate", "slide-specs"]);
  await finalizeDelegatedStyleSampleForTest(root, { publish: false, approveGate: false });
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
    "style/sample/slide.png",
    "style/selection.json",
  ]);
  assert.equal((await readProject(root)).gates.some(({ gate }) => gate === "style-sample"), false);

  await writeFile(join(root, "style", "sample", "prompt.txt"), "stale replacement\n");
  await assert.rejects(
    run(["approve", "--project", root, "--gate", "style-sample"]),
    /canonical style sample prompt/,
  );
  await finalizeDelegatedStyleSampleForTest(root, { publish: false, approveGate: false });
  await run(["publish-style-sample", "--project", root]);
  await run(["approve", "--project", root, "--gate", "style-sample"]);
  assert.equal(await assertGateCurrent(root, "style-sample"), true);
});
