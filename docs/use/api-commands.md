# Commands — Tier-1 reference

Every method bound on a `Repository` handle. 21 entries, **alphabetical order**.

Each entry below has the shape:

- **Signature** — TypeScript type, lifted from `src/application/commands/*.ts`
- **Options** — table of fields with type, requirement, and one-line meaning
- **Returns** — shape of the resolved value (or what's thrown)
- **Example** — minimal happy path + one variant when useful
- **See also** — primitives composed; related commands; ADRs that pinned the shape

For composition, error types, and the operator toolkit, see [`api-primitives.md`](api-primitives.md), [`errors.md`](errors.md), and the [recipes](recipes.md).

---

## `add`

Stage paths into `.git/index`. Two modes: literal paths (validated and staged) or `all: true` (walk the working tree, stage every modified/new/untracked path, drop tracked paths missing from disk).

### Signature

```ts
repo.add(
  paths: ReadonlyArray<string>,
  opts?: { force?: boolean; all?: boolean; breakStaleLockMs?: number },
): Promise<AddResult>;

interface AddResult {
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly removed: ReadonlyArray<FilePath>;
}
```

### Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `paths` | `ReadonlyArray<string>` | (required) | Literal paths or pathspec globs. **MUST be empty when `all: true`.** |
| `opts.all` | `boolean` | `false` | Bulk mode — walk the working tree and stage every change. |
| `opts.force` | `boolean` | `false` | Stage ignored paths anyway. |
| `opts.breakStaleLockMs` | `number` | (none) | Break a stale `.git/index.lock` older than this many ms. |

### Pathspec syntax

`*`, `?`, `**` are globs. `!`-prefixed entries exclude (last match wins, `.gitignore` semantics). Anything else is a literal that matches the exact path **and** its descendants. Character classes (`[abc]`) and magic prefixes (`:(top)`, `:(literal)`) are not supported in v1.

### Examples

```ts
// Literal paths
await repo.add(['README.md', 'src/index.ts']);

// Globs — stage every .ts except tests
await repo.add(['*.ts', '!*.test.ts']);

// Bulk mode — stage every change in the working tree
const result = await repo.add([], { all: true });
console.log(result.added.length, result.modified.length, result.removed.length);
```

### Throws

- `PATHSPEC_NO_MATCH` — a literal pattern matched nothing. (Glob no-match is a silent no-op.)
- `INVALID_OPTION { option: 'all' }` — `all: true` with a non-empty pathspec.
- `WORKING_TREE_FILE_TOO_LARGE` — a file exceeds `MAX_WORKING_TREE_BLOB_BYTES` (256 MiB).
- `BARE_REPO` — `add` is not valid in a bare repository.

### See also

- Primitives: `walkWorkingTree`, `readIndex`, `writeObject`
- Related commands: [`rm`](#rm), [`checkout`](#checkout) — share the pathspec syntax
- Recipes: [stage with globs](recipes.md#stage-with-globs), [bulk `add --all`](recipes.md#bulk-add-all)
- ADRs: [029](../adr/029-add-all-ignore-stub.md), [030](../adr/030-add-all-walk-strategy.md), [031](../adr/031-add-all-symlink-gitlink-policy.md), [032](../adr/032-add-all-large-file-guard.md), [037](../adr/037-pathspec-auto-detect.md), [038](../adr/038-pathspec-exclusion.md)

---

## `branch`

List, create, or delete branches.

### Signature

```ts
repo.branch(action:
  | { kind: 'list' }
  | { kind: 'create'; name: string; from?: string }
  | { kind: 'delete'; name: string; force?: boolean }
): Promise<BranchResult>;
```

> _Detailed entry pending — same shape as `add` above. Tracking gap in 18.2 plan._

---

## `catFile`

Batch read of git objects, in strict input order, with per-object size cap.

> _Detailed entry pending._

---

## `checkout`

Switch branches or restore working-tree files from a tree-ish or the index.

> _Detailed entry pending._

---

## `clone`

Clone a remote repository over smart-HTTP. Supports shallow clone (`depth`), partial clone (`filter`), bare clones, and a caller-supplied DNS resolver for SSRF guards.

### Signature

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

### Options

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

### Behaviour

`clone` creates the `.git` skeleton, performs smart-HTTP v1 discovery, fetches the pack, and propagates remote refs (`refs/remotes/origin/*` + tracked branch + tags). It does **not** materialise the working tree — follow up with `repo.checkout({ target: result.head })`.

A `filter` records `origin` as a *promisor remote* in `.git/config`. Objects omitted by the filter are fetched transparently on the first read — every command built on `readObject` works unchanged on a partial clone.

### Examples

```ts
// Full clone over HTTPS
const repo = await openRepository({
  cwd: '/tmp/clone',
  config: {
    dnsResolver: async (host) => (await import('node:dns')).promises.resolve(host),
  },
});

const result = await repo.clone({ url: 'https://github.com/owner/repo.git' });
await repo.checkout({ target: result.head });

// Partial clone — blobs lazy-fetched on read
await repo.clone({ url: 'https://github.com/owner/repo.git', filter: 'blob:none' });

// Shallow clone — last commit only
await repo.clone({ url: 'https://github.com/owner/repo.git', depth: 1 });
```

### Throws

- `TARGET_DIRECTORY_NOT_EMPTY` — `.git/HEAD` already exists in `cwd`.
- `REMOTE_ADVERTISES_NO_REFS` — server returned an empty ref list (or `url === ''`).
- `INVALID_URL` — URL failed SSRF / DNS validation.
- `REMOTE_FILTER_UNSUPPORTED` — server's capabilities lack `filter` for a partial clone.
- `NETWORK_ERROR` — transport failure (reason: `'connection-reset' | 'dns' | 'tls' | 'http-status' | 'aborted' | 'timeout'`).

### See also

- Primitives: `fetchPack`, `recordRefUpdate`, `updateShallow`, `updateConfigEntries`
- Related commands: [`fetch`](#fetch) — re-applies the stored filter on a partial clone; [`fetchMissing`](#fetchmissing) — batch prefetch
- Recipes: [clone + checkout](recipes.md#clone-and-checkout), [partial clone with lazy-fetch](recipes.md#partial-clone)
- ADRs: [005](../adr/005-clone-protocol-v1.md), [006](../adr/006-clone-pack-storage-layout.md), [007](../adr/007-clone-resume-semantics.md), [008](../adr/008-clone-defer-shallow.md), [078](../adr/078-partial-clone-filter-scope.md), [081](../adr/081-promisor-remote-port.md)

---

## `commit`

> _Detailed entry pending._

## `diff`

> _Detailed entry pending._

## `fetch`

> _Detailed entry pending._

## `fetchMissing`

> _Detailed entry pending._

## `init`

> _Detailed entry pending._

## `log`

> _Detailed entry pending._

## `merge`

> _Detailed entry pending._

## `push`

> _Detailed entry pending._

## `reflog`

> _Detailed entry pending._

## `reset`

> _Detailed entry pending._

## `revParse`

> _Detailed entry pending._

## `rm`

> _Detailed entry pending._

## `sparseCheckout`

> _Detailed entry pending._

## `status`

> _Detailed entry pending._

## `submodules`

> _Detailed entry pending._

## `tag`

> _Detailed entry pending._
