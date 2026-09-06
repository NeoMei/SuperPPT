import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// catalog.json is the canonical checked-in definition. Rebuilding validates
// and formats it; it never substitutes a second collection of styles.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(repoRoot, "skills/superppt/assets/styles");
const catalogPath = join(assetRoot, "catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const provenance = JSON.parse(await readFile(join(assetRoot, "provenance.json"), "utf8"));
const paletteIds = ["cool", "mid", "warm"];
const slots = ["{{PALETTE}}", "{{CONTENT_RELATIONSHIPS}}", "{{SLIDE_COPY}}"];
const args = process.argv.slice(2);
const normalize = args.includes("--normalize-previews");
let sourceRoot;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--normalize-previews") continue;
  if (args[index] === "--design-session-dir" && args[index + 1] && !args[index + 1].startsWith("--")) {
    sourceRoot = resolve(args[++index]);
    continue;
  }
  throw new Error("Unknown or incomplete argument: " + args[index]);
}
assert.equal(normalize, Boolean(sourceRoot), "--normalize-previews requires --design-session-dir, and vice versa");
assert.equal(catalog.catalogVersion, 2);
assert.equal(catalog.selectionMode, "single");
assert.ok(Array.isArray(catalog.styles) && catalog.styles.length >= 1 && catalog.styles.length <= 10);
assert.equal(new Set(catalog.styles.map((style) => style.id)).size, catalog.styles.length, "Style ids must be unique");
const previews = [];
for (const style of catalog.styles) {
  assert.match(style.id, /^[a-z0-9-]+$/);
  assert.ok(typeof style.name === "string" && style.name.trim(), style.id + ": missing name");
  assert.ok(Array.isArray(style.tiers) && style.tiers.length >= 1 && style.tiers.length <= 3);
  assert.ok(style.tiers.every((tier) => [1, 2, 3].includes(tier.level)));
  assert.equal(new Set(style.tiers.map((tier) => tier.level)).size, style.tiers.length);
  assert.ok(Array.isArray(style.palettes) && style.palettes.length > 0);
  assert.equal(new Set(style.palettes.map((palette) => palette.id)).size, style.palettes.length);
  for (const tier of style.tiers) {
    assert.equal(typeof tier.promptTemplate, "string");
    for (const slot of slots) {
      assert.equal(tier.promptTemplate.split(slot).length, 2, style.id + "/" + tier.level + ": exactly one " + slot + " required");
    }
    assert.equal((tier.promptTemplate.match(/{{/g) ?? []).length, 3, "Unexpected template slot");
    assert.ok(!tier.promptTemplate.includes("/Users/"), "Template must be portable");
  }
  for (const palette of style.palettes) {
    assert.match(palette.id, /^[a-z0-9-]+$/);
    assert.ok(typeof palette.name === "string" && palette.name.trim());
    assert.ok(typeof palette.prompt === "string" && palette.prompt.trim());
    assert.ok(!palette.prompt.includes("{{"), "Palette must not contain unresolved slots");
    if (paletteIds.includes(palette.id)) {
      assert.equal(palette.name, { cool: "偏冷", mid: "基准中线", warm: "偏暖" }[palette.id]);
    }
  }
  const seen = new Set();
  for (const preview of style.previews) {
    assert.ok(style.tiers.some((tier) => tier.level === preview.level));
    assert.ok(style.palettes.some((palette) => palette.id === preview.paletteId));
    const key = style.id + "-" + preview.level + "-" + preview.paletteId;
    assert.ok(!seen.has(key), "Duplicate preview: " + key);
    seen.add(key);
    assert.equal(preview.path, "previews/" + key + ".jpg", "Preview paths must be portable and combination-specific");
    previews.push({ ...preview, styleId: style.id });
  }
}
assert.equal(provenance.previews.length, previews.length, "Provenance must cover precisely the active previews");
const sources = new Map(provenance.previews.map((item) => [item.path, item]));
assert.equal(sources.size, previews.length, "Duplicate preview provenance");
for (const preview of previews) {
  const source = sources.get(preview.path);
  assert.ok(source, "Missing provenance: " + preview.path);
  assert.equal(source.styleId, preview.styleId);
  assert.equal(source.level, preview.level);
  assert.equal(source.paletteId, preview.paletteId);
  assert.match(source.sourceImage, /^design-system-round\d+\/[a-z0-9-]+\.png$/);
  assert.match(source.sourceImageSha256, /^[0-9a-f]{64}$/);
}

if (normalize) {
  await mkdir(join(assetRoot, "previews"), { recursive: true });
  for (const preview of previews) {
    const source = sources.get(preview.path);
    const bytes = await readFile(join(sourceRoot, source.sourceImage));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sourceImageSha256, "Source changed: " + source.sourceImage);
    const metadata = await sharp(bytes).metadata();
    assert.ok(Math.abs(metadata.width / metadata.height - 16 / 9) < 0.001, "Refuse to crop a non-16:9 source");
    await sharp(bytes)
      .resize(1280, 720, { fit: "fill" })
      .jpeg({ quality: 85, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toFile(join(assetRoot, preview.path));
  }
}

let totalBytes = 0;
for (const preview of previews) {
  const path = join(assetRoot, preview.path);
  const metadata = await sharp(path).metadata();
  assert.equal(metadata.format, "jpeg", preview.path);
  assert.equal(metadata.width, 1280, preview.path);
  assert.equal(metadata.height, 720, preview.path);
  const bytes = (await stat(path)).size;
  assert.ok(bytes <= 500_000, "Preview exceeds 500 KB: " + preview.path);
  totalBytes += bytes;
}
const serialized = JSON.stringify(catalog, null, 2) + "\n";
if (await readFile(catalogPath, "utf8") !== serialized) await writeFile(catalogPath, serialized);
const tierCount = catalog.styles.reduce((sum, style) => sum + style.tiers.length, 0);
const paletteCount = catalog.styles.reduce((sum, style) => sum + style.palettes.length, 0);
console.log("Validated catalog v2: " + catalog.styles.length + " styles, " + tierCount + " tiers, " + paletteCount + " palettes, " + previews.length + " previews (1280x720 JPEG, " + totalBytes + " bytes). Missing previews do not disable combinations.");
