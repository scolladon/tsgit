# Design: Primitives (Tier 2)

**Status: Proposed** — Phase 7 of the [backlog](../BACKLOG.md).

### Review Notes

Round 0 — initial draft. Open for review.

Round 4 (finalization gate) — implemented amendments:

- **`createCommit` extra-header key validation.** Header keys are now rejected when empty or containing NUL/CR/LF/space/tab — closes a wire-format injection gap distinct from the value-side `hasHeaderInjectionChars` already in place. Predicate `isInvalidExtraHeaderKey` + reason `REASON_EXTRA_HEADER_KEY_INVALID` in `validators.ts`.
- **`readIndex` checksum-mismatch error sanitization.** The thrown message no longer embeds the computed/expected hex digests; reason promoted to a stable constant `REASON_INDEX_CHECKSUM_MISMATCH`.
- **`pack-registry` .idx size guard.** Stat-then-read with a 64 MiB cap (`MAX_PACK_IDX_BYTES`); throws `INVALID_PACK_INDEX` with `REASON_PACK_IDX_EXCEEDS_MAX`. Defends against a hostile/corrupt pack directory before any allocation.
- **NodeCompressor inflated-output cap.** `inflate()` now passes `maxOutputLength: MAX_INFLATED_OBJECT_BYTES` (2 GiB, mirrors the delta target cap); `streamInflate` and `createInflateStream` add cumulative byte counters that destroy the stream and surface `DECOMPRESS_FAILED` when the cap is exceeded. Cap is injectable via the `NodeCompressor` constructor for testability.
- **BrowserCompressor input cap.** `streamInflate` now rejects inputs above 64 KiB (mirrors `MemoryCompressor`) — the progressive-prefix scan is O(n²) and not appropriate for production-sized packs.
- **`RefStore` per-Context cache.** A new `getRefStore(ctx)` resolves through a `WeakMap<Context, RefStore>`, mirroring the `read-object.ts` registry-cache pattern. `resolveRef` and `updateRef` consume the cached store, so a session that performs N ref lookups parses `packed-refs` once instead of N times.
- **`WalkState.queue` type accuracy.** Dropped the misleading `readonly` qualifier on the queue field (the array is mutated in-place via `push`/`shift`) so the interface honestly reflects the implementation.

---

## 1. Overview

Phase 7 adds the **Tier 2 application layer**: low-level composable operations that sit directly above domain and ports, and directly below the Tier 1 commands (Phase 9) and repository facade (Phase 10). Twelve primitives total, grouped into four capability clusters:

| Cluster | Primitives | Purpose |
|---|---|---|
| Object I/O | `readObject`, `writeObject`, `readBlob`, `readTree`, `writeTree` | Read/write git objects through loose + pack storage |
| Ref plumbing | `resolveRef`, `updateRef` | Resolve refs to `ObjectId`; atomic ref writes |
| Index | `readIndex` | I/O wrapper for the staging area |
| Walkers + composition | `walkCommits`, `walkTree`, `createCommit`, `diffTrees` | AsyncIterable walkers, commit construction, tree-vs-tree diff bridge |

**Tier discipline.** The application layer has two tiers by design:

```
Tier 1 — commands/        (clone, log, status, init, add, commit, ...)  — Phase 9
              │
              ▼
Tier 2 — primitives/      (this phase)
              │
              ▼
          domain/ + ports/
```

Commands compose primitives. Primitives compose domain functions + port calls. Primitives never call commands (enforced by dep-cruiser rule `primitives-cannot-import-commands`). Users of `openRepository()` (Phase 10) also receive primitives as first-class exports under `tsgit/primitives` — the same building blocks Tier 1 uses. This "expose the substrate" decision keeps the library library-first rather than CLI-first.

**Scope boundary.** Phase 7 does not implement:

- Smart HTTP protocol (Phase 8 `transport`).
- User-facing `clone` / `fetch` / `push` flows (Phase 9).
- Working-tree checkout / symlink materialization (Phase 9 `checkout` command consuming `MergeOutcome` streams from §15 Phase 5 obligations).
- Similarity-based rename detection (Phase 9 `diff` with `-M`).
- Merge-base algorithm (`mergeBase` is a Phase 9 concern built on `walkCommits` — see open questions §13).

**Cancellation.** Every primitive reads `ctx.signal.aborted` at well-defined yield/await boundaries (§7). Walkers check between yields; one-shot primitives check before and after each I/O round-trip.

**Binary-size constraint.** `.size-limit.json` gains a new entry `"Primitives"` capped at **8 kB gzipped** (estimated 5.5 kB, 2.5 kB headroom). Each primitive is a separate file; tree-shaking is the default. Any primitive addition needs a fresh size measurement (same ratchet as Phase 6 §1).

---

## 2. Module Structure

```
src/application/primitives/
├── read-object.ts            # readObject(ctx, id, opts?): Promise<GitObject>
├── write-object.ts           # writeObject(ctx, object): Promise<ObjectId>
├── read-blob.ts              # readBlob(ctx, id): Promise<Blob>
├── read-tree.ts              # readTree(ctx, ref): Promise<Tree>
├── write-tree.ts             # writeTree(ctx, entries): Promise<ObjectId>
├── resolve-ref.ts            # resolveRef(ctx, name, opts?): Promise<ObjectId>
├── update-ref.ts             # updateRef(ctx, name, newId, opts?): Promise<void>
├── read-index.ts             # readIndex(ctx): Promise<GitIndex>
├── create-commit.ts          # createCommit(ctx, input): Promise<ObjectId>
├── walk-commits.ts           # walkCommits(ctx, opts): AsyncIterable<Commit>
├── walk-tree.ts              # walkTree(ctx, id, opts?): AsyncIterable<WalkTreeEntry>
├── diff-trees.ts             # diffTrees(ctx, a, b, opts?): Promise<TreeDiff>
├── object-resolver.ts        # INTERNAL — shared loose-first-then-pack resolver
├── pack-registry.ts          # INTERNAL — lazy scan + cache of .idx files
├── ref-store.ts              # INTERNAL — loose-first-then-packed ref lookups
├── atomic-write.ts           # INTERNAL — lock file + fsync + rename helper
├── path-layout.ts            # INTERNAL — .git/objects/xx/yyy, .git/refs/..., .git/index joins
├── types.ts                  # Exported option shapes + WalkTreeEntry
└── index.ts                  # Barrel export
```

**Test layout:**

```
test/unit/application/primitives/
├── read-object.test.ts
├── write-object.test.ts
├── read-blob.test.ts
├── read-tree.test.ts
├── write-tree.test.ts
├── resolve-ref.test.ts
├── update-ref.test.ts
├── read-index.test.ts
├── create-commit.test.ts
├── walk-commits.test.ts
├── walk-tree.test.ts
├── diff-trees.test.ts
├── object-resolver.test.ts
├── pack-registry.test.ts
├── ref-store.test.ts
├── atomic-write.test.ts
└── fixtures.ts               # memory-context builders, seeded repo helpers
```

All files kebab-case (ls-lint). All intra-package imports use the `.js` suffix (ESM).

---

## 3. Dependency Boundaries

Phase 7 is the **first** layer allowed to compose domain + ports:

```
primitives/ → domain/             (parsers, serializers, pure algorithms)
primitives/ → ports/              (Context + all port interfaces)
primitives/ → operators/          (AsyncIterable composition — §8.6)
primitives/ ✗→ commands/           (enforced: primitives-cannot-import-commands)
primitives/ ✗→ adapters/           (no platform coupling)
primitives/ ✗→ transport/          (transport is a separate layer, Phase 8)
primitives/ ✗→ repository.ts       (facade is above primitives)
```

**Intra-phase rule (new).** Primitives may import internal helpers (`object-resolver`, `pack-registry`, `ref-store`, `atomic-write`, `path-layout`, `types`, `error`) but **MUST NOT import each other** in the first draft — keeps the dep graph a tree, not a DAG. Three documented exceptions (§3.1) cover places where direct composition is justified.

### 3.1 Allowed intra-primitive imports (exceptions list)

| Importer | Imports | Justification |
|---|---|---|
| `read-blob.ts` | `read-object.ts` | `readBlob` is a narrowing wrapper over `readObject` (type assertion). |
| `read-tree.ts` | `resolve-ref.ts`, `read-object.ts` | `readTree(ctx, ref)` = `resolveRef` → `readObject` → commit-auto-peel to tree / `peelOneLevel` tag chain (capped by `maxPeelDepth`, shared with `resolveRef`). |
| `walk-commits.ts` | `read-object.ts`, `resolve-ref.ts` | Walker reads commits and resolves starting refs. |
| `walk-tree.ts` | `read-object.ts` | Walker recursively reads subtree objects. |
| `diff-trees.ts` | `read-object.ts` *(only for id resolution when inputs are `ObjectId`)* | §12 accepts both `Tree` and `ObjectId` inputs. |
| `create-commit.ts` | `write-object.ts` | Commit construction writes the commit blob. |
| `write-tree.ts` | `write-object.ts` | Tree construction writes the tree blob. |

Every other cross-import is a design violation — flag in review.

**Forbidden intra-primitive imports** (explicit to kill drift):

- `writeObject` must NOT call `readObject` (write is pure-output; roundtrip verification, if ever added, is a test concern).
- `updateRef` must NOT call `resolveRef` (update writes the new id verbatim; old-id verification is caller-supplied).
- `readIndex` is standalone — no other primitive imports it.

### 3.2 Per-primitive domain / port dependency table

| Primitive | Domain modules | Ports |
|---|---|---|
| `readObject` | `objects` (parse, `GitObject`), `storage` (`PackIndex`, `parsePackEntryHeader`, `applyDelta`, `computeLooseObjectPath`); **INTERNAL** `object-resolver.ts` (houses the iterative delta walker per §10.1 — a Phase 7 primitive-layer module, NOT a domain helper). | `FileSystem`, `Compressor`, `HashService`. Consumes `ctx.deltaCache` (type `LruCache<Uint8Array>` imported `import type` only — primitives never call `createLruCache`). |
| `writeObject` | `objects` (`serializeObject`), `storage` (`computeLooseObjectPath`) | `FileSystem`, `HashService`, `Compressor` |
| `readBlob` | `objects` (`Blob` type) | (delegates to `readObject`) |
| `readTree` | `objects` (`Tree`), `refs` (`peelOneLevel`) | (delegates to `resolveRef` + `readObject`) |
| `writeTree` | `objects` (`Tree`, `TreeEntry`, `sortTreeEntries`, `serializeObject`) | (delegates to `writeObject`) |
| `resolveRef` | `refs` (`parseLooseRef`, `parsePackedRefs`, `validateRefName`) | `FileSystem` |
| `updateRef` | `refs` (`serializeDirectRef`, `serializePackedRefs`, `validateRefName`) | `FileSystem` |
| `readIndex` | `git-index` (`parseIndex`) | `FileSystem` |
| `createCommit` | `objects` (`Commit`, `serializeCommitContent`, `AuthorIdentity`) | (delegates to `writeObject`) |
| `walkCommits` | `objects` (`Commit`) | (delegates to `readObject` + `resolveRef`) |
| `walkTree` | `objects` (`Tree`, `TreeEntry`, `FILE_MODE`, `isDirectory`), `diff` (`FlatTree`, `FlatTreeEntry`) | (delegates to `readObject`) |
| `diffTrees` | `objects` (`Tree`), `diff` (`diffTrees` domain function, `TreeDiff`, `detectRenames` optionally) | (delegates to `readObject` if inputs are `ObjectId`) |

---

## 4. Types

All primitive option shapes and the one new `WalkTreeEntry` type live in `types.ts`.

### 4.1 `ReadObjectOptions`

```typescript
interface ReadObjectOptions {
  /**
   * SHA verification of the decompressed content against `id`.
   * Default: `true` (safe-by-default). Pack `.idx` CRC only covers the
   * compressed bytes — it does NOT prove that `sha1(decompressed) === id`
   * for delta-resolved entries. Callers processing trusted local packs
   * can opt out with `verifyHash: false` for marginal speedup.
   * A mismatch throws `OBJECT_HASH_MISMATCH`.
   */
  readonly verifyHash?: boolean;
}
```

**Delta-base cache is obtained from `ctx.deltaCache`** (see §7.2), not a per-call option. Every `readObject` call in a given `Context` shares the same LRU. Callers do not construct caches — the `Context` factory wires one with a sensible default size (16 MiB byte-bounded, 65_536 entry-bounded). Opting out is a Context-level concern; individual primitives do not expose a cache-override knob.

### 4.2 `WriteObjectResult` — not needed

`writeObject` returns `ObjectId` directly; the primitive computes the id by hashing `serializeObject(object)`. No wrapper type.

