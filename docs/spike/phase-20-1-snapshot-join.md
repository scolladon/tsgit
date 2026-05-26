# Phase 20.1 spike — Snapshot-and-join primitive

> **Status:** SPIKE v3 — final convergence iteration. Closes review pass 2 findings.
> Next stop: ADR batch (now 12) → formal design doc.
>
> **What changed from v2 → v3:**
> - **C1:** `Snapshot<E>` arity unified across §4.2/§4.4/§7 (was inconsistent in three places).
> - **C2:** `JoinError<S>` now generic; `source: keyof S & string` preserves slot typing.
> - **H1:** Separate `innerJoin()` function — no overload, no literal-type traps.
> - **H2:** pathspec + excludes composition contract spec'd inline (AND, pathspec first).
> - **H3:** `WriteEventBus` split into `WriteEventEmitter` (writer side) + `WriteEventStream` (reader side).
> - **H4:** `StashSnapshot.untracked: TreeSnapshot | null` as property, not method.
> - **§14:** doc-links + mutation-budgets wired into `validate` (Wave 0 + ADR M).
> - Iteration-stability invariant on `IndexSnapshot`; `WorkdirStat.mtime` aligned with existing `FileStat`.
> - Test debt enumerated per wave; deprecation env var spec'd; PR-split fallback added.
> - ADR queue grew from 8 to 14 (added D′ semver-split, I CQS triple-split, J pathspec+excludes, K innerJoin, L deprecation env var, M harness extension).
>
> **What changed from v1 → v2:** type-system fixes on `JoinRow<S>`; domain layering
> (entry methods moved out of `domain/`); generation-tracking CQS split; WorkdirSnapshot
> carries both pathspec + ignore predicate; StashSnapshot trio; mergeHead nullable;
> migration re-sequenced by consumer; 2.0.0 semver + deprecation cycle.

## 1. Goal

Replace the existing ad-hoc walkers (`walkTree`, `walkWorkingTree`) and
close the isomorphic-git "unified walk" parity gap with a primitive
that is **measurably better DX, measurably faster, and provably safer**
than `git.walk()`.

The primitive is the spine of every multi-source inspection in the
library: `status`, `diff`, `changes`, `unmerged`, `untracked`,
`checkout` conflict detection, `merge` 3-way comparison, `stash apply`
4-way comparison, future `rebase` / `cherry-pick` inspection.

## 2. Why not "walk"

Every legitimate use of `walk` reduces to one of two questions:

1. **"What is in this snapshot?"** — single-source enumeration.
2. **"How do N snapshots differ at each path?"** — multi-source
   join on path.

isomorphic-git collapses both into one callback walker
(`walk({ trees, map, reduce, iterate })`). That is the original sin —
a kitchen-sink primitive you can misuse any way, with no static or
dynamic guard-rails. The concrete UX failures it ships with:

| # | Failure | Cause |
|---|---|---|
| 1 | Positional null tuples — `[head, workdir, stage]` indexed by position | Walker shape is generic over N sources, no named slots |
| 2 | Hidden I/O — `entry.oid()` silently hashes a file from disk | All fields are async getters with identical shape |
| 3 | `map` / `reduce` / `iterate` triplet — three overlapping hooks | Bad separation of concerns; unclear which to override |
| 4 | Root sentinel `.` — special-case the user must remember to filter | Walker yields tree-level rows the user must reject |
| 5 | Automatic recursion — opt-out by `return null` is folklore | No declarative pruning at the source |
| 6 | No streaming, no cancellation, no backpressure | Single big promise; intermediate buffers in memory |
| 7 | No error context — throw inside `map` and which slot failed at which path? | Errors are unwrapped, source-anonymous |

The reframe: **walks are imperative traversals; what users actually
want is a relational join on paths.** A git inspection is "join these
snapshots on path"; that is a model every developer already understands.

## 3. Mental model

```
Snapshot      = immutable, lazy handle to a sorted, path-keyed set of entries
                from one source (tree | commit | index | workdir | mergeHead | …)

snapshot.entries({ paths?, recurse? })
              = AsyncIterable<Entry>  in canonical git path order

join({ a: snapA, b: snapB, … })
              = AsyncIterable<Row>    k-way merge join on path; named slots; sync fields

pipe(operator, operator, …)
              = chain transformations on the iterable (filter, map, sample,
                hashWorkdir, loadBlob, verify, groupByDir, …)
```

Three load-bearing properties:

1. **Snapshots are descriptions, not data.** Construction is free
   (no I/O, no parse). Iteration is the only cost. You can construct
   fifty snapshots in a hot loop and pay nothing until you iterate.
2. **Sync access for known data, async only for actual I/O.** Tree
   `oid` is sync (already parsed). Workdir `mode/size/mtime` is sync
   (one `lstat` per row, cached). Workdir `oid` requires `await
   row.workdir.hash()` — and that hash is *also* available as a
   pipeline stage `hashWorkdir()` for batched, concurrency-bounded
   execution.
3. **Errors are origin-tagged.** Every failure carries `(path,
   source)`. You always know which slot's I/O blew up at which path.

## 4. Type surface

### 4.1 Snapshot constructors (all on `Repository`)

```typescript
interface SnapshotFactory {
  // Immutable sources — content-addressed, truly atomic. Always present.
  head(opts?: SnapshotOptions): TreeSnapshot
  commit(oid: ObjectId, opts?: SnapshotOptions): TreeSnapshot
  tree(oid: ObjectId, opts?: SnapshotOptions): TreeSnapshot

  // Mutable sources — atomic via cache + generation clock.
  index(opts?: SnapshotOptions): IndexSnapshot

  // Best-effort sources — per-row stat cache, race-detection on demand.
  workdir(opts?: WorkdirSnapshotOptions): WorkdirSnapshot

  // Compound state heads — may not exist (no merge in progress, etc.).
  // Returns null when the corresponding ref/state file is absent.
  mergeHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>
  cherryPickHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>
  revertHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>
  fetchHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>

  // Stash entry is itself a TRIO (index/workdir/untracked sub-snapshots).
  // Returns null when no stash@{N} exists.
  stashEntry(index: number, opts?: SnapshotOptions): Promise<StashSnapshot | null>
}

interface StashSnapshot {
  readonly kind: 'stash'
  // Three sub-snapshots exposed as properties (no I/O on access).
  // null on `untracked` is the static signal that the stash was created
  // without --include-untracked — discoverable without iterating.
  readonly index: TreeSnapshot              // stash's saved index state
  readonly workdir: TreeSnapshot            // stash's saved working-tree state
  readonly untracked: TreeSnapshot | null   // null if no --include-untracked
}

interface SnapshotOptions {
  readonly paths?: Pathspec               // inclusion filter; uses src/domain/pathspec/ (14.2)
  readonly recurse?: boolean              // default: true
  readonly maxDepth?: number              // default: 1024
  readonly maxEntries?: number            // bounded enumeration
  readonly bypassCache?: boolean          // default: false; skips resolver cache for this call
}

interface WorkdirSnapshotOptions extends SnapshotOptions {
  // .gitignore semantics — distinct from pathspec.
  // pathspec is flat include/exclude (with :(exclude) magic); ignore is
  // per-directory cascade with `!` re-inclusion. Reuses src/domain/ignore/ (14.3);
  // build one with repo.ignoreMatcher().
  //
  // COMPOSITION CONTRACT:
  //   - `paths` (pathspec) AND `excludes` (ignore) compose with logical AND.
  //   - A path is emitted iff it is INCLUDED by `paths` AND NOT EXCLUDED by `excludes`.
  //   - Evaluation order: pathspec first (cheap, used for tree-pruning during
  //     enumeration), then ignore (per-directory cascade, evaluated as the walker
  //     descends). This order is purely an optimisation; the result is the same
  //     as either-first.
  //   - When `paths` is omitted, all paths are considered included.
  //   - When `excludes` is omitted, no paths are excluded by ignore.
  readonly excludes?: WalkIgnorePredicate

  // Single lstat per row (default) vs. two-pass materialize+verify.
  readonly consistency?: 'eager' | 'verified'
}

// Helper for "require this state to exist or throw" callers.
declare function requireSnapshot<T>(
  promise: Promise<T | null>,
  message: string,
): Promise<T>
```

