# Phase 19.3 — Unit-test expressiveness lint — Implementation plan

Derived from `docs/design/phase-19-3-unit-test-expressiveness-lint.md` and
ADRs 109–113. Each step lists Red → Green → Refactor; atomic commits per
step.

Convention reminders:
- Test titles: `Given <ctx>, When <act>, Then <expected>`.
- Test body: AAA section comments (`// Arrange`, optional `// Act`,
  `// Assert`). SUT variable is `sut`.
- 100% coverage on `tooling/test-pyramid/**`; scripts excluded from
  Stryker (ADR-108).

## File inventory

| # | Action | Path |
|---|---|---|
| 1 | NEW | `tooling/test-pyramid/scan-it-blocks.ts` (extracted from `detect-under-asserted.ts`) |
| 2 | EDIT | `tooling/test-pyramid/detect-under-asserted.ts` — re-import from scan-it-blocks |
| 3 | NEW | `tooling/test-pyramid/detect-bad-title.ts` |
| 4 | NEW | `tooling/test-pyramid/detect-missing-aaa.ts` |
| 5 | NEW | `tooling/test-pyramid/detect-banned-sut-name.ts` |
| 6 | NEW | `tooling/test-pyramid/detect-bare-class-throw.ts` |
| 7 | EDIT | `tooling/test-pyramid/parse-manifest.ts` — new heuristic shapes + gating block |
| 8 | EDIT | `tooling/test-pyramid/render-report.ts` — sections for new findings |
| 9 | EDIT | `tooling/test-pyramid/types.ts` — shared finding shapes (or per-file) |
| 10 | EDIT | `tooling/audit-test-pyramid.ts` — wire new detectors, compute gating exit code, `--report-only` flag |
| 11 | EDIT | `test-pyramid-budgets.json` — new heuristic entries + `gating` map |
| 12 | EDIT | `tooling/test-pyramid-budgets-schema.json` — match new manifest shape |
| 13 | NEW | `tooling/test/unit/test-pyramid/scan-it-blocks.test.ts` |
| 14 | EDIT | `tooling/test/unit/test-pyramid/detect-under-asserted.test.ts` — trim scanner cases that moved |
| 15 | NEW | `tooling/test/unit/test-pyramid/detect-bad-title.test.ts` |
| 16 | NEW | `tooling/test/unit/test-pyramid/detect-missing-aaa.test.ts` |
| 17 | NEW | `tooling/test/unit/test-pyramid/detect-banned-sut-name.test.ts` |
| 18 | NEW | `tooling/test/unit/test-pyramid/detect-bare-class-throw.test.ts` |
| 19 | EDIT | `tooling/test/unit/test-pyramid/parse-manifest.test.ts` |
| 20 | EDIT | `tooling/test/unit/test-pyramid/render-report.test.ts` |
| 21 | EDIT | `tooling/test/integration/audit-test-pyramid.test.ts` — exit-code, `--report-only`, new finding fixtures |
| 22 | CLEANUP | unit tests that fail the gate (small list, mostly title rewrites) |
| 23 | EDIT | `test-pyramid-budgets.json` — flip `gating.*` to true (last commit) |
| 24 | EDIT | `README.md`, `CONTRIBUTING.md`, `docs/understand/testing.md` — describe gated heuristics |
| 25 | EDIT | `docs/BACKLOG.md` — flip 19.3 `[ ]` → `[x]` |

## Step sequence

### Step 1 — Extract `scan-it-blocks.ts` (RGR)

**Red**: write `scan-it-blocks.test.ts` covering the cases currently in
`detect-under-asserted.test.ts` scanner-scope:

- Single `it()` with literal title.
- `it.skip` / `it.todo` / `it.fails`.
- `it.each([...])` (skips the data array, lands on inner title).
- Multi-line opener.
- Nested `describe` doesn't fool the brace counter.
- String literal containing `it(` is not picked up.

**Green**: copy the scanner verbatim from `detect-under-asserted.ts` to a
new `scan-it-blocks.ts` exporting `scanItBlocks(source: string):
ReadonlyArray<ItBlock>`.

**Refactor**: in `detect-under-asserted.ts`, replace the local scanner
with `import { scanItBlocks } from './scan-it-blocks.ts'`. Strip the
scanner's coverage cases from `detect-under-asserted.test.ts` (they live
in `scan-it-blocks.test.ts` now); keep the assertion-counting cases.

Commit: `refactor(scripts): extract scanItBlocks into shared module`.

### Step 2 — Manifest extension + schema (RGR)

