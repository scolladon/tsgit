# ADR-021: `reset --mixed` stat-cache donor strategy

## Status

Accepted (at `62336f3b89c7f2bc1d54876ce9c4ffe53b7022e2`)

## Context

`reset --mixed <target>` makes the index equal to the target tree's
projection. The question is **what stat-cache fields go into each
new index entry**:

- ctime/mtime (seconds + nanoseconds)
- dev/ino
- uid/gid
- fileSize

These fields drive `status`'s stat-cache fast path
(`isStatClean(entry, lstat)`). If they're wrong, `status` re-hashes
every file.

Two plausible approaches:

- **A. Fresh lstat from working tree.** For each path in the target
  tree, lstat the working-tree file and fill in stat fields from
  the result. Pros: matches `checkout`'s post-write entries.
  Cons: `reset --mixed` is supposed to leave the working tree
  alone — but reading working-tree lstats means partial behaviour
  depends on whether the file currently exists at that path. Files
  not present in the working tree have to fall back to zero stats
  anyway. Hybrid.
- **B. Zero-fill all stat fields.** Always emit zero for every
  stat field. Pros: simple, deterministic, no working-tree I/O.
  Cons: invalidates the stat cache on every `reset --mixed` — the
  next `status` re-hashes every file in the index, slow on large
  repos.
- **C. Stat-cache donor from prior index.** For each path in the
  target tree, look up the path in the **pre-reset index**. If an
  entry exists with the same `id` and same `mode` → clone its
  stat-cache fields. Otherwise → zero-fill. Pros: matches
  canonical git's behaviour, preserves cache for unchanged paths,
  no working-tree I/O. Cons: a path whose content changed gets
  zero stats — but that's the right answer (the cache must be
  invalidated for paths that actually changed).

## Decision

Option **C — stat-cache donor from prior index**.

Match criteria: `prior.path === target.path && prior.id ===
target.id && prior.mode === target.mode`. All three must match.
Stage-0 only on both sides (mixed reset wipes unmerged entries by
construction).

Implementation lives in
`src/application/primitives/build-index-from-tree.ts`. The
primitive is pure with respect to the working tree — it never
calls `fs.lstat`, `fs.read`, or any working-tree-side API. It only
reads git objects (`walkTree` → `readObject` for sub-trees).

```ts
const donor = priorIndexByPath.get(targetEntry.path);
const sameContent =
  donor !== undefined &&
  donor.id === targetEntry.id &&
  donor.mode === targetEntry.mode;

const newEntry: IndexEntry = sameContent
  ? { ...donor, flags: { ...donor.flags, stage: 0 } }   // preserve stat cache
  : zeroStatEntry(targetEntry.path, targetEntry.id, targetEntry.mode);
```

## Consequences

### Positive

- **Stat cache survives unchanged paths.** A repo with 50k
  unchanged blobs keeps its 50k cached stats — `status` stays fast.
- **No working-tree I/O.** `reset --mixed` is fully deterministic
  from `(target tree, prior index)`. Test fixtures can omit the
  working tree entirely. Matches the design's
  "working tree is not touched" invariant.
- **Changed paths force a re-hash on next `status`.** Zero stats
  make `isStatClean` return false; `status` falls through to the
  hash path, produces the correct answer, and writes the fresh
  stats back to the index on the next `add`/`commit`. This is the
  correct cache-invalidation behaviour.
- **Stage discipline.** Donor matching ignores stage-1/2/3 entries
  by construction. A reset after a failed merge wipes the
  unmerged state, exactly as `git reset` does.

### Negative

- **Mode-only changes invalidate stat cache.** A path that flipped
  `0o100644 → 0o100755` (regular → executable) at the same blob id
  gets zero stats. The next `status` re-hashes that one path.
  Marginal cost, correct behaviour.
- **Stat-cache donors can be subtly stale.** If the working-tree
  file at that path was modified out-of-band between the prior
  commit and the reset, the donor's stat fields no longer match
  the working file — `isStatClean` returns false, `status`
  re-hashes. The cache is "best effort"; correctness is preserved.

### Neutral

- This is exactly what canonical git does (`builtin/reset.c`'s
  `reset_index_file`).
- Forward-compatible with Phase 13.3 (`reset --hard`), which will
  use the same primitive but additionally call `materializeTree`
  with `force: true` to bring the working tree into agreement.

## Alternatives considered

- **A — fresh lstat from working tree.** Rejected. Means
  `reset --mixed` reads the working tree, which violates the
  contract. Also confuses behaviour: a file that's currently a
  symlink on disk but a regular file in the target tree would
  produce wrong stat fields.
- **B — zero-fill all.** Rejected. The benchmark cost is real on
  large repos. `status` is on the hot path of every commit cycle;
  cache invalidation should track what actually changed, not the
  command boundary.
