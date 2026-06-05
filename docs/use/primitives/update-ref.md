# `updateRef`

The coherent ref-write surface: atomically writes the ref, records the matching reflog (via the internal [`recordRefUpdate`](internals.md#recordrefupdate)), and logs coupled HEAD. A positional `newId` keeps the common case ergonomic.

## Signature

```ts
repo.primitives.updateRef(
  name: RefName,
  newId: ObjectId,
  options?: { oldId?: ObjectId; message?: string },
): Promise<void>;
```

## Example

```ts
await repo.primitives.updateRef('refs/heads/main', newCommitId, {
  oldId: previousTip,
  message: 'fast-forward to <newCommitId>',
});
```

## See also

- Related primitives: [`resolveRef`](resolve-ref.md)
- Internal mechanisms: [`recordRefUpdate`](internals.md#recordrefupdate), [`writeSymbolicRef`](internals.md#writesymbolicref)
