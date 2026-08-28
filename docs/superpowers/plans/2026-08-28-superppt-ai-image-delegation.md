# SuperPPT AI Image Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SuperPPT a guided, revisable presentation orchestrator that passes one approved high-detail visual direction unchanged into `ai-image-to-ppt`, receives authenticated image results, supports selected-page editable reconstruction, and promotes a formal deck only after the user reviews the candidate.

**Architecture:** SuperPPT owns dialogue stages, revision invalidation, Style Lock, immutable generation jobs, call-budget accounting, result validation, presentation QA, candidate assembly, page replacement, and delivery evidence. The current Agent invokes the separately resolved `ai-image-to-ppt` Skill; SuperPPT never imports provider code or chooses image providers. `image-to-editable-pptx` remains a separate selected-page dependency. Every expensive action is bound to a user-approved artifact and every result is bound back to the exact project revision, job, prompt, Style Lock, dependency identity, and output hash.

**Tech Stack:** TypeScript 5.9 ESM on Node.js 22.6+, Zod 4, Sharp, PDF-Lib, JSZip, Node test runner, existing PPTX/WPS integration, external Codex Skills `ai-image-to-ppt` and `image-to-editable-pptx`.

**Spec:** [`docs/superpowers/specs/2026-08-28-superppt-ai-image-to-ppt-delegation-design.md`](../specs/2026-08-28-superppt-ai-image-to-ppt-delegation-design.md), extending [`docs/superpowers/specs/2026-08-26-superppt-design.md`](../specs/2026-08-26-superppt-design.md). This plan supersedes the Provider Bridge, `capabilities.json`, and direct provider-call portions of [`docs/superpowers/plans/2026-08-26-superppt-v1.md`](2026-08-26-superppt-v1.md).

## Global Constraints

- SuperPPT MUST NOT import or copy `ai-image-to-ppt` provider adapters, inspect API keys, select providers, or retry providers internally.
- The Agent MUST pass the already resolved Skill roots into SuperPPT. SuperPPT MUST NOT guess sibling repositories, `$HOME`, or fixed Codex installation paths.
- Style is single-select. The selected recipe is materialized once, then carried as a provisional/approved Style Lock. Deck, retry, and page-regeneration jobs require the approved lock.
- Every image job sets `applyDependencyDefaultStyle: false`. Provider/channel switches must reuse the job's exact final prompt and references.
- `art-direction` references cannot be silently dropped. An unsupported reference capability pauses the workflow for user direction.
- The style-sample call requires its own execution authorization. Deck generation requires a separate generation-authorization gate. No per-page confirmation is needed after that gate unless execution encounters a decision that changes intent or budget.
- The authorized call budget counts actual host/API generation requests, including failed requests. Discovery and preflight checks that make no generation request do not count.
- Output is a candidate until the user sees the montage and approves the deck-review gate. Candidate generation must not mutate `manifest.exports` or `outputRevisions`.
- Editable conversion is opt-in per selected page. Preserve the high-resolution master; create a separate exact 1280x720 PNG using `ai-image-to-ppt/scripts/prepare_editable_input.py` before invoking `image-to-editable-pptx`.
- WPS smoke testing uses an owned `acceptance-smoke-copy`, temporarily edits one selected object, undoes the edit, discards without saving, closes, reopens, and verifies the original. Never mutate the canonical deck.
- All project-relative artifact paths are normalized portable paths; all writes use existing no-follow, owned-directory, immutable-revision, and exclusive-promotion helpers.
- No installation, GitHub push, merge, release, or publication is authorized by this plan.

---

### Task 1: Extend the guided gate and stage model

**Files:**
- Modify: `src/project/schemas.ts`
- Modify: `src/project/evidence.ts`
- Modify: `src/planning/confirm.ts`
- Modify: `src/planning/views.ts`
- Modify: `tests/project-state.test.ts`
- Modify: `tests/planning.test.ts`
- Modify: `tests/workflow-contract.test.ts`

- [ ] **Step 1: Write failing tests for all required checkpoints**

Add test cases proving:

```ts
const ordinary = [
  "outline",
  "slide-specs",
  "style-sample",
  "generation-authorization",
  "deck-review",
] as const;

assert.deepEqual(ordinary.map(previousGate), [
  null,
  "outline",
  "slide-specs",
  "style-sample",
  "generation-authorization",
]);
assert.equal(await assertGateCurrent(root, "generation-authorization"), false);
assert.equal(await assertGateCurrent(root, "deck-review"), false);
```

Also assert that `style-sample-generation` is accepted as an execution-authorization record but is not treated as an ordinary content approval, and that revision changes invalidate all downstream gates while preserving upstream history.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```bash
node --import tsx --test --test-name-pattern='generation authorization|deck review|sample execution authorization|downstream gates' tests/project-state.test.ts tests/planning.test.ts tests/workflow-contract.test.ts
```

Expected: schema/type failures because the three new gate names and stages are not recognized.

- [ ] **Step 3: Add the gate vocabulary and evidence kinds**

Export these types from `src/planning/confirm.ts`:

```ts
export type OrdinaryGate =
  | "outline"
  | "slide-specs"
  | "style-sample"
  | "generation-authorization"
  | "deck-review";

export type ExecutionGate = "style-sample-generation";
export type ConditionalGate = "revision-impact" | "slide-preview";
export type ProjectGate = OrdinaryGate | ExecutionGate | ConditionalGate;
```

Extend the manifest stage enum with `style-sample`, `generation-authorization`, and `deck-review`. Extend `GateSchema.presentation.kind` with `generation-plan` and `deck-review`. Preserve the strict special-case validation for `revision-impact` and `slide-preview`.

Use this ordinary dependency chain:

```ts
export const previousOrdinaryGate: Record<OrdinaryGate, OrdinaryGate | null> = {
  outline: null,
  "slide-specs": "outline",
  "style-sample": "slide-specs",
  "generation-authorization": "style-sample",
  "deck-review": "generation-authorization",
};
```

Keep execution authorization in a separate helper so approving it does not pretend the generated sample already exists:

```ts
export async function approveExecutionGate(
  root: string,
  gate: ExecutionGate,
  evidencePath: string,
): Promise<void>;
```

