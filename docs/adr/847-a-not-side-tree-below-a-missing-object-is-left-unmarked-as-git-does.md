---
subjects:
  - src/application/primitives/internal/closure-not-marks.ts
---
# 847 — A not-side tree below a missing object is left unmarked, as git does

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/closure-history-walks.md (D3, review finding) · **Supersedes/Refines:** refines ADR-842

## Context

`push` now feeds every locally held remote tip into the closure's `not` side, so the not-side
marker reads each held tip's root tree and every subtree. A held tip whose tree (or a subtree) is
missing locally — a `tree:0` partial clone with a promisor gap, a pruned or corrupt tree — made the
marker throw `OBJECT_NOT_FOUND`, and a push that succeeded before refused. git 2.55.0 on the same
shape quietly over-reports: `mark_tree_contents_uninteresting` returns when
`parse_tree_gently(tree, quiet_on_missing = 1)` fails, `rev-list --objects W ^H` exits 0 and
`pack-objects --revs` produces a pack. Pinned: with H's root tree deleted, git lists W, W's tree, and
every entry under the missing tree that the intact run had pruned; with only a subtree deleted, only
that subtree's contents reappear, its siblings stay pruned.

## Options considered

1. **Return quietly on `OBJECT_NOT_FOUND` from the not-side tree read, keeping the tree id itself
   marked** (recommended, chosen) — pros: git's behaviour; the safe direction (over-send) / cons: a
   deliberate catch on one error code.
2. **Keep refusing** — cons: a push git performs is refused; a recorded divergence on a refusal
   surface.
3. **A tolerance flag on the closure engine** — cons: widens the API for a rule git applies
   unconditionally.

## Decision

**Adopted-as-recommended (no user judgment).** `markTree` marks the tree id, then reads it; a read
that fails with `OBJECT_NOT_FOUND` ends that subtree's marking quietly and every other error is
rethrown. The want side is untouched: git refuses a missing object there and so does tsgit.

The not-side ancestry itself is now read graph-first through the shared commit-graph reader: a
graph-covered commit whose body is missing is expanded from the graph, exactly as git's
`repo_parse_commit` serves the uninteresting side, and a commit neither the graph nor the store
holds ends its branch of the walk as the former `ignoreMissing` walk did.

## Consequences

Closures with a not side over partial or damaged histories over-report toward git instead of
refusing; the closure-engine, push and interop suites pin both shapes byte for byte. The catch is
narrow and documented at the site so it does not read as a swallowed error. On a graph-bearing
repository the not side reads no commit bodies — 4 998 object reads fewer on the medium fixture.