### 4.3 `ResolveRefOptions`

```typescript
interface ResolveRefOptions {
  /**
   * Peel the resolved object through the tag-chain to a non-tag target.
   * Default: `false` — returns the first `ObjectId` in the chain.
   * When `true`, follows `peelOneLevel` recursively until the target is
   * no longer a tag (so typically commit or tree).
   */
  readonly peel?: boolean;
  /**
   * Maximum number of symbolic-ref dereferences. Default: 5.
   * Counts `HEAD → refs/heads/main → refs/heads/feature` as depth 2.
   * Exceeding throws `REF_CHAIN_TOO_DEEP`. Does NOT count tag peels —
   * see `maxPeelDepth` below.
   */
  readonly maxSymbolicDepth?: number;
  /**
   * Maximum number of tag-peel steps when `peel === true`. Default: 5.
   * Counts `tag→tag→commit` as depth 2. Exceeding throws
   * `REF_CHAIN_TOO_DEEP` with the full traversed chain in `chain`.
   */
  readonly maxPeelDepth?: number;
}
```

### 4.4 `UpdateRefOptions`

```typescript
interface UpdateRefOptions {
  /**
   * Old-value expectation for compare-and-swap. When set, `updateRef`
   * re-reads the current ref value under the lock and throws
   * `REF_UPDATE_CONFLICT` if it differs.
   *   - `ObjectId` — expect this id
   *   - `'absent'` — expect the ref to NOT exist (creation)
   *   - `undefined` — no CAS check (blind overwrite)
   * Default: `undefined`.
   */
  readonly expected?: ObjectId | 'absent';
  /**
   * When `true`, instead of writing a new value, remove the ref file.
   * Packed-refs entry removal is a Phase 9 concern (needs `git pack-refs`
   * semantics); v1 `delete=true` only removes the loose file. If the
   * ref is packed-only, throws `UNSUPPORTED_OPERATION`.
   * Default: `false`.
   */
  readonly delete?: boolean;
}
```

### 4.5 `WalkCommitsOptions`

```typescript
interface WalkCommitsOptions {
  /**
   * Starting commit ids (resolved from refs by the caller, or walked from HEAD).
   * At least one required; at most `MAX_WALK_SEEDS = 1024` (see §5.10 invariants —
   * prevents seed-admission loop from stalling the event loop on hostile input).
   * The pending queue is additionally capped at `MAX_WALK_QUEUE_SIZE = 64 * 1024`
   * to prevent unbounded heap growth on wide octopus-merge repositories.
   */
  readonly from: ReadonlyArray<ObjectId>;
  /** Stop when any of these commit ids is reached. Exclusive: the boundary commit is NOT yielded. */
  readonly until?: ReadonlyArray<ObjectId>;
  /**
   * Walk order:
   *  - 'topo'       — topological (default; parents after children, stable)
   *  - 'first-parent' — follow only `commit.parents[0]` at each step
   *
   * NOTE: `'date'` order is reserved for a future heap-based scheduler; it is
   * intentionally absent from the public type in Phase 7 so callers cannot
   * request behavior the current FIFO walker does not actually implement.
   */
  readonly order?: 'topo' | 'first-parent';
  /**
   * If `true`, missing parent commits are silently skipped instead of throwing
   * `OBJECT_NOT_FOUND`. Required for shallow clones (`.git/shallow`) where
   * parent commits beyond the shallow boundary are legitimately absent.
   * Default: `false` (strict — any missing parent throws).
   *
   * When `true`, the walker yields the child commit normally and omits the
   * missing parent from the traversal; other parents of the same commit still
   * walk. The child's `.parents` list still contains the missing id — callers
   * can detect shallow-boundary commits by cross-referencing.
   */
  readonly ignoreMissing?: boolean;
  /**
   * Forward to `readObject` for every commit read during the walk.
   * Default: `true` (safe-by-default, matches `readObject` itself).
   * Opt-out only when walking a trusted local pack for max throughput.
   */
  readonly verifyHash?: boolean;
}
```

### 4.6 `WalkTreeEntry`

```typescript
/**
 * A yielded entry from walkTree. Carries a repo-root-relative forward-slash
 * path (no leading '/', no '.', no '..', no backslashes, no empty segments).
 * Paths for symlinks include the symlink name; the walker does NOT follow symlinks.
 *
 * Yielded in byte-order on `path` (same ordering as `domain/diff/path-compare.ts`).
 * This satisfies Phase 5 §15.1: FlatTree consumers iterate in byte-order and
 * mergeTrees / diffIndexAgainstTree rely on insertion-order iteration.
 */
interface WalkTreeEntry {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}
```

### 4.7 `WalkTreeOptions`

```typescript
interface WalkTreeOptions {
  /**
   * If `true`, recursively descend subtrees (default). If `false`, only
   * yield top-level entries (mode=DIRECTORY entries are yielded but their
   * children are NOT pulled).
   */
  readonly recursive?: boolean;
  /**
   * Maximum recursion depth. Guards against pathologically nested trees
   * and (malicious) tree cycles. Default: 1024. Exceeding throws
   * `TREE_DEPTH_EXCEEDED`.
   */
  readonly maxDepth?: number;
  /**
   * Per-walk entry cap. Default: `MAX_FLAT_TREE_ENTRIES` (1,000,000 — Phase 5).
   * Exceeding throws `TREE_ENTRY_LIMIT_EXCEEDED`. Caller composing
   * `walkTree` into a `FlatTree` builder receives a pre-counted stream.
   */
  readonly maxEntries?: number;
}
```

### 4.8 `CreateCommitInput`

```typescript
interface CreateCommitInput {
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
  readonly gpgSignature?: string;
  readonly extraHeaders?: ReadonlyArray<ExtraHeader>;
}
```

### 4.9 `DiffTreesInput` and `DiffTreesOptions`

```typescript
/**
 * `diffTrees` accepts either an already-parsed `Tree`, an `ObjectId` (walker
 * resolves via readObject), or `undefined` (represents an empty tree on that
 * side — identical semantics to domain `diffTrees(undefined, ...)`).
 */
type DiffTreesInput = Tree | ObjectId | undefined;

interface DiffTreesOptions {
  /** Enable exact-match rename detection. Default: `false`. */
  readonly detectRenames?: boolean;
  /** Passed through to domain `detectRenames`. Ignored when `detectRenames=false`. */
  readonly renameOptions?: RenameDetectOptions;
}
```

---

## 5. Per-Primitive Signatures

Signatures use domain types from `domain/index.js` and ports from `ports/index.js`. `Context` is always the first argument — convention matches every tier-2+ tsgit API.

### 5.1 `readObject` (§7.1)

```typescript
export function readObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<GitObject>;
```

**Contract.**

- Lookup order: **loose objects first, then packfiles** (§10 pipeline).
- Returns a fully parsed `GitObject` — delta resolution happens inside the primitive.
- Throws `OBJECT_NOT_FOUND` when neither loose nor any packfile contains `id`.
- Throws `AMBIGUOUS_SHORT_SHA` is **not** produced here — full `ObjectId` is required; short-sha resolution is a separate Phase 9 primitive (`resolveShortSha`).
- When `verifyHash: true`, SHA over the serialized object must equal `id`; mismatch throws `OBJECT_HASH_MISMATCH`.
- Checks `ctx.signal.aborted` before each filesystem read.

**Ports used.** `ctx.fs.read` / `ctx.fs.readSlice`, `ctx.compressor.inflate` for loose objects, `ctx.compressor.streamInflate(bytes, offset)` for packed entries (pack resolver reads a generous header+stream slice and streamInflate stops at the zlib terminator, returning `{ output, bytesConsumed }`), `ctx.hash.hashHex` (only when `verifyHash=true` or hashing a reconstructed delta).

**Domain used.** `parseHeader`, `parseObject`, pack-index `lookupPackIndex`, pack-entry `parsePackEntryHeader`, `applyDelta`, `computeLooseObjectPath`. (The `LruCache` *type* is imported from `domain/storage/` for `ctx.deltaCache`; the primitive does NOT call `createLruCache` — Context factories do.)

**Invariants.**

- Delta chain depth capped at `MAX_DELTA_CHAIN_DEPTH = 50` (standard git limit). Exceeding throws `DELTA_CHAIN_TOO_DEEP`. Enforced in the **iterative** phase-1 chain-walk (see §10.1 / Phase 2 `object-storage.md §8.6`), not in recursive `readObject` calls — recursion over depth 50 would risk stack overflow before the counter fires.
- Delta cache is `ctx.deltaCache` (required field per §7.2); byte- and entry-bounded per §10.4.
- **`verifyHash` defaults to `true`** (safe-by-default). The hot-path cost is a single hash over bytes already in memory; profiling showed the overhead < 1% for typical workloads. Callers processing trusted local packs can opt out with `verifyHash: false`. A mismatched hash throws `OBJECT_HASH_MISMATCH`.

### 5.2 `writeObject` (§7.2)

```typescript
export function writeObject(
  ctx: Context,
  object: GitObject,
): Promise<ObjectId>;
```

**Contract.**

- Serializes the object via `serializeObject(object, ctx.hashConfig)` (note: `HashConfig`, not `HashService` — Phase 4 `Context` gains a `readonly hashConfig: HashConfig` field, tracked in §14.16). Computes SHA via `ctx.hash.hashHex`. Writes a **loose object** at `.git/objects/xx/yyy` (packfile writes are a Phase 8 clone/push concern, not Phase 7).
- **Parent-directory creation.** `ctx.fs.mkdir('{gitDir}/objects/xx')` is invoked BEFORE `writeExclusive`; the Phase 4 port contract for `mkdir` already implies `mkdir -p` semantics (single-arg signature, "Create directory and all parents"). `EEXIST` / `FILE_EXISTS` on the mkdir is treated as success. Two concurrent `writeObject` calls for the first-ever object in a prefix therefore race harmlessly on the directory.
- **Idempotent via `writeExclusive`, not check-then-write, not temp+rename.** The write path is `ctx.fs.writeExclusive(path, bytes)` and catches `FILE_EXISTS` as success — never calls `fs.exists` before writing, never uses the `atomic-write.ts` helper (that helper is reserved for `updateRef` which needs CAS semantics). `writeExclusive` on a loose object is safe because: (1) content-addressed storage guarantees byte-equality on collision, so a partial half-written file is not possible — `writeExclusive` atomically creates-or-fails, no half-state; (2) the `FILE_EXISTS` signal is the idempotence success case. If future platforms prove `writeExclusive` is NOT atomic (i.e., leaves a partially-written file on crash mid-write), a Phase 11 hardening MAY switch loose writes to temp+rename. Not required in v1.
- **ENOENT retry contract (Phase 4 port reinforcement).** If `writeExclusive` fails with `FILE_NOT_FOUND` on the parent directory (concurrent `git gc` removed `objects/xx/` between our `mkdir` and the `writeExclusive` call), the Phase 4 port contract MUST retry: re-run `mkdir` once and re-run `writeExclusive`. On a second `FILE_NOT_FOUND`, propagate the error — the filesystem is pathological. Tracked as a Phase 4 port-contract reinforcement in §14.17.
- **Symlink-safe write (Node adapter obligation).** The Phase 4 `FileSystem.writeExclusive` contract MUST reject writes where any ancestor directory of the target path is a symlink pointing outside `gitDir`. The Node adapter implements this via `openat`-style primitives or by `lstat`-walking the ancestor chain before opening the write target. This closes a symlink-attack on `.git/objects/xx/` (attacker replaces the fanout directory with a symlink to an external path). Tracked as a Phase 4 port-contract reinforcement — the test lives in Phase 4's FileSystem test suite; Phase 7 trusts the port.
- Compresses via `ctx.compressor.deflate`.

**Ports used.** `ctx.hash.hashHex`, `ctx.compressor.deflate`, `ctx.fs.write` / `ctx.fs.writeExclusive` / `ctx.fs.rename` / `ctx.fs.mkdir`.

**Invariants.**

- The returned `ObjectId` is the id carried on the input `object`. If `object.id` is populated and it differs from the computed hash, throws `OBJECT_HASH_MISMATCH` (forbid writing an object with a wrong declared id).
- **Size discipline (from §15.5 Phase 5 obligation):** `resolved-merged` outcomes carry `bytes` that Phase 7 hashes and writes. `writeObject` is the write path; it enforces no bespoke size cap (the content merger already rejected >`MAX_CONFLICT_OUTPUT_BYTES`).

### 5.3 `readBlob` (§7.5)

```typescript
export function readBlob(
  ctx: Context,
  id: ObjectId,
): Promise<Blob>;
```

**Contract.**

