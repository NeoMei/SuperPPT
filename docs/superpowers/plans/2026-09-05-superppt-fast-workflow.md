# SuperPPT Fast Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not delegate unless the user requests it.

**Goal:** 为新的一次性 PPT 制作任务实现三个用户决策点、整批生图和完整 PPTX 编辑交付，删除审计体系与旧项目兼容。

**Architecture:** 保留内容规划、风格编译、PPTX/OOXML 和选中页转换能力，替换其外围状态与授权编排。五个公共命令驱动一个简单 manifest；宿主 Agent 承担内容创作、生图与视觉 QA，CLI 通过机器交接对象继续运行。

**Tech Stack:** TypeScript、Node.js >=22.6、Zod、Sharp、PptxGenJS、JSZip、node:test；复用已安装的 ai-image-to-ppt 和 image-to-editable-pptx。

**Spec:** [2026-09-05-superppt-fast-workflow-design.md](../specs/2026-09-05-superppt-fast-workflow-design.md)

## 执行记录（2026-09-05）

以下为实际完成状态；后文保留最初步骤以便比较，不把已替换的旧测试命令或九次预定提交追认成已执行。实现文件和测试合并后的对应关系、命令结果及外部验收边界见 [验证记录](../../verification/2026-09-05-fast-workflow.md)。本次采用一个整合实现提交，不保留九份不可独立运行的过渡状态。

- [x] Task 1：vNext 状态、短锁、单一指针、原子更新与恢复。
- [x] Task 2：合并方案/风格决定、预编译提示词与紧凑文件引用。
- [x] Task 3：实际安装根解析、声明文件指纹、同 job 预检缓存。
- [x] Task 4：整批 job、聚合结果、预算与 checkpoint；宿主批次执行说明。
- [x] Task 5：三个默认决定、自动继续、五个公共入口及未变页复用。
- [x] Task 6：完整 deck 候选、选中页转换接口、原生编辑、采纳、回滚和字节不变交付。
- [x] Task 7：删除旧审计/兼容依赖闭包，更新测试与移除 koffi。
- [x] Task 8：Skill、参考契约、历史说明与真实安装包流程测试。
- [x] Task 9 本地部分：3/12 页 CLI、恢复/编辑测试、完整与 portable 检查、macOS WPS 编辑撤销保存重开和字节继承、验证报告。
- [ ] Task 9 外部部分：获授权的真实付费生图、真实转换器、Windows 实机，以及未覆盖的 WPS GUI 编辑动作。当前不宣称这些已验收。

实现未迁移旧项目、未改独立能力仓库、未委派、未发布或升级安装版本。

## Global Constraints

- 默认用户等待点不超过 3 个。
- 默认公共 CLI 入口不超过 5 个。
- 恢复生成时，已成功页的新增生图请求数为 0。
- 不保留 strict、audit 或 paranoid 模式。
- 不读取、迁移或继续执行 vNext 之前创建的旧项目。
- 不把 `ai-image-to-ppt` 或 `image-to-editable-pptx` 复制进 SuperPPT。
- 每个 job 最多做一次完整依赖预检；依赖指纹未变时不重扫源码树。
- 只有“已保存并关闭”才能采纳手动编辑的完整文件；采纳不重写 PPTX。
- 所有文件变更限定在 SuperPPT；本计划不授权修改其他 Skill 仓库、删除用户旧工作区、合并或发布。
- 从当前文档分支建立实现分支；使用执行时读取的 worktree 技能建立隔离工作区。不要覆盖其他任务的未提交文件。

## 实施基线与接口决议

代码基线是 `2f71bbe`，规格提交为 `e3413a1`、`2edecd6`，执行前用 CodeGraph 和 git status 复核变更。现有 `src/cli.ts` 暴露 36 个业务命令；`trusted-authorization.ts` 约 4,000 行。现有 node:test runner 在 `scripts/test.ts`，完整验证为 `npm run verify:full`。

两个边界必须落实：

