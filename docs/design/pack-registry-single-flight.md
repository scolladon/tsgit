# Design — pack-registry single-flight (no orphaned FileHandles)

> Brief: a concurrent burst of first reads makes `createPackRegistry` scan the pack
> directory N times and keep only the last `RegisteredPack` set; every superseded set's
> lazily-opened `FileHandle` becomes unreachable and is closed by the garbage collector —
> a hard process-killing error on Node 26. Single-flight the registry's two lazy
> initializers so no handle is ever orphaned.
> Status: draft → self-reviewed ×3 → awaiting ADR decisions

## Context

### The defect

Consumer report — sfdx-git-delta PR #1367 CI, `macos × node 26`: the process dies mid-run with

```
ERR: A FileHandle object was closed during garbage collection
```

on a file descriptor of `.git/objects/pack/*.pack`, **despite the consumer awaiting
`repo.dispose()` in a `finally`**. Node ≤ 24 emits the same condition as a `DEP0137`
deprecation warning; Node 26 promotes it to a hard error. Because it fires on a GC
sweep, it is nondeterministic — the same job passes and fails across runs.

Root cause (verified against the published 3.2.0 CJS dist with an instrumented repro;
inherited from the brief, **not re-derived here**):

| Workload | Pack-dir scans | Handles still open after `dispose()` |
|---|---|---|
| 200 **concurrent** `readBlob` | 199 | 198 |
| 200 **sequential** `readBlob` | 1 | 0 |

`createPackRegistry.loadAll` (`src/application/primitives/pack-registry.ts:201-216`)
memoises the **result**, and the assignment lands *after* two awaits:

```ts
let cache: ReadonlyArray<RegisteredPack> | undefined;       // :199

async function loadAll(): Promise<ReadonlyArray<RegisteredPack>> {
  if (cache !== undefined) return cache;                    // :202  ← every concurrent
  const dir = packsDir(commonGitDir(ctx));                  //         first caller passes
  if (!(await ctx.fs.exists(dir))) { cache = []; return cache; }
  const entries = await ctx.fs.readdir(dir);                // :208  ← N-th duplicate scan
  const packs: RegisteredPack[] = [];
  for (const entry of entries) {
    if (!isCandidate(entry)) continue;
    packs.push(await loadPack(ctx, dir, entry.name));       // :212  ← N-th RegisteredPack set
  }
  cache = packs;                                            // :214  ← last writer wins
  return cache;
}
```

Between `:202` and `:214` there is **no synchronous marker** that a scan is in flight, so
K concurrent first callers each build their own `RegisteredPack` set. Each caller then reads
through *its own* set, and `readSlice` (`:122-154`) lazily opens a persistent handle
(`ctx.fs.openWithNoFollow`, `:125`) on that set's pack. `refresh()` (`:220-228`) and
`dispose()` (`:239-250`) both close only the packs reachable from `cache` — the single
winner. The K−1 superseded sets are unreachable from any tsgit code path, so **only the GC
can ever close their handles**. That is exactly the condition Node 26 refuses.

A second, latent defect falls out of the same shape: `cache = packs` at `:214` runs
unconditionally, so a `refresh()` issued *during* an in-flight scan is silently undone — the
completing scan re-populates the memo from the **pre-refresh** directory listing. The
lazy-fetch retry path (`read-object.ts:119` `registry.refresh()` after a promisor fetch
writes a new pack) is precisely a refresh racing concurrent reads.

`offsetTable` (`:93-108`) has the identical result-memo-after-await shape. It owns no
disposable, and concurrent builders converge on equal values, so it leaks nothing — but each
duplicate builder pays a `stat` plus a full `O(n log n)` sort of every entry offset in the
pack, on the hot read path.

**One registry per `Context`.** Single-flight only helps because concurrent readers of one
repository share one registry instance: `read-object.ts:15-30` memoises it in a
`WeakMap<Context, PackRegistry>`, and every `readObject` / `readRawObject` goes through it.
So a `Promise.all` burst of `readBlob` on one open repository is K concurrent callers of *one*
`loadAll` — the exact shape of the report. (`fetch-missing.ts:65` builds its own short-lived
registry; see the last section.)

### Constraining prior decisions

- **ADR-510** (persistent per-pack `FileHandle`s owned by the pack registry) — the registry
  owns one lazily-opened handle per pack, "closed by `dispose()`"; fd lifetime is bounded by
  repo lifetime. This change does not revisit that decision; it repairs the one path where
  the ownership claim is false.
- **ADR-050** (cache-invalidation policy) — a cache whose entry can go stale gets
  event-driven invalidation; a cache whose value is provably stable never invalidates. The
  pack scan is the event-driven kind (`refresh()` is its event).
- **ADR-042** (canonical-root lazy realpath) — the adapter-side precedent for a promise-memo
  that clears itself on rejection.
- **ADR-359 / 360** (exact-slice pack reads via next-offset) — `offsetTable`'s consumers;
  unchanged here.
- **CLAUDE.md — structured output / git-faithfulness** — neither is engaged; see §8.

### House patterns this must follow

`src/adapters/node/node-file-system.ts:510-528` — promise-memo, clear-on-reject:

```ts
private async loadRootSet(): Promise<RootSet> {
  if (this.rootSetPromise === undefined) {
    this.rootSetPromise = this.canonicalizeRoots()
      .then(…)
      .catch((err: unknown) => { this.rootSetPromise = undefined; …; throw err; });
  }
  return this.rootSetPromise;
}
```

