# ADR-107: Pyramid audit heuristics — concrete thresholds, no in-source silencer

## Status

Accepted (at `b511d7f`)

## Context

Phase 19.2 picks two test-shape heuristics to surface in the audit:

1. **Over-mocked integration.** A test under `test/integration/**` that
   uses `vi.mock` / `vi.fn` / `vi.spyOn` / `vi.stubGlobal` / `vi.stubEnv`.
   Real integration tests in this project exercise the memory or node
   adapter, real FS, real HTTP fixtures — not ad-hoc mocks. Mock use is the
   smell that something belongs in `test/unit/` instead.
2. **Under-asserted unit.** An `it()` / `test()` block in `test/unit/**`
   whose body contains zero `expect()` / `assert.*` calls. Such a test passes
   as long as the body doesn't throw — which is a low bar for any branch the
   test was supposed to verify.

Three shapes were considered for how strict the heuristics should be:

1. **Concrete thresholds** — mock count > 0 in integration → finding;
   assertion count == 0 in a unit `it()` → finding. Cheap to implement,
   easy to explain. The 0/0 thresholds happen to match this codebase's
   current state (the integration suite has zero `vi.*` references; the unit
   suite is AAA-disciplined and uses `expect()` heavily).
2. **Heuristic flags, warn-only.** Same checks but reported in a softer
   "consider reviewing" section. Redundant given ADR-104 makes the *entire*
   audit warn-only.
3. **Defer to 19.3 / 19.4.** 19.3's expressiveness lint owns the
   under-assertion ban; 19.4's integration usefulness audit owns the
   mock-density check. Keep 19.2 purely as a ratio counter.

The defer option is appealing for phase-purity but leaves 19.2 thin. The
ratio alone, with no per-file findings, gives a weaker initial signal — and
shipping a tool with two trivial heuristics now means 19.3 / 19.4 can focus
on *promotion* (warn → block) rather than building heuristics from scratch.

A separate question: should the audit accept in-source silencer comments
(e.g. `// pyramid-audit:skip`) for known false positives? Per ADR-104 the
audit can't fail the build, so silencers serve no purpose — there's nothing
to silence. They'd also create a second source of truth (file + comment)
that drifts.

## Decision

Ship both heuristics with hard-coded behaviour as part of 19.2:

### Over-mocked integration

- Tier scope: `test/integration/**/*.test.ts`.
- Detection regex: `\bvi\.(mock|fn|spyOn|stubGlobal|stubEnv)\s*\(`.
- Threshold: `count > 0` per file → finding (file path + hit count).
- The five identifiers are the canonical mock-introducer set. Other
  `vi.*` calls (`vi.useFakeTimers`, `vi.advanceTimersByTime`) are timer
  control, not dependency substitution, and stay welcome in integration
  tests.

### Under-asserted unit

- Tier scope: `test/unit/**/*.test.ts`.
- Detection: brace-balanced scanner. Find each `it(` / `test(` opener,
  locate its `=> {` body opener, advance a brace counter through the body,
  count assertions matching
  `\b(expect\w*|assert(\.|Equal|That)?)\s*\(`.
- Threshold: `count == 0` in a non-skipped test → finding (file + line +
  test title).
- Exemptions: `.skip` / `.todo` / `.fails` / `.concurrent.skip` are counted
  in the file's `it()` total but skipped from the assertion-count check.
  `.each([...])` blocks are counted as one test.

### No in-source suppression

- No `// pyramid-audit:skip` comment, no `.audit-ignore` file, no
  per-test escape hatch. Findings are surfaced; the team decides whether to
  fix the test, fix the heuristic, or accept the noise.

### Calibration data

- Both heuristics' regexes and thresholds live in
  `test-pyramid-budgets.json`. Tightening / loosening either is a manifest
  edit + an ADR.

## Consequences

### Positive

- Cheap detection logic that runs on file-text alone; no compiler-API dep.
- Bootstraps with a current-state baseline of zero findings on the
  over-mocked check and a tractable initial list on the under-asserted
  check.
- 19.3 / 19.4 inherit a calibrated heuristic — they only need to debate the
  *promotion* (warn → block) once the report has run for a few cycles.

### Negative

- Helper functions like `expectFoo(...)` count as assertions (they match
  `\bexpect\w*\(`). False-negative risk: a test that calls only
  `expectFooSilently()` where the helper doesn't actually assert. Mitigation:
  ADR-104's report-only stance — refine the regex when a real case shows up.
- The brace scanner mis-counts pathological test layouts (a template
  literal containing `{`, a comment containing `it(`). Mitigation: the
  AAA-disciplined project style avoids those patterns; mis-counts surface
  as visible findings and are easy to refute or fix.

### Neutral

- The decision to skip a silencer mechanism mirrors `check:doc-links`
  (ADR-095), which also runs as a report without per-link opt-outs.
