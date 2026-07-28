# 518 — Raw merge-join validation surface: git diff-tree parity, with the five tree fsck checks landed in the same change

- **Status:** accepted
- **Date:** 2026-07-28
- **Design:** docs/design/raw-tree-cursor-diff.md · **Refines:** ADR-514 (byte-level merge-join), ADR-226 (prime directive)

## Context

The raw byte-cursor merge-join must pick a refusal surface. Empirical pins against git 2.55.0: `git diff-tree` refuses only structural malformations (missing space, malformed/empty mode, empty name, truncated hash) and diffs fsck-class malformations cleanly — unsorted, duplicate, `.`, `..`, embedded-`/` entries all produce output (an unsorted tree yields `D` then `A` for the displaced entry). tsgit today silently re-sorts unsorted trees (emitting nothing) — already divergent from git, so there is no zero-change option. At design time the fsck rider was believed to require implementing git's five tree-structure checks from scratch; planning verified the five checks already exist in `src/domain/fsck/validate-tree.ts` with unit coverage (`treeNotSorted` already interop-pinned). The real gaps are narrower: packed tree objects mis-report as `badType` because the fsck read path routes them through `readObject`→`parseTreeContent` (which throws before the structure checks can run, and `serializeObject` re-sorts — producing a false `hash-mismatch`), and four of the five checks lack interop pins.

## Options considered

1. **Git parity + fsck rider (recommended)** — structural checks only in the diff walk (4.9× measured); trust canonical sort order; discharge the fsck rider in the same change so coverage relocates to where git keeps it instead of vanishing — concretely: route packed objects through the raw read path so the existing five checks (`treeNotSorted`, `duplicateEntries`, `hasDot`, `hasDotdot`, `fullPathname`) actually fire on packed trees, and interop-pin the four unpinned checks against `git fsck --strict`.
2. **Keep tsgit's stricter checks** — structural + name validation + strictly-ascending order check (3.7× measured); self-contained but hard-refuses trees git happily diffs, including a brand-new refusal of unsorted trees.

## Decision

**Ratified by user — Option 1.** The raw merge-join enforces exactly git's `decode_tree_entry` structural refusals and nothing else; the fsck rider lands in the same change — the packed-object read gap closed and all five tree-structure checks pinned against `git fsck --strict`. On fsck-invalid trees the recursive diff now produces git's exact output instead of silently re-sorted output. `flattenTree` keeps its name validation for its worktree-facing callers (`merge`, `rm`, `apply-merge-to-worktree`, `stash`, and every other consumer of the flatten path) — the diff's own traversal, merge-join AND added/deleted-subtree expansion alike, validates neither; the resulting seam is deliberate and documented in the design.

## Consequences

Recursive diff becomes more faithful and faster at once. Refusal surface matches `diff-tree` byte-for-byte; corrupt-tree interop fixtures pin both the diff behaviour and the new fsck refusals. The parsed non-recursive path retains its re-sort divergence (out of scope; recorded in the design).

The design's original "flatten path can reach the filesystem, the merge-join cannot" framing was wrong: `diffTrees({ withStat: true })` and `{ ignoreWhitespace }` resolve `.gitattributes` per changed path, so an unvalidated name reaches the filesystem through the merge-join too. The real containment is two independent gates — attribute-provider path resolution treats any path that lexically escapes the worktree as carrying no attribute sources (no filesystem call at all), plus the adapter's own containment check as a second, defence-in-depth layer — not an asymmetry between the two traversal paths. Nor is there an asymmetry between the merge-join and the added/deleted-subtree expansion: the latter walks raw bytes via its own dedicated per-entry walker (not `flattenTree`), so it is exactly as name-validation-free as the merge-join.
