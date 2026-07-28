# 519 — cursorsSame mode equality: leading-zero-stripped byte comparison

- **Status:** accepted
- **Date:** 2026-07-28
- **Design:** docs/design/raw-tree-cursor-diff.md · **Refines:** ADR-518

## Context

The raw cursor compares modes as byte ranges. Exact byte equality would emit a spurious modify for `040000` vs `40000` (git's `canon_mode` treats them as identical). Full `canon_mode` equivalence (`100664`→`100644`, `40644`→`40000`…) would widen what the recursive path accepts relative to the parsed path (`normalizeFileMode` rejects those forms) — two answers inside one library for the same tree.

## Options considered

1. **Leading-zero-stripped byte equality (recommended)** — skip leading `0x30` bytes on each side, then byte-range compare. Provably identical to `normalizeFileMode(a) === normalizeFileMode(b)` on every mode tsgit accepts (`040000` is the only zero-prefixed valid form). No allocation, no decode.
2. **Full `canon_mode` byte-level equivalence** — git-faithful for the non-canonical forms, but quietly fixes half of a divergence whose other half stays; deserves its own ADR if ever taken.
3. **Exact byte equality** — rejected outright: spurious modify on `040000` vs `40000`.

## Decision

**Ratified by user — Option 1.** `cursorsSame` compares modes with leading zeros stripped; recursive and parsed paths agree everywhere both accept the input.

## Consequences

No mode-comparison divergence is introduced between the raw and parsed paths. The pre-existing `canon_mode` gap (`100664`/`40644` handling) remains a single, separate issue.
