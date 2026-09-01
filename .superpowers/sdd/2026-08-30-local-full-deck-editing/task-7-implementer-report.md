# Task 7 implementer report

## Scope and starting point

- Branch: `codex/superppt-local-full-deck`.
- Exact base: `eec215506b048ea38d6aecbb4fa34a6af8439fdd`.
- Scope: active SuperPPT Skill/README/full-deck workflow contract, continuous full-deck E2E, compiled/package acceptance, and a durable controlled project for later real WPS GUI acceptance.
- No push, publish, deploy, cloud upload, WPSComposer, PDF, montage, preview render, or single-page user PPTX operation was performed.

## RED-first evidence

- The new continuous E2E first stopped RED because `resolveCurrentDeckPage` was not exported. The old product path could not resolve “再改第 N 页” from the current reconciled topology.
- The focused CLI test first failed RED with `unknown command: resolve-current-deck-page`.
- The workflow-contract RED showed the active machine contract had no complete-deck editing policy for exact signals, hash binding, topology reconciliation, or pointer-only rollback.
- After the main implementation, the first source full run reported 665 total / 662 passed / 1 failed / 2 skipped. The only failure was an omitted existing publication phrase, “恰好 3 个普通确认”; README was corrected to distinguish those three confirmations from generation authorizations and complete-deck review.
- The first compiled full run then exposed two real build-runtime gaps: compiled resolution searched only `dist/references`, and `test:compiled` did not inject the validated workspace runtime. Focused compiled artifact/dependency tests reproduced the failures before the fixes and passed 2/2 after them.

## Implementation

- Added `resolveCurrentDeckPage({ root, pageNumber })` and the strict `resolve-current-deck-page` CLI route. It reads the current immutable revision and resolves the requested page only from its reconciled stable-slide topology.
- Added one continuous three-slide complete-deck E2E. It simulates a manual WPS save that changes slide-2 text/alignment, moves that page, inserts an unmanaged page, and deletes another page; adopts the exact saved bytes; resolves the next target by its new page number; creates the next complete candidate from those bytes; applies an Agent text edit; keeps current unchanged before exact hash-bound `确认`; confirms; then pointer-only rolls back to the manual revision.
- The E2E asserts the prior manual change survives the Agent candidate and that adoption, confirmation, and rollback do not rewrite either complete PPTX.
- Replaced the obsolete active smoke policy with a machine-readable complete-local-PPTX editing policy: one Markdown link, WPS/PowerPoint editor, `reviewRequired` labels, exact manual `已保存并关闭` only, exact Agent `确认` bound to the presented hash, reconciled topology, metadata-only adoption, and pointer-only rollback.
- Updated the active Skill, all five maintained references, and README to one guided creation path, one manual complete-deck loop, one Agent complete-deck loop, continuous page-number edits, and rollback. Earlier outline/page-description/style changes first disclose exact impact and wait.
- Style selection remains content-relevant and single-select after content; the accepted immutable Style Lock is delegated unchanged to `ai-image-to-ppt`. The workflow stops at every stage and never silently runs input to final output.
- Preserved dependency contract v3 and workflow preflight binding v2.
- Made the compiled runner reuse the same validated workspace runtime as source tests and allowed the dependency contract to resolve safely from source or compiled layout.

## Fixture E2E evidence (not real WPS)

- Fixture continuous full-deck E2E: **PASS**.
- Initial deck: 3 slides.
- Manual candidate begins from the exact initial/current bytes.
- Simulated saved topology: moved managed target, one deleted managed page, one newly allocated unmanaged page.
- Next-page resolution: **PASS in fixture** against the reconciled current topology.
- Agent current pointer before exact confirmation: unchanged on manual revision.
- Exact hash confirmation: promotes the Agent candidate.
- Rollback: restores the manual revision pointer.
- Post-adoption/confirmation/rollback PPTX writes: **zero in fixture**; byte assertions cover both manual and Agent complete files.
- Single-page user artifacts: **zero in fixture**.
- PDF/montage/generated-preview artifacts: **zero in fixture**.

This automated fixture is not real WPS GUI evidence and is not reported as such.

## Final frozen verification

- Source: `npm test` — **PASS**, 665 tests / 663 passed / 0 failed / 2 Windows-only skipped; `1009116.5335ms`.
- Types: `npm run lint:types` — **PASS**.
- Build: `npm run build` — **PASS**.
- Compiled: `npm run test:compiled` — **PASS**, 665 tests / 663 passed / 0 failed / 2 Windows-only skipped; `986862.909542ms`.
- Package: `npm pack --dry-run --json` — **PASS**, 102 files, 4,649,562 packed bytes, 5,652,707 unpacked bytes.
- Required package entries present: `skills/superppt/SKILL.md`, `skills/superppt/references/阶段契约.json`, `references/dependencies.json`, `src/deck-revisions/workflow.ts`, and `src/deck-revisions/store.ts`.
- Package forbidden generated/user paths: zero PPTX, PDF, montage, generated preview, user-edit, single-page donor, or staging entries. Built-in style-catalog JPEG previews remain intentional Skill assets and are not generated review artifacts.
- `git diff --check`: **PASS**.