`src/application/primitives/internal/read-commit-graph.ts:179-189` — same shape, with the
rationale already written down: *"Never memoize a rejection: a transient fs failure must not
permanently poison every later commit walk for this repository."*

`src/adapters/snapshot-resolvers/single-flight-index-resolver.ts:21-38` — the named
single-flight idiom: install the in-flight promise, clear the slot when it settles.

Neither house site carries an **identity guard** on the clear (they write
`this.rootSetPromise = undefined` / `graphCache.delete(ctx)` unconditionally). For them the
worst case is one redundant re-resolve. For the pack registry it is a leak — see §3.

### Audit — every lazy initializer in `src/` that crosses an `await`

| Site | Shape | Owns a disposable? | Verdict |
|---|---|---|---|
| `pack-registry.ts:199-216` `loadAll` | **result-memo** | **yes** — per-pack `FileHandle` | **in scope (§2)** |
| `pack-registry.ts:93-108` `offsetTable` | **result-memo** | no | **in scope (§4)** |
| `pack-registry.ts:114-125` `handlePromise` | promise-memo | yes | already correct |
| `read-object.ts:77-92` `lazyFetchOnce` | promise-memo (`Map`) | no | already correct |
| `node-file-system.ts:422,510` `rootSetPromise` | promise-memo | no | already correct |
| `read-commit-graph.ts:179-189` `graphCache` | promise-memo (`WeakMap`) | no | already correct |
| `config-read.ts:115` / `config-scoped-read.ts:15` | promise-memo (`WeakMap`) | no | already correct |
| `single-flight-index-resolver.ts:21-38` | promise-memo | no | already correct |
| `git-service-session.ts:179` `this.channel ??=` | promise-memo | **yes** — ssh channel | already correct |
| `apply-changeset.ts:266` · `diff-trees.ts:259` · `materialise-patch-files.ts:346` · `build-content-merger.ts:48` `providerPromise ??=` | promise-memo | no | already correct |
| `internal/bounded-reader.ts:23` `promises` | promise-memo (`Map`) | no | already correct |
| `repository.ts:465` `disposePromise` | promise-memo | n/a | already correct |
| `snapshot/tree-snapshot.ts:39` `cached: Tree` | result-memo | no | pure value cache — **do not touch** |
| `snapshot/index-snapshot.ts:51` `captured: GitIndex` | result-memo | no | pure value cache, documented first-resolve-wins — **do not touch** |
| `ref-store.ts:50` `packedCache` | result-memo + `mtime` key | no | pure value cache — **do not touch** |

The three result-memos left alone can duplicate work under a concurrent cold start, but they
memoise an immutable parsed value and hold nothing that must be released. Converting them is
out of scope (see the last section).

## Requirements

Verifiable at ship time. "Cold" = the memo has never been populated. K ≥ 2.

1. K concurrent first `all()` / `lookup()` calls perform **exactly one** pack-directory scan
   — one `exists`, one `readdir`, and one `stat` + `read` per `.idx` — and every caller
   receives the **same** `RegisteredPack` instances.
2. After `await registry.dispose()`, the count of handles opened through
   `ctx.fs.openWithNoFollow` that have not been `close()`d is **zero**, for every row of the
   lifecycle matrix in §5.
3. `refresh()` during an in-flight first scan clears the memo, closes that scan's packs when
   it settles, and the completing scan **never re-populates** the memo (fixes the
   stale-cache defect described above).
4. `dispose()` during an in-flight first scan resolves only after that scan's packs have been
   closed.
5. A rejected scan clears the memo and the next `all()` re-scans; the rejection reaches
   exactly the callers that joined that scan; a memo installed after an intervening
   `refresh()` is **never** cleared by an earlier scan's rejection.
6. K concurrent first `offsetTable()` calls on one pack perform exactly one `stat` and one
   offset sort, and all callers receive the same `PackOffsetTable` instance. A rejected build
   clears the memo so the next call retries — today's semantics, preserved.
7. Unchanged behaviour, each covered by an existing test: retired-pack per-call fallback;
   `UNSUPPORTED_OPERATION` browser fallback and its reset-and-retry; `refresh()` closes
   outgoing packs; `dispose()` rethrows the first close rejection; `dispose()` without a
   prior scan touches no `fs`; `isSafePackName` filtering; both `MAX_PACK_IDX_BYTES` guards;
   `close()` idempotence and its `inFlight` drain.
8. No git-observable behaviour changes — no new or altered object ids, refs, reflogs,
   on-disk state files, refusals, or structured result fields (§8).
9. The reported Node 26 workload (concurrent `readBlob` burst followed by an awaited
   `repo.dispose()`) completes without the `FileHandle` GC error. Node 26 is not available in
   this environment, so this is discharged **by proxy**: the error fires only when an *open*
   handle becomes garbage, and after this change every open handle stays reachable from the
   registry's memo until `close()` runs (requirements 1 + 2), so no open handle can be
   collected.

**Boundary of requirement 9.** That reachability argument holds while the registry itself is
reachable. A consumer that drops a live `Repository` **without** calling `dispose()` still
hands its open handles to the GC — inherent to ADR-510's persistent-handle decision, not
something single-flight can address, and unchanged by this design. The reported crash is not
that case (the consumer awaits `dispose()` in a `finally`); the mitigation for it is
`Symbol.asyncDispose`, already recorded as deferred in `docs/design/repository-facade.md:604`.

