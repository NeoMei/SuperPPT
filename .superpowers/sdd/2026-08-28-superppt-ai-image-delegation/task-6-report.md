# Task 6 report: delegated style-sample job

## Result

Replaced the direct provider-backed style-sample API with two orchestration APIs:

- `prepareStyleSampleJob(root, aiDependency)` verifies the separately approved `style-sample-generation` execution gate and rejects a spent one-call authorization.
- `finalizeStyleSample(root, jobId)` authenticates the immutable style-sample job, exact durable admission/result, normalized artifact bytes, provisional Style Lock, prompt, and reference binding. It then writes only the canonical style sample artifacts; it never invokes a model or provider.

The resulting sample remains `not-reviewed` and never attaches to a deck page. It is published for the user before `style-sample` gate approval and Style Lock promotion. `readPublishedStyleSample()` reports the three Agent-facing choices: `keep-style`, `revise-style-recipe`, and `authorize-new-sample`.

## TDD evidence

1. Added the delegated sample state-machine and spent-failure tests in `tests/generation.test.ts` before the new API existed.
2. RED command:

   ```bash
   node --import tsx --test --test-name-pattern='delegated style sample|sample generation plan|one-call' tests/generation.test.ts tests/planning.test.ts
   ```

   Result: failed as expected because `style-sample.ts` did not export `finalizeStyleSample`.

3. Added the user-choice view test before adding the view data.
4. RED command:

   ```bash
   node --import tsx --test --test-name-pattern='published style samples expose' tests/planning.test.ts
   ```

   Result: failed as expected because `nextActions` was undefined.

5. GREEN focused command:

   ```bash
   node --import tsx --test --test-name-pattern='delegated style sample|sample generation plan|one-call|published style samples expose|direct style-sample provider' tests/generation.test.ts tests/planning.test.ts
   ```

   Result: 4 passed, 0 failed.

## Verification

```bash
node --import tsx --test tests/generation.test.ts tests/planning.test.ts tests/styles.test.ts
```

Result: 124 passed, 0 failed.

```bash
npm run lint:types
git diff --check
```

Result: passed.

```bash
node --import tsx --test tests/e2e.test.ts
```

Result: 1 passed, 0 failed. The representative-sample leg uses the structured delegated job/admission/result/finalization flow.

```bash
RUNTIME_NODE=/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
RUNTIME_NODE_MODULES=/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
RUNTIME_BIN_DIR=/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override \
PATH=/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override:/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
/Users/neomei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --import tsx --test "tests/*.test.ts"
```

Result: 274 passed, 0 failed, 2 Windows-only tests skipped.

## Files changed

- `src/generation/style-sample.ts`
- `src/styles/sample-contract.ts`
- `src/planning/views.ts`
- `src/cli.ts`
- `src/acceptance/offline.ts`
- `tests/generation.test.ts`
- `tests/planning.test.ts`

## Compatibility and follow-up boundaries

- Removed the direct `generate-style-sample` CLI route; it now fails before any provider invocation. Added the minimal current `prepare-style-sample-job` and `finalize-style-sample` routes.
- The offline acceptance fixture calls the fake provider as the external Agent actor only after durable admission; the production style-sample orchestration module has no provider or bridge import/call.
- Legacy deck generation/provider paths remain unchanged intentionally. Task 10 owns final strict CLI consolidation and deletion of those remaining temporary legacy paths.
