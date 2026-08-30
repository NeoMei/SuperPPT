# Task 2 Implementer Report: Activate One Official Editable Slide in a Complete Deck

Status: DONE

Date: 2026-08-31 (Asia/Shanghai)

Base: `5c65e6d`

Final single-commit subject: `feat: activate official editable donors in full decks`

The immutable commit hash is reported to the orchestrator after commit creation. This report is included in that same commit, so it cannot contain its own final hash without a self-reference.

---

## Scope delivered

- Added `activateEditableSlideInDeck()` and `rewriteInternalImageRelationships()` in `src/deck-revisions/activate-slide.ts`.
- Added strict official v2 manifest, run-ledger, conversion-record, and authenticated-conversion schemas.
- Upgraded the editable adapter to require converter `0.2.x`, `manifestVersion: 2`, exact `slide-editable.pptx`, and authenticated source/manifest/ledger/clean-background/asset/donor hashes.
- Added `inspectOfficialEditableDonor()` and `authenticateProjectEditableConversion()` as the adapter's public authentication/inspection boundary.
- Activated only the selected complete-deck slide by raw namespace-aware `spTree` replacement. Untouched slide XML/relationships, target layout/notes/comments/transition/timing, unknown namespace content, and extension ranges remain outside the patched range.
- Copied only donor PNG image relationships into collision-free `ppt/media/superppt-<uuid>.png` parts with collision-free relationship IDs.
- Staged, inspected, race-checked, and atomically replaced the complete candidate exactly once; updated the active session prepared hash and journal `editableSlideIds`; returned only the complete candidate path.
- Migrated the existing editable, mixed-deck, and offline e2e converter fixtures to real official v2 evidence. The mixed-deck and offline acceptance fixture migrations were necessary scope exceptions because the Task 2 strict adapter correctly rejects their old 0.1/v1 fake outputs. They do not change product assertions, preview/export behavior, or provider behavior.

No installed Skill/plugin files were modified. No donor was rebuilt from source, no live analyze/run/provider call was made, and no credentials were used.

---

## Official v2 contract consumed

The implementation read and followed the installed physical `image-to-editable-pptx` 0.2.0 Skill, package schema, manifest/ledger schema, and build-output implementation. The authenticated contract is:

- converter package version `>=0.2.0 <0.3.0`;
- `manifestVersion: 2` with text, native shape, and transparent asset elements;
- asset `role`, `groupId`, `provenance`, `relations`, and `reviewRequired` evidence;
- ledger hashes for source image, manifest, clean background, assets, and donor PPTX;
- exact official donor filename `slide-editable.pptx`;
- official object names `asset-background`, `text-<id>`, `shape-<id>-<label>`, and `asset-<id>`.

The adapter retains its previous v1 text/asset compatibility view only for existing downstream edit operations. Authentication and deck activation use `officialManifest`, never that compatibility view.

---

## Strict TDD evidence

### RED

`tests/full-deck-activation.test.ts` was created first with an import of the not-yet-existing activation module.

```text
node --import tsx --test tests/full-deck-activation.test.ts
```

Result: expected `ERR_MODULE_NOT_FOUND` for `src/deck-revisions/activate-slide.js`. No production activation implementation existed at that point.

### GREEN

Final activation-only run after the slide-count race fixture was made explicit:

```text
node --import tsx --test tests/full-deck-activation.test.ts
```

Result: 25 tests, 25 passed, 0 failed, duration 3373.788584 ms.

Plan-focused run:

```text
node --import tsx --test tests/full-deck-activation.test.ts tests/editable.test.ts && npm run lint:types
```

Result: 68 tests, 68 passed, 0 failed; TypeScript passed. Duration for the test portion: 393064.556333 ms.

The first complete focused run exposed one legacy promotion assertion comparing the adapter's compatibility v1 view with the raw official v2 file. The assertion was corrected to compare the public compatibility interface; no adapter strictness was weakened.

Affected revision/deck suites were also run directly. That direct runner produced four expected `RUNTIME_*` environment failures and two obsolete mixed-deck 0.1 fixture failures. The standard test runner subsequently supplied the official workspace runtime; the mixed fixture was migrated to v2. No product change was made for the environment-only failures.

Offline e2e focused proof:

```text
RUNTIME_NODE=<workspace-node> RUNTIME_NODE_MODULES=<workspace-node-modules> RUNTIME_BIN_DIR=<workspace-bin> \
  node --import tsx --test tests/e2e.test.ts
```

Result: 1 passed, 0 failed. The test additionally proves the retained conversion record says `0.2.0`, the retained manifest says v2, and `slide-editable.pptx` is a readable ZIP containing the official presentation and slide parts.

Final standard run after all fixture migrations:

```text
npm test
```

Result: 469 tests, 467 passed, 0 failed, 2 Windows-only skipped, duration 874683.652375 ms.

Final type and patch checks:

```text
npm run lint:types
git diff --check
```

Result: both passed.

---

## Positive and negative coverage

Positive coverage proves:

- a 3-page candidate changes only its middle page;
- the returned path is the complete candidate and no single-slide artifact is exposed;
- native text, native shape, transparent assets, official names, and `reviewRequired` metadata survive;
- donor non-default prefixes remain valid after transplant;
- target unknown namespace declarations/extensions, transition, timing, layout, notes, and comments survive;
- untouched slide and relationship bytes remain identical;
- candidate metadata receives the committed hash and editable slide ID.

Negative coverage rejects:

- manifest v1 and converter 0.1/0.3;
- missing/mismatched official donor, manifest, clean background, source, asset, ledger, and owned paths/hashes;
- absolute/escaping outputs and candidates outside `output/deck-revisions/<revisionId>/deck.pptx`;
- external relationships, `r:link`, unsupported shape-tree relationships, macros, OLE, non-PNG media, ActiveX, charts, and diagrams;
- duplicate/wrong official object names;
- non-16:9 donors and donors with more than one slide;
- target index/slide-ID mismatch;
- a candidate changing to a 4-slide deck during staging.

---

## Public interfaces

- `activateEditableSlideInDeck(options): Promise<ActivatedDeckResult>`
- `rewriteInternalImageRelationships(relationshipsXml, additions): string`
- `inspectOfficialEditableDonor(bytes, manifest): Promise<OfficialEditableDonorInspection>`
- `authenticateProjectEditableConversion(options): Promise<AuthenticatedEditableConversionResult>`
- `AuthenticatedEditableConversionSchema`
- `EditableManifestV2Schema`

`ActivatedDeckResult.absolutePath` is the complete candidate path. The result intentionally has no single-slide artifact path.

---

## Risks and intentionally not done

- This task does not wire activation into Task 3 orchestration, CLI routing, UI, or WPS automation.
- It does not update the general dependency resolver's installed-plugin version range; that remains Task 6. Test/offline fixtures construct their already-authenticated 0.2 dependency identity locally rather than advancing Task 6.
- It does not rebuild, invoke, publish, or modify the official converter Skill/plugin.
- Candidate PPTX replacement is atomic. Session and journal JSON updates follow it as separately durable atomic files under the same project lease; broader multi-file crash recovery belongs to later orchestration work.
- No push, publish, release, deploy, or remote mutation was performed.