1. `gen_slide.py` 只能执行 API 调用；它不能代替宿主工具。`continue` 返回 `work` 时由当前 Agent 立即执行机器任务，完成后再次调用 `continue`，不问用户是否继续。生图交接包含整个 job，绝不变成逐页 SuperPPT CLI 往返。
2. `superppt.json.currentDeck` 是唯一可变的当前指针；`output/current.json` 是派生视图。候选 revision 元数据先写，manifest 后写，派生视图最后刷新。崩溃后从 manifest 重建视图，无双写认证。

正常路径的“三次”不含缺失信息追问、用户主动返工和外部调用结果不明等异常。统计生图交接时区分正常整批执行与中断恢复，不能用恢复场景否定正常路径 O(1) 的目标。

## 文件与职责

| 文件 | 操作与职责 |
|---|---|
| `src/workflow/contracts.ts` | 新建：三个用户决策、机器任务与命令输入输出的判别联合 |
| `src/workflow/continue.ts` | 新建：自动推进，串接规划、job、QA、组装 |
| `src/workflow/decide.ts` | 新建：决策应用、授权和返工 |
| `src/project/schemas.ts`、`store.ts`、`initialize.ts` | 替换旧 manifest 为单一 vNext schema，无旧 schema 分支 |
| `src/project/lock.ts`、`durable.ts`、`paths.ts`、`safe-file.ts` | 保留必要的锁、原子写、路径和普通文件检查；去除恶意并发防御 |
| `src/planning/{intake,load,render,schemas}.ts` | 保留内容模型；去掉独立确认门和旧证据依赖 |
| `src/styles/{schemas,style-lock,prompt-compiler}.ts` | 单文件 Style Lock，保留内容相关的视觉提示词 |
| `src/dependencies/{resolve,preflight,schemas}.ts` | 规范化安装路径、轻量依赖身份缓存 |
| `src/generation/{job-schemas,jobs,schemas,batch,delegation-result,quality}.ts` | 替换为批次 job、聚合 result、累计预算与 QA |
| `src/generation/checkpoint.ts` | 新建：普通 checkpoint 读写与恢复规则，批次内可调用的模块函数 |
| `src/deck/assemble.ts` | 改为由继续流程直接调用，初始完整 deck 只发布一次 |
| `src/deck-revisions/{store,workflow,schemas}.ts` | 简化候选、采纳和指针；沿用 topology/OOXML 算法 |
| `src/editable/{adapter,operations,route}.ts` | 接入新状态和编辑输入；保留转换器产物检查 |
| `src/project/final-delivery.ts` | 保留语义文件名、字节不变和同名不覆盖 |
| `src/cli.ts`、`src/cli-input.ts` | 仅五个公共命令，包括输入说明 |
| `skills/superppt/SKILL.md` 及 `references/` | 同步三次决策与一次整批委托，不传播实现细节 |

## Task 1: 当前任务状态与单一指针

**Files:** 修改 `src/project/{schemas,store,initialize,lock,durable}.ts`；新增 `tests/fast-state.test.ts`。

**Interfaces:** 导出 `initializeTask(root: string, title: string): Promise<TaskState>`、`readTask(root: string): Promise<TaskState>`、`updateTask(root: string, change: (s: TaskState) => TaskState): Promise<TaskState>`。`TaskState` 由 `src/project/schemas.ts` 导出。

- [ ] 写实际临时目录测试：新建后重开同一任务；旧/不支持版本的 manifest 拒绝且目录字节不变；在 rename 前后中断得到旧或新完整状态；过期派生 current 视图可重建。
- [ ] 运行 `node --import tsx --test tests/fast-state.test.ts`，确认缺失接口失败。
- [ ] 用以下状态骨架定义 Zod schema；复用现有 artifact、brief 和拓扑叶子类型，删除 gate snapshot、trust 和 authority 字段。

```ts
type TaskStage = 'planning' | 'plan-review' | 'sample-generation'
  | 'sample-review' | 'deck-generation' | 'deck-qa' | 'deck-review' | 'delivered';
type DeckRef = { revisionId: string; relativePath: string; sha256: string };
type TaskState = {
  schemaVersion: 'superppt-task-vnext'; projectId: string; title: string;
  contentRevision: string; stage: TaskStage; sourcePath: string;
  planPath: string | null; styleLockPath: string | null;
  activeJobId: string | null; currentDeck: DeckRef | null;
  pendingDecision: { id: string; kind: string } | null;
  editSessionPath: string | null;
  delivery: (DeckRef & { confirmedAt: string }) | null;
};
```

