# Local Full-Deck Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one local, complete PPTX revision the only SuperPPT review and editing artifact, activate or modify only the requested slide inside a full-deck candidate, and adopt user-saved bytes without any post-save rewrite or reassembly.

**Architecture:** Replace viewer adapters and page-preview confirmation with an owned local deck-revision ledger. Every edit starts by copying the current complete PPTX into a new candidate; editable reconstruction or Agent operations are applied to the target slide before the file link is shown. Manual save adoption changes only project metadata, while Agent edits require confirmation of the exact candidate hash before the same metadata-only promotion.

**Tech Stack:** TypeScript 5.9, Node.js >=22.6, Zod 4, JSZip, `@oai/artifact-tool` through the bundled runtime, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-superppt-design.md`

## Global Constraints

- Preserve the guided confirmation flow: outline, slide specifications, style sample, generation authorization, and complete-deck review remain human wait points.
- The runtime must have local filesystem access and must produce an absolute, clickable path to a writable `.pptx`; there is no cloud, upload, browser viewer, image-preview, or download fallback.
- The user only receives links to complete PPTX files. A one-slide PPTX may exist inside private staging only and must never be published as a user artifact.
- Every edit candidate starts from the exact current complete PPTX, never from regenerated page manifests or an older image ledger.
- Only the requested slide may be changed while preparing a candidate. Untouched slide XML and relationship parts must retain their pre-edit hashes.
- Manual editing means: prepare complete candidate, open in WPS/PowerPoint, save in place, receive the user's explicit `已保存`, perform read-only validation, and move the current-revision pointer. No copy, render, slide replacement, assembly, centering, style normalization, or other PPTX write is allowed after the user saves.
- Agent editing means: prepare and modify a complete candidate, provide its local link, and move the pointer only after the user confirms the candidate's exact SHA-256.
- An externally opened candidate is serialized. SuperPPT must not write it until the user reports it saved and the file passes the stable-read check.
- Preserve old complete PPTX revisions so `恢复上一版` changes only the current pointer.
- Keep `ai-image-to-ppt` and `image-to-editable-pptx` as separate versioned skills. SuperPPT owns orchestration, full-deck package operations, and revision state only.
- WPSComposer is not part of review, preview, adoption, or the primary editing path.
- Node engine floor remains `>=22.6`.
- The worktree already contains unrelated and in-progress changes. Start every task with `git status --short`; stage only the files named by that task and never reset or overwrite unrelated edits.

---

## File Structure

- Create `src/deck-revisions/schemas.ts`: local complete-deck revision, edit-session, adoption, and current-pointer schemas.
- Create `src/deck-revisions/inspect.ts`: safe regular-file checks, stable reads, PPTX package validation, slide-part hashing, and editable-object inspection.
- Create `src/deck-revisions/store.ts`: candidate creation, metadata publication, current-pointer movement, rejection, and rollback without rewriting PPTX bytes.
- Create `src/deck-revisions/activate-slide.ts`: transplant one private editable donor slide's shape tree and media relationships into the corresponding slide of a complete candidate.
- Create `src/deck-revisions/edit-slide.ts`: resolve and patch named objects in the actual current target-slide XML without rebuilding a user-saved page from an old manifest.
- Create `src/deck-revisions/workflow.ts`: manual-edit and Agent-edit orchestration over complete candidates.
- Create `src/editable/route.ts`: least-destructive `direct-edit -> activate-editable -> regenerate-slide` routing.
- Modify `src/deck/pptx.ts`: expose private one-slide donor generation only; do not publish donor paths.
- Modify `src/deck/assemble.ts`: initial assembly publishes a complete local deck revision and no PDF/montage/preview artifacts.
- Modify `src/editable/operations.ts`, `src/editable/adapter.ts`, and `src/editable/schemas.ts`: feed editable reconstruction and Agent operations into full-deck candidate preparation.
- Modify `src/project/schemas.ts`, `src/project/store.ts`, and `src/project/promotion.ts`: persist current deck pointer and edit-session state; remove montage and slide-preview authority.
- Modify `src/acceptance/schema.ts`, `src/acceptance/build.ts`, and `src/acceptance/current.ts`: bind delivery to the exact current complete PPTX revision.
- Modify `src/cli.ts`: expose complete-deck link, prepare/adopt manual edit, prepare/confirm/reject Agent edit, and rollback commands.
- Delete `src/deck/pdf.ts`, `src/deck/montage.ts`, `src/deck/wps-export.ts`, `src/editable/preview-image.ts`, and the post-save preview/rebuild portions of `src/editable/render.ts`.
- Modify `src/dependencies/schemas.ts`, `src/dependencies/resolve.ts`, `src/dependencies/preflight.ts`, and `references/dependencies.json`: remove WPSComposer review/export requirements.
- Modify `package.json` and `package-lock.json`: remove `pdf-lib` after PDF generation is deleted.
- Modify `skills/superppt/SKILL.md`, `skills/superppt/references/阶段契约.json`, `skills/superppt/references/门禁清单.md`, `skills/superppt/references/修改路由.md`, `skills/superppt/references/工作区契约.md`, and `README.md`: describe the local full-deck conversational flow.
- Create `tests/deck-revisions.test.ts`, `tests/full-deck-activation.test.ts`, and `tests/full-deck-editing.test.ts`.
- Modify `tests/deck.test.ts`, `tests/editable.test.ts`, `tests/import-edit.test.ts`, `tests/generation.test.ts`, `tests/mixed-deck.test.ts`, `tests/project-state.test.ts`, `tests/publication.test.ts`, `tests/workflow-contract.test.ts`, `tests/cli-approval.test.ts`, `tests/e2e.test.ts`, and `tests/plugin-package.test.ts`.
- Delete `tests/wps-export.test.ts` after its no-PDF/no-WPS assertions move to the deck and package tests.

---

### Task 1: Define the Local Complete-Deck Revision Ledger

**Files:**
- Create: `src/deck-revisions/schemas.ts`
- Create: `src/deck-revisions/inspect.ts`
- Create: `src/deck-revisions/store.ts`
- Create: `tests/deck-revisions.test.ts`
- Modify: `src/project/schemas.ts`

**Interfaces:**
- Produces `LocalDeckRevisionSchema`, `DeckEditSessionSchema`, `CurrentDeckPointerSchema`, and `DeckAdoptionEvidenceSchema`.
- Produces `inspectLocalPptx(path: string): Promise<InspectedLocalPptx>`.
- Produces `createDeckCandidate(root, options): Promise<ResolvedLocalDeckRevision>`.
- Produces `adoptDeckCandidate(root, options): Promise<ResolvedCurrentDeckPointer>` and `rollbackCurrentDeck(root, revisionId): Promise<ResolvedCurrentDeckPointer>`.
- Consumes `Sha256Schema`, safe project-path helpers, durable JSON writes, and project locks.

- [ ] **Step 1: Write failing schema and lifecycle tests**

```ts
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  adoptDeckCandidate,
  createDeckCandidate,
  readCurrentDeckPointer,
  rollbackCurrentDeck,
} from "../src/deck-revisions/store.js";

