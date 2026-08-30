# Portable PPTX Review Implementation Plan

> **Superseded on 2026-08-30:** The confirmed product direction no longer includes Review adapters, Codex/native viewers, Web Office, WPS image fallbacks, PDF, montage, or post-save sealing copies. Implement [`2026-08-30-local-full-deck-editing.md`](./2026-08-30-local-full-deck-editing.md) instead. This file remains only as historical design context and must not be executed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the exact PPTX revision the primary SuperPPT review object on every host, use Codex Desktop's native viewer when available, degrade through explicit host adapters, and preserve a user-saved Office file without any post-save content rewrite.

**Architecture:** Add a review-domain contract that is independent of rendering, then migrate candidate publication, confirmation, and acceptance from montage hashes to immutable PPTX artifacts. Candidate assembly produces PPTX only by default; optional WPS-derived exports live outside the confirmation identity. Manual Office editing uses an owned full-deck edit candidate and promotes the exact saved bytes after validation, avoiding reconstruction after the user saves.

**Tech Stack:** TypeScript 5.9, Node.js >=22.6, Zod 4, JSZip, `@oai/artifact-tool` through the bundled runtime, WPSComposer as an optional versioned dependency, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-superppt-design.md`

## Global Constraints

- Preserve the guided confirmation flow: outline, slide specifications, style sample, generation authorization, and deck review remain human wait points.
- `ReviewArtifact` confirmation binds `scope + revisionId + sha256`; PNG, PDF, montage, viewer identity, and zoom state never authorize delivery.
- Codex Desktop is an adapter, not a runtime dependency. Node code must not import or emulate `open_in_codex`; the Skill invokes that host capability when present.
- Candidate assembly produces `deck.pptx` and acceptance evidence by default. PDF, slide images, and montage are generated only on an explicit request or a fallback adapter request.
- SuperPPT must not implement a general PPTX visual renderer. WPS-derived previews are accepted only when WPSComposer reports an authenticated direct export capability.
- If direct WPS slide-image export is unavailable, select `desktop-office` or `download-only`; never route PPTX -> PDF -> `pdftoppm` as a substitute.
- A file saved by the user in WPS or PowerPoint is immutable after import. Validation may read it, hash it, and inspect package structure, but no code may rewrite its text, geometry, style, relationships, or media before review or promotion.
- Manual Office editing starts from a full-deck owned candidate with the selected slide editable. The exact saved full-deck bytes become the next deck candidate; no post-save single-slide reassembly is allowed.
- Keep `ai-image-to-ppt`, `image-to-editable-pptx`, and WPSComposer as separate versioned capabilities. SuperPPT owns contracts and orchestration only.
- Node engine floor remains `>=22.6`.
- The execution worktree already contains unrelated and in-progress changes. Start every task with `git status --short`; stage and commit only the files named by that task, and never reset or overwrite unrelated edits.

---

## File Structure

- Create `src/review/schemas.ts`: immutable review artifact, host capability, adapter decision, and confirmation schemas.
- Create `src/review/adapters.ts`: pure capability-based adapter selection; no rendering or host calls.
- Create `src/review/artifact.ts`: publish and authenticate project-owned PPTX review descriptors.
- Create `src/review/derived.ts`: explicit WPS-derived export registry; no default invocation.
- Create `src/editable/manual-deck.ts`: prepare, inspect, import, and authenticate full-deck manual-edit candidates.
- Modify `src/acceptance/schema.ts`: replace montage-bound review actions with PPTX review bindings; make derived exports optional.
- Modify `src/acceptance/build.ts` and `src/acceptance/current.ts`: build and validate acceptance against exact PPTX evidence.
- Modify `src/project/schemas.ts`: store PPTX review and manual-edit bindings without making preview images authoritative.
- Modify `src/project/promotion.ts`: publish/replay/confirm the exact PPTX review artifact.
- Modify `src/project/evidence.ts`: validate current review presentation against PPTX hashes.
- Modify `src/deck/assemble.ts`: produce PPTX-only candidates by default and promote optional derived artifacts separately.
- Modify `src/deck/pptx.ts`: prepare a full-deck editable candidate before manual editing; do not touch adopted decks after save.
- Modify `src/deck/wps-export.ts`: remove PDF-raster montage behavior and expose only authenticated, direct WPS export adapters.
- Delete `src/deck/pdf.ts` and `src/deck/montage.ts`: remove the built-in flat-render delivery path.
- Modify `src/dependencies/schemas.ts`, `src/dependencies/resolve.ts`, and `src/dependencies/preflight.ts`: advertise optional WPS direct slide-image export without requiring it.
- Modify `references/dependencies.json`: publish WPSComposer as an optional review/export dependency.
- Modify `package.json` and `package-lock.json`: remove `pdf-lib` after the built-in PDF renderer is deleted.
- Modify `src/editable/import-edit.ts`, `src/editable/operations.ts`, `src/editable/render.ts`, and `src/editable/schemas.ts`: bind adopted full-deck PPTX bytes and stop generating a replacement PNG/PPTX after save.
- Modify `src/cli.ts`: publish review plans, confirm exact artifacts, request optional derived exports, and adopt full-deck edits.
- Modify `skills/superppt/SKILL.md`, `skills/superppt/references/阶段契约.json`, `skills/superppt/references/门禁清单.md`, `skills/superppt/references/修改路由.md`, and `README.md`: describe host routing and exact-file adoption.
- Create `tests/review-contract.test.ts`, `tests/review-publication.test.ts`, `tests/manual-deck-adoption.test.ts`, and `tests/review-adapters.test.ts`.
- Modify `tests/deck.test.ts`, `tests/editable.test.ts`, `tests/generation.test.ts`, `tests/mixed-deck.test.ts`, `tests/planning.test.ts`, `tests/project-state.test.ts`, `tests/publication.test.ts`, `tests/workflow-contract.test.ts`, `tests/cli-approval.test.ts`, and `tests/plugin-package.test.ts`.

---

### Task 1: Define Renderer-Independent Review Contracts

**Files:**
- Create: `src/review/schemas.ts`
- Create: `src/review/adapters.ts`
- Create: `tests/review-contract.test.ts`
- Create: `tests/review-adapters.test.ts`

**Interfaces:**
- Produces: `ReviewArtifactSchema`, `ReviewConfirmationSchema`, `ReviewCapabilitiesSchema`, `ReviewPlanSchema`.
- Produces: `selectReviewAdapter(capabilities: ReviewCapabilities): ReviewAdapterId`.
- Consumes: `Sha256Schema` from `src/project/schemas.ts`.

- [ ] **Step 1: Write failing schema tests for deck and slide PPTX artifacts**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  ReviewArtifactSchema,
  ReviewConfirmationSchema,
} from "../src/review/schemas.js";

const projectId = "00000000-0000-4000-8000-000000000101";
const projectRevisionId = "00000000-0000-4000-8000-000000000102";
const reviewId = "00000000-0000-4000-8000-000000000103";
const revisionId = "00000000-0000-4000-8000-000000000104";

test("review artifact binds one exact deck pptx", () => {
  const artifact = ReviewArtifactSchema.parse({
    schemaVersion: 1,
    kind: "pptx",
    scope: "deck",
    reviewId,
    revisionId,
    projectId,
    projectRevisionId,
    deckRevision: 2,
    locator: { kind: "project-file", path: `output/candidates/${revisionId}/deck.pptx` },
    sha256: "a".repeat(64),
    createdAt: "2026-08-30T08:00:00.000Z",
  });
  assert.equal(artifact.scope, "deck");
  assert.throws(() => ReviewArtifactSchema.parse({ ...artifact, sha256: "preview.png" }));
});

test("review confirmation repeats the exact artifact identity", () => {
  assert.equal(ReviewConfirmationSchema.parse({
    schemaVersion: 1,
    kind: "review-confirmation",
    actionId: "00000000-0000-4000-8000-000000000105",
    action: "confirm-delivery",
    reviewId,
    scope: "deck",
    revisionId,
    artifactSha256: "a".repeat(64),
    confirmedAt: "2026-08-30T08:01:00.000Z",
    confirmationSha256: "b".repeat(64),
  }).artifactSha256, "a".repeat(64));
});
```

