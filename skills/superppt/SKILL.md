---
name: superppt
description: Use when the user wants to turn a topic, pasted content, or Markdown into a high-detail presentation, or revise a generated slide as an editable PPTX page.
---

# SuperPPT

Create, resume, revise, and deliver an image-first SuperPPT project. Resolve this Skill through symbolic links, treat the plugin root as two levels above its physical containing directory, and run package commands there. Before advancing any project, read [references/阶段契约.json](references/阶段契约.json); it is the sole wait/continue authority. Its three ordinary gates and two conditional gates are the only user wait points.

## Invariants

- 确认只建立可恢复的版本基线；前序阶段始终可修改。已确认内容的修改必须先走 `revision-impact`；V1 每次 revision 后重开 `outline`、`slide-specs`、`style-sample` 三道普通门禁。
- 风格只能单选。用紧凑、高细节的真实预览网格展示选项，再为一张内容丰富的代表页生成实际样张；不用大块空洞卡片。
- 普通页是整页图片。可编辑转换是选页的尽力重建，只有 manifest 中的文字和可靠提取的透明素材是可编辑对象；不能把整页图片描述为可编辑。
- 不打印或复制 API key，不自动安装/复制依赖，不覆盖不属于 SuperPPT 的目录或已有成功版本。

## Start or resume

For an existing project, verify `.superppt-project.json`, then read `superppt.json` and `项目状态.md`; refuse an unowned directory. For a new project, collect only a missing title/location, run `preflight`, initialize, and preserve the description, pasted text, or `.md` bytes as `source/original.md`. V1 does not ingest DOCX, PDF, or existing PPTX.

Read [references/工作区契约.md](references/工作区契约.md) before creating or mutating project files. Read [references/依赖说明.md](references/依赖说明.md) for preflight, exact CLI routes, provider disclosure, private inputs, or dependency failure. The CLI has no `--help` contract; never invent a command or flag.

## Nine stages

0. **preflight** — Resolve both explicitly supplied Skill roots and compatible versions. Do not branch on a model name or discover dependencies from environment variables or sibling directories.
1. **intake** — Agent 编排 converts the original description/text/Markdown into validated `brief.json`; deterministic code validates and records artifacts but does not perform the semantic writing.
2. **outline** — Agent orchestration expands the brief into ordered `outline.json`/`.md` with stable UUIDs, page roles, purpose, and source coverage. Run `validate-outline` and show the complete outline at the ordinary `outline` gate before any spec is required.
3. **slide-specs** — Expand every outline page into `slides/<stable-id>/spec.json`/`.md`: one core message, concise authorized text, visual subject, composition, relationships, forbidden content, and source references. Run `validate-plan` and show all specs at the ordinary `slide-specs` gate.
4. **style-sample** — Show the compact built-in high-detail preview grid, accept exactly one built-in recipe, choose a content-rich representative page, publish and explicitly approve its one-call generation plan, then prepare the immutable job. The Agent invokes `ai-image-to-ppt` only after an exact `admit-image-call`, records the private result, finalizes it, and publishes the real sample before the ordinary `style-sample` gate. V1 does not accept a custom or project-local recipe.
5. **generation** — Before any model call disclose the 提供者, 页数, 最大调用次数, 出站文本/参考图, and 输出位置. Publish and explicitly approve the generation authorization, prepare an immutable job, then have the Agent invoke `ai-image-to-ppt` serially. Every call requires an exact one-time admission and private `record-image-result`; rejection can trigger only a targeted page-regeneration job, within the three-attempt cap.
6. **assembly** — Assemble ordered final renders into a review-only candidate, publish its exact descriptor, and ask the user to choose `edit-page`, `return-upstream`, or `confirm-delivery`. Only the authenticated `confirm-delivery` action promotes PPTX, PDF, montage, and acceptance evidence into the owned output revision.
7. **revision** — On demand, use [references/修改路由.md](references/修改路由.md). Upstream changes require `revision-impact`; selected editable reconstruction requires `slide-preview`.
8. **delivery** — Deliver current artifacts and perform the real client smoke check described below.

Read [references/门禁清单.md](references/门禁清单.md) whenever presenting, approving, rejecting, or reopening a gate. Machine validation never adds another user wait point.

## Auditable visual prompts

For every style sample and page, use the deterministic 提示词编译器 with the approved spec, the single selected recipe, and visual-direction fields deterministically derived from the agent-authored per-slide spec. Make prompts content-specific and richly illustrated: one dominant focal point; explicit reading order; foreground/midground/background depth; material, lighting, scale, spatial relationship, evidence, and micro-detail; page-role composition; exact text safe area; and negative constraints. The canonical input and prompt hash make the result 可审计; do not promise a separate director artifact.

Only approved `requiredText` may be requested verbatim. Forbid pseudo-labels, random glyphs, decorative copy, logos, watermarks, and any 幻觉文字 from being baked into the image. Rich detail comes from meaningful visual evidence, not unreadable text clutter.

## Selected-page editing

Classify by the manifest, not by the user's edit verb. Text and reliable transparent assets may route to editable reconstruction; missing targets, main illustration, scene, background, overall layout, or information structure route to page regeneration. Normalize a bitmap source to exactly 1280×720 PNG before first conversion.

If the user only asks to make an already extracted text or transparent asset editable without changing its content, use the explicit `promote-editable` route; never forge a same-text edit or an empty edit plan. This is a page-level reconstruction: `--element` and `--kind` only prove that the requested target was extracted with the expected type, while every reliably extracted text and transparent asset on the selected page enters the editable layer; the background and unextracted objects remain non-editable. A missing or mismatched target returns only `{ "route": "regenerate" }`; continue with page regeneration instead of treating it as a failed mutation. When the current page is already editable, the CLI returns `{"route":"editable","status":"already-editable"}`; do not route `already-editable` to regenerate or rerun conversion. Continue from its current authenticated modified manifest with an explicit non-empty edit plan, without repeating OCR or vision. A successful first promotion is still only a candidate: render a preview, show before/after and route evidence, then follow `slide-preview` before `replace-slide`. A rejected preview leaves the current project and deck unchanged; do not claim persisted rejection evidence when none was written.

## Delivery boundary

Return PPTX, PDF, montage, acceptance, project status, planning artifacts, and selected style recipe. File creation and automated tests are not client acceptance. First run `npm run cli -- acceptance-smoke-copy --project <root>`. Read the returned `copy.path`, and open only that controlled `deck-smoke.pptx` in the user's target WPS or PowerPoint. Edit representative text or an extracted asset, then 保存、关闭、重新打开 and record the observed result in a private `0600` input. Finish with `npm run cli -- acceptance-record --project <root> --input <file>`.

客户端 smoke 只允许打开并保存受控副本。Never open or save the canonical `output/revisions/<n>/deck.pptx` as the smoke-test document: changing it invalidates the delivery hashes. `acceptance-record` takes the descriptor path returned by `acceptance-smoke-copy`; it derives descriptor/source identity from the trusted project anchor rather than accepting a client-supplied descriptor hash. If real client control is unavailable, state that acceptance is pending; never claim delivery proof.

On failure, resume from the last valid stage, retain failed-run evidence, report the exact blocker, and leave the prior deliverable unchanged.
