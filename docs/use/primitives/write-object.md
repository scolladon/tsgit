# `writeObject`

Write any `GitObject` to storage as a loose object. Returns the resulting `ObjectId`. Idempotent — writing the same content twice yields the same id and is a no-op the second time.

## Signature

```ts
repo.primitives.writeObject(object: GitObject): Promise<ObjectId>;
```

## Example

```ts
const id = await repo.primitives.writeObject({
  type: 'blob',
  content: new TextEncoder().encode('hello'),
});
```

## Interop with canonical git

Equivalent under readback: the on-disk loose-object SHA matches `git hash-object -w`'s for the same content, and `git cat-file -p <sha>` reads the payload back verbatim. The compressed disk bytes themselves differ — Node's zlib default level is 6, git's is 1 — but the spec doesn't pin compression. See [`design/phase-19-7-interop-suite.md`](../../design/phase-19-7-interop-suite.md).

## Repo-settings validation

`writeObject` validates the repo-settings class (`core.maxTreeDepth`, `core.deltaBaseCacheLimit`) as its **first step**, mirroring git's own `hash-object -w` / `write-tree`, which consult the packed store before writing and so reach `prepare_repo_settings` on the same path. This narrows an earlier guarantee: a primitive-only session (one that never ran an operational gate) still needs no gate to *read* objects, but it is **not** exempt from this check on a *write* — `writeObject` (and `writeTree`, which calls it) refuses a malformed `core.maxTreeDepth` / `core.deltaBaseCacheLimit` whether or not a gate ran this session. See [ADR-862](../../adr/862-the-object-write-entry-is-a-repo-settings-boundary.md) and the [repo-settings tier](internals.md#assertrepossettingsvalid) in `internals.md`.

## Throws

- `CONFIG_BAD_NUMERIC_VALUE` — a malformed `core.maxTreeDepth` or `core.deltaBaseCacheLimit`. See [errors](../errors.md#repository-state).

## See also

- Tier-1: [`commit`](../commands/commit.md), [`add`](../commands/add.md)
- Related primitives: [`writeTree`](write-tree.md), [`createCommit`](create-commit.md), [`readObject`](read-object.md)
