# Local Full-Deck Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one local, complete PPTX revision the only SuperPPT review and editing artifact, activate or modify only the requested slide inside a full-deck candidate, and adopt user-saved bytes without any post-save rewrite or reassembly.

**Architecture:** Replace viewer adapters and page-preview confirmation with an owned local edit-session journal, immutable deck revisions, and one atomically replaced current pointer. Every edit starts by copying the current complete PPTX into a session candidate; editable activation transplants the authenticated official `slide-editable.pptx` produced by `image-to-editable-pptx`, while Agent operations patch actual named OOXML objects. Manual adoption requires the user to save and close the editor, then performs stable read and topology reconciliation without writing the PPTX; Agent edits require confirmation of the exact candidate hash before the same metadata-only adoption transaction.

**Tech Stack:** TypeScript 5.9, Node.js >=22.6, Zod 4, JSZip and `saxes` as runtime dependencies, narrowly scoped namespace-aware OOXML range patching, `@oai/artifact-tool` through the bundled runtime, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-superppt-design.md`

## Global Constraints

- Preserve the guided confirmation flow: outline, slide specifications, style sample, generation authorization, and complete-deck review remain human wait points.
- The runtime must have local filesystem access and must produce an absolute, clickable path to a writable `.pptx`; there is no cloud, upload, browser viewer, image-preview, or download fallback.
- The user only receives links to complete PPTX files. A one-slide PPTX may exist inside private staging only and must never be published as a user artifact.
- Every edit candidate starts from the exact current complete PPTX, never from regenerated page manifests or an older image ledger.
- After stable identities exist, only the requested slide may be changed while preparing a candidate. Untouched slide XML and relationship parts must retain their pre-edit hashes. Initial assembly and an explicit one-time pre-open legacy identity migration are the only metadata-only exceptions; both must rebaseline hashes before the user receives a link.
- Manual editing may reorder, insert, or delete slides in WPS/PowerPoint. Adoption must reconcile the saved presentation order to persistent stable slide IDs, record deleted and newly unmanaged slides, and reject duplicate or ambiguous IDs without writing the PPTX.
- Manual editing means: prepare complete candidate, open in WPS/PowerPoint, save in place, close the editor, receive the user's explicit `已保存并关闭`, perform stable read, structure validation, and read-only topology reconciliation, then atomically move the current-revision pointer. No copy, render, slide replacement, assembly, centering, style normalization, identity injection, or other PPTX write is allowed after the user saves.
- Agent editing means: prepare and modify a complete candidate, provide its local link, and move the pointer only after the user confirms the candidate's exact SHA-256.
- An externally opened candidate is serialized. SuperPPT must not write it until the user reports it saved and closed and the file passes the stable-read check.
- Preserve old complete PPTX revisions so `恢复上一版` changes only the current pointer.
- Revision records are immutable. Candidate lifecycle lives in an edit-session journal; `current` and `superseded` are derived from one atomically replaced `output/current.json`, never written back into historical revision records.
- Keep `ai-image-to-ppt` and `image-to-editable-pptx` as separate versioned skills. `ai-image-to-ppt` must publish and SuperPPT must validate `references/capabilities.json`. `image-to-editable-pptx` must satisfy `>=0.2.0 <0.3.0`, `manifestVersion: 2`, and official `slide-editable.pptx` output. SuperPPT owns orchestration, authenticated full-deck package operations, and revision state only.
- SuperPPT must preserve converter v2 text, simple shapes, assets, `role`, `groupId`, `provenance`, `relations`, and `reviewRequired`. It must not rebuild a donor PPTX from the manifest.
- OOXML changes are narrowly scoped byte/text patches to known slide and relationship elements. Preserve unknown namespace declarations and extension lists; reject external donor relationships, unsupported active content, duplicate object names, and ambiguous page identities instead of whole-document parse/reserialize.
- Move `jszip` from `devDependencies` to runtime `dependencies` and add `saxes` as a parser-only runtime dependency; do not add a generic XML serializer that rewrites the complete package.
- Every CLI/Skill file handoff must format one absolute clickable Markdown link. Paths containing spaces or Chinese characters use an angle-bracket Markdown target; fail in preflight if the host cannot expose local file links.
- WPSComposer is not part of review, preview, adoption, or the primary editing path.
- Node engine floor remains `>=22.6`.
- The existing `/Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-v1` worktree contains overlapping in-progress changes. Preserve it untouched and execute this plan in a new clean worktree created from the documentation-only descendant of `4e2c1cd` that contains this confirmed spec and both plans; do not implement this plan on the dirty worktree or selectively stage overlapping files there.

---

## File Structure

- Create `src/deck-revisions/schemas.ts`: immutable complete-deck revision, mutable edit-session journal, adoption, topology, and current-pointer schemas.
- Create `src/deck-revisions/inspect.ts`: safe regular-file checks, stable reads, PPTX package validation, slide-part hashing, persistent identity extraction, and editable-object inspection.
- Create `src/deck-revisions/identity.ts`: publish initial/pre-open stable slide identity metadata and never run after manual save.
- Create `src/deck-revisions/topology.ts`: reconcile saved presentation order, moved/deleted/new pages, and blocking identity conflicts without writing PPTX bytes.
- Create `src/deck-revisions/ooxml.ts`: narrowly scoped namespace-aware extraction and relationship rewriting that preserves unknown XML outside the selected elements.
- Create `src/deck-revisions/store.ts`: candidate creation, journaled adoption transaction, immutable revision publication, atomic current-pointer movement, rejection, crash recovery, and rollback without rewriting PPTX bytes.
- Create `src/deck-revisions/activate-slide.ts`: authenticate and transplant the official converter-produced `slide-editable.pptx` into the corresponding slide of a complete candidate.
- Create `src/deck-revisions/edit-slide.ts`: resolve and patch named objects in the actual current target-slide XML without rebuilding a user-saved page from an old manifest.
- Create `src/deck-revisions/workflow.ts`: manual-edit and Agent-edit orchestration over complete candidates.
- Create `src/editable/route.ts`: least-destructive `direct-edit -> activate-editable -> regenerate-slide` routing.
- Create `src/host/capabilities.ts`: require explicit host-local filesystem and clickable-link support before local deck handoff.
- Modify `src/deck/assemble.ts`: initial assembly publishes a complete local deck revision and no PDF/montage/preview artifacts.
- Modify `src/editable/operations.ts`, `src/editable/adapter.ts`, and `src/editable/schemas.ts`: accept manifest v2 and the official donor, preserve shapes/provenance/relations/review flags, and feed Agent operations into full-deck candidate preparation.
- Modify `src/project/schemas.ts`, `src/project/store.ts`, and `src/project/promotion.ts`: persist current deck pointer and edit-session state; remove montage and slide-preview authority.
- Modify `src/acceptance/schema.ts`, `src/acceptance/build.ts`, and `src/acceptance/current.ts`: bind delivery to the exact current complete PPTX revision.
- Modify `src/cli.ts`: expose complete-deck link, prepare/adopt manual edit, prepare/confirm/reject Agent edit, and rollback commands.
- Delete `src/deck/pdf.ts`, `src/deck/montage.ts`, `src/editable/preview-image.ts`, and the post-save preview/rebuild portions of `src/editable/render.ts`.
- Modify `src/dependencies/schemas.ts`, `src/dependencies/resolve.ts`, `src/dependencies/preflight.ts`, and `references/dependencies.json`: remove WPSComposer review/export requirements.
- Modify `package.json` and `package-lock.json`: remove `pdf-lib` after PDF generation is deleted, move `jszip` into runtime dependencies, and add parser-only `saxes`.
- Modify `skills/superppt/SKILL.md`, `skills/superppt/references/阶段契约.json`, `skills/superppt/references/门禁清单.md`, `skills/superppt/references/修改路由.md`, `skills/superppt/references/工作区契约.md`, and `README.md`: describe the local full-deck conversational flow.
- Create `tests/deck-revisions.test.ts`, `tests/deck-topology.test.ts`, `tests/full-deck-activation.test.ts`, and `tests/full-deck-editing.test.ts`.
- Create `tests/cli-approval.test.ts`; modify `tests/deck.test.ts`, `tests/editable.test.ts`, `tests/generation.test.ts`, `tests/mixed-deck.test.ts`, `tests/project-state.test.ts`, `tests/publication.test.ts`, `tests/workflow-contract.test.ts`, `tests/e2e.test.ts`, and `tests/plugin-package.test.ts`.

---

### Task 0: Establish a Clean, Contract-Ready Implementation Baseline

**Files:**
- Preserve without modification: `/Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-v1`
- Create worktree: `/Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-local-full-deck`
- Consume companion plan: `docs/superpowers/plans/2026-08-30-ai-image-to-ppt-capability-manifest.md`

**Interfaces:**
- Produces a clean implementation branch `codex/superppt-local-full-deck` whose base contains the confirmed design and both plans.
- Produces a recorded source-test/type-check baseline before feature edits.
- Consumes a released or locally installed `ai-image-to-ppt` capability manifest that passes its own validator.

- [ ] **Step 1: Prove the existing worktree remains preserved**

Run in `/Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-v1`:

```bash
git status --short
git rev-parse HEAD
```

Expected: the overlapping tracked and untracked WIP files are still present. Do not reset, clean, stash, switch branches, or delete files in this worktree.

- [ ] **Step 2: Create the clean implementation worktree**

From the SuperPPT repository, after this confirmed design/plan revision is committed:

```bash
SUPERPPT_DESIGN_BASE=$(git -C /Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-v1 rev-parse HEAD)
git worktree add /Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-local-full-deck -b codex/superppt-local-full-deck "$SUPERPPT_DESIGN_BASE"
```

Expected: `git -C /Users/neomei/项目/codexprojects/SuperPPT/.worktrees/superppt-local-full-deck status --short` prints nothing, and both revised plan documents are present.

- [ ] **Step 3: Capture a fresh clean baseline**

Run in the new worktree:

```bash
npm ci
npm run lint:types
npm test
```

Expected: type checking and the complete source suite exit with status 0. If either fails, stop feature work and fix or explicitly baseline the pre-existing failure in a separate commit; never treat failures observed in the old dirty worktree as the clean baseline.

- [ ] **Step 4: Complete the lower-skill capability prerequisite**

Execute `docs/superpowers/plans/2026-08-30-ai-image-to-ppt-capability-manifest.md`, install its validated result into the Agent skill location, and run its manifest validator. Do not start SuperPPT dependency integration while `references/capabilities.json` is absent or invalid.

- [ ] **Step 5: Record the baseline without touching product code**

Save the exact clean base commit, Node version, npm version, source test count, type-check result, installed `ai-image-to-ppt` capability schema/sub-contract versions and manifest hash, and installed `image-to-editable-pptx` version in the implementation session notes. This step creates no SuperPPT source commit.

---

### Task 1: Define Immutable Revisions, Edit Sessions, and Slide Topology

**Files:**
- Create: `src/deck-revisions/schemas.ts`
- Create: `src/deck-revisions/ooxml.ts`
- Create: `src/deck-revisions/identity.ts`
- Create: `src/deck-revisions/inspect.ts`
- Create: `src/deck-revisions/topology.ts`
- Create: `src/deck-revisions/store.ts`
- Create: `tests/deck-revisions.test.ts`
- Create: `tests/deck-topology.test.ts`
- Modify: `src/deck/assemble.ts`
- Modify: `src/project/schemas.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces `LocalDeckRevisionSchema`, `DeckEditSessionSchema`, `SlideTopologySchema`, `CurrentDeckPointerSchema`, and `DeckAdoptionEvidenceSchema`.
- Produces `scanOoxmlRanges(xml): OoxmlRangeIndex` and `publishInitialSlideIdentities(pptxPath, slides)` for pre-open identity publication.
- Produces `inspectLocalPptx(path: string): Promise<InspectedLocalPptx>`.
- Produces `reconcileSlideTopology(previous, inspected): ReconciledSlideTopology` without writing the PPTX.
- Produces `createDeckCandidate(root, options): Promise<ResolvedDeckEditSession>`.
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
    sessionId: candidate.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
  });

  assert.deepEqual(await readFile(candidate.absolutePath), userSavedBytes);
  assert.equal(adopted.revisionId, candidate.candidateRevisionId);
  assert.equal((await readCurrentDeckPointer(fixture.root)).sha256, adopted.sha256);
  assert.deepEqual(await readFile(fixture.current.absolutePath), fixture.currentBytes);
  assert.equal((await readRevision(fixture.root, adopted.revisionId)).sha256, adopted.sha256);
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

