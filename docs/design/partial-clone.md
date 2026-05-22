# Design — Partial Clone (Phase 17.4)

## 1. Goal

Implement git **partial clone**: clone a repository while asking the server to
omit a class of objects (`--filter=<spec>`), and transparently fetch the
omitted objects on demand when a later read needs them ("lazy-fetch on read").

Backlog item **17.4**. Scope decided with the user (ADR-078, ADR-079):

- **Filter specs supported:** `blob:none`, `blob:limit=<n>`, `tree:<depth>`.
- **Lazy-fetch:** automatic and transparent inside `readObject`, **plus** an
  explicit batch API `repo.fetchMissing(oids)` so bulk readers (checkout,
  diff) can pull many objects in one round-trip.

Non-goals: smart-HTTP protocol v2, `sparse:oid` / `combine:` filters, partial
*push*, on-disk repacking of promisor packs.

## 2. Background — how git partial clone works

A partial clone is an ordinary clone with two additions:

1. The `git-upload-pack` request carries a `filter <spec>` line. The server
   omits the filtered objects from the returned pack.
2. The repository records a **promisor remote** in `.git/config`
   (`extensions.partialClone`, `remote.<name>.promisor`,
   `remote.<name>.partialclonefilter`) and marks every pack received from it
   with an empty `pack-<sha>.promisor` sentinel file. A promisor pack vouches
   that any object it references but does not contain is *promised* — it can
   be fetched from the promisor remote rather than being treated as corruption.

When a read hits an object that is not present locally, git lazy-fetches it
from the promisor remote and retries the read.

## 3. Wire format — the `filter` line

`git-upload-pack` protocol v1 request body (`upload-request`):

```
want <oid> <capabilities>\n      first want carries the capability list
want <oid>\n                     additional wants
...
shallow <oid>\n                  (existing; unchanged)
deepen <n>\n                     (existing; unchanged)
filter <filter-spec>\n           NEW — at most one, after deepen
0000                             flush
have <oid>\n                     (existing; unchanged)
...
done\n
```

The `filter` line is only legal when the client advertised the `filter`
capability in the first `want` line **and** the server advertised `filter` in
its ref-advertisement capability list.

### 3.1 Filter spec grammar

```
filter-spec  = "blob:none"
             / "blob:limit=" int [ "k" / "m" / "g" ]   (case-insensitive suffix)
             / "tree:" non-negative-int
```

`blob:limit=<n>[kmg]` — `k`/`m`/`g` multiply by 1024 / 1024² / 1024³. The
parsed, canonicalised form drops the suffix (`blob:limit=1k` → `blob:limit=1024`).

## 4. Domain — object filter

New module `src/domain/protocol/object-filter.ts`.

```ts
export type ObjectFilter =
  | { readonly kind: 'blob-none' }
  | { readonly kind: 'blob-limit'; readonly bytes: number }
  | { readonly kind: 'tree-depth'; readonly depth: number };

/** Parse a wire/CLI filter spec. Throws INVALID_FILTER_SPEC on bad input. */
export const parseObjectFilter: (spec: string) => ObjectFilter;

/** Canonical wire form — `blob:none` / `blob:limit=<bytes>` / `tree:<depth>`. */
export const formatObjectFilter: (filter: ObjectFilter) => string;
```

`parseObjectFilter` is total and pure: it validates and never reaches the
network. `bytes` and `depth` are non-negative safe integers; a value that is
negative, fractional, `NaN`, or beyond `Number.MAX_SAFE_INTEGER` is rejected.

New protocol error variant:

```ts
| { readonly code: 'INVALID_FILTER_SPEC'; readonly spec: string; readonly reason: string }
| { readonly code: 'REMOTE_FILTER_UNSUPPORTED' }
```

`INVALID_FILTER_SPEC` — the user supplied an unparseable `--filter`.
`REMOTE_FILTER_UNSUPPORTED` — a filter was requested but the server did not
advertise the `filter` capability.

Both are protocol-layer errors (the filter is a protocol concept). `reason`
carries a short machine-stable token (`unknown-kind`, `bad-blob-limit`,
`bad-tree-depth`, `empty`) so tests assert on data, not message text.

## 5. Protocol layer

### 5.1 `buildUploadPackRequest`

`WantHaveRequest` gains an optional field:

```ts
readonly filter?: string;   // canonical filter spec, already validated
```