- [ ] **Step 2: Run the schema tests and verify the missing module failure**

Run: `node --import tsx --test tests/review-contract.test.ts`

Expected: FAIL with `Cannot find module '../src/review/schemas.js'`.

- [ ] **Step 3: Implement strict artifact and confirmation schemas**

```ts
// src/review/schemas.ts
import { z } from "zod";
import { Sha256Schema } from "../project/schemas.js";

const ReviewLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project-file"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("authorized-url"), url: z.string().url().startsWith("https://") }).strict(),
]);

const ReviewArtifactBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("pptx"),
  reviewId: z.string().uuid(),
  revisionId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  locator: ReviewLocatorSchema,
  sha256: Sha256Schema,
  createdAt: z.string().datetime(),
});

export const ReviewArtifactSchema = z.discriminatedUnion("scope", [
  ReviewArtifactBaseSchema.extend({
    scope: z.literal("deck"),
    deckRevision: z.number().int().positive(),
    focusSlideId: z.string().uuid().optional(),
  }).strict(),
  ReviewArtifactBaseSchema.extend({
    scope: z.literal("slide"),
    slideId: z.string().uuid(),
    sourceRevisionId: z.string().uuid(),
  }).strict(),
]);

export const ReviewConfirmationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("review-confirmation"),
  actionId: z.string().uuid(),
  action: z.enum(["approve-slide", "confirm-delivery"]),
  reviewId: z.string().uuid(),
  scope: z.enum(["slide", "deck"]),
  revisionId: z.string().uuid(),
  artifactSha256: Sha256Schema,
  confirmedAt: z.string().datetime(),
  confirmationSha256: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.scope === "deck" && value.action !== "confirm-delivery") {
    context.addIssue({ code: "custom", path: ["action"], message: "deck review requires confirm-delivery" });
  }
  if (value.scope === "slide" && value.action !== "approve-slide") {
    context.addIssue({ code: "custom", path: ["action"], message: "slide review requires approve-slide" });
  }
});

export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
export type ReviewConfirmation = z.infer<typeof ReviewConfirmationSchema>;
```

- [ ] **Step 4: Write failing adapter-priority tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { selectReviewAdapter } from "../src/review/adapters.js";

const none = {
  nativePptx: false,
  webOffice: false,
  desktopOffice: false,
  wpsSlideImages: false,
  download: true,
};

test("native PPTX wins without requiring derived previews", () => {
  assert.equal(selectReviewAdapter({ ...none, nativePptx: true, wpsSlideImages: true }), "codex-desktop");
});

test("capability selection degrades without guessing the host name", () => {
  assert.equal(selectReviewAdapter({ ...none, webOffice: true }), "web-office");
  assert.equal(selectReviewAdapter({ ...none, desktopOffice: true }), "desktop-office");
  assert.equal(selectReviewAdapter({ ...none, wpsSlideImages: true }), "wps-image-fallback");
  assert.equal(selectReviewAdapter(none), "download-only");
});
```

- [ ] **Step 5: Implement capability schemas and pure selection**

```ts
// src/review/adapters.ts
import {
  ReviewCapabilitiesSchema,
  type ReviewAdapterId,
  type ReviewCapabilities,
} from "./schemas.js";