test("revision records stay immutable and interrupted adoption recovers one pointer", async (t) => {
  const fixture = await adoptionCrashFixture(t, "after-revision-before-pointer");
  const before = await readAllRevisionRecords(fixture.root);
  await recoverDeckAdoption(fixture.root);
  assert.deepEqual(await readAllRevisionRecords(fixture.root), before);
  assert.equal((await listCurrentPointers(fixture.root)).length, 1);
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `node --import tsx --test tests/deck-revisions.test.ts tests/deck-topology.test.ts`

Expected: FAIL because `src/deck-revisions/store.ts` does not exist.

- [ ] **Step 3: Implement strict revision and session schemas**

```ts
export const SlideTopologyEntrySchema = z.object({
  stableSlideId: z.string().uuid(),
  slidePart: z.string().regex(/^ppt\/slides\/slide[0-9]+\.xml$/),
  position: z.number().int().nonnegative(),
  management: z.enum(["managed", "unmanaged"]),
  presentationSlideId: z.number().int().min(256).max(4294967295),
  creationId: z.number().int().positive().max(4294967295),
}).strict();

export const SlideTopologySchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(SlideTopologyEntrySchema),
  deletedStableSlideIds: z.array(z.string().uuid()),
  sha256: Sha256Schema,
}).strict();

export const LocalDeckRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().uuid(),
  parentRevisionId: z.string().uuid().nullable(),
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  reason: z.enum(["initial", "manual-edit", "agent-edit", "slide-regeneration"]),
  relativePath: z.string().regex(/^output\/deck-revisions\/[0-9a-f-]{36}\/deck\.pptx$/),
  sha256: Sha256Schema,
  slideTopology: SlideTopologySchema,
  editableSlideIds: z.array(z.string().uuid()),
  changedSlideIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
}).strict();

export const DeckEditSessionSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  candidateRevisionId: z.string().uuid(),
  parentRevisionId: z.string().uuid(),
  mode: z.enum(["manual", "agent"]),
  targetSlideId: z.string().uuid(),
  state: z.enum(["prepared", "external-editing", "awaiting-confirmation", "adopting", "adopted", "rejected"]),
  candidateRelativePath: z.string().regex(/^output\/deck-revisions\/[0-9a-f-]{36}\/deck\.pptx$/),
  preparedSha256: Sha256Schema,
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
  slideTopologySha256: Sha256Schema,
  userSignal: z.literal("saved-and-closed").nullable(),
  confirmedSha256: Sha256Schema.nullable(),
  adoptedAt: z.string().datetime(),
}).strict().superRefine((evidence, context) => {
  if (evidence.mode === "manual" && (evidence.userSignal !== "saved-and-closed" || evidence.confirmedSha256 !== null)) {
    context.addIssue({ code: "custom", message: "manual adoption requires the saved-and-closed signal" });
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

Do not add mutable revision state. Store edit sessions below `output/deck-edit-sessions/<sessionId>/session.json`; store immutable adopted revision records beside their PPTX; derive current/superseded from `output/current.json`. Add only `currentDeck: CurrentDeckPointerSchema.nullable()` and active-session identity to `ProjectManifestSchema`. Remove preview artifacts from `EditableRevisionBindingSchema`; the binding retains converter identity and editable slide IDs but does not point to a PNG.

- [ ] **Step 4: Install runtime package tooling and implement namespace-aware raw ranges**

Run `npm install --save jszip saxes`. Verify both packages appear under `dependencies` and `jszip` no longer appears under `devDependencies`.

Use `saxes` only to identify namespace URI + local-name element/attribute ranges in the original UTF-8 XML. `scanOoxmlRanges()` returns offsets into the original string and namespace-resolved names; it never serializes a parsed document. Add tests with non-default prefixes, unknown namespace declarations, extension lists, Unicode text, and self-closing relationship elements.

- [ ] **Step 5: Implement safe PPTX inspection and stable reads**

`inspectLocalPptx()` must:

1. require an absolute, canonical, non-symlink regular file under the validated project root;
2. read the file twice with matching `size`, `mtimeMs`, and SHA-256;
3. parse it with JSZip and require `[Content_Types].xml`, `ppt/presentation.xml`, `ppt/_rels/presentation.xml.rels`, and at least one `ppt/slides/slideN.xml`;
4. return the complete file SHA, byte length, slide count, ordered slide-part paths, and SHA-256 for each slide XML and slide relationship part;
5. extract each `p:sldId/@id`, its slide relationship target, and `p14:creationId` when present;
6. reject duplicate slide relationship IDs, duplicate persistent IDs, missing internal slide targets, external slide targets, traversal paths, and ambiguous identity evidence;
7. perform no writes and expose no renderer output.

Use the existing `readRegularFileNoFollow()`, `validateProjectRoot()`, and project lock helpers instead of adding a second path-security implementation.

- [ ] **Step 6: Implement persistent identity and read-only topology reconciliation**

Initial assembly calls `publishInitialSlideIdentities()` before the deck is exposed. It records the project stable UUID -> `p:sldId/@id` -> slide relationship target -> `p14:creationId` mapping in the revision topology. A slide without `p14:creationId` receives a cryptographically random, nonzero, unique `xsd:unsignedInt` value at the official location `p:cSld/p:extLst/p:ext[@uri='{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}']/p14:creationId/@val`, using the namespace `http://schemas.microsoft.com/office/powerpoint/2010/main`. Preserve every existing `p:ext` child and all XML outside the insertion range byte-for-byte. A one-time migration of a legacy SuperPPT deck may add missing creation IDs before any external editor opens; record this as an explicit pre-open migration and rebaseline hashes. Do not add hidden shapes or a proprietary custom-XML slide marker.

`reconcileSlideTopology()` compares the previous revision topology with the saved presentation order:

- known identity at a new position -> preserve stable ID and record movement;
- previous identity absent -> add to `deletedStableSlideIds`;
- new slide part/creation ID with no known identity -> allocate a new stable ID and mark `management: "unmanaged"`;
- duplicate identity, conflicting custom-part/creation-ID evidence, or one slide mapped to multiple identities -> return a blocking conflict and do not adopt.

The function writes only topology metadata. It never injects or repairs identity inside a user-saved PPTX.

- [ ] **Step 7: Implement candidate creation and journaled metadata-only adoption**

`createDeckCandidate()` allocates the future revision ID, writes one owned copy to `output/deck-revisions/<candidateRevisionId>/deck.pptx`, authenticates it, and writes only the edit-session record. It does not create `revision.json` and never changes the current pointer.

`adoptDeckCandidate()` must:

```ts
const inspected = await inspectLocalPptx(candidate.absolutePath);
if (options.mode === "agent" && options.confirmedSha256 !== inspected.sha256) {
  throw new Error("agent confirmation does not bind the current candidate bytes");
}
if (options.mode === "manual" && options.userSignal !== "saved-and-closed") {
  throw new Error("manual adoption requires the explicit saved-and-closed signal");
}
const topology = reconcileSlideTopology(parent.slideTopology, inspected);
if (topology.conflicts.length > 0) throw new Error("saved deck has ambiguous slide identities");
await appendAdoptionJournal(root, { phase: "validated", sessionId: session.sessionId });
await writeImmutableRevisionRecord(root, finalizeRevision(session, inspected, topology));
await writeCurrentPointerOnly(root, {
  revisionId: session.candidateRevisionId,
  relativePath: session.candidateRelativePath,
  sha256: inspected.sha256,
});
```

Write the immutable revision record and adoption evidence before atomically replacing `output/current.json`; append journal phases before and after each durable metadata operation. Recovery treats an orphan finalized revision as non-current until the pointer transaction completes or is safely retried. The function must not call `writeFile`, `copyFile`, `rename`, `chmod`, `createPresentation`, identity injection, or any slide mutation function on `deck.pptx` after `inspectLocalPptx()` begins.

- [ ] **Step 8: Run schema, topology, store, crash-recovery, and type tests**

Run: `node --import tsx --test tests/deck-revisions.test.ts tests/deck-topology.test.ts tests/project-state.test.ts && npm run lint:types`

Expected: PASS with byte-for-byte manual adoption, moved/deleted/new slide reconciliation, ambiguous-ID rejection, crash recovery, immutable records, and pointer-only rollback.

- [ ] **Step 9: Commit the revision ledger and topology**

```bash
git add src/deck-revisions/schemas.ts src/deck-revisions/ooxml.ts src/deck-revisions/identity.ts src/deck-revisions/inspect.ts src/deck-revisions/topology.ts src/deck-revisions/store.ts src/deck/assemble.ts src/project/schemas.ts package.json package-lock.json tests/deck-revisions.test.ts tests/deck-topology.test.ts tests/project-state.test.ts
git commit -m "feat: add immutable deck revisions and topology"
```

---

### Task 2: Activate One Editable Slide Inside a Complete Candidate

**Files:**
- Create: `src/deck-revisions/activate-slide.ts`
- Create: `tests/full-deck-activation.test.ts`
- Modify: `src/editable/adapter.ts`
- Modify: `src/editable/schemas.ts`

**Interfaces:**
- Produces `AuthenticatedEditableConversionSchema` with manifest v2, ledger identity, official donor path/hash, converter version, and review-required objects.
- Consumes Task 1's `extractElementRange(xml, namespaceUri, localName)` and produces `rewriteInternalImageRelationships(...)` without serializing unrelated XML.
- Produces `activateEditableSlideInDeck(options): Promise<ActivatedDeckResult>`.
- Consumes the authenticated converter `manifestVersion: 2`, ledger, assets, and official `slide-editable.pptx` for one stable slide ID.
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
  assert.ok(result.targetInspection.editableShapeCount > 0);
  assert.deepEqual(result.reviewRequiredObjects, fixture.reviewRequiredObjects);
  assert.equal("singleSlidePath" in result, false);
});
```

Add tests proving native simple shapes and official object names (`text-<id>`, `shape-<id>-<label>`, `asset-<id>`) survive activation, all manifest v2 relations/provenance/review flags remain in the authenticated binding, and every non-target ZIP member under `ppt/slides/`, `ppt/notesSlides/`, and `ppt/comments/` retains its hash.

- [ ] **Step 2: Run the activation test and verify failure**

Run: `node --import tsx --test tests/full-deck-activation.test.ts`

Expected: FAIL because `activateEditableSlideInDeck()` is missing.

- [ ] **Step 3: Accept only the converter's official v2 result**

Define the SuperPPT adapter result:

```ts
export const AuthenticatedEditableConversionSchema = z.object({
  converterVersion: z.string().regex(/^0\.2\.[0-9]+(?:[-+].*)?$/),
  manifestVersion: z.literal(2),
  manifestPath: SafeOwnedRelativePathSchema,
  manifestSha256: Sha256Schema,
  ledgerPath: SafeOwnedRelativePathSchema,
  ledgerSha256: Sha256Schema,
  donorPptxPath: SafeOwnedRelativePathSchema.refine((p) => p.endsWith("/slide-editable.pptx")),
  donorPptxSha256: Sha256Schema,
  sourceImageSha256: Sha256Schema,
  reviewRequiredObjects: z.array(z.object({
    elementId: z.string().min(1),
    label: z.string().min(1),
    role: z.string().min(1),
  }).strict()),
}).strict();
```

Validate hashes against the converter ledger and owned output paths, parse `manifest.json` with the v2 schema, and require exactly one valid 16:9 slide in `slide-editable.pptx`. Reject v1, missing donor output, mismatched hashes, unexpected absolute paths, and donor/manifest object-name mismatches. Remove `buildPrivateEditableDonor()` and any SuperPPT manifest-to-PPTX rebuilding path.

- [ ] **Step 4: Extend namespace-aware ranges with relationship validation**

Use Task 1's raw range index to locate exactly one PresentationML `spTree` (`http://schemas.openxmlformats.org/presentationml/2006/main`) and reject zero or multiple matches. Build replacements from raw ranges; never serialize the parsed document.

