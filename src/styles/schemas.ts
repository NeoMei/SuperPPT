import { z } from "zod";

const Strings = z.array(z.string().min(1)).min(1);
const PageRoleSchema = z.enum(["cover", "section", "content", "process", "comparison", "data", "summary"]);

export const StyleRecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  preview: z.string().min(1).optional(),
  palette: Strings,
  materials: Strings,
  lighting: Strings,
  medium: Strings,
  typography: Strings,
  detailLanguage: Strings,
  compositionRules: Strings,
  forbidden: Strings,
  pageVariants: z.record(PageRoleSchema, z.string().min(1)),
}).strict();

export const StyleCatalogSchema = z.object({
  catalogVersion: z.literal(1),
  selectionMode: z.literal("single"),
  styles: z.array(StyleRecipeSchema.extend({ preview: z.string().min(1) })).min(8).max(12),
}).strict().superRefine((value, context) => {
  const ids = value.styles.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "style IDs must be unique", path: ["styles"] });
  }
  value.styles.forEach((style, index) => {
    if (style.preview !== `previews/${style.id}.jpg`) {
      context.addIssue({
        code: "custom",
        message: "style preview must match its style ID",
        path: ["styles", index, "preview"],
      });
    }
  });
});

export const VisualDirectorSchema = z.object({
  foreground: Strings,
  midground: Strings,
  background: Strings,
  microDetails: Strings,
  readingOrder: Strings,
  textSafeArea: z.string().min(1),
}).strict();

export type StyleRecipe = z.infer<typeof StyleRecipeSchema>;
export type VisualDirector = z.infer<typeof VisualDirectorSchema>;
