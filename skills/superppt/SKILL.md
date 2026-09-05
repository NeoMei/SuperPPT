---
name: superppt
description: Use when users want to make a high-detail presentation from a topic, pasted content or Markdown, or revise selected pages of a SuperPPT task.
---

# SuperPPT

将内容做成高细节、图片优先的整套 PPTX。默认只在三个决定处等待：
内容方案与风格选择（同时授权样页）→ 样页回看（同时授权整套）→ 完整 PPTX 回看与交付。
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

规划时一次写完整 Brief、Outline、逐页 SlideSpec 和 1–3 种真实风格候选。
读取 assets/styles/catalog.json，使用真实预览图紧凑展示。保留源内容结构、来源覆盖和精确 requiredText。
只追问影响结果的缺失事实，不分别确认大纲、逐页说明和风格。

## 生图与检查

在 plan-review 展示完整方案、各风格的样页出站 prompt、参考图用途、1 次调用预算和输出位置；选择即授权样页。
在 sample-review 展示实际样页、整套 prompt、参考图用途、页数、调用预算和输出位置；确认即授权整套。

每个 generate-batch work 整体交给 ai-image-to-ppt 一次，沿用其 SerialStickyRouter 和当前可调用宿主能力。
按 [批次工作说明](references/依赖说明.md#批次执行) 执行：串行、成功页复用、每次请求前累计预算、正常路径只回传一个聚合结果。
使用选中的 recipe、逐页 prompt 和批准样页；不追加依赖默认风格。宿主原图 raw 与严格 16:9 master 都保留。
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
