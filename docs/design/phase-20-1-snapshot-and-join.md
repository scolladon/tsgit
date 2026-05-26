# Phase 20.1 — Snapshot and join primitive

Phase 20 — Foundation primitives (v2) — opens with a unified replacement for
the ad-hoc walkers shipped in 14.x. `snapshot+join` is the new spine for every
multi-source inspection in the library: `status`, `diff`, `changes`,
`unmerged`, `untracked`, `checkout` conflict detection, `merge` 3-way
comparison, `stash apply` 4-way comparison, and the downstream porcelain in
Phase 21–22.

The rationale, alternatives, and trade-offs live in the spike at
`docs/spike/phase-20-1-snapshot-join.md` and ADRs 148–161. This document is
the engineering contract — every signature, every module, every export, every
test gate. We code from this.

## 1. Goal

Ship a snapshot-and-join primitive that:

1. **Closes the isomorphic-git `walk()` parity gap** with a measurably better
   API — typed slots, sync access for known data, explicit I/O stages,
   cancellable streaming pipelines, origin-tagged errors.
2. **Becomes the single hot path** for multi-source inspection. Existing
   `walkTree` / `walkWorkingTree` migrate onto it; `status`, `diff`, `add`,
   `checkout`, `merge`, and the rest follow.
3. **Bounds memory and discovers I/O** at the operator boundary. No silent
   hashing, no silent reads, no unbounded buffering.
4. **Caches what's free to cache** (immutable git objects; the index, with
   stat + generation invalidation). Zero-syscall hot path when no writes have
   occurred.
5. **Ships as 2.0.0** with a single deprecation cycle for the old walkers.
   Old API stays exported through 2.x; removed in 3.0.0.

## 2. Out of scope (does NOT ship in 20.1)

- `walkCommits` migration — graph traversal, different abstraction; stays.
- `IndexSnapshot.toTree()` — TREE-extension acceleration deferred to 20.3 (diff).
- File-watcher (inotify / FSEvents / kqueue) driven cache invalidation —
  generation + stat is sufficient for v2.0.0; watchers are a later optimization.
- WASM/Edge-runtime variants of `loadBlob` — same code; not benchmarked here.
- Public removal of `repo.primitives.walkTree` / `walkWorkingTree` — that's
  3.0.0 (per ADR-152).
- Cross-source pathspec on `join` itself — push filtering to snapshots.
- A type-level `OrderedAsyncIterable<T>` brand — runtime invariant check is
  enough for v2.0.0; brand if review surfaces accidental misuse.

## 3. References

- Spike: `docs/spike/phase-20-1-snapshot-join.md` (commit `1c35bc3`)
- ADRs: 148–161 (commit `205f409`)
  - 148 Pathspec engine reused at snapshot level
  - 149 Snapshots are lazy descriptions
  - 150 Generation-tracking + stat-fallback cache invalidation
  - 151 By-consumer migration waves
  - 152 Semver 2.0.0 + deprecation cycle
  - 153 Workdir best-effort + verified consistency mode
  - 154 Explicit-I/O pipeline operators
  - 155 Named-slot join rows
  - 156 Lazy symlink target
  - 157 CQS port-triple split
  - 158 `excludes` alongside `paths` on WorkdirSnapshotOptions
  - 159 `innerJoin` as separate function
  - 160 `TSGIT_SUPPRESS_DEPRECATIONS` env var
  - 161 Wave-0 harness extension
- Existing modules reused: `src/domain/pathspec/` (14.2), `src/domain/ignore/`
  (14.3), `src/ports/file-system.ts`, `src/ports/context.ts`,
  `src/application/primitives/read-object.ts`, `src/operators/` (pipe,
  filter, map, take).

## 4. Module layout

