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

async function text(path: string): Promise<string> {
  return readFile(`${skillRoot}/${path}`, "utf8");
}

test("declares the sole nine-stage interaction contract and exact human gates", async () => {
  const contract = JSON.parse(await text("references/阶段契约.json")) as {
    stages: Array<{ stage: number; id: string; interaction: string; action: string }>;
    gates: Array<{ id: string; kind: string; interaction: string; action: string }>;
  };

  assert.deepEqual(contract.stages.map(({ stage, id }) => [stage, id]), [
    [0, "preflight"],
    [1, "intake"],
    [2, "outline"],
    [3, "slide-specs"],
    [4, "style-sample"],
    [5, "generation"],
    [6, "assembly"],
    [7, "revision"],
    [8, "delivery"],
  ]);
  assert.deepEqual(
    contract.gates.filter(({ kind }) => kind === "ordinary").map(({ id }) => id),
    ["outline", "slide-specs", "style-sample"],
  );
  assert.deepEqual(
    contract.gates.filter(({ kind }) => kind === "conditional").map(({ id }) => id),
    ["revision-impact", "slide-preview"],
  );
  assert.deepEqual(
    contract.stages.filter(({ interaction, action }) => interaction === "human" && action === "wait").map(({ id }) => id),
    ["outline", "slide-specs", "style-sample"],
  );
  assert.ok(contract.gates.every(({ interaction, action }) => interaction === "human" && action === "wait"));
});

test("keeps the entrypoint compact and routes each conditional detail to one reference", async () => {
  const skill = await text("SKILL.md");
  for (const reference of references) {
    assert.match(skill, new RegExp(`references/${reference.replace(".", "\\.")}`));
    assert.ok((await text(`references/${reference}`)).trim().length > 0, `${reference} must not be empty`);
  }
  assert.match(skill, /sole wait\/continue authority|sole .*authority/i);
});

test("preserves revisable baselines and blocks unreviewed upstream mutation", async () => {
  const [skill, gates, route] = await Promise.all([
    text("SKILL.md"),
    text("references/门禁清单.md"),
    text("references/修改路由.md"),
  ]);
  const workflow = `${skill}\n${gates}\n${route}`;

  assert.match(workflow, /确认只建立可恢复的版本基线/);
  assert.match(workflow, /前序阶段.*始终可修改/);
  assert.match(workflow, /revision-impact/);
  assert.match(workflow, /impact.*approve-impact.*apply-impact/is);
  assert.match(workflow, /不得静默|禁止静默/);
  assert.match(workflow, /无法.*deterministic CLI|deterministic CLI.*无法/i);
});

test("defines agent-authored planning, single-select rich style, and auditable prompt compilation", async () => {
  const skill = await text("SKILL.md");

  assert.match(skill, /Markdown.*brief.*outline.*spec/is);
  assert.match(skill, /agent orchestration|Agent 编排/i);
  assert.match(skill, /风格只能单选/);
  assert.match(skill, /紧凑.*高细节|高细节.*紧凑/);
  assert.match(skill, /提示词编译器/);
  assert.match(skill, /deterministically derived from the agent-authored per-slide spec/i);
  assert.doesNotMatch(skill, /agent-authored visual-director/i);
  assert.match(skill, /可审计/);
  assert.match(skill, /幻觉文字|虚构文字/);
  assert.doesNotMatch(skill, /多选风格|自动把整套.*可编辑/);
});

test("makes model disclosure, QA, preview rejection, editability, and real delivery discoverable", async () => {
  const [skill, dependencies, route, workspace] = await Promise.all([
    text("SKILL.md"),
    text("references/依赖说明.md"),
    text("references/修改路由.md"),
    text("references/工作区契约.md"),
  ]);
  const workflow = `${skill}\n${dependencies}\n${route}\n${workspace}`;

  for (const boundary of ["提供者", "页数", "最大调用次数", "出站", "输出位置"]) {
    assert.match(workflow, new RegExp(boundary));
  }
  assert.match(workflow, /record-qa/);
  assert.match(workflow, /slide-preview/);
  assert.match(workflow, /promote-editable --project --slide --revision --element --kind/);
  assert.match(workflow, /不修改内容.*promote-editable|promote-editable.*不修改内容/is);
  assert.match(workflow, /promote-editable.*页面级重建|页面级重建.*promote-editable/is);
  assert.match(workflow, /--element.*--kind.*只.*目标.*已提取/is);
  assert.match(workflow, /全部可靠提取.*text.*transparent assets/is);
  assert.match(workflow, /背景.*未提取.*仍不可编辑/is);
  assert.match(workflow, /未被提取.*regenerate|regenerate.*未被提取/is);
  assert.match(workflow, /拒绝.*不变更|拒绝.*不修改/s);
  assert.match(workflow, /已.*editable.*不重复.*OCR.*vision/is);
  assert.match(workflow, /不能把整页图片描述为可编辑/);
  assert.match(workflow, /PPTX.*PDF.*montage.*acceptance/is);
  assert.match(workflow, /WPS.*PowerPoint.*保存.*关闭.*重新打开/is);
});