**Red**: extend `parse-manifest.test.ts` with the new heuristic shapes
and `gating` block. Cases:

- All new heuristics parse correctly (`gwtTitle`, `aaaBody`, `sutNaming`,
  `bareClassToThrow`).
- Each new heuristic's invalid forms throw `manifest invalid: <reason>`.
- `gating` object validates: keys must be known heuristic names; values
  must be booleans; missing keys default to `false`.
- Backwards compat — a manifest without `gating` parses (everything
  defaults to `false`).

**Green**: implement `parseGwtTitle`, `parseAaaBody`, `parseSutNaming`,
`parseBareClassToThrow`, `parseGating` in `parse-manifest.ts`. Extend the
`PyramidManifest` interface. Extend the JSON schema.

**Refactor**: extract the regex-compile helper if duplicated.

Commit: `feat(scripts): extend pyramid manifest with expressiveness heuristics`.

### Step 3 — `detect-bad-title.ts` (RGR)

**Red**: `detect-bad-title.test.ts`:

- GWT-compliant title → no finding.
- Missing `When` clause → finding (`reason: 'malformed'`).
- Missing `Then` clause → finding.
- Lowercase `given` → finding.
- Missing title (arrow-only `it(() => {})`) → finding (`reason:
  'missing'`).
- `.each` template literal validated.
- `.skip` block still validated.
- Multi-line title spanning two lines.

**Green**: implement detector. Accepts `(manifest, files)`; returns
`ReadonlyArray<BadTitleFinding>`. Uses `scanItBlocks`. Skips files
outside the unit tier.

**Refactor**: extract title-regex compile into the manifest layer.

Commit: `feat(scripts): detect non-GWT unit test titles`.

### Step 4 — `detect-missing-aaa.ts` (RGR)

**Red**: `detect-missing-aaa.test.ts`:

- `// Arrange` + `// Assert` present → no finding.
- Only `// Arrange` → finding (`missing: ['Assert']`).
- Only `// Assert` → finding (`missing: ['Arrange']`).
- Both missing → finding (`missing: ['Arrange', 'Assert']`).
- `// Act` alone is not enough (Arrange + Assert still required).
- Trailing prose `// Assert — covers all` matches.
- `// Assertion` (compound word) does *not* match `Assert`.
- Inline `expect(x) // Assert` (mid-line) does *not* match.
- Skipped block exempted.

**Green**: implement detector using the line-anchored regex from
ADR-112.

Commit: `feat(scripts): detect missing AAA body comments`.

### Step 5 — `detect-banned-sut-name.ts` (RGR)

**Red**: `detect-banned-sut-name.test.ts`:

- `const sut = ...` → no finding.
- `const subject = ...` → finding (`alias: 'subject'`).
- `let objectUnderTest = ...` → finding.
- `var systemUnderTest = ...` → finding.
- `const cut = ...` → finding.
- Destructured `const { subject } = ...` → no finding (documented limitation).
- Reading `obj.subject` → no finding.
- Skipped block exempted.

**Green**: implement detector.

Commit: `feat(scripts): detect banned SUT name synonyms`.

### Step 6 — `detect-bare-class-throw.ts` (RGR)

**Red**: `detect-bare-class-throw.test.ts`:

- `expect(fn).toThrow(TsgitError)` → finding (`identifier:
  'TsgitError'`).
- `expect(fn).toThrowError(TsgitError)` → finding.
- `expect(fn).toThrow('message')` → no finding.
- `expect(fn).toThrow(/regex/)` → no finding.
- `expect(fn).toThrow(expect.objectContaining({}))` → no finding.
- `expect(fn).toThrow(new Foo())` → no finding.
- `expect(fn).toThrow(lowercase)` → no finding (lowercase identifier).
- Skipped block exempted.

**Green**: implement detector.

Commit: `feat(scripts): detect bare-class .toThrow(Class) patterns`.

### Step 7 — Wire new detectors into `audit-test-pyramid.ts` (RGR)

**Red**: extend `audit-test-pyramid.test.ts`:

- Synthetic fixtures triggering each gated heuristic → exit `1`.
- Clean fixtures → exit `0`.
- `--report-only` flag → exit `0` even with findings.
- Reports include sections for each new heuristic.

**Green**: extend `runAudit` to return all findings (including new
ones). Extend `writeReports` and `renderMarkdown` / `renderJson`.
Implement `computeExitCode(outcome, manifest, reportOnly)`.

**Refactor**: tighten the exit-code function's signature; ensure
`process.exit` is the only mutation in the main module.

