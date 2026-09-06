---
name: superppt
description: Use when users want to make a high-detail presentation from a topic, pasted content or Markdown, or revise selected pages of a SuperPPT task.
---

# SuperPPT

将内容做成高细节、图片优先的整套 PPTX。默认只在三个决定处等待：
内容方案与选款（风格 → 档位 → 配色，同时授权样页）→ 样页回看（同时授权整套）→ 完整 PPTX 回看与交付。
风格只能单选。详细输入见 [CLI 与机器工作](references/依赖说明.md)。

## 操作节奏

先解析本 Skill 的物理安装位置，插件根目录是其所在目录的上两层。
通过当前宿主技能目录明确解析 ai-image-to-ppt 和 image-to-editable-pptx，不扫描用户主目录。
新建空任务目录，执行 start；中断的本版任务执行 continue。
旧任务不迁移、不读取继续，也不删除。需要时另建新目录。

以 continue 返回值行动：

- kind: work：立即读取 inputPath，完成机器工作并回传 result；不问用户“是否继续”。
- kind: decision：展示当前内容供用户决定，收到对应选择后执行 decide。
- kind: attention：解释具体缺失产物、失败或未明请求；不声称成功，不自动追加付费。
- kind: done：直接展示返回的语义文件名 PPTX 链接。

规划时一次写完整 Brief、Outline、逐页 SlideSpec 和可用真实风格候选。
读取 assets/styles/catalog.json，当前提供立体、玻璃、水墨。按“风格 → 档位 → 配色”展开已有选项：档位显示 1／2／3，配色使用该风格的偏冷／基准中线／偏暖。
用 details.previewBase 加 previews[].path 展示所选 level、paletteId 对应的已有图片。没有精确预览时，明确说明缺图；可分别展示同风格的档位参考与配色参考，逐张标明差异，不把参考图冒充该组合，不现场生图选款。这仍是同一次 plan-review，不增加逐步确认关卡。
保留源内容结构、来源覆盖和精确 requiredText（包含独立标题及全部可见文字，不删减、不限制行数）。relationships 只描述内容含义与关系；实际背景、承载图形和构图由生图模型根据内容决定。
只追问影响结果的缺失事实，不分别确认大纲、逐页说明和风格。

## 生图与检查

在 plan-review 展示完整方案、选中组合的样页内容 prompt、参考图用途、1 次调用预算和输出位置；确认选款即授权样页。内容 prompt 从 details.samplePromptsPath 按 styleId/level/paletteId 取出，不把所有组合的长 prompt 展开到对话。
在 sample-review 展示实际样页、整套 prompt、参考图用途、整套页数、复用页数、新生成页数与新增调用预算、输出位置；确认即授权整套。按 details.callBudget 披露和提交新增预算，不把整套页数当调用数。
用户确认无须修改的样页直接进入正式 PPT 的原对应页，不重画、不换图；只生成未缓存页。三页正常路径共调用三次：样页一次，剩余两页两次。内容、风格、档位、配色或用途改变时重新规划，按新批次缓存状态执行；用户要求重画某页时走 regenerate-page。未通过内容检查的样页不能替用户批准。
两处同时披露 details.submissionNote：实际出站文本 = 原内容 prompt + 两个换行 + 此用途说明。用途取已有 brief 的 purpose、audience，不新增分析或确认步骤。

每个 generate-batch work 整体交给 ai-image-to-ppt 一次，沿用其 SerialStickyRouter 和当前可调用宿主能力。
按 [批次工作说明](references/依赖说明.md#批次执行) 执行：串行、成功页复用、每次请求前累计预算、正常路径只回传一个聚合结果。
使用 job.styleLock.recipe 中锁定的 id、level、paletteId、promptTemplate、逐页确切 prompt 和批准样页；样页到整套沿用同一快照，不重新挑配色或重写档位。只替换每页内容关系与完整文案，不再叠加前中后景、微装饰或预设构图，不追加依赖默认风格。宿主原图 raw 与严格 16:9 master 都保留。
实际提交宿主或 API 时，原样发送 beginRequest 返回的完整 prompt：它在原内容后附加真实用途说明，让模型自行决定适当表达。该说明不是画面文案；不改内容规划、正文、风格、档位或配色，不增加预筛查或模型调用，也不承诺通过安全过滤。拒绝仍按既有失败流程处理。
原图不能直接当成可编辑 PPTX。两个依赖保持独立，不复制其实现。

review-images 时实际查看全部图片，逐项核对文字、风格、层级与禁用内容。
检查通过后 CLI 自动组装整套 PPTX。最后展示一个完整 PPTX 链接以及“修改某页 / 返回修改内容或风格 / 确认交付”。

## 改稿与完成

用户主动返工时使用 [修改路由](references/修改路由.md)。
手动：给完整候选文件链接，等待“已保存并关闭”；采纳用户保存的原文件，不重新组装。
Agent：只修改目标页，展示完整候选，确认后才切换当前版本。图像页按需仅转换这一页。
每次修改从最新完整文件开始；未修改页和已有人工调整保留。恢复上一版只切换当前指针。

交付输出为 交付/<项目标题>.pptx，字节与已确认当前文件相同。只给一个最终文件链接。
自动化测试不能证明 WPS/PowerPoint 实际编辑效果；没有做 GUI 编辑、保存和重新打开，就明确未验证。