No production or test file changed after the frozen source and exact compiled evidence above.

## Durable real-WPS controlled project

- Ignored acceptance root: `.superpowers/sdd/2026-08-30-local-full-deck-editing/task-7-wps-acceptance/`.
- Project root: `/Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-local-full-deck/.superpowers/sdd/2026-08-30-local-full-deck-editing/task-7-wps-acceptance/controlled-project`.
- State file: `task-7-wps-acceptance/acceptance-state.json`.
- Initial revision: `b628a05d-1639-4f02-b457-1ec6affe6fd3`.
- Initial SHA-256: `99b301091f99df5348a516cd80ee51bd79948008a150bc76220cc21544f30acb`.
- Manual candidate revision: `086182ff-d829-4225-ac7e-65eb059dfdfb`.
- Manual session: `38a0cd82-b09c-4a53-98fd-2de50bbd1466`.
- Target stable slide ID: `8a8433a7-3fb1-49f2-b9f8-422452d07168` (initial page 2).
- Candidate before-WPS SHA-256: `99b301091f99df5348a516cd80ee51bd79948008a150bc76220cc21544f30acb`.
- Candidate slide count: 3.
- Untouched slide-1/slide-3 XML and relationship hashes are recorded and equal between initial and candidate.
- The state and README contain the exact absolute complete-PPTX link and adoption command template.

## Real GUI acceptance status

- Manual complete-deck edit: **PENDING**. Before-save SHA is recorded; saved and post-adoption SHA values remain `null` until main-agent WPS work.
- Next-page continuity in real WPS: **PENDING**.
- Agent complete-deck GUI review/confirmation: **PENDING**.
- Real post-save PPTX writes: **PENDING**; fixture evidence is zero only.
- Real single-page/PDF/montage/generated-preview artifacts: **PENDING GUI observation**; fixture/package counts are zero.

The next action is explicitly the main agent opening the complete manual candidate in real WPS, editing slide-2 text/alignment, moving it, inserting one unmanaged page, deleting another page, saving in place, closing WPS, and only then continuing with exact `已保存并关闭`. This report does not claim those GUI steps passed.

## Commit and review handoff

- Intended independent commit message: `docs: guide complete deck editing loops`.
- The exact final HEAD and scoped `eec2155..<newHEAD>` review-package hash/line/byte evidence are generated after this report is committed and are reported in the handoff; the report does not predict its own commit identity.
- Independent review remains pending; this implementer report does not declare Task 7 review complete.

## Review-fix round 1 (2026-09-01)

### Review result and scope

- Review baseline: `b99a47833da89550da4e51e764834d5a651577a7`.
- Formal result before these fixes: Critical 0 / Important 2 / Minor 0; Spec and Quality both failed only on the two Important findings below.
- Finding 1: the page resolver and manual-candidate preparation were not bound to the same current revision, so a stable slide ID that survived a concurrent pointer change could be prepared from a newer revision without the caller noticing.
- Finding 2: compiled default dependency resolution preferred `dist/references/dependencies.json`, allowing a legacy shadow contract to replace the package-root authority.
- No real WPS GUI action was performed in this round. The original real-WPS statuses above remain **PENDING**.

### RED-first and GREEN evidence

- Revision-binding RED: the two new API/CLI race tests passed `revisionId`, but the old API schema and CLI rejected that field/flag before they could enforce stale authority: 0/2 passed.
- Revision-binding GREEN: `prepareManualEditDeck` now requires the resolver's `revisionId`; `prepare-manual-deck` requires `--revision-id`; a changed current pointer fails closed before a candidate/session is created. API and CLI race tests pass 2/2 even though the stable slide ID remains present in the promoted revision. Both assert unchanged revision/session directory listings and a null active session after rejection.
- Dependency-shadow RED: with the old compiled resolver, only explicit `contractFile` passed; valid, invalid, and symlinked `dist/references/dependencies.json` shadows selected or poisoned the compiled default: 1/5 passed.
- Dependency-shadow GREEN: source and compiled default resolution now select the same canonical package-root `references/dependencies.json` and SHA-256, ignoring all three shadow variants. Explicit `contractFile` still selects and attests the explicit file: 7/7 targeted tests passed in both source and compiled runs.
- Canonical default contract: `/Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-local-full-deck/references/dependencies.json`; SHA-256 `14f946f1254003a2ffa68bf8c5e9b9c7f2210dcaec548be46f63e131853483a2`.
- Documentation-contract RED/GREEN: the two focused tests first failed 0/2 because the machine contract and maintained instructions did not require the resolver revision handoff; after migration they passed 2/2.

