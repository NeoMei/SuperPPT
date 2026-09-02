# SuperPPT Windows 交接与验证指南

更新日期：2026-09-02。本文面向在 Windows 机器上接手 SuperPPT 验证与后续开发的同学，说明当前发布状态、可执行的验证步骤、测试能力边界，以及 Windows 相关修复的背景。

## 1. 当前发布状态

| 项 | 状态 |
| --- | --- |
| 仓库 | https://github.com/NeoMei/SuperPPT （公开） |
| Release | [SuperPPT v0.1.1](https://github.com/NeoMei/SuperPPT/releases/tag/v0.1.1)（当前版本，含 Windows 修复）；历史版本 [v0.1.0](https://github.com/NeoMei/SuperPPT/releases/tag/v0.1.0) |
| 发布产物 | `superppt-0.1.1.tgz` + `SHA256SUMS`，校验和与 sigstore artifact attestation 均已验证通过 |
| main HEAD（本文撰写时） | `d4af86d fix: use platform-safe script names in test fixtures` |
| 三平台 CI | ubuntu / macos / windows 全部通过（run 33549798960） |

重要：`v0.1.0` tag 指向 `2923c07`，早于三个 Windows 修复提交，其产物在 Windows 上存在 Style Lock 创建失败的问题（原因见第 5 节）；`v0.1.1` 已包含全部修复，Windows 环境请使用 v0.1.1 或 main。macOS 两个版本均不受影响。

## 2. Windows 快速验证

前置条件：Git、Node.js >= 22.6（建议与 CI 一致用 22.6.0）。

```bash
git clone https://github.com/NeoMei/SuperPPT.git
cd SuperPPT
npm ci
npm run verify:portable
```

预期结果：源码测试 100/100、编译产物测试 100/100、`tsc` 类型检查、构建、`npm audit`（0 漏洞）全部通过。这与 GitHub CI 在 windows-latest 上执行的命令完全一致。

注意：请直接在 `main` 上验证。不要 checkout `v0.1.0` tag 做验证——那个提交不含 Windows 修复，Style Lock 相关的 4 个测试会失败。

`npm ci` 可能输出 koffi / esbuild / fsevents 的 allow-scripts 警告，这是本机 npm 配置对安装脚本的提示，不影响验证；CI 与本机实测均确认 koffi 在 Windows x64 上通过预构建二进制正常工作。

## 3. 测试能力边界（在普通 Windows 电脑上）

| 门禁 | 能否运行 | 说明 |
| --- | --- | --- |
| `npm run verify:portable` | 可以 | 三平台 CI 同款门禁，无外部环境依赖 |
| `npm run verify:full` | 不行 | 依赖 Codex 私有 workspace runtime（`@oai/artifact-tool` 等），仅在 Codex 主机可用；完整源码/编译 636 项测试已在 macOS Codex 主机通过两轮 |
| 真实端到端（生成 PPT → WPS 编辑） | 需额外环境 | 需要 Codex/Agent 宿主、本地 `ai-image-to-ppt` 与 `image-to-editable-pptx` 依赖、WPS Office；便携套件全部使用 fixture，从不调用真实提供者 |
| `npm run test:release-install` | 不建议 | 该门禁设计为发布工作流（ubuntu）专用；其 `execFile("npm")` 调用方式在 Windows 上有已知兼容问题（见第 6 节） |

## 4. 常用命令速查

```bash
npm run verify:portable    # 便携门禁（Windows 可用）
npm run verify:full        # 完整运行时门禁（仅 Codex 主机）
npm run test:portable      # 仅便携测试
npm run lint:types         # 类型检查
npm run build              # 构建 dist/
npm run release:check      # 发布契约检查（版本/tag/工作流绑定）
npm run cli                # CLI 入口（tsx src/cli.ts）
```

## 5. Windows 修复历史（均已合入 main）

首推 CI 暴露 16 个 Windows 失败，分三轮修复：

1. `0cb60f1 fix: make portable gates pass on Windows`
   - `execFile("npm")` 在 Windows 无法解析 `npm.cmd`（spawn ENOENT）→ 测试改用 `process.env.npm_execpath` 通过 Node 直接调 npm CLI。
   - 临时目录清理 `rm` 在 Windows 出现 ENOTEMPTY 竞态 → 增加 `maxRetries`/`retryDelay`。
   - 产品缺陷：`GetFileAttributesW` 查询失败（含文件不存在）被误判为 reparse point → 改为仅在返回有效属性且确有 `0x400` 位时拒绝，并用 `>>> 0` 归一化 koffi 返回值的有符号/无符号差异。缺失文件交由后续 `lstatSync` 产生正常 ENOENT。
2. `064d674 fix: map missing anchored directories to ENOENT on Windows`
   - 目录锚定守卫（CreateFileW）打开不存在目录时抛出的错误缺少 `ENOENT` code，导致依赖 `isMissing` 的探测逻辑失效 → 将 Win32 错误 2/3 映射为 `ENOENT`（generation 与 revision 两处守卫）。
3. `d4af86d fix: use platform-safe script names in test fixtures`
   - 测试夹具用 `path.split("/")` 取文件名，Windows 反斜杠路径导致 capability manifest 写入绝对路径 → 改为 `split(/[\\\\/]/)`。

其中 1 的第三点和 2 是真实产品缺陷（Windows 上首次创建 Style Lock 会误报 reparse point / anchoring 失败），其余为测试脚手架兼容问题。这也是建议补发 v0.1.1 的原因。

## 6. 已知未处理事项

- `tests/release-install.test.ts` 仍直接 `execFile("npm")`，在 Windows 手动运行 `npm run test:release-install` 会失败。该门禁只在 ubuntu 发布工作流执行，如需在 Windows 本地跑发布安装冒烟，可套用 `npm_execpath` 方案修复。
- v0.1.0 发布产物不含 Windows 修复；v0.1.1 已按既有 tag 工作流补发并包含全部修复。

## 7. 架构与契约文档索引

- `README.md`：能力边界、验证命令、发布契约
- `SECURITY.md`：密钥处理与出站数据披露规则
- `skills/superppt/SKILL.md` 及 `skills/superppt/references/`：Agent 工作流、依赖说明、修改路由、工作区契约、门禁清单、阶段契约
- `docs/superpowers/specs/`、`docs/superpowers/plans/`：设计文档与实施计划
- `验收/验收报告.md`：完整验收报告
