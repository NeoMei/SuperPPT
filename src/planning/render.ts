import type { Brief, Outline, SlideSpec } from "./schemas.js";

export function renderBrief(value: Brief): string {
  return `# ${value.title}\n\n- 用途：${value.purpose}\n- 受众：${value.audience}\n- 语言：${value.language}\n- 目标页数：${value.targetSlides}\n\n## 必须覆盖\n\n${value.mustCover.map((item) => `- ${item}`).join("\n")}\n\n## 限制\n\n${value.constraints.map((item) => `- ${item}`).join("\n")}\n`;
}

export function renderOutline(value: Outline): string {
  const slides = [...value.slides]
    .sort((left, right) => left.order - right.order)
    .map((slide) => `## ${slide.order + 1}. ${slide.title}\n\n- ID：${slide.id}\n- 类型：${slide.role}\n- 目的：${slide.purpose}\n- 来源：${slide.sourceRefs.join("、")}\n`)
    .join("\n");
  return `# 整套页面大纲\n\n${slides}`;
}

export function renderSlideSpec(value: SlideSpec): string {
  return `# ${value.title}\n\n- 页面 ID：${value.slideId}\n- 类型：${value.role}\n- 核心观点：${value.coreMessage}\n- 视觉主体：${value.visualSubject}\n- 构图：${value.composition}\n\n## 必须文字\n${value.requiredText.map((item) => `- ${item}`).join("\n")}\n\n## 关系\n${value.relationships.map((item) => `- ${item}`).join("\n")}\n\n## 禁止\n${value.forbidden.map((item) => `- ${item}`).join("\n")}\n`;
}
