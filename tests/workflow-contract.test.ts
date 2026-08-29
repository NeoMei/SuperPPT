import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillRoot = "skills/superppt";
const references = [
  "阶段契约.json",
  "门禁清单.md",
  "工作区契约.md",
  "修改路由.md",
  "依赖说明.md",
] as const;

type GateKind = "ordinary" | "execution-authorization" | "conditional";
type StageEntry = {
  id: string;
  kind: GateKind;
  interaction: "human";
  action: "wait";
  mustWaitForUser: boolean;
  inputs: string[];
  userVisibleArtifact: string;
  allowedNextActions: string[];
  invalidationDependencies: string[];
  canSpendImageCalls: boolean;
};
type WorkflowPolicy = {
  conversation: {
    silentEndToEndAllowed: boolean;
    decisionMode: string;
    earlierStagesRevisable: boolean;
  };
  style: {
    selectionMode: string;
    defaultAllowed: boolean;
    catalog: string;
    previewMode: string;
  };
  generation: {
    executor: string;
    cliExecutesDependency: boolean;
    scheduling: string;
    providerSelectedBy: string;
  };
  delivery: {
    reviewRequired: boolean;
    genericApprovalAllowed: boolean;
    reviewActions: string[];
  };
  smoke: {
    copyDisposition: string;
    runtimeState: string;
    acceptanceRecordAction: string;
    intermediateEvidence: string;
  };
  jobInputs: {
    styleSample: {
      styleLockState: string;
      approvedSample: string;
      required: string[];
    };
    deckAndPageRegeneration: {
      styleLockState: string;
      approvedSample: string;
      required: string[];
    };
  };
  changeInvalidation: {
    style: string[];
  };
};
type StageContract = {
  contractVersion: number;
  stages: StageEntry[];
  workflowPolicy: WorkflowPolicy;
};

async function text(path: string): Promise<string> {
  return readFile(`${skillRoot}/${path}`, "utf8");
}

