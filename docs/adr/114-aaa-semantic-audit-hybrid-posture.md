# ADR-114: 19.3a posture — detect *and* sweep in the same PR

## Status

Accepted (at `4db24d2`)

## Context

BACKLOG entry 19.3a frames the work as a binary choice:

> Either (a) teach `detect-missing-aaa` to flag empty-section sandwiches,
> or (b) sweep the offenders and either delete redundant markers
> (single-statement bodies) or refactor to extract a `sut` variable.

Two pure options:

- **(a) only — detect, no sweep.** The lint catches the pattern going
  forward. 518 existing offenders remain in the tree, gated only on
  *new* offenders introduced post-PR. The gate is meaningful immediately
  for new code but the existing tree stays inconsistent with itself.
- **(b) only — sweep, no detect.** The 518 existing offenders are
  rewritten. Nothing prevents the pattern from coming back the next time
  someone autofixes an `aaaBody` finding into adjacent markers.

Neither option closes the loop. Option (a) tolerates the legacy debt
indefinitely; option (b) buys cleanup that decays the moment the next
PR lands.

The 19.3 PR established the working pattern: implementation commits +
cleanup commits + gate-flip commit, all in one PR. That same shape
applies here.

## Decision

**Both. Detect *and* sweep, in the same PR, with the gate flipped at
the end.**

- **Implementation commits land first** with the new detector and gate
  default-off (`gating.emptyAaaSection: false`), so CI stays green
  while the existing 518 violations are still present.
- **Sweep commits land next**, one per directory under `test/unit/`
  (≈ 20 commits, following the §6 sweep policy in
  `docs/design/phase-19-3a-aaa-marker-semantic-audit.md`).
- **Gate-flip commit lands last**, switching
  `gating.emptyAaaSection` to `true`. CI on this commit fails if any
  sweep commit missed a case.

This treats the BACKLOG's "or" as "and". The reading is justified
because the project's standing posture (19.2 §5.3, 19.3 §2) is
"violations are fixed in the test, not silenced." A gate with no
cleanup behind it is silence by another name.

## Consequences

### Positive

- **Tree stays consistent with the gate** — the lint and the codebase
  ship in lockstep, no permanent "legacy" carve-out.
- **Discoverable for new contributors** — the pattern that triggers
  the gate doesn't exist in the codebase as a precedent to copy.
- **Same playbook as 19.3** — reviewers already know how to read a
  PR shaped like this.

### Negative

- **Large PR.** ~20 sweep commits + implementation + gate flip is a
  big merge. Mitigated by atomic per-directory commits — reviewers
  can paginate.
- **Sweep work is mechanical but not trivial.** Three rewrite recipes
  must be applied correctly; tests must keep passing per commit.
  Mitigated by running `npm run test:unit` in CI on every commit.

### Neutral

- A pure-option-(a) PR would have been smaller and shipped faster, but
  would have left 19.3a permanently "half-done" in the BACKLOG sense.
  Acceptable tradeoff.
- Future similar BACKLOG items framed as "either / or" should be read
  as "both unless one is clearly excluded by scope or cost." This ADR
  is the precedent for that reading.