## Design

### §1 — Pinned async semantics

The design rests on six facts about promise scheduling rather than on any external tool's
behaviour. Pinned empirically with a standalone script (Node v22.22.3, pure JS, no repository
state touched); the semantics are specified by ECMAScript and do not vary by Node major.

| # | Claim | Observed |
|---|---|---|
| P1 | Under a **result-memo**, 3 concurrent first callers each run the initializer | `scans = 3`; the memo holds one set; **2 superseded sets** exist, referenced by their own callers only |
| P2 | Under a **promise-memo**, the memo slot is populated **synchronously** with the first call — before any `await` | `cache === p` immediately after `loadAll()` returns, `scans = 1`, all 3 callers share one set |
| P3 | Clear-on-reject **without** an identity guard clobbers a successor memo installed after an intervening `refresh()` | successor survived: **false** |
| P4 | Clear-on-reject **with** `if (cache === pending)` preserves the successor | successor survived: **true** |
| P5 | A `const pending = f().catch(cb)` whose `cb` references `pending` is initialised by the time `cb` runs (no TDZ) | **true** |
| P6 | A second caller joining a rejected memo sees the same rejection, one handler suffices to avoid an unhandled rejection, and the memo is cleared afterwards | **true** / **true** / **true** |

**P2 is the whole fix.** The bug is not "the cache is wrong"; it is that under a result-memo
there exists a window with *no* synchronous evidence that initialization is under way — so
neither a second caller, nor `refresh()`, nor `dispose()` can observe or join it. A
promise-memo makes the in-flight state a first-class, synchronously-readable value.

**P3/P4 are load-bearing and diverge from the house pattern.** With `refresh()` able to null
the slot mid-flight, an unguarded clear-on-reject can erase a *successor* memo — and that
successor's packs are then unreachable from `refresh()`/`dispose()`, reproducing the exact
leak in a narrower window. The identity guard is mandatory here even though ADR-042's and
`read-commit-graph`'s memos omit it.

### §2 — `loadAll` becomes single-flight

```ts
export function createPackRegistry(ctx: Context): PackRegistry {
  let cache: Promise<ReadonlyArray<RegisteredPack>> | undefined;

  const scanPacks = async (): Promise<ReadonlyArray<RegisteredPack>> => {
    const dir = packsDir(commonGitDir(ctx));
    if (!(await ctx.fs.exists(dir))) return [];
    const entries = await ctx.fs.readdir(dir);
    const packs: RegisteredPack[] = [];
    for (const entry of entries) {
      if (!isCandidate(entry)) continue;
      packs.push(await loadPack(ctx, dir, entry.name));
    }
    return packs;
  };

  const loadAll = (): Promise<ReadonlyArray<RegisteredPack>> => {
    if (cache !== undefined) return cache;
    const pending: Promise<ReadonlyArray<RegisteredPack>> = scanPacks().catch(
      (err: unknown) => {
        if (cache === pending) cache = undefined;
        throw err;
      },
    );
    cache = pending;
    return pending;
  };
  …
}
```

Three properties, each load-bearing:

- `scanPacks` no longer writes `cache`. The **only** writers are `loadAll` (install) and
  `refresh`/the reject-handler (clear). This is what makes requirement 3 hold: a scan that
  completes after a `refresh()` has nothing to re-populate.
- `loadAll` is a plain function, not `async`. Both would run the install synchronously, but
  the plain form makes it structurally impossible to introduce an `await` above the
  assignment later — the defect being fixed.
- The empty-directory arm returns `[]` instead of assigning it. `all()` still resolves to
  `[]`, and the memo now holds a resolved promise of `[]`, so a later `dispose()` sees a
  populated memo and closes an empty set — a no-op, matching today.

`readSlice` (`:122-154`) and `close` (`:156-166`) are **not modified** — including the
anchored equivalent-mutant proof comment at `:141-151`, which must survive the change
byte-for-byte or its Stryker location shifts and the proof stops applying.

**A pack that never escapes the scan can never have opened a handle.** `openWithNoFollow` is
reachable only from `readSlice` (`:125`), which is reachable only through the array
`scanPacks` returns. `loadPack` itself performs `stat` + `read` + `parsePackIndex` and opens
nothing. So when the scan rejects mid-loop, the partially-built array is discarded with zero
handles outstanding — which is why clearing the memo on rejection needs no partial cleanup.

### §3 — `refresh()` and `dispose()` capture the pending promise

Both must read the memo as *"the scan, in whatever state"* rather than *"the packs, if
already loaded"*.

```ts
refresh(): void {
  if (disposed) return;                           // candidate #4
  const outgoing = cache;
  cache = undefined;
  if (outgoing === undefined) return;
  trackClose(
    outgoing.then(
      (packs) => Promise.allSettled(packs.map((pack) => pack.close())),
      // A rejected scan produced no packs and therefore no handles. The error is
      // not discarded: it is delivered to the loadAll() caller that triggered the
      // scan (P6) — this arm only declines to close a set that does not exist.
      () => [],
    ),
  );
},

async dispose(): Promise<void> {
  disposed = true;                                // candidate #4
  const pending = cache;
  if (pending === undefined) return drainPendingCloses();
  const packs = await pending.catch(() => NO_PACKS);   // same rationale as above
  const results = await Promise.allSettled(packs.map((pack) => pack.close()));
  await drainPendingCloses();
  const failure = results.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (failure !== undefined) throw failure.reason;
},
```