export function selectReviewAdapter(raw: ReviewCapabilities): ReviewAdapterId {
  const capabilities = ReviewCapabilitiesSchema.parse(raw);
  if (capabilities.nativePptx) return "codex-desktop";
  if (capabilities.webOffice) return "web-office";
  if (capabilities.desktopOffice) return "desktop-office";
  if (capabilities.wpsSlideImages) return "wps-image-fallback";
  if (capabilities.download) return "download-only";
  throw new Error("no safe PPTX review adapter is available");
}
```

Add these exports to `src/review/schemas.ts`:

```ts
export const ReviewAdapterIdSchema = z.enum([
  "codex-desktop",
  "web-office",
  "desktop-office",
  "wps-image-fallback",
  "download-only",
]);

export const ReviewCapabilitiesSchema = z.object({
  nativePptx: z.boolean(),
  webOffice: z.boolean(),
  desktopOffice: z.boolean(),
  wpsSlideImages: z.boolean(),
  download: z.boolean(),
}).strict();

export const ReviewPlanSchema = z.object({
  artifact: ReviewArtifactSchema,
  adapter: ReviewAdapterIdSchema,
  derivedPreviewRequired: z.boolean(),
  externalUploadRequired: z.boolean(),
}).strict();

export type ReviewCapabilities = z.infer<typeof ReviewCapabilitiesSchema>;
export type ReviewAdapterId = z.infer<typeof ReviewAdapterIdSchema>;
```

- [ ] **Step 6: Run focused tests and type checking**

Run: `node --import tsx --test tests/review-contract.test.ts tests/review-adapters.test.ts && npm run lint:types`

Expected: PASS.

- [ ] **Step 7: Commit the review contract**

```bash
git add src/review/schemas.ts src/review/adapters.ts tests/review-contract.test.ts tests/review-adapters.test.ts
git commit -m "feat: define portable pptx review contracts"
```

---

### Task 2: Make PPTX the Only Required Candidate and Acceptance Export

**Files:**
- Modify: `src/acceptance/schema.ts`
- Modify: `src/acceptance/build.ts`
- Modify: `src/acceptance/current.ts`
- Modify: `src/project/schemas.ts`
- Modify: `src/deck/assemble.ts`
- Modify: `src/acceptance/offline.ts`
- Delete: `src/deck/pdf.ts`
- Delete: `src/deck/montage.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/deck.test.ts`
- Modify: `tests/editable.test.ts`
- Modify: `tests/generation.test.ts`
- Modify: `tests/import-edit.test.ts`
- Modify: `tests/mixed-deck.test.ts`
- Modify: `tests/project-state.test.ts`

**Interfaces:**
- Consumes: `ReviewArtifact` from Task 1.
- Produces: `OutputArtifacts = { pptx: Artifact; acceptance: Artifact }`.
- Produces: `DerivedOutputArtifacts = { pdf: Artifact | null; montage: Artifact | null; slideImages: Artifact[] }`.
- Produces: `assembleProjectCandidate(root, operations)` with no WPS or flat-export requirement.

- [ ] **Step 1: Change tests so a valid candidate contains only PPTX, acceptance, and its marker**

In candidate tests, assert this exact directory shape:

```ts
assert.deepEqual((await readdir(candidate.destination)).sort(), [
  ".superppt-candidate.json",
  "acceptance.json",
  "deck.pptx",
]);
assert.equal(candidate.artifacts.pptx.path.endsWith("/deck.pptx"), true);
assert.equal("pdf" in candidate.artifacts, false);
assert.equal("montage" in candidate.artifacts, false);
```

Change acceptance expectations to:

```ts
assert.deepEqual(acceptance.exports, {
  pptx: { path: candidate.artifacts.pptx.path, sha256: candidate.artifacts.pptx.sha256 },
  derived: { pdf: null, montage: null, slideImages: [] },
});
```

- [ ] **Step 2: Run the focused candidate tests and verify they fail on required flat artifacts**

Run: `node --import tsx --test tests/deck.test.ts tests/generation.test.ts tests/mixed-deck.test.ts`

Expected: FAIL because `deck.pdf` and `montage.jpg` are still required.

- [ ] **Step 3: Split required and derived artifact schemas**

Use the same structure in `OutputMarkerSchema`, `DeckCandidateMarkerSchema`, `ProjectManifestSchema`, and `AcceptanceSchema`:

```ts
const RequiredOutputArtifactsSchema = z.object({
  pptx: ArtifactSchema,
  acceptance: ArtifactSchema,
}).strict();

