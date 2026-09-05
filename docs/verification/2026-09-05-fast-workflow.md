# SuperPPT vNext 精简实现验证

日期：2026-09-05。范围：本地实现与验证，不是发布验收。

实现分支：`codex/superppt-fast-workflow`；工作区：`/Users/neomei/项目/codexprojects/SuperPPT/.worktrees/fast-workflow`；实现前 HEAD：`cde7a8c`。依据 [已确认设计](../superpowers/specs/2026-09-05-superppt-fast-workflow-design.md) 和 [实施计划](../superpowers/plans/2026-09-05-superppt-fast-workflow.md)。

## 结果与效率边界

| 指标 | 原实现 | 当前实现 |
|---|---:|---:|
| 生产源码文件数（src） | 77 | 36 |
| 生产源码行数（含空行、注释） | 27,223 | 3,018 |
| Skill 与五份操作参考文件字节数 | 48,208 | 13,533 |
| 公共业务 CLI 命令 | 36 | 5 |
| 默认用户决策点 | 多个独立内容、风格与验收门 | 3 |

源码减少约 89%，指令文件体积减少约 72%。这些是维护及上下文体积指标，不是模型生成速度指标。

三页、十二页 public CLI fixture 都是 8 次命令调用、3 次用户决定；完整套图各只有 1 次 job 交接和 1 次聚合结果回传。包括样页在内共 2 次生图 work；另有规划和视觉 QA work。页数增加不增加正常批次的 SuperPPT CLI 往返，但 provider 请求仍随实际待生成页数增长。宿主在 work 后自动执行并回传，不增加人工门。

移除了本地 HMAC、外部 authority、admission token、事件/头链、注册表、高水位、旧门禁和旧项目迁移分支；删除了仅供上述原生防御使用的 koffi。保留普通文件边界、资源大小限制、短锁、原子写、产物摘要和调用预算。未添加 strict/audit 备用模式。

## 当前代码对应关系

为了不保留过渡包装层，计划中的多个旧文件被合并，函数路径以当前源码为准：

| 责任 | 当前文件 |
|---|---|
| 单一 manifest、短锁、一次提交与重试回执 | `src/project/task-schema.ts`、`task-store.ts` |
| 规划、三次决策、自动继续和未变页复用 | `src/workflow/{contracts,planning,continue,decide,reuse}.ts` |
| 安装路径与轻量依赖指纹 | `src/dependencies/task-dependencies.ts` |
| 不可变 job、预算、checkpoint、聚合结果 | `src/generation/task-batch.ts` |
| 完整候选、采纳、回滚、语义名称交付 | `src/deck-revisions/task-deck.ts` |
| 选中页转换与原生对象修改 | `src/editable/{converter,task-conversion}.ts`、`src/deck-revisions/task-{edit,splice}.ts` |
| 五个入口 | `src/cli.ts` |

`superppt.json.currentDeck` 是唯一当前指针；`output/current.json` 为可重建视图。两个独立能力仍由 SuperPPT 编排，不复制其实现。新任务仅接受 vNext；旧目录拒绝且保持原样。`regenerate-page` 用于视觉返工；改变原文走 `revise-plan`。

## 自动化证据

本次最终完整检查退出码均为 0：

- `npm run verify:full`：源码 34 通过 / 1 跳过；类型检查、构建通过；编译产物 34 通过 / 1 跳过。
- `npm run verify:portable`：源码与编译产物分别 34 通过 / 1 跳过；类型检查、构建通过。
- `npm run test:release-install`：1 通过，无跳过。真实 npm pack、解包、安装运行依赖后，针对安装产物执行三页和十二页完整公共 CLI 流程。常规套件跳过的就是这项单独执行的安装测试。
- 最后补充“未知样页 ID”拒绝断言后，`node --import tsx --test tests/fast-planning.test.ts` 3 通过，类型检查通过；未改生产代码。
- `git diff --check` 通过。

源码套件约 8.9 秒，编译套件约 6.6 秒；独立安装测试约 13.2 秒。这些是本机测试耗时，不含真实模型生成。旧套件含大量已删除审计测试，与新套件不同，不能用新旧测试耗时宣称产品提速比例。

测试使用真实可解码图像和真实 PPTX，模型请求使用 fixture。覆盖正常流程、同 job 预检复用、预算先记账、成功页不重生、两页完成后第三页中断、回执不明不自动补发、独立重试预算、未变样页及页面缓存、QA 失败不得交付、结果/决策重复提交、原子 manifest、候选确认、完整 deck 重排增删、单页重生成、选中页 donor 激活和实际原生文字修改、交付不覆盖同名异内容文件。

依赖检查通过项目现有例外规则：仍有 **2 项 image-size 高危公告**，当前使用路径不可达的例外复核期限为 **2026-10-03**。这不等于 npm audit 零漏洞；该检查属于依赖发布维护，不是已删除的任务内审计链。

## macOS WPS 实际操作

临时三页 PPTX 使用 fixture 图像；第二页含用于交互验证的原生文字对象。实际在 WPS 中完成：

1. 打开完整候选，第二页将 `FAST WORKFLOW CHECK` 改为 `FAST WPS SAVED 2026`。
2. 撤销，屏幕确认恢复原文。
3. 再次修改，明确保存并关闭。
4. 重开同一文件，屏幕确认新文字保留；再次关闭。
5. 执行 `saved-and-closed` 采纳，并创建第三页的下一次手动编辑候选，比较完整文件字节；最后拒绝新候选。

保存文件、采纳后的 current 和下一次编辑候选 SHA-256 均为：

```text
031a0e85eedae1591769a613dfeb0e35750bfd3d4287bc9c8ea07d226377b4a7
```

验证临时目录：`/var/folders/0n/49qgdd8x7kgcvh719fw743mh0000gn/T/superppt-fast-jucOub/task`。临时文件未作为用户成品交付；WPS 最终停留首页。

这证明手工编辑→撤销→保存→重开，以及采纳/下一页编辑继承原文件。GUI 的重排、增删和 Agent 修改确认未逐项实操；对应行为目前只有自动化 PPTX fixture 证据。

## 未验证和未执行

- 未进行真实付费生图；没有总耗时或画质提升结论。
- 实际解析已安装的 ai-image-to-ppt 和 image-to-editable-pptx（后者 0.2.0），轻量指纹包含 12 个声明文件；这不是 provider 在线可用或实际转换执行证明。
- 选中页转换接口以真实 donor fixture 验证，未调用真实外部转换器。
- 未在 Windows 上运行。`verify:portable` 在 macOS 通过不等于 Windows 验收。
- Skill 已做源码/契约/CLI 检查，未进行独立 Agent 压力评估或独立子代理代码审查。遵守计划的“不委派”边界，由当前 Agent 自查。
- 未推送、合并、发布、升级本机插件或修改两项独立依赖。包版本仍为 0.1.3，仅用于本地打包验证，不宣称该版本已发布新实现。

当前交付是已验证的本地精简实现。后续真实生图、真实转换器、Windows 和独立 Agent 使用验证仍需各自实际证据，不能由上述绿色测试替代。
