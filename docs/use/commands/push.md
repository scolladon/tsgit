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
  readonly signed?: 'yes' | 'no' | 'if-asked';
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
| `signed` | `'yes' \| 'no' \| 'if-asked'` | `push.gpgSign` | Send a signed push certificate (git's `--signed`). `'yes'` always signs and throws `SIGNED_PUSH_UNSUPPORTED` when the server does not advertise the `push-cert` capability; `'if-asked'` signs only when the server advertises it, else pushes unsigned; `'no'` never signs. Requires a signing program via the command runner. |

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
- `INVALID_URL` — malformed remote URL; HTTP: failed SSRF validation; SSH/scp: a control character, or the host/path begins with `-` (argv-injection guard).
- `ADAPTER_UNAVAILABLE` — an `ssh://`/scp-like remote given to a runtime with no `SshTransport` wired (Browser, Memory).
- `NETWORK_ERROR` — transport failure (SSH surfaces the `ssh` child's exit code).
- `REMOTE_NOT_CONFIGURED` — `remote` is not in `.git/config`.
- `CONFIG_MISSING_VALUE` — `remote.<name>.pushurl` or `remote.<name>.url` is present but valueless (git NULL); carries `{ key, source, line }`. Push resolves `pushUrl ?? url`, and refuses on whichever is valueless before that fallback substitutes. Distinct from the absent case (`REMOTE_NOT_CONFIGURED`).
- `SIGNED_PUSH_UNSUPPORTED` — `signed: 'yes'` but the server does not advertise the `push-cert` capability. Nothing is sent. (`'if-asked'` falls back to an unsigned push instead of throwing.)
- `SIGNING_FAILED` — the push certificate could not be signed (signing program failed or unavailable, e.g. off-node).

## See also

- Primitives: [`enumeratePushObjects`](../primitives/internals.md#enumeratepushobjects), [`buildPack`](../primitives/internals.md#buildpack)
- Related commands: [`fetch`](fetch.md), [`branch`](branch.md), [`tag`](tag.md)
- ADRs: [013](../../adr/013-push-pack-encoding.md), [014](../../adr/014-push-refspec-scope.md), [015](../../adr/015-push-force-with-lease.md), [016](../../adr/016-push-atomic-tx.md), [434](../../adr/434-git-service-session-transport-seam.md), [437](../../adr/437-browser-inert-via-absent-ssh-capability.md), [438](../../adr/438-ssh-refusal-error-taxonomy.md), [440](../../adr/440-parse-remote-url-ssh-scp-ssrf-boundary.md), [442](../../adr/442-reuse-command-runner-for-signing.md), [444](../../adr/444-signed-push-in-scope-v1.md), [447](../../adr/447-off-node-signing-hard-refuse.md)