const DerivedOutputArtifactsSchema = z.object({
  pdf: ArtifactSchema.nullable(),
  montage: ArtifactSchema.nullable(),
  slideImages: z.array(ArtifactSchema),
}).strict();
```

The manifest export state becomes:

```ts
exports: z.object({
  pptx: ArtifactSchema.nullable(),
  acceptance: ArtifactSchema.nullable(),
  derived: DerivedOutputArtifactsSchema,
}).strict(),
```

Migration is code-only because SuperPPT has not published a stable V1 state format. Update fixtures and tests atomically; do not add a compatibility branch that silently accepts montage-bound confirmations.

- [ ] **Step 4: Make acceptance bind actual PPTX slide parts instead of derived page images**

Replace `finalRenderSha256` in `AcceptanceSchema.slides` with:

```ts
slidePartSha256: Sha256Schema,
```

Add a helper in `src/deck/assemble.ts`:

```ts
export async function inspectPptxSlides(path: string): Promise<Array<{
  order: number;
  slidePartSha256: string;
}>> {
  const zip = await JSZip.loadAsync(await readRegularFileNoFollow(path));
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return Promise.all(names.map(async (name, order) => ({
    order,
    slidePartSha256: createHash("sha256").update(await zip.file(name)!.async("nodebuffer")).digest("hex"),
  })));
}
```

`buildAcceptance()` must compare the inspected slide count and order to the marker slides, then record those hashes. It must not require PNG render hashes for delivery confirmation.

- [ ] **Step 5: Reduce default assembly to PPTX creation and PPTX verification**

Replace the default build operation with:

```ts
export type AssembleProjectOperations = {
  buildPptx?: (renders: FinalRender[], pptxPath: string) => Promise<void>;
  checkpoint?: (step: "pptx-built") => Promise<void> | void;
  beforePromote?: () => Promise<void> | void;
  afterRenderOpened?: (path: string) => Promise<void> | void;
};
```

`assembleProjectCandidate()` must create only `deck.pptx`, authenticate its slide count, stable IDs, relationships, and media, write `acceptance.json`, then write the candidate marker. Remove `exportPdf`, `buildMontage`, `exportDeckPdfViaWps`, and `buildMontageFromPdf` from the default path.

Delete `src/deck/pdf.ts` and `src/deck/montage.ts`, remove `pdf-lib` from `package.json`, and refresh the lockfile:

```bash
npm pkg delete dependencies.pdf-lib
npm install --package-lock-only --ignore-scripts
```

`sharp` remains because image generation QA, style previews, editable conversion, and direct-WPS-image montage still require it.

In the same task, delete the legacy `exportPdf`, `buildMontage`, `verifyFlatArtifacts`, and `PDFDocument` test cases/imports from `tests/deck.test.ts`, `tests/editable.test.ts`, `tests/generation.test.ts`, `tests/import-edit.test.ts`, and `tests/mixed-deck.test.ts`. Replace their fixture `buildOutputs` callbacks with PPTX-only `buildPptx` callbacks so type checking remains green immediately after `pdf-lib` is removed.

- [ ] **Step 6: Update promotion and recovery helpers for the two required artifacts**

Required canonical paths are:

```ts
function canonicalArtifactRefs(revisionNumber: number) {
  const base = `output/revisions/${revisionNumber}`;
  return {
    pptx: `${base}/deck.pptx`,
    acceptance: `${base}/acceptance.json`,
  } as const;
}
```

Recovery must authenticate only `.superppt-output.json`, `deck.pptx`, and `acceptance.json`. Derived artifacts are validated from their own registry in Task 4.

- [ ] **Step 7: Run candidate, acceptance, and type tests**

Run: `node --import tsx --test tests/deck.test.ts tests/editable.test.ts tests/generation.test.ts tests/import-edit.test.ts tests/mixed-deck.test.ts tests/project-state.test.ts && npm run lint:types`

Expected: PASS with no default `deck.pdf` or `montage.jpg` creation.

- [ ] **Step 8: Commit PPTX-only candidate assembly**

```bash
git add src/acceptance/schema.ts src/acceptance/build.ts src/acceptance/current.ts src/acceptance/offline.ts src/project/schemas.ts src/deck/assemble.ts src/deck/pdf.ts src/deck/montage.ts package.json package-lock.json tests/deck.test.ts tests/editable.test.ts tests/generation.test.ts tests/import-edit.test.ts tests/mixed-deck.test.ts tests/project-state.test.ts
git commit -m "refactor: make pptx the primary review artifact"
```

---

### Task 3: Publish and Confirm the Exact PPTX Review Artifact

**Files:**
- Create: `src/review/artifact.ts`
- Create: `tests/review-publication.test.ts`
- Modify: `src/acceptance/schema.ts`
- Modify: `src/project/promotion.ts`
- Modify: `src/project/evidence.ts`
- Modify: `src/planning/confirm.ts`
- Modify: `tests/planning.test.ts`
- Modify: `tests/publication.test.ts`
- Modify: `tests/editable.test.ts`

**Interfaces:**
- Consumes: `ReviewArtifact` from Task 1 and PPTX-only candidates from Task 2.
- Produces: `publishDeckReviewArtifact(root, candidateId): Promise<ReviewArtifact>`.
- Produces: `authenticateCurrentReviewArtifact(root): Promise<{ descriptor; artifact; pptxBytes }>`.
- Changes: deck-review actions bind `reviewId + revisionId + artifactSha256`, never `presentedMontageSha256`.

- [ ] **Step 1: Write a failing publication test proving the descriptor points at candidate PPTX bytes**

```ts
const review = await publishDeckReview(root, candidate.candidateId);
assert.equal(review.reviewArtifact.scope, "deck");
assert.equal(review.reviewArtifact.revisionId, candidate.candidateId);
assert.equal(review.reviewArtifact.sha256, candidate.artifacts.pptx.sha256);
assert.equal(review.reviewArtifact.locator.kind, "project-file");
assert.equal(review.reviewArtifact.locator.path, candidate.artifacts.pptx.path);
await assert.rejects(
  applyDeckReviewAction(root, {
    action: "confirm-delivery",
    candidateId: candidate.candidateId,
    descriptorSha256: review.descriptorSha256,
    reviewId: review.reviewArtifact.reviewId,
    revisionId: review.reviewArtifact.revisionId,
    artifactSha256: "f".repeat(64),
  }),
  /exact pptx review artifact/,
);
```

- [ ] **Step 2: Run the publication test and verify the old montage binding fails**

Run: `node --import tsx --test tests/review-publication.test.ts tests/publication.test.ts`

Expected: FAIL because `DeckReviewDescriptorSchema` and actions still require montage evidence.

- [ ] **Step 3: Implement artifact publication and authentication**

```ts
// src/review/artifact.ts
export async function authenticateProjectReviewArtifact(
  root: string,
  raw: unknown,
): Promise<{ artifact: ReviewArtifact; bytes: Buffer }> {
  const artifact = ReviewArtifactSchema.parse(raw);
  if (artifact.locator.kind !== "project-file") {
    throw new Error("server-side authentication requires a project-file review artifact");
  }
  const bytes = await readOwnedRegularFile(root, artifact.locator.path);
  if (sha256Evidence(bytes) !== artifact.sha256) {
    throw new Error("review PPTX changed after publication");
  }
  return { artifact, bytes };
}
```

`publishDeckReview()` creates one `ReviewArtifact` whose `revisionId` is the candidate UUID, whose `projectRevisionId` is the current project revision, and whose SHA-256 is re-read from the candidate PPTX immediately before descriptor publication.

- [ ] **Step 4: Replace montage identity in deck review schemas and evidence**

Change the action request/evidence base to include:

```ts
reviewId: z.string().uuid(),
revisionId: z.string().uuid(),
artifactSha256: Sha256Schema,
```

Delete `presentedMontageSha256`. `recordDeckReviewAction()` must reject unless all three values equal the authenticated current `ReviewArtifact`. `validateCurrentPresentationBinding()` and `approveDeckReviewActionGate()` must re-read `deck.pptx` and validate the artifact SHA before accepting the action.

- [ ] **Step 5: Remove current montage copies from the review publication directory**

The exact allowed entries become:

```ts
const names = manifest.stage === "deck-review"
  ? ["review.json"]
  : ["action.json", "review.json"];