function validateStageContract(contract: StageContract): void {
  const expectedByKind: Record<GateKind, string[]> = {
    ordinary: ["outline", "slide-specs", "style-sample", "generation-authorization", "deck-review"],
    "execution-authorization": ["style-sample-generation"],
    conditional: ["revision-impact", "slide-preview"],
  };
  for (const [kind, expected] of Object.entries(expectedByKind) as Array<[GateKind, string[]]>) {
    assert.deepEqual(contract.stages.filter((entry) => entry.kind === kind).map((entry) => entry.id), expected);
  }
  assert.equal(new Set(contract.stages.map(({ id }) => id)).size, contract.stages.length);
  const expectedInvalidation: Record<string, string[]> = {
    outline: ["slide-specs", "style-sample-generation", "style-sample", "generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "slide-specs": ["style-sample-generation", "style-sample", "generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "style-sample": ["generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "generation-authorization": ["deck-review", "formal-delivery", "acceptance-evidence"],
    "deck-review": ["formal-delivery", "acceptance-evidence"],
    "style-sample-generation": ["style-sample", "generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "revision-impact": ["approved-impact-plan.staleSlideIds", "approved-impact-plan.restartStage-and-downstream-gates", "formal-delivery", "acceptance-evidence"],
    "slide-preview": ["candidate-montage", "deck-review", "formal-delivery", "acceptance-evidence"],
  };
  for (const entry of contract.stages) {
    assert.equal(entry.interaction, "human", `${entry.id} interaction`);
    assert.equal(entry.action, "wait", `${entry.id} action`);
    assert.equal(entry.mustWaitForUser, true, `${entry.id} mustWaitForUser`);
    assert.ok(entry.inputs.length > 0, `${entry.id} inputs`);
    assert.ok(entry.inputs.every((item) => item.trim().length > 0), `${entry.id} input values`);
    assert.ok(entry.userVisibleArtifact.trim().length > 0, `${entry.id} userVisibleArtifact`);
    assert.ok(entry.allowedNextActions.length > 0, `${entry.id} allowedNextActions`);
    assert.deepEqual(entry.invalidationDependencies, expectedInvalidation[entry.id], `${entry.id} invalidationDependencies`);
    assert.equal(typeof entry.canSpendImageCalls, "boolean", `${entry.id} canSpendImageCalls`);
  }
  assert.deepEqual(
    contract.stages.filter(({ canSpendImageCalls }) => canSpendImageCalls).map(({ id }) => id),
    ["generation-authorization", "style-sample-generation"],
  );

  const policy = contract.workflowPolicy;
  assert.equal(policy.conversation.silentEndToEndAllowed, false);
  assert.equal(policy.conversation.decisionMode, "one-content-specific-decision-at-a-time");
  assert.equal(policy.conversation.earlierStagesRevisable, true);
  assert.equal(policy.style.selectionMode, "single");
  assert.equal(policy.style.defaultAllowed, false);
  assert.equal(policy.style.catalog, "assets/styles/catalog.json");
  assert.equal(policy.style.previewMode, "compact-real-preview-grid");
  assert.equal(policy.generation.executor, "agent-invokes-resolved-ai-image-to-ppt-skill");
  assert.equal(policy.generation.cliExecutesDependency, false);
  assert.equal(policy.generation.scheduling, "serial");
  assert.equal(policy.generation.providerSelectedBy, "ai-image-to-ppt-host-routing");
  assert.equal(policy.delivery.reviewRequired, true);
  assert.equal(policy.delivery.genericApprovalAllowed, false);
  assert.deepEqual(policy.delivery.reviewActions, ["edit-page", "return-upstream", "confirm-delivery"]);
  assert.equal(policy.smoke.copyDisposition, "discard-no-save");
  assert.equal(policy.smoke.runtimeState, "discard-reopen-supported");
  assert.equal(policy.smoke.acceptanceRecordAction, "invoke-after-authenticated-discard-reopen-evidence");
  assert.equal(policy.smoke.intermediateEvidence, "immutable-acceptance-observation");
  assert.equal(policy.jobInputs.styleSample.styleLockState, "provisional");
  assert.equal(policy.jobInputs.styleSample.approvedSample, "must-be-null");
  assert.deepEqual(policy.jobInputs.styleSample.required, [
    "exact-recipe-and-hash",
    "reference-snapshots",
    "representative-page-spec-and-prompt",
    "one-call-authorization",
  ]);
  assert.equal(policy.jobInputs.deckAndPageRegeneration.styleLockState, "approved");
  assert.equal(policy.jobInputs.deckAndPageRegeneration.approvedSample, "authenticated-non-null");
  assert.deepEqual(policy.jobInputs.deckAndPageRegeneration.required, [
    "exact-recipe-and-hash",
    "reference-snapshots",
    "page-specific-spec-and-prompt",
    "generation-authorization",
  ]);
  assert.deepEqual(policy.changeInvalidation.style, [
    "style-sample-generation",
    "style-sample",
    "generation-authorization",
    "deck-review",
    "formal-delivery",
    "acceptance-evidence",
  ]);
}

test("machine contract encodes all user decisions and rejects unsafe workflow variants", async () => {
  const contract = JSON.parse(await text("references/阶段契约.json")) as StageContract;
  validateStageContract(contract);

  const invalid: Array<[string, (fixture: StageContract) => void]> = [
    ["silent completion", (fixture) => { fixture.workflowPolicy.conversation.silentEndToEndAllowed = true; }],
    ["style multi-select", (fixture) => { fixture.workflowPolicy.style.selectionMode = "multiple"; }],
    ["dependency default style", (fixture) => { fixture.workflowPolicy.style.defaultAllowed = true; }],
    ["parallel page generation", (fixture) => { fixture.workflowPolicy.generation.scheduling = "parallel"; }],
    ["SuperPPT provider choice", (fixture) => { fixture.workflowPolicy.generation.providerSelectedBy = "superppt"; }],
    ["direct dependency execution", (fixture) => { fixture.workflowPolicy.generation.cliExecutesDependency = true; }],
    ["generic deck-review approval", (fixture) => { fixture.workflowPolicy.delivery.genericApprovalAllowed = true; }],
    ["pre-review delivery", (fixture) => { fixture.workflowPolicy.delivery.reviewRequired = false; }],
    ["saved smoke mutation", (fixture) => { fixture.workflowPolicy.smoke.copyDisposition = "save"; }],
    ["machine auto-advance", (fixture) => { fixture.stages[0]!.mustWaitForUser = false; }],
    ["unauthenticated discard invocation", (fixture) => { fixture.workflowPolicy.smoke.acceptanceRecordAction = "invoke-now"; }],
    ["sample requires approved sample", (fixture) => { fixture.workflowPolicy.jobInputs.styleSample.approvedSample = "authenticated-non-null"; }],
    ["deck lacks approved sample", (fixture) => { fixture.workflowPolicy.jobInputs.deckAndPageRegeneration.approvedSample = "must-be-null"; }],
    ["style change skips sample authorization", (fixture) => { fixture.workflowPolicy.changeInvalidation.style.shift(); }],
  ];
  for (const [label, mutate] of invalid) {
    const fixture = structuredClone(contract);
    mutate(fixture);
    assert.throws(() => validateStageContract(fixture), (error: unknown) => error instanceof Error, label);
  }
});

test("entrypoint is concise and routes each maintained detail to one reference", async () => {
  const skill = await text("SKILL.md");
  for (const reference of references) {
    assert.match(skill, new RegExp(`references/${reference.replace(".", "\\.")}`));
    assert.ok((await text(`references/${reference}`)).trim().length > 0, `${reference} must not be empty`);
  }
  assert.ok(skill.split("\n").length <= 115, "conditional detail belongs in references");
  assert.match(skill, /阶段契约.*唯一|sole.*authority/i);
});

test("guided route stops at content-specific checkpoints and keeps every earlier stage revisable", async () => {
  const [skill, gates, route] = await Promise.all([
    text("SKILL.md"),
    text("references/门禁清单.md"),
    text("references/修改路由.md"),
  ]);
  const workflow = `${skill}\n${gates}\n${route}`;

  const checkpoints = [
    "针对内容追问",
    "outline",
    "slide-specs",
    "单选",
    "style-sample-generation",
    "style-sample",
    "generation-authorization",
    "串行",
    "deck-review",
  ];
  let cursor = -1;
  for (const checkpoint of checkpoints) {
    const next = workflow.indexOf(checkpoint, cursor + 1);
    assert.ok(next > cursor, `${checkpoint} must appear after the preceding checkpoint`);
    cursor = next;
  }
  assert.match(workflow, /每次只.*一个.*问题|one.*decision.*at a time/is);
  assert.match(workflow, /已经知道|已知内容/);
  assert.match(workflow, /前序阶段.*始终可修改|返回前序/);
  assert.match(workflow, /影响.*证据.*下游|下游.*影响.*证据/is);
  assert.match(workflow, /impact.*approve-impact.*apply-impact/is);
  assert.match(workflow, /不得静默|禁止静默/);
  assert.match(workflow, /展示.*userVisibleArtifact.*等待.*allowedNextActions|present.*userVisibleArtifact.*wait.*allowedNextActions/is);
  assert.match(workflow, /机器.*校验.*不能.*继续|machine validation.*cannot.*advance/is);
});

test("style choice is one compact real-preview selection and its immutable lock is delegated unchanged", async () => {
  const [skill, dependencies, catalogText] = await Promise.all([
    text("SKILL.md"),
    text("references/依赖说明.md"),
    text("assets/styles/catalog.json"),
  ]);
  const catalog = JSON.parse(catalogText) as { selectionMode: string; styles: Array<{ preview: string }> };
  const workflow = `${skill}\n${dependencies}`;
  assert.equal(catalog.selectionMode, "single");
  assert.ok(catalog.styles.length >= 8);
  assert.ok(catalog.styles.every(({ preview }) => preview.startsWith("previews/") && preview.endsWith(".jpg")));
  assert.match(workflow, /通常.*三|normally three/i);
  assert.match(workflow, /真实预览|real preview/i);
  assert.match(workflow, /exact recipe.*hash|配方.*哈希/is);
  assert.match(workflow, /unchanged|原样/);
  assert.match(workflow, /provider.*channel.*不.*重述|提供者.*渠道.*不.*重述/is);
  assert.match(workflow, /applyDependencyDefaultStyle.*false/);
  assert.match(workflow, /provisional.*approvedSample.*null/is);
  assert.match(workflow, /approved Style Lock.*authenticated.*non-null approved sample/is);
  assert.doesNotMatch(workflow, /pass .*approved sample.*into every immutable.*job|把.*approved sample.*交给每个.*job/i);
});

test("delegation discloses exact outbound inputs and preserves current Task 10 routes", async () => {
  const [skill, dependencies] = await Promise.all([
    text("SKILL.md"),
    text("references/依赖说明.md"),
  ]);
  const workflow = `${skill}\n${dependencies}`;
  for (const boundary of ["出站文本", "参考图", "页数", "调用次数", "输出位置", "ai-image-to-ppt"]) {
    assert.match(workflow, new RegExp(boundary));
  }
  for (const usage of ["style-reference", "subject-reference", "art-direction"]) {
    assert.match(workflow, new RegExp(usage));
  }
  assert.match(workflow, /art-direction.*不支持.*停止|unsupported art-direction.*stop/is);
  assert.match(workflow, /read.*ai-image-to-ppt\/SKILL\.md|读取.*ai-image-to-ppt\/SKILL\.md/is);
  assert.match(workflow, /admit-image-call.*record-image-result/is);
  assert.match(workflow, /逐页串行|serially/);
  assert.match(workflow, /不重新生成.*成功|successful.*not regenerate/is);

  const requiredRoutes = [
    "publish-sample-generation-plan",
    "approve --project --gate style-sample-generation",
    "prepare-style-sample-job",
    "publish-generation-plan",
    "approve --project --gate generation-authorization",
    "prepare-deck-job",
    "admit-image-call",
    "record-image-result",
    "assemble-candidate",
    "publish-deck-review",
    "deck-review-action",
  ];
  for (const route of requiredRoutes) assert.match(dependencies, new RegExp(route.replaceAll("-", "\\-")));
  assert.doesNotMatch(dependencies, /approve --project .*deck-review/);
});

test("review blocks delivery and selected-page editability remains preview-gated", async () => {
  const [skill, dependencies, route] = await Promise.all([
    text("SKILL.md"),
    text("references/依赖说明.md"),
    text("references/修改路由.md"),
  ]);
  const workflow = `${skill}\n${dependencies}\n${route}`;
  assert.match(workflow, /候选.*montage.*修改某页.*返回前序.*确认交付/is);
  assert.match(workflow, /confirm-delivery.*才.*交付|delivery.*only.*confirm-delivery/is);
  assert.match(workflow, /只.*选中页.*convert|convert.*selected page/is);
  assert.match(workflow, /slide-preview/);
  assert.match(workflow, /render-editable.*confirm-preview.*replace-slide/is);
  assert.match(workflow, /不能把整页图片描述为可编辑/);
  assert.match(workflow, /already-editable.*不.*regenerate|already-editable.*不得.*重生/is);
});

test("controlled WPS smoke edits, undoes, discards, and reopens without saving canonical output", async () => {
  const [skill, dependencies] = await Promise.all([
    text("SKILL.md"),
    text("references/依赖说明.md"),
  ]);
  const workflow = `${skill}\n${dependencies}`;
  for (const evidence of ["选定对象", "观察到的修改", "撤销结果", "丢弃结果", "重开结果"]) {
    assert.match(workflow, new RegExp(evidence));
  }
  assert.match(workflow, /discard|no-save|不保存/);
  assert.match(workflow, /npm run cli -- acceptance-smoke-copy --project/);
  assert.match(workflow, /npm run cli -- acceptance-record --project .* --input/);
  assert.match(workflow, /deck-smoke\.pptx/);
  assert.match(workflow, /绝不.*canonical.*deck\.pptx|禁止.*canonical.*deck\.pptx/is);
  assert.doesNotMatch(workflow, /客户端编辑、保存、关闭|保存、关闭、重新打开|edit representative text.*then save/i);
  assert.match(workflow, /temporaryEditObserved:true/);
  assert.match(workflow, /undoObserved:true/);
  assert.match(workflow, /saveDecision:"discarded"/);
  assert.match(workflow, /reopenObserved:true/);
  assert.match(workflow, /成功.*记录.*正式交付|successful authenticated record.*formal delivery/is);
  assert.match(workflow, /不得虚构|never fabricate/i);
  assert.doesNotMatch(workflow, /blocked until Task 12|blocked-until-task-12|task-11-save-based-incompatible/i);
});
