# Phase 20.1 implementation plan — Snapshot and join primitive

Derived from `design/phase-20-1-snapshot-and-join.md` and ADRs 148–161.
Steps are ordered for atomic commits — each commit is independently
reviewable and (where possible) independently runnable.

Wave numbering mirrors the design doc:
- Wave 0: harness extension (1 commit).
- Wave 1: snapshot+join primitive introduction (17 commits).
- Waves 2–7: consumer migrations (6 commits).
- Wave 8: walker deprecation (1 commit).

Total: ~25 commits in one PR. PR splits at last green wave if a later
wave stalls (per ADR-151).

## Step 0 — Pre-flight

- Branch: `feat/20-1-snapshot-join` (already created; spike v3, 14 ADRs,
  design doc v2 already committed).
- Verify baseline: `npm ci && npm run validate` green on the branch.
- Confirm `package.json:version = 1.3.0` — bump to `2.0.0` happens in
  Wave 8 (per ADR-152).
- Read `design/phase-20-1-snapshot-and-join.md` §17.1 (Wave 1 build-order
  DAG) and §17.3 (test debt by wave) before starting.

---

## Wave 0 — Harness extension (ADR-161)

### Step 0.1 — Wire doc-links + mutation-budgets into validate

**Goal.** `npm run validate` includes `check:doc-links` and
`check:mutation-budgets`. Existing scripts already exist; this step
adds them to the validate chain.

Files:

1. `package.json` — extend the `validate` script's dependency list.
   - Add `check:doc-links` and `check:mutation-budgets` to the
     concurrently-run check list (around line 693–715 per current state).
   - If `check:size` would now fail due to anticipated 20.1 bundle
     impact, bump the size-limit budget here with an inline comment
     `// 20.1: size optimization deferred to perf phase` (per design
     §15.6 and review pass 2 D14).

**Tests (existing scripts, no new tests).**

- Run `npm run check:doc-links` standalone — green on the current `docs/`
  tree (the spike, ADRs, and design doc are already linked correctly).
- Run `npm run check:mutation-budgets` standalone — green or noisy with
  pre-existing entries; if noisy due to budget drift, fix or document
  in this commit.

**Verify.** `npm run validate` passes with the new checks in the chain.

**Commit.** `chore(harness): wire doc-links + mutation-budgets into validate`.

---

## Wave 1 — Snapshot+join primitive

Wave 1 lands the entire new API surface plus full unit/integration/
property test coverage. No consumer is migrated. Old walkers stay
authoritative for everyone else in the codebase.

The 46 steps of design §17.1's DAG group into 17 reviewable commits below.

### Step 1.1 — Ports (write-scope + write-event-emitter + write-event-stream + generation-view + snapshot-resolvers)

**Goal.** Five port files exporting type-only interfaces. No behavior.

Files:

1. `src/ports/write-scope.ts` — `export type WriteScope = 'index' | 'refs' | 'objects'`.
2. `src/ports/write-event-emitter.ts` — `WriteEventEmitter` interface, imports `WriteScope` from `./write-scope.js`.
3. `src/ports/write-event-stream.ts` — `WriteEventStream` + `Disposable` interfaces, imports `WriteScope`.
4. `src/ports/generation-view.ts` — `GenerationView` interface, imports `WriteScope`.
5. `src/ports/snapshot-resolvers.ts` — `ResolveOptions`, `IndexResolver`, `TreeResolver`, `WorkdirEnumerator`, `WorkdirEnumOptions`. Imports `GitIndex`, `Tree`, `ObjectId`, `Context`, `Pathspec`, `WalkIgnorePredicate`.

**Tests.** None per se — types compile, `check:types` passes. Add a
trivial assertion test that imports all five ports and re-exports them
to satisfy knip reachability until Wave 1.6 wires them up.

**Verify.** `npm run check:types` green; `npm run check` green.

**Commit.** `feat(ports): snapshot+join port interfaces`.

### Step 1.2 — Domain rows + classifiers

**Goal.** Pure data shapes in `src/domain/snapshot/`. No I/O, no methods.

Files:

1. `src/domain/snapshot/snapshot-kind.ts` — `SnapshotKind` type.
2. `src/domain/snapshot/tree-entry-row.ts` — `TreeEntryRow`.
3. `src/domain/snapshot/index-entry-row.ts` — `IndexEntryRow`, `IndexFlags`, `IndexCachedStat`.
4. `src/domain/snapshot/workdir-entry-row.ts` — `WorkdirEntryRow`, `WorkdirStat` (includes `mode` per design §6.3).
5. `src/domain/snapshot/join-row.ts` — `OuterJoinRow<S>`, `InnerJoinRow<S>`, `EntryOf<X>`.
6. `src/domain/snapshot/classifiers.ts` — `classifyIndexVsHead`, `classifyWorkdirVsIndex`, `IndexVsHead`, `WorkdirVsIndex` discriminated unions.
7. `src/domain/snapshot/index.ts` — re-export façade.

**Tests first (RED).**

- `test/unit/domain/snapshot/classifiers.test.ts` — full truth table for
  both classifiers: 5×3 = 15 cases for `classifyIndexVsHead`, 5×4 = 20
  cases for `classifyWorkdirVsIndex` (covering every `IndexVsHead` /
  `WorkdirVsIndex` value). Pure-function tests, no fixtures.
- `test/unit/domain/snapshot/classifiers.properties.test.ts` — lens 2
  (compositional matcher). Property: classifier output is determined
  entirely by the (oid, mode, kind) triple of inputs; no hidden state.

**Implementation (GREEN).** Write the classifier branch table; rest is
type-only.

**Verify.** Unit tests green; property test green; mutation budget 0 on
classifiers.ts.

**Commit.** `feat(domain): snapshot rows + classifiers`.

### Step 1.3 — `GitIndex.trailerSha` extension

**Goal.** Surface the SHA-1 trailer on `GitIndex` so
`CachingIndexResolver` can use it for racy-stat validation.

Files (MODIFIED):

1. `src/domain/git-index/index.ts` — add `readonly trailerSha: Uint8Array` to `GitIndex` interface.
2. `src/domain/git-index/parse-index.ts` (or wherever the parser lives)
   — capture the trailing 20 bytes (already read for validation) and
   include in the returned `GitIndex`.
3. `src/application/primitives/read-index.ts` — confirm trailer still
   validated before passing through.

**Tests first.**

- Existing index parser tests stay green (regression gate).
- Add: `test/unit/domain/git-index/trailer-sha.test.ts` — parse a known
  fixture, assert `trailerSha` matches the last 20 bytes of the buffer.
- Property: round-trip — for arbitrary valid index buffers, `parseIndex(buf).trailerSha === buf.slice(-20)`.

**Verify.** `npm run test:unit -- git-index` green; `npm run test:integration` green (no regressions).

**Commit.** `feat(domain): surface index SHA-1 trailer on GitIndex`.

### Step 1.4 — Application entries

**Goal.** Three entry interfaces wrapping the domain rows with their
async I/O surface (per ADR-154 and design §7).

Files:

1. `src/application/primitives/snapshot/tree-entry.ts` — `TreeEntry` extends `TreeEntryRow`; `read()` reads blob via TreeResolver.
2. `src/application/primitives/snapshot/index-entry.ts` — `IndexEntry` extends `IndexEntryRow`; `read()` reads blob.
3. `src/application/primitives/snapshot/workdir-entry.ts` — `WorkdirEntry` extends `WorkdirEntryRow`; `hash()` / `read()` / `readLink()` / `verify()`. Throws `UnsupportedOperationError` on `readLink()` when `kind !== 'symlink'`.
4. `src/application/primitives/snapshot/require-snapshot.ts` — `requireSnapshot` helper. Throws `SnapshotRequiredError`.

**Tests first.**

- `test/unit/application/primitives/snapshot/tree-entry.test.ts` — happy path read; error wrapping with `(source: 'tree', path)`.
- `test/unit/application/primitives/snapshot/index-entry.test.ts` — happy path read.
- `test/unit/application/primitives/snapshot/workdir-entry.test.ts` —
  hash deterministic against a fixture; read raw bytes; readLink throws
  on non-symlink (assert `UnsupportedOperationError.operation` value);
  verify throws `WorkdirRaceError` with `observed` + `current` populated
  when stat differs.
- `test/unit/application/primitives/snapshot/require-snapshot.test.ts`
  — passes through when non-null; throws `SnapshotRequiredError(message)`
  when null. Per CLAUDE.md mutation rule, assert the error's `reason` field
  exactly.

**Verify.** Unit tests green; mutation budget 0 on each file.

**Commit.** `feat(application): snapshot entry wrappers`.

### Step 1.5 — WriteEventBus + GenerationView adapter

