---
subjects:
  - src/application/commands/add.ts
---
# 1237 — add decides "outside the sparse definition" with git's predicates per route

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-B, R5) · **Supersedes/Refines:** applies DOCTRINE D-2

## Context

tsgit's `add` leaves an entry alone when its bit is set. git tests the sparse patterns on the
tracked-update and untracked routes, and the bit on the unmatched-literal route. Once ADR-1236
clears the bit of a present out-of-pattern file, a bit-only `add` stages it, where git refuses
`add a/f` (S7, A1) and skips it under `add -A` (S7b, A2).

## Options considered

1. **git's per-route predicates, with the pattern matcher loaded once per call** (recommended).
2. Feed `add` the raw on-disk index — wrong once any writer persisted `H` (A1, A2).
3. Leave `add` unchanged — ships the S7/A2 regression.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — DOCTRINE D-2: a row the change newly
reaches is folded whole. A cleared out-of-pattern file is neither staged nor removed, and a literal
naming it is reported in `AddResult.sparse`.

## Consequences

### Positive

- `add` matches git whatever bit the index holds.

### Negative

- `add` reads the sparse patterns on every call under sparse checkout.
