---
subjects:
  - src/application/primitives/internal/is-entry-stat-clean.ts
---
# 1263 — A zero recorded size on a non-empty blob never matches the work file

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (G-d, R1) · **Supersedes/Refines:** applies DOCTRINE(D-5); completes ADR-1261

## Context

git's `ce_match_stat_basic` ends with a branch tsgit lacks: a recorded size of zero on an entry
whose blob is not the empty blob is a change. That is the mark the racy smudge leaves.

Main catches a smudged entry whose file was then truncated to zero bytes only through the mtime
nanoseconds (rows F1, F2). Under the whole-second compare of ADR-1261 every field matches, zero
against zero: `status` would report the file clean and `checkout -- f` would leave it empty.

## Options considered

1. **The branch sits inside the shared compare, so every judge and the smudge pass apply it**
   (recommended).
2. The branch is added to each caller that needs it.
3. No branch; the racy test is trusted to cover the shape.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-5): the gap is in the compare the
change edits. Option 1.

Refused: option 2 repeats the test at five call sites. Option 3 fails once the index leaves the
entry's second, which is rows F1 and F2.

## Consequences

### Positive

- Rows F1 and F2 keep matching git.
- The smudge pass skips an entry it already smudged: one content read fewer.

### Negative

- An entry recorded with a zero size is always settled by content, as git settles it.