- [ ] 锁仅覆盖本地状态读改写；网络、用户等待和宿主工具调用期间释放锁。用排他创建和活跃 PID 检查处理正常并发；不加入锁签名。临时文件和标记只在本任务目录生成；不使用原生 openat/Windows guard 证明目录身份。
- [ ] 指针切换、清除旧 delivery 和结束编辑会话在一次 `updateTask` 中完成；原子落盘后更新派生 current 视图。
- [ ] 运行本任务测试和类型检查；提交 `refactor: introduce single-state PPT tasks`。中途旧调用者的类型错误必须有明确待替换列表，最终任务不得遗留。

## Task 2: 合并内容规划和风格决策

**Files:** 新建 `src/workflow/contracts.ts`；修改 `src/planning/{load,render,schemas}.ts`、`src/styles/{schemas,style-lock,prompt-compiler}.ts`；新增 `tests/fast-planning.test.ts`。

**Interfaces:** 导出 `PlanBundle`（现有 Brief、Outline、SlideSpec[] 和三个推荐风格）、`WorkRequest`、`WorkflowReply`；`publishPlan(root: string, plan: PlanBundle): Promise<WorkflowReply>`；`renderPlanReview(plan: PlanBundle): string`。

```ts
type WorkRequest = {
  id: string; kind: 'plan' | 'generate-batch' | 'review-images' | 'edit-deck';
  inputPath: string; resultPath: string;
};
type WorkflowReply =
  | { kind: 'work'; work: WorkRequest }
  | { kind: 'decision'; id: string; stage: 'plan-review' | 'sample-review' | 'deck-review'; view: string }
  | { kind: 'attention'; reason: string }
  | { kind: 'done'; deck: DeckRef };
```

- [ ] 构造完整三页计划测试：漏页、重复 ID、无来源覆盖不能发布；完整计划只返回一个 `plan-review`；重复发布相同输入不新增决策 ID。
- [ ] 运行 `node --import tsx --test tests/fast-planning.test.ts`，确认失败后实现。
- [ ] `publishPlan` 复用现有内容 schema 和 prompt compiler；一次发布完整大纲与紧凑逐页描述。真实风格预览来自现有 catalog；为三种可选风格预编译样页出站文本，选择时直接绑定对应文本，不能批准后另换 prompt。
- [ ] 将 Style Lock 收敛为 recipe、representativeSlideId、references、approvalState、approvedSample；直接嵌入现有 recipe，不再维护 selection/recipe/lock 三文件证明。保留禁止依赖追加默认风格的字段语义。
- [ ] 测试风格锁变化会使未执行 job 失效，requiredText 与角色构图仍进入 prompt；不把 SHA、token、schema 字段展示为用户选择。
- [ ] 运行本任务测试及 `tests/styles.test.ts` 中保留的提示词行为测试；提交 `feat: combine content and style review`。

## Task 3: 依赖解析与批次预检

**Files:** 修改 `src/dependencies/{resolve,preflight,schemas}.ts`；新增 `tests/fast-dependencies.test.ts`。

**Interfaces:** `resolveTaskDependencies(input: { aiSkillRoot: string; editableSkillRoot: string }): Promise<TaskDependencies>`；`preflightJob(root: string, jobId: string, deps: TaskDependencies): Promise<void>`。`TaskDependencies` 包含 canonicalRoot、version、入口路径与轻量 fingerprint。

- [ ] 测试安装 symlink 可以解析；用户传入 Skill 根目录时从该 Skill 的实际安装布局定位 package root，不扫描主目录猜位置；不兼容版本和缺入口报告明确原因。
- [ ] 运行 `node --import tsx --test tests/fast-dependencies.test.ts`，确认失败。
- [ ] fingerprint 只使用声明的 package/plugin/capability manifest、Skill 和必需入口的大小、mtime 与必要文件摘要。移除完整 `src/` 树证明；只承担本任务内普通安装变化检测。
- [ ] 缓存规范路径与已检查 job ID；同一 job 不因 publish/prepare/accept 多次重复预检。切换任务会话时重新确认宿主可调用能力，不能把安装清单当作在线可用性证明。
- [ ] 用计数 spy 验证同一 job 多次 continue 的完整预检次数 <=1，文件改变后新 job 才刷新；运行测试并提交 `refactor: cache dependency checks per batch`。