### Maintained contract migration

- README, the active Skill, all five active references, and the main plan now pass the `revisionId` returned by `resolve-current-deck-page` unchanged to `prepare-manual-deck --revision-id`.
- The machine contract declares `manual.revisionBinding = "resolver-revision-id-must-still-be-current"`; stale preparation requires a fresh resolution and leaves no candidate/session residue.
- Dependency documentation names package-root `references/dependencies.json` as the source and compiled/installed default authority, rejects `dist/references` shadow authority, and preserves the explicit `contractFile` trust boundary.
- The ignored controlled WPS acceptance state records the exact initial revision binding and updated command template. Its already-prepared complete candidate was not regenerated, opened, or adopted.

### Round-1 focused verification

- Affected source suites (`cli-approval`, `dependencies`, `e2e`, `full-deck-editing`, `workflow-contract`): **PASS**, 63/63, `15862.629209ms`.
- `npm run lint:types && npm run build`: **PASS**.
- Affected compiled suites: **PASS**, 63/63, `15888.345ms`.
- Adjacent source package/publication/runtime suites: **PASS**, 14/14, `573.803875ms`.
- Adjacent compiled package/publication/runtime suites: **PASS**, 14/14, `556.02675ms`.
- `npm pack --dry-run --json`: **PASS**, 102 files, 4,650,099 packed bytes, 5,654,183 unpacked bytes. It contains the two required full-deck Skill/contracts/modules and no generated PPTX, user edit, single-page donor, PDF, montage, staging, or generated review-preview artifact.
- This round intentionally used focused source/compiled verification before the review conclusion, rather than rerunning the long full suites. The earlier full-suite evidence remains the original Task 7 freeze, not evidence for these review-fix changes.

### Round-1 commit and review handoff

- Intended independent commit message: `fix: bind complete deck workflow authority`.
- The exact fix commit and scoped `b99a478..<newHEAD>` review-package hash/line/byte evidence are generated after this report is committed and reported in the handoff; this report does not predict its own commit identity.

## Review-fix round 2 (2026-09-01)

### Scope and RED-first evidence

- Review baseline: `d82178880ad6e511647be6ce1bec13d6fd08fa72`.
- The remaining Important was documentation-only: Task 3 in the main implementation plan still showed `prepareManualEditDeck({ root, slideId })` and instructed an implementation to read current itself, contradicting the resolver snapshot binding added in round 1.
- A new machine-contract test first failed **RED**, 0/1, at `resolve the current page before manual preparation`. It requires Task 3 to resolve the page first, pass `resolved.revisionId` and `resolved.stableSlideId` unchanged, state that the revision must remain current, fail closed before any candidate/session creation, and leave zero residue. It also checks every manual-preparation call in the full plan so another legacy API example cannot silently return.

### Minimal documentation correction

- Task 3 now declares `resolveCurrentDeckPage({ root, pageNumber })` in its interfaces.
- Its workflow example resolves page 2 first and passes both fields from that one resolver snapshot to `prepareManualEditDeck`.
- Its implementation requirements no longer tell a future implementation to select current internally. They require the supplied revision to remain current, fail closed before any candidate/session creation when stale, and leave zero candidate/session residue.
- No runtime source, active Skill/reference, package contract, controlled candidate, or real WPS state changed in this round.

### Round-2 verification

- Focused new source contract: **GREEN**, 1/1, `307.335458ms` process duration.
- Complete source workflow-contract suite: **PASS**, 10/10, `313.255291ms`.
- `npm run lint:types && npm run build`: **PASS**.
- Complete compiled workflow-contract suite: **PASS**, 10/10, `403.971708ms`.
- Full-plan audit: one `prepareManualEditDeck` call remains, and it passes `resolved.revisionId` plus `resolved.stableSlideId`; the obsolete self-read-current wording is absent.
- `git diff --check`: **PASS**.
- Real WPS manual, next-page, Agent GUI, and post-save checks remain **PENDING** and were not touched.

### Round-2 commit and review handoff

- Intended independent commit message: `docs: bind manual plan examples to revision`.
- The exact fix commit and scoped `d821788..<newHEAD>` review-package hash/line/byte evidence are generated after this report is committed and reported in the handoff; this report does not predict its own commit identity.

## Review-fix round 3 (2026-09-01)

### Scope and TDD evidence

- Review baseline: `90b7e75a7226160f529b482a6687d543baa12c86`.
- The remaining Minor was documentation-only: the Task 3 interface summary claimed `resolveCurrentDeckPage()` returned `slideIndex`, while the runtime contract returns `revisionId`, `pageNumber`, `stableSlideId`, and `management`.
- The workflow-contract test was first extended to require the exact resolver summary and reject any `resolveCurrentDeckPage` summary containing `slideIndex` anywhere in the full plan.
- Old documentation result: **RED**, 0/1, `808.365125ms`; it failed on the mismatched interface summary.
- Minimal correction: replace only the Task 3 return summary with `Promise<{ revisionId; pageNumber; stableSlideId; management }>`.
- Focused corrected result: **GREEN**, 1/1, `1341.718834ms`.

