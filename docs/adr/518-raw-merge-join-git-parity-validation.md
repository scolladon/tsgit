# 518 — Raw merge-join validation surface: git diff-tree parity, with the five tree fsck checks landed in the same change

- **Status:** accepted
- **Date:** 2026-07-28
- **Design:** docs/design/raw-tree-cursor-diff.md · **Refines:** ADR-514 (byte-level merge-join), ADR-226 (prime directive)

## Context

The raw byte-cursor merge-join must pick a refusal surface. Empirical pins against git 2.55.0: `git diff-tree` refuses only structural malformations (missing space, malformed/empty mode, empty name, truncated hash) and diffs fsck-class malformations cleanly — unsorted, duplicate, `.`, `..`, embedded-`/` entries all produce output (an unsorted tree yields `D` then `A` for the displaced entry). tsgit today silently re-sorts unsorted trees (emitting nothing) — already divergent from git, so there is no zero-change option. tsgit's `fsck` implements none of git's five tree-structure checks, so those malformations are caught only as a side effect of `parseTreeContent` throwing during reads.

## Options considered

1. **Git parity + fsck rider (recommended)** — structural checks only in the diff walk (4.9× measured); trust canonical sort order; land git's five tree fsck checks (`treeNotSorted`, `duplicateEntries`, `hasDot`, `hasDotdot`, `fullPathname`) in the same change so coverage relocates to where git keeps it instead of vanishing.
2. **Keep tsgit's stricter checks** — structural + name validation + strictly-ascending order check (3.7× measured); self-contained but hard-refuses trees git happily diffs, including a brand-new refusal of unsorted trees.

## Decision

**Ratified by user — Option 1.** The raw merge-join enforces exactly git's `decode_tree_entry` structural refusals and nothing else; the five missing tree-structure checks land in `fsck` in the same change, pinned against `git fsck --strict`. On fsck-invalid trees the recursive diff now produces git's exact output instead of silently re-sorted output. `flattenTree` keeps its name validation (it can reach the filesystem); the resulting merge-join/flatten seam is deliberate and documented in the design.

## Consequences

Recursive diff becomes more faithful and faster at once. Refusal surface matches `diff-tree` byte-for-byte; corrupt-tree interop fixtures pin both the diff behaviour and the new fsck refusals. The parsed non-recursive path retains its re-sort divergence (out of scope; recorded in the design).