## Task 4: 批次 job、checkpoint 与结果接收

**Files:** 修改 `src/generation/{job-schemas,jobs,schemas,batch,delegation-result}.ts`；新增 `src/generation/checkpoint.ts`、`tests/fast-generation.test.ts`。

**Interfaces:** `publishBatchJob(root: string, job: BatchJob): Promise<string>`、`acceptBatchResult(root: string, result: BatchResult): Promise<void>`、`readBatchCheckpoint(root: string, jobId: string): Promise<BatchCheckpoint>`。三个类型在 generation schema 文件中导出；checkpoint 的 helper 仅供宿主批次执行使用，不增加公共命令。

```ts
type BatchCheckpoint = {
  jobId: string; requestCount: number;
  inFlightSlideId: string | null;
  completed: Record<string, { path: string; sha256: string }>;
};
export function remainingCalls(budget: number, cp: BatchCheckpoint): number {
  return Math.max(0, budget - cp.requestCount);
}
```

- [ ] 新增预算测试的具体断言：

```ts
assert.equal(remainingCalls(4, {
  jobId: 'batch-a', requestCount: 3, inFlightSlideId: null, completed: {}
}), 1);
```

- [ ] 增加真实图片临时文件案例：整批三页接收、错误页集合、非 16:9、错误摘要、partial 后继续、相同 result 重复提交；completed 页的路径/摘要不得被后续结果覆盖。
- [ ] 运行 `node --import tsx --test tests/fast-generation.test.ts`，确认失败后实现。`BatchJob` 固定 jobId/contentRevision/kind/pages/styleLock/callBudget/disclosure；`BatchResult` 保存所有页状态、累计 requestCount、实际路由和参考图使用情况。
- [ ] 授权与 job 使用同一内容 revision、选中风格及已展示的 prompt；新 job 在决定后激活，不能修改已发布输入。结果重试只更新状态，不再生成图像。
- [ ] 批次执行由当前宿主 Agent 按已解析 ai-image-to-ppt Skill 整体承担：整个 job 只建立一个 SerialStickyRouter，逐页调用已有 import/API helper，记录一个 checkpoint，完成后输出一个 result。此胶合流程写进 SuperPPT Skill，不修改依赖源码或发明依赖不存在的 batch CLI。
- [ ] 每次真正外部请求前递增 checkpoint.requestCount 并保存 inFlightSlideId；能力探测不计费。失败也占预算；新进程不重置。所有 fallback/retry 共用余额，余额为零则停止。此 helper 无权限 token、外部登记或签名。
- [ ] 中断恢复先验证 completed 文件，再处理在途页。回执不明且无可确认产物时返回 attention；不得宣称外部请求 exactly-once，也不得自动补发。partial resume 仍用原 job 和余额。
- [ ] 运行本任务测试；提交 `feat: accept whole image batches with resumable progress`。

## Task 5: 自动继续、三个决定与五个公共命令

**Files:** 新建 `src/workflow/{continue,decide}.ts`；修改 `src/cli.ts`、`src/cli-input.ts`、`src/generation/quality.ts`；新增 `tests/fast-workflow.test.ts`、`tests/fast-cli.test.ts`。

**Interfaces:** `continueTask(root: string, resultPath?: string): Promise<WorkflowReply>`；`decideTask(root: string, input: DecisionInput): Promise<WorkflowReply>`。`DecisionInput` 在 contracts.ts 中定义为 action 的判别联合，必须带当前 decisionId；样页/整套动作带批准的 callBudget。

- [ ] 测试三页正常流程，只产生 plan-review、sample-review、deck-review；两个生图 work 分别为样页和整套。`work` 不是人类 decision。相同 continue 重试保留原 work.id，不重复编排。
- [ ] 运行 `node --import tsx --test tests/fast-workflow.test.ts tests/fast-cli.test.ts`，确认失败。
- [ ] CLI 精确路由为下列形式；结果回传复用 continue，不创建第六个命令：

