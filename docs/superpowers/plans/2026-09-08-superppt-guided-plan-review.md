# SuperPPT Guided Plan Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Follow the current session's delegation authorization and tool availability.

**Goal:** 让 SuperPPT 按需逐题澄清内容，并在同一方案确认页上回看内容、选择风格、提交修改或明确授权样页。

**Architecture:** 延续现有 planning → plan-review 和三个业务决策点。规划上下文在任务目录保存，发布时纳入不可变方案；HTML 由方案快照生成，只输出给 Agent 的可读回复。决定执行复用当前 decisionId 校验，不增加 Web 后端。

**Tech Stack:** Node.js >=22.6、TypeScript、Zod 4、现有静态 HTML/CSS/浏览器 JavaScript、node:test、tsx。

**Spec:** [已确认设计](../specs/2026-09-08-superppt-guided-plan-review-design.md)。用户已先确认方向，再确认具体设计稿。

## Global Constraints

- 正常流程仍是三个业务决策点。
- 完整素材不强制经过访谈；内容、大纲、风格不分别新增审批门。
- 只点击风格、翻页、展开内容或复制普通选款文本，不视为生成授权。
- 页面选择与填写意见仅更新页面草稿，不修改任务状态或发起生图。
- 有待提交修改意见时，先提交修改并回看新方案。
- 旧页面的回复不能误授权新方案。
- 不改变已接受的模板、34 个运行配方或独立生图依赖；90 张图床图片不是 90 个运行配方。
- 当前 HTML 真实浏览器验收曾被宿主策略阻断；不能绕过明确限制或用静态测试冒充 UI 验收。
- 工作区为 `/Users/neomei/项目/codexprojects/SuperPPT/.worktrees/fast-workflow`，分支为 `codex/superppt-spec-baseline`。该目录没有 `.codegraph/`，不能借用外层其他分支的索引。
- 工作区含前一轮图床迁移与自定义 token 修复的未提交改动。执行前记录基线，不还原这些改动，也不把它们误记成本任务实现；无法拆分提交时保留未提交状态并报告。

## 文件职责与任务依赖

| 文件 | 责任 |
| --- | --- |
| `src/planning/context.ts`（新增） | 当前有效回答、假设、叙事摘要及规划草稿的读写校验 |
| `src/planning/review-model.ts`（新增） | 将已发布方案转换为展示数据，构造明确的确认／修改回复 |
| `src/planning/review-view.ts`（新增） | 方案区块 HTML、意见输入及页面交互安装函数 |
| `src/workflow/contracts.ts` | PlanBundle 增加可选规划上下文；旧本版任务没有该字段仍能读取 |
| `src/workflow/continue.ts` | 将上下文文件路径和问答指引交给规划 Agent |
| `src/workflow/planning.ts` | 固化上下文，用同一 decisionId 发布方案页与决定，提供对话回退摘要 |
| `src/workflow/decide.ts` | 修订方案时将上一版有效上下文交给下一轮规划；保留已有决定校验 |
| `src/styles/selection-view.ts` | 承载方案区块，保留原两轮风格选择和图片失败行为 |
| `skills/superppt/SKILL.md`、`references/依赖说明.md` | 问答准则、文件交接、页面与纯对话确认语义 |
| `tests/planning-context.test.ts`、`tests/plan-review.test.ts`（新增） | 上下文恢复、冻结、展示、回复与旧版本边界 |
| `tests/style-selection.test.ts`、`tests/fast-cli.test.ts`、`tests/release-install.test.ts` | 保留选款测试并扩展完整安装流程验证 |

执行顺序：任务 1 → 任务 2 → 任务 3 → 任务 4。各任务测试通过后审查其差异；最后审查整组变更。

## Task 1：持久化规划上下文与按需问答

**Files:** 新增 `src/planning/context.ts`、`tests/planning-context.test.ts`；修改工作流 contracts、continue、planning、decide 及运行 Skill／依赖说明。

**Interfaces:**

```ts
export type PlanningContext = {
  schemaVersion: 1;
  narrativeSummary: string;
  answers: Array<{ key: string; value: string; kind: 'fact' | 'preference' }>;
  assumptions: string[];
};
export const PlanningContextSchema: z.ZodType<PlanningContext>;
export function planningContextPath(revision: string): string;
export function readPlanningContext(root: string, revision: string): Promise<PlanningContext>;
export function ensurePlanningContext(root: string, revision: string, previousPlanPath?: string): Promise<string>;
```

