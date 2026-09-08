import { z } from 'zod';

const Id = z.string().regex(/^[a-z0-9-]+$/);
export const CreativityLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const VariantSelectionSchema = z.object({ level: CreativityLevelSchema, paletteId: Id }).strict();
const AssetPath = z.string().min(1).refine(path =>
  !path.startsWith('/') && !/^[a-zA-Z]:\//.test(path) && !path.includes('\\') &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
  'Asset path must be a portable contained relative path');
const StyleAsset = z.object({ level: CreativityLevelSchema, paletteId: Id, path: AssetPath }).strict();
const RecipeTemplateSlots = ['PALETTE', 'CONTENT_RELATIONSHIPS', 'SLIDE_COPY'] as const;
const ResolvedTemplateSlots = ['CONTENT_RELATIONSHIPS', 'SLIDE_COPY'] as const;
const hasExactTemplateSlots = (text: string, slots: readonly string[]) => {
  if (text.includes('{{{') || text.includes('}}}')) return false;
  let remaining = text;
  for (const slot of slots) {
    const token = `{{${slot}}}`;
    if (remaining.split(token).length !== 2) return false;
    remaining = remaining.replace(token, '');
  }
  return !remaining.includes('{{') && !remaining.includes('}}');
};
const Template = z.string().min(1).refine(text => hasExactTemplateSlots(text, RecipeTemplateSlots),
  'Template requires exactly one palette, relationships and copy slot and no other double-brace tokens');
const ResolvedTemplate = z.string().min(1).refine(text => hasExactTemplateSlots(text, ResolvedTemplateSlots),
  'Resolved template requires exactly one relationships and copy slot and no other double-brace tokens');
const PalettePrompt = z.string().min(1).refine(text => !text.includes('{{') && !text.includes('}}'),
  'Palette prompt cannot contain template slots');

export const StyleRecipeSchema = z.object({
  id: Id, name: z.string().min(1),
  tiers: z.array(z.object({ level: CreativityLevelSchema, promptTemplate: Template }).strict()).min(1).max(3),
  palettes: z.array(z.object({ id: Id, name: z.string().min(1), prompt: PalettePrompt }).strict()).min(1),
  previews: z.array(StyleAsset),
  showcase: StyleAsset.optional(),
}).strict().superRefine((style, ctx) => {
  const levels = style.tiers.map(t => t.level), palettes = style.palettes.map(p => p.id);
  const previews = style.previews.map(p => p.level + '/' + p.paletteId);
  if (new Set(levels).size !== levels.length || new Set(palettes).size !== palettes.length || new Set(previews).size !== previews.length)
    ctx.addIssue({ code: 'custom', message: 'Style options must be unique' });
  if (style.previews.some(p => !levels.includes(p.level) || !palettes.includes(p.paletteId)))
    ctx.addIssue({ code: 'custom', message: 'Preview must reference an available tier and palette' });
  if (style.showcase && (!levels.includes(style.showcase.level) || !palettes.includes(style.showcase.paletteId)))
    ctx.addIssue({ code: 'custom', message: 'Showcase must reference an available tier and palette' });
  if (style.showcase && style.showcase.path !== `showcases/${style.id}.jpg`)
    ctx.addIssue({ code: 'custom', message: 'Showcase path must match its style id' });
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
  promptTemplate: ResolvedTemplate,
}).strict();
export type StyleRecipe = z.infer<typeof StyleRecipeSchema>;
export type ResolvedStyle = z.infer<typeof ResolvedStyleSchema>;
export type VariantSelection = z.infer<typeof VariantSelectionSchema>;
