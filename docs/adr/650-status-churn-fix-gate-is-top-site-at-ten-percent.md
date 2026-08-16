# 650 — The status-churn fix gate is top-site-or-nothing at 10 %

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D12)

## Context

The `status` workload spends 17.5 % of profiled ticks in GC with `MapPrototypeSet` and
`ArrayPrototypeJoin` hot — but no single frame is attributed yet. The brief mandates an
allocation profile before any code edit. The open question was the exit criterion when
the profile lands: what counts as an attributable construct worth editing, and what is
honestly "diffuse — no change".

## Options considered

1. **Fix only the top attributed site; below a stated share, record the finding and
   ship no code change (design recommendation; threshold user-owned)** — pros: keeps
   "investigate, then fix" honest in both directions; the GC-share oracle stays
   attributable to one edit / cons: leaves sub-threshold churn on the table.
2. **Fix every candidate above a lower share in one pass** — pros: more recovered churn
   / cons: the before/after delta becomes un-attributable across simultaneous edits.
3. **Defer the item to its own run once the allocation profile exists** — pros: cleanest
   separation / cons: postpones a measured cost with a pre-chewed candidate list.

## Decision

**Option 1, threshold 10 % (user-ratified).** The allocation profile is captured first
on the unmodified tree; if its top site accounts for ≥10 % of allocated bytes on the
status workload, that one site is fixed and re-measured; below 10 %, the outcome is a
recorded finding and no code change. Either outcome closes the item.
