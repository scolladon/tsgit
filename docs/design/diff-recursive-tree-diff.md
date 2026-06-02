# Design — recursive tree-diff (shared patch path)

> Promote the recursive tree-flattening that `show` does locally into a shared
> primitive, and adopt it everywhere the patch path consumes a `TreeDiff`. Fixes
> `repo.diff({ format: 'patch' })` (and the latent `computePatchId` twin) throwing
> `UNEXPECTED_OBJECT_TYPE` on any tree that contains a sub-directory.

## 1. Problem

`materialisePatchFiles` hydrates every `DiffChange` by `readBlob`-ing the blob
oid each change carries. The single-level `domain/diff/tree-diff.ts` `diffTrees`
classifies a top-level **sub-directory** entry (mode `040000`, a *tree* oid) as a
plain `add` / `delete` / `modify` change. `materialisePatchFiles` then calls
`readBlob` on that tree oid, which throws `UNEXPECTED_OBJECT_TYPE` (`readBlob`
rejects any non-blob object).

Three call sites share this exact `diffTrees → materialisePatchFiles → renderPatch`
pattern, so three surfaces carry the same defect:

| Call site | Symptom on a nested-dir change |
|-----------|-------------------------------|
| `diff({ format: 'patch' })` | **throws** `UNEXPECTED_OBJECT_TYPE` (the reported bug) |
| `computePatchId` (rebase cherry-equivalent drop-set) | **throws** — a replayed/upstream commit touching a nested file aborts the rebase |
| `show` (commit patch) | **works** — but only because it flattens both trees *locally* before diffing |

`show` already solved this with a private `flattenedTree` helper (`flattenTree` →
synthetic full-path-blob `Tree` → `diffTrees(..., { detectRenames: true })`). The
fix is to lift that proven workaround into the shared chokepoint so `diff` and
`computePatchId` inherit it, and `show` stops carrying a bespoke copy.

## 2. Why flatten-then-diff is byte-faithful

`git diff` (porcelain) is **recursive**: a sub-directory change is rendered as
per-file `diff --git a/sub/b.txt …` hunks, never as a single tree entry. tsgit
reproduces this by flattening both trees to full-path blob entries and running the
**existing** `domain/diff/tree-diff.ts` classification over them.

The ordering is provably git-faithful. git sorts tree entries with a directory's
name treated as if it had a trailing `/` (`encodeEntryName`), precisely so a
directory falls where its recursively-expanded contents would fall in a full-path
sort. Therefore a raw byte sort of the flattened full paths reproduces git's
recursive walk order exactly. Flattened entries are all blobs (no trailing slash),
so `treeEntryCompare` reduces to a raw byte compare of the full path — which is the
sort `domainDiffTrees` already applies. This equivalence is the same one that
`show-interop` already pins byte-for-byte; this change reuses it rather than
re-deriving it.

## 3. Design

### 3.1 Shared recursive flag on the `diffTrees` primitive

Add `recursive?: boolean` to `DiffTreesOptions`. When set, the primitive flattens
both resolved trees to a full-path **blob projection** and runs the same
`domainDiffTrees` classification; rename detection composes on top unchanged.

```ts
export async function diffTrees(ctx, a, b, options?): Promise<TreeDiff> {
  const [treeA, treeB] = await Promise.all([resolveInput(ctx, a), resolveInput(ctx, b)]);
  const raw =
    options?.recursive === true
      ? domainDiffTrees(await blobProjection(ctx, treeA), await blobProjection(ctx, treeB))
      : domainDiffTrees(treeA, treeB);
  return options?.detectRenames === true ? detectRenames(raw, options.renameOptions) : raw;
}
```

`blobProjection(ctx, tree?)` returns `undefined` for an absent side, otherwise
`flattenTree`s the tree and rebuilds a `Tree` whose entries carry **full-path
names** and the leaf blob mode. This projection is a *diff-only*, never-serialised
view (its slash-bearing names would be rejected by the tree serializer — that is
fine, they never reach it). Keeping this projection here removes `show`'s private
copy.

`flattenTree` is generalised from `ObjectId` to `ObjectId | Tree` (the underlying
`walkTree` already accepts both), so the primitive flattens the **already-resolved**
`Tree` without a redundant object read.

### 3.2 Adopt in the three consumers

- **`diff` patch path** — `diffTrees(ctx, from, to, { recursive: true, detectRenames? })`.
  The `format: 'patch'` branch now recurses; its bundled `PatchResult.diff` is the
  recursive `TreeDiff`. **This is the intended behaviour change** (the structured
  `diff` for a nested change flips from one tree-entry change to per-file changes).
