import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";

import { generateProject, recordManualQa, retryProjectPage, runBatch } from "../src/generation/batch.js";
import { generateSlide } from "../src/generation/provider.js";
import { reviewSlide } from "../src/generation/quality.js";
import { AttemptLedgerSchema, QualityDecisionSchema } from "../src/generation/schemas.js";
import type { ResolvedDependencies } from "../src/dependencies/schemas.js";
import { approveGate, assertGateCurrent } from "../src/planning/confirm.js";
import { publishPlanViews, publishStyleSample } from "../src/planning/views.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject } from "../src/project/store.js";

const runner = join(process.cwd(), "scripts", "run_ai_image_provider.py");
const fakeProvider = join(process.cwd(), "tests", "fixtures", "fake_ai_provider.py");
const fakeReviewer = join(process.cwd(), "tests", "fixtures", "fake_ai_reviewer.py");
const execFileAsync = promisify(execFile);
const SLIDE_IDS = [
  "00000000-0000-4000-8000-000000000711",
  "00000000-0000-4000-8000-000000000712",
  "00000000-0000-4000-8000-000000000713",
] as const;

async function directory(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return realpath(root);
}

async function approvedProject(t: TestContext, prefix: string): Promise<{ root: string; ai: ResolvedDependencies["ai"]; editableRoot: string }> {
  const parent = await directory(t, prefix);
  const root = join(parent, "project");
  await initializeProject({ root, title: "Generation Demo" });
  const outline = {
    schemaVersion: 1,
    slides: SLIDE_IDS.map((id, order) => ({
      id,
      order,
      title: `Slide ${order + 1}`,
      role: order === 0 ? "cover" : order === 1 ? "process" : "summary",
      purpose: `Purpose ${order + 1}`,
      sourceRefs: [`L${order + 1}`],
    })),
  };
  await writeFile(join(root, "brief.json"), `${JSON.stringify({
    schemaVersion: 1,
    title: "Generation Demo",
    purpose: "Test generation",
    audience: "Testers",
    language: "en",
    targetSlides: 3,
    mustCover: ["Slide 1", "Slide 2", "Slide 3"],
    constraints: ["16:9"],
  })}\n`);
  await writeFile(join(root, "outline.json"), `${JSON.stringify(outline)}\n`);
  for (const slide of outline.slides) {
    const slideRoot = join(root, "slides", slide.id);
    await mkdir(slideRoot);
    await writeFile(join(slideRoot, "spec.json"), `${JSON.stringify({
      schemaVersion: 1,
      slideId: slide.id,
      title: slide.title,
      role: slide.role,
      coreMessage: `Core ${slide.order + 1}`,
      requiredText: ["Title"],
      visualSubject: "One central subject",
      composition: "Layered foreground midground background",
      relationships: ["A leads to B"],
      forbidden: ["watermark"],
      sourceRefs: slide.sourceRefs,
    })}\n`);
  }
  await writeFile(join(root, "style", "selection.json"), `${JSON.stringify({
    schemaVersion: 1,
    styleId: "cinematic-tech",
    representativeSlideId: SLIDE_IDS[1],
  })}\n`);
  await writeFile(join(root, "style", "sample", "prompt.txt"), "private compiled visual director prompt\n", { mode: 0o600 });
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#102030" } }).png().toFile(join(root, "style", "sample", "sample.png"));
  await publishPlanViews(root);
  await approveGate(root, "outline");
  await approveGate(root, "slide-specs");
  await publishStyleSample(root);
  await approveGate(root, "style-sample");

  const aiRoot = join(parent, "ai-image-to-ppt");
  await mkdir(join(aiRoot, "scripts"), { recursive: true });
  await mkdir(join(aiRoot, "references"));
  await writeFile(join(aiRoot, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  await writeFile(join(aiRoot, "scripts", "provider.py"), await readFile(fakeProvider));
  await writeFile(join(aiRoot, "scripts", "reviewer.py"), await readFile(fakeReviewer));
  const capabilities = {
    contractVersion: 1,
    defaultProvider: "openai-gpt-image-2",
    providers: [{ id: "openai-gpt-image-2", module: "scripts/provider.py", callable: "gen", outputFormats: ["png"], supportsReferenceImages: true }],
    reviewer: { module: "scripts/reviewer.py", callable: "check" },
  };
  await writeFile(join(aiRoot, "references", "capabilities.json"), JSON.stringify(capabilities));
  const editableRoot = join(parent, "image-to-editable-pptx");
  await mkdir(join(editableRoot, "skills", "image-to-editable-pptx"), { recursive: true });
  await writeFile(join(editableRoot, "package.json"), JSON.stringify({ name: "image-to-editable-pptx", version: "0.1.0" }));
  await writeFile(join(editableRoot, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  await writeFile(join(editableRoot, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  return {
    root,
    editableRoot,
    ai: {
      ...capabilities as ResolvedDependencies["ai"],
      root: aiRoot,
      source: "manifest",
    },
  };
}

test("passes prompts through a 0600 file in a 0700 directory and atomically normalizes output", async (t) => {
  const root = await directory(t, "superppt-provider-");
  const output = join(root, "slide.png");
  const privatePaths: string[] = [];
  const prompt = "private content that must never escape";
  const ledger = await generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    providerId: "manifest-provider",
    slideId: "00000000-0000-4000-8000-000000000701",
    prompt,
    output,
    attempt: 1,
    beforeExecute: async (privatePath) => {
      privatePaths.push(privatePath);
      assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(privatePath, ".."))).mode & 0o777, 0o700);
    },
  });

  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 1080);
  assert.equal(metadata.format, "png");
  assert.equal(isAbsolute(ledger.output!), true);
  assert.equal(AttemptLedgerSchema.parse(ledger).promptPurged, true);
  assert.doesNotMatch(JSON.stringify(ledger), new RegExp(prompt));
  for (const path of privatePaths) await assert.rejects(access(path));
});

