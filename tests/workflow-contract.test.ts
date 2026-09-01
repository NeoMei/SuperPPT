import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DECK_EDIT_MODE_QUESTION,
  bindAgentDeckConfirmation,
  classifyDeckEditMode,
  describeDeckEditRoute,
  mapUpstreamDeckChange,
  presentUpstreamImpactPlan,
  translateManualDeckSignal,
} from "../src/editable/route.js";

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
    selectionEvidence: string;
    legacyEvidence: string;
    publicationRecovery: string;
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
  editing: {
    artifactKind: string;
    localPptxLinksPerResponse: number;
    previewAndEditor: string;
    pageResolution: string;
    authorization: {
      action: string;
      binding: string;
      consumption: string;
      failure: string;
    };
    manual: {
      revisionBinding: string;
      waitForUserText: string;
      internalSignal: string;
      acceptsSavedOnly: boolean;
      adoption: string;
      topology: string;
    };
    agent: {
      waitForUserText: string;
      confirmationBinding: string;
      pointerBeforeConfirmation: string;
    };
    rollback: string;
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
    ordinary: ["outline", "slide-specs", "style-selection", "style-sample", "generation-authorization", "deck-review"],
    "execution-authorization": ["style-sample-generation"],
    conditional: ["revision-impact"],
  };
  for (const [kind, expected] of Object.entries(expectedByKind) as Array<[GateKind, string[]]>) {
    assert.deepEqual(contract.stages.filter((entry) => entry.kind === kind).map((entry) => entry.id), expected);
  }
  assert.equal(new Set(contract.stages.map(({ id }) => id)).size, contract.stages.length);
  const expectedInvalidation: Record<string, string[]> = {
    outline: ["slide-specs", "style-selection", "style-sample-generation", "style-sample", "generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "slide-specs": ["style-selection", "style-sample-generation", "style-sample", "generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "style-selection": ["style-sample-generation", "style-sample", "generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "style-sample": ["generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "generation-authorization": ["deck-review", "formal-delivery", "acceptance-evidence"],
    "deck-review": ["formal-delivery", "acceptance-evidence"],
    "style-sample-generation": ["style-sample", "generation-authorization", "deck-review", "formal-delivery", "acceptance-evidence"],
    "revision-impact": ["approved-impact-plan.staleSlideIds", "approved-impact-plan.restartStage-and-downstream-gates", "formal-delivery", "acceptance-evidence"],
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
  assert.equal(policy.style.selectionEvidence, "v2-current-revision-representative-slide-and-same-source-style-lock-sha");
  assert.equal(policy.style.legacyEvidence, "v1-read-migration-only-cannot-authorize-sample-plan");
  assert.equal(policy.style.publicationRecovery, "exact-idempotent-v1-to-v2-migration-and-checkpoint-replay; conflicts-byte-exact-fail-closed");
  assert.equal(policy.generation.executor, "agent-invokes-resolved-ai-image-to-ppt-skill");
  assert.equal(policy.generation.cliExecutesDependency, false);
  assert.equal(policy.generation.scheduling, "serial");
  assert.equal(policy.generation.providerSelectedBy, "ai-image-to-ppt-host-routing");
  assert.equal(policy.delivery.reviewRequired, true);
  assert.equal(policy.delivery.genericApprovalAllowed, false);
  assert.deepEqual(policy.delivery.reviewActions, ["edit-page", "return-upstream", "confirm-delivery"]);
  assert.equal(policy.editing.artifactKind, "complete-local-pptx");
  assert.equal(policy.editing.localPptxLinksPerResponse, 1);
  assert.equal(policy.editing.previewAndEditor, "wps-or-powerpoint");
  assert.equal(policy.editing.pageResolution, "current-reconciled-topology");
  assert.deepEqual(policy.editing.authorization, {
    action: "complete-deck-review-edit-page",
    binding: "exact-current-revision-sha256-stable-slide-id",
    consumption: "one-time-atomic-before-candidate-session-creation",
    failure: "missing-wrong-slide-stale-replay-fail-closed-zero-residue",
  });
  assert.deepEqual(policy.editing.manual, {
    revisionBinding: "resolver-revision-id-must-still-be-current",
    waitForUserText: "已保存并关闭",
    internalSignal: "saved-and-closed",
    acceptsSavedOnly: false,
    adoption: "stable-read-validate-metadata-only-pointer-move",
    topology: "reconcile-move-insert-delete-with-stable-slide-ids",
  });
  assert.deepEqual(policy.editing.agent, {
    waitForUserText: "确认",
    confirmationBinding: "exact-presented-sha256",
    pointerBeforeConfirmation: "unchanged",
  });
  assert.equal(policy.editing.rollback, "pointer-only-no-pptx-write");
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
  const [contractText, gateChecklist] = await Promise.all([
    text("references/阶段契约.json"),
    text("references/门禁清单.md"),
  ]);
  const contract = JSON.parse(contractText) as StageContract;
  validateStageContract(contract);
  const declaredCount = /它的(\d+|[一二三四五六七八九十])个 stage entry/.exec(gateChecklist)?.[1];
  const chineseCounts: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  assert.ok(declaredCount, "门禁清单 must declare the machine contract stage-entry count");
  assert.equal(chineseCounts[declaredCount] ?? Number(declaredCount), contract.stages.length);
  const checklistInvalidations = new Map(
    [...gateChecklist.matchAll(/^- `([^`]+)` → ([^。]+)。$/gm)].map((match) => [match[1]!, match[2]!.split(" → ")]),
  );
  for (const entry of contract.stages) {
    const documented = checklistInvalidations.get(entry.id);
    if (!documented) continue;
    assert.deepEqual(
      documented.map((rawValue) => {
        const value = rawValue.replaceAll("`", "");
        return value === "formal delivery" ? "formal-delivery" : value === "acceptance evidence" ? "acceptance-evidence" : value;
      }),
      entry.invalidationDependencies,
      `${entry.id} checklist invalidation order`,
    );
  }

  const invalid: Array<[string, (fixture: StageContract) => void]> = [
    ["silent completion", (fixture) => { fixture.workflowPolicy.conversation.silentEndToEndAllowed = true; }],
    ["style multi-select", (fixture) => { fixture.workflowPolicy.style.selectionMode = "multiple"; }],
    ["dependency default style", (fixture) => { fixture.workflowPolicy.style.defaultAllowed = true; }],
    ["parallel page generation", (fixture) => { fixture.workflowPolicy.generation.scheduling = "parallel"; }],
    ["SuperPPT provider choice", (fixture) => { fixture.workflowPolicy.generation.providerSelectedBy = "superppt"; }],
    ["direct dependency execution", (fixture) => { fixture.workflowPolicy.generation.cliExecutesDependency = true; }],
    ["generic deck-review approval", (fixture) => { fixture.workflowPolicy.delivery.genericApprovalAllowed = true; }],
    ["pre-review delivery", (fixture) => { fixture.workflowPolicy.delivery.reviewRequired = false; }],
    ["single-page handoff", (fixture) => { fixture.workflowPolicy.editing.artifactKind = "single-page-pptx"; }],
    ["multiple local links", (fixture) => { fixture.workflowPolicy.editing.localPptxLinksPerResponse = 2; }],
    ["stale page resolution", (fixture) => { fixture.workflowPolicy.editing.pageResolution = "outline-order"; }],
    ["manual saved-only acceptance", (fixture) => { fixture.workflowPolicy.editing.manual.acceptsSavedOnly = true; }],
    ["manual rewrite adoption", (fixture) => { fixture.workflowPolicy.editing.manual.adoption = "replace-saved-page"; }],
    ["unbound Agent confirmation", (fixture) => { fixture.workflowPolicy.editing.agent.confirmationBinding = "session-only"; }],
    ["rollback rewrite", (fixture) => { fixture.workflowPolicy.editing.rollback = "copy-and-rewrite"; }],
    ["machine auto-advance", (fixture) => { fixture.stages[0]!.mustWaitForUser = false; }],
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
    "style-selection",
    "approve --project --gate style-sample-generation",
    "prepare-style-sample-job",
    "publish-generation-plan",
    "approve --project --gate generation-authorization",
    "prepare-deck-job",
    "admit-image-call",
    "record-image-result",
    "current-deck-link",
    "resolve-current-deck-page",
    "prepare-manual-deck",
    "adopt-saved-deck",
    "prepare-agent-deck",
    "confirm-agent-deck",
    "reject-deck-candidate",
    "rollback-deck",
    "complete-deck-review",
  ];
  for (const route of requiredRoutes) assert.match(dependencies, new RegExp(route.replaceAll("-", "\\-")));
  assert.doesNotMatch(dependencies, /approve --project .*deck-review/);
});