### Round-3 verification

- Complete source workflow-contract suite: **PASS**, 10/10, `805.908666ms`.
- `npm run lint:types && npm run build`: **PASS**.
- Complete compiled workflow-contract suite: **PASS**, 10/10, `365.730458ms`.
- Full-plan scan: no resolver interface or description still associates `slideIndex` with `resolveCurrentDeckPage`.
- `git diff --check`: **PASS**.
- Only the main plan, its machine-contract test, and this report changed. Runtime, active Skill/references, package contract, controlled candidate, and real WPS state were not touched; real GUI statuses remain **PENDING**.

### Round-3 commit and review handoff

- Intended independent commit message: `docs: correct resolver return contract`.
- The exact fix commit and scoped `90b7e75..<newHEAD>` review-package hash/line/byte evidence are generated after this report is committed and reported in the handoff; this report does not predict its own commit identity.

## Real-WPS nullable-creation topology repair (2026-09-01)

### Scope and root cause

- Fix baseline: `a4dedf02ead98933b645ce8ea27518883e14a8fa`.
- Supplied real-WPS evidence showed surviving unique presentation IDs, one deleted presentation ID, one newly allocated presentation ID, and `p14:creationId` removed from every saved slide. This agent did not read, write, or retry adoption against that real file.
- Root cause traced through inspection, topology parsing, reconciliation, and adoption: inspection correctly returned `creationId: null`; the persisted schema rejected null, null values incorrectly participated in uniqueness/disjointness, reconciliation required both presentation and creation matches, and a new slide without creation evidence was rejected after temporarily substituting the fake value `1`.

### RED-first evidence

- Pure, hand-derived fixtures first ran **RED**, 0/5, `1626.956708ms`:
  - WPS move/delete/insert with presentation IDs `257/259/258` and all-null creation evidence produced five identity conflicts;
  - nullable active/tombstone records failed schema parsing;
  - non-null inconsistent evidence over a presentation-only known slide could not reach the intended fail-closed branch;
  - metadata-only manual adoption failed with `saved deck has ambiguous slide identities`;
  - regeneration reported the unrelated diagnostic `direct edit changed stable complete-deck topology`.
- The authoritative-plan contract separately ran **RED**, 0/1, `208.875333ms`, because it still required non-null creation IDs and described new slides only through creation evidence.

### Minimal repair and safety boundary

- Active and tombstone topology records now persist `creationId: number | null`. Null values do not participate in active/deleted uniqueness, disjointness, crossover maps, or creation tombstone lookup.
- `presentationSlideId` remains mandatory and unique. With inspected creation null, a unique known presentation ID preserves its stable ID and records null exactly; a new unique non-tombstoned presentation ID becomes an unmanaged slide with null creation evidence.
- With inspected creation non-null, both creation and presentation evidence must still resolve to the same stable slide. Single-sided, crossed, duplicate, active/deleted, and presentation-tombstone evidence remain blocking conflicts.
- A second reconciliation over the adopted all-null topology preserves every stable ID. Deleting a later all-null unmanaged page creates a nullable tombstone without conflicting with other null creation values.
- Existing authoritative bindings in candidate creation, adoption validation, activation, direct edit, and regeneration continue to require exact presentation equality and exact nullable creation equality. Strict TypeScript validation covers every consumer; the fixture exercises candidate creation, direct edit, presentation/confirmation, rollback, and regeneration from the adopted nullable topology.
- Regeneration and direct-edit topology checks now supply distinct operation labels; the regeneration failure test requires the accurate regeneration diagnostic and explicitly rejects `direct edit` wording.
- The main plan and design spec now document nullable WPS creation evidence, presentation authority, non-null corroboration, tombstone rejection, and unmanaged-null insertion.

### Fixture integration evidence (not a real-WPS retry)

- WPS-shaped complete PPTX fixture: moved managed page, deleted prior page, inserted new page, presentation IDs `257/259/258`, and all official creation IDs absent.
- Manual saved bytes were adopted metadata-only with unchanged bytes, inode, and size; topology records `[managed/null, unmanaged/null, managed/null]` and retains the presentation tombstone for deleted ID `256`.
- The next page-number resolution returns the moved stable slide. An Agent candidate starts from the exact manual bytes, performs a direct text edit, presents an exact SHA, confirms, and switches current only after confirmation.
- Pointer-only rollback restores the manual revision. Both the manual saved PPTX and Agent candidate PPTX remain byte-identical to their recorded pre-confirm/pre-rollback buffers after confirmation and rollback.
- A new regeneration candidate from the rolled-back nullable topology succeeds, preserves all three null creation values, reaches Agent presentation, and is rejected without moving current.
- Real WPS post-fix adoption and downstream GUI validation remain **PENDING** for the main agent; fixture success is not reported as real GUI success.

