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
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';  // -w / -b / --ignore-space-at-eol
  readonly ignoreCrAtEol?: boolean;                          // --ignore-cr-at-eol
  readonly ignoreBlankLines?: boolean;                       // --ignore-blank-lines
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

// Ignore all whitespace differences (-w). A file whose only change is
// whitespace drops from the change-set entirely.
const noWs = await repo.diff({ from: 'HEAD~1', ignoreWhitespace: 'all' });

// Ignore blank-line-only hunks. The file stays in the change-set (it is
// present in name-status and nonzero under --quiet); only its hunks and
// numstat row are suppressed.
const noBlank = await repo.diff({ from: 'HEAD~1', ignoreBlankLines: true });
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
- A `modify` may carry a `broken` dissimilarity datum (`SimilarityScore`) when `-B`
  break detection kept the modify broken rather than folding it into a rename. The
  `score` is git's break-detection dissimilarity (`merge_score`), which the caller
  projects to the `M<n>` / `dissimilarity index <n>%` integer percent.
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

## Whitespace

The three whitespace fields are **data modes**, not rendering knobs. They change
which lines are considered equal during the line diff, which hunks exist, which
files appear in the change-set, and the numstat counts — exactly as `git diff -w`
/ `-b` / `--ignore-blank-lines` do. They do not affect any display string emitted
by the library (there is none).

**`ignoreWhitespace`** is a mutually exclusive enum that models git's three
line-key modes:

- `'all'` — ignore all space/tab bytes (`git diff -w`). Most aggressive; subsumes
  `'change'` and `'at-eol'`.
- `'change'` — ignore changes in the amount of whitespace, but not its presence
  or absence (`git diff -b`).
- `'at-eol'` — ignore trailing whitespace only (`git diff --ignore-space-at-eol`).

`ignoreCrAtEol` and `ignoreBlankLines` are orthogonal booleans that combine
freely with the enum and with each other.

**File-drop under a line-key mode.** When `ignoreWhitespace` or `ignoreCrAtEol`
is set, a file whose only change normalises away under that mode is dropped from
`TreeDiff.changes` entirely — it disappears from name-status, numstat, and raw
output, exactly as it does in `git diff -w --name-status`. A whitespace-only
*rename* is not dropped: rename/copy/break similarity scoring is unaffected by
whitespace modes (`-M -w` ≡ `-M`).

**Blank-line suppression** (`ignoreBlankLines`) is a hunk/numstat suppressor, not
a file-drop trigger. A file with only blank-line changes **stays** in
`TreeDiff.changes` (present in name-status/raw, nonzero under `--quiet`); its
hunks and numstat row are suppressed. The numstat omit rule is derivable from
the shipped fields: omit the row when `added === 0 && deleted === 0 && !binary &&
oldMode === newMode`.

## Config defaults

`RepositoryConfig` (passed to `openRepository`) now accepts
`ignoreWhitespace`, `ignoreCrAtEol`, and `ignoreBlankLines` as programmatic
facade-level defaults, alongside the existing `detectRenames`. Each field is
resolved as: **per-call option `??` config default `??` built-in default**.

These are tsgit's own defaults — not git's on-disk `.git/config` and explicitly
not `core.whitespace` (which governs whitespace-error detection, a different
feature).

## See also

- Primitives: [`diffTrees`](../primitives/diff-trees.md),
  [`walkTree`](../primitives/walk-tree.md),
  [`resolveRef`](../primitives/resolve-ref.md)
- Related commands: [`log`](log.md), [`show`](show.md), [`status`](status.md)
- Design: `docs/design/cosmetic-output-sweep.md` · `docs/design/phase-20-3-diff-patch-format.md` · `docs/design/whitespace-diff-options.md`
- ADRs: 251 (TreeDiff-only surface) · 252 (`withStat` counts) · 243 (recursive
  tree diff) · 166–169 (the superseded patch-text format) · 378 (whitespace
  options flat enum) · 379 (`--ignore-blank-lines` in scope) · 380 (file-drop
  via line diff) · 381 (whitespace threading and similarity invariant) · 382
  (whitespace config default)
