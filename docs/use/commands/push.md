# `push`

Push refs and objects to a remote. Supports `<src>:<dst>` refspecs, force (`+<src>:<dst>` or `force: true`), force-with-lease (`'auto'` or explicit oid), and delete refspecs (`:<dst>`).

## Signature

```ts
repo.push(opts?: PushOptions): Promise<PushResult>;

interface PushOptions {
  readonly remote?: string;                    // default 'origin'
  readonly refspecs?: ReadonlyArray<string>;
  readonly force?: boolean;
  readonly forceWithLease?: ObjectId | 'auto';
  readonly noVerify?: boolean;
}

interface PushResult {
  readonly pushedRefs: ReadonlyArray<PushedRef>;
}

interface PushedRef {
  readonly name: RefName;
  readonly status: 'ok' | 'rejected';
  readonly reason?: string;     // server's `ng <reason>` line when rejected
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `remote` | `string` | `'origin'` | Remote name from `.git/config`. |
| `refspecs` | `ReadonlyArray<string>` | (current branch) | Explicit `<src>:<dst>`, `+<src>:<dst>`, `:<dst>`, or short-form (`main`). `HEAD` permitted as source. |
| `force` | `boolean` | `false` | Skip the non-fast-forward guard for all refspecs in this call. |
| `forceWithLease` | `ObjectId \| 'auto'` | (none) | `'auto'` reads `refs/remotes/<remote>/<branch>` as the lease; explicit `ObjectId` accepts a caller-supplied expected oid. Mismatch throws `PUSH_REJECTED`. |
| `noVerify` | `boolean` | `false` | Skip the `pre-push` hook. |

## Behaviour

- **Atomic ref updates.** All accepted refspecs land server-side under the same transaction.
- **Local remote-tracking refresh.** On an accepted heads-branch push, `refs/remotes/<remote>/<branch>` is updated to the new oid.
- **Hooks (Node only):** `pre-push` runs with git's canonical `<local-ref> <local-oid> <remote-ref> <remote-oid>` stdin.

## Examples

```ts
// Default: push current branch to origin
await repo.push();

// Explicit refspec
await repo.push({ remote: 'origin', refspecs: ['refs/heads/main:refs/heads/main'] });

// Force-with-lease against cached remote-tracking ref
await repo.push({ forceWithLease: 'auto' });

// Delete a remote ref
await repo.push({ refspecs: [':refs/heads/feature/x'] });

// Per-refspec inspection
const result = await repo.push({ refspecs: ['main', 'feature/y'] });
for (const r of result.pushedRefs) {
  console.log(r.name, r.status, r.reason ?? '');
}
```

## Throws

- `PUSH_REJECTED` — server returned `ng` for at least one ref (also covers `forceWithLease` mismatch). Surfaces in `pushedRefs[i].status`.
- `NON_FAST_FORWARD` — non-fast-forward refspec without `force` / `forceWithLease`.
- `HOOK_FAILED` — `pre-push` returned non-zero exit (when hooks are enabled).
- `NETWORK_ERROR` — transport failure.
- `REMOTE_NOT_CONFIGURED` — `remote` is not in `.git/config`.
- `CONFIG_MISSING_VALUE` — `remote.<name>.url` **or** `pushurl` is present but valueless (git NULL); carries `{ key, source, line }`. Push refuses eagerly, even when a usable URL resolves, reporting the first valueless of the two by config-file line. Distinct from the absent case (`REMOTE_NOT_CONFIGURED`).

## See also

- Primitives: [`enumeratePushObjects`](../primitives/internals.md#enumeratepushobjects), [`buildPack`](../primitives/internals.md#buildpack)
- Related commands: [`fetch`](fetch.md), [`branch`](branch.md), [`tag`](tag.md)
- ADRs: [013](../../adr/013-push-pack-encoding.md), [014](../../adr/014-push-refspec-scope.md), [015](../../adr/015-push-force-with-lease.md), [016](../../adr/016-push-atomic-tx.md)