```
src/
├── domain/
│   └── snapshot/                                    # NEW — pure data, no I/O
│       ├── index.ts                                 # re-export façade
│       ├── snapshot-kind.ts                         # SnapshotKind discriminator
│       ├── tree-entry-row.ts                        # TreeEntryRow
│       ├── index-entry-row.ts                       # IndexEntryRow, IndexFlags, IndexCachedStat
│       ├── workdir-entry-row.ts                     # WorkdirEntryRow, WorkdirStat
│       ├── join-row.ts                              # OuterJoinRow<S>, InnerJoinRow<S>, EntryOf<X>
│       └── classifiers.ts                           # classifyIndexVsHead, classifyWorkdirVsIndex
├── ports/
│   ├── snapshot-resolvers.ts                        # NEW — IndexResolver, TreeResolver, WorkdirEnumerator
│   ├── write-event-emitter.ts                       # NEW — WriteEventEmitter (command side)
│   ├── write-event-stream.ts                        # NEW — WriteEventStream (subscribe side)
│   └── generation-view.ts                           # NEW — GenerationView (query side)
├── application/
│   ├── primitives/
│   │   ├── snapshot/                                # NEW — application-tier snapshot impls
│   │   │   ├── index.ts                             # re-export façade
│   │   │   ├── tree-snapshot.ts                     # TreeSnapshot impl
│   │   │   ├── index-snapshot.ts                   # IndexSnapshot impl
│   │   │   ├── workdir-snapshot.ts                  # WorkdirSnapshot impl
│   │   │   ├── stash-snapshot.ts                    # StashSnapshot trio
│   │   │   ├── tree-entry.ts                        # TreeEntry (Row + read())
│   │   │   ├── index-entry.ts                       # IndexEntry (Row + read())
│   │   │   ├── workdir-entry.ts                     # WorkdirEntry (Row + hash/read/readLink/verify)
│   │   │   ├── snapshot-factory.ts                  # SnapshotFactory interface + impl
│   │   │   ├── require-snapshot.ts                  # requireSnapshot helper
│   │   │   ├── join.ts                              # join + innerJoin + short-circuit
│   │   │   └── path-merge.ts                        # k-way path-keyed merge iterator
│   │   ├── snapshot-operators/                      # NEW — pipeline stages
│   │   │   ├── index.ts                             # re-export façade
│   │   │   ├── hash-workdir.ts                      # hashWorkdir(opts)
│   │   │   ├── load-blob.ts                         # loadBlob(slot, opts)
│   │   │   ├── verify-workdir.ts                    # verify('workdir', opts)
│   │   │   ├── group-by-dir.ts                      # groupByDir()
│   │   │   ├── count.ts                             # count<T> — terminal
│   │   │   ├── to-array.ts                          # toArray<T> — terminal
│   │   │   └── first.ts                             # first<T> — terminal
│   │   ├── deprecation.ts                           # NEW — warnDeprecated helper (ADR-160)
│   │   └── ...existing files...
│   └── commands/
│       └── ...existing files (migrated Wave 2–7)...
├── adapters/
│   └── snapshot-resolvers/                          # NEW — concrete resolver stack
│       ├── index.ts                                 # re-export façade
│       ├── raw-index-resolver.ts                    # RawIndexResolver
│       ├── caching-index-resolver.ts                # CachingIndexResolver (decorator)
│       ├── single-flight-index-resolver.ts          # SingleFlightIndexResolver (decorator)
│       ├── raw-tree-resolver.ts                     # RawTreeResolver
│       ├── caching-tree-resolver.ts                 # CachingTreeResolver (LRU)
│       ├── fs-workdir-enumerator.ts                 # FsWorkdirEnumerator
│       ├── in-memory-write-event-bus.ts             # Implements emitter + stream
│       └── counter-generation-view.ts               # Counter-backed GenerationView
└── repository.ts                                    # MODIFIED — wires SnapshotFactory
```

**Architecture rule (`check:architecture`):** `domain/snapshot/` cannot import
from `application/`, `adapters/`, or `ports/snapshot-resolvers.ts`. Branded
type imports from `domain/objects/` and `domain/pathspec/` are allowed.

## 5. Ports

All port interfaces are in `src/ports/`. Each one is single-purpose; the
concrete adapters live in `src/adapters/snapshot-resolvers/`.

### 5.1 `IndexResolver`

```typescript
// src/ports/snapshot-resolvers.ts
import type { Context } from './context.js'
import type { ParsedIndex } from '../domain/git-index/index.js'

export interface IndexResolver {
  /**
   * Resolve the current `.git/index` to a parsed structure.
   *
   * Implementations are free to cache and to deduplicate concurrent calls.
   * Callers must NOT mutate the returned value; treat as deeply frozen.
   */
  resolve(ctx: Context): Promise<ParsedIndex>
}
```

### 5.2 `TreeResolver`

```typescript
export interface TreeResolver {
  /**
   * Resolve a tree object by its oid. May be cached (LRU). Throws
   * `unexpectedObjectType` if the oid is not a tree.
   */
  resolve(ctx: Context, treeId: ObjectId): Promise<Tree>
}
```

### 5.3 `WorkdirEnumerator`

```typescript
export interface WorkdirEnumOptions {
  readonly paths?: Pathspec
  readonly excludes?: WalkIgnorePredicate
  readonly maxDepth?: number
  readonly maxEntries?: number
}

export interface WorkdirEnumerator {
  /**
   * Stream `WorkdirEntryRow` instances in canonical git path order. Honors
   * `ctx.signal`. Single `lstat` per yielded row (cached on the row).
   */
  enumerate(ctx: Context, opts: WorkdirEnumOptions): AsyncIterable<WorkdirEntryRow>
}
```

### 5.4 `WriteEventEmitter` (command side, ADR-157)

```typescript
// src/ports/write-event-emitter.ts
export type WriteScope = 'index' | 'refs' | 'objects'

export interface WriteEventEmitter {
  /**
   * Called by write-boundary primitives AFTER a successful write but BEFORE
   * releasing any acquired lock. See `docs/understand/caching.md` for the
   * lock-ordering protocol.
   */
  emit(scope: WriteScope): void
}
```

### 5.5 `WriteEventStream` (subscribe side, ADR-157)

```typescript
// src/ports/write-event-stream.ts
export interface Disposable {
  dispose(): void
}

export interface WriteEventStream {
  /**
   * Subscribe to write events. Multiple subscribers receive identical event
   * sequences. Subscription order has no observable effect on event delivery.
   */
  subscribe(listener: (scope: WriteScope) => void): Disposable
}
```

### 5.6 `GenerationView` (query side, ADR-157)

