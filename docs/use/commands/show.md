# `show`

Formatted output for one or more git objects, faithful to `git show`. Each
revision resolves to an object and is rendered by type: a commit shows its
header, message, and patch; an annotated tag shows its header and message then
its target; a tree lists its entries; a blob yields its raw bytes.

`repo.show(...)` returns both the structured per-object results and `bytes` —
the byte-faithful stream `git show` would print (handles binary blobs and the
multi-object join).

## Signature

```ts
type ShowInput = string | ReadonlyArray<string>; // default 'HEAD'

type MergeDiffMode = 'none' | 'separate' | 'combined' | 'dense'; // -s / -m / -c / --cc

interface ShowStatOptions {
  readonly width?: number;     // diffstat width; default 80
  readonly nameWidth?: number;
  readonly count?: number;
}

interface ShowOptions {
  readonly contextLines?: number;             // commit-patch hunk context; default 3
  readonly noPatch?: boolean;                 // -s / --no-patch
  readonly format?: string;                   // --pretty / --format (named or format:/tformat:)
  readonly date?: string;                     // --date=<mode>
  readonly stat?: boolean | ShowStatOptions;  // --stat
  readonly numstat?: boolean;                 // --numstat
  readonly mergeDiff?: MergeDiffMode;         // -m / -c / --cc; default 'dense'
}

interface ShowTreeEntry {
  readonly name: string;
  readonly mode: FileMode;
  readonly id: ObjectId;
}

type ShowResult =
  | { readonly kind: 'commit'; readonly id: ObjectId; readonly commit: CommitData;
      readonly patch?: PatchResult;               // single-parent / -m first patch
      readonly stat?: ReadonlyArray<StatEntry>;   // --stat / --numstat
      readonly perParent?: ReadonlyArray<PatchResult>; // -m, one per parent
      readonly text: string }
  | { readonly kind: 'tag'; readonly id: ObjectId; readonly tag: TagData;
      readonly target: ShowResult; readonly text: string }      // text = tag block only
  | { readonly kind: 'tree'; readonly id: ObjectId;
      readonly entries: ReadonlyArray<ShowTreeEntry>; readonly text: string }
  | { readonly kind: 'blob'; readonly id: ObjectId; readonly content: Uint8Array };

interface ShowOutput {
  readonly objects: ReadonlyArray<ShowResult>; // one per input rev, in order
  readonly bytes: Uint8Array;                  // faithful `git show <input…>` stream
}

repo.show(input?: ShowInput, opts?: ShowOptions): Promise<ShowOutput>;
```

## Examples

```ts
// Show HEAD (default) — commit header + message + patch.
const head = await repo.show();
console.log(new TextDecoder().decode(head.bytes));

// Show an annotated tag — tag block, then the recursed target commit.
const tag = await repo.show('v1.0');

// Inspect a tree listing (header echoes the input rev verbatim).
const tree = await repo.show('HEAD^{tree}');
console.log(tree.objects[0].kind); // 'tree'

// Read a blob's raw bytes.
const blob = await repo.show('HEAD:does-not-peel-use-oid' /* or a blob oid */);

// Multiple objects in one call, like `git show A B`.
const many = await repo.show(['v1.0', 'HEAD', 'HEAD~2']);

// Widen the commit patch context.
const wide = await repo.show('HEAD', { contextLines: 5 });

// -s: header + message only, no diff.
const summary = await repo.show('HEAD', { noPatch: true });

// Alternate pretty formats and a custom placeholder template.
const oneline = await repo.show('HEAD', { format: 'oneline' });
const custom = await repo.show('HEAD', { format: 'format:%h %an: %s%n%b' });

// Diffstat / numeric stat in place of the patch.
const stat = await repo.show('HEAD', { stat: true });
const numstat = await repo.show('HEAD', { numstat: true });

// Read a blob (or sub-tree) by path inside a tree-ish.
const file = await repo.show('HEAD:src/index.ts');

// Alternate date rendering (iso/iso-strict/rfc/short/raw/unix/relative/human/format:).
const iso = await repo.show('HEAD', { date: 'iso' });

// Merge diffs: per-parent (-m), combined (-c), or dense combined (--cc, default).
const perParent = await repo.show(mergeOid, { mergeDiff: 'separate' });
```

## Output guarantees

- `bytes` is byte-identical to `git show` (scrubbed env, signing off) for the
  covered shapes: commit (incl. root and merge), annotated and lightweight
  tags, tree listings, blobs, and multi-rev streams. Pinned by cross-tool
  interop against a live `git`.
- The commit `Date:` line uses git's default `medium` format
  (`Wed Nov 15 00:13:20 2023 +0200`), rendered in the identity's own timezone.
- Commit patches detect renames by default (matching git's `diff.renames`),
  unlike [`diff`](diff.md), which is opt-in.
- **Merge commits** emit a `Merge:` line and, by default, a **dense combined
  diff** (`--cc`) — the same default as `git show`. A merge that took one side
  verbatim (an empty combined diff) shows the header + a trailing blank, no
  patch. `mergeDiff` selects `separate` (`-m`, per-parent), `combined` (`-c`),
  or `none`. **Root commits** diff against the empty tree.
- A revision repeated across the arg list de-duplicates if it resolves to a
  commit (git's revision-walker semantics); blobs, trees, and tags do not.
- Annotated tags are **not** auto-peeled: `show('v1.0')` renders the tag
  object (and recurses into its target), never just the target.

## v2 flags

All shipped as additive options (no breaking change):

- **`-s`/`--no-patch`** (`noPatch`) — header + message only.
- **`--pretty`/`--format`** (`format`) — `oneline`, `short`, `medium`, `full`,
  `fuller`, `raw`, `reference`, `email`, `mboxrd`, or a `format:`/`tformat:`
  placeholder template (`%H %h %an %ad %s %b %d`…; unknown `%?` pass through).
- **`--stat`/`--numstat`** (`stat`/`numstat`) — the diffstat (faithful graph
  scaling, `Bin … bytes` for binaries) or numeric `<add>\t<del>\t<path>`.
- **`<rev>:<path>`** — read a blob/tree by path inside any tree-ish.
- **`-m`/`-c`/`--cc`** (`mergeDiff`) — per-parent or combined merge diffs;
  dense (`--cc`) is the default for merges.
- **`--date=<mode>`** (`date`) — `iso`, `iso-strict`, `rfc`, `short`, `raw`,
  `unix`, `local`, `relative`, `human`, or `format:<strftime>`.

Limitations: `%xXX` is byte-faithful for ASCII bytes only; `relative`/`human`/
`local` are not interop-pinned (now-/host-dependent); dynamic oid abbreviation
is fixed at 7; combined diffs of files deleted by the merge are out of scope.

## See also

- Related commands: [`log`](log.md), [`diff`](diff.md), [`cat-file`](cat-file.md)
- Design: `docs/design/show-object-output.md` · `docs/design/show-v2-flags.md`
- ADRs: 240–242 (v1 structured union, multi-rev, rename detection) · 244 (option
  model + abbrev) · 245 (`<rev>:<path>`) · 246 (pretty breadth) · 247 (date
  modes) · 248 (combined merge diff)
