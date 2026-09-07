import type { StyleRecipe } from './schemas.js';

export type StyleVariantSelection = {
  styleId: string;
  styleName: string;
  level: 1 | 2 | 3;
  paletteId: string;
  paletteName: string;
  previewPath: string | null;
  previewStatus: 'available' | 'missing';
};

export type StyleSelection = {
  styles: Array<{
    id: string;
    name: string;
    card: {
      imagePath: string | null;
      imageKind: 'showcase' | 'variant-reference' | 'missing';
      referenceLevel: 1 | 2 | 3 | null;
      referencePaletteId: string | null;
    };
    groups: Array<{ level: 1 | 2 | 3; variants: StyleVariantSelection[] }>;
  }>;
};

export function styleSelection(styles: StyleRecipe[]): StyleSelection {
  return {
    styles: styles.map(style => {
      const reference = style.showcase ?? style.previews[0] ?? null;
      return {
        id: style.id,
        name: style.name,
        card: {
          imagePath: reference?.path ?? null,
          imageKind: style.showcase ? 'showcase' : reference ? 'variant-reference' : 'missing',
          referenceLevel: reference?.level ?? null,
          referencePaletteId: reference?.paletteId ?? null,
        },
        groups: style.tiers.map(tier => ({
          level: tier.level,
          variants: style.palettes.map(palette => {
            const preview = style.previews.find(item => item.level === tier.level && item.paletteId === palette.id);
            return {
              styleId: style.id,
              styleName: style.name,
              level: tier.level,
              paletteId: palette.id,
              paletteName: palette.name,
              previewPath: preview?.path ?? null,
              previewStatus: preview ? 'available' : 'missing',
            };
          }),
        })),
      };
    }),
  };
}
