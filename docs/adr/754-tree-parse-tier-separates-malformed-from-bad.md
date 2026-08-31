---
subjects:
  - src/domain/objects/tree.ts
  - src/domain/fsck/validate-tree.ts
  - src/domain/objects/tree-entry-bytes.ts
---
# 754 — The tree parse tier separates malformed from bad

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D7) · **Supersedes/Refines:** acts on ADR-723's mode-tier addendum

## Context

git separates two classes of tree fault. A record it cannot parse — an empty mode, a
non-octal mode byte, an empty name — fails in the tree parser and is summarised as
`badTree`. A record it can parse but does not recognise — an octal mode outside the
known set — passes the parser and is reported by `fsck` as `badFilemode`. Measured,
git 2.55.0: `10064a` gives `error: malformed mode in tree entry` then `badTree`; an
empty mode gives the same pair; an empty name gives `error: empty filename in tree
entry` then `badTree`; `777777` gives only `badFilemode`.

`tree-cursor.ts` already matches this split. `parseTreeContent` collapses it into one
`normalizeFileMode` check that runs *after* the name and hash checks, and
`validate-tree.ts` reports `badFilemode` where git reports `badTree`.

## Options considered

1. **Adopt the split on both defective sites, for the mode bytes and the empty name** (designer's recommendation) — pros: parse-tier error data becomes identical to the cursor's, restoring `parseTreeContent` as the cursor's differential oracle / cons: reorders which fault a doubly-malformed record reports, and changes a published error's reason string.
2. **Mode tier only** — cons: git treats the empty name as the same tier and the same collapse, so splitting it off is arbitrary.
3. **No change** — cons: leaves `parseTreeContent` the outlier and leaves `fsck` misclassifying.

## Decision

**Ratified by the user: option 1.** Both defective sites scan the mode bytes and the
name span for structural faults **first**: an empty or non-octal mode is a malformed
mode, an empty name is an empty filename, and in `fsck` both are `badTree`. Only after
that does the existing matcher decide whether a well-formed octal mode is a recognised
one, which remains the separate `badFilemode` class. The octal-digit scan moves into the
shared classifier so the cursor and the parse sites read it from one place.

## Consequences

### Positive

- `parseTreeContent` and the cursor produce identical error data for every parse-tier fault, which is what makes one usable as the other's differential oracle.
- `fsck`'s exit classification for a non-octal mode matches git's.

### Negative

- A record that is malformed in more than one way now reports its mode fault where it previously reported its name fault — an observable reorder, pinned by its own interop row.
- `parseTreeContent`'s empty-name reason string changes; it is a visible error-data change on a published parse path, and it is the change that makes the two paths agree.