`buildUploadPackRequest` appends `filter <spec>\n` to the want-payload stream
**after** the optional `deepen` line, before the flush. `filter` is a string
(already canonicalised by the caller) — the protocol layer does not re-parse.

### 5.2 Capability negotiation

`CLIENT_CAPABILITIES_FETCH` (`src/domain/protocol/capabilities.ts`) gains the
`filter` token. `selectFetchCapabilities` already intersects client wants with
the server advertisement, so `filter` survives **iff** the server advertised
it. Announcing `filter` without sending a `filter` line is a normal,
inert capability advertisement (this is what a non-partial fetch from a
filter-capable server already looks like in canonical git).

A new helper in `upload-pack-client.ts`:

```ts
/** True when the server's advertised capability set includes `filter`. */
export const advertisesFilter: (capabilities: ReadonlyArray<string>) => boolean;
```

`clone` calls it and throws `REMOTE_FILTER_UNSUPPORTED` when a filter was
requested against a server that cannot honour it — fail fast, before the pack
POST.

## 6. Primitive layer — `fetchPack`

`FetchPackInput` gains two optional fields:

```ts
/** Canonical filter spec. When set, emits a `filter` line; requires the
 *  `filter` capability to be in `capabilities`. */
readonly filter?: string;
/** When true, write an empty `pack-<sha>.promisor` sentinel beside the
 *  pack so the objects it references but omits are treated as promised. */
readonly promisor?: boolean;
```

`fetchPack` threads `filter` into `buildUploadPackRequest` and, after writing
`pack-<sha>.pack` / `.idx`, writes `pack-<sha>.promisor` (zero bytes) when
`promisor` is set. The empty-pack early-return path writes no `.promisor`
(there is no pack to vouch for).

`writePackArtifacts` uses `writeExclusive`; a `FILE_EXISTS` collision means a
byte-identical pack (the name is the content SHA) is already on disk. The
lazy-fetch caller (§8) tolerates `FILE_EXISTS` and treats it as success;
`fetchPack` itself is unchanged so `clone` / `fetch` semantics do not move.

## 7. Configuration

### 7.1 Reading — `ParsedConfig`

`config-read.ts` gains:

```ts
readonly extensions?: { readonly partialClone?: string };   // promisor remote name
// remote map entry:
{ url?, fetch?, promisor?: boolean, partialCloneFilter?: string }
```

The parser learns the `[extensions]` section and the `remote.<name>.promisor`
/ `remote.<name>.partialclonefilter` keys (git config keys are matched
case-insensitively, as the existing `[core]` parser already does).

### 7.2 Writing — generalised `[section]` writer

`update-config.ts` today writes only `[core]` (ADR-074). Partial clone must
also write `[extensions]` and `[remote "origin"]`, so the line-surgery writer
is generalised:

```ts
/** Set `key` under `[section]` / `[section "subsection"]`, preserving every
 *  other byte. Section name matched case-insensitively; subsection matched
 *  case-sensitively (git semantics). */
export const setConfigEntry:
  (text: string, section: string, subsection: string | undefined,
   key: string, value: string) => string;

/** setConfigEntry bound to `[core]` — kept for the sparse-checkout caller. */
export const setCoreConfigEntry:
  (text: string, key: string, value: string) => string;

/** Fold setConfigEntry over a batch, write, invalidate the readConfig cache. */
export const updateConfigEntries:
  (ctx: Context, entries: ReadonlyArray<ConfigEntry>) => Promise<void>;

interface ConfigEntry {
  readonly section: string;
  readonly subsection?: string;
  readonly key: string;
  readonly value: string;
}
```

`updateCoreConfig` is retained, re-expressed over `updateConfigEntries`.
Control-char rejection extends to the subsection name (a `"` or `\n` in a
subsection would let line surgery splice a forged section).

### 7.3 What `clone --filter` writes

After a successful filtered fetch, `clone` persists (remote name fixed to
`origin`, matching the existing ref propagation):

```ini
[core]
	repositoryformatversion = 1     ; extensions.* require format v1 (git interop)
[remote "origin"]
	url = <url>
	fetch = +refs/heads/*:refs/remotes/origin/*
	promisor = true
	partialclonefilter = <canonical-spec>
[extensions]
	partialClone = origin
```

A **non-partial** clone is unchanged — it writes no `[remote]` section (the
pre-existing `fetch`-after-`clone` gap is out of scope for 17.4).

## 8. Lazy-fetch

### 8.1 The `PromisorRemote` port

