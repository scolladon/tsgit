---
subjects:
  - src/application/primitives/internal/resolve-tree-path.ts
supersedes:
  - adr: "723"
    scope: "the carried-forward requirement that the descent validate every entry's mode eagerly, past the matched entry"
---
# 761 — Path descent stops at the first match

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (review round 1) · **Supersedes/Refines:** supersedes ADR-723 (eager per-entry mode validation only)

## Context

The descent walked every entry of a directory even after finding its target, because
ADR-723 carried forward a requirement that each visited entry's mode be validated
eagerly. Review found the shipped code does not actually do that — `matched ??=`
short-circuits, so entries after the match are advanced but never validated. All four
review dimensions found it independently.

That leaves the refusal **position-dependent**: an octal-but-unrecognised mode on a
sibling raises `INVALID_FILE_MODE` when it sorts before the target and is silently
ignored when it sorts after. Measured on this branch, with the sibling before the target
the descent throws; with the identical tree content and the sibling after, it resolves
cleanly.

Two facts decide the direction. Canonical git validates **neither** sibling's mode during
a path lookup — `find_tree_entry` compares names and stops. And the full scan is
expensive: the descent is a measured hot path, and stopping at the match roughly halves
the average directory scan.

## Options considered

1. **Stop at the first match, matching git** — pros: faithful, and roughly halves the average scan on the hottest descent path / cons: a refusal-set change; an `INVALID_FILE_MODE` that fires today stops firing.
2. **Restore unconditional validation** — pros: keeps today's refusal set and the documented invariant, no new decision / cons: preserves a refusal git does not have, and pays a full scan for it.
3. **Stop at the match without recording it** — cons: an unrecorded refusal-set change, which is the failure ADR-723 exists to prevent.

## Decision

**Ratified by the user: option 1.** The descent stops at the first matching entry. Mode
validation happens for the entries actually visited on the way to the match and for the
matched entry itself, exactly as git does; a malformed sibling beyond the match is not the
descent's business. The structural scan still runs for every entry the walk advances
through, so a tree that cannot be parsed is still refused.

**Superseded from ADR-723:** the carried-forward requirement that mode validation stay
eager per visited entry across the whole directory.

**Carried forward from ADR-723:** the cursor-scan boundary, the per-consumer
re-implementation rule, and the mode-tier split — all unchanged.

## Consequences

### Positive

- Path lookup matches git's own loop, and the position-dependence disappears: the same tree gives the same answer regardless of sibling order.
- The average directory scan on the hot descent path roughly halves.

### Negative

- A tree whose malformed sibling sorts after the target now resolves where it previously refused. `fsck` remains the surface that reports such a tree, which is where git reports it.
