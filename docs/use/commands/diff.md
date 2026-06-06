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
  readonly recursive?: boolean;    // recurse into sub-trees (`git diff-tree -r`); default false
  readonly withStat?: boolean;     // attach per-file { added, deleted, binary } counts
}

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

- The `DiffChange` union covers add, delete, modify, rename, and type-change.
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
