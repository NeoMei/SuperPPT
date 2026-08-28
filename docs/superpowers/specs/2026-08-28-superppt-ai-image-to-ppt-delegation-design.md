# SuperPPT 与 ai-image-to-ppt 薄委托设计

- 日期：2026-08-28
- 状态：用户已确认架构方向，待审核书面设计
- 范围：SuperPPT 通过 Skill 级委托使用 `ai-image-to-ppt`
- 上位设计：`docs/superpowers/specs/2026-08-26-superppt-design.md`

本文档取代已撤回的“宿主文生图适配层”设计，并使 `docs/superpowers/plans/2026-08-26-superppt-v1.md` 中基于 `capabilities.json` 和 Python Provider bridge 的生成集成部分失效。该旧计划的其他历史实现记录仍保留；新实现必须另写计划。

## 1. 核心决定

SuperPPT 的文生图完全由 `ai-image-to-ppt` 实现。SuperPPT 不再拥有 Host Caller、Provider Adapter、路由状态机或宿主图片导入器。

两者的边界是：

- SuperPPT 负责用户对话、内容规划、风格单选、提示词编译、确认门、revision、整套组装、改页和交付。
- `ai-image-to-ppt` 负责宿主能力发现、宿主/API 候选、模型路由、串行粘性批次、图像生成、导入、raw/master 保留、16:9 规范化、生成侧检查和安全错误分类。

SuperPPT 只定义 `ImageGenerationJob` 和 `ImageGenerationResult` 两个跨 Skill 契约，不定义新的文生图引擎。

## 2. 为什么仍需要契约

Codex Skill 不是可直接 `import` 的应用内函数。当前 Agent 会同时遵循 SuperPPT 和 `ai-image-to-ppt` 的指令，并在两者之间传递任务与结果。因此仍需要一个小而可验证的交接面，用于：

- 把生图绑定到用户已确认的页面、风格和 revision。
- 保证样页单次授权与整套批次授权不混用。
- 限制调用次数和输出目录。
- 识别中断后的已成功页，不重新生成。
- 防止旧 revision、错页或被替换图片进入当前演示稿。

这是编排安全契约，不是生成实现。

## 3. 依赖发现

SuperPPT 必须从当前 Agent 会话的 Codex Skill 目录解析 `ai-image-to-ppt`，不把兄弟 Git 仓库、`~/.agents/skills` 或某个开发机绝对路径写死。Agent 把目录中已解析的 Skill 根目录传给 SuperPPT 预检；SuperPPT CLI 只验证该根目录和所需文件，不自行遍历用户主目录猜测安装位置。

预检记录：

- Skill 标识 `ai-image-to-ppt`。
- 当前解析到的 Skill 根目录。
- `SKILL.md` 哈希，以及可获得时的包版本或 Git revision。
- 所需脚本是否位于该 Skill 根目录内。

插件打包后，`ai-image-to-ppt` 可以是同一内置发行集中的独立 Skill。SuperPPT 不复制它的脚本；如果依赖未安装或不可解析，预检明确告知用户并停在当前阶段。

## 4. `ImageGenerationJob`

SuperPPT 在项目所有的 `generation/jobs/<job-id>/` 下创建不可变任务。任务至少包含：

```json
{
  "contractVersion": 1,
  "jobId": "uuid",
  "kind": "style-sample | deck | page-regeneration",
  "projectRevisionId": "revision-id",
  "authorizationDigest": "sha256",
  "callBudget": 1,
  "routePolicy": "ai-image-to-ppt-default",
  "pages": [
    {
      "slideId": "stable-slide-id",
      "order": 0,
      "promptArtifact": "slides/<id>/prompt.txt",
      "promptSha256": "sha256",
      "target": "generation/jobs/<job-id>/ai-image-output/<id>.png"
    }
  ]
}
```

契约规则：

