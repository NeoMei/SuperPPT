# SuperPPT

用三次关键决定，把主题、文字或 Markdown 做成高细节图片型 PPTX；按需仅将指定页重建为可编辑内容。

内容方案 + 单选风格 + 样页授权 → 样页回看 + 整套授权 → 完整 PPTX 回看与交付。
缺失事实、用户主动改稿和请求失败另行处理；正常机器步骤自动继续。

## 使用

通过 Codex/兼容宿主安装本仓库 Skill，告诉 Agent 你的内容与期望。
依赖 ai-image-to-ppt 和 image-to-editable-pptx 独立安装，宿主 Agent 负责调用；CLI 不代替宿主图像工具。
内部接口只有 start、continue、decide、edit、status，详见 [操作说明](skills/superppt/references/依赖说明.md)。

只支持新建一次性任务。中断的本版任务可恢复；旧项目不迁移、不兼容，也不删除。
superppt.json 是单一当前状态；完整候选在确认前不替换当前 PPTX。
手动编辑后回复“已保存并关闭”，采纳不改写文件。最终交付：交付/<项目标题>.pptx。

## 开发

Node.js >=22.6，运行 npm ci，然后 npm run verify:full。
npm run verify:portable 运行可移植检查；npm run test:release-install 验证实际打包与安装。
跨系统生成能力受独立依赖和宿主支持限制，本机测试不代表 Windows/WPS 验收。

本次重构规格：[Fast workflow](docs/superpowers/specs/2026-09-05-superppt-fast-workflow-design.md)。
旧 specs 仅保留历史，不再决定当前运行步骤。实现没有 strict/audit 模式、审计链、HMAC、外部权限注册或旧项目迁移。