```text
start --project <new-root> --input <source-request.json> --dependencies <resolved.json>
continue --project <root> [--result <work-result.json>]
decide --project <root> --input <decision.json>
edit --project <root> --input <edit-request.json>
status --project <root>
```

- [ ] `start` 接收主题/文本/Markdown 输入，继续使用 intake 的字节保留。缺少影响成品的信息由 Agent 集中补齐。计划、视觉 QA、Agent 编辑均以 work/result 传递；CLI 只做确定性步骤。
- [ ] continue 状态转换：planning→plan work→plan-review；方案决定→sample-generation→sample work→sample-review；样页决定→deck-generation→batch work→deck-qa→QA work→assembly→deck-review；交付决定→delivered。
- [ ] 每个机器结果带 work.id 与 contentRevision，旧结果不改变当前任务。QA 使用现有 requiredText/风格/层级检查项；视觉检查缺失时不能自动填 accepted，缺项由 QA work 补全。
- [ ] 决策输入支持 select-style-and-generate-sample、approve-sample-and-generate-deck、revise-plan、regenerate-page、confirm-delivery、confirm-agent-edit、saved-and-closed、reject-edit、rollback-deck；按当前状态限定动作。明确自然语言由 Agent 解释，不增加“必须逐字回复确认”的额外门。
- [ ] 用户已经请求的上游修改构成修改授权；影响摘要与必要的新调用预算一次呈现。使受影响产物失效并复用未变页，不能重建旧 impact/approve-impact/apply-impact 三步。
- [ ] 注册表只含五个业务命令；`--help` 是这些命令的文档选项。CLI 测试检查旧 approve/admit/record 等路由无效；正常执行无需私有 JSON 手工拼接或人工等待机器 work。
- [ ] 运行本任务测试；提交 `feat: drive PPT tasks through five commands`。

## Task 6: 完整 PPTX 组装、编辑采纳和交付

**Files:** 修改 `src/deck/assemble.ts`、`src/deck-revisions/{schemas,store,workflow}.ts`、`src/editable/{adapter,operations,route}.ts`、`src/project/final-delivery.ts`；改造 `tests/{full-deck-editing,full-deck-activation,deck-topology,publication}.test.ts`。

**Interfaces:** `assembleTaskDeck(root: string): Promise<DeckRef>`；`editTask(root: string, request: EditRequest): Promise<WorkflowReply>`；`adoptTaskDeck(root: string, signal: 'saved-and-closed' | { confirmedSha256: string }): Promise<DeckRef>`；`deliverTaskDeck(root: string): Promise<DeckRef>`。`EditRequest` 在 workflow/contracts.ts 定义为 pageNumber、mode、instruction；内部立即解析为 current revision 与 stableSlideId。

- [ ] 复用三页真实 PPTX fixture，先建立行为断言：初次 batch 完成一定能到完整 PPTX；反复 continue 不新增 revision；未确认候选不影响 current；人工采纳后字节保持不变。
- [ ] 运行 `node --import tsx --test tests/full-deck-editing.test.ts tests/full-deck-activation.test.ts tests/deck-topology.test.ts tests/publication.test.ts`，记录旧 manifest 依赖引发的失败。
- [ ] 组装保留 createPresentation、图片格式规范化、stable slide identity 和页数/顺序检查，直接创建 `output/deck-revisions/<id>/deck.pptx`；删去中间 candidate-review promotion 和 gate snapshot 要求。
- [ ] 编辑保持 direct-edit / activate-editable / regenerate-slide 路由。可靠文字与提取对象走现有 OOXML 编辑，未可编辑页只转换被选中页，复杂视觉走批准后的单页 job。不要把完整图片页标为可编辑。
- [ ] 候选 session 记录父 revision、候选路径和已展示摘要即可；删除一次性 pending binding 消费。保留普通 revision 检查以防页码重排后改错页。
- [ ] 人工保存后用现有 inspect/topology 校准移动、新增、删除；先落 revision.json，再一次更新 manifest 的 currentDeck、editSessionPath、stage、delivery。中断重复采纳只补齐同一候选。Agent 确认必须匹配展示后未改变的文件。
- [ ] 回滚通过 manifest 原子更新指针并清除 delivery；派生 current view 不成为前置条件。后续修改从已采纳字节复制，不能从旧图片重新组装丢失用户改动。
- [ ] 正式交付复制同一字节到语义浅层路径；保留同名不同内容后缀规则。仅返回一个完整 PPTX 链接。补充字节断言：

