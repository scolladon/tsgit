# Plan — browser `log` message trailing-`\n` parity

One slice. Production code is untouched; the change is a single test-expectation
correction backed by a real red→green against chromium + firefox.

## Prerequisites (already satisfied)

- Worktree on `feat/browser-log-trailing-newline`, `npm install` done.
- `npm run build` + `npm run build:parity` done (the browser page loads `dist/`).
- Playwright chromium + firefox engines installed.

## Slice 1 — correct the `log` surface-parity expectation

**File:** `test/browser/surface-parity.spec.ts`

- **Red.** Run the `log` scenario on chromium and firefox against the current
  (stale) expectation:
  ```
  npx playwright test --project=chromium --project=firefox -g "log runs"
  ```
  Confirm it fails on both, asserting `'second commit\n' !== 'second commit'`
  (received array `['second commit\n', 'seed commit\n']`). webkit is not in the
  selected projects; even if selected it would skip (OPFS gap).
- **Green.** Edit the first `test.step` expectation:
  ```
  expect(entries.map((entry) => entry.message)).toEqual([
    'second commit\n',
    'seed commit\n',
  ]);
  ```
  Add a why-comment: the porcelain `stripspace` guarantees one trailing `\n`, and
  `repo.log()` returns the raw commit-object body verbatim (ADR 206). Re-run the
  same command; both chromium and firefox pass.
- **Verify.** `npm run validate` green (lint/format/types/unit — the spec must
  still satisfy biome + GWT/AAA lint). Then a full `npm run test:e2e` (all three
  engines) to confirm the suite is green end-to-end with webkit skipping OPFS.

**Commit:** `test(browser): expect stripspace trailing newline in log readback`

## Slice 2 — docs refresh + BACKLOG

**Files:** `docs/BACKLOG.md` (+ README/RUNBOOK/CONTRIBUTING/get-started/use/understand
only if any documents this behavior — expected: none beyond BACKLOG).

- Carry the uncommitted main BACKLOG edit into this branch: add the 21.2c entry
  (`[ ]`, unchanged) and the 21.2d entry, then **correct the 21.2d root-cause
  text** (drop the false "timing-dependent / Node strips" narrative; state the
  PR #93 stale-expectation root cause) and flip `[ ]` → `[x]`.
- Scan README / RUNBOOK / CONTRIBUTING / `docs/get-started` · `docs/use` ·
  `docs/understand` for any statement about `log` message shape; update only if
  one exists.

**Commit:** `docs: flip 21.2d, correct browser-log root cause` (BACKLOG + any doc
edits), folded with the standard docs refresh.

## Review + mutation

- **Review ×3** (typescript / security / test) on `git diff main...HEAD`.
  Expected near-empty: a test-expectation edit + docs. The test reviewer confirms
  the GWT/AAA structure and that the assertion is specific.
- **Mutation:** out of scope by construction — no production source changes, and
  `stryker run` mutates the unit suite, not browser specs. Note in the PR; do not
  burn a full mutation run for a no-op delta.

## Dependency graph

Slice 1 → Slice 2 (docs reflect the shipped behavior). Sequential; no parallelism.