test("purges private input and suppresses provider stdout, stderr, and exception text on failure", async (t) => {
  const root = await directory(t, "superppt-provider-failure-");
  const output = join(root, "slide.png");
  const secret = "TOP SECRET PROMPT VALUE";
  let privatePath = "";

  await assert.rejects(generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "noisy_failure",
    providerId: "manifest-provider",
    slideId: "00000000-0000-4000-8000-000000000702",
    prompt: secret,
    output,
    attempt: 1,
    timeoutMs: 2_000,
    beforeExecute: async (path) => { privatePath = path; },
  }), (error: unknown) => {
    assert.doesNotMatch(String(error), new RegExp(secret));
    assert.match(String(error), /provider generation failed/);
    return true;
  });
  await assert.rejects(access(privatePath));
  await assert.rejects(access(output));
});

test("rejects incomplete or unsafe provider images without replacing an existing output", async (t) => {
  const root = await directory(t, "superppt-provider-invalid-");
  const modulePath = join(root, "provider.py");
  const output = join(root, "slide.png");
  const prior = Buffer.from("prior successful bytes");
  await writeFile(output, prior, { mode: 0o600 });
  await writeFile(modulePath, "def gen(prompt, out_path, retries=0):\n open(out_path, 'wb').write(b'not-an-image'); return True\n");

  await assert.rejects(generateSlide({
    runner,
    modulePath,
    callable: "gen",
    providerId: "generic-provider",
    slideId: "00000000-0000-4000-8000-000000000703",
    prompt: "private",
    output,
    attempt: 1,
  }), /provider output is not an allowed complete image/);
  assert.deepEqual(await readFile(output), prior);
  assert.equal((await lstat(output)).isFile(), true);
});

