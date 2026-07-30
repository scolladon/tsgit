# 546 — Shallow set is memoised per Context with explicit invalidation

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/shallow-boundary-commit-walk.md · **Supersedes/Refines:** none

## Context

With the grafted read tier (ADR-542), the shallow set is consulted on the per-commit
read path. Reading `.git/shallow` per read is untenable; the repo requires at most one
extra filesystem probe per `Context` in non-shallow repos.

## Options considered

1. **Per-`Context` `WeakMap` memo + `invalidateShallowSet` from `updateShallow`**
   (designer's recommendation) — pros: the established house pattern
   (`loose-oid-cache.fanoutCache`, `read-commit-graph.graphCache`); tsgit-side writes
   (`fetch --deepen`) invalidate immediately / cons: foreign writers unobserved
   mid-`Context`.
2. **No memo** — pros: always fresh / cons: a file read per commit on the grafted path.
3. **Memo + mtime revalidation** — pros: narrows the foreign-writer window / cons: a
   `stat` per read to close a window the object-store caches already leave open —
   inconsistent with the house pattern.

## Decision

Adopted-as-recommended (no user judgment): **option 1**. `loadShallowSet` /
`isShallowRepository` memoise in a `WeakMap<Context, …>`; `updateShallow` calls
`invalidateShallowSet`.

## Consequences

One probe per `Context` in the common case. Inherited caveat, same as the loose-object
fanout cache: a real-git subprocess rewriting `.git/shallow` mid-`Context` is not
observed — interop tests must build a fresh `Context` after any git-side
deepen/unshallow.