test("active workflow hands off only one complete local PPTX and names exact wait signals", async () => {
  const [skill, dependencies, route, gates, workspace, stages] = await Promise.all([
    text("SKILL.md"),
    text("references/依赖说明.md"),
    text("references/修改路由.md"),
    text("references/门禁清单.md"),
    text("references/工作区契约.md"),
    text("references/阶段契约.json"),
  ]);
  const workflow = `${skill}\n${dependencies}\n${route}\n${gates}\n${workspace}\n${stages}`;
  assert.match(workflow, /需要我帮你修改，还是由你手动修改？/);
  assert.match(workflow, /一句|one sentence/i);
  assert.match(workflow, /完整.*本地.*PPTX.*链接|complete local PPTX link/i);
  assert.match(workflow, /停止.*等待|stop.*wait/is);
  assert.match(workflow, /已保存并关闭/);
  assert.match(workflow, /确认.*SHA-256|SHA-256.*确认/is);
  assert.match(workflow, /current-deck-link.*prepare-manual-deck.*adopt-saved-deck/is);
  assert.match(workflow, /resolve-current-deck-page[\s\S]*(?:revisionId|revision ID)[\s\S]*prepare-manual-deck[\s\S]*--revision-id/i);
  assert.match(workflow, /prepare-agent-deck.*confirm-agent-deck.*reject-deck-candidate/is);
  assert.match(workflow, /rollback-deck/);
  for (const obsolete of [
    "render-editable",
    "confirm-preview",
    "replace-slide",
    "assemble-candidate",
    "publish-deck-review",
    "deck-review-action",
    "slide-preview",
    "montage",
  ]) assert.doesNotMatch(workflow, new RegExp(obsolete, "i"), obsolete);
  assert.match(workflow, /(?:former|legacy|旧)[^\n]*acceptance-smoke-copy[^\n]*acceptance-record[^\n]*(?:not|removed|移除|不)/i);
  assert.doesNotMatch(workflow, /(?:交付|展示|链接|handoff)[^\n]*(?:PNG|PDF|单页 PPTX|browser|cloud|upload)/i);
  assert.match(workflow, /不能把整页图片描述为可编辑/);
});