test("anchors output and private directories against replacement races", async (t) => {
  const parent = await directory(t, "superppt-provider-race-");
  const outputRoot = join(parent, "output");
  const movedRoot = join(parent, "moved-output");
  await mkdir(outputRoot, { mode: 0o700 });
  await assert.rejects(generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    prompt: "never redirect me",
    output: join(outputRoot, "slide.png"),
    trustedRoot: outputRoot,
    attempt: 1,
    afterOutputDirectoryOpened: async () => {
      await rename(outputRoot, movedRoot);
      await mkdir(outputRoot, { mode: 0o700 });
    },
  }), /provider generation failed/);
  assert.deepEqual(await readdir(outputRoot), []);

  const secondRoot = join(parent, "second");
  const stolenPrivate = join(parent, "stolen-private");
  const attacker = join(parent, "attacker");
  await mkdir(secondRoot, { mode: 0o700 });
  await mkdir(attacker, { mode: 0o700 });
  await assert.rejects(generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    prompt: "private race content",
    output: join(secondRoot, "slide.png"),
    trustedRoot: secondRoot,
    attempt: 1,
    beforeExecute: async (privatePath) => {
      await rename(join(privatePath, ".."), stolenPrivate);
      await symlink(attacker, join(privatePath, ".."));
    },
  }), /provider generation failed/);
  assert.deepEqual(await readdir(attacker), []);
  assert.equal((await readdir(stolenPrivate)).length, 0);
});

test("executes the already-opened provider module when its path is replaced", async (t) => {
  const root = await directory(t, "superppt-provider-module-race-");
  const modulePath = join(root, "provider.py");
  const original = await readFile(fakeProvider);
  await writeFile(modulePath, original);
  const ledger = await generateSlide({
    runner,
    modulePath,
    callable: "gen",
    prompt: "private",
    output: join(root, "slide.png"),
    attempt: 1,
    afterProviderModuleOpened: async () => {
      await rename(modulePath, join(root, "provider.opened.py"));
      await writeFile(modulePath, "def gen(prompt, out_path, retries=0):\n raise RuntimeError(prompt)\n");
    },
  });
  assert.equal(ledger.outcome, "generated");
});

test("cleans private input after provider timeout and rejects trusted-root escape", async (t) => {
  const root = await directory(t, "superppt-provider-timeout-");
  const modulePath = join(root, "slow.py");
  await writeFile(modulePath, "import time\ndef gen(prompt, out_path, retries=0):\n time.sleep(5); return True\n");
  let privatePath = "";
  await assert.rejects(generateSlide({
    runner,
    modulePath,
    callable: "gen",
    prompt: "timeout secret",
    output: join(root, "slide.png"),
    attempt: 1,
    timeoutMs: 50,
    beforeExecute: async (path) => { privatePath = path; },
  }), /provider generation failed/);
  await assert.rejects(access(privatePath));

  const trusted = join(root, "trusted");
  const outside = join(root, "outside");
  await mkdir(trusted);
  await mkdir(outside);
  await assert.rejects(generateSlide({
    runner,
    modulePath: fakeProvider,
    callable: "gen",
    prompt: "private",
    output: join(outside, "slide.png"),
    trustedRoot: trusted,
    attempt: 1,
  }), /outside the trusted root/);
});

test("uses a private review request and rejects non-exact reviewer JSON", async (t) => {
  const root = await directory(t, "superppt-review-");
  const image = join(root, "slide.png");
  await sharp({ create: { width: 16, height: 9, channels: 3, background: "#123456" } }).png().toFile(image);
  const privatePaths: string[] = [];
  const quality = await reviewSlide({
    runner,
    modulePath: fakeReviewer,
    callable: "check",
    image,
    requiredText: ["Title"],
    styleName: "Manifest Style",
    beforeExecute: async (privatePath) => {
      privatePaths.push(privatePath);
      assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
    },
  });
  assert.equal(QualityDecisionSchema.parse(quality).ok, true);
  await assert.rejects(reviewSlide({
    runner,
    modulePath: fakeReviewer,
    callable: "malformed",
    image,
    requiredText: ["Title"],
    styleName: "Manifest Style",
  }), /reviewer returned invalid quality JSON/);
  for (const path of privatePaths) await assert.rejects(access(path));
});