- `style-sample` 只有一页且 `callBudget` 为 1，必须绑定当次“生成这张样页”授权。
- `deck` 页面顺序与当前 slide specs 一致，必须绑定整套生成授权。
- `page-regeneration` 只针对用户已确认需要重新生图的一页。
- `callBudget` 统计真正发出的宿主或 API 生图请求；不产生生图请求的能力发现和缺失凭证检查不计入。已消耗额度的失败尝试仍计数；依赖 Skill 不得为降级、重试或切换 Provider 超过该上限。
- `routePolicy` 只指向 `ai-image-to-ppt` 的默认策略，不在 job 中复制候选顺序、密钥状态或重试规则。
- 所有路径均为项目相对路径，且指向项目所有的专属 job 目录。
- 任务一旦发布不就地修改；上游变更会使其失效并创建新 job。

## 5. Agent 委托执行

SuperPPT Skill 按以下顺序编排：

1. 确认当前对话门禁和调用授权。
2. 发布 `ImageGenerationJob`。
3. 加载并遵循已解析的 `ai-image-to-ppt/SKILL.md`。
4. 把整份 job 作为一个串行批次，不把每页拆成独立路由会话。
5. 让 `ai-image-to-ppt` 依其自有策略生成并导入 job 专属目录。
6. 从其现有 `GenerationResult` 和 `SerialStickyRouter.report()` 捕获结构化结果，不解析未受信任的自然语言 Provider 响应。

已缓存且经 SuperPPT 重新验证的页面作为 cached 交给 `ai-image-to-ppt`，不重新生成，也不建立或修改路由粘性状态。

## 6. `ImageGenerationResult`

SuperPPT 将依赖 Skill 返回的结构化结果收敛为：

```json
{
  "contractVersion": 1,
  "jobId": "uuid",
  "projectRevisionId": "revision-id",
  "outcome": "success | partial | fatal | exhausted",
  "batchReport": {},
  "pages": [
    {
      "slideId": "stable-slide-id",
      "status": "success | cached | failed",
      "provider": "openai | gemini | doubao | null",
      "channel": "host | api | null",
      "master": "generation/jobs/<job-id>/ai-image-output/<id>.png",
      "raw": "generation/jobs/<job-id>/ai-image-output/raw/<id>.png",
      "masterSha256": "sha256"
    }
  ]
}
```

`batchReport` 保留 `ai-image-to-ppt` 的串行粘性报告语义，包括页面结果和安全的切换原因。SuperPPT 不往其中添加原始 Provider 响应、密钥或未脱敏错误。API 成功页可以没有单独 raw 文件；宿主成功页必须保留 raw 与 master。

SuperPPT 只提供一个薄的结果记录命令：它消费 `ai-image-to-ppt` 脚本产生的 `GenerationResult` JSON 和 `SerialStickyRouter.report()` JSON，校验 job 与产物后原子更新 `ImageGenerationResult`。命令不解析自然语言回复，不调用模型，不判断候选顺序。这使现有 `ai-image-to-ppt` 无需增加 SuperPPT 专用 Provider 或重复路由代码。

## 7. SuperPPT 结果接收

SuperPPT 在项目租约内验证：

1. job 尚未被接收，且仍指向当前 revision 和当前授权。
2. 页面 ID、顺序、提示词哈希和目标路径与 job 一致。
3. 产物位于 job 专属目录，是非符号链接的安全普通文件。
4. master 可完整解码，是严格 16:9，字节数、像素与 SHA-256 符合限制。
5. 宿主成功页有对应 raw，且 result 的 provider/channel 与 batch report 一致。
6. 实际宿主/API 生图请求数不超过 `callBudget`，且没有未授权的额外页。

通过后，SuperPPT 保留 `ai-image-to-ppt` master 和 raw，另行派生自身组装所需的 1920×1080 PNG，并把页面绑定到当前 revision。这个派生是本地确定性格式转换，不是文生图。

已成功接收的 job 重复提交只能返回经哈希鉴定的原结果，不再写入。任一绑定或产物不匹配时失败关闭，不修改当前成功项目版本。

## 8. 对话和生成流

### 8.1 风格样页

