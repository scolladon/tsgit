# Phase 13.6 — `checkout({ paths, source: 'index' })` synthesises tree from index entries

## 1. Goal

Close the placeholder in `checkout.ts:resolvePathSource` for the
`source: 'index'` branch, which currently resolves to HEAD's tree.
After this PR, path-restore from the index actually restores from
the **staged** content, even when the index has diverged from HEAD
via `add` / `rm`.

BACKLOG §13.6 acceptance:

> `repo.checkout({ paths, source: 'index' })` restores from staged
> content, not HEAD's content. Test: stage a divergent version of
> a path then run path-restore with `source: 'index'` — disk
> content matches the staged version, not HEAD's.

The fix needs a new primitive that turns the index's flat
`IndexEntry[]` back into a nested `Tree` object (or rather, a
chain of nested tree objects with the root id returned).

## 2. Surface

No public change. `checkout({ paths, source: 'index' })` keeps
the same signature; only the internal resolution improves.

### 2.1 New primitive

```ts
// src/application/primitives/synthesize-tree-from-index.ts
export const synthesizeTreeFromIndex = async (
  ctx: Context,
  index: GitIndex,
): Promise<ObjectId>;
```

Returns the `ObjectId` of the root tree synthesised from the
index's stage-0 entries. Sub-trees are written to the object
store as a side-effect of the recursive walk. Pure with respect
to the working tree — only the object store is touched.

## 3. Behaviour

### 3.1 The synthesis algorithm

```
synthesize(entries):
  # Group entries by first path segment.
  filesAtRoot = []     # entries whose path has no '/'
  byPrefix    = {}     # prefix → sub-entries (path stripped of prefix)

  for entry in entries:
    parts = entry.path.split('/')
    if len(parts) == 1:
      filesAtRoot.push({ name: parts[0], mode: entry.mode, id: entry.id })
    else:
      [prefix, ...rest] = parts
      byPrefix[prefix].push({ path: rest.join('/'), mode, id })

  treeEntries = []

  for prefix in keys(byPrefix):
    subTreeId = await synthesize(byPrefix[prefix])    # recursive
    treeEntries.push({ name: prefix, mode: DIRECTORY, id: subTreeId })

  treeEntries.extend(filesAtRoot)

  return writeTree(ctx, treeEntries)
```

`writeTree` already sorts entries with the git-canonical sort
(trailing-`/` for subtrees) and writes the tree object. We just
need to feed it the right flat-by-level entry list.

### 3.2 Stage filtering

Only stage-0 entries contribute. Stage-1/2/3 entries (unmerged
state) are ignored — a repo mid-merge that runs `checkout
--source=index` should be operating on the resolved baseline,
not on the conflict stages. This matches the `compute-changeset`
and `build-index-from-tree` conventions (Phase 13.1 / 13.2).

### 3.3 Empty-index edge case

An index with zero stage-0 entries synthesises to an empty tree.
The empty tree has a well-known ObjectId
(`4b825dc642cb6eb9a060e54bf8d69288fbee4904` for SHA-1) — same as
what `writeTree(ctx, [])` produces. No special-casing needed.

### 3.4 Round-trip invariant

For an index that was just committed (no `add` / `rm` divergence),
`synthesizeTreeFromIndex(ctx, index)` MUST return the same
ObjectId as the committed `commit.data.tree`. This is the
"identity" property of the synthesis function and the strongest
correctness check.

### 3.5 Wire-up in checkout

The implementation split into two helpers (post-pass-1 review):

- `resolvePathSource` (now `'HEAD' | ObjectId` only — the `'index'`
  branch was hoisted out).
- `materializePathRestoreLockless` (for `source: 'index'`) — reads
  the index ONCE and feeds the same snapshot to both
  `synthesizeTreeFromIndex` and `materializeTree`. Closes the
  TOCTOU window where a concurrent `git add` between two reads
  could mismatch the target tree and the current-index base.
- `materializePathRestoreLocked` (for `source: 'HEAD' | ObjectId`)
  — same lock-first ordering as Phase 13.2/13.3.

