# AI Image to PPT Capability Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one versioned, machine-readable `ai-image-to-ppt` capability manifest whose declared routing, scripts, result contracts, and output dimensions can be validated by both the Skill itself and SuperPPT.

**Architecture:** The manifest is the authoritative static capability contract; it does not discover credentials or promise that a provider is currently reachable. The Skill's validator checks the manifest schema and verifies every declared local script against the actual package. SuperPPT consumes the same manifest and fails preflight on absence, schema mismatch, unsafe paths, or missing scripts.

**Tech Stack:** Python 3, JSON, PyYAML, pytest/unittest-compatible existing test suite.

**Spec:** `docs/superpowers/specs/2026-08-26-superppt-design.md`, section 4.4.

## Global Constraints

- Execute this plan in the upstream `ai-image-to-ppt` repository checkout that contains `SKILL.md`, `scripts/`, `references/`, and `tests/`; do not edit only an installed cache copy.
- The manifest describes supported contracts, not live credential availability or a promise that a host capability is present.
- Preserve host-first sticky order: host OpenAI -> OpenAI API -> host Gemini -> Gemini API -> host Doubao -> Doubao API.
- OpenAI API's declared default model is `gpt-image-2`; host model selection remains host-owned and must not be falsely pinned.
- Editable handoff remains an exact 1280x720 PNG; normalized deck export remains exact 1920x1080.
- All manifest script paths are relative POSIX paths below the Skill root, resolve to non-symlink regular files, and cannot contain `..`, absolute paths, or control characters.
- Do not put API keys, credential names beyond documented environment-variable identifiers, machine-specific absolute paths, or live account state in the manifest.
- A release is not complete until the upstream source, installed Agent Skill copy, installed Codex Skill copy, and SuperPPT preflight all validate the same manifest bytes.

---

### Task 1: Define and Validate the Capability Manifest

**Files:**
- Create: `references/capabilities.json`
- Create: `scripts/capability_manifest.py`
- Create: `tests/test_capability_manifest.py`
- Modify: `scripts/validate_skill.py`
- Modify: `tests/test_validate_skill.py`

**Interfaces:**
- Produces `load_capability_manifest(skill_root: Path) -> dict`.
- Produces `validate_capability_manifest(skill_root: Path) -> tuple[bool, str]`.
- Extends `validate_skill()` so a missing or invalid manifest fails package validation.

- [ ] **Step 1: Write failing manifest validation tests**

```python
def test_published_capability_manifest_is_valid():
    valid, message = validate_capability_manifest(REPOSITORY_ROOT)
    assert valid, message


def test_manifest_rejects_path_escape(tmp_path):
    skill = copy_skill_fixture(tmp_path)
    manifest = json.loads((skill / "references/capabilities.json").read_text())
    manifest["scripts"]["generationResult"] = "../outside.py"
    (skill / "references/capabilities.json").write_text(json.dumps(manifest))
    valid, message = validate_capability_manifest(skill)
    assert not valid
    assert "safe relative script" in message


def test_manifest_matches_host_first_sticky_order():
    manifest = load_capability_manifest(REPOSITORY_ROOT)
    assert [f'{item["provider"]}:{item["channel"]}' for item in manifest["routingOrder"]] == [
        "openai:host", "openai:api", "gemini:host",
        "gemini:api", "doubao:host", "doubao:api",
    ]
```

Also test missing manifest, malformed JSON, unknown top-level key, unsupported schema/sub-contract version, duplicate route, unsafe/symlink/missing script, wrong output dimensions, OpenAI API default other than `gpt-image-2`, and host routes that incorrectly pin a model.

- [ ] **Step 2: Run tests and verify the missing-module/manifest failure**

Run: `python3 -m pytest -q tests/test_capability_manifest.py tests/test_validate_skill.py`

Expected: FAIL because `scripts/capability_manifest.py` and `references/capabilities.json` do not exist.

- [ ] **Step 3: Publish schema version 1 data**

Create `references/capabilities.json` with this exact contract shape:

```json
{
  "schemaVersion": 1,
  "skill": "ai-image-to-ppt",
  "contracts": {
    "generationResult": 1,
    "serialStickyRouterReport": 1,
    "hostImageImport": 1,
    "editableInput": 1
  },
  "routingOrder": [
    { "provider": "openai", "channel": "host", "modelSelection": "host-owned" },
    { "provider": "openai", "channel": "api", "defaultModel": "gpt-image-2" },
    { "provider": "gemini", "channel": "host", "modelSelection": "host-owned" },
    { "provider": "gemini", "channel": "api", "defaultModel": "gemini-3.1-flash-image" },
    { "provider": "doubao", "channel": "host", "modelSelection": "host-owned" },
    { "provider": "doubao", "channel": "api", "defaultModel": "doubao-seedream-5-0-260128" }
  ],
  "outputs": {
    "normalizedSlide": { "format": "image", "width": 1920, "height": 1080 },
    "editableInput": { "format": "png", "width": 1280, "height": 720 }
  },
  "scripts": {
    "generationResult": "scripts/generation_result.py",
    "hostRoutingPolicy": "scripts/host_routing_policy.py",
    "importHostImage": "scripts/import_host_image.py",
    "prepareEditableInput": "scripts/prepare_editable_input.py",
    "apiGenerator": "scripts/gen_slide.py",
    "normalizedExport": "scripts/export_images.py"
  }
}
```