1. 用户单选风格和代表页。
2. SuperPPT 显示依赖 Skill、一次调用、对外调用和输出位置。
3. 用户明确选择“生成这张样页”。
4. SuperPPT 发布单页 job，Agent 委托 `ai-image-to-ppt` 执行。
5. SuperPPT 验证结果并向用户展示样页，等待风格样页确认。

### 8.2 整套生成

1. 样页确认后，SuperPPT 显示页数、依赖 Skill、调用次数上限、对外调用和输出位置。
2. 用户明确授权整套生成。
3. SuperPPT 发布有序 deck job，Agent 在同一 `ai-image-to-ppt` 路由批次中串行生成。
4. 完成页逐页落盘；中断时保留已验证页，恢复时以 cached 页传给依赖 Skill。
5. SuperPPT 接收并验证整份结果，仅对成功页更新项目状态。
6. 组装候选 PPTX/PDF/缩略图，展示整套回看；用户确认交付前不提升正式 output revision。

## 9. 失败与恢复

- Provider/channel 候选顺序、可降级状态、致命状态和粘性切换完全以 `ai-image-to-ppt` 为准。
- SuperPPT 只解释 dependency 返回的结构化状态，不根据原始错误文本自行判断是否切换 Provider。
- 批次因致命错误停止时，SuperPPT 保留 job、结果、已成功页和安全摘要，不宣称整套生成成功。
- 当前 revision 变更时，旧 job 和 result 标记失效；其产物保留为失败/历史证据，不提升到当前页面。
- 中断恢复不删除未知文件，不重新生成经验证的成功页。

## 10. 可编辑页交接

`ai-image-to-ppt` 产出的高分辨率 master 是生成侧权威图像。只在某页进入 `image-to-editable-pptx` 时，SuperPPT 再委托 `ai-image-to-ppt/scripts/prepare_editable_input.py` 从 master 派生独立的精确 1280×720 PNG。不覆盖 master 或 raw，不在 SuperPPT 中复制裁切规则。

随后 SuperPPT 调用 `image-to-editable-pptx` 的现有契约，继续单页预览确认和整套替换。

## 11. 测试

实现使用 TDD，覆盖：

- 依赖从 Skill 目录解析，不依赖兄弟仓库或开发机绝对路径。
- 样页 job 与 deck job 的授权不能互用；上游变更后授权和 job 失效。
- job 的页面、顺序、提示词哈希、调用上限和输出目录不可被提交参数替换。
- result 的页面、provider/channel、batch report、master/raw 和哈希一致性。
- 错 job、旧 revision、错页、路径逃逸、符号链接、图片篡改和额外未授权页失败关闭。
- 中断后成功页作为 cached 恢复，不触发重新生成。
- 已接收 job 的重复提交为经鉴定的无写入幂等结果。
- 候选整套可渲染，但缺少整套回看确认时不能提升正式 output revision。
- 现有 API Provider 回归替换为 `ai-image-to-ppt` 结构化结果契约回归，而不再验证 SuperPPT 自己的 Provider bridge。

## 12. 真实验收

真实验收使用合成、无隐私的三页内容：

1. 用户逐步确认大纲、逐页描述和风格，并单独授权一次样页生成。
2. SuperPPT 发布一页 job，Agent 真实委托 `ai-image-to-ppt` 生成样页。
3. 样页确认后，用户授权三页整套批次。最多 4 次宿主生图调用（1 样页 + 3 正式页），串行，失败不自动超出授权重试。
4. 验证 `ImageGenerationResult`、master/raw、页面绑定和整套缩略图。
5. 选一页从 master 派生 1280×720 PNG，真实委托 `image-to-editable-pptx` 转换为可编辑页并替换回整套。
6. 先向用户展示整套回看；只在用户确认交付后提升正式 output revision。
7. 在 WPS 的 `acceptance-smoke-copy` 上临时修改选定文字或对象，撤销，不保存，关闭并重开。

没有真实 `ai-image-to-ppt` 委托、真实可编辑转换和 WPS 操作证据，不宣称真实验收通过。
