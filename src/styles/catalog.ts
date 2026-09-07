import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StyleCatalogSchema, StyleRecipeSchema, VariantSelectionSchema, type ResolvedStyle } from "./schemas.js";

const BUILT_IN_STYLE_CATALOG_RELATIVE_PATH = "skills/superppt/assets/styles/catalog.json";

function builtInCatalogCandidates(): string[] {
  return [
    fileURLToPath(new URL(`../../${BUILT_IN_STYLE_CATALOG_RELATIVE_PATH}`, import.meta.url)),
    fileURLToPath(new URL(`../../../${BUILT_IN_STYLE_CATALOG_RELATIVE_PATH}`, import.meta.url)),
  ];
}

export async function loadStyleCatalog(path: string) {
  const value = StyleCatalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
  for (const style of value.styles) {
    for (const preview of style.previews) await access(join(dirname(path), preview.path));
    if (style.showcase) await access(join(dirname(path), style.showcase.path));
  }
  return value;
}

export async function loadBuiltInStyleCatalog() {
  for (const path of builtInCatalogCandidates()) {
    try {
      await access(path);
      return await loadStyleCatalog(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("built-in style catalog is missing from the SuperPPT plugin root");
}

export function builtInStyleAssetsRoot(): string {
  const path = builtInCatalogCandidates().find(path => existsSync(path));
  if (!path) throw new Error('Built-in style assets missing');
  return dirname(path);
}

export function selectStyleVariant(rawStyle: unknown, rawSelection: unknown): ResolvedStyle {
  const style = StyleRecipeSchema.parse(rawStyle), selection = VariantSelectionSchema.parse(rawSelection);
  const tier = style.tiers.find(t => t.level === selection.level);
  const palette = style.palettes.find(p => p.id === selection.paletteId);
  if (!tier) throw new Error('Unavailable creativity tier');
  if (!palette) throw new Error('Unavailable style palette');
  return { id: style.id, name: style.name, ...selection,
    promptTemplate: tier.promptTemplate.replace('{{PALETTE}}', () => palette.prompt) };
}

export function selectRepresentativeSlide<T extends { id: string; role: string; requiredText: string[]; relationships: string[] }>(slides: T[]): T {
  if (slides.length === 0) throw new Error("cannot select a sample from an empty deck");
  const score = (slide: T) => (slide.role === "cover" ? -100 : 0) + slide.requiredText.length * 2 + slide.relationships.length * 3;
  return [...slides].sort((a, b) => score(b) - score(a))[0]!;
}