- [ ] **Step 4: Bind new ordinary gates to published artifacts**

Teach `gateArtifacts()` and `currentPresentation()` to read:

```text
generation/authorization-plan.json
output/candidates/current/review.json
output/candidates/current/montage.jpg
```

The generation gate snapshot must bind the approved Style Lock hash, ordered page IDs, call budget, outbound content/reference disclosure, dependency identity, and revision. The deck-review snapshot must bind the candidate descriptor plus PPTX/PDF/montage hashes.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/project/schemas.ts src/project/evidence.ts src/planning/confirm.ts src/planning/views.ts tests/project-state.test.ts tests/planning.test.ts tests/workflow-contract.test.ts
git commit -m "feat: add generation and deck review gates"
```

---

### Task 2: Resolve Skill dependencies without provider discovery

**Files:**
- Modify: `src/dependencies/schemas.ts`
- Modify: `src/dependencies/resolve.ts`
- Modify: `src/dependencies/preflight.ts`
- Modify: `tests/dependencies.test.ts`

- [ ] **Step 1: Replace provider tests with Skill-identity tests**

Create temporary fake Skill roots containing exact required files. Assert the resolved AI dependency has this public shape:

```ts
const AiImageSkillDependencySchema = z.object({
  kind: z.literal("ai-image-to-ppt"),
  root: z.string().min(1),
  skillFile: z.string().min(1),
  skillSha256: Sha256Schema,
  gitRevision: z.string().min(1).nullable(),
  scripts: z.object({
    generationResult: z.string().min(1),
    hostRoutingPolicy: z.string().min(1),
    importHostImage: z.string().min(1),
    prepareEditableInput: z.string().min(1),
  }).strict(),
}).strict();
```

Add negative tests for a symlinked root, missing `SKILL.md`, missing required script, changed file after resolution, and any fallback to a sibling repo/fixed home path.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/dependencies.test.ts
```

Expected: tests fail because the resolver still expects `capabilities.json`, provider modules, and a default provider.

- [ ] **Step 3: Implement explicit Skill resolution**

Add the new resolver API alongside the legacy provider resolver so this commit remains buildable while Tasks 4-7 move generation callers:

```ts
export type ResolveDependencyRequest = {
  aiSkillRoot: string;
  editableSkillRoot: string;
};

export async function resolveSkillDependencies(
  request: ResolveDependencyRequest,
): Promise<ResolvedDependencies>;
```

Canonicalize roots with `realpath`, reject symlinked/unsafe required files, hash `SKILL.md`, and locate the four AI scripts relative to that canonical root. Preserve the existing explicit editable dependency validation, but rename its input from a source override to a resolved Skill root.

Do not execute `SKILL.md`, inspect provider credentials, or require a provider manifest. Mark the old provider resolver as internal/deprecated and remove it only in Task 10 after all callers have moved.

- [ ] **Step 4: Make preflight report identity and capability boundaries**

Return:

```ts
type DependencyPreflight = {
  ok: boolean;
  aiImageToPpt: {
    root: string;
    skillSha256: string;
    gitRevision: string | null;
    requiredScripts: Record<string, { path: string; sha256: string }>;
  };
  imageToEditablePptx: {
    root: string;
    skillSha256: string;
    version: string | null;
  };
  errors: Array<{ dependency: string; code: string; safeMessage: string }>;
};
```

Preflight is read-only and consumes zero image calls.

- [ ] **Step 5: Run GREEN without extending legacy routing**

```bash
node --import tsx --test tests/dependencies.test.ts
npm run lint:types
```

Expected: dependency tests and typecheck pass. No new code may call the legacy provider resolver.

- [ ] **Step 6: Commit**

```bash
git add src/dependencies tests/dependencies.test.ts
git commit -m "refactor: resolve image skills without provider bridge"
```

---

### Task 3: Materialize provisional and approved Style Locks

**Files:**
- Create: `src/styles/style-lock.ts`
- Modify: `src/styles/schemas.ts`
- Modify: `src/styles/catalog.ts`
- Modify: `src/styles/prompt-compiler.ts`
- Modify: `src/styles/sample-contract.ts`
- Modify: `src/styles/publication.ts`
- Modify: `tests/styles.test.ts`
- Modify: `tests/helpers/style-sample.ts`

- [ ] **Step 1: Write failing Style Lock lifecycle tests**

Cover single selection, exact recipe persistence, reference hashes, default-style disabling, approval transition, tamper detection, and revision binding:

```ts
const provisional = await createProvisionalStyleLock(root, {
  selection: { kind: "catalog", styleId: "scientific-atlas" },
  referenceArtifacts: [{ path: "style/references/map.png", role: "art-direction" }],
});
assert.equal(provisional.approvalState, "provisional");
assert.equal(provisional.applyDependencyDefaultStyle, false);
assert.equal(provisional.approvedSample, null);

const approved = await approveStyleLock(root);
assert.equal(approved.approvalState, "approved");
assert.equal(approved.approvedSample?.path, "style/sample/slide.png");
assert.notEqual(approved.styleLockSha256, provisional.styleLockSha256);
```

Also test that a deck job cannot consume a provisional lock and that changing the recipe, sample, or reference bytes invalidates the lock.

Add a second lifecycle case for a project-defined style created from a user description and optional reference images. It must produce the same complete `StyleRecipeSchema` and Style Lock as a catalog selection; downstream generation must not distinguish the two origins.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='Style Lock|provisional|approved|default style|reference hash' tests/styles.test.ts
```

Expected: module/API missing failures.

- [ ] **Step 3: Define strict schemas**

Implement:

```ts
export const StyleSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), styleId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal("custom"),
    name: z.string().min(1),
    description: z.string().min(1),
    recipe: StyleRecipeSchema,
  }).strict(),
]);

export const StyleReferenceSchema = z.object({
  path: z.string().startsWith("style/references/"),
  sha256: Sha256Schema,
  role: z.enum(["art-direction", "content-reference"]),
}).strict();