```typescript
// src/ports/generation-view.ts
export interface GenerationView {
  /** Monotonic counter; increments per `emit(scope)` event. */
  current(scope: WriteScope): number
}
```

## 6. Domain rows (pure data)

Domain layering rule: these are pure records. No methods, no I/O, no
adapter-specific types. Branded types from `src/domain/objects/` only.

### 6.1 `TreeEntryRow`

```typescript
// src/domain/snapshot/tree-entry-row.ts
export interface TreeEntryRow {
  readonly source: 'tree'
  readonly path: FilePath
  readonly oid: ObjectId
  readonly mode: FileMode
  readonly kind: 'file' | 'symlink' | 'submodule'
}
```

### 6.2 `IndexEntryRow`

```typescript
// src/domain/snapshot/index-entry-row.ts
export interface IndexFlags {
  readonly assumeUnchanged: boolean
  readonly skipWorktree: boolean
  readonly intentToAdd: boolean
}

export interface IndexCachedStat {
  readonly mtimeMs: number
  readonly mtimeNs?: bigint
  readonly size: number
  readonly ino?: bigint
}

export interface IndexEntryRow {
  readonly source: 'index'
  readonly path: FilePath
  readonly oid: ObjectId
  readonly mode: FileMode
  readonly stage: 0 | 1 | 2 | 3
  readonly flags: IndexFlags
  readonly cachedStat?: IndexCachedStat
}
```

### 6.3 `WorkdirEntryRow`

```typescript
// src/domain/snapshot/workdir-entry-row.ts
export interface WorkdirStat {
  readonly size: number
  readonly mtimeMs: number
  readonly mtimeNs?: bigint
  readonly ino?: bigint
}

export interface WorkdirEntryRow {
  readonly source: 'workdir'
  readonly path: FilePath
  readonly mode: FileMode
  readonly kind: 'file' | 'symlink' | 'directory' | 'submodule'
  readonly stat: WorkdirStat
}
```

`WorkdirStat` aligns with the existing `FileStat` in `src/ports/file-system.ts`
— `mtimeNs` and `ino` are optional, satisfying the browser adapter constraint.
Racy-stat detection prefers `mtimeNs` when present, falls back to `mtimeMs`,
and falls back further to SHA-trailer comparison (see §10.5).

### 6.4 `SnapshotKind` discriminator

```typescript
// src/domain/snapshot/snapshot-kind.ts
export type SnapshotKind =
  | 'tree'
  | 'commit'
  | 'index'
  | 'workdir'
  | 'mergeHead'
  | 'cherryPickHead'
  | 'revertHead'
  | 'fetchHead'
  | 'stash'
```

### 6.5 `JoinRow` types

```typescript
// src/domain/snapshot/join-row.ts
export type EntryOf<X> = X extends Snapshot<infer E> ? E : never

export type OuterJoinRow<S> = {
  readonly path: FilePath
} & {
  readonly [K in keyof S]?: EntryOf<S[K]>
}

export type InnerJoinRow<S> = {
  readonly path: FilePath
} & {
  readonly [K in keyof S]: EntryOf<S[K]>      // required, no `?`
}
```

### 6.6 Classifiers

```typescript
// src/domain/snapshot/classifiers.ts
// Pure functions over rows. Reused by status, diff, changes.

export type IndexVsHead =
  | 'unmodified' | 'added' | 'modified' | 'deleted' | 'typechange'

export type WorkdirVsIndex =
  | 'unmodified' | 'modified' | 'deleted' | 'typechange' | 'untracked'

export const classifyIndexVsHead = (
  head: TreeEntryRow | undefined,
  index: IndexEntryRow | undefined,
): IndexVsHead => { /* ... */ }

export const classifyWorkdirVsIndex = (
  index: IndexEntryRow | undefined,
  workdir: WorkdirEntryRow | undefined,
): WorkdirVsIndex => { /* ... */ }
```

## 7. Application entries (rows + I/O)

`src/application/primitives/snapshot/` wraps each domain row with its async
I/O surface (per ADR-154). Entries are what `snapshot.entries()` yields.

### 7.1 `TreeEntry`

```typescript
// src/application/primitives/snapshot/tree-entry.ts
export interface TreeEntry extends TreeEntryRow {
  /** Reads the blob bytes for this entry's oid via the TreeResolver. */
  read(): Promise<Uint8Array>
}
```

### 7.2 `IndexEntry`

```typescript
// src/application/primitives/snapshot/index-entry.ts
export interface IndexEntry extends IndexEntryRow {
  read(): Promise<Uint8Array>
}
```

### 7.3 `WorkdirEntry`

```typescript
// src/application/primitives/snapshot/workdir-entry.ts
export interface WorkdirEntry extends WorkdirEntryRow {
  /** Reads the file and computes its blob-hash (sha1, blob header). */
  hash(): Promise<ObjectId>
  /** Raw file bytes (no hash). */
  read(): Promise<Uint8Array>
  /** Symlink target. Throws UnsupportedOperation if kind !== 'symlink'. */
  readLink(): Promise<string>
  /** Re-lstat; throws WorkdirRaceError on (mtime, size, ino) mismatch. */
  verify(): Promise<void>
}
```

Entry methods name their I/O (per ADR-154). Sync fields are inherited from
the corresponding row; I/O methods are new.