Helper usage:

```typescript
const merge = await requireSnapshot(
  repo.snapshot.mergeHead(),
  'no merge in progress',
)
```

### 4.2 Snapshot interface (single-source iteration)

```typescript
// Canonical, used everywhere. ONE parameter — the entry. Kind discriminator
// lives on the entry itself (TreeEntry.source: 'tree', etc.).
interface Snapshot<E extends SnapshotEntry> {
  readonly kind: SnapshotKind
  entries(opts?: SnapshotOptions): AsyncIterable<E>
}

type SnapshotKind =
  | 'tree' | 'commit' | 'index' | 'workdir'
  | 'mergeHead' | 'cherryPickHead' | 'revertHead' | 'fetchHead' | 'stash'

type SnapshotEntry =
  | TreeEntry
  | IndexEntry
  | WorkdirEntry

// Concrete aliases tighten the entry type for known kinds.
type TreeSnapshot    = Snapshot<TreeEntry>
type IndexSnapshot   = Snapshot<IndexEntry>
type WorkdirSnapshot = Snapshot<WorkdirEntry>
```

### 4.3 Per-source entry shapes — domain rows vs. application entries

**Domain layering rule:** `src/domain/` owns pure data shapes. I/O methods
(`hash`, `read`, `verify`) and adapter-specific fields (`ino`, `mtime`,
`size` from POSIX-stat) live in the application layer, not domain.

**Domain (`src/domain/snapshot/`) — pure data rows:**

```typescript
interface TreeEntryRow {
  readonly source: 'tree'
  readonly path: FilePath
  readonly oid: ObjectId
  readonly mode: FileMode
  readonly kind: 'file' | 'symlink' | 'submodule'
}

interface IndexEntryRow {
  readonly source: 'index'
  readonly path: FilePath
  readonly oid: ObjectId
  readonly mode: FileMode
  readonly stage: 0 | 1 | 2 | 3
  readonly flags: IndexFlags
  readonly cachedStat?: IndexCachedStat        // from index stat-cache; may be stale
}

interface WorkdirEntryRow {
  readonly source: 'workdir'
  readonly path: FilePath
  readonly mode: FileMode
  readonly kind: 'file' | 'symlink' | 'directory' | 'submodule'
  readonly stat: WorkdirStat                   // see ports/file-system.ts (POSIX abstraction)
}

interface WorkdirStat {                        // platform-abstracted; aligns with src/ports/file-system.ts FileStat
  readonly size: number
  readonly mtimeMs: number                     // ms precision — universally available
  readonly mtimeNs?: bigint                    // ns precision — optional (Node fs.statSync.bigint, not browser)
  readonly ino?: bigint                        // optional — absent on adapters where inode isn't exposed
}

// Racy-stat detection prefers mtimeNs when present; falls back to mtimeMs.
// Adapters that supply neither cannot detect mid-second mutations and must
// fall back to the SHA-trailer comparison documented in §7.3.
```

**Application (`src/application/primitives/snapshot/`) — entries with I/O:**

```typescript
// Each entry wraps a Row + holds a resolver reference for its I/O methods.
interface TreeEntry extends TreeEntryRow {
  read(): Promise<Uint8Array>                  // pulls blob via TreeResolver
}

interface IndexEntry extends IndexEntryRow {
  read(): Promise<Uint8Array>                  // pulls blob by oid
}

interface WorkdirEntry extends WorkdirEntryRow {
  hash(): Promise<ObjectId>                    // reads file, computes blob-hash
  read(): Promise<Uint8Array>                  // raw bytes
  readLink(): Promise<string>                  // throws if kind !== 'symlink'
  verify(): Promise<void>                      // re-stat; throws WorkdirRaceError on mismatch
}
```

Domain rows are usable standalone for pure functions (matchers, classifiers,
formatters); application entries add the I/O surface for consumers that need
it. Snapshot `.entries()` yields the application-layer interface.

### 4.4 Join API

```typescript
// Two distinct functions, not overloads. Avoids the TS literal-narrowing trap
// where `const opts = { mode: 'inner' }` widens `mode` to string and silently
// falls into the outer overload.

interface JoinOptions {
  readonly concurrency?: number
  readonly signal?: AbortSignal
}

// Outer join: emit a row if ANY source has the path. Slots are optional.
declare function join<S extends { readonly [k: string]: Snapshot<SnapshotEntry> }>(
  sources: S,
  opts?: JoinOptions,
): AsyncIterable<OuterJoinRow<S>>

// Inner join: emit only when ALL sources have the path. Slots are required.
declare function innerJoin<S extends { readonly [k: string]: Snapshot<SnapshotEntry> }>(
  sources: S,
  opts?: JoinOptions,
): AsyncIterable<InnerJoinRow<S>>

// Per-key narrowing via `infer` — works because Snapshot is single-param.
type EntryOf<X> = X extends Snapshot<infer E> ? E : never

type OuterJoinRow<S> = {
  readonly path: FilePath
} & {
  readonly [K in keyof S]?: EntryOf<S[K]>
}

type InnerJoinRow<S> = {
  readonly path: FilePath
} & {
  readonly [K in keyof S]: EntryOf<S[K]>       // required, no `?`
}
```

