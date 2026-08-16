# `diffTrees`

Compare two tree-ids; return a structured `TreeDiff`. Optional rename detection (off by default — quadratic cost) and optional recursion into sub-trees (off by default — single-level, like `git diff-tree`).

## Signature

```ts
repo.primitives.diffTrees(
  a: ObjectId,
  b: ObjectId | undefined,
  options?: {
    detectRenames?: boolean;
    renameOptions?: RenameDetectOptions; // threshold, copies, copyThreshold, breakRewrites
    recursive?: boolean;
    ignoreWhitespace?: 'all' | 'change' | 'at-eol';  // -w / -b / --ignore-space-at-eol
    ignoreCrAtEol?: boolean;                          // --ignore-cr-at-eol
    ignoreBlankLines?: boolean;                       // --ignore-blank-lines
  },
): Promise<TreeDiff>;

interface TreeDiff {
  readonly changes: ReadonlyArray<DiffChange>;
}
```

`renameOptions` threads through to the detection engine unchanged. See
[`diff`](../commands/diff.md) for the full `RenameDetectOptions` knob reference
(`threshold`, `copies`, `copyThreshold`, `breakRewrites`).

`b` may be `undefined`, interpreted as the empty tree (every entry under `a` shows as added).

With `recursive: true`, both trees are flattened to full-path blob entries before classification, so a changed sub-directory surfaces as per-file changes (`src/foo.ts`) rather than a single `src` tree-entry change. This is the mode the Tier-1 `diff` and `show` commands build on.

## Example

```ts
const a = (await repo.primitives.readTree('HEAD~1')).id;
const b = (await repo.primitives.readTree('HEAD')).id;
const diff = await repo.primitives.diffTrees(a, b, { detectRenames: true });
console.log(diff.changes.length);
```

## Whitespace

The three whitespace options thread through identically to the Tier-1 `diff`
command. The line-key drop pass (a file whose only change normalises away under
`ignoreWhitespace`/`ignoreCrAtEol` is removed from `changes`) and blank-line
suppression (`ignoreBlankLines` suppresses hunks/numstat but keeps the file in
`changes`) are both applied here. See [`diff`](../commands/diff.md#whitespace)
for the full behaviour and the numstat omit rule.

## Recursive diff and corrupt trees

With `recursive: true`, the walk enforces only the structural checks a tree
object needs to be readable at all — missing space after mode, malformed or
empty mode, missing NUL after name, empty filename, truncated hash — throwing
`INVALID_TREE_ENTRY` when one is hit, in either tree, at any depth. An
unsorted tree, a duplicate entry name, or a `.`/`..`/embedded-`/` entry name is
walked and diffed exactly as `git diff-tree -r` does, not refused. (The
non-recursive path still refuses invalid or duplicate names via the parsed
`Tree`'s own validation, but silently re-sorts an unsorted tree rather than
diffing it in on-disk order or refusing it — a pre-existing divergence,
unrelated to `recursive: true`.)

## Throws

- `INVALID_TREE_ENTRY` — one of the structural malformations above (`recursive: true` only).
- `UNEXPECTED_OBJECT_TYPE` — a changed directory entry's oid does not resolve to a tree; or `a`/`b` (an `ObjectId`, or a commit/tag oid peeled down to its tree) resolves to something other than a tree.
- `OBJECT_NOT_FOUND` — an oid is missing from the store. With `recursive: true`, a caller-supplied `Tree` is re-read raw by its own `id` before the walk starts, so a hand-forged `Tree` whose `id` was never written throws here even though its `entries` were already in hand.
- `TREE_CYCLE_DETECTED` / `TREE_DEPTH_EXCEEDED` — a gitlink loop, or recursion past `core.maxTreeDepth` (`recursive: true` only). The depth bound is `core.maxTreeDepth`, read from the repository-local config only (default 2048 when unset) and honoured unclamped at any configured value; there is no caller override.
- `TREE_ENTRY_LIMIT_EXCEEDED` — total entries walked — every merge-join level plus every expanded added/deleted subtree — exceeds 1,000,000. One shared budget for the whole `recursive: true` call, not one per subtree.
- `OPERATION_ABORTED` — `ctx.signal` is already aborted.
- `CONFIG_BAD_NUMERIC_VALUE` — the repository-local config holds a `core.maxTreeDepth` value git's numeric grammar refuses. Primitives resolve the cap themselves, so this reaches a direct primitive caller that never went through a command.

## See also

- Tier-1: [`diff`](../commands/diff.md), [`merge`](../commands/merge.md)
- Related primitives: [`readTree`](read-tree.md), [`walkTree`](walk-tree.md)
