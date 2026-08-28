# SuperPPT 宿主文生图适配层设计

- 日期：2026-08-28
- 状态：已逐节确认，待用户审核文档
- 范围：让 SuperPPT 正确继承新版 `ai-image-to-ppt` 的宿主优先生图能力
- 上位设计：`docs/superpowers/specs/2026-08-26-superppt-design.md`

## 1. 背景与根因

新版 `ai-image-to-ppt` 把生图路由改为宿主优先：Skill/Agent 层先发现并直接调用当前宿主注册的图像工具，宿主不可用时才考虑 API 候选。其 `scripts/gen_slide.py` 明确是 API/CLI-only 适配器，无法从 Python 子进程内调用 Codex 宿主工具。

SuperPPT 现有生成路径只能读取 `module + callable` Provider 能力并从子进程调用 `gen()`。因此，即使 `ai-image-to-ppt` 本地和 GitHub 已是最新版，SuperPPT 也不会自动获得宿主生图能力。这是一个执行边界不匹配，不是版本问题。

## 2. 设计目标

1. 让 SuperPPT 能通过 Codex 宿主 `imagegen` 完成风格样例和正式页面生成，不要求 `OPENAI_API_KEY`。
2. 保留现有 API Provider 生成路径，不将宿主调用伪装成 Python Provider。
3. 让跨进程、跨回合的宿主生成可验证、可恢复，且不会把错页、旧修订或被篡改的图片提升为项目产物。
4. 继承 `ai-image-to-ppt` 的候选顺序、失败分类、宿主图片导入和串行粘性路由契约，不在 SuperPPT 中发明第二套策略。

## 3. 非目标

- 不修改或分叉 `ai-image-to-ppt` 与 `image-to-editable-pptx` 的实现。
- 不让 TypeScript 或 Python 子进程直接调用 Codex 宿主工具。
- 不用伪造的 `capabilities.json` 宣称子进程具有它实际没有的能力。
- 不改变可编辑页转换、整套组装和 WPS 验收契约。
- 不在本次适配中增加并行生成、后台队列或 Web UI。

## 4. 选定方案

采用“准备请求 → Agent 调用宿主工具 → 导入工作区 → 验证并提交”的两阶段适配。

没有选择以下方案：

- **子进程直调宿主工具**：子进程没有 Codex 工具注册表和调用上下文，这不是可靠边界。
- **用能力清单伪装 Python Provider**：能通过预检，但真正生成仍失败，属于假验收。
- **建立常驻 MCP/HTTP 代理**：能解决调用边界，但对 V1 增加不必要的进程、鉴权和生命周期复杂度。

## 5. 组件边界

### 5.1 Host Request Coordinator

新增宿主请求协调器，只负责准备和提交宿主生成请求，不负责调用生图工具。

每个不可变请求至少绑定：

- `requestId`
- `kind`: `style-sample` 或 `slide`
- `slideId`
- `revisionId`
- `gateEvidence`
- `providerCandidate`: 例如 `host-openai`
- `attempt`
- `promptSha256`
- `expectedFormat` 和 16:9 约束
- `createdAt`
- `state`: `prepared`、`committed` 或 `invalidated`

请求文件由 SuperPPT 在项目租约内创建，使用项目安全文件原语和排他写入。提交时不接受 Agent 重新传入上述字段，只根据 `requestId` 读回已绑定的权威请求。

### 5.2 Agent Host Caller

`skills/superppt/SKILL.md` 负责编排宿主调用：

1. 读取准备命令返回的权威提示词。
2. 直接调用当前宿主已注册且可调用的 `imagegen`。
3. 只接受明确的主图，或唯一返回图片。
4. 将宿主产物交给 `ai-image-to-ppt` 的导入器。

Agent 不把裸 HTTP(S) URL 交给 SuperPPT，不从 UI 预览、Cookie 或浏览器登录提取能力。

### 5.3 Host Artifact Importer

宿主产物必须使用当前 `ai-image-to-ppt/scripts/import_host_image.py` 导入 SuperPPT 项目内由请求 ID 专属的 staging 目录。

导入器负责：

- 验证绝对本地路径、行内字节/Base64/data URL 等受支持产物。
- 原样保留 `raw/<filename>`。
- 对 0.5% 容差内的近 16:9 宿主图做居中裁切，从不拉伸。
- 发布高分辨率、严格 16:9 的 master。
- 在路径、文件类型、MIME、解码、像素、所有权或发布原语不安全时失败关闭。

SuperPPT 不自行复制上述图片处理规则。

### 5.4 Host Committer

提交器在 SuperPPT 项目租约内执行：

