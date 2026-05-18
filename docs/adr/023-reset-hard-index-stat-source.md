# ADR-023: `reset --hard` uses `materializeTree`'s post-write stats, not `buildIndexFromTree`'s donor strategy

## Status

Accepted (at `f0039d3e3e2ad620884fffe63456097fff995032`)

## Context

`reset --hard` makes both the index AND the working tree byte-
identical to the target commit's tree. We have two primitives that
can produce the post-reset IndexEntry list:

- **`materializeTree`** (Phase 13.1) — walks the target tree,
  computes a changeset against the current index, writes the
  working tree, and **lstats every written file** to populate
  the resulting `IndexEntry[]`. The stat-cache fields therefore
  reflect the freshly-written files on disk.
- **`buildIndexFromTree`** (Phase 13.2) — projects the target tree
  to a stage-0 `IndexEntry[]` using the "stat-cache donor" strategy:
  clone stat fields from the prior index when the path's `id + mode`
  match, zero-fill otherwise. Pure with respect to the working tree
  (no I/O).

Both produce the same set of paths with the same `id`/`mode` for a
given target tree. The difference is the **stat-cache fields**.

Phase 13.2 chose `buildIndexFromTree` because mixed reset does not
touch the working tree: there's nothing to lstat. Donor stats are
the only correct source — they preserve the cache for files that
didn't actually change on disk.

Phase 13.3 is different. We rewrite the working tree first, then
commit the index. After the rewrite, every file on disk has new
mtime / ctime / size — the donor strategy would record stat fields
that no longer match what's on disk, invalidating the stat cache for
every path. The next `status` would re-hash every file.

## Decision

For `reset --hard`, the index commit takes `materializeTree`'s
`newIndexEntries` directly. We do NOT call `buildIndexFromTree` in
the hard path.

```typescript
const result = await materializeTree(ctx, {
  targetTree: commit.data.tree,
  currentIndex,
  force: true,
  forceRewriteAll: true,
});
await lock.commit(result.newIndexEntries);
```

### `forceRewriteAll`

A second flag we add to `MaterializeTreeOpts` in this phase.
`materializeTree`'s diff is `currentIndex → targetTree`, so a path
whose index already matches the target is classified `noop` and
the working-tree write is skipped. That's correct for checkout
(Phase 13.1), where we assume the working tree mirrors the index.
For `reset --hard`, the working tree may have **uncommitted local
modifications** the user is asking us to discard — but the index
still records the committed `id`, so the path looks like a noop.
`forceRewriteAll: true` converts every noop into an update inside
`materializeTree`, ensuring every target-tree path is written
regardless of what the index claims. The flag is opt-in; existing
checkout call sites retain their semantics.

`result.newIndexEntries` already has:

- One entry per leaf in the target tree (no DIRECTORY rows).
- `id` and `mode` from the target tree.
- `ctime`/`mtime`/`dev`/`ino`/`uid`/`gid`/`fileSize` from the
  post-write `lstat`.
- `flags.stage = 0`, `flags.assumeValid = false`,
  `flags.extended = false`.

This is exactly what canonical git's `reset --hard` writes.

## Consequences

### Positive

- **Stat cache is fresh and correct.** The next `status` runs the
  fast path (`isStatClean` returns true) for every path — no
  re-hashing.
- **No double-walk of the target tree.** `materializeTree` already
  walks it; calling `buildIndexFromTree` would walk it again for
  no benefit.
- **Hard-reset's "byte-identical to target" invariant is upheld**
  for the index too. The post-write lstat is the authoritative
  stat for the file we just wrote — there is no donor that could
  legitimately apply.
- **The two reset modes (`mixed` / `hard`) use different
  primitives, and that's correct.** Mixed: working tree untouched
  → donor strategy. Hard: working tree rewritten → fresh lstat.
  Each primitive's contract matches the operation's semantics.

### Negative

- **The two reset paths look superficially similar but differ in
  this one important detail.** A future reader trying to
  "harmonise" them (e.g., extracting a single `rebuildIndexFor`
  helper) would either (a) lose the stat cache for mixed, or (b)
  produce stale stats for hard. This ADR exists to prevent that
  refactor.
- **`materializeTree` is doing more work than `buildIndexFromTree`
  (writes + lstats vs. pure projection).** For hard reset that's
  required work; we can't skip the lstats and still produce a
  correct index.

### Neutral

- Matches `builtin/reset.c`'s `reset_index_file` behaviour for
  the `hard` reset path: the index is rebuilt from the working
  tree's post-write state.
- Forward-compatible with Phase 13.4 (3-way merge tree walk),
  which will also need post-write stats for the merge's working
  tree.

## Alternatives considered

- **Use `buildIndexFromTree` for both mixed and hard, "for
  symmetry".** Rejected. Symmetric API masks asymmetric
  semantics: the two operations differ exactly in whether the
  working tree is touched, and the stat-source choice has to
  reflect that. Forcing symmetry produces a wrong index for
  hard reset.
- **Call both: `materializeTree` for the working tree, then
  `buildIndexFromTree` for the index.** Rejected. Wastes the
  lstats `materializeTree` already did. Also produces stale
  donor stats — same correctness failure as the previous option.
- **Skip the working-tree lstat and zero-fill all stats (then
  let `status` re-hash on first call).** Rejected. Defeats the
  point of a stat cache for hours after the reset; doesn't
  match canonical git.