test("main plan binds every manual preparation example to one resolver snapshot and stale failure leaves no residue", async () => {
  const plan = await readFile("docs/superpowers/plans/2026-08-30-local-full-deck-editing.md", "utf8");
  const task3Start = plan.indexOf("### Task 3: Implement Manual-Save and Agent-Confirmation Workflows");
  const task4Start = plan.indexOf("### Task 4:", task3Start);
  assert.ok(task3Start >= 0 && task4Start > task3Start, "Task 3 plan section");
  const task3 = plan.slice(task3Start, task4Start);

  assert.match(
    task3,
    /Produces `resolveCurrentDeckPage\(\{ root, pageNumber \}\): Promise<\{ revisionId; pageNumber; stableSlideId; management \}>`\./,
  );
  assert.doesNotMatch(plan, /resolveCurrentDeckPage[^\n]*slideIndex/);

  const resolveIndex = task3.indexOf("resolveCurrentDeckPage({");
  const prepareIndex = task3.indexOf("prepareManualEditDeck({");
  assert.ok(resolveIndex >= 0 && resolveIndex < prepareIndex, "resolve the current page before manual preparation");
  assert.match(task3, /const resolved = await resolveCurrentDeckPage\(\{[\s\S]*?root: fixture\.root,[\s\S]*?pageNumber: 2,[\s\S]*?\}\);/);
  assert.match(task3, /prepareManualEditDeck\(\{[\s\S]*?revisionId: resolved\.revisionId,[\s\S]*?slideId: resolved\.stableSlideId,[\s\S]*?\}\);/);
  assert.match(task3, /revisionId[^\n]*(?:still|must remain|仍是|必须仍是)[^\n]*current/i);
  assert.match(task3, /(?:fail closed|失败关闭)[^\n]*(?:before|在)[^\n]*candidate[^\n]*session/i);
  assert.match(task3, /(?:zero|no|不得留下|零)[^\n]*(?:candidate|session)[^\n]*(?:residue|残留)/i);

  const manualCalls = [...plan.matchAll(/prepareManualEditDeck\(\{([\s\S]*?)\n\s*\}\);/g)];
  assert.ok(manualCalls.length > 0, "documented prepareManualEditDeck calls");
  for (const [, options] of manualCalls) {
    assert.match(options!, /revisionId:\s*resolved\.revisionId/);
    assert.match(options!, /slideId:\s*resolved\.stableSlideId/);
  }
});

test("main plan keeps presentation identity authoritative when WPS removes optional creation evidence", async () => {
  const plan = await readFile("docs/superpowers/plans/2026-08-30-local-full-deck-editing.md", "utf8");
  assert.match(plan, /creationId:\s*z\.number\(\)[^\n]*\.nullable\(\)/);
  assert.match(plan, /creationId[^\n]*(?:null|missing)[^\n]*presentationSlideId[^\n]*(?:stable|preserve)/i);
  assert.match(plan, /creationId[^\n]*non-null[^\n]*(?:agree|consistent)[^\n]*presentation/i);
  assert.match(plan, /presentationSlideId[^\n]*(?:tombstone|deleted)[^\n]*(?:reject|blocking)/i);
  assert.match(plan, /new[^\n]*presentationSlideId[^\n]*creationId[^\n]*null[^\n]*unmanaged/i);
  assert.doesNotMatch(plan, /new slide part\/creation ID with no known identity/);
});