1. 重新读取项目权威状态。
2. 校验请求仍为 `prepared`，且当前 revision、规划门禁、样例门禁要求和页面顺序未改变。
3. 重新编译当前页面提示词，对比 `promptSha256`。
4. 验证 staging 中 raw/master 为该请求专属、安全的普通文件。
5. 将 master 规范化为 SuperPPT 现有的 1920×1080 PNG 页面产物；高分辨率 master 和 raw 仍保留。
6. 生成现有 `AttemptLedgerSchema` 兼容的 ledger，记录实际 provider/channel、提示词哈希、输出哈希和字节数。
7. 原子提升各个产物，最后将请求转为 `committed`。如果进程在产物提升后、状态更新前中断，再次提交必须先鉴定已存在图片和 ledger；完全匹配时只补齐状态，不重写产物，任一字段或哈希不匹配时失败关闭。

任何校验失败都不会改变当前已成功项目版本。

### 5.5 Existing API Provider Adapter

现有 `generateSlide()` 和 Python bridge 继续服务 API Provider。宿主路由不给 Provider schema 填入虚假 `module` 或 `callable`。两条路径在生成完成后统一产出 SuperPPT ledger 和 1920×1080 页面图，后续质检、组装和可编辑转换不区分调用来源。

## 6. 数据与命令流

### 6.0 对话编排前置条件

宿主适配命令只是可验证的执行原语，不是绕过用户的自动化入口。SuperPPT Skill 必须先按上位设计完成引导对话：展示并确认大纲和逐页描述；在风格阶段先显示选定风格、代表页、实际 provider/channel、一次调用、对外调用和输出位置，获得单次“生成这张样页”授权后才能准备样页请求。样页结果确认后，系统再显示整套批次的页数、调用次数上限和输出位置。只有用户对当前 revision 的整套生成计划明确授权后，才能创建第一个正式页宿主生成请求。样页单次授权不能充当整套批次授权。

已授权的串行批次可以自动完成各页，不逐页打断用户。但批次完成后只能生成候选组装产物；系统必须先展示整套缩略图和检查结果，让用户选择改页、返回修改上游或确认交付。未获得“确认交付”时，不得提升正式 output revision 或宣称项目交付完成。

### 6.1 风格样例

1. `prepare-host-style-sample` 检查 outline 和 slide-specs 门禁，并要求当前 revision 已有与选定风格、代表页、provider/channel 和一次调用计划一致的样页生成授权；通过后创建不可变请求。
2. 命令只返回安全调用所需的请求 ID、候选、提示词位置和预期输出位置。
3. Agent 调用宿主工具并使用导入器写入请求 staging。
4. `commit-host-generation --request <request-id>` 完成验证和提升，写入 `style/sample/`。
5. 现有样例契约验证通过后，才允许用户确认 style-sample 门禁。

### 6.2 正式页面

1. `prepare-next-host-slide` 检查 outline、slide-specs 和 style-sample 三个当前门禁。
2. 它还要求生成授权门禁与当前 revision 及调用计划一致；随后跳过已有经验证成功产物的页面，且每次只准备一个有效请求。
3. Agent 完成宿主调用和导入后，使用同一个提交命令提升到 `images/<slide-id>/attempt-<n>/`。
4. 现有质检器生成质量决策。成功页立即写回项目状态；未提交或不合格页不标记为 ready。
5. 上一页完成后才能准备下一页，以符合串行粘性路由。

### 6.3 恢复

重新运行时，协调器按顺序检查：

- ledger 与图片都有效的 committed 请求：复用，不重新生图。对同一请求的重复提交是经鉴定的无写入幂等操作。
- 已导入 master 但未提交的 prepared 请求：允许重新提交。
- 图片和 ledger 已完整提升、但请求仍为 prepared：鉴定全部绑定和哈希后，只将请求补记为 committed。
- 未导入产物的 prepared 请求：使用同一请求继续宿主调用；不无声创建第二个并发请求。
- 与当前 revision、门禁或提示词不匹配的请求：标记失效，不允许提交。

## 7. 路由和错误分类

SuperPPT Skill 使用 `ai-image-to-ppt/scripts/host_routing_policy.py` 管理已分类的尝试，候选顺序为：

`host-openai` → `api-openai` → `host-gemini` → `api-gemini` → `host-doubao` → `api-doubao`

仅以下状态允许转到后续候选：

- `unavailable`
- `auth_unavailable`
- `retryable_exhausted`

以下状态必须立即终止当前批次：

- `policy_refused`
- `invalid_input`
- `invalid_output`
- `local_failure`

首个实际成功候选成为后续页面的粘性起点。已验证缓存页不建立或修改粘性状态。路由报告只保留页面、候选、channel、安全状态和切换原因，不保留密钥、原始 Provider 响应或未脱敏错误。

## 8. 安全与一致性规则