`disposed` is set **before** the first `await`, so a `refresh()` interleaved anywhere inside
`dispose()` is already gated. `all: loadAll` and `lookup` keep their current bindings in the
returned object literal.

`refresh()` stays synchronous — it is `refresh(): void` on the public `PackRegistry`
interface and is called from a synchronous context (`read-object.ts:40`,
`read-object.ts:119`). Its close work stays fire-and-forget, exactly as today; the only
change is that the work is now chained onto a promise instead of an array.

Neither swallows an error. Each rejection has exactly one owner — the `all()` / `lookup()`
caller that triggered the scan — and both handlers exist solely to keep a second, ownerless
subscription from becoming an unhandled rejection. A scan rejection surfacing out of
`dispose()` would be actively harmful: `repository.dispose()` (`repository.ts:466-491`) runs
in consumers' `finally` blocks, where it would mask the original failure.

`drainPendingCloses` is candidate **#3**; under the do-nothing alternative both calls
disappear and `dispose()` returns to a bare `if (pending === undefined) return;`.

`trackClose` must only ever be handed a promise that cannot reject (`Promise.allSettled`
never does), or its bookkeeping `.finally` becomes an unhandled rejection of its own. The
drain takes a snapshot (`[...pendingCloses]`) — a close registered *during* the drain is not
awaited, which is unreachable because the only `trackClose` caller is `refresh()`, gated
`disposed` under candidate #4.

### §4 — `offsetTable` becomes single-flight

```ts
let tablePromise: Promise<PackOffsetTable> | undefined;

const buildOffsetTable = async (): Promise<PackOffsetTable> => {
  const stat = await ctx.fs.stat(packPath);
  const packFileSize = stat.size;
  const sortedOffsets = [...entryOffsets(index)].sort((a, b) => a - b);
  const trailerStart = packFileSize - ctx.hashConfig.digestLength;
  if (trailerStart < 0) throw invalidPackIndex('pack file too small to contain a trailer');
  return { sortedOffsets, packFileSize, trailerStart };
};

const offsetTable = (): Promise<PackOffsetTable> => { /* same install/clear as loadAll */ };
```

Behaviour deltas, both intended:

- Concurrent cold callers now receive the **same** `PackOffsetTable` object rather than
  distinct objects with equal fields. Nothing keys off its identity: `nextOffsetForEntry`
  is pure over its fields, and `ctx.deltaCache` is keyed by `ObjectId`
  (`object-resolver.ts:60,346,426,436`), never by pack or table identity.
- A rejected build clears the memo, so the next call re-`stat`s — identical to today's
  `cachedTable` staying `undefined` after a throw. The alternative (memoising the rejection)
  would be a behaviour change; see candidate **#2**.

No identity guard is strictly required here — nothing but the arrow itself writes
`tablePromise`, so a clear can never run after a successor install. Under candidate **#1(a)**
the guard exists once inside the shared helper, where the helper's own
clear-then-reinstall-then-reject test kills it. Under **#1(b)** an inline guard here would be
provably-never-false and therefore an unkillable equivalent mutant; see the mutation note in
the test strategy for how that is discharged.

### §5 — Lifecycle interleaving matrix

`P` = the in-flight scan promise. Note the ordering constraint that shapes several rows: a
caller cannot `readSlice` until the scan it joined has settled, so a `refresh()`/`dispose()`
that lands **during** the scan always precedes any handle open. Their job in that window is
not to close a handle but to `retire` the incoming packs so no handle is ever opened on a set
nobody owns — which is what makes rows L3–L5 observable as `opens() === 0`.

| # | Interleaving | Required outcome |
|---|---|---|
| L1 | K concurrent `all()` / `lookup()` on a cold registry | 1 scan; every caller gets the same set (R1) |
| L2 | `all()` → `all()` (second after the first settles) | 0 additional scans; same set |
| L3 | scan pending, then `refresh()` | memo cleared synchronously; `P`'s packs are `close()`d (hence retired) when `P` settles; the original callers still receive `P`'s set, whose `readSlice` then takes the per-call fallback and opens nothing; the next `all()` re-scans |
| L4 | scan pending, then `dispose()` | `dispose()` awaits `P`, closes/retires its packs, and resolves only **after** `P` settled (R4); a later `readSlice` by `P`'s caller opens nothing |
| L5 | scan pending, then `dispose()`, then `P` rejects | `dispose()` resolves **without throwing** and attempts no `close()`; the rejection surfaces only to `P`'s `all()` callers |
| L6 | `P` rejects | memo cleared; next `all()` re-scans (R5) |
| L7 | `P1` pending → `refresh()` → `all()` installs `P2` → `P1` rejects | `P2` survives (identity guard, P3/P4); `P1`'s rejection reaches `P1`'s callers only |
| L8 | `refresh()` then `dispose()` | `dispose()` resolves only after the refresh-initiated closes settle — **candidate #3** |
| L9 | `dispose()` twice | idempotent; the second pass's `close()` calls are no-ops (`retired` + `handlePromise === undefined`, `:157-159`) |
| L10 | `refresh()` and `dispose()` closing the same pack concurrently | idempotent as L9; the loser observes `handlePromise === undefined` and returns |
| L11 | `dispose()` → `refresh()` → `all()` | **candidate #4**: either `refresh()` is a no-op after disposal, or a fresh scan opens handles nothing will close |
| L12 | `readSlice` in flight when its pack is closed by `refresh`/`dispose` | unchanged: `close()` drains `inFlight` (`:163`); a read arriving after close takes the per-call fallback |
| L13 | `dispose()` on a registry that never scanned | resolves without touching `fs` (existing test) |
| L14 | `refresh()` twice while one scan is pending | the second sees an already-cleared memo and returns; `P`'s packs are closed exactly once |