路径固定为 `planning/<revision>/context.json`。`readPlanningContext` 只在 ENOENT 时返回空上下文；损坏 JSON、非法种类、重复 key 必须报错。`ensurePlanningContext` 保留已有草稿，无草稿时从上一版 PlanBundle.context 初始化，否则创建空上下文。所有路径通过 task-store 的受限路径与原子写入函数处理。

- [x] 记录执行前 git 状态、差异及前轮验收结果到 `.artifacts/guided-plan-review/`；确认当前分支与工作目录。
- [x] 在新增测试中先验证上下文契约及拒绝行为：

```ts
const context = {
  schemaVersion: 1, narrativeSummary: '问题、试点、投入与决策',
  answers: [{ key: 'goal', value: '批准试点', kind: 'preference' }],
  assumptions: ['按十分钟口头汇报组织'],
};
assert.deepEqual(PlanningContextSchema.parse(context), context);
assert.equal(PlanningContextSchema.safeParse({
  ...context, answers: [...context.answers, ...context.answers],
}).success, false);
assert.equal(PlanningContextSchema.safeParse({
  ...context, answers: [{ key: 'revenue', value: '100', kind: 'guess' }],
}).success, false);
```

- [x] 运行 `node --import tsx --test tests/planning-context.test.ts`，记录缺少模块／契约导致的预期失败。
- [x] 实现 schema 及文件助手。PlanBundle 增加 `context: PlanningContextSchema.optional()`；不要为旧计划解析时自动添加字段，以免改变已发布方案的序列化哈希。
- [x] 在规划 request 增加 `planningContextPath`。Agent 每次收到回答就更新有效上下文；恢复时先读该文件和源材料，再问下一个必要问题。问答仍属于现有 plan work。
- [x] 发布新方案时，payload.context 若存在则校验并采用；否则读取当前草稿，写入发布的 plan.json。已发布方案重复提交时，遗漏 context 的重放使用已发布 context 参与比较，不重新读取可变草稿；显式不同的 context 按已有「Published plan changed」路径拒绝。
- [x] revise-plan 后的新 revision 从旧 plan.context 初始化；未改变页 ID、完整文案及生图缓存逻辑保持原行为。
- [x] 增加真实文件测试：读写恢复、无文件默认值、损坏文件拒绝、修订继承、发布后草稿变化不影响已发布方案、重复发布不变、新增显式上下文修改被拒绝。
- [x] 更新 Skill 问答规则：完整材料直接规划；逐题询问高影响缺口；推荐项附理由；合并用户一次给出的多个答案；低影响假设可见；不能编造数字或承诺；不强制多套方案或重构原稿。
- [x] 以完整文稿、只有主题、一次多答、中断恢复四个应用场景验证 Agent 行为，记录实际回答与未覆盖边界；文字匹配测试不能替代这些场景。
- [x] 运行上下文测试及 `npm run lint:types`，审查差异。
- [x] `feat: persist guided planning context` 对应实现已随完整 guided 功能提交保存；控制器按执行前快照将 token 修复和图床迁移拆为独立提交，任务间共享文件归入同一 guided 提交。

## Task 2：从同一方案快照产生确认模型

**Files:** 新增 `src/planning/review-model.ts`、`tests/plan-review.test.ts`；修改 `src/workflow/planning.ts`。

**Interfaces:**

```ts
export type ReviewModel = {
  revision: string;
  decisionId: string;
  narrativeSummary: string;
  answers: PlanningContext['answers'];
  assumptions: string[];
  slides: Array<{
    id: string; number: number; title: string; coreMessage: string;
    requiredText: string[]; relationships: string[]; sourceRefs: string[];
    isSample: boolean;
  }>;
  variants: Record<string, { choice: string; prompt: string }>;
  references: Array<{ path: string; role: string }>;
  callBudget: 1;
  output: string;
};
export type ReviewNote = { label: string; text: string };
export function buildReviewModel(plan: PlanBundle, revision: string, decisionId: string): ReviewModel;
export function reviewReply(model: ReviewModel, variantKey: string | null, notes: ReviewNote[]): string;
```