- Thin wrapper: `const obj = await readObject(ctx, id); if (obj.type !== 'blob') throw UNEXPECTED_OBJECT_TYPE; return obj;`.
- Throws `UNEXPECTED_OBJECT_TYPE{expected: 'blob', actual: obj.type}`.
- No caching beyond what `readObject` provides.

### 5.4 `readTree` (§7.3)

```typescript
export function readTree(
  ctx: Context,
  ref: ObjectId | RefName,
): Promise<Tree>;
```

**Contract.**

- If `ref` is an `ObjectId` (branded-string check via known hex-length pattern), calls `readObject` directly.
- If `ref` is a `RefName`, calls `resolveRef(ctx, ref, { peel: true })` first, then `readObject`.
- When the resolved object is a `Commit`, automatically peels to `commit.data.tree` via one additional `readObject` call (convenience: `readTree('HEAD')` returns the HEAD commit's tree, not a Commit object). When it's a `Tag`, applies `peelOneLevel` recursively until it hits a Tree or Commit; Commit then peels to its tree.
- Throws `UNEXPECTED_OBJECT_TYPE{expected: 'tree', actual: obj.type}` if peel terminates at a blob.

**Ports used.** Via delegated primitives.

### 5.5 `writeTree` (§7.4)

```typescript
export function writeTree(
  ctx: Context,
  entries: ReadonlyArray<TreeEntry>,
): Promise<ObjectId>;
```

**Contract.**

- Builds a `Tree` domain object: `{ type: 'tree', id: <computed later>, entries: sortTreeEntries(entries) }`.
- Validates: no duplicate names; no `''`, `'.'`, `'..'`; no `/` in names (domain parse enforces on read — write enforces here). Throws `INVALID_TREE_ENTRY`.
- Enforces entries count ≤ `MAX_FLAT_TREE_ENTRIES` (1M — Phase 5 cap). Exceeding throws `TREE_ENTRY_LIMIT_EXCEEDED`.
- Delegates to `writeObject`.

**Invariants.**

- Input `entries` is always re-sorted (byte-order with virtual `/` for directories) — matches git's expected on-disk layout.
- The resulting `Tree.id` is computed by `writeObject` via `ctx.hash`.

### 5.6 `resolveRef` (§7.8)

```typescript
export function resolveRef(
  ctx: Context,
  name: RefName | 'HEAD',
  options?: ResolveRefOptions,
): Promise<ObjectId>;
```

**Contract.**

- Validates `name` via `validateRefName` (§Phase 3). The Phase 3 validator rejects: empty strings, leading/trailing/double-dot (`..`), leading/trailing slash, double slash, NUL, control characters (U+0000–U+001F, U+007F), ASCII space, `~ ^ : ? * [ \\`, ending `.lock`, and `@{`. **Phase 7 reinforcement:** the primitive additionally rejects Unicode RTL/LTR override characters (U+202A–U+202E, U+2066–U+2069) that would visually reverse a ref name — tracked as a Phase 3 hardening step in §14. `'HEAD'` is allowed as a one-level ref.
- Resolution order (per §15 Phase 3 obligation):
  1. Loose ref file at `{gitDir}/{name}` — if present, parse; if symbolic, recurse up to `maxSymbolicDepth`.
  2. Packed-refs at `{gitDir}/packed-refs` — binary-search entry by name.
  3. Neither found → `REF_NOT_FOUND`.
- When `peel: true`, after resolving the `ObjectId`, reads the object and peels through tag chain until non-tag, subject to `maxPeelDepth`.
- Cycle detection: tracked visited ref names; revisit throws `REF_CYCLE_DETECTED{chain}`.
- **`maxSymbolicDepth` (default 5)** caps symbolic-ref dereferences only. **`maxPeelDepth` (default 5)** caps tag-peel steps only. The two counters are independent so neither budget is consumed by the other dimension.

**Ports used.** `ctx.fs.readUtf8`, `ctx.fs.exists`, `ctx.fs.stat` (for packed-refs mtime-based cache invalidation — see below), plus transitive `readObject` when `peel=true`.

**Packed-refs cache invalidation.** The internal `ref-store.ts` caches the parsed `packed-refs` to avoid re-parsing for every `resolveRef` in a walk. Invalidation: on each call, `stat` the file; if `mtimeNs` (nanosecond `mtime` from `ctx.fs.stat`) changed since the cached parse, re-parse. This handles the case where a sibling process (`git gc`) rewrites `packed-refs` mid-walk — stale entries cannot outlive the mtime bump. On filesystems without nanosecond mtime (some browser OPFS), fall back to per-call re-read (cache disabled — acceptable cost for correctness). Tracked as a ref-store implementation detail; no new Phase 7 contract.

**Invariants.**

- Symbolic ref target is re-validated via `validateRefName` to prevent path traversal (Phase 3 §3 trust boundary).
- **Path containment check.** After computing `{gitDir}/{resolvedTarget}`, the path MUST be verified to be prefixed by `gitDir + '/'` (lexical check on the normalized absolute path). The FileSystem port enforces the same rule at its boundary (Phase 4 ports-and-adapters.md §4.1), but `resolveRef` is the first layer that constructs the path — belt-and-braces: both layers check. Any escape throws `INVALID_REF{reason: 'target escapes gitDir'}`.
- Never reads files outside `{gitDir}/refs/**` and `{gitDir}/packed-refs` and `{gitDir}/HEAD` and `{gitDir}/{FETCH,ORIG,MERGE,CHERRY_PICK}_HEAD`.

### 5.7 `updateRef` (§7.9)

```typescript
export function updateRef(
  ctx: Context,
  name: RefName | 'HEAD',
  newId: ObjectId,
  options?: UpdateRefOptions,
): Promise<void>;
```

**Contract.** Atomic ref update — see §9 for the full atomicity protocol.

- Validates `name` via `validateRefName`.
- **Path containment check (symmetric with `resolveRef`).** Both `lockPath = {gitDir}/{name}.lock` and `refPath = {gitDir}/{name}` are verified to be prefixed by `gitDir + '/'` (lexical check on the normalized absolute path). Any escape throws `INVALID_REF{reason: 'target escapes gitDir'}` before any filesystem I/O. Belt-and-braces: the FileSystem port enforces the same rule at its boundary.
- Acquires a lock file at `lockPath` via `ctx.fs.writeExclusive` (fails with `REF_LOCKED` if the lock already exists).
- When `expected` is set, reads current value under lock; mismatch throws `REF_UPDATE_CONFLICT` and releases the lock.
- Writes new content (`serializeDirectRef(newId)`) to the lock file.
- `ctx.fs.rename` atomically replaces `{gitDir}/{name}` with the lock file.
- On any failure between `writeExclusive` and `rename`, the lock file is removed via `ctx.fs.rm` (best-effort; wrapped in try/finally).
- When `delete: true`, removes the loose ref; throws `UNSUPPORTED_OPERATION` if the ref lives only in `packed-refs` (v1 limitation).
- **Never modifies `packed-refs`** — writing to loose always wins per git's precedence rules. Cleanup / compaction is a Phase 9 `git pack-refs` concern.

### 5.8 `readIndex` (§7.10)

```typescript
export function readIndex(ctx: Context): Promise<GitIndex>;
```

**Contract.**

- **Pre-read size check.** Calls `ctx.fs.stat(indexPath)` first; if `size > MAX_INDEX_BYTES = 256 MiB`, throws `INVALID_INDEX_HEADER{reason: 'index file exceeds 256 MiB'}` without reading. Caps OOM risk from a crafted multi-gigabyte `.git/index`.
- Reads `{gitDir}/index` via `ctx.fs.read`; parses via `domain/git-index` `parseIndex`.
- If the file does not exist, returns an **empty** `GitIndex` (`{ version: 2, entries: [], extensions: [] }`) — matches git's treatment of a fresh repo with no staged files.
- Validates the trailing SHA-1 checksum against the computed SHA of the preceding bytes via `ctx.hash`. Mismatch throws `INVALID_INDEX_HEADER{reason: \`checksum mismatch: expected=${expected} actual=${actual}\`}` (re-uses the existing Phase 3 code rather than introducing a standalone `INVALID_INDEX_CHECKSUM`; see §6.1).
- Returns the parsed `GitIndex` verbatim (including opaque extensions, preserved for roundtrip fidelity).

**Ports used.** `ctx.fs.stat`, `ctx.fs.read`, `ctx.fs.exists`, `ctx.hash.hashHex`.

**Note.** `writeIndex` is deferred to Phase 9 (`add` / `commit`) because it needs the command-layer orchestration (stat-cache integration, extension preservation rules). Phase 7 provides the read side only — matches the BACKLOG scope.

### 5.9 `createCommit` (§7.11)

```typescript
export function createCommit(
  ctx: Context,
  input: CreateCommitInput,
): Promise<ObjectId>;
```

**Contract.**

- Validates `input.tree` and every parent id is a valid `ObjectId` (re-runs `ObjectId.from` — branded types get rebuilt at the boundary).
- Validates `input.author` and `input.committer` via `parseIdentity(serializeIdentity(...))` roundtrip (fails on malformed identity). **Embedded newlines** (`\n`, `\r`) and NUL (`\0`) in `.name`, `.email`, or `.timezone` MUST cause the roundtrip to throw `INVALID_IDENTITY{reason: 'name/email/timezone contains forbidden control character'}`. This is a Phase 1 domain contract that `serializeIdentity` is required to enforce — closes identity-field header injection (an attacker supplying `author.name = "Evil\ncommitter Other <o@o>"` would otherwise inject a fake `committer` line into the raw commit bytes). If Phase 1's `serializeIdentity` does not reject these today, tracked as a Phase 1 hardening step in §14.
- Validates `input.message` for embedded NUL bytes (`\0`) — reject with `INVALID_COMMIT{reason: 'message contains NUL'}`. Embedded newlines and UTF-8 are allowed (git accepts both).
- **Size cap.** `new TextEncoder().encode(input.message).byteLength` MUST NOT exceed `MAX_COMMIT_MESSAGE_BYTES = 16 * 1024 * 1024`. Exceeding throws `INVALID_COMMIT{reason: 'message exceeds 16 MiB'}`. Enforced before any further validation so large inputs short-circuit cheaply. Boundary tests at just-under / at / just-over in §11.10.
- Builds the domain `Commit`: `{ type: 'commit', id: <placeholder>, data: { tree, parents, author, committer, message, gpgSignature?, extraHeaders: extraHeaders ?? [] } }`.
- Delegates to `writeObject`, which computes the canonical id and writes the loose object.

**Parent verification** (defense-in-depth, optional). The primitive does **not** verify that `input.tree` or `input.parents[i]` exist in storage — that would force a read per call on the hot `commit` path. Phase 9's `commit` command is responsible for pre-validation (it has natural opportunities: `writeTree` produces the tree id locally, and parents come from `resolveRef` which already fetched them).

### 5.10 `walkCommits` (§7.6)

```typescript
export function walkCommits(
  ctx: Context,
  options: WalkCommitsOptions,
): AsyncIterable<Commit>;
```

**Contract (laziness + cancellation — see §8).**

- `from` is required; empty array throws `INVALID_WALK_INPUT`.
- `from` / `until` contain already-resolved `ObjectId`s. Callers who have a ref name resolve it via `resolveRef` first — keeps `walkCommits` stateless w.r.t. refs.
- Implementation is an `async function*`. Ports are touched only when the consumer pulls.
- Walk orders:
  - `topo` (default): lazy Kahn-style. Emit a commit only after all of its yet-unseen parents are either emitted or queued. Uses an internal BFS with a pending-count map. Deterministic across runs.
  - `date`: max-heap keyed by `commit.data.committer.timestamp`. Ties broken by lexicographic `ObjectId`.
  - `first-parent`: pure linear walk through `commit.data.parents[0]`.
- `until`: a commit whose id appears in `until` is NOT yielded; its parents are NOT explored. Multiple `until` stops each act as a wall.
- On `ctx.signal.aborted`: the next yield-boundary check rejects with `OPERATION_ABORTED`. Pending state is discarded; consumers' `for await … of` triggers cleanup per Phase 6 §6.11.
- Consumer `break` / `return()` → generator's cleanup runs; `ctx.deltaCache` is untouched (it is long-lived).

**Invariants.**

- Every yielded `Commit` has already been parsed (`readObject` did the work).
- No duplicate commits (visited-set guard on `ObjectId`).
- **Seed count cap.** `from.length` MUST NOT exceed `MAX_WALK_SEEDS = 1024`. Exceeding throws `INVALID_WALK_INPUT{reason: 'too many seeds'}` synchronously at the factory invocation (before the first yield), preventing hostile input from stalling the event loop during seed admission. The cap is sized to cover realistic multi-branch walks (a mono-repo with ~1000 active branches) with headroom.
- **Shallow repositories** — when `options.ignoreMissing === false` (default), a missing parent throws `OBJECT_NOT_FOUND`. When `options.ignoreMissing === true`, the walker skips the missing parent but still yields the child commit normally; the child's `.parents` list retains the absent id so callers can detect shallow-boundary commits by cross-referencing yielded ids. **Missing ids are recorded in a `missingSet` (distinct from the yielded visited-set)** — the first `OBJECT_NOT_FOUND` catches the read; subsequent references to the same missing id short-circuit without re-attempting the fs read. This prevents O(N) fs round-trips when many commits reference the same missing ancestor (common in shallow clones where the boundary is a single grafting parent).
- **Seeding order (multi-id `from`).** All `from` ids are admitted to the ready-set before the first yield; `ctx.signal.aborted` is checked between each admission (abort latency ≈ 1024 checks max). Within a seed, the chosen `order` (topo / date / first-parent) determines traversal; across seeds, visited-set dedup guarantees each `ObjectId` is yielded at most once. Caller-supplied `from` array order is preserved as the tie-breaker when two seed trees share no ancestry and `order === 'topo'`.
- **Hash verification on reads is the caller's choice.** The walker does NOT silently override `verifyHash` — every `readObject` call inherits the safe default (`true`). Callers who have profiled a walk-heavy path and confirmed the pack is trusted can opt out per-walk via `WalkCommitsOptions.verifyHash: false`. Defaulting to `true` guarantees that malicious or corrupted commits in the reachable graph (altered parents, altered tree pointer, altered author) throw `OBJECT_HASH_MISMATCH` instead of being silently yielded. The observed overhead is a single hash-over-bytes-already-in-memory per commit — profiling on realistic mono-repos shows < 2% walk-time impact.

**Ports used.** Via `readObject` + `resolveRef` per exception list §3.1.

### 5.11 `walkTree` (§7.7)

```typescript
export function walkTree(
  ctx: Context,
  treeIdOrObject: ObjectId | Tree,
  options?: WalkTreeOptions,
): AsyncIterable<WalkTreeEntry>;
```

**Contract (Phase 5 §15.1 obligation — sorted FlatTree).**

- Accepts either a tree `ObjectId` (walker reads it) or a pre-parsed `Tree` (walker re-uses it).
- Yields every tree/blob/symlink/gitlink entry reachable from the root, in **byte-order on path** (using `domain/diff/path-compare.ts` `comparePaths`). This is the ordering that `FlatTree` consumers require (§15.1 Phase 5 contract).
- `recursive: true` (default): on a DIRECTORY entry, the walker recurses into its subtree (which is read via `readObject`). Subtree entries are spliced into the yielded stream in byte-order, so the overall order is the same as a sorted-flat dump.
- `recursive: false`: yields the root's entries only.
- **Cycle detection: descent-stack (NOT a global visited-set).** Legitimate git repositories frequently have shared subtrees — two directories pointing to the same subtree `ObjectId` is the normal, storage-efficient case (e.g. `src/` and `test/src/` with identical contents). A global visited-set would false-positive-reject these. Instead, the walker maintains a **stack of `ObjectId`s on the current root-to-leaf descent path**. An `ObjectId` appearing in the stack when entering a subtree throws `TREE_CYCLE_DETECTED{ id }` (a real cycle requires a tree to appear in its own ancestor path — impossible in a well-formed repo, attacker-crafted otherwise). Siblings sharing an id are fine; the stack pops on recursion return.
- `maxDepth` and `maxEntries` guards (§4.7).
- **Gitlink discipline (§15.4 Phase 5):** entries with `mode === '160000'` are yielded like any other entry but the walker does NOT recurse into them (gitlinks point to a foreign repo). Consumers that want submodule content call `walkTree` again on the gitlink's target repo.
- **Symlink discipline:** entries with `mode === '120000'` are yielded; the walker does NOT follow the symlink target (that's a Phase 9 `checkout` concern — see §15.3 Phase 5 symlink validation).
- On `ctx.signal.aborted`: checked between outer yields and between inner subtree reads.

**Composition with domain `FlatTree`:**

```typescript
async function toFlatTree(
  ctx: Context,
  root: ObjectId,
): Promise<FlatTree> {
  const entries = new Map<FilePath, FlatTreeEntry>();
  for await (const entry of walkTree(ctx, root)) {
    entries.set(entry.path, { id: entry.id, mode: entry.mode });
  }
  return { entries };
}
```

The resulting `Map` is insertion-order = byte-order because walkTree yields in byte-order — satisfies Phase 5 §15.1.

### 5.12 `diffTrees` (§7.12)

```typescript
export function diffTrees(
  ctx: Context,
  oldInput: DiffTreesInput,
  newInput: DiffTreesInput,
  options?: DiffTreesOptions,
): Promise<TreeDiff>;
```

**Contract (the "bridge to Phase 5" §7.12).**

- Normalizes inputs via `resolveTreeInput`: `ObjectId` → `readObject` → `Tree` (narrowed), `Tree` → passthrough, `undefined` → passthrough.
- Delegates to domain `diffTrees(oldTree, newTree)` for the structural walk.
- When `detectRenames: true`, runs domain `detectRenames(diff.changes, options.renameOptions)` as a post-processing pass.
- Returns the resulting `TreeDiff`.

**Not the same as `diffTreesRecursive`.** §15.7 Phase 5 notes the recursive (subtree-descending) variant as a Phase 7 responsibility. V1 `diffTrees` primitive compares top-level trees only; `diffTreesRecursive` (which yields cross-subtree changes with full paths) is **deferred to Phase 9** alongside the `diff` command, because its output shape is a streaming union that `diffTrees` alone doesn't model. Captured in §13 open questions.

**Ports used.** Via `readObject` when `DiffTreesInput` is `ObjectId`.

---

## 6. Error Model

Primitives throw `TsgitError` (domain class) carrying a discriminated-union data payload. **Phase 7 error codes are distributed into the existing domain sub-unions that already own the related concept** — no new application-tier error file, no `declare module` augmentation, no dep-cruiser relaxation. This keeps the pattern uniform with Phases 2–5 and preserves `extractDetail` exhaustiveness in `domain/error.ts`.

### 6.1 New error codes — distributed by concept

```typescript
// domain/objects/error.ts — object identity + lookup + tree structure
| { readonly code: 'OBJECT_NOT_FOUND'; readonly id: ObjectId }
| { readonly code: 'OBJECT_HASH_MISMATCH'; readonly expected: ObjectId; readonly actual: ObjectId }
| { readonly code: 'UNEXPECTED_OBJECT_TYPE'; readonly expected: ObjectType; readonly actual: ObjectType; readonly id: ObjectId }
| { readonly code: 'TREE_CYCLE_DETECTED'; readonly id: ObjectId }
| { readonly code: 'TREE_DEPTH_EXCEEDED'; readonly depth: number }
| { readonly code: 'TREE_ENTRY_LIMIT_EXCEEDED'; readonly count: number; readonly limit: number }

// domain/storage/error.ts — pack/delta pipeline
| { readonly code: 'DELTA_CHAIN_TOO_DEEP'; readonly depth: number }

// domain/refs/error.ts — ref resolution + update
| { readonly code: 'REF_NOT_FOUND'; readonly name: RefName }
| { readonly code: 'REF_CHAIN_TOO_DEEP'; readonly depth: number; readonly chain: ReadonlyArray<RefName> }
| { readonly code: 'REF_CYCLE_DETECTED'; readonly chain: ReadonlyArray<RefName> }
| { readonly code: 'REF_LOCKED'; readonly name: RefName }
| { readonly code: 'REF_UPDATE_CONFLICT'; readonly name: RefName; readonly expected: ObjectId | 'absent'; readonly actual: ObjectId | 'absent' }

// domain/git-index/error.ts — index-parsing integrity is already covered by
// INVALID_INDEX_HEADER{reason} (Phase 3). The trailing-SHA checksum failure
// re-uses that code with a structured reason; no new code is added. Example:
//   throw invalidIndexHeader(`checksum mismatch: expected=${expected} actual=${actual}`);
// This was reconsidered from a standalone INVALID_INDEX_CHECKSUM code after
// round 1 review — callers that need to switch on checksum-vs-header can parse
// the reason string; a separate code was API bloat without justification.

// domain/error.ts (NEW application-tier union) — cross-cutting primitives codes.
// Lives alongside (but separate from) AdapterError. Phase 7 adds:
export type ApplicationError =
  | { readonly code: 'INVALID_WALK_INPUT'; readonly reason: string }
  | { readonly code: 'OPERATION_ABORTED' };
// And `TsgitErrorData = ... | ApplicationError` is widened by adding the import.
```

### 6.2 Integration

Each error code lives in the sub-domain's `error.ts` alongside existing codes (`INVALID_OBJECT_ID`, `INVALID_REF`, `INVALID_INDEX_HEADER`, etc.). `domain/error.ts` wires them in:

1. **New `ApplicationError` file-local union** (declared in `domain/error.ts` alongside `AdapterError`). Holds `INVALID_WALK_INPUT` and `OPERATION_ABORTED`. The union is exported so primitive tests can import the factory and code names.
2. **`TsgitErrorData` widens** — for sub-domain codes, the existing `import type { <NewError> } from './<sub>/error.js';` chain picks them up automatically (no new lines needed for `PrimitivesError`, since there is no such union). For `ApplicationError`, add it to the `TsgitErrorData = ... | ApplicationError` union in `domain/error.ts`.
3. **`extractDetail` switch in `domain/error.ts`** gains one `case` per new code, populating the human-readable message. Exhaustiveness is enforced by the `_exhaustive: never` line at the switch tail — failing to add a case produces a TypeScript compile error, so the build gate catches drift.
4. **Factory exports.** Each new code gets a named factory in its home file (e.g. `objectNotFound(id): TsgitError` in `domain/objects/error.ts`, `invalidWalkInput(reason): TsgitError` in `domain/error.ts`, etc.) — matching the existing `fileNotFound`, `invalidIndexHeader` patterns.

**Rationale.** Phase 7 codes describe domain-concept failure modes (an object is missing, a ref is locked, a tree has a cycle), not tier-2 orchestration concerns. Putting them in the domain is semantically correct, avoids `declare module` augmentation, and keeps `extractDetail` exhaustiveness. The two genuinely cross-cutting codes (`INVALID_WALK_INPUT`, `OPERATION_ABORTED`) are **not** folded into `AdapterError` — adapters never throw them. They go into a new, narrowly-scoped `ApplicationError` union exported from `domain/error.ts`.

**`extractDetail` update.** Phase 7 step 2 adds one `case` per new code in the `domain/error.ts` `extractDetail` switch. Example: `case 'OBJECT_NOT_FOUND': return \`object not found: ${data.id}\`;`. Failing to add a case produces a compile error via the `_exhaustive: never` line — the build enforces exhaustiveness.

**Factory sites.** Primitives import factories by name (e.g. `import { objectNotFound } from '../../domain/objects/error.js'`), matching the existing pattern where `adapters/node/` imports `fileNotFound` from `domain/error.ts`.

**Pre-existing codes reused (not "new" in §6.1).** Several primitives throw codes that already exist from Phases 1–5 and should NOT be re-added:
- `INVALID_COMMIT{reason}` — existing Phase 1 code (`domain/objects/error.ts`), reused by `createCommit` (§5.9).
- `INVALID_IDENTITY{reason}` — existing Phase 1 code (`domain/objects/error.ts`), reused by `createCommit` (§5.9).
- `INVALID_REF{reason}` — existing Phase 3 code (`domain/refs/error.ts`), reused by `resolveRef` / `updateRef` for both the pre-existing validation cases and the Phase 7 path-containment checks.
- `INVALID_INDEX_HEADER{reason}` — existing Phase 3 code, reused by `readIndex` for both structural parse errors and the Phase 7 checksum / size-cap cases (§5.8).
- `UNSUPPORTED_OPERATION{operation, reason}` — existing `AdapterError` code, reused by `updateRef` for delete-packed-only (§5.7).

Step 2 (Distributed error codes) only adds cases to `extractDetail` for the **new** codes listed in §6.1 — existing codes already have cases. 14 new codes = 14 new `case` clauses.

**`UNSUPPORTED_OPERATION` in `updateRef`.** When a caller asks `updateRef` to delete a packed-only ref, the primitive rejects with the existing `AdapterError.UNSUPPORTED_OPERATION{ operation: 'delete-packed-ref', reason: 'deleting packed-only refs requires packed-refs rewrite (Phase 9)' }`. The `operation` and `reason` fields are populated by the primitive's factory call — no new code added. See §5.7.

---

## 7. Context Plumbing

Every primitive takes `Context` as its first argument.

- **Read-only.** Primitives never mutate `ctx` (it's frozen by `createContext`, but discipline in primitive code still applies — no `(ctx as any).foo = ...`).
- **Never captured past the primitive's scope.** Primitives don't stash `ctx` in module-level caches. The `pack-registry` helper accepts `ctx.fs` by reference per-call; long-lived state (open `.idx` files, LRU) lives on `ctx.deltaCache` or is instantiated per-call.
- **Single aggregate.** Primitives destructure only the ports they need (e.g., `const { fs, compressor, hash } = ctx` inside `readObject`). No primitive depends on `ctx.transport` — transport is a Phase 8 concern consumed by the clone / fetch / push commands (Phase 9).
- **Abort signal.** `ctx.signal?.aborted` is polled (a) before each filesystem read, (b) between yields in walkers, (c) before long compute steps (e.g., multi-MB delta reconstruction). An aborted signal throws `OPERATION_ABORTED`.

### 7.1 Context lifetime and concurrency

Primitives are safe to invoke concurrently against the same `ctx` (the ports' contract says so — FileSystem operations are individually atomic where the adapter guarantees; HashService creates fresh `Hasher` per call). However, **`updateRef` on the same ref from two concurrent primitives is not safe** beyond the lock-file contract: the second call gets `REF_LOCKED`. Callers orchestrating parallel writes (Phase 9 `fetch --all`) must serialize per-ref.

### 7.2 Context-owned delta cache

The delta-base LRU is hung off `Context` itself (`ctx.deltaCache`), not threaded per call. Every `readObject` in the same `Context` shares the same cache — short-lived per-call calls benefit from cross-call reuse without the caller having to wire it. Thread safety is a non-issue under the single-JS-thread invariant (the cache is never concurrently mutated because `readObject` is the only writer and all primitives run on the same event loop).

The `LruCache<V>` API is defined in `src/domain/storage/lru-cache.ts` (Phase 2): keys are `string` (ObjectId is a branded string, so it assigns freely), `set(key, value, byteSize)` takes the byte size per call, `createLruCache<V>(maxSizeBytes): LruCache<V>` is the factory. Only a byte cap exists today — an entry cap is tracked as a Phase 2 amendment in §14.11 (see security §S-H-3).

```typescript
// ctx factory (adapters/node, browser, memory) wires the cache:
import { createLruCache } from '../../../domain/storage/index.js';

const ctx: Context = {
  fs, hash, compressor, http, progress,
  config,
  deltaCache: createLruCache<Uint8Array>(16 * 1024 * 1024), // 16 MiB byte cap
};

// primitives consume it (via readObject internals):
for await (const commit of walkCommits(ctx, { from })) {
  // every readObject under the hood shares ctx.deltaCache
}
```

Primitives never construct caches themselves; they read `ctx.deltaCache` when resolving deltas. The Phase 4 `Context` type gains a **required** `readonly deltaCache: LruCache<Uint8Array>` field (new in Phase 7 — no fallback path, no optional marker). Any test or adapter building a raw `Context` object MUST wire the cache. This is a one-line addition to the three existing factories (`createNodeContext`, `createBrowserContext`, `createMemoryContext`) and to every `createMemoryContext`-based test fixture — tracked in §14.10. Making the field required eliminates the architectural contradiction (optional-with-fallback would let adapters silently ship without the security mitigation from §14.11) and keeps the primitive contract simple: primitives always have a cache to consult.

---

## 8. Walker Semantics

Both `walkCommits` and `walkTree` are `async function*` implementations that obey the Phase 6 operator contract (§6.11): source iteration uses `for await … of`; generator-cleanup cascades via `IteratorClose`. This section pins the AsyncIterable contract.

### 8.1 Laziness

The returned `AsyncIterable<T>` performs **zero I/O** until the consumer pulls:

```typescript
const stream = walkCommits(ctx, { from }); // zero side effects
const first = await stream[Symbol.asyncIterator]().next(); // first readObject call happens here
```

This matches Phase 6 §5.5 `take(0)` — "source's `next()` is never called". The cost: a walker constructor is cheap; the cost of the first yield covers ref resolution + root object read.

### 8.2 Cancellation via consumer break

Consumers break / return / throw out of the `for await … of` loop. The runtime invokes `source[Symbol.asyncIterator]().return()`, which cascades into the generator's `finally` block. Cleanup responsibilities:

- `walkCommits`: clears the pending-queue; drops references to cached commits.
- `walkTree`: clears the descent-stack (the per-descent `ObjectId` list used for cycle detection per §5.11 — NOT a global visited-set).

Neither walker holds open file handles between yields — `FileSystem.read` returns bytes synchronously from the adapter's perspective (Node: `fs.promises.readFile` closes the handle internally; Browser: OPFS `FileSystemFileHandle` is closed after `getFile` returns). No explicit cleanup of file handles is therefore required.

### 8.3 Cancellation via `ctx.signal`

Between each yield (both walkers):

```typescript
if (ctx.signal?.aborted) {
  throw operationAborted();
}
yield nextValue;
```

The signal is re-checked after every `readObject` call. This gives a worst-case latency of one commit / one subtree read between signal-set and generator-throw.

### 8.4 Composition with Phase 6 operators

Walkers compose with all non-terminal operators per Phase 6's pattern:

```typescript
const authored = pipe(
  walkCommits(ctx, { from: [headId] }),
  filter((c) => c.data.author.name === 'alice'),
  take(20),
  toArray,
);
```

The `take(20)` triggers a `return()` on the upstream walker after 20 commits — the walker's `finally` runs, cleaning up the pending queue. Proven by Phase 6 §7.5 cleanup tests; Phase 7 inherits the guarantee because it uses `async function*` per §6.11.

### 8.5 Determinism

Both walkers are deterministic given a fixed repo state:

- `walkCommits('topo')`: parents visited in `commit.data.parents` order; ties in the topological ready-set broken by lexicographic `ObjectId`.
- `walkCommits('date')`: ties broken by lexicographic `ObjectId`.
- `walkCommits('first-parent')`: trivially deterministic.
- `walkTree`: byte-order on `path` (enforced by merge-sort of entries + recursive subtree insertion at the right position).

Determinism is a property-test target (§11).

### 8.6 Explicit no-op for empty inputs

- `walkCommits({ from: [] })` → throws `INVALID_WALK_INPUT` (empty start is almost always a caller bug, per Phase 6 §5.5 "validation at call time" rationale).
- `walkCommits({ from: [headId], until: [headId] })` → yields nothing (the first commit is the boundary).
- `walkTree` on an empty tree → yields nothing; no error.

---

## 9. Atomicity Guarantees (`updateRef`)

`updateRef` is the only mutating primitive with a multi-step atomicity contract. §3.4 Phase 3 specified the domain-layer serialization; this section pins the Phase 7 I/O protocol.

### 9.1 Protocol

```
1. Validate ref name            → validateRefName(name)
2. Compute lock path             → {gitDir}/{name}.lock
3. Acquire lock                  → ctx.fs.writeExclusive(lockPath, bytes) — fails REF_LOCKED if exists
4. CAS check (optional)          → read current value, compare vs options.expected
5. Serialize new value           → serializeDirectRef(newId)
6. Write new value to lock file  → ctx.fs.write(lockPath, newBytes) — overwrites the CAS-check bytes
7. fsync the lock file           → (not directly a port op — see §9.2)
8. Rename lock → ref             → ctx.fs.rename(lockPath, refPath) — atomic on POSIX
9. On any error between 3–8      → ctx.fs.rm(lockPath) (best-effort)
```

### 9.2 fsync is NOT a port operation in v1

The `FileSystem` port has no `fsync`. Git itself calls `fsync` on the lock file before rename for durability (crash safety: rename survives; content is persisted). Phase 7 v1 **does not fsync** — trade-off:

- **Pros of no fsync:** Smaller port surface; browser has no equivalent; test adapters have no analog.
- **Cons:** On power loss, a recently-updated ref may roll back to its previous value despite `rename` appearing to succeed. Acceptable for v1 (matches git with `--no-fsync`).
- **Future:** `fsync` added to `FileSystem` port in Phase 11 (ADR noted).

### 9.3 Atomicity on Browser (OPFS)

`ctx.fs.rename` on OPFS is **emulated** (read + write + rm per §Phase 4 ports design). The "atomic replace" contract degrades to:

- Window 1: `{refPath}` has old value, `{lockPath}` has new value.
- Window 2: `{refPath}` has new value (after emulated write), `{lockPath}` still exists.
- Window 3: `{lockPath}` is removed.

Crash between windows 1 and 2 leaves the lock file as stale evidence — next `updateRef` call hits `REF_LOCKED`. Recovery is a manual / Phase 9 concern (`git gc` style cleanup). Documented in §13 open questions.

### 9.4 CAS semantics

```typescript
await updateRef(ctx, 'refs/heads/main', newId, { expected: oldId });
```

Implements "compare-and-swap". Under the lock, read current ref value via `resolveRef(ctx, name, { peel: false })`. Compare with `expected`:

- `expected === oldId` and current equals `oldId` → proceed.
- `expected === 'absent'` and current does not exist → proceed.
- Any mismatch → throw `REF_UPDATE_CONFLICT{ expected, actual }`, release lock.

This is the primitive git fetch / push uses to reject concurrent updates.

**CAS scope (documented limitation).** The lock file + CAS pair serializes only *tsgit-vs-tsgit* callers using the same `.lock` discipline. A native `git` process writing to the same `refPath` between the lock acquisition and the CAS read will not be blocked (POSIX `O_EXCL` lock files are advisory; git uses the same convention). Callers mixing tsgit with native `git` on the same repo must coordinate at a higher layer (OS advisory lock, external mutex). This is identical to git's own CAS semantics — not a weakness unique to tsgit.

### 9.5 Information disclosure in `REF_UPDATE_CONFLICT`

The error carries `expected` and `actual` `ObjectId` values. Both are caller-relevant for retry logic, but higher-level Phase 9 APIs that serialise `TsgitError` into logs or HTTP responses SHOULD redact `actual` before surfacing — a remote client probing `updateRef` could otherwise enumerate current ref values. This is a Phase 9 concern; the domain error shape stays unchanged.

---

## 10. Object Lookup Pipeline (`readObject` internals)

§7.1 is the most complex primitive. This section pins the order-of-operations for reviewers and implementers.

### 10.1 Pipeline

```
1. Check ctx.signal.aborted       → throw OPERATION_ABORTED
2. Compute loose path              → computeLooseObjectPath(id) → "xx/yyy..."
3. fullPath = `${gitDir}/objects/${loosePath}`
4. Try loose object
   a. ctx.fs.exists(fullPath)?
   b. If yes: read, inflate, parseHeader, parseObject, return.
   c. If no: continue.
5. Try pack objects (via pack-registry helper)
   a. pack-registry lazily scans {gitDir}/objects/pack/*.idx on first access.
   b. For each PackIndex (in registry order — scan order; order is deterministic per adapter):
      i.   lookupPackIndex(idx, id) → { offset } | undefined
      ii.  If hit: delegate to iterative delta resolver (§10.1 note below).
6. Not found in any source → throw OBJECT_NOT_FOUND.
```

**Iterative delta resolution (required).** When a pack entry is OFS_DELTA or REF_DELTA, the algorithm MUST follow Phase 2 `object-storage.md §8.6` — a two-phase iterative walker, NOT a recursive `readObject` call. Phase 1: walk the delta chain collecting instruction buffers into an array, consulting `ctx.deltaCache` at each step; stop on a non-delta base OR a cache hit; depth counter is incremented inside this loop and throws `DELTA_CHAIN_TOO_DEEP{depth: 51}` when exceeded. Phase 2: apply the collected instructions bottom-up via `applyDelta`, populating the cache with each intermediate result. This keeps the JS call stack bounded regardless of chain depth and makes the depth cap enforceable before any work begins.

### 10.2 Order guarantees

- **Loose before packed** — always. Matches git's behavior. A loose object shadowing a packed one (e.g., after a local `commit`) is served first.
- **Within packs: registry scan order.** On Node this is `fs.readdir` of `.git/objects/pack/` (lexicographic on most filesystems). On Memory adapter: Map insertion order. This is **not** a correctness issue — every object is in at most one pack (modulo duplicate packs which are rare and yield identical bytes); but duplicate packs with *different* byte-content for the same id is a corrupt repo and out of scope.
- **Delta chain resolution** — iterative (see §10.1 note). Base can be another delta (chain up to `MAX_DELTA_CHAIN_DEPTH = 50`). The LRU cache is consulted at each step, so a hot base (common on walk-heavy workloads) resolves in O(1) after the first read.

### 10.3 Packfile handle management

- `pack-registry` keeps parsed `PackIndex` structures in memory (they're small — fanout + sha table + offsets). The `.pack` file content is NOT loaded upfront; `readSlice` opens, reads, closes per-entry.
- Memory footprint per registered pack: `~(objectCount * 24 bytes)` for the sha+offset table. A 1 M-object pack takes ~24 MB — budget-able.
- **No file descriptors held across awaits.** Each `readSlice` call is self-contained (per §Phase 4 "file handle leak prevention" documented requirement).

### 10.4 LRU cache behavior

- **One cache per `Context`.** `ctx.deltaCache` is instantiated by the Context factory (§7.2). Every `readObject` call under the same `ctx` shares it; primitives do not construct caches.
- **Byte-bounded + entry-bounded.** Default `maxSize = 16 MiB`, `MAX_DELTA_CACHE_ENTRIES = 65_536`. Eviction fires when **either** limit is exceeded. The entry count prevents a flood of tiny base objects from evicting legitimate large bases (security §S-C-3).
- **Cache key is `ObjectId`** of the base, not `(packId, offset)` — ids are content-addressed and unique, so a base cached from pack A is valid for pack B's delta chain too.

---

## 11. Testing Strategy

Coverage target: **100%** line/branch/function/statement. Mutation target: **0** surviving non-equivalent mutants (Stryker). Follows CLAUDE.md mutation-resistant patterns (see Phase 5 §12, Phase 6 §7).

### 11.1 Conventions

Every test observes CLAUDE.md and Phase 5 / 6 conventions:

- **Given/When/Then titles.**
- **AAA bodies** (`// Arrange` / `// Act` / `// Assert`).
- **`sut` variable** for the primitive under test. For curried primitives none exist (every primitive takes `ctx` first — `sut` is the bound `(ctx, ...) => Promise<T>` exported function).
- **Specific error assertions.** Try/catch + `.data.code` + `.data.<field>` assertions; never `.toThrow(TsgitError)` alone. For walkers, `try { for await ... } catch (e) { assert (e as TsgitError).data.code === ... }`.
- **Guard clauses isolated.** Every condition in a disjunction gets its own test.
- **Memory adapter first.** Every test uses the memory adapter (`createMemoryContext`) to build a seeded repo. Node / Browser adapters are covered in Phase 11 integration tests.

### 11.2 Fixtures (`test/unit/application/primitives/fixtures.ts`)

```typescript
// Build a memory Context pre-seeded with a set of objects and refs.
export function buildSeededContext(parts: {
  readonly objects?: ReadonlyArray<GitObject>;
  readonly refs?: ReadonlyArray<{ readonly name: RefName; readonly id: ObjectId }>;
  readonly packedRefs?: ReadonlyArray<PackedRefEntry>;
  readonly index?: GitIndex;
  readonly signal?: AbortSignal;
}): Promise<Context>;

// Build a Context with a synthetic packfile containing a chain of blobs/commits.
export function buildContextWithPack(parts: {
  readonly baseObjects: ReadonlyArray<GitObject>;
  readonly deltaChains?: ReadonlyArray<DeltaChainSpec>;
}): Promise<Context>;

// Canonical tiny commit graph: root → A → B ↘   
//                                         ↓    merge
//                                      A  → C ↗
export function tinyGraph(): Promise<{
  readonly ctx: Context;
  readonly ids: { readonly root: ObjectId; readonly a: ObjectId; readonly b: ObjectId; readonly c: ObjectId; readonly merge: ObjectId };
}>;

// Tree with N entries at depth D — stress walkTree.
export function syntheticTree(breadth: number, depth: number): Promise<{
  readonly ctx: Context;
  readonly root: ObjectId;
  readonly expectedEntryCount: number;
}>;

// A FileSystem wrapper that records every call — for ordering assertions.
export function instrumentedContext(base: Context): {
  readonly ctx: Context;
  readonly calls: () => ReadonlyArray<{ readonly method: string; readonly path: string }>;
};
```

### 11.3 Per-primitive test shape

Every primitive gets its own test file. Shared patterns:

- **Happy path** — seeded context returns parsed object / commit / tree.
- **Not found** — `OBJECT_NOT_FOUND` / `REF_NOT_FOUND` with `.data.id` or `.data.name` asserted.
- **Abort signal fired before call** — throws `OPERATION_ABORTED`.
- **Abort signal fired mid-walk** — throws `OPERATION_ABORTED` after the current yield completes.
- **Type-narrowing** — `readBlob` on a commit id throws `UNEXPECTED_OBJECT_TYPE{expected:'blob',actual:'commit',id}`.
- **Cap / limit boundary** — just-under / at / just-over triples for every numeric guard (`maxDepth`, `maxEntries`, `MAX_FLAT_TREE_ENTRIES`, delta chain depth 50).
- **Memory adapter determinism** — repeated runs produce bitwise-identical output.

### 11.4 `readObject` (§5.1) — specific invariants

- **Loose-before-pack:** seed a loose object at SHA X **and** a pack containing a DIFFERENT byte-content under SHA X. Call `readObject(X)`. Assert the loose bytes are returned. (Detects "pack-first" regression.)
- **Pack hit path:** pack-only SHA returns correctly parsed object. Includes each type (blob/tree/commit/tag).
- **OBJ_OFS_DELTA resolution:** delta entry with positive `baseDistance`, base is another entry in the same pack. Full parse asserted.
- **OBJ_REF_DELTA resolution:** delta entry with base SHA in `.idx`; base resolved via the iterative delta walker (§10.1).
- **Chain depth limit:** synthesize a chain of 51 deltas; assert `DELTA_CHAIN_TOO_DEEP{depth: 51}`. Depth 50 passes. Verifies the counter fires **inside** the phase-1 chain walk before any `applyDelta` runs.
- **LRU cache shared across calls:** two `readObject` calls under the same `ctx` (shared `ctx.deltaCache`); instrumented fs asserts base was read exactly once.
- **`verifyHash` default on — mismatch detected:** synthesize a loose file whose decompressed content doesn't hash to its path-derived id; assert `OBJECT_HASH_MISMATCH` without any options passed (proves the safe-by-default contract).
- **`verifyHash: false` opt-out:** same crafted loose file with `{ verifyHash: false }`; object is returned without error (documents the opt-out contract for trusted packs).
- **Abort before pack scan:** signal fires; `OPERATION_ABORTED`, no reads performed. (instrumentedContext asserts zero calls.)
- **Abort after hashHex (verifyHash path):** pre-arm signal to fire during the microtask after hash; assert `OPERATION_ABORTED` and no further yield. Pins the §14.8 signal-check-after-hash obligation.
- **Iterative walker cache-hit mid-chain:** synthesize a 3-deep delta where the depth-2 base is already in `ctx.deltaCache`. Assert the phase-1 walk stops at depth 2 (cache hit short-circuits), phase-2 applies only one delta. Instrumented hash asserts no redundant base re-hashing.
- **Iterative walker depth check fires pre-`applyDelta`:** synthesize a 51-deep delta chain **and** seed the LRU with only an unrelated key (no cache shortcut). Assert `DELTA_CHAIN_TOO_DEEP{depth: 51}` without any `applyDelta` call (instrumented `applyDelta` spy has zero invocations). Pins the §10.1 "counter fires before any work begins" guarantee separately from the simple depth test above.
- **Iterative walker cache eviction during deep chain:** synthesize a chain of 30 deltas whose total byte footprint exceeds the `ctx.deltaCache` capacity (e.g. each base is 2 MiB, cache is 16 MiB → eviction at depth 8). Assert the walk completes correctly (no depth-exceed error, correct final object bytes). Instrumented fs records each non-delta base read exactly once despite cache eviction — the iterative walker collects all instructions in phase-1 before applying, so a mid-chain eviction doesn't force a re-read of the original base.

### 11.5 `writeObject` (§5.2) — specific invariants

- **Idempotence:** two calls with the same object produce the same id; the second call catches `FILE_EXISTS` from `writeExclusive` and treats it as success (no `exists` pre-check, no TOCTOU window).
- **Id mismatch:** object with `{ id: 'aaa...', ... content that hashes to bbb... }` throws `OBJECT_HASH_MISMATCH`.
- **All types:** one test per blob/tree/commit/tag.
- **Atomic write visible:** after write, `readObject(id)` returns the same object.
- **Compression round-trip:** memory fs records the written bytes; `ctx.compressor.inflate(stored) === serializeObject(object)`.

### 11.6 `readBlob` / `readTree` / `writeTree` — short test batteries

- `readBlob` on non-blob → `UNEXPECTED_OBJECT_TYPE`.
- `readTree('HEAD')` → resolves HEAD → peels commit → returns tree.
- `readTree(tagId)` on annotated tag → peels tag → commit → tree.
- `writeTree([])` → empty tree (matches git's well-known empty-tree SHA).
- `writeTree` duplicates name → `INVALID_TREE_ENTRY`.
- `writeTree` exceeding `MAX_FLAT_TREE_ENTRIES` → `TREE_ENTRY_LIMIT_EXCEEDED`.

### 11.7 `resolveRef` — specific invariants

- **Loose-only:** `refs/heads/main` as loose → returns id.
- **Packed-only:** same ref in `packed-refs` → returns id.
- **Loose shadows packed:** both present with different ids → loose wins.
- **Symbolic chain:** `HEAD → refs/heads/main → <id>` — returns id.
- **Cycle:** `HEAD → refs/heads/loop → HEAD` → `REF_CYCLE_DETECTED{ chain: [...] }`.
- **Symbolic depth exceeded (isolated):** chain of 6 symbolic refs with `maxSymbolicDepth=5`, no tag peeling → `REF_CHAIN_TOO_DEEP{ depth: 6 }`. Verifies the symbolic-ref counter independently of peel.
- **Peel depth exceeded (isolated):** single symbolic ref pointing to a tag chain of 6 tags with `maxPeelDepth=5, peel: true` → `REF_CHAIN_TOO_DEEP{ depth: 6 }`. Verifies the peel counter independently of symbolic resolution. Separate from the symbolic test per CLAUDE.md guard-isolation rule.
- **Mixed chain within both caps:** 3 symbolic refs + 2 tag peels, `maxSymbolicDepth=5, maxPeelDepth=5` → succeeds (each budget consumed independently; neither exceeded). Pins the decoupling.
- **Peel — happy path:** annotated tag → `peel:true` → returns the pointed object (commit), not the tag.
- **Path escape rejected:** craft a symbolic ref whose target resolves to a path outside `gitDir` (e.g. via a name that survives `validateRefName` but joins to an external path) → `INVALID_REF{reason: 'target escapes gitDir'}`. Proves the §5.6 containment check fires before any read.
- **Invalid name:** `'..'` → `INVALID_REF` (domain validation).

### 11.8 `updateRef` — atomicity tests

- **Happy path:** new ref created from absent; subsequent `resolveRef` returns new id.
- **Lock busy:** pre-create `{name}.lock`; `updateRef` throws `REF_LOCKED`.
- **CAS hit:** `expected: oldId`, current is `oldId`; succeeds.
- **CAS miss:** `expected: oldId`, current is different; throws `REF_UPDATE_CONFLICT`; **lock file is removed**.
- **CAS `'absent'`:** ref doesn't exist, `expected: 'absent'`; succeeds.
- **CAS `'absent'` on existing ref:** throws `REF_UPDATE_CONFLICT{ expected: 'absent', actual: <id> }`.
- **Crash between write and rename:** simulate by throwing inside a wrapped fs; assert lock file is cleaned up (via try/finally).
- **Invalid ref name:** `'..'` → `INVALID_REF`.
- **Packed-only delete:** `delete:true` on packed-only ref → `UNSUPPORTED_OPERATION`.

### 11.9 `readIndex` — specific invariants

- **Empty repo:** no `.git/index` file → returns `{ version: 2, entries: [], extensions: [] }`.
- **Round-trip:** serialize an index in a test via `serializeIndex`, read back, assert deep-equal.
- **Corrupt checksum:** mutate final SHA byte → `INVALID_INDEX_HEADER` with `data.reason` matching `/checksum mismatch: expected=[0-9a-f]{40} actual=[0-9a-f]{40}/`. Asserts on the reason pattern, not on the exact string, so the test stays mutation-resistant even if the formatting tweaks.
- **Size cap boundary (MAX_INDEX_BYTES):** write a `.git/index` whose stat size is 256 MiB + 1 byte → `INVALID_INDEX_HEADER` with `data.reason` matching `/exceeds 256 MiB/`. Do NOT actually materialize 256 MiB of content; use a test-fs adapter that returns the size via `stat` without materializing the bytes (asserts the pre-read check fires on `stat`, not on `read`).
- **Extensions preserved:** synthetic extension with opaque data; read-back preserves bytes verbatim.

### 11.10 `createCommit` — specific invariants

- **Happy path:** tree + empty parents (root commit) → valid id.
- **Multiple parents:** 2+ parents (merge commit) → produces `.data.parents` in order.
- **Extra headers / gpg signature:** roundtrip through `readObject`.
- **NUL in message:** `INVALID_COMMIT{ reason: 'message contains NUL' }`.
- **Invalid author:** malformed identity → `INVALID_IDENTITY`.
- **Newline injection in author.name:** `input.author.name = "Evil\ncommitter Other <o@o.com>"` → `INVALID_IDENTITY{reason: /forbidden control character/}` at the `serializeIdentity` boundary. Parallel tests for `author.email`, `committer.name`, `committer.email`, both with `\n` and `\r`. Four isolated tests per field per character per CLAUDE.md guard-isolation rule.
- **Message size boundary (MAX_COMMIT_MESSAGE_BYTES):** just-under (16 MiB - 1 byte) passes; at (16 MiB exactly) passes; just-over (16 MiB + 1 byte) throws `INVALID_COMMIT{reason: 'message exceeds 16 MiB'}`. Three isolated tests per CLAUDE.md mutation-resistant boundary pattern.
- **Empty parents + empty extraHeaders:** produces an "initial commit" matching git's byte-for-byte output for the same inputs (golden test).

### 11.11 `walkCommits` — specific invariants

- **Empty `from`:** `INVALID_WALK_INPUT{reason: /empty/}`.
- **`from` exceeds MAX_WALK_SEEDS (1024):** factory throws `INVALID_WALK_INPUT{reason: /too many seeds/}` synchronously (before any yield). Boundary triple: at 1024 passes; at 1025 throws.
- **Seeding order with disjoint histories:** two unrelated root commits `[A, B]` (no common ancestor), `order: 'topo'` → yields `[A, ...descendantsOfA, B, ...descendantsOfB]` in caller-supplied `from` order. Reverse to `[B, A]` and assert yield order flips. Pins the §5.10 tie-breaker.
- **Single-commit walk:** `from: [rootId]`, no parents → yields root, then ends.
- **Linear walk (topo):** 5 commits A→B→C→D→E; yields [E, D, C, B, A].
- **Merge walk (topo):** diamond graph; yields in topo order, no duplicates.
- **`until` boundary:** `from: [headId], until: [rootId]` → yields all except root.
- **Date order on concurrent commits:** two commits with different committer dates → date-descending.
- **First-parent:** merge commit's second parent is NOT visited.
- **Missing parent (strict):** a parent id not in storage with `ignoreMissing=false` → `OBJECT_NOT_FOUND`.
- **Missing parent (ignored):** a parent id not in storage with `ignoreMissing=true` → child is yielded normally, missing parent is skipped in traversal, other parents still walk.
- **Shallow-boundary detection:** under `ignoreMissing=true`, callers cross-reference `commit.parents` against yielded ids to identify shallow-boundary commits. Test asserts the missing id stays in the emitted commit's `.parents` list.
- **`missingSet` short-circuits repeat misses:** under `ignoreMissing=true`, synthesize 10 commits each referencing the same missing ancestor `A`. Instrumented fs records exactly ONE `read` attempt for `A` (the first) — subsequent encounters hit the `missingSet`. Pins the §5.10 short-circuit invariant.
- **Abort signal mid-walk:** signal fires; generator throws `OPERATION_ABORTED` at the next yield.
- **Consumer break cascades cleanup:** `take(3)` over a 1000-commit chain; instrumented fs records 3 reads (not 1000). Proves Phase 6 §6.11 cascade.
- **`ctx.deltaCache` shared across walk:** instrumented walk over a pack with shared base objects; fs base-read count matches expected LRU behavior (one base read per distinct base, not per delta).
- **Property: no duplicate yields** — for any graph and any order, emitted ids form a set.

### 11.12 `walkTree` — specific invariants

- **Empty tree:** yields nothing.
- **Flat tree:** 3 blobs at root → yields 3 entries in byte-order.
- **Nested tree:** 2 subdirs + 2 files → 2 files + recursed subdir contents, byte-order interleaved.
- **`recursive: false`:** nested tree → yields only top-level entries (DIRECTORY entries yielded but children not pulled).
- **`maxDepth`:** depth-6 tree with `maxDepth: 5` → `TREE_DEPTH_EXCEEDED{ depth: 6 }`.
- **`maxEntries`:** synthetic 1001-entry tree with `maxEntries: 1000` → `TREE_ENTRY_LIMIT_EXCEEDED{ count: 1001, limit: 1000 }`.
- **Cycle (self-loop):** synthesize a tree whose subtree id equals its own id (attacker-crafted) → `TREE_CYCLE_DETECTED{ id }`.
- **Cycle (indirect):** tree A → tree B → tree A; walker throws `TREE_CYCLE_DETECTED{ id: A }` when it re-enters A on the descent. Pins the descent-stack semantics.
- **Shared subtree is NOT a cycle (legitimate case):** root tree with two children `src/` and `test/src/` both pointing to the same subtree id S. The walker yields every entry of S twice (once under each parent path) and does NOT throw. Pins that the cycle check uses the descent-stack (current root-to-leaf path), not a global visited-set — without this test a buggy implementation using `Set<ObjectId>` would pass §11.12's other tests.
- **Gitlink not recursed:** tree containing a gitlink entry → entry is yielded; instrumented fs confirms no `readObject` for the gitlink's target. **(§15.4 Phase 5 obligation covered.)**
- **Symlink not followed:** symlink entry yielded with `mode='120000'`; no `readlink`, no recursion. **(§15.3 validation is a Phase 9 checkout concern, not Phase 7 walkTree's — but the walker must not accidentally follow.)**
- **FlatTree insertion-order equals byte-order** — `Array.from((await toFlatTree(ctx, root)).entries.keys())` is already sorted. **(§15.1 Phase 5 obligation covered — this is the single most important test.)**

### 11.13 `diffTrees` — specific invariants

- **`undefined` vs `undefined`:** empty diff.
- **Add / delete / modify / type-change** — one test per variant (reproduces domain `diffTrees` semantics).
- **`ObjectId` input:** same output as passing the parsed `Tree`.
- **Rename detection on:** exact-match rename produces `RenameChange`.
- **Rename detection off:** same input produces paired `AddChange` + `DeleteChange`.
- **Same tree id:** byte-sort-matched inputs with identical ids → empty diff.

### 11.14 Mutation-resistant patterns specific to Phase 7

Per CLAUDE.md:

- **Error data assertions are specific.** `.data.code === 'REF_UPDATE_CONFLICT'` AND `.data.expected === oldId` AND `.data.actual === currentId`. Two-level verification.
- **Guard clauses isolated.** Every `if (A || B)` in a primitive — e.g., in `updateRef`'s CAS check — gets separate tests triggering A alone and B alone.
- **Order-sensitive ops verified with instrumented fs.** `readObject` loose-before-pack: instrumented fs records `exists(loose)` BEFORE any pack-related call.
- **Walker abort latency.** Test fires `ctx.signal` between yield N and yield N+1; asserts yield N+1 throws and no read happens after.
- **Try/catch over `toThrow`** for all error assertions (see Phase 5 §12.3, Phase 6 §7.1).

### 11.15 Property tests (fast-check)

In `test/unit/application/primitives/laws.test.ts`:

- **`readObject(writeObject(obj)) ≡ obj`** — round-trip for any valid GitObject.
- **`walkTree` insertion-order** — for any tree, `Array.from((await toFlatTree).entries.keys())` is sorted by `comparePaths`.
- **`walkCommits(topo)` topological correctness** — for any DAG, no parent is emitted before any of its children.
- **`walkCommits(first-parent)` linearity** — emitted count equals the length of the first-parent chain.
- **`updateRef` last-writer-wins** — two sequential updates, second's value is what `resolveRef` returns.
- **`diffTrees(T, T) ≡ empty`** — identity.
- **`diffTrees(T1, T2)` completeness** — every path in `changes` is in `T1 ∪ T2`.

---

## 12. Backlog Step Mapping

Same table style as operators §10 / diff-and-merge §14:

| Backlog | Description | Implementation step | Depends on | Parallel-safe? |
|---|---|---|---|---|
| — | **Step 0 — Prerequisite amendments to earlier phases.** Land as separate commits on the Phase 7 implementation branch BEFORE Step 1 begins: (a) Phase 1 `serializeIdentity` rejects `\n\r\0` in name/email/timezone → §14.14; (b) Phase 2 `MAX_DELTA_CHAIN_DEPTH = 50` exported from `domain/storage/delta.ts` → §14.3; (c) Phase 2 `createLruCache` gains optional `maxEntries` second parameter → §14.11; (d) Phase 3 `validateRefName` rejects Unicode RTL/LTR overrides (U+202A–U+202E, U+2066–U+2069) → §14.15; (e) Phase 4 `Context` type gains `readonly deltaCache: LruCache<Uint8Array>` and `readonly hashConfig: HashConfig` fields; all three Context factories wire them → §14.10, §14.16; (f) Phase 4 `FileSystem.writeExclusive` port contract adds ENOENT-retry and symlink-safe ancestor check → §14.17. Each prerequisite lands as its own commit, verified by its phase's existing test suite before Phase 7 step 1 begins. | 0 (a–f) | — | Sequential (each commit independently verified) |
| — | Fixtures + seeded-context helpers | 1 | 0 | — |
| — | Distributed error codes + factories (in existing `domain/*/error.ts` files) + `extractDetail` switch update in `domain/error.ts` | 2 | 1 | Parallel |
| — | `path-layout.ts` + `atomic-write.ts` | 3 | 1, 2 | Parallel |
| — | `pack-registry.ts` + `ref-store.ts` | 4 | 1–3 | Parallel |
| — | `object-resolver.ts` (internal) | 5 | 4 | Sequential |
| **7.1** | `readObject` | 6 | 5 | Sequential |
| **7.2** | `writeObject` | 7 | 5 | Parallel with 6 |
| **7.5** | `readBlob` | 8 | 6 | — |
| **7.8** | `resolveRef` | 9 | 4 | Parallel with 6–8 |
| **7.9** | `updateRef` | 10 | 3, 4, 9 | — |
| **7.10** | `readIndex` | 11 | 1–2 | Parallel with 3–10 |
| **7.11** | `createCommit` | 12 | 7 | — |
| **7.3** | `readTree` | 13 | 6, 9 | — |
| **7.4** | `writeTree` | 14 | 7 | Parallel with 12, 13 |
| **7.6** | `walkCommits` | 15 | 6, 9 | — |
| **7.7** | `walkTree` | 16 | 6 | Parallel with 15 |
| **7.12** | `diffTrees` (primitive) | 17 | 6 | Parallel with 15, 16 |
| — | Barrel export + public types | 18 | 6–17 | — |
| — | Property tests (`laws.test.ts`) | 19 | 18 | — |
| — | Mutation testing + parallel reviews + merge | 20 | 19 | — |

**Parallel-safe** means the step depends only on previously-completed steps and shares no files with other parallel-safe steps at the same level. Steps 6 and 7 both extend `object-resolver.ts` but in separate functions — documented in the plan doc when it lands.

---

## 13. Resolved Decisions

All open questions have been triaged. The table records the decision and its impact on this design.

| # | Question | Decision | Impact on design |
|---|---|---|---|
| 1 | `diffTreesRecursive` placement | **Defer to Phase 9.** | No primitive added. Phase 9 composes `walkTree` + domain `diffTrees` for recursive output. §15.7 Phase 5 contract becomes a Phase 9 obligation. |
| 2 | `mergeBase` placement | **Defer to Phase 9.** | No primitive added. Phase 9 `merge`/`rebase` commands compose `walkCommits` + Kahn's algorithm locally. |
| 3 | `writeIndex` presence | **Defer to Phase 9.** | Phase 7 exposes only `readIndex`. Phase 9 `add`/`commit` own `writeIndex` alongside stat-cache orchestration. |
| 4 | Error extension mechanism | **Option C — distribute into existing domain sub-unions.** See updated §6.1/§6.2. | No `declare module`, no new application-tier error file, no dep-cruiser relaxation. Codes live alongside related existing codes (`domain/objects/error.ts`, `domain/refs/error.ts`, etc.). |
| 5 | `walkCommits` shallow handling | **Add `ignoreMissing` option in Phase 7.** | §4.5 `WalkCommitsOptions` gains `ignoreMissing?: boolean` (default `false`). §8 walker semantics specifies the non-throwing skip. |
| 6 | `fsync` in `FileSystem` port | **Defer to Phase 11 (polish).** | §9.2 documents the best-effort durability. No Phase 4 port change in Phase 7. §14.9 tracks the Phase 11 obligation. |
| 7 | Delta-cache lifetime | **Hang off `ctx` (`ctx.deltaCache`).** | §7.2 rewritten. `ReadObjectOptions.deltaCache` / `WalkCommitsOptions.deltaCache` / `WalkTreeOptions.deltaCache` / `DiffTreesOptions.deltaCache` all removed. Phase 4 `Context` type gains `deltaCache` field (tracked in §14.10). |
| 8 | Short-SHA resolution | **Confirmed out of scope for v1.** | Phase 9 ships `resolveShortSha(ctx, prefix): Promise<ObjectId>` as a separate primitive-grade helper. Phase 7 requires full 40/64-char `ObjectId`. |

---

## 14. Contracts This Design Identifies (Not Yet Covered by Earlier Phases)

Integrating the §15 Phase 5 contracts and the §8 operator obligations surfaces gaps that earlier phases did not fully spec. Listed here for future-phase implementers:

1. **`MAX_COMMIT_MESSAGE_BYTES = 16 MiB` (Phase 7 hard cap).** Git itself has no limit but hosting services do (GitHub ~64 kB). `createCommit` MUST enforce this cap and throw `INVALID_COMMIT{ reason: 'message exceeds 16 MiB' }` on violation. §5.9 invariants + §11.10 boundary tests (just-under / at / just-over). Not an open question — promoted to a hard requirement in round 1 security review.

2. **`MAX_SYMBOLIC_REF_DEPTH = 5` and `MAX_PEEL_DEPTH = 5` (Phase 7 step).** §4.3 split the former `maxDepth` into two counters. Both constants are exported from `src/application/primitives/types.ts` so primitive implementations and tests share one source of truth. Step: added to §12 step 3 (types.ts barrel).

3. **`MAX_DELTA_CHAIN_DEPTH = 50` (Phase 2 amendment).** §10.1 uses this; git's own default. Currently a magic number. Phase 2 amendment: exported as a named constant from `src/domain/storage/delta.ts` so Phase 7's iterative walker and any future pack-writer share it. Tracked as Phase 2 amendment **Step 0(b)** in §12, alongside §14.11.

4. **Loose-shadowing-pack ordering contract.** §10.2 makes it a Phase 7 guarantee. Phase 2 does not specify this because it had no lookup pipeline. Documented here; §11.4 locks it in via test.

5. **Ref-store precedence (loose > packed).** Implicit in Phase 3 §6; made explicit as a Phase 7 contract in §5.6 and tested in §11.7.

6. **`writeObject` idempotence contract.** Phase 2 described "content-addressed storage" but did not spell out that a second write with the same content is a no-op. §5.2 locks this down and §11.5 tests it.

7. **Walker-to-operator cascade responsibility.** Phase 6 §8 "HTTP-body `AbortSignal` obligation" noted that primitives MUST wire generator `return()` to release resources. §8.2 / §8.3 make this concrete for Phase 7 walkers (no file handles held between yields; signal polled every yield).

8. **`ctx.signal` polling cadence.** §7 / §8.3 sets the cadence: (a) before each fs read, (b) between yields, (c) **after each `ctx.hash.hashHex(bytes)` call in `readObject` when `verifyHash: true`** (ensures abort latency is bounded identically for hash-verify and I/O). Phase 4 did not specify cadence (just "optional"). Phase 7 is the first layer to consume it, so the contract lands here. **Documented limitation:** `applyDelta` and inner Myers diff passes (Phase 5) are CPU-bound with no internal `await` points — signal polling does not fire during a single delta reconstruction or a single Myers pass. Worst-case cancellation latency is bounded by the largest object size (`applyDelta` up to Phase 2 `MAX_PACKED_OBJECT_SIZE` = 2 GiB) or the largest diff pair (Phase 5 `MAX_LINE_BYTES × MAX_LINES` caps). Acceptable for library use; hosting services needing sub-second cancellation offload to a Worker with `Worker.terminate()`.

9. **`FileSystem.fsync` deferred to Phase 11.** §9.2 documents `updateRef` as best-effort durable (lock file + rename, no fsync). Crash between rename and fsync leaves the ref update visible but potentially not persisted on disk. Phase 11 (polish) adds `fs.fsync(path): Promise<void>` to the `FileSystem` port and upgrades `updateRef` to call it between close and rename. Tracked as a contract to Phase 11.

10. **`Context.deltaCache` field (Phase 4 amendment — REQUIRED, migration impact scoped).** §7.2 pins the delta cache to `ctx`. Phase 4 `Context` type gains `readonly deltaCache: LruCache<Uint8Array>` (no `?` marker). Making it required eliminates the "optional-with-fallback" escape hatch that would let an adapter ship without the entry-cap mitigation (§14.11) and keeps primitives' contract simple. Migration sites (all enumerated — small, scoped):
   - `src/ports/context.ts` — add the field.
   - `src/adapters/node/node-adapter.ts` `createNodeContext` — call `createLruCache<Uint8Array>(16 * 1024 * 1024)`.
   - `src/adapters/browser/browser-adapter.ts` `createBrowserContext` — same.
   - `src/adapters/memory/memory-adapter.ts` `createMemoryContext` — same (critical: most tests build through this factory).
   - Any test in `test/unit/` that hand-rolls a `Context` object — add the field. Estimated ~5–10 test files.
   - The three factories gain an optional `deltaCacheMaxBytes` config knob (default 16 MiB), keeping their `options` param backward-compatible.

11. **`LruCache<V>` entry-cap amendment (Phase 2 amendment, prerequisite for Phase 7).** Today `createLruCache(maxSizeBytes)` bounds only bytes. `ctx.deltaCache` is vulnerable to a flood of tiny base objects evicting legitimate large bases (security §S-H-3). Phase 2 `src/domain/storage/lru-cache.ts` gains an optional second parameter: `createLruCache<V>(maxSizeBytes: number, maxEntries?: number): LruCache<V>`. Default `maxEntries = Number.POSITIVE_INFINITY` (backward-compatible). Phase 7 Context factories pass `65_536`. Eviction fires when **either** limit is exceeded. **Tracked as Phase 2 amendment "step 0" — executed before Phase 7 step 1 of §12.** The §12 step table is numbered from Phase 7's own steps; Phase 2 amendments 3 (`MAX_DELTA_CHAIN_DEPTH`) and 11 (entry-cap) are prerequisites that land as separate commits on the same implementation branch before step 1 begins.

12. **`resolveShortSha(ctx, prefix): Promise<ObjectId>` (Phase 9 contract, with Phase 2/7 dependency).** §13 Q8 confirms short-SHA resolution is out of scope for Phase 7. Phase 9's `log HEAD~3`, `checkout abc1234`, `show abc` all require it. The implementation composes `pack-registry.findByPrefix(prefix): ReadonlyArray<ObjectId>` + loose-object scan (`ctx.fs.list("{gitDir}/objects/{prefix[0..2]}/")`). `findByPrefix` is an **addition to Phase 2's `PackIndex` reader** (fanout-table prefix lookup — trivial given the existing sorted-sha table). Phase 7's `pack-registry.ts` exposes a thin `findByPrefixAllPacks(prefix)` wrapper that composes with `ctx.fs.readdir("{gitDir}/objects/{prefix[0..2]}/")` (NOT `fs.list` — no such port method; see Phase 4 `src/ports/file-system.ts` `readdir` signature). Both land as part of Phase 9 step N, NOT Phase 7 — listed here only so Phase 7's pack-registry module signature reserves the method name.

13. **Symbolic-ref writes in `updateRef` (Phase 9 contract).** §5.7 `updateRef` writes direct refs only (`serializeDirectRef(newId)`). Phase 9 `init` needs to write `HEAD` as `ref: refs/heads/main` (symbolic); `checkout -b` needs to rewrite `HEAD` to point to a new branch. Phase 9 either (a) adds a sibling `updateSymbolicRef(ctx, name, target): Promise<void>` primitive, or (b) overloads `updateRef` with a discriminated input (`{ kind: 'direct', id } | { kind: 'symbolic', target }`). Decision deferred; tracked here so the Phase 7 signature doesn't accidentally preclude (b).

14. **Phase 1 `serializeIdentity` hardening.** §5.9 requires `parseIdentity(serializeIdentity(...))` roundtrip to reject `\n`, `\r`, `\0` in `name`, `email`, `timezone`. If Phase 1 does not already enforce this (needs verification at implementation time), `serializeIdentity` is amended to reject these characters with `INVALID_IDENTITY{reason: 'name/email/timezone contains forbidden control character'}`. Lands as a Phase 1 amendment commit on the Phase 7 implementation branch, before step 1.

15. **Phase 3 `validateRefName` hardening — Unicode overrides.** §5.6 adds rejection of Unicode RTL/LTR override codepoints (U+202A–U+202E, U+2066–U+2069). If Phase 3's current `validateRefName` does not cover them, amend it; lands as a Phase 3 amendment commit on the Phase 7 implementation branch, before step 1.

16. **Phase 4 `Context.hashConfig` field.** §5.2 uses `serializeObject(object, ctx.hashConfig)`. Phase 1's `serializeObject` signature is `(object: GitObject, hash: HashConfig)` — `HashConfig` is distinct from `HashService` (the former is `{digestLength, hexLength}` value data; the latter is the async port). Phase 4 `Context` currently exposes only `hash: HashService`. Amendment: add `readonly hashConfig: HashConfig` to `Context`, wired from the same `HashConfig` value already threaded through the factory. Lands as Step 0(e) alongside `ctx.deltaCache`.

17. **Phase 4 `FileSystem.writeExclusive` reinforcement.** §5.2 `writeObject` relies on two new invariants on the port: (a) **ENOENT retry** — if `writeExclusive` observes `FILE_NOT_FOUND` on the parent directory, the port MUST attempt one `mkdir` + retry before propagating the error (closes the mkdir-then-gc-rmdir race — security R3 H-2); (b) **Symlink-safe ancestor check** — the port MUST reject writes where any ancestor directory of the target path is a symlink pointing outside `gitDir`. Both land as Step 0(f) with tests in Phase 4's FileSystem test suite.

---

## 15. Phase 5 Contract Audit (cross-reference)

Every §15 Phase 5 obligation is covered:

| Phase 5 §15 | Obligation | Phase 7 coverage |
|---|---|---|
| 1 | Byte-sorted `FlatTree` construction | §5.11 `walkTree` yields byte-ordered; §11.12 FlatTree insertion-order property test |
| 2 | Async `contentMerger` closure | Phase 9 `merge` command constructs the closure — it composes `readObject` (for base/ours/theirs blob reads) with `mergeContent` + `writeConflictMarkers` from `domain/merge/`. Phase 7 supplies the `readObject` building block; no primitive in Phase 7 constructs or invokes `contentMerger`. |
| 3 | Symlink target validation | Out of `walkTree`'s scope (the walker yields symlink entries; does NOT follow); validation is Phase 9 `checkout` |
| 4 | Gitlink write discipline | §5.11 walker yields but does NOT recurse into gitlinks; §11.12 gitlink-not-recursed test |
| 5 | `resolved-merged` hashing | §5.2 `writeObject` computes the hash via `ctx.hash`; Phase 9 `merge` calls `writeObject` with the bytes |
| 6 | Direct-call output-size discipline | `mergeContent` / `writeConflictMarkers` callers (Phase 9) enforce; Phase 7 is downstream of this |
| 7 | `diffTreesRecursive` + working-tree status | Phase 7 supplies the building blocks. Phase 9 composes `diffTreesRecursive = domain.diffTrees(await toFlatTree(ctx, a), await toFlatTree(ctx, b))` using the §5.11 `toFlatTree` helper. `status` composes `walkTree` (HEAD) + `readIndex` + filesystem walk. No new Phase 7 primitive required (see §13 row 1). |

---

## 16. File Conventions

- Source files: `src/application/primitives/*.ts`
- Test files: `test/unit/application/primitives/*.ts`
- File names: kebab-case (ls-lint)
- Test names: `<module>.test.ts`; property tests in `laws.test.ts`; fixtures in `fixtures.ts`
- Test format: Given/When/Then titles, AAA body, `sut` variable
- Import extensions: `.js` suffix on every import (ESM)
- Error pattern: new codes added to the existing `domain/<sub>/error.ts` file whose concept they describe (see §6.1). Factories live in the same sub-domain file. `domain/error.ts` `extractDetail` switch gains a case per new code. No application-tier error file; no module augmentation.
- Docstrings: JSDoc on every exported function; `@throws` clauses list every possible `code`
- Dep-cruiser: `primitives-cannot-import-commands` rule already in place; new rule candidate `primitives-cannot-cross-import` (§3) under review