### §6 — Error semantics

No new error codes. Every existing throw keeps its code, reason, and call site:

- `INVALID_PACK_INDEX` / `REASON_PACK_IDX_EXCEEDS_MAX` (both the pre-`read` `stat` guard and
  the post-`read` TOCTOU guard) — unchanged, now surfaced through the shared memo, so K
  concurrent first callers all receive the *same* error instance instead of K equal ones.
  No consumer compares error identity.
- `INVALID_PACK_INDEX` / `'pack file too small to contain a trailer'` — unchanged.
- `UNSUPPORTED_OPERATION` from `openWithNoFollow` — untouched; handled inside `readSlice`,
  below both memos.
- `dispose()` still rethrows the **first** rejected `close()` reason after settling all of
  them.

One deliberate asymmetry: a scan rejection propagates to `all()` / `lookup()` callers but is
absorbed by `refresh()` and `dispose()`. Rationale in §3 — the error has an owner; a second
subscriber re-raising it would produce a duplicate, wrongly attributed failure.

### §7 — Performance

The change is a strict reduction in duplicated work; it adds one promise allocation per cold
initialization and one identity comparison per rejection.

| Path | Today, K concurrent cold callers | After |
|---|---|---|
| Pack scan | K × (`exists` + `readdir` + per-`.idx` `stat` + full `.idx` `read` + `parsePackIndex`) | 1 × |
| Peak `.idx` bytes resident | K × idx size (each bounded by `MAX_PACK_IDX_BYTES` = 64 MiB **individually**, so K legitimate concurrent scans can allocate K × 64 MiB) | 1 × |
| `offsetTable` | K × (`stat` + `entryOffsets` copy + `O(n log n)` sort over every pack entry) | 1 × |
| Open fds after `dispose()` | up to K − 1 per pack, closed only by GC | 0 |

No benchmark is added: `test/bench` scenarios drive sequential workloads, where both memos
already hit on the second call, so the harness would report no delta. A concurrency
benchmark is a separate piece of work (see the last section).

### §8 — Git-faithfulness

**Untouched.** This is pure lifecycle correctness inside a caching layer. The change alters
no object id, ref, reflog, on-disk state file (`sequencer/`, `MERGE_HEAD`, …), refusal
condition, or structured result field — the surfaces ADR-226 binds. ADR-249 is not engaged
either: nothing rendered, nothing formatted.

No public shape moves. Verified: `pack-registry.ts` is re-exported from neither
`src/application/primitives/index.ts` nor `src/index.ts`, and `PackRegistry`,
`RegisteredPack` and `PackOffsetTable` appear **zero** times in `reports/api.json`. Under
candidate #1(a) the new helper lands in `primitives/internal/`, which is likewise unexported.
So no `reports/api.json` regeneration is owed and the pre-push `check:doc-typedoc` gate is
unaffected — the one surface gate that most often ambushes a change in this repo.

Per `.claude/workflow/faithfulness.md`, no behaviour of canonical `git` is described or
relied upon here, so **no empirical git pinning is required and no new interop test is
added**. The pinned matrix that *is* required — the async-semantics matrix — is §1. The
existing interop suite serves as the regression net: it must stay green, proving the memo
rewrite did not perturb pack reads.

The only observable deltas are: fewer syscalls; earlier fd release; and shared object
identity for `RegisteredPack` / `PackOffsetTable` across concurrent callers (§4 shows
nothing keys off it).

### §9 — The invariant

> **Any lazy initializer that crosses an `await` must memoise the promise, not the result.
> If the initialization owns a disposable, `dispose`/`refresh` must capture and await the
> pending promise before releasing it.**

Corollary, forced by P3/P4: **if the memo slot can be cleared by anything other than the
initializer itself, clear-on-reject must be identity-guarded.**

