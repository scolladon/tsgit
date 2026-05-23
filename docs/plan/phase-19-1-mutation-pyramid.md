# Plan — Phase 19.1 mutation pyramid

Implements `docs/design/phase-19-1-mutation-pyramid.md`. Three ADRs land alongside (100–102, already committed; 055 marked superseded).

## Ordering

Six slices, in order. Slices 1–3 build the budget-check from the inside out (pure function → CLI → wireit wiring), slice 4 builds the diff-scope computation independently, slice 5 wires CI, slice 6 cleans up + docs.

| Slice | Topic | Sub-worktree? |
|---|---|---|
| 0 | Scaffolding (`mutation-budgets.json`, JSON schema, npm script names, wireit recipes) | no |
| 1 | `evaluateBudgets` pure function + types (TDD on pure logic, no I/O) | no — single TDD cycle |
| 2 | CLI wrapper `scripts/check-mutation-budgets.ts` + manifest loader + integration test against a real report | no |
| 3 | `scripts/run-stryker-pr.ts` shim (reads `TSGIT_MUTATE_PATHS_FILE`, spawns stryker `--mutate`) + tests | no |
| 4 | `.github/scripts/compute-mutation-scope.sh` + integration test against tmp git repo | no |
| 5 | CI rewrite — `mutation` job uses new flow; `mutation-os.yml` deleted | no — config only |
| 6 | Docs (CONTRIBUTING quality section, `docs/understand/quality.md` update), BACKLOG flip, validation | no |

No sub-worktrees: every slice is small (≤ ~150 LOC each) and they share the same surface; serial TDD inside one tree is faster than orchestrating parallel work.

## Slice 0 — Scaffolding

Files created / modified:

- `mutation-budgets.json` (new, at repo root) — the bucket manifest from §10 of the design. Authored disjoint; the budget checker enforces this at runtime.
- `scripts/mutation-budgets-schema.json` (new) — JSON Schema referenced by `mutation-budgets.json`'s `$schema` field. Lets editors validate the manifest as it's edited. Schema is small (bucket name enum, globs array, thresholds object).
- `package.json`:
  - Add devDep `minimatch` (pure pattern match, no FS walk needed — the budget script gets paths from the report JSON, then matches against bucket globs). `glob` would pull in unnecessary FS-scanning machinery.
  - Add three wireit recipes:
    - `test:mutation:pr` — runs `node --experimental-strip-types scripts/run-stryker-pr.ts`; declared inputs include `src/**/*.ts`, `test/unit/**/*.ts`, `stryker.config.json`, `vitest.config.ts`; outputs `reports/mutation/**`.
    - `check:mutation-budgets` — runs `node --experimental-strip-types scripts/check-mutation-budgets.ts`; declared inputs include `reports/mutation/mutation-report.json`, `mutation-budgets.json`, the script itself; no output (it's a gate).
    - `check:mutation-scope` — runs `bash .github/scripts/compute-mutation-scope.sh` — exposed for local dry-runs. No wireit cache.
  - Do NOT wire `check:mutation-budgets` into `validate` at any point. `validate` deliberately excludes the heavy `test:mutation` dependency the budget check requires. The contract is `npm run test:mutation && npm run check:mutation-budgets` as a separate gate (documented in CONTRIBUTING by slice 6).
- `knip.json` — register `scripts/check-mutation-budgets.ts`, `scripts/run-stryker-pr.ts` as entries; without this, knip flags them as dead code.
- `tsconfig.json` — confirm `scripts/**/*.ts` is in `include` (currently `src/**/*.ts` + `test/**/*.ts` + `scripts/**/*.ts` — check first).
- `cspell.json` — add new vocabulary: `mutationscore`, anything else the new files surface.

What to test first: none in slice 0 — it's config-only. Smoke-verify each new npm script is reachable and prints a help/no-op stub.

What to verify: `npm run validate` still passes (everything else unaffected).

Commit: `chore(mutation): scaffold per-bucket budgets manifest`.

## Slice 1 — `evaluateBudgets` pure function

Files:

- `scripts/mutation-budgets.ts` (new) — module exporting:
  - `BucketName`, `Thresholds`, `BucketDefinition`, `BucketResult`, `BudgetCheckOutcome` types (matching §10 of the design). `BudgetCheckOutcome` includes `unassignedFiles: readonly string[]` AND `overlaps: readonly { path: string; buckets: readonly BucketName[] }[]` — both empty on success, both surfaced on failure with structured detail.
  - `parseManifest(raw: unknown): { buckets: readonly BucketDefinition[] }` — hand-rolled validator; throws `ManifestError` with structured message on invalid input.
  - `parseReport(raw: unknown): StrykerMutationReport` — hand-rolled validator; asserts `schemaVersion` major matches `1`; throws `ReportError("unsupported mutation-report schemaVersion: <v>")` on unknown major. Asserts `files` is an object of `{ mutants: { status: ... }[] }`.
  - `evaluateBudgets(report, manifest): BudgetCheckOutcome` — pure aggregation over already-parsed inputs. No I/O, no schema work, no exit.
  - `bucketForPath(path: string, buckets: readonly BucketDefinition[]): BucketName | null` — exported for tests; first-match wins.
- `test/unit/scripts/mutation-budgets.test.ts` (new) — TDD spec.

TDD cycles, in order:

1. **`parseManifest` validation** — Given/When/Then per case:
   - Given an empty object, When parsed, Then throws `ManifestError("manifest invalid: missing buckets array")`.
   - Given a bucket with no `name`, When parsed, Then throws `ManifestError("manifest invalid: bucket missing name")`.
   - Given thresholds out of range (`break: 101`), Then throws.
   - Given a valid manifest matching the real `mutation-budgets.json`, Then returns it untouched.
2. **`bucketForPath`** — first-match-wins, no-match returns null:
   - Given `src/domain/foo.ts` and the real manifest, Then returns `'domain'`.
   - Given `src/notabucket/foo.ts`, Then returns `null`.
   - Given overlapping globs (synthetic manifest, two buckets both matching `src/a/**`), Then returns the first bucket's name.
3. **`evaluateBudgets` happy path** — given a fixture report with one file in `domain` (100% killed), Then `domain` result is `score: 100, status: 'pass'`, all other buckets are `n/a`, `ok: true`.
4. **`evaluateBudgets` failure** — one file in `adapters` below break (e.g. score 80, threshold 85), Then `adapters` is `fail`, `ok: false`.
5. **`evaluateBudgets` boundary** — score exactly at break, Then `pass` (>= not >).
6. **`evaluateBudgets` unassigned** — fixture report contains `src/newbucket/foo.ts`, Then `unassignedFiles: ['src/newbucket/foo.ts']`, `ok: false`.
7. **`evaluateBudgets` overlap detection** — synthetic manifest where two buckets both match a file in the report, Then `outcome.ok = false` AND `outcome.overlaps = [{ path: '...', buckets: ['a', 'b'] }]`. Per-bucket score for the affected file is reported under the FIRST matching bucket (so the table still tells a coherent story); the overlap field is the structured cause.
8. **`evaluateBudgets` score formula** — fixture with `killed:8, survived:1, timeout:0, noCoverage:1`, score should be `8/10 * 100 = 80`. Verifies `noCoverage` counts as not-killed (matches Stryker's `mutationScore`).
9. **`parseReport` schema version** — fixture with `schemaVersion: "99.0"`, Then throws with `unsupported mutation-report schemaVersion: 99.0`. Verified as a separate test against `parseReport`, not `evaluateBudgets` (parse-at-edge, evaluate-in-core).

Each test follows Given/When/Then title, AAA body with `// Arrange` / `// Act` / `// Assert` comments, `sut` is `evaluateBudgets` or the relevant helper.

Verify: 100% line/branch/function coverage on `scripts/mutation-budgets.ts` (the v8 gate will enforce; if scripts/ isn't currently in coverage scope, slice 0 needs to add `scripts/**/*.ts` to the v8 include list).

Commit: `feat(mutation): evaluateBudgets pure function with manifest validation`.

## Slice 2 — CLI wrapper + integration test

Files:

- `scripts/check-mutation-budgets.ts` (new) — CLI. Reads `reports/mutation/mutation-report.json` and `mutation-budgets.json` via `node:fs/promises`, calls `parseManifest` + `evaluateBudgets`, prints the bucket table, exits `0`/`1`. Pure I/O at the edges; all logic delegated to slice-1 module.
- `test/integration/scripts/check-mutation-budgets.test.ts` (new) — integration spec that runs the script as a child process against a tmp-dir fixture:
  - Given a valid manifest + a passing report, When the CLI runs, Then exit 0 and stdout contains a table with `domain | pass | 100`.
  - Given an over-budget report, Then exit 1 and stdout shows `fail`.
  - Given a missing report file, Then exit 1 with `report not found: <path>`.
  - Given a malformed manifest, Then exit 1 with `manifest invalid: ...`.

Use `node:child_process` `execFile` (promisified). Place under `test/integration/` because it crosses the process boundary.

Verify: `npm run check:mutation-budgets` against the current `reports/mutation/` (run `npm run test:mutation` first to generate it) — should pass at land time, since the existing code is already at or above the proposed thresholds. If a bucket fails, that's pre-existing tech debt — surface it, fix it in this slice before proceeding.

Commit: `feat(mutation): check:mutation-budgets CLI`.

## Slice 3 — `run-stryker-pr.ts` shim

Files:

- `scripts/run-stryker-pr.ts` (new) — reads `TSGIT_MUTATE_PATHS_FILE` env var; if set, reads the file, joins with commas, spawns `stryker run --mutate <list>` and inherits stdio. If unset, looks for `--mutate <list>` in `process.argv`; if also absent, spawns `stryker run` (full tree) and prints a one-line note that this is the local-dev path. Exit code is the stryker exit code.
- `test/unit/scripts/run-stryker-pr.test.ts` (new) — TDD spec with a fake `spawn` injected via the module's signature (export the function with a `spawn` parameter; the CLI wrapper passes the real `child_process.spawn`):
  - Given `TSGIT_MUTATE_PATHS_FILE` pointing at a file with `a.ts,b.ts`, When invoked, Then spawn is called with `['run', '--mutate', 'a.ts,b.ts']`.
  - Given `TSGIT_MUTATE_PATHS_FILE` pointing at an empty file, Then the script exits 0 without spawning stryker (no-op path, matches the "skip if no src changes" CI step).
  - Given `--mutate src/foo.ts` in argv, no env var, Then spawn is called with `['run', '--mutate', 'src/foo.ts']`.
  - Given neither, Then spawn is called with `['run']` and a console note is printed.

Verify: locally `TSGIT_MUTATE_PATHS_FILE=/tmp/empty npm run test:mutation:pr` exits 0 instantly.

Commit: `feat(mutation): run-stryker-pr shim for diff-scoped invocation`.

## Slice 4 — `compute-mutation-scope.sh`

Files:

- `.github/scripts/compute-mutation-scope.sh` (new) — bash (matches `set -euo pipefail`; GitHub Linux runners ship bash by default):

  ```sh
  #!/usr/bin/env bash
  set -euo pipefail
  BASE_SHA="${1:-${GITHUB_BASE_REF:-main}}"
  HEAD_SHA="${2:-HEAD}"
  git diff --name-only --diff-filter=AMR "$BASE_SHA" "$HEAD_SHA" \
    | grep -E '^src/.*\.ts$' \
    | grep -vE '/(index\.ts|.*\.d\.ts)$' \
    | grep -vE '^src/adapters/browser/' \
    | tr '\n' ',' \
    | sed 's/,$//'
  ```

  Slice 5 needs to know whether the output is empty so the CI job can skip stryker. Two options:
  - Caller checks `[ -s /tmp/mutate.txt ]` — simpler, used in this plan.
  - Script writes a marker line (`--no-changes`) on empty — more explicit. Rejected: file-empty check is already idiomatic in bash.

- `test/integration/scripts/compute-mutation-scope.test.ts` (new) — integration spec that creates a tmp git repo, commits files, runs the shell script, asserts output:
  - No src/ changes → empty output.
  - One src/domain/foo.ts add → `src/domain/foo.ts`.
  - Mixed src + test changes → only src.
  - Deleted file → excluded (`--diff-filter=AMR` skips deletions).
  - Renamed file → new path (the `R` filter resolves to the new path).
  - File under `src/adapters/browser/` → excluded.
  - Index file (`src/index.node.ts`) → excluded.

Verify locally by running the script against a recent main..feature diff in another repo or by faking with `git diff main..HEAD` in the worktree.

Commit: `feat(mutation): compute-mutation-scope.sh for PR diff scoping`.

## Slice 5 — CI rewrite + nightly deletion

Files modified:

- `.github/workflows/ci.yml` — rewrite the `mutation` job per §6 of the design:
  - `if: github.event_name == 'pull_request'` unchanged.
  - `needs: [unit-tests]` unchanged.
  - Steps:
    1. `actions/checkout@v6` with `fetch-depth: 0` (already there).
    2. `./.github/actions/setup` (already there).
    3. New step: `Compute mutated file set` → `bash .github/scripts/compute-mutation-scope.sh "$BASE_SHA" "$HEAD_SHA" > /tmp/mutate.txt` (env: `BASE_SHA: ${{ github.event.pull_request.base.sha }}`, `HEAD_SHA: ${{ github.event.pull_request.head.sha }}`).
    4. New step: `Skip if no src changes` → `if [ ! -s /tmp/mutate.txt ]; then echo "::notice::No src/ files changed — skipping mutation"; exit 0; fi`.
    5. Replace `npm run test:mutation:incremental` with `npm run test:mutation:pr` (env: `TSGIT_MUTATE_PATHS_FILE: /tmp/mutate.txt`).
    6. New step: `npm run check:mutation-budgets`.
    7. Upload artifact step unchanged.

  Concrete YAML for steps 3–6 (the new bits):

  ```yaml
  - id: scope
    name: Compute mutated file set
    env:
      BASE_SHA: ${{ github.event.pull_request.base.sha }}
      HEAD_SHA: ${{ github.event.pull_request.head.sha }}
    run: |
      bash .github/scripts/compute-mutation-scope.sh "$BASE_SHA" "$HEAD_SHA" > /tmp/mutate.txt
      if [ -s /tmp/mutate.txt ]; then
        echo "skip=false" >> "$GITHUB_OUTPUT"
      else
        echo "::notice::No src/ files changed — skipping mutation"
        echo "skip=true" >> "$GITHUB_OUTPUT"
      fi
  - if: steps.scope.outputs.skip != 'true'
    run: npm run test:mutation:pr
    env:
      TSGIT_MUTATE_PATHS_FILE: /tmp/mutate.txt
  - if: steps.scope.outputs.skip != 'true'
    run: npm run check:mutation-budgets
  ```

  The artifact upload step keeps `if: always()` and runs whether or not the scope was empty (so a skipped-but-passing job still uploads — albeit a trivially empty — artifact, keeping CI-log structure consistent).

- `.github/workflows/mutation-os.yml` — delete.

Files NOT modified:

- `stryker.config.json` — thresholds stay as the fallback for ad-hoc full-tree runs (`npm run test:mutation` locally).

Verify: open the PR and watch the `mutation` job. On a PR that touches one file, the job should run in well under 5 minutes; on a PR with no src/ changes, it should print the notice and skip the stryker run; on a PR that drops a bucket below its threshold (force-tested by manually breaking a test), it should fail with the bucket-table output.

Commit: `ci(mutation): diff-scoped PR gate + per-bucket budgets; remove per-OS nightly`.

## Slice 6 — Docs + BACKLOG + final validation

Files modified:

- `CONTRIBUTING.md` — add a "Mutation budgets" subsection under the existing test-conventions section. Quote the bucket table, point at `mutation-budgets.json` as source of truth, document the inline `// equivalent-mutant: <why>` convention, and call out the new two-step gate: `npm run test:mutation && npm run check:mutation-budgets`.
- `docs/understand/design-decisions.md` — add a new "Mutation pyramid (Phase 19.1)" section after "Documentation structure (Phase 18.2)", linking ADRs 100/101/102 and the design doc.
- `RUNBOOK.md` — add a one-line entry under the existing mutation-testing reference pointing at `npm run check:mutation-budgets` and the diff-scoped PR gate.
- `docs/BACKLOG.md` — flip `[ ] **19.1**` to `[x] **19.1**` with `· ADRs 100–102 · design/phase-19-1-mutation-pyramid.md` appended (matching the format of prior items). Update the v2 Wave 0 status line in the table at the top to reflect partial progress.

No new `docs/understand/quality.md` file — the design-decisions ADR index is the project's established home for cross-phase design narratives, and adding a new top-level doc would duplicate that index.

Run the harness end-to-end:
- `npm run validate` — every existing check passes; the new `check:mutation-budgets` is NOT added here (validate intentionally excludes the heavy `test:mutation` dependency).
- `npm run test:mutation` — full-tree run, then immediately `npm run check:mutation-budgets` — both must pass. The CI does the diff-scoped equivalent on every PR.
- `check:doc-links` — verify the new ADR references (`100`, `101`, `102`) resolve.
- `check:doc-coverage` — no new commands or primitives, unaffected.
- `check:doc-typedoc` — no API changes, snapshot unchanged.

Step 7 of `CLAUDE.md`'s workflow already says "npm run validate" + "stryker run" as two separate gates. After 19.1, the second gate is "`stryker run` + `check:mutation-budgets`" — captured in CONTRIBUTING.

Commit: `docs(quality): mutation pyramid wiring + BACKLOG 19.1 [x]`.

## Risks discovered during planning

- **`scripts/` may not currently be in coverage scope.** Slice 0 needs to verify and, if needed, extend `vitest.config.ts` coverage `include` to cover `scripts/mutation-budgets.ts` and `scripts/run-stryker-pr.ts`. If extending coverage to `scripts/` blows up because other scripts aren't tested, fall back to per-file include rather than `scripts/**`.
- **`mutation-budgets.json` adds a new top-level file the project doesn't currently have.** Check `dependency-cruiser`, `ls-lint`, `cspell`, and the doc-coverage script don't choke on it.
- **The PR gate's `if: steps.scope.outputs.skip != 'true'` structure depends on slice 4's output contract.** Resolve in slice 4 — the script writes both the path list and a `--no-changes` sentinel; slice 5 wires the step output.
- **`npm run test:mutation:pr` invoked locally without `TSGIT_MUTATE_PATHS_FILE` or `--mutate` runs full-tree.** That's intentional (slice 3 spec). Document in CONTRIBUTING so devs know the local-dev path.

## What this plan does NOT do

- No new mutation operators, no Stryker plugin authoring.
- No changes to the existing `// equivalent-mutant:` annotations (already audited; all 16 still valid).
- No documentation of equivalent-mutant catalogue — inline-only stays canonical (per user decision).
- No nightly mutation replacement — gone for good (ADR-102).
- No per-PR full-tree fallback — diff-scope is the only PR path.
