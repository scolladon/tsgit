# 634 — `status` shares one stat map across its two passes

- **Status:** accepted (ratified by user, against the design recommendation)
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-12 / P10) · **Supersedes/Refines:** —

## Context

`status` lstats every tracked path twice: once in the tracked-diff pass
(`compareWorkingTreeDelta`) and again for the same path during the untracked walk
(`visitEntry`). Deduplicating requires a stat map shared between the two passes — a
restructuring of `status`'s two-pass shape with its own correctness surface (staleness
between passes). The design recommended deferring to its own design; the user ruled it
into scope.

## Options considered

1. Out of scope — its own design (design recommendation).
2. **In scope: a stat map shared between the tracked and untracked passes.**
3. In scope: a short-lived stat cache inside the adapter — a cache with no invalidation
   story on the hottest surface in the library.

## Decision

**Ratified by the user: option 2.** `status` builds/consults one per-run stat map keyed
by repo-relative path: whichever pass stats a path first records the result; the other
pass consumes it instead of issuing a second stat. The map lives for a single `status` invocation
and is never shared across calls — no cross-call invalidation surface exists.

## Consequences

- Roughly one `lstat` saved per tracked path per `status` — a direct `status:clean`
  contribution compounding with ADR-633.
- The staleness window between the two passes narrows to a single stat per path (today
  the two stats already race the working tree; consuming one result twice removes the
  second sample, it does not add a new race class). The stat-cache fast path's semantics
  (mtime/size/ino match ⇒ no re-hash) are unchanged.
- Scoped strictly to `status`'s orchestration; the adapter grows no cache (option 3
  rejected).
