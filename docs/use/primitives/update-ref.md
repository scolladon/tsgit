# `updateRef`

The coherent ref-write surface: resolves the current ref value and HEAD, builds the ref write together with any coupled-HEAD reflog entry, and commits both in one [`RefStore.applyRefUpdates`](internals.md#refstore--getrefstore) call — the single point at which anything is written, so a refusal (a CAS mismatch, an invalid name) never leaves a ref written with its reflog entry missing. HEAD is resolved *before* that call; an unresolvable HEAD (an invalid target name) is tolerated when updating another ref — the write proceeds with HEAD read as uncoupled, matching git — but any other HEAD read failure still refuses the whole update before anything is written. A positional `newId` keeps the common case ergonomic.

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
- Internal mechanisms: [`RefStore`](internals.md#refstore--getrefstore), [`recordRefUpdate`](internals.md#recordrefupdate), [`writeSymbolicRef`](internals.md#writesymbolicref)