export const StyleLockSchema = z.object({
  contractVersion: z.literal(1),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  approvalState: z.enum(["provisional", "approved"]),
  recipe: StyleRecipeSchema,
  styleRecipeSha256: Sha256Schema,
  approvedSample: ArtifactSchema.nullable(),
  referenceArtifacts: z.array(StyleReferenceSchema),
  applyDependencyDefaultStyle: z.literal(false),
  createdAt: z.string().datetime(),
}).strict();
```

Serialize canonical JSON to `style/recipe.json` and `style/lock.json`. Catalog selection copies the exact catalog recipe; custom selection validates the Agent-authored complete recipe derived from the user's description/reference images. Compute `styleLockSha256` from the canonical file bytes and return it alongside the parsed lock rather than embedding a self-referential hash inside the document.

- [ ] **Step 4: Compile the complete art direction from the lock**

Change the prompt compiler to accept `StyleLock` rather than an independently reloaded catalog entry:

```ts
export function compileSlidePrompt(input: {
  spec: SlideSpec;
  styleLock: StyleLock;
  correction?: QualityCorrection;
}): { text: string; sha256: string };
```

The prompt must include palette, materials, lighting, medium, typography, detail language, composition rules, page-role variant, forbidden list, exact required text, and the explicit instruction that dependency default style must not be appended. Corrections append only page-specific quality fixes; they cannot mutate the locked recipe.

- [ ] **Step 5: Promote provisional to approved only from the accepted sample**

`approveStyleLock(root)` must require a current `style-sample` gate, authenticate `style/sample/slide.png`, and atomically replace `style/lock.json`. Re-running with the same sample is idempotent; changing the sample or revision requires a new gate and lock.

- [ ] **Step 6: Run GREEN**

```bash
node --import tsx --test tests/styles.test.ts
npm run lint:types
```

- [ ] **Step 7: Commit**

```bash
git add src/styles tests/styles.test.ts tests/helpers/style-sample.ts
git commit -m "feat: persist approved style locks"
```

---

### Task 4: Add immutable image-generation jobs and call-budget authorization

**Files:**
- Create: `src/generation/job-schemas.ts`
- Create: `src/generation/jobs.ts`
- Create: `src/generation/authorization.ts`
- Modify: `src/generation/private-input.ts`
- Modify: `tests/generation.test.ts`
- Modify: `tests/planning.test.ts`

- [ ] **Step 1: Write failing contract tests**

Test all job kinds and the authorization boundary:

```ts
export const ImageJobKindSchema = z.enum([
  "style-sample",
  "deck",
  "page-regeneration",
]);

const job = await prepareImageGenerationJob(root, {
  kind: "deck",
  aiDependency,
});
assert.equal(job.styleLock.approvalState, "approved");
assert.equal(job.pages.length, 3);
assert.equal(job.callBudget, 3);
assert.equal(job.pages[0]!.promptSha256, sha256(job.pages[0]!.finalPrompt));
```

Test rejection when approval is absent/stale, a page is unordered, budget is smaller than the initial page count, a page prompt is mutated after job publication, or a page-regeneration job tries to reuse the old prompt hash.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='image generation job|call budget|generation authorization' tests/generation.test.ts tests/planning.test.ts
```

- [ ] **Step 3: Define the immutable job**

Implement the exact top-level contract:

```ts
export const ImageGenerationJobSchema = z.object({
  contractVersion: z.literal(1),
  jobId: z.string().uuid(),
  kind: ImageJobKindSchema,
  projectId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  authorizationDigest: Sha256Schema,
  routePolicy: z.literal("ai-image-to-ppt-default"),
  aiSkill: z.object({
    root: z.string().min(1),
    skillSha256: Sha256Schema,
    gitRevision: z.string().nullable(),
  }).strict(),
  styleLockPath: z.literal("style/lock.json"),
  styleLockSha256: Sha256Schema,
  styleLock: StyleLockSchema,
  callBudget: z.number().int().positive(),
  outboundDisclosure: z.object({
    sendsText: z.literal(true),
    references: z.array(StyleReferenceSchema),
  }).strict(),
  pages: z.array(z.object({
    slideId: z.string().uuid(),
    order: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    promptArtifact: z.string().startsWith("slides/"),
    finalPrompt: z.string().min(1),
    promptSha256: Sha256Schema,
    target: z.string().startsWith("generation/jobs/"),
  }).strict()).min(1),
  createdAt: z.string().datetime(),
}).strict();
```

Write canonical jobs exclusively under `generation/jobs/<jobId>/job.json`; never overwrite them.

- [ ] **Step 4: Publish and approve generation plans**

Add:

```ts
export async function publishGenerationAuthorizationPlan(
  root: string,
  request: { aiDependency: AiImageSkillDependency; callBudget: number },
): Promise<GenerationAuthorizationPlan>;

export async function assertJobAuthorized(
  root: string,
  job: ImageGenerationJob,
): Promise<void>;
```

For `style-sample`, bind `style/sample/generation-plan.json` to the `style-sample-generation` execution gate and require budget `1`. For `deck`, bind `generation/authorization-plan.json` to the ordinary `generation-authorization` gate. For `page-regeneration`, require explicit incremental authorization if no unspent calls remain.

- [ ] **Step 5: Make call-budget accounting explicit**

Store an append-only ledger at `generation/call-ledger.jsonl` with:

```ts
type CallLedgerEntry = {
  jobId: string;
  slideId: string;
  attempt: number;
  requestOrdinal: number;
  outcome: "success" | "failed";
  recordedAt: string;
};
```

Only a recorded actual generation request consumes budget. Ensure duplicate result ingestion cannot double-count the same `(jobId,slideId,attempt,requestOrdinal)` tuple.

- [ ] **Step 6: Run GREEN**

```bash
node --import tsx --test tests/generation.test.ts tests/planning.test.ts
npm run lint:types
```

- [ ] **Step 7: Commit**

```bash
git add src/generation/job-schemas.ts src/generation/jobs.ts src/generation/authorization.ts src/generation/private-input.ts tests/generation.test.ts tests/planning.test.ts
git commit -m "feat: authorize immutable image generation jobs"
```

---

### Task 5: Authenticate `ai-image-to-ppt` results and routing reports