```

`output/candidates/current/review.json` links to the candidate PPTX; it does not copy the PPTX or a montage. Invalidation authenticates and moves only `review.json` and optional `action.json`.

- [ ] **Step 6: Run publication, planning, editable-selection, and type tests**

Run: `node --import tsx --test tests/review-publication.test.ts tests/publication.test.ts tests/planning.test.ts tests/editable.test.ts && npm run lint:types`

Expected: PASS, and a forged PPTX hash must block edit selection and delivery confirmation.

- [ ] **Step 7: Commit exact-PPTX review publication**

```bash
git add src/review/artifact.ts src/acceptance/schema.ts src/project/promotion.ts src/project/evidence.ts src/planning/confirm.ts tests/review-publication.test.ts tests/publication.test.ts tests/planning.test.ts tests/editable.test.ts
git commit -m "feat: bind deck review to exact pptx revisions"
```

---

### Task 4: Add Explicit Derived Export and Fallback Capability

**Files:**
- Create: `src/review/derived.ts`
- Modify: `src/deck/wps-export.ts`
- Modify: `src/dependencies/schemas.ts`
- Modify: `src/dependencies/resolve.ts`
- Modify: `src/dependencies/preflight.ts`
- Modify: `references/dependencies.json`
- Modify: `tests/wps-export.test.ts`
- Modify: `tests/dependencies.test.ts`

**Interfaces:**
- Consumes: authenticated `ReviewArtifact` from Task 3.
- Produces: `publishDerivedReviewArtifacts(options): Promise<DerivedReviewRecord>`.
- Produces: optional WPS capability `slideImageExport`; its absence is a normal capability result, not a preflight failure.

- [ ] **Step 1: Write failing dependency and fallback tests**

```ts
test("WPS without direct slide-image export remains usable for desktop-office", async () => {
  const dependency = await resolveWpsComposerSkillDependency(wpsRootWithoutImageExporter);
  assert.equal(dependency.capabilities.slideImageExport, null);
});

test("image fallback refuses PDF rasterization", async () => {
  await assert.rejects(
    publishDerivedReviewArtifacts({
      root,
      artifact,
      request: { slideImages: true, pdf: false, montage: true },
      wpsDependency: dependencyWithoutImageExporter,
    }),
    /direct WPS slide-image export is unavailable/,
  );
});
```

- [ ] **Step 2: Run the focused tests and verify current PDF-raster behavior fails**

Run: `node --import tsx --test tests/wps-export.test.ts tests/dependencies.test.ts`

Expected: FAIL because the current implementation exports PDF then calls `pdftoppm`.

- [ ] **Step 3: Make the WPS direct image exporter an optional resolved capability**

Change the dependency schema to:

```ts
capabilities: z.object({
  pdfExport: z.object({ path: z.string().min(1), sha256: Sha256Schema }).nullable(),
  slideImageExport: z.object({ path: z.string().min(1), sha256: Sha256Schema }).nullable(),
}).strict(),
```

Resolver rules:

```ts
const optionalSlideExporter = join(wpsRoot, "scripts", "slide_image_export.py");
```

If that exact regular file exists, record its canonical path and SHA-256. If it does not exist, record `null`. A symlink, escaped path, or changed hash is an integrity error. Do not invent a wrapper that converts through PDF.

- [ ] **Step 4: Replace `buildMontageFromPdf` with direct-image registration**

Delete the `pdftoppm` and Sharp rasterization path from `src/deck/wps-export.ts`. Add:

```ts
export type WpsSlideImageExport = {
  pageCount: number;
  images: Array<{ order: number; path: string; sha256: string }>;
};

