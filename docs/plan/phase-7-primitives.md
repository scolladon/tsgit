# Plan: Phase 7 — Primitives (Tier 2)

Implements [design/primitives.md](../design/primitives.md).
Covers [backlog](../BACKLOG.md) items 7.1–7.12.

### Review Notes

Round 0 — initial draft. Open for review.

---

## Backlog → Step Mapping

| Backlog | Description | Step |
|---|---|---|
| — | Phase 1/2/3/4 prerequisite amendments (6 commits) | 0(a–f) |
| — | Fixtures + seeded-context helpers | 1 |
| — | Distributed error codes + factories + `extractDetail` updates | 2 |
| — | `path-layout.ts` + `atomic-write.ts` | 3 |
| — | `pack-registry.ts` + `ref-store.ts` | 4 |
| — | `object-resolver.ts` (internal iterative delta walker) | 5 |
| **7.1** | `readObject` | 6 |
| **7.2** | `writeObject` | 7 |
| **7.5** | `readBlob` | 8 |
| **7.8** | `resolveRef` | 9 |
| **7.9** | `updateRef` | 10 |
| **7.10** | `readIndex` | 11 |
| **7.11** | `createCommit` | 12 |
| **7.3** | `readTree` | 13 |
| **7.4** | `writeTree` | 14 |
| **7.6** | `walkCommits` | 15 |
| **7.7** | `walkTree` | 16 |
| **7.12** | `diffTrees` (primitive) | 17 |
| — | Barrel export + public types | 18 |
| — | Property tests (`laws.test.ts`) | 19 |
| — | Mutation testing + 4× parallel reviews + merge | 20 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor. After every green step, run: `npm run check:types && npm run test:unit && npm run check:architecture`.

**Commit strategy.** One commit per completed step. Message format: **scope matches the file tree being modified**.
- Step 0(a)/(b)/(c)/(d) modify `src/domain/**` → `feat(domain):` / `chore(domain):`.
- Step 0(e)/(f) modify `src/ports/**` and `src/adapters/**` → `feat(ports):` / `feat(adapters):`.
- Step 2 modifies `src/domain/*/error.ts` AND creates `src/application/primitives/types.ts` → split into two commits: `feat(domain): add Phase 7 error codes and factories` + `feat(primitives): add types.ts with option shapes and constants`. Landed sequentially on the implementation branch; the `types.ts` commit is trivially dependent on the domain error commit (TsgitErrorData union must be widened first so primitive types referencing `TsgitError` compile).
- Steps 1, 3, 4, 5 and all primitive steps (6–17) + barrel + laws modify `src/application/primitives/**` → `feat(primitives):` or `chore(primitives):` (test fixtures + internal helpers). Step 19 (laws.test.ts) uses `test(primitives):` since it adds no source, only tests.
- Step 20 squash-merge message: `feat(primitives): add phase 7 — primitives` (matches Phase 6).

**Size gate.** The 80 kB gzipped cap on `dist/esm/primitives/index.js` (actual limit TBD when size-limit entry added) is verified at step 18 (barrel) and step 20 (finalization) only.

**Branch strategy.** Implement on the existing `plan/phase-7-primitives` branch until the plan itself lands, then **open a fresh implementation branch** (`feat/phase-7-primitives` or a worktree under `.claude/worktrees/phase-7-primitives`).

---

## Prerequisites (before Step 0)