## 8. Snapshot interface

```typescript
// src/application/primitives/snapshot/index.ts (re-exported on Snapshot)
export interface Snapshot<E extends SnapshotEntry> {
  readonly kind: SnapshotKind
  entries(opts?: SnapshotOptions): AsyncIterable<E>
}

export type SnapshotEntry = TreeEntry | IndexEntry | WorkdirEntry

export type TreeSnapshot    = Snapshot<TreeEntry>
export type IndexSnapshot   = Snapshot<IndexEntry>
export type WorkdirSnapshot = Snapshot<WorkdirEntry>
```

**Single type parameter** (per ADR-155's type discipline carried through
review pass 2). Kind is exposed as a runtime discriminator on the snapshot;
entries carry their own `source` discriminator inherited from the row.

### 8.1 `SnapshotOptions`

```typescript
export interface SnapshotOptions {
  /** Pathspec inclusion filter; reuses src/domain/pathspec/ (ADR-148). */
  readonly paths?: Pathspec

  /** Default: true. Set to false for shallow tree enumeration. */
  readonly recurse?: boolean

  /** Default: 1024. Maximum tree depth for cycle / runaway protection. */
  readonly maxDepth?: number

  /** Bounded enumeration; default: MAX_FLAT_TREE_ENTRIES (shared with 14.x). */
  readonly maxEntries?: number

  /** Default: false. When true, skips resolver caches for this call. */
  readonly bypassCache?: boolean
}
```

### 8.2 `WorkdirSnapshotOptions`

```typescript
export interface WorkdirSnapshotOptions extends SnapshotOptions {
  /**
   * `.gitignore`-style exclusion predicate (ADR-158). Composes with
   * `paths` via logical AND. Reuses src/domain/ignore/ (14.3); build one
   * with `repo.ignoreMatcher()`.
   */
  readonly excludes?: WalkIgnorePredicate

  /**
   * Default: 'eager' — single lstat per row, race-aware via verify().
   * 'verified' — two-pass materialize + re-verify on access.
   * See ADR-153.
   */
  readonly consistency?: 'eager' | 'verified'
}
```

## 9. Snapshot factory

```typescript
// src/application/primitives/snapshot/snapshot-factory.ts
export interface SnapshotFactory {
  // ---- Immutable sources (truly atomic; ADR-149)
  head(opts?: SnapshotOptions): TreeSnapshot
  commit(oid: ObjectId, opts?: SnapshotOptions): TreeSnapshot
  tree(oid: ObjectId, opts?: SnapshotOptions): TreeSnapshot

  // ---- Mutable source (atomic via cache + generation; ADR-150)
  index(opts?: SnapshotOptions): IndexSnapshot

  // ---- Best-effort source (ADR-153)
  workdir(opts?: WorkdirSnapshotOptions): WorkdirSnapshot

  // ---- Compound state heads (may not exist; ADR-149)
  mergeHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>
  cherryPickHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>
  revertHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>
  fetchHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>

  // ---- Stash trio
  stashEntry(index: number, opts?: SnapshotOptions): Promise<StashSnapshot | null>
}
```

**Construction discipline (ADR-149):** Every immutable / mutable / best-effort
factory above (the sync ones) does ZERO I/O. The synchronous return type is
the static signal — no `await` needed, no parse triggered.

The compound state heads and `stashEntry` are `Promise<… | null>` because
discovering whether the ref exists requires one filesystem check (a `stat` on
`.git/MERGE_HEAD`, etc.). They still don't parse the underlying tree until
iterated.

### 9.1 `StashSnapshot`

```typescript
// src/application/primitives/snapshot/stash-snapshot.ts
export interface StashSnapshot {
  readonly kind: 'stash'
  /** Stash's saved index state. */
  readonly index: TreeSnapshot
  /** Stash's saved working-tree state. */
  readonly workdir: TreeSnapshot
  /** Null if stash was created without `--include-untracked` (ADR static). */
  readonly untracked: TreeSnapshot | null
}
```

Per ADR (review pass 2 H4): `untracked` is a property, not a method. Whether
the stash has untracked state is metadata, discoverable immediately on the
snapshot handle.

### 9.2 `requireSnapshot` helper

```typescript
// src/application/primitives/snapshot/require-snapshot.ts
export const requireSnapshot = async <T>(
  promise: Promise<T | null>,
  message: string,
): Promise<T> => {
  const value = await promise
  if (value === null) {
    throw new TsgitError('SNAPSHOT_REQUIRED', { reason: message })
  }
  return value
}
```

Usage:

```typescript
const merge = await requireSnapshot(
  repo.snapshot.mergeHead(),
  'no merge in progress',
)
```

## 10. Resolvers (adapter stack)

### 10.1 Decorator composition

```
        CachingIndexResolver         (stat + generation invalidation)
                 ↑ wraps
        SingleFlightIndexResolver    (collapse concurrent parses)
                 ↑ wraps
        RawIndexResolver             (pure parse, stateless)
                 ↑ uses
        FileSystem port              (existing)
```

Same shape applies to `TreeResolver`: `CachingTreeResolver` (LRU, no
invalidation — content-addressed) wraps `RawTreeResolver`.

`WorkdirEnumerator` is single-tier (no global cache; per-row stat cache lives
on the row).

