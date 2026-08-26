import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveDependencies } from "../src/dependencies/resolve.js";
import { preflightDependencies } from "../src/dependencies/preflight.js";

async function fixture(): Promise<{ ai: string; editable: string }> {
  const root = await mkdtemp(join(tmpdir(), "superppt-deps-"));
  const ai = join(root, "ai-image-to-ppt");
  const editable = join(root, "editable-plugin");
  await mkdir(join(ai, "scripts"), { recursive: true });
  await mkdir(join(ai, "references"), { recursive: true });
  await mkdir(join(editable, "skills", "image-to-editable-pptx"), { recursive: true });
  await writeFile(join(ai, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  await writeFile(join(ai, "scripts", "gen_slide_gemini.py"), "def gen(prompt, out_path, retries=0): return True\n");
  await writeFile(join(editable, "package.json"), JSON.stringify({ name: "image-to-editable-pptx", version: "0.1.0", engines: { node: ">=22.6" } }));
  await writeFile(join(editable, "package-lock.json"), JSON.stringify({ name: "image-to-editable-pptx", version: "0.1.0", lockfileVersion: 3, packages: {} }));
  await writeFile(join(editable, "skills", "image-to-editable-pptx", "SKILL.md"), "---\nname: image-to-editable-pptx\n---\n");
  return { ai, editable };
}

test("resolves legacy ai-image and editable plugin roots", async () => {
  const { ai, editable } = await fixture();
  const resolved = await resolveDependencies({ aiRoot: ai, editableRoot: editable });
  assert.equal(resolved.ai.providers[0]?.id, "gemini-legacy");
  assert.equal(resolved.editable.version, "0.1.0");
  assert.match(resolved.editable.cli.cwd, /editable-plugin$/);
});

test("prefers a strict capability manifest and exposes gpt-image-2 without model branching", async () => {
  const { ai, editable } = await fixture();
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
