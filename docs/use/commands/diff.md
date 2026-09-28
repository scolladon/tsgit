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
  readonly renameOptions?: RenameDetectOptions;  // fine-tune detection; breakRewrites also applies
                                                  // when detectRenames is off; the other members
                                                  // only apply when it is on
  readonly recursive?: boolean;    // recurse into sub-trees (`git diff-tree -r`); default false
  readonly withStat?: boolean;     // attach per-file { added, deleted, binary } counts
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';  // -w / -b / --ignore-space-at-eol
  readonly ignoreCrAtEol?: boolean;                          // --ignore-cr-at-eol
  readonly ignoreBlankLines?: boolean;                       // --ignore-blank-lines
}

// RenameDetectOptions knobs:
//   threshold?:      numeric 0..MAX_SCORE similarity gate for renames and copies (default 50%); callers map
//                    git's -M50% / -M50 / -M0.5 forms to this number.
//   copies?:         'off' (default) | 'on' (detect copies from modified sources, -C) |
//                    'harder' (widen copy sources to all preimage paths, -C -C)
//   breakRewrites?:  { score: number; merge: number } | false (default false, -B off)
//                    score: dissimilarity gate to attempt a break; merge: gate to keep broken.
//                    A merge value of 0 maps to the default keep-broken gate (60%).
//                    Applies with or without `detectRenames` — git's -B alone breaks and
//                    rejoins full rewrites; it never pairs a break with another file.

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
- `withStat: true` forces `recursive: true` regardless of what was passed —
  git's `--numstat` recurses before rename/copy detection runs, because a
  changed sub-directory has no lines of its own to diff; pairing only ever
  sees leaf blobs when line counts are requested.
