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
const acceptedStyleIds = ["tactile", "glass", "ink", "hand-drawn", "textbook", "collage", "cinematic-tech", "luxury-photo", "blueprint", "fantasy"];
const acceptedStyleNames = ["立体", "玻璃", "水墨", "经典手绘", "教材图解", "创意拼贴", "电影科技", "奢华摄影", "建筑蓝图", "叙事幻想"];
const acceptedManifestStyleIds = ["tactile", "glass", "ink", "01-hand-drawn", "02-textbook", "01-collage", "04-cinematic-tech", "05-luxury-photo", "06-blueprint", "07-fantasy"];
const expectedRecipeTransformations = [
  { operation: "replace", from: "中文 PPT 广告展示页", to: "中文 PPT 页面" },
  { operation: "replace", from: "的 SuperPPT 标题和副标题区", to: "的标题和副标题区" },
  { operation: "replace-section", source: "内容关系", with: "{{CONTENT_RELATIONSHIPS}}" },
  { operation: "replace-paragraph", source: "本轮基准配色", with: "{{PALETTE}}" },
  { operation: "replace-block", source: "逐字使用的完整文案", with: "{{SLIDE_COPY}}" },
  { operation: "remove", source: "用途说明", reason: "fixture-specific usage note" },
];
const args = process.argv.slice(2);
const normalize = args.includes("--normalize-previews");
let sourceRoot;
let acceptedSourceRoot;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--normalize-previews") continue;
  if (args[index] === "--design-session-dir" && args[index + 1] && !args[index + 1].startsWith("--")) {
    sourceRoot = resolve(args[++index]);
    continue;
  }
  if (args[index] === "--accepted-source-dir" && args[index + 1] && !args[index + 1].startsWith("--")) {
    acceptedSourceRoot = resolve(args[++index]);
    continue;
  }
  throw new Error("Unknown or incomplete argument: " + args[index]);
}
assert.equal(normalize, Boolean(sourceRoot || acceptedSourceRoot), "--normalize-previews requires at least one source directory, and source directories require --normalize-previews");
function assertSafeRelativePath(path, label) {
  assert.ok(typeof path === "string" && path.length > 0, label + ": missing path");
  assert.ok(!path.startsWith("/") && !/^[a-zA-Z]:\//.test(path) && !path.includes("\\"), label + ": path must be portable and relative");
  assert.ok(path.split("/").every((part) => part && part !== "." && part !== ".."), label + ": path must remain contained");
}
function replaceExactlyOnce(value, from, to, label) {
  assert.equal(value.split(from).length, 2, label + ": expected exactly one source phrase");
  return value.replace(from, to);
}
function extractAcceptedRecipe(sourcePrompt, styleId) {
  let promptTemplate = sourcePrompt.trimEnd();
  promptTemplate = replaceExactlyOnce(promptTemplate, "中文 PPT 广告展示页", "中文 PPT 页面", styleId + ": page wording");
  promptTemplate = replaceExactlyOnce(promptTemplate, "的 SuperPPT 标题和副标题区", "的标题和副标题区", styleId + ": title-area wording");
  const paletteMatches = [...promptTemplate.matchAll(/\n\n本轮基准配色：\n([^\n]+)(?=\n\n)/g)];
  assert.equal(paletteMatches.length, 1, styleId + ": expected one palette paragraph");
  const palettePrompt = paletteMatches[0][1];
  const relationshipMatches = promptTemplate.match(/内容关系：[^\n]+/g) ?? [];
  assert.equal(relationshipMatches.length, 1, styleId + ": expected one content relationship section");
  promptTemplate = promptTemplate.replace(/内容关系：[^\n]+/, "内容关系：{{CONTENT_RELATIONSHIPS}}");
  promptTemplate = promptTemplate.replace(/\n\n本轮基准配色：\n[^\n]+(?=\n\n)/, "\n\n本轮基准配色：\n{{PALETTE}}");
  const visibleCopyMatches = promptTemplate.match(/逐字使用的完整文案：\n[\s\S]*?(?=\n\n用途说明：)/g) ?? [];
  assert.equal(visibleCopyMatches.length, 1, styleId + ": expected one visible-copy block");
  promptTemplate = promptTemplate.replace(/逐字使用的完整文案：\n[\s\S]*?(?=\n\n用途说明：)/, "逐字使用的完整文案：\n{{SLIDE_COPY}}");
  const usageMatches = promptTemplate.match(/\n\n用途说明：[^\n]*$/g) ?? [];
  assert.equal(usageMatches.length, 1, styleId + ": expected one fixture usage note");
  promptTemplate = promptTemplate.replace(/\n\n用途说明：[^\n]*$/, "") + "\n";
  return { promptTemplate, palettePrompt };
}
assert.equal(catalog.catalogVersion, 2);
assert.equal(catalog.selectionMode, "single");
assert.deepEqual(catalog.styles.map((style) => style.id), acceptedStyleIds);
assert.deepEqual(catalog.styles.map((style) => style.name), acceptedStyleNames);
assert.equal(new Set(catalog.styles.map((style) => style.id)).size, catalog.styles.length, "Style ids must be unique");
const previews = [];
const showcases = [];
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
    assertSafeRelativePath(preview.path, "Preview " + key);
    assert.equal(preview.path, "previews/" + key + ".jpg", "Preview paths must be portable and combination-specific");
    previews.push({ ...preview, styleId: style.id });
  }
  assert.ok(style.showcase, style.id + ": missing showcase");
  assert.ok(style.tiers.some((tier) => tier.level === style.showcase.level), style.id + ": showcase tier unavailable");
  assert.ok(style.palettes.some((palette) => palette.id === style.showcase.paletteId), style.id + ": showcase palette unavailable");
  assertSafeRelativePath(style.showcase.path, "Showcase " + style.id);
  assert.equal(style.showcase.path, "showcases/" + style.id + ".jpg");
  showcases.push({ ...style.showcase, styleId: style.id });
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
  assertSafeRelativePath(source.sourceImage, "Preview source " + preview.path);
  if (source.acceptedSourceId) {
    assert.equal(source.acceptedSourceId, provenance.acceptedSource.id);
    assert.match(source.sourceImage, /^images\/[a-z0-9-]+\.png$/);
  } else {
    assert.match(source.sourceImage, /^design-system-round\d+\/[a-z0-9-]+\.png$/);
  }
  assert.match(source.sourceImageSha256, /^[0-9a-f]{64}$/);
}