test("runs only stale or failed pages, isolates page errors, and stops after three attempts", async () => {
  const calls: string[] = [];
  const result = await runBatch({
    pages: [
      { id: "ready", status: "ready", prompt: "A", promptSha256: "a".repeat(64), output: "/unused/ready.png" },
      { id: "stale", status: "stale", prompt: "B", promptSha256: "b".repeat(64), output: "/tmp/stale.png" },
      { id: "isolated", status: "failed", prompt: "C", promptSha256: "c".repeat(64), output: "/tmp/isolated.png" },
    ],
    concurrency: 4,
    generate: async (page, attempt) => {
      calls.push(`${page.id}:${attempt}`);
      if (page.id === "isolated") throw new Error("isolated error");
      return { ok: true, output: page.output };
    },
    review: async (_page, attempt) => ({
      ok: false,
      issues: [`attempt ${attempt}`],
      requiredText: [],
      styleConsistent: false,
      hierarchyClear: false,
      richDetail: false,
      noForbiddenContent: true,
    }),
  });

  assert.deepEqual(calls.filter((call) => call.startsWith("stale")), ["stale:1", "stale:2", "stale:3"]);
  assert.equal(calls.some((call) => call.startsWith("ready")), false);
  assert.equal(calls.filter((call) => call.startsWith("isolated")).length, 3);
  assert.equal(result.pages.find((page) => page.id === "stale")?.status, "failed");
  assert.equal(result.pages.find((page) => page.id === "ready")?.status, "ready");
  assert.equal(result.pages.find((page) => page.id === "isolated")?.status, "failed");
  assert.equal(result.errors.length, 3);
});

test("rejects invalid concurrency before invoking a provider", async () => {
  let called = false;
  await assert.rejects(runBatch({
    pages: [{ id: "page", status: "stale", prompt: "A", promptSha256: "a".repeat(64), output: "/tmp/page.png" }],
    concurrency: 9,
    generate: async () => { called = true; return { ok: true, output: "/tmp/page.png" }; },
    review: async () => ({ ok: true, issues: [], requiredText: [], styleConsistent: true, hierarchyClear: true, richDetail: true, noForbiddenContent: true }),
  }), /concurrency must be between 1 and 8/);
  assert.equal(called, false);
});

test("quality decisions require exact self-consistency", () => {
  assert.throws(() => QualityDecisionSchema.parse({
    ok: true,
    issues: ["missing title"],
    requiredText: [],
    styleConsistent: true,
    hierarchyClear: true,
    richDetail: true,
    noForbiddenContent: true,
  }), /ok must equal/);
});

test("generates a gated project through the manifest-declared provider and retains every accepted ledger", async (t) => {
  const fixture = await approvedProject(t, "superppt-project-generation-");
  const result = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 2 });

  assert.equal(result.providerId, "openai-gpt-image-2");
  assert.equal(result.callCount, 3);
  assert.equal(result.reviewer, "dependency");
  const manifest = await readProject(fixture.root);
  assert.equal(manifest.stage, "generating");
  assert.deepEqual(manifest.slides.map(({ status }) => status), ["ready", "ready", "ready"]);
  assert.equal(await assertGateCurrent(fixture.root, "outline"), true);
  assert.equal(await assertGateCurrent(fixture.root, "slide-specs"), true);
  assert.equal(await assertGateCurrent(fixture.root, "style-sample"), true);
  for (const slide of manifest.slides) {
    const ledgerPath = join(fixture.root, "images", slide.id, "attempt-1", "ledger.json");
    const ledger = AttemptLedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
    assert.equal(ledger.providerId, "openai-gpt-image-2");
    assert.equal(ledger.revisionId, manifest.currentRevision.id);
    assert.equal(ledger.outcome, "accepted");
    assert.doesNotMatch(JSON.stringify(ledger), /private compiled visual director prompt/);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(ledgerPath, ".."))).mode & 0o777, 0o700);
  }
});