### Frozen verification

- Initial targeted GREEN: **PASS**, 5/5, `1295.664334ms`.
- Broader source revisions/activation/CLI/E2E regression: **PASS**, 161/161, `414569.544667ms`.
- Frozen affected source suites (`deck-topology`, `full-deck-editing`, `workflow-contract`): **PASS**, 43/43, `7144.437041ms`.
- `npm run lint:types && npm run build`: **PASS**.
- Frozen affected compiled suites: **PASS**, 43/43, `7184.548958ms`.
- `git diff --check`: **PASS**.

### Commit and review handoff

- Intended independent commit message: `fix: adopt WPS decks without creation IDs`.
- The exact fix commit and scoped `a4dedf0..<newHEAD>` review-package hash/line/byte evidence are generated after this report is committed and reported in the handoff; this report does not predict its own commit identity.

## Whole-branch review closure (2026-09-01)

### Scope and RED evidence

- Review baseline: `248a3be` (`fix: adopt WPS decks without creation IDs`). This round addresses all seven whole-branch findings together; no P2 item was deferred.
- Initial focused source run: **RED**, 81 total / 77 passed / 4 failed, `43.17s`. It proved that the exact complete-deck review CLI and authenticated style-selection CLI were absent, manual `changedSlideIds` only echoed the target instead of actual WPS changes, and the package still exposed the legacy smoke script/CLI contract.
- Adjacent audit then found two old `tests/deck.test.ts` assertions that still required the removed smoke script and legacy acceptance commands. Their focused migration is behavior-based: the script path is absent and `acceptance`, `acceptance-smoke-copy`, and `acceptance-record` are unknown CLI commands.

### Minimal implementation

- Added `complete-deck-review` with exact revision/SHA binding for `edit-page`, `return-upstream`, and `confirm-delivery`. Confirmation enters `delivered` and writes one acceptance record whose `completeDeck`, `formalDelivery`, `exports.pptx`, and `client.completeDeck` all name the same current revision, canonical absolute path, and SHA-256; the PPTX is neither copied nor rewritten.
- Every edit-page transition enters `revising`; manual adoption, Agent confirm/reject, adopted-session recovery, and pointer-only rollback restore `deck-review`, bind the manifest to current, and remove stale formal-delivery/client/export metadata.
- Manual adoption computes actual changed stable IDs from topology position/insertion/deletion plus slide XML and relationship bytes. A WPS-native unmanaged page bypasses converter activation and supports a second complete-deck manual cycle.
- Added authenticated `style-selection`: exact user single choice, representative stable slide, and current project revision are persisted before sample authorization. A stale selection fails closed, and the stage contract now places this wait between `slide-specs` and sample generation authorization.
- Removed `scripts/acceptance-smoke.sh` and isolated the old acceptance mechanism from the public CLI/package route. Exact-current complete-deck review is the active acceptance path.
- Synchronized the active Skill, all five references (`阶段契约`, `门禁清单`, `工作区契约`, `修改路由`, `依赖说明`), README, main plan, workflow-contract tests, package tests, and this acceptance report.

### Focused verification and acceptance boundary

- Frozen focused source suites (`cli-approval`, `full-deck-editing`, `plugin-package`, `planning`, `workflow-contract`): **PASS**, 92/92, `45.98s`.
- Frozen legacy-entry source name-pattern: **PASS**, 2/2, `1.18s`.
- Frozen `npm run lint:types && npm run build`: **PASS**.
- Frozen focused compiled suites: **PASS**, 92/92, `56.38s`; compiled legacy-entry name-pattern: **PASS**, 2/2, `1.20s`.
- Frozen `npm pack --dry-run --json`: **PASS**, 102 files, package size 4,652,855 bytes, unpacked 5,667,702 bytes; legacy smoke script and generated/user PPTX, PDF, montage, and staging artifacts are absent. Built-in style catalog preview assets remain intentional Skill inputs.
- Fixture manual adoption -> exact formal delivery: **PASS** and byte-equal. Fixture Agent confirm/reject/rollback review reset: **PASS**. Actual topology/XML changed IDs and unmanaged second manual edit: **PASS**.
- Real WPS manual edit: **PENDING**. Real WPS next-page continuity: **PENDING**. Real WPS Agent GUI: **PENDING**. No controlled WPS file or user document was opened or modified in this round.
- The long full source/compiled suites were intentionally **not run** in this round; controller frozen verification remains pending and must not be inferred from the focused results.

### Commit and review handoff

- Intended independent commit message: `fix: close exact complete-deck delivery contract`.
- The exact commit and scoped `248a3be..<newHEAD>` review-package hash/line/byte evidence are generated after this report is committed; this report does not predict its own commit identity.

## Whole-branch review fix round 2 (2026-09-01)

### Scope and RED-first evidence

