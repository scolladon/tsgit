# Plan — Phase 19.3c: GWT describe/it split

Derived from `design/phase-19-3c-gwt-describe-it-split.md` and
ADRs 117–119.

Order is load-bearing. Each step is a separate commit unless noted.
TDD throughout — write the test, watch it fail, write the code, watch
it pass, refactor, validate.

## Slice 1 — `scanDescribeBlocks` sibling scanner

Files:
- `tooling/test-pyramid/scan-describe-blocks.ts` (new)
- `tooling/test/unit/test-pyramid/scan-describe-blocks.test.ts` (new)

Test fixtures (each becomes one `Then` leaf):
1. Top-level `describe('title', () => { … })` → one record at line N.
2. Nested describes → two records, openIdx ordering preserved.
3. `describe.skip(…)` / `describe.todo(…)` / `describe.each([…])('title', …)`
   → skip flag set; title extracted (each from second parens).
4. Template-literal title → extracted as literal.
5. No-title `describe(() => {})` → no record emitted.
6. Title containing nested parens, escaped quotes, mixed quotes → still
   extracted correctly.

Implementation:
- Duplicate the small paren/brace helpers (`findMatchingClose`,
  `extractTitle`, `lineAt`, `isWhitespace`, `SKIP_MODIFIERS`) into
  `scan-describe-blocks.ts`. The functions are <30 lines combined and
  `scanItBlocks` is not refactored — keeps slice risk low and ADR-118
  honest ("each scanner stays small and audit-readable").
- `scanDescribeBlocks` walks `(?<!\.)\bdescribe((?:\.\w+)*)\s*\(`
  openers; same `each`-aware title position logic. Output:
  `{ line, title, openIdx, closeIdx, isSkipped }`.
- **Also additively extend `scanItBlocks`** to include `openIdx` on
  its `ItBlock` records (purely additive — `line`, `title`, `body`,
  `isSkipped` stay). The detector join needs both sides' offsets.
  Update `scan-it-blocks.test.ts` to assert the new field, leaving
  every other detector's reads of `ItBlock` untouched.

Commit: `feat(tooling): scanDescribeBlocks sibling scanner`.

## Slice 2 — manifest schema for new `gwtTitle` shape

Files:
- `tooling/test-pyramid/parse-manifest.ts`
- `tooling/test-pyramid-budgets-schema.json`
- `test-pyramid-budgets.json`
- `tooling/test/unit/test-pyramid/parse-manifest.test.ts`

Tests (add to existing parse-manifest test):
1. Manifest with `gwtTitle.{describeWhen, describeGiven, describeCombined, itThen, legacyItGwt}` parses to an object exposing five compiled `RegExp`s.
2. Missing any of the five → fail with `manifest invalid: gwtTitle.<field> ...`.
3. Invalid regex string → fail with reason.
4. Legacy `gwtTitle.regex` field alone → fail (no silent acceptance).

Implementation:
- Replace `parseGwtTitle` with field-by-field parsing producing
  `GwtTitleHeuristic` with five compiled regexes (no `g` flag).
- Update JSON schema: object with five required string patterns.
- Update `test-pyramid-budgets.json` to the new shape (patterns from
  design §5).

Commit: `feat(tooling): gwtTitle manifest schema accepts describe/it split`.

## Slice 3 — `detectBadTitle` rewrite

Files:
- `tooling/test-pyramid/detect-bad-title.ts`
- `tooling/test/unit/test-pyramid/detect-bad-title.test.ts`

Tests (one per reason + one per accepted shape):
1. 3-level `describe('Given X') > describe('When Y') > it('Then Z')` → no finding.
2. 2-level `describe('Given X, When Y') > it('Then Z')` → no finding.
3. Outer non-GWT describe wrapping a 3-level GWT group → no finding.
4. `it()` with no literal → `missing`.
5. `it('Then …')` with no GWT ancestor → `when-missing`.
6. `it('Then …')` under `describe('When …')` only → `given-missing`.
7. `it('Then …')` under `describe('Given X')` only → `when-missing`.
8. Reversed nesting `describe('When …') > describe('Given …') > it('Then …')` → `nested-gwt`.
9. Triple-nested GWT (two `Given`s or two `When`s in the chain) → `nested-gwt`.
10. Legacy `it('Given X, When Y, Then Z')` under any ancestors → `legacy-it-gwt`.
11. Non-GWT `it('does X')` → `then-missing`.
12. `.skip` / `.todo` blocks are still validated (uses fixture 5).

Implementation:
- Read both scanners.
- Build the join helper `findDescribeAncestors(itRecord, describes)`
  inside the detector file.
- Apply the §4.3 algorithm verbatim.
- Sort findings by `(path, line)`.

Commit: `feat(tooling): detect-bad-title validates describe→it GWT path`.

## Slice 4 — audit wiring + fixture refresh

Files:
- `tooling/audit-test-pyramid.ts` (only if signature changes; likely no change because findings shape stays `BadTitleFinding[]`).
- `tooling/test/unit/test-pyramid/render-report.test.ts` (existing).
- `tooling/test/integration/audit-test-pyramid.test.ts` (existing).

Tests:
- Integration fixture `tooling/test/integration/fixtures/audit-test-pyramid/` adds:
  - one valid 3-level file (passes),
  - one legacy-shaped file (`legacy-it-gwt`),
  - one missing-When file (`when-missing`),
  - one reversed-nesting file (`nested-gwt`).
- Report renderer (`render-report`) prints the new reasons under the
  `gwtTitle` heading.

