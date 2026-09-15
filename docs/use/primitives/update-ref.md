# `updateRef`

The coherent ref-write surface: resolves the current ref value and HEAD, builds the ref write together with any coupled-HEAD reflog entry, and commits both in one [`RefStore.applyRefUpdates`](internals.md#refstore--getrefstore) call — the single point at which anything is written, so a refusal (a CAS mismatch, an invalid name) never leaves a ref written with its reflog entry missing. HEAD is resolved *before* that call; an unresolvable HEAD (an invalid target name) is tolerated when updating another ref — the write proceeds with HEAD read as uncoupled, matching git — but any other HEAD read failure still refuses the whole update before anything is written. A positional `newId` keeps the common case ergonomic.

A default write or delete dereferences a symbolic `name` — the transaction acts on the
name it resolves to (its terminal), logging every walked symbolic ref along the way, the
same way git's own ref transaction splits at each hop. `noDeref` (git's `--no-deref`) acts
on `name` itself instead, without walking through it.

## Signature

```ts
repo.primitives.updateRef(
  name: RefName,
  newId: ObjectId,
  options:
    | { delete?: false; expected?: ObjectId | 'absent'; reflogMessage: string; noDeref?: boolean }
    | { delete: true; expected?: ObjectId | 'absent'; reflogMessage?: string; noDeref?: boolean },
): Promise<void>;
```

The null object id (all-zero) is treated exactly like `delete: true`. `expected` is git's
compare-and-swap: `'absent'` requires the ref not to already exist.

## Example

```ts
await repo.primitives.updateRef('refs/heads/main', newCommitId, {
  expected: previousTip,
  reflogMessage: 'fast-forward to <newCommitId>',
});

// Delete a symbolic ref itself, leaving its target untouched (git's `--no-deref`).
await repo.primitives.updateRef('refs/remotes/origin/HEAD', zeroOid, {
  delete: true,
  noDeref: true,
});
```

## See also

- Related primitives: [`resolveRef`](resolve-ref.md)
- Internal mechanisms: [`RefStore`](internals.md#refstore--getrefstore), [`recordRefUpdate`](internals.md#recordrefupdate), [`writeSymbolicRef`](internals.md#writesymbolicref)