**Files:**
- Create: `src/generation/delegation-result.ts`
- Modify: `src/generation/schemas.ts`
- Modify: `src/generation/anchored-dir.ts`
- Modify: `src/generation/quality.ts`
- Modify: `tests/generation.test.ts`
- Add: `tests/fixtures/fake_ai_skill_result.json`

- [ ] **Step 1: Write failing result-ingestion tests**

Cover the dependency's current `GenerationResult` statuses:

```ts
const statuses = [
  "success",
  "unavailable",
  "auth_unavailable",
  "retryable_exhausted",
  "policy_refused",
  "invalid_input",
  "invalid_output",
  "local_failure",
] as const;
```

Assert success requires an authenticated raw/master artifact, exact prompt hash, Style Lock hashes, reference usage, and a matching `SerialStickyRouter.report()`. Assert every failed actual request consumes one call. Assert `art-direction: unsupported` returns a paused decision and cannot be accepted.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='delegated result|routing report|unsupported art direction|actual request' tests/generation.test.ts
```

- [ ] **Step 3: Implement dependency result schemas**

Parse, do not reimplement, the dependency result:

```ts
export const DependencyGenerationResultSchema = z.object({
  status: z.enum(statuses),
  provider: z.string().min(1).nullable(),
  channel: z.string().min(1).nullable(),
  output_path: z.string().min(1).nullable(),
  safe_message: z.string().min(1),
}).strict();
```

Parse the router report as `serial` pages/switches evidence. Do not derive or override provider choices from it.

- [ ] **Step 4: Define SuperPPT's authenticated result record**

Write each intake record to `generation/jobs/<jobId>/results/<slideId>-<attempt>.json`, then atomically rebuild the job-level `generation/jobs/<jobId>/result.json`:

```ts
export const ImagePageResultSchema = z.object({
  contractVersion: z.literal(1),
  jobId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  slideId: z.string().uuid(),
  attempt: z.number().int().positive(),
  requestCount: z.number().int().min(0),
  status: z.enum(["success", "cached", "failed", "paused"]),
  dependency: DependencyGenerationResultSchema,
  actualPromptSha256: Sha256Schema,
  styleLockSha256: Sha256Schema,
  styleRecipeSha256: Sha256Schema,
  referenceUsage: z.array(z.object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    usage: z.enum(["used", "unsupported"]),
  }).strict()),
  artifacts: z.object({
    raw: ArtifactSchema.nullable(),
    master: ArtifactSchema,
    normalized: ArtifactSchema,
  }).strict().nullable(),
  styleConsistency: z.enum(["accepted", "rejected", "not-reviewed"]),
  recordedAt: z.string().datetime(),
}).strict();

export const ImageGenerationResultSchema = z.object({
  contractVersion: z.literal(1),
  jobId: z.string().uuid(),
  projectRevisionId: z.string().uuid(),
  styleRecipeSha256: Sha256Schema,
  approvedSampleSha256: Sha256Schema.nullable(),
  outcome: z.enum(["success", "partial", "fatal", "exhausted", "attention-required"]),
  actualRequestCount: z.number().int().nonnegative(),
  batchReport: SerialStickyReportSchema,
  pages: z.array(ImagePageResultSchema),
  updatedAt: z.string().datetime(),
}).strict();
```

Require `ai-image-to-ppt` to have already generated/imported raw and master artifacts into the job-owned target directory. SuperPPT only authenticates and preserves those bytes, then derives a separate exact 1920x1080 PNG with Sharp; it never invokes or duplicates the host image importer. Require a raw artifact for `channel:"host"`; permit `raw:null` for API success exactly as the dependency contract allows.

- [ ] **Step 5: Validate identity and idempotence**

`recordDelegatedResult()` must re-read and authenticate `job.json`, Style Lock, prompt, references, dependency Skill hash, output bytes, and router report before any manifest update. An identical replay returns the existing record; a conflicting replay fails. A revision change leaves the immutable result recorded but does not attach it to the current manifest.

- [ ] **Step 6: Keep presentation QA in SuperPPT**

Update quality evidence so `styleConsistency` compares the normalized page against the approved sample and page-role rules. The dependency proves prompt/reference use; SuperPPT decides visual acceptance. A corrective decision creates a new job in Task 6; it never causes an internal provider retry.

- [ ] **Step 7: Run GREEN**

```bash
node --import tsx --test tests/generation.test.ts
npm run lint:types
```

- [ ] **Step 8: Commit**

```bash
git add src/generation/delegation-result.ts src/generation/schemas.ts src/generation/anchored-dir.ts src/generation/quality.ts tests/generation.test.ts tests/fixtures/fake_ai_skill_result.json
git commit -m "feat: authenticate delegated image results"
```

---

### Task 6: Replace direct style-sample generation with a delegated sample job

**Files:**
- Modify: `src/generation/style-sample.ts`
- Modify: `src/styles/sample-contract.ts`
- Modify: `src/planning/views.ts`
- Modify: `tests/generation.test.ts`
- Modify: `tests/planning.test.ts`

- [ ] **Step 1: Write the failing sample state-machine test**

Exercise this exact sequence:

```ts
await createProvisionalStyleLock(root, selection);
await publishStyleSampleGenerationPlan(root, { aiDependency, callBudget: 1 });
await assert.rejects(() => prepareStyleSampleJob(root, aiDependency), /authorization/);
await approveExecutionGate(root, "style-sample-generation", "style/sample/generation-plan.json");
const job = await prepareStyleSampleJob(root, aiDependency);
await recordDelegatedResult(root, job, dependencyResult, routerReport);
await publishStyleSample(root);
await approveGate(root, "style-sample");
const approved = await approveStyleLock(root);
assert.equal(approved.approvalState, "approved");
```

Assert no later step runs if the one-call budget is spent on a failed generation.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='delegated style sample|sample generation plan|one-call' tests/generation.test.ts tests/planning.test.ts
```

- [ ] **Step 3: Turn `style-sample.ts` into orchestration only**

Remove imports of `provider.ts` and `bridge-process.ts`. Export:

```ts
export async function prepareStyleSampleJob(
  root: string,
  aiDependency: AiImageSkillDependency,
): Promise<ImageGenerationJob>;

export async function finalizeStyleSample(
  root: string,
  jobId: string,
): Promise<StyleSampleArtifacts>;
```

