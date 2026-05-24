# Phase 19.2 — Testing-pyramid audit

Wave 0 continuation. 19.1 hardened the mutation feedback loop; 19.2 turns the
same scrutiny on the test suite itself: how many tests live at each tier, what
ratio do they hit, and which ones look suspicious (over-mocked integrations,
under-asserted units).

This is a tooling-and-observability phase: no product code, no command
additions. The output is a committed audit script + a machine-readable report
+ a markdown summary. Findings surface in CI logs and (later) PR comments;
they do **not** gate merges.

## 1. Goals

1. **Count tests per tier and report the ratio.** Currently the only signal
   is "all green". A drift from 80/15/5 toward, say, 95/4/1 should be visible.
2. **Surface suspicious tests as concrete findings.** Two heuristics in scope:
   - Integration tests using `vi.mock` / `vi.fn` (real fixtures + the memory
     adapter cover the integration tier; ad-hoc mocks belong in unit tests).
   - Unit `it()` blocks with zero `expect()` / `assert.*` calls.
3. **Single source of truth for the budget.** A `test-pyramid-budgets.json`
   manifest at repo root, validated at load time, parallels the structure of
   `mutation-budgets.json` (ADRs 100–101).
4. **Cheap to run, cheap to maintain.** No new runtime dep beyond the existing
   TypeScript install; regex/brace-scanner parsing in the spirit of ADR-097.

## 2. Non-goals

- **No CI gate.** Per [ADR-104](../adr/104-pyramid-audit-report-only.md) the
  audit is report-only. The fail-on-threshold-miss behaviour is reserved for
  19.3 (under-assertion lint) and 19.4 (integration usefulness audit) where
  the heuristics are sharper.
- **No coverage measurement.** Vitest + Istanbul already cover that.
- **No e2e expansion.** 19.5/19.5a own browser-surface gap-filling; 19.2 just
  counts what's there.