- Review baseline: `ddd5b12`. This round closes all three Important and two Minor findings; no finding was deferred.
- The first focused source run was intentionally **RED**, 5/5 failed in `1.62s`: manual preparation accepted a missing edit binding, delivery ignored the injected fixed-artifact crash checkpoint, legacy v1 style selection could publish a sample plan, the package still contained `src/acceptance/smoke-copy.ts`, and the outline downstream checklist omitted `style-selection`.
- The product boundary stayed strict. Old fixtures were migrated to create/consume authenticated bindings and v2 style evidence instead of weakening candidate creation or sample authorization.

### Minimal closure

- `complete-deck-review edit-page` now persists one pending binding to the exact current deck revision, SHA-256, and stable slide ID. Manual/Agent preparation atomically consumes it; missing, wrong-slide, stale, and replayed bindings fail before candidate/session creation with zero residue. Terminal adoption, confirmation, rejection, recovery, and rollback clear it and restore exact-current `deck-review` state.
- Style-sample plan publication now requires current project stage `style-selection`, authenticated schema v2 selection evidence, exact current project revision, and the Style Lock SHA/recipe produced from that same selection. Legacy v1 evidence remains parseable for explicit migration but cannot authorize external generation.
- The fixed `output/deck-revisions/<revision>/acceptance.json` path now recovers both artifact-written and manifest-before-update crashes, reuses byte-identical evidence across deliver/rollback/redeliver, rejects malformed/conflicting evidence, refuses an external symlink trust root, and never deletes or rewrites the complete deck.
- Removed the packaged `src/acceptance/smoke-copy.ts` implementation and the old create/record/read APIs. Legacy client-acceptance trust helpers are no longer exported from the deep generation module; useful crash, replay, conflict, byte-preservation, and no-follow trust-root coverage now targets exact-current acceptance.
- `outline` invalidation now includes `style-selection` in the human checklist exactly as the machine contract already required. The active Skill, all five references, README, main plan, stage-machine fields, tests, and this report describe the same one-time edit, v2 style, exact acceptance, and removed legacy-package boundaries.

### Focused verification

- Initial five-finding GREEN: **PASS**, 5/5, `20.66s`.
- Full `deck-revisions` source regression after fixture migration: **PASS**, 33/33, `16.04s`.
- Whole `full-deck-activation` source run: 114/116 passed; the two failures identified the two remaining old Agent fixtures. After migrating those fixtures through `complete-deck-review edit-page`, exact rerun: **PASS**, 2/2, `8.77s`. No product relaxation was made.
- Whole `full-deck-editing` source run exposed one obsolete completed-lease-list assertion after the new review action; the corrected no-active/no-pending assertion reran **PASS**, 3/3. The focused complete-deck source matrix otherwise passed 13/14, and its sole failure was an omitted test-process `RUNTIME_*` environment; exact rerun with the required workspace runtime passed 1/1.
- Source workflow/package contract: **PASS**, 15/15. Frozen affected compiled matrix: **PASS**, 17/17 plus complete compiled deck revisions 33/33, for 50/50.
- `npm run lint:types && npm run build`: **PASS**. `npm pack --dry-run --json`: **PASS**, 101 files, package size 4,647,335 bytes, unpacked 5,628,648 bytes. `git diff --check`: **PASS**.
- The long full source and `test:compiled` suites were intentionally **not run**; final full-suite freeze remains controller-owned.

### Real WPS evidence boundary

- This round did not open WPS or touch the ignored controlled project. It preserves the already-recorded real GUI result `PASSED_REAL_WPS_MANUAL_AND_AGENT`: real manual save/adoption/reopen, next-page reconciliation, Agent exact-SHA confirmation, and pointer-only rollback all passed, with saved source/candidate bytes preserved and zero derived review artifacts.
- Fixture results above are not substituted for that real GUI evidence. The ignored acceptance record remains the authority for the real WPS hashes and observations.

### Commit and review handoff

- Intended independent commit message: `fix: enforce exact complete-deck review bindings`.
- The exact commit and scoped `ddd5b12..<newHEAD>` review-package hash/line/byte evidence are generated after this report is committed; this report does not predict its own commit identity.

## Style-selection migration and recovery fix round 4 (2026-09-01)

### RED and root cause

- Review baseline: `fe1e721`. The sole remaining Important finding was production migration and crash recovery for authenticated style selection.
- Initial public API/CLI focused run was intentionally **RED**, 7/7 failed in `9.4s`: matching v1 and retry both stopped at `EEXIST`, none of the three publication checkpoints was recoverable, and a revision race left the next current revision blocked by the stale lock.
- The root cause was a three-step publication split across an exclusive lock write, an exclusive selection write, and an independent manifest update, with no exact replay path. The test helper hid the v1 failure by unlinking `selection.json`, and offline acceptance still authored v1 directly.

### Minimal closure