### 10.2 `RawIndexResolver`

```typescript
// src/adapters/snapshot-resolvers/raw-index-resolver.ts
export const createRawIndexResolver = (fs: FileSystem): IndexResolver => ({
  resolve: async (ctx) => {
    const buffer = await fs.readFile(`${ctx.layout.gitDir}/index`)
    return parseIndex(buffer)            // existing src/domain/git-index/
  },
})
```

### 10.3 `SingleFlightIndexResolver`

```typescript
// src/adapters/snapshot-resolvers/single-flight-index-resolver.ts
export const createSingleFlightIndexResolver = (
  inner: IndexResolver,
): IndexResolver => {
  let inflight: Promise<ParsedIndex> | null = null
  return {
    resolve: async (ctx) => {
      if (inflight) return inflight
      inflight = (async () => {
        try {
          return await inner.resolve(ctx)
        } finally {
          inflight = null
        }
      })()
      return inflight
    },
  }
}
```

Asserted by property test: 1000 concurrent `resolve()` calls trigger exactly
one underlying `inner.resolve()` (§13.2).

### 10.4 `CachingIndexResolver`

```typescript
// src/adapters/snapshot-resolvers/caching-index-resolver.ts
interface CacheEntry {
  readonly parsed: ParsedIndex
  readonly observed: FileStat
  cachedGen: number
}

export const createCachingIndexResolver = (
  inner: IndexResolver,
  fs: FileSystem,
  stream: WriteEventStream,
  view: GenerationView,
): IndexResolver => {
  let entry: CacheEntry | null = null

  stream.subscribe((scope) => {
    if (scope === 'index') {
      // Generation already bumped by view; entry's cachedGen now stale.
      // Lazy invalidation — next resolve() detects mismatch and re-parses.
    }
  })

  return {
    resolve: async (ctx) => {
      const currentGen = view.current('index')

      if (entry && entry.cachedGen === currentGen && !ctx.bypassCache) {
        return entry.parsed                          // zero-syscall hit
      }

      const stat = await fs.stat(`${ctx.layout.gitDir}/index`)

      if (entry && statMatches(stat, entry.observed) && !needsRacyCheck(stat, entry.observed)) {
        entry.cachedGen = currentGen
        return entry.parsed                          // stat-validated hit
      }

      if (entry && statMatches(stat, entry.observed) && needsRacyCheck(stat, entry.observed)) {
        const trailer = await readTrailer(fs, ctx, 20)
        if (bytesEqual(trailer, entry.parsed.trailerSha)) {
          entry.cachedGen = currentGen
          return entry.parsed                        // SHA-trailer-validated hit
        }
      }

      // Miss — re-parse.
      const parsed = await inner.resolve(ctx)
      entry = { parsed, observed: stat, cachedGen: currentGen }
      return parsed
    },
  }
}
```