assert.equal(provenance.acceptedSource.id, "ten-style-showcase-v1");
assertSafeRelativePath(provenance.acceptedSource.manifest, "Accepted manifest");
assert.match(provenance.acceptedSource.manifestSha256, /^[0-9a-f]{64}$/);
assert.equal(provenance.showcases.length, showcases.length, "Provenance must cover precisely the accepted showcases");
const showcaseSources = new Map(provenance.showcases.map((item) => [item.path, item]));
assert.equal(showcaseSources.size, showcases.length, "Duplicate showcase provenance");
for (const showcase of showcases) {
  const source = showcaseSources.get(showcase.path);
  assert.ok(source, "Missing showcase provenance: " + showcase.path);
  assert.equal(source.styleId, showcase.styleId);
  assert.equal(source.level, showcase.level);
  assert.equal(source.paletteId, showcase.paletteId);
  assert.equal(source.acceptedSourceId, provenance.acceptedSource.id);
  assertSafeRelativePath(source.sourceImage, "Showcase source image " + showcase.path);
  assertSafeRelativePath(source.sourcePrompt, "Showcase source prompt " + showcase.path);
  assert.match(source.sourceImage, /^images\/[a-z0-9-]+\.png$/);
  assert.match(source.sourcePrompt, /^prompts\/[a-z0-9-]+\.txt$/);
  assert.match(source.sourceImageSha256, /^[0-9a-f]{64}$/);
  assert.match(source.sourcePromptSha256, /^[0-9a-f]{64}$/);
}
const newStyleIds = acceptedStyleIds.slice(3);
assert.deepEqual(provenance.recipes.map((recipe) => recipe.styleId), newStyleIds);
for (const recipe of provenance.recipes) {
  assertSafeRelativePath(recipe.sourcePrompt, "Recipe source " + recipe.styleId);
  assert.match(recipe.sourcePromptSha256, /^[0-9a-f]{64}$/);
  assert.match(recipe.promptTemplateSha256, /^[0-9a-f]{64}$/);
  assert.match(recipe.palettePromptSha256, /^[0-9a-f]{64}$/);
  const style = catalog.styles.find((candidate) => candidate.id === recipe.styleId);
  assert.ok(style, "Recipe style missing: " + recipe.styleId);
  assert.equal(style.tiers.length, 1, recipe.styleId + ": accepted recipe must expose one tier");
  assert.equal(style.palettes.length, 1, recipe.styleId + ": accepted recipe must expose one palette");
  assert.equal(createHash("sha256").update(style.tiers[0].promptTemplate).digest("hex"), recipe.promptTemplateSha256, recipe.styleId + ": prompt template changed");
  assert.equal(createHash("sha256").update(style.palettes[0].prompt).digest("hex"), recipe.palettePromptSha256, recipe.styleId + ": palette prompt changed");
}
assert.deepEqual(provenance.recipeTransformations, expectedRecipeTransformations, "Recipe transformation contract changed");

