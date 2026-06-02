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

interface ShowOptions {
  readonly contextLines?: number; // commit-patch hunk context; default 3
}

interface ShowTreeEntry {
  readonly name: string;
  readonly mode: FileMode;
  readonly id: ObjectId;
}

type ShowResult =
  | { readonly kind: 'commit'; readonly id: ObjectId; readonly commit: CommitData;
      readonly patch?: PatchResult; readonly text: string }     // patch omitted for merges
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
- **Merge commits** emit a `Merge:` line and **no patch** (git's default);
  **root commits** diff against the empty tree.
- A revision repeated across the arg list de-duplicates if it resolves to a
  commit (git's revision-walker semantics); blobs, trees, and tags do not.
- Annotated tags are **not** auto-peeled: `show('v1.0')` renders the tag
  object (and recurses into its target), never just the target.

## Deferred (not v1)

`-s` / `--no-patch`, `--format` / `--pretty`, `--stat`, `<rev>:<path>` blob
lookup, combined merge diffs (`-c` / `-m` / `--cc`), and alternate `--date=`
modes. Each is an additive option on the same return shape.

## See also

- Related commands: [`log`](log.md), [`diff`](diff.md), [`cat-file`](cat-file.md)
- Design: `docs/design/show-object-output.md`
- ADRs: 240 (structured union + faithful bytes) · 241 (multi-rev `shown_one` +
  commit dedup) · 242 (patch rename detection on by default)