Rows are emitted in **canonical git path order** — the sort the `tree`
object format uses, treating directories as `path/` for collation.
Downstream chained joins stay O(n) without buffering.

**Single-source short-circuit (precise):** `join({ x })` skips the k-way
merge stage and reads `x.entries()` directly. Per yielded row, the only
overhead vs. raw `x.entries()` is the row-envelope alloc:
`{ path, x: <entry> }`. Allocation count: **exactly one row object per
entry, plus one short-lived alloc for the `path` projection** (or zero
when `path` is shared with the underlying entry). Asserted by the
allocation-count test in §14.1.

### 4.5 Operators (pipeline stages, explicit I/O)

All operators are `AsyncIterable → AsyncIterable` transforms.

```typescript
// Built-in transforms (reuse src/operators/):
pipe(...ops)
filter(predicate)
map(transform)
take(n)
sample({ first?: n, every?: n })

// Join-specific operators (all preserve canonical-path-order — INVARIANT, not optional):
hashWorkdir(opts?: { concurrency?: number })
  // For each row with .workdir lacking .oid, compute it.
  // Adds .workdir.oid to the row. Bounded concurrency.

verify(slot: 'workdir', opts?: { onRace?: 'throw' | 'skip' | 'emit' })
  // Re-lstat workdir entries and detect mid-iteration races.

groupByDir()
  // Aggregate rows by parent directory; yields { path: dirPath, rows: Row[] }

// Terminal operators — return Promise<T>, NOT AsyncIterable.
count<T>(source: AsyncIterable<T>): Promise<number>
toArray<T>(source: AsyncIterable<T>): Promise<readonly T[]>
first<T>(source: AsyncIterable<T>): Promise<T | null>
```

`loadBlob` is generic over the source keys to keep slot names checked at compile time:

```typescript
declare function loadBlob<S, K extends keyof S>(
  slot: K,
  opts?: { concurrency?: number; maxInflightBytes?: number },
): (source: AsyncIterable<OuterJoinRow<S>>) => AsyncIterable<OuterJoinRow<S>>
```

**Order-preservation invariant.** Every built-in operator yields rows in the
same path order as its input. Mis-ordered input is a precondition violation
that throws `OrderInvariantViolation` rather than producing wrong output.
User-supplied custom operators that reorder break the invariant; this is the
user's responsibility. A type-level `OrderedAsyncIterable<T>` brand may be
added later if review surfaces accidental violation; v1 ships with runtime
checks only.

Composition example:

```typescript
const dirty = pipe(
  join({ head: repo.snapshot.head(), workdir: repo.snapshot.workdir() }),
  hashWorkdir({ concurrency: 16 }),
  filter(r => r.head?.oid !== r.workdir?.oid),
  take(100),
)

for await (const row of dirty) { /* … */ }
```

## 5. Worked examples

### 5.1 `status` (3-way: HEAD × index × workdir)

```typescript
async function* status(repo: Repository): AsyncIterable<StatusChange> {
  const head = repo.snapshot.head()
  const index = repo.snapshot.index()
  const workdir = repo.snapshot.workdir()

  const rows = pipe(
    join({ head, index, workdir }),
    hashWorkdir({ concurrency: 16 }),
  )

  for await (const row of rows) {
    const indexVsHead = classifyIndexVsHead(row.head, row.index)
    const workdirVsIndex = classifyWorkdirVsIndex(row.index, row.workdir)
    if (indexVsHead === 'unmodified' && workdirVsIndex === 'unmodified') continue
    yield { path: row.path, indexVsHead, workdirVsIndex }
  }
}
```

Cost on a clean monorepo (500k files):