Implementation:
- Render: add the new reason names to the gwtTitle section. No
  shape change in `AuditOutcome`; `BadTitleFinding` adds `ancestors`
  (printed as `'A > B'` in the report when non-empty).

Commit: `feat(tooling): report-render new GWT reasons`.

## Slice 5 — codemod tool

Files:
- `tooling/codemod-gwt-describe-split.ts` (new)
- `tooling/test/unit/codemod-gwt-describe-split.test.ts` (new)

Tests:
1. File with N legacy `it()` titles under one describe → emits one 3-
   level structure per `(Given, When)` partition, preserves imports,
   helpers, beforeEach.
2. File with single legacy `it()` → emits 3-level structure (codemod
   does not produce 2-level).
3. File with already-correct 3-level → unchanged.
4. File with mixed legacy + new structure → only legacy `it()`s are
   rewritten; new ones pass through.
5. `--check` exit code 0 on no-changes, 1 on would-rewrite.
6. `--dry-run` prints diff, writes nothing.

Implementation:
- Re-use `scanItBlocks` + `scanDescribeBlocks` to map.
- Parse legacy title with the `legacyItGwt` regex.
- Partition by `(Given, When)` preserving original order.
- Emit a new source string by splicing — never re-format unrelated
  bytes. Two-space indent step, `'` for new string literals to match
  existing style.
- CLI args per design §6.

Commit: `feat(tooling): codemod-gwt-describe-split one-shot rewriter`.

## Slice 6 — sweep run

Files:
- All files under `test/unit/**` and `tooling/test/unit/**` (~219 files).

Procedure:
1. `node --experimental-strip-types tooling/codemod-gwt-describe-split.ts --root .` to rewrite in place.
2. `npm run test:unit` — every test still passes (the rewrite is title-and-nesting only; bodies are untouched).
3. Identify residue (codemod did not rewrite) — fix by hand.
4. `node --experimental-strip-types tooling/audit-test-pyramid.ts` — zero `gwtTitle` findings.

Commit: `chore(tests): sweep unit tests to GWT describe/it split`. Single
commit — the rewrite is mechanical and a per-directory split adds noise
without reviewer benefit.

## Slice 7 — delete the codemod

Files:
- `tooling/codemod-gwt-describe-split.ts` (delete)
- `tooling/test/unit/codemod-gwt-describe-split.test.ts` (delete)

Tests: none; we're removing both.

Commit: `chore(tooling): remove one-shot GWT codemod after sweep`.

## Slice 8 — `cancel-on-merge.yml`

Files:
- `.github/workflows/cancel-on-merge.yml` (new)

Tests: none (workflow file). Validated by `yamllint`-style structure
review only; tested in production by the next PR merge.

Implementation: design §7.2 verbatim.

Commit: `ci: cancel feature-branch runs on PR merge`.

## Slice 9 — docs refresh

Files:
- `docs/BACKLOG.md` — add 19.3c row marked `[x]` referencing ADRs 117–119 and design `phase-19-3c-gwt-describe-it-split.md`.
- `docs/understand/design-decisions.md` — add ADR-117 / 118 / 119 rows in their ADR sections.
- `CLAUDE.md` Test Conventions — rephrase **Titles** bullet:
  > **Titles:** `describe('Given <context>') > describe('When <action>') > it('Then <expected>')`. The 2-level shortcut `describe('Given <context>, When <action>') > it('Then <expected>')` is allowed for groups with a single expectation.
- `CONTRIBUTING.md` — point Test Conventions section at the new shape if it has its own copy (verify; if it just links to CLAUDE.md, nothing to do).
- `README.md` — Test Conventions block (if present) → same rephrasing as CLAUDE.md.

Commit: `docs: update test-convention docs for GWT describe/it split`.

## Slice 10 — review ×3, validate, push, PR

- Run code-reviewer + security-reviewer + typescript-reviewer + test-review in parallel. Three rounds.
- `npm run validate` — green.
- `node --experimental-strip-types tooling/run-stryker-pr.ts` — kill diff-scoped mutants.
- Push branch.
- `gh pr create` with thorough body referencing design + ADRs + sweep
  scope (4,323 leaves migrated across ~219 files).

## Dependencies

```
1 → 3
2 → 3
1, 2, 3 → 4
1, 2, 3 → 5
5 → 6
6 → 7
(8 independent of 1–7 but lands in the same PR)
6 → 9  (CLAUDE.md change must follow successful sweep)
all → 10
```

Slice 8 (CI) can run in parallel with slices 1–7. All slices land on the
single feature branch `feat/19.3-gwt-describe-it-split`.

## Open questions / risk register

- **Codemod residue.** Pre-sweep guess: ≤ 15 files (table-driven,
  string-interpolated, or unusual nesting). Mitigation: hand-fix in
  the same sweep commit.
- **Tests with shared setup that move into nested describes.** Vitest
  hooks (`beforeEach` etc.) cascade outward to inward, so leaving the
  hooks at the existing outer describe still applies them to nested
  leaves. No change needed; the codemod preserves hook positions.
- **`it.each([…])` legacy titles** — the template literal is treated as
  a literal by the scanner. The codemod handles them the same way; the
  hardcoded `Given X, When Y, Then Z` template stays inside the
  `each`'s second-parens position and gets split into `describe`
  wrappers around the `each` call. If the each-array values vary the
  Given or When clause across rows, the codemod cannot split safely;
  flag and hand-fix.
- **Audit run-time cost.** Two scanner passes on 219 files at <1 ms each
  ≈ 0.5 s total. Negligible.
