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

const list = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");

export function compilePrompt(input: { spec: PromptSpec | SlideSpec; style: StyleRecipe; director: VisualDirector }): CompiledPrompt {
  const spec = PromptSpecSchema.parse(input.spec);
  const style = StyleRecipeSchema.parse(input.style);
  const director = VisualDirectorSchema.parse(input.director);
  const text = [
    "Use case: productivity-visual",
    "Asset type: premium 16:9 presentation slide",
    `Page role: ${spec.role}`,
    `Slide title (verbatim): "${spec.title}"`,
    `Core message: ${spec.coreMessage}`,
    `Style recipe: ${style.id} — ${style.name}`,
    `Style consistency: preserve this exact recipe across the deck while adapting only the page-role composition.`,
    `Primary visual subject: ${spec.visualSubject}`,
    `Composition: ${spec.composition}; ${style.compositionRules.join("; ")}; ${style.pageVariants[spec.role]}`,
    `Foreground:\n${list(director.foreground)}`,
    `Midground:\n${list(director.midground)}`,
    `Background:\n${list(director.background)}`,
    `Micro details:\n${list(director.microDetails)}`,
    `Reading order:\n${list(director.readingOrder)}`,
    `Text safe area: ${director.textSafeArea}`,
    `Relationships:\n${list(spec.relationships)}`,
    `Palette: ${style.palette.join(", ")}`,
    `Materials: ${style.materials.join(", ")}`,
    `Lighting: ${style.lighting.join(", ")}`,
    `Medium: ${style.medium.join(", ")}`,
    `Typography: ${style.typography.join(", ")}`,
    `Detail language: ${style.detailLanguage.join(", ")}`,
    `Text (verbatim):\n${list(spec.requiredText.map((value) => `"${value}"`))}`,
    `Avoid:\n${list([...style.forbidden, ...spec.forbidden])}`,
    "Final self-check: preserve one dominant focal point, clear hierarchy, rich foreground/midground/background detail, exact required copy, exact 16:9 composition, and no logo or watermark.",
  ].join("\n\n");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
