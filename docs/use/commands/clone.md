# `clone`

Clone a remote repository over smart-HTTP, or over SSH (`ssh://[user@]host[:port]/path` and scp-like `[user@]host:path`, Node only — see [Node get-started](../../get-started/node.md#ssh-remotes)). Supports shallow clone (`depth`), partial clone (`filter`), and bare clones. The SSRF guard (DNS resolver, `http://` and private-network policy) applies to HTTP(S) remotes and is configured once on `openRepository`, not per call; SSH remotes delegate connection security entirely to the system `ssh` — see [security](../../understand/security.md).

## Signature

```ts
repo.clone(opts: CloneOptions): Promise<CloneResult>;

interface CloneOptions {
  readonly url: string;
  readonly bare?: boolean;
  readonly initialBranch?: string;
  readonly depth?: number;
  readonly filter?: string;
}

interface CloneResult {
  readonly path: FilePath;
  readonly head: RefName | undefined;
  readonly fetchedRefs: ReadonlyArray<{ name: RefName; id: ObjectId }>;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | `string` | (required) | `https://…`/`http://…`, or (Node only) `ssh://[user@]host[:port]/path` and scp-like `[user@]host:path`. |
| `bare` | `boolean` | `false` | Build a bare repository (no working tree). |
| `initialBranch` | `string` | (server `HEAD`) | Override the branch `HEAD` points at after clone. |
| `depth` | `number` | (full clone) | Shallow clone depth. Persists boundaries to `.git/shallow`. |
| `filter` | `string` | (full clone) | Partial-clone filter: `'blob:none'`, `'blob:limit=<size>'`, or `'tree:<depth>'`. |

> There is **no `objectFormat` option** — real git's `clone` has no
> `--object-format` flag either. The destination's hash algorithm is learned
> from the source, not requested by the caller; see Behaviour below.

> SSRF policy is **not** a clone option. Configure it once on `openRepository({ config: { dnsResolver, allowInsecure, allowPrivateNetworks } })`; the transport wrapper enforces it on every request (see [security](../../understand/security.md)). The default fail-closed resolver rejects every host until `dnsResolver` is supplied.

## Behaviour

`bare: true` writes the clone at `ctx.layout.gitDir` — same as [`init`](init.md), it does not relocate the layout the `Context` was opened with. To reopen the result (with tsgit or real git), open with `gitDir` equal to `cwd` before cloning, so the constructed layout already has no work tree: `openRepository({ cwd: d, gitDir: d, bare: true })` then `repo.clone({ url, bare: true })`.

`clone` creates the `.git` skeleton, opens a session against the resolved transport (smart-HTTP, negotiating protocol v2 — `ls-refs` discovery + the `fetch` command — with a v1 fallback for servers that don't advertise `version 2`; or a single duplex channel over SSH, always v1), fetches the pack, and propagates remote refs (`refs/remotes/origin/*` + tracked branch + tags) — ref resolution, including the tracked branch's `HEAD` symref, works the same on both protocol versions. It does **not** materialise the working tree — follow up with `repo.checkout({ rev: result.head })`.

The destination's object-format (sha1 or sha256) is **adopted from the source**, not requested: discovery happens first, and the `.git` skeleton is written only once the peer's algorithm is known, matching real git's clone (which has no `--object-format` of its own). A source declaring sha256 produces a sha256 destination — `.git/config` carries `[extensions]`/`objectformat = sha256` — even when the caller's own `Context` defaults to sha1. The one refusal left on this path is a caller-supplied `HashService` that cannot be re-instantiated for another algorithm (no `withAlgorithm`): that throws `UNSUPPORTED_OBJECT_FORMAT` rather than silently cloning at the wrong width.

A `filter` records `origin` as a *promisor remote* in `.git/config`. Objects omitted by the filter are fetched transparently on the first read — every command built on `readObject` works unchanged on a partial clone. Partial clone works over either protocol version: the server needs to advertise `filter` — as a v1 capability, or as a sub-feature of the v2 `fetch` command — or the clone throws `REMOTE_FILTER_UNSUPPORTED`.

## Examples

```ts
// Full clone over HTTPS
const repo = await openRepository({
  cwd: '/tmp/clone',
  config: {
    dnsResolver: async (host) => (await import('node:dns')).promises.resolve(host),
  },
});

const result = await repo.clone({ url: 'https://github.com/owner/repo.git' });
await repo.checkout({ rev: result.head });

// Partial clone — blobs lazy-fetched on read
await repo.clone({ url: 'https://github.com/owner/repo.git', filter: 'blob:none' });

// Shallow clone — last commit only
await repo.clone({ url: 'https://github.com/owner/repo.git', depth: 1 });
```

## Throws

`clone` does **not** validate `[core]` config (`core.maxTreeDepth`, `core.loosecompression` / `core.compression`, …) on either the destination or the ambient repository the caller happens to be standing in — a deliberate divergence from a blanket "every operational command gates" rule, not an oversight. Canonical git's own refusal on an invalid `core.maxTreeDepth` is a **source-side** effect: the process serving a local-path clone reads its own config at startup and dies before it can serve anything. Git never reads the destination's config (an occupied destination fails with "already exists" first, before any config read) and never reads the ambient repository's. tsgit's `clone` is client-only and reaches its source through a transport, so it has no analogue for that source-side read; gating on the destination or ambient config here would refuse a clone git accepts.

- `TARGET_DIRECTORY_NOT_EMPTY` — `.git/HEAD` already exists at the target gitDir. `path` names the work tree, or the gitDir itself for a bare target with none.
- `REMOTE_ADVERTISES_NO_REFS` — server returned an empty ref list (or `url === ''`).
- `INVALID_URL` — malformed remote URL; HTTP: failed SSRF / DNS validation; SSH/scp: a control character, or the host/path begins with `-` (argv-injection guard).
- `ADAPTER_UNAVAILABLE` — an `ssh://`/scp-like remote given to a runtime with no `SshTransport` wired (Browser, Memory).
- `UNSUPPORTED_OBJECT_FORMAT` — the peer advertised a hash algorithm the local `HashService` cannot adopt (no `withAlgorithm`), or a format outside `sha1`/`sha256`.
- `REMOTE_FILTER_UNSUPPORTED` — server's capabilities lack `filter` for a partial clone.
- `NETWORK_ERROR` — transport failure (HTTP reason: `'connection-reset' | 'dns' | 'tls' | 'http-status' | 'aborted' | 'timeout'`; SSH: the `ssh` child's exit code).

## See also

- Design: `docs/design/incremental-fetch-negotiation.md`
- Primitives: [`fetchPack`](../primitives/internals.md#fetchpack), [`recordRefUpdate`](../primitives/internals.md#recordrefupdate), [`updateShallow`](../primitives/internals.md#updateshallow), [`updateConfigEntries`](../primitives/internals.md#setconfigentry--setcoreconfigentry--updateconfigentries--updatecoreconfig)
- Related commands: [`fetch`](fetch.md), [`fetchMissing`](fetch-missing.md), [`checkout`](checkout.md)
- Recipes: [clone + checkout](../recipes.md#clone-and-checkout), [partial clone with lazy-fetch](../recipes.md#partial-clone)
- ADRs: [005](../../adr/005-clone-protocol-v1.md) (superseded by 450), [006](../../adr/006-clone-pack-storage-layout.md), [007](../../adr/007-clone-resume-semantics.md), [008](../../adr/008-clone-defer-shallow.md), [078](../../adr/078-partial-clone-filter-scope.md), [081](../../adr/081-promisor-remote-port.md), [434](../../adr/434-git-service-session-transport-seam.md), [437](../../adr/437-browser-inert-via-absent-ssh-capability.md), [438](../../adr/438-ssh-refusal-error-taxonomy.md), [440](../../adr/440-parse-remote-url-ssh-scp-ssrf-boundary.md), [450](../../adr/450-fetch-protocol-v2-with-v1-fallback.md), [451](../../adr/451-fetch-v1-fallback-framing-and-multi-ack.md), [452](../../adr/452-empty-pack-suppression-and-everything-local.md)
