# `clone`

Clone a remote repository over smart-HTTP. Supports shallow clone (`depth`), partial clone (`filter`), bare clones, and a caller-supplied DNS resolver for SSRF guards.

## Signature

```ts
repo.clone(opts: CloneOptions): Promise<CloneResult>;

interface CloneOptions {
  readonly url: string;
  readonly bare?: boolean;
  readonly initialBranch?: string;
  readonly depth?: number;
  readonly resolver?: DnsResolver;
  readonly allowInsecure?: boolean;
  readonly allowPrivateNetworks?: boolean;
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
| `url` | `string` | (required) | `https://…` or `http://…` repository URL. |
| `bare` | `boolean` | `false` | Build a bare repository (no working tree). |
| `initialBranch` | `string` | (server `HEAD`) | Override the branch `HEAD` points at after clone. |
| `depth` | `number` | (full clone) | Shallow clone depth. Persists boundaries to `.git/shallow`. |
| `filter` | `string` | (full clone) | Partial-clone filter: `'blob:none'`, `'blob:limit=<size>'`, or `'tree:<depth>'`. |
| `resolver` | `DnsResolver` | (none) | DNS resolver injected to enforce SSRF guards. |
| `allowInsecure` | `boolean` | `false` | Permit `http://` URLs. Off by default. |
| `allowPrivateNetworks` | `boolean` | `false` | Permit URLs whose DNS resolution lands on RFC1918 / loopback / link-local. |

## Behaviour

`clone` creates the `.git` skeleton, performs smart-HTTP v1 discovery, fetches the pack, and propagates remote refs (`refs/remotes/origin/*` + tracked branch + tags). It does **not** materialise the working tree — follow up with `repo.checkout({ rev: result.head })`.

A `filter` records `origin` as a *promisor remote* in `.git/config`. Objects omitted by the filter are fetched transparently on the first read — every command built on `readObject` works unchanged on a partial clone.

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

- `TARGET_DIRECTORY_NOT_EMPTY` — `.git/HEAD` already exists in `cwd`.
- `REMOTE_ADVERTISES_NO_REFS` — server returned an empty ref list (or `url === ''`).
- `INVALID_URL` — URL failed SSRF / DNS validation.
- `REMOTE_FILTER_UNSUPPORTED` — server's capabilities lack `filter` for a partial clone.
- `NETWORK_ERROR` — transport failure (reason: `'connection-reset' | 'dns' | 'tls' | 'http-status' | 'aborted' | 'timeout'`).

## See also

- Primitives: [`fetchPack`](../primitives/internals.md#fetchpack), [`recordRefUpdate`](../primitives/record-ref-update.md), [`updateShallow`](../primitives/internals.md#updateshallow), [`updateConfigEntries`](../primitives/internals.md#setconfigentry--setcoreconfigentry--updateconfigentries--updatecoreconfig)
- Related commands: [`fetch`](fetch.md), [`fetchMissing`](fetch-missing.md), [`checkout`](checkout.md)
- Recipes: [clone + checkout](../recipes.md#clone-and-checkout), [partial clone with lazy-fetch](../recipes.md#partial-clone)
- ADRs: [005](../../adr/005-clone-protocol-v1.md), [006](../../adr/006-clone-pack-storage-layout.md), [007](../../adr/007-clone-resume-semantics.md), [008](../../adr/008-clone-defer-shallow.md), [078](../../adr/078-partial-clone-filter-scope.md), [081](../../adr/081-promisor-remote-port.md)