`finalizeStyleSample` copies only an accepted, authenticated normalized artifact into `style/sample/slide.png`, writes the prompt/ledger artifacts required by the current sample contract, and never calls an image API.

- [ ] **Step 4: Make the user-facing sample publication precede approval**

`publishStyleSample()` must continue generating a view descriptor that the Agent can show. The Agent then asks the user whether to keep the style, revise the style recipe, or regenerate a new sample with separately authorized budget.

- [ ] **Step 5: Run GREEN**

```bash
node --import tsx --test tests/generation.test.ts tests/planning.test.ts tests/styles.test.ts
npm run lint:types
```

- [ ] **Step 6: Commit**

```bash
git add src/generation/style-sample.ts src/styles/sample-contract.ts src/planning/views.ts tests/generation.test.ts tests/planning.test.ts
git commit -m "refactor: delegate style sample generation"
```

---

### Task 7: Replace internal batch generation with serial delegated deck jobs

**Files:**
- Modify: `src/generation/batch.ts`
- Modify: `src/generation/abandoned.ts`
- Modify: `tests/generation.test.ts`

- [ ] **Step 1: Write failing serial-delegation and resume tests**

Add tests proving:

- `prepareDeckJob()` requires current outline, slide-specs, style-sample, and generation-authorization gates.
- The approved Style Lock and exact page prompts are copied into the immutable job.
- Pages are ordered and handled serially; there is no `concurrency` option.
- Accepted pages resume without another request.
- Provider/channel switches in the router report do not change `promptSha256`.
- A rejected quality result produces a new `page-regeneration` job with the same Style Lock hash and a new prompt hash.
- No result path can spend more than the authorized call budget.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='serial delegated deck|resume delegated|page regeneration|provider switch|authorized budget' tests/generation.test.ts
```

- [ ] **Step 3: Replace the batch API**

Remove `runBatch`, provider execution, and concurrency. Export orchestration APIs:

```ts
export async function prepareDeckJob(
  root: string,
  aiDependency: AiImageSkillDependency,
): Promise<ImageGenerationJob>;

export async function describeProjectGeneration(
  root: string,
): Promise<GenerationProgress>;

