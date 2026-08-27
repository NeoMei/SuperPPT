import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  convertProjectPage,
  prepareConversionInput,
  runEditableConversion,
} from "../src/editable/adapter.js";
import {
  applyEditPlan,
  applyProjectEditPlan,
  prepareReplacementAssets,
  UnsupportedEditableTargetError,
  validateModifiedRevision,
} from "../src/editable/operations.js";
import {
  EditableManifestSchema,
  RunLedgerV2Schema,
} from "../src/editable/schemas.js";
import { initializeProject } from "../src/project/initialize.js";
import { sha256 as projectSha256, updateProject } from "../src/project/store.js";

const execFileAsync = promisify(execFile);
const fixtureRoot = resolve("tests/fixtures/editable");
const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

async function temporary(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function converterRoot(t: TestContext): Promise<string> {
  const root = join(await temporary(t, "superppt-editable-plugin-"), "plugin");
  await mkdir(join(root, "skills", "image-to-editable-pptx"), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "image-to-editable-pptx",
    version: "0.1.0",
    engines: { node: ">=22.6" },
    scripts: { cli: "tsx src/cli.ts" },
  })}\n`);
  await writeFile(join(root, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  return root;
}

async function png(width: number, height: number, alpha = false): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 18, g: 42, b: 65, alpha: 0 } : "#122a41",
    },
  }).png().toBuffer();
}

async function writeFakeConverterOutput(outDir: string, sourcePng: string): Promise<void> {
  await mkdir(join(outDir, "assets"), { recursive: true });
  const manifest = await readFile(join(fixtureRoot, "manifest.json"));
  const background = await readFile(join(fixtureRoot, "clean-background.png"));
  const icon = await readFile(join(fixtureRoot, "assets", "icon.png"));
  const files = {
    "ocr.json": Buffer.from('{"lines":[]}\n'),
    "vision.json": Buffer.from('{"elements":[]}\n'),
    "analysis-ledger.json": Buffer.from('{"analysis":"fixture"}\n'),
    "manifest.json": manifest,
    "removal-mask.png": await png(1280, 720, true),
    "clean-background.png": background,
    "assets/icon.png": icon,
    "fixture-editable.pptx": Buffer.from("fixture-pptx"),
  } as const;
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(outDir, name), bytes);
  }
  const output = (name: string) => join(outDir, name);
  const ledger = {
    ledgerVersion: 2,
    mode: "replay",
    recorded: false,
    models: { ocr: "qwen3.5-ocr", vision: "qwen3-vl-plus" },
    durationsMs: { ocr: 0, vision: 0, analyze: 0, plan: 0, repair: 0, export: 0, total: 0 },
    taskIds: {},
    warnings: [],
    decisions: [
      {
        candidateId: "text-title",
        kind: "text",
        decision: "accepted",
        bbox: { x: 120, y: 88, width: 680, height: 92 },
        sourceElementIndexes: [0],
        repairMethod: "local_nearest_surface",
        extraction: "none",
        output: { state: "editable_layer", manifestElementId: "ocr-title" },
      },
      {
        candidateId: "icon-candidate",
        kind: "icon",
        decision: "accepted",
        bbox: { x: 920, y: 260, width: 120, height: 120 },
        sourceElementIndexes: [1],
        repairMethod: "local_nearest_surface",
        extraction: "transparent",
        output: { state: "editable_layer", manifestElementId: "icon-1", assetPath: "assets/icon.png" },
      },
    ],
    hashes: {
      sourceImage: sha256(await readFile(sourcePng)),
      ocr: sha256(files["ocr.json"]),
      vision: sha256(files["vision.json"]),
      analysisLedger: sha256(files["analysis-ledger.json"]),
      manifest: sha256(files["manifest.json"]),
      removalMask: sha256(files["removal-mask.png"]),
      cleanBackground: sha256(files["clean-background.png"]),
      assets: { "assets/icon.png": sha256(files["assets/icon.png"]) },
      pptx: sha256(files["fixture-editable.pptx"]),
    },
    outputs: {
      directory: outDir,
      ocr: output("ocr.json"),
      vision: output("vision.json"),
      analysisLedger: output("analysis-ledger.json"),
      manifest: output("manifest.json"),
      removalMask: output("removal-mask.png"),
      cleanBackground: output("clean-background.png"),
      assets: output("assets"),
      pptx: output("fixture-editable.pptx"),
    },
  };
  RunLedgerV2Schema.parse(ledger);
  await writeFile(join(outDir, "run-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(join(outDir, ".image-to-editable-pptx-output.json"), `${JSON.stringify({
    markerVersion: 1,
    appId: "image-to-editable-pptx",
    artifactKind: "published-output",
  }, null, 2)}\n`);
}

async function makeConverterOutputTextOnly(outDir: string): Promise<void> {
  const manifestPath = join(outDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.elements = manifest.elements.filter((element: { kind: string }) => element.kind === "text");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  const ledgerPath = join(outDir, "run-ledger.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.hashes.manifest = sha256(manifestBytes);
  ledger.hashes.assets = {};
  ledger.decisions = ledger.decisions.filter((decision: { kind: string }) => decision.kind === "text");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

async function replacementStaging(t: TestContext): Promise<{
  root: string;
  projectId: string;
  slideId: string;
  revisionId: string;
  parentRevisionId: string;
}> {
  const base = await realpath(await temporary(t, "superppt-editable-staging-"));
  const projectId = "00000000-0000-4000-8000-000000000001";
  const slideId = "00000000-0000-4000-8000-000000000002";
  const revisionId = "00000000-0000-4000-8000-000000000003";
  const parentRevisionId = "00000000-0000-4000-8000-000000000004";
  const slideRoot = join(base, slideId);
  const stagingName = `.staging-${revisionId}-00000000-0000-4000-8000-000000000005`;
  const root = join(slideRoot, stagingName);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".superppt-editable-staging.json"), `${JSON.stringify({
    stagingMarkerVersion: 1,
    appId: "superppt",
    artifactKind: "editable-slide-staging",
    projectId,
    slideId,
    revisionId,
    parentRevisionId,
    stagingName,
  })}\n`);
  return { root, projectId, slideId, revisionId, parentRevisionId };
}

test("normalizes generated pages to the converter's exact 1280x720 PNG contract", async (t) => {
  const root = await temporary(t, "superppt-editable-input-");
  const source = join(root, "source.jpg");
  const target = join(root, "source-1280x720.png");
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#223344" } }).jpeg().toFile(source);
  await prepareConversionInput(source, target);
  const metadata = await sharp(target).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.format], [1280, 720, "png"]);
});

test("refuses a linked or pre-existing conversion input target", async (t) => {
  const root = await temporary(t, "superppt-editable-input-target-");
  const source = join(root, "source.png");
  const sentinel = join(root, "sentinel.png");
  const target = join(root, "target.png");
  const before = await png(16, 16);
  await writeFile(source, await png(1920, 1080));
  await writeFile(sentinel, before);
  await symlink(sentinel, target);
  await assert.rejects(prepareConversionInput(source, target), /fresh regular non-symlink path/);
  assert.deepEqual(await readFile(sentinel), before);
});

test("runs the injected npm CLI without putting credentials in command arguments", async (t) => {
  const root = await temporary(t, "superppt-editable-run-");
  const sourcePng = join(root, "source.png");
  const outDir = join(root, "output");
  await writeFile(sourcePng, await png(1280, 720));
  const plugin = await converterRoot(t);
  let invoked = false;
  const result = await runEditableConversion({
    converterRoot: plugin,
    sourcePng,
    outDir,
    execute: async (command, args, options) => {
      invoked = true;
      assert.equal(command, "npm");
      assert.deepEqual(args, ["run", "cli", "--", "run", "--image", sourcePng, "--out", outDir]);
      assert.equal(options.cwd, await realpath(plugin));
      assert.doesNotMatch([command, ...args].join(" "), /secret-value/);
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(invoked, true);
  assert.equal(result.manifest.elements.length, 2);
  assert.equal(result.ledger.ledgerVersion, 2);
  assert.equal(result.artifactHashes.sourceImage, sha256(await readFile(sourcePng)));
});

test("validates converter package, Node version, and exact source before execution", async (t) => {
  const root = await temporary(t, "superppt-editable-preflight-");
  const sourcePng = join(root, "source.png");
  const outDir = join(root, "output");
  const plugin = await converterRoot(t);
  await writeFile(sourcePng, await png(1279, 720));
  let calls = 0;
  const execute = async () => { calls += 1; return { stdout: "", stderr: "" }; };
  await assert.rejects(runEditableConversion({ converterRoot: plugin, sourcePng, outDir, execute }), /exact 1280x720 PNG/);
  await writeFile(sourcePng, await png(1280, 720));
  await assert.rejects(runEditableConversion({ converterRoot: plugin, sourcePng, outDir, execute, nodeVersion: "22.5.9" }), /Node\.js 22\.6/);
  await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "lookalike", version: "0.1.0", engines: { node: ">=22.6" }, scripts: { cli: "x" } }));
  await assert.rejects(runEditableConversion({ converterRoot: plugin, sourcePng, outDir, execute }), /converter package/);
  assert.equal(calls, 0);
});

test("fully decodes PNG source pixels before invoking the converter", async (t) => {
  const root = await temporary(t, "superppt-editable-truncated-");
  const plugin = await converterRoot(t);
  const sourcePng = join(root, "source.png");
  const full = await png(1280, 720);
  const truncated = full.subarray(0, 64);
  assert.deepEqual([(await sharp(truncated).metadata()).width, (await sharp(truncated).metadata()).height], [1280, 720]);
  await writeFile(sourcePng, truncated);
  let calls = 0;
  await assert.rejects(runEditableConversion({
    converterRoot: plugin,
    sourcePng,
    outDir: join(root, "output"),
    execute: async () => { calls += 1; },
  }), /valid PNG|decode/);
  assert.equal(calls, 0);
});

test("authenticates ownership, the source, manifest, background, assets, and every ledger output", async (t) => {
  const root = await temporary(t, "superppt-editable-auth-");
  const plugin = await converterRoot(t);
  const sourcePng = join(root, "source.png");
  await writeFile(sourcePng, await png(1280, 720));
  for (const tamper of ["manifest.json", "clean-background.png", "assets/icon.png", "ocr.json", "fixture-editable.pptx"] as const) {
    const outDir = join(root, `output-${tamper.replaceAll("/", "-")}`);
    await assert.rejects(runEditableConversion({
      converterRoot: plugin,
      sourcePng,
      outDir,
      execute: async () => {
        await mkdir(outDir);
        await writeFakeConverterOutput(outDir, sourcePng);
        await writeFile(join(outDir, tamper), "tampered");
        return { stdout: "", stderr: "" };
      },
    }), /hash mismatch|valid PNG|manifest/);
  }
});

test("requires a one-to-one accepted ledger decision for every editable manifest element", async (t) => {
  const root = await temporary(t, "superppt-editable-decisions-");
  const plugin = await converterRoot(t);
  const sourcePng = join(root, "source.png");
  await writeFile(sourcePng, await png(1280, 720));
  const scenarios = [
    (ledger: { decisions: Array<Record<string, unknown>> }) => { ledger.decisions = []; },
    (ledger: { decisions: Array<Record<string, unknown>> }) => {
      ledger.decisions[0] = { ...ledger.decisions[0], bbox: { x: 121, y: 88, width: 680, height: 92 } };
    },
    (ledger: { decisions: Array<Record<string, unknown>> }) => {
      ledger.decisions.push({
        candidateId: "forged-extra",
        kind: "text",
        decision: "accepted",
        bbox: { x: 10, y: 10, width: 100, height: 40 },
        sourceElementIndexes: [2],
        repairMethod: "local_nearest_surface",
        extraction: "none",
        output: { state: "editable_layer", manifestElementId: "ghost-text" },
      });
    },
  ];
  for (const [index, mutate] of scenarios.entries()) {
    const outDir = join(root, `output-${index}`);
    await assert.rejects(runEditableConversion({
      converterRoot: plugin,
      sourcePng,
      outDir,
      execute: async () => {
        await mkdir(outDir);
        await writeFakeConverterOutput(outDir, sourcePng);
        const ledgerPath = join(outDir, "run-ledger.json");
        const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
        mutate(ledger);
        await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
        return { stdout: "", stderr: "" };
      },
    }), /ledger decision/);
  }
});

test("rejects symlinked ownership and asset files plus rectangular or escaping assets", async (t) => {
  const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
  assert.throws(() => EditableManifestSchema.parse({
    ...manifest,
    elements: [{ ...manifest.elements[1], extraction: "rectangular" }],
  }), /transparent/);
  assert.throws(() => EditableManifestSchema.parse({
    ...manifest,
    elements: [{ ...manifest.elements[1], assetPath: "../outside.png" }],
  }), /project-relative/);
  assert.throws(() => EditableManifestSchema.parse({
    ...manifest,
    elements: [{
      kind: "shape",
      id: "unsafe-shape",
      label: "must stay in background",
      shape: "rect",
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      fillColor: "FFFFFF",
      strokeColor: "000000",
      strokeWidthPx: 1,
      cornerRadiusPx: 0,
      zIndex: 1,
    }],
  }), /shape|Invalid/);

  const root = await temporary(t, "superppt-editable-symlink-");
  const plugin = await converterRoot(t);
  const sourcePng = join(root, "source.png");
  const outDir = join(root, "output");
  await writeFile(sourcePng, await png(1280, 720));
  await assert.rejects(runEditableConversion({
    converterRoot: plugin,
    sourcePng,
    outDir,
    execute: async () => {
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      const marker = join(outDir, ".image-to-editable-pptx-output.json");
      await rm(marker);
      await symlink(join(outDir, "manifest.json"), marker);
      return { stdout: "", stderr: "" };
    },
  }), /regular non-symlink|ownership/);
});

test("rejects a symlink hidden in a referenced asset path", async (t) => {
  const root = await temporary(t, "superppt-editable-nested-symlink-");
  const plugin = await converterRoot(t);
  const sourcePng = join(root, "source.png");
  const outDir = join(root, "output");
  await writeFile(sourcePng, await png(1280, 720));
  await assert.rejects(runEditableConversion({
    converterRoot: plugin,
    sourcePng,
    outDir,
    execute: async () => {
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      const outside = join(root, "outside");
      await mkdir(outside);
      const icon = await readFile(join(outDir, "assets", "icon.png"));
      await writeFile(join(outside, "icon.png"), icon);
      await symlink(outside, join(outDir, "assets", "nested"));
      const manifestPath = join(outDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.elements.find((element: { id: string }) => element.id === "icon-1").assetPath = "assets/nested/icon.png";
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(manifestPath, manifestBytes);
      const ledgerPath = join(outDir, "run-ledger.json");
      const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
      ledger.hashes.manifest = sha256(manifestBytes);
      ledger.hashes.assets = { "assets/nested/icon.png": sha256(icon) };
      ledger.decisions.find((decision: { kind: string }) => decision.kind === "icon").output.assetPath = "assets/nested/icon.png";
      await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      return { stdout: "", stderr: "" };
    },
  }), /symlink|outside converter output/);
});

test("replaces actual text and moves only actual transparent assets", async () => {
  const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
  const changed = applyEditPlan(manifest, { route: "editable", operations: [
    { kind: "replace-text", elementId: "ocr-title", text: "新的标题" },
    { kind: "move-asset", elementId: "icon-1", bbox: { x: 900, y: 300, width: 120, height: 120 } },
  ] });
  const title = changed.elements.find((element) => element.id === "ocr-title");
  assert.equal(title?.kind, "text");
  assert.equal(title?.kind === "text" ? title.text : undefined, "新的标题");
  assert.equal(changed.elements.find((element) => element.id === "icon-1")?.bbox.x, 900);
});

test("routes missing, background-only, and mismatched targets to regeneration", async () => {
  const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
  for (const plan of [
    { route: "editable", operations: [{ kind: "replace-text", elementId: "background-label", text: "X" }] },
    { route: "editable", operations: [{ kind: "move-asset", elementId: "ocr-title", bbox: { x: 1, y: 1, width: 10, height: 10 } }] },
    { route: "regenerate", reason: "uncertain graphic remains in the background" },
  ]) {
    assert.throws(() => applyEditPlan(manifest, plan), UnsupportedEditableTargetError);
  }
});

test("copies replacement assets into an owned revision and never returns the user path", async (t) => {
  const root = await temporary(t, "superppt-editable-replacement-");
  const revision = (await replacementStaging(t)).root;
  const original = join(root, "private-user-file.png");
  await writeFile(original, await png(32, 32, true));
  const prepared = await prepareReplacementAssets({ route: "editable", operations: [{
    kind: "replace-asset",
    elementId: "icon-1",
    assetPath: original,
  }] }, revision);
  assert.equal(prepared.route, "editable");
  if (prepared.route !== "editable") return;
  const replacement = prepared.operations[0];
  assert.equal(replacement?.kind, "replace-asset");
  if (replacement?.kind !== "replace-asset") return;
  assert.match(replacement.assetPath, /^assets\/replacements\/[a-f0-9-]+\.png$/);
  assert.doesNotMatch(JSON.stringify(prepared), /private-user-file/);
  const copied = join(revision, ...replacement.assetPath.split("/"));
  assert.equal((await lstat(copied)).isSymbolicLink(), false);
  assert.equal(sha256(await readFile(copied)), sha256(await readFile(original)));
});

test("rejects symlinked, opaque, and unowned replacement assets", async (t) => {
  const root = await temporary(t, "superppt-editable-replacement-unsafe-");
  const revision = join(root, "revision");
  await mkdir(revision);
  const opaque = join(root, "opaque.png");
  const alias = join(root, "alias.png");
  await writeFile(opaque, await png(20, 20));
  await symlink(opaque, alias);
  const plan = (assetPath: string) => ({ route: "editable", operations: [{ kind: "replace-asset", elementId: "icon-1", assetPath }] });
  await assert.rejects(prepareReplacementAssets(plan(opaque), revision), /owned editable staging/);
  const staging = (await replacementStaging(t)).root;
  await assert.rejects(prepareReplacementAssets(plan(alias), staging), /regular non-symlink transparent PNG/);
  await assert.rejects(prepareReplacementAssets(plan(opaque), staging), /regular non-symlink transparent PNG/);
});

test("caps replacement PNG input before reading or decoding it", async (t) => {
  const root = await temporary(t, "superppt-editable-replacement-size-");
  const revision = (await replacementStaging(t)).root;
  for (const [name, size] of [["empty.png", 0], ["oversize.png", 64 * 1024 * 1024 + 1]] as const) {
    const path = join(root, name);
    await writeFile(path, "");
    await truncate(path, size);
    await assert.rejects(prepareReplacementAssets({ route: "editable", operations: [{ kind: "replace-asset", elementId: "icon-1", assetPath: path }] }, revision), /replacement asset size limit/);
  }
});

test("replacement preparation rejects sealed revisions and symlink-ancestor staging aliases", async (t) => {
  const root = await realpath(await temporary(t, "superppt-editable-staging-boundary-"));
  const privateAsset = join(root, "private.png");
  await writeFile(privateAsset, await png(12, 12, true));
  const plan = { route: "editable", operations: [{ kind: "replace-asset", elementId: "icon-1", assetPath: privateAsset }] };

  const revisionId = "00000000-0000-4000-8000-000000000013";
  const sealed = join(root, revisionId);
  await mkdir(sealed);
  await writeFile(join(sealed, ".superppt-editable-revision.json"), `${JSON.stringify({
    markerVersion: 1,
    appId: "superppt",
    artifactKind: "editable-slide-revision",
    projectId: "00000000-0000-4000-8000-000000000011",
    slideId: "00000000-0000-4000-8000-000000000012",
    revisionId,
    revisionKind: "conversion",
  })}\n`);
  await assert.rejects(prepareReplacementAssets(plan, sealed), /owned editable staging/);

  const staging = await replacementStaging(t);
  const aliasParent = join(root, "alias-parent");
  await symlink(join(staging.root, ".."), aliasParent);
  await assert.rejects(
    prepareReplacementAssets(plan, join(aliasParent, staging.root.split("/").at(-1)!)),
    /canonical|owned editable staging/,
  );
});

async function readyProject(t: TestContext): Promise<{ root: string; slideId: string }> {
  const parent = await realpath(await temporary(t, "superppt-editable-project-"));
  const root = join(parent, "project");
  const slideId = "00000000-0000-4000-8000-000000000102";
  await initializeProject({
    root,
    title: "Editable fixture",
    idFactory: () => "00000000-0000-4000-8000-000000000101",
  });
  const render = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#23384d" } }).png().toBuffer();
  await writeFile(join(root, "images", `${slideId}.png`), render);
  await updateProject(root, (manifest) => ({
    ...manifest,
    stage: "generating",
    slides: [{
      id: slideId,
      order: 0,
      title: "Editable page",
      role: "content",
      specRevisionId: manifest.currentRevision.id,
      promptRevisionId: manifest.currentRevision.id,
      styleRevisionId: manifest.currentRevision.id,
      status: "ready",
      image: null,
      editable: null,
      finalRender: {
        path: `images/${slideId}.png`,
        sha256: projectSha256(render),
        revisionId: manifest.currentRevision.id,
      },
      staleReasons: [],
    }],
  }));
  return { root, slideId };
}

test("creates fresh durable conversion revisions without changing the previous converter output", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const execute = async (_command: string, args: string[]) => {
    const sourcePng = args[args.indexOf("--image") + 1]!;
    const outDir = args[args.indexOf("--out") + 1]!;
    await mkdir(outDir);
    await writeFakeConverterOutput(outDir, sourcePng);
    return { stdout: "", stderr: "" };
  };
  const first = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute,
    idFactory: () => "00000000-0000-4000-8000-000000000103",
  });
  const before = await readFile(first.manifestPath);
  const second = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute,
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });
  assert.match(first.revisionRoot, /editable\/00000000-0000-4000-8000-000000000102\/00000000-0000-4000-8000-000000000103$/);
  assert.notEqual(first.revisionRoot, second.revisionRoot);
  assert.deepEqual(await readFile(first.manifestPath), before);
  assert.deepEqual([(await sharp(join(first.revisionRoot, "source-1280x720.png")).metadata()).width, (await sharp(join(first.revisionRoot, "source-1280x720.png")).metadata()).height], [1280, 720]);
  assert.equal((await lstat(join(first.revisionRoot, ".superppt-editable-revision.json"))).isSymbolicLink(), false);
  const record = JSON.parse(await readFile(first.conversionRecord, "utf8"));
  assert.equal(record.projectRevisionId, (await readFile(join(project.root, "superppt.json"), "utf8").then(JSON.parse)).currentRevision.id);
  assert.equal(record.finalRender.path, `images/${project.slideId}.png`);
});

test("rechecks the project render after conversion before publishing SuperPPT ownership", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const revisionId = "00000000-0000-4000-8000-000000000113";
  await assert.rejects(convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      await writeFile(join(project.root, "images", `${project.slideId}.png`), await png(1920, 1080));
      return { stdout: "", stderr: "" };
    },
    idFactory: () => revisionId,
  }), /project revision or final render changed during editable conversion/);
  await assert.rejects(lstat(join(project.root, "editable", project.slideId, revisionId, ".superppt-editable-revision.json")), { code: "ENOENT" });
});

test("applies edits into a new immutable revision and preserves the authenticated converter revision", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
    idFactory: () => "00000000-0000-4000-8000-000000000105",
  });
  const sourceManifest = await readFile(source.manifestPath);
  const replacement = join(await temporary(t, "superppt-editable-user-"), "user-private.png");
  await writeFile(replacement, await png(48, 48, true));
  const changed = await applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [
      { kind: "replace-text", elementId: "ocr-title", text: "修改后标题" },
      { kind: "replace-asset", elementId: "icon-1", assetPath: replacement },
    ] },
    idFactory: () => "00000000-0000-4000-8000-000000000106",
  });
  const modifiedText = await readFile(changed.modifiedManifestPath, "utf8");
  const modified = JSON.parse(modifiedText);
  assert.equal(modified.modifiedManifestVersion, 1);
  assert.equal(modified.manifest.elements.find((element: { id: string }) => element.id === "ocr-title").text, "修改后标题");
  assert.doesNotMatch(modifiedText, /user-private/);
  assert.deepEqual(await readFile(source.manifestPath), sourceManifest);
  assert.equal((await lstat(changed.modifiedManifestPath)).isSymbolicLink(), false);
  assert.equal((await sharp(join(changed.revisionRoot, "clean-background.png")).metadata()).format, "png");
  await assert.rejects(lstat(join(changed.revisionRoot, ".superppt-editable-staging.json")), { code: "ENOENT" });
  assert.equal((await lstat(join(changed.revisionRoot, ".superppt-editable-revision.json"))).isFile(), true);
  const validated = await validateModifiedRevision(changed.revisionRoot);
  assert.equal(validated.record.revisionId, changed.revisionId);
  assert.equal(validated.record.parentRevisionId, source.revisionId);
  assert.equal(validated.record.sourceRevisionId, source.revisionId);
  assert.deepEqual(
    Object.keys(validated.record.artifacts.assets).sort(),
    ["assets/icon.png", modified.manifest.elements.find((element: { id: string }) => element.id === "icon-1").assetPath].sort(),
  );
});

test("modified revision validation detects manifest, background, and asset tampering after publication", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  const replacement = join(await temporary(t, "superppt-editable-validator-user-"), "replacement.png");
  await writeFile(replacement, await png(24, 24, true));
  const changed = await applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-asset", elementId: "icon-1", assetPath: replacement }] },
  });
  const modified = JSON.parse(await readFile(changed.modifiedManifestPath, "utf8"));
  const replacementPath = modified.manifest.elements.find((element: { id: string }) => element.id === "icon-1").assetPath as string;
  for (const path of [
    changed.modifiedManifestPath,
    join(changed.revisionRoot, "clean-background.png"),
    join(changed.revisionRoot, ...replacementPath.split("/")),
  ]) {
    const before = await readFile(path);
    await writeFile(path, "tampered");
    await assert.rejects(validateModifiedRevision(changed.revisionRoot), /modified revision|hash mismatch|invalid/);
    await writeFile(path, before);
    await validateModifiedRevision(changed.revisionRoot);
  }
});

test("prevalidates every edit target before staging and cleans owned staging after later failures", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  const slideRoot = join(project.root, "editable", project.slideId);
  const privateAsset = join(await temporary(t, "superppt-editable-cleanup-user-"), "private.png");
  await writeFile(privateAsset, await png(24, 24, true));
  const before = (await readdir(slideRoot)).sort();
  await assert.rejects(applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-asset", elementId: "background-only", assetPath: privateAsset }] },
  }), UnsupportedEditableTargetError);
  assert.deepEqual((await readdir(slideRoot)).sort(), before);

  const opaque = join(await temporary(t, "superppt-editable-cleanup-opaque-"), "opaque.png");
  await writeFile(opaque, await png(24, 24));
  await assert.rejects(applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [
      { kind: "replace-asset", elementId: "icon-1", assetPath: privateAsset },
      { kind: "replace-asset", elementId: "icon-1", assetPath: opaque },
    ] },
  }), /transparent PNG/);
  assert.deepEqual((await readdir(slideRoot)).sort(), before);
  assert.equal((await readdir(slideRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("rejects source asset replacement between validation and copy and removes staging", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  const slideRoot = join(project.root, "editable", project.slideId);
  const before = (await readdir(slideRoot)).sort();
  type ProbeOptions = Parameters<typeof applyProjectEditPlan>[0] & {
    operations: { afterSourceValidation: () => Promise<void> };
  };
  const applyWithProbe = applyProjectEditPlan as unknown as (options: ProbeOptions) => ReturnType<typeof applyProjectEditPlan>;
  await assert.rejects(applyWithProbe({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "changed" }] },
    operations: {
      afterSourceValidation: async () => writeFile(join(source.revisionRoot, "assets", "icon.png"), "tampered"),
    },
  }), /source editable artifact hash changed before copy/);
  assert.deepEqual((await readdir(slideRoot)).sort(), before);
});

test("validates the sealed revision before promotion and removes failed sealed staging", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  const slideRoot = join(project.root, "editable", project.slideId);
  const revisionId = "00000000-0000-4000-8000-000000000188";
  const before = (await readdir(slideRoot)).sort();
  await assert.rejects(applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "never publish" }] },
    idFactory: () => revisionId,
    operations: {
      beforeSealValidation: async (staging) => writeFile(join(staging, "modified-manifest.json"), "tampered"),
    },
  }), /modified manifest.*invalid|hash mismatch/);
  assert.deepEqual((await readdir(slideRoot)).sort(), before);
  await assert.rejects(lstat(join(slideRoot, revisionId)), { code: "ENOENT" });
  assert.equal((await readdir(slideRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("rejects an editable symlink ancestor before staging or copying private bytes", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  const privateAsset = join(await temporary(t, "superppt-editable-symlink-user-"), "private.png");
  const privateBytes = await png(24, 24, true);
  await writeFile(privateAsset, privateBytes);
  const editable = join(project.root, "editable");
  const outside = join(await temporary(t, "superppt-editable-symlink-outside-"), "editable-store");
  await rename(editable, outside);
  await symlink(outside, editable);
  const before = (await readdir(join(outside, project.slideId))).sort();

  await assert.rejects(applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-asset", elementId: "icon-1", assetPath: privateAsset }] },
  }), /editable.*unsafe|canonical|symlink/i);

  assert.deepEqual((await readdir(join(outside, project.slideId))).sort(), before);
  assert.equal((await readdir(join(outside, project.slideId))).some((name) => name.startsWith(".staging-")), false);
});

test("cleans private replacement bytes when durable revision marker writing fails", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  const slideRoot = join(project.root, "editable", project.slideId);
  const before = (await readdir(slideRoot)).sort();
  const privateAsset = join(await temporary(t, "superppt-editable-marker-failure-user-"), "private.png");
  await writeFile(privateAsset, await png(24, 24, true));
  const revisionId = "00000000-0000-4000-8000-000000000189";

  await assert.rejects(applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-asset", elementId: "icon-1", assetPath: privateAsset }] },
    idFactory: () => revisionId,
    operations: {
      duringRevisionMarkerWrite: async () => { throw new Error("marker write probe"); },
    },
  }), /marker write probe/);

  assert.deepEqual((await readdir(slideRoot)).sort(), before);
  await assert.rejects(lstat(join(slideRoot, revisionId)), { code: "ENOENT" });
  assert.equal((await readdir(slideRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("uses the staging identity to clean private bytes after revision marker corruption", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  const slideRoot = join(project.root, "editable", project.slideId);
  const before = (await readdir(slideRoot)).sort();
  const privateAsset = join(await temporary(t, "superppt-editable-marker-corrupt-user-"), "private.png");
  await writeFile(privateAsset, await png(24, 24, true));
  const revisionId = "00000000-0000-4000-8000-000000000190";

  await assert.rejects(applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-asset", elementId: "icon-1", assetPath: privateAsset }] },
    idFactory: () => revisionId,
    operations: {
      afterRevisionMarkerWrite: async (_staging: string, markerPath: string) => writeFile(markerPath, "{"),
    },
  }), /modified revision marker.*invalid|unsafe or invalid/);

  assert.deepEqual((await readdir(slideRoot)).sort(), before);
  await assert.rejects(lstat(join(slideRoot, revisionId)), { code: "ENOENT" });
  assert.equal((await readdir(slideRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("publishes text-only modified revisions with an owned empty assets directory", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      await makeConverterOutputTextOnly(outDir);
      return { stdout: "", stderr: "" };
    },
    idFactory: () => "00000000-0000-4000-8000-000000000114",
  });
  const changed = await applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "Text only" }] },
    idFactory: () => "00000000-0000-4000-8000-000000000115",
  });
  assert.equal((await lstat(join(changed.revisionRoot, "assets"))).isDirectory(), true);
});

test("rejects apply-edit after the bound source render becomes stale", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const source = await convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async (_command, args) => {
      const sourcePng = args[args.indexOf("--image") + 1]!;
      const outDir = args[args.indexOf("--out") + 1]!;
      await mkdir(outDir);
      await writeFakeConverterOutput(outDir, sourcePng);
      return { stdout: "", stderr: "" };
    },
  });
  await writeFile(join(project.root, "images", `${project.slideId}.png`), await png(1920, 1080));
  await assert.rejects(applyProjectEditPlan({
    ...project,
    sourceRevisionId: source.revisionId,
    rawPlan: { route: "editable", operations: [{ kind: "replace-text", elementId: "ocr-title", text: "stale" }] },
  }), /source project revision or final render is stale/);
});

test("fails closed on unowned slide paths and refuses regenerate plans in apply-edit", async (t) => {
  const project = await readyProject(t);
  const plugin = await converterRoot(t);
  const outside = join(await temporary(t, "superppt-editable-outside-"), "outside");
  await mkdir(outside);
  await rm(join(project.root, "editable"), { recursive: true });
  await symlink(outside, join(project.root, "editable"));
  await assert.rejects(convertProjectPage({
    ...project,
    converterRoot: plugin,
    execute: async () => ({ stdout: "", stderr: "" }),
  }), /editable project path is unsafe/);

  const second = await readyProject(t);
  await assert.rejects(applyProjectEditPlan({
    ...second,
    sourceRevisionId: "00000000-0000-4000-8000-000000000199",
    rawPlan: { route: "regenerate", reason: "background target" },
  }), UnsupportedEditableTargetError);
});

test("exposes strict plan-edit CLI routing without invoking a live provider", async (t) => {
  const root = await temporary(t, "superppt-editable-cli-");
  const plan = join(root, "plan.json");
  await writeFile(plan, JSON.stringify({ route: "regenerate", reason: "background-only target" }));
  await chmod(plan, 0o600);
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "plan-edit", "--input", plan], { cwd: process.cwd() });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { route: "regenerate" });
});

test("plan-edit requires a private input and never prints text or user asset paths", async (t) => {
  const root = await temporary(t, "superppt-editable-private-plan-");
  const plan = join(root, "plan.json");
  await writeFile(plan, JSON.stringify({ route: "editable", operations: [
    { kind: "replace-text", elementId: "ocr-title", text: "PRIVATE-TEXT" },
    { kind: "replace-asset", elementId: "icon-1", assetPath: "/private/USER-ASSET.png" },
  ] }));
  if (process.platform !== "win32") {
    for (const mode of [0o644, 0o700]) {
      await chmod(plan, mode);
      await assert.rejects(execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "plan-edit", "--input", plan], { cwd: process.cwd() }), /edit plan file must be private/);
    }
  }
  await chmod(plan, 0o600);
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "plan-edit", "--input", plan], { cwd: process.cwd() });
  assert.deepEqual(JSON.parse(stdout), {
    route: "editable",
    operationCount: 2,
    operationKinds: ["replace-asset", "replace-text"],
  });
  assert.doesNotMatch(stdout, /PRIVATE-TEXT|USER-ASSET|\/private\//);
});