`variants` 以 `styleId/level/paletteId` 为键；prompt 必须是 `compileSlidePrompt` 输出加两个换行及 `submissionNote(plan.brief)` 的实际出站文本。构造模型时只从计划快照取内容和样式，不读取当前全局 catalog，也不访问网络。

- [x] 写失败测试：模型保留完整 requiredText、页序和样页标记；自定义风格不会被内置目录替代；每个 prompt 与现有提交边界结果完全相同。
- [x] 运行 `node --import tsx --test tests/plan-review.test.ts` 并记录预期失败。
- [x] 实现模型。没有 context 时使用空上下文，叙事摘要缺失明确显示「未提供叙事摘要」，不伪造一句已确认结论。
- [x] 实现回复构造的三个互斥分支：

```ts
const notesText = notes.filter(note => note.text.trim())
  .map(note => `${note.label}：${note.text.trim()}`).join('\n');
const identity = `方案版本：${model.revision}\n决定编号：${model.decisionId}`;
if (notesText) return `请修改方案，暂不生成样页。\n${identity}\n${notesText}`;
if (!variantKey || !Object.hasOwn(model.variants, variantKey)) return '';
return `确认当前内容方案并生成样页。\n${identity}\n${model.variants[variantKey]!.choice}\n授权新增生图调用：1 次。`;
```

- [x] 增加用例：无选择返回空文本；非法组合不形成授权；有修改意见时回复只包含修改语义；授权文本绑定 revision、decisionId、组合及预算 1。
- [x] publishPlan 在写 HTML 前选定同一个 pending decisionId，模型和状态提交复用该 ID；保留已有重复发布路径，不为页面单独随机创建决定。
- [x] 在 plan-review details 提供 contentRevision 和当前规划上下文摘要；对话正文保持完整内容入口，明确图片可能联网加载，普通选款不等于授权生成。
- [x] 使用现有 fixtureTask／fixturePlan 运行集成测试：发布 A → revise-plan → 发布 B → 提交 A 页面的 decisionId，须由既有 decideTask 拒绝，且 B 的 activeJobId 保持 null。
- [x] 运行新测试、`tests/style-options.test.ts` 和 `npm run lint:types`，审查差异。
- [x] `feat: bind plan review replies to published decisions` 对应实现已随完整 guided 功能提交保存；控制器按执行前快照将 token 修复和图床迁移拆为独立提交，任务间共享文件归入同一 guided 提交。

## Task 3：扩展现有 HTML 为完整方案确认页

**Files:** 新增 `src/planning/review-view.ts`；修改 `src/styles/selection-view.ts`、`src/workflow/planning.ts`、`tests/plan-review.test.ts`、`tests/style-selection.test.ts`。

**Interfaces:**

```ts
export function renderReviewContent(model: ReviewModel): string;
export function installReviewInteractions(model: ReviewModel): void;
// StyleSelectionView 增加 review?: ReviewModel。
// 未传 review 的原选款渲染接口继续有效。
```

`renderReviewContent` 返回整体摘要、事实与偏好、假设、逐页卡片、完整文字 details、来源、意见 textarea 和样页说明。选款布局仍由 selection-view 负责，避免复制整份样式选择器。

- [x] 先写失败测试：完整长文案可在 HTML 中找到，页序正确；恶意标题／正文／意见标签不会形成 HTML 节点或闭合 script；34 个选择组合及缺图提示保持。
- [x] 运行新测试，确认因缺少方案区块失败。
- [x] 增加带 label 的整体及逐页意见输入、样页标记，以及选定组合后的完整 prompt 展开区。每个选择按钮增加明确的 variant key，不能从显示文案反向解析组合。
- [x] 以 textContent 填写动态文本。初始 HTML 使用完整实体转义；传入脚本的 JSON 至少将 `<` 编码为 `\u003c`，不能直接插入用户正文。
- [x] 实现页面状态：

```ts
const hasNotes = notes.some(note => note.text.trim());
const hasVariant = selectedKey !== null && Object.hasOwn(model.variants, selectedKey);
confirmButton.disabled = !hasVariant || hasNotes;
reviseButton.disabled = !hasNotes;
const reply = reviewReply(model, selectedKey, notes);
```

