# `recordRefUpdate`

Atomic ref CRUD with reflog write. The single chokepoint every ref-moving command goes through — write a ref directly only when you need that lower-level seam.

## Signature

```ts
repo.primitives.recordRefUpdate(
  name: RefName,
  oldId: ObjectId | undefined,
  newId: ObjectId,
  message: string,
): Promise<void>;
```

## Behaviour

- **Atomicity:** the ref write and the reflog append are wrapped in a single lock.
- **`oldId` check** (CAS): if `oldId` is set and doesn't match the current value, throws `REF_CAS_FAILURE`. Pass `undefined` to skip the check.
- **`newId === ZERO_OID`** deletes the ref.
- **Reflog gate:** writes a reflog entry when `core.logAllRefUpdates` is on (default) for default-loggable prefixes (`refs/heads/`, `refs/remotes/`, `refs/notes/`, `HEAD`).
- **HEAD dual logging:** when the update advances HEAD's underlying branch, both `.git/logs/HEAD` and `.git/logs/refs/heads/<branch>` get entries.

## Example

```ts
const tip = await repo.primitives.resolveRef('refs/heads/main');
const next = await repo.primitives.createCommit({ /* … */ });
await repo.primitives.recordRefUpdate('refs/heads/main', tip, next, 'commit: <subject>');
```

## See also

- Tier-1: [`commit`](../commands/commit.md), [`branch`](../commands/branch.md), [`tag`](../commands/tag.md), [`reset`](../commands/reset.md)
- Related primitives: [`updateRef`](update-ref.md), [`writeSymbolicRef`](write-symbolic-ref.md), [`resolveRef`](resolve-ref.md)
- ADRs: [058](../../adr/058-reflog-integration-point.md), [059](../../adr/059-head-dual-logging.md), [063](../../adr/063-log-all-ref-updates.md)