**Goal.** Concrete process-local adapter implementing
`WriteEventEmitter` + `WriteEventStream`, plus `CounterGenerationView`.

Files:

1. `src/adapters/snapshot-resolvers/counter-generation-view.ts` —
   `CounterGenerationView` extends `GenerationView` with internal
   `bump(scope)`. Implementation per design §10.8.
2. `src/adapters/snapshot-resolvers/in-memory-write-event-bus.ts` —
   `createInMemoryWriteEventBus(view)` returns `{ emitter, stream }`.
   `emit(scope)` calls `view.bump(scope)` then fans out to listeners.

**Tests first.**

- `test/unit/adapters/snapshot-resolvers/counter-generation-view.test.ts`
  — `current('index') === 0` initially; after `bump('index')`,
  `current('index') === 1` and `current('refs') === 0`.
- `test/unit/adapters/snapshot-resolvers/in-memory-write-event-bus.test.ts`
  — emit propagates to subscribers; `dispose()` removes subscriber;
  multiple subscribers see identical event sequences.
- `test/unit/adapters/snapshot-resolvers/generation-view.properties.test.ts`
  — lens 4 invariants: scope independence under arbitrary interleaved
  event histories (`emit('index')` does not bump `refs` or `objects`);
  subscriber order does not affect delivery order. `numRuns: 200`.

**Verify.** Unit + property green; mutation budget 0.

**Commit.** `feat(adapters): in-memory write-event bus + generation view`.

### Step 1.6 — Raw resolvers

**Goal.** Stateless `RawIndexResolver` and `RawTreeResolver` that
implement the resolver ports without caching.

Files:

1. `src/adapters/snapshot-resolvers/raw-index-resolver.ts` —
   `createRawIndexResolver(fs)`. Reads `${ctx.layout.gitDir}/index`,
   parses via `parseIndex` (now returns `GitIndex` with `trailerSha`),
   returns it.
2. `src/adapters/snapshot-resolvers/raw-tree-resolver.ts` —
   `createRawTreeResolver(ctx-resolver)`. Calls existing `readObject`,
   throws `unexpectedObjectType` if not a tree.

**Tests first.**

- `test/unit/adapters/snapshot-resolvers/raw-index-resolver.test.ts` —
  parse a fixture; assert returned `GitIndex` includes `trailerSha`;
  ResolveOptions ignored (no caching to bypass).
- `test/unit/adapters/snapshot-resolvers/raw-tree-resolver.test.ts` —
  round-trip a tree fixture; non-tree oid raises `unexpectedObjectType`.

**Verify.** Unit tests green; mutation budget 0.

**Commit.** `feat(adapters): raw index + tree resolvers`.

### Step 1.7 — Resolver decorators (single-flight, caching)

**Goal.** Decorator stack atop `RawIndexResolver` and atop
`RawTreeResolver`.

Files:

1. `src/adapters/snapshot-resolvers/single-flight-index-resolver.ts` —
   wraps an `IndexResolver`; deduplicates concurrent calls into one
   inflight promise.
2. `src/adapters/snapshot-resolvers/caching-index-resolver.ts` —
   per design §10.4. Subscribes to `WriteEventStream`. Stat-based
   invalidation with SHA-trailer racy-stat fallback. Honors `ResolveOptions.bypassCache`.
3. `src/adapters/snapshot-resolvers/caching-tree-resolver.ts` —
   pure bounded LRU keyed by ObjectId; configurable size (default 256).

**Tests first.**

- `test/unit/adapters/snapshot-resolvers/single-flight-index-resolver.test.ts`
  — 1000 concurrent `resolve()` calls trigger exactly one inner
  resolve. (Use a stub `IndexResolver` that increments a call counter.)
- `test/unit/adapters/snapshot-resolvers/caching-index-resolver.test.ts`
  — parse-count assertions per design §15.1: 1 after 1000 hits with
  same generation; 2 after stat change; 2 after `emit('index')`; 2 after
  external write whose mtime collides (trailer mismatch).
- `test/unit/adapters/snapshot-resolvers/caching-index-resolver.properties.test.ts`
  — lens 2: empty event history → cache reused; any `index` event →
  parse-count increments; non-`index` event → parse-count unchanged.
  `numRuns: 100`.