Parse relationship elements by namespace URI. Reject `TargetMode="External"`, `r:link`, macros, OLE, audio/video, ActiveX, charts, diagrams, and every shape-tree relationship whose type is not the OOXML image relationship. Preserve the target slide's existing layout relationship and all raw XML outside the replaced `spTree`/relationship insertion ranges.

- [ ] **Step 5: Implement target-slide shape-tree transplantation**

`activateEditableSlideInDeck()` must operate on a temporary copy and atomically replace the candidate only after validation:

1. load the complete candidate and authenticated official donor with JSZip;
2. resolve the target slide part from `ppt/presentation.xml` and its relationships by slide order;
3. use namespace-aware raw ranges to extract the donor shape tree, regardless of its XML prefix;
4. allocate collision-free relationship IDs for donor images;
5. copy donor image bytes to unique `ppt/media/superppt-<uuid>.png` paths;
6. rewrite the transplanted shape tree's `r:embed` values to the new IDs;
7. retain the target slide's existing layout, notes, comments, transition, timing, namespace declarations, extension lists, and every non-shape raw XML range;
8. replace only the target `<p:spTree>` and append only the new image relationships;
9. inspect the staged complete deck, require the same slide count and stable identity topology, require v2 text/shape/asset object names on the target, and compare untouched slide-part hashes;
10. atomically replace the pre-open candidate once, then update candidate metadata with the new prepared hash and editable slide ID.

