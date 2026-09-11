---
subjects:
  - src/application/commands/blame.ts
---
# 844 — blame -L swaps inverted bounds as git does

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-9) · **Supersedes/Refines:** none

## Context

`blame -L` today seeds the whole file and filters at the end; the change seeds one entry over the
requested window, as git's `blame_entry` does, and moves the range validation up to the seed.
Pinning the `-L` matrix against git 2.55.0 showed that `git blame -L 4,2` **swaps** the bounds
(`line-range.c` `parse_range_arg`: `if (*begin && *end && *end < *begin) SWAP(*end, *begin)`) and
succeeds, where tsgit refuses `INVALID_OPTION` "range end 2 precedes start 4". No decision record
pinned the refusal; it was documented as behaviour.

## Options considered

1. **Swap like git** (recommended, chosen) — pros: faithful (ADR-226); the range code is rewritten anyway; pinned row for row by the interop matrix / cons: a documented refusal becomes a success.
2. **Keep the refusal as a recorded divergence** — cons: a permanent divergence on a refusal surface for no benefit.
3. **Defer the swap to a separate item** — cons: lands the rewrite twice.

## Decision

**User-ratified.** The bounds are checked in git's order — each bound must be a positive integer
(begin first), inverted bounds are swapped, a start beyond the file's line count refuses
`file has only N lines`, an end beyond it is clamped — and the refusal for an inverted range is
removed. Every other message is verbatim as today.

## Consequences

The only intentional behaviour change in `blame` in this change: `-L 4,2` now blames lines 2–4.
The option documentation and the command page drop the "inverted range refuses" clause. The
matrix — window, clamp, swap, each refusal with its exact message and exit 128, the empty file with
and without a range, the working-tree seed — is pinned in the blame interop test.