Where this is written down and whether it is mechanically enforced is candidate **#5**.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Memo mechanism** | **(a) Shared internal helper** — new `src/application/primitives/internal/promise-memo.ts` exposing `createPromiseMemo<T>(factory)` → `{ get, peek, clear }`; both sites consume it. **(b) Two inline promise-memos** in `pack-registry.ts`, no new module. **(c) A `LazyResource<T>` class** owning both the memo and the disposal protocol | **(a)** | The invariant in §9 is a *rule*, and a rule with one named implementation is testable once and reusable by the next site; `internal/` already holds exactly this kind of ~30-line building block (`bounded-map`, `bounded-reader`, `concurrency-limiter`). `peek`/`clear` are the two operations `refresh`/`dispose` need and are awkward to name inline. (b) duplicates the identity-guard subtlety twice in one file and gives candidate #5 nothing to point at. (c) over-fits: only one of the two sites owns a disposable, and a class contradicts the file's FP-first closure style |
| 2 | **Rejection policy** | **(a) Clear on reject, identity-guarded, at both sites** — a failed init is retried by the next caller. **(b) Clear at `loadAll` only**; keep `offsetTable`'s rejection memoised. **(c) Memoise rejections at both sites** — one failure is permanent for the registry's life | **(a)** | (a) preserves today's semantics exactly at both sites (`cache`/`cachedTable` both stay `undefined` after a throw) and matches the house rule already written at `read-commit-graph.ts:184` — *"Never memoize a rejection: a transient fs failure must not permanently poison every later commit walk"*. (b) makes two memos in one file disagree for no reason. (c) is a real behaviour change: a transient `EMFILE`/`ENOENT` during one scan would wedge the registry until the `Context` is discarded |
| 3 | **`refresh()`'s fire-and-forget close batch** | **(a) Track it** — `refresh()` registers its `allSettled` in a pending-closes set that `dispose()` drains. **(b) Leave it untracked** (today's behaviour) and scope requirement 2 to sequences without a preceding `refresh()`. **(c) Make `refresh()` async** and let callers await it | **(a)** | Requirement 2 is the acceptance criterion the consumer will assert against, and under (b) a `refresh()`-then-`dispose()` sequence — which the lazy-fetch retry path (`read-object.ts:119`) produces — can return from `dispose()` with an fd still closing, making any leak assertion flaky. These handles are *reachable* (the close chain holds them), so this is not the GC crash; it is the difference between "no leak" and "no leak, provably, at the moment `dispose()` resolves". (c) is a breaking change to a public `void` method and pushes the burden onto every caller |
| 4 | **Post-`dispose()` lifecycle** | **(a) `dispose()` sets a terminal flag; `refresh()` becomes a no-op after it** (`all()` keeps returning the closed, retired set as today). **(b) Leave as-is** — a post-`dispose()` `refresh()` re-arms the registry and the next `all()` opens handles nothing will close. **(c) `dispose()` also clears the memo**, so the next `all()` re-scans | **(a)** | (b) is a live, if narrow, re-introduction of the very leak this change fixes: `createPackRegistry` is also used standalone (`fetch-missing.ts:65`), outside the `repository.dispose()` state machine that would otherwise refuse later operations. (a) costs one boolean and one guard and makes "disposed" mean disposed. (c) is strictly worse than (b): it *guarantees* the next read opens unowned handles rather than merely permitting it |
| 5 | **Codifying the §9 invariant** | **(a) ADR only**, plus a doc-comment on the helper. **(b) ADR + a new `tooling/audit-lazy-memos.ts` scanner** wired as `check:lazy-memos`, flagging a `let x: T \| undefined` memo assigned after an `await` inside a closure that also creates a disposable, with an allowlist. **(c) ADR + a bullet in CLAUDE.md's Domain Invariants** | **(a)** | The audit table found exactly two offending sites in ~32k nodes and both are fixed here, so a permanent gate would be almost pure allowlist maintenance; the repo's existing scanners (`audit-write-surfaces`, `audit-browser-surface`) each guard a surface with continuous churn, which this is not. (b) is also the hardest of the three to make precise — "owns a disposable" is not syntactically decidable, so it would either miss the resource-owning case or drown in false positives on pure value caches. (c) risks CLAUDE.md drift for a rule with a single call site; the helper's doc-comment sits closer to the code |
| 6 | **Test seam and tier for the leak proof** | **(a) Unit only** — a shared `ctx.fs` wrapper ledger counting `openWithNoFollow` / handle `close()` plus a gated `readdir`, over the memory adapter. **(b) (a) + a new scenario in `test/integration/dispose-free-exit.test.ts`** that runs a *concurrent* read burst in the child process and asserts `ACTIVE_HANDLES_DELTA=0` against real Node fds. **(c) (a) + a Node-adapter integration test counting fds via `lsof` / `process.report`** | **(b)** | (a) alone proves the memo logic but not the thing the consumer reported: the existing `dispose-free-exit.test.ts` already asserts `ACTIVE_HANDLES_DELTA=0` for a **sequential** diff and passes today — i.e. the current suite's closest analogue is blind to this bug, and the one-line delta between it and a burst is exactly the regression. Cost is real (that file's `beforeAll` runs `npm run build`, 120 s budget) but it is paid once and the scenario reuses the built entry point. (c) is `lsof`-dependent and platform-fragile where `process._getActiveHandles()` is already in use here |

## Test strategy

### Unit — `test/unit/application/primitives/pack-registry.test.ts` (extend)

Conventions per CLAUDE.md: `describe('Given …')` > `describe('When …')` > `it('Then …')`,
AAA section comments, `sut` = the thing under test (the file already uses both
`const sut = createPackRegistry(ctx)` and `const sut = pack.offsetTable`). Fixtures already
present: `buildSeededContext` (`./fixtures.js`), `writeSyntheticPack` (`./pack-fixture.js`).

**New shared helper** — `test/unit/application/primitives/handle-ledger.ts` (kebab-case per
ls-lint; a sibling of the existing `fixtures.ts` / `pack-fixture.ts`). It replaces the ledger
the current tests hand-roll five times over:

```ts
interface HandleLedger {
  readonly ctx: Context;               // ctx with a wrapped fs
  readonly opens: () => number;        // openWithNoFollow calls
  readonly closes: () => number;       // handle.close() calls
  readonly outstanding: () => number;  // opens − closes  ← requirement 2
  readonly readdirCalls: () => number;
  /** Per-call deferred queue: each readdir blocks until its own entry is settled. */
  readonly readdirGate: {
    readonly settle: (call: number, entries: ReadonlyArray<DirEntry>) => void;
    readonly fail: (call: number, error: unknown) => void;
  };
}
const withHandleLedger = (ctx: Context, opts?: { gateReaddir?: boolean }) => HandleLedger;
```

It wraps `ctx.fs.openWithNoFollow` to count and to decorate the returned `FileHandle`'s
`close`, and `ctx.fs.readdir` to count and (optionally) park on a **per-call** deferred.
Per-call, not a single gate: U7 needs two scans in flight simultaneously and must settle them
in a chosen order. **No `fs` module mocking** — the seam is the existing `FileSystem` port,
exactly as every current test in this file does.

Every assertion below is externally observable through that ledger or through a return value;
none inspects the private memo.

| Test | Given / When / Then | Kills |
|---|---|---|
| U1 | Given a cold registry over a repo with 2 packs, When K=8 `all()` calls run under `Promise.all`, Then `readdirCalls === 1` and every returned array is the same reference | the whole result-memo shape. RED today: `readdirCalls === 8`, 8 distinct arrays |
| U2 | …When K=8 `lookup(id)` calls run concurrently on an oid taken from `writeSyntheticPack`'s returned ids, Then all hits carry the identical `pack` reference and `readdirCalls === 1` | `lookup`'s join path |
| U3 | Given U1's burst, When each of the 8 callers `readSlice`s its own result and `dispose()` is awaited, Then `opens() === 2` and `outstanding() === 0` | **requirement 2 / the reported crash**. RED today: `opens() === 16` (8 sets × 2 packs), `outstanding() === 14` — only the winner's 2 are closed |
| U4 | Given a gated scan (call 0) in flight, When `refresh()` runs, call 0 is settled, the original caller then `readSlice`s, and `all()` is called again, Then `readdirCalls === 2` and `opens() === 0` — the completing scan neither re-populated the memo nor left an un-retired pack | L3 + requirement 3. RED today: `readdirCalls === 1` (the scan re-populated it) and `opens() === 1` |
| U5 | Given a gated scan (call 0) in flight, When `dispose()` is started, call 0 is then settled, and the disposal is awaited, Then an order log records `settle` before `dispose-resolved`, and a subsequent `readSlice` by the scan's caller gives `opens() === 0`, `outstanding() === 0` | L4 + requirement 4. RED today: `dispose()` resolves first having closed nothing, then `readSlice` opens a handle nothing will ever close (`outstanding() === 1`) — the leak in its narrowest form |
| U6 | Given a scan that rejects (`readdir` throws `permissionDenied`), When `all()` is awaited, Then the error's `data.code === 'PERMISSION_DENIED'` (asserted via try/catch on `.data`, not `toThrow(Class)`) and a second `all()` re-scans | L6 / clear-on-reject |
| U7 | Given gated scans, When the sequence `p1 = all()` (call 0) → `refresh()` → `p2 = all()` (call 1) → `readdirGate.fail(0, …)` → `readdirGate.settle(1, …)` runs, Then `p1` rejects, `p2` resolves, and a third `all()` performs **no** further scan (`readdirCalls === 2`) | **the identity guard** (P3/P4). Without it the third `all()` scans (`=== 3`), killing both `ConditionalExpression` mutants on `cache === pending` |
| U8 | Given a gated scan that rejects, When `dispose()` is awaited concurrently, Then it resolves without throwing and `closes() === 0` | L5 / dispose's absorb arm |
| U9 | Given a gated scan that rejects, When `refresh()` ran during it, Then the refresh-side close chain settles and no unhandled rejection fires — a one-shot `process.on('unhandledRejection')` listener installed in Arrange, removed in a `finally`, asserted not called after one macrotask turn | refresh's `() => []` arm |
| U10 | Given a pack read once then `refresh()`ed, When `dispose()` is awaited, Then `outstanding() === 0` at the moment `dispose()` resolves | L8 — **candidate #3**; omitted if #3(b) is chosen |
| U11 | Given a disposed registry whose pack was read once, When `refresh()` then `all()` then `readSlice` run, Then `readdirCalls` and `opens()` are both unchanged | L11 — **candidate #4**; omitted if #4(b) |
| U12 | Given a cold pack obtained from `all()`, with the `stat` counter reset afterwards (as the existing `offsetTable` cache test already does, `:398-442`), When K=8 `offsetTable()` calls run under `Promise.all`, Then `stat` was called once and all 8 results are the same reference | requirement 6. RED today: 8 `stat` calls, 8 distinct objects |
| U13 | Given a pack whose `stat` makes `trailerStart` negative, When `offsetTable()` rejects and is called again, Then it re-`stat`s and rejects again with reason containing `'pack file too small'` | candidate #2(a): rejections are not memoised |

