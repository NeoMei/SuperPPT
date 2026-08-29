---
name: superppt
description: Guide users from a topic, pasted content, or Markdown to a high-detail image-first presentation, with review-gated delivery and editable selected-page revisions.
---

# SuperPPT

Use a real guided conversation. The visible route is：内容导入/描述 → 针对内容追问 → `outline` → `slide-specs` → 紧凑单选风格 → `style-sample-generation` → `style-sample` → `generation-authorization` → 逐页串行生成 → `deck-review` → 修改某页 / 返回前序 / 确认交付。每个用户决定都要停下来等待；不得从导入静默跑到最终 PPT，也不得把反馈拖到交付时才收集。

Before advancing, read [references/阶段契约.json](references/阶段契约.json). It is the 唯一 wait/continue authority. Its eight entries are all mandatory user waits: stop, present that entry's `userVisibleArtifact`, and wait for one of its `allowedNextActions`. Machine validation cannot advance a stage or imply approval. 每次只问一个与当前内容直接相关的问题，或展示一组当前决定；同时摘要已经知道的内容，让用户能即时纠正。确认建立可恢复基线，不锁死前序阶段。

## Start or resume

Resolve this Skill through symlinks and treat the plugin root as two levels above its physical containing directory. For an existing project, verify `.superppt-project.json`, then read `superppt.json` and `项目状态.md`; refuse an unowned directory. For a new project, collect only missing title/location, run `preflight`, initialize, and preserve the description, pasted text, or Markdown bytes as `source/original.md`. V1 does not ingest DOCX, PDF, or PPTX.

Read [references/工作区契约.md](references/工作区契约.md) before project mutations. Read [references/依赖说明.md](references/依赖说明.md) for exact Task 10 CLI routes, private inputs, dependency resolution, outbound disclosure, and failure handling. The CLI has no `--help` contract; never invent commands or flags.

## Guided planning

After import, ask only missing questions that materially change audience, purpose, duration/page count, narrative emphasis, required facts, or constraints. Do not run a generic questionnaire or repeat generic “确认吗？”. Agent orchestration writes validated `brief.json`, then a complete ordered outline with stable UUIDs, page roles, purpose, and source coverage. Show it and stop at `outline`.

After outline approval, author every `slides/<stable-id>/spec.json`/`.md`. Make the core message, exact safe text, visual subject, composition and spatial relationships, source evidence, and forbidden content inspectable. Show every page description and stop separately at `slide-specs`; style work cannot substitute for this checkpoint.

## Compact single-select style

Read `assets/styles/catalog.json`. Recommend a content-relevant compact subset—通常只推荐三种—using the real preview images in one tight grid. Each card carries high-information recipe cues for palette, medium/material, lighting, composition, and detail language; offer the remaining catalog only on request. 风格只能单选；never multi-select, accept a dependency default, or use oversized empty cards.

Persist exactly one immutable Style Lock with `applyDependencyDefaultStyle: false`. A style-sample job binds the provisional Style Lock's exact recipe/hash/reference snapshots with `approvedSample: null`, plus the representative page spec/prompt and one-call authorization. Only the authenticated sample can promote that lock. Deck and page-regeneration jobs instead require the approved Style Lock with an authenticated non-null approved sample, plus each page-specific spec/prompt and generation authorization. Pass every sealed byte/path/hash unchanged. If provider/channel changes, do not ask the user to restate the approved style. SuperPPT performs editorial planning; it does not render images, choose a provider, or alter the dependency's host routing.

## Rich, auditable prompts

Compile each sample/page prompt deterministically from the approved spec and Style Lock. Describe a dominant focal subject, reading order, foreground/midground/background, material, lighting, scale, spatial relationships, evidence, meaningful illustration and micro-detail, page-role composition, exact text-safe area, and negative constraints. Richness must explain the content, not add decorative clutter, pseudo-labels, random glyphs, fake microtext, logos, or watermarks. Request only approved `requiredText` verbatim.

## External generation authorization

Before each paid/external authorization, show the exact 出站文本 and prompts, every 参考图 and its user-visible usage (`style-reference`, `subject-reference`, or `art-direction`), page/call count, output location, and that the host Agent will invoke `ai-image-to-ppt`. The job schema persists `style-reference` and `subject-reference` as immutable `content-reference` artifacts; this disclosure label never changes their bytes, path, order, or hash. `art-direction` 不支持时停止并解释；never silently downgrade it.

For the sample, publish its one-call plan and stop at `style-sample-generation`. Only when that authorization is current, resolve and read the resolved `ai-image-to-ppt/SKILL.md`, prepare the immutable job, obtain the exact one-time `admit-image-call`, invoke the Skill with the sealed inputs unchanged, and feed its structured result through `record-image-result`. Publish the real sample and stop again at `style-sample`.

After sample approval, publish the whole-deck plan and stop at `generation-authorization`. Repeat the same admitted delegation page by page, serially. Never run pages in parallel and do not regenerate already successful pages. Provider/channel fallback remains inside `ai-image-to-ppt`; report the actual structured route result without choosing a provider on the user's behalf.

## Review, revision, and editing

Assemble a review-only candidate and show the real 候选稿 montage before formal delivery. At `deck-review`, offer exactly `修改某页 / 返回前序 / 确认交付` (`edit-page / return-upstream / confirm-delivery`). Only authenticated `confirm-delivery` may promote formal PPTX, PDF, montage, and acceptance evidence; never use generic `approve` for deck review or deliver before it.

The user may return to any earlier stage. Follow [references/修改路由.md](references/修改路由.md): publish revision-impact evidence, explain which stable IDs and downstream artifacts change, invalidate only that downstream scope, and resume at the impact plan's first changed gate. Do not force a restart or silently mutate a confirmed artifact.

When editability is requested, classify from the manifest. Only reliably extracted text and transparent assets are editable; never describe the whole image page as editable. 只对 action 绑定的选中页执行 `convert-page`, then show before/after and route evidence at `slide-preview`. Approval rebuilds the candidate and returns to `deck-review`; rejection leaves the current page and deck unchanged. Detailed `promote-editable`, `already-editable`, regenerate, and preview routes are in [references/修改路由.md](references/修改路由.md).

Read [references/门禁清单.md](references/门禁清单.md) whenever presenting, authorizing, approving, rejecting, or reopening a decision.

## Delivery acceptance

Run `npm run cli -- acceptance-smoke-copy --project <root>` and open only its controlled `deck-smoke.pptx` in WPS or PowerPoint. Choose and record one 选定对象, temporarily edit that specific text/object, record the 观察到的修改, undo and record the 撤销结果, choose discard/no-save and record the 丢弃结果, close, reopen, and record the 重开结果 showing the original is intact.

Task 11 is an intermediate runtime: `acceptance-record` still requires `saved:true` and a changed copy hash, so it is incompatible with discard evidence. Record these observations in the human pending-acceptance report, mark client 验收待完成, and do **not** invoke `npm run cli -- acceptance-record --project <root> --input <file>` for this flow. That route remains blocked until Task 12 migrates the schema/runtime; never forge save evidence to satisfy it.

Never open or save canonical `output/revisions/<n>/deck.pptx` for smoke testing, and never tell the client to save the smoke edit. If client control is unavailable, report acceptance pending. On any failure, keep the previous deliverable unchanged and report the exact resumable stage.
