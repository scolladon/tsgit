# `show`

Structured object data for one or more revisions. Each revision resolves to an
object and is returned by type: a commit carries its `CommitData` plus the diff
against its parent (`patch`) or, for a merge, one diff per parent (`perParent`);
an annotated tag carries its `TagData` and the recursively shown target; a tree
carries its entries; a blob carries its raw content.

`repo.show(...)` returns **data only** — assembling `git show`'s display (the
`commit`/`Merge` headers, dates, the unified patch, a combined diff for merges)
from these fields is the caller's responsibility (see [ADR-249](../../adr/249-describe-structured-data-only.md) /
[ADR-250](../../adr/250-cosmetic-output-sweep.md)).

## Signature

```ts
type ShowInput = string | ReadonlyArray<string>; // default 'HEAD'

interface ShowOptions {
  readonly withStat?: boolean; // attach per-file { added, deleted, binary } counts
}

interface ShowTreeEntry {
  readonly name: string;
  readonly mode: FileMode;
  readonly id: ObjectId;
}

type ShowResult<D = TreeDiff> =
  | { readonly kind: 'commit'; readonly id: ObjectId; readonly commit: CommitData;
      readonly patch?: D;                       // single-parent / root (vs empty tree)
      readonly perParent?: ReadonlyArray<D> }   // merge: one diff per parent
  | { readonly kind: 'tag'; readonly id: ObjectId; readonly tag: TagData;
      readonly target: ShowResult<D> }
  | { readonly kind: 'tree'; readonly id: ObjectId;
      readonly entries: ReadonlyArray<ShowTreeEntry> }
  | { readonly kind: 'blob'; readonly id: ObjectId; readonly content: Uint8Array };

// A single rev returns one result; an array returns one result per rev, in order.
// `withStat: true` yields `ShowResult<StatTreeDiff>` (counts present on each change).
repo.show(rev?: string, opts?: ShowOptions): Promise<ShowResult>;
repo.show(revs: ReadonlyArray<string>, opts?: ShowOptions): Promise<ReadonlyArray<ShowResult>>;
```

## Examples

```ts
// Show HEAD (default) — commit data + the structured patch (a TreeDiff).
const head = await repo.show();
if (head.kind === 'commit') {
  for (const change of head.patch?.changes ?? []) console.log(change.type, change);
}

// Annotated tag — the tag data, then the recursed target (never auto-peeled).
const tag = await repo.show('v1.0');
if (tag.kind === 'tag') console.log(tag.tag.tagName, tag.target.kind);

// Tree listing — structured entries.
const tree = await repo.show('HEAD^{tree}');
if (tree.kind === 'tree') console.log(tree.entries.map((e) => e.name));

// Blob — raw bytes.
const blob = await repo.show('<blob-oid>');
if (blob.kind === 'blob') process.stdout.write(blob.content);

// Multiple objects in one call (one result per rev, in order; no de-duplication).
const many = await repo.show(['v1.0', 'HEAD', 'HEAD~2']);

// Read a blob or sub-tree by path inside a tree-ish.
const file = await repo.show('HEAD:src/index.ts');

// Per-file line counts (the data half of --numstat).
const withStat = await repo.show('HEAD', { withStat: true });
if (withStat.kind === 'commit') {
  for (const c of withStat.patch?.changes ?? []) console.log(c.added, c.deleted, c.binary);
}

// Merge: one TreeDiff per parent.
const merge = await repo.show('<merge-oid>');
if (merge.kind === 'commit') console.log(merge.perParent?.length); // parent count
```

## Data guarantees

- The structured fields are sufficient to reconstruct git's default `git show`
  output byte-for-byte — pinned by cross-tool interop that rebuilds the stream
  from the result and compares to a live `git` (merges against `git show -m`).
- Commit diffs detect renames by default (matching git's `diff.renames`), unlike
  [`diff`](diff.md), which is opt-in, and recurse into sub-directories.
- **Merge commits** carry `perParent` (one `TreeDiff` per parent, in parent
  order) and no `patch`. **Root commits** carry a `patch` diffed against the
  empty tree.
- A revision repeated across the arg list yields one result per occurrence (no
  stream de-duplication — that is a rendering artifact the caller owns).
- Annotated tags are **not** auto-peeled: `show('v1.0')` returns the tag object
  (recursing into its target via `target`), never just the target.
- `<rev>:<path>` resolves a blob/tree by path inside any tree-ish.

## Rendering is the caller's job

`show` ships no `bytes`/`text` and no `--pretty`/`--date`/`--stat`/`-c`/`--cc`
options. To reproduce `git show`'s display, render from the structured fields:
format the commit header/date yourself, and turn a `TreeDiff` into a unified
patch with your own serializer (the test suite's `show-render` reconstruction
module is a worked example).

## See also

- Related commands: [`log`](log.md), [`diff`](diff.md), [`cat-file`](cat-file.md)
- Design: `docs/design/cosmetic-output-sweep.md` (sweep) · `docs/design/show-object-output.md` (v1 structure)
- ADRs: 250 (`show` structured-only) · 252 (`withStat` counts) · 253 (merge
  `perParent`) · 249 (structured-output rule) · 242 (rename detection) · 245
  (`<rev>:<path>`)
