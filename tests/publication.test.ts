import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DeckReviewActionRequestSchema } from "../src/acceptance/schema.js";
import { applyDeckReviewAction } from "../src/project/promotion.js";

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

test("publishes one strict three-action deck-review boundary", () => {
  assert.equal(typeof applyDeckReviewAction, "function");
  const base = { candidateId: "00000000-0000-4000-8000-000000000099", descriptorSha256: "a".repeat(64) };
  for (const action of ["edit-page", "return-upstream", "confirm-delivery"] as const) {
    assert.equal(DeckReviewActionRequestSchema.parse({ ...base, action }).action, action);
  }
  assert.throws(() => DeckReviewActionRequestSchema.parse({ ...base, action: "approve" }), /invalid/i);
  assert.throws(() => DeckReviewActionRequestSchema.parse({ ...base, action: "confirm-delivery", gate: "deck-review" }), /unrecognized/i);
});

test("runs deterministic verification on Linux, macOS, and Windows with Node 22.6", async () => {
  const [workflow, verifier, contractVerifier] = await Promise.all([
    text(".github/workflows/ci.yml"),
    text("scripts/verify.sh"),
    text("scripts/verify-contract.mjs"),
  ]);

  for (const runner of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(workflow, new RegExp(`- ${runner}`));
  }
  assert.match(workflow, /node-version:\s*22\.6\.0/);
  assert.match(workflow, /run:\s*bash scripts\/verify\.sh/);
  assert.match(verifier, /node scripts\/verify-contract\.mjs/);
  assert.match(verifier, /npm test/);
  assert.match(verifier, /npm run lint:types/);
  assert.match(verifier, /npm run build/);
  assert.match(verifier, /npm run test:compiled/);
  assert.match(verifier, /git diff --check/);
  assert.doesNotMatch(verifier, /bash scripts\/verify\.sh/);
  assert.match(contractVerifier, /unfinished placeholders found/);
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
