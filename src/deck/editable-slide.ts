import type { EditableManifestV2 } from '../editable/schemas.js';
export type PreparedEditableElement =
  | Extract<EditableManifestV2['elements'][number], { kind: 'text' }>
  | (Extract<EditableManifestV2['elements'][number], { kind: 'asset' }> & { bytes: Buffer });
export type PreparedEditableSlide = { id: string; cleanBackground: Buffer; elements: PreparedEditableElement[] };