- **No runtime assertion-count tracking.** Static AST/brace parsing is good
  enough for the AAA-disciplined `it()` blocks the project enforces. A
  vitest-reporter approach was rejected for cost (full run) and brittleness
  (runtime can't see `expect()` calls inside helper functions that never ran).
- **No equivalent-mutant-style catalogue for false positives.** If the
  heuristic flags a test the team has accepted as fine, fix the test (add an
  assertion, move it to unit). The point of report-only is that no one has to
  scramble in CI to silence a finding.

## 3. Test classification — directory-based

Per [ADR-105](../adr/105-directory-based-test-classification.md), classification
is purely by path:

| Tier | Glob | Notes |
|---|---|---|
| `unit` | `test/unit/**/*.test.ts` | Pure-function and small-module tests. Mock-friendly. |
| `integration` | `test/integration/**/*.test.ts` (incl. `posix-only/`, `win-only/`) | Real FS / real HTTP / memory adapter via `compose-adapters`. Must not use `vi.mock`/`vi.fn`. |
| `e2e` | `test/browser/**/*.spec.ts` | Playwright-driven (vitest browser project + standalone Playwright per 19.5). |

Excluded from counts:
- `test/fixtures/**` — data only, no test cases.
- `test/bench/**` — benchmarks, gated by `npm run test:bench`.
- `test/**/support/**`, `test/**/fixtures.ts` — helpers, no `describe`/`it`
  blocks at the top level.

Rationale: matches the actual project layout (`vitest.config.ts` already uses
the same globs to wire projects). A heuristic-based classifier (inspect
imports) was considered and rejected as moving the boundary on every refactor.

## 4. Target ratio — 80/15/5 with warn bands

Per [ADR-106](../adr/106-pyramid-ratio-target-and-bands.md):

| Tier | Target share | Warn band | Rationale |
|---|---|---|---|
| `unit` | 80% | < 75% → warn | Hexagonal architecture concentrates logic in `src/domain/**` and tier-2 primitives → unit-heavy. |
| `integration` | 15% | < 10% or > 25% → warn | Real-FS, real-HTTP, posix-only, win-only suites. Drift below 10% means insufficient platform coverage; above 25% suggests unit logic leaked outside `test/unit`. |
| `e2e` | 5% | < 3% → warn | Browser surface-parity (19.3 / 19.5a own ramp-up). A floor only — no upper bound. |

Each test file contributes one count to its tier (file-level granularity).
A future revision can switch to `it()`-block-level counts if file size variance
proves misleading; for now file-count is the cheapest stable signal and matches
how the team talks about coverage ("12 integration tests for clone").

Snapshot at start of 19.2 (informational, not a baseline contract):

| Tier | Files | Share |
|---|---:|---:|
| unit | 207 | 88.0% |
| integration | 24 | 10.2% |
| e2e | 4 | 1.7% |
| **total** | **235** | |

`unit` is above target; that is fine. `e2e` is below the floor; 19.5/19.5a
will close that. The audit will warn on `e2e` from day one — that warning is
the load-bearing signal that the upcoming phases have real work to do.

## 5. Heuristics — concrete thresholds

Per [ADR-107](../adr/107-pyramid-audit-heuristics.md):

### 5.1 Over-mocked integration

Pattern: `\bvi\.(mock|fn|spyOn|stubGlobal|stubEnv)\s*\(` matched per file in
`test/integration/**/*.test.ts`.

Why these five identifiers: `vi.mock` and `vi.fn` are the canonical mock
introducers; `vi.spyOn`, `vi.stubGlobal`, `vi.stubEnv` are the back-doors that
achieve the same effect (replace a real dependency with a controlled stub).
Memory adapter use is *not* a mock — it's a class import from
`src/adapters/memory/**` and produces no `vi.*` calls.

Threshold: > 0 hits → finding (file path + hit count).

### 5.2 Under-asserted units

For each `test/unit/**/*.test.ts`, walk `it(` / `test(` openers and count
`expect(` / `assert.` invocations inside the test body. Threshold: any block
with zero matches → finding (file path + line + test title).

Parser strategy: a small brace-balanced scanner — find each `it(` / `test(`
position, locate the arrow-function body opener `=> {`, then advance a brace
counter until it returns to zero. Within that range, regex-count assertions.
This handles nested `describe()` blocks correctly because we never enter a
nested `it(` — the outer brace counter passes through nested constructs and
the inner test's content is *its* count.

Edge cases:
- `it.skip(...)` / `it.todo(...)` / `it.fails(...)` — counted as a test case
  in the file's `it()` total, but skipped tests don't need assertions. We
  exempt `.skip`, `.todo`, `.fails`, `.concurrent.skip` from the
  under-asserted check (still counted in the file tier-tally though).
- `it.each([...])(...)` — runs once per row but is a single source block. We
  count it as one test and expect at least one assertion in the body.
- Multi-line `it(` openers — supported (the scanner locates `=> {` on any line
  after the opener).
- Helper-function calls like `expectGitObject(...)` — *not* counted. The
  finding for a custom-helper test will surface and the fix is to inline an
  `expect.*` call into the helper or rename it (e.g. our existing
  `expect*` helpers are already named with the prefix and would count).
  Actually: anything matching `expect\.?` at a word boundary counts, so
  `expectGitObject` matches `\bexpect\w*\(` and is included. Rationale:
  helpers that wrap `expect()` typically keep the prefix, and false-positive
  cost is low when output is report-only.

Final regex for assertion-counting: `\b(expect\w*|assert(\.|Equal|That)?)\s*\(`.

### 5.3 No suppression mechanism

Because the audit is report-only, there is no comment-based silencer. If a
finding is wrong, the heuristic is wrong — fix the heuristic. If a finding is
right, fix the test. This is the same posture as the doc-link checker (ADR-095).

## 6. Tooling

### 6.1 Script — `scripts/audit-test-pyramid.ts`

Contract:
- **Inputs (file-system reads):**
  - `test-pyramid-budgets.json` — manifest (see §6.2).
  - All `test/unit/**/*.test.ts`, `test/integration/**/*.test.ts`,
    `test/browser/**/*.spec.ts` resolved via `node:fs/promises` + a
    deterministic glob walker. No external glob dep.
- **Outputs:**
  - `reports/test-pyramid.json` — machine-readable summary.
  - `reports/test-pyramid.md` — markdown table + findings list.
  - stdout — same content as the markdown (for CI logs).
- **Exit code:** always `0` unless the manifest is malformed or a file system
  error occurs. Findings do *not* affect exit code.

### 6.2 Manifest — `test-pyramid-budgets.json`

```json
{
  "tiers": [
    { "name": "unit",        "glob": "test/unit/**/*.test.ts",        "target": 80, "warnBelow": 75, "warnAbove": null },
    { "name": "integration", "glob": "test/integration/**/*.test.ts", "target": 15, "warnBelow": 10, "warnAbove": 25 },
    { "name": "e2e",         "glob": "test/browser/**/*.spec.ts",     "target":  5, "warnBelow":  3, "warnAbove": null }
  ],
  "heuristics": {
    "overMockedIntegration": { "tier": "integration", "regex": "\\bvi\\.(mock|fn|spyOn|stubGlobal|stubEnv)\\s*\\(", "threshold": 0 },
    "underAssertedUnit":     { "tier": "unit", "minAssertionsPerTest": 1 }
  }
}
```

Schema: `scripts/test-pyramid-budgets-schema.json` (JSON Schema draft-07) for
editor support; runtime validation is a hand-rolled checker matching
`mutation-budgets.ts`'s pattern (ADR-101 §4) — no Zod dep.

### 6.3 npm script + wireit

```json
"check:test-pyramid": {
  "command": "tsx scripts/audit-test-pyramid.ts",
  "files": [
    "scripts/audit-test-pyramid.ts",
    "scripts/test-pyramid/**/*.ts",
    "test-pyramid-budgets.json",
    "test/unit/**/*.test.ts",
    "test/integration/**/*.test.ts",
    "test/browser/**/*.spec.ts"
  ],
  "output": ["reports/test-pyramid.json", "reports/test-pyramid.md"]
}
```

Wired into the umbrella `validate` task (alongside `check:doc-coverage`,
`check:doc-links`, `check:mutation-budgets`).

### 6.4 CI integration

Three touch-points in `.github/workflows/ci.yml`:

1. **Run on every PR** as a step in the existing `lint` job — fast (it's pure
   file-scanning), no service deps. Output uploaded as an artifact for
   debugging.
2. **No status gate.** Per ADR-104, the job always exits `0` after a
   successful audit. A future ADR can promote individual heuristics to
   blocking once they prove stable.
3. **PR comment** *(deferred to follow-up)*. The markdown report is suitable
   for `actions/github-script` to post as a PR comment, but the initial cut
   only writes to artifacts to keep the surface area small.

## 7. Module structure

```
scripts/
  audit-test-pyramid.ts             # entry point; orchestrates the three passes
  test-pyramid/
    classify-test-file.ts           # path → tier mapping (pure)
    count-tier-files.ts             # tier counts + ratios (pure)
    detect-over-mocked.ts           # integration regex scanner (pure)
    detect-under-asserted.ts        # unit AAA-block scanner (pure)
    render-report.ts                # JSON + markdown emitters (pure)
    parse-manifest.ts               # manifest loader + validator (pure)
    types.ts                        # shared shapes
test-pyramid-budgets.json           # manifest at repo root
scripts/test-pyramid-budgets-schema.json
```

Each helper is independently unit-testable. The entry point is thin
orchestration (file IO + composition) — its coverage comes from a single
integration test that runs the script end-to-end against a temp directory
fixture.

## 8. Testing strategy

Unit tests (under `test/unit/scripts/test-pyramid/`):

- `classify-test-file` — path → tier table, plus rejection of fixture/bench
  paths.
- `count-tier-files` — empty input, single-tier, all-tiers, share rounding
  rules (banker's rounding vs truncate — TBD in plan).
- `detect-over-mocked` — synthetic file strings with each of the five `vi.*`
  forms and a clean control, plus a content with `vi.mock` inside a comment
  (false-positive accepted under report-only; documented).
- `detect-under-asserted` — multi-test fixtures covering nested describes,
  `.skip` / `.todo` / `.fails`, `.each([])`, multi-line openers, helper-named
  `expectFoo()` calls (matched by the regex).
- `parse-manifest` — happy-path + each failure mode (missing `tiers`,
  malformed thresholds, unknown heuristic name, regex compile error).
- `render-report` — golden snapshot tests for both JSON and markdown outputs.

Integration test (under `test/integration/scripts/`):

- `audit-test-pyramid.test.ts` — spawns the script against a curated temp
  directory containing a small synthetic `test/` tree; asserts the produced
  `reports/*.{json,md}` content. Real file IO, real glob walking.

Property tests: deferred to 19.6 (parsers phase).

Coverage target: 100% lines/branches/functions/statements on every file in
`scripts/test-pyramid/**`. Mutation: every mutant killed; equivalent mutants
documented inline. Per the 19.1 buckets, these files fall into the
`application` bucket — `application/95` break threshold applies.

Actually: `scripts/**` is currently excluded from Stryker (see
`stryker.config.json`). 19.2 follows that convention — the scripts are
build-time tooling, not shipped code. Coverage stays at 100% via vitest;
mutation testing on tooling is out of scope. This stance is captured in
[ADR-108](../adr/108-pyramid-audit-tooling-mutation-policy.md).

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Brace-counter scanner mis-parses unusual test layouts (template literals containing `{`, comments containing `it(`). | Restrict to the disciplined AAA project style; accept a finding for any test the scanner mis-reads as zero assertions — the fix is to simplify the test. False positives are visible (file + line + title) and easy to refute. |
| Regex `\bvi\.(mock|fn|...)\s*\(` matches a string literal mentioning `vi.mock`. | Document under report-only; if it actually shows up, anchor the scanner on top-of-file imports later. The current integration suite has zero `vi.*` references so the regex starts at 0 findings. |
| Audit drifts out of date as new tiers (Deno, Bun, Workers per 19.8) come online. | Manifest is the single source of truth; add a tier entry when the runtime parity matrix lands. The audit fails closed on unknown tiers (manifest-validated). |
| Maintenance cost of yet another check script. | The script is < 400 lines TS, all pure helpers, no network/process spawning. Same shape as `check-mutation-budgets.ts` and `check-doc-coverage.ts`. |

## 10. Acceptance criteria

- `npm run check:test-pyramid` produces `reports/test-pyramid.{json,md}`
  matching the snapshot fixtures.
- Running it on the branch's working tree reports the 207/24/4 baseline above
  and lists zero over-mocked findings (current truth) and the actual list of
  zero-assertion unit tests, if any.
- The manifest is wired into `validate` and the lint workflow.
- README and `docs/understand/testing.md` reference the report.
- `docs/BACKLOG.md` 19.2 is flipped `[ ]` → `[x]` in the same PR.
- Three review passes performed; harness green; mutants killed in the
  application-bucket files (script tooling itself excluded per ADR-108).

## 11. Decisions deferred / out of scope

- **Per-`it()`-block tier weighting.** Counted as one per file for now (§4).
- **AST-based parsing.** Regex/brace-counter is the chosen instrument for
  19.2; switch to `typescript` compiler API if the heuristic catalogue grows
  past three distinct checks.
- **PR-comment posting.** Reports are artifacts; PR-comment automation lives
  in a separate, smaller change once the artifact format stabilises.
- **Promotion to gate.** 19.3 (under-assertion lint) and 19.4 (integration
  usefulness) own the gate-conversion conversation. 19.2 deliberately ships
  with no gate to gather a few cycles of report data first.