- `test/unit/adapters/snapshot-resolvers/caching-tree-resolver.test.ts`
  — LRU semantics: hit by oid, eviction at capacity, no invalidation
  surface (mutating callers' captured tree must not affect cache).

**Verify.** Unit + property green; mutation budget 0; allocation-count
assertion on single-flight (one inflight promise allocated per uncached
window).

**Commit.** `feat(adapters): single-flight + caching resolver decorators`.

### Step 1.8 — FS workdir enumerator

**Goal.** `FsWorkdirEnumerator` that walks the working tree, applying
pathspec + ignore predicate, yielding `WorkdirEntryRow`.

Files:

1. `src/adapters/snapshot-resolvers/fs-workdir-enumerator.ts` —
   `createFsWorkdirEnumerator(fs, ctx)`. Internally calls the existing
   `walkWorkingTree` logic but adapts the yield shape to
   `WorkdirEntryRow` (populating `stat` with `mode` per design §6.3).
   Accepts `paths`, `excludes`, `maxDepth`, `maxEntries`, `signal`.
   Honors `ctx.signal`.

**Tests first.**

- `test/unit/adapters/snapshot-resolvers/fs-workdir-enumerator.test.ts`
  — byte-equal output to `walkWorkingTree` on the existing fixture set
  for `paths = undefined, excludes = undefined`; pathspec pruning;
  ignore-predicate exclusion; max-depth / max-entries enforcement;
  `signal.abort()` interrupts.

**Verify.** Unit tests green; mutation budget 0; output byte-equal to
legacy `walkWorkingTree` (regression gate).

**Commit.** `feat(adapters): filesystem workdir enumerator`.

### Step 1.9 — Snapshot implementations (Tree, Index, Workdir, Stash)

**Goal.** Snapshot handles backed by the resolvers. Iteration-stability
invariant enforced on `IndexSnapshot` (design §8.0).

Files:

1. `src/application/primitives/snapshot/tree-snapshot.ts` — backed by
   `TreeResolver`; cache is content-addressed so first iteration's
   resolve is sufficient.
2. `src/application/primitives/snapshot/index-snapshot.ts` — backed by
   `IndexResolver`. On FIRST iteration, captures the returned `GitIndex`
   reference in a private field. All subsequent iterations stream from
   that captured reference. Mid-iteration mutations to the underlying
   cache do not affect this handle.
3. `src/application/primitives/snapshot/workdir-snapshot.ts` — backed
   by `WorkdirEnumerator`. Implements `consistency: 'eager' | 'verified'`
   per design §8.2 boundary table.
4. `src/application/primitives/snapshot/stash-snapshot.ts` — `StashSnapshot`
   exposes `index`, `workdir`, `untracked` as properties (per ADR; design §9.1).

**Tests first.**

- `test/unit/application/primitives/snapshot/tree-snapshot.test.ts` —
  iteration yields entries in canonical path order; `paths` filter;
  `recurse: false`; `maxDepth`; `maxEntries`.
- `test/unit/application/primitives/snapshot/tree-snapshot.properties.test.ts`
  — lens 1: for arbitrary trees, `TreeSnapshot.entries()` output ≡
  legacy `walkTree()` output. `numRuns: 50`.
- `test/unit/application/primitives/snapshot/index-snapshot.test.ts` —
  iteration; `paths`; `bypassCache`; **iteration-stability test** —
  start iterating, call resolver's `emit('index')` from a stub, observe
  that the in-flight iteration continues yielding pre-mutation rows.
- `test/unit/application/primitives/snapshot/workdir-snapshot.test.ts`
  — `'eager'` default mode; `'verified'` two-pass mode; `excludes`
  composes with `paths` via AND per design §8.2.
- `test/unit/application/primitives/snapshot/stash-snapshot.test.ts` —
  trio access; `untracked: null` when stash made without `--include-untracked`.

**Verify.** Unit + property green; mutation budget 0; iteration-stability
test passes (one of the harder assertions — write carefully).

**Commit.** `feat(application): snapshot implementations`.

### Step 1.10 — Snapshot factory + Repository wiring (deferred to 1.14)

**Goal.** `SnapshotFactory` interface + factory implementation pulling
together the resolvers and snapshot impls.

Files:

1. `src/application/primitives/snapshot/snapshot-factory.ts` —
   `SnapshotFactory` interface + `createSnapshotFactory(deps)` taking
   `IndexResolver`, `TreeResolver`, `WorkdirEnumerator`, `Context`,
   `ignoreMatcher`. Returns the factory with `head()`, `tree(oid)`,
   `commit(oid)`, `index()`, `workdir()`, `mergeHead()`, etc.

**Tests first.**

- `test/unit/application/primitives/snapshot/snapshot-factory.test.ts`
  — every factory method returns the right snapshot kind; `mergeHead()`
  / `cherryPickHead()` / etc. return `null` when ref absent.

**Verify.** Unit tests green; mutation budget 0.

**Commit.** `feat(application): snapshot factory`.

### Step 1.11 — `join` + `innerJoin` + `path-merge`

**Goal.** K-way path-keyed merge; outer + inner overloads as separate
functions per ADR-159.

Files:

1. `src/application/primitives/snapshot/path-merge.ts` — internal
   k-way merge iterator; exports `pathMerge`, `assertOrdered` helper
   used by all operators.
2. `src/application/primitives/snapshot/join.ts` — `join`, `innerJoin`,
   single-source short-circuit. Composed signal handling per design §11.3.

**Tests first.**

- `test/unit/application/primitives/snapshot/path-merge.test.ts` —
  3-way merge across known orderings; empty sources; single source
  short-circuit; `assertOrdered` throws `OrderInvariantViolation` on
  reorder.
- `test/unit/application/primitives/snapshot/join.test.ts` —
  outer-join rows include all sources' paths; inner-join rows only
  include intersect; row shape matches per ADR-155; signal cancellation
  honored.
- `test/unit/application/primitives/snapshot/join.properties.test.ts` —
  lens 2 + 4: for arbitrary (tree, index, workdir) triples, outer-join
  yields path union sorted; row slot membership matches source presence;
  slot fields byte-equal direct enumeration. `numRuns: 100`.
- Allocation-count test for single-source `join({x})` — exactly one row
  envelope alloc per entry; verified via instrumentation.

**Verify.** Unit + property green; mutation budget 0; allocation
assertion passes.

**Commit.** `feat(application): join + innerJoin primitives`.

### Step 1.12 — Operators (hashWorkdir, loadBlob, verify, groupByDir, terminals)

**Goal.** Pipeline stages for the snapshot+join stack.

Files:

1. `src/application/primitives/snapshot-operators/hash-workdir.ts` —
   plus the generic `hashSlot` underlying it per design §12.1.
2. `src/application/primitives/snapshot-operators/load-blob.ts` —
   generic over join keys; `maxInflightBytes` knob (default 64 MiB).
3. `src/application/primitives/snapshot-operators/verify-workdir.ts` —
   `onRace: 'throw' | 'skip' | 'emit'`.
4. `src/application/primitives/snapshot-operators/group-by-dir.ts` —
   directory aggregation.
5. `src/application/primitives/snapshot-operators/count.ts` — terminal.
6. `src/application/primitives/snapshot-operators/to-array.ts` — terminal.
7. `src/application/primitives/snapshot-operators/first.ts` — terminal.
8. `src/application/primitives/snapshot-operators/index.ts` — façade.

**Tests first.**

- One `test/unit/application/primitives/snapshot-operators/<op>.test.ts`
  per file.
- Per operator: concurrency limit honored; signal cancellation; errors
  wrapped with `(slot, path, cause)`; order preserved (calls `assertOrdered`).
- `loadBlob` specifically: `maxInflightBytes` enforced — yield 1000
  large blobs with `maxInflightBytes: 1 MiB` and assert in-flight bytes
  never exceeds limit.
- Terminals: `count` short-circuits on `signal.abort()`; `first` yields
  on first row and disposes upstream.

**Verify.** Unit tests green; mutation budget 0 on every operator.

**Commit.** `feat(application): snapshot pipeline operators`.

### Step 1.13 — Deprecation helper

**Goal.** `warnDeprecated(callsite, message)` helper used in Wave 8.
Lands early in Wave 1 to keep Wave 8 a pure refactor.

Files:

1. `src/application/primitives/deprecation.ts` — per ADR-160 and design
   §15.5. Set-based call-site dedup; `process.env.TSGIT_SUPPRESS_DEPRECATIONS === '1'` gate; defensive on browser (no `process`).

**Tests first.**

- `test/unit/application/primitives/deprecation.test.ts` — emits
  once per unique callsite; suppressed when env var set; no throw
  when `process.env` is undefined (browser context).
- Per CLAUDE.md mutation rules, assert the EXACT env-var name in the
  test (StringLiteral mutant guard).

**Verify.** Unit tests green; mutation budget 0; manually verify
`TSGIT_SUPPRESS_DEPRECATIONS=1 node -e '...'` suppresses output.

**Commit.** `feat(application): deprecation warn-once helper`.

### Step 1.14 — Repository wiring + public exports

**Goal.** `Repository` gains `snapshot: SnapshotFactory` and
`ignoreMatcher()`. Public API exported from `src/index.ts` and
`src/index.node.ts`.

Files (MODIFIED):

1. `src/repository.ts` — wire the resolver decorator stack, the
   `InMemoryWriteEventBus` adapter, the `SnapshotFactory`, and the
   `ignoreMatcher` factory. Honor `openRepository({ caching, resolvers })`
   options per design.
2. `src/index.ts` — add the public exports per design §14.
3. `src/index.node.ts` — same exports for the Node adapter.

**Tests first.**

- `test/unit/repository/snapshot-wiring.test.ts` — open repo, assert
  `repo.snapshot.head()` returns a `TreeSnapshot`, etc.; assert
  `openRepository({ caching: false })` swaps in raw resolvers.
- `test/unit/api-surface/snapshot-exports.test.ts` — imports every new
  public export (types, functions, error classes) and assert they
  resolve. Pure smoke test; satisfies knip reachability per design §15.6.

**Verify.** Unit tests green; `check:dead-code` (knip) green; `check:exports` (attw) green.

**Commit.** `feat(repository): wire snapshot factory + public exports`.

### Step 1.15 — Integration tests

**Goal.** End-to-end coverage of caching invalidation, iteration
stability, and workdir race detection.

Files:

1. `test/integration/snapshot-cache.test.ts` — open real repo on tmpfs;
   mutate `.git/index` externally; observe re-parse on next snapshot;
   mutate via `repo.add()`; observe generation bump triggers re-parse;
   concurrent external + internal mutations both detected.
2. `test/integration/snapshot-iteration-stability.test.ts` — open
   `IndexSnapshot`, start iterating, mutate index from inside the loop,
   observe in-flight iteration sees pre-mutation rows; new snapshot
   opened after sees post-mutation rows.
3. `test/integration/workdir-race.test.ts` — `consistency: 'eager'`
   race detection via `verify()`; `consistency: 'verified'` two-pass
   detection; chmod-only race detected (per design §6.3 `WorkdirStat.mode`).

**Verify.** Integration tests green; no regressions in
`test/parity/` scenarios.

**Commit.** `test(integration): snapshot cache + iteration + workdir race`.

### Step 1.16 — User-facing docs

**Goal.** New primer docs that the design committed to in Wave 1
(per design §16).

Files:

1. `docs/use/snapshots.md` — user-facing primer. Mental model
   (snapshots are descriptions, not data), worked examples for status,
   diff, untracked, custom queries, links to ADRs for "why".
2. `docs/understand/caching.md` — `WriteEventEmitter` / `WriteEventStream`
   / `GenerationView` contract; lock-ordering protocol; racy-stat
   handling.

**Verify.** `npm run check:doc-links` green; `npm run check:doc-coverage`
green (all new public surface documented).

**Commit.** `docs: snapshots + caching primers`.

### Step 1.17 — Wave 1 closeout

**Goal.** Full `npm run validate` green on the cumulative Wave 1
state. No consumer migrated yet; old walkers still authoritative.

**Verify.** `npm run validate` — every gate, no suppressions, no
ignore directives. Stryker run on the new files — 0 surviving mutants.

(No new files; this step exists as a checkpoint and as the conventional
boundary before consumer migration starts. If the validate run flags
anything, fix as a small follow-up commit before Wave 2.)

---

## Wave 2 — Migrate `status`

### Step 2.1 — `commands/status.ts` to snapshot+join

**Goal.** `status.ts` calls `repo.snapshot.head()` / `index()` /
`workdir()` and `join(...)` instead of `walkWorkingTree`.

Files (MODIFIED):

1. `src/application/commands/status.ts` — rewrite to use snapshot+join.
   Composition pattern per design §5.1 worked example (status as a
   pilot porcelain).
2. `test/unit/application/commands/status.test.ts` — REWRITE assertions
   to exercise the new code path. Behavior is unchanged; only the
   internal call-graph differs.

**Tests first.** Run the existing status fixtures through the rewritten
implementation. Output must be byte-equal to the legacy behavior.

**Verify.** `npm run test:unit -- status` green; `npm run test:parity` green; `npm run validate` green.

**Commit.** `refactor(status): use snapshot+join`.

---

## Wave 3 — Migrate `diff`

### Step 3.1 — `commands/diff.ts` to snapshot+join

Files (MODIFIED):

1. `src/application/commands/diff.ts` — `join({ from, to })` over
   two `TreeSnapshot`s; per design §5.2.
2. `test/unit/application/commands/diff.test.ts` — REWRITE.

**Verify.** `npm run test:unit -- diff` green; `npm run validate` green.

**Commit.** `refactor(diff): use snapshot+join`.

---

## Wave 4 — Migrate `add`

### Step 4.1 — `commands/add.ts` to snapshot+join

**Goal.** `add` uses `WorkdirSnapshot` with `paths` + `excludes`. The
ignore predicate path stays — `excludes` is exactly the existing
`WalkIgnorePredicate`.

Files (MODIFIED):

1. `src/application/commands/add.ts` — replace `walkWorkingTree` calls
   with `repo.snapshot.workdir({ paths, excludes })`. Iteration yields
   `WorkdirEntry`; calling `entry.hash()` (or pipelining `hashWorkdir`)
   replaces the inline hashing.
2. `test/unit/application/commands/add.test.ts` — REWRITE.

**Verify.** `npm run test:unit -- add` green; `npm run validate` green.

**Commit.** `refactor(add): use snapshot+join`.

---

## Wave 5 — Migrate `checkout`

### Step 5.1 — `commands/checkout.ts` to snapshot+join

Files (MODIFIED):

1. `src/application/commands/checkout.ts` — conflict-detection becomes
   `join({ head, target, workdir })` + classifier per design §6.6.
2. `test/unit/application/commands/checkout.test.ts` — REWRITE.

**Verify.** `npm run test:unit -- checkout` green; `npm run validate` green.

**Commit.** `refactor(checkout): use snapshot+join`.

---

## Wave 6 — Migrate `merge`

### Step 6.1 — `commands/merge.ts` to snapshot+join

**Goal.** `merge` uses the 4-way join pattern per design §5.4:
`join({ base, ours, theirs, workdir })`.

Files (MODIFIED):

1. `src/application/commands/merge.ts` — 4-way join; `MergeHeadSnapshot`
   accessed via `await repo.snapshot.mergeHead()` + `requireSnapshot`.
2. `src/application/primitives/materialize-tree.ts` — any consumers
   of `walkTree` here migrate to `TreeSnapshot.entries()`.
3. `test/unit/application/commands/merge.test.ts` — REWRITE.

**Verify.** `npm run test:unit -- merge` green; `npm run validate` green.

**Commit.** `refactor(merge): use snapshot+join`.

---

## Wave 7 — Remaining consumers

### Step 7.1 — Migrate rm, ls-tree, ls-files, and primitives

**Goal.** Every remaining consumer of `walkTree`/`walkWorkingTree`
migrates. After this commit, only the deprecated facades themselves
still reference the old names.

Files (MODIFIED):

1. `src/application/commands/rm.ts` — if `walkWorkingTree` referenced.
2. `src/application/commands/ls-tree.ts` (or equivalent) — uses
   `repo.snapshot.tree(oid).entries({ recurse, paths })`.
3. `src/application/commands/ls-files.ts` (or equivalent) — uses
   `repo.snapshot.index().entries({ paths })`.
4. `src/application/primitives/enumerate-push-objects.ts` — replace
   `walkTree` internal calls with `repo.snapshot.tree(...)`.
5. `src/application/primitives/flatten-tree.ts` — same.
6. `src/application/primitives/build-index-from-tree.ts` — same.
7. `src/application/primitives/materialize-tree.ts` — same (residual
   after Wave 6).
8. `src/application/primitives/walk-submodules.ts` — INTERNAL migration:
   replace its `walkTree` call with `TreeSnapshot.entries()`. The public
   `walkSubmodules` surface is unchanged.
9. Each touched file's test file — REWRITE assertions or audit for
   regressions per spike §11 test-debt table.

**Tests first.** All existing tests for these files must continue
passing. Each migration is a behavior-preserving refactor.

**Verify.** `npm run validate` green; `check:dead-code` confirms zero
internal callers of `walkTree`/`walkWorkingTree` remain (only the
facades themselves and the deprecation-test smoke tests).

**Commit.** `refactor(primitives): migrate remaining walkers to snapshot+join`.

---

## Wave 8 — Deprecate old walkers + PR finalization

### Step 8.1 — Walkers as deprecated facades

**Goal.** `walkTree` and `walkWorkingTree` become `@deprecated` facades
over the new API. Runtime warning emits once per call-site, gated by
`TSGIT_SUPPRESS_DEPRECATIONS`. Version bumps to 2.0.0.

Files (MODIFIED):

1. `src/application/primitives/walk-tree.ts` — replace implementation
   with: call `warnDeprecated(__filename + ':walkTree', '<message>')`,
   then delegate to `TreeSnapshot.entries({ recurse: true })`. JSDoc
   `@deprecated` annotation with replacement guidance.
2. `src/application/primitives/walk-working-tree.ts` — same pattern.
3. `package.json` — bump `version` to `2.0.0`.
4. `jscpd.config.json` (or equivalent) — allowlist the facade files
   as expected duplication (they're trivial pass-throughs; jscpd will
   otherwise flag).

**Tests first.**

- `test/unit/application/primitives/walk-tree.test.ts` (REPOINTED) —
  facade emits the warning once on first call; subsequent calls don't
  emit; `TSGIT_SUPPRESS_DEPRECATIONS=1` suppresses; output byte-equal
  to `TreeSnapshot.entries({ recurse: true })`.
- `test/unit/application/primitives/walk-working-tree.test.ts` (REPOINTED)
  — same pattern.

**Verify.** `npm run validate` green; `check:duplicates` green (with
allowlist); `check:doc-typedoc` re-generates `reports/api.json` showing
the `@deprecated` markers.

**Commit.** `refactor(primitives): deprecate walkTree, walkWorkingTree`.

### Step 8.2 — Migration doc + walker doc updates

**Goal.** User-facing docs point to the new API; deprecation cycle
documented.

Files (MODIFIED):

1. `docs/use/migrate-from-isomorphic-git.md` — replace iso-git `walk()`
   examples with snapshot+join recipes (per spike §12).
2. `docs/use/primitives/walk-tree.md` — `@deprecated` notice; link to
   `docs/use/snapshots.md`.
3. `docs/use/primitives/walk-working-tree.md` — same.

**Verify.** `npm run check:doc-links` green; `npm run check:doc-coverage`
green.

**Commit.** `docs: migrate-from-isomorphic-git + walker deprecation notices`.

### Step 8.3 — README + RUNBOOK + CONTRIBUTING + BACKLOG

**Goal.** Top-level docs reflect 2.0.0 + snapshot+join as the
recommended path.

Files (MODIFIED):

1. `README.md` — "Primitives" section leads with snapshots+join.
2. `RUNBOOK.md` — `TSGIT_SUPPRESS_DEPRECATIONS` env var documented.
3. `CONTRIBUTING.md` — new testing patterns for the snapshot+join stack.
4. `docs/BACKLOG.md` — flip `[ ] **20.1**` → `[x] **20.1**` line.

**Verify.** `npm run check:doc-links` green; `npm run validate` fully
green on the cumulative branch.

**Commit.** `docs: 2.0.0 README + RUNBOOK + CONTRIBUTING + BACKLOG tick`.

---

## Post-Wave-8 — Pre-PR checklist

Before pushing and opening the PR:

1. `npm run validate` — clean, no suppressions, no ignore directives.
2. `npm run test:mutation` (Stryker) — 0 surviving mutants on every
   new file. Equivalent mutants inline-documented.
3. `git log --oneline ^main HEAD` — review commit history; each commit
   is reviewable and ideally runnable in isolation.
4. Squash-merge plan: this PR will be squash-merged into main; commit
   messages compose into a single coherent release note.
5. PR body:
   - Summary: snapshot+join primitive, 2.0.0 semver-major
   - References: spike, ADRs 148–161, design doc
   - Test plan: every wave's validation checkpoint
   - Migration recipe link

**Do not run `gh pr create`.** Wait for the user to open the PR
(per project workflow rule).

---

## PR-split fallback

Per ADR-151, if a wave stalls more than two days mid-implementation:

- The PR splits at the last green wave.
- Subsequent waves ship as follow-up PRs against the deprecated-walker
  baseline of Wave 1 (NOT against main; the new primitive must be
  available to migrate against).
- Wave 8 (deprecation) is the ONLY wave that must land in the same PR
  as Wave 1. If Wave 8 hasn't shipped, old walkers stay un-deprecated
  in the 2.x line.

Splitting is a documented escape valve, not a default. Prefer landing
the full PR.
