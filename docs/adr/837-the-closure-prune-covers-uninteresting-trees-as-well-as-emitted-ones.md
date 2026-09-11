---
subjects:
  - src/application/primitives/internal/closure-engine.ts
---
# 837 — The closure prune covers uninteresting trees as well as emitted ones

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-2) · **Supersedes/Refines:** none

## Context

The brief describes the prune predicate as `emitted.has(id)`. git's `list-objects.c`
`process_tree` returns on `UNINTERESTING | SEEN` — an uninteresting tree is never expanded on the
interesting side either. Today `emitTree` descends into marked (uninteresting) subtrees and rejects
each entry one by one, so every closure with a `not` side pays a full descent it then discards.

## Options considered

1. **`emitted.has(id)` only** — pros: the brief's literal text / cons: leaves the uninteresting descent in place on push, `--not` and `^x` closures.
2. **`emitted.has(id) || marked.has(id)`** (recommended, chosen) — pros: git's own predicate; also stops descending uninteresting subtrees / cons: none observable — the equivalence argument covers both.

## Decision

**Adopted-as-recommended (no user judgment).** The predicate passed to `walkTree` is
`marked.has(id) || emitted.has(id)`, and the root short-circuit in `emitTree` returns before the
root emit when the root tree is in either set.

## Consequences

Emission order, first-encounter path, `nameHash` and the object cap are unchanged: every pruned
visit was a silent block today (its emits were rejected before the cap check, or skipped as marked),
and deleting a contiguous silent run preserves every surviving emit's ordinal. Pack bytes are
therefore identical, pinned by a committed `buildPack` SHA golden on a shared-subtree fixture and a
two-worktree byte comparison on the delta-chain fixture. Every `not`-bearing closure additionally
stops descending uninteresting subtrees.
