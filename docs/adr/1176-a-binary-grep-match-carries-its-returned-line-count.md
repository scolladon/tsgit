---
subjects:
  - src/application/commands/grep.ts
---
# 1176 — a binary grep match carries its returned-line count

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-blob-target.md · **Supersedes/Refines:** refines ADR-1171, ADR-1174

## Context

For a binary blob, `git grep -c` prints the number of lines the matcher returns, not 1
(git 2.56: `bin\0NEEDLE\nNEEDLE\n` ⇒ `HEAD:b.bin:2`, on a tree target and a blob target alike).
tsgit returned only `binaryMatch: true` with empty `hits`, so a caller could not rebuild git's
count, and the grep doc projected `binaryMatch ? 1 : hits.length`. Found by review on this change,
which carried the same projection to the new blob target.

## Decision

**Ratified by the user.** `GrepBlobResult` gains `binaryMatchCount: number`: the number of lines of
the bounded 64 KiB window the invert-aware matcher returns; `0` for a text blob. `binaryMatch` stays,
true exactly when the count is positive. The binary verdict counts every line of the window instead
of stopping at the first returned one.

Rejected: correcting the doc and recording the gap in the divergence ledger (leaves a consumer API
gap above the filing bar), and deferring to the backlog.

## Consequences

### Positive

- `-c` over a binary blob is rebuilt from data, as git prints it, on every target.

### Negative

- No early exit: a binary blob costs one full window scan (bounded, ≤ ~8 ms measured on a
  one-LF-every-2-bytes window).
- Returned lines past the first 64 KiB are not counted, so such a binary blob counts lower than
  `git grep -c` (the window's existing residual).

### Neutral

- Additive field; existing callers are unaffected.
