# `diff`

Compare two tree-like targets. Returns the structured `TreeDiff` — the changed
paths with their modes and object ids. Rendering it as a unified patch is the
caller's responsibility (see [ADR-251](../../adr/251-diff-tree-diff-only.md)).

## Signature

```ts
interface DiffOptions {
  readonly from?: string;          // tree-ish, full rev grammar; default 'HEAD'
  readonly to?: string;            // tree-ish, full rev grammar; default empty tree
  readonly detectRenames?: boolean;
  readonly renameOptions?: RenameDetectOptions;  // fine-tune detection; only used when detectRenames is true
  readonly recursive?: boolean;    // recurse into sub-trees (`git diff-tree -r`); default false
  readonly withStat?: boolean;     // attach per-file { added, deleted, binary } counts
}

// RenameDetectOptions knobs:
//   threshold?:      numeric 0..MAX_SCORE rename similarity gate (default 50%); callers map
//                    git's -M50% / -M50 / -M0.5 forms to this number.
//   copies?:         'off' (default) | 'on' (detect copies from modified sources, -C) |
//                    'harder' (widen copy sources to all preimage paths, -C -C)
//   copyThreshold?:  numeric 0..MAX_SCORE copy similarity gate; defaults to threshold.
//   breakRewrites?:  { score: number; merge: number } | false (default false, -B off)
//                    score: dissimilarity gate to attempt a break; merge: gate to keep broken.
//                    A merge value of 0 maps to the default keep-broken gate (60%).

interface TreeDiff {
  readonly changes: ReadonlyArray<DiffChange>;
}

// With `withStat: true`, each change additionally carries `added` / `deleted` /
// `binary` (a `StatTreeDiff`), the data half of git's `--numstat`.
repo.diff(opts?: DiffOptions): Promise<TreeDiff>;
repo.diff(opts: DiffOptions & { withStat: true }): Promise<StatTreeDiff>;
```

## Examples

```ts
// Structured diff of HEAD vs the empty tree (every entry shows as added).
const everything = await repo.diff();

// Diff two refs.
const incoming = await repo.diff({ from: 'main', to: 'feature/x' });

// Detect renames (off by default). `from`/`to` accept the full rev grammar,
// so `HEAD~1` / `HEAD^` / annotated tags resolve to their tree.
const withRenames = await repo.diff({ from: 'HEAD~1', detectRenames: true });

// Detect renames and copies from modified sources, using default thresholds.
const withCopies = await repo.diff({ detectRenames: true, renameOptions: { copies: 'on' } });

// Recurse into sub-directories (`git diff-tree -r`): a change under `src/`
// shows as per-file `DiffChange`s, not one `src` tree-entry change.
const perFile = await repo.diff({ from: 'HEAD~1', recursive: true });

// Per-file line counts (the data half of --numstat).
const stat = await repo.diff({ from: 'HEAD~1', withStat: true });
for (const c of stat.changes) console.log(c.added, c.deleted, c.binary, c);
```

## Recursion

- The default is **non-recursive** like `git diff-tree`: a changed sub-directory
  surfaces as a single tree-entry change. Pass `recursive: true` to expand it
  into per-file `DiffChange`s (`git diff-tree -r`).

## Data guarantees

- The `DiffChange` union covers add, delete, modify, rename, copy, and type-change.
- A `rename` or `copy` change carries `oldId`/`newId`/`oldMode`/`newMode` (both
  sides of the pairing) and a `similarity` score (`SimilarityScore` with `score`
  in `0..MAX_SCORE` and `maxScore === MAX_SCORE`).
- A `modify` may carry a `broken` dissimilarity datum (`SimilarityScore` where
  `score = MAX_SCORE − similarity`) when `-B` break detection kept the modify broken
  rather than folding it into a rename.
- `withStat` reads blob contents and runs a line diff per file; without it the
  diff is purely tree-level (no blob reads).
- A unified patch reconstructed from the `TreeDiff` matches `git diff
  --no-ext-diff --no-color` byte-for-byte — pinned by the integration suite,
  which reconstructs via the shared `renderPatch` serializer and double-pins
  against both a live `git` and a frozen golden. (`renderPatch` stays internal:
  `rebase` writes `.git/rebase-merge/patch` with it and `patch-id` hashes with
  it.)

## Rendering is the caller's job

`diff` ships no patch `text` and no `format`/`contextLines`/`pathPrefix` options.
To produce a unified diff, render the `TreeDiff` with your own serializer
(materialise the blob contents, then emit hunks).

## See also

- Primitives: [`diffTrees`](../primitives/diff-trees.md),
  [`walkTree`](../primitives/walk-tree.md),
  [`resolveRef`](../primitives/resolve-ref.md)
- Related commands: [`log`](log.md), [`show`](show.md), [`status`](status.md)
- Design: `docs/design/cosmetic-output-sweep.md` · `docs/design/phase-20-3-diff-patch-format.md`
- ADRs: 251 (TreeDiff-only surface) · 252 (`withStat` counts) · 243 (recursive
  tree diff) · 166–169 (the superseded patch-text format)
