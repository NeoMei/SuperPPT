import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const roles = {
  cover: "one iconic hero scene with generous title-safe atmosphere",
  section: "one transitional visual threshold with a single chapter cue",
  content: "layered explanatory scene with one focal subject and supporting evidence",
  process: "directional sequence with unmistakable start, transitions, and outcome",
  comparison: "balanced opposing regions with a visible shared evaluation axis",
  data: "integrated evidence field where charts belong to the scene rather than float above it",
  summary: "converging visual synthesis with one memorable closing image",
};
const preview = (id) => `previews/${id}.jpg`;
const make = (id, name, palette, materials, lighting, medium, typography, detailLanguage, compositionRules, forbidden) =>
  ({ id, name, preview: preview(id), palette, materials, lighting, medium, typography, detailLanguage, compositionRules, forbidden, pageVariants: roles });

const styles = [
  make("ink-future", "水墨未来", ["carbon black", "rice-paper ivory", "mineral cyan"], ["fibrous xuan paper", "metallic ink"], ["misty backlight", "silver edge glow"], ["Chinese ink painting", "precision technical illustration"], ["restrained Song-style title", "small modern annotation"], ["dry-brush circuitry", "layered ink mist", "microscopic seal marks"], ["asymmetric void and density", "one ink focal mass", "flowing visual current"], ["tourist poster", "cartoon panda", "random calligraphy"]),
  make("scientific-atlas", "科学图鉴", ["bone white", "specimen green", "cobalt blue"], ["archival paper", "glass specimen plate"], ["museum daylight", "fine raking light"], ["natural-history plate", "scientific cutaway illustration"], ["engraved serif heading", "precise specimen labels"], ["cross-section anatomy", "calibration ticks", "hand-inked micro labels"], ["central specimen hierarchy", "numbered evidence clusters", "disciplined annotation routes"], ["school worksheet", "clip art", "unlabeled decoration"]),
  make("isometric-miniature", "三维微缩", ["warm stone", "oxidized teal", "signal orange"], ["cast resin", "brushed aluminum"], ["soft studio key", "miniature practical lights"], ["isometric diorama", "high-end product visualization"], ["compact geometric title", "physical wayfinding labels"], ["tiny operators", "cable conduits", "machined panel seams"], ["single miniature world", "readable vertical strata", "controlled 30-degree perspective"], ["toy-like plastic", "empty cubes", "flat icon grid"]),
  make("cinematic-editorial", "电影编辑", ["charcoal", "paper cream", "editorial crimson"], ["matte photographic paper", "fine film grain"], ["dramatic window light", "soft negative fill"], ["cinematic photography", "premium magazine layout"], ["large editorial serif", "quiet grotesk captions"], ["contact-sheet fragments", "subtle crop marks", "tonal fabric detail"], ["one photographic thesis", "editorial tension", "clear reading rhythm"], ["stock-photo collage", "busy magazine cover", "fake brand marks"]),
  make("swiss-avantgarde", "先锋瑞士", ["warm white", "absolute black", "vermilion"], ["uncoated paper", "screen-print ink"], ["flat gallery light", "sharp paper shadow"], ["Swiss editorial design", "constructivist print composition"], ["oversized grotesk type", "micro-grid captions"], ["registration crosses", "halftone image fields", "hairline grid coordinates"], ["radical asymmetric grid", "high contrast scale", "precise negative space"], ["generic corporate template", "rounded cards", "decorative gradients"]),
  make("cinematic-tech", "电影科技", ["midnight blue", "electric cyan", "restrained coral"], ["smoked glass", "brushed metal"], ["volumetric key light", "cyan rim light"], ["cinematic concept art", "photoreal 3D"], ["clear title safe area", "precise sans serif"], ["fine circuitry", "particle paths", "micro-etched labels"], ["one dominant focal point", "layered depth", "controlled information zones"], ["neon gamer UI", "hologram clutter", "unreadable microtext"]),
  make("luxury-photographic", "奢华摄影", ["obsidian", "champagne", "deep emerald"], ["satin metal", "polished stone"], ["sculpted studio light", "warm reflected glow"], ["luxury still life", "architectural photography"], ["refined high-contrast serif", "spaced small capitals"], ["stone veining", "controlled reflections", "fine textile weave"], ["hero-object staging", "calm premium spacing", "photographic depth planes"], ["jewelry advertisement cliché", "gold overload", "generic office portrait"]),
  make("tactile-craft", "材质手作", ["clay white", "indigo thread", "saffron"], ["handmade paper", "stitched textile"], ["north-window daylight", "warm table bounce"], ["paper sculpture", "editorial craft photography"], ["humanist serif title", "hand-set label strips"], ["torn fiber edges", "visible stitches", "embossed symbols"], ["one crafted centerpiece", "layered paper depth", "material-led hierarchy"], ["children's scrapbook", "messy glue marks", "random stickers"]),
  make("architectural-blueprint", "建筑蓝图", ["blueprint navy", "chalk white", "safety amber"], ["vellum", "anodized aluminum"], ["cool drafting-table light", "precise edge illumination"], ["architectural drawing", "technical axonometric rendering"], ["condensed technical title", "monospaced dimension notes"], ["section hatches", "dimension chains", "component callouts"], ["governing structural axis", "measured modular grid", "clear section-to-detail hierarchy"], ["illegible CAD screenshot", "random engineering numbers", "flat wireframe only"]),
  make("narrative-fantasy", "叙事幻想", ["twilight violet", "moonlit silver", "ember orange"], ["weathered stone", "translucent crystal"], ["moonlit atmosphere", "warm narrative beacon"], ["narrative concept art", "matte-painting realism"], ["elegant storybook serif", "restrained cartographic labels"], ["symbolic constellations", "weathered map lines", "miniature story events"], ["one narrative journey", "foreground-to-horizon progression", "symbolic evidence landmarks"], ["game loading screen", "fantasy character poster", "ornamental noise"]),
];

