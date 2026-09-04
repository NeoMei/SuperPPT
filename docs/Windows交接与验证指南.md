# SuperPPT Windows 交接与验证指南

更新日期：2026-09-05。本文面向在 Windows 机器上接手 SuperPPT 验证与后续开发的同学，说明当前发布状态、可执行的验证步骤、测试能力边界，以及 Windows 相关修复的背景。

## 1. 当前发布状态

| 项 | 状态 |
| --- | --- |
| 仓库 | https://github.com/NeoMei/SuperPPT （公开） |
| Release | [SuperPPT v0.1.3](https://github.com/NeoMei/SuperPPT/releases/tag/v0.1.3)（当前版本）；历史版本 [v0.1.2](https://github.com/NeoMei/SuperPPT/releases/tag/v0.1.2)、[v0.1.1](https://github.com/NeoMei/SuperPPT/releases/tag/v0.1.1)、[v0.1.0](https://github.com/NeoMei/SuperPPT/releases/tag/v0.1.0) |
| 发布产物 | `superppt-0.1.3.tgz` + `SHA256SUMS`，由 tag workflow 生成校验和与 sigstore artifact attestation |
| 上游 main HEAD（本文复核时） | `v0.1.3` tag commit |
| 三平台 CI | ubuntu / macos / windows 均为发布门禁 |

重要：`v0.1.0` tag 指向 `2923c07`，早于三个 Windows 修复提交，其产物在 Windows 上存在 Style Lock 创建失败的问题（原因见第 5 节）；`v0.1.1` 已包含首轮修复，`v0.1.2` 进一步加入完整 Windows 原子发布、跨平台全量门禁和依赖审计，`v0.1.3` 加入浅层语义交付路径与交付身份强化。Windows 环境请使用 v0.1.3 或 main。

## 2. Windows 快速验证

前置条件：Git、Node.js >= 22.6（建议与 CI 一致用 22.6.0）。

```bash
git clone https://github.com/NeoMei/SuperPPT.git
cd SuperPPT
npm ci
npm run verify:portable
```

预期结果：源码测试、编译产物测试、`tsc` 类型检查、构建和严格依赖审计全部通过。这与 GitHub CI 在 windows-latest 上执行的命令完全一致。依赖审计仅临时接受 PptxGenJS 4.0.1 的未使用 `image-size` 声明所带来的两个无可安装修复版本的公告；该例外绑定精确版本、验证发布代码不可达，并于 2026-10-03 到期复审。任何新增公告或依赖变化都会失败。

注意：请直接在 `main` 上验证。不要 checkout `v0.1.0` tag 做验证——那个提交不含 Windows 修复，Style Lock 相关的 4 个测试会失败。

`npm ci` 可能输出 koffi / esbuild / fsevents 的 allow-scripts 警告，这是本机 npm 配置对安装脚本的提示，不影响验证；CI 与本机实测均确认 koffi 在 Windows x64 上通过预构建二进制正常工作。

## 3. 测试能力边界（在普通 Windows 电脑上）

| 门禁 | 能否运行 | 说明 |
| --- | --- | --- |
| `npm run verify:portable` | 可以 | 三平台 CI 同款门禁，无外部环境依赖 |
| `npm run verify:full` | 可以 | 使用仓库自有 PPTX 服务，完整执行源码测试、编译测试、类型检查、构建、依赖审计和 diff 检查；命令本身已改为跨平台，不再要求 Bash 或私有 workspace runtime |
| 真实端到端（生成 PPT → WPS 编辑） | 分阶段可行 | SuperPPT 组装、editable 转换和 WPS 编辑可在 Windows 原生运行；`ai-image-to-ppt` 的生成/host-image import 为保持 no-follow、目录描述符和硬链接发布保证而在非 POSIX 平台 fail closed，生成阶段需在 WSL/Linux/macOS 完成。便携套件不调用付费提供者 |
| `npm run test:release-install` | 可以 | 真实打包、仅生产依赖安装和 CLI 启动冒烟；通过当前 Node 与 `npm_execpath` 调用 npm，兼容 Windows。 |

## 4. 常用命令速查

```powershell
npm run verify:portable    # 便携门禁（Windows 可用）
npm run verify:full        # 完整跨平台门禁
npm run test:portable      # 仅便携测试
npm run lint:types         # 类型检查
npm run build              # 构建 dist/
npm run release:check -- --root "$($PWD.Path)" --tag v0.1.3  # 发布契约检查（版本/tag/工作流绑定）
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

- v0.1.0 发布产物不含 Windows 修复；Windows 环境应使用 v0.1.3。
- `ai-image-to-ppt` 的生成和 host-image import 原生 Windows 不受支持，这是其已声明的安全边界；可在 Windows 运行 `python scripts/run_windows_tests.py` 验证 export、editable-input preparation、routing、recovery、validation 和 vision-check 等受支持能力。

## 7. 架构与契约文档索引

- `README.md`：能力边界、验证命令、发布契约
- `SECURITY.md`：密钥处理与出站数据披露规则
- `skills/superppt/SKILL.md` 及 `skills/superppt/references/`：Agent 工作流、依赖说明、修改路由、工作区契约、门禁清单、阶段契约
- `docs/superpowers/specs/`、`docs/superpowers/plans/`：设计文档与实施计划
- `验收/验收报告.md`：完整验收报告