export async function preparePageRegenerationJob(
  root: string,
  request: {
    slideId: string;
    rejectedResultPath: string;
    correction: QualityCorrection;
  },
): Promise<ImageGenerationJob>;
```

`GenerationProgress` reports ordered page status, calls authorized/consumed/remaining, current job, paused capability decisions, and authenticated artifact paths. It does not report a SuperPPT-selected provider.

Keep the old direct-generation exports temporarily isolated and marked deprecated so the still-unmigrated CLI and legacy tests compile. They are removed with their bridge files in Task 10, immediately after the CLI is switched.

- [ ] **Step 4: Attach only accepted results to slide records**

Set `slide.image` and `slide.finalRender` from authenticated normalized result artifacts. Store provider/channel only in result/acceptance evidence, not as SuperPPT routing state. Keep abandoned job cleanup restricted to owned staging; immutable published jobs and results are audit records.

- [ ] **Step 5: Run GREEN and prove the new path does not import the bridge**

```bash
node --import tsx --test tests/generation.test.ts
! rg -n 'bridge-process|providerRunner|concurrency' src/generation/jobs.ts src/generation/delegation-result.ts src/generation/authorization.ts
npm run lint:types
```

- [ ] **Step 6: Commit**

```bash
git add src/generation tests/generation.test.ts
git commit -m "refactor: use serial delegated deck jobs"
```

---

### Task 8: Assemble candidates first and promote only after deck review

**Files:**
- Modify: `src/deck/assemble.ts`
- Modify: `src/acceptance/build.ts`
- Modify: `src/acceptance/schema.ts`
- Modify: `src/project/promotion.ts`
- Modify: `tests/deck.test.ts`
- Modify: `tests/publication.test.ts`
- Modify: `tests/e2e.test.ts`
- Modify: `tests/mixed-deck.test.ts`

- [ ] **Step 1: Write failing candidate/promotion tests**

Assert:

```ts
const candidate = await assembleProjectCandidate(root);
const before = await readProject(root);
assert.equal(before.exports.pptx, null);
assert.equal(before.outputRevisions?.length ?? 0, 0);
assert.match(candidate.destination, /output\/candidates\//);

await publishDeckReview(root, candidate.candidateId);
await assert.rejects(() => promoteApprovedCandidate(root, candidate.candidateId), /deck-review/);
await approveGate(root, "deck-review");
const delivery = await promoteApprovedCandidate(root, candidate.candidateId);
assert.equal(delivery.revisionNumber, 1);
```

Also test candidate tampering, stale revision, wrong candidate approval, concurrent promotion, and returning upstream without altering formal outputs.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='candidate|deck review|formal output|promote approved' tests/deck.test.ts tests/publication.test.ts tests/e2e.test.ts tests/mixed-deck.test.ts
```

- [ ] **Step 3: Split assembly from promotion**

Replace the direct `assembleProject()` side effect with:

```ts
export async function assembleProjectCandidate(root: string): Promise<{
  candidateId: string;
  destination: string;
  artifacts: { pptx: Artifact; pdf: Artifact; montage: Artifact; acceptance: Artifact };
}>;

export async function publishDeckReview(
  root: string,
  candidateId: string,
): Promise<DeckReviewDescriptor>;

export async function promoteApprovedCandidate(
  root: string,
  candidateId: string,
): Promise<AssembleProjectResult>;
```

Candidates live at `output/candidates/<candidateId>/`; the user-visible pointer is `output/candidates/current/review.json`. Promotion authenticates the review descriptor and gate snapshot, then uses the existing exclusive revision destination semantics.

Retain a deprecated `assembleProject()` wrapper only until Task 10 so the old CLI remains buildable in this intermediate commit. New code and tests must use the candidate APIs. Task 10 removes the wrapper.

- [ ] **Step 4: Preserve user choices after candidate review**

The deck-review publication must explicitly expose three outcomes to the Skill layer: `edit-page`, `return-upstream`, and `confirm-delivery`. Only `confirm-delivery` maps to `approveGate("deck-review")` and promotion.

- [ ] **Step 5: Run GREEN**

```bash
node --import tsx --test tests/deck.test.ts tests/publication.test.ts tests/e2e.test.ts tests/mixed-deck.test.ts
npm run lint:types
```

- [ ] **Step 6: Commit**

```bash
git add src/deck/assemble.ts src/acceptance/build.ts src/acceptance/schema.ts src/project/promotion.ts tests/deck.test.ts tests/publication.test.ts tests/e2e.test.ts tests/mixed-deck.test.ts
git commit -m "feat: review deck candidates before promotion"
```

---

### Task 9: Bind selected-page editability and replacement to the approved deck

**Files:**
- Modify: `src/editable/adapter.ts`
- Modify: `src/editable/schemas.ts`
- Modify: `src/editable/render.ts`
- Modify: `src/deck/assemble.ts`
- Modify: `tests/editable.test.ts`
- Modify: `tests/mixed-deck.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Assert that conversion:

- accepts only a selected, current, authenticated 1920x1080 page master;
- calls the resolved `prepare_editable_input.py` path rather than reimplementing provider generation;
- creates a separate exact 1280x720 PNG without touching raw/master/normalized images;
- validates `image-to-editable-pptx` output and preview before replacement;
- invalidates the old candidate and deck-review gate after a page is replaced;
- preserves other slides and the approved Style Lock.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='prepare editable input|selected page|candidate invalidation|approved style lock' tests/editable.test.ts tests/mixed-deck.test.ts
```

- [ ] **Step 3: Record the external preparation invocation**

Extend the conversion ledger with:

```ts
prepareEditableInput: {
  scriptPath: string;
  scriptSha256: string;
  sourceMaster: Artifact;
  output1280x720: Artifact;
};
```

Execute only the script resolved and hashed during preflight. Re-authenticate it immediately before invocation. Treat nonzero exit, invalid JSON, wrong dimensions, symlinked output, or output outside the owned conversion revision as a safe failure.

- [ ] **Step 4: Invalidate and rebuild candidates after replacement**

After `slide-preview` approval and replacement, clear candidate pointers and downstream `deck-review` currency. The user can inspect the new page preview, rebuild the candidate, and confirm delivery; no upstream outline/style reconfirmation is needed unless the change request actually invalidated those stages.

- [ ] **Step 5: Run GREEN**

```bash
node --import tsx --test tests/editable.test.ts tests/mixed-deck.test.ts
npm run lint:types
```

- [ ] **Step 6: Commit**

```bash
git add src/editable src/deck/assemble.ts tests/editable.test.ts tests/mixed-deck.test.ts
git commit -m "feat: bind selected page edits to reviewed decks"
```

---

### Task 10: Update CLI routes for Agent-mediated delegation

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/dependencies/schemas.ts`
- Modify: `src/dependencies/resolve.ts`
- Modify: `src/dependencies/preflight.ts`
- Modify: `src/generation/batch.ts`
- Delete: `src/generation/provider.ts`
- Delete: `src/generation/bridge-process.ts`
- Delete: `scripts/run_ai_image_provider.py`
- Modify: `tests/project-state.test.ts`
- Modify: `tests/plugin-package.test.ts`
- Modify: `tests/dependencies.test.ts`
- Modify: `tests/generation.test.ts`
- Delete: `tests/fixtures/fake_ai_provider.py`
- Modify: `package.json`

- [ ] **Step 1: Write failing strict-route tests**

The final CLI surface must include:

```text
preflight --ai-skill <resolved-root> --editable-skill <resolved-root>
publish-sample-generation-plan --project <root> --ai-skill <root>
approve --project <root> --gate style-sample-generation
prepare-style-sample-job --project <root> --ai-skill <root>
record-image-result --project <root> --job <job.json> --result <result.json> --route-report <report.json>
finalize-style-sample --project <root> --job-id <uuid>
publish-style-sample --project <root>
approve --project <root> --gate style-sample
publish-generation-plan --project <root> --ai-skill <root> --call-budget <n>
approve --project <root> --gate generation-authorization
prepare-deck-job --project <root> --ai-skill <root>
prepare-page-regeneration-job --project <root> --request <private-json>
generation-status --project <root>
assemble-candidate --project <root>
publish-deck-review --project <root> --candidate-id <uuid>
approve --project <root> --gate deck-review
promote-delivery --project <root> --candidate-id <uuid>
```

Reject `generate-style-sample`, `generate`, `retry-page`, `--concurrency`, provider flags, and dependency environment-variable-only configuration.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='delegation CLI|strict CLI|removed provider routes' tests/project-state.test.ts tests/plugin-package.test.ts
```

- [ ] **Step 3: Implement strict argument parsing and private inputs**

Every command accepts only documented flags. Result files and page-regeneration requests must be regular no-follow files; sensitive request files require mode `0600` on POSIX. `preflight` must use command arguments, not `SUPERPPT_AI_IMAGE_TO_PPT_SOURCE` or sibling path discovery.

The CLI prints job/result JSON for the Agent to consume but never runs the dependency Skill itself. This preserves the Skill-to-Skill orchestration boundary.

After the new routes pass, remove the deprecated provider resolver, direct-generation exports, `assembleProject()` wrapper, Provider Bridge modules/script, fake provider fixture, and their legacy tests. Keep only migration-safe parsing for already persisted attempt ledgers; no executable provider path remains.

- [ ] **Step 4: Run GREEN**

```bash
node --import tsx --test tests/project-state.test.ts tests/plugin-package.test.ts
node --import tsx --test tests/dependencies.test.ts tests/generation.test.ts
! rg -n 'run_ai_image_provider|providerRunner|bridge-process|defaultProvider|--concurrency' src scripts tests
npm run lint:types
```

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/dependencies src/generation src/deck/assemble.ts scripts/run_ai_image_provider.py tests/project-state.test.ts tests/plugin-package.test.ts tests/dependencies.test.ts tests/generation.test.ts tests/fixtures/fake_ai_provider.py package.json
git commit -m "feat: expose agent mediated image job routes"
```

---

### Task 11: Rewrite the SuperPPT Skill as a guided conversation

**Files:**
- Modify: `skills/superppt/SKILL.md`
- Modify: `skills/superppt/references/阶段契约.json`
- Modify: `skills/superppt/references/门禁清单.md`
- Modify: `skills/superppt/references/依赖说明.md`
- Modify: `skills/superppt/references/修改路由.md`
- Modify: `skills/superppt/references/工作区契约.md`
- Modify: `skills/superppt/agents/openai.yaml`
- Modify: `tests/workflow-contract.test.ts`
- Modify: `tests/plugin-package.test.ts`

- [ ] **Step 1: Write failing behavioral-contract tests**

Require the Skill text/contracts to contain these interaction rules:

```text
内容导入/描述 -> 针对内容追问 -> 大纲确认 -> 逐页描述确认
-> 紧凑单选风格 -> 样页调用授权 -> 样页确认
-> 整套生成授权 -> 串行生成 -> 候选稿/Montage 审阅
-> 修改某页 / 返回前序 / 确认交付
```

Tests must reject language that permits silent end-to-end completion, multi-select style, per-page parallel generation, dependency default style, direct provider selection, or formal delivery before deck review.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/workflow-contract.test.ts tests/plugin-package.test.ts
```

- [ ] **Step 3: Rewrite the orchestration instructions**

The Skill must:

1. Ask content-specific questions, not generic “confirm?” only.
2. Present compact high-detail style cards and accept exactly one selection.
3. Tell the user what text/references will be sent before each paid/external generation authorization.
4. Resolve and read `ai-image-to-ppt/SKILL.md`, pass the immutable job's exact prompts/references, then feed its structured output back through `record-image-result`.
5. Never ask the user to re-describe an approved style on provider/channel changes.
6. Stop and explain when an `art-direction` reference is unsupported.
7. Let the user revisit any earlier stage; publish impact, invalidate only downstream artifacts, and ask for reconfirmation at the first changed gate.
8. Show the montage before delivery and offer `修改某页 / 返回前序 / 确认交付`.
9. Convert only the selected page when editability is needed.

- [ ] **Step 4: Update the stage contract**

Make `阶段契约.json` machine-checkable with five ordinary gates, one sample execution authorization, and two conditional gates. Every stage entry must identify its inputs, user-visible artifact, allowed next actions, invalidation dependencies, and whether it can spend image calls.

- [ ] **Step 5: Correct WPS smoke wording**

Replace any instruction that says to save the edited smoke copy with: temporarily edit one chosen text/object, verify the change is visible, undo, discard/no-save, close, reopen, and verify the original. Record the observed object, undo result, discard result, and reopen result.

- [ ] **Step 6: Run GREEN**

```bash
node --import tsx --test tests/workflow-contract.test.ts tests/plugin-package.test.ts
node scripts/verify-contract.mjs
```

- [ ] **Step 7: Commit**

```bash
git add skills/superppt tests/workflow-contract.test.ts tests/plugin-package.test.ts
git commit -m "docs: guide users through SuperPPT checkpoints"
```

---

### Task 12: Change client acceptance to undo/discard/reopen evidence

**Files:**
- Modify: `src/acceptance/schema.ts`
- Modify: `src/acceptance/smoke-copy.ts`
- Modify: `src/acceptance/build.ts`
- Modify: `src/project/schemas.ts`
- Modify: `src/project/store.ts`
- Modify: `src/deck/assemble.ts`
- Modify: `tests/deck.test.ts`
- Modify: `scripts/acceptance-smoke.sh`

- [ ] **Step 1: Write failing acceptance-evidence tests**

Replace `savedCopySha256`-driven success with explicit observation evidence:

```ts
const observation = {
  application: "WPS",
  selectedObject: "slide-2:title",
  temporaryEditObserved: true,
  undoObserved: true,
  saveDecision: "discarded",
  reopenObserved: true,
  reopenedCopySha256: initialCopy.sha256,
};
```

Reject saved modifications, missing undo, missing discard confirmation, hash mismatch after reopen, canonical deck edits, and a smoke copy that was never reopened.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test --test-name-pattern='undo|discard|reopen|canonical deck' tests/deck.test.ts
```

- [ ] **Step 3: Implement the new anchor completion contract**

Change the smoke anchor completion fields to:

```ts
observation: ArtifactSchema | null;
reopenedCopySha256: Sha256Schema | null;
acceptanceRecord: ArtifactSchema | null;
completedAt: z.string().datetime().nullable();
```

Completed state requires all fields, `saveDecision:"discarded"`, and reopened hash equal to the initial copy hash. The canonical source artifact must still authenticate unchanged.

- [ ] **Step 4: Update the manual smoke helper**

Make `scripts/acceptance-smoke.sh` create/locate the owned smoke copy and print the exact Chinese checklist. It must not automate UI edits or claim acceptance by itself.

- [ ] **Step 5: Run GREEN**

```bash
node --import tsx --test tests/deck.test.ts
npm run lint:types
```

- [ ] **Step 6: Commit**

```bash
git add src/acceptance src/project/schemas.ts src/project/store.ts src/deck/assemble.ts tests/deck.test.ts scripts/acceptance-smoke.sh
git commit -m "fix: require discard and reopen WPS evidence"
```

---

### Task 13: Rewrite offline acceptance around the real delegation contract

**Files:**
- Modify: `src/acceptance/offline.ts`
- Modify: `src/acceptance/current.ts`
- Modify: `tests/e2e.test.ts`
- Modify: `tests/fixtures/e2e/build.mjs`
- Add: `tests/fixtures/e2e/fake-ai-image-to-ppt/SKILL.md`
- Add: `tests/fixtures/e2e/fake-ai-image-to-ppt/scripts/generation_result.py`
- Add: `tests/fixtures/e2e/fake-ai-image-to-ppt/scripts/host_routing_policy.py`
- Add: `tests/fixtures/e2e/fake-ai-image-to-ppt/scripts/import_host_image.py`
- Add: `tests/fixtures/e2e/fake-ai-image-to-ppt/scripts/prepare_editable_input.py`

- [ ] **Step 1: Write the end-to-end failing scenario**

The fixture must execute a three-slide, synthetic, non-private workflow with exactly four simulated generation requests:

1. ingest content and confirm outline;
2. confirm slide specs;
3. single-select a high-detail style;
4. authorize one sample request and record it;
5. approve the sample and approved Style Lock;
6. authorize three deck requests and record them serially;
7. assemble a candidate and verify formal exports remain empty;
8. review the montage and approve delivery;
9. convert/edit/preview/replace one page;
10. rebuild/review/promote the mixed deck;
11. record undo/discard/reopen WPS evidence on a smoke copy.

Assert `requestCount === 4`, all page results share the approved recipe/sample hashes, and the edited page is the only editable page.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/e2e.test.ts
```

Expected: fixture still creates `capabilities.json` and calls the fake provider bridge.

- [ ] **Step 3: Build a fake Skill, not a fake provider**

The fixture Skill mirrors only the public files and structured outputs used by SuperPPT. It must not be imported as a TypeScript module. Test code plays the Agent role: read job JSON, produce dependency `GenerationResult` and router report fixtures, then call SuperPPT result ingestion.

- [ ] **Step 4: Make acceptance validate the new evidence**

`current.ts` must authenticate gate chain, approved Style Lock, job/result/call ledgers, candidate/review/promotion binding, mixed-page records, and WPS discard/reopen evidence. Remove provider-manifest assumptions.

- [ ] **Step 5: Run GREEN**

```bash
node --import tsx --test tests/e2e.test.ts
npm run lint:types
```

- [ ] **Step 6: Commit**

```bash
git add src/acceptance tests/e2e.test.ts tests/fixtures/e2e
git commit -m "test: accept SuperPPT delegation end to end"
```

---

### Task 14: Full regression, design conformance, and authorized real acceptance

**Files:**
- Modify: `README.md`
- Modify: `.gitignore`
- Verify: `docs/superpowers/specs/2026-08-28-superppt-ai-image-to-ppt-delegation-design.md`
- Verify: `docs/superpowers/specs/2026-08-26-superppt-design.md`
- Create during acceptance only: `.artifacts/real-acceptance/` (gitignored)

- [ ] **Step 1: Run the complete automated suite**

First load the current Codex workspace dependencies and inject the returned paths. The paths below are the verified bundle for this plan-writing session; refresh them if the bundle version changes:

```bash
SUPERPPT_RUNTIME_NODE=/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
SUPERPPT_RUNTIME_MODULES=/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules
SUPERPPT_RUNTIME_BIN=/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override
export RUNTIME_NODE="$SUPERPPT_RUNTIME_NODE"
export RUNTIME_NODE_MODULES="$SUPERPPT_RUNTIME_MODULES"
export RUNTIME_BIN_DIR="$SUPERPPT_RUNTIME_BIN"
npm test
npm run lint:types
npm run build
npm run test:compiled
node scripts/verify-contract.mjs
```

Expected: all commands exit 0. Investigate any existing baseline failure instead of masking it or weakening assertions.

- [ ] **Step 2: Prove obsolete architecture is absent**

```bash
! rg -n 'capabilities\.json|run_ai_image_provider|Provider Bridge|providerRunner|defaultProvider|--concurrency' src scripts skills tests
rg -n 'Style Lock|applyDependencyDefaultStyle|generation-authorization|deck-review|art-direction|call budget' src skills tests
```

Expected: first command finds no runtime references; second finds implementation and behavioral coverage.

- [ ] **Step 3: Review spec coverage line by line**

Create a temporary checklist outside tracked docs and map every requirement in both specs to code plus at least one test. Specifically verify: guided interaction, revisable upstream stages, single-select rich style, exact Style Lock handoff, serial sticky dependency boundary, unsupported references, budget accounting, candidate review, selected-page editability, and WPS discard/reopen evidence.

- [ ] **Step 4: Run the already-authorized real acceptance within budget**

Use synthetic non-private three-slide content. Resolve the current installed/local Skill roots through the active Agent session, preflight them, and make at most four actual image requests total: one style sample plus three deck pages. Run serially. Do not automatically retry a failed request; record the spent call and stop if the remaining budget cannot complete the accepted scope.

Capture under the gitignored acceptance directory:

```text
preflight.json
style/recipe.json
style/lock.json
generation/jobs/*/job.json
generation/jobs/*/results/*.json
generation/call-ledger.jsonl
candidate/deck.pptx
candidate/deck.pdf
candidate/montage.jpg
acceptance.json
wps-observation.json
```

- [ ] **Step 5: Perform the real WPS smoke check**

Open only the owned smoke copy. Temporarily edit one selected text/object, verify it changes, undo, discard without saving, close, reopen, and verify the original. Record application/version if visible, selected object, the four observations, and hashes. Keep the canonical candidate/delivery untouched.

- [ ] **Step 6: Report states separately**

Report automated tests, real host image generation, editable-page reconstruction, candidate review, WPS smoke, local branch/HEAD, working-tree cleanliness, and the fact that no push/install/release occurred. Do not call an automated fixture “real acceptance.”

- [ ] **Step 7: Final commit**

```bash
git add .gitignore README.md docs/superpowers/specs src tests skills scripts package.json
git commit -m "feat: complete SuperPPT guided image delegation"
git status --short
```

Expected: the final `git status --short` is empty; acceptance artifacts remain ignored and uncommitted.

---

## Completion Criteria

- The user is guided through content questions and each material confirmation; SuperPPT cannot silently go from input to delivery.
- Exactly one rich style is selected, persisted, sampled, approved, and handed unchanged to every deck/retry/edit regeneration job.
- `ai-image-to-ppt` owns all image provider/channel routing and image creation; SuperPPT has no provider execution path.
- Actual calls never exceed the approved budget and failures count correctly.
- Formal output is promoted only after the user reviews the candidate montage and confirms delivery.
- Earlier stages remain revisable with downstream-only invalidation.
- Only selected pages take the editable reconstruction route; the assembled mixed deck retains the other high-fidelity image pages.
- WPS evidence proves temporary editability plus undo/discard/reopen without mutating canonical output.
- Full automated tests, compiled tests, contract verification, and bounded real acceptance all pass with auditable artifacts.