Leaving now-unreferenced target-slide media in the package is acceptable; deleting shared media is forbidden because it could affect other slides.

- [ ] **Step 6: Add corruption, OOXML preservation, and identity tests**

Test and reject:

- a donor with external relationships;
- a donor containing macros, OLE, media, ActiveX, chart, diagram, `r:link`, duplicate object names, or unsupported shape-tree relationships;
- a donor using non-default XML prefixes, plus a target containing unknown namespace declarations and extension lists that must remain byte-identical outside patched ranges;
- a target index outside the deck;
- a candidate whose slide count changes during staging;
- a donor whose page size is not 16:9;
- a converter output that lacks authenticated clean background or manifest hashes;
- a converter result with `manifestVersion: 1`, version outside `>=0.2.0 <0.3.0`, missing official donor, or mismatched donor hash;
- any attempted output path outside `output/deck-revisions/<revisionId>/deck.pptx`.

- [ ] **Step 7: Run activation, editable, and type tests**

Run: `node --import tsx --test tests/full-deck-activation.test.ts tests/editable.test.ts && npm run lint:types`

Expected: PASS; only the target slide changes, v2 native shapes and review-required metadata survive, unknown OOXML is preserved, and no user-visible single-page artifact exists.

- [ ] **Step 8: Commit official-donor full-deck activation**

