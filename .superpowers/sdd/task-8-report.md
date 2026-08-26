# Task 8 report: image-deck assembly and acceptance

## Outcome

Implemented revision-bound assembly for SuperPPT image decks. PPTX creation now uses a generated JavaScript ES module and `@oai/artifact-tool`; the obsolete `pptxgenjs` dependency was removed. The same decoded, ordered final-render byte set drives PPTX, PDF, and montage output.

## Implementation

- Added strict 1920x1080 PNG/JPEG decoding, SHA-256 binding, safe IDs, contiguous order checks, stable `page-<slide-id>` object names, and 1280x720 full-bleed slides.
- Added command-scoped runtime enforcement for `RUNTIME_NODE`, `RUNTIME_NODE_MODULES`, and `RUNTIME_BIN_DIR`. The temporary authoring directory receives a local `node_modules` symlink (junction on Windows) and a generated `.mjs` builder.
- Added PDF and montage export from the exact validated `FinalRender[]` buffers used by the PPTX builder.
- Added physical same-byte verification: every PPTX slide must contain exactly one image shape whose relationship resolves to media bytes matching the ordered final-render SHA-256; PDF and montage bytes are deterministically rebuilt and compared byte-for-byte.
- Added assembly under the `assembly` project lease with `output/.staging-*`, exclusive promotion to `output/revisions/<revision-number>/`, immutable ownership evidence, current-revision rechecks, and recovery when promotion completed before manifest publication.
- Added full slide-identity binding, strict canonical artifact paths, physical hash validation, refusal to overwrite unowned/tampered destinations, and quarantine when a same-revision render changes after output promotion.
- Provider identity is authenticated from every page's accepted attempt ledger; caller/default provider values are not part of the assembly API or CLI.
- Added acceptance schema/building plus `acceptance`, and explicit `acceptance-record`. Delivery recording never replaces old evidence: it atomically publishes fixed-name immutable `acceptance-record.json`, then performs one manifest-pointer update. A crash leaves only a harmless orphan; retry re-parses the 0600 client input and deterministically recomputes the entire expected record instead of trusting a side journal. `deliveryComplete` is true only when application selection, opened, edited, saved, reopened, and confirmation time are explicitly present and revision/gates/provider/slides/exports still match current physical evidence.
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
- partial build failure, post-promotion crash recovery, concurrent assembly, real controlled stale-revision transition, same-revision render replacement, unowned destination, output tampering, and canonical-path recovery;
- unbound/fake PPTX rejection, attempt-ledger provider binding and tamper rejection, and deterministic PDF/montage byte binding;
- explicit all-true acceptance recording, hard-crash retry after immutable record promotion, coordinated orphan-record rewrite rejection, and current-evidence enforcement;
- injected runtime portability with platform-specific `PATH` delimiter and no machine path embedded in source/tests;
- strict CLI route exposure.

The initial focused run failed because the deck modules did not exist. The CLI route test separately failed with `unknown command: assemble` before the routes were implemented.

## Verification evidence

- Artifact-operation marker: executed successfully exactly once before the first real authoring run with `create`, expected output count `1`, format `pptx`.
- Focused tests: `node --import tsx --test tests/deck.test.ts` -> 21 passed, 0 failed.
- Full source tests: `npm test` -> 154 tests, 152 passed, 2 Windows-only skipped, 0 failed.
- Type check: `npm run lint:types` -> passed.
- Build: `npm run build` -> passed.
- Compiled tests: `npm run test:compiled` -> 154 tests, 152 passed, 2 Windows-only skipped, 0 failed.
- Diff hygiene: `git diff --check` -> clean.
- Prohibited implementation scan: no `pptxgenjs`, PptxGenJS, `python-pptx`, or `python_pptx` in Task 8 production files; no machine-specific runtime path is embedded in production code.

## Presentation QA

A real three-slide deck was authored with `@oai/artifact-tool` from three 1920x1080 source images at `/tmp/superppt-task8-review-qeeZSF`.

The test commands were run with `RUNTIME_NODE`, `RUNTIME_NODE_MODULES`, and `RUNTIME_BIN_DIR` supplied by the loaded workspace dependency runtime. Rendering used that runtime's Python and `PATH="$RUNTIME_BIN_DIR:$PATH"`:

```text
node --import tsx --test tests/deck.test.ts
npm test
npm run lint:types
npm run build
npm run test:compiled
<runtime-python> <presentations-skill>/container_tools/render_slides.py /tmp/superppt-task8-review-qeeZSF/deck.pptx
<runtime-python> <presentations-skill>/container_tools/slides_test.py /tmp/superppt-task8-review-qeeZSF/deck.pptx
```

- `render_slides.py` rendered all 3 slides.
- `slides_test.py` reported: `Test passed. No overflow detected.`
- OOXML inspection resolved one image relationship per slide and found that ordered packaged-media SHA-256 values exactly equaled the three ordered source-image SHA-256 values.
- Artifact Tool import/inspect found exactly one image per slide, ordered stable names `page-qa-1`, `page-qa-2`, `page-qa-3`, and bbox `[0,0,1280,720]` on every page.
- Per-slide layout JSON confirmed 1280x720 full-bleed placement; speaker notes were empty because the inputs were user-generated and had no external sources.
- Full-size visual inspection of all 3 renders confirmed complete edge-to-edge images with no clipping, gaps, or unintended overlap.
- PDF page count was 3; montage geometry was 1200x225 for three 400x225 tiles.

## Scope boundary

This hardening commit contains only Task 8 files: `src/cli.ts`, `src/deck/assemble.ts`, `src/deck/montage.ts`, `src/deck/pdf.ts`, `src/deck/pptx.ts`, `tests/deck.test.ts`, and this report. Task 6/7 sources and tests are excluded.
