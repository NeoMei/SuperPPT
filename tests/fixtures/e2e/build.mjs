import { mkdir, writeFile } from "node:fs/promises";

const root = new URL("./", import.meta.url);
const slides = [
  { id: "00000000-0000-4000-8000-000000000701", order: 0, title: "AI Agent 协作系统与六类角色", role: "cover", purpose: "建立主题", sourceRefs: ["L1-L2"], coreMessage: "一个系统协同多个专家", requiredText: ["AI Agent 协作系统"], visualSubject: "central orchestration core", composition: "hero core", relationships: ["core coordinates specialists"] },
  { id: "00000000-0000-4000-8000-000000000702", order: 1, title: "六类角色如何形成闭环", role: "process", purpose: "解释流程", sourceRefs: ["L3-L6"], coreMessage: "规划到反馈形成闭环", requiredText: ["规划", "记忆", "工具", "执行", "评估", "反馈"], visualSubject: "six specialist stations", composition: "clockwise closed loop", relationships: ["feedback improves planning"] },
  { id: "00000000-0000-4000-8000-000000000703", order: 2, title: "交付价值：稳定、可追踪、可迭代", role: "summary", purpose: "总结交付价值", sourceRefs: ["L7-L8"], coreMessage: "稳定编排带来可追踪交付", requiredText: ["稳定", "可追踪", "可迭代"], visualSubject: "converging delivery horizon", composition: "three outcomes converge", relationships: ["orchestration produces outcomes"] },
];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
await writeFile(new URL("source.md", root), "# AI Agent 协作系统\n\n一个编排核心协调多个专家。\n规划、记忆、工具、执行、评估和反馈形成闭环。\n\n稳定编排带来可追踪、可迭代的交付。\n");
await writeFile(new URL("brief.json", root), json({ schemaVersion: 1, title: "AI Agent 协作系统", purpose: "解释协作编排", audience: "产品与技术团队", language: "zh-CN", targetSlides: 3, mustCover: ["六类角色", "闭环", "交付价值"], constraints: ["16:9", "无水印"] }));
await writeFile(new URL("outline.json", root), json({ schemaVersion: 1, slides: slides.map(({ coreMessage, requiredText, visualSubject, composition, relationships, ...outline }) => outline) }));
for (const slide of slides) {
  const directory = new URL(`slides/${slide.id}/`, root);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("spec.json", directory), json({ schemaVersion: 1, slideId: slide.id, title: slide.title, role: slide.role, coreMessage: slide.coreMessage, requiredText: slide.requiredText, visualSubject: slide.visualSubject, composition: slide.composition, relationships: slide.relationships, forbidden: ["watermark", "unreadable text"], sourceRefs: slide.sourceRefs }));
}