export async function exportSlideImagesViaWps(options: {
  pptxPath: string;
  outputDirectory: string;
  dependency: WpsComposerSkillDependency;
  timeoutSeconds?: number;
}): Promise<WpsSlideImageExport>;
```

This function executes only `dependency.capabilities.slideImageExport.path`, requires contiguous `slide-0001.png` names, validates every file as a complete image, and returns hashes. If the capability is null, it throws before creating output.

- [ ] **Step 5: Publish optional derived records outside confirmation identity**

`src/review/derived.ts` writes:

```ts
type DerivedReviewRecord = {
  schemaVersion: 1;
  kind: "derived-review-artifacts";
  reviewId: string;
  sourceRevisionId: string;
  sourcePptxSha256: string;
  renderer: "wpscomposer";
  pdf: Artifact | null;
  slideImages: Artifact[];
  montage: Artifact | null;
  createdAt: string;
};
```

If montage is requested, compose it only from the authenticated direct WPS slide images. The record and outputs live under `review/derived-previews/<reviewId>/`; they are never inserted into `ReviewConfirmationSchema`.

- [ ] **Step 6: Run focused tests and type checking**

Run: `node --import tsx --test tests/wps-export.test.ts tests/dependencies.test.ts tests/review-adapters.test.ts && npm run lint:types`

Expected: PASS; systems without the optional exporter choose desktop or download review and create no degraded preview.

- [ ] **Step 7: Commit explicit derived exports**

```bash
git add src/review/derived.ts src/deck/wps-export.ts src/dependencies/schemas.ts src/dependencies/resolve.ts src/dependencies/preflight.ts references/dependencies.json tests/wps-export.test.ts tests/dependencies.test.ts tests/review-adapters.test.ts
git commit -m "feat: add explicit WPS review fallbacks"
```

---

### Task 5: Adopt a User-Saved Full Deck Without Rewriting It

**Files:**
- Create: `src/editable/manual-deck.ts`
- Create: `tests/manual-deck-adoption.test.ts`
- Modify: `src/editable/import-edit.ts`
- Modify: `src/editable/operations.ts`
- Modify: `src/editable/render.ts`
- Modify: `src/editable/schemas.ts`
- Modify: `src/project/schemas.ts`
- Modify: `src/deck/assemble.ts`
- Modify: `src/deck/pptx.ts`
- Modify: `tests/import-edit.test.ts`
- Modify: `tests/editable.test.ts`

**Interfaces:**
- Consumes: current reviewed deck, one authenticated `edit-page` action, and an editable conversion revision.
- Produces: `prepareManualEditDeck(options): Promise<ReviewArtifact>`.
- Produces: `inspectManualEditDeck(options): Promise<ManualDeckReview>`.
- Produces: `adoptManualEditDeck(options): Promise<{ revisionId; reviewArtifact; candidateId }>`.
- Guarantee: promoted `deck.pptx` SHA-256 equals the exact user-saved input SHA-256.

- [ ] **Step 1: Replace manifest-roundtrip tests with exact-byte adoption tests**

```ts
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

function localReviewPath(root: string, artifact: ReviewArtifact): string {
  assert.equal(artifact.locator.kind, "project-file");
  if (artifact.locator.kind !== "project-file") throw new Error("test requires a project file");
  return join(root, ...artifact.locator.path.split("/"));
}

