import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CompleteDeckReviewActionRequestSchema } from "../src/acceptance/schema.js";
import { applyCompleteDeckReviewAction } from "../src/project/promotion.js";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const text = (path: string) => readFile(path, "utf8");

test("publishes the approved Git-backed marketplace metadata", async () => {
  const marketplace = await json(".agents/plugins/marketplace.json");

  assert.deepEqual(marketplace, {
    name: "superppt",
    interface: { displayName: "SuperPPT" },
    plugins: [
      {
        name: "superppt",
        source: {
          source: "url",
          url: "https://github.com/NeoMei/SuperPPT.git",
          ref: "main",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ],
  });
});

test("publishes one strict three-action complete-deck review boundary", () => {
  assert.equal(typeof applyCompleteDeckReviewAction, "function");
  const base = { revisionId: "00000000-0000-4000-8000-000000000099", deckSha256: "a".repeat(64) };
  const slideId = "00000000-0000-4000-8000-000000000098";
  assert.deepEqual(CompleteDeckReviewActionRequestSchema.parse({ ...base, action: "edit-page", slideId }), {
    ...base,
    action: "edit-page",
    slideId,
  });
  for (const action of ["return-upstream", "confirm-delivery"] as const) {
    assert.equal(CompleteDeckReviewActionRequestSchema.parse({ ...base, action }).action, action);
    assert.throws(() => CompleteDeckReviewActionRequestSchema.parse({ ...base, action, slideId }), /unrecognized/i);
  }
  assert.throws(() => CompleteDeckReviewActionRequestSchema.parse({ ...base, action: "edit-page" }), /invalid/i);
  assert.throws(() => CompleteDeckReviewActionRequestSchema.parse({ ...base, action: "edit-page", slideId, slideIds: [slideId] }), /unrecognized/i);
  assert.throws(() => CompleteDeckReviewActionRequestSchema.parse({ ...base, action: "approve" }), /invalid/i);
  assert.throws(() => CompleteDeckReviewActionRequestSchema.parse({ ...base, action: "confirm-delivery", gate: "deck-review" }), /unrecognized/i);
  assert.throws(() => CompleteDeckReviewActionRequestSchema.parse({
    ...base,
    action: "confirm-delivery",
    candidateId: "00000000-0000-4000-8000-000000000097",
  }), /unrecognized/i);
});

test("runs portable and full verification cross-platform with Node 22.6", async () => {
  const [workflow, verifier, contractVerifier, packageDocument] = await Promise.all([
    json(".github/workflows/ci.yml"),
    text("scripts/verify-full.mjs"),
    text("scripts/verify-contract.mjs"),
    json("package.json"),
  ]);

  assert.deepEqual(workflow.jobs.portable.strategy.matrix.os, [
    "ubuntu-latest",
    "macos-latest",
    "windows-latest",
  ]);
  assert.equal(workflow.jobs.portable.steps[1].with["node-version"], "22.6.0");
  assert.ok(workflow.jobs.portable.steps.some((step: { run?: string }) => step.run === "npm run verify:portable"));
  assert.ok(workflow.jobs.portable.steps.every((step: { run?: string }) => step.run !== "bash scripts/verify.sh"));
  assert.match(verifier, /verify-contract\.mjs/);
  for (const command of ["test", "lint:types", "build", "test:compiled", "audit:dependencies"]) {
    assert.match(verifier, new RegExp(`"${command.replace(":", "\\:")}"`));
  }
  assert.match(verifier, /"git", \["diff", "--check"\]/);
  assert.doesNotMatch(verifier, /bash scripts\/verify\.sh/);
  assert.equal(packageDocument.scripts["verify:full"], "node scripts/verify-full.mjs");
  assert.match(contractVerifier, /unfinished placeholders found/);
  for (const required of ["tests/presentation-service.test.ts", "tests/deck.test.ts"]) {
    assert.match(packageDocument.scripts["test:portable"], new RegExp(required.replace(".", "\\.")));
    assert.match(packageDocument.scripts["test:portable:compiled"], new RegExp(`dist/${required.replace(/\.ts$/, ".js").replace(".", "\\.")}`));
  }
});

test("documents only the verified V1 capabilities and editable boundary", async () => {
  const readme = await text("README.md");

  for (const required of [
    "描述、粘贴文本或 Markdown",
    "恰好 3 个普通确认",
    "10 种",
    "风格只能单选",
    "前序内容",
    "图片优先",
    "ai-image-to-ppt",
    "image-to-editable-pptx",
    "1280×720",
    "PPTX",
    "PDF",
    "蒙太奇",
    "验收",
    "不是整套全可编辑",
    "WPS 或 PowerPoint",
  ]) {
    assert.match(readme, new RegExp(required));
  }
  assert.match(readme, /只有[^\n]*(选中|指定)[^\n]*(成功提取|可靠提取)[^\n]*可编辑/);
  assert.doesNotMatch(readme, /项目私有风格|自定义风格/);
  assert.doesNotMatch(readme, /已经上线|已上线|现已发布/);
});

test("documents the exact secret-handling and disclosure rules", async () => {
  const security = await text("SECURITY.md");

  for (const destination of [
    "仓库文件",
    "命令行参数",
    "日志",
    "账本",
    "录屏",
    "失败运行证据",
    "验收产物",
  ]) {
    assert.match(security, new RegExp(destination));
  }
  assert.match(security, /API key|API 密钥/i);
  assert.match(security, /0600/);
  assert.match(security, /0700/);
  assert.match(security, /finally/);
  assert.match(security, /提供者/);
  assert.match(security, /出站数据/);
  assert.match(security, /停止执行/);
  assert.match(security, /轮换[^\n]*(密钥|key)/i);
});

test("uses the unmodified MIT license grant for NeoMei", async () => {
  const license = await text("LICENSE");

  assert.match(license, /^MIT License$/m);
  assert.match(license, /^Copyright \(c\) 2026 NeoMei$/m);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});
