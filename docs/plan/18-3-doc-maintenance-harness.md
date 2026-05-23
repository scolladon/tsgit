# Plan — Doc-maintenance harness (Phase 18.3)

Implements `docs/design/18-3-doc-maintenance-harness.md`. Five ADRs land alongside (095–099, already committed).

## Ordering

Five slices, in order. The slices are mostly independent — `1`, `2`, `3` could parallelise — but landing them sequentially keeps reviews tractable and the diff narrative coherent. Slice 0 is shared scaffolding consumed by 1–4.

| Slice | Topic | Sub-worktree? |
|---|---|---|
| 0 | Shared scaffolding (`.lychee.toml`, cspell, package.json scripts, wireit recipes) | no |
| 1 | Link checker (lychee + CI job) | no — small, no test surface |
| 2 | API coverage drift (`scripts/check-doc-coverage.ts` + unit tests + CI job) | candidate, but kept inline; one TDD cycle |
| 3 | TypeDoc JSON snapshot (`reports/api.json`, `docs:json` recipe, CI job) | no |
| 4 | Path-based docs PR gate (CI-only, warn-only) | no |
| 5 | Docs touch-up + BACKLOG tick + parallel reviews | no |

No sub-worktrees: every slice is small enough that the sequential TDD cycle inside a single working tree is fastest.

## Slice 0 — Scaffolding

Files created / modified:

- `.lychee.toml` (new) — root config for the link checker; see 1.x for the content.
- `package.json` — add three npm scripts: `check:doc-links`, `check:doc-coverage`, `check:doc-typedoc`. Add `docs:json` wireit recipe. Wire all three into `validate`'s `dependencies` list.
- `cspell.json` — add new vocabulary the harness introduces: `lychee`, `lycheeverse`, `linkcheck`, anything else surfaced by the diff.
- `knip.json` — add `scripts/check-doc-coverage.ts` to the `entry` array (so knip doesn't flag it as dead code).

What to test first: there are no production-code tests in slice 0; the slice is config + scripts wiring. Verify each new npm script is reachable (`npm run check:doc-links --silent` runs lychee even if it has no links to scan; `npm run docs:json` produces `reports/api.json`; `npm run check:doc-coverage` runs the (initially empty) script).

What to verify: `npm run validate` still passes after adding the new dependencies.

## Slice 1 — Markdown link checker

Files:

- `.lychee.toml` (filled in) — exclude `docs/plan/**`, `docs/spike/**`, `docs/design/phase-13-4b-*.md`; set `timeout = 20`, `max_retries = 2`, `accept = [200, 206, 301, 302, 304, 307, 308, 429]`, `scheme = ["http", "https"]`, `cache = true`.
- `.github/workflows/ci.yml` — new job `doc-links` on `ubuntu-latest`, needs `[lint, typecheck]`. Uses `lycheeverse/lychee-action@v2` with `args: --config .lychee.toml --no-progress --verbose 'README.md' 'CONTRIBUTING.md' 'RUNBOOK.md' 'SECURITY.md' 'docs/**/*.md'`. Sets `fail: true`.
- `package.json` — `check:doc-links` wireit recipe runs `lychee --config .lychee.toml README.md CONTRIBUTING.md RUNBOOK.md SECURITY.md 'docs/**/*.md'`.
- `CONTRIBUTING.md` — one-line note pointing at the lychee install instructions.

What to test first: nothing — this slice is config + a third-party CLI. End-to-end verification is the CI run on the PR.

What to verify locally: run `npm run check:doc-links` after installing lychee (`brew install lychee`); should exit 0 against the current docs tree at land time. If it doesn't, fix the link before merging this slice.

## Slice 2 — API coverage drift

Files:

- `scripts/check-doc-coverage.ts` (new) — pure Node script using `node --experimental-strip-types`. Reads `src/repository.ts`, extracts command + primitive names via regex (ADR-097), kebab-cases them, verifies for each:
  - `docs/use/<kind>/<kebab>.md` exists
  - `docs/use/<kind>/README.md` contains a row matching `` [`<camelCase>`](<kebab>.md) ``
  - Allowlist consulted via `scripts/check-doc-coverage.allowlist.json` (empty at land time)
  - Exits 1 with structured stderr stanzas on any gap; exits 0 if clean
- `scripts/check-doc-coverage.allowlist.json` (new) — `{ "commands": [], "primitives": [] }`.
- `test/unit/scripts/check-doc-coverage.test.ts` (new) — TDD spec for the parser + checker. Pattern: pure functions exported from the script + a thin `main` wrapper.
- `.github/workflows/ci.yml` — new job `doc-coverage` on `ubuntu-latest`, needs `[lint, typecheck]`. Runs `npm run check:doc-coverage`.
- `package.json` — `check:doc-coverage` wireit recipe + add to `validate` dependencies.

What to test first: a TDD cycle per parser concern:

1. RED — write `Given a Repository interface with three readonly commands, When parseRepositoryInterface runs, Then it returns those three names`
2. GREEN — implement the regex parser
3. REFACTOR — extract `parseRepositoryInterface`, `kebabCase`, `checkDocsExist`, `checkIndexRow`, `formatGapStanza` into small named functions; `main` composes them.

Tests required (Given/When/Then titles, AAA body, `sut` variable):

- parser-only:
  - Given a synthetic source with three commands, When parsed, Then returns those names
  - Given a source missing the primitives block, When parsed, Then primitives set is empty
  - Given a source whose `BindCtx` is renamed, When parsed, Then both sets are empty (and the integration assertion catches this regression)
- kebab-case:
  - Given `catFile`, When kebab-cased, Then `cat-file`
  - Given `revParse`, When kebab-cased, Then `rev-parse`
- doc-presence check:
  - Given a docs root with the expected file, When checkDocsExist runs, Then returns []
  - Given a docs root missing the file, When checkDocsExist runs, Then returns one gap with the missing path
- index-row check:
  - Given a README.md containing the expected row, When checkIndexRow runs, Then returns []
  - Given a README.md missing the row, When checkIndexRow runs, Then returns one gap
- allowlist:
  - Given a name in the commands allowlist, When the checker runs against a docs root that's missing the file, Then it's not reported as a gap
- integration:
  - Given the real `src/repository.ts` + real docs tree, When the checker runs at HEAD, Then exits 0 (this asserts the parser tracks reality)

What to verify: `npm run check:doc-coverage` exits 0 against the current tree.

## Slice 3 — TypeDoc JSON drift

Files:

- `package.json` — `docs:json` wireit recipe runs `typedoc --json reports/api.json --emit none --skipErrorChecking`. `check:doc-typedoc` recipe runs `docs:json` then `git diff --exit-code reports/api.json` (with a helpful stderr message on non-zero). Add `check:doc-typedoc` to `validate`'s `dependencies`.
- `reports/api.json` (new) — generated from current `main` at branch time, committed wholesale.
- `.gitignore` — review entry for `reports/`; carve out `!reports/api.json` so the file isn't accidentally re-ignored. (Currently `reports/` may not be gitignored — confirm during slice.)
- `.github/workflows/ci.yml` — new job `doc-typedoc` on `ubuntu-latest`, needs `[lint, typecheck]`. Runs `npm run check:doc-typedoc`.
- `CONTRIBUTING.md` — one-line note: "After JSDoc changes, run `npm run check:doc-typedoc` and commit the updated `reports/api.json`."

What to test first: no Vitest test — the CI job IS the test. Verify locally:

1. `npm run docs:json` produces `reports/api.json`
2. Diff against committed: empty (the file is the baseline we just committed)
3. Touch a JSDoc string in any exported symbol; re-run `docs:json`; verify diff is non-empty and structurally meaningful (`git diff reports/api.json | grep "<your edit>"` shows the change)
4. Revert the touched JSDoc; re-run; diff is empty again.

What to verify: `npm run check:doc-typedoc` exits 0 at the end of the slice.

## Slice 4 — Path-based docs PR gate

Files:

- `.github/workflows/ci.yml` — new job `docs-pr-gate` triggered on `pull_request` only. `continue-on-error: true` for the warn phase (ADR-099). Steps:
  - `actions/checkout` with `fetch-depth: 0`
  - Inline shell + node script: compute changed files via `git diff --name-only ${{ github.event.pull_request.base.sha }}...HEAD`, map command/primitive source paths to expected doc paths, check whether any expected doc was also touched.
  - On mismatch, write to `$GITHUB_STEP_SUMMARY` and post (or update) a PR comment via `gh api` with the `<!-- docs-pr-gate -->` sentinel for idempotency.
  - Always exits 0 in the warn phase.
- No `npm` script — the gate is PR-only.
- `docs/BACKLOG.md` — add a single-line follow-up: promote the gate to blocking after one cycle of observation.

What to test first: nothing — the CI job is the gate. End-to-end verification is the PR itself. Since this PR touches no `src/application/{commands,primitives}/<name>.ts` file, the gate should be silent (no mismatch, no comment).

What to verify: open the PR; confirm `docs-pr-gate` runs and shows "no docs drift detected" (or equivalent) in step summary.

## Slice 5 — Docs + BACKLOG tick + reviews

Files:

- `docs/BACKLOG.md` — flip 18.3 entry to `[x]`. Move the four sub-bullets into a brief "lands as" line referencing the new files (`.lychee.toml`, `scripts/check-doc-coverage.ts`, `reports/api.json`, `docs/adr/095–099`).
- `RUNBOOK.md` — add a "Doc-maintenance harness" subsection: how to debug a broken link, how to regenerate `reports/api.json`, how to read a docs-PR-gate comment.
- `CONTRIBUTING.md` — already updated in slices 1 + 3; consolidate references and ensure the install-lychee hint and the typedoc-snapshot ritual are both clearly explained.
- `docs/understand/architecture.md` — no change expected; verify by spot-check.
- `README.md` — no change expected.

Three parallel reviews (per CLAUDE.md step 6):

1. code-reviewer agent on the diff — focuses on `scripts/check-doc-coverage.ts` and its tests
2. security-reviewer agent — focuses on the inline GitHub Actions scripts (any shell injection vectors in the path-based gate's `gh api` invocations?)
3. doc-coverage self-check — runs `npm run check:doc-coverage`, `npm run check:doc-links`, `npm run check:doc-typedoc` against the final tree

Per Phase 18.2's experience: run all three concurrently. Apply all findings. Repeat as a second pass if any pass made non-trivial changes; the design and ADR contents converged on draft so the implementation review may also converge in one pass.

## Engineering-harness pass

After the implementation reviews land:

- `npm run validate` — full pipeline including the new `check:doc-links`, `check:doc-coverage`, `check:doc-typedoc` (all should exit 0)
- `stryker run` — incremental; the only new mutation surface is `scripts/check-doc-coverage.ts`; the unit tests must kill every mutant or document equivalents inline.

## Risks and contingencies

| Risk | Mitigation |
|---|---|
| `reports/api.json` is non-deterministic across runners | Verify locally + in CI on the branch. If observed, add a small post-process pass; do not pre-emptively complicate. |
| Lychee rate-limits CI's external checks | `.lychee.toml` already accepts 429; add specific host exclusions if seen on first run. |
| The path-based gate's inline shell script is brittle to PR shape edge cases (force-push, rebased PRs) | Warn-only ramp absorbs the noise. Promotion ADR will document any rules added during observation. |
| `check:doc-coverage` regex over-/under-matches after a future `Repository` interface refactor | Integration test against real repository.ts will fail; that's the canary. |
| Commitlint rejects PR titles or commit subjects (18.2 pitfall) | All commit subjects lower-case. No phase refs in code. |
| pre-push cspell blocks (18.2 pitfall) | cspell.json updated in slice 0 with all new vocabulary. Verify `npm run check:spelling` before each push. |

## Files added / modified summary

```
New files:
  .lychee.toml
  scripts/check-doc-coverage.ts
  scripts/check-doc-coverage.allowlist.json
  test/unit/scripts/check-doc-coverage.test.ts
  reports/api.json
  docs/design/18-3-doc-maintenance-harness.md     (slice 0)
  docs/plan/18-3-doc-maintenance-harness.md       (this file)
  docs/adr/095-doc-link-checker-tool.md
  docs/adr/096-api-coverage-source-of-truth.md
  docs/adr/097-api-coverage-regex-parser.md
  docs/adr/098-typedoc-drift-json-snapshot.md
  docs/adr/099-docs-pr-gate-warn-then-block.md

Modified:
  package.json            (3 scripts + 1 wireit recipe + validate dep list)
  cspell.json             (new vocabulary)
  knip.json               (new entry path)
  .gitignore              (carve-out for reports/api.json if needed)
  .github/workflows/ci.yml (4 new jobs)
  CONTRIBUTING.md         (install hint + typedoc ritual)
  RUNBOOK.md              (debug-the-harness section)
  docs/BACKLOG.md         (18.3 → [x] + follow-up)
```