async function editSelectedSlideFixture(path: string, slideId: string, text: string): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(path));
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const selected = (await Promise.all(slideNames.map(async (name) => ({
    name,
    xml: await zip.file(name)!.async("string"),
  })))).find(({ xml }) => xml.includes(`background-${slideId}`));
  if (!selected) throw new Error("selected editable slide is missing");
  const changed = selected.xml
    .replace(/algn=(['"])l\1/, 'algn="ctr"')
    .replace(/<a:t>[^<]*<\/a:t>/, `<a:t>${text}</a:t>`);
  if (changed === selected.xml) throw new Error("fixture edit did not change the selected slide");
  zip.file(selected.name, changed);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
}

test("manual edit adoption promotes the exact saved deck bytes", async (t) => {
  const prepared = await prepareManualEditDeck({ root, slideId, sourceRevisionId });
  const temporary = await mkdtemp(join(tmpdir(), "superppt-manual-adoption-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const saved = join(temporary, "saved-by-wps.pptx");
  await copyFile(localReviewPath(root, prepared), saved);
  await editSelectedSlideFixture(saved, slideId, "用户最终居中标题");

  const review = await inspectManualEditDeck({ root, slideId, sourceRevisionId, editedDeckPath: saved });
  const adopted = await adoptManualEditDeck({
    root,
    slideId,
    sourceRevisionId,
    editedDeckPath: saved,
    expectedEditedDeckSha256: review.editedDeckSha256,
  });

  const savedBytes = await readFile(saved);
  const adoptedBytes = await readFile(localReviewPath(root, adopted.reviewArtifact));
  assert.deepEqual(adoptedBytes, savedBytes);
  assert.equal(adopted.reviewArtifact.sha256, sha256(savedBytes));
});
```

Add a regression assertion that the selected slide XML still contains the user's alignment and geometry after deck promotion, and that the promoted deck SHA equals the imported saved-deck SHA.

- [ ] **Step 2: Run adoption tests and verify the current manifest rebuild changes the file**

Run: `node --import tsx --test tests/manual-deck-adoption.test.ts tests/import-edit.test.ts tests/editable.test.ts`

Expected: FAIL because current code parses `slide1.xml`, rebuilds a manifest, renders PNG, and creates another PPTX.

- [ ] **Step 3: Prepare the editable full-deck candidate before the user edits**

Add this binding:

```ts
export const ManualEditDeckSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("manual-edit-deck"),
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  candidateId: z.string().uuid(),
  slideId: z.string().uuid(),
  sourceRevisionId: z.string().uuid(),
  sourceDeck: ArtifactSchema,
  editableDeck: ArtifactSchema,
  createdAt: z.string().datetime(),
}).strict();
```

`prepareManualEditDeck()` runs before WPS is opened. It uses the existing converter manifest to assemble one full deck where only the selected page is editable, writes it to `editable/<slideId>/<sourceRevisionId>/manual-edit/deck.pptx`, hashes it, and publishes a slide-scope `ReviewArtifact` whose locator points to that full deck and whose `slideId` identifies the decision scope. Rebuilding is allowed here because the user has not edited this candidate yet.

- [ ] **Step 4: Inspect the saved full deck without changing bytes**

`inspectManualEditDeck()` must:

```ts
const bytes = await readRegularFileNoFollow(options.editedDeckPath);
const editedDeckSha256 = sha256(bytes);
const zip = await JSZip.loadAsync(bytes);
```

It validates:

- the file is a regular `.pptx` with no macro part and no external relationships;
- slide count equals the prepared deck;
- slide order is unchanged;
- every untouched image slide retains its stable `page-<slideId>` object and original media SHA-256;
- the selected slide still exists at its original index;
- the prepared candidate and saved file hashes differ only when the user actually saved changes.

It returns observations and warnings but never emits edit operations and never writes a manifest used to reconstruct the saved deck.

- [ ] **Step 5: Seal exact saved bytes as the adopted deck candidate**

`adoptManualEditDeck()` must re-read and re-hash the input, compare it to `expectedEditedDeckSha256`, copy the exact bytes with `writeDurableExclusive`, then re-read the sealed copy and require byte equality. Its marker stores:

```ts
adoption: {
  sourceManualEditDeckSha256: prepared.editableDeck.sha256,
  editedDeckSha256: expectedEditedDeckSha256,
  selectedSlideId: slideId,
  validationRecordSha256,
}
```

The adopted file first becomes a slide-scope ReviewArtifact over the exact full deck. After `approve-slide`, the same bytes become the next PPTX-only deck candidate; `assembleProjectCandidate()` accepts this authenticated override and skips `createPresentation()` entirely. The subsequent deck review publishes a new deck-scope artifact over the same SHA. Candidate promotion copies the exact bytes again and asserts:

```ts
assert.equal(promoted.artifacts.pptx.sha256, expectedEditedDeckSha256);
```

- [ ] **Step 6: Remove post-save PNG rendering and manifest-authoritative confirmation**

For adopted manual decks:

- `renderProjectEditablePreview()` is not called;
- `renderAdoptedPptxViaWps()` and its PDF -> `pdftoppm` path are deleted;
- `slide-preview` confirmation is renamed at the CLI/Skill boundary to `slide-review` and binds the adopted PPTX `ReviewArtifact`;
- parsed text/shape observations may be stored as non-authoritative diagnostics for future routing, but `modified-manifest.json` cannot drive reconstruction of the adopted file.

Automatic `applyProjectEditPlan()` remains available for Agent-authored changes before manual save; its output gets a fresh PPTX review artifact and never inherits a previous manual confirmation.

- [ ] **Step 7: Run adoption, editable, candidate, and type tests**

Run: `node --import tsx --test tests/manual-deck-adoption.test.ts tests/import-edit.test.ts tests/editable.test.ts tests/generation.test.ts && npm run lint:types`

Expected: PASS with byte-for-byte saved-deck preservation and no adopted-preview rasterization.

- [ ] **Step 8: Commit exact full-deck adoption**

```bash
git add src/editable/manual-deck.ts src/editable/import-edit.ts src/editable/operations.ts src/editable/render.ts src/editable/schemas.ts src/project/schemas.ts src/deck/assemble.ts src/deck/pptx.ts tests/manual-deck-adoption.test.ts tests/import-edit.test.ts tests/editable.test.ts tests/generation.test.ts
git commit -m "fix: adopt user-saved decks without rewriting"
```

---

### Task 6: Expose Review Planning and Host Actions Through the CLI and Skill

**Files:**
- Modify: `src/cli.ts`
- Modify: `skills/superppt/SKILL.md`
- Modify: `skills/superppt/references/阶段契约.json`
- Modify: `skills/superppt/references/门禁清单.md`
- Modify: `skills/superppt/references/修改路由.md`
- Modify: `README.md`
- Modify: `tests/cli-approval.test.ts`
- Modify: `tests/workflow-contract.test.ts`
- Modify: `tests/plugin-package.test.ts`

**Interfaces:**
- Consumes: review artifact, capability selection, optional derived export, and manual-deck adoption APIs from Tasks 1-5.
- Produces CLI: `review-plan`, `export-review-derived`, `prepare-manual-edit-deck`, `inspect-manual-edit-deck`, `adopt-manual-edit-deck`, `confirm-review`.
- Produces Skill routing: Codex host open, Web/desktop handoff, WPS image fallback, download-only.

- [ ] **Step 1: Write failing CLI contract tests**

The CLI tests must assert:

```ts
assert.deepEqual(await runJson("review-plan", [
  "--project", root,
  "--capabilities", capabilities0600,
]), {
  artifact: currentReviewArtifact,
  adapter: "codex-desktop",
  derivedPreviewRequired: false,
  externalUploadRequired: false,
  nextRequiredAction: "open the exact PPTX with the selected host adapter, then wait for the user decision",
});
```

Also assert `confirm-review` requires `--review-id`, `--revision`, and `--sha256`, rejects a stale hash, and never accepts `--render`, `--montage`, or generic `approve`.

- [ ] **Step 2: Run CLI and workflow tests and verify old commands fail**

Run: `node --import tsx --test tests/cli-approval.test.ts tests/workflow-contract.test.ts tests/plugin-package.test.ts`

Expected: FAIL because the current interface still exposes `render-editable`, `confirm-preview`, and montage-centered instructions.

- [ ] **Step 3: Add strict CLI commands**

Use private `0600` JSON input for capabilities:

```ts
const capabilities = await readCliJsonInput(
  options.get("--capabilities")!,
  "review capabilities",
  ReviewCapabilitiesSchema,
  { privateInput: true },
);
```

Command responsibilities:

- `review-plan`: authenticate current `ReviewArtifact`, select adapter, output plan only.
- `export-review-derived`: require explicit `--pdf true|false --slide-images true|false --montage true|false`; refuse all-false requests.
- `prepare-manual-edit-deck`: create the full editable candidate before the user opens WPS.
- `inspect-manual-edit-deck`: read-only validation and hash report.
- `adopt-manual-edit-deck`: seal exact bytes only after the inspected SHA is supplied.
- `confirm-review`: bind exact review identity and perform slide replacement or delivery promotion according to scope.

`review-plan` computes flags exactly as follows:

```ts
const adapter = selectReviewAdapter(capabilities);
const plan = ReviewPlanSchema.parse({
  artifact,
  adapter,
  derivedPreviewRequired: adapter === "wps-image-fallback",
  externalUploadRequired: adapter === "web-office",
});
```

Keep `deck-review-action` as a compatibility error that tells callers to use `confirm-review`; do not accept the old montage-bound request.

- [ ] **Step 4: Update the Skill's host adapter behavior**

The Skill must state this exact decision order:

```text
1. If the host exposes native PPTX open, open ReviewArtifact.locator.path directly.
2. Else if an authorized Web Office viewer is configured, disclose upload/access retention and obtain permission before upload.
3. Else if WPS/PowerPoint desktop open is available, open the exact PPTX externally.
4. Else if WPSComposer reports direct slide-image export, request derived images and show those without changing the PPTX.
5. Else provide the exact PPTX file and state that inline preview is unavailable.
```

For Codex Desktop, the Skill instructs the Agent to invoke the host file-opening capability with `target.type = "file"` and the absolute PPTX path. It must not claim that this action is available on other hosts.

- [ ] **Step 5: Update machine-readable stages and modification routing**

Change `deck-review.inputs` to `review-only candidate descriptor`, `exact candidate PPTX ReviewArtifact`, and page QA evidence. Change `slide-preview` to `slide-review` in the stage contract, gate list, CLI wording, and invalidation dependencies. Its user-visible artifact is the exact PPTX with the selected stable slide ID, not a before/after PNG.

Manual editing instructions become:

```text
prepare full editable deck -> open exact candidate -> user saves -> inspect exact saved deck -> show hash and impact -> user confirms adoption -> seal exact bytes -> reopen exact adopted PPTX -> user confirms slide/deck review
```

- [ ] **Step 6: Run CLI, workflow, package, and type tests**

Run: `node --import tsx --test tests/cli-approval.test.ts tests/workflow-contract.test.ts tests/plugin-package.test.ts && npm run lint:types`

Expected: PASS; shipped instructions contain no default montage review and no post-save render step.

- [ ] **Step 7: Commit CLI and Skill routing**

```bash
git add src/cli.ts skills/superppt/SKILL.md skills/superppt/references/阶段契约.json skills/superppt/references/门禁清单.md skills/superppt/references/修改路由.md README.md tests/cli-approval.test.ts tests/workflow-contract.test.ts tests/plugin-package.test.ts
git commit -m "feat: route SuperPPT review through host adapters"
```

---

### Task 7: Run Full Regression and Real Host Acceptance

**Files:**
- Modify: `tests/e2e.test.ts`
- Modify: `tests/plugin-package.test.ts`
- Modify: `docs/superpowers/specs/2026-08-26-superppt-design.md` only if execution discovers a genuine contradiction; otherwise leave the confirmed spec unchanged.

**Interfaces:**
- Consumes all completed tasks.
- Produces one tested end-to-end path for Codex native review and one tested no-Codex fallback path.

- [ ] **Step 1: Add an end-to-end native-review fixture**

The test must run:

```text
assemble candidate
publish deck ReviewArtifact
select codex-desktop from declared capabilities
confirm exact candidate SHA
promote candidate
assert promoted deck SHA equals reviewed candidate SHA
```

It must fail if the file changes between publication and confirmation.

- [ ] **Step 2: Add an end-to-end no-Codex fallback fixture**

Exercise two capability sets:

```ts
assert.equal(selectReviewAdapter({
  nativePptx: false,
  webOffice: false,
  desktopOffice: true,
  wpsSlideImages: false,
  download: true,
}), "desktop-office");

assert.equal(selectReviewAdapter({
  nativePptx: false,
  webOffice: false,
  desktopOffice: false,
  wpsSlideImages: false,
  download: true,
}), "download-only");
```

Both paths must confirm the same PPTX SHA without generating PDF or montage.

- [ ] **Step 3: Add the manual-edit regression to E2E**

Prepare a full editable candidate, apply a fixture WPS-style XML change to the selected slide, adopt it, promote it, and assert:

```ts
assert.equal(promoted.artifacts.pptx.sha256, inspected.editedDeckSha256);
assert.deepEqual(await readFile(promotedDeckPath), await readFile(savedDeckPath));
```

Also assert untouched slide media hashes remain equal to the pre-edit candidate.

- [ ] **Step 4: Run the complete source test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Run type checking, build, and compiled tests**

Run: `npm run lint:types && npm run build && npm run test:compiled`

Expected: all commands succeed with zero failures.

- [ ] **Step 6: Run plugin packaging validation**

Run: `npm pack --dry-run --json`

Expected: the package contains `src/review/`, updated Skill references, and no `dist/`, temporary review files, user-edited decks, or generated previews.

- [ ] **Step 7: Perform real Codex Desktop review acceptance**

Create a fresh controlled project candidate, publish its `ReviewArtifact`, open that exact absolute `.pptx` through the Codex host file viewer, and verify:

- left-side slide thumbnails match the PPTX page count;
- selecting pages changes the main canvas;
- zoom and download work;
- the WPS open action targets the same reviewed file;
- the file SHA remains unchanged after review-only use.

Record the candidate ID, review ID, revision ID, absolute path, and SHA-256 in the acceptance log. Do not treat a screenshot alone as proof.

- [ ] **Step 8: Perform real no-Codex/manual-edit acceptance**

Using the same controlled project, force `desktop-office`, open the owned full-deck manual-edit candidate in WPS, change one selected text alignment, save, inspect, confirm adoption, and promote. Reopen the promoted deck in WPS and verify the saved alignment remains exactly as the user set it. Confirm that no PNG, PDF, or montage was generated unless explicitly requested.

- [ ] **Step 9: Commit E2E coverage**

```bash
git add tests/e2e.test.ts tests/plugin-package.test.ts
git commit -m "test: cover portable pptx review end to end"
```

- [ ] **Step 10: Report acceptance separately from implementation**

The handoff must report:

```text
source tests: pass/fail count
compiled tests: pass/fail count
Codex Desktop native review: passed/pending with exact artifact SHA
desktop Office fallback: passed/pending with exact artifact SHA
manual save/adoption byte identity: passed/pending
direct WPS image fallback capability: available/unavailable; no PDF raster substitute
```

Do not claim live acceptance when only fixtures ran.
