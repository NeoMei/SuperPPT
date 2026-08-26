# Task 8 report: image-deck assembly and acceptance

## Outcome

Implemented revision-bound assembly for SuperPPT image decks. PPTX creation now uses a generated JavaScript ES module and `@oai/artifact-tool`; the obsolete `pptxgenjs` dependency was removed. The same decoded, ordered final-render byte set drives PPTX, PDF, and montage output.

## Implementation

- Added strict 1920x1080 PNG/JPEG decoding, SHA-256 binding, safe IDs, contiguous order checks, stable `page-<slide-id>` object names, and 1280x720 full-bleed slides.
- Added command-scoped runtime enforcement for `RUNTIME_NODE`, `RUNTIME_NODE_MODULES`, and `RUNTIME_BIN_DIR`. The temporary authoring directory receives a local `node_modules` symlink (junction on Windows) and a generated `.mjs` builder.
- Added PDF and montage export from the exact validated `FinalRender[]` buffers used by the PPTX builder.
- Added assembly under the `assembly` project lease with `output/.staging-*`, exclusive promotion to `output/revisions/<revision-number>/`, immutable ownership evidence, current-revision rechecks, and recovery when promotion completed before manifest publication.
- Added physical hash validation for final renders and every export, strict output marker checks, refusal to overwrite unowned or tampered destinations, and exact manifest artifact references.
- Added acceptance schema/building plus `acceptance`, and explicit `acceptance-record`. `deliveryComplete` is true only when application selection, opened, edited, saved, reopened, and confirmation time are explicitly present and the revision/gates/slides/exports still match current physical evidence.
- Added CLI routes: `assemble`, `acceptance`, and `acceptance-record`.

## TDD and safety coverage

`tests/deck.test.ts` covers:

- shared order and page parity across PPTX/PDF/montage;
- stable PPTX image object names and page structure;
- empty decks, duplicate/non-contiguous order, duplicate IDs;
- complete decoding, exact 1920x1080 geometry, symlinks, render hash tampering, and read-time replacement;
- injected artifact runtime and trusted-root output anchoring;
- strict acceptance initialization and stale/non-ready/tampered rejection;
- owned staging/promotion and manifest/physical-reference parity;
- partial build failure, post-promotion crash recovery, concurrent assembly, stale revision, unowned destination, and output tampering;
- explicit all-true acceptance recording and current-evidence enforcement;
- strict CLI route exposure.

The initial focused run failed because the deck modules did not exist. The CLI route test separately failed with `unknown command: assemble` before the routes were implemented.

## Verification evidence

- Artifact-operation marker: executed successfully exactly once before the first real authoring run with `create`, expected output count `1`, format `pptx`.
- Focused tests: `node --import tsx --test tests/deck.test.ts` -> 14 passed, 0 failed.
- Full source tests: `npm test` -> 140 tests, 138 passed, 2 Windows-only skipped, 0 failed.
- Type check: `npm run lint:types` -> passed.
- Build: `npm run build` -> passed.
- Compiled tests: `npm run test:compiled` -> 140 tests, 138 passed, 2 Windows-only skipped, 0 failed.
- Diff hygiene: `git diff --check` -> clean.
- Prohibited implementation scan: no `pptxgenjs`, PptxGenJS, `python-pptx`, or `python_pptx` in Task 8 production files; no machine-specific runtime path is embedded in production code.

## Presentation QA

A real three-slide deck was authored with `@oai/artifact-tool` from three 1920x1080 source images.

- `render_slides.py` rendered all 3 slides.
- `slides_test.py` reported: `Test passed. No overflow detected.`
- Artifact Tool import/inspect found exactly one image per slide, ordered stable names `page-qa-1`, `page-qa-2`, `page-qa-3`, and bbox `[0,0,1280,720]` on every page.
- Per-slide layout JSON confirmed 1280x720 full-bleed placement; speaker notes were empty because the inputs were user-generated and had no external sources.
- Full-size visual inspection of all 3 renders confirmed complete edge-to-edge images with no clipping, gaps, or unintended overlap.
- PDF page count was 3; montage geometry was 1200x225 for three 400x225 tiles.

## Scope boundary

Only Task 8 files are intended for this commit: `package.json`, `package-lock.json`, `src/cli.ts`, `src/deck/**`, `src/acceptance/**`, `tests/deck.test.ts`, and this report. Concurrent generation/reviewer changes in the shared worktree are intentionally excluded.