1. 所有项目写入前都验证 `.superppt-project.json` 所有权、规范根路径、非符号链接和普通文件边界。
2. 准备与提交均使用现有项目租约；不允许同一项目存在两个可提交宿主生成请求。
3. 请求、staging、raw、master、页面 PNG 和 ledger 必须位于同一项目内，并使用项目相对路径登记。
4. commit 不接受用户传入的 provider、slideId、revisionId、attempt 或输出哈希作为权威值。
5. 旧 revision、旧门禁、错页、提示词哈希不同、非安全文件或非法图片全部失败关闭。已 committed 请求只能返回经鉴定的现有结果，不得再次写入或替换产物。
6. 提交失败不覆盖上一个已成功产物；现有 output revision 不变。
7. 提示词在宿主调用后按现有隐私契约清理私有副本，ledger 仅记录哈希和 `promptPurged: true`。

## 9. 可编辑页交接

宿主导入后的高分辨率 master 是生成侧权威图像，不得被 1280×720 转换输入覆盖。只在某页进入 `image-to-editable-pptx` 时，使用 `ai-image-to-ppt/scripts/prepare_editable_input.py` 生成独立的精确 1280×720 PNG，然后继续现有可编辑转换、单页预览确认和整套替换流程。

## 10. 测试设计

所有实现使用 TDD，每个行为先有一个因缺失功能而正确失败的测试。

### 10.1 请求行为

- 未有与当前 revision、风格、代表页、provider/channel 和一次调用计划匹配的样页生成授权时，拒绝准备宿主样页请求。
- 准备风格样例会绑定代表页、当前 revision、门禁和提示词哈希。
- 未有与当前 revision、provider/channel、页数和调用次数上限匹配的整套生成授权时，拒绝准备正式页宿主请求。
- 正式页面一次只准备一页，已验证成功页不重复生成。
- 存在未完成请求时，重试返回同一请求，不创建竞态请求。

### 10.2 提交行为

- 正常导入的 host master 能产生经验证的 1920×1080 PNG 和现有 schema ledger。
- 请求只能产生一次成功写入；已 committed 请求的重复提交只能返回经鉴定的原结果。
- 错页、旧 revision、门禁失效、提示词变更、图片篡改、符号链接、路径逃逸和非法解码都会被拒绝。
- 准备、导入或提交中断后能恢复，不损坏既有成功页。
- 并发提交、项目目录替换、请求文件替换和产物替换竞态失败关闭。

### 10.3 回归

- 现有 API Provider 风格样例和批量生成测试保持通过。
- 现有规划门禁、影响分析、回滚、可编辑页替换、整套组装和验收 smoke 测试保持通过。
- 候选整套可以渲染与回看，但在缺失当前 revision 的整套回看确认时不能提升正式 output revision。
- 源码测试、编译后测试、类型检查、构建、插件验证、Skill 验证和 `git diff --check` 全部通过。

## 11. 真实验收

真实验收使用合成、无隐私的三页内容，且必须保留以下证据：

1. **宿主生图**：1 张风格样例 + 3 张正式页，串行，最多 4 次实际宿主生图调用，失败不自动重试。
2. **页面质量**：每页是有效 16:9，具备清晰主视觉、图文关系、可读层级与选定高细节风格一致性。
3. **可编辑转换**：从高分辨率 master 派生独立 1280×720 PNG，选一页调用 `image-to-editable-pptx`，验证文字是真实文本框而非整页位图。
4. **替换与整套交付**：将可编辑页替换回三页 PPTX，验证页数、顺序、渲染预览、PDF 和验收清单均对应同一 revision。
5. **WPS 客户端**：只在 `acceptance-smoke-copy` 受控副本上临时修改选定文字或对象，执行撤销，明确选择不保存，关闭后重新打开，验证原内容和文档标题。
6. **对话证据**：保留大纲、逐页描述、风格样例、生成授权和整套回看五个当前门禁的 revision 绑定证据，并保留风格样页的单次生成授权记录。用户在整套回看后明确选择“确认交付”，候选产物才能提升为正式 output revision。

结构检查、渲染预览或方案文字都不能替代上述三类真实证据：宿主生图、可编辑转换和 WPS 实际操作。

## 12. 交付判定

只有当以下条件同时成立，才可宣称本次新版 `ai-image-to-ppt` 真实适配验收通过：

- 宿主请求和提交安全契约的自动化测试通过。
- 全量 SuperPPT 回归和所有验证脚本通过。
- 真实宿主生图在 4 次调用上限内产出风格样例和三页正式页。
- 选定页真实转换为可编辑对象并替换回整套。
- WPS 受控副本的修改、撤销、不保存、关闭和重开验证成功。
- 对话门禁证明系统没有从内容导入静默运行到最终交付，且正式 output revision 仅在用户回看整套后提升。

若任一环节未执行或只有模拟证据，结论必须明确标记为“未完成真实验收”。