- HEAD tree parse: cached after first iteration.
- Index parse: cached + stat-validated (~10µs after the first call).
- Workdir enumeration: one `readdir` per directory, one `lstat` per file.
- `hashWorkdir`: only invoked on rows whose `(mode, size, mtime)`
  differ from the index `stat-cache` (git's racy-stat trick). Typical
  clean-tree call: 0 hashes.

### 5.2 `diff` (2-way: any two trees)

```typescript
async function* diff(
  repo: Repository,
  fromOid: ObjectId,
  toOid: ObjectId,
): AsyncIterable<FileDiff> {
  const rows = join({
    from: repo.snapshot.tree(fromOid),
    to: repo.snapshot.tree(toOid),
  })

  for await (const { path, from, to } of rows) {
    if (from?.oid === to?.oid) continue   // unchanged
    yield buildFileDiff(path, from, to)
  }
}
```

Both sources are tree snapshots — cached, content-addressed, zero races.

### 5.3 `untracked` (workdir ∖ index ∖ ignored)

```typescript
async function* untracked(repo: Repository): AsyncIterable<FilePath> {
  const ignore = await repo.ignoreMatcher()           // builds MatcherStack from .gitignore cascade
  const rows = join({
    index: repo.snapshot.index(),
    workdir: repo.snapshot.workdir({
      excludes: ignore,                                // per-directory cascade, `!` re-inclusion
    }),
  })
  for await (const row of rows) {
    if (!row.index && row.workdir) yield row.path
  }
}
```

Pruning at the **snapshot level** (via `excludes` predicate) means `node_modules`
is never enumerated — no `skipSubtree()` callback to forget. Pathspec inclusion
filters (`paths`) and `.gitignore` exclusion (`excludes`) compose: enumerator
applies the pathspec first, then the ignore predicate, then yields.

### 5.4 `mergeHead` may be absent — null check pattern

```typescript
async function* mergeChanges(repo: Repository): AsyncIterable<MergeRow> {
  const theirs = await repo.snapshot.mergeHead()
  if (theirs === null) return                         // no merge in progress

  const rows = join({
    base: repo.snapshot.tree(await repo.mergeBase('HEAD', 'MERGE_HEAD')),
    ours: repo.snapshot.head(),
    theirs,
    workdir: repo.snapshot.workdir(),
  })
  for await (const row of rows) yield classifyMergeState(row)
}

// Or, for callers that require the state:
async function abortMerge(repo: Repository): Promise<void> {
  const theirs = await requireSnapshot(
    repo.snapshot.mergeHead(),
    'no merge in progress',
  )
  // …
}
```

### 5.5 Custom user query (escape-hatch use)

> "Find all `.ts` files modified between HEAD~10 and HEAD."

```typescript
const changed = pipe(
  join({
    old: repo.snapshot.commit(oldOid, { paths: ['**/*.ts'] }),
    new: repo.snapshot.head({ paths: ['**/*.ts'] }),
  }),
  filter(r => r.old?.oid !== r.new?.oid),
  map(r => r.path),
)
```

Pathspec at the snapshot level prunes traversal; no per-row filter cost.

## 6. Consistency model

| Source | Consistency | Mechanism | vs. git |
|---|---|---|---|
| Tree / Commit | Atomic | Content-addressed; cache keyed by oid; immutable by physics | **Better** — cached resolution, git re-resolves per command |
| Index | Atomic after first-touch parse | Parse on first iteration; stat + generation-clock invalidation; single-flight on concurrent in-process callers | **Better** — git re-parses `.git/index` per subcommand |
| Workdir (default `eager`) | Per-row frozen lstat; documented race | Single `lstat` cached on the row; `verify()` opt-in re-check | **Equivalent** — same semantics as git, more honest |
| Workdir (`verified`) | Two-pass with race detection | Full enumeration + lstat materialization, then re-verify on iteration; emits `WorkdirRaceError` | **Better via porcelain API** — git's `update-index --refresh` / `core.preloadIndex` cover adjacent ground from the CLI; no equivalent surfaced as a typed in-process API |

Net: caching wins (tree, index) are real. Workdir parity is honest. The
`verified` mode formalises what git users hand-roll as `git update-index
--refresh; git status`.

## 7. Caching architecture (hexagonal)

### 7.1 Ports

```typescript
// src/ports/snapshot-resolvers.ts
export interface IndexResolver {
  resolve(ctx: Context): Promise<ParsedIndex>
}

export interface TreeResolver {
  resolve(ctx: Context, treeId: ObjectId): Promise<Tree>
}

export interface WorkdirEnumerator {
  enumerate(ctx: Context, opts: EnumOptions): AsyncIterable<WorkdirEntryRow>
}

// CQS split into THREE interfaces — emit, subscribe, and read are all separable.
// A single concrete adapter can implement all three, but write primitives only
// import the emitter; cache adapters only import the stream; read primitives
// only import the view.

export type WriteScope = 'index' | 'refs' | 'objects'

// Command side — write primitives import this only.
export interface WriteEventEmitter {
  emit(scope: WriteScope): void
}

// Subscribe side — cache adapters import this only, never the emitter.
// Stream-shaped so it doesn't smuggle the emit() surface back through the type.
export interface WriteEventStream {
  subscribe(listener: (scope: WriteScope) => void): Disposable
}

// Query side — read primitives import this only.
export interface GenerationView {
  current(scope: WriteScope): number                  // monotonic
}
```

**Wiring:**

- Write primitives depend on `WriteEventEmitter`. They cannot subscribe.
- `CachingIndexResolver` depends on `WriteEventStream` + `GenerationView`. It cannot emit.
- Read primitives depend on `GenerationView`. They cannot emit or subscribe.
- Concrete adapter (`InMemoryWriteEventBus`) implements all three, registered in DI three times — once per interface. A primitive that needs to do both must declare both deps; the compiler shows you the mistake.

### 7.2 Adapter stack (decorator composition)

```
            CachingIndexResolver           (stat-based eviction + generation check)
                     ↑ wraps
            SingleFlightIndexResolver      (collapse concurrent parses into one)
                     ↑ wraps
            RawIndexResolver               (pure parse, no state)
                     ↑ uses
            FileSystem port                (existing)

            CachingTreeResolver            (bounded LRU keyed by oid, no invalidation)
                     ↑ wraps
            RawTreeResolver                (readObject)
```

### 7.3 Generation-tracking contract

- Per-repository monotonic counters, scoped by mutation target (`index`,
  `refs`, `objects`).
- Every write-boundary primitive calls `WriteEventEmitter.emit(scope)` **after a
  successful write but BEFORE releasing the lock** (critical for TOCTOU —
  see lock-ordering below):
  - `updateIndex`, `applyChangeset`, write-index → `emit('index')`
  - `recordRefUpdate`, ref writes → `emit('refs')`
  - `writeObject`, pack write → `emit('objects')`
- `CachingIndexResolver` (or peer) subscribes; its internal counter
  increments on each event. Counter is exposed via `GenerationView`.
- Cache records `(parsedValue, observedStat, generationAtParse)`.
- Cache hit path:
  ```
  currentGen = view.current(scope)
  if cachedGen === currentGen AND not bypassCache:
    use cache, no syscall
  else:
    stat(file)
    if (mtime, size, ino) match observedStat:
      if mtime ≥ recordedMtime [racy-stat window]:
        compare last 20 bytes (SHA-1 trailer)
        if mismatch: re-parse
        else:        use cache, refresh cachedGen
      else:
        use cache, refresh cachedGen
    else:
      re-parse, replace cache entry
  ```
- Hot path with no writes: **zero syscalls per cache hit**.

**Lock-ordering protocol (closes the TOCTOU window):**

```
Writer:
  1. acquire .git/index.lock
  2. write .git/index.new
  3. fsync (durability per existing platform policy)
  4. rename .git/index.new → .git/index
  5. emit('index')                          ← before release, critical
  6. release .git/index.lock

Reader (in same process):
  - reads cachedGen, then reads view.current('index') ATOMICALLY-ish:
    JS is single-threaded per task, so any emit() between cache-fetch
    and view-read happens before/after our task, never interleaved.
  - If a concurrent writer in another process changed the file but
    didn't go through our emit() path, the stat-mismatch branch catches it.

External writer (another process):
  - emit() is not called. Our generation stays put.
  - On next reader access, generationAtParse === currentGen → hit path.
  - But stat(file) shows different (mtime, size, ino) → re-parse.
  - Racy-stat window: if filesystem mtime granularity collides (1s on FAT,
    2s on NFS), stat-mtime matches but content differs → SHA-trailer
    comparison catches it.
```

**External-writer crash mid-write:**

- Git's atomic rename means the file is either old-or-new, never torn.
  If the writer crashes before rename, we still see the old file
  unchanged; cache stays valid.
- If the writer crashes between rename and emit(), we see the new file
  and our generation is still stale → next read stats and re-parses.
- Either branch is correct.

**Iteration stability invariant (closes the reentrancy hole):**

- An `IndexSnapshot` captures the resolver's parsed value AND its
  `generationAtParse` at *first iteration*. Subsequent `emit('index')`
  events do NOT invalidate an in-flight iteration on that snapshot.
- A snapshot's `.entries()` is therefore consistent for its entire
  lifetime: rows yielded at iteration t=0 and t=N are guaranteed to be
  from the same parse, even if a concurrent write happened in between.
- This is distinct from cache invalidation. The cache may have been
  replaced (new parse for next snapshot); the in-flight snapshot still
  holds a strong reference to its parsed value.
- Equivalent for `TreeSnapshot` (oid-keyed, immutable by physics) and
  `WorkdirSnapshot` (per-row stat cache, see §6 row 3).
- Asserted by integration test: open snapshot S, call `for await (const e of
  S.entries())`, mutate index from inside the loop, observe S continues
  yielding pre-mutation values; a *new* snapshot opened after the mutation
  yields post-mutation values.

**Racy-stat trigger mirrors git** (see Documentation/technical/racy-git.txt):
re-validate whenever `stat-mtime ≥ recorded-index-mtime`, not just on coarse
filesystems. Matches git's SD_VALID semantics. Trailer-SHA check is the
re-validation mechanism for the index file itself; per-entry racy stat for
working-tree entries is unchanged from existing 14.x behavior.

### 7.4 Swap / disable / bypass

```typescript
openRepository(path, { caching: false })                       // all raw
openRepository(path, { caching: { tree: true, index: false } }) // selective
openRepository(path, { resolvers: { index: customIndexResolver } })

// Per-call bypass:
repo.snapshot.index({ cache: 'bypass' }).entries()
```

### 7.5 Domain isolation

- Domain primitives **never reference** caches. They depend on the
  resolver ports only.
- Caching adapters live in `src/adapters/snapshot-resolvers/`.
- Tests:
  - `RawIndexResolver` against fixtures (pure parse).
  - `CachingIndexResolver` with stub resolver + stub FS (assert
    parse-count = 1 across 1000 hits; parse-count = 2 after a stat
    change; parse-count = 2 after a generation bump).
  - Integration: open repo, mutate `.git/index` externally, observe
    re-parse on next snapshot.

## 8. Performance characteristics

Order-of-magnitude targets — load-bearing for the 2.0.0 release. Absolute
numbers refined via benchmark during implementation (§14's bench gate).
A target missed by >2× is a design-doc blocker, not a "fix later" item.

**Initial targets (cold + warm, measured on a 50k-file repository):**

| Scenario | Cold target | Warm target |
|---|---|---|
| `repo.snapshot.index().entries()` (full iterate) | < 50 ms | < 5 ms (cached parse) |
| `repo.snapshot.head().entries()` (full iterate) | < 30 ms | < 3 ms (cached tree) |
| `repo.status()` (3-way join, clean tree) | < 200 ms | < 50 ms |
| `repo.status()` (3-way join, 100 modified files) | < 250 ms | < 80 ms |
| Cached index resolve (hit path, no writes) | < 10 µs | (same) |
| Cached tree resolve (hit path) | < 5 µs | (same) |

Cost-shape table (qualitative, applies regardless of repo size):

| Operation | Cost shape | Comparison |
|---|---|---|
| Snapshot construction | One small object alloc, 0 syscalls | iso-git: same (cheap object) |
| First index parse | 1 read + parse `.git/index` | iso-git: same |
| Cached index parse | 0 syscalls when generation unchanged; 1 stat on generation bump | iso-git: re-parses every command |
| Tree resolve (cached) | LRU lookup, 0 reads | iso-git: re-resolves |
| Workdir entry yield | 1 lstat per row | iso-git: same |
| Workdir hash (lazy) | 1 read + 1 hash per row when invoked | iso-git: silent on `.oid()` call |
| Workdir hash (batched) | N concurrent reads bounded by `concurrency` | iso-git: serial, no concurrency knob |
| Join row | One small object alloc per row | iso-git: similar (`WalkerEntry` array) |

Memory: **bounded** end-to-end. Streaming row emission, no
materialization unless the consumer collects (`Array.fromAsync`).

## 9. Error model

```typescript
class SnapshotError extends TsgitError {
  readonly source: SnapshotKind
  readonly path?: FilePath
  readonly cause: Error
}

// Generic over the join source map so `source` is statically narrowed
// to the slot names actually present. Avoids `source: string` erasure
// at the catch boundary — typed-slot narrowing survives the throw.
class JoinError<S extends { readonly [k: string]: unknown }> extends TsgitError {
  readonly path: FilePath
  readonly source: keyof S & string
  readonly cause: Error
}

class WorkdirRaceError extends TsgitError {
  readonly path: FilePath
  readonly observed: { mtimeMs: number; mtimeNs?: bigint; size: number; ino?: bigint }
  readonly current:  { mtimeMs: number; mtimeNs?: bigint; size: number; ino?: bigint }
}

class OrderInvariantViolation extends TsgitError {
  readonly operator: string
  readonly previousPath: FilePath
  readonly currentPath: FilePath
}
```

Every async operator wraps thrown errors with the originating slot and path.
A consumer's `try`/`catch` around `for await` receives `(slot, path, cause)`
**with slot statically narrowed to the literal slot keys of the originating
`join` call**. No more anonymous errors; no `as string` casts at catch sites.

## 10. Hexagonal layering summary

```
src/
├── domain/
│   └── snapshot/                       # PURE DATA ONLY — no I/O, no adapter types
│       ├── snapshot-kind.ts            # SnapshotKind discriminator
│       ├── tree-entry-row.ts           # TreeEntryRow (path/oid/mode/kind)
│       ├── index-entry-row.ts          # IndexEntryRow + IndexFlags + IndexCachedStat
│       ├── workdir-entry-row.ts        # WorkdirEntryRow + WorkdirStat (port-abstracted)
│       └── classifiers.ts              # pure: classifyIndexVsHead, classifyWorkdirVsIndex
├── ports/
│   ├── snapshot-resolvers.ts           # IndexResolver, TreeResolver, WorkdirEnumerator
│   ├── write-event-emitter.ts          # WriteEventEmitter (command side)
│   ├── write-event-stream.ts           # WriteEventStream (subscribe side)
│   └── generation-view.ts              # GenerationView (query side)
├── application/
│   ├── primitives/
│   │   ├── snapshot/
│   │   │   ├── tree-snapshot.ts        # TreeSnapshot impl (uses TreeResolver)
│   │   │   ├── index-snapshot.ts       # IndexSnapshot impl (uses IndexResolver)
│   │   │   ├── workdir-snapshot.ts     # WorkdirSnapshot impl (uses WorkdirEnumerator)
│   │   │   ├── stash-snapshot.ts       # StashSnapshot impl (trio of tree-snapshots)
│   │   │   ├── tree-entry.ts           # TreeEntry  = TreeEntryRow + read()
│   │   │   ├── index-entry.ts          # IndexEntry = IndexEntryRow + read()
│   │   │   ├── workdir-entry.ts        # WorkdirEntry = WorkdirEntryRow + hash()/read()/readLink()/verify()
│   │   │   ├── require-snapshot.ts     # the requireSnapshot() helper
│   │   │   └── join.ts                 # k-way merge join + single-source short-circuit
│   │   └── snapshot-operators/
│   │       ├── hash-workdir.ts
│   │       ├── load-blob.ts
│   │       ├── verify-workdir.ts
│   │       ├── group-by-dir.ts
│   │       ├── count.ts                # terminal
│   │       ├── to-array.ts             # terminal
│   │       └── first.ts                # terminal
│   └── commands/
│       ├── status.ts                   # migrated when its consumer wave lands
│       ├── diff.ts
│       ├── add.ts
│       ├── checkout.ts
│       ├── merge.ts
│       └── (etc.)
├── adapters/
│   └── snapshot-resolvers/
│       ├── raw-index-resolver.ts
│       ├── caching-index-resolver.ts          # subscribes to WriteEventStream
│       ├── single-flight-index-resolver.ts
│       ├── raw-tree-resolver.ts
│       ├── caching-tree-resolver.ts
│       ├── fs-workdir-enumerator.ts
│       ├── in-memory-write-event-bus.ts       # implements WriteEventEmitter + WriteEventStream (process-local)
│       └── counter-generation-view.ts         # GenerationView impl
└── repository.ts                              # SnapshotFactory wired into openRepository
```

**Dependency rule preserved:** `repository → commands → primitives → domain`.
Resolvers sit at the ports/adapters boundary. **Domain owns rows (pure data);
application owns entries (rows + I/O methods).** Domain has zero adapter
knowledge — `WorkdirStat` is a port-abstracted shape, not POSIX `Stats`.

## 11. Migration plan (by-consumer waves, single PR, semver-major)

Migrate consumer-by-consumer rather than walker-by-walker. This avoids the
v1 spike's planning hole — `walkSubmodules` imports `walkTree`, `status`
calls `walkWorkingTree`. By-walker migration creates a moment where Wave-1
pilots co-exist with their old walkers; by-consumer keeps every commit
internally consistent.

| Wave | Commit topic | Scope |
|---|---|---|
| 0 | `chore(harness): wire doc-links + mutation-budgets into validate` | Bring existing scripts into the `npm run validate` chain. Adds ADR M. No code changes to snapshot path. |
| 1 | `feat(snapshot): introduce snapshot+join primitive` | Ports (`IndexResolver`, `TreeResolver`, `WorkdirEnumerator`, `WriteEventEmitter`, `WriteEventStream`, `GenerationView`), domain rows, application entries, snapshot factories, `join`, `innerJoin`, operators, `requireSnapshot` helper, `StashSnapshot`, resolvers, wiring in `repository.ts`. Tests + property tests. **No consumer migrated yet.** Old walkers untouched, still authoritative. |
| 2 | `refactor(status): use snapshot+join` | Migrate `commands/status.ts`. Delete `walkWorkingTree` calls from this file. Other walkers unchanged. |
| 3 | `refactor(diff): use snapshot+join` | Migrate `commands/diff.ts` + any diff helpers. |
| 4 | `refactor(add): use snapshot+join` | Migrate `commands/add.ts`. Reuses `excludes` predicate path. |
| 5 | `refactor(checkout): use snapshot+join` | Migrate `commands/checkout.ts`. |
| 6 | `refactor(merge): use snapshot+join` | Migrate `commands/merge.ts` + materialize-tree consumers. |
| 7 | `refactor(rm,ls-tree,ls-files): use snapshot+join` | Migrate remaining consumers. Audit `enumerate-push-objects`, `flatten-tree`, `build-index-from-tree`, `materialize-tree`, `walkSubmodules` internals. |
| 8 | `refactor(primitives): deprecate walkTree, walkWorkingTree` | Mark `@deprecated`; keep as thin facades over `TreeSnapshot.entries()` / `WorkdirSnapshot.entries()`. Update `docs/get-started/migrate-from-isomorphic-git.md`. jscpd allowlist entry added (facades are trivial pass-throughs, expected dup). |

**Semver impact:** ship as **`2.0.0`** (from current `1.3.0`). Deprecated walkers
stay exported for the 2.x line with `@deprecated` JSDoc + runtime console warning
on first call per call-site, gated by `TSGIT_SUPPRESS_DEPRECATIONS=1` env var.
Warning text: `[tsgit] walkTree() is deprecated; use repo.snapshot.tree(oid).entries()
(see docs/use/snapshots.md). Set TSGIT_SUPPRESS_DEPRECATIONS=1 to silence.`
Removed in 3.0.0 (no fixed date).

**Deprecation mechanism:**

```typescript
// src/application/primitives/deprecation.ts
const WARNED = new Set<string>()
export const warnDeprecated = (callsite: string, message: string): void => {
  if (process.env.TSGIT_SUPPRESS_DEPRECATIONS === '1') return
  if (WARNED.has(callsite)) return
  WARNED.add(callsite)
  console.warn(message)
}
```

**Test debt — per wave (closes review pass 2 H-2):**

| Wave | Test file fate |
|---|---|
| 1 | New: `test/unit/application/primitives/snapshot/*.test.ts`, `test/unit/adapters/snapshot-resolvers/*.test.ts`, four `*.properties.test.ts` siblings, `test/integration/snapshot-cache.test.ts` |
| 2 | `test/unit/application/commands/status.test.ts` rewritten to assert via snapshot+join (logic identical, surface different) |
| 3 | `test/unit/application/commands/diff.test.ts` rewritten |
| 4 | `test/unit/application/commands/add.test.ts` rewritten |
| 5 | `test/unit/application/commands/checkout.test.ts` rewritten |
| 6 | `test/unit/application/commands/merge.test.ts` rewritten |
| 7 | `test/unit/application/primitives/walk-tree.test.ts` and `walk-working-tree.test.ts` repointed to test deprecated facades (thin); `walk-submodules.test.ts` updated for new internals; `enumerate-push-objects.test.ts`, `repository.test.ts`, `test/parity/scenarios/read-pipeline.scenario.ts`, `test/integration/sparse-checkout.test.ts`, `test/integration/network/partial-clone-http-backend.test.ts`, `test/integration/network/cat-file-batch-promisor.test.ts`, `tooling/test/unit/audit-browser-surface.test.ts` audited for old-walker references and updated |
| 8 | Facades have minimal smoke tests asserting `@deprecated` JSDoc emits the env-gated warning once |

**PR-split fallback (closes review pass 2 M-2):** If a migration wave (especially
checkout 5 or merge 6) stalls more than two days mid-implementation, the PR
splits at the last green wave. Subsequent waves ship as follow-up PRs against
the deprecated-walker baseline of Wave 1. Wave 8 (deprecation) is the only
wave that *must* land in the same PR as Wave 1 if it lands at all — splitting
across PRs is fine for Waves 2–7.

**Reviewable rollback states:**

- After Wave 1: new primitive lives, zero consumers migrated. Safe to
  pause here indefinitely; no production code touches the new path.
- After any Wave 2–7: that consumer is on snapshot+join, others still on
  old walkers. No dual code paths in a single consumer.
- After Wave 8: deprecated facades in place; consumers migrated;
  external API still compiles.

Out of scope for 20.1:

- `walkCommits` — graph traversal, different abstraction.
- `loadBlob` operator implementation may stub for `index`/`head` if not
  needed by Wave 2–7 pilots; revisited in 20.3 (diff patch text).
- `repository.primitives.walkTree`/`walkWorkingTree` **public** removal —
  3.0.0 milestone, not 2.0.0.

## 12. Migration recipe — iso-git → tsgit

A small mapping table to help any iso-git user port code in minutes.

```typescript
// iso-git
await git.walk({
  fs, dir,
  trees: [TREE({ ref: 'HEAD' }), WORKDIR(), STAGE()],
  map: async (filepath, [head, workdir, stage]) => {
    if (filepath === '.') return
    const headOid = await head?.oid()
    const stageOid = await stage?.oid()
    const workdirOid = await workdir?.oid()      // SILENT HASH
    if (headOid === stageOid && stageOid === workdirOid) return
    return { path: filepath, headOid, stageOid, workdirOid }
  },
})

// tsgit
const rows = pipe(
  join({
    head: repo.snapshot.head(),
    stage: repo.snapshot.index(),
    workdir: repo.snapshot.workdir(),
  }),
  hashWorkdir({ concurrency: 16 }),                // EXPLICIT, BATCHED
)
for await (const r of rows) {
  if (r.head?.oid === r.stage?.oid && r.stage?.oid === r.workdir?.oid) continue
  yield { path: r.path, headOid: r.head?.oid, stageOid: r.stage?.oid, workdirOid: r.workdir?.oid }
}
```

Migration mapping:

| iso-git | tsgit |
|---|---|
| `TREE({ ref })` | `repo.snapshot.tree(oid)` / `repo.snapshot.head()` / `repo.snapshot.commit(oid)` |
| `WORKDIR()` | `repo.snapshot.workdir()` |
| `STAGE()` | `repo.snapshot.index()` |
| `map: async (path, [a,b,c]) => …` | `for await (const { path, a, b, c } of join({a,b,c}))` |
| `await entry.oid()` (tree/stage) | `entry.oid` (sync) |
| `await entry.oid()` (workdir) | `await entry.hash()` or `hashWorkdir()` operator |
| `await entry.mode()` | `entry.mode` (sync) |
| `await entry.content()` | `await entry.read()` or `loadBlob(slot)` operator |
| `await entry.type()` | `entry.kind` (sync) |
| `return null` (skip subtree) | `paths: ['!subtree/**']` on the snapshot — pruned at source |
| `reduce` | downstream `groupByDir()` / `pipe(map, …)` |
| `iterate` | concurrency knob on each operator |
| filepath `'.'` sentinel | (never emitted; join yields file rows only) |
| error inside `map` | wrapped in `JoinError { path, source, cause }` |

## 13. Open questions for implementation phase

Resolved during v1→v2 review (see header changelog):

- ~~Stash semantics~~ — three sub-snapshots (`StashSnapshot.index()/.workdir()/.untracked()`), per §4.1.
- ~~Symlink stat~~ — lazy `WorkdirEntry.readLink()`.
- ~~Pathspec coupling~~ — `src/domain/pathspec/` already exists, reused directly.
- ~~Migration shape~~ — by-consumer waves, per §11.
- ~~`mergeHead` lifecycle~~ — `Promise<TreeSnapshot | null>` + `requireSnapshot` helper.
- ~~Semver impact~~ — 2.0.0 with deprecation cycle.

Still open, to settle during implementation:

1. **Index extension handling.** TREE extension carries a cached tree that lets
   index→tree be O(unchanged-dirs). Should `IndexSnapshot.toTree()` use it
   transparently? Deferred — `IndexSnapshot.toTree()` is not on the 20.1 surface;
   decide when 20.3 (diff patch text) lands and needs it.
2. **`paths` parameter on `join` (cross-source).** Each snapshot has its own
   pathspec. Should `join` accept an additional pathspec applied to the merged
   stream? Lean: no — push filtering to snapshots, keep join shape-pure.
3. **`loadBlob` memory-bound default.** Lean: `maxInflightBytes` knob, default
   64 MiB. Pinned by ADR before Wave 3 (diff) lands.
4. **`WeakRef` vs LRU on snapshot cache.** `WeakRef` is universally available
   (Node 14.6+, all modern browsers). Lean: `WeakRef` for the "last parsed"
   slot + bounded LRU below it. Decision-locked in design doc.

## 14. What to validate during implementation

### 14.1 Unit-level test gates

- `RawIndexResolver`: round-trips against fixtures from the existing
  test corpus.
- `CachingIndexResolver`: parse-count assertions — 1 after 1000 hits;
  2 after stat change; 2 after generation event; 2 after external write
  whose mtime collides (trailer-SHA mismatch path).
- `SingleFlightIndexResolver`: 1000 concurrent `resolve()` calls trigger
  exactly 1 underlying parse.
- `TreeSnapshot.entries`: byte-equal to current `walkTree` output on
  every fixture (regression gate; runs before each migration wave).
- `WorkdirSnapshot.entries`: byte-equal to current `walkWorkingTree` on
  every fixture (regression gate; runs before each migration wave).
- `WorkdirSnapshot` with `excludes`: behaviorally equivalent to current
  `walkWorkingTree({ ignore })`.
- `join`: emits rows in canonical git path order; single-source
  short-circuit verified by allocation-count assertion (envelope-only
  overhead vs. raw entries).
- `hashWorkdir` / `loadBlob` / `verify-workdir`: respect concurrency
  limit; honor `ctx.signal`; errors wrapped with `(path, source)`.
- `requireSnapshot`: throws with message when the resolved value is
  null; passes through otherwise.

### 14.2 Property tests (four-lens rule, per CLAUDE.md)

- `join.properties.test.ts` — lens 2 (compositional aggregator) + lens 4
  (counting invariant): for arbitrary `(tree, index, workdir)` triples,
  `join` emits the path union sorted; each row contains exactly the
  slots that had the path; slot fields byte-equal direct enumeration.
- `caching-index-resolver.properties.test.ts` — lens 2: empty event
  history → identity (cache reused); any `index` event → parse-count
  increments; non-`index` event → parse-count unchanged.
- `generation-view.properties.test.ts` — lens 4 (algebraic invariants).
  Care: the property "monotonic per scope" is a tautology if the SUT is
  literally `++counter[scope]` — the test would just restate the
  implementation. The properties we ship test invariants the SUT could
  PLAUSIBLY violate under refactoring: (a) **scope independence under
  interleaved event histories** — given arbitrary sequences of
  `emit('index')` and `emit('refs')`, `current('index')` reflects only the
  `'index'` events; (b) **subscriber isolation via `WriteEventStream`** —
  multiple subscribers see identical event sequences regardless of
  subscription order. These are real composition invariants that a
  single-counter refactor would break.
- `tree-snapshot-entries.properties.test.ts` — lens 1 (round-trip):
  for arbitrary trees, `TreeSnapshot.entries()` output ≡
  `walkTree()` output (parity gate during migration waves).

### 14.3 Full `npm run validate` cross-check

The CI gate runs all of these. Wave 0 wires `check:doc-links` and
`check:mutation-budgets` into the chain (currently they exist as scripts but
aren't called by `validate` — see `package.json:693-715`). The design must
pass every check without suppressions or ignore directives.

| Check | Status | What this design must satisfy |
|---|---|---|
| `check` (Biome lint+format) | wired | All new code formatted; kebab-case filenames |
| `check:types` (tsc strict) | wired | All new generics compile; no `any` escapes |
| `check:dead-code` (knip) | wired | No orphan exports after each wave; Wave-8 facades in knip allowlist |
| `check:duplicates` (jscpd) | wired | jscpd allowlist entry for Wave-8 facades (trivial pass-through) |
| `check:filesystem` (ls-lint) | wired | All new files kebab-case |
| `check:architecture` (dep-cruiser) | wired | New rule: `domain/snapshot/` can't import from `application/`/`adapters/`/`ports/` except branded types |
| `check:spelling` | wired | New terminology added to dictionary |
| `check:deps` | wired | No new runtime deps |
| `check:security` | wired | No raw FS paths; all paths go through validated layouts |
| `check:size` | wired | Snapshot+operators bundle within existing size budget (or budget bumped with ADR) |
| `check:exports` (attw) | wired | New public types type-check under all export conditions |
| `check:browser-surface` | wired | `WorkdirStat.ino` / `mtimeNs` optional means browser adapter compiles without polyfills (see §4.3) |
| `check:write-surfaces` | wired | Write primitives call `WriteEventEmitter.emit` after every successful write |
| `check:test-pyramid` | wired | New unit/integration/property test ratios within configured budgets |
| `check:doc-coverage` | wired | Public surface fully documented in `docs/use/` |
| `check:doc-typedoc` | wired | `reports/api.json` regenerated; diff reviewed |
| `check:parity-fixtures` | wired | Existing parity scenarios still pass after each wave |
| `check:doc-links` | **wired by Wave 0** | All cross-references resolve (script exists at `package.json:197`; not in validate today) |
| `check:mutation-budgets` | **wired by Wave 0** | Budgets file updated with entries for `join.ts`, `caching-*-resolver.ts`, `generation-view.ts`, every snapshot impl, every operator. Target: 0 surviving mutants; equivalent mutants inline-documented with `// equivalent-mutant: <why>` |
| `test:coverage` | wired | 100% line/branch/function/statement on new code |
| `test:integration` | wired | New integration tests for caching + invalidation + migration parity |
| `test:parity` | wired | Memory + Node + browser adapters all pass |

### 14.4 Documentation requirements

- `docs/use/snapshots.md` (new) — user-facing primer on snapshots, joins, operators.
- `docs/use/migrate-from-isomorphic-git.md` (update) — replace iso-git `walk()` examples with snapshot+join.
- `docs/use/primitives/walk-tree.md` (update) — note deprecation, link to snapshots.
- `docs/use/primitives/walk-working-tree.md` (update) — same.
- `docs/understand/caching.md` (new) — `WriteEventEmitter` / `WriteEventStream` / `GenerationView` contract, lock-ordering, racy-stat handling.
- `README.md` — update "primitives" section to lead with snapshots+join.
- `RUNBOOK.md` — deprecation warning behavior, env override.

## 15. What this enables downstream

| Backlog item | Enabled by |
|---|---|
| 20.2 standalone primitives (`hashBlob`, `isIgnored`, `updateIndex`) | `WorkdirEntry.hash()`, snapshot pathspec, index resolver port |
| 20.3 diff patch-text output | `join({ from, to })` + new `loadBlob` + serializer |
| 20.4 merge state machine | `mergeHead`, `cherryPickHead`, `revertHead` snapshots already exposed |
| 21.1 `pull` | reuses `merge` which reuses `join({ ours, theirs, base })` |
| 21.2 `mv` | `join({ index, workdir })` + atomic rename |
| 21.3 `stash` | `stashEntry(N)` snapshot trio |
| 22.x history rewriting | per-commit `tree(oid)` snapshots with cached resolution |

20.1 is genuinely a foundation: every downstream porcelain composes
on the snapshot+join substrate without inventing a new walker.

## 16. ADRs queued (write before design doc lands)

Fourteen decisions are user-shaping and need ADRs per CLAUDE.md §3:

| ADR | Topic | Resolves spike §§ |
|---|---|---|
| A | Pathspec engine reused from 14.2 at the snapshot level (no new grammar) | §4.1, §5.3 |
| B | Snapshots are lazy descriptions, not eager parses (free construction, parse on first iteration) | §3, §4.1 |
| C | Generation-tracking + stat-fallback as cache invalidation mechanism | §7.1, §7.3 |
| D | By-consumer migration waves (not by-walker), single-PR with PR-split fallback | §11 |
| D′ | Semver-major 2.0.0 + single deprecation cycle for old walkers; removal in 3.0.0 | §11 |
| E | Workdir best-effort consistency by default; opt-in `verified` two-pass mode | §4.1, §6 |
| F | Explicit-I/O pipeline operators, not async-getter properties (core anti-iso-git decision) | §3, §4.3, §4.5 |
| G | Named-slot join rows, not positional tuples; statically-narrowed per-slot entry types | §4.4 |
| H | Lazy symlink target via `readLink()`, not eager enumeration | §4.3 |
| I | CQS port-triple split — `WriteEventEmitter` + `WriteEventStream` + `GenerationView` | §7.1 |
| J | `excludes` (gitignore-style cascade) sits alongside `paths` (pathspec) on `WorkdirSnapshotOptions`; AND-composed | §4.1, §5.3 |
| K | Inner-join as a separate `innerJoin()` function rather than overloaded `mode` parameter | §4.4 |
| L | `TSGIT_SUPPRESS_DEPRECATIONS` env var to silence deprecated-walker warnings; warn-once per call-site | §11 |
| M | Wave-0 harness extension: wire `check:doc-links` + `check:mutation-budgets` into `npm run validate` | §11, §14.3 |

Each ADR uses `docs/adr/000-template.md`, status `Accepted (at <main-sha>)`,
sequentially numbered from the next available slot. Land as one commit:
`docs(adr): NNN..NNN+13 snapshot-and-join foundation` (14 ADRs).
