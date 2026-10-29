import { createHash } from 'node:crypto';
import { SlideSpecSchema, type SlideSpec } from '../planning/schemas.js';
import { ResolvedStyleSchema, type ResolvedStyle } from './schemas.js';

export type CompiledPrompt = { text: string; sha256: string };
export const contentHierarchyDirection = `内容优先与视觉层级（必须遵守）：
根据所选风格与创意档位，让观众一眼读懂本页核心信息。图文共同构思：在该档位使用图形时，围绕对应文意主动创作有表现力的图形，让形态、结构和连接表达各组文字的含义及真实关系；不把图形降为背景或装饰，也不预设固定造型、数量或布局。
适当缩小单个图形、控制视觉权重，为完整文字保留足够空间、字号与对比，使图文相互呼应而不是让文字被挤到角落。需要时使用适合所选风格的托底增强可读性，不强制每组托底或限定文字与图形的固定占比。不得遮挡、删改或弱化文案，不添加无来源的评分、数字或关系；风格配方明确采用纯文字时遵循该档位，不强行添加图形。`;
export function compileSlidePrompt(input: { spec: SlideSpec; style: ResolvedStyle }): CompiledPrompt {
  const spec = SlideSpecSchema.parse(input.spec), style = ResolvedStyleSchema.parse(input.style);
  const slots: Record<string, string> = {
    CONTENT_RELATIONSHIPS: spec.relationships.length ? spec.relationships.join('\n') : spec.coreMessage,
    SLIDE_COPY: spec.requiredText.join('\n'),
  };
  // One pass with a callback keeps dollar signs and slot-like source text literal.
  let text = contentHierarchyDirection + '\n\n' + style.promptTemplate.replace(/{{(CONTENT_RELATIONSHIPS|SLIDE_COPY)}}/g, (_, key: string) => slots[key]);
  text += `\n\n${contentHierarchyDirection}\n本页核心信息（仅作为语义指导，不新增画面文字）：${spec.coreMessage}`;
  if (spec.forbidden.length) text += '\n\n本页避免：' + spec.forbidden.join('；');
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}