- `authenticateStyleSelection` now serializes the complete public operation under the project generation lease, validates selection conflicts before mutation, migrates matching current v1 evidence through anchored durable atomic replace to canonical v2, and returns the same result on exact retry.
- The public path can resume after injected `lock-written`, `selection-written`, and `manifest-before-update` failures. It reuses every already-durable byte, repairs only an exact incomplete provisional lock, and updates the stage only after rechecking the current revision.
- Mismatched v1/v2 selection, Style Lock, representative slide, or revision evidence fails closed with selection/lock/recipe/manifest bytes unchanged. After a revision race, only internally coherent stale evidence already preserved by the old revision can be retired; inconsistent evidence is never overwritten.
- Offline acceptance now calls the public authenticated route and writes no v1 selection. The delegated sample helper no longer unlinks selection evidence or creates a lock outside that public route. Schema-v1 remains parseable solely for migration and still cannot publish external sample authorization.
- Active Skill, all five references, README, main plan, and the machine workflow policy now state the same atomic migration, exact replay, and byte-preserving conflict contract.

### Focused verification and evidence boundary

- Final source planning + workflow contract: **PASS**, 67/67, `43.72s`; focused generation/style authorization and lock regression: **PASS**, 4/4, `8.76s`; source offline E2E: **PASS**, 2/2, `10.68s`.
- Final exact public migration/checkpoint rerun: **PASS**, 7/7, `6.45s`. `npm run lint:types` and `npm run build`: **PASS**.
- Compiled public migration/checkpoint 7/7, workflow 11/11, generation/style 4/4, and E2E 2/2: **PASS**, 24/24 total.
- `npm pack --dry-run --json`: **PASS**, 101 files, 4,649,283 bytes packed / 5,638,270 bytes unpacked. `git diff --check`: **PASS**.
- No full source or compiled suite was run; controller freeze remains authoritative. This round did not open WPS or touch a user/controlled PPTX. Fixture E2E is not real WPS evidence, and the previously recorded real WPS result remains unchanged.

### Commit and review handoff

- Intended independent commit message: `fix: recover authenticated style selection`.
- The exact commit and scoped `fe1e721..<newHEAD>` review-package SHA/line/byte evidence are generated after this report is committed; this report does not predict its own commit identity.

## Authenticated stale-style retirement fix round 5 (2026-09-01)

### RED and trust-boundary finding

- Review baseline: `f6dc107`. The sole Important finding was that stale style retirement trusted mutually coherent canonical files without authenticating their ownership or immutable revision provenance.
- The initial hand-derived matrix was intentionally **RED**, 4 total / 1 passed / 3 failed, `6.12s`: wrong-project evidence, an unknown revision, and coherent bytes differing from the known old revision snapshot were all silently deleted and replaced. Only the legal exact-snapshot race happened to pass.
- Rejected cases assert byte-exact preservation of `selection.json`, `lock.json`, `recipe.json`, and `superppt.json`, and no additional business files. Lease audit records are intentionally excluded from that business-artifact assertion.

### Minimal closure

- `retireCoherentStaleEvidence` now requires the lock project to equal the current project; its revision to be a strictly older manifest revision; and the direct child revision's `parentSnapshotDescriptorSha256` to authenticate that old revision's immutable descriptor.
- The authenticated immutable manifest snapshot must bind the exact canonical `style/selection.json` SHA and old revision. The v2 selection then binds the exact lock SHA, and the lock binds the exact recipe SHA. Project/revision membership or internal file coherence alone never authorizes removal.
- The path uses the existing authenticated snapshot reader plus owned/no-follow style reads. It rereads all three exact byte sequences immediately before anchored removal while the existing generation lease serializes the operation; missing, changed, wrong-project, unknown, unanchored, or mismatched evidence fails closed.
- Authenticated style publication records `manifest.style` against the actual selection bytes. A project revision invalidates the live style binding while its immutable parent snapshot retains the retirement proof.
- Style-sample finalization now preserves the authenticated selection bytes instead of reformatting them, so the manifest binding remains valid while sample artifacts are finalized.
- Active Skill, all five references, README, main plan, and the machine workflow policy state the same project/old-revision/child-anchor/immutable-byte requirements.

### Focused verification and evidence boundary

- Frozen source public/stale matrix: **PASS**, 10/10, `18.15s`; source planning + workflow: **PASS**, 70/70, `62.90s`; generation/style: **PASS**, 4/4, `16.73s`; complete-deck E2E: **PASS**, 2/2, `21.01s`.
- `npm run lint:types && npm run build`: **PASS**.
- Compiled public/stale matrix 10/10, workflow 11/11, generation/style 4/4, and E2E 2/2: **PASS**, 27/27 total.
- `npm pack --dry-run --json`: **PASS**, 101 files, 4,650,225 bytes packed / 5,641,963 bytes unpacked; no generated/user PPTX, PDF, montage, staging, or legacy smoke-copy entry is packaged.
- The long full source and compiled suites were intentionally **not run**; controller freeze remains pending. This round did not open WPS or touch any user/controlled PPTX, and prior real WPS evidence remains unchanged.