If a provider's current default constant differs, update the manifest to the source constant and update this plan/spec before implementation; do not make the validator rewrite runtime defaults to match documentation.

- [ ] **Step 4: Implement strict validation**

`capability_manifest.py` must reject unknown/missing keys and validate exact scalar types, unique fixed routing order, dimensions, supported contract version integers, and safe script paths. Resolve every script with `Path.resolve(strict=True)`, require it to remain under the resolved Skill root, reject symlinks via `lstat()`, and require a regular file.

Extend `validate_skill()` to call `validate_capability_manifest()` after SKILL frontmatter/body validation and return `Capability manifest invalid: <safe reason>` on failure.

- [ ] **Step 5: Run focused validation tests**

Run: `python3 -m pytest -q tests/test_capability_manifest.py tests/test_validate_skill.py`

Expected: PASS with all positive and negative cases.

- [ ] **Step 6: Commit the manifest contract**

```bash
git add references/capabilities.json scripts/capability_manifest.py scripts/validate_skill.py tests/test_capability_manifest.py tests/test_validate_skill.py
git commit -m "feat: publish image generation capability manifest"
```

---

### Task 2: Bind Documentation, Packaging, and SuperPPT Consumption

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `tests/test_documentation.py`
- Modify: `tests/test_resource_boundaries.py`
- Modify in SuperPPT: `references/dependencies.json`
- Modify in SuperPPT: `src/dependencies/schemas.ts`
- Modify in SuperPPT: `src/dependencies/resolve.ts`
- Modify in SuperPPT: `src/dependencies/preflight.ts`
- Modify in SuperPPT: `tests/dependencies.test.ts`

**Interfaces:**
- Documents `references/capabilities.json` as the machine contract and `SKILL.md` as human operating instructions.
- Produces a SuperPPT dependency result containing manifest/sub-contract versions and hash, resolved safe script paths/hashes, routing order, and output dimensions.

- [ ] **Step 1: Add failing documentation and consumer tests**

The source Skill tests require both `SKILL.md` and `README.md` to link `references/capabilities.json`, explain that it is static capability rather than live availability, and include it in allowed package resources.

The SuperPPT tests copy a fixture Skill and verify:

```ts
const dependency = await resolveAiImageSkillDependency(fixture.root);
assert.equal(dependency.capabilitySchemaVersion, 1);
assert.equal(dependency.contracts.generationResult, 1);
assert.equal(dependency.outputs.editableInput.width, 1280);
assert.equal(dependency.outputs.editableInput.height, 720);
assert.equal(dependency.scripts.generationResult.endsWith("scripts/generation_result.py"), true);
```

Negative tests cover missing/malformed manifest, unsafe/missing script, wrong routing order, wrong dimensions, unsupported schema version, and manifest/script disagreement.

- [ ] **Step 2: Run focused suites and verify failure**

Run in `ai-image-to-ppt`: `python3 -m pytest -q tests/test_documentation.py tests/test_resource_boundaries.py`

Run in SuperPPT: `node --import tsx --test tests/dependencies.test.ts`

Expected: both suites FAIL because documentation/packaging and SuperPPT consumption are not yet bound to the manifest.

- [ ] **Step 3: Update human documentation without duplicating the schema**

Link the manifest and explain its authority. Keep routing examples in human prose, but do not reproduce the full JSON in both documents. State that a valid manifest does not prove credentials or host availability; those remain runtime results.

- [ ] **Step 4: Make SuperPPT consume the same contract**

Set the dependency entry to require `capabilitySchemaVersion: 1`, the four supported sub-contract versions, and the six named script capabilities. Parse the manifest once with strict Zod schemas, resolve declared script paths below the canonical non-symlink Skill root, compute manifest/skill/script SHA-256 values, and return those values in preflight. Delete the independent `requiredAiScripts` filename table after tests prove every consumer uses manifest declarations.

- [ ] **Step 5: Run complete source validation in both repositories**

Run in `ai-image-to-ppt`:

```bash
python3 scripts/validate_skill.py .
python3 -m pytest -q
```

Run in SuperPPT:

```bash
npm run lint:types
node --import tsx --test tests/dependencies.test.ts tests/plugin-package.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 6: Install and compare exact manifest bytes**

Install/update the validated Skill into both configured locations. Verify SHA-256 equality among the upstream source, `/Users/neomei/.agents/skills/ai-image-to-ppt/references/capabilities.json`, and `/Users/neomei/.codex/skills/ai-image-to-ppt/references/capabilities.json`. Then run SuperPPT preflight against each installed root and require identical parsed capability results.

- [ ] **Step 7: Commit documentation and SuperPPT consumption separately**

In `ai-image-to-ppt`:

```bash
git add SKILL.md README.md tests/test_documentation.py tests/test_resource_boundaries.py
git commit -m "docs: bind skill instructions to capability manifest"
```

In SuperPPT:

```bash
git add references/dependencies.json src/dependencies/schemas.ts src/dependencies/resolve.ts src/dependencies/preflight.ts tests/dependencies.test.ts
git commit -m "feat: validate ai image skill capabilities"
```

Do not publish or push either repository unless the user separately authorizes release.
