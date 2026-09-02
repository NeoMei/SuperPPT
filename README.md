# SuperPPT

SuperPPT 把主题描述、粘贴文本或 Markdown 变成一套高细节、图片优先的本地 PPTX。它的核心不是一次性“生成完毕”，而是一条可检查、可退回、可继续修改的引导路径。

## 引导创建

1. 保留原始输入，只追问会真正改变成品的内容。
2. 依次展示并等待用户决定：完整大纲、逐页描述、`style-selection` 内容相关的紧凑风格单选、样页调用授权、真实样页、整套生成授权、完整 deck 审阅。
3. 风格在内容推荐之后从 10 种紧凑选项中选择；推荐只依据前序内容，风格只能单选。`style-selection --input` 把用户选择、代表页 stable ID 和 current project revision 一起认证为 v2 evidence，并绑定同源 Style Lock hash；未选择不得进入样页授权。匹配 current revision 的旧 v1 选择会由该公开路由原子迁移为 canonical v2，但 v1 本身绝不能发布样页生成计划。完全相同的重试可恢复 lock/selection/manifest 三阶段中断；任何不匹配证据均保持原字节并 fail closed。版本变化后只能退役由当前项目严格旧 revision、子 revision descriptor anchor 和 immutable snapshot v2 共同精确绑定的 selection→lock→recipe 字节；退役通过可重放事务跨三个删除边界恢复，而不是裸 unlink。Project rollback 从同一 descriptor-bound 快照恢复三份精确字节与 `manifest.style`/stage，不依赖后续 style-sample gate；仅互相自洽、未知 revision 或不安全快照绝不删除或恢复。一个经样页确认的 Style Lock 以字节和哈希不变的方式交给 `ai-image-to-ppt`，保持整套一致。

其中恰好 3 个普通确认是大纲、逐页描述和真实样页。样页生成与整套生成另有执行授权，完整 deck 另有审阅决定；任何一项都不能替代或推断另一项。
4. 每个决定点都必须停下来等待；不从输入静默跑到最终 PPTX。

用户随时可以返回“修改大纲 / 修改第 N 页描述 / 换风格”。SuperPPT 会先展示受影响的稳定页面 ID、失效产物和恢复阶段，等待确认后才创建新版本。

## 完整 deck 修改

WPS 或 PowerPoint 是预览与编辑界面。每次编辑响应只交付一个可点击的完整本地 PPTX 链接，并显示任何 `reviewRequired` 对象标签。

- 手动循环：按 current 完整 deck 的对账后页序把第 N 页解析成稳定 ID 与 `revisionId`，把两者原样传给 `prepare-manual-deck --revision-id`；若 current 已变就拒绝并重新解析，不在新 revision 上静默继续。随后复制该精确 current 文件为完整 candidate，展示唯一链接后停止。WPS-native unmanaged 插入页也可直接再次手工编辑，无 converter。用户在 WPS/PowerPoint 中修改、原位保存、关闭，并精确回复 `已保存并关闭`。采纳只稳定读取、校验结构、对账移动/插入/删除后的 topology 和 slide XML，记录实际 changed stable IDs，并移动 current pointer；不在保存后改写 PPTX。
- Agent 循环：从精确 current 完整 deck 创建 candidate，只改目标页已认证对象，展示唯一链接、修改摘要和 SHA-256 后停止。只有用户精确回复 `确认`，且确认绑定所展示哈希时，current pointer 才切换。
- 连续修改：“再改第 N 页”始终按最新对账 topology 解析，下一个 candidate 从上一次采纳的精确字节创建。
- 恢复：“恢复上一版”只移动 current pointer，不重写任何历史 PPTX。手动采纳、Agent 确认/拒绝和 rollback 都回到 `deck-review`，重绑 exact current revision/SHA 并清除旧交付绑定。

完整 deck 审阅的三选一使用 `complete-deck-review --action <edit-page|return-upstream|confirm-delivery> --revision-id --sha256 [--slide-id]`。`edit-page` 会持久化一个只能消费一次的 exact current revision/SHA/stable slide binding；manual/Agent prepare 缺失、错页、stale 或重放时必须在创建 candidate/session 前拒绝并且零残留。只有 `confirm-delivery` 进入 `delivered`；formal delivery、exports、acceptance 和 client metadata 全部引用同一 exact current revision/absolute path/SHA，不复制或重写 PPTX。固定 revision acceptance 路径可幂等重放与崩溃恢复；已有相同 evidence 重用，冲突则 fail closed 且不删除用户文件。旧 `acceptance-smoke-copy`、`acceptance-record` 实现与入口不再发布。

可编辑边界依旧取决于 `image-to-editable-pptx` 的可验证提取结果：只有指定对象成功提取后才可编辑；可靠文字与透明素材走 editable 路由，主插画、背景、整体布局和未提取对象走定向重生路由。这不是整套全可编辑。

## 依赖与本地开发

SuperPPT 只编排两个显式本地 Skill 依赖：`ai-image-to-ppt` 和稳定版 `image-to-editable-pptx >=0.2.0 <0.3.0`。依赖 contract 保持 v3，workflow preflight binding 保持 v2；不随 SuperPPT 捆绑或静默安装。每次外部调用前会披露出站文本、参考图用途、页数/调用次数和输出位置。

SuperPPT 需要 Node.js 22.6 或更高版本。

```bash
npm ci
npm run verify:portable
npm run verify:full
npm run test:release-install
```

`verify:portable` 是 GitHub 公共 runner 的 Linux/macOS/Windows 门禁，不依赖 Codex 私有 workspace runtime。`verify:full` 必须在已注入 workspace runtime 的 Codex 主机运行，覆盖完整源码与编译测试；`test:release-install` 会真实打包、按 `--omit=dev` 安装并启动 CLI。发布前全部门禁都必须通过，公共 CI 不能用替身伪造 `@oai/artifact-tool`。

V1 只通过 GitHub/Codex 插件渠道发布，不发布 npm 包，`package.json` 因此保持 `private: true`。发布 tag 必须与插件版本完全一致（当前为 `v0.1.1`），tag commit 必须已在 `main`；tag workflow 会重新执行 portable gate、生成 `.tgz` 与 `SHA256SUMS`、写入 GitHub artifact provenance，并一次性创建 GitHub Release。

发布状态：v0.1.0 与 v0.1.1 均通过 tag workflow 创建 GitHub Release 并通过校验和与 artifact attestation 验证；npm 保持不发布。v0.1.0 产物构建于 Windows 修复合入前，Windows 环境请使用 v0.1.1 及以后版本，并参考 [Windows 交接与验证指南](docs/Windows交接与验证指南.md)。

## V1 限制

只接收描述、粘贴文本和 Markdown；不直接摄取 DOCX、PDF 或现有 PPTX。

修改验收只使用唯一完整本地 PPTX，不生成 PDF、蒙太奇、预览渲染或单页 donor。
内置样式配方沿用 1280×720 设计坐标；编辑交付仍只有完整本地 PPTX，不向用户提供或要求渲染 PNG。
