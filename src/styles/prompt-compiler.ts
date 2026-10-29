import { createHash } from 'node:crypto';
import { SlideSpecSchema, type SlideSpec } from '../planning/schemas.js';
import { ResolvedStyleSchema, type ResolvedStyle } from './schemas.js';

export type CompiledPrompt = { text: string; sha256: string };
export const contentHierarchyDirection = `内容优先与视觉层级（必须遵守）：
先让观众一眼读懂本页核心信息，再阅读辅助说明；文字、标题、关键数字和必要说明是首要阅读主线。图形必须直接解释核心信息或真实内容关系，只能服务阅读路径，不得成为脱离文案的独立主视觉、装饰背景或抢占焦点。
先为完整文字和托底预留主体阅读空间：文字区域约占正文区域的 65%—75%，图形及连接约占 25%—35%，比例是设计参考，可根据内容和页型灵活调整。每组标题与完整说明放在足够宽、对比清楚的实体或半透明托底面上，字号大而易读；托底材质遵循所选风格，不固定颜色、模块数量或版式。让相关图形紧邻文字并解释含义，先安排完整文字与托底，再围绕文字安排简洁图形，不得压缩、遮挡、拆散或弱化完整文案，不添加无来源的评分、数字、箭头或关系。
当风格参考图或其他风格指令与文字占比、托底或内容主次冲突时，以本段为准；材质、配色和创意气质仍遵循所选风格。`;
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
