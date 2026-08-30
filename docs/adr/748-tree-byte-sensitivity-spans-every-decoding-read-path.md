---
subjects:
  - src/domain/objects/tree.ts
  - src/domain/fsck/validate-tree.ts
  - src/application/primitives/internal/flatten-raw.ts
  - src/application/primitives/internal/resolve-tree-path.ts
  - src/domain/diff/tree-diff.ts
---
# 748 — Tree byte-sensitivity unification spans every decoding read path

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D1) · **Supersedes/Refines:** none

## Context

Four places validate a tree entry's name. Three of them decode the raw bytes to a
string first and compare text; only `resolve-tree-path.ts` compares bytes. The three
decoding sites share one root cause and one set of consequences — a bare byte-order
mark reads as an empty name, two distinct invalid-UTF-8 names collide, and a
BOM-prefixed `.` reads as `.`. Two of the four disagree inside a single `fsck` run:
the command's object-parse layer refuses a tree its validator would have reported on.

## Options considered

1. **All four sites, with the byte predicate extracted as a shared module** (designer's recommendation) — pros: one root cause fixed once, no site left as the new outlier / cons: the diff spans `domain/objects`, `domain/fsck` and two application internals, and fsck's finding classes move.
2. **The two object-parse sites now, fsck separately** — pros: smaller review surface / cons: writes the shared helper twice and ships an `fsck` that contradicts itself in the interim.
3. **`tree.ts` only, as the backlog entry literally says** — cons: reproduces the outcome that created this item — one site fixed, the rest left as outliers.

## Decision

**Ratified by the user: option 1.** Every read path that validates a tree entry name
compares raw bytes. `tree.ts`, `flatten-raw.ts` and `validate-tree.ts` are corrected;
`resolve-tree-path.ts`'s existing byte predicate is extracted as the shared module they
all consume. A future site that needs the same check consumes that module rather than
writing a fourth copy.

## Consequences

The backlog entry's stated scope (`tree.ts` only) is superseded by this decision and is
recorded as incomplete rather than followed. Planning then found a fifth site the design
had not counted: the non-recursive tree diff builds its ordering and equality key by
re-encoding the decoded name, so two entries whose names differ only in invalid UTF-8
collapse into one key there too. It is bound by this decision like the other four. `TreeCursor` and `raw-tree-diff.ts` remain
out of scope — their narrower refusal surface is deliberate and already pinned. The
review surface is genuinely wide; the interop suite is the gate.