- With `recursive: true`, a corrupt/fsck-invalid tree (unsorted entries,
  duplicate names, `.`/`..`/embedded-`/` names) diffs exactly like
  `git diff-tree -r` instead of throwing — only structural entry damage
  (missing space/NUL, malformed/empty mode, truncated hash) still refuses.
  See [`diffTrees`](../primitives/diff-trees.md#throws) for the full refusal
  surface.

## Data guarantees

- The `DiffChange` union covers add, delete, modify, rename, copy, and type-change.
- A `rename` or `copy` change carries `oldId`/`newId`/`oldMode`/`newMode` (both
  sides of the pairing) and a `similarity` score (`SimilarityScore` with `score`
  in `0..MAX_SCORE` and `maxScore === MAX_SCORE`).
- **Exact pairing** (identical content, `similarity.score === MAX_SCORE`) matches
  git's `-M`/`-C`: destinations are matched in path order against candidate
  sources sharing their content, examining at most 100 candidates per
  destination (git's fixed bound). Under plain renames, each source pairs at
  most once — a second destination with the same content shows as an `add`,
  not a second `rename`; among several same-content sources, a matching
  basename wins, otherwise the first source in path order. Under `copies`, the
  same source can pair repeatedly: a deleted source paired k times yields k−1
  `copy` changes and one `rename` (the rename last in path order), and a
  source the diff keeps (modified, or unchanged under `copies: 'harder'`) only
  yields `copy` changes — renames are always chosen before copies over the
  shared candidate list, as in git. Regular files pair across the executable
  bit; symlinks, gitlinks, and trees pair only with identical content **and**
  mode, and are never similarity-scored — but they still count toward
  `limit`. Exact pairing is never skipped by the rename limit — the limit only
  gates similarity scoring for non-identical content.
- A `modify` may carry a `broken` dissimilarity datum (`SimilarityScore`) when `-B`
  break detection kept the modify broken rather than folding it into a rename. The
  `score` is git's break-detection dissimilarity (`merge_score`), which the caller
  projects to the `M<n>` / `dissimilarity index <n>%` integer percent.
- A `type-change` may carry `broken` when `-B` broke a symlink↔regular type
  change and its halves rejoined; `score` is always `MAX_SCORE` (git prints
  `T100`). A broken type change whose new side pairs elsewhere as a rename or
  copy destination is replaced by that change instead — no `type-change` is
  emitted for it.
- With `withStat`, a kept-broken `modify` (one carrying `broken`) counts every
  old-side line as deleted and every new-side line as added — git's
  complete-rewrite numstat, not a line diff — unless the pair is binary, which
  reports `{ added: 0, deleted: 0, binary: true }` as usual. Neither
  `ignoreWhitespace` nor `ignoreCrAtEol` drops it, even when the rewrite is
  whitespace-only.
- Under plain `-M` (`copies: 'off'`, nothing left to break, `threshold` below
  100%), a delete and an add whose basename is unique on both sides pair
  first — ahead of the general similarity matrix — once their similarity
  reaches the midpoint between `threshold` and 100%. In the general matrix,
  two candidates with equal similarity are ranked by whether the basename
  matches, then by path order — never by traversal order.
- `withStat` reads blob contents and runs a line diff per file; without it the
  diff is purely tree-level (no blob reads).
- The line diff follows git's own default xdiff pipeline, not a plain bounded
  Myers search: a leading/trailing common run and any line with no match on
  the other side are discarded before the search runs (record cleanup), the
  search itself is git's linear-space divide-and-conquer split — its snake
  heuristic and cost cap return a valid, possibly non-minimal script in
  bounded time, never bailing to a whole-file replacement past a fixed edit
  distance however large the true edit distance is — and the resulting
  change groups are then slid by the indent heuristic exactly as
  `xdl_change_compact` slides them (git's own default; there is no flag to
  turn it off). Both the `added`/`deleted` counts under `withStat` and the
  hunk boundaries a caller renders from the `TreeDiff` follow from this
  pipeline.
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

## Textconv drivers (`diff=<name>`)

When a path carries a `diff=<name>` attribute in `.gitattributes` and the
corresponding `[diff "<name>"].textconv` command is configured, the diff compares
the **textconv output** of each side rather than the raw committed bytes — exactly
as `git diff --no-ext-diff` does.

- **Both sides transformed.** The textconv command receives each blob's raw bytes
  and its stdout replaces the content for hunk and numstat computation. Added files
  run textconv on the new side only; deleted files on the old side only.
- **OIDs are not affected.** The structured `DiffChange` fields (`oldId`, `newId`,
  mode, rename similarity) are computed from the raw committed tree and are never
  touched by textconv. A caller rendering an `index` header line should use the raw
  OIDs — textconv affects only the patch hunks and `added`/`deleted` counts.
- **Named-but-unconfigured driver.** If a path's `diff=<name>` attribute names a
  driver with no `[diff "<name>"]` section (or no `textconv` key) in the config,
  the diff falls back to raw bytes — git's declared-but-inert boundary.
- **`-diff` / `binary` macro.** A path resolving `diff` to `false` (via `-diff` or
  the built-in `binary` macro) suppresses the text diff entirely; textconv is never
  applied to binary-suppressed paths.
- **Range-diff and patch-id.** Textconv is NOT applied when computing patch-id or
  range-diff output — those use raw committed bytes.
- **Out of scope.** `[diff].cachetextconv` is not implemented in v1; the driver
  always runs. The `[filter].process` long-running protocol is also out of scope.

**Node.** The textconv command is run through the `CommandRunner` port (same trust
model as merge drivers and hooks — the command comes from `.git/config`, the
attribute only names it). In the browser / memory adapters, or in Node with
`openRepository({ command: false })`, no driver is wired and the diff falls back
to raw bytes. See the [RUNBOOK](../../../RUNBOOK.md) "Operating filter and textconv drivers"
section for security and operator notes.

## Binary-vs-text decision (`diff` / `binary` attribute)

The `binary` field on `StatFields` (and the patch binary branch when reconstructing
a unified diff) is not purely a content-sniff — it honours the `diff` attribute in
`.gitattributes` first, exactly as git does. The library ships the structured
`binary: boolean`; a caller reconstructing `Binary files a/F and b/F differ` and
`-\t-` numstat rows derives them from that field.

| `.gitattributes` rule | `binary` (numstat) | patch binary branch |
|---|---|---|
| `f -diff` (or `*.bin binary` macro) | `true` — even over textual content (no NUL) | forced binary — `Binary files … differ` |
| `f diff` (bare, set true) | `false` — even over NUL content | forced text hunk — NUL bytes survive verbatim |
| `f diff=<name>` + configured `textconv` | raw-blob decision: `true` if the **raw** committed bytes contain NUL, `false` otherwise | text hunk over the **textconv output** |
| `f diff=<name>`, no `textconv` configured | content-sniff of raw bytes | content-sniff of raw bytes |
| no rule (unspecified) | content-sniff (NUL → binary) — unchanged | content-sniff (NUL → binary) — unchanged |

A few points worth noting:

- **`binary` macro.** The built-in `binary` macro expands to `-diff -merge -text`. A
  path matching `*.bin binary` therefore resolves `diff` to `false` — it forces binary
  display on both surfaces, even when the content has no NUL bytes.
- **Named-driver numstat asymmetry.** When `diff=<name>` names a configured textconv
  driver, the patch is a text hunk (over the transformed bytes) but numstat tracks the
  **raw** blob — so a NUL-retaining or NUL-stripping textconv still shows `-\t-` in
  numstat while the patch shows a clean text hunk. This matches git exactly.
- **OIDs are not affected.** The `diff` / `binary` attribute never enters the
  `DiffChange` OIDs or modes. It drives two independent decisions: the `binary`
  boolean and the patch binary branch described above, and — separately — rename,
  copy and break similarity scoring, described next.
- **Off-node adapters.** `-diff` and bare `diff` (and the raw-blob numstat decision
  for named drivers) are honoured in the browser and in-memory adapters — they need
  no external command. Only textconv driver *execution* requires a Node `CommandRunner`
  (see the textconv section above).

## Rename and break similarity scoring (`diff` attribute)

Rename/copy detection and `-B` break-rewrite scoring honour the same `diff`
attribute, resolved per path, as the binary-vs-text decision above — from the worktree's
`.gitattributes`, `.git/info/attributes` and `core.attributesFile` — but as an
**independent** decision: textconv never enters it (the scorer always reads the raw
blob, matching git's `diff_filespec_is_binary`), and a named driver (`diff=<name>`)
defers directly to that driver's own `diff.<name>.binary` config value rather than to
whether a `textconv` command is configured.

- `-diff` (or the `binary` macro) scores the blob as binary; a bare `diff` scores it
  as text; `diff=<name>` follows `diff.<name>.binary` when the driver sets it; an
  unspecified attribute, or a named driver with no `binary` config, falls back to the
  ordinary content sniff.
- The override is resolved per path. A rename or copy candidate's two sides — a
  source path and a destination path — each resolve their own path's attribute
  independently; a `-B` break's old and new content, being two states of one path,
  share a single resolved override.
- **Text content skips the CR of a CRLF pair** when the scorer chunks a blob into
  spans for hashing — the CR is neither accumulated into the hash nor counted toward
  the chunk's byte length. Binary content hashes every byte, CR included.
- The chunk hash's bucket, `(accum1 + accum2 * 0x61) % HASHBASE`, wraps its unsigned
  32-bit accumulator addition to 32 bits before the modulo — matching git's
  `unsigned int` arithmetic rather than a wider intermediate.

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
  (whitespace config default) · 909 (xdiff line-diff transcription) · 910
  (indent-heuristic change compaction) · 911 (similarity hash wraps and skips
  CRLF carriage returns)
