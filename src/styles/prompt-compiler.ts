import { createHash } from "node:crypto";
import { z } from "zod";
import type { SlideSpec } from "../planning/schemas.js";
import { StyleRecipeSchema, VisualDirectorSchema, type StyleRecipe, type VisualDirector } from "./schemas.js";

type PromptSpec = {
  title: string;
  role: keyof StyleRecipe["pageVariants"];
  coreMessage: string;
  requiredText: string[];
  visualSubject: string;
  composition: string;
  relationships: string[];
  forbidden: string[];
};

const PromptSpecSchema = z.object({
  title: z.string().min(1),
  role: z.enum(["cover", "section", "content", "process", "comparison", "data", "summary"]),
  coreMessage: z.string().min(1),
  requiredText: z.array(z.string().min(1)).max(12),
  visualSubject: z.string().min(1),
  composition: z.string().min(1),
  relationships: z.array(z.string().min(1)),
  forbidden: z.array(z.string().min(1)),
});

export type CompiledPrompt = { text: string; sha256: string };

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

const field = (label: string, value: unknown): string => `${label} (canonical JSON): ${canonicalJson(value)}`;

export function compilePrompt(input: { spec: PromptSpec | SlideSpec; style: StyleRecipe; director: VisualDirector }): CompiledPrompt {
  const spec = PromptSpecSchema.parse(input.spec);
  const style = StyleRecipeSchema.parse(input.style);
  const director = VisualDirectorSchema.parse(input.director);
  const payload = { director, spec, style };
  const text = [
    "Use case: productivity-visual",
    "Asset type: premium 16:9 presentation slide",
    field("Page role", spec.role),
    field("Slide title (verbatim)", spec.title),
    field("Core message", spec.coreMessage),
    field("Style recipe", { id: style.id, name: style.name }),
    `Style consistency: preserve this exact recipe across the deck while adapting only the page-role composition.`,
    field("Primary visual subject", spec.visualSubject),
    field("Composition", { page: spec.composition, rules: style.compositionRules, variant: style.pageVariants[spec.role] }),
    field("Foreground", director.foreground),
    field("Midground", director.midground),
    field("Background", director.background),
    field("Micro details", director.microDetails),
    field("Reading order", director.readingOrder),
    field("Text safe area", director.textSafeArea),
    field("Relationships", spec.relationships),
    field("Palette", style.palette),
    field("Materials", style.materials),
    field("Lighting", style.lighting),
    field("Medium", style.medium),
    field("Typography", style.typography),
    field("Detail language", style.detailLanguage),
    field("Text (verbatim)", spec.requiredText),
    field("Avoid", [...style.forbidden, ...spec.forbidden]),
    `BEGIN SUPERPPT CANONICAL INPUT\n${canonicalJson(payload)}\nEND SUPERPPT CANONICAL INPUT`,
    "Final self-check: preserve one dominant focal point, clear hierarchy, rich foreground/midground/background detail, exact required copy, exact 16:9 composition, and no logo or watermark.",
  ].join("\n\n");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