`readObject` is a primitive; the fetch machinery (`discoverRefs`,
`withDefaults`) lives in the command tier. To let the primitive trigger a
fetch without importing upward (the `primitives-cannot-import-commands`
dependency rule), lazy-fetch is exposed as an **optional port on `Context`**,
mirroring `hooks?: HookRunner`.

`src/ports/promisor.ts`:

```ts
export interface PromisorFetchOutcome {
  /** False when the repository has no promisor remote configured — the
   *  caller then falls through to its normal `OBJECT_NOT_FOUND`. */
  readonly attempted: boolean;
  readonly requested: number;
  readonly fetched: number;
}

export interface PromisorRemote {
  fetch(oids: ReadonlyArray<ObjectId>): Promise<PromisorFetchOutcome>;
}
```

`Context` gains `readonly promisor?: PromisorRemote`. `openRepository` always
wires it (the implementation self-gates on config — a non-partial repo's
`fetch` returns `attempted: false`).

### 8.2 The `fetchMissing` command

`src/application/commands/fetch-missing.ts` exposes two entry points over one
shared internal routine `fetchMissingInternal(ctx, oids)`:

```ts
export interface FetchMissingOptions { readonly oids: ReadonlyArray<ObjectId>; }
export interface FetchMissingResult {
  readonly remote: string;
  readonly requested: number;   // oids asked for
  readonly fetched: number;     // oids that were missing and got fetched
}

/** Tier-1 command — throws NO_PROMISOR_REMOTE on a non-partial repo. */
export const fetchMissing:
  (ctx: Context, opts: FetchMissingOptions) => Promise<FetchMissingResult>;

/** PromisorRemote port implementation — never throws NO_PROMISOR_REMOTE;
 *  reports `attempted: false` instead so `readObject` falls through cleanly. */
export const createPromisorRemote: (ctx: Context) => PromisorRemote;
```

`fetchMissingInternal` returns a discriminated outcome
(`{ kind: 'no-promisor' } | { kind: 'fetched'; remote; requested; fetched }`).
`fetchMissing` maps `no-promisor` to a thrown `NO_PROMISOR_REMOTE`;
`createPromisorRemote(ctx).fetch` maps it to `attempted: false`.

Algorithm (`fetchMissingInternal`):

1. `assertRepository(ctx)`.
2. Read config. No `extensions.partialClone` ⇒ return `{ kind: 'no-promisor' }`.
3. Resolve `remote.<name>.url`. Absent ⇒ `REMOTE_NOT_CONFIGURED` (a partial
   repo with no remote URL is corrupt).
4. Filter `oids` to those **not present locally** (loose-object probe + a
   fresh `PackRegistry` lookup — no `readObject`, so no re-entrancy). De-dupe.
   Empty ⇒ return `{ fetched: 0 }` without touching the network.
5. `withDefaults` transport → `discoverRefs` → `selectFetchCapabilities`.
6. `fetchPack({ wants: missing, haves: [], capabilities, url, promisor: true,
   progressOp: 'fetch-missing:write-objects' })`. **No `filter`** (§8.4).
   A `FILE_EXISTS` from a concurrent identical pack write is swallowed.
7. Return.

### 8.3 Wiring into `readObject`

`read-object.ts` keeps a per-`Context` `PackRegistry` (existing `WeakMap`) and
adds a per-`Context` **in-flight map** `Map<ObjectId, Promise<void>>` so
concurrent reads of the same missing object share one fetch.

```
readObject(ctx, id, opts):
  registry = getPackRegistry(ctx)
  try:
    return resolveObject(ctx, registry, id, …)
  catch err:
    if err is not OBJECT_NOT_FOUND for `id`  -> rethrow
    if ctx.promisor is undefined             -> rethrow
    await lazyFetchOnce(ctx, id)             # deduped via the in-flight map
    registry.refresh()                       # see the newly written pack
    return resolveObject(ctx, registry, id, …)   # one retry; may still throw
```

`PackRegistry` gains `refresh(): void` — clears its cached `.idx` scan so the
next `lookup` re-scans `objects/pack/` and finds the lazy-fetched pack.

`lazyFetchOnce` calls `ctx.promisor.fetch([id])`. If the outcome is
`attempted: false`, the wrapper rethrows the original `OBJECT_NOT_FOUND`
(non-partial repo). The retry is attempted exactly once; a still-missing
object after the retry surfaces `OBJECT_NOT_FOUND` normally.

