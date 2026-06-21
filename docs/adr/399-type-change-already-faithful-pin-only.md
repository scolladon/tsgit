# ADR-399: file↔type type-change (`T`) is already faithful — pin the leaf-kind pairs

## Status

Accepted

- **Date:** 2026-06-21
- **Design:** [design/diff-faithfulness-odds-ends.md](../design/diff-faithfulness-odds-ends.md) §2
- **Refines:** [ADR-226](226-git-faithfulness-prime-directive.md) (git-faithfulness)
- **Relates to:** [ADR-243](243-diff-recursive-tree-diff.md) (recursive diff), [ADR-369](369-similarity-rename-detection-scope.md) (diffcore detection surface)

## Context

The brief stated file↔symlink type changes are "dropped from diff output (matches
`--diff-filter=AMD`)". A full audit of every diff surface shows this is **stale**:
tsgit already emits `type-change` (`DiffChangeType` member `'type-change'`, carrying
`oldId`/`newId`/`oldMode`/`newMode`) on the tree↔tree, index↔tree, recursive,
whitespace-drop-pass, blob-hydration, patch-render and status surfaces, and already
reconstructs git's `T` raw line in the `whatchanged`/`status` interop tests. There is
**no `--diff-filter` surface anywhere** in `src/` to drop `T` through, and real git
emits `T` by default (no filter) for a file→symlink change.

The real gap is a **fixture hole**: the tree↔tree interop `beforeAll` never creates a
`T` entry, so the `type-change` → `T` raw-line arm is un-exercised on that axis
(`status-interop` covers the index/worktree axes). The question is what to pin.

## Options considered

- **Fixture home:** (a) a new dedicated `diff-type-change-interop.test.ts`;
  (b) extend `whatchanged-interop.test.ts`'s shared fixture; (c) fold into the LFS
  interop file. **Chose (a)** — one `*-interop.test.ts` per surface is the house
  pattern; (b) mixes a structural change into a fixture other assertions depend on;
  (c) conflates two unrelated brief parts.
- **Kind-pairs pinned:** (a) only file↔symlink; (b) all three reachable leaf-kind
  pairs (file↔symlink, file↔gitlink, symlink↔gitlink); (c) file↔symlink + one
  gitlink pair. **Chose (b)** — `kindOf` distinguishes four kinds; the three
  leaf-kind pairs are the complete set reachable as a same-path `type-change`
  (directory cannot co-occur with a leaf at one path — it becomes delete+add). The
  consumer is a real repo with submodules (gitlinks), so leaving gitlink pairs
  unpinned would leave the audit incomplete.

## Decision

**No tsgit source change.** Part 2 is **pin-only** — the audit confirms faithful
`type-change` emission on every surface.

Add a dedicated `test/integration/diff-type-change-interop.test.ts` pinning **all
three leaf-kind pairs** against live git, both directions:

- file↔symlink (`100644` ⇄ `120000`),
- file↔gitlink (`100644` ⇄ `160000`),
- symlink↔gitlink (`120000` ⇄ `160000`).

Each asserts the structured `TreeDiff` change is `type-change` with the correct
modes/oids and reconstructs git's `--raw` `T` line, `--name-status` `T`, and patch
bytes.

Add a **negative pin**: a leaf↔directory change at one path (`x` blob → `x/` subtree)
yields a `delete`+`add` pair (git's tree-entry ordering sorts a directory as `x/`, so
blob-`x` and tree-`x` are distinct keys), **never** `T` — guarding against a future
mis-classification.

For the gitlink pairs, add domain unit tests asserting `classifySamePath` /
`classifyIndexVsTree` emit `type-change` (not `modify`) for the gitlink modes — the
cheap mutation-resistant guard.

## Consequences

### Positive

- Closes the audit: every reachable `type-change` kind-pair is faithfulness-pinned,
  and the leaf↔directory negative is frozen as a delete+add.
- Exercises the previously-dead `type-change` → `T` reconstruction arm on the
  tree↔tree axis.

### Negative

- Three extra interop fixtures vs the one the brief literally named — a small cost
  for a complete audit.

### Neutral

- No behaviour change; the domain `type-change` emission is already unit-covered.
  No `--diff-filter` surface is introduced (none is needed; `T` surfaces by default).