```ts
assert.deepEqual(await readFile(adopted.absolutePath), savedBytes);
assert.deepEqual(await readFile(delivered.absolutePath), savedBytes);
```

上例 `adopted` / `delivered` 为测试中将 DeckRef.relativePath 与临时 root 解析后的对象，`savedBytes` 为模拟 WPS 保存完后读取的 Buffer。

- [ ] 运行本任务测试；提交 `refactor: preserve complete-deck edits on simple task state`。

## Task 7: 删除审计与旧流程的依赖闭包

**Files:** 删除 `src/generation/trusted-authorization.ts`；重写/删除不再被使用的 `src/generation/{authorization,lease,anchored-dir,private-input,style-sample}.ts`、`src/project/{evidence,promotion,rollback-guard}.ts`、`src/styles/{selection,publication,sample-contract}.ts`、`src/planning/confirm.ts`、`src/revisions/` 的旧证据/回滚事务、`src/acceptance/{offline,current,build,schema}.ts`。逐个确认消费者后处理，不递归删除目录。

- [ ] CodeGraph 查询 trusted authorization、旧 promotion 和 anchored filesystem 的所有生产/测试调用者。对混合文件保留文件检查、拓扑和格式验证，用普通 I/O 替换原生恶意并发防御。
- [ ] 改造 `tests/generation.test.ts`、`tests/project-state.test.ts`、`tests/revisions.test.ts` 中仍有用户价值的预算、缓存、状态和改稿测试；删除只测试链签名/旧 gate/旧 CLI 的案例。`tests/trust-boundary.test.ts` 中保留无凭证泄漏与项目路径相关断言，不能因文件名整体丢掉有用检查。
- [ ] 修改 `scripts/verify-contract.mjs`、`scripts/verify-full.mjs`、`scripts/verify-release.mjs`、`scripts/run-release-install-smoke.mjs` 和 `package.json` 的固定旧入口引用。离线验收改为新五命令 fixture，不留第二套业务引擎。
- [ ] 搜索实际残留，逐条判断上下文：

```bash
rg -n 'trusted-authorization|admit-image-call|admissionToken|createHmac|authorization-heads|project-registry|ROOT_AUTHORITY|high.water' src scripts tests skills
rg -n 'koffi|anchored-dir|anchored-fs' src package.json
```

- [ ] 删除用于上述审计的测试、fixture 和依赖；若 koffi 仅被删除的原生防御模块使用，通过 `npm uninstall koffi` 更新 package 与 lock。保留 dependency vulnerability 检查和真正的发布签名能力，不将它们误归为项目内审计链。
- [ ] 不实现旧 schema 转换器；初始化只认 vNext 标记，对未知/旧目录返回“请使用新的空目录”，无需读取旧业务结构。旧项目文件一律保持原样。
- [ ] 执行 `npm run lint:types` 和 `npm test`，收敛全部旧调用者；提交 `refactor: remove audit infrastructure and legacy workflows`。

## Task 8: Skill、文档和打包统一到新流程

**Files:** 修改 `skills/superppt/SKILL.md`、`skills/superppt/references/{阶段契约.json,工作区契约.md,依赖说明.md,修改路由.md,门禁清单.md}`、`README.md`、`SECURITY.md`、`references/dependencies.json`、`.codex-plugin/plugin.json`；更新 `tests/{workflow-contract,plugin-package,release-readiness,release-install}.test.ts`。