1. **Design doc merged.** `docs/design/primitives.md` is on main.
2. **Phases 1–6 complete.** Phase 7 composes their outputs; no gaps.
3. **`size-limit` entry for Primitives.** Add to `.size-limit.json` before step 18 lands — rough budget 80 kB gzipped (primitives pull domain + ports transitively, so the cap is higher than operators'). Landed as part of step 18.
4. **`package.json exports."./primitives"`** already points at `dist/esm/application/primitives/index.js` + types — no change.
5. **`.dependency-cruiser.cjs` rules.** Add a rule `primitives-boundary` blocking imports from `src/application/commands/`, `src/transport/`, `src/application/repository.ts` into `src/application/primitives/`. Existing rules already block `domain → application` and cross-adapter imports. Landed as part of step 1.
6. **`knip.json` entry.** `src/application/primitives/index.ts` already in the `entry` array (verified).
7. **cspell lexicon.** Add any new domain terms surfacing in this plan (e.g. `fanout`, `OFS_DELTA`, `REF_DELTA`, `OBJ_REF_DELTA`) if not already present.

---

## File Conventions

- Source files under `src/application/primitives/`.
- Test files under `test/unit/application/primitives/`.
- File names: kebab-case (enforced by ls-lint). `walkCommits.ts` → `walk-commits.ts`, `flatMap` pattern.
- Test file names: `<module>.test.ts`. Fixtures in `fixtures.ts`. Property tests in `laws.test.ts`.
- **Test format:** Given/When/Then titles, AAA bodies with `// Arrange` / `// Act` / `// Assert` comments, `sut` variable. See CLAUDE.md and design §11.1.
- **Inline test specifications in this plan use one of two styles.** (a) Full `Given … When … Then …` prose in the plan → copy verbatim as the test title. (b) Shorthand `<scenario>: <outcome>` (used in Steps 9, 10, 15, 16 for space efficiency) → rewrite each shorthand line to the full `Given … When … Then …` form when authoring the test file. The shorthand captures the specification; the Vitest `it(...)` title is the final canonical form per CLAUDE.md.
- **Import extensions:** all imports MUST use the `.js` extension (ESM / verbatimModuleSyntax).
- **Error types:** `TsgitError` via named factories from `domain/<sub>/error.ts`. Never construct `new TsgitError({...})` in primitive bodies — always call a factory.
- **Return type discipline:** walkers return `AsyncIterable<T>` (NOT `AsyncGenerator<T, void, unknown>`). Terminal primitives return `Promise<T>`.
- **Iteration protocol:** walkers MUST iterate via `for await … of` (never manual `.next()`). Design §8 (Phase 6 operator obligations apply).
- **Ctx discipline:** `ctx` is first param, read-only, destructured to the minimum needed ports inside the body.

---

## Design Decisions (applied in this plan)

- **Step 0 prerequisites land as separate commits** on the implementation branch, each verified by its originating phase's test suite before the next amendment begins. Rationale: keeps the blame surface small and makes reverting a single amendment cheap.
- **Steps 1–5 (support infra) sequenced before any primitive step.** Fixtures, error factories, path-layout, atomic-write, pack-registry, ref-store, object-resolver are pure building blocks with no cross-dependencies on primitives. Every primitive (steps 6–17) composes these; landing them first prevents rework.
- **Primitive ordering within steps 6–17** follows the dependency-minimal order: `readObject` → `writeObject` (independent) → narrowing wrappers (`readBlob`, `readTree`, `writeTree`) → `resolveRef` + `updateRef` (ref layer) → `readIndex` + `createCommit` (index + commit construction) → walkers (`walkCommits`, `walkTree`) → `diffTrees`. Each step depends only on previously-landed primitives.
- **`object-resolver.ts` is the sole internal module that owns the iterative delta walker.** Design §10.1 mandates iterative (not recursive). The walker is the most complex piece of the phase; landing it as its own step 5 with its own test battery is explicit about this.
- **Walker cleanup tests mirror Phase 6 §7.5.** Every walker (walkCommits, walkTree) gets three-tier cleanup tests: (a) natural exhaustion, (b) source self-abort, (c) consumer throw. Design §8.2.
- **Every invalid-input test asserts on `.message` regex** (or `.data.reason` match) — never `toThrow(TsgitError)` alone. Mutation-resistant per CLAUDE.md.
- **Required reading before Step 1:** `docs/design/primitives.md` §11.14 "Mutation-resistant patterns specific to Phase 7" — enumerates the try/catch-over-toThrow rule, instrumented-fs ordering checks, two-level `.data` assertions, and the boundary-triple pattern. Every primitive step below is written assuming the reader has internalized §11.14.
- **Every boundary cap gets just-under / at / just-over triple tests** per CLAUDE.md: `MAX_DELTA_CHAIN_DEPTH`, `MAX_WALK_SEEDS`, `MAX_INDEX_BYTES`, `MAX_COMMIT_MESSAGE_BYTES`, `MAX_SYMBOLIC_REF_DEPTH`, `MAX_PEEL_DEPTH`, `MAX_DELTA_CACHE_ENTRIES`. Landed at the test step for the consuming primitive.

---

## Step 0: Prerequisite amendments to earlier phases

Land as six separate commits on the implementation branch, in order. Each is verified by running its originating phase's existing test suite green before the next amendment begins. All six MUST be green before Step 1.

### Step 0(a) — Phase 1 `serializeIdentity` hardening

**Design:** §14.14.

**Modify:** `src/domain/objects/author-identity.ts` `serializeIdentity`.

**Red.** Add tests to `test/unit/domain/objects/author-identity.test.ts`:

```
Given author.name containing '\n', When serializeIdentity is called, Then throws INVALID_IDENTITY with data.reason matching /forbidden control character/
Given author.email containing '\r', When serializeIdentity is called, Then throws INVALID_IDENTITY /forbidden control character/
Given author.timezoneOffset containing '\0', When serializeIdentity is called, Then throws INVALID_IDENTITY /forbidden control character/

Negative baseline (prevents over-broad rejection mutants):
  Given author.name containing '\t' (tab, not in the reject set), Then succeeds.
  Given author.name containing normal UTF-8 "café", Then succeeds.
  Given author.email containing '+' (RFC5322 plus addressing), Then succeeds.
```

Each rejected field × each of `\n`, `\r`, `\0` = 9 isolated tests per CLAUDE.md guard-isolation rule. Three accept-baseline tests kill rejection-set widening mutants.

**Green.** Add a pre-serialization validation pass that rejects `\n`, `\r`, `\0` in `name`, `email`, `timezoneOffset`. Factory: reuse existing `invalidIdentity(reason)` in `domain/objects/error.ts`.

**Verify.** `npm run test:unit -- test/unit/domain/objects/` must be green.

**Commit.** `feat(domain): reject control characters in identity fields`

### Step 0(b) — Phase 2 `MAX_DELTA_CHAIN_DEPTH` constant

**Design:** §14.3.

**Modify:** `src/domain/storage/delta.ts`.

Export: `export const MAX_DELTA_CHAIN_DEPTH = 50;`

**Red.** One-line test in `test/unit/domain/storage/delta.test.ts` asserting `MAX_DELTA_CHAIN_DEPTH === 50`. Catches misspell / wrong-value mutants before Step 5 consumes the constant.

**Verify.** `npm run test:unit -- test/unit/domain/storage/`.

**Commit.** `chore(domain): export MAX_DELTA_CHAIN_DEPTH constant`

### Step 0(c) — Phase 2 `createLruCache` entry cap

**Design:** §14.11.

**Modify:** `src/domain/storage/lru-cache.ts`.

**Red.** Add tests to `test/unit/domain/storage/lru-cache.test.ts`:

```
Entry-cap isolated boundary triple (bytes budget unbounded, only entry cap tested):
  Given createLruCache(Number.MAX_SAFE_INTEGER, 10), When 9 entries of 10 bytes each are set,
    Then entryCount === 9 (just-under).
  Given createLruCache(Number.MAX_SAFE_INTEGER, 10), When 10 entries are set,
    Then entryCount === 10 (at).
  Given createLruCache(Number.MAX_SAFE_INTEGER, 10), When 11 entries are set,
    Then entryCount === 10 and the oldest key is evicted (just-over).

Byte-cap isolated boundary triple (entry cap unbounded):
  Given createLruCache(100, Infinity), When 2 entries of 49 bytes each are set,
    Then currentSize === 98 (just-under).
  Given createLruCache(100, Infinity), When one 100-byte entry is set,
    Then currentSize === 100 (at).
  Given createLruCache(100, Infinity), When 3 entries of 50 bytes each are set,
    Then the oldest entry is evicted (just-over; sum 150 > 100).

Backward-compat: createLruCache(1024) (single-arg legacy call) → entry cap defaults to Infinity.
  When 1000 tiny entries are set within the byte budget, Then all 1000 present.

Combined caps first-hit: createLruCache(100, 10), When filled with 11 tiny entries,
  Then entry cap fires first (entryCount capped at 10); with one 101-byte entry,
  Then byte cap fires.
```

**Green.** Update `createLruCache` signature: `createLruCache<V>(maxSizeBytes: number, maxEntries?: number): LruCache<V>`. Default `maxEntries = Number.POSITIVE_INFINITY`. Eviction fires on `entryCount > maxEntries` OR `currentSize > maxSizeBytes`.

**Commit.** `feat(domain): add optional entry cap to LruCache`

### Step 0(d) — Phase 3 `validateRefName` Unicode hardening

**Design:** §14.15.

**Modify:** `src/domain/refs/ref-validation.ts` `validateRefName`.

**Red.** Add tests to `test/unit/domain/refs/ref-validation.test.ts`:

```
Given a ref name containing U+202E (RLO), When validateRefName is called, Then throws INVALID_REF /forbidden Unicode override/
Given a ref name containing U+2066 (LRI), Then same
Given a ref name containing U+202A..U+202E (each of 5), Then same (5 isolated tests)
Given a ref name containing U+2066..U+2069 (each of 4), Then same (4 isolated tests)
Given 'refs/heads/main' (no overrides), Then passes (baseline accept).
Negative boundaries (prevents range-widening mutants):
  Given a ref name containing U+2029 (codepoint just below the first reject, U+202A), Then passes.
  Given a ref name containing U+202F (codepoint just above U+202E), Then passes.
  Given a ref name containing U+2065 (just below U+2066), Then passes.
  Given a ref name containing U+206A (just above U+2069), Then passes.
```

Total 9 isolated reject tests + 1 baseline accept.

**Green.** Add a pass that scans each codepoint; reject matches with existing `invalidRef(reason)` factory.

**Commit.** `feat(domain): reject Unicode override chars in ref names`

### Step 0(e) — Phase 4 `Context.deltaCache` + `Context.hashConfig`

**Design:** §14.10, §14.16.

**Modify:**
- `src/ports/context.ts` — add `readonly deltaCache: LruCache<Uint8Array>` and `readonly hashConfig: HashConfig`.
- `src/adapters/node/node-adapter.ts` `createNodeContext` — wire `createLruCache<Uint8Array>(16 * 1024 * 1024, 65_536)` + populate `hashConfig` from existing hash config.
- `src/adapters/browser/browser-adapter.ts` `createBrowserContext` — same.
- `src/adapters/memory/memory-adapter.ts` `createMemoryContext` — same.
- `CreateContextParts` (if exported) — add the two fields.
- Every test fixture building a raw `Context` — add the two fields. **TypeScript is the exhaustive gate**: making both fields non-optional causes `npm run check:types` to flag every missing site with a precise diagnostic. The implementer iterates `check:types` until green; no grep needed. Expected: ~5–10 test files in `test/unit/` will need the two fields added.

**Red.** Add a test per adapter factory asserting `ctx.deltaCache.maxSize === 16 MiB` and `ctx.hashConfig.digestLength === 20` (sha1).

**Green.** Wire as described.

**Commit.** `feat(ports): add deltaCache and hashConfig to Context`

### Step 0(f) — Phase 4 `FileSystem.writeExclusive` reinforcement

**Design:** §14.17.

**Modify:** `src/ports/file-system.ts` contract doc + `src/adapters/node/` implementation + `src/adapters/memory/`.

**Red.** Add tests to adapter test suites:

```
ENOENT retry:
Given writeExclusive is called on a path whose parent was removed after mkdir, When called, Then port retries mkdir once then writeExclusive; succeeds.
Given the retry also fails with ENOENT, When called, Then throws FILE_NOT_FOUND (no further retry).

Symlink-safe:
Given writeExclusive is called on '<gitDir>/objects/xx/yyy' where 'objects/xx' is a symlink to '/tmp/foo', When called, Then throws (symlink ancestor rejected).
Given writeExclusive is called on a plain path (no symlink ancestors), When called, Then succeeds (baseline).
```

**Green.** In the Node adapter, on first `ENOENT`: `mkdir(dirname(path))` + retry `writeExclusive` once. For symlink: `lstat`-walk the ancestor chain; reject if any component is a symlink whose resolved target is outside `gitDir`. In the Memory adapter: the ENOENT case is simulated via a `simulateAncestorRemoval` hook on `MemoryFileSystem`; the symlink case is simulated via a `simulateSymlinkAncestor(path, target)` hook that makes `writeExclusive` behave as if that ancestor were a symlink (matching the contract without the adapter needing real symlinks).

**Testable on memory adapter.** The two hooks (`simulateAncestorRemoval`, `simulateSymlinkAncestor`) make both failure modes Red-testable without real-filesystem integration. Node-adapter-specific real-symlink integration tests remain Phase 11 responsibility but are NOT required to gate Step 0(f) — the memory-adapter hook tests prove the contract is honored. Design rationale: the contract is a FileSystem port obligation; adapters MUST implement it; memory adapter's hook-based simulation is a legitimate contract test.

**Commit.** `feat(ports): writeExclusive ENOENT retry and symlink-safe`

---

## Step 1: Fixtures + seeded-context helpers

**Create:** `test/unit/application/primitives/fixtures.ts`, `test/unit/application/primitives/fixtures.test.ts`

**Depends on:** Step 0.

### Fixtures to implement

Per design §11.2 — names match the design exactly:

- **`buildSeededContext(parts)`** — wraps `createMemoryContext()` and pre-populates `.git/objects/**` via the Phase 1 `serializeObject` + Phase 4 `ctx.fs.write` (bypassing the `writeObject` primitive to avoid a bootstrap loop). Seeds `.git/refs/**`, `.git/packed-refs`, and `.git/index` via direct fs writes through `serializeIndex` (Phase 3) + `serializePackedRefs` (Phase 3). Signature per design §11.2. Used by every primitive test.
- **`buildContextWithPack({ baseObjects, deltaChains })`** — builds a minimal valid `.pack` + `.idx` byte pair from a description via Phase 2 `serializePackfile` + `serializePackIndex`, writes them to the memory fs, and returns a Context. Required for readObject delta tests (Steps 5, 6).
- **`tinyGraph()`** — canonical small commit graph (root → A → B, with C merging A+B). Used by every walkCommits test (Step 15) for topological / date / first-parent / until / from-multi-seed / diamond cases.
- **`syntheticTree(breadth, depth)`** — tree with N entries at depth D. Used by walkTree boundary tests (Step 16) and by readTree deep-peel tests (Step 13).
- **`instrumentedContext(base)`** — wraps a Context and returns `{ ctx, calls }` where `calls()` returns the ordered list of every port call (method + path). Used for "fs read exactly once" assertions, "applyDelta spy has zero invocations" (Step 5), pullCount-style ordering checks (Step 15). The spy covers `fs.read`, `fs.readUtf8`, `fs.stat`, `fs.write`, `fs.writeExclusive`, `fs.mkdir`, `fs.rename`, `fs.rm`, `fs.exists`, `fs.readdir`, `hash.hashHex`, `compressor.deflate`, `compressor.inflate`, and a hook for the internal `applyDelta` import so the iterative walker tests can assert phase-1-before-phase-2 ordering.
- **`serializeIndexFixture(index)`** — test-only helper that delegates to Phase 3's `serializeIndex` so readIndex tests (Step 11) can round-trip without needing a Phase 9 `writeIndex` primitive. Exposed from `fixtures.ts`.

### Red (contract self-tests)

Per design §11.2 tail — every fixture gets a small self-test verifying its contract (mirrors the Phase 6 operators plan Step 1 "fixture contract self-test" pattern: `test/unit/operators/fixtures.test.ts`).

### Verify

```bash
npm run check:types && npm run test:unit -- test/unit/application/primitives/fixtures
```

**Commit.** `chore(primitives): add test fixtures`

---

## Step 2: Distributed error codes + factories + `extractDetail` updates + `types.ts`

**Modify:**
- `src/domain/objects/error.ts` — add 6 codes (`OBJECT_NOT_FOUND`, `OBJECT_HASH_MISMATCH`, `UNEXPECTED_OBJECT_TYPE`, `TREE_CYCLE_DETECTED`, `TREE_DEPTH_EXCEEDED`, `TREE_ENTRY_LIMIT_EXCEEDED`) + factories.
- `src/domain/storage/error.ts` — add 1 code (`DELTA_CHAIN_TOO_DEEP`) + factory.
- `src/domain/refs/error.ts` — add 5 codes (`REF_NOT_FOUND`, `REF_CHAIN_TOO_DEEP`, `REF_CYCLE_DETECTED`, `REF_LOCKED`, `REF_UPDATE_CONFLICT`) + factories.
- `src/domain/error.ts` — add 2 codes in new `ApplicationError` union (`INVALID_WALK_INPUT`, `OPERATION_ABORTED`); widen `TsgitErrorData`; add 14 cases to `extractDetail` switch.

**Create:**
- `src/application/primitives/types.ts` — exports every option shape and walker value type referenced by the §5 signatures: `ReadObjectOptions`, `ResolveRefOptions`, `UpdateRefOptions`, `WalkCommitsOptions`, `WalkTreeOptions`, `WalkTreeEntry`, `CreateCommitInput`, `DiffTreesInput`, `DiffTreesOptions`. Plus the primitive-layer constants `MAX_SYMBOLIC_REF_DEPTH = 5`, `MAX_PEEL_DEPTH = 5`, `MAX_WALK_SEEDS = 1024`, `MAX_INDEX_BYTES = 256 * 1024 * 1024`, `MAX_COMMIT_MESSAGE_BYTES = 16 * 1024 * 1024`. Created here (not Step 3) so every later primitive step can import from one location without cycles.

**Depends on:** Step 0, Step 1.

### Red

Tests in each sub-domain's `error.test.ts` (or a new `domain/error.test.ts` for `ApplicationError`):

```
For each new code:
  Given factory(args), When called, Then returns TsgitError instance with data.code === '<CODE>' and data payload matches args.
```

Plus an `extractDetail` coverage test: for each of the 14 new codes, `new TsgitError({ code: 'X', ... }).message` starts with `X: <expected-prefix>`.

### Green

Add the codes + factories per design §6.1 / §6.2. Example signatures:

```typescript
// domain/objects/error.ts
export const objectNotFound = (id: ObjectId): TsgitError =>
  new TsgitError({ code: 'OBJECT_NOT_FOUND', id });

export const objectHashMismatch = (expected: ObjectId, actual: ObjectId): TsgitError =>
  new TsgitError({ code: 'OBJECT_HASH_MISMATCH', expected, actual });
// ... etc
```

For `ApplicationError`:

```typescript
// domain/error.ts
export type ApplicationError =
  | { readonly code: 'INVALID_WALK_INPUT'; readonly reason: string }
  | { readonly code: 'OPERATION_ABORTED' };

export type TsgitErrorData = DomainObjectError | StorageError | RefsError | IndexError | AdapterError | DiffError | MergeError | ApplicationError;

export const invalidWalkInput = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_WALK_INPUT', reason });

export const operationAborted = (): TsgitError =>
  new TsgitError({ code: 'OPERATION_ABORTED' });
```

14 new `case` arms in `extractDetail` (`_exhaustive: never` catches any omission at compile time).

### Verify

```bash
npm run check:types && npm run test:unit -- test/unit/domain/
```

**Commit 1 (domain errors).** `feat(domain): add Phase 7 error codes and factories`

**Commit 2 (primitives types).** After the domain-errors commit lands, create `src/application/primitives/types.ts` with the option shapes and constants listed above; then `feat(primitives): add types.ts with option shapes and constants`. The split is required because commit 1 widens `TsgitErrorData` (a domain concern) and commit 2 introduces the application-tier types module (a primitives concern) — one file tree per commit per the match-file-tree scope rule (see Workflow §Commit strategy).

---

## Step 3: `path-layout.ts` + `atomic-write.ts`

**Create:** `src/application/primitives/path-layout.ts`, `src/application/primitives/atomic-write.ts`, + tests.

**Depends on:** Step 0, Step 1, Step 2.

### `path-layout.ts`

Pure path helpers composing `ctx.config.gitDir` with known sub-paths. No I/O.

```typescript
export const looseObjectPath = (gitDir: string, id: ObjectId): string =>
  `${gitDir}/objects/${computeLooseObjectPath(id)}`;

export const looseRefPath = (gitDir: string, name: RefName): string =>
  `${gitDir}/${name}`;

export const packedRefsPath = (gitDir: string): string =>
  `${gitDir}/packed-refs`;

export const indexPath = (gitDir: string): string =>
  `${gitDir}/index`;

export const objectsDir = (gitDir: string, prefix: string): string =>
  `${gitDir}/objects/${prefix}`;
```

### `atomic-write.ts`

The reusable lock-file + rename helper for `updateRef`. NOT for `writeObject` (which uses `writeExclusive` directly per design §5.2).

```typescript
export async function atomicWriteRef(
  ctx: Context,
  refPath: string,
  content: Uint8Array,
): Promise<void> {
  const lockPath = `${refPath}.lock`;
  await ctx.fs.writeExclusive(lockPath, content);
  try {
    await ctx.fs.rename(lockPath, refPath);
  } catch (error) {
    await ctx.fs.rm(lockPath).catch(() => {});
    throw error;
  }
}
```

### Red

`path-layout.test.ts`: one test per function — given inputs, assert returned path is byte-equal to expected.

`atomic-write.test.ts`:

```
Given refPath and content, When atomicWriteRef succeeds, Then final refPath contains content and lockPath no longer exists.
Given writeExclusive throws with .data.code === 'REF_LOCKED' (lock already exists), When called, Then atomicWriteRef propagates the same TsgitError (rename never attempted — instrumented fs records zero rename calls).
Given rename throws mid-call, When atomicWriteRef catches, Then lockPath is removed best-effort (instrumented fs records a rm call); the original rename error is re-thrown with its original .data preserved.
```

### Verify

```bash
npm run check:types && npm run test:unit -- test/unit/application/primitives/ && npm run check:architecture
```

**Commit.** `chore(primitives): add path-layout and atomic-write helpers`

---

## Step 4: `pack-registry.ts` + `ref-store.ts`

**Create:** `src/application/primitives/pack-registry.ts`, `src/application/primitives/ref-store.ts`, + tests.

**Depends on:** Steps 1, 2, 3. Step 4's `ref-store.ts` imports `looseRefPath` and `packedRefsPath` from Step 3's `path-layout.ts`, and `pack-registry.ts` imports `objectsDir`. Step 3 MUST land before Step 4 (the earlier "parallel with 3" claim was wrong — corrected here and in the dependency graph).

### `pack-registry.ts`

Lazy scan + cache of `.idx` files, keyed by pack name. Returns `ReadonlyArray<{ name, index }>` on each call. Cache invalidated on `ctx.fs.readdir` mtime change (if the adapter exposes mtime; otherwise re-read per call).

Key methods:

```typescript
interface PackRegistry {
  all(): Promise<ReadonlyArray<RegisteredPack>>;
  lookup(id: ObjectId): Promise<PackLookupHit | undefined>; // first pack to hit
}

interface RegisteredPack {
  readonly name: string;
  readonly index: PackIndex;
  readonly packPath: string;
}

interface PackLookupHit {
  readonly pack: RegisteredPack;
  readonly offset: number;
}

export function createPackRegistry(ctx: Context): PackRegistry;
```

### `ref-store.ts`

Loose-first-then-packed ref lookup. mtime-based cache of parsed `packed-refs`.

```typescript
interface RefStore {
  resolveDirect(name: RefName): Promise<ObjectId | undefined>;
  writeLoose(name: RefName, id: ObjectId): Promise<void>;
  removeLoose(name: RefName): Promise<void>;
  listLoose(prefix: string): Promise<ReadonlyArray<RefName>>;
}

export function createRefStore(ctx: Context): RefStore;
```

### Red

`pack-registry.test.ts`:

```
Given an empty pack directory, When all() is called, Then returns [].
Given 2 packs, When lookup(id present in pack 1) is called, Then returns { pack: pack1, offset }.
Given 2 packs with the same id (duplicate packs), When lookup is called, Then returns the first registry-order hit.
Given a pack directory that grows between calls, When the registry's mtime changes, Then the next lookup sees the new pack.
```

`ref-store.test.ts`:

```
Given a loose ref and a packed-ref with the same name, When resolveDirect is called, Then loose wins (precedence).
Given writeLoose is called, When followed by resolveDirect, Then returns the written id.
Given removeLoose removes a loose ref shadowing a packed one, When resolveDirect is called, Then returns the packed id (fall-through).
Given packed-refs file mtime advances between calls, When resolveDirect is called, Then cache is invalidated and re-parsed.
```

### Verify

```bash
npm run check:types && npm run test:unit -- test/unit/application/primitives/ && npm run check:architecture
```

**Commit.** `chore(primitives): add pack-registry and ref-store helpers`

---

## Step 5: `object-resolver.ts` (iterative delta walker)

**Create:** `src/application/primitives/object-resolver.ts`, `test/unit/application/primitives/object-resolver.test.ts`.

**Depends on:** Steps 0(b), 0(c), 0(e), 1, 2, 4. (0(b) for `MAX_DELTA_CHAIN_DEPTH`; 0(c) for LRU entry cap; 0(e) for `ctx.deltaCache`; Step 3 is NOT required — `path-layout.ts` is not consumed here; Step 4 is required for `pack-registry`.)

This is the most complex internal module. The iterative two-phase walker per design §10.1. Landed as its own step to get its own test battery.

### Signature

```typescript
export async function resolveObject(
  ctx: Context,
  id: ObjectId,
  verifyHash: boolean,
): Promise<GitObject>;
```

Consumed only by `readObject` (step 6). Not part of the public primitive surface.

### Algorithm (per design §10.1 + §7 cancellation cadence)

```
1. Check ctx.signal.aborted → throw OPERATION_ABORTED.
2. Try loose via ctx.fs.exists + read + inflate + parseHeader + parseObject → skip to step 6.
3. (loose miss) Check ctx.signal.aborted → throw OPERATION_ABORTED. (Boundary between fs operations per design §7.)
4. Try pack via packRegistry.lookup(id):
   a. No hit → throw OBJECT_NOT_FOUND.
   b. Hit → Check ctx.signal.aborted → throw OPERATION_ABORTED. (Belt-and-braces poll before the .pack readSlice — design §7 "before each fs read".)
   c. readSlice the entry, parsePackEntryHeader.
      d. Non-delta → inflate + parseObject → skip to step 6.
      e. Delta → enter iterative phase-1 walk:
          - Collect instruction buffers into an array until a non-delta base or a cache hit is found.
          - On each step: increment depth counter; throw DELTA_CHAIN_TOO_DEEP if depth > MAX_DELTA_CHAIN_DEPTH.
          - Phase-1 does NOT poll ctx.signal (each phase-1 step is a bounded fs read; abort latency is the size of the delta chain, bounded by MAX_DELTA_CHAIN_DEPTH = 50).
          - Phase-2: apply buffers bottom-up via applyDelta; populate ctx.deltaCache with each intermediate result.
5. (post-parse, pre-verify) Check ctx.signal.aborted → throw OPERATION_ABORTED. (Boundary between I/O and CPU-bound hash per design §14.8.)
6. verifyHash (if true): ctx.hash.hashHex(bytes) vs id; throw OBJECT_HASH_MISMATCH if different.
7. (post-hash) Check ctx.signal.aborted → throw OPERATION_ABORTED. (Per design §14.8 — hash is expensive; abort latency bounded identically to I/O.)
8. Return parseObject(bytes, id).
```

### Red

Per design §11.4 (the primitive-layer tests delegate to `resolveObject` internally; we add a direct test battery here):

```
Loose path: loose object only; returns parsed object. Covers each of blob/tree/commit/tag.
Pack path: pack-only; returns parsed object.
Loose shadows pack: both present with different bytes at same id; loose wins.
OFS_DELTA depth-2: base entry + delta entry → correct reconstruction.
REF_DELTA depth-2: base SHA in .idx; correct reconstruction.
Depth boundary triple: depth-49 passes (just-under); depth-50 passes (at); depth-51 throws DELTA_CHAIN_TOO_DEEP{depth: 51} (just-over). Three isolated tests.
Depth-51 chain + empty cache: assert applyDelta spy has ZERO invocations (counter fires in phase-1).
Depth-3 chain with depth-2 base already in cache: phase-1 stops at depth-2; phase-2 applies only 1 delta.
Entry-cap boundary triple at MAX_DELTA_CACHE_ENTRIES = 65_536 (each intermediate tiny so byte cap never fires):
  just-under: 65_535 intermediates → ctx.deltaCache.entryCount === 65_535, no eviction.
  at: exactly 65_536 intermediates → entryCount === 65_536, oldest still present.
  just-over: 65_537 intermediates → entryCount === 65_536, oldest evicted, newest present. Instrumented cache records entry-cap eviction code path (not byte-cap).
Byte-cap eviction with 30 large intermediates (each 2 MiB, total 60 MiB > 16 MiB cache): final result correct; non-delta base read exactly once.
verifyHash=true + mismatched content: throws OBJECT_HASH_MISMATCH with correct data.
verifyHash=false + mismatched content: returns the bytes without error.
Abort before loose probe (signal pre-armed): OPERATION_ABORTED, zero fs calls.
Abort after loose miss, before pack scan (signal fires mid-call): OPERATION_ABORTED; instrumented fs records ONE call (the loose probe), zero pack calls.
Abort after parse, before hashHex: OPERATION_ABORTED; instrumented hash records zero calls.
Abort after hashHex: OPERATION_ABORTED post-verification; instrumented hash records exactly one call.
Not found: id not in any source; throws OBJECT_NOT_FOUND{id}.
Unexpected object type would be caught here at parseObject — but the type check is a readObject-layer concern (§5.3–§5.4 narrowing wrappers). Exclude from this test battery.
```

### Green

Implement per §10.1. Iterative walker uses a local `Array<InstructionBuffer>` and `let depth = 0`. `ctx.deltaCache` is read in phase-1 (look up base by id), written in phase-2 (each intermediate result).

### Verify

```bash
npm run check:types && npm run test:unit -- test/unit/application/primitives/object-resolver && npm run check:architecture
```

**Commit.** `feat(primitives): add iterative object resolver (internal)`

---

## Step 6: `readObject` (§7.1)

**Create:** `src/application/primitives/read-object.ts`, `test/unit/application/primitives/read-object.test.ts`.

**Depends on:** Step 5.

### Signature

```typescript
export async function readObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<GitObject>;
```

### Green

Thin wrapper over `resolveObject`:

```typescript
export async function readObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<GitObject> {
  return resolveObject(ctx, id, options?.verifyHash ?? true);
}
```

### Red

Most invariants already covered by step 5's test battery. `read-object.test.ts` adds the public-surface tests per design §11.4:

```
Given no options passed, When readObject is called on a corrupted loose file whose content does NOT hash to id, Then throws OBJECT_HASH_MISMATCH with .data.expected and .data.actual set (proves default verifyHash is true at the public surface).
Given { verifyHash: false }, When readObject is called on the same corrupted loose file, Then returns the bytes without error.
Given two readObject calls under the same ctx resolving the same delta chain, When instrumented, Then the non-delta base is read from fs exactly once (shared ctx.deltaCache).
Given signal pre-armed to fire between loose probe and pack scan, When readObject is called, Then throws OPERATION_ABORTED; instrumented fs records ONE loose-probe call, zero pack-scan calls.

Public-surface loose-before-pack ORDERING test (design §11.14 mutation pattern — distinct from the Step 5 internal test):
  Given a loose object at SHA X AND a pack containing a DIFFERENT byte-content entry under SHA X, When readObject(ctx, X) is called WITH the public API (no internal knowledge), Then returns the loose bytes. Instrumented fs records the fs.exists loose-probe BEFORE any packRegistry call. Detects "pack-first" regressions at the primitive boundary.
```

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

**Commit.** `feat(primitives): add readObject`

---

## Step 7: `writeObject` (§7.2)

**Create:** `src/application/primitives/write-object.ts`, `test/unit/application/primitives/write-object.test.ts`.

**Depends on:** Steps 0(e), 0(f), 1, 2. (Design §12 lists "Parallel with 6" — an ordering hint, not a real dependency. writeObject does not invoke `readObject` or `resolveObject`; content-addressed round-trip verification is a laws-test concern at Step 19.)

### Signature

```typescript
export async function writeObject(
  ctx: Context,
  object: GitObject,
): Promise<ObjectId>;
```

### Red (design §11.5)

```
Happy path: write a blob; return id equals ctx.hash.hashHex(serializeObject(object)); loose file exists at path.
Idempotence: two calls with identical object succeed; second catches FILE_EXISTS from writeExclusive.
Id mismatch (caller pre-populated object.id): object.id !== computed id → throws OBJECT_HASH_MISMATCH.
mkdir-then-gc-rmdir race: arrange fs spy to remove the objects/xx/ dir between mkdir and writeExclusive; writeExclusive port retries and succeeds. (Relies on step 0(f) contract.)
Abort before hash: OPERATION_ABORTED, no writes.
Abort after hash, before write: OPERATION_ABORTED.
All four object types (blob/tree/commit/tag) round-trip readObject(writeObject(x)) ≡ x — one sanity test per type here; fast-check property coverage lands in Step 19 laws.
Compression round-trip (§11.5): after writeObject, memory fs records the written bytes; ctx.compressor.inflate(stored) equals serializeObject(object, ctx.hashConfig). Pins the deflate wiring; a mutant skipping deflate would fail this test even though the round-trip test passes (deflate(x) then inflate → x).
Atomic-write visibility (§11.5): immediately after writeObject(x) resolves, readObject(id) returns the same object bytes (no racy visibility window).
```

### Green

```typescript
import type { Context } from '../../ports/context.js';
import type { GitObject, ObjectId } from '../../domain/objects/git-object.js';
import { serializeObject } from '../../domain/objects/git-object.js';
import { objectHashMismatch } from '../../domain/objects/error.js';
import { operationAborted } from '../../domain/error.js';
import { looseObjectPath, objectsDir } from './path-layout.js';

export async function writeObject(ctx: Context, object: GitObject): Promise<ObjectId> {
  if (ctx.signal?.aborted) throw operationAborted();
  const bytes = serializeObject(object, ctx.hashConfig);
  const computed = ctx.hash.hashHex(bytes);
  if (object.id && object.id !== computed) throw objectHashMismatch(object.id, computed);
  if (ctx.signal?.aborted) throw operationAborted();
  const prefix = computed.slice(0, 2);
  await ctx.fs.mkdir(objectsDir(ctx.config.gitDir, prefix));
  const path = looseObjectPath(ctx.config.gitDir, computed);
  const compressed = await ctx.compressor.deflate(bytes);
  try {
    await ctx.fs.writeExclusive(path, compressed);
  } catch (error) {
    if (isFileExists(error)) return computed; // idempotent success
    throw error;
  }
  return computed;
}

function isFileExists(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_EXISTS';
}
```

`objectsDir(gitDir, prefix)` is added to the Step 3 `path-layout.ts` helpers (update that step's listed signatures if not already covered). Using the helper avoids the `dirname` import ambiguity flagged in R1.

### Verify

Standard chain.

**Commit.** `feat(primitives): add writeObject`

---

## Step 8: `readBlob` (§7.5)

**Create:** `src/application/primitives/read-blob.ts`, test.

**Depends on:** Step 6.

### Green

```typescript
export async function readBlob(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<Blob> {
  const object = await readObject(ctx, id, options);
  if (object.type !== 'blob') throw unexpectedObjectType('blob', object.type, id);
  return object;
}
```

### Red (design §11.6)

```
Given a blob id, When readBlob is called, Then returns Blob with correct content.
Given a tree id, When readBlob is called, Then throws UNEXPECTED_OBJECT_TYPE{expected: 'blob', actual: 'tree', id}.
Given a commit id, Then UNEXPECTED_OBJECT_TYPE{actual: 'commit'}.
Given a tag id, Then UNEXPECTED_OBJECT_TYPE{actual: 'tag'}.
Options propagate: readBlob(ctx, id, { verifyHash: false }) → readObject sees the opt-out.
```

**Commit.** `feat(primitives): add readBlob`

---

## Step 9: `resolveRef` (§7.8)

**Create:** `src/application/primitives/resolve-ref.ts`, test.

**Depends on:** Steps 1–4.

### Signature

```typescript
export async function resolveRef(
  ctx: Context,
  name: RefName | 'HEAD',
  options?: ResolveRefOptions,
): Promise<ObjectId>;
```

### Green (per design §5.6)

Algorithm:
1. `validateRefName(name)` (rejects all the hardened cases per step 0(d)).
2. Build `refPath = looseRefPath(gitDir, name)`; verify `refPath` starts with `gitDir + '/'` else `invalidRef('target escapes gitDir')`.
3. Delegate to `refStore.resolveDirect(name)` → `ObjectId | undefined`.
4. If undefined → `refNotFound(name)`.
5. If the loose-ref file was a symbolic target, follow with a cycle-checking loop, capped at `maxSymbolicDepth` (default 5).
6. If `peel: true`, walk the tag chain via `peelOneLevel` capped at `maxPeelDepth` (default 5).
7. Return the final `ObjectId`.

### Red (design §11.7)

Reproduced inline per Phase 6 convention:

```
Loose-only: refs/heads/main as loose → returns id.
Packed-only: same ref in packed-refs → returns id.
Loose shadows packed: both present with different ids → loose wins.
Symbolic chain: HEAD → refs/heads/main → <id> → returns id.
Cycle: HEAD → refs/heads/loop → HEAD → REF_CYCLE_DETECTED{chain}.

Symbolic depth boundary (isolated from peel — §11.7 R2 requirement):
  just-under (chain of 4 symbolic refs, maxSymbolicDepth=5) → succeeds.
  at (chain of 5, maxSymbolicDepth=5) → succeeds.
  just-over (chain of 6, maxSymbolicDepth=5) → REF_CHAIN_TOO_DEEP{depth: 6}.

Peel depth boundary (isolated from symbolic — §11.7 R2 requirement):
  just-under (tag chain of 4, maxPeelDepth=5, peel:true) → succeeds.
  at (chain of 5) → succeeds.
  just-over (chain of 6) → REF_CHAIN_TOO_DEEP{depth: 6}.

Mixed chain within both caps: 3 symbolic refs + 2 tag peels, both caps=5 → succeeds.
  Pins the decoupling: each counter consumed independently.

Peel happy path: annotated tag → peel:true → returns the pointed commit.
Path escape rejected: symbolic target resolves to path outside gitDir → INVALID_REF{reason: /target escapes gitDir/}.
Invalid name: '..' → INVALID_REF (domain validateRefName).
```

Total: 15 tests. Each boundary cap spells out all three (just-under / at / just-over) isolated tests per CLAUDE.md.

**Commit.** `feat(primitives): add resolveRef`

---

## Step 10: `updateRef` (§7.9)

**Create:** `src/application/primitives/update-ref.ts`, test.

**Depends on:** Steps 3, 4, 9.

### Signature

```typescript
export async function updateRef(
  ctx: Context,
  name: RefName,
  newId: ObjectId,
  options?: UpdateRefOptions,
): Promise<void>;
```

### Green (per design §5.7 / §9)

**Durability limitation (design §14.9).** `updateRef` is best-effort durable in v1 — the lock-file + rename sequence does NOT call `fsync` between rename and return. A crash between rename and fsync leaves the ref visible but potentially not persisted on disk. Phase 11 (polish) will add `fs.fsync(path)` to the port and upgrade `atomic-write.ts` to call it. Tracked in design §14.9. Step 10 is intentionally silent on fsync; an implementer who adds it here would break the Phase 11 boundary.

Algorithm (from design §9.1):
1. `validateRefName(name)`.
2. Path containment check on both `lockPath` and `refPath`.
3. If `options.expected` is set: `resolveDirect(name)` under lock, compare, throw `REF_UPDATE_CONFLICT` on mismatch.
4. If `options.delete === true`: if loose file exists, `fs.rm` it; if only in packed-refs, throw `UNSUPPORTED_OPERATION`. (No packed-refs rewrite in v1.)
5. Else: `atomicWriteRef(ctx, refPath, serializeDirectRef(newId))`.

### Red (design §11.8)

Reproduced inline per Phase 6 convention:

```
Happy path: new ref created from absent; subsequent resolveRef returns new id.
Lock busy: pre-create {name}.lock; updateRef throws REF_LOCKED.

CAS isolated-disjunct triple (design §11.14 mandates isolation for the OR-guard
`if (expected !== 'absent' && current !== expected)`):
  CAS hit (expected: oldId, current === oldId): succeeds.
  CAS miss on expected-id (expected: oldId, current is differentId):
    throws REF_UPDATE_CONFLICT{expected, actual}; lock file removed.
  CAS 'absent' happy (expected: 'absent', current absent): succeeds.
  CAS 'absent' on existing ref:
    throws REF_UPDATE_CONFLICT{expected: 'absent', actual: <id>}; lock removed.
  (Four isolated tests, each exercising exactly one arm of the disjunction.)

Crash between write and rename: simulate by throwing inside a wrapped fs; assert
  lock file is cleaned up (try/finally covered by atomic-write helper).
Invalid ref name: '..' → INVALID_REF.
Packed-only delete: delete:true on packed-only ref → UNSUPPORTED_OPERATION
  with data.operation === 'delete-packed-ref'.
Path escape rejected: crafted ref name whose resolved path escapes gitDir →
  INVALID_REF{reason: /target escapes gitDir/}. Proves §5.7 containment check fires.
```

Each assertion uses try/catch + `.data.code` + `.data.<field>` checks per CLAUDE.md §Mutation-Resistant Test Patterns.

**Commit.** `feat(primitives): add updateRef`

---

## Step 11: `readIndex` (§7.10)

**Create:** `src/application/primitives/read-index.ts`, test.

**Depends on:** Steps 1–2.

### Green (per design §5.8)

```typescript
export async function readIndex(ctx: Context): Promise<GitIndex> {
  const path = indexPath(ctx.config.gitDir);
  if (!(await ctx.fs.exists(path))) return emptyIndex();
  const stat = await ctx.fs.stat(path);
  if (stat.size > MAX_INDEX_BYTES) throw invalidIndexHeader(`index file exceeds 256 MiB`);
  const bytes = await ctx.fs.read(path);
  const parsed = parseIndex(bytes);
  const computed = ctx.hash.hashHex(bytes.subarray(0, bytes.length - 20));
  const trailer = bytesToHex(bytes.subarray(bytes.length - 20));
  if (computed !== trailer) throw invalidIndexHeader(`checksum mismatch: expected=${computed} actual=${trailer}`);
  return parsed;
}
```

### Red (design §11.9)

Reproduced inline per Phase 6 convention:

```
Given no .git/index file, When readIndex is called, Then returns { version: 2, entries: [], extensions: [] }.
Given a serialized index via serializeIndexFixture, When readIndex is called, Then returns the deep-equal GitIndex (round-trip).
Given an index whose final 20-byte SHA is mutated, When readIndex is called, Then throws INVALID_INDEX_HEADER with .data.reason matching /checksum mismatch: expected=[0-9a-f]{40} actual=[0-9a-f]{40}/.
Given an index containing a synthetic opaque extension, When readIndex is called, Then the extension bytes round-trip verbatim.

MAX_INDEX_BYTES boundary triple:
  Given a .git/index whose stat size is 256 MiB - 1 byte (just-under), When readIndex is called, Then proceeds to read+parse (no short-circuit throw).
  Given a size of exactly 256 MiB (at), Then proceeds.
  Given a size of 256 MiB + 1 byte (just-over), Then throws INVALID_INDEX_HEADER with .data.reason matching /exceeds 256 MiB/ WITHOUT calling fs.read (instrumented fs asserts zero read calls past stat).
  All three tests use a test-fs adapter that returns the size via stat without materializing the bytes.
```

7 tests total. Each error assertion uses try/catch + `.data.code` + `.data.reason` regex per §11.14.

**Commit.** `feat(primitives): add readIndex`

---

## Step 12: `createCommit` (§7.11)

**Create:** `src/application/primitives/create-commit.ts`, test.

**Depends on:** Step 7, Step 0(a).

### Green (per design §5.9)

```typescript
export async function createCommit(ctx: Context, input: CreateCommitInput): Promise<ObjectId> {
  validateCommitInput(input); // NUL in message, MAX_COMMIT_MESSAGE_BYTES, identity roundtrip
  const commit: Commit = {
    type: 'commit',
    data: { tree: input.tree, parents: input.parents, author: input.author, committer: input.committer, message: input.message, gpgSignature: input.gpgSignature, extraHeaders: input.extraHeaders ?? [] },
    id: '' as ObjectId,
  };
  return writeObject(ctx, commit);
}
```

### Red (design §11.10)

Reproduced inline per Phase 6 convention:

```
Given a valid tree + empty parents (root commit), When createCommit is called, Then returns a valid ObjectId and readObject(id) yields the written commit.
Given a commit with 2+ parents (merge commit), When createCommit is called, Then .data.parents preserves caller-supplied order.
Given input.gpgSignature and input.extraHeaders set, When createCommit is called, Then readObject(id) round-trips both fields verbatim.
Given input.message containing '\0', When createCommit is called, Then throws INVALID_COMMIT with .data.reason matching /message contains NUL/.
Given a malformed input.author (parseIdentity roundtrip fails), When createCommit is called, Then throws INVALID_IDENTITY.
Given empty parents + empty extraHeaders, When createCommit is called, Then the computed id byte-matches a golden fixture produced by running real git on the same canonical input.

MAX_COMMIT_MESSAGE_BYTES boundary triple:
  Given input.message of 16 MiB - 1 byte (just-under), Then succeeds.
  Given input.message of exactly 16 MiB (at), Then succeeds.
  Given input.message of 16 MiB + 1 byte (just-over), Then throws INVALID_COMMIT with .data.reason matching /message exceeds 16 MiB/.

Identity newline-injection matrix (R3 §11.10 bullets):
  For each field ∈ {author.name, author.email, committer.name, committer.email}:
    Given the field contains '\n', When createCommit is called, Then throws INVALID_IDENTITY with .data.reason matching /forbidden control character/.
    Given the field contains '\r', Then same.
  (8 isolated tests total — 4 fields × 2 characters — per CLAUDE.md guard-isolation rule.)
```

17 tests total. Every error assertion uses try/catch + `.data.code` + `.data.reason` regex.

**Commit.** `feat(primitives): add createCommit`

---

## Step 13: `readTree` (§7.3)

**Create:** `src/application/primitives/read-tree.ts`, test.

**Depends on:** Steps 6, 9.

### Green (per design §5.4)

`readTree`'s peel chain reuses `REF_CHAIN_TOO_DEEP` intentionally — the code describes a ref-like chain limit (symbolic/peel), and tags-pointing-to-tags is semantically a ref-style traversal even though the input was an `ObjectId`. The `chain` field is empty for `readTree` (no RefNames are threaded); the `depth` field carries the overflow count. Tracked explicitly here so reviewers don't flag it as a code-reuse smell.

```typescript
export async function readTree(ctx: Context, ref: RefName | ObjectId): Promise<Tree> {
  const id = isObjectId(ref) ? ref : await resolveRef(ctx, ref, { peel: false });
  let current = id;
  let object = await readObject(ctx, current);
  let depth = 0;
  while (object.type === 'commit' || object.type === 'tag') {
    if (++depth > MAX_PEEL_DEPTH) throw refChainTooDeep(depth, []);
    current = object.type === 'commit' ? object.data.tree : peelOneLevel(object).id;
    object = await readObject(ctx, current);
  }
  if (object.type !== 'tree') throw unexpectedObjectType('tree', object.type, current);
  return object;
}
```

### Red (design §11.6)

```
Given a tree id, When readTree is called, Then returns Tree.
Given a commit id, When readTree is called, Then peels to the commit's tree.
Given an annotated tag pointing to a commit, When readTree is called, Then peels tag→commit→tree.
Given 'HEAD' as ref, When readTree is called, Then resolves HEAD → reads the HEAD commit → peels to its tree (most common user entry point; design §11.6 listed first).
Given a tag chain of depth 5 under default maxPeelDepth=5, Then succeeds.
Given a tag chain of depth 6 under default maxPeelDepth=5, Then throws REF_CHAIN_TOO_DEEP{depth: 6, chain: []}.
Given a tag chain of depth 4 under maxPeelDepth=5, Then succeeds (just-under boundary).
Given a blob id, Then UNEXPECTED_OBJECT_TYPE{expected: 'tree', actual: 'blob', id}.
```

**Commit.** `feat(primitives): add readTree`

---

## Step 14: `writeTree` (§7.4)

**Create:** `src/application/primitives/write-tree.ts`, test.

**Depends on:** Step 7.

### Green (per design §5.5)

```typescript
export async function writeTree(ctx: Context, entries: ReadonlyArray<TreeEntry>): Promise<ObjectId> {
  const sorted = sortTreeEntries(entries);
  const tree: Tree = { type: 'tree', data: { entries: sorted }, id: '' as ObjectId };
  return writeObject(ctx, tree);
}
```

### Red (design §11.6)

```
Given 3 unsorted entries, When writeTree is called, Then returns id equal to writing the sorted version.
Given 0 entries, Then returns the canonical empty-tree id.
Given duplicate entry names, Then throws INVALID_TREE_ENTRY with .data.reason matching /duplicate entry/ (domain sortTreeEntries validates).
Given MAX_FLAT_TREE_ENTRIES entries (Phase 5 constant; just-under), Then succeeds.
Given MAX_FLAT_TREE_ENTRIES entries exactly (at), Then succeeds.
Given MAX_FLAT_TREE_ENTRIES + 1 entries (just-over), Then throws TREE_ENTRY_LIMIT_EXCEEDED{count, limit}.
Roundtrip: readTree(writeTree(entries)) yields the same sorted entries.
```

**Commit.** `feat(primitives): add writeTree`

---

## Step 15: `walkCommits` (§7.6)

**Create:** `src/application/primitives/walk-commits.ts`, test.

**Depends on:** Steps 6, 9.

### Green (per design §5.10)

Key implementation points:
- Validate `from.length` between 1 and `MAX_WALK_SEEDS = 1024`.
- Maintain `visitedSet: Set<string>` (yielded ids) and `missingSet: Set<string>` (missing ids under ignoreMissing).
- Ordering: for `topo`, Kahn's algorithm with a `pending-count` map keyed by child `ObjectId` (count = unvisited parents); a parent's entry decrements when the parent is **emitted**, not when queued. Ties broken by lexicographic `ObjectId`. For `date`, an inline binary heap keyed by `commit.data.committer.timestamp` (not stable — clock-skew case accepted per design §4.5); ties broken by lexicographic `ObjectId`. For `first-parent`, a simple stack that only pushes `parents[0]`. The binary heap is a local helper inside `walk-commits.ts` — not a shared utility. ~30 lines; a sift-up/sift-down with `Array<{id, timestamp}>` storage.
- Between each yield, check `ctx.signal.aborted` → throw `operationAborted()`.
- `options.verifyHash ?? true` threaded to every `readObject` call.
- `ignoreMissing`: catch `OBJECT_NOT_FOUND` on parent reads; record in `missingSet`; subsequent reads short-circuit via the set without another fs call.

### Red (design §11.11)

All tests from design §11.11, reproduced inline per Phase 6 convention:

```
Empty from: INVALID_WALK_INPUT with data.reason matching /empty/.
from exceeds MAX_WALK_SEEDS boundary — just-under (1023 seeds) passes;
  at (1024 seeds) passes; just-over (1025 seeds) throws INVALID_WALK_INPUT /too many seeds/. (Three isolated tests.)
Single-commit walk: from: [rootId], no parents → yields root then ends.
Linear topo: 5 commits A→B→C→D→E, order 'topo' → yields [E, D, C, B, A].
Diamond topo: merge graph; no duplicates; parents emitted before children.
until boundary: from: [headId], until: [rootId] → root excluded.
Date ordering with distinct timestamps: strict descending.
Date ordering with clock skew (parent has later date than child): documented non-stability; test asserts the set is emitted but does not pin the order.
First-parent: merge commit's second parent is NOT visited.
Missing parent (strict): ignoreMissing=false → OBJECT_NOT_FOUND.
Missing parent (ignored): ignoreMissing=true → child yielded, missing parent skipped.
Shallow-boundary detection: child's .parents keeps the absent id post-yield.
missingSet short-circuit: 10 commits referencing the same missing parent A under
  ignoreMissing=true — instrumented fs records exactly ONE read attempt for A.
verifyHash default=true propagates to readObject calls (instrumented hash records N calls for N yielded commits).
verifyHash=false propagates (instrumented hash records zero calls).
Seeding order with disjoint histories: from=[A, B] topo → [A...B...]; from=[B, A] → [B...A...].

§8.2 cleanup cascade — three-tier pattern per Phase 6 operators plan Step 6 (observable via iter.next() state + instrumented fs):
  (a) Natural exhaustion: finite graph walked to end; iter.next() returns { done: true } after the last yielded commit.
  (b) Source self-abort: readObject throws mid-walk (synthetic corrupted pack); generator propagates; subsequent iter.next() returns { done: true }; instrumented fs records no reads after the throw.
  (c) Consumer throw: for-await caller throws inside the loop body; generator's implicit IteratorClose fires; subsequent iter.next() returns { done: true }; instrumented fs records no further reads.

Abort signal mid-walk: signal pre-armed to fire on second yield; OPERATION_ABORTED at second yield only.
Consumer break cascades cleanup: take(3) over a 1000-commit chain; instrumented fs records 3 commit reads.
ctx.deltaCache shared across walk: instrumented walk over a pack with shared base; fs base-read count
  matches expected LRU behavior (one base read per distinct base).
Property: no duplicate yields — for any graph and any order, emitted ids form a set.
```

Approximately 22 tests total. All use try/catch + `.data.code` + `.data.<field>` regex assertions per CLAUDE.md §Mutation-Resistant Test Patterns. The boundary-triple on `MAX_WALK_SEEDS` isolates each disjunct.

**Commit.** `feat(primitives): add walkCommits`

---

## Step 16: `walkTree` (§7.7)

**Create:** `src/application/primitives/walk-tree.ts`, test.

**Depends on:** Step 6.

### Green (per design §5.11)

Key implementation points:
- Descent-stack `ObjectId[]` tracks the current root-to-leaf path; NOT a global visited-set.
- Byte-ordered yield via `sortTreeEntries` output + per-subtree recursion merge.
- `recursive: true` (default) recurses into DIRECTORY entries; gitlinks (mode `160000`) are yielded but NOT recursed.
- Symlinks (mode `120000`) are yielded; walker does NOT readlink.
- `maxDepth`, `maxEntries` guards.

### Red (design §11.12)

Reproduced inline per Phase 6 convention:

```
Empty tree: yields nothing.
Flat tree: 3 blobs at root → yields 3 entries in byte-order.
Nested tree: 2 subdirs + 2 files → 2 files + recursed subdir contents, byte-order interleaved.
recursive: false → yields only top-level entries (DIRECTORY entries yielded, children not pulled).
maxDepth boundary: just-under (depth 5, maxDepth 5) succeeds; at-boundary depth 5 ok; just-over
  (depth 6, maxDepth 5) throws TREE_DEPTH_EXCEEDED{depth: 6}. Three isolated tests.
maxEntries boundary: just-under / at / just-over triple on TREE_ENTRY_LIMIT_EXCEEDED.
Cycle (self-loop): tree whose subtree id equals its own id → TREE_CYCLE_DETECTED{id}.
Cycle (indirect): tree A → tree B → tree A → TREE_CYCLE_DETECTED{id: A} when walker re-enters A.
Shared subtree is NOT a cycle: root with two children src/ and test/src/ pointing to the same
  subtree id S; walker yields every entry of S twice (once per parent path) without throwing.
  Pins that cycle detection uses the descent-stack, not a global visited-set.
Gitlink not recursed: tree containing a gitlink (mode 160000) → entry yielded; instrumented fs
  records no readObject for the gitlink's target (§15.4 Phase 5 obligation).
Symlink not followed: symlink entry (mode 120000) yielded; no readlink, no recursion.
FlatTree insertion-order is byte-order: Array.from((await toFlatTree(ctx, root)).entries.keys())
  is already sorted (§15.1 Phase 5 obligation — the single most important test).

§8.2 cleanup cascade — three-tier pattern per Phase 6 operators plan Step 6:
  (a) Natural exhaustion: finite tree walked to end; iter.next() returns { done: true, value: undefined } on the last call; subsequent iter.next() stays `done: true`.
  (b) Source self-abort: readObject throws on a subtree read; generator propagates the error out; subsequent iter.next() returns { done: true }; instrumented fs records no calls after the throw.
  (c) Consumer throw: for-await caller throws inside the loop body; the generator's implicit IteratorClose fires; subsequent iter.next() returns { done: true } and instrumented fs records no further reads after the throw point. (Observable proxy for "finally ran" — the descent-stack's clearing is not directly observable, but the done-state and no-further-reads prove the generator is fully torn down.)

Abort signal mid-walk: OPERATION_ABORTED between outer yields.
Consumer break cascades cleanup: take(3) over a 10k-entry tree; instrumented fs reads match.
```

**Commit.** `feat(primitives): add walkTree`

---

## Step 17: `diffTrees` (primitive, §7.12)

**Create:** `src/application/primitives/diff-trees.ts`, test.

**Depends on:** Steps 6, 13. (Green sketch calls `readTree` directly — not a transitive dep; Step 13 is a hard prerequisite.)

### Green (per design §5.12)

Thin wrapper around domain `diffTrees`:

```typescript
export async function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options?: DiffTreesOptions,
): Promise<TreeDiff> {
  const treeA = isTree(a) ? a : a ? await readTree(ctx, a) : undefined;
  const treeB = isTree(b) ? b : b ? await readTree(ctx, b) : undefined;
  const raw = domainDiffTrees(treeA, treeB);
  return options?.detectRenames ? detectRenames(raw, options.renameOptions) : raw;
}
```

### Red (design §11.13)

Reproduced inline per Phase 6 convention:

```
Given a === undefined and b === undefined, When diffTrees is called, Then yields an empty TreeDiff.
Given a tree with one blob 'a.txt' and b tree empty, When diffTrees is called, Then yields one AddChange for 'a.txt'.
Given a tree with 'a.txt' (id X) and b tree with 'a.txt' (id Y, Y ≠ X), When diffTrees is called, Then yields one ModifyChange.
Given a tree with 'a.txt' blob and b tree with 'a.txt' as symlink (type change), When diffTrees is called, Then yields a TypeChange.
Given an ObjectId input for a, When diffTrees is called, Then delegates to readTree(ctx, a) and returns the same output as passing the parsed Tree.
Given options.detectRenames === true and an exact-match rename between a and b, When diffTrees is called, Then yields a RenameChange (via the Phase 5 rename-detect pass).
```

6 tests total. Assertions use try/catch + `.data.code` for error paths; positive paths assert on the TreeDiff shape deep-equality.

**Commit.** `feat(primitives): add diffTrees (primitive)`

---

## Step 18: Barrel export + public types + size-limit entry

**Modify:** `src/application/primitives/index.ts` (currently `export {};`), `.size-limit.json`.

**Depends on:** Steps 6–17 (every primitive green).

### Actions

Alphabetized barrel per Biome `organizeImports: "on"`:

```typescript
export { createCommit } from './create-commit.js';
export { diffTrees } from './diff-trees.js';
export { readBlob } from './read-blob.js';
export { readIndex } from './read-index.js';
export { readObject } from './read-object.js';
export { readTree } from './read-tree.js';
export { resolveRef } from './resolve-ref.js';
export { updateRef } from './update-ref.js';
export { walkCommits } from './walk-commits.js';
export { walkTree } from './walk-tree.js';
export { writeObject } from './write-object.js';
export { writeTree } from './write-tree.js';
export type * from './types.js';
```

`.size-limit.json` — add entry `"Primitives"` with `limit: "80 kB"`, `gzip: true`, `path: "dist/esm/application/primitives/index.js"`.

### Red

`test/unit/application/primitives/index.test.ts`:

```
Structural: all 12 named exports are typeof 'function'. Kills "missing export" mutants.
Identity smoke: each re-export resolves to the same function reference as the direct import
  (e.g. `import { readObject as A } from '...'` and `import { readObject as B } from '.../read-object.js'`
  then `expect(A).toBe(B)`). Kills "exported the wrong symbol" mutants (e.g. a
  mis-wired barrel that exports `readBlob` under the name `readTree` would pass
  the structural test but fail identity).
Type-only export: types module re-exports expected option shapes (compile-time check
  via expectTypeOf: Awaitable-style type assertion per Phase 6 operators barrel).
```

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:dead-code && npm run build && npm run check:size
```

**Commit.** `feat(primitives): add barrel exports and size-limit entry`

---

## Step 19: `laws.test.ts` — property tests

**Create:** `test/unit/application/primitives/laws.test.ts`.

**Depends on:** Step 18.

### Laws (design §11.15)

```
Roundtrip: writeObject → readObject is identity for all 4 object types. (Arbitrary: fc.record({ type, data }) per type.)
Ref roundtrip: updateRef → resolveRef returns the same id.
Tree order: writeTree(entries) produces byte-identical output for any permutation of entries.
Commit construction: createCommit(input) → readObject(id) yields Commit with input's data.
WalkCommits no-duplicates: emitted ids form a set for any graph and any order.
WalkCommits first-parent linearity: for any graph with a tip T, walkCommits(ctx, { from: [T], order: 'first-parent' }) yields exactly the sequence [T, T.parents[0], T.parents[0].parents[0], …] — length equals the first-parent chain length; no merge parents included.
WalkTree byte-sorted paths: yielded paths form a strictly-sorted sequence under byte-order comparison.
DiffTrees self: diffTrees(tree, tree) yields [].
```

8 laws — `first-parent linearity` added in R1 review to match design §11.15 exactly.

**Arbitrary state discipline.** Every `fc.assert` iteration MUST build a fresh `buildSeededContext` — no shared mutable `Context`, no reused pack, no carried-over LRU across runs. Fast-check shrinking interacts poorly with shared state and produces false failures / false successes. Explicit rule: arbitraries produce input *descriptions* (shapes), and the property body constructs the Context inside the async predicate from that description.

**Arbitrary shapes (per law):**
- Roundtrip: `fc.oneof(fc.record(blobArb), fc.record(treeArb), fc.record(commitArb), fc.record(tagArb))`.
- Ref roundtrip: `fc.record({ name: refNameArb, id: objectIdArb })`.
- Tree order: `fc.array(fc.record(treeEntryArb), { minLength: 0, maxLength: 50 })` → shuffled variants compared.
- Commit construction: `fc.record(commitInputArb)`.
- WalkCommits no-duplicates + first-parent linearity: `commitGraphArb` (DAG generator producing `{ commits, tips }`).
- WalkTree byte-sorted paths: `fc.record(treeShapeArb)`.
- DiffTrees self: `fc.record(treeArb)`.
Each `*Arb` is a named module-local arbitrary. Defined inline at the top of `laws.test.ts`, no cross-test sharing.

Property tests use `fast-check` (already devDependency).

### Verify

Standard chain.

**Commit.** `test(primitives): add composition-law property tests`

---

## Step 20: Mutation testing + parallel reviews + finalization

**Not a code step** — finalization workflow per CLAUDE.md §Post-Build Workflow.

1. **Mutation testing — scoped run.** The default `npm run test:mutation` (Stryker) mutates `src/**/*.ts`, which would flag surviving mutants in unrelated Phase 1–6 code and block the merge gate. Use a scoped override targeting only Phase 7 code AND the Step 0 amendments:

   ```bash
   npx stryker run --mutate 'src/application/primitives/**,\
   src/domain/objects/error.ts,src/domain/storage/error.ts,src/domain/refs/error.ts,\
   src/domain/error.ts,src/domain/storage/delta.ts,src/domain/storage/lru-cache.ts,\
   src/domain/refs/ref-validation.ts,src/domain/objects/author-identity.ts,\
   src/ports/context.ts,src/ports/file-system.ts,src/adapters/**'
   ```

   Fix every surviving mutant. Accept only provably equivalent ones with inline `// Stryker disable next-line all -- equivalent, see design §<ref>` annotations at the mutated line (landed during each step's green phase where possible).
2. Run 4× parallel reviews per CLAUDE.md post-build workflow:
   - `code-reviewer` — code correctness.
   - `security-reviewer` — public-API attack surface; re-verify the §14 security contracts landed correctly.
   - `profiling-driven-optimization` skill — hot-path cost on realistic workloads (log of 10k commits, status of 50k files, clone-sized pack read).
   - `test-review` skill — coverage / mutation / GWT compliance.

   Address all CRITICAL and HIGH findings before merge.
3. Update docs:
   - `docs/BACKLOG.md` — mark 7.1–7.12 as `[x]`; update the "Progress" line.
   - `README.md` — if the README has a primitives entry or feature matrix, update it.
   - `docs/design/primitives.md` — add post-implementation notes at the top if any design decision changed during TDD (pattern: operators/diff-and-merge §Review Notes).
4. Final `npm run validate` — full quality gate green.
5. Commit final docs update on the implementation branch.
6. Squash-and-merge to main: single commit with subject `feat(primitives): add phase 7 — primitives`, matching Phase 6 convention.
7. Cleanup: delete the implementation branch (`git branch -D feat/phase-7-primitives`) or worktree (`git worktree remove .claude/worktrees/phase-7-primitives`).

---

## Dependency Graph

```
Step 0 (a,b,c,d,e,f)  ─── sequential, six prerequisite commits

         │
         ▼
Step 1  (fixtures)        ─── parallel with Step 2 (no shared files)
Step 2  (error codes + types.ts)  ─── parallel with Step 1

         │ (both complete)
         ▼
Step 3  (path-layout + atomic-write)  ─── must land before Step 4

         │
         ▼
Step 4  (pack-registry + ref-store)   ─── imports path-layout helpers

         │ (step 4 complete)
         ▼
Step 5  (object-resolver iterative walker)  ─── needs 0(b), 0(c), 0(e), 1, 2, 4

         │
         ▼
Step 6  (readObject)  ── needs 5
Step 7  (writeObject) ── needs 0(e), 0(f), 1, 2  (parallel with 6; does NOT need 5)

         │
         ▼
Step 8  (readBlob)     ── needs 6
Step 9  (resolveRef)   ── needs 4 (does NOT need 6 or 7; parallel with them)
Step 11 (readIndex)    ── needs 1, 2 (parallel with most of the post-5 fan-out)

Step 10 (updateRef)    ── needs 3, 4, 9
Step 12 (createCommit) ── needs 7, 0(a)
Step 13 (readTree)     ── needs 6, 9
Step 14 (writeTree)    ── needs 7
Step 15 (walkCommits)  ── needs 6, 9
Step 16 (walkTree)     ── needs 6
Step 17 (diffTrees)    ── needs 6 (plus 13 transitively via readTree)

         │
         ▼
Step 18 (barrel + size)  ── needs 6–17

         │
         ▼
Step 19 (laws)           ── needs 18

         │
         ▼
Step 20 (finalize)       ── mutations + 4× reviews + docs + merge
```

**Parallelizable groups:**

- Steps 1 + 2 can land in parallel — Step 1 touches only `test/unit/**`; Step 2 touches only `src/domain/**/error.ts` and `src/application/primitives/types.ts`.
- Steps 3 and 4 are sequential — Step 4's `ref-store.ts` and `pack-registry.ts` import path helpers from Step 3.
- Steps 6 + 7 + 9 + 11 can land in parallel once their prereqs are satisfied (6 needs 5; 7 needs 0(e)/0(f) + 2; 9 needs 4; 11 needs 2).
- Steps 8, 12, 13, 14, 15, 16, 17 fan out from the core primitive set — each depends on one or two predecessors and shares no files with siblings in the same wave.

---

## Post-Plan — next branch

Once this plan file is reviewed and merged, open a fresh branch for Step 0 of implementation:

```bash
git checkout main
git checkout -b feat/phase-7-primitives
# or using a worktree for parallel work:
git worktree add .claude/worktrees/phase-7-primitives -b feat/phase-7-primitives
```

Execute Steps 0(a) → 20 on that branch. Do not commit implementation code to the current `plan/phase-7-primitives` branch.
