---
subjects:
  - src/application/primitives/internal/is-entry-stat-clean.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
---
# 1262 — The racy test compares whole seconds for every reader and the index writer

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (G-c, R2, R3) · **Supersedes/Refines:** applies DOCTRINE(D-5); completes ADR-1261

## Context

`isRacy` compares nanoseconds, as git's `is_racy_stat` does only under `USE_NSEC`, and has no
guard for a zero index timestamp. An entry staged at T.1 under an index written at T.2 is not
racy for tsgit. Once the field compare of ADR-1261 drops nanoseconds, a same-size edit at T.5
matches every field: `status` would report the file clean and `checkout -- f` would keep the
edit (rows E1, E2).

The write-time smudge uses the same test, so on main it already skips an entry git smudges on an
unrelated index write (row E3).

## Options considered

1. **One `isRacyTimestamp`: not a gitlink, index seconds not zero, index seconds at or before the
   entry's mtime seconds; used by every reader, by `hasRacyTimestamp` and by the smudge pass**
   (recommended).
2. Whole seconds for the smudge pass only.
3. Keep the nanosecond test.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-5): the divergence is proven in the
seam the change edits, and the readers and the writer must move together. Option 1.

Refused: options 2 and 3 turn rows E1 and E2 into data-integrity failures under ADR-1261.

## Consequences

### Positive

- Row E3 matches git; rows E1 and E2 keep matching.

### Negative

- Every entry sharing the index's second is hashed until the next index write, as git hashes it.
  ADR-1267 gates that cost.