test("uses private manual QA when no reviewer exists and retries only one failed stable page", async (t) => {
  const fixture = await approvedProject(t, "superppt-manual-qa-");
  fixture.ai.reviewer = null;
  const generated = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 3 });
  assert.equal(generated.reviewer, "manual");
  assert.deepEqual((await readProject(fixture.root)).slides.map(({ status }) => status), ["generating", "generating", "generating"]);

  const accepted = {
    ok: true,
    issues: [],
    requiredText: [{ text: "Title", present: true, exact: true }],
    styleConsistent: true,
    hierarchyClear: true,
    richDetail: true,
    noForbiddenContent: true,
  };
  const rejected = { ...accepted, ok: false, issues: ["hierarchy needs repair"], hierarchyClear: false };
  const evidenceRoot = join(await directory(t, "superppt-manual-evidence-"), "qa");
  await mkdir(evidenceRoot, { mode: 0o700 });
  for (const [index, slideId] of SLIDE_IDS.entries()) {
    const input = join(evidenceRoot, `${slideId}.json`);
    await writeFile(input, JSON.stringify(index === 0 ? rejected : accepted), { mode: 0o600 });
    await chmod(input, 0o600);
    await recordManualQa({ root: fixture.root, slideId, input });
  }
  const beforeRetry = await readProject(fixture.root);
  assert.deepEqual(beforeRetry.slides.map(({ status }) => status), ["failed", "ready", "ready"]);
  const peerHashes = beforeRetry.slides.slice(1).map(({ image }) => image?.sha256);

  const retried = await retryProjectPage({ root: fixture.root, slideId: SLIDE_IDS[0], ai: fixture.ai, runner });
  assert.equal(retried.callCount, 1);
  const afterRetry = await readProject(fixture.root);
  assert.deepEqual(afterRetry.slides.map(({ status }) => status), ["generating", "ready", "ready"]);
  assert.deepEqual(afterRetry.slides.slice(1).map(({ image }) => image?.sha256), peerHashes);
  await access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-1", "ledger.json"));
  await access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-2", "ledger.json"));
});

test("rejects generation when any of the three planning gates is no longer current", async (t) => {
  const fixture = await approvedProject(t, "superppt-stale-gate-");
  await writeFile(join(fixture.root, "slides", SLIDE_IDS[0], "spec.json"), "{}\n");
  await assert.rejects(
    generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 }),
    /outline, slide-specs, and style-sample gates must be current/,
  );
  assert.equal((await readProject(fixture.root)).slides.length, 0);
});

test("manual QA requires a regular 0600 JSON file and exact reviewer schema", async (t) => {
  const fixture = await approvedProject(t, "superppt-manual-private-");
  fixture.ai.reviewer = null;
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 1 });
  const input = join(await directory(t, "superppt-manual-private-input-"), "qa.json");
  await writeFile(input, JSON.stringify({ ok: true }), { mode: 0o644 });
  await chmod(input, 0o644);
  await assert.rejects(recordManualQa({ root: fixture.root, slideId: SLIDE_IDS[0], input }), /manual QA input must have mode 0600/);
  await chmod(input, 0o600);
  await assert.rejects(recordManualQa({ root: fixture.root, slideId: SLIDE_IDS[0], input }), /manual QA evidence is invalid/);
});