```bash
git add src/deck-revisions/activate-slide.ts src/editable/adapter.ts src/editable/schemas.ts tests/full-deck-activation.test.ts tests/editable.test.ts
git commit -m "feat: activate official editable donors in full decks"
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
- Produces `resolveCurrentDeckPage({ root, pageNumber }): Promise<{ revisionId; stableSlideId; slideIndex }>`.
- Produces `prepareManualEditDeck(options): Promise<PreparedDeckEdit>`.
- Produces `adoptManualSavedDeck(options): Promise<ResolvedCurrentDeckPointer>`.
- Produces `beginAgentCandidateConfirmation(options): Promise<PreparedDeckEdit>`.
- Produces `confirmAgentEditDeck(options): Promise<ResolvedCurrentDeckPointer>`.
- Produces `rejectDeckEdit(options): Promise<void>`.
- Consumes Task 1 candidate/store APIs and Task 2 slide activation.

- [ ] **Step 1: Write failing workflow tests**

```ts
test("manual flow adopts exact bytes only after saved-and-closed", async (t) => {
  const fixture = await generatedProject(t);
  const resolved = await resolveCurrentDeckPage({
    root: fixture.root,
    pageNumber: 2,
  });
  const prepared = await prepareManualEditDeck({
    root: fixture.root,
    revisionId: resolved.revisionId,
    slideId: resolved.stableSlideId,
  });
  assert.equal(prepared.slideCount, fixture.slideIds.length);
  assert.equal(prepared.localLink, prepared.absolutePath);
  assert.equal(prepared.mode, "manual");

  const saved = await simulateWpsSaveAndClose(prepared.absolutePath);
  const adopted = await adoptManualSavedDeck({
    root: fixture.root,
    sessionId: prepared.sessionId,
    userSignal: "saved-and-closed",
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
    sessionId: candidate.sessionId,
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
2. accept the `revisionId` and `stableSlideId` returned together by `resolveCurrentDeckPage()` without substituting a newer pointer;
3. require that revisionId must remain current; otherwise fail closed before any candidate or session creation and leave zero candidate/session residue;
4. create a full candidate from that exact resolved revision;
5. activate only the requested slide when it is not already listed in `editableSlideIds`;
6. inspect the resulting full deck;
7. persist an `external-editing` session;
8. return the absolute candidate path as `localLink` plus labels/roles for every authenticated `reviewRequired` object.

The conversation tells the user to inspect any returned `reviewRequired` objects in the complete deck before saving and closing; this warning does not create a separate preview or confirmation gate.

`adoptManualSavedDeck()` accepts only the exact active session plus `userSignal: "saved-and-closed"`. It performs a stable read, structure validation, and Task 1's read-only topology reconciliation, then runs the journaled metadata-only adoption transaction. It must not repair, normalize, or rewrite slide content after the user saves; the user may intentionally have edited, reordered, inserted, or removed more than one slide. Blocking duplicate/ambiguous identities stop adoption and preserve the prior current pointer.

- [ ] **Step 4: Implement the Agent confirmation lifecycle**

`beginAgentCandidateConfirmation()` accepts an already prepared and inspected complete candidate from Task 4, records `awaiting-confirmation`, and returns its complete local path and exact presented hash. It does not change the current pointer.

`confirmAgentEditDeck()` re-reads the candidate, requires its hash to equal both the presented hash and `confirmedSha256`, and performs metadata-only adoption. `rejectDeckEdit()` marks the session rejected and leaves the prior current pointer unchanged.

- [ ] **Step 5: Serialize external editing**

Add tests proving:

- a second page edit cannot start while one session is `external-editing`;
- Agent operations cannot target the open candidate;
- `已保存并关闭` on a stale session is rejected;
- `已保存` without the close signal is rejected and leaves the session open;
- after manual adoption, a new edit starts from the exact saved complete deck;
- after a user reorder/insert/delete, the next request resolves page numbers from the reconciled current topology;
- after Agent confirmation, the next edit starts from the exact confirmed complete deck.

- [ ] **Step 6: Run workflow, revisions, and type tests**

Run: `node --import tsx --test tests/full-deck-editing.test.ts tests/deck-revisions.test.ts tests/deck-topology.test.ts tests/revisions.test.ts && npm run lint:types`

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
- Consumes the current deck revision's reconciled topology, `editableSlideIds`, authenticated editable manifest v2/binding, page description, and approved Style Lock.
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

For `direct-edit`, `src/deck-revisions/edit-slide.ts` must resolve the stable slide ID through the current reconciled topology and inspect the actual target slide in the newly copied complete candidate. Resolve objects by the stable names created by the official converter (`text-<element-id>`, `shape-<element-id>-<label>`, and `asset-<element-id>`) and confirm the current object type before patching. Change only the requested text node or supported geometry/style attributes in that object's current OOXML. Text replacement preserves paragraph/run structure, alignment, geometry, language, font, size, color, and every non-text property unless the request explicitly targets that property. Historical conversion manifests may supply identity hints, provenance, relations, and truthful capability limits, but they must never be rendered back over a page that the user previously saved.

Add a regression fixture where the user first changes title alignment in WPS, then the Agent changes only the title text in the next candidate. The Agent candidate must retain the user's alignment, geometry, all unrelated objects, and every non-target slide part.

`prepareAgentEditDeck()` must always create a complete candidate first. It then runs `editActualSlideObjects()` for `direct-edit`, Task 2 official-donor activation followed by `editActualSlideObjects()` for `activate-editable`, or Step 4's one-page image replacement for `regenerate-slide`. After inspection it calls Task 3's `beginAgentCandidateConfirmation()` and returns one complete local PPTX link. If the authenticated binding contains `reviewRequired: true` assets, the result also returns their labels/roles and the Skill tells the user to inspect them in the complete deck before confirmation.

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
- text-only Agent edits preserve WPS-authored alignment and run formatting;
- supported simple-shape edits target `shape-*` objects without rebuilding the slide;
- `reviewRequired` objects are disclosed before manual saved-and-closed or Agent confirmation.

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
- Create: `src/host/capabilities.ts`
- Modify: `src/acceptance/schema.ts`
- Modify: `src/acceptance/build.ts`
- Modify: `src/acceptance/current.ts`
- Modify: `src/project/schemas.ts`
- Modify: `src/project/promotion.ts`
- Modify: `src/cli.ts`
- Modify: `tests/publication.test.ts`
- Modify: `tests/project-state.test.ts`
- Create: `tests/cli-approval.test.ts`
- Modify: `tests/workflow-contract.test.ts`

**Interfaces:**
- Produces `HostRuntimeCapabilitiesSchema` and `requireLocalDeckHandoff(capabilities): void`.
- Produces a deck-review gate bound to `revisionId + absolutePath + sha256` for one complete local PPTX.
- Produces `formatLocalPptxLink(absolutePath, label): string` and CLI commands `current-deck-link`, `resolve-current-deck-page`, `prepare-manual-deck`, `adopt-saved-deck`, `prepare-agent-deck`, `confirm-agent-deck`, `reject-deck-candidate`, and `rollback-deck`. Manual preparation requires the exact `revisionId` returned by page resolution.
- Removes `render-editable`, `confirm-preview`, `replace-slide`, image-review adapter, and derived-export commands.

- [ ] **Step 1: Write failing CLI contract tests**

```ts
test("manual edit commands return a clickable complete local pptx and saved-and-closed adoption", async (t) => {
  const project = await cliProject(t);
  const resolved = await runCliJson([
    "resolve-current-deck-page", "--project", project.root, "--page-number", "2",
  ]);
  const prepared = await runCliJson([
    "prepare-manual-deck", "--project", project.root,
    "--revision-id", resolved.revisionId, "--slide-id", resolved.stableSlideId,
  ]);
  assert.equal(prepared.kind, "complete-local-pptx");
  assert.equal(prepared.slideCount, project.slideIds.length);
  assert.match(prepared.absolutePath, /output\/deck-revisions\/.+\/deck\.pptx$/);
  assert.equal(prepared.markdownLink, `[${prepared.linkLabel}](<${prepared.absolutePath}>)`);

  const adopted = await runCliJson([
    "adopt-saved-deck", "--project", project.root,
    "--session-id", prepared.sessionId, "--user-signal", "saved-and-closed",
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

Manual `已保存并关闭` is itself the adoption action after stable read, structure validation, and topology reconciliation. Agent candidates require a separate `confirm-agent-deck` action bound to the candidate hash. Neither action triggers assembly.

Define the injected host contract:

```ts
export const HostRuntimeCapabilitiesSchema = z.object({
  source: z.literal("agent-host"),
  localFilesystem: z.boolean(),
  localFileLinks: z.boolean(),
}).strict();
```

The Skill/harness supplies this capability object when invoking the workflow. `requireLocalDeckHandoff()` rejects unless both booleans are true. SuperPPT must not infer support from TTY state, operating system, WPS installation, or the fact that a path exists.

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
  "linkLabel": "<project-name>.pptx",
  "markdownLink": "[<project-name>.pptx](</absolute/project/output/deck-revisions/<uuid>/deck.pptx>)",
  "sha256": "<64-hex>",
  "slideCount": 12,
  "reviewRequiredObjects": [],
  "nextRequiredAction": "open this complete PPTX in WPS or PowerPoint"
}
```

`formatLocalPptxLink()` requires an absolute canonical `.pptx` path, rejects control characters/newlines and `>` in the target, and always uses an angle-bracket Markdown target so spaces and Chinese path segments remain clickable. `current-deck-link` returns the same shape without a session. Preflight must fail before project work when the host cannot expose local file links. The CLI must not emit a single-page PPT path, PNG path, PDF path, montage path, browser URL, or cloud-upload instruction.

- [ ] **Step 5: Preserve conversational wait points**

Update workflow tests so the Skill must:

- ask `需要我帮你修改，还是由你手动修改？` only when the user's request did not already choose a mode;
- explain the chosen direct/activate/regenerate route in one sentence;
- stop after presenting the complete local link;
- wait for `已保存并关闭` on manual sessions and reject the shorter `已保存` signal;
- wait for `确认` on Agent sessions;
- allow `修改大纲`, `修改第 N 页描述`, and `换风格` to return to upstream gates with impact disclosure.

- [ ] **Step 6: Run CLI, state, publication, and type tests**

Run: `node --import tsx --test tests/cli-approval.test.ts tests/workflow-contract.test.ts tests/publication.test.ts tests/project-state.test.ts && npm run lint:types`

Expected: PASS with local complete-deck links and no preview-bound action.

- [ ] **Step 7: Commit CLI and gate migration**

```bash
git add src/host/capabilities.ts src/acceptance/schema.ts src/acceptance/build.ts src/acceptance/current.ts src/project/schemas.ts src/project/promotion.ts src/cli.ts tests/publication.test.ts tests/project-state.test.ts tests/cli-approval.test.ts tests/workflow-contract.test.ts
git commit -m "feat: replace preview gates with local deck links"
```

---

### Task 6: Remove Rendering, Viewer, WPS Export, and Post-Save Rewrite Paths

**Files:**
- Delete: `src/deck/pdf.ts`
- Delete: `src/deck/montage.ts`
- Delete: `src/editable/preview-image.ts`
- Modify or delete after callers migrate: `src/editable/render.ts`
- Modify: `src/deck/assemble.ts`
- Modify: `src/dependencies/schemas.ts`
- Modify: `src/dependencies/resolve.ts`
- Modify: `src/dependencies/preflight.ts`
- Modify: `references/dependencies.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/deck.test.ts`
- Modify: `tests/editable.test.ts`
- Modify: `tests/generation.test.ts`
- Modify: `tests/mixed-deck.test.ts`

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
    userSignal: "saved-and-closed",
  });
  const afterStat = await stat(fixture.absolutePath);
  assert.deepEqual(await readFile(fixture.absolutePath), beforeBytes);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.size, beforeStat.size);
});
```

- [ ] **Step 2: Run deck and editable tests and verify the old PDF/montage path fails**

Run: `node --import tsx --test tests/deck.test.ts tests/editable.test.ts tests/mixed-deck.test.ts`

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

Remove `pdf-lib` from `package.json` and regenerate `package-lock.json` with `npm install --package-lock-only`. Assert that Task 2's runtime `jszip` and `saxes` dependencies remain under `dependencies`. Keep `sharp` because source-image normalization, editable conversion, and generation QA still use it.

- [ ] **Step 4: Remove WPSComposer from the main dependency contract**

Delete WPS preview/export capability schemas and preflight branches. `references/dependencies.json` must list only the two required skill dependencies for this workflow. Its `ai-image-to-ppt` entry requires the versioned `references/capabilities.json` schema and exact script capabilities used by SuperPPT; its `image-to-editable-pptx` entry requires `>=0.2.0 <0.3.0`, manifest v2, official donor output, and object-name contracts. The runtime resolver must parse and validate those same requirements instead of maintaining separate hard-coded version rules. Do not add a hidden optional preview fallback.

Add negative preflight fixtures for a missing/malformed `ai-image-to-ppt` capability manifest, manifest/script disagreement, converter 0.1.x, manifest v1, missing `slide-editable.pptx`, and a host without clickable local-file capability. Each must fail before a generation or conversion call.

- [ ] **Step 5: Delete post-save reconstruction**

Remove calls and exports for:

- `renderAdoptedPptxViaWps()`;
- `renderProjectEditablePreview()`;
- `renderEditablePage()` after Agent edits have moved to pre-open donor generation;
- manifest-driven `replace-slide` after manual save;
- any code that copies an adopted PPTX into a new assembled deck.

Keep converter validation and pre-open Agent operations. Rename remaining helpers so no function called `render*` is used during adoption.

- [ ] **Step 6: Run removal, package, and type tests**

Run: `node --import tsx --test tests/deck.test.ts tests/editable.test.ts tests/generation.test.ts tests/mixed-deck.test.ts tests/plugin-package.test.ts && npm run lint:types`

Expected: PASS with no `pdf-lib`, WPSComposer preview dependency, PDF, montage, PNG review, or post-save PPTX writer.

- [ ] **Step 7: Commit removal of obsolete paths**

```bash
git add src/deck/assemble.ts src/deck/pdf.ts src/deck/montage.ts src/editable/preview-image.ts src/editable/render.ts src/dependencies/schemas.ts src/dependencies/resolve.ts src/dependencies/preflight.ts references/dependencies.json package.json package-lock.json tests/deck.test.ts tests/editable.test.ts tests/generation.test.ts tests/mixed-deck.test.ts tests/plugin-package.test.ts
git commit -m "refactor: remove rendered review and post-save rewrite paths"
```

The dirty preserved worktree contains untracked `src/deck/wps-export.ts`, `src/editable/import-edit.ts`, `tests/wps-export.test.ts`, and `tests/import-edit.test.ts`. They are not part of the clean base and must not be copied into the implementation worktree. Delete the tracked clean-base `src/editable/preview-image.ts` normally and stage that deletion.

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
-> user saves, closes WPS/PowerPoint, and says 已保存并关闭
-> stable read, structure validation, and read-only topology reconciliation
-> create immutable revision/adoption metadata through the recovery journal
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
3. simulate a WPS save-and-close that moves slide 2, inserts one unmanaged page, and deletes one page;
4. adopt exact bytes and assert the reconciled topology preserves the moved ID, records the deletion, and allocates a new unmanaged ID;
5. resolve current page 3 through the reconciled topology and prepare it from those exact saved bytes;
6. assert the prior saved edit remains unchanged in the next candidate;
7. apply an Agent text edit to the resolved target page;
8. assert current still points to the manual revision until confirmation;
9. confirm the Agent candidate and assert rollback restores the manual revision without rewriting either file.

- [ ] **Step 3: Update user-facing instructions**

Remove all language about:

- opening a one-page editable PPT;
- replacing a saved page back into a deck;
- rendering the edited page back to PNG;
- Codex Viewer, ReviewAdapter, Web Office, WPS image fallback, PDF, montage, or cloud upload;
- WPSComposer as a review dependency.

Every editing response must provide one clickable Markdown link to the complete local PPTX, say that WPS/PowerPoint is the preview and editing interface, disclose any `reviewRequired` object labels, and wait for the correct manual saved-and-closed or Agent confirmation signal.

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
3. edit one title alignment or text value on slide 2, move that slide, insert a page, delete a different page, save in place, and close WPS;
4. record the exact saved file SHA-256;
5. invoke manual adoption with `已保存并关闭`, verify the file SHA-256 is unchanged after adoption, and verify topology reconciliation for moved/new/deleted pages;
6. reopen that exact file in WPS and verify the user edit remains exactly as saved;
7. request editing by the new current page number and verify the resolved target is correct and the new complete candidate contains the prior saved change;
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