if (normalize) {
  await mkdir(join(assetRoot, "previews"), { recursive: true });
  await mkdir(join(assetRoot, "showcases"), { recursive: true });
  async function normalizeAsset(target, source, root) {
    const bytes = await readFile(join(root, source.sourceImage));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sourceImageSha256, "Source changed: " + source.sourceImage);
    const metadata = await sharp(bytes).metadata();
    assert.ok(Math.abs(metadata.width / metadata.height - 16 / 9) < 0.001, "Refuse to crop a non-16:9 source");
    await sharp(bytes)
      .resize(1280, 720, { fit: "fill" })
      .jpeg({ quality: 85, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toFile(join(assetRoot, target.path));
  }
  if (sourceRoot) {
    for (const preview of previews) {
      const source = sources.get(preview.path);
      if (!source.acceptedSourceId) await normalizeAsset(preview, source, sourceRoot);
    }
  }
  if (acceptedSourceRoot) {
    const manifestBytes = await readFile(join(acceptedSourceRoot, provenance.acceptedSource.manifest));
    assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), provenance.acceptedSource.manifestSha256, "Accepted manifest changed");
    const manifest = JSON.parse(manifestBytes);
    assert.deepEqual(manifest.styles.map((style) => style.id), acceptedManifestStyleIds, "Accepted manifest style roster changed");
    const manifestStyles = new Map(manifest.styles.map((style) => [style.id, style]));
    for (let index = 0; index < acceptedStyleIds.length; index += 1) {
      const styleId = acceptedStyleIds[index];
      const source = showcaseSources.get("showcases/" + styleId + ".jpg");
      const manifestStyle = manifestStyles.get(acceptedManifestStyleIds[index]);
      assert.ok(manifestStyle, "Accepted manifest mapping missing: " + styleId);
      assert.equal(manifestStyle.name, acceptedStyleNames[index], "Accepted manifest name changed: " + styleId);
      assert.equal(source.sourceImage, manifestStyle.image, "Showcase image mapping changed: " + styleId);
      assert.equal(source.sourceImageSha256, manifestStyle.sha256, "Showcase image hash mapping changed: " + styleId);
      assert.equal(source.sourcePrompt, manifestStyle.prompt, "Showcase prompt mapping changed: " + styleId);
      const promptBytes = await readFile(join(acceptedSourceRoot, source.sourcePrompt));
      assert.equal(createHash("sha256").update(promptBytes).digest("hex"), source.sourcePromptSha256, "Accepted prompt changed: " + source.sourcePrompt);
      const recipe = provenance.recipes.find((candidate) => candidate.styleId === styleId);
      if (recipe) {
        assert.equal(recipe.sourcePrompt, manifestStyle.prompt, "Recipe prompt mapping changed: " + styleId);
        assert.equal(recipe.sourcePromptSha256, source.sourcePromptSha256, "Recipe prompt hash mapping changed: " + styleId);
        const extracted = extractAcceptedRecipe(promptBytes.toString("utf8"), styleId);
        const catalogStyle = catalog.styles.find((candidate) => candidate.id === styleId);
        assert.equal(extracted.promptTemplate, catalogStyle.tiers[0].promptTemplate, "Recipe extraction changed: " + styleId);
        assert.equal(extracted.palettePrompt, catalogStyle.palettes[0].prompt, "Palette extraction changed: " + styleId);
      }
    }
    for (const preview of previews) {
      const source = sources.get(preview.path);
      if (source.acceptedSourceId) {
        const showcaseSource = showcaseSources.get("showcases/" + preview.styleId + ".jpg");
        assert.equal(source.sourceImage, showcaseSource.sourceImage, "Preview source mapping changed: " + preview.path);
        assert.equal(source.sourceImageSha256, showcaseSource.sourceImageSha256, "Preview source hash mapping changed: " + preview.path);
        await normalizeAsset(preview, source, acceptedSourceRoot);
      }
    }
    for (const showcase of showcases) await normalizeAsset(showcase, showcaseSources.get(showcase.path), acceptedSourceRoot);
  }
}

