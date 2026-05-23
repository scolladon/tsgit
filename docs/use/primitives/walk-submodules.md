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

Same as the [`submodules`](../commands/submodules.md) command — same name validation, same CVE hardening, same join with `.gitmodules` — but yields one entry at a time so the consumer can stop early.

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

- Tier-1: [`submodules`](../commands/submodules.md)
- Related primitives: [`readObject`](read-object.md), [`walkTree`](walk-tree.md)
- ADRs: [083](../../adr/083-submodule-api-surface.md), [085](../../adr/085-nested-submodule-recursion.md)