Commit: `feat(scripts): gate audit on expressiveness heuristics`.

### Step 8 — `render-report.ts` extensions (RGR)

**Red**: extend `render-report.test.ts`:

- Markdown contains "GWT title", "AAA body", "SUT naming", "Bare-class
  toThrow" sections.
- JSON output includes the new finding arrays.
- Empty findings render as `_none_`.

**Green**: extend renderers.

Commit: bundled with step 7 if small; otherwise separate `feat(scripts):
render expressiveness findings in audit report`.

### Step 9 — Cleanup commits (one per heuristic)

Run `npx tsx tooling/audit-test-pyramid.ts --report-only` locally; for
each finding type, fix the tests in an atomic commit:

- `test(unit): convert non-GWT titles to Given/When/Then`
- `test(unit): add AAA body comments where missing`
- `test(unit): rename SUT synonyms to sut`
- `test(unit): replace bare-class toThrow with data assertions`
- `test(unit): add assertions to under-asserted blocks` (if any)

Order is independent across heuristics; commits can be interleaved by
the lowest-friction sequence.

### Step 10 — Flip gating

After cleanup, set:

```json
"gating": {
  "underAssertedUnit":      true,
  "gwtTitle":               true,
  "aaaBody":                true,
  "sutNaming":              true,
  "bareClassToThrow":       true,
  "overMockedIntegration":  false
}
```

in `test-pyramid-budgets.json`. CI on this commit must be green; failing
means a missed cleanup case.

Commit: `feat(scripts): enable gating for unit-test expressiveness lint`.

### Step 11 — Three review passes

Run agents/skills in parallel per pass:
- `code-reviewer` agent — diff hygiene, type safety, naming.
- `security-reviewer` agent — regex-injection / catastrophic
  backtracking on the new patterns.
- `typescript-reviewer` agent — idiomatic patterns, branded types.
- `test-review` skill — mutation-resistant assertion shapes.

Repeat three times, fixing every finding each round.

### Step 12 — Harness green + mutation

- `npm run validate` — full pipeline.
- `npm run test:mutation` (or scoped via `test:mutation:pr`) — keep
  bucket budgets per ADR-101. Scripts/test-pyramid stay excluded
  (ADR-108).

### Step 13 — Docs refresh

Update:
- `README.md` — reference the gated discipline rules in the "Why
  tsgit" section (one line) and link to `docs/understand/testing.md`.
- `CONTRIBUTING.md` — describe how to run `check:test-pyramid`
  locally, where to look in the report, and the `--report-only`
  escape hatch.
- `docs/understand/testing.md` — heuristic-by-heuristic explanation
  of the four expressiveness rules + the promoted under-asserted
  rule.
- `RUNBOOK.md` — if the audit script gets a new failure mode worth
  documenting.

Flip `docs/BACKLOG.md` 19.3 `[ ]` → `[x]`.

Commits:
- `docs: document gated expressiveness lint`
- `docs(backlog): mark 19.3 complete`

### Step 14 — Push & PR

Push the branch; open the PR with summary + test plan. Squash-merge on
green. Cleanup worktree and branch.

## Dependency graph

```
Step 1 (scan-it-blocks) ──┬─> Step 3 (bad-title)        ─┐
                          ├─> Step 4 (missing-aaa)       ├─> Step 7 (wire)
                          ├─> Step 5 (banned-sut)        │
                          └─> Step 6 (bare-class-throw)  │
                                                         │
Step 2 (manifest) ───────────────────────────────────────┘
                                                         │
Step 7 (wire) ──> Step 8 (render) ──> Step 9 (cleanup) ──> Step 10 (flip)
                                                              │
                                                              ▼
                                                    Step 11 (review) ──> 12 ──> 13 ──> 14
```

Steps 3–6 are parallelisable; they share `scan-it-blocks` but produce
independent detectors. If running in parallel agent teams, assign one
detector per agent and merge before step 7.

## Verification at each step

Every step ends with `npm run check:types`, `npm run test:unit`, and the
specific new test file passing. Step 10 (flip) additionally requires
`npm run validate` to be green end-to-end.

## Out-of-scope reminders

Carried over from `docs/design/phase-19-3-unit-test-expressiveness-lint.md`
§2 / §14:

- No AST parser; regex/brace only.
- No allowlist / suppression mechanism.
- No PR-comment posting.
- No promotion of `overMockedIntegration`.
- No new test runtimes (Deno/Bun/Workers — 19.8).
