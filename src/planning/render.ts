import type { Brief, Outline, SlideSpec } from "./schemas.js";

function literalMarkdownText(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replace(/([`*_{}\[\]()#+.!|])/gu, "\\$1");
}

function literalList(values: readonly string[]): string {
  return values.map((item) => `- ${literalMarkdownText(item)}`).join("\n");
}

export function renderBrief(value: Brief): string {
  return `# ${literalMarkdownText(value.title)}\n\n- 用途：${literalMarkdownText(value.purpose)}\n- 受众：${literalMarkdownText(value.audience)}\n- 语言：${literalMarkdownText(value.language)}\n- 目标页数：${value.targetSlides}\n\n## 必须覆盖\n\n${literalList(value.mustCover)}\n\n## 限制\n\n${literalList(value.constraints)}\n`;
}

export function renderOutline(value: Outline): string {
  const slides = [...value.slides]
    .sort((left, right) => left.order - right.order)
    .map((slide) => `## ${slide.order + 1}. ${literalMarkdownText(slide.title)}\n\n- ID：${slide.id}\n- 类型：${literalMarkdownText(slide.role)}\n- 目的：${literalMarkdownText(slide.purpose)}\n- 来源：${slide.sourceRefs.map(literalMarkdownText).join("、")}\n`)
    .join("\n");
  return `# 整套页面大纲\n\n${slides}`;
}

export function renderSlideSpec(value: SlideSpec): string {
  return `# ${literalMarkdownText(value.title)}\n\n- 页面 ID：${value.slideId}\n- 类型：${literalMarkdownText(value.role)}\n- 核心观点：${literalMarkdownText(value.coreMessage)}\n- 视觉主体：${literalMarkdownText(value.visualSubject)}\n- 构图：${literalMarkdownText(value.composition)}\n\n## 必须文字\n${literalList(value.requiredText)}\n\n## 关系\n${literalList(value.relationships)}\n\n## 禁止\n${literalList(value.forbidden)}\n`;
}
