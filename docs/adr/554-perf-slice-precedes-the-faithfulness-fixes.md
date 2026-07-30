# 554 — The perf slice lands first; the two faithfulness fixes follow it in the same PR

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

Pinning the whitespace drop verdicts against git 2.55.0 to build a differential oracle
uncovered two **pre-existing** divergences from canonical git, neither caused by nor
fixed by the performance work:

- **C4** — a file that only *gains a trailing LF*. `LineDigest.terminated` participates in
  `digestsEqual`, so tsgit treats the gain as significant and keeps the file; git drops it
  under both `-w` and `--ignore-space-at-eol`. The `withStat` path diverges identically
  (`normalizeLine` preserves the LF, `bytesEqual` sees it).
- **C5** — a whitespace-only change on a 70 000-byte line. tsgit's
  `MAX_LINE_BYTES = 65 536` marks the side binary and a binary side is never dropped;
  git's text/binary heuristic is NUL-in-the-first-8000-bytes only and has no line-length
  cap.

The prime directive makes fixing both non-optional. The question is sequencing, because
the performance change's whole review economy rests on the invariant "the verdict must
not move" — which is also the differential oracle's premise.

## Options considered

1. **Perf slice first, reproducing today's verdicts exactly; then fix C4 and C5 as
   separate ordered commits in the same PR, each with its own ADR and interop case**
   (designer's recommendation).
2. **Fix the divergences first**, then build the fast path on the corrected verdicts —
   cons: the perf baseline moves mid-PR and the differential test is written against
   verdicts that just changed.
3. **Pure perf; file C4 and C5 elsewhere** — cons: deviates from the standing
   no-follow-ups default.

## Decision

**Option 1**, ratified by the user. Ordered, not merged.

## Consequences

Merging a verdict change into the perf change would poison the differential oracle and
destroy the property that makes the perf diff cheap to review, so the ordering is
load-bearing rather than cosmetic. The perf slice's tests therefore assert *today's*
verdicts including C4 and C5; the two fix commits then update exactly those assertions,
which is the visible, reviewable statement of what each fix changes. Each fix carries its
own ADR and its own `diff-whitespace-modes-interop` case. C4's fix must cover the
`withStat` path in the same commit — write-path symmetry is a recurring blind spot on
this repository. C5's fix reopens a deliberate denial-of-service cap and therefore owes
an explicit threat argument; because the design characterises both divergences but
designs neither fix, the design is revised to cover them before planning.
