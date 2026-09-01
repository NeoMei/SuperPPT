# SuperPPT

SuperPPT 把主题描述、粘贴文本或 Markdown 变成一套高细节、图片优先的本地 PPTX。它的核心不是一次性“生成完毕”，而是一条可检查、可退回、可继续修改的引导路径。

## 引导创建

1. 保留原始输入，只追问会真正改变成品的内容。
2. 依次展示并等待用户决定：完整大纲、逐页描述、内容相关的紧凑风格单选、样页调用授权、真实样页、整套生成授权、完整 deck 审阅。
3. 风格在内容推荐之后从 10 种紧凑选项中选择；推荐只依据前序内容，风格只能单选。一个经样页确认的 Style Lock 以字节和哈希不变的方式交给 `ai-image-to-ppt`，保持整套一致。

其中恰好 3 个普通确认是大纲、逐页描述和真实样页。样页生成与整套生成另有执行授权，完整 deck 另有审阅决定；任何一项都不能替代或推断另一项。
4. 每个决定点都必须停下来等待；不从输入静默跑到最终 PPTX。

用户随时可以返回“修改大纲 / 修改第 N 页描述 / 换风格”。SuperPPT 会先展示受影响的稳定页面 ID、失效产物和恢复阶段，等待确认后才创建新版本。

## 完整 deck 修改

WPS 或 PowerPoint 是预览与编辑界面。每次编辑响应只交付一个可点击的完整本地 PPTX 链接，并显示任何 `reviewRequired` 对象标签。

- 手动循环：按 current 完整 deck 的对账后页序把第 N 页解析成稳定 ID，复制精确 current 文件为完整 candidate，展示唯一链接后停止。用户在 WPS/PowerPoint 中修改、原位保存、关闭，并精确回复 `已保存并关闭`。采纳只稳定读取、校验结构、对账移动/插入/删除后的 topology，并移动 current pointer；不在保存后改写 PPTX。
- Agent 循环：从精确 current 完整 deck 创建 candidate，只改目标页已认证对象，展示唯一链接、修改摘要和 SHA-256 后停止。只有用户精确回复 `确认`，且确认绑定所展示哈希时，current pointer 才切换。
- 连续修改：“再改第 N 页”始终按最新对账 topology 解析，下一个 candidate 从上一次采纳的精确字节创建。
- 恢复：“恢复上一版”只移动 current pointer，不重写任何历史 PPTX。

可编辑边界依旧取决于 `image-to-editable-pptx` 的可验证提取结果：只有指定对象成功提取后才可编辑；可靠文字与透明素材走 editable 路由，主插画、背景、整体布局和未提取对象走定向重生路由。这不是整套全可编辑。

## 依赖与本地开发

SuperPPT 只编排两个显式本地 Skill 依赖：`ai-image-to-ppt` 和稳定版 `image-to-editable-pptx >=0.2.0 <0.3.0`。依赖 contract 保持 v3，workflow preflight binding 保持 v2；不随 SuperPPT 捆绑或静默安装。每次外部调用前会披露出站文本、参考图用途、页数/调用次数和输出位置。

SuperPPT 需要 Node.js 22.6 或更高版本。

```bash
npm ci
bash scripts/verify.sh
```

当前未进行 push、npm 发布或生产部署；本地验证不等于发布状态。

## V1 限制

只接收描述、粘贴文本和 Markdown；不直接摄取 DOCX、PDF 或现有 PPTX。

修改验收只使用唯一完整本地 PPTX，不生成 PDF、蒙太奇、预览渲染或单页 donor。
内置样式配方沿用 1280×720 设计坐标；编辑交付仍只有完整本地 PPTX，不向用户提供或要求渲染 PNG。