test("manual and Agent wait signals are exact and bind the presented candidate hash", () => {
  const presentedSha256 = "a".repeat(64);
  assert.equal(translateManualDeckSignal("已保存并关闭"), "saved-and-closed");
  for (const rejected of ["已保存", "保存并关闭", "已保存并关闭。"]) {
    assert.throws(() => translateManualDeckSignal(rejected), /已保存并关闭/);
  }
  assert.equal(bindAgentDeckConfirmation("确认", presentedSha256), presentedSha256);
  for (const rejected of ["好", "确认。", "approve"]) {
    assert.throws(() => bindAgentDeckConfirmation(rejected, presentedSha256), /确认/);
  }
  assert.throws(() => bindAgentDeckConfirmation("确认", "0"), /64|invalid|regex/i);
});

test("deck editing recognizes natural answers to the exact mode question and rejects contradictions", () => {
  const cases = [
    ["我自己改这一页", "manual"],
    ["我手动修改这一页", "manual"],
    ["由我手动修改", "manual"],
    ["帮我改这一页", "agent"],
    ["帮我修改这一页", "agent"],
    ["你帮我修改", "agent"],
    ["把标题改短", null],
  ] as const;
  for (const [instruction, expected] of cases) {
    assert.equal(classifyDeckEditMode({ change: "text", instruction }), expected, instruction);
  }
  assert.throws(
    () => classifyDeckEditMode({ change: "text", instruction: "你帮我修改，也可以由我手动修改" }),
    /contradictory|冲突|只能选择/i,
  );
  assert.equal(DECK_EDIT_MODE_QUESTION, "需要我帮你修改，还是由你手动修改？");
});

test("deck edit routing is one sentence and upstream choices bind actual impact-plan fields", () => {
  const revisionId = "00000000-0000-4000-8000-000000000091";
  const slideId = "00000000-0000-4000-8000-000000000092";
  const routeDisclosures = [describeDeckEditRoute({
    route: "direct-edit",
    currentRevisionId: revisionId,
    slideId,
    operations: [{ kind: "replace-text", elementId: "title", text: "New" }],
  }), describeDeckEditRoute({
    route: "activate-editable",
    currentRevisionId: revisionId,
    slideId,
    operations: [],
  }), describeDeckEditRoute({
    route: "regenerate-slide",
    currentRevisionId: revisionId,
    slideId,
    reason: "layout",
    styleLockSha256: "a".repeat(64),
  })];
  assert.match(routeDisclosures[0]!, /直接修改.*完整.*PPTX/);
  assert.match(routeDisclosures[1]!, /转为可编辑.*完整.*PPTX/);
  assert.match(routeDisclosures[2]!, /重做.*完整.*PPTX/);
  for (const disclosure of routeDisclosures) {
    assert.equal(disclosure.split("。").filter(Boolean).length, 1, disclosure);
  }
  const slideIds = [
    "00000000-0000-4000-8000-000000000091",
    "00000000-0000-4000-8000-000000000092",
    "00000000-0000-4000-8000-000000000093",
  ];
  assert.deepEqual(mapUpstreamDeckChange("修改大纲", slideIds), { kind: "outline-structure", slideIds });
  assert.deepEqual(mapUpstreamDeckChange("修改第 2 页描述", slideIds), { kind: "slide-spec", slideIds: [slideIds[1]] });
  assert.deepEqual(mapUpstreamDeckChange("换风格", slideIds), { kind: "style" });
  assert.throws(() => mapUpstreamDeckChange("修改第 4 页描述", slideIds), /page|页码|range/i);

  const impactBody = {
    schemaVersion: 1,
    kind: "revision-impact-plan",
    projectId: "00000000-0000-4000-8000-000000000081",
    baseRevisionId: "00000000-0000-4000-8000-000000000082",
    baseRevisionNumber: 1,
    baseManifestSha256: "a".repeat(64),
    evidencePath: "revisions/pending-impact.json",
    change: { kind: "slide-spec", slideIds: [slideIds[1]] },
    staleSlideIds: [slideIds[1]],
    invalidatedOutputs: ["complete-local-pptx", "formal-delivery", "acceptance-evidence"],
    invalidateExports: true,
    restartStage: "slide-specs",
  } as const;
  const impactSha256 = createHash("sha256").update(JSON.stringify(impactBody)).digest("hex");
  const presentation = presentUpstreamImpactPlan({ ...impactBody, sha256: impactSha256 });
  assert.deepEqual(presentation.affectedStableSlideIds, [slideIds[1]]);
  assert.deepEqual(presentation.invalidatedOutputs, ["complete-local-pptx", "formal-delivery", "acceptance-evidence"]);
  assert.equal(presentation.restartStage, "slide-specs");
  assert.equal(presentation.sha256, impactSha256);
  assert.equal(presentation.waitFor, "确认");
});