let remoteAssets = {};
try {
  const registry = JSON.parse(await readFile(join(assetRoot, "remote-assets.json"), "utf8"));
  assert.equal(registry.version, 1, "Unsupported remote registry version");
  assert.ok(registry.assets && typeof registry.assets === "object" && !Array.isArray(registry.assets));
  remoteAssets = registry.assets;
  for (const [key, asset] of Object.entries(remoteAssets)) {
    assert.match(key, /^(previews|showcases)\/[a-z0-9-]+\.(jpg|jpeg|png)$/);
    const url = new URL(asset.url);
    assert.ok(url.protocol === "https:" && !url.username && !url.password && !url.hash, key + ": unsafe remote URL");
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    for (const field of ["bytes", "width", "height"]) assert.ok(Number.isSafeInteger(asset[field]) && asset[field] > 0, key + ": invalid " + field);
    assert.equal(asset.width * 9, asset.height * 16, key + ": expected 16:9");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let totalBytes = 0;
let remoteCount = 0;
let localCount = 0;
for (const asset of [...previews, ...showcases]) {
  if (Object.hasOwn(remoteAssets, asset.path)) {
    remoteCount += 1;
    continue;
  }
  localCount += 1;
  const path = join(assetRoot, asset.path);
  const metadata = await sharp(path).metadata();
  assert.equal(metadata.format, "jpeg", asset.path);
  assert.equal(metadata.width, 1280, asset.path);
  assert.equal(metadata.height, 720, asset.path);
  const bytes = (await stat(path)).size;
  assert.ok(bytes <= 500_000, "Asset exceeds 500 KB: " + asset.path);
  totalBytes += bytes;
}
const serialized = JSON.stringify(catalog, null, 2) + "\n";
if (await readFile(catalogPath, "utf8") !== serialized) await writeFile(catalogPath, serialized);
const tierCount = catalog.styles.reduce((sum, style) => sum + style.tiers.length, 0);
const paletteCount = catalog.styles.reduce((sum, style) => sum + style.palettes.length, 0);
console.log("Validated catalog v2: " + catalog.styles.length + " styles, " + tierCount + " tiers, " + paletteCount + " palettes, " + previews.length + " previews and " + showcases.length + " showcases (" + remoteCount + " remote references, " + localCount + " local JPEGs, " + totalBytes + " bundled image bytes). Missing previews do not disable combinations.");
