# `updateRef`

Convenience wrapper around [`recordRefUpdate`](record-ref-update.md). Same atomicity guarantees; gives you a positional `newId` for the common case.

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

- Related primitives: [`recordRefUpdate`](record-ref-update.md), [`writeSymbolicRef`](write-symbolic-ref.md), [`resolveRef`](resolve-ref.md)
