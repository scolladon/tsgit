# 520 — Tree cursor lives in domain/objects/tree-cursor.ts

- **Status:** accepted
- **Date:** 2026-07-28
- **Design:** docs/design/raw-tree-cursor-diff.md

## Context

The raw tree cursor is a parser over the git tree grammar, consumed by both the raw merge-join (`domain/diff`) and the raw `flattenTree` (application tier). Its differential oracle is `parseTreeContent` in `domain/objects/tree.ts`.

## Options considered

1. **`src/domain/objects/tree-cursor.ts` (recommended)** — the tree grammar is owned by `domain/objects`; both consumers reach it without coupling flatten to the diff module; sits next to its oracle.
2. **`src/domain/diff/raw-tree-cursor.ts`** — co-located with the heaviest consumer but forces flatten → diff dependency.
3. **`src/application/primitives/internal/tree-cursor.ts`** — hides it from the domain surface, but it is pure zero-port logic that belongs in domain by the dependency rule.

## Decision

**Ratified by user — Option 1.** The cursor module lives at `src/domain/objects/tree-cursor.ts`.

## Consequences

Clean layering (`repository → commands → primitives → domain` holds); the cursor's property tests sit beside the tree codec's existing test family.