### Commit and review handoff

- Intended independent commit message: `fix: authenticate stale style retirement`.
- The exact commit and scoped `f6dc107..<newHEAD>` review-package SHA/line/byte evidence are generated after this report is committed; this report does not predict its own commit identity.

## Style snapshot rollback and replayable retirement fix round 6 (2026-09-01)

### RED-first evidence and root causes

- Review baseline: `d359113`. Two Important findings were addressed together.
- Initial public-behavior run was intentionally **RED**, 0/2, `12.50s`. A real R0 authenticated `style-selection` → R1 new style → rollback R0 failed at `artifact hash mismatch: style/selection.json`; a crash expected after the first stale-evidence removal was never observed because retirement had no checkpoint or recovery transaction.
- Three adjacent RED probes then locked the full trust boundary: a rolled-back R0 style chain could not be snapshotted for the next revision, a coordinated project-path/snapshot-file crossover was accepted by the snapshot reader, and an approved Style Lock could not cross a revision transition because selection correctly retains the provisional-lock SHA while the live lock is promoted.
- The machine workflow contract was separately RED until it named both descriptor-bound rollback restoration and replayable retirement.

### Minimal closure

- Revision manifest snapshots now publish schema v2. When `manifest.style` is present, the exact `style/selection.json`, `style/lock.json`, and `style/recipe.json` bytes are copied into the immutable snapshot; descriptor entries bind their fixed project paths, fixed snapshot filenames, hashes, and sizes. The reader requires the exact regular-file tree, reads every byte twice through anchored/no-follow access, validates descriptor integrity and the full selection/lock/recipe chain, and rejects missing, extra, linked, crossed, or hash-conflicting evidence.
- Schema-v1 snapshots remain readable and idempotently reusable only when their manifest claims no style chain. A v1 snapshot with `manifest.style` fails closed instead of pretending it can restore missing bytes.
- Rollback merges descriptor-authenticated style snapshot bytes into the existing authenticated planning-artifact map before publishing its journal. R0 selection/lock/recipe bytes, `manifest.style`, and `style-selection` stage are restored without a later style-sample gate. The current R1 bytes are also preserved by its immutable pre-rollback snapshot and rollback journal; all four existing crash boundaries converge to the byte-exact before/after state.
- A rollback creates a new project revision while the restored style evidence remains owned by its original known revision. Subsequent snapshot/apply operations accept that exact historical binding without rewriting it.
- Stale retirement now publishes an exact, descriptor-integrity-protected transaction containing the three old bytes and their snapshot anchor before any removal. Each removal is idempotent; interruption after selection, recipe, or lock removal resumes from the transaction, reauthenticates project/revision/child anchor/snapshot bytes, and atomically moves the active transaction to immutable completed evidence before publishing the new v2 selection.
- Approved locks are accepted only by reconstructing the exact provisional form bound by selection while separately snapshot-binding the promoted lock bytes; recipe and project/revision bindings remain exact. Unauthenticated conflicts still create no retirement transaction and preserve live evidence.
- The old custom-style fixture was not used to relax production: it now supplies its actual discriminated custom v1 selection, and the test helper preserves that source instead of incorrectly coercing every existing lock to a catalog choice.
- Active Skill, all five references, README, main plan, and machine stage policy describe the same snapshot-v2 rollback and replayable-retirement contract.

### Focused verification and evidence boundary

- Core Round6 behavior/safety matrix: **PASS**, 4/4, `20.14s`; v1 compatibility 1/1; rolled-back continuation 1/1; project-path crossover 1/1; approved-lock transition and retirement 1/1.
- Frozen focused source (`revisions`, `project-state`, `planning`, `styles`, `e2e`, `workflow-contract`): **PASS**, 153 total / 151 passed / 0 failed / 2 Windows-only skipped, `94.94s`.
- `npm run lint:types && npm run build`: **PASS**.
- Frozen matching compiled suites: **PASS**, 153 total / 151 passed / 0 failed / 2 Windows-only skipped, `132.09s`.
- `npm pack --dry-run --json`: **PASS**, 101 files, 4,653,336 bytes packed / 5,659,449 bytes unpacked; generated/user PPTX, PDF, montage, staging, and legacy smoke-copy entries are absent. `git diff --check`: **PASS**.
- The long full source and `test:compiled` suites were intentionally **not run**. This round did not open WPS or touch a user/controlled PPTX; prior real WPS evidence remains unchanged.

### Commit and review handoff

- Intended independent commit message: `fix: restore style evidence across rollback`.
- The exact commit and scoped `d359113..<newHEAD>` review-package SHA/line/byte evidence are generated after this report is committed; this report does not predict its own commit identity.
