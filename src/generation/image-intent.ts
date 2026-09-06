import { z } from 'zod';

export const GenerationIntentSchema = z.object({ purpose: z.string().min(1), audience: z.string().min(1) });
export function submissionNote(intent: z.infer<typeof GenerationIntentSchema>): string {
  return `【生图用途说明（非画面文字）】
本图用于 PPT。实际用途：${intent.purpose}
面向受众：${intent.audience}
请准确表达原文含义，自行选择适合上述用途的图示与呈现方式；保持指定风格、创意档位、配色及全部可见文案不变。此说明不作为画面文字。`;
}
