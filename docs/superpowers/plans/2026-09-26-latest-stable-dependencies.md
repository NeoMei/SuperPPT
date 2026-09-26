# Latest Stable Dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the latest stable dependency plugins without forcing an older minor version or weakening conversion-output validation.

**Architecture:** Keep explicit installed roots and lightweight entry fingerprints. Admit stable semantic versions without a minor-version ceiling; the existing manifest/ledger/donor validators remain authoritative. Reuse the fingerprint check at conversion boundaries as well as generation-job creation.

**Tech Stack:** TypeScript, Node test runner, Zod, existing PPTX and filesystem helpers; no new packages.

**Spec:** User-approved dependency policy from the current conversation, recorded in `docs/specs/decisions.md` under D-22.

## Global Constraints

- Prefer the latest stable release; never automatically downgrade, install, or upgrade during a task.
- A locally installed version is not proof of the latest published version or of live provider availability.
- Keep explicit roots, package identity, readable entries, version/fingerprint recording, and all output validation.
- No source-tree scanner, invented converter capability manifest, live conversion probe, or paid requests.
- Preserve existing documents as historical evidence; supersede their old minor-version policy explicitly.

## Task 1: Dependency admission, snapshot protection, and Agent definition

**Files:** `src/dependencies/task-dependencies.ts`, `src/editable/task-conversion.ts`, `tests/fast-dependencies.test.ts`, `tests/fast-editing.test.ts`, `tests/helpers/fast-task.ts`, `references/dependencies.json`, `skills/superppt/SKILL.md`, `skills/superppt/references/依赖说明.md`, `README.md`, `docs/specs/{README,decisions}.md`.

**Interfaces:** Preserve `resolveTaskDependencies(input): Promise<TaskDependencies>` and `preflightJob(root, jobId): Promise<void>`; extract `checkTaskDependencies(root): Promise<TaskDependencies>` for the existing fingerprint loop and reuse its validated snapshot in conversion preparation/import.

- [x] Add table-driven real-filesystem admission tests for `0.3.0`, `0.4.1`, `1.0.0`, build metadata, prerelease/invalid versions, wrong package identity and missing CLI.
- [x] Run `node --import tsx --test tests/fast-dependencies.test.ts` and observe stable new versions fail with the old 0.2.x error.
- [x] Add tests proving installation drift blocks conversion preparation and import without changing the current deck or candidate.
- [x] Run `node --import tsx --test tests/fast-editing.test.ts` and observe the missing conversion fingerprint guards.
- [x] Replace the minor lock with a string-typed stable SemVer check, retaining package identity and entry fingerprints. Extract the shared check and call it before conversion work and before importing a conversion result.
- [x] Change the normal task fixture to converter `0.3.0`; keep an explicit compatibility case for `0.2.2` so supported offline installs remain usable.
- [x] Update Agent instructions, reference metadata and D-22 with latest-stable selection, no downgrade, no network/latest claims without evidence, preservation of published job snapshots, and manifest v2/ledger v2/1280×720/donor validation boundaries. The checks do not freeze the installation or monitor every request within an existing batch.
- [x] Run the focused tests and the source suite. Review the current Skill against the observed baseline failure: the Agent recommended installing 0.2.x to bypass the gate although both installed plugins were already latest releases.

## Task 2: Verification and GitHub update

- [x] Run `npm run verify:portable` and `npm run test:release-install`; record the existing audit failure below rather than treating the aggregate command as passing.
- [x] Resolve the actual installed `image-to-editable-pptx 0.3.0` and start a disposable task without generating images or calling providers.
- [x] Obtain an independent read-only review of correctness, scope, latest-stable wording, and preservation of output checks.
- [ ] Inspect `git status`, `git diff`, and `git log --oneline -10`; stage only this change, commit with `fix:` prefix, and push normally to the existing repository default branch. Do not force-push or create an unrequested release.
- [ ] Report the commit URL and distinguish source update from local plugin installation, release publication, paid conversion, and GUI validation.

## Verification record — 2026-09-26

- RED: focused suite 6 passed / 4 failed, reproducing both the old version gate and missing conversion fingerprint guards.
- Final focused suite: 12 passed. Review follow-ups cover first-request rollback and rejection of manifest v3 from an admitted future stable version.
- Final source and compiled suites: each 120 passed / 0 failed / 1 skipped. The skipped package-install test was run separately and passed (1/1).
- Type checking, build, repository contracts and `git diff --check` passed. Actual installed converter 0.3.0 resolved and the public `start` command returned planning work without any generation/conversion/provider calls.
- Independent review found no blockers; its two test suggestions were added. Four Skill scenarios were reviewed for downgrade avoidance, honest offline reporting, future incompatible output rejection and preserving in-flight budgets.
- `verify:portable` did **not** pass overall: the unchanged audit script expects npm advisory IDs 1138808/1138809, while npm now reports 1239766/1239765 for the same GHSA URLs. The two high-severity image-size/pptxgenjs findings remain reported. No lockfile, security policy, audit allowlist or dependencies were changed to suppress this failure.
- No release was created, no existing local plugin installation was replaced, and no paid provider or WPS/PowerPoint GUI validation was performed.