`statMatches` compares `(mtimeMs, mtimeNs?, size, ino?)`. `needsRacyCheck`
returns true when `stat-mtime ≥ observed-mtime` (the racy-stat window per
git's rules; see ADR-150).

### 10.5 `CachingTreeResolver`

Bounded LRU keyed by `ObjectId`. No invalidation logic. Default size: 256
trees (configurable via `openRepository({ caching: { treeLruSize } })`).
Lifts the existing pack delta-base cache pattern in
`src/application/primitives/object-resolver.ts`.

### 10.6 `FsWorkdirEnumerator`

Wraps the existing `walkWorkingTree` logic from
`src/application/primitives/walk-working-tree.ts` with two changes:

1. Yields `WorkdirEntryRow` (with `stat` populated) instead of the legacy
   `{ path, stat }` shape.
2. Accepts both `paths: Pathspec` and `excludes: WalkIgnorePredicate`,
   composed per ADR-158.

### 10.7 `InMemoryWriteEventBus`

```typescript
// src/adapters/snapshot-resolvers/in-memory-write-event-bus.ts
export const createInMemoryWriteEventBus = (
  view: CounterGenerationView,
): { emitter: WriteEventEmitter; stream: WriteEventStream } => {
  const listeners = new Set<(scope: WriteScope) => void>()

  return {
    emitter: {
      emit: (scope) => {
        view.bump(scope)                          // advance generation
        for (const fn of listeners) fn(scope)
      },
    },
    stream: {
      subscribe: (listener) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    },
  }
}
```

### 10.8 `CounterGenerationView`

```typescript
// src/adapters/snapshot-resolvers/counter-generation-view.ts
export interface CounterGenerationView extends GenerationView {
  bump(scope: WriteScope): void
}

export const createCounterGenerationView = (): CounterGenerationView => {
  const counters: Record<WriteScope, number> = {
    index: 0,
    refs: 0,
    objects: 0,
  }
  return {
    current: (scope) => counters[scope],
    bump:    (scope) => { counters[scope] += 1 },
  }
}
```

Public API in `src/ports/generation-view.ts` exports only `GenerationView`.
The `CounterGenerationView` interface with `bump` is an adapter-internal
detail (the `WriteEventBus` adapter holds the only reference).

## 11. Join API

```typescript
// src/application/primitives/snapshot/join.ts
export interface JoinOptions {
  readonly concurrency?: number
  readonly signal?: AbortSignal
}

export const join = <S extends { readonly [k: string]: Snapshot<SnapshotEntry> }>(
  sources: S,
  opts: JoinOptions = {},
): AsyncIterable<OuterJoinRow<S>> => {
  const keys = Object.keys(sources) as Array<keyof S & string>
  if (keys.length === 1) {
    return shortCircuit(sources, keys[0]!, opts)
  }
  return pathMerge(sources, keys, opts, /* mode */ 'outer')
}

export const innerJoin = <S extends { readonly [k: string]: Snapshot<SnapshotEntry> }>(
  sources: S,
  opts: JoinOptions = {},
): AsyncIterable<InnerJoinRow<S>> => {
  const keys = Object.keys(sources) as Array<keyof S & string>
  return pathMerge(sources, keys, opts, /* mode */ 'inner') as AsyncIterable<InnerJoinRow<S>>
}
```

`pathMerge` is the k-way merge iterator in `path-merge.ts`. `shortCircuit`
bypasses the merge for single-source joins (ADR for envelope-only overhead
in spike §4.4): yields `{ path, [slotName]: entry }` with one alloc per row.

### 11.1 Order invariant

Rows emit in canonical git path order — tree's sort, treating directories
as `path/`. Operators that consume row streams MUST preserve order (per
ADR — runtime check, throws `OrderInvariantViolation` on detected reorder).

### 11.2 Concurrency

`JoinOptions.concurrency` is forwarded to operator stages downstream
(`hashWorkdir`, `loadBlob`). Default: `ctx.concurrency` (existing).

## 12. Operator catalog

All operators are `AsyncIterable<In> → AsyncIterable<Out>` transforms, plus
three terminal operators returning `Promise<T>`.

### 12.1 `hashWorkdir`

```typescript
// src/application/primitives/snapshot-operators/hash-workdir.ts
export interface HashWorkdirOptions {
  readonly concurrency?: number
}

export const hashWorkdir = <S extends { workdir?: Snapshot<WorkdirEntry> }>(
  opts: HashWorkdirOptions = {},
) => async function* (
  source: AsyncIterable<OuterJoinRow<S>>,
): AsyncIterable<OuterJoinRow<S>> {
  // For each row with .workdir lacking .oid, compute hash; emit augmented row.
  // Concurrency-bounded via a worker pool.
}
```

### 12.2 `loadBlob`

```typescript
export interface LoadBlobOptions {
  readonly concurrency?: number
  readonly maxInflightBytes?: number     // default: 64 * 1024 * 1024
}

export const loadBlob = <S, K extends keyof S>(
  slot: K,
  opts: LoadBlobOptions = {},
) => async function* (
  source: AsyncIterable<OuterJoinRow<S>>,
): AsyncIterable<OuterJoinRow<S>> {
  // Eagerly read blob content for the named slot; honors maxInflightBytes
  // to bound memory.
}
```

### 12.3 `verify` (workdir)

```typescript
export type VerifyRaceAction = 'throw' | 'skip' | 'emit'

export const verify = <S extends { workdir?: Snapshot<WorkdirEntry> }>(
  slot: 'workdir',
  opts: { onRace?: VerifyRaceAction } = {},
) => /* ... */
```

Re-lstats workdir entries during iteration. `onRace` controls behavior:
`throw` (default) raises `WorkdirRaceError`; `skip` drops the row; `emit`
yields the row with a synthetic race marker.

### 12.4 `groupByDir`

```typescript
export interface DirGroup<R> {
  readonly path: FilePath              // directory path
  readonly rows: ReadonlyArray<R>
}

export const groupByDir = <R extends { path: FilePath }>() =>
  async function* (source: AsyncIterable<R>): AsyncIterable<DirGroup<R>> { /* ... */ }
```

### 12.5 Terminal operators

```typescript
export const count    = async <T>(source: AsyncIterable<T>): Promise<number>          => { /* */ }
export const toArray  = async <T>(source: AsyncIterable<T>): Promise<readonly T[]>    => { /* */ }
export const first    = async <T>(source: AsyncIterable<T>): Promise<T | null>        => { /* */ }
```

All three honor `ctx.signal` and short-circuit on `break` semantics of the
underlying iterator.

## 13. Error model

```typescript
// Errors live in src/domain/error.ts (extends TsgitError).

class SnapshotError extends TsgitError {
  readonly source: SnapshotKind
  readonly path?: FilePath
  readonly cause: Error
}

class JoinError<S extends { readonly [k: string]: unknown }> extends TsgitError {
  readonly path: FilePath
  readonly source: keyof S & string         // statically narrowed
  readonly cause: Error
}

class WorkdirRaceError extends TsgitError {
  readonly path: FilePath
  readonly observed: WorkdirStat
  readonly current:  WorkdirStat
}

class OrderInvariantViolation extends TsgitError {
  readonly operator: string
  readonly previousPath: FilePath
  readonly currentPath: FilePath
}
```

`JoinError<S>` preserves slot-name narrowing through the catch boundary
(ADR-155). Concrete catch sites can `if (e.source === 'workdir')` and TS
narrows accordingly.

## 14. Public API surface

`src/index.ts` and `src/index.node.ts` add these exports:

```typescript
// Types
export type {
  Snapshot, TreeSnapshot, IndexSnapshot, WorkdirSnapshot, StashSnapshot,
  TreeEntry, IndexEntry, WorkdirEntry,
  TreeEntryRow, IndexEntryRow, WorkdirEntryRow,
  WorkdirStat, IndexFlags, IndexCachedStat,
  SnapshotKind, SnapshotEntry,
  SnapshotOptions, WorkdirSnapshotOptions,
  OuterJoinRow, InnerJoinRow, EntryOf,
  JoinOptions, HashWorkdirOptions, LoadBlobOptions, VerifyRaceAction, DirGroup,
  IndexVsHead, WorkdirVsIndex,
  SnapshotError, JoinError, WorkdirRaceError, OrderInvariantViolation,
}

// Functions
export {
  join, innerJoin, requireSnapshot,
  hashWorkdir, loadBlob, verify, groupByDir,
  count, toArray, first,
  classifyIndexVsHead, classifyWorkdirVsIndex,
}
```

`Repository` gains:

```typescript
interface Repository {
  // ...existing surface...
  readonly snapshot: SnapshotFactory
  readonly ignoreMatcher: () => Promise<WalkIgnorePredicate>
}
```

`repo.primitives.walkTree` / `walkWorkingTree` stay exported (deprecated
facades per Wave 8). The new `repo.snapshot.*` is the recommended path
through 2.x.

## 15. Testing strategy

### 15.1 Unit tests (Wave 1)

| Suite | File | Coverage gate |
|---|---|---|
| Raw resolvers | `test/unit/adapters/snapshot-resolvers/raw-*.test.ts` | 100% L/B/F/S |
| Caching resolvers | `test/unit/adapters/snapshot-resolvers/caching-*.test.ts` | 100% L/B/F/S; parse-count assertions |
| Single-flight | `test/unit/adapters/snapshot-resolvers/single-flight-*.test.ts` | 100% L/B/F/S; concurrent-resolve assertion |
| Workdir enumerator | `test/unit/adapters/snapshot-resolvers/fs-workdir-enumerator.test.ts` | 100% L/B/F/S |
| WriteEventBus | `test/unit/adapters/snapshot-resolvers/in-memory-write-event-bus.test.ts` | 100% L/B/F/S; subscriber isolation |
| GenerationView | `test/unit/adapters/snapshot-resolvers/counter-generation-view.test.ts` | 100% L/B/F/S |
| Snapshot impls | `test/unit/application/primitives/snapshot/{tree,index,workdir,stash}-snapshot.test.ts` | 100% L/B/F/S; byte-equal to old walker outputs on fixtures |
| Entries | `test/unit/application/primitives/snapshot/{tree,index,workdir}-entry.test.ts` | 100% L/B/F/S |
| Snapshot factory | `test/unit/application/primitives/snapshot/snapshot-factory.test.ts` | 100% L/B/F/S |
| `requireSnapshot` | `test/unit/application/primitives/snapshot/require-snapshot.test.ts` | 100% L/B/F/S |
| `join` / `innerJoin` | `test/unit/application/primitives/snapshot/join.test.ts` | 100% L/B/F/S; order invariant; single-source short-circuit alloc count |
| Operators | `test/unit/application/primitives/snapshot-operators/*.test.ts` | 100% L/B/F/S; concurrency limits honored; signal cancellation |
| Deprecation helper | `test/unit/application/primitives/deprecation.test.ts` | 100% L/B/F/S; env-var gate; warn-once |

### 15.2 Property tests (four-lens rule)

| File | Lens | Property |
|---|---|---|
| `test/unit/application/primitives/snapshot/join.properties.test.ts` | 2 + 4 | Outer-join yields the path union sorted; row slot membership matches source presence; slot fields byte-equal direct enumeration |
| `test/unit/adapters/snapshot-resolvers/caching-index-resolver.properties.test.ts` | 2 | Empty event history → cache reused (parse-count=1 across N calls); any `index` event → parse-count increments; non-`index` event → parse-count unchanged |
| `test/unit/adapters/snapshot-resolvers/generation-view.properties.test.ts` | 4 | Scope independence under interleaved event histories; subscriber isolation via stream |
| `test/unit/application/primitives/snapshot/tree-snapshot.properties.test.ts` | 1 | Round-trip: `TreeSnapshot.entries()` output ≡ `walkTree()` output for arbitrary trees |

Tier budgets (per ADR): join — `numRuns: 100`; caching — `numRuns: 100`;
generation — `numRuns: 200`; tree-snapshot parity — `numRuns: 50`.

### 15.3 Integration tests (Wave 1)

- `test/integration/snapshot-cache.test.ts` — open repo, mutate index externally,
  observe re-parse on next snapshot; mutate via `repo.add()`, observe generation
  bump triggers re-parse; concurrent external + internal mutations honored.
- `test/integration/snapshot-iteration-stability.test.ts` — open snapshot, mutate
  index during iteration, assert in-flight iteration sees pre-mutation rows;
  new snapshot sees post-mutation rows.
- `test/integration/workdir-race.test.ts` — `consistency: 'eager'` race
  detection via `verify()`; `consistency: 'verified'` two-pass detection.

### 15.4 Parity tests

- Existing `test/parity/scenarios/read-pipeline.scenario.ts` updated to exercise
  snapshot+join after Wave 2 migration; Memory + Node + Browser adapters all
  pass.
- New scenario: snapshot-and-join read pipeline (status-equivalent) against the
  same fixture.

### 15.5 Mutation testing

Stryker budgets file (`scripts/mutation-budgets.yaml`) gets entries for every
new file. Target: 0 surviving mutants on:

- `join.ts`, `path-merge.ts`, `snapshot-factory.ts`, `tree-snapshot.ts`,
  `index-snapshot.ts`, `workdir-snapshot.ts`, `stash-snapshot.ts`,
  `caching-index-resolver.ts`, `caching-tree-resolver.ts`,
  `single-flight-index-resolver.ts`, `in-memory-write-event-bus.ts`,
  `counter-generation-view.ts`, every operator.

Equivalent mutants documented inline with `// equivalent-mutant: <why>` per
existing project convention (no central catalogue per project memory).

### 15.6 Validation harness

Every check listed in spike §14.3 must pass on every wave commit. Wave 0
extends `validate` to include `check:doc-links` and `check:mutation-budgets`
(ADR-161); subsequent waves must keep both green.

## 16. Documentation deliverables

New / updated docs in this PR (per spike §14.4):

| Path | State | Purpose |
|---|---|---|
| `docs/use/snapshots.md` | NEW | Primer on snapshots, joins, operators; recommended path for new code |
| `docs/use/migrate-from-isomorphic-git.md` | UPDATED | Iso-git `walk()` → tsgit snapshot+join recipe (per spike §12) |
| `docs/use/primitives/walk-tree.md` | UPDATED | Deprecation notice; link to snapshots |
| `docs/use/primitives/walk-working-tree.md` | UPDATED | Deprecation notice; link to snapshots |
| `docs/understand/caching.md` | NEW | `WriteEventEmitter` / `WriteEventStream` / `GenerationView` contract; lock-ordering; racy-stat handling |
| `README.md` | UPDATED | "Primitives" section leads with snapshots+join |
| `RUNBOOK.md` | UPDATED | `TSGIT_SUPPRESS_DEPRECATIONS` env var documented |
| `CONTRIBUTING.md` | UPDATED | New testing patterns for the snapshot+join stack |
| `docs/BACKLOG.md` | UPDATED | Tick 20.1 line `[ ]` → `[x]` in the implementation PR's own commits |

## 17. Migration plan

The wave structure (Wave 0 → Wave 8) and per-wave test debt live in spike §11.
This design doc does not duplicate that schedule — the plan doc
(`docs/plan/phase-20-1-snapshot-and-join.md`) will lift it into a TDD-ordered
build sequence.

Short summary:

- **Wave 0:** `chore(harness): wire doc-links + mutation-budgets into validate`
  (ADR-161; ships before any snapshot code).
- **Wave 1:** `feat(snapshot): introduce snapshot+join primitive` (ports,
  domain rows, application entries, factory, join, operators, resolvers,
  tests). **No consumer migrated.**
- **Waves 2–7:** one consumer per wave (status → diff → add → checkout → merge
  → rest). Each wave migrates one command + its tests; old walker stays
  authoritative for not-yet-migrated consumers.
- **Wave 8:** `refactor(primitives): deprecate walkTree, walkWorkingTree`.
  Facades over the new API; runtime warning gated by env var; jscpd
  allowlist updated.

Single PR per ADR-151. PR splits at the last green wave if a later wave
stalls; Waves 2–7 are individually splittable.

## 18. Open implementation questions

These are impl-detail-level — they do not block design freeze. Each is
expected to be settled mid-implementation:

1. **TREE-extension acceleration in `IndexSnapshot.toTree()`** — deferred to
   20.3 per ADR; `IndexSnapshot.toTree()` is not on the 20.1 surface.
2. **`loadBlob.maxInflightBytes` default** — current proposal: 64 MiB.
   Pinned by ADR before Wave 3 (diff) lands.
3. **`WeakRef` for snapshot-cache LRU** — WeakRef is universally available.
   Lean: `WeakRef` for the "last parsed" slot + bounded LRU below it.
   Locked when caching-tree-resolver lands.
4. **Operator order-invariant brand type** — `OrderedAsyncIterable<T>` could
   be introduced if review pass on Wave 1 surfaces accidental misuse. Default
   stance: runtime check only.

## 19. Validation checkpoint

Before each wave merges, `npm run validate` must pass clean — no
suppressions, no ignore directives. Coverage 100% L/B/F/S on every new
file. Stryker mutation budget 0 survivors on every new file (with equivalent
mutants inline-documented). doc-links + mutation-budgets gates green from
Wave 0 onward.

After Wave 8, the codebase has:
- `repo.snapshot.*` as the primary multi-source primitive.
- `repo.primitives.walkTree` / `walkWorkingTree` as `@deprecated` facades.
- Every command migrated to snapshot+join.
- 100% coverage, 0 mutation survivors, all parity scenarios green across
  Node + Memory + Browser + Deno + Bun + Workers adapters.
- Released as 2.0.0; migration recipe documented; deprecation env var
  in `RUNBOOK.md`.
