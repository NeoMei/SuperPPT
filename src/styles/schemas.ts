import { z } from 'zod';

const Id = z.string().regex(/^[a-z0-9-]+$/);
export const CreativityLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const VariantSelectionSchema = z.object({ level: CreativityLevelSchema, paletteId: Id }).strict();
const Template = z.string().min(1).refine(text =>
  ['PALETTE', 'CONTENT_RELATIONSHIPS', 'SLIDE_COPY'].every(slot => text.split('{{' + slot + '}}').length === 2),
  'Template requires exactly one palette, relationships and copy slot');

export const StyleRecipeSchema = z.object({
  id: Id, name: z.string().min(1),
  tiers: z.array(z.object({ level: CreativityLevelSchema, promptTemplate: Template }).strict()).min(1).max(3),
  palettes: z.array(z.object({ id: Id, name: z.string().min(1), prompt: z.string().min(1) }).strict()).min(1),
  previews: z.array(z.object({ level: CreativityLevelSchema, paletteId: Id, path: z.string().min(1) }).strict()),
}).strict().superRefine((style, ctx) => {
  const levels = style.tiers.map(t => t.level), palettes = style.palettes.map(p => p.id);
  const previews = style.previews.map(p => p.level + '/' + p.paletteId);
  if (new Set(levels).size !== levels.length || new Set(palettes).size !== palettes.length || new Set(previews).size !== previews.length)
    ctx.addIssue({ code: 'custom', message: 'Style options must be unique' });
  if (style.previews.some(p => !levels.includes(p.level) || !palettes.includes(p.paletteId)))
    ctx.addIssue({ code: 'custom', message: 'Preview must reference an available tier and palette' });
});
export const StyleCatalogSchema = z.object({
  catalogVersion: z.literal(2), selectionMode: z.literal('single'),
  styles: z.array(StyleRecipeSchema).min(1).max(10),
}).strict().superRefine((catalog, ctx) => {
  if (new Set(catalog.styles.map(s => s.id)).size !== catalog.styles.length)
    ctx.addIssue({ code: 'custom', message: 'Style IDs must be unique' });
});
// Snapshot only the selected variant: later catalog changes cannot alter a running deck.
export const ResolvedStyleSchema = z.object({
  id: Id, name: z.string().min(1), level: CreativityLevelSchema, paletteId: Id,
  promptTemplate: z.string().min(1),
}).strict();
export type StyleRecipe = z.infer<typeof StyleRecipeSchema>;
export type ResolvedStyle = z.infer<typeof ResolvedStyleSchema>;
export type VariantSelection = z.infer<typeof VariantSelectionSchema>;
