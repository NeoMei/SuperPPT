import { createHash } from 'node:crypto';
import { SlideSpecSchema, type SlideSpec } from '../planning/schemas.js';
import { ResolvedStyleSchema, type ResolvedStyle } from './schemas.js';

export type CompiledPrompt = { text: string; sha256: string };
export function compileSlidePrompt(input: { spec: SlideSpec; style: ResolvedStyle }): CompiledPrompt {
  const spec = SlideSpecSchema.parse(input.spec), style = ResolvedStyleSchema.parse(input.style);
  const slots: Record<string, string> = {
    CONTENT_RELATIONSHIPS: spec.relationships.length ? spec.relationships.join('\n') : spec.coreMessage,
    SLIDE_COPY: spec.requiredText.join('\n'),
  };
  // One pass with a callback keeps dollar signs and slot-like source text literal.
  let text = style.promptTemplate.replace(/{{(CONTENT_RELATIONSHIPS|SLIDE_COPY)}}/g, (_, key: string) => slots[key]);
  if (spec.forbidden.length) text += '\n\n本页避免：' + spec.forbidden.join('；');
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}
