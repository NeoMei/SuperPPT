# SuperPPT macOS 交接与接力开发指南

更新日期：2026-09-05。本文面向在 macOS 上继续开发、联调和发布 SuperPPT 的接手者。以下状态已在 Windows 交接机上复核；到 Mac 后仍应按本文重新跑门禁，不要把历史通过结果当作当前机器的结果。

## 1. 交接状态

SuperPPT 由三个独立 Git 仓库协作，不是 monorepo，也不通过根仓库捆绑依赖 Skill。

| 仓库 | 当前交接基线 | 发布状态 |
| --- | --- | --- |
| [NeoMei/SuperPPT](https://github.com/NeoMei/SuperPPT) | `v0.1.3` tag / `main` | [v0.1.3](https://github.com/NeoMei/SuperPPT/releases/tag/v0.1.3) 已正常发布 |
| [NeoMei/ai-image-to-ppt](https://github.com/NeoMei/ai-image-to-ppt) | `main` 为 `86deb88f50cc9305ad215da716dda1624424d0a8` | 当前没有独立版本/tag 发布约定，以 `main` 和能力清单为准 |
| [NeoMei/image-to-editable-pptx](https://github.com/NeoMei/image-to-editable-pptx) | `v0.2.2` tag / `main` | [GitHub v0.2.2](https://github.com/NeoMei/image-to-editable-pptx/releases/tag/v0.2.2) 与 npm `0.2.2` 已发布 |

SuperPPT v0.1.3 的 Release workflow 会生成 `superppt-0.1.3.tgz` 与 `SHA256SUMS`，并为发布资产写入 artifact attestation。`image-to-editable-pptx@0.2.2` 同时完成 GitHub Release 与 npm 发布，两个渠道必须保持同版本。

## 2. Mac 首次拉取与目录布局

建议把三个仓库放在同一父目录下，保持彼此独立。这样不会把两个依赖仓库误加入 SuperPPT 的 Git 索引。

```bash
export STACK="$HOME/Developer/superppt-stack"
mkdir -p "$STACK"
cd "$STACK"

git clone https://github.com/NeoMei/SuperPPT.git SuperPPT
git clone https://github.com/NeoMei/ai-image-to-ppt.git ai-image-to-ppt
git clone https://github.com/NeoMei/image-to-editable-pptx.git image-to-editable-pptx

git -C "$STACK/SuperPPT" status --short --branch
git -C "$STACK/ai-image-to-ppt" status --short --branch
git -C "$STACK/image-to-editable-pptx" status --short --branch
```

如果本机已有克隆，分别在三个仓库执行 `git pull --ff-only`，不要在 SuperPPT 根目录运行会纳入相邻/嵌套仓库的批量 `git add -A`。提交前始终先看 `git status --short`。

## 3. 环境准备

最低要求：

- macOS + Xcode Command Line Tools（`xcode-select --install`）；
- Git；
- Node.js `>=22.6` 和 npm；
- Python `>=3.9`；
- PowerPoint for Mac，或 WPS Office for Mac，用于真实 UI 验收；
- 只有执行在线图片生成或可编辑分析时，才需要相应 provider/百炼凭证。

先确认实际解释器，不要依赖 shell 里残留的旧版本：

```bash
git --version
node --version
npm --version
python3 --version
```

安装锁定依赖：

```bash
cd "$STACK/SuperPPT"
npm ci

cd "$STACK/image-to-editable-pptx"
npm ci --include=dev

cd "$STACK/ai-image-to-ppt"
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt -r requirements-dev.txt
```

不要提交 `.venv`、API Key、输出 deck、测试截图或带凭证的 shell 历史。

## 4. 三仓库基线验证

### SuperPPT

```bash
cd "$STACK/SuperPPT"
npm run verify:portable
npm run verify:full
npm run test:release-install
npm run release:check -- --root "$PWD" --tag v0.1.3
```

`verify:portable` 与 GitHub 的 Linux/macOS/Windows 公共 runner 门禁一致。`verify:full` 会继续执行完整源码和编译产物测试、类型检查、构建、依赖审计及 diff 检查。

### ai-image-to-ppt

```bash
cd "$STACK/ai-image-to-ppt"
source .venv/bin/activate
python scripts/validate_skill.py .
python -m unittest discover -s tests -v
```

macOS 提供该仓库安全发布所需的 POSIX 目录描述符、no-follow、硬链接和同目录 rename 能力，因此图片生成与 host-image import 应运行完整测试路径。Windows 对这两条路径是有意 fail closed；这不是需要移植到 Mac 的待修 bug。

### image-to-editable-pptx

```bash
cd "$STACK/image-to-editable-pptx"
npm run verify
npm pack --dry-run
```

测试只使用本地 fixture 和可注入 provider，不应访问网络。若任何测试意外要求真实凭证或产生外部调用，应先停下排查。

## 5. SuperPPT 依赖预检

SuperPPT 只接受两个显式本地 Skill 根目录，不做环境变量路径回退，也不静默安装。每次开始完整工作流前运行：

```bash
cd "$STACK/SuperPPT"
export SUPERPPT_HOST_CAPABILITIES='{"source":"agent-host","localFilesystem":true,"localFileLinks":true}'

npm run cli -- preflight \
  --ai-skill "$STACK/ai-image-to-ppt" \
  --editable-skill "$STACK/image-to-editable-pptx"
```

预期 JSON 顶层为 `"ok": true`，并显示：

- `aiImageToPpt.gitRevision` 与当前 AI 仓库一致；
- `imageToEditablePptx.version` 为兼容范围 `>=0.2.0 <0.3.0` 内的版本；
- AI capability schema 为 v1；
- editable manifest/ledger 均为 v2；
- `errors` 为空数组。

任一仓库更新后都要重新运行 preflight。不要复用旧 workflow preflight attestation；SuperPPT 会对依赖路径、Git revision、能力清单、脚本和源码树做完整性绑定。

## 6. macOS 联调顺序

先跑离线，再跑付费/外部调用，最后做真实 Office UI 验收。

1. 运行第 4 节的三个仓库门禁，并确认三个工作树干净。
2. 运行第 5 节 preflight，保存非敏感输出作为本次联调证据。
3. 按 `skills/superppt/SKILL.md` 创建一个最小 3 页项目，依次完成内容确认、风格选择、样页确认和生成授权。不要绕过 gate 或直接伪造中间 JSON。
4. 在每次在线调用前向用户披露出站文本、参考图用途、页数/调用次数和输出位置。凭证必须由 macOS 钥匙串（Keychain）或等价的获批凭证管理器即时取得，只注入需要它的受控子进程；不得持久化、放入会话级 shell 环境，也不得出现在 CLI 参数、仓库或日志中。
5. 用 `ai-image-to-ppt` 生成严格 16:9 主图；需要可编辑页时，用 `scripts/prepare_editable_input.py` 生成独立的 `1280x720 PNG` 输入，再交给 `image-to-editable-pptx`。
6. 检查 editable 输出的 `manifest.json`、`run-ledger.json`、三张 QA 图和 `slide-editable.pptx`。`reviewRequired: true` 不能自动当作验收通过。
7. 由 SuperPPT 组装唯一完整 PPTX，并走完整 deck review；只有 `confirm-delivery` 才进入 delivered。确认后应直接得到项目根下 `交付/<语义化项目名>.pptx` 的唯一链接；`output/deck-revisions/<uuid>/deck.pptx` 只是内部不可变版本，不是用户最终交付路径。交付文件必须与 current 字节和 SHA 完全一致，且不得覆盖不同内容的同名用户文件。
8. 在 PowerPoint/WPS 中打开成品，移动代表性前景、编辑文字、执行撤销、保存、关闭并重新打开，确认修改持久化且未破坏背景与层级。

`image-to-editable-pptx` 的网络 `analyze` / `run` 需要百炼凭证。先通过系统的安全交互界面将它们存入 macOS 钥匙串，不要把真实值粘贴到 shell 命令或历史中。获批的运行包装器应在调用前一刻读取凭证，将 `DASHSCOPE_API_KEY` 和 `DASHSCOPE_WORKSPACE_ID` 只注入需要它的受控子进程，并在进程结束后丢弃内存中的值。一旦怀疑暴露，立即停止调用，先在提供者侧撤销并轮换凭证，完成影响评估后才能重试。

AI provider 的 host-first 路由和可选 API 凭证请以 `ai-image-to-ppt/SKILL.md` 与 `references/capabilities.json` 为准。浏览器已登录不代表 host capability 可调用。

## 7. 当前已知边界与待办

- SuperPPT 是 image-first：只保证成功提取的文字/素材可编辑，背景、主插画、整体布局和未可靠提取对象不承诺全可编辑。
- V1 输入只接受描述、粘贴文本或 Markdown，不直接摄取 DOCX、PDF 或既有 PPTX。
- SuperPPT 根包保持 `private: true`，只走 GitHub/Codex 插件发布，不发 npm。
- `image-to-editable-pptx@0.2.2` 的 GitHub Release 与 npm registry 已保持一致。
- SuperPPT 与 editable 的依赖审计临时接受 PptxGenJS 4.0.1 未使用的 `image-size` 声明带来的两个不可达公告；例外绑定精确版本，并在 2026-10-03 到期复审。依赖变化或新增公告应继续 fail closed。
- macOS 默认文件系统通常大小写不敏感；CI 的 Linux runner 大小写敏感。新增或重命名文件后应依赖 Git 记录真实 case，并确保 `verify:portable` 在 CI 继续通过。
- 不要把 AI 原始图、可编辑转换目录、用户内容或恢复目录当作源码提交。恢复警告里报告的路径可能包含敏感内容，应先人工处理再清理。

## 8. 验证 image-to-editable-pptx 发布链

只有在 `image-to-editable-pptx` 工作树干净、完整门禁通过且 npm 账号已获授权时执行新版本发布：

```bash
cd "$STACK/image-to-editable-pptx"
git pull --ff-only
git status --short --branch
npm run verify
npm pack --dry-run

npm login
npm whoami
npm publish --access public
npm view image-to-editable-pptx version
```

预期最后一条返回当前 GitHub Release 对应的版本。若 npm 已存在该版本，不要重复发布；先检查包页面、发布者和 tarball 内容。不要修改版本号来绕过登录、权限、2FA 或 provenance 问题。

## 9. 后续发布规则

### SuperPPT

1. 同步 `package.json`、`package-lock.json`、`.codex-plugin/plugin.json` 和相关发布契约测试中的版本。
2. 运行 `npm run verify:portable`、`npm run verify:full`、`npm run test:release-install` 和新版本的 `release:check`。
3. 先把 release commit 推到 `main`，再创建并推送同版本 `vSEMVER` tag。
4. 等 tag workflow 完成后，核对 GitHub Release、tgz、`SHA256SUMS` 和 artifact attestation。

### image-to-editable-pptx

同步 package、lockfile 和插件版本，跑 `npm run verify` 与 `npm pack --dry-run`；GitHub Release 和 npm 版本都成功后才算完整发布。

### ai-image-to-ppt

当前以 `main` 和 `references/capabilities.json` 为契约。改动能力、脚本路径、模型默认值或路由顺序后，必须同时更新文档/测试，并回到 SuperPPT 重新运行依赖 preflight 和相关集成测试。

## 10. 文档索引

- `README.md`：产品能力、开发门禁与发布总览
- `SECURITY.md`：密钥、出站数据和信任边界
- `skills/superppt/SKILL.md`：Agent 主工作流
- `skills/superppt/references/依赖说明.md`：依赖与 CLI 路由
- `skills/superppt/references/工作区契约.md`：项目目录和产物约束
- `skills/superppt/references/门禁清单.md`：阶段 gate
- `skills/superppt/references/阶段契约.json`：机器可读阶段契约
- `docs/Windows交接与验证指南.md`：Windows 特有边界与修复历史
- `验收/验收报告.md`：既有完整验收证据
