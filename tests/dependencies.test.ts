import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { preflightDependencies } from "../src/dependencies/preflight.js";
import {
  resolveDependencies,
  resolveFromSkillEntries,
} from "../src/dependencies/resolve.js";

const execFileAsync = promisify(execFile);

type Fixture = { root: string; ai: string; editable: string };

async function fixture(t: TestContext, version = "0.1.0"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "superppt-deps-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ai = join(root, "ai-image-to-ppt");
  const editable = join(root, "editable-plugin");
  await mkdir(join(ai, "scripts"), { recursive: true });
  await mkdir(join(ai, "references"), { recursive: true });
  await mkdir(join(editable, "skills", "image-to-editable-pptx"), { recursive: true });
  await writeFile(join(ai, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  await writeFile(join(ai, "scripts", "gen_slide_gemini.py"), "def gen(prompt, out_path, retries=0): return True\n");
  await writeFile(join(editable, "package.json"), JSON.stringify({ name: "image-to-editable-pptx", version, engines: { node: ">=22.6" } }));
  await writeFile(join(editable, "package-lock.json"), JSON.stringify({ name: "image-to-editable-pptx", version, lockfileVersion: 3, packages: {} }));
  await writeFile(join(editable, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  return { root, ai, editable };
}

async function expectIncompatibleVersion(t: TestContext, version: string): Promise<void> {
  const { ai, editable } = await fixture(t, version);
  await assert.rejects(
    resolveDependencies({ aiRoot: ai, editableRoot: editable }),
    /compatible image-to-editable-pptx >=0\.1\.0 <0\.2\.0/,
  );
}

test("resolves legacy ai-image and editable plugin roots", async (t) => {
  const { ai, editable } = await fixture(t);
  const resolved = await resolveDependencies({ aiRoot: ai, editableRoot: editable });
  assert.equal(resolved.ai.providers[0]?.id, "gemini-legacy");
  assert.equal(resolved.editable.version, "0.1.0");
  assert.match(resolved.editable.cli.cwd, /editable-plugin$/);
});

test("preserves Doubao and reviewer legacy capabilities", async (t) => {
  const { ai, editable } = await fixture(t);
  await writeFile(join(ai, "scripts", "gen_slide_doubao.py"), "def gen(prompt, out_path, retries=0): return True\n");
  await writeFile(join(ai, "scripts", "vision_check_gemini.py"), "def check(path): return True\n");

  const resolved = await resolveDependencies({ aiRoot: ai, editableRoot: editable });
  assert.deepEqual(resolved.ai.providers.map(({ id }) => id), ["gemini-legacy", "doubao-legacy"]);
  assert.deepEqual(resolved.ai.reviewer, {
    module: "scripts/vision_check_gemini.py",
    callable: "check",
  });
});

test("prefers a strict capability manifest and exposes gpt-image-2 without model branching", async (t) => {
  const { ai, editable } = await fixture(t);
  await writeFile(join(ai, "references", "capabilities.json"), JSON.stringify({
    contractVersion: 1,
    defaultProvider: "openai-gpt-image-2",
    providers: [{
      id: "openai-gpt-image-2",
      module: "scripts/gen_slide_gpt_image.py",
      callable: "gen",
      outputFormats: ["png"],
      supportsReferenceImages: true,
    }],
    reviewer: null,
  }));
  await writeFile(join(ai, "scripts", "gen_slide_gpt_image.py"), "def gen(prompt, out_path, retries=0): return True\n");

  const resolved = await resolveDependencies({ aiRoot: ai, editableRoot: editable });
  assert.equal(resolved.ai.defaultProvider, "openai-gpt-image-2");
  assert.equal(resolved.ai.providers[0]?.supportsReferenceImages, true);
  assert.equal((await preflightDependencies(resolved)).ok, true);
});

test("fails on an invalid present manifest instead of activating legacy fallback", async (t) => {
  const { ai, editable } = await fixture(t);
  await writeFile(join(ai, "references", "capabilities.json"), "not-json");

  await assert.rejects(
    resolveDependencies({ aiRoot: ai, editableRoot: editable }),
    /capability manifest is invalid/,
  );
});

test("fails on an unreadable present manifest instead of activating legacy fallback", async (t) => {
  const { ai, editable } = await fixture(t);
  const manifest = join(ai, "references", "capabilities.json");
  await writeFile(manifest, "{}");
  await chmod(manifest, 0o000);

  await assert.rejects(
    resolveDependencies({ aiRoot: ai, editableRoot: editable }),
    /capability manifest is unreadable/,
  );
});

test("requires the ai-image-to-ppt root Skill entry", async (t) => {
  const { ai, editable } = await fixture(t);
  await unlink(join(ai, "SKILL.md"));

  await assert.rejects(
    resolveDependencies({ aiRoot: ai, editableRoot: editable }),
    /ai-image-to-ppt Skill entry is missing/,
  );
});

test("resolves exact physical Skill entries", async (t) => {
  const { ai, editable } = await fixture(t);
  const resolved = await resolveFromSkillEntries({
    aiSkill: join(ai, "SKILL.md"),
    editableSkill: join(editable, "skills", "image-to-editable-pptx", "SKILL.md"),
  });

  assert.equal(resolved.ai.root, await realpath(ai));
  assert.equal(resolved.editable.root, await realpath(editable));
});

test("rejects existing files that are not the exact physical Skill entries", async (t) => {
  const { ai, editable } = await fixture(t);
  const wrongEditable = join(editable, "skills", "wrong", "SKILL.md");
  await mkdir(join(editable, "skills", "wrong"), { recursive: true });
  await writeFile(wrongEditable, "---\nname: wrong\n---\n");

  await assert.rejects(resolveFromSkillEntries({
    aiSkill: join(ai, "scripts", "gen_slide_gemini.py"),
    editableSkill: join(editable, "skills", "image-to-editable-pptx", "SKILL.md"),
  }), /aiSkill must be the root SKILL\.md/);
  await assert.rejects(resolveFromSkillEntries({
    aiSkill: join(ai, "SKILL.md"),
    editableSkill: wrongEditable,
  }), /editableSkill must be skills\/image-to-editable-pptx\/SKILL\.md/);
});

test("accepts the semantic version lower boundary and build metadata", async (t) => {
  const first = await fixture(t, "0.1.0");
  const second = await fixture(t, "0.1.99+build.7.sha");
  assert.equal((await resolveDependencies({ aiRoot: first.ai, editableRoot: first.editable })).editable.version, "0.1.0");
  assert.equal((await resolveDependencies({ aiRoot: second.ai, editableRoot: second.editable })).editable.version, "0.1.99+build.7.sha");
});

test("rejects semantic versions outside the compatible boundaries", async (t) => {
  await expectIncompatibleVersion(t, "0.0.999");
  await expectIncompatibleVersion(t, "0.2.0");
});

test("rejects malformed semantic versions", async (t) => {
  await expectIncompatibleVersion(t, "0.1.0junk");
  await expectIncompatibleVersion(t, "0.1.01");
  await expectIncompatibleVersion(t, "v0.1.0");
});

test("preflight reports removed provider, reviewer, and lockfile as unavailable", async (t) => {
  const { ai, editable } = await fixture(t);
  await writeFile(join(ai, "scripts", "vision_check_gemini.py"), "def check(path): return True\n");
  const resolved = await resolveDependencies({ aiRoot: ai, editableRoot: editable });
  await Promise.all([
    unlink(join(ai, "scripts", "gen_slide_gemini.py")),
    unlink(join(ai, "scripts", "vision_check_gemini.py")),
    unlink(join(editable, "package-lock.json")),
  ]);

  const report = await preflightDependencies(resolved);
  assert.equal(report.ok, false);
  assert.equal(report.reviewerAvailable, false);
  assert.deepEqual(report.problems, [
    "provider module is unreadable: scripts/gen_slide_gemini.py",
    "reviewer module is unreadable: scripts/vision_check_gemini.py",
    "image-to-editable-pptx package-lock.json is missing",
  ]);
});

test("CLI emits a successful JSON preflight report", async (t) => {
  const { ai, editable } = await fixture(t);
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "preflight"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: ai,
      SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: editable,
    },
  });
  assert.equal(stderr, "");
  assert.equal((JSON.parse(stdout) as { ok: boolean }).ok, true);
});

test("CLI emits failed JSON and exits nonzero when preflight fails", async (t) => {
  const { ai, editable } = await fixture(t);
  await unlink(join(editable, "package-lock.json"));

  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "preflight"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SUPERPPT_AI_IMAGE_TO_PPT_SOURCE: ai,
        SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE: editable,
      },
    }),
    (error: unknown) => {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.equal((JSON.parse(result.stdout ?? "") as { ok: boolean }).ok, false);
      return true;
    },
  );
});