- **`computePatchId`** — `diffTrees(ctx, parentTree, cData.tree, { recursive: true })`
  (no rename detection — git's patch-id is a raw recursive diff). Closes the latent
  rebase abort on any commit that touches a nested file.
- **`show.commitPatch`** — drop `flattenedTree` + the `flattenTree` import; call
  `diffTrees(ctx, parent?, commit.tree, { recursive: true, detectRenames: true })`.
  Byte-identical output — `show-interop` is the regression guard.

### 3.3 `diff` exposes a public `recursive` flag (ADR-243)

`diff({ format: 'tree' })` is tsgit's analogue of `git diff-tree` (raw), which is
**non-recursive by default** with `-r` opting in. A public `recursive?: boolean`
is added to `DiffOptions` (default `false`) to reproduce that opt-in:

- `format: 'patch'` **always recurses** (git porcelain has no non-recursive
  patch); `recursive` is inert for patch, documented on the option.
- `format: 'tree'` recurses **only** when `recursive: true` — `git diff-tree -r`;
  default `false` preserves the existing single-level structured contract.

One composition threads it to the primitive:
`const recursive = opts.format === 'patch' || opts.recursive === true;`

## 4. Layering

```
diff / show / patch-id  (commands + primitive)
        │ recursive: true
        ▼
diffTrees primitive  ──flattenTree──▶ walkTree (I/O: reads sub-tree objects)
        │ blobProjection
        ▼
domainDiffTrees  (pure classification — unchanged, already mutation-killed)
```

Recursion (object I/O via `walkTree`) stays in the primitive tier; the pure
domain classifier is untouched. No domain code changes — only its inputs widen
from single-level to full-path-blob trees.

## 5. Test plan

- **Unit — `diff-trees.test.ts`**: with `recursive: true`, a nested-dir **add**,
  **modify**, **delete**, and **type-change** each surface as per-file
  `DiffChange`s (full-path names); `recursive` composes with `detectRenames`; the
  default (`recursive` absent / `false`) path is unchanged (sub-dir → single
  tree-entry change). Isolated guard tests per branch (mutation-resistant).
- **Unit — `diff.test.ts`**: `format: 'patch'` over a nested directory no longer
  throws and renders per-file hunks; `format: 'patch', recursive: false` is still
  recursive (flag inert for patch); `format: 'tree'` (default) over the same trees
  still yields a single tree-entry change (non-recursive contract pinned);
  `format: 'tree', recursive: true` surfaces the nested change as per-file
  `DiffChange`s (`git diff-tree -r`).
- **Unit — `patch-id.test.ts`**: a commit changing a nested file yields a stable,
  computable patch-id (previously threw); two commits introducing the same nested
  change on different bases collide (equivalence preserved through recursion).
- **Unit — `flatten-tree.test.ts`**: the `ObjectId | Tree` overload flattens a
  passed-in `Tree` object identically to flattening its oid.
- **Interop — `diff-recursive-interop.test.ts`** (new): build a nested-directory
  history in real `git` and tsgit; assert `diff({ format: 'patch' })` bytes equal
  `git diff` **and** a frozen golden (double-pin, matching `diff-patch-git-parity`).
  Covers add-into-subdir, modify-in-subdir, delete-from-subdir, and a deep
  (`a/b/c.txt`) nest.

### 5.1 Property tests — considered, not warranted

The recursive `diffTrees` branch is **I/O composition** (`flattenTree` + reuse of
the already-property-tested `domainDiffTrees`), not a new algebraic surface. Against
the four lenses: no `parse`/`serialize` round-trip; the aggregator invariants it
would assert are already owned by `domain/diff/tree-diff.properties.test.ts`; it is
not a total function over a grammar; no idempotence/counting law distinct from the
domain's. A property test here would mostly exercise flattening (covered by
`walk-tree` / `flatten-tree`) or re-assert domain laws — a tautology. So no
`*.properties.test.ts` sibling; example + interop tests carry the proof.

## 6. Decisions (ADR-243)

One user-judgment decision: **does the structured `tree` format recurse, and is
`recursive` a public `DiffOptions` flag?** Decided **B — patch recurses
unconditionally; a public `recursive?: boolean` (default `false`) opts the `tree`
format into recursion, mirroring `git diff-tree -r`**. The default-`false`
preserves the single-level structured contract; the patch path ignores the flag
(always recursive). See ADR-243.

## 7. Out of scope / follow-ups

- Combined-merge diffs, `--stat`/`--numstat`, and the rest of `show`'s v2 flag
  surface remain **23.1b**.
- If the architecture pass (post-feature) judges the synthetic full-path-blob
  `Tree` projection worth replacing with a pure `diffFlatTrees(FlatTree, FlatTree)`
  domain function, that is a behaviour-preserving refactor evaluated then — not a
  feature concern.
