# 570 — The promise-memo invariant is codified as ADR only

- **Status:** accepted
- **Date:** 2026-08-01
- **Design:** docs/design/pack-registry-single-flight.md · **Supersedes/Refines:** none

## Context

The invariant this change establishes — any lazy initializer that crosses an `await`
must memoise the promise, not the result; if the initialization owns a disposable,
`dispose`/`refresh` must capture and await the pending promise; a slot clearable by
anything other than the initializer needs an identity-guarded clear — needs a home.
The design's audit of every lazy initializer in `src/` found exactly two offending
sites in ~32k graph nodes, both fixed by this change; every other resource-owning memo
was already promise-based.

## Options considered

1. **ADR only**, plus a doc-comment on the ADR-566 helper (designer's recommendation) —
   the rule sits closest to the one named implementation new code would reach for.
2. **ADR + a `check:lazy-memos` scanner** wired into validate — "owns a disposable" is
   not syntactically decidable, so it either misses the case that matters or drowns in
   false positives on pure value caches; near-pure allowlist maintenance for a
   two-site historical defect rate.
3. **ADR + a CLAUDE.md Domain Invariants bullet** — drift risk for a rule with a single
   implementation site; the helper's doc-comment is closer to the code.

## Decision

**Ratified by the user: option 1** — chosen over the run brief's initial request for a
review-battery checklist lens; the user's in-conversation judgment supersedes the brief.

## Consequences

This ADR is the invariant's record; the helper's doc-comment is its in-code beacon. No
scanner, no checklist line — future reviews rely on the ADR trail and the helper being
the obvious tool. If a third offending site ever appears, revisiting option 2 is cheap
and this ADR is the place that says so.
