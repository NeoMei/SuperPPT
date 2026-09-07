# Ten styles and two-round selection implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the ten accepted style directions and their bundled images, with a complete style gallery followed by all available variants of one style inside the existing plan-review decision.

**Architecture:** Keep catalog v2 as the only runtime recipe source. Add an optional representative showcase to each style without changing old templates, palettes or variant previews. Add portable selection presentation generated from the published plan: first all styles, then one style's available tier/palette matrix. The existing select-style-and-generate-sample decision remains the only authorization for generation.

**Tech Stack:** TypeScript, Zod, Node test runner, sharp, local standalone HTML.

**Spec:** docs/specs/style-art-directions.md; style-showcase-copy.md; visual-design-and-selection.md (VS-01 through VS-08); decisions.md D-17 through D-20.

## Global Constraints

- Work only in /Users/neomei/项目/codexprojects/SuperPPT/.worktrees/fast-workflow, branch codex/superppt-spec-baseline. No CodeGraph index exists in this worktree; do not use the parent checkout's index as its source.
- Accepted source artifact root: /Users/neomei/.codex/visualizations/2026/09/06/01a07610-a616-77f3-b5d1-20a97c2aa7b7/ten-style-showcase-v1. manifest.json identifies all accepted masters, prompts and hashes. generation.json identifies unchanged old catalog templates. This is an import source only, never a runtime dependency.
- Exactly ten active IDs/names: tactile/立体, glass/玻璃, ink/水墨, hand-drawn/经典手绘, textbook/教材图解, collage/创意拼贴, cinematic-tech/电影科技, luxury-photo/奢华摄影, blueprint/建筑蓝图, fantasy/叙事幻想. Swiss and printmaking are not active styles.
- Existing tactile/glass/ink tiers, palettes and previews remain deeply equal to commit db9db2e. Add showcase metadata only. Their 27 variants and 24 old previews remain; missing exact previews are disclosed, not generated or disabled.
- New seven styles expose only level 3 and palette mid (基准中线), taken from accepted sent prompts. No invented levels or palettes. Total 34 selectable variants; 31 exact variant previews, plus ten representative showcases.
- Original collage A is accepted, including its text/graphic separation. Never import the refinement images. Do not add fusion demands or alter the accepted material language.
- Template slots {{PALETTE}}, {{CONTENT_RELATIONSHIPS}}, {{SLIDE_COPY}} each occur exactly once. No fixed showcase marketing copy, usage notes, paths or numbers should leak into arbitrary user generation. Usage intent stays at the existing submission boundary.
- JPEG previews: exactly 1280x720 and <=500,000 bytes, resize/compress accepted strict-16:9 masters only; no redesign, crop or image generation. Runtime asset and provenance paths are portable relative paths. Source hashes reference accepted source masters.
- Keep independent dependency tools, immutable selection snapshots, sample reuse, budgets and five CLI commands. No new paid call, decision stage or state transition for merely viewing/picking a preview. Custom plan styles remain supported.
- Do not merge, push, publish or change installed skills. Finish local implementation, review and real browser/installed-package checks first.

## Task 1: Integrate accepted recipes and bundled showcases