- [x] 确认按钮标明「复制确认回复」，说明复制后发送给 Agent 才会执行。修改按钮只复制修改意见。页面标明草稿未提交、刷新不保证保留；不显示「已提交」「已保存」假状态。
- [x] 复用 attemptClipboardCopy 的异步剪贴板与旧接口回退。两者失败时显示并选中完整可读回复，用户可以手动复制；不能回退为仅风格选择文本而丢失版本／预算或意见。
- [x] 保持图片懒加载、referrerpolicy、加载失败提示和完整纯对话回退。内容与修改意见只留本地页面，不使用远端请求或外部分析脚本。
- [x] 测试完整授权、意见输入后禁用授权、清空意见后恢复、换风格更新确切 prompt、复制失败和特殊字符；自动化只证明所执行的逻辑／结构，不表述为真实浏览器验收。
- [x] 运行新测试及 `tests/style-selection.test.ts`、`tests/remote-style-assets.test.ts`、`npm run lint:types`，审查差异。
- [x] `feat: add visual plan review and revision feedback` 对应实现已随完整 guided 功能提交保存；控制器按执行前快照将 token 修复和图床迁移拆为独立提交，任务间共享文件归入同一 guided 提交。

## Task 4：完整工作流与交互验收

**Files:** 修改 `tests/fast-cli.test.ts`、`tests/release-install.test.ts`、`skills/superppt/SKILL.md`、`skills/superppt/references/依赖说明.md`、`docs/specs/README.md`、`docs/specs/visual-design-and-selection.md`；报告写入 `.artifacts/guided-plan-review/`。

- [x] 在现有 3 页和 12 页公共 CLI 流程中验证 request 的上下文路径、发布页的内容卡片、同一个 decisionId 和实际样页 prompt。仅把明确授权交给 decideTask 后才允许出现生成工作。
- [x] 保留并验证现有流程断言：8 次公共命令、3 次决定、一次完整批次、已批准样页复用，以及交付与批准文件字节相同。需要额外修订的测试另建场景，不削弱正常路径断言。
- [x] 加入「规划中保存回答 → 恢复 → 发布 → 修改某页 → 新方案回看 → 拒绝旧页面确认 → 确认新方案」的完整测试，核对未变页 ID 和状态，不触发真实付费生图。
- [x] 更新 Skill 原生回退路径与例子：对话和页面都披露相同方案、确切已选 prompt、预算和生成动作；接收带版本的回复时不得用新 decisionId 静默替换旧 ID。
- [x] 运行 `npm run verify:full`，源码、类型、构建和编译测试及依赖门禁全部成功后，再运行 `npm run test:release-install`。安装包继续只包含远端图片索引，不重新打包设计图或凭据。
- [ ] 在宿主明确允许打开的方式下，实际操作一个 12 页方案页：展开第 12 页完整文案，选择玻璃三档偏冷，查看 prompt，填写第 2 页修改意见，验证确认按钮禁用，复制修改，清空意见，再复制确认回复并检查版本／预算。当前宿主本地 URL 策略明确阻断，未执行。
- [ ] 实测窄视口和剪贴板失败回退。当前宿主本地 URL 策略明确阻断，未执行。
- [x] 记录真实浏览器阻断与未验项目；未更换服务端、浏览器或自动化通道绕过限制，未将生成脚本逻辑测试标成真实交互通过。
- [x] 对照设计的全部验收行逐项附证据；复查三次确认、原文保留、当前有效上下文及错误处理。只有新缺陷／改动才触发相应复测。
- [x] 更新文档中的「未实现／已实现／真实交互未验收」状态，准确报告发布和宿主安装状态；未自动推送、合并或发布。

## 计划自查

设计第 3 节由任务 1 覆盖；第 4 节由任务 2／3 覆盖；第 5 节的提交、预算和旧版本边界由任务 2／3／4 覆盖；第 6 节的恢复、数据权威源和回退由任务 1／2／3 覆盖；第 7／8 节由任务 4 验证。实现不依赖图床写入权限，也不需要再次提供上传凭据。

此文件同时记录实施状态：已勾选项已执行；未勾选项仅包括被当前宿主本地 URL 策略阻断的真实浏览器／窄视口／剪贴板验收。既有图床迁移测试不能当作本计划的实现证据。
