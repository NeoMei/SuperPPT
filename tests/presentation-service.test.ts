import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import sharp from "sharp";

import { createPresentation } from "../src/deck/pptx.js";
import { pxToInchX, pxToInchY } from "../src/deck/geometry.js";
import {
  resolvePresentationConstructor,
  writePresentation,
} from "../src/deck/presentation-service.js";
import { repositorySourcePath } from "./repository-source.js";

test("resolves direct and nested pptxgenjs default exports", () => {
  const constructor = resolvePresentationConstructor(PptxGenJS);
  assert.equal(typeof constructor, "function");
  assert.equal(resolvePresentationConstructor({ default: { default: constructor } }), constructor);
  assert.throws(
    () => resolvePresentationConstructor({ default: { default: {} } }),
    /did not expose a presentation constructor/,
  );
});

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "superppt-presentation-service-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function image(path: string, color: string): Promise<Buffer> {
  await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: color },
  }).png().toFile(path);
  return readFile(path);
}

function assertNear(actual: string, expected: number, label: string): void {
  assert.ok(Math.abs(Number(actual) - expected) <= 2, `${label}: ${actual} ~= ${expected}`);
}

test("owned adapter builds a three-page image/editable/image PPTX without Codex runtime coupling", async (t) => {
  const root = await directory(t);
  const first = await image(join(root, "first.png"), "#dc503c");
  const second = await image(join(root, "second.png"), "#1e64c8");
  const third = await image(join(root, "third.png"), "#3caa55");
  const output = join(root, "three-slide.pptx");
  const runtime = {
    RUNTIME_NODE: process.env.RUNTIME_NODE,
    RUNTIME_NODE_MODULES: process.env.RUNTIME_NODE_MODULES,
    RUNTIME_BIN_DIR: process.env.RUNTIME_BIN_DIR,
  };
  delete process.env.RUNTIME_NODE;
  delete process.env.RUNTIME_NODE_MODULES;
  delete process.env.RUNTIME_BIN_DIR;
  try {
    await createPresentation([
      { id: "first", bytes: first, contentType: "image/png" },
      {
        id: "second", bytes: second, contentType: "image/png", mode: "editable",
        editable: {
          id: "second",
          cleanBackground: second,
          elements: [{
            kind: "text", id: "title", text: "TITLE EDIT",
            bbox: { x: 77.25, y: 67.5, width: 613.75, height: 76.25 }, rotation: 0,
            color: "#17324D", fontSizePx: 32, bold: true, align: "left", zIndex: 1,
          }],
        },
      },
      { id: "third", bytes: third, contentType: "image/png" },
    ], output);
  } finally {
    for (const [name, value] of Object.entries(runtime)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const bytes = await readFile(output);
  assert.ok(createHash("sha256").update(bytes).digest("hex"));
  const zip = await JSZip.loadAsync(bytes);
  const slides = await Promise.all([1, 2, 3].map(async (index) =>
    zip.file(`ppt/slides/slide${index}.xml`)!.async("string")));
  const presentationXml = await zip.file("ppt/presentation.xml")!.async("string");
  const slideMasterXml = await zip.file("ppt/slideMasters/slideMaster1.xml")!.async("string");
  const coreXml = await zip.file("docProps/core.xml")!.async("string");
  assert.match(slides[0]!, /name="page-first"/);
  assert.match(slides[1]!, /name="background-second"/);
  assert.match(slides[1]!, /name="text-title"/);
  assert.match(slides[1]!, /TITLE EDIT/);
  const textShape = slides[1]!.match(/name="text-title"[\s\S]*?<\/p:sp>/)?.[0];
  assert.ok(textShape, "text-title shape XML is present");
  const geometry = textShape!.match(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(geometry, "text-title geometry is serialized");
  assertNear(geometry![1]!, pxToInchX(77.25) * 914400, "x");
  assertNear(geometry![2]!, pxToInchY(67.5) * 914400, "y");
  assertNear(geometry![3]!, pxToInchX(613.75) * 914400, "width");
  assertNear(geometry![4]!, pxToInchY(76.25) * 914400, "height");
  assert.match(textShape!, /<a:rPr[^>]*b="1"[^>]*sz="2400"/);
  assert.match(textShape!, /<a:srgbClr val="17324D"/i);
  assert.match(textShape!, /<a:pPr[^>]*algn="l"/);
  assert.match(slides[2]!, /name="page-third"/);
  assert.doesNotMatch(slides[0]!, /TITLE EDIT/);
  assert.doesNotMatch(slides[2]!, /TITLE EDIT/);
  assert.match(presentationXml, /<p:defaultTextStyle>[\s\S]*?lang="zh-CN"/);
  assert.match(slideMasterXml, /<p:txStyles>[\s\S]*?lang="zh-CN"/);
  assert.match(coreXml, /<dc:language>zh-CN<\/dc:language>/);
});

test("fails closed when a requested output parent is swapped after validation", async (t) => {
  const root = await directory(t);
  const physical = join(root, "physical");
  const outside = await directory(t);
  await mkdir(join(physical, "child"), { recursive: true });
  await mkdir(join(outside, "child"));
  const requested = join(root, "requested");
  await symlink(physical, requested);
  const bytes = await image(join(root, "page.png"), "#17324d");
  const output = join(requested, "child", "race.pptx");

  await assert.rejects(writePresentation([
    { id: "race", bytes, contentType: "image/png" },
  ], output, root, {
    beforePromotion: async () => {
      await rename(requested, `${requested}.validated`);
      await symlink(outside, requested);
    },
  }), /output parent changed after validation/);

  await assert.rejects(access(join(physical, "child", "race.pptx")));
  await assert.rejects(access(join(outside, "child", "race.pptx")));
});

async function assertIndependentSource(path: string): Promise<void> {
  const source = await readFile(path, "utf8");
  assert.doesNotMatch(source, /@oai\/artifact-tool|codex-primary-runtime|codex-runtimes|RUNTIME_NODE|RUNTIME_NODE_MODULES|RUNTIME_BIN_DIR/);
}

test("SuperPPT owned presentation-service source exists and is independent", async () => {
  await assertIndependentSource(await repositorySourcePath("src/deck/presentation-service.ts"));
});

test("SuperPPT PPTX writer and test runner remain independent from Codex artifact runtime", async () => {
  await assertIndependentSource(await repositorySourcePath("src/deck/pptx.ts"));
  await assertIndependentSource(await repositorySourcePath("scripts/test.ts"));
});
