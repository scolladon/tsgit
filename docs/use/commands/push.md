# `push`

Push refs and objects to a remote. Supports `<src>:<dst>` refspecs, force (`+<src>:<dst>` or `force: true`), force-with-lease (`'auto'` or explicit oid), and delete refspecs (`:<dst>`).

## Signature

```ts
repo.push(opts?: PushOptions): Promise<PushResult>;

interface PushOptions {
  readonly remote?: string;                    // default: resolved push-remote chain — see Behaviour
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
| `remote` | `string` | resolved chain | Remote name. Resolved as `branch.<current>.pushRemote` → `remote.pushDefault` → `branch.<current>.remote` → the sole configured remote → `'origin'`; an explicit value always wins. Detached HEAD skips both `branch.<current>.*` rungs. See Behaviour. |
| `refspecs` | `ReadonlyArray<string>` | derived from `push.default` | Explicit `<src>:<dst>`, `+<src>:<dst>`, `:<dst>`, or short-form (`main`). `HEAD` permitted as source. Bypasses `push.default` entirely when given. See Behaviour. |
| `force` | `boolean` | `false` | Skip the non-fast-forward guard for all refspecs in this call. |
| `forceWithLease` | `ObjectId \| 'auto'` | (none) | `'auto'` reads `refs/remotes/<remote>/<branch>` as the lease; explicit `ObjectId` accepts a caller-supplied expected oid. Mismatch throws `PUSH_REJECTED`. |
| `noVerify` | `boolean` | `false` | Skip the `pre-push` hook. |
| `signed` | `'yes' \| 'no' \| 'if-asked'` | `push.gpgSign` | Send a signed push certificate (git's `--signed`). `'yes'` always signs and throws `SIGNED_PUSH_UNSUPPORTED` when the server does not advertise the `push-cert` capability; `'if-asked'` signs only when the server advertises it, else pushes unsigned; `'no'` never signs. Requires a signing program via the command runner. |

## Behaviour

- **Remote selection.** In precedence order: the explicit `remote` option, `branch.<current>.pushRemote`, `remote.pushDefault`, `branch.<current>.remote`, the sole configured remote (only when exactly one `remote.*` block exists), then `'origin'`. A detached HEAD skips both `branch.<current>.*` rungs.
- **`push.default` mode.** When `refspecs` isn't given, the pushed refspec is derived from `push.default` (git's own default, and this library's, is `simple`; `tracking` is a deprecated alias for `upstream`):
  - `nothing` — always refuses (`PUSH_DEFAULT_NOTHING`), before the remote is contacted.
  - `current` — pushes the current branch to a same-named branch on the remote (`refs/heads/<current>:refs/heads/<current>`); refuses (`PUSH_DETACHED_NO_REFSPEC`) on a detached HEAD.
  - `upstream` — refuses (`PUSH_REMOTE_NOT_UPSTREAM`) when the resolved push remote isn't the branch's fetch remote (a triangular workflow); otherwise refuses (`NO_UPSTREAM_CONFIGURED`) when no upstream is configured; otherwise pushes to the branch's configured upstream (`branch.<current>.merge`).
  - `simple` (the default) — same as `upstream`, but on a triangular remote it behaves like `current` instead (no upstream required), and on a non-triangular remote it additionally refuses (`PUSH_UPSTREAM_NAME_MISMATCH`) when the upstream's branch name differs from the current branch's.
  - `matching` — pushes every local branch the remote already advertises under `refs/heads/`; a local branch the remote doesn't carry is simply not pushed. Works on a detached HEAD.

  An explicit `refspecs` option bypasses `push.default` entirely — none of the mode logic above runs. The one exception is validation: an unrecognized `push.default` value still refuses (`INVALID_PUSH_DEFAULT`) even when `refspecs` is given, since that check runs eagerly on every `push` call before the remote or refspec is resolved.
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
- `INVALID_PUSH_DEFAULT` — `push.default` is set to a value other than `nothing`, `current`, `upstream`, `simple`, `matching`, or the `tracking` alias; carries `{ value, source, line }`. Checked eagerly before the remote or refspec is resolved, even when `refspecs` is given explicitly.
- `PUSH_DEFAULT_NOTHING` — `push.default` is `nothing` and no explicit `refspecs` were given.
- `PUSH_DETACHED_NO_REFSPEC` — `push.default` is `current`, `upstream`, or `simple` (including the default), HEAD is detached, and no explicit `refspecs` were given.
- `NO_UPSTREAM_CONFIGURED` — `push.default` is `upstream` or `simple`, the remote isn't triangular, and `branch.<current>.merge` isn't configured. Carries `{ branch }`.
- `PUSH_REMOTE_NOT_UPSTREAM` — `push.default` is `upstream` and the resolved push remote isn't the branch's fetch remote (a triangular workflow). Carries `{ remote, branch }`.
- `PUSH_UPSTREAM_NAME_MISMATCH` — `push.default` is `simple`, the remote isn't triangular, and the configured upstream's branch name differs from the current branch's. Carries `{ branch, upstream }`.
- `SIGNED_PUSH_UNSUPPORTED` — `signed: 'yes'` but the server does not advertise the `push-cert` capability. Nothing is sent. (`'if-asked'` falls back to an unsigned push instead of throwing.)
- `SIGNING_FAILED` — the push certificate could not be signed (signing program failed or unavailable, e.g. off-node).

## See also

- Primitives: [`enumeratePushObjects`](../primitives/internals.md#enumeratepushobjects), [`buildPack`](../primitives/internals.md#buildpack)
- Related commands: [`fetch`](fetch.md), [`branch`](branch.md), [`tag`](tag.md)
- ADRs: [013](../../adr/013-push-pack-encoding.md), [014](../../adr/014-push-refspec-scope.md), [015](../../adr/015-push-force-with-lease.md), [016](../../adr/016-push-atomic-tx.md), [434](../../adr/434-git-service-session-transport-seam.md), [437](../../adr/437-browser-inert-via-absent-ssh-capability.md), [438](../../adr/438-ssh-refusal-error-taxonomy.md), [440](../../adr/440-parse-remote-url-ssh-scp-ssrf-boundary.md), [442](../../adr/442-reuse-command-runner-for-signing.md), [444](../../adr/444-signed-push-in-scope-v1.md), [447](../../adr/447-off-node-signing-hard-refuse.md), [456](../../adr/456-branch-remote-resolution-primitives.md), [458](../../adr/458-push-remote-and-push-default-canonical-git.md)
