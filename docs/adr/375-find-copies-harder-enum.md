# ADR-375: `--find-copies-harder` is the `copies: 'harder'` enum value

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-373](373-detection-option-api.md)

## Context

git's copy detection has three states: off, plain `-C` (copy sources = files changed in
the diff), and `-C --find-copies-harder` / `-C -C` (copy sources = ALL preimage paths,
unchanged included — far more expensive). The option surface (ADR-373) must encode
which of the three is active.

## Options considered

1. **(chosen) Third enum value `copies: 'harder'`** — `copies: 'off' | 'on' | 'harder'`.
   Pros: the three states are mutually exclusive and ordered, so one enum is the precise
   model; no illegal combinations. Cons: none material.
2. **A separate boolean `findCopiesHarder` alongside `copies: boolean`** — Rejected:
   admits the nonsensical `{ copies: false, findCopiesHarder: true }`.
3. **A repeated `copies` count (`1` = `-C`, `2` = `-C -C`)** — Rejected: couples the API
   to git's flag-repetition quirk.

## Decision

`RenameDetectOptions.copies` is the enum `'off' | 'on' | 'harder'`. `'on'` feeds copy
sources = files modified in the diff (plain `-C`, ADR-376); `'harder'` feeds copy
sources = all preimage paths (`--find-copies-harder`). The two are mutually exclusive by
construction.

## Consequences

- No illegal option combination is representable.
- The orchestrator selects the copy-source set by switching on the single enum.
- `'harder'` reaches the rename limit far sooner because `num_src` includes every
  preimage blob (ADR-377).
