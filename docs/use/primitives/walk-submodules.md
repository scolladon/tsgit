# `walkSubmodules`

`AsyncIterable<SubmoduleEntry>` walker. Iterate without materialising the full list — useful for early-stop / bounded-depth descent.

## Signature

```ts
repo.primitives.walkSubmodules(options?: WalkSubmodulesOptions): AsyncIterable<SubmoduleEntry>;

interface WalkSubmodulesOptions {
  readonly ref?: RefName | ObjectId;  // tree-ish; default 'HEAD'
  readonly recursive?: boolean;
  readonly maxDepth?: number;         // default MAX_SUBMODULE_DEPTH
}
```

## Behaviour

Same as the [`submodule.list`](../commands/submodule.md) command — same name validation, same CVE hardening, same join with `.gitmodules` — but yields one entry at a time so the consumer can stop early.

A recursive descent's local-availability skip (uninitialised, missing-commit,
cycle-detected, and depth-capped submodules yield their own entry but no
children) does **not** cover a hostile gitlink path: the gitlink entry's own
tree path is checked against git's index-entry name rules *before* the
local-availability probe runs, so `recursive: true` over a tree containing one
throws `INVALID_INDEX_ENTRY` rather than silently skipping — whether or not
that submodule happens to be initialised locally.

## Throws

- `INVALID_INDEX_ENTRY` — a gitlink entry's own tree path fails git's own
  index-entry name rules (absolute path; `.`, `..`, or empty segment;
  `.git`/`.gitmodules` alias). Checked at every level of a recursive descent,
  ahead of the local-availability probe.

## Example

```ts
// Stop at the first nested submodule
for await (const entry of repo.primitives.walkSubmodules({ recursive: true })) {
  if (entry.depth >= 2) {
    console.log('first nested:', entry.path);
    break;
  }
}
```

## See also

- Tier-1: [`submodule.list`](../commands/submodule.md)
- Related primitives: [`readObject`](read-object.md), [`walkTree`](walk-tree.md)
- ADRs: [083](../../adr/083-submodule-api-surface.md), [085](../../adr/085-nested-submodule-recursion.md)
