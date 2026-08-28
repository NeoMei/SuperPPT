import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { preflightDependencies } from "../src/dependencies/preflight.js";
import { resolveSkillDependencies } from "../src/dependencies/resolve.js";
import { AiImageSkillDependencySchema } from "../src/dependencies/schemas.js";

const requiredScripts = {
  generationResult: "generation_result.py",
  hostRoutingPolicy: "host_routing_policy.py",
  importHostImage: "import_host_image.py",
  prepareEditableInput: "prepare_editable_input.py",
} as const;

type Fixture = { root: string; ai: string; editable: string };

async function fixture(t: TestContext, version = "0.1.0"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "superppt-skill-deps-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ai = join(root, "provided-ai-skill");
  const editable = join(root, "provided-editable-skill");
  await mkdir(join(ai, "scripts"), { recursive: true });
  await mkdir(join(editable, "skills", "image-to-editable-pptx"), { recursive: true });
  await writeFile(join(ai, "SKILL.md"), "---\nname: ai-image-to-ppt\n---\n");
  await Promise.all(Object.values(requiredScripts).map((script) => writeFile(
    join(ai, "scripts", script),
    "raise SystemExit('this script must never be executed by dependency resolution')\n",
  )));
  await writeFile(join(editable, "package.json"), JSON.stringify({
    name: "image-to-editable-pptx",
    version,
  }));
  await writeFile(
    join(editable, "skills", "image-to-editable-pptx", "SKILL.md"),
    "---\nname: image-to-editable-pptx\n---\n",
  );
  return { root, ai, editable };
}

function request(fixture: Fixture) {
  return {
    aiSkillRoot: fixture.ai,
    editableSkillRoot: fixture.editable,
  };
}

test("resolves exactly the supplied Skill roots without provider discovery", async (t) => {
  const current = await fixture(t);
  const sibling = join(current.root, "ai-image-to-ppt");
  await mkdir(join(sibling, "scripts"), { recursive: true });
  await writeFile(join(sibling, "SKILL.md"), "wrong sibling Skill\n");

  const resolved = await resolveSkillDependencies(request(current));
  const ai = AiImageSkillDependencySchema.parse(resolved.ai);
  const aiRoot = await realpath(current.ai);
  const editableRoot = await realpath(current.editable);

  assert.equal(ai.kind, "ai-image-to-ppt");
  assert.equal(ai.root, aiRoot);
  assert.equal(ai.skillFile, join(aiRoot, "SKILL.md"));
  assert.deepEqual(ai.scripts, {
    generationResult: join(aiRoot, "scripts", "generation_result.py"),
    hostRoutingPolicy: join(aiRoot, "scripts", "host_routing_policy.py"),
    importHostImage: join(aiRoot, "scripts", "import_host_image.py"),
    prepareEditableInput: join(aiRoot, "scripts", "prepare_editable_input.py"),
  });
  assert.equal(resolved.editable.root, editableRoot);
  assert.equal(resolved.editable.version, "0.1.0");
});

test("rejects a symlinked Skill root", async (t) => {
  const current = await fixture(t);
  const linkedRoot = join(current.root, "linked-ai-skill");
  await symlink(current.ai, linkedRoot);

  await assert.rejects(
    resolveSkillDependencies({ ...request(current), aiSkillRoot: linkedRoot }),
    /ai-image-to-ppt Skill root must not be a symbolic link/,
  );
});

test("rejects required scripts reached through a symbolic link", async (t) => {
  const current = await fixture(t);
  const externalScripts = join(current.root, "external-scripts");
  await mkdir(externalScripts);
  await Promise.all(Object.values(requiredScripts).map((script) => writeFile(
    join(externalScripts, script),
    "wrong linked script\n",
  )));
  await rm(join(current.ai, "scripts"), { recursive: true, force: true });
  await symlink(externalScripts, join(current.ai, "scripts"));

  await assert.rejects(
    resolveSkillDependencies(request(current)),
    /ai-image-to-ppt required script is unsafe: generation_result\.py/,
  );
});

test("rejects a missing ai-image-to-ppt SKILL.md", async (t) => {
  const current = await fixture(t);
  await unlink(join(current.ai, "SKILL.md"));

  await assert.rejects(
    resolveSkillDependencies(request(current)),
    /ai-image-to-ppt Skill entry is missing/,
  );
});

test("rejects a missing required AI Skill script without using a sibling fallback", async (t) => {
  const current = await fixture(t);
  await unlink(join(current.ai, "scripts", requiredScripts.importHostImage));
  const sibling = join(current.root, "ai-image-to-ppt");
  await mkdir(join(sibling, "scripts"), { recursive: true });
  await writeFile(join(sibling, "SKILL.md"), "sibling fallback\n");
  await writeFile(join(sibling, "scripts", requiredScripts.importHostImage), "wrong fallback\n");

  await assert.rejects(
    resolveSkillDependencies(request(current)),
    /ai-image-to-ppt required script is missing: import_host_image\.py/,
  );
});

test("preflight reports a changed required script after resolution", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  await writeFile(join(current.ai, "scripts", requiredScripts.hostRoutingPolicy), "changed after resolution\n");

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [{
    dependency: "ai-image-to-ppt",
    code: "identity_changed",
    safeMessage: "required Skill files changed after resolution",
  }]);
  assert.match(report.aiImageToPpt.requiredScripts.hostRoutingPolicy.sha256, /^[a-f0-9]{64}$/);
});

test("preflight reports a removed required script after resolution", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  await unlink(join(current.ai, "scripts", requiredScripts.prepareEditableInput));

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [{
    dependency: "ai-image-to-ppt",
    code: "identity_changed",
    safeMessage: "required Skill files changed after resolution",
  }]);
});

test("preflight reports the resolved dependency identities without executing Skill files", async (t) => {
  const current = await fixture(t);
  const resolved = await resolveSkillDependencies(request(current));
  const aiRoot = await realpath(current.ai);
  const editableRoot = await realpath(current.editable);

  const report = await preflightDependencies(resolved);

  assert.equal(report.ok, true);
  assert.equal(report.aiImageToPpt.root, aiRoot);
  assert.equal(report.aiImageToPpt.skillSha256, resolved.ai.skillSha256);
  assert.equal(report.imageToEditablePptx.root, editableRoot);
  assert.equal(report.imageToEditablePptx.version, "0.1.0");
  assert.deepEqual(Object.keys(report.aiImageToPpt.requiredScripts).sort(), Object.keys(requiredScripts).sort());
  assert.deepEqual(report.errors, []);
});
