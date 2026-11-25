---
subjects:
  - src/application/primitives/compare-working-tree-entry.ts
---
# 1264 — A refresh rewrites an entry's stat only when the compare fails

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (G-e, R4) · **Supersedes/Refines:** applies DOCTRINE(D-2); consumer of ADR-1261

## Context

`shouldRefresh` decides which entries a refresh rewrites, and it uses the nanosecond compare.
After a same-second `chmod`, `status` writes the file's new ctime into the index. git's
`refresh_cache_ent` returns the entry as read whenever `ie_match_stat` reports no change, so
`ls-files --debug` shows the old stat (rows A5, C2s, C3s).

## Options considered

1. **`shouldRefresh` uses the shared compare with the scan's `StatCheck`** (recommended).
2. Keep refreshing on any drift.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-2): `shouldRefresh` is a consumer of
the compare the change fixes. Option 1.

Refused: option 2 keeps the on-disk index different from git's.

## Consequences

### Positive

- The index entry is byte-identical to git's after `status` on rows A5, C2s and C3s.

### Negative

- A drift inside one second stays unrecorded in the index, as in git's.