Retained unchanged (requirement 7): every existing case in the file. The
`refresh()`-closes-outgoing test (`:711-750`) currently waits a macrotask
(`setTimeout(…, 0)`) for the fire-and-forget close; under candidate #3(a) it can await
`dispose()` instead, which is deterministic — a strict improvement, not a rewrite.

**New unit file** if candidate #1(a) lands:
`test/unit/application/primitives/internal/promise-memo.test.ts` — single-flight under a
burst; `peek()` on an idle memo returns `undefined`; `peek()` mid-flight returns the pending
promise; `clear()` returns the outgoing promise and leaves the memo idle; clear-on-reject;
identity-guarded clear (the `clear()`-then-reinstall-then-reject sequence).

### Integration — `test/integration/dispose-free-exit.test.ts` (extend, candidate #6b)

Add a third `mode` to the existing child script: open the repo, fire a `Promise.all` burst of
`readBlob`/`diff` calls against the packed repository, `await repo.dispose()`, and report
`ACTIVE_HANDLES_DELTA`. Then: `Given a repo whose objects are packed` >
`When a child process opens it, runs a concurrent read burst, and calls dispose()` >
`Then no active handles remain after dispose (no fd leak under concurrency)` asserting
`ACTIVE_HANDLES_DELTA=0`.

This reuses the file's whole apparatus (`npm run build` in `beforeAll`, `mkdtemp` repo,
`git gc` to force everything into a pack, the baseline-delta measurement that cancels out
`execFile`'s stdio pipes). The file's `@proves` header must gain the new scenario on its
`unique:` line so `tooling/test-pyramid/detect-integration-proof.ts` keeps passing; no new
tier entry is needed in `test-pyramid-budgets.json` because no new file is created.

### Property tests — none, deliberately

Checked against all four lenses in CLAUDE.md: there is no parse/serialize (or
compile/render) pair; no compositional matcher reducing rules to a verdict; no algebraic
grammar to be total over; no idempotence or counting invariant over a syntactic input. The
subject is promise lifecycle orchestration, and a property oracle for "exactly one scan"
would have to re-implement the memo — the tautology the rules explicitly warn against. The
lifecycle matrix in §5 is the enumerable edge space and is covered example-wise above.

### Parity / browser

No new parity fixture. The browser path is exercised by the existing
`UNSUPPORTED_OPERATION` fallback test: on OPFS, `openWithNoFollow` always throws, so no
handle is ever created and requirement 2 is vacuously true there — while requirement 1 (one
scan for K callers) still applies and is covered by U1/U2 running on the memory adapter.

### Mutation

Target 0 survivors across the changed lines. Known risk areas and their killers:

- `cache !== undefined` early return → U1 (burst) and the existing "second `all()` is cached"
  test cover both arms.
- `if (cache === pending)` identity guard → U7 is the only test that distinguishes it; both
  `ConditionalExpression → true` and `→ false` must fail without it. Per the "guard clauses
  need isolated tests" rule this gets its own case, not a rider on U6.
- `offsetTable`'s identity guard (§4). Under candidate #1(a) it does not exist at this site
  at all — it lives once in the shared helper, killed by `promise-memo.test.ts`'s
  clear-then-reinstall-then-reject case (U7's analogue). Under #1(b) an inline guard here is
  provably never false and will survive; it is then discharged as an equivalent mutant with a
  proof comment anchored on the **expression** line, never a block-level suppression. This
  asymmetry is a concrete reason to prefer #1(a).
- `dispose()`'s `pending === undefined` guard → the existing "no packs loaded ⇒ no readdir"
  test plus U5.
- `refresh()`'s `outgoing === undefined` guard → the existing refresh test plus a
  `refresh()`-on-a-cold-registry case.

`mutation-budgets.json` has no `pack-registry` entry today; if the file's score moves, the
budget is reviewed at the mutation phase rather than pre-declared here.

## Out of scope

- **The three surviving result-memos** (`tree-snapshot.ts:39`, `index-snapshot.ts:51`,
  `ref-store.ts:50`). They memoise immutable parsed values and own nothing releasable;
  `index-snapshot`'s first-resolve-wins semantics are documented and deliberate. Converting
  them would be churn with no leak to fix.
- **`fetch-missing.ts:65`'s undisposed local registry.** Verified benign: `collectMissing`
  only calls `lookup`, which never reaches `readSlice`, so no handle is ever opened. It does
  pay a second pack-directory scan outside the per-`Context` cache — a separate efficiency
  question, not a leak.
- **An idle-close timer for persistent handles.** ADR-510 anticipated one and required it be
  `unref()`'d; fd lifetime remains bounded by repo lifetime here.
- **A concurrency benchmark** (`test/bench` drives sequential workloads; measuring the K-way
  win needs a new scenario shape, and per the repo's measurement discipline any published
  number must come from the CI nightly artifact, not a local run).
- **Changing the `PackRegistry` public interface.** `refresh(): void` and
  `dispose(): Promise<void>` keep their signatures; candidate #3(c) is recorded and rejected.
- **`Symbol.asyncDispose` on `Repository`.** The mitigation for the drop-without-dispose
  boundary noted under requirement 9, already deferred by `docs/design/repository-facade.md:604`
  as a stage-3 feature with patchy runtime coverage. A separate surface decision.
- **The Node 26 upgrade itself** (engines, CI matrix). This change makes tsgit correct under
  Node 26's stricter rule; whether the repo adds a Node 26 CI leg is a separate decision.