**Files:** Modify src/styles/schemas.ts, src/styles/catalog.ts, scripts/build-style-catalog.mjs, skills/superppt/assets/styles/catalog.json, provenance.json, README.md. Add showcases/*.jpg and seven previews/*-3-mid.jpg; extend tests/style-options.test.ts or add tests/style-catalog.test.ts.

**Interfaces:** StyleRecipe gains optional `showcase: {level: CreativityLevel; paletteId: string; path: string}`. It references an existing tier/palette. loadStyleCatalog validates its file. Existing StyleRecipe callers without a showcase continue working. Showcase paths follow `showcases/<styleId>.jpg`.

- [ ] Write focused failing tests for exactly ten IDs, original three definitions unchanged, seven one-variant recipes rejecting unsupported choices, showcase loading/schema errors, all bundled assets valid, and compiling unrelated copy without fixture advertising leakage.

```ts
assert.deepEqual(catalog.styles.map(s => s.id), ['tactile','glass','ink','hand-drawn','textbook','collage','cinematic-tech','luxury-photo','blueprint','fantasy']);
const selected = selectStyleVariant(collage, {level: 3, paletteId: 'mid'});
const text = compileSlidePrompt({spec: unrelatedSpec, style: selected}).text;
assert.ok(text.includes(unrelatedSpec.requiredText.join('\n')));
assert.doesNotMatch(text, /10 大精选模板|SuperPPT 目标版本|让内容，自带设计感/);
assert.throws(() => selectStyleVariant(collage, {level: 1, paletteId:'mid'}));
```

- [ ] Run `node --import tsx --test tests/style-options.test.ts tests/style-catalog.test.ts` (use actual files created), record expected RED.
- [ ] Extend the schema using the existing preview shape; validate showcase option references and portable contained asset paths (reject absolute/traversal paths). Load both preview and showcase files. Keep the optional contract backward compatible.
- [ ] Extract each new recipe directly from its accepted prompt: replace the palette paragraph, the content-relationship paragraph, and full visible-copy block with the respective slots. Strip the trailing fixture-specific usage note. Generalize the fixture phrases “中文 PPT 广告展示页” to “中文 PPT 页面” and “SuperPPT 标题和副标题区” to “标题和副标题区” for arbitrary user content. Keep all remaining art/tier instructions, including the accepted collage wording, intact. Record these transformations and source hashes in provenance.
- [ ] Normalize the ten accepted showcase masters and seven exact new variant images with sharp. Preserve all old variant files. Extend build-style-catalog validation/provenance for showcases and accepted sources with safe relative paths; preserve legacy source mappings and normalization support. Do not introduce another runtime catalog generator.
- [ ] Run focused tests, `node scripts/build-style-catalog.mjs`, `npm run lint:types`, and the full source suite once. Verify unchanged old recipe/preview hashes against db9db2e. Commit and report.

## Task 2: Deliver two-round selection in plan review

**Files:** Create src/styles/selection.ts and src/styles/selection-view.ts. Modify src/workflow/planning.ts, continue.ts, skills/superppt/SKILL.md, skills/superppt/references/依赖说明.md. Add tests/style-selection.test.ts, extend tests/fast-planning.test.ts and style-workflow.test.ts.

**Interfaces:** Export pure `styleSelection(styles: StyleRecipe[])` returning first-round style cards plus per-style variant groups. Each variant has `level`, `paletteId`, `paletteName`, `previewPath: string|null`, and explicit missing-preview status. Cards use `showcase` when available; custom styles may use an explicitly labelled variant reference or no image. Export presentation writer returning a task-relative HTML path. planDetails preserves existing fields and adds `selection` and `selectionPath` (after publication). The plan reply view links the absolute local selection HTML and lists all style names for text-only hosts.

- [ ] Write RED tests: ten cards, 34 variants grouped by level, exactly three missing old previews, only 3/mid for new seven; empty custom previews; escaping untrusted names/labels; published and resumed plan replies expose the same usable presentation; previewing never creates a generation job or consumes pendingDecision.

```ts
const selection = styleSelection(catalog.styles);
assert.equal(selection.styles.length, 10);
assert.equal(selection.styles.flatMap(s => s.groups.flatMap(g => g.variants)).length, 34);
const before = await readTask(root);
await taskReply(root);
assert.deepEqual(await readTask(root), before);
```

- [ ] Build a self-contained responsive HTML selector with bundled preview images embedded (no network or external runtime dependency): first view all style showcases, click a style to show all its variant groups, click a variant to display a concise human-readable choice and copyable reply (`选择创意拼贴，3 档，基准中线`). Include return-to-styles, accessible controls, clear labels and missing-image messages. A missing image is selectable if its recipe exists. No automatic generation or CLI invocation from HTML, no raw decision JSON in user flow.
- [ ] Keep this a preview within plan-review. Returning to the style list does not mutate state; the final existing decide action still validates and locks the chosen tuple with budget 1. Do not add task state or decision stages just for presentation. Include purpose/audience and clarify choice alone does not send a request; the agent discloses exact sample prompt/budget at the existing boundary.
- [ ] Make first-round default plans include all built-in styles, not an agent shortlist. Preserve deliberately authored custom plans: do not silently rewrite published caller-provided plan.styles. Update planning work instructions and Skill to use the entire built-in catalog by default, show all first-round images, then all second-round variants without separate tier/palette approval rounds. Native inline images and textual tuple reply are fallbacks if HTML is unavailable; do not claim remote mobile acceptance.
- [ ] Write/update runtime references explaining available options and accepted limitations. Preserve five CLI commands and all existing sample/deck contracts. Test through publishPlan -> taskReply -> choose collage 3/mid -> generation job snapshot with unrelated content; invalid collage 1/cool leaves state unchanged.
- [ ] Run focused tests, typecheck, full source suite once; commit and report path to a generated real plan-review selector for root browser inspection.

## Task 3: Verify packaged behavior and update current documentation

**Files:** Extend tests/release-install.test.ts / its existing harness and add a focused public CLI selection test if needed. Update README.md, docs/specs/visual-design-and-selection.md, style-showcase-copy.md, style-art-directions.md and decisions.md current-status paragraphs. No dependency or version bump unless a check technically requires it (report first).

**Interfaces:** Task 1 catalog/showcase files and Task 2 published selection fields/HTML work from built dist and a packed independent plugin root.

- [ ] Add a focused installed-package/public-CLI assertion that all ten styles and valid showcase files load, a published default all-style plan includes the standalone selection document with embedded images, and a new style can lock to 3/mid without reading local design-session folders. Keep fixture generation, not paid image calls.
- [ ] Verify the selected new style survives sample -> deck job with identical recipe and approved sample reuse; reuse existing fixture harness rather than duplicating generation internals.
- [ ] Run `node scripts/build-style-catalog.mjs`, `npm run lint:types`, `npm run build`, `npm run test:compiled`, and `npm run test:release-install`; capture results. Run required `npm run verify:full` if its current script adds relevant gates, recording any environment limits separately.
- [ ] Update current docs to ten active styles and two-round presentation, accurately disclose seven only-3/mid directions and three legacy missing previews. Keep historical decisions historical. Do not claim every combination is accepted, mobile verified, or published/released.
- [ ] Commit and report. Root performs real local browser verification on the returned selector: 10 first-round images loaded, choose original collage -> only 3/mid, return -> old glass has 9 combos with two labelled missing previews, copy/selection reply is human-readable; inspect a narrow viewport if supported. Finish with whole-branch independent review and address findings.
