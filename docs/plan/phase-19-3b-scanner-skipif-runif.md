# Plan — 19.3b Scanner support for `skipIf` / `runIf`

Derived from `docs/design/phase-19-3b-scanner-skipif-runif.md` and `docs/adr/120-skipif-runif-non-skipped-at-scan.md`. TDD throughout: tests fail first, code makes them pass, commits stay atomic.

## Step order

### Step 1 — Tests fail (Red)

Edit both scanner test files to assert the post-fix behaviour. Run the suite; the new assertions must fail (one commit, no source change yet).

**File `tooling/test/unit/test-pyramid/scan-it-blocks.test.ts`** — replace and append:

- Replace the existing test at `:218` (`it.skipIf` block dropped — known limitation) with: extracts one block, `title === 'Given x, When y, Then z'`, `isSkipped === false`, body contains the closure source.
- Replace the existing test at `:232` (`it.runIf` block dropped — known limitation) with the analogous extraction assertion.
- Append: `it.skipIf(cond)` with no follow-up call → block dropped silently; a later well-formed `it('valid', …)` is still emitted.
- Append: `it.runIf(cond)('case %s', (n) => { expect(…);` (inner call never closes) → block dropped silently.
- Append: `it.concurrent.skipIf(cond)('Given x, When y, Then z', () => {…})` → one block, `isSkipped === false`.

Style: keep this file's legacy single-line `it('Given …, When …, Then …', …)` form under the transparent `describe('scanItBlocks', () => {…})` wrapper. AAA section comments (Arrange / Act / Assert) on each test.

**File `tooling/test/unit/test-pyramid/scan-describe-blocks.test.ts`** — append new blocks following the modern describe-tree split style already used in the file:

- `describe('Given a describe.skipIf(cond)(…) block', …)` → `describe('When scanDescribeBlocks runs', …)` → `it('Then one record with title/openIdx/closeIdx is returned and isSkipped is false', …)`.
- Analogous describe tree for `describe.runIf`.
- `describe('Given a describe.skipIf(cond) with no follow-up call', …)` → drops silently.
- `describe('Given a describe.runIf(cond)(…) whose inner call never closes', …)` → drops silently.
- `describe('Given a nested describe.skipIf(cond)(…) wrapping an inner describe(…)', …)` → both records returned; inner span contained by outer.

**Commit**: `test(harness): assert scanner extracts skipIf/runIf two-stage call shapes`.

Run `npm run test:unit` — the new assertions fail, all existing assertions still pass.

### Step 2 — Code passes (Green)

**File `tooling/test-pyramid/scan-it-blocks.ts`**:

1. Drop the BACKLOG-19.3b limitation paragraph from the file header comment (lines 13–18).
2. Replace `const isEach = chainKeys.includes('each');` with:

   ```ts
   const TWO_STAGE_MODIFIERS = new Set(['each', 'skipIf', 'runIf']);
   // … inside the loop:
   const isTwoStage = chainKeys.some((seg) => TWO_STAGE_MODIFIERS.has(seg));
   ```

   Hoist `TWO_STAGE_MODIFIERS` to module scope alongside `SKIP_MODIFIERS`.
3. Rename `isEach` → `isTwoStage` at the `if` branch.

**File `tooling/test-pyramid/scan-describe-blocks.ts`**: identical change (hoist set, rename predicate). No file-header comment changes — it doesn't carry one.

Run `npm run test:unit` — all assertions pass (existing `each` cases still green; new `skipIf` / `runIf` cases now green).

**Commit**: `feat(harness): scanner extracts skipIf/runIf two-stage call shapes`.

### Step 3 — Verify the broader pipeline

Run:

```
npm run check
npm run check:types
npm run test:unit
npm run test:integration
node --experimental-strip-types tooling/audit-test-pyramid.ts --report-only
```

Expected:

- Unit + integration suites green.
- Audit prints zero new findings (per the design's downstream-effect analysis — no current unit test uses `…If`).
- Lint / type-check clean.

If the audit reports findings, they are pre-existing or genuine — investigate before merging. No findings expected.

**Commit**: only if step 3 surfaces something requiring a follow-up fix. Otherwise step 2's commit stands.

### Step 4 — Refactor sweep

Look at the two scanner files side by side. The change in step 2 leaves a near-duplicate `TWO_STAGE_MODIFIERS` constant in each file. Do **not** extract a shared module:

- The two scanners already share `findMatchingClose`, `extractTitle`, `lineAt`, `isWhitespace` as copy-paste duplicates (deliberate, per the existing comment in `scan-describe-blocks.ts`: "Mirrors `scanItBlocks` (paren/brace walker, same skip modifiers, …)").
- Centralizing the constant alone would be inconsistent with the rest of the file's deliberate duplication policy.
- Centralizing the whole shared infrastructure is out of scope for 19.3b — that's a separate refactor.

Confirm both files compile and pass tests; nothing else moves.

### Step 5 — Mutation testing

`stryker.config.json` scopes `mutate` to `src/**/*.ts`; the touched files (`tooling/test-pyramid/scan-*.ts`) are **outside that scope**, so the standard `stryker run` produces zero mutants for this diff. The safety net is the new unit tests added in step 1 — each `TWO_STAGE_MODIFIERS` member (`each`, `skipIf`, `runIf`) is exercised by at least one happy-path test, which would catch a manual member removal.

No mutation step needed for this PR. The workflow's "kill every killable mutant" obligation is trivially satisfied (no killable mutants exist in scope).

### Step 6 — Three review passes

Three rounds. Each round runs the parallel-agent fan-out: `typescript-reviewer`, `code-reviewer`, `test-review`, `security-reviewer`. Fix every actionable finding inside the round, then repeat. Stop after three.

Lightweight scope (single conceptual change across two files plus their tests), so each round is fast.

### Step 7 — Docs + BACKLOG

Touch:

- `docs/BACKLOG.md` — flip `19.3b` from `[ ]` to `[x]` and append the ADR / design pointers in the same line format as `19.3a` / `19.3c`:
  > `[x] **19.3b** Scanner support for two-stage call shapes — `it.skipIf(cond)('title', body)` / `it.runIf(cond)('title', body)` (mirrored on `describe`) now extract titles via the same path as `it.each([…])(…)`; `isSkipped` stays `false` per ADR-120 · ADR-120 · `design/phase-19-3b-scanner-skipif-runif.md`.`
- `docs/understand/architecture.md`, `docs/use/*`, `README.md` — search for any reference to "two-stage", "skipIf", or "known limitation 19.3b"; remove or update. Nothing expected outside the BACKLOG.
- `RUNBOOK.md`, `CONTRIBUTING.md` — no expected impact (scanner is internal tooling), but grep to confirm.

**Commit**: `docs: backlog tick + scanner ref refresh`.

### Step 8 — Push + PR

```
npm run validate     # full harness — must be green
git push -u origin feat/scanner-skipif-runif
gh pr create --title "feat(harness): scanner support for skipIf/runIf two-stage call shapes" --body "$(cat <<'EOF'
## Summary

- Extends `scan-it-blocks` / `scan-describe-blocks` to extract titles from `…If(cond)(title, body)`, alongside the existing `each` path. `isSkipped` stays `false` per ADR-120.
- Drops the known-limitation header comment from `scan-it-blocks.ts`; converts the two pinned `…dropped (known limitation, BACKLOG 19.3b)` tests into post-fix extraction assertions.
- Closes a forward-looking blind spot: gated heuristics are unit-tier only and no current unit test uses these helpers, so the fix surfaces zero findings today but lints any future unit-tier `it.skipIf` / `it.runIf` on first commit.

Design: `docs/design/phase-19-3b-scanner-skipif-runif.md` · ADR: `docs/adr/120-skipif-runif-non-skipped-at-scan.md` · BACKLOG: 19.3b flipped in this PR.

## Test plan

- [ ] `npm run test:unit` — new `…If` happy/failure-mode assertions pass; existing `each` assertions unchanged.
- [ ] `npm run validate` — full harness green.
- [ ] `node --experimental-strip-types tooling/audit-test-pyramid.ts --report-only` — no new findings.
EOF
)"
```

Squash-merge on green CI. Cleanup: `git branch -D feat/scanner-skipif-runif`.

## Dependencies

- Step 1 must land first (failing tests prove behaviour gap).
- Step 2 depends on step 1 (Green requires Red).
- Steps 3–5 depend on step 2.
- Step 6 (review) gates step 7 (docs) and step 8 (PR).
- BACKLOG tick must travel inside the PR's commits, not after merge.