test("recovers an accepted manual ledger after a crash before manifest publication", async (t) => {
  const fixture = await approvedProject(t, "superppt-manual-recovery-");
  fixture.ai.reviewer = null;
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 2 });
  const input = join(await directory(t, "superppt-manual-recovery-input-"), "qa.json");
  await writeFile(input, JSON.stringify({
    ok: true,
    issues: [],
    requiredText: [{ text: "Title", present: true, exact: true }],
    styleConsistent: true,
    hierarchyClear: true,
    richDetail: true,
    noForbiddenContent: true,
  }), { mode: 0o600 });
  await chmod(input, 0o600);
  await assert.rejects(recordManualQa({
    root: fixture.root,
    slideId: SLIDE_IDS[0],
    input,
    afterLedgerWritten: async () => { throw new Error("injected after ledger"); },
  }), /injected after ledger/);
  assert.equal((await readProject(fixture.root)).slides[0]!.status, "generating");

  const resumed = await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 2 });
  assert.equal(resumed.pages.find(({ id }) => id === SLIDE_IDS[0])?.status, "ready");
  assert.equal(resumed.callCount, 2);
  await assert.rejects(access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-2")));
});

test("CLI generate prints its provider disclosure before state-changing results", async (t) => {
  const fixture = await approvedProject(t, "superppt-generation-cli-");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "generate",
    "--project", fixture.root,
    "--concurrency", "2",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: fixture.ai.root,
      SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: fixture.editableRoot,
    },
  });
  assert.equal(stderr, "");
  const documents = stdout.trim().split(/\n(?=\{)/).map((value) => JSON.parse(value) as Record<string, unknown>);
  assert.equal(documents.length, 2);
  assert.deepEqual(documents[0], {
    event: "generation-plan",
    providerId: "openai-gpt-image-2",
    pageCount: 3,
    callCount: 9,
    outputRoot: join(fixture.root, "images"),
    reviewer: "dependency",
  });
  assert.equal(documents[1]!.callCount, 3);
});

test("CLI record-qa and retry-page use manual evidence without regenerating peers", async (t) => {
  const fixture = await approvedProject(t, "superppt-manual-cli-");
  fixture.ai.reviewer = null;
  const capabilitiesPath = join(fixture.ai.root, "references", "capabilities.json");
  const capabilities = JSON.parse(await readFile(capabilitiesPath, "utf8")) as Record<string, unknown>;
  capabilities.reviewer = null;
  await writeFile(capabilitiesPath, JSON.stringify(capabilities));
  await generateProject({ root: fixture.root, ai: fixture.ai, runner, concurrency: 3 });

  const evidenceRoot = await directory(t, "superppt-manual-cli-evidence-");
  const rejectedPath = join(evidenceRoot, "rejected.json");
  await writeFile(rejectedPath, JSON.stringify({
    ok: false,
    issues: ["repair hierarchy"],
    requiredText: [{ text: "Title", present: true, exact: true }],
    styleConsistent: true,
    hierarchyClear: false,
    richDetail: true,
    noForbiddenContent: true,
  }), { mode: 0o600 });
  await chmod(rejectedPath, 0o600);
  const env = {
    ...process.env,
    SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: fixture.ai.root,
    SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: fixture.editableRoot,
  };
  await execFileAsync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "record-qa",
    "--project", fixture.root,
    "--slide", SLIDE_IDS[0],
    "--input", rejectedPath,
  ], { cwd: process.cwd(), env });
  const before = await readProject(fixture.root);
  assert.equal(before.slides[0]!.status, "failed");
  const peerLedger = await readFile(join(fixture.root, "images", SLIDE_IDS[1], "attempt-1", "ledger.json"));

  const retried = await execFileAsync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "retry-page",
    "--project", fixture.root,
    "--slide", SLIDE_IDS[0],
  ], { cwd: process.cwd(), env });
  assert.equal(retried.stderr, "");
  assert.match(retried.stdout, /"pageCount": 1/);
  await access(join(fixture.root, "images", SLIDE_IDS[0], "attempt-2", "ledger.json"));
  assert.deepEqual(await readFile(join(fixture.root, "images", SLIDE_IDS[1], "attempt-1", "ledger.json")), peerLedger);
});
