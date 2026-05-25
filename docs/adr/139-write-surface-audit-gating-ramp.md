# ADR-139: Write-surface audit ships warn-only, promotes after one cycle

## Status

Accepted (at `69fb435`)

## Context

19.7 ships a new audit (`check:write-surfaces`) that enforces every
`@writes`-tagged surface in `src/` has a matching
`cross-tool-interop` test (or an allowlist entry). The gating
posture has two precedents to choose between:

- **Blocking from day one** — ADR-132 (browser surface audit).
  Justified there because (a) the property is binary, (b) the
  transition cost was paid in the same PR (31 gaps closed up
  front).
- **Warn-only first PR, blocking after one cycle** — ADR-099 (docs
  PR gate) and ADR-125 (integration usefulness). Justified there
  because the heuristics are fuzzy enough that flaky findings
  shouldn't block real work.

19.7's audit measures a binary property (a surface is covered or
not), which leans towards ADR-132's posture. But the transition
cost is larger than 19.5a's: this PR adds 13 new interop tests
spread across 14 byte-emitting surfaces. The tests themselves are
non-trivial (peer-tmpdir setup, git binary spawns, comparison
strategy per kind). Bugs in the interop tests would cause audit
failures that look like coverage gaps but are actually test bugs;
blocking on day one means PR authors retrofit the test fixes under
time pressure.

## Decision

The `check:write-surfaces` audit ships **warn-only** in the sweep
PR (this PR). A follow-up PR, no earlier than one full merge cycle
later, flips `gating.writeSurfaces: false` to `true` once the audit
has been clean across that cycle.

Same posture as ADR-099 / ADR-125. Different rationale than
ADR-132: the property is binary, but the test-side risk is high
enough that one observation cycle is worth more than one PR's
worth of grace.

If a coverage drop happens during the warn-only cycle, the audit
report makes it visible in the PR diff (the per-surface `gaps[]`
list); reviewers can demand the fix before merge even without a
hard block.

## Consequences

### Positive

- The sweep PR can land even if one interop test has a flaky
  comparison or a missing `it.skipIf(!hasGit())` guard — the audit
  reports the gap, the test gets a quick follow-up, and the next
  PR flips the gate.
- The pattern is consistent with the project's recent posture
  (ADR-099, ADR-125), reducing the cognitive load on contributors
  who already learned that audit-gates start warn-only.

### Negative

- For one cycle, a coverage drop could slip through if a reviewer
  doesn't read the audit's report. Mitigated by the report being
  committed (diff visibility) and by the fact that the gate flips
  blocking shortly after.
- "One cycle" is a fuzzy unit. Operationalised as "the next
  conventional follow-up PR after this one merges," matching how
  19.4 promoted its `integrationProof` gate.

### Neutral

- The audit's wireit script + report writing run identically in
  warn-only and blocking modes; only the exit code differs.
  Promotion is a one-line manifest change.
- An attacker who lands a malicious src change in the warn-only
  cycle that adds a `@writes` tag without a matching test would
  surface as a coverage gap in the report, but wouldn't fail the
  build. The threat model for this audit is contributor error,
  not malicious supply-chain attack; the warn-only window is
  acceptable.