`readBlob` delegates to `readObject`, so it inherits lazy-fetch with no change.
`resolveObject`'s internal REF_DELTA base recursion calls `resolveObject`, not
`readObject` — delta bases are never lazy-fetched, which is correct: tsgit
strips `thin-pack` from its capabilities, so every pack it stores is
self-contained.

### 8.4 Why lazy-fetch sends no filter

A lazy-fetch requests an **exact** object by oid. Re-applying the repo's
filter would be wrong: `want <blob-oid>` + `filter blob:none` omits the very
blob requested. So lazy-fetch sends `want <oid>` with no `filter` and no
`have`.

Consequence for `tree:<depth>` clones: lazy-fetching a tree returns that tree
**and its full sub-tree/blob closure** (the server walks into the wanted
tree). This is a correct super-set — the repository stays valid — but it
over-fetches. For `blob:none` / `blob:limit` clones (the dominant case) there
is no over-fetch: a blob has no reachable dependents. A tighter incremental
tree fetch is deferred (ADR-080).

### 8.5 Partial-aware `fetch`

A regular `fetch` into a partial repo must re-apply the stored filter, or new
commits would arrive with full blobs and silently un-partial the repo. `fetch`
reads `remote.<name>.partialclonefilter` from config; when present it
re-validates the value through `parseObjectFilter`/`formatObjectFilter` (a
hand-corrupted config filter is rejected before it reaches the wire) and
passes the canonical spec to `fetchPack` with `promisor: true`. It also
`advertisesFilter`-checks the discovery response, so a server that has since
dropped `filter` support yields `REMOTE_FILTER_UNSUPPORTED` rather than a
rejected POST. No new `FetchOptions` field — the behaviour is derived from
config, exactly as git does it.

## 9. `clone --filter` flow

`clone` with `opts.filter` set runs, in order:

1. `parseObjectFilter(opts.filter)` → canonical spec. A bad spec throws
   `INVALID_FILTER_SPEC` **before** any network I/O.
2. `discoverRefs` (unchanged).
3. `advertisesFilter(advertisement.capabilities)` — false ⇒
   `REMOTE_FILTER_UNSUPPORTED`, before the pack POST.
4. `fetchPack({ …, filter: canonicalSpec, promisor: true })`.
5. ref propagation + HEAD (unchanged).
6. persist the promisor config block (§7.3).

A non-filtered `clone` skips steps 1, 3, 6 and passes no `filter` /
`promisor` — byte-identical to today's behaviour.

## 10. Repository facade

- `Repository` gains `readonly fetchMissing: BindCtx<typeof commands.fetchMissing>`.
- `CloneOptions` gains `readonly filter?: string`.
- `openRepository` binds `fetchMissing` and wires `ctx.promisor`. The promisor
  implementation closes over the `Context`; because `Context` is frozen and
  must itself contain `promisor`, the closure captures the `ctx` binding via a
  late-assigned `let` — the closure is only ever invoked after `openRepository`
  returns, so the binding is always populated by call time.

## 11. File layout

New:

```
src/domain/protocol/object-filter.ts          filter ADT + parse/format
src/ports/promisor.ts                          PromisorRemote port
src/application/commands/fetch-missing.ts       fetchMissing command + port impl
```

Modified:

```
src/domain/protocol/error.ts                   INVALID_FILTER_SPEC, REMOTE_FILTER_UNSUPPORTED
src/domain/protocol/upload-pack.ts              WantHaveRequest.filter, filter line
src/domain/protocol/capabilities.ts             'filter' in CLIENT_CAPABILITIES_FETCH
src/domain/protocol/index.ts                    barrel
src/domain/commands/error.ts                    NO_PROMISOR_REMOTE
src/application/primitives/fetch-pack.ts         filter + promisor inputs
src/application/primitives/config-read.ts        extensions + promisor keys
src/application/primitives/update-config.ts      generalised section writer
src/application/primitives/pack-registry.ts      refresh()
src/application/primitives/read-object.ts        lazy-fetch retry wrapper
src/application/primitives/index.ts              barrel
src/application/commands/clone.ts                CloneOptions.filter
src/application/commands/fetch.ts                partial-aware (stored filter)
src/application/commands/index.ts                barrel
src/application/commands/internal/upload-pack-client.ts   advertisesFilter
src/ports/context.ts                             Context.promisor
src/ports/index.ts                               barrel
src/repository.ts                                fetchMissing + promisor wiring
```

## 12. Testing strategy

### 12.1 Unit (100 % line/branch/function/statement)