- [ ] Skill 正常路径只介绍三次决定；记录 Agent 接收到 work 后自动执行的规则，完整批次使用一次 ai-image-to-ppt 路由上下文，result 回传 continue。
- [ ] 阶段契约只保留三个人工 decision；异常授权、保存关闭和改单页确认归属现有决定/编辑动作。用户界面展示任务内容与调用上限，不逐步解释 SHA、锁、私有文件或注册表。
- [ ] 依赖说明列出五个真实命令及输入例子，补全现有脚本的宿主导入和结果聚合方式；checkpoint helper 是批次内部调用模块，无每页 SuperPPT CLI。
- [ ] 旧设计/计划文档开头标注“历史规格，执行以 2026-09-05 vNext 为准”，保留 Git 历史；打包与 Skill 不引用这些历史规范。当前 SECURITY.md 删除本地 HMAC/反回滚承诺，保留凭证与文件不覆盖说明。
- [ ] 安装包 smoke 通过真实解包产物跑新入口，确认 schema 和依赖 manifest 的源代码/编译产物路径一致；不要只测源码目录。
- [ ] 运行 `node --import tsx --test tests/workflow-contract.test.ts tests/plugin-package.test.ts tests/release-readiness.test.ts tests/release-install.test.ts`；提交 `docs: ship the three-decision PPT workflow`。

## Task 9: 正常链路、恢复与效率验收

**Files:** 重写 `tests/e2e.test.ts`、`tests/fixtures/e2e/build.mjs`；新建 `docs/verification/2026-09-05-fast-workflow.md`（记录实际执行结果后创建）。

- [ ] 用一个真实三页素材 fixture 驱动 public CLI：start、规划 work/result、方案决定、样页 work/result、样页决定、整批 work/result、QA work/result、完整 PPTX、交付决定。统计人类决定恰为 3；整套生图交接与结果接收各为 1。
- [ ] 将同一测试扩为 12 页，确认 SuperPPT 生图交接次数不随页数增长；provider 请求数允许随页数增长。用 mock executor 输出真实可解码图片，不能把 fixture 冒充真实生图证据。
- [ ] 在两页完成后中断：恢复后前两页不再调用 provider，累计失败/成功调用预算不归零；覆盖在途回执不明不自动补发、超额前停止、旧 result 不更新新 revision。
- [ ] 验证三条编辑链：Agent 改一页后确认；人工保存完整 deck 并重排/增删页后采纳；回滚后下一次编辑继承当前文件。原生新增页继续可手动修改。
- [ ] 运行 `npm run verify:full`、`npm run verify:portable`、`npm run test:release-install`。修改后受影响检查需重跑，全部通过后不无故重复全套。
- [ ] 记录同一 fixture 的固定 CLI 调用数、机器交接数、用户决定数、预检次数、执行耗时与排除的模型生成耗时。不得声称未经实测的“60%总耗时下降”；以交互和编排减少的实测值报告。
- [ ] 在获授权的真实生图任务中验证一次完整 job，记录实际路由/调用数/输出；实施授权本身不代替付费生图授权。当前 macOS WPS 做临时编辑→撤销→明确保存/不保存→重开，并单独验证保存采纳与下一页修改。Windows 要求实际环境证据，缺失就报告未验证。
- [ ] 在验证记录中区分自动化、真实生图、macOS WPS、Windows 四项状态；测试通过不能替代未进行的手动行为。
- [ ] 提交验证与测试变更；列出最终代码差异、删除量、未清事项和打包状态，交付本地实现结果。推送、PR 合并和正式发布按届时用户授权执行。

## 规格覆盖与完成检查

| Spec | 对应任务 |
|---|---|
| 1–6 产品范围、三决定、自动继续、五命令 | 2、5、8、9 |
| 7 状态与原子更新 | 1、6 |
| 8 Style Lock | 2、4 |
| 9–10 批次、授权、checkpoint | 4、5、9 |
| 11 依赖预检 | 3 |
| 12 完整 PPTX 修改交付 | 6、9 |
| 13 上游修改 | 2、5、6 |
| 14 错误和恢复 | 1、4、5、6、9 |
| 15–17 无兼容、删除审计、保留能力 | 1、7、8 |
| 18–20 测试、实施顺序、最终验收 | 7、8、9 |

执行时逐项勾选，不能把“计划已写完”记成实现完成。临时过渡函数在最终任务前退出发布包；没有旧项目迁移器、严格模式或备用旧流程。
