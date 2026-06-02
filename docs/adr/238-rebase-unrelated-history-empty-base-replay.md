# ADR-238: `rebase` onto unrelated history replays against the empty-tree base

## Status

Accepted (at `436d4346`)

## Context

`rebaseRun` resolves the merge-base of `upstream` and `HEAD`. When the two have
**no common ancestor** (unrelated histories — e.g. an orphan branch),
`mergeBase` returns `undefined` and the command refuses with
`UNSUPPORTED_OPERATION` ("no common ancestor between HEAD and upstream"). This
refusal has existed since the non-interactive rebase landed (22.3, #108); it was
never covered by an ADR and never pinned by a test.

Canonical `git rebase <unrelated-upstream>` **succeeds**. Verified against git
2.54 (`GIT_*` scrubbed, `commit.gpgsign=false`) on an orphan-branch repo:

```
main:    base ── m1            merge-base(main, feature) = ∅
feature: f0 ── f1  (orphan)

$ git rebase main             # HEAD on feature
→ feature: base ── m1 ── f0' ── f1'
   f0'.parent = m1            ← the root commit, replayed, gains m1 as its parent
   HEAD reflog:  rebase (start): checkout main
                 rebase (pick): feature root
                 rebase (pick): feature one
                 rebase (finish): returning to refs/heads/feature
```

An empty merge-base means the entire branch (`∅..HEAD`) is the replay set. The
branch's root commit has no parent, so its 3-way replay runs with **base = the
empty tree** — the identical add-add path `merge` takes for unrelated histories
(`computeMergeTreeResult(…, undefined)`) and `cherry-pick` takes when picking a
root commit (both via the shared `applyMergeToWorktree` primitive, ADR-215).

Per the prime directive (ADR-226), tsgit replicates git's observable behaviour
unless an ADR explicitly diverges. The refusal is an undocumented divergence
that **invents** a refusal git does not have.

The alternatives considered:

1. **Make rebase faithful** — delete the refusal, replay the whole branch onto
   upstream, the root commit against the empty-tree base.
2. **Keep the refusal, document it** — an ADR justifying a permanent deviation.

## Decision

Resolve in favour of **faithfulness (alternative 1)**. The `base === undefined`
refusal is removed. `base` is threaded as `ObjectId | undefined` through the
replay pipeline (`commitsToReplay`, `dropCherryEquivalents`, `planInteractive`,
`rebaseRunInteractive`). `commitsToReplay(base, head)` with `base === undefined`
performs no exclusion walk, yielding the whole `head` history — the literal
meaning of `∅..head`. Everything downstream is already faithful:

- the decision tree never reports up-to-date (`onto` is always a resolved oid,
  so `onto === base` is `onto === undefined` → `false`);
- the root commit's replay reuses the existing empty-base branch of
  `mergeUnderLock` (`parents[0] === undefined` → `baseTree = undefined`), which
  was simply unreachable from rebase before (in the related case the root is
  always an ancestor of the merge-base);
- the `rebase (start)` / `rebase (pick)` / `rebase (finish)` reflog dance and the
  single-parent shape are emitted unchanged by `detachHead` / `replayFrom` /
  `finishRebase`.

No new domain code is introduced. The behaviour is pinned by a cross-tool interop
test (tsgit vs `git rebase <unrelated>`: identical resulting tree, commit count,
single-parent tip) and a unit test for the empty-base root replay.

## Consequences

### Positive

- `repo.rebase.run` is byte-faithful to `git rebase` on unrelated histories,
  closing a prime-directive divergence.
- Zero new abstraction — the empty-tree add-add path is reused, not reinvented.
- The interactive path inherits the fix for free (`planInteractive` shares
  `commitsToReplay`; `leadingFold` stops at a parentless root, so the whole
  branch replays).

### Negative

- A rebase onto a genuinely unrelated upstream now does real work instead of
  failing fast; a caller that *relied* on the refusal as a guard loses it. This
  matches git, where the burden is on the caller to pick a sensible upstream.

### Neutral

- The cherry-pick-equivalent drop (`dropCherryEquivalents`) runs against the full
  `upstream` history when `base` is `undefined`; collisions across unrelated
  branches are rare but handled exactly as git handles them.
