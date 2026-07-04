# `fetch`

Fetch refs and objects from a remote. Supports shallow fetch (`depth`), prune (`prune`), and re-applies the stored partial-clone filter so a partial repo stays partial.

## Signature

```ts
repo.fetch(opts?: FetchOptions): Promise<FetchResult>;

interface FetchOptions {
  readonly remote?: string;                    // default 'origin'
  readonly refspecs?: ReadonlyArray<string>;   // default '+refs/heads/*:refs/remotes/<remote>/*'
  readonly prune?: boolean;                    // default false
  readonly depth?: number;                     // shallow fetch boundary
}

interface FetchResult {
  readonly updatedRefs: ReadonlyArray<FetchUpdate>;
  readonly prunedRefs: ReadonlyArray<RefName>;
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

interface FetchUpdate {
  readonly name: RefName;
  readonly oldId: ObjectId | undefined;
  readonly newId: ObjectId;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `remote` | `string` | `'origin'` | Remote name. Resolved against `.git/config` `[remote "<name>"]`. |
| `refspecs` | `ReadonlyArray<string>` | branches refspec | Explicit refspec list. |
| `prune` | `boolean` | `false` | Delete `refs/remotes/<remote>/*` entries the server no longer advertises. Local branches and tags are never touched. |
| `depth` | `number` | (full) | Shallow fetch depth. Writes `.git/shallow`. |

## Behaviour

- **Partial clone aware:** if `.git/config` records `partialclonefilter`, the fetch re-applies that filter; the repo stays partial. If the server no longer advertises `filter` support, re-applying throws `REMOTE_FILTER_UNSUPPORTED`.
- **Protocol negotiation:** `fetch` opts into smart-HTTP protocol v2 (`ls-refs` + `fetch` commands) and falls back to v1 when the server doesn't advertise `version 2`; SSH remotes always use v1. Both legs, including partial-clone `filter`, are supported.
- **Incremental fetch:** a remote that has advanced since the last fetch returns the new objects, on either protocol version.
- **No-op short-circuit:** when every wanted object already exists locally, `fetch` skips the pack round-trip entirely — no `fetch`/upload-pack exchange, no packfile written.
- **Atomic ref updates:** all ref updates land under a single lock or none do.
- **Reflog:** updates land in `.git/logs/` via the standard `recordRefUpdate` writer.

## Examples

```ts
// Default: fetch all branches from origin
await repo.fetch();

// Shallow fetch of a single branch
await repo.fetch({ remote: 'origin', refspecs: ['refs/heads/main:refs/remotes/origin/main'], depth: 1 });

// Prune deleted remote branches
const result = await repo.fetch({ prune: true });
console.log(result.prunedRefs);
```

## Throws

- `REMOTE_NOT_CONFIGURED` — `remote` is not in `.git/config`.
- `CONFIG_MISSING_VALUE` — `remote.<name>.url` is present but valueless (git NULL); carries `{ key, source, line }`. Distinct from the absent case (`REMOTE_NOT_CONFIGURED`).
- `INVALID_URL` — malformed remote URL; HTTP: failed SSRF validation; SSH/scp: a control character, or the host/path begins with `-` (argv-injection guard).
- `ADAPTER_UNAVAILABLE` — an `ssh://`/scp-like remote given to a runtime with no `SshTransport` wired (Browser, Memory).
- `NETWORK_ERROR` — transport failure (reason varies; SSH surfaces the `ssh` child's exit code).
- `REFSPEC_INVALID` — refspec syntactically invalid.
- `REMOTE_FILTER_UNSUPPORTED` — the repo's stored `partialclonefilter` can't be re-applied because the server's capabilities lack `filter` support (v1 capability list or v2 `fetch` command's sub-features).

## See also

- Design: `docs/design/incremental-fetch-negotiation.md`
- Primitives: [`fetchPack`](../primitives/internals.md#fetchpack), [`enumerateRefs`](../primitives/internals.md#enumeraterefs), [`readShallow`](../primitives/internals.md#readshallow), [`updateShallow`](../primitives/internals.md#updateshallow)
- Related commands: [`clone`](clone.md), [`fetchMissing`](fetch-missing.md), [`push`](push.md)
- ADRs: [009](../../adr/009-fetch-shallow-where.md), [010](../../adr/010-fetch-haves-strategy.md), [011](../../adr/011-fetch-ref-update-tx.md), [012](../../adr/012-fetch-prune-semantics.md), [434](../../adr/434-git-service-session-transport-seam.md), [437](../../adr/437-browser-inert-via-absent-ssh-capability.md), [438](../../adr/438-ssh-refusal-error-taxonomy.md), [440](../../adr/440-parse-remote-url-ssh-scp-ssrf-boundary.md), [450](../../adr/450-fetch-protocol-v2-with-v1-fallback.md), [451](../../adr/451-fetch-v1-fallback-framing-and-multi-ack.md), [452](../../adr/452-empty-pack-suppression-and-everything-local.md)