- `object-filter.test.ts` — parse every valid spec (`blob:none`,
  `blob:limit=0|100|1k|2m|3g`, `tree:0|5`), every rejection
  (`blob:limit=` / `blob:limit=-1` / `blob:limit=1x` / `tree:-1` /
  `tree:1.5` / `unknown:x` / empty), format round-trips. Error assertions
  check `.data.code` **and** `.data.reason`.
- `upload-pack` — `buildUploadPackRequest` emits the `filter` line in the
  correct position; omits it when `filter` unset; filter coexists with
  `deepen` and `have` lines.
- `capabilities` — `filter` survives negotiation iff advertised.
- `fetch-pack` — `filter` reaches the request body; `.promisor` sentinel
  written iff `promisor` set; not written on the empty-pack path.
- `config-read` — `[extensions]` + promisor keys parsed; case-insensitivity.
- `update-config` — `setConfigEntry` for new section, existing section,
  existing key, subsection match (case-sensitive) vs section (case-insensitive);
  control-char rejection in key/value/subsection.
- `pack-registry` — `refresh()` re-scans and surfaces a pack added after the
  first `lookup`.
- `read-object` — lazy-fetch fires on miss with a promisor; retry succeeds
  after the registry refresh; in-flight de-dup (two concurrent reads → one
  `promisor.fetch`); no promisor ⇒ original `OBJECT_NOT_FOUND`; still-missing
  after retry ⇒ `OBJECT_NOT_FOUND`. Uses a fake `PromisorRemote`.
- `fetch-missing` — no promisor ⇒ `NO_PROMISOR_REMOTE`; no remote URL ⇒
  `REMOTE_NOT_CONFIGURED`; already-local oids filtered out (no network);
  empty oid list ⇒ no-op; `FILE_EXISTS` tolerated.
- `clone` — `filter` validated before discovery; `REMOTE_FILTER_UNSUPPORTED`
  when the server lacks the capability; config block written correctly.

Memory adapter + `MemoryHttpTransport` drive the protocol-level tests; the
fake `PromisorRemote` drives `read-object` in isolation.

### 12.2 Integration (`test/integration/network/`)

`partial-clone-http-backend.test.ts`, against a real `git-http-backend` CGI
(reusing `test/bench/support/http-backend-server.ts`). The served repo is a
**copy** of the `clone-source` fixture configured with
`uploadpack.allowfilter=true` and `uploadpack.allowanysha1inwant=true` (set on
the copy in `beforeAll` — the committed fixture is never mutated).

- `clone({ url, filter: 'blob:none' })` ⇒ commits + trees present, blobs
  absent; `.git/config` has the promisor block; a `.promisor` file exists.
- Reading a blob (`repo.primitives.readBlob`) triggers lazy-fetch and returns
  the correct content; a second read is served locally (no second request).
- `repo.fetchMissing([blobOid, …])` pulls a batch in one fetch.
- The lazy-filled repo `git fsck`s clean under canonical git (interop).

### 12.3 Mutation

`stryker run` over the new/changed files; every killable mutant killed.
Equivalent mutants documented inline with `// equivalent-mutant:`.

## 13. Key design decisions

| # | Decision | ADR |
|---|----------|-----|
| 1 | Filter scope = `blob:none` + `blob:limit` + `tree:depth` | ADR-078 |
| 2 | Lazy-fetch = automatic in `readObject` + explicit `fetchMissing` batch API | ADR-079 |
| 3 | Lazy-fetch sends no filter; `tree:` clones over-fetch on tree reads | ADR-080 |
| 4 | Lazy-fetch wired via a `PromisorRemote` port on `Context` | ADR-081 |
| 5 | Generalise the `[core]`-only config writer to any `[section]` | ADR-082 |

## 14. Risks

- **Server support.** Lazy-fetch needs the promisor remote to allow
  `want`-ing non-advertised oids (`uploadpack.allowanysha1inwant`). A server
  that refuses surfaces `HTTP_ERROR` / a protocol error from `fetchPack` — no
  silent corruption. Documented; the integration fixture enables it.
- **Concurrent pack writes.** Two parallel lazy-fetches of the same object
  would write the same `pack-<sha>`. The in-flight map de-dupes within a
  `Context`; cross-`Context` collisions are absorbed by the `FILE_EXISTS`
  tolerance (the SHA-named pack is content-identical).
- **`tree:depth` over-fetch.** Accepted and documented (ADR-080); does not
  affect correctness, only transfer volume, and only for `tree:` clones.
</content>
</invoke>