test("manual adoption moves only the current pointer and preserves saved bytes", async (t) => {
  const fixture = await completeDeckProject(t);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: fixture.current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [fixture.slideIds[1]!],
    editableSlideIds: [fixture.slideIds[1]!],
  });
  const userSavedBytes = await userEditedFixture(await readFile(candidate.absolutePath));
  await writeFile(candidate.absolutePath, userSavedBytes);

  const adopted = await adoptDeckCandidate(fixture.root, {
    candidateRevisionId: candidate.revisionId,
    mode: "manual",
    userSignal: "saved",
  });

  assert.deepEqual(await readFile(candidate.absolutePath), userSavedBytes);
  assert.equal(adopted.revisionId, candidate.revisionId);
  assert.equal((await readCurrentDeckPointer(fixture.root)).sha256, adopted.sha256);
  assert.deepEqual(await readFile(fixture.current.absolutePath), fixture.currentBytes);
});

test("rollback changes the pointer without rewriting either deck", async (t) => {
  const fixture = await adoptedTwoRevisionProject(t);
  const before = await Promise.all(fixture.revisions.map((item) => readFile(item.absolutePath)));
  const pointer = await rollbackCurrentDeck(fixture.root, fixture.revisions[0]!.revisionId);
  assert.equal(pointer.revisionId, fixture.revisions[0]!.revisionId);
  assert.deepEqual(
    await Promise.all(fixture.revisions.map((item) => readFile(item.absolutePath))),
    before,
  );
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `node --import tsx --test tests/deck-revisions.test.ts`

Expected: FAIL because `src/deck-revisions/store.ts` does not exist.

- [ ] **Step 3: Implement strict revision and session schemas**

```ts
export const LocalDeckRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().uuid(),
  parentRevisionId: z.string().uuid().nullable(),
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  deckRevision: z.number().int().positive(),
  reason: z.enum(["initial", "manual-edit", "agent-edit", "slide-regeneration"]),
  state: z.enum(["candidate", "external-editing", "current", "superseded", "rejected"]),
  relativePath: z.string().regex(/^output\/deck-revisions\/[0-9a-f-]{36}\/deck\.pptx$/),
  preparedSha256: Sha256Schema,
  finalSha256: Sha256Schema.nullable(),
  editableSlideIds: z.array(z.string().uuid()),
  changedSlideIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
  adoptedAt: z.string().datetime().nullable(),
}).strict();

export const DeckEditSessionSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  candidateRevisionId: z.string().uuid(),
  mode: z.enum(["manual", "agent"]),
  targetSlideId: z.string().uuid(),
  state: z.enum(["prepared", "external-editing", "awaiting-confirmation", "adopted", "rejected"]),
  presentedSha256: Sha256Schema.nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export const CurrentDeckPointerSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().uuid(),
  relativePath: z.string().regex(/^output\/deck-revisions\/[0-9a-f-]{36}\/deck\.pptx$/),
  sha256: Sha256Schema,
  updatedAt: z.string().datetime(),
}).strict();

export const DeckAdoptionEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  adoptionId: z.string().uuid(),
  mode: z.enum(["manual", "agent"]),
  candidateRevisionId: z.string().uuid(),
  previousRevisionId: z.string().uuid().nullable(),
  adoptedSha256: Sha256Schema,
  userSignal: z.literal("saved").nullable(),
  confirmedSha256: Sha256Schema.nullable(),
  adoptedAt: z.string().datetime(),
}).strict().superRefine((evidence, context) => {
  if (evidence.mode === "manual" && (evidence.userSignal !== "saved" || evidence.confirmedSha256 !== null)) {
    context.addIssue({ code: "custom", message: "manual adoption requires only the saved signal" });
  }
  if (evidence.mode === "agent" && (evidence.userSignal !== null || evidence.confirmedSha256 !== evidence.adoptedSha256)) {
    context.addIssue({ code: "custom", message: "agent adoption requires exact candidate confirmation" });
  }
});

export type LocalDeckRevision = z.infer<typeof LocalDeckRevisionSchema>;
export type CurrentDeckPointer = z.infer<typeof CurrentDeckPointerSchema>;
export type ResolvedLocalDeckRevision = LocalDeckRevision & { absolutePath: string };
export type ResolvedCurrentDeckPointer = CurrentDeckPointer & { absolutePath: string };
```

Add `currentDeck: CurrentDeckPointerSchema.nullable()` and `deckEditSession: DeckEditSessionSchema.nullable()` to `ProjectManifestSchema`. Remove preview artifacts from `EditableRevisionBindingSchema`; the binding retains converter identity and editable slide IDs but does not point to a PNG.

- [ ] **Step 4: Implement safe PPTX inspection and stable reads**

`inspectLocalPptx()` must:

1. require an absolute, canonical, non-symlink regular file under the validated project root;
2. read the file twice with matching `size`, `mtimeMs`, and SHA-256;
3. parse it with JSZip and require `[Content_Types].xml`, `ppt/presentation.xml`, `ppt/_rels/presentation.xml.rels`, and at least one `ppt/slides/slideN.xml`;
4. return the complete file SHA, byte length, slide count, ordered slide-part paths, and SHA-256 for each slide XML and slide relationship part;
5. perform no writes and expose no renderer output.

Use the existing `readRegularFileNoFollow()`, `validateProjectRoot()`, and project lock helpers instead of adding a second path-security implementation.

- [ ] **Step 5: Implement candidate creation and metadata-only adoption**

`createDeckCandidate()` writes one owned copy to `output/deck-revisions/<revisionId>/deck.pptx`, authenticates the copy, and writes `revision.json`. It never changes the current pointer.

`adoptDeckCandidate()` must:

```ts
const inspected = await inspectLocalPptx(candidate.absolutePath);
if (options.mode === "agent" && options.confirmedSha256 !== inspected.sha256) {
  throw new Error("agent confirmation does not bind the current candidate bytes");
}
if (options.mode === "manual" && options.userSignal !== "saved") {
  throw new Error("manual adoption requires the explicit saved signal");
}
await writeCurrentPointerOnly(root, {
  revisionId: candidate.revisionId,
  relativePath: candidate.relativePath,
  sha256: inspected.sha256,
});
```

The function must record adoption evidence in JSON and update project metadata, but it must not call `writeFile`, `copyFile`, `rename`, `createPresentation`, or any slide mutation function on `deck.pptx` after `inspectLocalPptx()` returns.

- [ ] **Step 6: Run schema, store, and type tests**

Run: `node --import tsx --test tests/deck-revisions.test.ts tests/project-state.test.ts && npm run lint:types`

Expected: PASS with byte-for-byte manual adoption and pointer-only rollback.

- [ ] **Step 7: Commit the revision ledger**

```bash
git add src/deck-revisions/schemas.ts src/deck-revisions/inspect.ts src/deck-revisions/store.ts src/project/schemas.ts tests/deck-revisions.test.ts tests/project-state.test.ts
git commit -m "feat: add local full-deck revision ledger"
```

---

### Task 2: Activate One Editable Slide Inside a Complete Candidate

**Files:**
- Create: `src/deck-revisions/activate-slide.ts`
- Create: `tests/full-deck-activation.test.ts`
- Modify: `src/deck/pptx.ts`
- Modify: `src/deck/editable-slide.ts`
- Modify: `src/editable/adapter.ts`

**Interfaces:**
- Produces `buildPrivateEditableDonor(options): Promise<Buffer>`.
- Produces `activateEditableSlideInDeck(options): Promise<ActivatedDeckResult>`.
- Consumes the authenticated converter manifest and assets for one stable slide ID.
- Consumes an owned complete candidate path from Task 1 and never returns a donor path to the CLI or Skill.

- [ ] **Step 1: Write failing full-deck activation tests**

```ts
test("activates only the selected slide and returns the complete deck candidate", async (t) => {
  const fixture = await threeSlideImageDeck(t);
  const before = await inspectLocalPptx(fixture.candidatePath);
  const result = await activateEditableSlideInDeck({
    projectRoot: fixture.root,
    candidatePath: fixture.candidatePath,
    slideIndex: 1,
    slideId: fixture.slideIds[1]!,
    conversionRoot: fixture.conversionRoot,
  });
  const after = await inspectLocalPptx(fixture.candidatePath);

  assert.equal(after.slideCount, 3);
  assert.equal(result.absolutePath, fixture.candidatePath);
  assert.deepEqual(result.editableSlideIds, [fixture.slideIds[1]!]);
  assert.equal(after.slideParts[0]!.xmlSha256, before.slideParts[0]!.xmlSha256);
  assert.equal(after.slideParts[2]!.xmlSha256, before.slideParts[2]!.xmlSha256);
  assert.notEqual(after.slideParts[1]!.xmlSha256, before.slideParts[1]!.xmlSha256);
  assert.ok(result.targetInspection.editableTextCount > 0);
  assert.equal("singleSlidePath" in result, false);
});
```

Add a second test that uses a deck previously saved by a WPS-like fixture and proves all non-target ZIP members under `ppt/slides/`, `ppt/notesSlides/`, and `ppt/comments/` retain their hashes.

- [ ] **Step 2: Run the activation test and verify failure**

Run: `node --import tsx --test tests/full-deck-activation.test.ts`

Expected: FAIL because `activateEditableSlideInDeck()` is missing.

- [ ] **Step 3: Expose private donor generation**

Refactor the existing editable-page branch in `src/deck/pptx.ts` into:

```ts
export async function buildPrivateEditableDonor(
  page: PptxEditablePage,
  privateStagingRoot: string,
): Promise<Buffer>;
```

The function creates a one-slide PPTX only under an owned `.staging-*` directory, returns bytes, and deletes staging in `finally`. Do not return or persist the donor path. Initial complete-deck generation continues to use `createPresentation()`.

- [ ] **Step 4: Implement target-slide shape-tree transplantation**

`activateEditableSlideInDeck()` must operate on a temporary copy and atomically replace the candidate only after validation:

1. load the complete candidate and donor with JSZip;
2. resolve the target slide part from `ppt/presentation.xml` and its relationships by slide order;
3. extract the donor `<p:spTree>...</p:spTree>`;
4. allocate collision-free relationship IDs for donor images;
5. copy donor image bytes to unique `ppt/media/superppt-<uuid>.png` paths;
6. rewrite the transplanted shape tree's `r:embed` values to the new IDs;
7. retain the target slide's existing layout, notes, comments, transition, timing, and non-shape XML;
8. replace only the target `<p:spTree>` and append only the new image relationships;
9. inspect the staged complete deck, require the same slide count, require editable text or asset objects on the target, and compare untouched slide-part hashes;
10. atomically replace the pre-open candidate once, then update candidate metadata with the new prepared hash and editable slide ID.

Leaving now-unreferenced target-slide media in the package is acceptable; deleting shared media is forbidden because it could affect other slides.

- [ ] **Step 5: Add corruption and identity tests**

Test and reject:

- a donor with external relationships;
- a target index outside the deck;
- a candidate whose slide count changes during staging;
- a donor whose page size is not 16:9;
- a converter output that lacks authenticated clean background or manifest hashes;
- any attempted output path outside `output/deck-revisions/<revisionId>/deck.pptx`.

- [ ] **Step 6: Run activation, editable, and type tests**

Run: `node --import tsx --test tests/full-deck-activation.test.ts tests/editable.test.ts && npm run lint:types`

Expected: PASS; only the target slide changes and no user-visible single-page artifact exists.

- [ ] **Step 7: Commit full-deck activation**

```bash
git add src/deck-revisions/activate-slide.ts src/deck/pptx.ts src/deck/editable-slide.ts src/editable/adapter.ts tests/full-deck-activation.test.ts tests/editable.test.ts
git commit -m "feat: activate editable pages inside full decks"
```

---

### Task 3: Implement Manual-Save and Agent-Confirmation Workflows

**Files:**
- Create: `src/deck-revisions/workflow.ts`
- Create: `tests/full-deck-editing.test.ts`
- Modify: `src/editable/operations.ts`
- Modify: `src/editable/schemas.ts`
- Modify: `src/project/store.ts`

**Interfaces:**
- Produces `prepareManualEditDeck(options): Promise<PreparedDeckEdit>`.
- Produces `adoptManualSavedDeck(options): Promise<ResolvedCurrentDeckPointer>`.
- Produces `beginAgentCandidateConfirmation(options): Promise<PreparedDeckEdit>`.
- Produces `confirmAgentEditDeck(options): Promise<ResolvedCurrentDeckPointer>`.
- Produces `rejectDeckEdit(options): Promise<void>`.
- Consumes Task 1 candidate/store APIs and Task 2 slide activation.

- [ ] **Step 1: Write failing workflow tests**

```ts
test("manual flow exposes only a complete deck and saved means exact-file adoption", async (t) => {
  const fixture = await generatedProject(t);
  const prepared = await prepareManualEditDeck({
    root: fixture.root,
    slideId: fixture.slideIds[1]!,
  });
  assert.equal(prepared.slideCount, fixture.slideIds.length);
  assert.equal(prepared.localLink, prepared.absolutePath);
  assert.equal(prepared.mode, "manual");

  const saved = await simulateWpsSave(prepared.absolutePath);
  const adopted = await adoptManualSavedDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    userSignal: "saved",
  });
  assert.deepEqual(await readFile(prepared.absolutePath), saved);
  assert.equal(adopted.absolutePath, prepared.absolutePath);
});

test("agent candidate is not current until its exact hash is confirmed", async (t) => {
  const fixture = await editableProject(t);
  const before = await readCurrentDeckPointer(fixture.root);
  const candidate = await createDeckCandidate(fixture.root, {
    sourceRevisionId: before.revisionId,
    reason: "agent-edit",
    changedSlideIds: [fixture.slideIds[1]!],
    editableSlideIds: [fixture.slideIds[1]!],
  });
  await simulateAgentXmlEdit(candidate.absolutePath, fixture.slideIds[1]!);
  const prepared = await beginAgentCandidateConfirmation({
    root: fixture.root,
    candidateRevisionId: candidate.revisionId,
    slideId: fixture.slideIds[1]!,
  });
  assert.deepEqual(await readCurrentDeckPointer(fixture.root), before);
  await assert.rejects(confirmAgentEditDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    confirmedSha256: "0".repeat(64),
  }), /exact candidate/);
  const adopted = await confirmAgentEditDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    confirmedSha256: prepared.sha256,
  });
  assert.equal(adopted.revisionId, prepared.revisionId);
});
```

- [ ] **Step 2: Run the workflow tests and verify failure**

Run: `node --import tsx --test tests/full-deck-editing.test.ts`

Expected: FAIL because `src/deck-revisions/workflow.ts` is missing.

- [ ] **Step 3: Implement the manual workflow**

`prepareManualEditDeck()` must:

1. reject when another edit session is active;
2. read the current complete deck pointer;
3. create a full candidate from that exact file;
4. activate only the requested slide when it is not already listed in `editableSlideIds`;
5. inspect the resulting full deck;
6. persist an `external-editing` session;
7. return the absolute candidate path as `localLink`.

`adoptManualSavedDeck()` accepts only the exact active session plus `userSignal: "saved"`. It performs a stable read and structure validation, then calls Task 1's metadata-only adoption. It must not compare or repair slide content after the user saves; the user may intentionally have edited, reordered, or removed more than one slide.

- [ ] **Step 4: Implement the Agent confirmation lifecycle**

`beginAgentCandidateConfirmation()` accepts an already prepared and inspected complete candidate from Task 4, records `awaiting-confirmation`, and returns its complete local path and exact presented hash. It does not change the current pointer.

`confirmAgentEditDeck()` re-reads the candidate, requires its hash to equal both the presented hash and `confirmedSha256`, and performs metadata-only adoption. `rejectDeckEdit()` marks the session rejected and leaves the prior current pointer unchanged.

- [ ] **Step 5: Serialize external editing**

Add tests proving:

- a second page edit cannot start while one session is `external-editing`;
- Agent operations cannot target the open candidate;
- `已保存` on a stale session is rejected;
- after manual adoption, a new edit starts from the exact saved complete deck;
- after Agent confirmation, the next edit starts from the exact confirmed complete deck.

- [ ] **Step 6: Run workflow, revisions, and type tests**

Run: `node --import tsx --test tests/full-deck-editing.test.ts tests/deck-revisions.test.ts tests/revisions.test.ts && npm run lint:types`

Expected: PASS with serialized edits and no PPTX write after manual save.

- [ ] **Step 7: Commit the workflows**

```bash
git add src/deck-revisions/workflow.ts src/editable/operations.ts src/editable/schemas.ts src/project/store.ts tests/full-deck-editing.test.ts tests/deck-revisions.test.ts tests/revisions.test.ts
git commit -m "feat: adopt complete deck edits by pointer"
```

---

### Task 4: Route Direct Edits, Editable Activation, and Slide Regeneration

**Files:**
- Create: `src/deck-revisions/edit-slide.ts`
- Create: `src/editable/route.ts`
- Modify: `src/editable/operations.ts`
- Modify: `src/editable/adapter.ts`
- Modify: `src/generation/jobs.ts`
- Modify: `src/generation/job-schemas.ts`
- Modify: `src/generation/batch.ts`
- Modify: `tests/editable.test.ts`
- Modify: `tests/generation.test.ts`

**Interfaces:**
- Produces `DeckEditRouteSchema` and `classifyDeckEdit(request, context): DeckEditRoute`.
- Produces `editActualSlideObjects(options): Promise<EditedDeckResult>` and `prepareAgentEditDeck(options): Promise<PreparedDeckEdit>`.
- Produces routes `direct-edit`, `activate-editable`, and `regenerate-slide`.
- Consumes the current deck revision's `editableSlideIds`, authenticated editable manifest, page description, and approved Style Lock.
- Produces one complete Agent candidate or one complete manual candidate; it never produces a user-facing page artifact.

- [ ] **Step 1: Write failing least-destructive routing tests**

```ts
test("routes with direct edit before activation before regeneration", () => {
  assert.equal(classifyDeckEdit(textRequest, editableContext).route, "direct-edit");
  assert.equal(classifyDeckEdit(textRequest, imageOnlyContext).route, "activate-editable");
  assert.equal(classifyDeckEdit(redesignRequest, editableContext).route, "regenerate-slide");
});

test("regeneration keeps the approved style lock", async () => {
  const route = classifyDeckEdit(redesignRequest, editableContext);
  const job = await prepareRegeneratedSlideJob(route, approvedStyleFixture);
  assert.equal(job.pages.length, 1);
  assert.equal(job.pages[0]!.slideId, editableContext.slideId);
  assert.equal(job.styleLockSha256, approvedStyleFixture.sha256);
});
```

- [ ] **Step 2: Run routing tests and verify failure**

Run: `node --import tsx --test tests/editable.test.ts tests/generation.test.ts`

Expected: FAIL because the full-deck route contract is not implemented.

- [ ] **Step 3: Implement the route contract**

```ts
export const DeckEditRouteSchema = z.discriminatedUnion("route", [
  z.object({
    route: z.literal("direct-edit"),
    slideId: z.string().uuid(),
    operations: z.array(EditOperationSchema).min(1),
  }).strict(),
  z.object({
    route: z.literal("activate-editable"),
    slideId: z.string().uuid(),
    operations: z.array(EditOperationSchema),
  }).strict(),
  z.object({
    route: z.literal("regenerate-slide"),
    slideId: z.string().uuid(),
    reason: z.string().min(1),
    styleLockSha256: Sha256Schema,
  }).strict(),
]);
```

Text, number, supported style, or reliable asset changes use `direct-edit` when the page is already editable and `activate-editable` otherwise. Layout, background, illustration, material, or composition changes use `regenerate-slide`. Unsupported extracted objects must never be reported as directly editable.

For `direct-edit`, `src/deck-revisions/edit-slide.ts` must inspect the actual target slide in the newly copied complete candidate. Resolve objects by the stable names created during editable activation (`text-<element-id>` and `asset-<element-id>`) and confirm the current object type before patching. Change only the requested text or supported properties in that object's current OOXML. Historical conversion manifests may supply identity hints, but they must never be rendered back over a page that the user previously saved.

Add a regression fixture where the user first changes title alignment in WPS, then the Agent changes only the title text in the next candidate. The Agent candidate must retain the user's alignment, geometry, all unrelated objects, and every non-target slide part.

`prepareAgentEditDeck()` must always create a complete candidate first. It then runs `editActualSlideObjects()` for `direct-edit`, Task 2 activation plus pre-open manifest operations for `activate-editable`, or Step 4's one-page image replacement for `regenerate-slide`. After inspection it calls Task 3's `beginAgentCandidateConfirmation()` and returns one complete local PPTX link.

- [ ] **Step 4: Bind regeneration to the current full deck**

The regeneration job contains one page and the approved Style Lock. When `ai-image-to-ppt` returns a successful normalized page image, replace only the target slide's shape tree inside a newly created complete candidate. Remove the target slide ID from that candidate's `editableSlideIds`; a later edit can activate the regenerated page again.

Never call initial full-deck `createPresentation()` for a slide-regeneration edit, and never regenerate already successful untouched pages.

- [ ] **Step 5: Add user-override and truthful-limit tests**

Verify:

- `不要转可编辑，直接重做这一页` forces `regenerate-slide`;
- `我自己改` chooses manual mode without changing the technical route;
- `帮我改` chooses Agent mode;
- missing editable targets switch to regeneration or report a real limitation;
- all route results name one stable slide ID and one current deck revision.

- [ ] **Step 6: Run editable, generation, and type tests**

Run: `node --import tsx --test tests/editable.test.ts tests/generation.test.ts tests/full-deck-editing.test.ts && npm run lint:types`

Expected: PASS with one-page generation jobs and full-deck candidate outputs.

- [ ] **Step 7: Commit edit routing**

```bash
git add src/deck-revisions/edit-slide.ts src/editable/route.ts src/editable/operations.ts src/editable/adapter.ts src/generation/jobs.ts src/generation/job-schemas.ts src/generation/batch.ts tests/editable.test.ts tests/generation.test.ts tests/full-deck-editing.test.ts
git commit -m "feat: route edits into complete deck candidates"
```

---

### Task 5: Replace Preview-Centered Gates and CLI Commands

**Files:**
- Modify: `src/acceptance/schema.ts`
- Modify: `src/acceptance/build.ts`
- Modify: `src/acceptance/current.ts`
- Modify: `src/project/schemas.ts`
- Modify: `src/project/promotion.ts`
- Modify: `src/cli.ts`
- Modify: `tests/publication.test.ts`
- Modify: `tests/project-state.test.ts`
- Modify: `tests/cli-approval.test.ts`
- Modify: `tests/workflow-contract.test.ts`

**Interfaces:**
- Produces a deck-review gate bound to `revisionId + absolutePath + sha256` for one complete local PPTX.
- Produces CLI commands `current-deck-link`, `prepare-manual-deck`, `adopt-saved-deck`, `prepare-agent-deck`, `confirm-agent-deck`, `reject-deck-candidate`, and `rollback-deck`.
- Removes `render-editable`, `confirm-preview`, `replace-slide`, image-review adapter, and derived-export commands.

- [ ] **Step 1: Write failing CLI contract tests**

```ts
test("manual edit commands return a complete local pptx and saved adoption", async (t) => {
  const project = await cliProject(t);
  const prepared = await runCliJson([
    "prepare-manual-deck", "--project", project.root, "--slide-id", project.slideIds[1]!,
  ]);
  assert.equal(prepared.kind, "complete-local-pptx");
  assert.equal(prepared.slideCount, project.slideIds.length);
  assert.match(prepared.absolutePath, /output\/deck-revisions\/.+\/deck\.pptx$/);

  const adopted = await runCliJson([
    "adopt-saved-deck", "--project", project.root,
    "--session-id", prepared.sessionId, "--user-signal", "saved",
  ]);
  assert.equal(adopted.currentRevisionId, prepared.revisionId);
});

test("removed preview commands fail with the complete-deck replacement", async () => {
  for (const command of ["render-editable", "confirm-preview", "replace-slide", "export-review-derived"]) {
    const result = await runCliFailure([command]);
    assert.match(result.stderr, /complete deck|current-deck-link|prepare-manual-deck/i);
  }
});
```

- [ ] **Step 2: Run CLI and workflow tests and verify old behavior fails**

Run: `node --import tsx --test tests/cli-approval.test.ts tests/workflow-contract.test.ts tests/publication.test.ts`

Expected: FAIL because CLI and gates still bind montage and slide-preview evidence.

- [ ] **Step 3: Replace deck-review and edit-session evidence**

Remove `presentedMontageSha256`, preview paths, and adapter IDs. Deck review actions bind:

```ts
{
  action: "edit-page" | "return-upstream" | "confirm-delivery";
  revisionId: string;
  deckSha256: string;
  slideId?: string;
}
```

Manual `已保存` is itself the adoption action after read-only validation. Agent candidates require a separate `confirm-agent-deck` action bound to the candidate hash. Neither action triggers assembly.

- [ ] **Step 4: Implement the complete-deck CLI surface**

Each preparation command prints:

```json
{
  "kind": "complete-local-pptx",
  "mode": "manual|agent",
  "revisionId": "<uuid>",
  "sessionId": "<uuid>",
  "targetSlideId": "<uuid>",
  "absolutePath": "/absolute/project/output/deck-revisions/<uuid>/deck.pptx",
  "sha256": "<64-hex>",
  "slideCount": 12,
  "nextRequiredAction": "open this complete PPTX in WPS or PowerPoint"
}
```

`current-deck-link` returns the same shape without a session. The CLI must not emit a single-page PPT path, PNG path, PDF path, montage path, browser URL, or cloud-upload instruction.

- [ ] **Step 5: Preserve conversational wait points**

Update workflow tests so the Skill must:

- ask `需要我帮你修改，还是由你手动修改？` only when the user's request did not already choose a mode;
- explain the chosen direct/activate/regenerate route in one sentence;
- stop after presenting the complete local link;
- wait for `已保存` on manual sessions;
- wait for `确认` on Agent sessions;
- allow `修改大纲`, `修改第 N 页描述`, and `换风格` to return to upstream gates with impact disclosure.

- [ ] **Step 6: Run CLI, state, publication, and type tests**

Run: `node --import tsx --test tests/cli-approval.test.ts tests/workflow-contract.test.ts tests/publication.test.ts tests/project-state.test.ts && npm run lint:types`

Expected: PASS with local complete-deck links and no preview-bound action.

- [ ] **Step 7: Commit CLI and gate migration**

```bash
git add src/acceptance/schema.ts src/acceptance/build.ts src/acceptance/current.ts src/project/schemas.ts src/project/promotion.ts src/cli.ts tests/publication.test.ts tests/project-state.test.ts tests/cli-approval.test.ts tests/workflow-contract.test.ts
git commit -m "feat: replace preview gates with local deck links"
```

---

### Task 6: Remove Rendering, Viewer, WPS Export, and Post-Save Rewrite Paths

**Files:**
- Delete: `src/deck/pdf.ts`
- Delete: `src/deck/montage.ts`
- Delete: `src/deck/wps-export.ts`
- Delete: `src/editable/preview-image.ts`
- Modify or delete after callers migrate: `src/editable/render.ts`
- Modify: `src/deck/assemble.ts`
- Modify: `src/editable/import-edit.ts`
- Modify: `src/dependencies/schemas.ts`
- Modify: `src/dependencies/resolve.ts`
- Modify: `src/dependencies/preflight.ts`
- Modify: `references/dependencies.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/deck.test.ts`
- Modify: `tests/editable.test.ts`
- Modify: `tests/import-edit.test.ts`
- Modify: `tests/generation.test.ts`
- Modify: `tests/mixed-deck.test.ts`
- Delete: `tests/wps-export.test.ts`

**Interfaces:**
- `assembleProjectCandidate()` produces one complete PPTX plus structural acceptance evidence.
- Adoption reads and hashes an existing complete PPTX; it has no render or rebuild callback.
- Runtime dependency preflight requires `ai-image-to-ppt` and `image-to-editable-pptx`, not WPSComposer.

- [ ] **Step 1: Add failing negative-contract tests**

```ts
test("candidate assembly emits no render-derived review artifacts", async (t) => {
  const candidate = await assembleFixtureProject(t);
  assert.deepEqual(Object.keys(candidate.artifacts).sort(), ["acceptance", "pptx"]);
  assert.equal(await pathExists(join(candidate.root, "deck.pdf")), false);
  assert.equal(await pathExists(join(candidate.root, "montage.jpg")), false);
  assert.equal(await pathExists(join(candidate.root, "slides")), false);
});

test("manual adoption invokes no output writer", async (t) => {
  const fixture = await preparedManualCandidate(t);
  const beforeBytes = await readFile(fixture.absolutePath);
  const beforeStat = await stat(fixture.absolutePath);
  await adoptManualSavedDeck({
    root: fixture.root,
    sessionId: fixture.sessionId,
    userSignal: "saved",
  });
  const afterStat = await stat(fixture.absolutePath);
  assert.deepEqual(await readFile(fixture.absolutePath), beforeBytes);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.size, beforeStat.size);
});
```

- [ ] **Step 2: Run deck and editable tests and verify the old PDF/montage path fails**

Run: `node --import tsx --test tests/deck.test.ts tests/editable.test.ts tests/import-edit.test.ts tests/mixed-deck.test.ts`

Expected: FAIL because current assembly still requires PDF/montage and adopted edits still render previews.

- [ ] **Step 3: Remove derived output production**

Delete PDF, montage, WPS slide-image export, `pdftoppm`, editable preview, `verifyFlatArtifacts`, and preview-bound schemas. Change output contracts from:

```ts
{ pptx: Artifact; pdf: Artifact; montage: Artifact; acceptance: Artifact }
```

to:

```ts
{ pptx: Artifact; acceptance: Artifact }
```

Remove `pdf-lib` from `package.json` and regenerate `package-lock.json` with `npm install --package-lock-only`. Keep `sharp` because source-image normalization, editable conversion, and generation QA still use it.

- [ ] **Step 4: Remove WPSComposer from the main dependency contract**

Delete WPS preview/export capability schemas and preflight branches. `references/dependencies.json` must list only the two required skill dependencies for this workflow. Do not add a hidden optional preview fallback.

- [ ] **Step 5: Delete post-save reconstruction**

Remove calls and exports for:

- `renderAdoptedPptxViaWps()`;
- `renderProjectEditablePreview()`;
- `renderEditablePage()` after Agent edits have moved to pre-open donor generation;
- manifest-driven `replace-slide` after manual save;
- any code that copies an adopted PPTX into a new assembled deck.

Keep converter validation and pre-open Agent operations. Rename remaining helpers so no function called `render*` is used during adoption.

- [ ] **Step 6: Run removal, package, and type tests**

Run: `node --import tsx --test tests/deck.test.ts tests/editable.test.ts tests/import-edit.test.ts tests/generation.test.ts tests/mixed-deck.test.ts tests/plugin-package.test.ts && npm run lint:types`

Expected: PASS with no `pdf-lib`, WPSComposer preview dependency, PDF, montage, PNG review, or post-save PPTX writer.

- [ ] **Step 7: Commit removal of obsolete paths**

```bash
git add src/deck/assemble.ts src/deck/pdf.ts src/deck/montage.ts src/editable/render.ts src/editable/import-edit.ts src/dependencies/schemas.ts src/dependencies/resolve.ts src/dependencies/preflight.ts references/dependencies.json package.json package-lock.json tests/deck.test.ts tests/editable.test.ts tests/import-edit.test.ts tests/generation.test.ts tests/mixed-deck.test.ts tests/plugin-package.test.ts
git commit -m "refactor: remove rendered review and post-save rewrite paths"
```

`src/deck/wps-export.ts`, `src/editable/preview-image.ts`, and `tests/wps-export.test.ts` are currently untracked work-in-progress files. Remove them from the working tree during this task and confirm with `git status --short` that they are absent; do not try to stage nonexistent untracked paths.

---

### Task 7: Update the Skill Contract and Run End-to-End Acceptance

**Files:**
- Modify: `skills/superppt/SKILL.md`
- Modify: `skills/superppt/references/阶段契约.json`
- Modify: `skills/superppt/references/门禁清单.md`
- Modify: `skills/superppt/references/修改路由.md`
- Modify: `skills/superppt/references/工作区契约.md`
- Modify: `README.md`
- Modify: `tests/e2e.test.ts`
- Modify: `tests/workflow-contract.test.ts`
- Modify: `tests/plugin-package.test.ts`

**Interfaces:**
- Consumes all completed tasks.
- Produces one guided creation path, one manual complete-deck edit loop, one Agent complete-deck edit loop, and one rollback path.

- [ ] **Step 1: Write the complete workflow contract before changing instructions**

The Skill must express this exact manual sequence:

```text
user requests page N edit
-> resolve stable slide ID and current complete deck revision
-> explain route and ask manual-or-Agent only if absent
-> create complete candidate from current complete deck
-> activate page N inside the candidate when required
-> provide one complete local PPTX link
-> stop and wait
-> user says 已保存
-> stable read and structure validation only
-> move current pointer to the exact same file
-> offer another page edit or final delivery
```

The Agent sequence differs only after candidate preparation:

```text
Agent modifies target page in the complete candidate
-> provide one complete local PPTX link and concise change summary
-> stop and wait
-> user says 确认
-> authenticate exact presented hash
-> move current pointer
```

- [ ] **Step 2: Add end-to-end tests for consecutive pages**

The fixture must:

1. generate and adopt a three-slide initial deck;
2. prepare slide 2 for manual editing inside the complete deck;
3. simulate a WPS save and adopt exact bytes;
4. prepare slide 3 from those exact saved bytes;
5. assert slide 2's saved XML is present unchanged in the slide-3 candidate;
6. apply an Agent text edit to slide 3;
7. assert current still points to the manual revision until confirmation;
8. confirm the Agent candidate and assert rollback restores the manual revision without rewriting either file.

- [ ] **Step 3: Update user-facing instructions**

Remove all language about:

- opening a one-page editable PPT;
- replacing a saved page back into a deck;
- rendering the edited page back to PNG;
- Codex Viewer, ReviewAdapter, Web Office, WPS image fallback, PDF, montage, or cloud upload;
- WPSComposer as a review dependency.

Every editing response must provide the complete local PPTX path, say that WPS/PowerPoint is the preview and editing interface, and wait for the correct manual or Agent signal.

- [ ] **Step 4: Run the complete source suite**

Run: `npm test`

Expected: all source tests pass with zero failures.

- [ ] **Step 5: Run type checking, build, and compiled tests**

Run: `npm run lint:types && npm run build && npm run test:compiled`

Expected: all commands succeed with zero failures.

- [ ] **Step 6: Run package validation**

Run: `npm pack --dry-run --json`

Expected: package contains the two required skill contracts and full-deck revision modules, and contains no generated PPTX, user-edited files, single-page donors, previews, PDFs, montages, or temporary staging directories.

- [ ] **Step 7: Perform real WPS manual-edit acceptance**

Using a fresh controlled project:

1. generate a complete candidate and record its revision ID, absolute path, SHA-256, slide count, and untouched-slide part hashes;
2. prepare slide 2 as editable and verify the returned link opens the complete deck in WPS;
3. edit one title alignment or text value on slide 2, save in place, and close WPS;
4. record the exact saved file SHA-256;
5. invoke manual adoption and verify the file SHA-256 is unchanged after adoption;
6. reopen that exact file in WPS and verify the user edit remains exactly as saved;
7. request slide 3 editing and verify the new complete candidate contains the saved slide-2 change;
8. confirm no PDF, montage, preview image, single-page user artifact, or post-save deck copy was created.

- [ ] **Step 8: Perform real Agent-edit acceptance**

From the adopted manual revision, ask the Agent to change a supported slide-3 text object. Verify the current pointer remains on the manual revision before confirmation, open the complete Agent candidate in WPS, confirm it, and verify the confirmed complete file becomes current without any further PPTX write.

- [ ] **Step 9: Commit instructions and E2E coverage**

```bash
git add skills/superppt/SKILL.md skills/superppt/references/阶段契约.json skills/superppt/references/门禁清单.md skills/superppt/references/修改路由.md skills/superppt/references/工作区契约.md README.md tests/e2e.test.ts tests/workflow-contract.test.ts tests/plugin-package.test.ts
git commit -m "docs: guide complete deck editing loops"
```

- [ ] **Step 10: Report implementation and real acceptance separately**

The final handoff must report:

```text
source tests: pass/fail count
compiled tests: pass/fail count
package validation: passed/failed
manual complete-deck edit: passed/pending with exact before-save, saved, and post-adoption hashes
next-page continuity: passed/pending with the prior saved slide preserved
Agent complete-deck edit: passed/pending with pre-confirm and post-confirm pointers
post-save PPTX writes: zero/nonzero
single-page user artifacts: zero/nonzero
PDF/montage/preview artifacts: zero/nonzero
```

Do not claim real WPS acceptance when only fixtures ran.