```ts
const materializePathRestoreLockless = async (ctx, pathSet) => {
  const currentIndex = await readIndex(ctx);
  const targetTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
  return materializeTree(ctx, {
    targetTree, currentIndex, force: true, forceRewriteAll: true, paths: pathSet,
  });
};
```

## 4. Module layout

```
src/application/primitives/
└── synthesize-tree-from-index.ts          # NEW
src/application/primitives/index.ts         # extend barrel
src/application/commands/checkout.ts        # use the new primitive
test/unit/application/primitives/
└── synthesize-tree-from-index.test.ts     # NEW
test/unit/application/commands/
└── checkout.test.ts                       # extend with divergence test
```

## 5. Testing strategy

### 5.1 Unit — `synthesizeTreeFromIndex`

- **Given an empty index, When synthesise, Then returns the
  empty-tree ObjectId** — equals `writeTree(ctx, [])`.
- **Given an index with one root-level file, When synthesise,
  Then root tree has one regular entry**.
- **Given an index with paths `a.txt`, `dir/b.txt`, `dir/sub/c.txt`,
  When synthesise, Then the nested tree structure is correct**
  (root has `a.txt` + `dir` subtree; `dir` has `b.txt` + `sub`
  subtree; `sub` has `c.txt`).
- **Given an index with stage-2 entries (unmerged), When
  synthesise, Then they are filtered out** — paths only in
  stage-2 don't appear in the resulting tree.
- **Round-trip property**: commit a fixture, read its index,
  synthesise → assert the resulting tree id equals
  `commit.data.tree`. Strongest correctness check.

### 5.2 Unit — `checkout.test.ts` extension

- **Given a divergent index (`add` after `commit` for a path),
  When `checkout({ paths: [path], source: 'index' })`, Then disk
  content matches the staged content, NOT HEAD's content**.
  This is the BACKLOG acceptance test verbatim.

### 5.3 Mutation

Stryker on `src/application/primitives/synthesize-tree-from-index.ts`
and the touched line in `checkout.ts`. Target: 0 new survivors
(or documented inline as `// equivalent-mutant`).

## 6. Out of scope

- Conflict-stage trees (we never emit stage-1/2/3 entries in the
  synthesised tree; merge conflicts that produce unmerged
  stages survive their own resolution flow).

> **Update during implementation:** the "share the read-index
> snapshot between synthesis and diff" optimisation was originally
> deferred here as YAGNI. Pass-1 review surfaced it as a TOCTOU
> hazard: a concurrent `git add` between two reads would leave
> the target tree and the current-index base pointing at
> different snapshots. The fix was hoisted into the design as
> §3.5 — single `readIndex` feeds both.

## 7. Open questions

- **Q1: Should we cache the synthesised tree id?** No. The index
  changes between every `add`/`rm`/`commit`; a cache would need
  invalidation tied to index writes. Out of scope for this PR.
- **Q2: What if an index entry has an unusual mode (gitlink at a
  non-leaf path)?** Gitlink entries (`FILE_MODE.GITLINK`) are
  always at leaves by definition (a gitlink IS a path), so they
  appear in `filesAtRoot` for their containing directory.
  `writeTree` accepts them with the correct mode.

## 8. Self-review log

### Pass 1 → Pass 2

- Originally proposed walking the index in a single linear pass
  to produce a flat list of pending writes, then sorting and
  chunking by prefix. Killed: that's more complex than the
  natural recursion. Switched to recursive group-by-prefix.
- Added §3.4 (round-trip invariant) explicitly — it's the
  cleanest correctness test and a perfect mutation-kill candidate
  (every alternative synthesis would diverge from the canonical
  tree id).

### Pass 2 → Pass 3

- §3.5 explicitly cites the "second readIndex" choice and
  defers the optimisation. Pass-3 reviewers tend to ask "why
  not plumb the index through?" — fence it off here.
- §6 added the "gitlink at a non-leaf path" question (Q2) so
  reviewers don't try to invent a synthetic handling that
  doesn't apply.
- Renamed primitive from `treeFromIndex` to
  `synthesizeTreeFromIndex` — the verb "synthesise" matches
  Phase 13.2's `buildIndexFromTree` direction-pair (build /
  synthesise reads cleanly together).