await mkdir("skills/superppt/assets/styles", { recursive: true });
await writeFile("skills/superppt/assets/styles/catalog.json", `${JSON.stringify({ catalogVersion: 1, selectionMode: "single", styles }, null, 2)}\n`);

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (process.argv.includes("--normalize-previews")) {
  const designSessionDir = valueAfter("--design-session-dir");
  const generatedImagesDir = valueAfter("--generated-images-dir");
  if (!designSessionDir || !generatedImagesDir) {
    throw new Error("--normalize-previews requires --design-session-dir and --generated-images-dir");
  }

  const sources = [
    ...styles.slice(0, 6).map((style, index) => ({
      id: style.id,
      source: join(designSessionDir, `detail-style-${index + 1}.jpg`),
    })),
    { id: "luxury-photographic", source: join(generatedImagesDir, "exec-b25884dc-0fa6-4d7d-9beb-03037e8a17ca.png") },
    { id: "tactile-craft", source: join(generatedImagesDir, "exec-f1c9f9b3-c261-49e6-95a8-16eb91c91e61.png") },
    { id: "architectural-blueprint", source: join(generatedImagesDir, "exec-a8cd8a73-9158-4c09-9190-060ac2bae6b4.png") },
    { id: "narrative-fantasy", source: join(generatedImagesDir, "exec-ae0d60e6-5085-4842-aca4-253af9588fa0.png") },
  ];
  const previewDir = "skills/superppt/assets/styles/previews";
  await mkdir(previewDir, { recursive: true });
  for (const { id, source } of sources) {
    const destination = join(previewDir, `${id}.jpg`);
    await sharp(source)
      .rotate()
      .resize(1600, 900, { fit: "cover", position: "centre" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toFile(destination);
    const metadata = await sharp(destination).metadata();
    if (metadata.format !== "jpeg" || metadata.width !== 1600 || metadata.height !== 900) {
      throw new Error(`normalized preview has invalid metadata: ${id}`);
    }
    console.log(`${id}\t${source}\t${destination}\t${metadata.width}x${metadata.height}\t${metadata.format}`);
  }
}
